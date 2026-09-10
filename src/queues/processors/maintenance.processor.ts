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

    const prunedChanges = await this.prisma.change.deleteMany({
      where: { createdAt: { lt: changeRetentionCutoff } },
    });

    if (prunedChanges.count > 0 && this.metricsService) {
      this.metricsService.incrementSyncChangesCompacted(prunedChanges.count);
    }

    this.logger.log(
      `[MaintenanceProcessor] Cleanup complete: purged ${expiredSessions.count} expired sessions, ${expiredIdempotencyKeys.count} expired idempotency keys, and pruned ${prunedChanges.count} change event records older than ${retentionDays} days.`,
    );

    return {
      purgedSessions: expiredSessions.count,
      purgedIdempotencyKeys: expiredIdempotencyKeys.count,
      purgedChanges: prunedChanges.count,
      executedAt: now.toISOString(),
    };
  }
}
