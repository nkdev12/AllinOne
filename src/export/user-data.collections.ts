import type { Prisma } from "@prisma/client";

/**
 * Any Prisma delegate reachable from both the top-level client and an
 * interactive transaction, so one read path serves the export (no transaction)
 * and the erasure cascade (which may run inside one).
 */
export type UserDataDelegate = Extract<keyof Prisma.TransactionClient, string>;

/**
 * How a row belongs to the account being exported or erased.
 *
 * - `owner` — the row names the account in a single column (`userId`, or the
 *   finance tables' `ownerId` / `paidByUserId` / `fromUserId`, which is why this
 *   is a field and not an assumption).
 * - `anyOf` — the account may hold the row from either side. `ResourceShare` is
 *   the only content case: a grant this account issued and a grant it received are
 *   both this account's business, and erasing the account has to revoke the access
 *   it was given.
 * - `parent` — the row has no owner column at all; it belongs to the account only
 *   through the row it hangs off (`NoteHistory.noteId`). The parent is itself
 *   account-scoped, so a child read can never widen past the account's own data.
 *   Parent ids are resolved one page at a time, which is what keeps a
 *   library-sized account out of memory and out of one unbounded `$in` list.
 */
export type UserDataScope =
  | { readonly by: "owner"; readonly field: string }
  | { readonly by: "anyOf"; readonly fields: readonly string[] }
  | {
      readonly by: "parent";
      readonly parent: UserDataCollection;
      readonly key: string;
    };

export interface UserDataCollection {
  /** Key the row is written under in the bundle, and counted under in summary. */
  readonly collection: string;
  readonly delegate: UserDataDelegate;
  readonly scope: UserDataScope;
  /**
   * Hard-deleted by the account erasure. `false` means the export hands a copy but
   * the rows outlive the account — every such row is either revoked in place or
   * owned by somebody else, and each one says which below.
   */
  readonly erasure: boolean;
  /**
   * Columns stripped from the exported row. Used for the bearer credentials that
   * live on rows an account is entitled to see the shape of: a revoked session's
   * token is still a token, and an export file is not a keychain.
   */
  readonly redact?: readonly string[];
}

/** The vault's server-side secrets, none of which belong in a downloadable file. */
const VAULT_SETTING_SECRETS = [
  "masterKeyHash",
  "masterKeyHashPepper",
  "recoveryKdfSalt",
  "recoveryKey",
  "wrappedMasterKey",
  "wrappedMasterIv",
  "wrappedMasterTag",
  "passwordWrappedKey",
  "passwordWrappedIv",
  "passwordWrappedTag",
  "recoveryGrantedAt",
] as const;

const SESSION_TOKEN_FIELDS = ["accessToken", "refreshToken"] as const;

// A handful of collections are referenced as a parent by their children, so they
// are declared here once and shared, rather than duplicated per child entry.
const NOTES: UserDataCollection = {
  collection: "note",
  delegate: "note",
  scope: { by: "owner", field: "userId" },
  erasure: true,
};

const PROJECTS: UserDataCollection = {
  collection: "project",
  delegate: "project",
  scope: { by: "owner", field: "userId" },
  erasure: true,
};

const TASKS: UserDataCollection = {
  collection: "task",
  delegate: "task",
  scope: { by: "owner", field: "userId" },
  erasure: true,
};

const EVENTS: UserDataCollection = {
  collection: "event",
  delegate: "event",
  scope: { by: "owner", field: "userId" },
  erasure: true,
};

const DEVICES: UserDataCollection = {
  collection: "device",
  delegate: "device",
  scope: { by: "owner", field: "userId" },
  // Revoked in place rather than erased: `Device.publicKey` is what a future
  // re-enrolment of the same hardware is matched against, and the row is the only
  // record of which device held which session.
  erasure: false,
};

const FINANCE_TRIPS: UserDataCollection = {
  collection: "financeTrip",
  delegate: "financeTrip",
  scope: { by: "owner", field: "ownerId" },
  erasure: false,
};

/**
 * One finance table's stake in an account: how the rows name their owner, and
 * what the sync oplog calls the entity.
 *
 * `entityType` values are the strings `src/sync/change-projection.ts` switches
 * on, so a tombstone written from `src/users/users.service.ts` is a DELETE a
 * device can actually apply. The table lives in this file because the export and
 * the erasure have to walk the same set of finance tables with the same owner
 * columns, and one list is the only way to guarantee they keep doing so.
 */
export interface FinanceTenancy {
  readonly delegate: UserDataDelegate;
  readonly entityType: string;
  readonly ownerFields: readonly string[];
}

