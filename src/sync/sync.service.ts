import { Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { PushSyncDto } from "./dto/push-sync.dto";
import { PullSyncDto } from "./dto/pull-sync.dto";
import { SyncGateway } from "./sync.gateway";
import { MetricsService } from "@/common/metrics/metrics.service";
import { ErrorCode } from "@/common/errors/error-code";
import { badRequest, forbidden, notFound } from "@/common/errors/http-errors";
import { appendChange, getHighestChangeCursor } from "./change-cursor";
import { assertPushableChanges } from "./change-payload.validator";

export interface SyncConflictEntry {
  entityId: string;
  entityType: string;
  reason: string;
  clientVersion: number;
  serverVersion: number;
  serverPayload?: any;
}

@Injectable()
export class SyncService {
  constructor(
    private prisma: PrismaService,
    @Optional() private syncGateway?: SyncGateway,
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

    const result = await this.prisma.$transaction(async (tx) => {
      const conflictsResolved = 0;
      const accepted: string[] = [];
      const conflicts: SyncConflictEntry[] = [];
      let lastAssignedCursor: bigint | undefined;

      for (const change of dto.changes) {
        const existingChange = await tx.change.findFirst({
          where: {
            userId,
            entityType: change.entityType,
            entityId: change.entityId,
          },
          orderBy: { cursor: "desc" },
        });

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
        // concurrent write. Nothing on this request can tell the two apart: both
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
        if (
          existingChange &&
          existingChange.payload &&
          typeof existingChange.payload === "object"
        ) {
          if (change.version < existingChange.version) {
            conflicts.push({
              entityId: change.entityId,
              entityType: change.entityType,
              reason: "VERSION_MISMATCH",
              clientVersion: change.version,
              serverVersion: existingChange.version,
              serverPayload: existingChange.payload,
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
    });

    if (this.syncGateway) {
      this.syncGateway.notifySyncInvalidation(
        userId,
        dto.deviceId,
        result.highestCursor,
      );
    }

    this.metricsService?.incrementSyncPush(dto.changes.length);

    return result;
  }

  /**
   * Pull changes from the server for a device starting after the specified cursor position.
   * Filters on `where: { userId }` server-side unconditionally.
   */
  async pullChanges(userId: string, dto: PullSyncDto) {
    await assertSyncDevice(this.prisma, userId, dto.deviceId);

    const cursorBigInt = parsePullCursor(dto.cursor);
    const limit = dto.limit || 100;

    const rows = await this.prisma.change.findMany({
      where: {
        userId,
        ...(cursorBigInt !== undefined ? { cursor: { gt: cursorBigInt } } : {}),
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

    // An empty page echoes the caller's checkpoint instead of inventing one: a
    // device that stored a real cursor must not be handed "0" and start over.
    const nextCursor =
      formattedChanges.length > 0
        ? formattedChanges[formattedChanges.length - 1].cursor
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
