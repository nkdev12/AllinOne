import { ChangeOperation } from "@prisma/client";
import { assertPushableChanges } from "./change-payload.validator";
import {
  projectAcceptedChange,
  type ChangeProjectionClient,
  type ProjectableChange,
} from "./change-projection";

/**
 * The share half of a pushed `finance_shared_expense` UPDATE.
 *
 * `projection_allocation.spec.ts` pins what the split *adds up to*; this file
 * pins what the projection then does to the rows that already exist. Both come
 * from one hazard: the UPDATE branch used to write `shares: { deleteMany: {},
 * create: [...] }`, which rebuilt the whole table on every device push. That is
 * three losses at once — every share row got a fresh id under a device that had
 * already stored the split, every tombstone the REST diff in `groups.service.ts`
 * `applyShareDiff` writes was erased (a participant who left a split came back
 * invisible-to-nobody), and any `isSettled`/`settledAt`/`version` those rows
 * carried went with them.
 *
 * Each `it` below names the mutation of `change-projection.ts` that would make
 * it fail, so a later "simplification" back to a rebuild is caught by the test
 * that says why the rebuild was removed.
 */

const userId = "user-uuid-123";
const expenseId = "66666666-6666-4666-8666-666666666666";
const groupId = "77777777-7777-4777-8777-777777777777";
const alice = "user-a";
const bob = "user-b";
const carol = "user-c";

/** Loose on purpose: the projection reads three methods off each delegate. */
type Fake = Record<string, any>;

type ShareRow = {
  id: string;
  sharedExpenseId: string;
  userId: string;
  owedAmountMinor: bigint;
  shareUnits: number | null;
  isSettled: boolean;
  settledAt: Date | null;
  deletedAt: Date | null;
  version: number;
  createdAt: Date;
};

function storedShare(
  over: Partial<ShareRow> & { id: string; userId: string },
): ShareRow {
  return {
    sharedExpenseId: expenseId,
    owedAmountMinor: BigInt(0),
    shareUnits: null,
    isSettled: false,
    settledAt: null,
    deletedAt: null,
    version: 1,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    ...over,
  };
}

/**
 * An in-memory stand-in for `finance_expense_shares` that honours the three
 * calls the projection is allowed to make: a filtered/ordered read, an insert,
 * and an update by id that understands `{ increment: n }`. It has no
 * `deleteMany` and no `delete`, which is the point — a projection that still
 * tried the nested rebuild never reaches this table at all, and every assertion
 * below about `rows` is therefore an assertion about what was really written.
 */
function shareStore(rows: ShareRow[]) {
  let nextId = 1;

  const matches = (row: ShareRow, where: Record<string, any>) => {
    if (where.sharedExpenseId !== undefined) {
      if (row.sharedExpenseId !== where.sharedExpenseId) return false;
    }
    if ("deletedAt" in where) {
      if ((row.deletedAt ?? null) !== where.deletedAt) return false;
    }
    return true;
  };

  const findMany = jest.fn(async ({ where }: any) =>
    rows
      .filter((row) => matches(row, where ?? {}))
      .slice()
      .sort((a, b) =>
        a.userId === b.userId
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : a.userId < b.userId
            ? -1
            : 1,
      )
      .map((row) => ({ ...row })),
  );

  const create = jest.fn(async ({ data }: any) => {
    const created: ShareRow = {
      id: `share-new-${nextId++}`,
      sharedExpenseId: data.sharedExpenseId,
      userId: data.userId,
      owedAmountMinor: data.owedAmountMinor,
      shareUnits: data.shareUnits ?? null,
      isSettled: data.isSettled ?? false,
      settledAt: data.settledAt ?? null,
      deletedAt: data.deletedAt ?? null,
      version: data.version ?? 1,
      createdAt: new Date("2026-10-05T00:00:00.000Z"),
    };
    rows.push(created);
    return { ...created };
  });

  const update = jest.fn(async ({ where, data }: any) => {
    const target = rows.find((row) => row.id === where.id);
    if (!target) throw new Error(`P2025: no share row with id ${where.id}`);
    for (const [key, value] of Object.entries(data as Record<string, any>)) {
      if (
        value &&
        typeof value === "object" &&
        "increment" in (value as Record<string, any>)
      ) {
        (target as any)[key] =
          Number((target as any)[key]) +
          Number((value as Record<string, any>).increment);
        continue;
      }
      (target as any)[key] = value;
    }
    return { ...target };
  });

  return { rows, findMany, create, update };
}

