import { Processor, Process } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import { PrismaService } from "@/common/prisma/prisma.service";

@Processor("maintenance")
export class MaintenanceProcessor {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(private prisma: PrismaService) {}

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

    this.logger.log(
      `[MaintenanceProcessor] Cleanup complete: purged ${expiredSessions.count} expired sessions and ${expiredIdempotencyKeys.count} expired idempotency keys.`,
    );

    return {
      purgedSessions: expiredSessions.count,
      purgedIdempotencyKeys: expiredIdempotencyKeys.count,
      executedAt: now.toISOString(),
    };
  }
}
