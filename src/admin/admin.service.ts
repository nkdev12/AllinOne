import { Injectable, NotFoundException, Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
import {
  QueryAdminAuditLogsDto,
  AdminRevokeSessionsDto,
  AdminDisableMfaDto,
  UpdateUserStatusDto,
} from "./dto/admin.dto";
import { AuditAction } from "@prisma/client";

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Queries security audit logs for SIEM analysis.
   */
  async queryAuditLogs(dto: QueryAdminAuditLogsDto) {
    return this.auditLogService.queryLogs({
      userId: dto.userId,
      action: dto.action,
      resourceType: dto.resourceType,
      from: dto.from,
      to: dto.to,
      page: dto.page,
      limit: dto.limit,
    });
  }

  /**
   * Revokes all active sessions for a target user (Incident Response flow).
   */
  async revokeUserSessions(
    targetUserId: string,
    operatorId: string,
    dto?: AdminRevokeSessionsDto,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${targetUserId} not found`);
    }

    const now = new Date();
    const updateResult = await this.prisma.session.updateMany({
      where: {
        userId: targetUserId,
        revokedAt: null,
      },
      data: {
        revokedAt: now,
      },
    });

    await this.auditLogService.recordAuditLog({
      userId: operatorId,
      action: AuditAction.DEVICE_REVOKED,
      resourceType: "User",
      resourceId: targetUserId,
      metadata: {
        targetUserId,
        operatorId,
        revokedSessionsCount: updateResult.count,
        reason: dto?.reason || "Admin forced session revocation",
      },
    });

    this.logger.warn(
      `[AdminService] Operator ${operatorId} revoked ${updateResult.count} session(s) for user ${targetUserId}`,
    );

    return {
      success: true,
      targetUserId,
      revokedSessionsCount: updateResult.count,
    };
  }

  /**
   * Administratively disables MFA for an authenticated, locked-out user with full audit logging.
   */
  async disableUserMfa(
    targetUserId: string,
    operatorId: string,
    dto: AdminDisableMfaDto,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: { mfaSettings: true },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${targetUserId} not found`);
    }

    if (user.mfaSettings) {
      await this.prisma.mFASetting.update({
        where: { userId: targetUserId },
        data: {
          totpEnabled: false,
          totpSecret: null,
          recoveryCodes: null,
          backupCodesUsed: null,
        },
      });
    }

    await this.auditLogService.recordAuditLog({
      userId: operatorId,
      action: AuditAction.MFA_DISABLED,
      resourceType: "User",
      resourceId: targetUserId,
      metadata: {
        targetUserId,
        operatorId,
        reason: dto.reason,
      },
    });

    this.logger.warn(
      `[AdminService] Operator ${operatorId} disabled MFA for user ${targetUserId}. Reason: ${dto.reason}`,
    );

    return {
      success: true,
      targetUserId,
      message: "MFA has been administratively disabled",
    };
  }

  /**
   * Changes account status (ACTIVE, SUSPENDED, DELETED) and revokes sessions on suspension.
   */
  async updateUserStatus(
    targetUserId: string,
    operatorId: string,
    dto: UpdateUserStatusDto,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${targetUserId} not found`);
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        status: dto.status,
        deletedAt: dto.status === "DELETED" ? new Date() : undefined,
      },
    });

    if (dto.status === "SUSPENDED" || dto.status === "DELETED") {
      await this.prisma.session.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await this.auditLogService.recordAuditLog({
      userId: operatorId,
      action: AuditAction.ACCOUNT_CREATED,
      resourceType: "User",
      resourceId: targetUserId,
      changes: {
        previousStatus: user.status,
        newStatus: dto.status,
      },
      metadata: {
        targetUserId,
        operatorId,
        reason: dto.reason,
      },
    });

    return updatedUser;
  }

  /**
   * Retrieves security overview of a user (sessions, devices, MFA, recent audit events).
   */
  async getUserOverview(targetUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: {
        mfaSettings: true,
        devices: {
          where: { revokedAt: null },
          select: {
            id: true,
            name: true,
            platform: true,
            appVersion: true,
            lastSeenAt: true,
          },
        },
        sessions: {
          where: { revokedAt: null },
          select: {
            id: true,
            deviceId: true,
            lastActivityAt: true,
            ipAddress: true,
            userAgent: true,
            createdAt: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${targetUserId} not found`);
    }

    const recentAuditLogs = await this.prisma.auditLog.findMany({
      where: { userId: targetUserId },
      take: 10,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        action: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
      },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      },
      mfaEnabled: Boolean(user.mfaSettings?.totpEnabled),
      activeSessionsCount: user.sessions.length,
      activeDevicesCount: user.devices.length,
      activeSessions: user.sessions,
      activeDevices: user.devices,
      recentAuditLogs,
    };
  }
}
