import { Injectable, Logger, Optional } from "@nestjs/common";
import { ChangeOperation, Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { PushSyncDto } from "./dto/push-sync.dto";
import { PullSyncDto } from "./dto/pull-sync.dto";
import { SyncNotificationService } from "./sync-notification.service";
import { MetricsService } from "@/common/metrics/metrics.service";
import { ErrorCode } from "@/common/errors/error-code";
import { badRequest, forbidden, notFound } from "@/common/errors/http-errors";
import { appendChange, getHighestChangeCursor } from "./change-cursor";
import { assertPushableChanges } from "./change-payload.validator";
import { projectAcceptedChange } from "./change-projection";

export interface SyncConflictEntry {
  entityId: string;
  entityType: string;
  reason: string;
  clientVersion: number;
  serverVersion: number;
  serverPayload?: any;
}

/**
 * The largest page one pull may hand back. A change row is unbounded up to the
 * 64 KiB payload ceiling (`change-payload.validator.ts`), so 500 rows is already
 * a ~32 MB response; anything larger is a client bug or a denial-of-service
 * attempt, and it is answered with a shorter page instead of an error.
 */
const MAX_PULL_PAGE_SIZE = 500;

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
   * A batch holding a change no device could replay is refused whole, before any
   * write, so the log never carries a row that every device then copies.
   */
  async pushChanges(userId: string, dto: PushSyncDto) {
    await assertSyncDevice(this.prisma, userId, dto.deviceId);

    assertPushableChanges(dto.changes);

    const replicaRecipients = new Set<string>();
    const timeoutMs = Number(process.env.SYNC_TRANSACTION_TIMEOUT_MS) || 30000;
    const maxWaitMs = Number(process.env.SYNC_TRANSACTION_MAX_WAIT_MS) || 10000;

    const result = await this.prisma.$transaction(
      async (tx) => {
        const conflictsResolved = 0;
        const accepted: string[] = [];
        const conflicts: SyncConflictEntry[] = [];
        let lastAssignedCursor: bigint | undefined;
        const latestInBatch = new Map<
          string,
          { version: number; payload?: any }
        >();

        for (const change of dto.changes) {
          const entityKey = `${change.entityType}:${change.entityId}`;
          let existingChange = latestInBatch.get(entityKey);
          if (!existingChange) {
            const storedChange = await tx.change.findFirst({
              where: {
                userId,
                entityType: change.entityType,
                entityId: change.entityId,
              },
              orderBy: { cursor: "desc" },
            });
            if (storedChange) {
              existingChange = {
                version: storedChange.version,
                payload: storedChange.payload,
              };
              latestInBatch.set(entityKey, existingChange);
            }
          }

          const finalPayload = change.payload;

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
          if (existingChange) {
            if (change.version < existingChange.version) {
              conflicts.push({
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
              });
              continue;
            }
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
          lastAssignedCursor = createdChange.cursor;

          // The row behind the log entry. Only a change that got this far is
          // projected — a refused one is a write the log never accepted, and the
          // mirror has to agree with the log rather than with whatever a device
          // happened to try. Inside this transaction on purpose: a push that
          // rolled back would otherwise leave a domain row edited by changes no
          // device will ever be handed.
          await projectAcceptedChange(tx, userId, change);
          for (const recipient of await this.replicateGroupChange(
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
          )) {
            replicaRecipients.add(recipient);
          }

          latestInBatch.set(entityKey, {
            version: change.version,
            payload: finalPayload,
          });

          accepted.push(createdChange.id);
        }

        const updatedSyncState = await tx.deviceSyncState.upsert({
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
          lastAssignedCursor ?? (await getHighestChangeCursor(tx, userId))
        ).toString();

        return {
          success: true,
          accepted,
          conflicts,
          newCursor: highestCursor,
          processedCount: dto.changes.length,
          conflictsResolved,
          highestCursor,
          lastPushedSequence: updatedSyncState.lastPushedSequence,
        };
      },
      {
        maxWait: maxWaitMs,
        timeout: timeoutMs,
      },
    );

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

  const named = await prisma.device.findFirst({ where: { id: deviceId } });
  if (named?.userId === userId) {
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
