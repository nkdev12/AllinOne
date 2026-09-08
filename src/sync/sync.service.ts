import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { PushSyncDto } from "./dto/push-sync.dto";
import { PullSyncDto } from "./dto/pull-sync.dto";
import { SyncGateway } from "./sync.gateway";
import { MetricsService } from "@/common/metrics/metrics.service";

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
   */
  async pushChanges(userId: string, dto: PushSyncDto) {
    const device = await this.prisma.device.findFirst({
      where: { id: dto.deviceId, userId, revokedAt: null },
    });
    if (!device) {
      throw new NotFoundException(
        `Active device with ID '${dto.deviceId}' not found.`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const conflictsResolved = 0;
      const accepted: string[] = [];
      const conflicts: SyncConflictEntry[] = [];

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

        const createdChange = await tx.change.create({
          data: {
            userId,
            deviceId: dto.deviceId,
            entityType: change.entityType,
            entityId: change.entityId,
            operation: change.operation as any,
            version: change.version,
            payload: finalPayload,
          },
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

      const latestChange = await tx.change.findFirst({
        where: { userId },
        orderBy: { cursor: "desc" },
        select: { cursor: true },
      });

      const highestCursor = latestChange ? latestChange.cursor.toString() : "0";

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
    const device = await this.prisma.device.findFirst({
      where: { id: dto.deviceId, userId, revokedAt: null },
    });
    if (!device) {
      throw new NotFoundException(
        `Active device with ID '${dto.deviceId}' not found.`,
      );
    }

    const cursorBigInt = dto.cursor ? BigInt(dto.cursor) : undefined;
    const limit = dto.limit || 100;

    const changes = await this.prisma.change.findMany({
      where: {
        userId,
        ...(cursorBigInt !== undefined ? { cursor: { gt: cursorBigInt } } : {}),
      },
      orderBy: { cursor: "asc" },
      take: limit,
    });

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
    }));

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
      hasMore: changes.length === limit,
    };
  }

  /**
   * Query synchronization status metadata for a specified device.
   */
  async getSyncStatus(userId: string, deviceId: string) {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, userId, revokedAt: null },
    });
    if (!device) {
      throw new NotFoundException(
        `Active device with ID '${deviceId}' not found.`,
      );
    }

    const syncState = await this.prisma.deviceSyncState.findUnique({
      where: { deviceId },
    });

    const latestChange = await this.prisma.change.findFirst({
      where: { userId },
      orderBy: { cursor: "desc" },
      select: { cursor: true },
    });

    return {
      deviceId,
      lastPulledCursor: syncState?.lastPulledCursor || "0",
      lastPushedSequence: syncState?.lastPushedSequence || 0,
      lastSuccessfulSyncAt: syncState?.lastSuccessfulSyncAt || null,
      serverHighestCursor: latestChange ? latestChange.cursor.toString() : "0",
    };
  }
}
