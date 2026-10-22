import {
  allocateExpenseShares,
  validMembers,
} from "../finance/groups/group-validation";
// Shared with the REST write boundary: every money read path
// (`getCashFlowSummary`, `AnalyticsService.getNetWorth`, `BudgetsService`)
// matches the currency column as exact upper case, so a device that stored
// "inr" has to be normalised here too or the projection lands a row the
// victim-side dashboards cannot see. `src/finance/accounts/accounts.service.ts`
// is the single writer of that rule; importing it keeps the two paths from
// drifting apart. Nothing in that file's graph reaches `change-projection`, so
// the edge is one-way (`sync` -> `finance`), the same way this module already
// reaches `finance/groups/group-validation`.
import { normaliseCurrency } from "@/finance/accounts/accounts.service";
import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import {
  ChangeOperation,
  EventStatus,
  FinanceTransactionKind,
  Prisma,
  TaskPriority,
  TaskStatus,
} from "@prisma/client";

/**
 * Mirrors an accepted change onto the domain row it describes.
 *
 * The sync log is append-only and a pull replays it verbatim, so for a long time
 * `/sync/push` needed no domain write at all to be correct *for devices* — and
 * that is exactly how the `Note` row became a stale echo. A note edited on a
 * laptop had its text on the log and not in the table, so `GET /notes`, the
 * `search` filter, the AI routes and anything reading `prisma.note` directly
 * answered from the body the note was created with, and a REST edit afterwards
 * logged a payload built from that row: `noteChangePayload` reads its `title`,
 * `content`, `tags`, `color`, `noteType` and `structured` off the row it just
 * wrote, so the version of a note every device then replayed was whichever copy
 * the last *server-side* edit happened to leave behind. Two devices that had
 * never spoken to REST agreed with each other and disagreed with the server.
 *
 * So the projection runs inside the same transaction as the log append, for
 * accepted changes only, and a change that projects onto nothing is refused: the
 * transaction covering that one change rolls back and the change comes home in
 * the response's `rejected` array. Refusing rather than dropping quietly is
 * deliberate — a mirror that silently fails is a row that quietly lies, and the
 * log is the one copy still telling the truth.
 *
 * `note`, `folder`, `task`, `event`, and `calendar` are projected: their payloads
 * are validated by `DOCUMENT_SHAPES` and mapped directly onto the Prisma entity
 * tables, ensuring REST endpoints and sync remain consistent.
 *
 * Three methods, which is the whole surface a projection is allowed. Naming
 * them rather than taking `Prisma.TransactionClient` keeps the pass-through
 * honest — a projection that could `deleteMany` is a projection that will, one
 * day, be given a reason to.
 *
 * The one exception is `financeExpenseShare`, whose read half is `findMany`
 * instead of `findUnique`: a split is a list of rows, and diffing it needs them
 * all at once (see `applyProjectedShareDiff`). What stays refused on that table
 * is the delete. A share row is the only finance row whose absence is a fact
 * worth keeping — a participant who left a split keeps their id and their
 * `deletedAt` so the other devices can see they left — and no projection gets to
 * erase that on a device's behalf.
 */
export type ChangeProjectionClient = {
  note?: Pick<
    Prisma.TransactionClient["note"],
    "findUnique" | "create" | "update"
  >;
  folder?: Pick<
    Prisma.TransactionClient["folder"],
    "findUnique" | "create" | "update"
  >;
  task?: Pick<
    Prisma.TransactionClient["task"],
    "findUnique" | "create" | "update"
  >;
  event?: Pick<
    Prisma.TransactionClient["event"],
    "findUnique" | "create" | "update"
  >;
  calendar?: Pick<
    Prisma.TransactionClient["calendar"],
    "findUnique" | "findFirst" | "create" | "update"
  >;
  financeAccount?: Pick<
    Prisma.TransactionClient["financeAccount"],
    "findUnique" | "create" | "update"
  >;
  financeCategory?: Pick<
    Prisma.TransactionClient["financeCategory"],
    "findUnique" | "create" | "update"
  >;
  financeTransaction?: Pick<
    Prisma.TransactionClient["financeTransaction"],
    "findUnique" | "create" | "update"
  >;
  financeBudget?: Pick<
    Prisma.TransactionClient["financeBudget"],
    "findUnique" | "create" | "update"
  >;
  financeSavingsGoal?: Pick<
    Prisma.TransactionClient["financeSavingsGoal"],
    "findUnique" | "create" | "update"
  >;
  financeRecurringRule?: Pick<
    Prisma.TransactionClient["financeRecurringRule"],
    "findUnique" | "create" | "update"
  >;
  financeLoan?: Pick<
    Prisma.TransactionClient["financeLoan"],
    "findUnique" | "create" | "update"
  >;
  financeGroup?: Pick<
    Prisma.TransactionClient["financeGroup"],
    "findUnique" | "create" | "update"
  >;
  resourceShare?: Pick<
    Prisma.TransactionClient["resourceShare"],
    "findFirst" | "findMany"
  >;
  user?: Pick<Prisma.TransactionClient["user"], "findMany">;
  financeSharedExpense?: Pick<
    Prisma.TransactionClient["financeSharedExpense"],
    "findUnique" | "create" | "update"
  >;
  financeExpenseShare?: Pick<
    Prisma.TransactionClient["financeExpenseShare"],
    "findMany" | "create" | "update"
  >;
  financeSettlement?: Pick<
    Prisma.TransactionClient["financeSettlement"],
    "findUnique" | "create" | "update"
  >;
  financeTrip?: Pick<
    Prisma.TransactionClient["financeTrip"],
    "findUnique" | "create" | "update"
  >;
  financeTripItinerary?: Pick<
    Prisma.TransactionClient["financeTripItinerary"],
    "findUnique" | "create" | "update"
  >;
};

/** One accepted change, as much of it as a projection can use. */
export interface ProjectableChange {
  entityType: string;
  entityId: string;
  operation: ChangeOperation | string;
  version: number;
  payload?: Record<string, any> | null;
}

const logger = new Logger("ChangeProjection");

/**
 * The columns a note payload is allowed to speak, each already narrowed to a
 * value the column can hold.
 *
 * A key that is absent stays absent here: `title` and `content` are required on
 * the wire by `NOTE_FIELDS`, but `tags`, `color`, `noteType` and `structured`
 * are not, and a device on an older build pushes `{title, content}` alone.
 * Writing `tags: []` for that change would clear the user's labels in the table
 * for the same reason the pull path refuses to — the change never spoke about
 * them.
 */
interface NoteColumns {
  title?: string;
  content?: string | null;
  tags?: string[];
  color?: string | null;
  noteType?: string | null;
  structured?: string | null;
}

export async function projectAcceptedChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
): Promise<void> {
  if (change.entityType === "note" && tx?.note) {
    return projectNoteChange(tx, userId, change, payloadOf(change));
  }
  if (change.entityType === "folder" && tx?.folder) {
    return projectFolderChange(tx, userId, change, payloadOf(change));
  }
  if (change.entityType === "task" && tx?.task) {
    return projectTaskChange(tx, userId, change, payloadOf(change));
  }
  if (change.entityType === "event" && tx?.event) {
    return projectEventChange(tx, userId, change, payloadOf(change));
  }
  if (change.entityType === "calendar" && tx?.calendar) {
    return projectCalendarChange(tx, userId, change, payloadOf(change));
  }
  if (change.entityType === "finance_account" && tx?.financeAccount) {
    return projectFinanceAccountChange(tx, userId, change, payloadOf(change));
  }
  if (change.entityType === "finance_category" && tx?.financeCategory) {
    return projectFinanceCategoryChange(tx, userId, change, payloadOf(change));
  }
  if (change.entityType === "finance_transaction" && tx?.financeTransaction) {
    return projectFinanceTransactionChange(
      tx,
      userId,
      change,
      payloadOf(change),
    );
  }
  if (change.entityType === "finance_budget" && tx?.financeBudget) {
    return projectFinanceBudgetChange(tx, userId, change, payloadOf(change));
  }
  if (change.entityType === "finance_savings_goal" && tx?.financeSavingsGoal) {
    return projectFinanceSavingsGoalChange(
      tx,
      userId,
      change,
      payloadOf(change),
    );
  }
  if (
    change.entityType === "finance_recurring_rule" &&
    tx?.financeRecurringRule
  ) {
    return projectFinanceRecurringRuleChange(
      tx,
      userId,
      change,
      payloadOf(change),
    );
  }
  if (change.entityType === "finance_loan" && tx?.financeLoan) {
    return projectFinanceLoanChange(tx, userId, change, payloadOf(change));
  }
  if (change.entityType === "finance_group" && tx?.financeGroup) {
    return projectFinanceGroupChange(tx, userId, change, payloadOf(change));
  }
  if (
    change.entityType === "finance_shared_expense" &&
    tx?.financeSharedExpense
  ) {
    return projectFinanceSharedExpenseChange(
      tx,
      userId,
      change,
      payloadOf(change),
    );
  }
  if (change.entityType === "finance_settlement" && tx?.financeSettlement) {
    return projectFinanceSettlementChange(
      tx,
      userId,
      change,
      payloadOf(change),
    );
  }
  if (change.entityType === "finance_trip" && tx?.financeTrip) {
    return projectFinanceTripChange(tx, userId, change, payloadOf(change));
  }
  if (
    change.entityType === "finance_trip_itinerary" &&
    tx?.financeTripItinerary
  ) {
    return projectFinanceTripItineraryChange(
      tx,
      userId,
      change,
      payloadOf(change),
    );
  }
}

/** A payload that is not an object is a payload that says nothing about any column. */
function payloadOf(change: ProjectableChange): Record<string, any> {
  return change.payload &&
    typeof change.payload === "object" &&
    !Array.isArray(change.payload)
    ? change.payload
    : {};
}