export const FINANCE_TENANCY: readonly FinanceTenancy[] = [
  {
    delegate: "financeAccount",
    entityType: "finance_account",
    ownerFields: ["userId"],
  },
  {
    delegate: "financeCategory",
    entityType: "finance_category",
    ownerFields: ["userId"],
  },
  {
    delegate: "financeTransaction",
    entityType: "finance_transaction",
    ownerFields: ["userId"],
  },
  {
    delegate: "financeBudget",
    entityType: "finance_budget",
    ownerFields: ["userId"],
  },
  {
    delegate: "financeSavingsGoal",
    entityType: "finance_savings_goal",
    ownerFields: ["userId"],
  },
  {
    delegate: "financeRecurringRule",
    entityType: "finance_recurring_rule",
    ownerFields: ["userId"],
  },
  {
    delegate: "financeLoan",
    entityType: "finance_loan",
    ownerFields: ["userId"],
  },
  // A group's owner column is `ownerId`, not `userId`; same for a trip. Reading
  // the field list off `prisma/schema.prisma` rather than assuming one name is
  // the whole reason this table exists.
  {
    delegate: "financeGroup",
    entityType: "finance_group",
    ownerFields: ["ownerId"],
  },
  {
    delegate: "financeTrip",
    entityType: "finance_trip",
    ownerFields: ["ownerId"],
  },
  {
    delegate: "financeSharedExpense",
    entityType: "finance_shared_expense",
    ownerFields: ["paidByUserId"],
  },
  {
    delegate: "financeSettlement",
    entityType: "finance_settlement",
    ownerFields: ["fromUserId", "toUserId"],
  },
];

/**
 * Every collection an account's content is made of, in one list that both the
 * export and the erasure read.
 *
 * Two properties this file exists to hold:
 *
 * 1. The order is child-before-parent wherever a child has no owner column of its
 *    own, so erasing a parent never orphans the children whose parent ids were the
 *    only way to find them.
 * 2. `erasure: true` selects a subset of this list, and the export streams every
 *    entry in it. That is the invariant `src/users/account-erasure.spec.ts` proves
 *    operationally — nothing the cascade removes can be missing from the bundle —
 *    and the reason both code paths read the *same* array rather than keeping two
 *    lists a later commit forgets to update together.
 *
 * `prisma/schema.prisma` declares no `@relation` on `Change.userId` — model
 * `Change` carries no relation at all — so nothing in MongoDB cascades that
 * account's change log. It is listed here and deleted in code, because its
 * `payload` holds note, task and event content in plaintext and, for `vault_item`
 * rows, the only copy of the user's vault the server ever held. Adding the
 * relation is the schema owner's call, not this file's.
 */
