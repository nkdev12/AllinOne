import { Processor, Process } from "@nestjs/bull";
import { Logger, Optional } from "@nestjs/common";
import { Job } from "bull";
import { PrismaService } from "@/common/prisma/prisma.service";
import { MetricsService } from "@/common/metrics/metrics.service";

@Processor("maintenance")
export class MaintenanceProcessor {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    private prisma: PrismaService,
    @Optional() private metricsService?: MetricsService,
  ) {}

  @Process("cleanup-expired")
  async handleCleanupExpired(job: Job) {
    this.logger.log(
      `[MaintenanceProcessor] Executing retryable maintenance job #${job.id}...`,
    );

    const now = new Date();

    const expiredSessions = await this.prisma.session.deleteMany({
      where: { refreshExpiresAt: { lt: now } },
    });

    const expiredIdempotencyKeys = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: now } },
    });

    // P1-5: Prune Change records older than retention period (default 30 days)
    const retentionDays = parseInt(
      process.env.CHANGE_RETENTION_DAYS || "30",
      10,
    );
    const changeRetentionCutoff = new Date(
      now.getTime() - retentionDays * 24 * 60 * 60 * 1000,
    );

    // A change log is a queue, and a queue is only safe to compact behind the
    // slowest reader. `createdAt` cannot answer that on its own: cursors count
    // per user, so a phone that has not pulled in 60 days still holds a
    // checkpoint inside the rows this job is about to remove. Its next pull then
    // matches nothing — not because it caught up but because the history is
    // gone — and it goes on syncing from there, permanently missing every edit
    // and deletion in between, with no error anywhere to say so. So each user's
    // prune stops at the oldest cursor their live devices have not read.
    const expiredByUser = await this.prisma.change.groupBy({
      by: ["userId"],
      where: { createdAt: { lt: changeRetentionCutoff } },
      _count: { _all: true },
    });

    const floors = await this._oldestUnreadCheckpoints(
      expiredByUser.map((group) => group.userId),
    );

    // One delete per user instead of the single global one this used to be: the
    // floor is per user, and a daily job bounded by the number of users with
    // expired rows is not a load worth complicating the query for.
    let prunedChanges = 0;
    let heldBack = 0;
    for (const group of expiredByUser) {
      const floor = floors.get(group.userId);
      const { count } = await this.prisma.change.deleteMany({
        where: {
          userId: group.userId,
          createdAt: { lt: changeRetentionCutoff },
          // Absent means no live device is waiting on this log at all, so
          // nothing holds the prune back.
          ...(floor === undefined ? {} : { cursor: { lt: floor } }),
        },
      });
      prunedChanges += count;
      heldBack += group._count._all - count;
    }

    if (prunedChanges > 0 && this.metricsService) {
      this.metricsService.incrementSyncChangesCompacted(prunedChanges);
    }

    this.logger.log(
      `[MaintenanceProcessor] Cleanup complete: purged ${expiredSessions.count} expired sessions, ${expiredIdempotencyKeys.count} expired idempotency keys, and pruned ${prunedChanges} change event records older than ${retentionDays} days` +
        (heldBack > 0
          ? ` (${heldBack} held back for a device that has not pulled them yet)`
          : "") +
        ".",
    );

    return {
      purgedSessions: expiredSessions.count,
      purgedIdempotencyKeys: expiredIdempotencyKeys.count,
      purgedChanges: prunedChanges,
      // Not a failure — the log growing past its nominal retention because a
      // device still needs the rows. Worth watching: it is the difference
      // between "compacted" and "someone is 40 days behind".
      heldBackForIdleDevices: heldBack,
      executedAt: now.toISOString(),
    };
  }

  /**
   * The oldest checkpoint each user's live devices hold — how far back the log
   * has to stay. A device that has never pulled counts as 0, which is correct:
   * it is going to ask for the whole log, and half of it is not an answer.
   * Revoked devices are excluded, because nothing can pull with them again.
   */
  private async _oldestUnreadCheckpoints(
    userIds: string[],
  ): Promise<Map<string, bigint>> {
    const devices = await this.prisma.device.findMany({
      where: { userId: { in: userIds }, revokedAt: null },
      select: {
        userId: true,
        syncStates: { select: { lastPulledCursor: true } },
      },
    });

    const floors = new Map<string, bigint>();
    for (const device of devices) {
      const checkpoint = parseCheckpoint(
        device.syncStates[0]?.lastPulledCursor,
      );
      const seen = floors.get(device.userId);
      if (seen === undefined || checkpoint < seen) {
        floors.set(device.userId, checkpoint);
      }
    }

    return floors;
  }
}

/**
 * A stored cursor, or 0 for anything that is not a plain number — including
 * null, which means "this device has never pulled". Guessing high here would
 * delete rows a device still needs, and the job would not be the thing that
 * noticed.
 */
function parseCheckpoint(cursor?: string | null): bigint {
  if (!cursor || !/^\d+$/.test(cursor)) return BigInt(0);
  return BigInt(cursor);
}
