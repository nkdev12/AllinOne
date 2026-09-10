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

export interface QueryAuditLogsDto {
  userId?: string;
  action?: AuditAction;
  resourceType?: string;
  resourceId?: string;
  from?: string | Date;
  to?: string | Date;
  page?: number;
  limit?: number;
}

export interface PaginatedAuditLogsDto {
  data: any[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
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

  /**
   * Queries security audit logs for administrative SIEM monitoring.
   *
   * @param dto Query filters and pagination parameters
   * @returns Paginated audit log records
   */
  async queryLogs(dto: QueryAuditLogsDto): Promise<PaginatedAuditLogsDto> {
    const page = Math.max(1, dto.page || 1);
    const limit = Math.min(100, Math.max(1, dto.limit || 20));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (dto.userId) where.userId = dto.userId;
    if (dto.action) where.action = dto.action;
    if (dto.resourceType) where.resourceType = dto.resourceType;
    if (dto.resourceId) where.resourceId = dto.resourceId;

    if (dto.from || dto.to) {
      where.createdAt = {};
      if (dto.from) where.createdAt.gte = new Date(dto.from);
      if (dto.to) where.createdAt.lte = new Date(dto.to);
    }

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