function expenseRow(over: Record<string, any> = {}) {
  return {
    groupId,
    tripId: null,
    totalAmountMinor: BigInt(10000),
    splitType: "EXACT",
    deletedAt: null,
    version: 1,
    ...over,
  };
}

/**
 * The transaction `/sync/push` hands the projection: one client, every delegate
 * off the same object. A share write that threw has to take the expense write
 * with it, and that is only true because both go through this `tx`.
 */
function txWith(rows: ShareRow[], existing: Record<string, any> | null) {
  const store = shareStore(rows);
  const tx: Fake = {
    financeGroup: {
      findUnique: jest.fn().mockResolvedValue({
        ownerId: userId,
        deletedAt: null,
        currency: "INR",
      }),
    },
    financeSharedExpense: {
      findUnique: jest
        .fn()
        .mockResolvedValue(existing ? { ...existing } : null),
      create: jest.fn().mockResolvedValue({ id: expenseId }),
      update: jest.fn().mockResolvedValue({ id: expenseId }),
    },
    financeExpenseShare: {
      findMany: store.findMany,
      create: store.create,
      update: store.update,
    },
  };
  return { tx, store };
}

const push = (tx: Fake, change: ProjectableChange) =>
  projectAcceptedChange(
    tx as unknown as ChangeProjectionClient,
    userId,
    change,
  );

function updateChange(
  payload: Record<string, any>,
  over: Partial<ProjectableChange> = {},
): ProjectableChange {
  return {
    entityType: "finance_shared_expense",
    entityId: expenseId,
    operation: ChangeOperation.UPDATE,
    version: 2,
    payload: {
      groupId,
      paidByUserId: userId,
      title: "Dinner",
      totalAmountMinor: 10000,
      currency: "INR",
      splitType: "EXACT",
      date: "2026-10-01T19:00:00.000Z",
      ...payload,
    },
    ...over,
  };
}

const minor = (row: ShareRow) => Number(row.owedAmountMinor);
const rowById = (rows: ShareRow[], id: string) => rows.find((r) => r.id === id);
const liveRows = (rows: ShareRow[]) => rows.filter((r) => r.deletedAt === null);

/** The columns a share write is allowed to touch, and the ones it never is. */
const SETTLE_KEYS = ["isSettled", "settledAt"];

