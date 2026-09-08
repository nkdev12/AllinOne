import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AuditAction } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";

export interface RecordAuditLogParams {
  userId: string;
  action: AuditAction;
  resourceType?: string;
  resourceId?: string;
  changes?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Persists a structured SIEM audit log event into the database.
   *
   * @param params Audit log parameter object
   * @returns Created AuditLog record
   */
  async recordAuditLog(params: RecordAuditLogParams) {
    const correlationId = params.correlationId || uuidv4();

    const mergedMetadata = {
      ...(params.metadata || {}),
      correlationId,
      recordedAt: new Date().toISOString(),
    };

    try {
      const logEntry = await this.prisma.auditLog.create({
        data: {
          userId: params.userId,
          action: params.action,
          resourceType: params.resourceType || null,
          resourceId: params.resourceId || null,
          changes: params.changes || undefined,
          ipAddress: params.ipAddress || null,
          userAgent: params.userAgent || null,
          metadata: mergedMetadata,
        },
      });

      this.logger.log(
        `[AuditLog] Recorded '${params.action}' for userId: ${params.userId} (CorrelationID: ${correlationId})`,
      );

      return logEntry;
    } catch (error: any) {
      this.logger.error(
        `[AuditLog] Failed to record audit log '${params.action}' for userId: ${params.userId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
