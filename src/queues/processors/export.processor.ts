import { Processor, Process } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import { PrismaService } from "@/common/prisma/prisma.service";

export interface ProcessExportJobData {
  userId: string;
  exportType: "ALL" | "VAULT" | "NOTES" | "TASKS";
  requestIp?: string;
}

@Processor("export")
export class ExportProcessor {
  private readonly logger = new Logger(ExportProcessor.name);

  constructor(private prisma: PrismaService) {}

  @Process("process-export")
  async handleProcessExport(job: Job<ProcessExportJobData>) {
    this.logger.log(
      `[ExportProcessor] Processing data export job #${job.id} for user: ${job.data.userId}, type: ${job.data.exportType}`,
    );

    const user = await this.prisma.user.findUnique({
      where: { id: job.data.userId },
      select: { id: true, email: true, createdAt: true },
    });

    if (!user) {
      throw new Error(
        `User with ID '${job.data.userId}' not found for export.`,
      );
    }

    // Generate exported payload representation
    const exportBundle = {
      user,
      exportType: job.data.exportType,
      exportedAt: new Date().toISOString(),
    };

    this.logger.log(
      `[ExportProcessor] Successfully generated export bundle for user ${job.data.userId}`,
    );

    return exportBundle;
  }
}