describe("a pushed finance_shared_expense UPDATE diffs its shares", () => {
  it("keeps both original share ids and issues no create for an amounts-only edit", async () => {
    // Break this by putting `shares: { deleteMany: {}, create: shareData }` back,
    // or by re-keying the diff on the row id instead of `userId`: either one
    // mints fresh ids and calls `create` for participants who never left.
    const { tx, store } = txWith(
      [
        storedShare({
          id: "share-alice",
          userId: alice,
          owedAmountMinor: BigInt(6000),
        }),
        storedShare({
          id: "share-bob",
          userId: bob,
          owedAmountMinor: BigInt(4000),
        }),
      ],
      expenseRow({ totalAmountMinor: BigInt(10000) }),
    );

    await push(
      tx,
      updateChange({
        totalAmountMinor: 11000,
        shares: [
          { userId: alice, owedAmountMinor: 7000 },
          { userId: bob, owedAmountMinor: 4000 },
        ],
      }),
    );

    expect(store.create).not.toHaveBeenCalled();
    expect(store.rows.map((row) => row.id)).toEqual([
      "share-alice",
      "share-bob",
    ]);

    // Only the row whose amount actually moved is written, and it is written
    // where it lies: bob keeps version 1, so a replay of the same split cannot
    // look like an edit another device has to win against.
    const written = store.update.mock.calls.map(([arg]) => arg);
    expect(written).toHaveLength(1);
    expect(written[0].where).toEqual({ id: "share-alice" });
    expect(minor(rowById(store.rows, "share-alice")!)).toBe(7000);
    expect(rowById(store.rows, "share-alice")!.version).toBe(2);
    expect(minor(rowById(store.rows, "share-bob")!)).toBe(4000);
    expect(rowById(store.rows, "share-bob")!.version).toBe(1);

    for (const arg of written) {
      expect(arg.data).not.toHaveProperty("deletedAt");
    }

    // The nested write is gone from the parent update, so nothing downstream can
    // rebuild the table behind the diff's back.
    const parent = tx.financeSharedExpense.update.mock.calls[0][0].data;
    expect(parent).not.toHaveProperty("shares");
    expect(parent.totalAmountMinor).toBe(BigInt(11000));
  });

  it("tombstones a participant the payload no longer lists instead of deleting the row", async () => {
    // Break this by deleting absent rows (or by `deleteMany: {}`): the row has to
    // still be there, still carry its amount and its settle facts, with only
    // `deletedAt` and `version` moved.
    const settledAt = new Date("2026-10-02T08:00:00.000Z");
    const { tx, store } = txWith(
      [
        storedShare({
          id: "share-alice",
          userId: alice,
          owedAmountMinor: BigInt(6000),
        }),
        storedShare({
          id: "share-bob",
          userId: bob,
          owedAmountMinor: BigInt(4000),
          isSettled: true,
          settledAt,
          version: 5,
        }),
      ],
      expenseRow({ totalAmountMinor: BigInt(6000) }),
    );

    await push(
      tx,
      updateChange({
        totalAmountMinor: 6000,
        shares: [{ userId: alice, owedAmountMinor: 6000 }],
      }),
    );

    expect(store.rows).toHaveLength(2);
    expect(store.create).not.toHaveBeenCalled();

    const bobRow = rowById(store.rows, "share-bob")!;
    expect(bobRow.deletedAt).toBeInstanceOf(Date);
    expect(minor(bobRow)).toBe(4000);
    expect(bobRow.isSettled).toBe(true);
    expect(bobRow.settledAt).toEqual(settledAt);
    expect(bobRow.version).toBe(6);

    // Alice's row already says what the payload says, so it is not written at all.
    expect(store.update.mock.calls.map(([arg]) => arg.where.id)).toEqual([
      "share-bob",
    ]);
    expect(liveRows(store.rows).map((row) => row.userId)).toEqual([alice]);

    const tombstone = store.update.mock.calls[0][0].data;
    expect(Object.keys(tombstone).sort()).toEqual(["deletedAt", "version"]);
    expect(tombstone.version).toEqual({ increment: 1 });
  });

  it("leaves an isSettled / settledAt already on a row alone across an amounts-only update", async () => {
    // Break this by writing `isSettled`/`settledAt` from the payload on the
    // update path: a legacy three-key push (which states nothing about
    // settlement) would then clear a settle the REST settlement flow recorded,
    // and a device replay would un-settle Bob for everybody.
    const settledAt = new Date("2026-10-12T09:00:00.000Z");
    const { tx, store } = txWith(
      [
        storedShare({
          id: "share-alice",
          userId: alice,
          owedAmountMinor: BigInt(6000),
          isSettled: true,
          settledAt,
          version: 3,
        }),
      ],
      expenseRow({ totalAmountMinor: BigInt(6000) }),
    );

    await push(
      tx,
      updateChange({
        totalAmountMinor: 7000,
        shares: [{ userId: alice, owedAmountMinor: 7000 }],
      }),
    );

    const aliceRow = rowById(store.rows, "share-alice")!;
    expect(minor(aliceRow)).toBe(7000);
    expect(aliceRow.isSettled).toBe(true);
    expect(aliceRow.settledAt).toEqual(settledAt);
    expect(aliceRow.version).toBe(4);

    for (const [arg] of store.update.mock.calls) {
      for (const key of SETTLE_KEYS) {
        expect(arg.data).not.toHaveProperty(key);
      }
    }
  });

  it("revives a tombstoned row when its participant reappears instead of stacking a second live row", async () => {
    // Break this by reading only `deletedAt: null` rows (the REST diff's read):
    // bob would then get a brand-new id while his tombstone stayed buried, and a
    // device that held the old row would have to guess which of the two is him.
    const { tx, store } = txWith(
      [
        storedShare({
          id: "share-alice",
          userId: alice,
          owedAmountMinor: BigInt(6000),
        }),
        storedShare({
          id: "share-bob",
          userId: bob,
          owedAmountMinor: BigInt(4000),
          deletedAt: new Date("2026-10-03T10:00:00.000Z"),
          version: 2,
        }),
      ],
      expenseRow({ totalAmountMinor: BigInt(10000) }),
    );

    await push(
      tx,
      updateChange({
        totalAmountMinor: 10000,
        shares: [
          { userId: alice, owedAmountMinor: 6000 },
          { userId: bob, owedAmountMinor: 4000 },
        ],
      }),
    );

    expect(store.create).not.toHaveBeenCalled();
    const revived = rowById(store.rows, "share-bob")!;
    expect(revived.deletedAt).toBeNull();
    expect(revived.version).toBe(3);
    expect(liveRows(store.rows).map((row) => row.userId)).toEqual([alice, bob]);
    expect(
      liveRows(store.rows).filter((row) => row.userId === bob),
    ).toHaveLength(1);

    const revive = store.update.mock.calls[0][0];
    expect(revive.where).toEqual({ id: "share-bob" });
    expect(revive.data.deletedAt).toBeNull();
    // Alice was already live and already correct: no write, no version churn.
    expect(rowById(store.rows, "share-alice")!.version).toBe(1);
  });

  it("still projects the legacy three-key share payload with no settle or version keys", async () => {
    // Break this by making the new keys mandatory on the write path: every change
    // already queued on every phone ships exactly
    // `{userId, owedAmountMinor, shareUnits}`, and refusing or ignoring it is the
    // transport disagreement this file exists to prevent.
    const legacy = updateChange({
      totalAmountMinor: 11000,
      shares: [
        { userId: alice, owedAmountMinor: 7000, shareUnits: null },
        { userId: bob, owedAmountMinor: 4000, shareUnits: null },
      ],
    });
    expect(() => assertPushableChanges([legacy])).not.toThrow();

    const { tx, store } = txWith(
      [
        storedShare({
          id: "share-alice",
          userId: alice,
          owedAmountMinor: BigInt(6000),
        }),
      ],
      expenseRow({ totalAmountMinor: BigInt(10000) }),
    );

    await expect(push(tx, legacy)).resolves.toBeUndefined();

    expect(minor(rowById(store.rows, "share-alice")!)).toBe(7000);
    expect(store.create).toHaveBeenCalledTimes(1);
    // A row this push genuinely creates states nothing about settlement, so it
    // gets the column defaults rather than a key invented here.
    expect(Object.keys(store.create.mock.calls[0][0].data).sort()).toEqual([
      "owedAmountMinor",
      "shareUnits",
      "sharedExpenseId",
      "userId",
    ]);
    expect(liveRows(store.rows).map((row) => row.userId)).toEqual([alice, bob]);
  });

  it("carries a settle flag the push states onto a genuinely new share row", async () => {
    // Break this by dropping the payload's `isSettled`/`settledAt` on insert: the
    // second half of the reported defect — a share a phone pushed already settled
    // arriving unsettled, because the rebuild wrote three keys and nothing else.
    const { tx, store } = txWith(
      [
        storedShare({
          id: "share-alice",
          userId: alice,
          owedAmountMinor: BigInt(5000),
        }),
      ],
      expenseRow({ totalAmountMinor: BigInt(10000) }),
    );

    await push(
      tx,
      updateChange({
        totalAmountMinor: 10000,
        shares: [
          { userId: alice, owedAmountMinor: 5000 },
          {
            userId: carol,
            owedAmountMinor: 5000,
            isSettled: true,
            settledAt: "2026-10-12T09:00:00.000Z",
          },
        ],
      }),
    );

    expect(store.create).toHaveBeenCalledTimes(1);
    const created = store.create.mock.calls[0][0].data;
    expect(created.userId).toBe(carol);
    expect(created.isSettled).toBe(true);
    expect(created.settledAt).toBeInstanceOf(Date);
    expect((created.settledAt as Date).toISOString()).toBe(
      "2026-10-12T09:00:00.000Z",
    );
  });

  it("runs no share write for a change the row has already outvoted", async () => {
    // Break this by diffing the shares before `losesToWhatTheRowHolds`: a stale
    // device would then move share rows and bump their versions while its own
    // change was refused on the parent — the mirror disagreeing with the log.
    const { tx, store } = txWith(
      [
        storedShare({
          id: "share-alice",
          userId: alice,
          owedAmountMinor: BigInt(6000),
        }),
      ],
      expenseRow({ version: 40 }),
    );

    await push(
      tx,
      updateChange(
        {
          totalAmountMinor: 6000,
          shares: [{ userId: alice, owedAmountMinor: 6000 }],
        },
        { version: 3 },
      ),
    );

    expect(tx.financeSharedExpense.update).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
  });

  it("replays the same split without writing the share table at all", async () => {
    // Break this by writing unconditionally per requested share: a retry of the
    // same push bumps every version, and the device's next pull reads an edit
    // that never happened.
    const rows = [
      storedShare({
        id: "share-alice",
        userId: alice,
        owedAmountMinor: BigInt(6000),
      }),
      storedShare({
        id: "share-bob",
        userId: bob,
        owedAmountMinor: BigInt(4000),
      }),
    ];
    const { tx, store } = txWith(rows, expenseRow());

    const change = updateChange({
      totalAmountMinor: 10000,
      shares: [
        { userId: alice, owedAmountMinor: 6000 },
        { userId: bob, owedAmountMinor: 4000 },
      ],
    });
    await push(tx, change);
    await push(tx, change);

    expect(store.update).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(store.rows.map((row) => row.version)).toEqual([1, 1]);
  });

  it("lets a failed share write reject the whole projection", async () => {
    // Break this by wrapping the diff in a `try/catch`: the parent row was
    // already updated through the same `tx` by then, so a swallowed error leaves
    // an expense whose logged split never landed.
    const { tx, store } = txWith(
      [
        storedShare({
          id: "share-alice",
          userId: alice,
          owedAmountMinor: BigInt(6000),
        }),
      ],
      expenseRow(),
    );
    store.update.mockRejectedValue(new Error("write conflict"));

    await expect(
      push(
        tx,
        updateChange({
          totalAmountMinor: 7000,
          shares: [{ userId: alice, owedAmountMinor: 7000 }],
        }),
      ),
    ).rejects.toThrow("write conflict");

    // The expense write happened first, inside the client it was handed — which
    // is the only thing that makes the rollback real for it too.
    expect(tx.financeSharedExpense.update).toHaveBeenCalled();
  });

  it("asks the share table once per projection, not once per participant", async () => {
    // Break this by reading a row per requested share: a 100-participant split
    // then costs 100 reads inside the same transaction as the log append.
    const rows = [alice, bob, carol].map((who, index) =>
      storedShare({
        id: `share-${who}`,
        userId: who,
        owedAmountMinor: BigInt(index === 0 ? 4000 : 3000),
      }),
    );
    const { tx, store } = txWith(
      rows,
      expenseRow({ totalAmountMinor: BigInt(10000) }),
    );

    await push(
      tx,
      updateChange({
        totalAmountMinor: 10000,
        shares: [
          { userId: alice, owedAmountMinor: 5000 },
          { userId: bob, owedAmountMinor: 3000 },
          { userId: carol, owedAmountMinor: 2000 },
        ],
      }),
    );

    expect(store.findMany).toHaveBeenCalledTimes(1);
    expect(tx.financeExpenseShare.findMany.mock.calls[0][0].where).toEqual({
      sharedExpenseId: expenseId,
    });
  });
});