async function projectNoteChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const noteDelegate = tx.note;
  if (!noteDelegate) return;

  // The lookup is deliberately unfiltered by `userId`, and the comparison that
  // follows is the whole of the authorization. `Change` rows are keyed by user
  // and a pull only ever hands a device its own account's log, so `entityId` is
  // the one field in a push that names something the caller does not own — and
  // without this check the projection would be an endpoint that edits any
  // note in the collection by uuid.
  const existing = await noteDelegate.findUnique({
    where: { id: change.entityId },
    select: { userId: true, version: true, deletedAt: true },
  });

  if (existing && existing.userId !== userId) {
    // The change still goes on the caller's log, which is where it belongs and
    // where it is harmless: nobody else ever reads that log. What must not
    // happen is the write to the row.
    logger.warn(
      `Ignored a ${String(change.operation)} change for note ${change.entityId} pushed by ${userId}: the note belongs to ${existing.userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    // Nothing to mark: a note this server has never seen cannot be deleted
    // here, and a tombstone for it would be a row whose only content is a
    // `deletedAt` — which the read paths already filter out, so it would buy
    // nothing and cost a document.
    if (!existing) return;

    // A tombstone is a write, so it answers to the same tie rule the content
    // branches above apply. The push gate in `sync.service.ts` compares against
    // the newest `Change` row, and `MaintenanceProcessor` prunes that log once a
    // change is past retention and no live device is still waiting on it — after
    // which the gate has nothing to compare against and this row is the only
    // answer left. Unguarded, a 40-day-old DELETE queued at version 3 would
    // tombstone a note the owner is at version 40 with *and* stamp 3 onto it, so
    // the row ends up behind its own history and every device that had already
    // deleted-and-raced it disagrees with the table about whether it exists.
    if (losesToWhatTheRowHolds(change, existing)) return;

    await noteDelegate.update({
      where: { id: change.entityId },
      data: {
        // `updatedAt` is left alone: Prisma stamps it, and a hand-written value
        // would be the projection overriding the one column that records when
        // this server last changed the row.
        deletedAt: new Date(),
        version: change.version,
      },
    });
    return;
  }

  const columns = noteColumns(payload);

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await noteDelegate.create({
      data: {
        ...columns,
        id: change.entityId,
        userId,
        // A note whose first change carried no title is a note the user created
        // with an empty one; the client allows that, and `title` is a required
        // column, so the empty string is the answer rather than a throw.
        title: columns.title ?? "",
        version: change.version,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  // The tie rule the client applies to the same change (`SyncManager._apply`),
  // kept identical so the table and a device's copy land on the same answer: an
  // older version never overwrites a newer one, and against a tombstone an
  // equal version loses to the delete, because a delete and the in-flight edit
  // it raced carry the same number. `RESTORE` is exempt — coming back is its
  // entire meaning.
  if (losesToWhatTheRowHolds(change, existing)) return;

  await noteDelegate.update({
    where: { id: change.entityId },
    data: { ...columns, version: change.version, deletedAt: null },
  });
}

async function projectFolderChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const folderDelegate = tx.folder;
  if (!folderDelegate) return;

  const existing = await folderDelegate.findUnique({
    where: { id: change.entityId },
    select: { userId: true, version: true, deletedAt: true },
  });

  if (existing && existing.userId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for folder ${change.entityId} pushed by ${userId}: the folder belongs to ${existing.userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
    // The stale-DELETE tie rule, as in the note branch above. `FoldersService`
    // neither bumps this row's version nor logs a change, so the version the row
    // holds is the one the last accepted change left — which makes this the
    // guard's cheapest case, not its hardest.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await folderDelegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  const columns = folderColumns(payload);

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await folderDelegate.create({
      data: {
        ...columns,
        id: change.entityId,
        userId,
        name: columns.name ?? "",
        version: change.version,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await folderDelegate.update({
    where: { id: change.entityId },
    data: { ...columns, version: change.version, deletedAt: null },
  });
}

/**
 * The version rule a device applies to the same change, kept in one place so the
 * table and a client's copy reach the same answer about whether a row exists.
 *
 * `SyncManager._apply` drops a change older than the row it lands on, and drops
 * an equal one against a tombstone: a delete and the in-flight edit that raced it
 * carry the same number, and the tie goes to the delete. `RESTORE` is exempt,
 * because coming back is the whole of what it means.
 */
function losesToWhatTheRowHolds(
  change: ProjectableChange,
  existing: { version: number; deletedAt: Date | null },
): boolean {
  if (change.operation === ChangeOperation.RESTORE) return false;
  // `!= null` rather than `!== null`: a document written before the column
  // existed has no `deletedAt` key at all, and that is a live row.
  return (
    change.version < existing.version ||
    (existing.deletedAt != null && change.version === existing.version)
  );
}

/** `name`, `type` and `icon`, each narrowed to what its column can hold. */
function folderColumns(payload: Record<string, any>): {
  name?: string;
  type?: string | null;
  icon?: string | null;
} {
  const columns: { name?: string; type?: string | null; icon?: string | null } =
    {};

  if (typeof payload.name === "string") columns.name = payload.name;
  if (isTextOrNull(payload.type)) columns.type = payload.type;
  if (isTextOrNull(payload.icon)) columns.icon = payload.icon;

  return columns;
}

/**
 * Each key the payload really has, narrowed to what its column can hold.
 *
 * `changePayloadRejection` has already refused a change that breaks these rules,
 * so every branch below is a value that cannot reach it — and it is still the
 * projection that would throw on it, costing that one change its write. Narrowing
 * here means a payload from a build this server has not been introduced to
 * costs the columns it got wrong and nothing else.
 */
function noteColumns(payload: Record<string, any>): NoteColumns {
  const columns: NoteColumns = {};

  if (typeof payload.title === "string") columns.title = payload.title;
  if (isTextOrNull(payload.content)) columns.content = payload.content;

  // A list with one non-string in it is not a reason to drop the whole set:
  // `tags` is a column of strings, and the strings in it are the ones the user
  // typed.
  if (Array.isArray(payload.tags)) {
    columns.tags = payload.tags.filter((tag) => typeof tag === "string");
  }

  if (isTextOrNull(payload.color)) columns.color = payload.color;
  if (isTextOrNull(payload.noteType)) columns.noteType = payload.noteType;
  if (isTextOrNull(payload.structured)) columns.structured = payload.structured;

  return columns;
}

function isTextOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * A payload's `transactionKind` as a column value, or `undefined` for "this
 * change says nothing about the classification".
 *
 * The same shape as the `priority`/`status` gates in `taskColumns`: judged
 * against the schema's own enum members rather than a hand-written list, so a
 * value outside them is silence instead of a write. `changePayloadRejection`
 * already refuses one on the push path, so an unreadable value reaching here
 * means a different entry point — and writing `"GARBAGE"` into a Mongo enum
 * column would strand the row outside every filter that reads it, including the
 * `NOT` clause that keeps balance adjustments out of the money totals.
 */
function transactionKindColumn(
  value: unknown,
): FinanceTransactionKind | undefined {
  return typeof value === "string" &&
    Object.values(FinanceTransactionKind).includes(
      value as FinanceTransactionKind,
    )
    ? (value as FinanceTransactionKind)
    : undefined;
}

/**
 * The currency column for a payload value, normalised exactly the way the REST
 * write boundary normalises it (`normaliseCurrency`).
 *
 * A non-string is a currency no device meant: `changePayloadRejection` already
 * refuses one, and the projection is the thing that would otherwise throw
 * `value.trim is not a function` and cost that change its write. Every
 * currency a projection writes goes through here, because a row stored as "inr"
 * is invisible to the exact-upper-case money reads the same way it was before
 * the REST path was fixed — the push mirror simply had not been told.
 */
function currencyColumn(value: unknown): string {
  return normaliseCurrency(typeof value === "string" ? value : null);
}

/**
 * The device's own birth time for the note, or nothing.
 *
 * Only a CREATE carries one, and only a row being created can take it — an
 * existing note's beginning is a fact about it, not a field to be re-stamped by
 * whichever edit arrived next. An unparseable value is skipped rather than
 * written: `new Date("tomorrow")` is an `InvalidDate`, and Prisma would reject
 * the document for it.
 */
function parsedCreatedAt(payload: Record<string, any>): Date | undefined {
  if (typeof payload.createdAt !== "string") return undefined;
  const parsed = new Date(payload.createdAt);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function projectTaskChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const taskDelegate = tx.task;
  if (!taskDelegate) return;

  const existing = await taskDelegate.findUnique({
    where: { id: change.entityId },
    select: { userId: true, version: true, deletedAt: true },
  });

  if (existing && existing.userId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for task ${change.entityId} pushed by ${userId}: the task belongs to ${existing.userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
    // The stale-DELETE tie rule, as in the note branch above.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await taskDelegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  const columns = taskColumns(payload);

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await taskDelegate.create({
      data: {
        ...columns,
        id: change.entityId,
        userId,
        title: columns.title ?? "",
        version: change.version,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await taskDelegate.update({
    where: { id: change.entityId },
    data: { ...columns, version: change.version, deletedAt: null },
  });
}

function taskColumns(payload: Record<string, any>): Record<string, any> {
  const columns: Record<string, any> = {};

  if (typeof payload.title === "string") columns.title = payload.title;
  if (isTextOrNull(payload.description))
    columns.description = payload.description;
  if (isTextOrNull(payload.projectId)) columns.projectId = payload.projectId;
  if (isTextOrNull(payload.sectionId)) columns.sectionId = payload.sectionId;
  if (isTextOrNull(payload.parentId)) columns.parentId = payload.parentId;
  if (
    typeof payload.priority === "string" &&
    Object.values(TaskPriority).includes(payload.priority as TaskPriority)
  ) {
    columns.priority = payload.priority;
  }
  if (
    typeof payload.status === "string" &&
    Object.values(TaskStatus).includes(payload.status as TaskStatus)
  ) {
    columns.status = payload.status;
  } else if (payload.status === "DONE" || payload.isCompleted === true) {
    columns.status = TaskStatus.COMPLETED;
  } else if (payload.isCompleted === false) {
    columns.status = TaskStatus.TODO;
  }
  if (typeof payload.dueDate === "string") {
    const d = new Date(payload.dueDate);
    if (!Number.isNaN(d.getTime())) columns.dueDate = d;
  } else if (payload.dueDate === null) {
    columns.dueDate = null;
  }
  if (isTextOrNull(payload.dueTime)) columns.dueTime = payload.dueTime;
  if (isTextOrNull(payload.recurrenceRule))
    columns.recurrenceRule = payload.recurrenceRule;
  if (typeof payload.completedAt === "string") {
    const d = new Date(payload.completedAt);
    if (!Number.isNaN(d.getTime())) columns.completedAt = d;
  } else if (payload.completedAt === null) {
    columns.completedAt = null;
  }
  if (typeof payload.sortOrder === "number")
    columns.sortOrder = payload.sortOrder;

  return columns;
}

async function projectEventChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const eventDelegate = tx.event;
  if (!eventDelegate) return;

  const existing = await eventDelegate.findUnique({
    where: { id: change.entityId },
    select: { userId: true, version: true, deletedAt: true },
  });

  if (existing && existing.userId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for event ${change.entityId} pushed by ${userId}: the event belongs to ${existing.userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
    // The stale-DELETE tie rule, as in the note branch above.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await eventDelegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  const columns = eventColumns(payload);

  if (!existing) {
    const startAt = columns.startAt ?? new Date();
    const endAt = columns.endAt ?? new Date(startAt.getTime() + 3600000);
    const createdAt = parsedCreatedAt(payload);
    let calendarId = columns.calendarId;
    if (!calendarId && tx.calendar?.findFirst) {
      const cal =
        (await tx.calendar.findFirst({
          where: { userId, isPrimary: true, deletedAt: null },
          select: { id: true },
        })) ??
        (await tx.calendar.findFirst({
          where: { userId, deletedAt: null },
          select: { id: true },
        }));
      if (cal) calendarId = cal.id;
    }
    if (!calendarId) return;

    await eventDelegate.create({
      data: {
        ...columns,
        id: change.entityId,
        userId,
        calendarId,
        title: columns.title ?? "",
        startAt,
        endAt,
        version: change.version,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await eventDelegate.update({
    where: { id: change.entityId },
    data: { ...columns, version: change.version, deletedAt: null },
  });
}

function eventColumns(payload: Record<string, any>): Record<string, any> {
  const columns: Record<string, any> = {};

  if (typeof payload.title === "string") columns.title = payload.title;
  if (isTextOrNull(payload.description))
    columns.description = payload.description;
  if (isTextOrNull(payload.location)) columns.location = payload.location;
  if (typeof payload.calendarId === "string")
    columns.calendarId = payload.calendarId;
  if (typeof payload.startAt === "string") {
    const d = new Date(payload.startAt);
    if (!Number.isNaN(d.getTime())) columns.startAt = d;
  }
  if (typeof payload.endAt === "string") {
    const d = new Date(payload.endAt);
    if (!Number.isNaN(d.getTime())) columns.endAt = d;
  }
  if (typeof payload.isAllDay === "boolean")
    columns.isAllDay = payload.isAllDay;
  if (isTextOrNull(payload.recurrenceRule))
    columns.recurrenceRule = payload.recurrenceRule;
  if (
    typeof payload.status === "string" &&
    Object.values(EventStatus).includes(payload.status as EventStatus)
  ) {
    columns.status = payload.status;
  }
  if (isTextOrNull(payload.color)) columns.color = payload.color;

  return columns;
}

async function projectCalendarChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const calendarDelegate = tx.calendar;
  if (!calendarDelegate) return;

  const existing = await calendarDelegate.findUnique({
    where: { id: change.entityId },
    select: { userId: true, deletedAt: true },
  });

  if (existing && existing.userId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for calendar ${change.entityId} pushed by ${userId}: the calendar belongs to ${existing.userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
    // No tie guard here, and it is not an oversight: `Calendar` has no `version`
    // column (`prisma/schema.prisma:662`), so the row cannot answer the question
    // the guard asks. That cuts both ways — a stale calendar change cannot roll a
    // stored version backwards, because this projection never writes one, and it
    // cannot be refused for being older than the row either. Closing the tombstone
    // half needs the column first, which is a schema change, not a projection
    // change.
    await calendarDelegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date() },
    });
    return;
  }

  const columns = calendarColumns(payload);

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await calendarDelegate.create({
      data: {
        ...columns,
        id: change.entityId,
        userId,
        name: columns.name ?? "New Calendar",
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  await calendarDelegate.update({
    where: { id: change.entityId },
    data: { ...columns, deletedAt: null },
  });
}

function calendarColumns(payload: Record<string, any>): Record<string, any> {
  const columns: Record<string, any> = {};

  if (typeof payload.name === "string") columns.name = payload.name;
  if (isTextOrNull(payload.color)) columns.color = payload.color;
  if (typeof payload.isPrimary === "boolean")
    columns.isPrimary = payload.isPrimary;

  return columns;
}

async function projectFinanceAccountChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const delegate = tx.financeAccount;
  if (!delegate) return;

  const existing = await delegate.findUnique({
    where: { id: change.entityId },
    select: { userId: true, deletedAt: true, version: true },
  });

  if (existing && existing.userId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_account ${change.entityId} pushed by ${userId}: the account belongs to ${existing.userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
    // A tombstone is a write, and `adjustAccount` bumps this row's version on
    // every transaction booked against it without ever logging a
    // `finance_account` change, so the account's own copy of the oplog is
    // regularly *behind* the row. An offline device's stale DELETE at version 3
    // therefore passes the push gate in `sync.service.ts` and, unguarded, would
    // blank out an account the owner is at version 40 with — and stamp 3, after
    // which every legitimate later change looks stale. The tie rule is the one
    // the content branches already apply; `RESTORE` still wins, because coming
    // back is its whole meaning.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  const openingMinor = BigInt(
    Math.round(Number(payload.openingBalanceMinor ?? 0)),
  );
  const currentMinor =
    payload.currentBalanceMinor !== undefined
      ? BigInt(Math.round(Number(payload.currentBalanceMinor)))
      : openingMinor;

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await delegate.create({
      data: {
        id: change.entityId,
        userId,
        name: payload.name ?? "New Account",
        type: payload.type ?? "BANK",
        currency: currencyColumn(payload.currency),
        openingBalanceMinor: openingMinor,
        currentBalanceMinor: currentMinor,
        color: isTextOrNull(payload.color) ? payload.color : null,
        iconKey: isTextOrNull(payload.iconKey) ? payload.iconKey : null,
        isArchived:
          typeof payload.isArchived === "boolean" ? payload.isArchived : false,
        sortOrder:
          typeof payload.sortOrder === "number" ? payload.sortOrder : 0,
        version: change.version,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await delegate.update({
    where: { id: change.entityId },
    data: {
      ...(typeof payload.name === "string" ? { name: payload.name } : {}),
      ...(typeof payload.type === "string"
        ? { type: payload.type as any }
        : {}),
      ...(typeof payload.currency === "string"
        ? { currency: currencyColumn(payload.currency) }
        : {}),
      ...(payload.currentBalanceMinor !== undefined
        ? { currentBalanceMinor: currentMinor }
        : {}),
      ...(isTextOrNull(payload.color) ? { color: payload.color } : {}),
      ...(isTextOrNull(payload.iconKey) ? { iconKey: payload.iconKey } : {}),
      ...(typeof payload.isArchived === "boolean"
        ? { isArchived: payload.isArchived }
        : {}),
      ...(typeof payload.sortOrder === "number"
        ? { sortOrder: payload.sortOrder }
        : {}),
      version: change.version,
      deletedAt: null,
    },
  });
}

async function projectFinanceCategoryChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const delegate = tx.financeCategory;
  if (!delegate) return;

  const existing = await delegate.findUnique({
    where: { id: change.entityId },
    select: { userId: true, deletedAt: true, version: true },
  });

  if (existing && existing.userId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_category ${change.entityId} pushed by ${userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
    // The stale-DELETE tie rule, as in the account branch above.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await delegate.create({
      data: {
        id: change.entityId,
        userId,
        name: payload.name ?? "New Category",
        type: payload.type ?? "EXPENSE",
        iconKey: isTextOrNull(payload.iconKey) ? payload.iconKey : null,
        color: isTextOrNull(payload.color) ? payload.color : null,
        parentId: isTextOrNull(payload.parentId) ? payload.parentId : null,
        isSystem:
          typeof payload.isSystem === "boolean" ? payload.isSystem : false,
        version: change.version,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await delegate.update({
    where: { id: change.entityId },
    data: {
      ...(typeof payload.name === "string" ? { name: payload.name } : {}),
      ...(typeof payload.type === "string"
        ? { type: payload.type as any }
        : {}),
      ...(isTextOrNull(payload.iconKey) ? { iconKey: payload.iconKey } : {}),
      ...(isTextOrNull(payload.color) ? { color: payload.color } : {}),
      ...(isTextOrNull(payload.parentId) ? { parentId: payload.parentId } : {}),
      version: change.version,
      deletedAt: null,
    },
  });
}

/**
 * Whose row a reference the payload names answers to, or nothing at all.
 *
 * `undefined` means the question was never asked — either the change does not
 * speak about that reference, or this projection client has no delegate to ask.
 * A partial client is a test fixture's shape, not a rule about ownership, so it
 * is the one case that cannot be judged; the real `/sync/push` path always hands
 * the whole Prisma transaction client.
 */
async function resolveReferenceOwner(
  delegate: { findUnique: (args: any) => Promise<any> } | undefined,
  ref: string | null,
): Promise<{ userId: string | null } | null | undefined> {
  if (ref === null || !delegate) return undefined;
  return delegate.findUnique({ where: { id: ref }, select: { userId: true } });
}

/**
 * Whether a reference this change names must not be written onto the row.
 *
 * REST asks this question of every reference before it writes
 * (`transactions.service.ts` resolves `accountId`, `toAccountId` and
 * `categoryId` under the caller, `recurring.service.ts` does the same with
 * `assertAccountOwned`/`assertCategoryUsable`), and a push that skipped it plants
 * a row on a victim's account for the victim's own writes to settle:
 * `updateTransaction` and `deleteTransaction` hand `oldTx.accountId` to
 * `adjustAccount`, which updates `financeAccount` under the *transaction* row's
 * owner and moves that account's balance. So a reference the caller may not use
 * is refused here, exactly as the row itself is refused by the owner comparisons
 * above.
 *
 * Fails closed. An id the collection does not answer for is refused alongside a
 * provably foreign one: "nobody owns this account" is not "the pusher owns it",
 * and a row parked on an id that resolves to nothing is a balance no path can
 * attribute — the same way the itinerary branch refuses a parent trip the table
 * does not answer for.
 *
 * `FinanceCategory.userId` is nullable (`prisma/schema.prisma:932`) and the
 * unowned rows are the shared `isSystem` labels analytics serves to everybody,
 * so a `null` owner is usable, not foreign.
 */
function referenceIsUnusable(
  row: { userId: string | null } | null | undefined,
  userId: string,
): boolean {
  if (row === undefined) return false;
  if (row === null) return true;
  return row.userId !== null && row.userId !== userId;
}

/**
 * Whether a failed create means "this row already exists".
 *
 * `FinanceTransaction.id` is a client-chosen `_id` on a MongoDB collection, and
 * since the recurring bill is minted from a deterministic UUIDv5
 * (`recurringTransactionId` in `src/finance/recurring/recurring.service.ts`) two
 * writers can aim at the same `_id` in the same instant: the worker and the
 * phone for one occurrence, or two devices that both generated the same bill
 * offline and pushed it in overlapping requests. Between this projection's
 * `findUnique` and its `create` that race turns into a unique-index violation,
 * which Prisma on MongoDB reports as `P2002` for an interactive transaction and
 * as a raw `E11000` further down the stack.
 *
 * Recognising it is load-bearing in a way it is not for the REST writers. A push
 * appends the `Change` row and projects the domain row inside one `$transaction`
 * (`sync.service.ts:253-273`), and only an `HttpException` coming out of the
 * projection is read as a per-change refusal (`rejectionFromProjection`);
 * anything else stays fatal to the whole batch, on the reasoning that a database
 * outage must not be reported to the device as a decision about its edits. A
 * duplicate key would be caught by that same net and crash a request whose only
 * sin was two devices agreeing on an id. Same recognition as `isAlreadyMintedError`
 * and `isAlreadySeeded`, applied where the caller cannot afford to stop.
 */
function isDuplicateRowIdError(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? "";
  const message = (error as { message?: string })?.message ?? "";
  const target = JSON.stringify(
    (error as { meta?: { target?: unknown } })?.meta?.target,
  );
  return (
    code === "P2002" ||
    code === "E11000" ||
    message.includes("E11000") ||
    message.includes("DuplicateKey") ||
    target?.includes("_id") === true
  );
}

async function projectFinanceTransactionChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const delegate = tx.financeTransaction;
  if (!delegate) return;

  const existing = await delegate.findUnique({
    where: { id: change.entityId },
    select: {
      userId: true,
      deletedAt: true,
      version: true,
    },
  });

  if (existing && existing.userId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_transaction ${change.entityId} pushed by ${userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing || existing.deletedAt) return;
    if (losesToWhatTheRowHolds(change, existing)) return;
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  const amountMinor = BigInt(Math.round(Number(payload.amountMinor ?? 0)));
  const txDate = payload.transactionDate
    ? new Date(payload.transactionDate)
    : new Date();

  const accountRef =
    typeof payload.accountId === "string" ? payload.accountId : null;
  const toAccountRef =
    typeof payload.toAccountId === "string" ? payload.toAccountId : null;
  const categoryRef =
    typeof payload.categoryId === "string" ? payload.categoryId : null;

  const accountRow = await resolveReferenceOwner(tx.financeAccount, accountRef);
  const toAccountRow = await resolveReferenceOwner(
    tx.financeAccount,
    toAccountRef,
  );

  if (
    referenceIsUnusable(accountRow, userId) ||
    referenceIsUnusable(toAccountRow, userId)
  ) {
    // A transfer with one side belonging to somebody else is not a transfer
    // this user can make, and an income or expense parked on a foreign account
    // is the same write wearing a different hat. The change is dropped whole
    // rather than repaired: an account half is not the caller's to settle.
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_transaction ${change.entityId} pushed by ${userId}: it names an account that is not theirs or that the collection does not answer for.`,
    );
    return;
  }

  const categoryRow = await resolveReferenceOwner(
    tx.financeCategory,
    categoryRef,
  );
  // A label is a nullable column and a fact about the money rather than where
  // it sits, so an unusable one costs the label and not the row.
  const categoryIsUnusable = referenceIsUnusable(categoryRow, userId);

  // What this payload offers a row that already exists, built once up here
  // because two paths take it: the row a `findUnique` missed can still be there
  // by the time the `create` runs (see `isDuplicateRowIdError`), and the answer
  // to "somebody else billed this exact occurrence" is the answer a known row
  // gets.
  //
  // A key the payload does not carry stays out of the write rather than being
  // blanked: a device on an older build pushes `{accountId, type, amountMinor,
  // currency, title, transactionDate}` alone, and writing `tags: []` for that
  // change would clear labels the change never spoke about. `notes`, `tags`,
  // `categoryId`, `toAccountId`, `receiptAttachmentId`,
  // `isExcludedFromBudget`, `transactionKind` and `reversalOfTransactionId` are
  // all gated on `!== undefined` for that reason, so a payload that does say
  // `null` clears the column and one that stays silent does not. Silencing
  // `transactionKind` is what keeps a legacy row ordinary cash flow: the write
  // that says nothing leaves the key absent, and the money reads' `NOT` clause
  // counts an absent key as income or spending.
  const kindForUpdate = transactionKindColumn(payload.transactionKind);
  const updateData = {
    ...(typeof payload.accountId === "string"
      ? { accountId: payload.accountId }
      : {}),
    ...(payload.toAccountId !== undefined
      ? {
          toAccountId: isTextOrNull(payload.toAccountId)
            ? payload.toAccountId
            : null,
        }
      : {}),
    ...(payload.categoryId !== undefined
      ? {
          categoryId:
            !categoryIsUnusable && isTextOrNull(payload.categoryId)
              ? payload.categoryId
              : null,
        }
      : {}),
    ...(typeof payload.type === "string" ? { type: payload.type as any } : {}),
    ...(kindForUpdate === undefined ? {} : { transactionKind: kindForUpdate }),
    ...(payload.amountMinor !== undefined ? { amountMinor } : {}),
    ...(typeof payload.currency === "string"
      ? { currency: currencyColumn(payload.currency) }
      : {}),
    ...(typeof payload.title === "string" ? { title: payload.title } : {}),
    ...(payload.notes !== undefined
      ? { notes: isTextOrNull(payload.notes) ? payload.notes : null }
      : {}),
    ...(Array.isArray(payload.tags) ? { tags: payload.tags } : {}),
    ...(payload.transactionDate ? { transactionDate: txDate } : {}),
    ...(payload.receiptAttachmentId !== undefined
      ? {
          receiptAttachmentId: isTextOrNull(payload.receiptAttachmentId)
            ? payload.receiptAttachmentId
            : null,
        }
      : {}),
    ...(payload.isExcludedFromBudget !== undefined
      ? { isExcludedFromBudget: payload.isExcludedFromBudget }
      : {}),
    ...(payload.reversalOfTransactionId !== undefined
      ? {
          reversalOfTransactionId: isTextOrNull(payload.reversalOfTransactionId)
            ? payload.reversalOfTransactionId
            : null,
        }
      : {}),
    ...(payload.loanId !== undefined
      ? {
          loanId: isTextOrNull(payload.loanId)
            ? payload.loanId
            : null,
        }
      : {}),
    version: change.version,
    // An UPDATE or CREATE is a statement that the row lives: the app's own
    // undelete pushes a whole document rather than a DELETE-shaped one, and a
    // payload that means "still deleted" arrives as `DELETE` instead.
    deletedAt: null,
  };

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    try {
      await delegate.create({
        data: {
          id: change.entityId,
          userId,
          accountId: payload.accountId,
          toAccountId: isTextOrNull(payload.toAccountId)
            ? payload.toAccountId
            : null,
          categoryId:
            !categoryIsUnusable && isTextOrNull(payload.categoryId)
              ? payload.categoryId
              : null,
          type: payload.type ?? "EXPENSE",
          // Stated rather than left to the schema default, exactly as
          // `isExcludedFromBudget` below is: a row this projection mints from a
          // payload that predates the classification is ordinary cash flow, and
          // saying so in the document is what lets a later `NOT` filter read it
          // without depending on which Prisma version applies the default.
          transactionKind:
            transactionKindColumn(payload.transactionKind) ??
            FinanceTransactionKind.NORMAL,
          amountMinor,
          currency: currencyColumn(payload.currency),
          title: payload.title ?? "Transaction",
          notes: isTextOrNull(payload.notes) ? payload.notes : null,
          tags: Array.isArray(payload.tags) ? payload.tags : [],
          transactionDate: txDate,
          receiptAttachmentId: isTextOrNull(payload.receiptAttachmentId)
            ? payload.receiptAttachmentId
            : null,
          recurringRuleId: isTextOrNull(payload.recurringRuleId)
            ? payload.recurringRuleId
            : null,
          sharedExpenseId: isTextOrNull(payload.sharedExpenseId)
            ? payload.sharedExpenseId
            : null,
          isExcludedFromBudget:
            typeof payload.isExcludedFromBudget === "boolean"
              ? payload.isExcludedFromBudget
              : false,
          reversalOfTransactionId: isTextOrNull(payload.reversalOfTransactionId)
            ? payload.reversalOfTransactionId
            : null,
          loanId: isTextOrNull(payload.loanId) ? payload.loanId : null,
          version: change.version,
          ...(createdAt ? { createdAt } : {}),
        },
      });
      return;
    } catch (error) {
      if (!isDuplicateRowIdError(error)) throw error;

      // Between the `findUnique` above and this `create`, another writer landed
      // the same `_id` — the worker and a phone both minting one recurring
      // occurrence, or two devices that generated the same bill offline and
      // pushed it in overlapping requests. Re-read it and take the update path,
      // because a collision on a deterministic id is a duplicate of the same
      // fact and not a corrupted push: the change stays accepted, the batch
      // stays alive, and the log keeps one row per edit rather than a crash that
      // would roll back every healthy change queued behind it.
      //
      // Anything the re-read cannot explain is still the original error. No row
      // answering for an id the index just rejected means the database is saying
      // something other than "already billed", and that stays fatal on purpose.
      const raced = await delegate.findUnique({
        where: { id: change.entityId },
        select: { userId: true, deletedAt: true, version: true },
      });
      if (!raced) throw error;

      if (raced.userId !== userId) {
        logger.warn(
          `Ignored a ${String(change.operation)} change for finance_transaction ${change.entityId} pushed by ${userId}: the row that holds this id belongs to ${raced.userId}.`,
        );
        return;
      }

      logger.debug(
        `finance_transaction ${change.entityId} was created while this change was being projected; applied the change as an update instead.`,
      );
      if (losesToWhatTheRowHolds(change, raced)) return;

      await delegate.update({
        where: { id: change.entityId },
        data: updateData,
      });
      return;
    }
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await delegate.update({
    where: { id: change.entityId },
    data: updateData,
  });
}

