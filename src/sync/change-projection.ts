import {
  assertExpenseShares,
  validMembers,
} from "../finance/groups/group-validation";
import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import {
  ChangeOperation,
  EventStatus,
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
 * accepted changes only, and a change that projects onto nothing aborts the
 * push. That is deliberate: a mirror that silently fails is a row that quietly
 * lies, and the log is the one copy still telling the truth.
 *
 * `note`, `folder`, `task`, `event`, and `calendar` are projected: their payloads
 * are validated by `DOCUMENT_SHAPES` and mapped directly onto the Prisma entity
 * tables, ensuring REST endpoints and sync remain consistent.
 *
 * Three methods, which is the whole surface a projection is allowed. Naming
 * them rather than taking `Prisma.TransactionClient` keeps the pass-through
 * honest — a projection that could `deleteMany` is a projection that will, one
 * day, be given a reason to.
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
  financeSharedExpense?: Pick<
    Prisma.TransactionClient["financeSharedExpense"],
    "findUnique" | "create" | "update"
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
 * `assertPushableChanges` has already refused a batch that breaks these rules,
 * so every branch below is a value that cannot reach it — and it is still the
 * projection that would throw on it, taking the whole push with it. Narrowing
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
    select: { userId: true, deletedAt: true },
  });

  if (existing && existing.userId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_account ${change.entityId} pushed by ${userId}: the account belongs to ${existing.userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
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
        currency: payload.currency ?? "INR",
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

  await delegate.update({
    where: { id: change.entityId },
    data: {
      ...(typeof payload.name === "string" ? { name: payload.name } : {}),
      ...(typeof payload.type === "string"
        ? { type: payload.type as any }
        : {}),
      ...(typeof payload.currency === "string"
        ? { currency: payload.currency }
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
    select: { userId: true, deletedAt: true },
  });

  if (existing && existing.userId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_category ${change.entityId} pushed by ${userId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
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

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await delegate.create({
      data: {
        id: change.entityId,
        userId,
        accountId: payload.accountId,
        toAccountId: isTextOrNull(payload.toAccountId)
          ? payload.toAccountId
          : null,
        categoryId: isTextOrNull(payload.categoryId)
          ? payload.categoryId
          : null,
        type: payload.type ?? "EXPENSE",
        amountMinor,
        currency: payload.currency ?? "INR",
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
        version: change.version,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return;
  }

  await delegate.update({
    where: { id: change.entityId },
    data: {
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
            categoryId: isTextOrNull(payload.categoryId)
              ? payload.categoryId
              : null,
          }
        : {}),
      ...(typeof payload.type === "string"
        ? { type: payload.type as any }
        : {}),
      ...(payload.amountMinor !== undefined ? { amountMinor } : {}),
      ...(typeof payload.currency === "string"
        ? { currency: payload.currency }
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
      version: change.version,
      deletedAt: null,
    },
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

  if (!existing) {
    const createdAt = parsedCreatedAt(payload);
    await delegate.create({
      data: {
        id: change.entityId,
        userId,
        accountId: payload.accountId,
        categoryId: isTextOrNull(payload.categoryId)
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
            categoryId: isTextOrNull(payload.categoryId)
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

  if (existing && existing.ownerId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_group ${change.entityId} pushed by ${userId}: the group belongs to ${existing.ownerId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  if (payload.members !== undefined && !validMembers(payload.members))
    throw new BadRequestException("Invalid group friends.");

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
        currency: payload.currency ?? "INR",
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
        ? { currency: payload.currency }
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
    const parent = await tx.financeGroup?.findUnique({
      where: { id: refs.groupId },
    });
    if (!parent || parent.ownerId !== userId || parent.deletedAt) {
      throw new ForbiddenException("This group is not available to you.");
    }
    if (currency && parent.currency !== currency) {
      throw new BadRequestException("Use the group currency.");
    }
  }
  if (refs.tripId) {
    const parent = await tx.financeTrip?.findUnique({
      where: { id: refs.tripId },
    });
    if (!parent || parent.ownerId !== userId || parent.deletedAt) {
      throw new ForbiddenException("This trip is not available to you.");
    }
    if (currency && parent.baseCurrency !== currency) {
      throw new BadRequestException("Use the trip currency.");
    }
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
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  if (payload.shares !== undefined || !existing)
    assertExpenseShares(
      Number(payload.totalAmountMinor ?? existing?.totalAmountMinor),
      payload.shares,
    );
  const shareData = Array.isArray(payload.shares)
    ? payload.shares.map((share: any) => ({
        userId: share.userId,
        owedAmountMinor: BigInt(share.owedAmountMinor),
        shareUnits: share.shareUnits ?? null,
      }))
    : undefined;

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
        paidByUserId: payload.paidByUserId ?? userId,
        payerAccountId: isTextOrNull(payload.payerAccountId)
          ? payload.payerAccountId
          : null,
        title:
          typeof payload.title === "string" ? payload.title : "Shared Expense",
        totalAmountMinor,
        ...(shareData ? { shares: { create: shareData } } : {}),
        currency: payload.currency ?? "INR",
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
      ...(typeof payload.paidByUserId === "string"
        ? { paidByUserId: payload.paidByUserId }
        : {}),
      ...(payload.payerAccountId !== undefined
        ? {
            payerAccountId: isTextOrNull(payload.payerAccountId)
              ? payload.payerAccountId
              : null,
          }
        : {}),
      ...(typeof payload.title === "string" ? { title: payload.title } : {}),
      ...(payload.totalAmountMinor !== undefined ? { totalAmountMinor } : {}),
      ...(shareData ? { shares: { deleteMany: {}, create: shareData } } : {}),
      ...(typeof payload.currency === "string"
        ? { currency: payload.currency }
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
    await delegate.update({
      where: { id: change.entityId },
      data: { deletedAt: new Date(), version: change.version },
    });
    return;
  }

  const from = payload.fromUserId ?? existing?.fromUserId;
  const to = payload.toUserId ?? existing?.toUserId;
  if (
    !from ||
    !to ||
    from === to ||
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
        fromUserId: payload.fromUserId ?? userId,
        toUserId: payload.toUserId ?? "",
        amountMinor,
        currency: payload.currency ?? "INR",
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
        ? { fromUserId: payload.fromUserId }
        : {}),
      ...(typeof payload.toUserId === "string"
        ? { toUserId: payload.toUserId }
        : {}),
      ...(payload.amountMinor !== undefined ? { amountMinor } : {}),
      ...(typeof payload.currency === "string"
        ? { currency: payload.currency }
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

  if (existing && existing.ownerId !== userId) {
    logger.warn(
      `Ignored a ${String(change.operation)} change for finance_trip ${change.entityId} pushed by ${userId}: the trip belongs to ${existing.ownerId}.`,
    );
    return;
  }

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
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
        baseCurrency: payload.baseCurrency ?? "INR",
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
        ? { baseCurrency: payload.baseCurrency }
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

async function projectFinanceTripItineraryChange(
  tx: ChangeProjectionClient,
  _userId: string,
  change: ProjectableChange,
  payload: Record<string, any>,
): Promise<void> {
  const delegate = tx.financeTripItinerary;
  if (!delegate) return;

  const existing = await delegate.findUnique({
    where: { id: change.entityId },
    select: { tripId: true, deletedAt: true, version: true },
  });

  if (change.operation === ChangeOperation.DELETE) {
    if (!existing) return;
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
        tripId: payload.tripId,
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