export const USER_DATA_COLLECTIONS: readonly UserDataCollection[] = [
  // ---- Notes and their dependants -------------------------------------------
  {
    collection: "noteHistory",
    delegate: "noteHistory",
    scope: { by: "parent", parent: NOTES, key: "noteId" },
    erasure: true,
  },
  {
    collection: "noteTag",
    delegate: "noteTag",
    scope: { by: "parent", parent: NOTES, key: "noteId" },
    erasure: true,
  },
  {
    collection: "attachment",
    delegate: "attachment",
    scope: { by: "owner", field: "userId" },
    erasure: true,
  },
  NOTES,
  {
    collection: "folder",
    delegate: "folder",
    scope: { by: "owner", field: "userId" },
    erasure: true,
  },
  {
    collection: "tag",
    delegate: "tag",
    scope: { by: "owner", field: "userId" },
    erasure: true,
  },

  // ---- Tasks ----------------------------------------------------------------
  {
    collection: "section",
    delegate: "section",
    scope: { by: "parent", parent: PROJECTS, key: "projectId" },
    erasure: true,
  },
  {
    collection: "taskLabel",
    delegate: "taskLabel",
    scope: { by: "parent", parent: TASKS, key: "taskId" },
    erasure: true,
  },
  {
    collection: "reminder",
    delegate: "reminder",
    scope: { by: "owner", field: "userId" },
    erasure: true,
  },
  TASKS,
  PROJECTS,

  // ---- Calendar -------------------------------------------------------------
  {
    collection: "eventAttendee",
    delegate: "eventAttendee",
    scope: { by: "parent", parent: EVENTS, key: "eventId" },
    erasure: true,
  },
  {
    collection: "eventReminder",
    delegate: "eventReminder",
    scope: { by: "owner", field: "userId" },
    erasure: true,
  },
  EVENTS,
  {
    collection: "calendar",
    delegate: "calendar",
    scope: { by: "owner", field: "userId" },
    erasure: true,
  },

  // ---- Vault ----------------------------------------------------------------
  // Erased, and exported as its KDF parameters only. The vault's *content* leaves
  // as `vault_item` rows in `change.payload` below — opaque blobs sealed under the
  // master password, which the owner holds and this server never sees. What lives
  // on this row is the verifier and the key wrappers: exporting them would put a
  // bearer secret in a downloadable file, and deleting them orphans nothing,
  // because `prisma/schema.prisma` records that the authoritative KDF parameters
  // travel inside every vault blob (`_kdf`) and the client re-derives from them on
  // the next vault setup.
  {
    collection: "vaultSetting",
    delegate: "vaultSetting",
    scope: { by: "owner", field: "userId" },
    erasure: true,
    redact: VAULT_SETTING_SECRETS,
  },

  // ---- Collaboration --------------------------------------------------------
  {
    collection: "resourceShare",
    delegate: "resourceShare",
    scope: { by: "anyOf", fields: ["ownerId", "sharedWithUserId"] },
    erasure: true,
  },

  // ---- Device, session and sync state ---------------------------------------
  {
    collection: "deviceSyncState",
    delegate: "deviceSyncState",
    // `Device` rows survive (revoked, not deleted), so these checkpoints still
    // resolve at erasure time.
    scope: { by: "parent", parent: DEVICES, key: "deviceId" },
    erasure: true,
  },
  DEVICES,
  {
    collection: "session",
    delegate: "session",
    scope: { by: "owner", field: "userId" },
    // Revoked in place, same reason as `device`. The tokens are the part that must
    // not leave the database inside a file.
    erasure: false,
    redact: SESSION_TOKEN_FIELDS,
  },
  {
    collection: "idempotencyKey",
    delegate: "idempotencyKey",
    scope: { by: "owner", field: "userId" },
    // A cached response holds the plaintext of the write that produced it, so this
    // collection goes both ways: exported, and erased.
    erasure: true,
  },

  // ---- The change log, last -------------------------------------------------
  // Every `payload` here is content the collections above are made of — and for a
  // `vault_item` row it is the only copy the server ever held. Deleting it after
  // the rows it describes are gone keeps the bundle replayable in cursor order.
  {
    collection: "change",
    delegate: "change",
    scope: { by: "owner", field: "userId" },
    erasure: true,
  },
  {
    collection: "syncCursor",
    delegate: "syncCursor",
    scope: { by: "owner", field: "userId" },
    erasure: true,
  },

  // ---- Finance --------------------------------------------------------------
  // Erased by tombstone rather than `deleteMany` (`UsersService.tombstoneFinanceRows`
  // writes `deletedAt` plus a DELETE change per row, so a device holding a
  // checkpoint is told to drop its copy), and exported in full — which is the half
  // that used to be missing: an account could be erased before it was ever handed
  // its own financial history.
  ...FINANCE_TENANCY.map<UserDataCollection>((table) => ({
    collection: table.delegate,
    delegate: table.delegate,
    scope:
      table.ownerFields.length === 1
        ? { by: "owner", field: table.ownerFields[0] }
        : { by: "anyOf", fields: table.ownerFields },
    erasure: false,
  })),
  {
    collection: "financeTripItinerary",
    delegate: "financeTripItinerary",
    // Keyed only by `tripId`; it belongs to whichever account owns the trip, and
    // the tombstone pass resolves it the same way.
    scope: { by: "parent", parent: FINANCE_TRIPS, key: "tripId" },
    erasure: false,
  },
  {
    collection: "financeExpenseShare",
    delegate: "financeExpenseShare",
    // `userId` here is the person the split is owed to. Their share of somebody
    // else's expense is their own fact and is exported; erasing it would rewrite
    // the group's arithmetic from a request only one side made, which is the same
    // line `tombstoneFinanceRows` already refuses to cross.
    scope: { by: "owner", field: "userId" },
    erasure: false,
  },
];

/** The subset the erasure cascade removes — and so the subset the export must cover. */
export const ERASED_COLLECTIONS: readonly UserDataCollection[] =
  USER_DATA_COLLECTIONS.filter((entry) => entry.erasure);

/**
 * The clause that says "this row is the account's", read off the entry's own scope.
 *
 * One helper for both the export and the erasure, because a row one of them can
 * find and the other cannot is the exact bug this whole file is structured to
 * prevent: the export hands back a copy of what it believes is the account's data,
 * and the cascade then removes what it believes is the same set.
 *
 * A `parent`-scoped entry throws: its rows belong to the account only through
 * another row, and reading them by an account column is the widening this guard
 * exists to refuse. Every parent in the manifest is owner-scoped, so this catches a
 * future edit rather than a live case.
 */
export function accountWhere(
  entry: UserDataCollection,
  userId: string,
): Record<string, unknown> {
  switch (entry.scope.by) {
    case "owner":
      return { [entry.scope.field]: userId };
    case "anyOf":
      return { OR: entry.scope.fields.map((field) => ({ [field]: userId })) };
    case "parent":
      throw new Error(
        `Collection "${entry.collection}" is scoped through "${entry.scope.parent.collection}", so it has no account column to read by.`,
      );
  }
}

/**
 * Rows an account may not be erased through, because another account owns them and
 * only *names* this one: a shared expense in somebody else's group that this user
 * paid, a settlement either side of which belongs to them. Deleting those would
 * rewrite another user's split from a request this user made, so they are exported
 * and reported instead.
 */
export const FOREIGN_OWNED_FINANCE_DELEGATES = [
  "financeSharedExpense",
  "financeSettlement",
] as const;