async function projectFinanceBudgetChange(
  tx: any,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const delegate = tx.financeBudget;
  const existing = await delegate.findUnique({
    where: { id: change.entityId },
    select: {
      userId: true,
      deletedAt: true,
      version: true,
    },
  });

  if (existing && existing.userId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_budget ${change.entityId} pushed by ${userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing || existing.deletedAt) return;
    // The stale-DELETE tie rule, as in the account branch above.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  const amountMinor = BigInt(Math.round(Number(payload.amountMinor ?? 0)));

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await delegate.create({
      data: {
        id: change.entityId,
        userId,
        categoryId: isTextOrNull(payload.categoryId)
          ? payload.categoryId
          : null,
        amountMinor,
        currency:
          typeof payload.currency === "string"
            ? payload.currency.toUpperCase()
            : "INR",
        period: (payload.period as any) ?? "MONTHLY",
        startDate: payload.startDate ? new Date(payload.startDate) : null,
        endDate: payload.endDate ? new Date(payload.endDate) : null,
        alertAt80: payload.alertAt80 ?? true,
        alertAt100: payload.alertAt100 ?? true,
        version: change.version,
        deletedAt: null,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await delegate.update({
    where: { id: change.entityId },
    data: {
      ...(payload.categoryId !== undefined
        ? {
            categoryId: isTextOrNull(payload.categoryId)
              ? payload.categoryId
              : null,
          }
        : {}),
      ...(payload.amountMinor !== undefined ? { amountMinor } : {}),
      ...(typeof payload.currency === "string"
        ? { currency: payload.currency.toUpperCase() }
        : {}),
      ...(payload.period !== undefined
        ? { period: payload.period as any }
        : {}),
      ...(payload.startDate !== undefined
        ? { startDate: payload.startDate ? new Date(payload.startDate) : null }
        : {}),
      ...(payload.endDate !== undefined
        ? { endDate: payload.endDate ? new Date(payload.endDate) : null }
        : {}),
      ...(payload.alertAt80 !== undefined
        ? { alertAt80: payload.alertAt80 }
        : {}),
      ...(payload.alertAt100 !== undefined
        ? { alertAt100: payload.alertAt100 }
        : {}),
      version: change.version,
      deletedAt: null,
    },
  });
}

async function projectFinanceSavingsGoalChange(
  tx: any,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const delegate = tx.financeSavingsGoal;
  const existing = await delegate.findUnique({
    where: { id: change.entityId },
    select: {
      userId: true,
      deletedAt: true,
      version: true,
    },
  });

  if (existing && existing.userId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_savings_goal ${change.entityId} pushed by ${userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing || existing.deletedAt) return;
    // The stale-DELETE tie rule, as in the account branch above.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  const targetAmountMinor = BigInt(
    Math.round(Number(payload.targetAmountMinor ?? 0)),
  );
  const currentAmountMinor = BigInt(
    Math.round(Number(payload.currentAmountMinor ?? 0)),
  );

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await delegate.create({
      data: {
        id: change.entityId,
        userId,
        name: typeof payload.name === "string" ? payload.name : "Savings Goal",
        targetAmountMinor,
        currentAmountMinor,
        currency:
          typeof payload.currency === "string"
            ? payload.currency.toUpperCase()
            : "INR",
        targetDate: payload.targetDate ? new Date(payload.targetDate) : null,
        color: isTextOrNull(payload.color) ? payload.color : null,
        iconKey: isTextOrNull(payload.iconKey) ? payload.iconKey : null,
        isCompleted: payload.isCompleted ?? false,
        version: change.version,
        deletedAt: null,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await delegate.update({
    where: { id: change.entityId },
    data: {
      ...(typeof payload.name === "string" ? { name: payload.name } : {}),
      ...(payload.targetAmountMinor !== undefined ? { targetAmountMinor } : {}),
      ...(payload.currentAmountMinor !== undefined
        ? { currentAmountMinor }
        : {}),
      ...(typeof payload.currency === "string"
        ? { currency: payload.currency.toUpperCase() }
        : {}),
      ...(payload.targetDate !== undefined
        ? {
            targetDate: payload.targetDate
              ? new Date(payload.targetDate)
              : null,
          }
        : {}),
      ...(payload.color !== undefined
        ? { color: isTextOrNull(payload.color) ? payload.color : null }
        : {}),
      ...(payload.iconKey !== undefined
        ? { iconKey: isTextOrNull(payload.iconKey) ? payload.iconKey : null }
        : {}),
      ...(payload.isCompleted !== undefined
        ? { isCompleted: payload.isCompleted }
        : {}),
      version: change.version,
      deletedAt: null,
    },
  });
}

async function projectFinanceRecurringRuleChange(
  tx: any,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const delegate = tx.financeRecurringRule;
  const existing = await delegate.findUnique({
    where: { id: change.entityId },
    select: {
      userId: true,
      deletedAt: true,
      version: true,
    },
  });

  if (existing && existing.userId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_recurring_rule ${change.entityId} pushed by ${userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing || existing.deletedAt) return;
    // The stale-DELETE tie rule, as in the account branch above.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  const amountMinor = BigInt(Math.round(Number(payload.amountMinor ?? 0)));
  const startDate = payload.startDate
    ? new Date(payload.startDate)
    : new Date();
  const nextDueDate = payload.nextDueDate
    ? new Date(payload.nextDueDate)
    : startDate;

  // The same reference rule the transaction branch applies, kept identical: a
  // rule bills against `accountId` for the rest of its life, and the processor
  // half of that chain (`recurring.service.ts` `assertAccountOwned`, and the
  // `processDueRulesScoped` re-check that settles a rule whose account is gone)
  // is already closed server-side — so the projection was the one door left
  // open.
  // A foreign or unknown `accountId` drops the change whole; a label the caller
  // may not use costs the label and not the rule, exactly as the transaction
  // branch treats `categoryId`.
  const accountRef =
    typeof payload.accountId === "string" ? payload.accountId : null;
  const categoryRef =
    typeof payload.categoryId === "string" ? payload.categoryId : null;

  const accountRow = await resolveReferenceOwner(tx.financeAccount, accountRef);
  if (referenceIsUnusable(accountRow, userId)) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_recurring_rule ${change.entityId} pushed by ${userId}: it names an account that is not theirs or that the collection does not answer for.`,
    );
    return;
  }

  const categoryRow = await resolveReferenceOwner(
    tx.financeCategory,
    categoryRef,
  );
  const categoryIsUnusable = referenceIsUnusable(categoryRow, userId);

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await delegate.create({
      data: {
        id: change.entityId,
        userId,
        accountId: payload.accountId,
        categoryId:
          !categoryIsUnusable && isTextOrNull(payload.categoryId)
            ? payload.categoryId
            : null,
        type: (payload.type as any) ?? "EXPENSE",
        amountMinor,
        title:
          typeof payload.title === "string"
            ? payload.title
            : "Recurring Transaction",
        frequency: (payload.frequency as any) ?? "MONTHLY",
        interval: typeof payload.interval === "number" ? payload.interval : 1,
        startDate,
        endDate: payload.endDate ? new Date(payload.endDate) : null,
        nextDueDate,
        lastGeneratedAt: payload.lastGeneratedAt
          ? new Date(payload.lastGeneratedAt)
          : null,
        autoGenerate: payload.autoGenerate ?? true,
        version: change.version,
        deletedAt: null,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await delegate.update({
    where: { id: change.entityId },
    data: {
      ...(typeof payload.accountId === "string"
        ? { accountId: payload.accountId }
        : {}),
      ...(payload.categoryId !== undefined
        ? {
            categoryId:
              !categoryIsUnusable && isTextOrNull(payload.categoryId)
                ? payload.categoryId
                : null,
          }
        : {}),
      ...(payload.type !== undefined ? { type: payload.type as any } : {}),
      ...(payload.amountMinor !== undefined ? { amountMinor } : {}),
      ...(typeof payload.title === "string" ? { title: payload.title } : {}),
      ...(payload.frequency !== undefined
        ? { frequency: payload.frequency as any }
        : {}),
      ...(typeof payload.interval === "number"
        ? { interval: payload.interval }
        : {}),
      ...(payload.startDate !== undefined ? { startDate } : {}),
      ...(payload.endDate !== undefined
        ? { endDate: payload.endDate ? new Date(payload.endDate) : null }
        : {}),
      ...(payload.nextDueDate !== undefined ? { nextDueDate } : {}),
      ...(payload.lastGeneratedAt !== undefined
        ? {
            lastGeneratedAt: payload.lastGeneratedAt
              ? new Date(payload.lastGeneratedAt)
              : null,
          }
        : {}),
      ...(payload.autoGenerate !== undefined
        ? { autoGenerate: payload.autoGenerate }
        : {}),
      version: change.version,
      deletedAt: null,
    },
  });
}

async function projectFinanceLoanChange(
  tx: any,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const delegate = tx.financeLoan;
  const existing = await delegate.findUnique({
    where: { id: change.entityId },
    select: {
      userId: true,
      deletedAt: true,
      version: true,
    },
  });

  if (existing && existing.userId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_loan ${change.entityId} pushed by ${userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing || existing.deletedAt) return;
    // The stale-DELETE tie rule, as in the account branch above.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  const principalAmountMinor = BigInt(
    Math.round(Number(payload.principalAmountMinor ?? 0)),
  );
  const remainingAmountMinor = BigInt(
    Math.round(
      Number(payload.remainingAmountMinor ?? payload.principalAmountMinor ?? 0),
    ),
  );
  const isSettled =
    payload.isSettled !== undefined
      ? Boolean(payload.isSettled)
      : remainingAmountMinor <= 0n;

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await delegate.create({
      data: {
        id: change.entityId,
        userId,
        type: (payload.type as any) ?? "LENT",
        counterpartyName:
          typeof payload.counterpartyName === "string"
            ? payload.counterpartyName
            : "Contact",
        counterpartyContact: isTextOrNull(payload.counterpartyContact)
          ? payload.counterpartyContact
          : null,
        principalAmountMinor,
        remainingAmountMinor,
        currency:
          typeof payload.currency === "string"
            ? payload.currency.toUpperCase()
            : "INR",
        dueDate: payload.dueDate ? new Date(payload.dueDate) : null,
        notes: isTextOrNull(payload.notes) ? payload.notes : null,
        isSettled,
        version: change.version,
        deletedAt: null,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await delegate.update({
    where: { id: change.entityId },
    data: {
      ...(typeof payload.type === "string"
        ? { type: payload.type as any }
        : {}),
      ...(typeof payload.counterpartyName === "string"
        ? { counterpartyName: payload.counterpartyName }
        : {}),
      ...(payload.counterpartyContact !== undefined
        ? {
            counterpartyContact: isTextOrNull(payload.counterpartyContact)
              ? payload.counterpartyContact
              : null,
          }
        : {}),
      ...(payload.principalAmountMinor !== undefined
        ? { principalAmountMinor }
        : {}),
      ...(payload.remainingAmountMinor !== undefined
        ? { remainingAmountMinor }
        : {}),
      ...(typeof payload.currency === "string"
        ? { currency: payload.currency.toUpperCase() }
        : {}),
      ...(payload.dueDate !== undefined
        ? { dueDate: payload.dueDate ? new Date(payload.dueDate) : null }
        : {}),
      ...(payload.notes !== undefined
        ? { notes: isTextOrNull(payload.notes) ? payload.notes : null }
        : {}),
      ...(payload.isSettled !== undefined
        ? { isSettled: Boolean(payload.isSettled) }
        : payload.remainingAmountMinor !== undefined
          ? { isSettled: remainingAmountMinor <= 0n }
          : {}),
      version: change.version,
      deletedAt: null,
    },
  });
}

async function projectFinanceGroupChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const delegate = tx.financeGroup;
  if (!delegate) return;

  const existing = await delegate.findUnique({
    where: { id: change.entityId },
    select: { ownerId: true, deletedAt: true, version: true },
  });

  if (
    existing &&
    existing.ownerId !== userId &&
    (change.operation === ChangeOperation.DELETE ||
      !(await canEditFinanceGroup(tx, userId, change.entityId)))
  ) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_group ${change.entityId} pushed by ${userId}: the group belongs to ${existing.ownerId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
    // The stale-DELETE tie rule, as in the account branch above.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  if (payload.members !== undefined) {
    if (!validMembers(payload.members)) {
      throw new BadRequestException("Invalid group friends.");
    }
    await assertRegisteredGroupMembers(tx, userId, payload.members);
  }

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await delegate.create({
      data: {
        id: change.entityId,
        ownerId: userId,
        members: payload.members ?? [],
        name: typeof payload.name === "string" ? payload.name : "New Group",
        description: isTextOrNull(payload.description)
          ? payload.description
          : null,
        currency: currencyColumn(payload.currency),
        iconKey: isTextOrNull(payload.iconKey) ? payload.iconKey : null,
        isArchived:
          typeof payload.isArchived === "boolean" ? payload.isArchived : false,
        version: change.version,
        deletedAt: null,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await delegate.update({
    where: { id: change.entityId },
    data: {
      ...(payload.members !== undefined ? { members: payload.members } : {}),
      ...(typeof payload.name === "string" ? { name: payload.name } : {}),
      ...(payload.description !== undefined
        ? {
            description: isTextOrNull(payload.description)
              ? payload.description
              : null,
          }
        : {}),
      ...(typeof payload.currency === "string"
        ? { currency: currencyColumn(payload.currency) }
        : {}),
      ...(payload.iconKey !== undefined
        ? { iconKey: isTextOrNull(payload.iconKey) ? payload.iconKey : null }
        : {}),
      ...(typeof payload.isArchived === "boolean"
        ? { isArchived: payload.isArchived }
        : {}),
      version: change.version,
      deletedAt: null,
    },
  });
}

async function canEditFinanceGroup(
  tx: ChangeProjectionClient,
  userId: string,
  groupId: string,
): Promise<boolean> {
  const share = await tx.resourceShare?.findFirst({
    where: {
      resourceType: "EXPENSE_GROUP",
      resourceId: groupId,
      sharedWithUserId: userId,
      deletedAt: null,
      role: { in: ["EDITOR", "ADMIN"] },
    },
  });
  return share != null;
}

/**
 * The trip analogue of `canEditFinanceGroup`, deliberately the same shape: one
 * live grant on *this* trip, held by *this* user, carrying a role with write
 * weight.
 *
 * `ShareResourceType` has always listed `TRIP` (`prisma/schema.prisma:821-827`)
 * and `/collaboration` has always accepted it, but nothing read it back, so a
 * trip grant was a row that granted nothing. It is read the same way the group
 * grant is — `sharedWithUserId` (never the email, which is the invite address and
 * not an identity this server can re-verify), `deletedAt: null` (a revoked grant
 * must stop answering the instant it is revoked) and `role in [EDITOR, ADMIN]`.
 *
 * The role filter is the read/write line, and it is the line the REST side draws
 * too (`trips.service.ts` `getTripById(userId, tripId, canEdit)`): a VIEWER is
 * never admitted by this function, so a VIEWER cannot reach a write through the
 * sync path even though they can see the trip.
 */
async function canEditFinanceTrip(
  tx: ChangeProjectionClient,
  userId: string,
  tripId: string,
): Promise<boolean> {
  const share = await tx.resourceShare?.findFirst({
    where: {
      resourceType: "TRIP",
      resourceId: tripId,
      sharedWithUserId: userId,
      deletedAt: null,
      role: { in: ["EDITOR", "ADMIN"] },
    },
  });
  return share != null;
}

async function assertRegisteredGroupMembers(
  tx: ChangeProjectionClient,
  userId: string,
  members: Array<{ id: string }>,
): Promise<void> {
  const ids = [...new Set(members.map((member) => member.id))].filter(
    (id) => id !== "You" && id !== userId,
  );
  if (!ids.length) return;
  const accounts = await tx.user?.findMany({
    where: { id: { in: ids }, status: "ACTIVE" },
    select: { id: true, deletedAt: true },
  });
  const active = new Set(
    (accounts ?? [])
      .filter((account) => !account.deletedAt)
      .map((account) => account.id),
  );
  if (ids.some((id) => !active.has(id))) {
    throw new BadRequestException(
      "Each friend must be a registered active account.",
    );
  }
}

/**
 * The parent a shared expense or settlement answers to, and the currency it is
 * pinned to.
 *
 * The currency comparison is made normalised on both sides, because that is the
 * only answer consistent with what this module writes: a device that stored
 * "inr" is not asking for a different currency, and refusing it here would abort
 * the whole push over a case difference in a value the projection then
 * normalises anyway.
 */
type FinanceGroupScope = Prisma.FinanceGroupGetPayload<{
  select: { ownerId: true; deletedAt: true; currency: true };
}>;

type FinanceTripScope = Prisma.FinanceTripGetPayload<{
  select: { ownerId: true; deletedAt: true; baseCurrency: true };
}>;

async function findFinanceGroupScope(
  tx: ChangeProjectionClient,
  id: string,
): Promise<FinanceGroupScope | null | undefined> {
  return tx.financeGroup?.findUnique({
    where: { id },
    select: { ownerId: true, deletedAt: true, currency: true },
  });
}

async function findFinanceTripScope(
  tx: ChangeProjectionClient,
  id: string,
): Promise<FinanceTripScope | null | undefined> {
  return tx.financeTrip?.findUnique({
    where: { id },
    select: { ownerId: true, deletedAt: true, baseCurrency: true },
  });
}

/**
 * Write authority over the parent a shared expense or settlement belongs to.
 *
 * Everything this function admits is a *write* — it guards the projection of a
 * pushed `finance_shared_expense` / `finance_settlement` row — so both branches
 * ask for a grant with write weight (`EDITOR`/`ADMIN`) and nothing less. Read
 * authority is a different question with a different answer, and it is asked
 * where reading happens: the REST side (`groups.service.ts` `getGroupById` and
 * `trips.service.ts` `getTripById`) takes a `canEdit` flag, and a `VIEWER` grant
 * passes the read call and fails the write call. This function ignores a VIEWER
 * grant entirely, so opening a trip to a collaborator cannot widen who writes
 * money rows on it.
 *
 * Two refusals and one lock stay exactly as they were: a change that names
 * neither parent is a malformed change (`BadRequestException`), a parent the
 * collection does not answer for is treated the same as one the caller has no
 * claim on (`ForbiddenException`, never a "not found" that would distinguish the
 * two to a probing device), and the child's currency must equal the parent's
 * normalised currency — a grantee is pinned to the trip's `baseCurrency` the
 * same way a group editor is pinned to the group's `currency`.
 */
async function assertSharedScope(
  tx: ChangeProjectionClient,
  userId: string,
  refs: { groupId?: string | null; tripId?: string | null },
  currency?: string,
): Promise<void> {
  if (!refs.groupId && !refs.tripId) {
    throw new BadRequestException("A group or trip is required.");
  }
  if (refs.groupId) {
    const parent = await findFinanceGroupScope(tx, refs.groupId);
    if (
      !parent ||
      parent.deletedAt ||
      (parent.ownerId !== userId &&
        !(await canEditFinanceGroup(tx, userId, refs.groupId)))
    ) {
      throw new ForbiddenException("This group is not available to you.");
    }
    if (
      currency &&
      currencyColumn(parent.currency) !== currencyColumn(currency)
    ) {
      throw new BadRequestException("Use the group currency.");
    }
  }
  if (refs.tripId) {
    const parent = await findFinanceTripScope(tx, refs.tripId);
    if (
      !parent ||
      parent.deletedAt ||
      (parent.ownerId !== userId &&
        !(await canEditFinanceTrip(tx, userId, refs.tripId)))
    ) {
      throw new ForbiddenException("This trip is not available to you.");
    }
    if (
      currency &&
      currencyColumn(parent.baseCurrency) !== currencyColumn(currency)
    ) {
      throw new BadRequestException("Use the trip currency.");
    }
  }
}

/**
 * The key for a change this server will not store because it names somebody the
 * pusher has no authority over.
 *
 * `ErrorCode` carries no ownership key (`src/common/errors/error-code.ts` is not
 * this module's to extend), and the two refusal families have to stay
 * distinguishable: an unstorable *payload* is a bug in the device's builder that
 * will fail identically forever, while a lost *grant* is a group the user has
 * left, and the app wants to drop that row quietly rather than report a broken
 * build. One key each is the only way a client can tell them apart without
 * reading prose.
 */
export const SYNC_PUSH_UNAUTHORIZED = "SYNC_PUSH_UNAUTHORIZED";

function unauthorizedChange(message: string, details: Record<string, unknown>) {
  return new ForbiddenException({
    code: SYNC_PUSH_UNAUTHORIZED,
    message,
    details,
  });
}

/**
 * The user ids this group answers for, or `undefined` when the question cannot be
 * asked.
 *
 * Three sets, because those are the people both this server and the app treat as
 * "in the group": the owner (a member of their own group whether or not they
 * listed themselves), the group's own `members` column — which is exactly the list
 * the client offers in its "Paid by" and "Split with" pickers — and every user
 * holding a live grant on the group, who are precisely the accounts
 * `replicateGroupChange` copies a row like this one to. Refusing a grantee would
 * reject a collaborator the owner has already shared with.
 *
 * It is one read per change rather than one per candidate id because a split names
 * up to 100 participants (`weightOnlyShares`/`validShares` in
 * `change-payload.validator.ts`), and asking each of them separately would put a
 * hundred round trips inside the transaction that also writes the row.
 *
 * Fails closed for a group the collection does not hold (`new Set()` — nobody is a
 * member of nothing, and `assertSharedScope` has already refused such a change on
 * the create path) and stays permissive only where nothing can be known: a
 * projection client without the delegate, or a `members` column that is not the
 * array every writer stores. That is the same concession `resolveReferenceOwner`
 * makes to a client missing a delegate — the real push path always hands the whole
 * transaction client.
 */
async function financeGroupMemberIds(
  tx: ChangeProjectionClient,
  groupId: string,
): Promise<Set<string> | undefined> {
  const group = await tx.financeGroup?.findUnique({
    where: { id: groupId },
    select: { ownerId: true, members: true },
  });
  if (group === undefined) return undefined;
  if (group === null) return new Set<string>();
  if (!Array.isArray(group.members)) return undefined;

  const ids = new Set<string>([group.ownerId]);
  for (const member of group.members as any[]) {
    if (member && typeof member.id === "string") ids.add(member.id);
  }

  if (tx.resourceShare) {
    const grants = await tx.resourceShare.findMany({
      where: {
        resourceType: "EXPENSE_GROUP",
        resourceId: groupId,
        deletedAt: null,
      },
      select: { sharedWithUserId: true },
    });
    if (grants === undefined) return undefined;
    for (const grant of grants as Array<{ sharedWithUserId: string }>) {
      ids.add(grant.sharedWithUserId);
    }
  }
  return ids;
}

/**
 * Keep the actor in the same participant set used for settlement endpoints.
 *
 * `assertSharedScope` establishes write authority first (owner or an
 * EDITOR/ADMIN grant). This second, deliberately adjacent assertion makes the
 * invariant explicit at the point a settlement can be re-pointed: the author
 * and both people named by the payment must all belong to its *destination*
 * group. It also fails closed if those two sources of authority ever drift.
 */
function assertSettlementAuthorMembership(
  userId: string,
  refs: { groupId?: string | null },
  membership: Set<string> | undefined,
): void {
  if (!refs.groupId) return;
  if (membership?.has(userId) == true) return;
  throw unauthorizedChange(
    "You are not a member of the group this settlement belongs to.",
    { groupId: refs.groupId, userId },
  );
}

/**
 * Whose name this expense is credited with, checked against the group being
 * written rather than taken from the payload.
 *
 * `resolveReferenceOwner` is the pattern every other caller-supplied foreign key
 * in this file follows, and the shared expense was the one that skipped it: the
 * validator only asserts that `paidByUserId` is "a string"
 * (`change-payload.validator.ts`), so any id an EDITOR could name was stamped
 * onto a row the sync path then propagated to that person's own devices — strictly
 * weaker than `POST /finance/groups/:id/expenses` for the same row.
 *
 * Two coercions survive on purpose, because they are the ones that existed before
 * this guard and cost nobody a reference:
 * - a change that does not name a payer credits the pusher, and
 * - `"You"`, the client's local id for itself inside a member list, means the
 *   pusher — `assertRegisteredGroupMembers` already reads it that way, and a
 *   device that queued an expense before its group snapshot landed would
 *   otherwise lose the change to a membership test it cannot pass yet.
 * A payer that is named, is not the pusher, and is not in the group is refused:
 * silently rewriting it to the pusher would store a document the device never
 * authored, which is the thing this file's whole stale-write rule exists to avoid.
 */
function resolveSharedExpensePayer(
  userId: string,
  refs: { groupId?: string | null; tripId?: string | null },
  membership: Set<string> | undefined,
  payload: Record<string, any>,
): string {
  const named = payload.paidByUserId;
  if (named === undefined || named === null || typeof named !== "string") {
    return userId;
  }
  if (named === "You" || named === userId) return userId;

  if (!refs.groupId) {
    // A trip-only expense has no member list: the trip is the pusher's alone, so
    // the only payer this scope can vouch for is the pusher.
    throw unauthorizedChange(
      "This expense names a payer the group you are writing to does not include.",
      { tripId: refs.tripId, paidByUserId: named },
    );
  }
  if (membership && !membership.has(named)) {
    throw unauthorizedChange(
      "This expense names a payer who is not a member of the group.",
      { groupId: refs.groupId, paidByUserId: named },
    );
  }
  return named;
}

/**
 * Every participant a pushed split names, held to the same membership the payer
 * is held to.
 *
 * The payer says who is owed; a share row says who owes, and `readBalances`
 * (`groups.service.ts`) sums those rows into a debt attributed to the user id
 * written beside them. An id outside the group therefore does two things with one
 * forged change: it invents an obligation on somebody who never agreed to it, and
 * it makes that person's balance depend on a row no device of theirs authored —
 * `replicateGroupChange` copies this very change into the *victim's* oplog, so the
 * debt renders on their screens as something they made. `shares[].userId` was
 * checked for uniqueness only (`change-payload.validator.ts`), never membership.
 *
 * The same two coercions the payer branch allows: `"You"` and the pusher's own id
 * are one participant, and the pusher is in this group by construction because
 * `assertSharedScope` just proved they own it or hold an EDITOR/ADMIN grant on it.
 * A trip-only expense has no participant list at all, which is why a foreign
 * participant there is refused rather than waved through — same rule, same reason
 * as the payer branch above.
 *
 * Only the shares the change speaks are judged: an UPDATE that rewords a title
 * leaves the stored participants alone, and refusing them here would refuse a
 * change that does not mention them.
 */
function assertSharedExpenseParticipants(
  userId: string,
  refs: { groupId?: string | null; tripId?: string | null },
  membership: Set<string> | undefined,
  shares: unknown,
): void {
  if (!Array.isArray(shares)) return; // the allocator already refuses a non-list

  const strangers = new Set<string>();
  for (const share of shares as any[]) {
    const participant = share?.userId;
    if (typeof participant !== "string") continue;
    if (participant === "You" || participant === userId) continue;
    // `membership` is only unresolved in two different ways: no group at all, in
    // which case nobody but the pusher can be vouched for, and a group the
    // collection cannot describe, in which case nothing is provable and the
    // participant passes.
    if (!membership) {
      if (!refs.groupId) strangers.add(participant);
    } else if (!membership.has(participant)) {
      strangers.add(participant);
    }
  }
  if (strangers.size === 0) return;

  if (!refs.groupId) {
    throw unauthorizedChange(
      "This split assigns a share to somebody the trip you are writing to has no participant list for.",
      { tripId: refs.tripId, participants: [...strangers] },
    );
  }
  throw unauthorizedChange(
    "This split assigns a share to somebody who is not a member of the group.",
    { groupId: refs.groupId, participants: [...strangers] },
  );
}

/**
 * Whose payment a pushed settlement names (`fromUserId` who paid or `toUserId` who received),
 * checked against the group being written rather than taken from the payload verbatim.
 *
 * Like `resolveSharedExpensePayer`, settlements replicate through `replicateGroupChange`
 * to every member of the group and shift debts in `readBalances`. An attacker who could
 * name an arbitrary user for `fromUserId` or `toUserId` would forge obligations or payments
 * on victims who never authored or agreed to them.
 *
 * Coercions:
 * - `"You"` and the pusher's own id resolve to `userId`.
 * - In a trip without a group (trip-only), only the pusher is vouched for; naming an external user is refused.
 * - When `membership` is defined, foreign participants are refused with `SYNC_PUSH_UNAUTHORIZED`.
 */
function resolveSettlementParticipant(
  userId: string,
  refs: { groupId?: string | null; tripId?: string | null },
  membership: Set<string> | undefined,
  field: "fromUserId" | "toUserId",
  named: unknown,
): string {
  if (named === undefined || named === null || typeof named !== "string") {
    return field === "fromUserId" ? userId : "";
  }
  if (named === "You" || named === userId) return userId;

  if (!refs.groupId) {
    throw unauthorizedChange(
      "This settlement names a participant the group you are writing to does not include.",
      { tripId: refs.tripId, [field]: named },
    );
  }
  if (membership && !membership.has(named)) {
    throw unauthorizedChange(
      "This settlement names a participant who is not a member of the group.",
      { groupId: refs.groupId, [field]: named },
    );
  }
  return named;
}

/**
 * The account a shared expense was paid from, or `null`.
 *
 * The payer id says *who*; this says *whose money*, and it is the reference that
 * must not be pointed at somebody else's private ledger. The account is resolved
 * through the same helper the transaction branch uses, so an id the collection
 * does not answer for is refused alongside a provably foreign one, and what lands
 * is always an account the pusher owns — the group member writing this row, whose
 * authority over the group `assertSharedScope` just proved. That is the checkable
 * form of "an account of this group": `FinanceAccount` has no group column, so a
 * group-owned account does not exist to point at, and the REST write boundary
 * resolves the same field under the caller
 * (`groups.service.ts` `assertAccountScope`) for the same reason.
 *
 * A value that is not a string stays the coercion to `null` this branch already
 * performed, so the only behaviour that changes here is the forged reference.
 */
async function resolvePayerAccount(
  tx: ChangeProjectionClient,
  userId: string,
  payload: Record<string, any>,
): Promise<string | null> {
  const ref =
    typeof payload.payerAccountId === "string" ? payload.payerAccountId : null;
  if (ref === null) return null;

  const owner = await resolveReferenceOwner(tx.financeAccount, ref);
  if (referenceIsUnusable(owner, userId)) {
    throw unauthorizedChange(
      "This expense is paid from an account that is not yours.",
      { payerAccountId: ref },
    );
  }
  return ref;
}

/** One participant's slice of the split, as the allocator decided it. */
interface ProjectedShare {
  userId: string;
  owedAmountMinor: number;
  shareUnits: number | null;
}

/** What one share on the wire says about its own settlement, if anything. */
interface StatedSettlement {
  isSettled?: boolean;
  settledAt?: Date | null;
}

/**
 * The settle facts a pushed share states, keyed by `userId`.
 *
 * They cannot come from `allocateExpenseShares`, which returns exactly three keys
 * (`userId`, `owedAmountMinor`, `shareUnits`) because the amounts are the only
 * thing it is asked to decide. So the flags are read off the payload the device
 * actually sent — and read here rather than at each write site, because a
 * `settledAt` that is a string no `Date` accepts is a share stating no settle
 * fact. `change-payload.validator.ts` already refuses that shape on the wire; this
 * is the same answer for any caller that reached the projection another way.
 */
function pushedShareSettlement(shares: unknown): Map<string, StatedSettlement> {
  const byUser = new Map<string, StatedSettlement>();
  if (!Array.isArray(shares)) return byUser;

  for (const share of shares as any[]) {
    if (!share || typeof share.userId !== "string") continue;
    const stated: StatedSettlement = {};
    if (typeof share.isSettled === "boolean")
      stated.isSettled = share.isSettled;
    if (share.settledAt === null) {
      stated.settledAt = null;
    } else if (typeof share.settledAt === "string") {
      const parsed = new Date(share.settledAt);
      if (!Number.isNaN(parsed.getTime())) stated.settledAt = parsed;
    }
    if (stated.isSettled !== undefined || stated.settledAt !== undefined) {
      byUser.set(share.userId, stated);
    }
  }

  return byUser;
}

/**
 * Rewrite a split in place, keyed on `userId`, for a change that arrived from a
 * device.
 *
 * This is the projection's copy of `groups.service.ts` `applyShareDiff`, and the
 * semantics are deliberately identical: rows move where they lie, only rows whose
 * amount or weight really moved are written, `isSettled`/`settledAt` are never
 * touched by an edit that only moved money, and a participant the payload stopped
 * listing is tombstoned instead of deleted. It is a copy and not an import for one
 * reason — that one is a private method on the service and reaches the table
 * through the service's own client, and sharing it would mean editing a file this
 * pass does not own.
 *
 * The version that replaces here was one nested write on the parent row,
 * `shares: { deleteMany: {}, create: [...] }`, and on this path it cost more than
 * it cost over REST: a device pushes an edit to an expense it already holds, so
 * every share id in its local table went stale on every other device, the
 * tombstones the REST diff had written came back as live rows (a participant who
 * left a split was suddenly in it again, and `readBalances` charges them for it),
 * and `isSettled`/`settledAt`/`version` were dropped on the floor because the
 * three keys the rebuild created never mentioned them.
 *
 * Two things this path does that a plain live-rows-only diff would get wrong.
 * Tombstones are read as well as live rows, so a participant who left and rejoined
 * from a phone revives the row they already have an id for instead of stacking a
 * second one — the REST diff in `groups.service.ts` reads the same way now, and
 * that agreement is the point: the two transports must not disagree about whether
 * a rejoined participant is the same person. And the settle facts come from the
 * payload for the rows the payload is describing for the first time (an insert, or
 * a revival), because a share a phone pushed already settled has no other
 * transport that can say so.
 *
 * Everything runs on the `tx` this projection was handed, after the parent row is
 * written and before the change's log entry can commit: a share write that throws
 * takes the parent update down with it, which is the only way the mirror and the
 * log can agree about a refused change.
 */
async function applyProjectedShareDiff(
  tx: ChangeProjectionClient,
  expenseId: string,
  requested: ProjectedShare[],
  settlement: Map<string, StatedSettlement>,
): Promise<void> {
  const delegate = tx.financeExpenseShare;
  if (!delegate) {
    // Only a client that does not carry the table can get here — the real
    // `Prisma.TransactionClient` `/sync/push` hands in always does. Warn rather
    // than stay silent: a split that did not land is a row that lies.
    logger.warn(
      `Skipped the share diff for finance_shared_expense ${expenseId}: the projection client has no financeExpenseShare delegate.`,
    );
    return;
  }

  // One read for the whole diff, ordered so that two devices describing the same
  // split write the same rows in the same sequence. Code-point order on `userId`,
  // then `createdAt` so that the newest row for a participant wins when a REST
  // rejoin and a device rejoin have left two.
  const rows = await delegate.findMany({
    where: { sharedExpenseId: expenseId },
    orderBy: [{ userId: "asc" }, { createdAt: "asc" }],
  });

  const liveByUser = new Map<string, (typeof rows)[number]>();
  const tombstoneByUser = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    // `!= null` and not `!== null`, as elsewhere in this file: a share written
    // before the column existed has no `deletedAt` key at all, and that is a live
    // row — rebuilding it here would be the erasure this diff exists to stop.
    if (row.deletedAt == null) {
      if (!liveByUser.has(row.userId)) liveByUser.set(row.userId, row);
    } else {
      tombstoneByUser.set(row.userId, row);
    }
  }

  const wanted = new Set(requested.map((share) => share.userId));
  const deletedAt = new Date();

  for (const share of requested) {
    const owedAmountMinor = BigInt(share.owedAmountMinor);
    const shareUnits = share.shareUnits ?? null;
    const live = liveByUser.get(share.userId);

    if (live) {
      if (
        Number(live.owedAmountMinor) === share.owedAmountMinor &&
        (live.shareUnits ?? null) === shareUnits
      ) {
        // Nothing to write, so nothing is bumped: a replay of a split that has not
        // moved cannot look like an edit another device has to win against.
        continue;
      }
      // No `isSettled` / `settledAt` in this write, exactly as in `applyShareDiff`.
      // Only the participant who owes the money settles it, and a push that moved
      // an amount must not be able to undo that from another device — the stored
      // row is the one that knows whether this share is paid.
      await delegate.update({
        where: { id: live.id },
        data: {
          owedAmountMinor,
          shareUnits,
          version: { increment: 1 },
        },
      });
      continue;
    }

    const stated = settlement.get(share.userId);
    const revived = tombstoneByUser.get(share.userId);

    if (revived) {
      // The rejoining participant keeps the row — and so keeps the id every device
      // that ever saw them still holds. A tombstone coming back is a share this
      // push is describing from scratch, so the settle facts it states are applied
      // here; a push that states nothing (`userId`/amount/weight only, the payload
      // every shipping build sends) leaves the stored ones alone.
      await delegate.update({
        where: { id: revived.id },
        data: {
          owedAmountMinor,
          shareUnits,
          deletedAt: null,
          ...(stated?.isSettled !== undefined
            ? { isSettled: stated.isSettled }
            : {}),
          ...(stated?.settledAt !== undefined
            ? { settledAt: stated.settledAt }
            : {}),
          version: { increment: 1 },
        },
      });
      continue;
    }

    await delegate.create({
      data: {
        sharedExpenseId: expenseId,
        userId: share.userId,
        owedAmountMinor,
        shareUnits,
        ...(stated?.isSettled !== undefined
          ? { isSettled: stated.isSettled }
          : {}),
        ...(stated?.settledAt !== undefined
          ? { settledAt: stated.settledAt }
          : {}),
      },
    });
  }

  // Live in the table, absent from the payload: out of the split, not out of the
  // database. The row keeps its id, its amount and its settle facts, and the only
  // things that move are the tombstone and the version — which is what lets a pull
  // tell every other device that this participant left.
  for (const row of liveByUser.values()) {
    if (wanted.has(row.userId)) continue;
    await delegate.update({
      where: { id: row.id },
      data: { deletedAt, version: { increment: 1 } },
    });
  }
}

async function projectFinanceSharedExpenseChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const delegate = tx.financeSharedExpense;
  if (!delegate) return;

  const existing = await delegate.findUnique({
    where: { id: change.entityId },
    select: {
      groupId: true,
      tripId: true,
      totalAmountMinor: true,
      splitType: true,
      deletedAt: true,
      version: true,
    },
  });

  if (existing) await assertSharedScope(tx, userId, existing);
  if (change.operation !== ChangeOperation.DELETE) {
    await assertSharedScope(
      tx,
      userId,
      {
        groupId: payload.groupId ?? existing?.groupId,
        tripId: payload.tripId ?? existing?.tripId,
      },
      payload.currency,
    );
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
    // The stale-DELETE tie rule, as in the account branch above.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  // The two references that say who paid, resolved against the group this change
  // writes into before anything is spent on arithmetic. Both are the pusher's to
  // name only inside that group's membership, and the account additionally has to
  // be one the pusher owns.
  const scope = {
    groupId: isTextOrNull(payload.groupId)
      ? payload.groupId
      : (existing?.groupId ?? null),
    tripId: isTextOrNull(payload.tripId)
      ? payload.tripId
      : (existing?.tripId ?? null),
  };
  // One membership read for the payer and every share together, rather than one
  // per named participant.
  const members = scope.groupId
    ? await financeGroupMemberIds(tx, scope.groupId)
    : undefined;

  const paidByUserId = resolveSharedExpensePayer(
    userId,
    scope,
    members,
    payload,
  );
  assertSharedExpenseParticipants(userId, scope, members, payload.shares);
  const payerAccountId = await resolvePayerAccount(tx, userId, payload);

  // The amounts come from the same allocator the REST write path uses
  // (`groups.service.ts`), imported rather than re-derived here: a device that
  // queues an honest three-way split of 10000 (3333 x 3, because its own
  // `SplitCalculator` rounded the other way on an older build) was accepted over
  // `POST /finance/groups/:id/expenses` and refused by `/sync/push`, so the same
  // action answered differently by transport. `EQUAL`, `PERCENTAGE` and `SHARES`
  // are allocated by weight with the largest-remainder pass; `EXACT` and
  // `ITEMIZED` keep the exact-sum contract through the same call, and so do the
  // non-negative / unique-participant / positive-total guarantees.
  //
  // It still throws. That is the established shape of this file —
  // `assertSharedScope` already throws `BadRequestException` and
  // `ForbiddenException` mid-projection — and `/sync/push` now answers a throw
  // with a per-change rejection: this change is refused with the code the
  // projection put on it, its own transaction rolls back, and every other change
  // in the request is applied and committed. A split no device can replay still
  // costs the push exactly what the REST path would have cost the same split.
  const totalMinorNumber = Math.round(
    Number(payload.totalAmountMinor ?? existing?.totalAmountMinor ?? 0),
  );

  const allocated =
    payload.shares !== undefined || !existing
      ? allocateExpenseShares(
          totalMinorNumber,
          payload.shares,
          payload.splitType ?? existing?.splitType,
        )
      : undefined;

  // The settle facts this push states, read once for both branches: the CREATE
  // below nests them in `shareData`, the UPDATE hands the same map to
  // `applyProjectedShareDiff`. Reading the payload twice — once here, once at that
  // call — is how the two branches drifted apart about these keys in the first
  // place, and one read is what keeps one payload meaning one thing.
  const settlement = pushedShareSettlement(payload.shares);

  // The nested list, and only for the CREATE below: a brand-new expense has no
  // rows to diff, so `shares: { create: shareData }` is the whole of what it needs.
  // The UPDATE branch does not use this — it hands `allocated` and `settlement` to
  // `applyProjectedShareDiff`, which writes the rows one by one.
  //
  // The flags travel with the row's birth, and after that the settlement flow owns
  // them: a CREATE writes the `isSettled` / `settledAt` a share states, and the
  // UPDATE diff never rewrites either one on an existing live row. That asymmetry
  // is deliberate. A phone that recorded "Bala paid me back" and pushes the expense
  // for the first time has no other transport that can say so, while a device that
  // only moved an amount must not be able to undo a settlement the participant who
  // owes the money already made.
  //
  // A stated share-level `version` is deliberately not read here. The parent row
  // takes `version: change.version` because the log entry this change is filed
  // under really is that edit, and `applyProjectedShareDiff` increments a share row
  // once per edit it applies — so a row that has never existed has no edit history
  // to claim, and a client that names 40 gets the column's `@default(1)` instead of
  // a count it invented. It is the same answer `applyShareDiff` gives over REST.
  const shareData = allocated?.map((share) => {
    const stated = settlement.get(share.userId);
    return {
      userId: share.userId,
      owedAmountMinor: BigInt(share.owedAmountMinor),
      shareUnits: share.shareUnits ?? null,
      // Stated or absent, never defaulted here: a payload that says nothing about
      // settlement keeps creating `isSettled = false` / `settledAt = null` rows
      // through the schema defaults, exactly as it did before these keys existed.
      ...(stated?.isSettled !== undefined
        ? { isSettled: stated.isSettled }
        : {}),
      ...(stated?.settledAt !== undefined
        ? { settledAt: stated.settledAt }
        : {}),
    };
  });

  const totalAmountMinor = BigInt(
    Math.round(Number(payload.totalAmountMinor ?? 0)),
  );
  const date = payload.date ? new Date(payload.date) : new Date();

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await delegate.create({
      data: {
        id: change.entityId,
        groupId: isTextOrNull(payload.groupId) ? payload.groupId : null,
        tripId: isTextOrNull(payload.tripId) ? payload.tripId : null,
        paidByUserId,
        payerAccountId,
        title:
          typeof payload.title === "string" ? payload.title : "Shared Expense",
        totalAmountMinor,
        ...(shareData ? { shares: { create: shareData } } : {}),
        currency: currencyColumn(payload.currency),
        splitType: (payload.splitType as any) ?? "EQUAL",
        date,
        notes: isTextOrNull(payload.notes) ? payload.notes : null,
        receiptAttachmentId: isTextOrNull(payload.receiptAttachmentId)
          ? payload.receiptAttachmentId
          : null,
        version: change.version,
        deletedAt: null,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await delegate.update({
    where: { id: change.entityId },
    data: {
      ...(payload.groupId !== undefined
        ? { groupId: isTextOrNull(payload.groupId) ? payload.groupId : null }
        : {}),
      ...(payload.tripId !== undefined
        ? { tripId: isTextOrNull(payload.tripId) ? payload.tripId : null }
        : {}),
      ...(typeof payload.paidByUserId === "string" ? { paidByUserId } : {}),
      ...(payload.payerAccountId !== undefined ? { payerAccountId } : {}),
      ...(typeof payload.title === "string" ? { title: payload.title } : {}),
      ...(payload.totalAmountMinor !== undefined ? { totalAmountMinor } : {}),
      ...(typeof payload.currency === "string"
        ? { currency: currencyColumn(payload.currency) }
        : {}),
      ...(payload.splitType !== undefined
        ? { splitType: payload.splitType as any }
        : {}),
      ...(payload.date !== undefined ? { date } : {}),
      ...(payload.notes !== undefined
        ? { notes: isTextOrNull(payload.notes) ? payload.notes : null }
        : {}),
      ...(payload.receiptAttachmentId !== undefined
        ? {
            receiptAttachmentId: isTextOrNull(payload.receiptAttachmentId)
              ? payload.receiptAttachmentId
              : null,
          }
        : {}),
      version: change.version,
      deletedAt: null,
    },
  });

  // The split moves on its own rows, and it moves after the parent write instead
  // of nested inside it. `shareData` is what the CREATE branch above nests — the
  // rows here already exist, so nesting would be the rebuild this diff replaces.
  // A change that says nothing about the split (`allocated` is `undefined`) leaves
  // every share row exactly where it is: no version churn, no lost `isSettled`.
  // The `settlement` map is the one the CREATE path above reads from the same
  // payload, so the two branches cannot answer the same keys differently.
  if (allocated) {
    await applyProjectedShareDiff(tx, change.entityId, allocated, settlement);
  }
}

async function projectFinanceSettlementChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const delegate = tx.financeSettlement;
  if (!delegate) return;

  const existing = await delegate.findUnique({
    where: { id: change.entityId },
    select: {
      groupId: true,
      tripId: true,
      fromUserId: true,
      toUserId: true,
      deletedAt: true,
      version: true,
    },
  });

  if (existing) await assertSharedScope(tx, userId, existing);
  if (change.operation !== ChangeOperation.DELETE) {
    await assertSharedScope(
      tx,
      userId,
      {
        groupId: payload.groupId ?? existing?.groupId,
        tripId: payload.tripId ?? existing?.tripId,
      },
      payload.currency,
    );
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
    // The stale-DELETE tie rule, as in the account branch above.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  const scope = {
    groupId: isTextOrNull(payload.groupId)
      ? payload.groupId
      : (existing?.groupId ?? null),
    tripId: isTextOrNull(payload.tripId)
      ? payload.tripId
      : (existing?.tripId ?? null),
  };
  const members = scope.groupId
    ? await financeGroupMemberIds(tx, scope.groupId)
    : undefined;
  assertSettlementAuthorMembership(userId, scope, members);

  const resolvedFrom =
    payload.fromUserId !== undefined
      ? resolveSettlementParticipant(
          userId,
          scope,
          members,
          "fromUserId",
          payload.fromUserId,
        )
      : existing?.fromUserId;
  const resolvedTo =
    payload.toUserId !== undefined
      ? resolveSettlementParticipant(
          userId,
          scope,
          members,
          "toUserId",
          payload.toUserId,
        )
      : existing?.toUserId;

  if (
    !resolvedFrom ||
    !resolvedTo ||
    resolvedFrom === resolvedTo ||
    (payload.amountMinor !== undefined &&
      (!Number.isSafeInteger(payload.amountMinor) || payload.amountMinor <= 0))
  )
    throw new BadRequestException("Invalid payment.");
  const amountMinor = BigInt(Math.round(Number(payload.amountMinor ?? 0)));
  const date = payload.date ? new Date(payload.date) : new Date();

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await delegate.create({
      data: {
        id: change.entityId,
        groupId: isTextOrNull(payload.groupId) ? payload.groupId : null,
        tripId: isTextOrNull(payload.tripId) ? payload.tripId : null,
        fromUserId: resolvedFrom,
        toUserId: resolvedTo,
        amountMinor,
        currency: currencyColumn(payload.currency),
        date,
        notes: isTextOrNull(payload.notes) ? payload.notes : null,
        paymentMethod: isTextOrNull(payload.paymentMethod)
          ? payload.paymentMethod
          : null,
        version: change.version,
        deletedAt: null,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await delegate.update({
    where: { id: change.entityId },
    data: {
      ...(payload.groupId !== undefined
        ? { groupId: isTextOrNull(payload.groupId) ? payload.groupId : null }
        : {}),
      ...(payload.tripId !== undefined
        ? { tripId: isTextOrNull(payload.tripId) ? payload.tripId : null }
        : {}),
      ...(typeof payload.fromUserId === "string"
        ? { fromUserId: resolvedFrom }
        : {}),
      ...(typeof payload.toUserId === "string" ? { toUserId: resolvedTo } : {}),
      ...(payload.amountMinor !== undefined ? { amountMinor } : {}),
      ...(typeof payload.currency === "string"
        ? { currency: currencyColumn(payload.currency) }
        : {}),
      ...(payload.date !== undefined ? { date } : {}),
      ...(payload.notes !== undefined
        ? { notes: isTextOrNull(payload.notes) ? payload.notes : null }
        : {}),
      ...(payload.paymentMethod !== undefined
        ? {
            paymentMethod: isTextOrNull(payload.paymentMethod)
              ? payload.paymentMethod
              : null,
          }
        : {}),
      version: change.version,
      deletedAt: null,
    },
  });
}

async function projectFinanceTripChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const delegate = tx.financeTrip;
  if (!delegate) return;

  const existing = await delegate.findUnique({
    where: { id: change.entityId },
    select: { ownerId: true, deletedAt: true, version: true },
  });

  // The trip belongs to somebody else. That is not the end of the question any
  // more, because `ShareResourceType.TRIP` is a real grant now: an EDITOR or
  // ADMIN the owner shared the trip with edits it from their own device, and the
  // change arrives on their log like any other. The rule is the group's, copied
  // exactly — write operations need the grant, and a DELETE never buys one:
  // `trips.service.ts` `deleteTrip` refuses a non-owner over REST, and a push
  // that could tombstone a trip the pusher does not own would be the wider door.
  if (
    existing &&
    existing.ownerId !== userId &&
    (change.operation === ChangeOperation.DELETE ||
      !(await canEditFinanceTrip(tx, userId, change.entityId)))
  ) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_trip ${change.entityId} pushed by ${userId}: the trip belongs to ${existing.ownerId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
    // The stale-DELETE tie rule, as in the account branch above.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  const startDate = payload.startDate
    ? new Date(payload.startDate)
    : new Date();
  const endDate = payload.endDate ? new Date(payload.endDate) : startDate;
  const totalBudgetMinor =
    payload.totalBudgetMinor !== undefined && payload.totalBudgetMinor !== null
      ? BigInt(Math.round(Number(payload.totalBudgetMinor)))
      : null;

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await delegate.create({
      data: {
        id: change.entityId,
        ownerId: userId,
        title: typeof payload.title === "string" ? payload.title : "New Trip",
        destinations: Array.isArray(payload.destinations)
          ? payload.destinations
          : [],
        startDate,
        endDate,
        baseCurrency: currencyColumn(payload.baseCurrency),
        totalBudgetMinor,
        notes: isTextOrNull(payload.notes) ? payload.notes : null,
        isArchived:
          typeof payload.isArchived === "boolean" ? payload.isArchived : false,
        version: change.version,
        deletedAt: null,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await delegate.update({
    where: { id: change.entityId },
    data: {
      ...(typeof payload.title === "string" ? { title: payload.title } : {}),
      ...(Array.isArray(payload.destinations)
        ? { destinations: payload.destinations }
        : {}),
      ...(payload.startDate !== undefined ? { startDate } : {}),
      ...(payload.endDate !== undefined ? { endDate } : {}),
      ...(typeof payload.baseCurrency === "string"
        ? { baseCurrency: currencyColumn(payload.baseCurrency) }
        : {}),
      ...(payload.totalBudgetMinor !== undefined ? { totalBudgetMinor } : {}),
      ...(payload.notes !== undefined
        ? { notes: isTextOrNull(payload.notes) ? payload.notes : null }
        : {}),
      ...(typeof payload.isArchived === "boolean"
        ? { isArchived: payload.isArchived }
        : {}),
      version: change.version,
      deletedAt: null,
    },
  });
}

/**
 * Whether this pusher may write an itinerary row that hangs off `trip`.
 *
 * `FinanceTripItinerary` has no owner column, so the parent trip is the only
 * thing in the schema that can answer whose item this is, and that rule is
 * unchanged by sharing: the grant is looked up **on the parent**, never on the
 * item. An item whose trip cannot be resolved is still refused for everybody —
 * an orphan has no parent to inherit authority from, which is the same
 * parent-derived invariant the Flutter client holds locally
 * (`finance_trip_repository.dart` refuses to create an item without its trip,
 * `sync_manager.dart` refuses to apply one) and the reason a grantee's cursor
 * is handed the trip row before its plan rows.
 *
 * Owner: always writable. Grantee: writable only on a live `EDITOR`/`ADMIN`
 * grant, so a `VIEWER` who pulls the plan cannot push a change to it — the
 * refusal is the silent log-and-drop this branch already made for a stranger,
 * not an exception, because the change belongs on the pusher's log either way
 * and nobody else reads that log.
 */
async function tripIsWritable(
  tx: ChangeProjectionClient,
  userId: string,
  tripId: string | undefined | null,
  trip: { ownerId: string },
): Promise<boolean> {
  if (trip.ownerId === userId) return true;
  if (typeof tripId !== "string" || !tripId) return false;
  return canEditFinanceTrip(tx, userId, tripId);
}

async function projectFinanceTripItineraryChange(
  tx: ChangeProjectionClient,
  userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const delegate = tx.financeTripItinerary;
  if (!delegate) return;

  const existing = await delegate.findUnique({
    where: { id: change.entityId },
    select: { tripId: true, deletedAt: true, version: true },
  });

  // `FinanceTripItinerary` has no owner column of its own — the parent trip is
  // the only thing that can answer whose item this is (`prisma/schema.prisma:1191-1209`),
  // the same way `finance_shared_expense` and `finance_settlement` reach their
  // owner through their parent in `assertSharedScope`. So the parent is loaded
  // and compared before any branch writes, the tombstone below included: a
  // delete is the easiest cross-user write to hide, because it asks for nothing
  // but the uuid it is about to blank out.
  //
  // A CREATE has no row to read, so the payload's own `tripId` is its only claim
  // about the parent; an UPDATE or DELETE trusts the table first, because
  // `payload.tripId` describes where the device thinks the item goes and the row
  // says where it actually is — and the row is the thing being written.
  const tripId = existing?.tripId ?? payload.tripId;
  const trip =
    typeof tripId === "string" && tripId
      ? await tx.financeTrip?.findUnique({
          where: { id: tripId },
          select: { ownerId: true },
        })
      : null;

  if (!trip || !(await tripIsWritable(tx, userId, tripId, trip))) {
    // A parent that is not in the table is not the caller's either, and a
    // tombstoned trip belonging to somebody else fails the same comparison —
    // `ownerId` is stamped from the pusher at CREATE and never rewritten, so
    // this one read answers both questions. The change still goes on the
    // caller's log, where it is harmless because nobody else reads that log;
    // what must not happen is the write to this row.
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_trip_itinerary ${change.entityId} pushed by ${userId}: ${
        trip
          ? `the trip ${tripId} belongs to ${trip.ownerId}`
          : `no trip it belongs to could be resolved (${tripId ?? "no tripId given"})`
      }.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
    // The stale-DELETE tie rule, as in the account branch above: the row's own
    // `version` is read here already, so a tombstone older than what the item
    // holds cannot roll it back.
    if (losesToWhatTheRowHolds(change, existing)) return;
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  const plannedCostMinor =
    payload.plannedCostMinor !== undefined && payload.plannedCostMinor !== null
      ? BigInt(Math.round(Number(payload.plannedCostMinor)))
      : null;
  const date = payload.date ? new Date(payload.date) : null;

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await delegate.create({
      data: {
        id: change.entityId,
        // The parent this change was authorized against, not the payload's
        // unverified claim about one.
        tripId,
        dayIndex: typeof payload.dayIndex === "number" ? payload.dayIndex : 1,
        date,
        title:
          typeof payload.title === "string" ? payload.title : "Itinerary item",
        plannedCostMinor,
        notes: isTextOrNull(payload.notes) ? payload.notes : null,
        sortOrder:
          typeof payload.sortOrder === "number" ? payload.sortOrder : 0,
        version: change.version,
        deletedAt: null,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  if (losesToWhatTheRowHolds(change, existing)) return;

  await delegate.update({
    where: { id: change.entityId },
    data: {
      ...(typeof payload.dayIndex === "number"
        ? { dayIndex: payload.dayIndex }
        : {}),
      ...(payload.date !== undefined ? { date } : {}),
      ...(typeof payload.title === "string" ? { title: payload.title } : {}),
      ...(payload.plannedCostMinor !== undefined ? { plannedCostMinor } : {}),
      ...(payload.notes !== undefined
        ? { notes: isTextOrNull(payload.notes) ? payload.notes : null }
        : {}),
      ...(typeof payload.sortOrder === "number"
        ? { sortOrder: payload.sortOrder }
        : {}),
      version: change.version,
      deletedAt: null,
    },
  });
}
