import { Injectable, Logger, Optional, HttpException } from "@nestjs/common";
import { ChangeOperation, Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { PushSyncDto } from "./dto/push-sync.dto";
import { PullSyncDto } from "./dto/pull-sync.dto";
import { SyncNotificationService } from "./sync-notification.service";
import { MetricsService } from "@/common/metrics/metrics.service";
import { ErrorCode } from "@/common/errors/error-code";
import { badRequest, forbidden, notFound } from "@/common/errors/http-errors";
import { appendChange, getHighestChangeCursor } from "./change-cursor";
import {
  changePayloadRejection,
  type ChangeRejection,
} from "./change-payload.validator";
import {
  projectAcceptedChange,
  SYNC_PUSH_UNAUTHORIZED,
  type ProjectableChange,
} from "./change-projection";

export interface SyncConflictEntry {
  entityId: string;
  entityType: string;
  reason: string;
  clientVersion: number;
  serverVersion: number;
  serverPayload?: any;
}

/**
 * One change this server did not store, keyed by the id the pushing device
 * recognises.
 *
 * `id` is the change's `entityId`, not a `Change` row id: the row was never
 * written, so a server-side id would name something that does not exist, and the
 * device can only settle a queue entry it can find. `conflicts` already
 * identifies a refused change by `entityType`/`entityId` for the same reason.
 *
 * Cross-repo invariant: `id` is the change's `entityId` as pushed by the client.
 * This matches the device's queue entries unambiguously because clients coalesce
 * their queue by `entityType:entityId` before batching, guaranteeing that one
 * entity appears at most once per push batch. A client that queued multiple
 * changes for one entity in a single batch without coalescing would find
 * matching by `id` ambiguous.
 */
export interface SyncRejectionEntry {
  id: string;
  entityType?: string;
  errorCode: string;
  message: string;
}

/**
 * What one `/sync/push` did with the batch it was handed.
 *
 * Every key this endpoint returned before is still returned, with the same names
 * and the same meaning. `rejected` and `truncated` are the only additions and both
 * are optional on the wire: they appear only when a change was refused, so a batch
 * that landed whole answers exactly as it always did.
 */
export interface SyncPushResult {
  success: boolean;
  accepted: string[];
  conflicts: SyncConflictEntry[];
  rejected?: SyncRejectionEntry[];
  /**
   * Whether `rejected` is the whole story.
   *
   * A push may carry `MAX_CHANGES_PER_PUSH` changes and one response names at most
   * `MAX_REJECTED_ENTRIES` of them, so the array is a bounded report and not a
   * receipt. Without this flag a client cannot tell "these are the broken rows"
   * from "these are the first broken rows", and the second reading is the one that
   * silently drops healthy work: a device that cleared its queue by id would delete
   * the unnamed rows it was never told about. Absent means every rejection is
   * listed.
   */
  truncated?: boolean;
  newCursor: string;
  processedCount: number;
  conflictsResolved: number;
  highestCursor: string;
  lastPushedSequence: number;
}

/**
 * The largest page one pull may hand back. A change row is unbounded up to the
 * 64 KiB payload ceiling (`change-payload.validator.ts`), so 500 rows is already
 * a ~32 MB response; anything larger is a client bug or a denial-of-service
 * attempt, and it is answered with a shorter page instead of an error.
 */
const MAX_PULL_PAGE_SIZE = 500;

/**
 * The most rejections one response names.
 *
 * A push may carry up to `MAX_CHANGES_PER_PUSH` changes (500), so an all-invalid
 * batch could otherwise answer with hundreds of prose entries. Responses exceeding
 * this bound drop subsequent rejections from the response body and set `truncated: true`.
 * Note: clients whose batch sizes are smaller than or equal to this cap (such as
 * the Flutter client whose push batch size is 50) will never hit truncation.
 */
const MAX_REJECTED_ENTRIES = 100;

/**
 * How long one rejection's `message` runs.
 *
 * The prose is for a developer reading a log line, and a payload violation can
 * stack a sentence per field onto every change in a batch. The `errorCode` is the
 * part a client branches on, and that is fixed-width.
 */
const MAX_REJECTED_MESSAGE_CHARS = 240;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private prisma: PrismaService,
    // The same wake-up the REST write paths now send, through the same choke
    // point: a push that broadcast straight at `SyncGateway` while a REST edit
    // broadcast at nothing is how one half of the sync traffic looked live and
    // the other half did not.
    @Optional() private syncNotifications?: SyncNotificationService,
    @Optional() private metricsService?: MetricsService,
  ) {}

  /**
   * Push changes from a device to the server database.
   * Filters on `where: { userId }` server-side unconditionally.
   *
   * Each change is decided on its own. It used to be the batch that was judged:
   * one row no device could replay threw before any write, and the client's
   * answer to a refused batch is to keep the whole queue — so the poisoned row
   * retried forever and every healthy change queued behind it retried with it. A
   * failure now costs the one change that caused it: it is named in `rejected`,
   * its `Change` row is not written, and the rest of the request is applied and
   * committed as normal.
   *
   * Isolation is per change and not finer. The log append, the domain projection
   * and the cursor allocation for one change stay inside one `$transaction`, so a
   * change is never half-applied; the cost is that a large batch is now several
   * round trips instead of one, which is the trade the wedge makes worth paying.
   */
  async pushChanges(userId: string, dto: PushSyncDto): Promise<SyncPushResult> {
    await assertSyncDevice(this.prisma, userId, dto.deviceId);

    const replicaRecipients = new Set<string>();
    const timeoutMs = Number(process.env.SYNC_TRANSACTION_TIMEOUT_MS) || 30000;
    const maxWaitMs = Number(process.env.SYNC_TRANSACTION_MAX_WAIT_MS) || 10000;

    const conflictsResolved = 0;
    const accepted: string[] = [];
    const conflicts: SyncConflictEntry[] = [];
    const rejected: SyncRejectionEntry[] = [];
    let droppedRejections = 0;
    let lastAssignedCursor: bigint | undefined;
    const latestInBatch = new Map<string, { version: number; payload?: any }>();

    const reject = (entry: SyncRejectionEntry) => {
      if (rejected.length < MAX_REJECTED_ENTRIES) {
        rejected.push(entry);
        return;
      }
      droppedRejections += 1;
    };

    for (const [index, change] of dto.changes.entries()) {
      // Payload shape first, and without touching the database: a change no
      // device could ever replay costs this request one write and nothing else.
      const refusal = changePayloadRejection(change, index);
      if (refusal) {
        reject(rejectionEntry(change, refusal));
        continue;
      }

      const entityKey = `${change.entityType}:${change.entityId}`;
      const finalPayload = change.payload;

      let outcome:
        | { kind: "conflict"; conflict: SyncConflictEntry }
        | {
            kind: "accepted";
            id: string;
            cursor: bigint;
            recipients: string[];
          };

      try {
        outcome = await this.prisma.$transaction(
          async (tx) => {
            let existingChange = latestInBatch.get(entityKey);
            if (!existingChange) {
              const storedChange = await readStoredChange(tx, userId, change);
              if (storedChange) {
                existingChange = storedChange;
                latestInBatch.set(entityKey, storedChange);
              }
            }

            // A stale write is refused whole, never merged into what is already
            // there. Merging would put a payload on the log that no device ever
            // authored or signed — for a `vault_item` that is impossible anyway
            // (the blob is opaque ciphertext), and for notes, tasks and events the
            // client is the thing that knows what the user meant. This is the only
            // conflict rule; the field-merge `ConflictResolverService` that used to
            // sit beside it was deleted rather than wired in, for that reason.
            //
            // `<` and not `<=`, which makes an equal version a decision rather than
            // an oversight. Two things arrive here at the version already stored:
            // a retry — a push whose response was lost re-sends the same change at
            // the same number, and refusing it would report a conflict over work the
            // log already holds and drop the client's queue entry for it — and two
            // devices that edited from the same version, which is a genuine
            // concurrent write. Nothing here can tell the two apart: both
            // are the same entity at the same version, and `deviceId` is not a tie
            // break because a retry comes from the same device that made the edit.
            // So both are accepted, and the concurrent pair resolves to whichever
            // row the log reached last, in cursor order — every device converges on
            // it, because they all replay the same log.
            // The author whose version is overwritten does find out one layer up: the
            // winner reaches their next pull, rewrites the note under them, and the
            // client reloads the open editor rather than leaving the discarded text
            // on screen to be typed over and re-pushed at a higher version
            // (`SyncManager.rewrittenNotes` in the Flutter client). That makes the
            // loss visible where the user is looking; recovering the discarded
            // version is a product decision the log does not pretend to have made.
            //
            // The comparison is with the newest stored *version*, which the row
            // carries whether or not it carries a payload: a DELETE is legitimately
            // logged with `payload: null` (see `CONTENT_CARRYING_OPERATIONS`), and
            // gating on the payload shape used to disarm the whole rule for that
            // entity — once a delete tail sat there, a stale UPDATE at version 3
            // against stored version 9 was accepted and resurrected the row on every
            // device. `serverPayload` is still only echoed when it is an object.
            if (existingChange && change.version < existingChange.version) {
              return {
                kind: "conflict" as const,
                conflict: {
                  entityId: change.entityId,
                  entityType: change.entityType,
                  reason: "VERSION_MISMATCH",
                  clientVersion: change.version,
                  serverVersion: existingChange.version,
                  serverPayload:
                    existingChange.payload &&
                    typeof existingChange.payload === "object"
                      ? existingChange.payload
                      : undefined,
                },
              };
            }

            const createdChange = await appendChange(tx, {
              userId,
              deviceId: dto.deviceId,
              entityType: change.entityType,
              entityId: change.entityId,
              operation: change.operation as any,
              version: change.version,
              payload: finalPayload,
              // The device's own stamp for when the edit happened, kept separate
              // from `createdAt` so a pull can hand back the edit time rather than
              // this server's receive time. Nothing here decides conflicts with it.
              clientTimestamp: change.clientTimestamp ?? null,
            });

            // The row behind the log entry. Only a change that got this far is
            // projected — a refused one is a write the log never accepted, and the
            // mirror has to agree with the log rather than with whatever a device
            // happened to try. Inside this transaction on purpose: a change that
            // rolled back would otherwise leave a domain row edited by a change no
            // device will ever be handed.
            await projectAcceptedChange(tx, userId, change);
            const recipients = await this.replicateGroupChange(
              tx,
              userId,
              {
                entityType: change.entityType,
                entityId: change.entityId,
                operation: change.operation as ChangeOperation,
                version: change.version,
              },
              finalPayload as Prisma.InputJsonValue,
              dto.deviceId,
            );

            return {
              kind: "accepted" as const,
              id: createdChange.id,
              cursor: createdChange.cursor,
              recipients,
            };
          },
          {
            maxWait: maxWaitMs,
            timeout: timeoutMs,
          },
        );
      } catch (error) {
        const projectionRefusal = rejectionFromProjection(error);
        if (!projectionRefusal) {
          // Not a decision about this change: the database, the transaction or a
          // bug. Those stay fatal, because a client that dropped its queue over an
          // outage would lose edits the server never refused.
          throw error;
        }
        // This change's own transaction rolled back, so its log row, its domain
        // row and its cursor are all unsent; the changes already committed in this
        // request stay committed.
        reject(rejectionEntry(change, projectionRefusal));
        continue;
      }

      if (outcome.kind === "conflict") {
        conflicts.push(outcome.conflict);
        continue;
      }

      lastAssignedCursor = outcome.cursor;
      for (const recipient of outcome.recipients) {
        replicaRecipients.add(recipient);
      }
      latestInBatch.set(entityKey, {
        version: change.version,
        payload: finalPayload,
      });
      accepted.push(outcome.id);
    }

    if (droppedRejections > 0) {
      this.logger.warn(
        `Push from device ${dto.deviceId} carried ${droppedRejections} rejected change(s) beyond the ${MAX_REJECTED_ENTRIES} this response names. Truncated flag set in response.`,
      );
    }

    const updatedSyncState = await this.prisma.deviceSyncState.upsert({
      where: { deviceId: dto.deviceId },
      create: {
        deviceId: dto.deviceId,
        lastPushedSequence: dto.changes.length,
        lastSuccessfulSyncAt: new Date(),
      },
      update: {
        lastPushedSequence: { increment: dto.changes.length },
        lastSuccessfulSyncAt: new Date(),
      },
    });

    const highestCursor = (
      lastAssignedCursor ?? (await getHighestChangeCursor(this.prisma, userId))
    ).toString();

    const result: SyncPushResult = {
      success: true,
      accepted,
      conflicts,
      // Absent rather than an empty array for a batch that landed whole, so this
      // response is exactly the one this endpoint has always answered with.
      ...(rejected.length > 0 ? { rejected } : {}),
      // Only when the list above is a prefix of the truth, for the same reason:
      // a client that has never heard of either key reads the same body it read
      // before.
      ...(droppedRejections > 0 ? { truncated: true } : {}),
      newCursor: highestCursor,
      processedCount: dto.changes.length,
      conflictsResolved,
      highestCursor,
      lastPushedSequence: updatedSyncState.lastPushedSequence,
    };

    if (this.syncNotifications) {
      this.syncNotifications.notifyMutation({
        userId,
        originDeviceId: dto.deviceId,
        highestCursor: result.highestCursor,
      });
      for (const recipientId of replicaRecipients) {
        this.syncNotifications.notifyMutation({ userId: recipientId });
      }
    }

    this.metricsService?.incrementSyncPush(dto.changes.length);

    return result;
  }

  /**
   * Sync cursors belong to one account. A group edit is copied to every
   * collaborator's own log, so each participant can pull it with their cursor.
   */
  private async replicateGroupChange(
    tx: Prisma.TransactionClient,
    authorId: string,
    change: {
      entityType: string;
      entityId: string;
      operation: ChangeOperation;
      version: number;
    },
    payload: Prisma.InputJsonValue,
    deviceId: string,
  ): Promise<string[]> {
    let groupId: string | null = null;
    if (change.entityType === "finance_group") groupId = change.entityId;
    if (change.entityType === "finance_shared_expense") {
      groupId =
        (
          await tx.financeSharedExpense.findUnique({
            where: { id: change.entityId },
            select: { groupId: true },
          })
        )?.groupId ?? null;
    }
    if (change.entityType === "finance_settlement") {
      groupId =
        (
          await tx.financeSettlement.findUnique({
            where: { id: change.entityId },
            select: { groupId: true },
          })
        )?.groupId ?? null;
    }
    if (!groupId) return [];

    const group = await tx.financeGroup.findUnique({
      where: { id: groupId },
      select: { ownerId: true },
    });
    if (!group) return [];
    const shares = await tx.resourceShare.findMany({
      where: {
        resourceType: "EXPENSE_GROUP",
        resourceId: groupId,
        deletedAt: null,
      },
      select: { sharedWithUserId: true },
    });
    const recipients = new Set<string>([
      group.ownerId,
      ...shares.map(
        (share: { sharedWithUserId: string }) => share.sharedWithUserId,
      ),
    ]);
    recipients.delete(authorId);
    for (const recipientId of recipients) {
      await appendChange(tx, {
        userId: recipientId,
        deviceId,
        entityType: change.entityType,
        entityId: change.entityId,
        operation: change.operation,
        version: change.version,
        payload,
      });
    }
    return [...recipients];
  }

  /**
   * Pull changes from the server for a device starting after the specified cursor position.
   * Filters on `where: { userId }` server-side unconditionally.
   */
  async pullChanges(userId: string, dto: PullSyncDto) {
    await assertSyncDevice(this.prisma, userId, dto.deviceId);

    const cursorBigInt = parsePullCursor(dto.cursor);
    // Clamped, not just validated: `PullSyncDto` now bounds `limit` at
    // MAX_PULL_PAGE_SIZE, but a client that predates that bound would otherwise
    // get a 400 for a call that used to work. Degrading to the ceiling keeps it
    // paging, and keeps `take: limit + 1` from asking for the whole log.
    const limit = Math.min(dto.limit || 100, MAX_PULL_PAGE_SIZE);

    const serverHighestCursor = await getHighestChangeCursor(
      this.prisma,
      userId,
    );

    // If a client's requested cursor is strictly ahead of the highest cursor recorded
    // on the server (e.g., following a disaster recovery restore from backup),
    // continuing to filter with `cursor > cursorBigInt` would cause silent sync loss:
    // the client would permanently miss changes between the restored cursor and its stranded cursor.
    // In this case, we reset the query to pull from 0 and advance the client to the server's truth.
    const isAheadOfServer =
      cursorBigInt !== undefined && cursorBigInt > serverHighestCursor;

    if (isAheadOfServer) {
      this.logger.warn(
        `Device ${dto.deviceId} requested cursor ${cursorBigInt.toString()} which exceeds server highest cursor ${serverHighestCursor.toString()} (server restored or cursor drift). Resetting pull to 0 to prevent silent sync loss.`,
      );
    }

    const effectiveCursor = isAheadOfServer ? undefined : cursorBigInt;

    const rows = await this.prisma.change.findMany({
      where: {
        userId,
        ...(effectiveCursor !== undefined
          ? { cursor: { gt: effectiveCursor } }
          : {}),
      },
      // createdAt only breaks ties while legacy rows still share cursor 0, i.e.
      // until scripts/backfill-change-cursor.ts has run.
      orderBy: [{ cursor: "asc" }, { createdAt: "asc" }],
      // One row past the page so `hasMore` reports whether the log really
      // continues instead of inferring it from a page that happens to be full.
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const changes = hasMore ? rows.slice(0, limit) : rows;

    const formattedChanges = changes.map((c) => ({
      id: c.id,
      userId: c.userId,
      deviceId: c.deviceId,
      entityType: c.entityType,
      entityId: c.entityId,
      operation: c.operation,
      version: c.version,
      payload: c.payload,
      cursor: c.cursor.toString(),
      createdAt: c.createdAt,
      // Null for a change this server authored (a REST write has no device clock
      // to borrow). Clients fall back to `createdAt` when it is absent.
      clientTimestamp: c.clientTimestamp ?? null,
    }));

    // An empty page echoes the caller's checkpoint only when valid; when the caller was
    // ahead of the server, fall back to serverHighestCursor so the device's checkpoint
    // is aligned with the restored server.
    const nextCursor =
      formattedChanges.length > 0
        ? formattedChanges[formattedChanges.length - 1].cursor
        : isAheadOfServer
          ? serverHighestCursor.toString()
          : dto.cursor || "0";

    await this.prisma.deviceSyncState.upsert({
      where: { deviceId: dto.deviceId },
      create: {
        deviceId: dto.deviceId,
        lastPulledCursor: nextCursor,
        lastSuccessfulSyncAt: new Date(),
      },
      update: {
        lastPulledCursor: nextCursor,
        lastSuccessfulSyncAt: new Date(),
      },
    });

    this.metricsService?.incrementSyncPull();

    return {
      changes: formattedChanges,
      nextCursor,
      hasMore,
    };
  }

  /**
   * Query synchronization status metadata for a specified device.
   */
  async getSyncStatus(userId: string, deviceId: string) {
    await assertSyncDevice(this.prisma, userId, deviceId);

    const syncState = await this.prisma.deviceSyncState.findUnique({
      where: { deviceId },
    });

    const serverHighestCursor = await getHighestChangeCursor(
      this.prisma,
      userId,
    );

    return {
      deviceId,
      lastPulledCursor: syncState?.lastPulledCursor || "0",
      lastPushedSequence: syncState?.lastPushedSequence || 0,
      lastSuccessfulSyncAt: syncState?.lastSuccessfulSyncAt || null,
      serverHighestCursor: serverHighestCursor.toString(),
    };
  }
}

/**
 * The newest row this account's log holds for one entity, which is the version a
 * push is compared against. Read inside the same transaction that writes the next
 * row, so two pushes racing for one entity cannot both see the older version and
 * both be told they won.
 */
async function readStoredChange(
  tx: Prisma.TransactionClient,
  userId: string,
  change: ProjectableChange,
): Promise<{ version: number; payload?: any } | null> {
  const stored = await tx.change.findFirst({
    where: {
      userId,
      entityType: change.entityType,
      entityId: change.entityId,
    },
    orderBy: { cursor: "desc" },
  });

  return stored ? { version: stored.version, payload: stored.payload } : null;
}

/**
 * The `rejected` entry for one change, with its message trimmed to the bound.
 *
 * The prose comes from two very different places — a field-path list from the
 * payload validator, or whatever a domain guard said — and both are allowed to be
 * long. The id and the code are the parts a client acts on.
 */
function rejectionEntry(
  change: { entityId: string },
  rejection: ChangeRejection,
): SyncRejectionEntry {
  const { message } = rejection;
  return {
    id: change.entityId,
    errorCode: rejection.errorCode,
    message:
      message.length <= MAX_REJECTED_MESSAGE_CHARS
        ? message
        : `${message.slice(0, MAX_REJECTED_MESSAGE_CHARS - 1)}…`,
  };
}

/**
 * Whether a projection's throw is a decision about this change or an outage.
 *
 * A domain guard in `change-projection.ts` answers with a 4xx — the same
 * `BadRequestException`/`ForbiddenException` the equivalent REST write raises for
 * the same row — and per-change rejection means that answer now travels inside a
 * 200 body instead of unwinding the request. Anything else (a Prisma error, a
 * transaction timeout, a 5xx) stays fatal: a device that dropped its queue over
 * an outage would lose edits the server never actually refused.
 *
 * The code is the guard's own when it carried one, and otherwise derived from the
 * status exactly the way the exception filter derives it for a 4xx that reaches
 * the wire: 403 is an authority answer about a row the pusher may not write,
 * which is `SYNC_PUSH_UNAUTHORIZED`; a 400 is the payload's shape or its
 * arithmetic, which is the key a declined change has always carried. Keeping the
 * two apart is what lets a client tell "my builder is broken" from "I am no
 * longer in this group", because only one of those is worth retrying.
 */
function rejectionFromProjection(error: unknown): ChangeRejection | null {
  if (!(error instanceof HttpException)) return null;

  const status = error.getStatus();
  if (status >= 500) return null;

  const body = error.getResponse() as any;
  const code =
    typeof body?.code === "string"
      ? body.code
      : status === 403
        ? SYNC_PUSH_UNAUTHORIZED
        : ErrorCode.SYNC_PUSH_REJECTED;

  const raw = body?.message ?? error.message;
  const message = Array.isArray(raw) ? raw.join(" ") : String(raw);

  return { errorCode: code, message };
}

/**
 * The device check every `/sync/*` entry point opens with, and the only place
 * that decides *why* a device cannot sync.
 *
 * The lookup stays filtered by the authenticated user rather than reading the row
 * and comparing afterwards, because that filter is the authorization. Only on the
 * failure path does it ask a second question — was the row missing, revoked, or
 * somebody else's — because those three want three different things from the
 * client, and until now they shared one 404. A client that had never heard of its
 * own device can fix that by registering; a client whose device was revoked
 * cannot, and must not try, because minting a fresh row would undo the decision
 * in silence.
 *
 * The second read asks the same scoped question without `revokedAt`, so the only
 * thing it can learn is that this account's own row is not usable. Comparing the
 * owner afterwards would have put a row belonging to another account in the
 * process's memory on a path whose whole job is deciding what to tell the caller
 * about it; scoping the query is what keeps "not yours" indistinguishable from
 * "not there" by construction rather than by the discipline of the code below it.
 */
async function assertSyncDevice(
  prisma: Pick<PrismaService, "device">,
  userId: string,
  deviceId: string,
) {
  const device = await prisma.device.findFirst({
    where: { id: deviceId, userId, revokedAt: null },
  });
  if (device) return device;

  const own = await prisma.device.findFirst({
    where: { id: deviceId, userId },
  });
  if (own) {
    throw forbidden(
      ErrorCode.DEVICE_REVOKED,
      `Device '${deviceId}' was revoked for this account. Syncing stops until it is registered again.`,
      { deviceId },
    );
  }

  // No such row, or one belonging to someone else: deliberately the same answer.
  // Distinguishing them would let a caller probe which device UUIDs exist by
  // trying to sync as them.
  throw notFound(
    ErrorCode.DEVICE_NOT_REGISTERED,
    `Active device with ID '${deviceId}' not found.`,
    { deviceId },
  );
}

function parsePullCursor(cursor?: string): bigint | undefined {
  if (cursor === undefined || cursor === "") return undefined;

  if (!/^\d+$/.test(cursor)) {
    throw badRequest(
      ErrorCode.VALIDATION_ERROR,
      "cursor: must be the numeric sync cursor returned by a previous pull.",
      { field: "cursor", value: cursor },
    );
  }

  return BigInt(cursor);
}
