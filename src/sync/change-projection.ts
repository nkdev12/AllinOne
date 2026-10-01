import { Logger } from "@nestjs/common";
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
  if (isTextOrNull(payload.description)) columns.description = payload.description;
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
  if (isTextOrNull(payload.recurrenceRule)) columns.recurrenceRule = payload.recurrenceRule;
  if (typeof payload.completedAt === "string") {
    const d = new Date(payload.completedAt);
    if (!Number.isNaN(d.getTime())) columns.completedAt = d;
  } else if (payload.completedAt === null) {
    columns.completedAt = null;
  }
  if (typeof payload.sortOrder === "number") columns.sortOrder = payload.sortOrder;

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
  if (isTextOrNull(payload.description)) columns.description = payload.description;
  if (isTextOrNull(payload.location)) columns.location = payload.location;
  if (typeof payload.calendarId === "string") columns.calendarId = payload.calendarId;
  if (typeof payload.startAt === "string") {
    const d = new Date(payload.startAt);
    if (!Number.isNaN(d.getTime())) columns.startAt = d;
  }
  if (typeof payload.endAt === "string") {
    const d = new Date(payload.endAt);
    if (!Number.isNaN(d.getTime())) columns.endAt = d;
  }
  if (typeof payload.isAllDay === "boolean") columns.isAllDay = payload.isAllDay;
  if (isTextOrNull(payload.recurrenceRule)) columns.recurrenceRule = payload.recurrenceRule;
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
  if (typeof payload.isPrimary === "boolean") columns.isPrimary = payload.isPrimary;

  return columns;
}

