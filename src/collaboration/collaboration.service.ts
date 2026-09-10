import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
import { AuditAction } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import {
  ResourceShare,
  ResourceType,
  ShareRole,
  SharePermissionResult,
} from "./collaboration.interface";
import {
  CreateShareDto,
  QuerySharedResourcesDto,
  UpdateShareDto,
} from "./dto/collaboration.dto";

@Injectable()
export class CollaborationService {
  private readonly logger = new Logger(CollaborationService.name);
  // Fast in-memory cache synchronized with store
  private readonly shares = new Map<string, ResourceShare>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private getRoleWeight(role: ShareRole): number {
    switch (role) {
      case "ADMIN":
        return 3;
      case "EDITOR":
        return 2;
      case "VIEWER":
        return 1;
      default:
        return 0;
    }
  }

  private async verifyResourceOwner(
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<{ ownerId: string; title: string }> {
    if (resourceType === "NOTE") {
      const note = await this.prisma.note.findFirst({
        where: { id: resourceId, deletedAt: null },
      });
      if (!note) {
        throw new NotFoundException(`Note with ID '${resourceId}' not found.`);
      }
      return { ownerId: note.userId, title: note.title };
    }

    if (resourceType === "PROJECT") {
      const project = await this.prisma.project.findFirst({
        where: { id: resourceId, deletedAt: null },
      });
      if (!project) {
        throw new NotFoundException(
          `Project with ID '${resourceId}' not found.`,
        );
      }
      return { ownerId: project.userId, title: project.name };
    }

    if (resourceType === "CALENDAR") {
      const calendar = await this.prisma.calendar.findFirst({
        where: { id: resourceId, deletedAt: null },
      });
      if (!calendar) {
        throw new NotFoundException(
          `Calendar with ID '${resourceId}' not found.`,
        );
      }
      return { ownerId: calendar.userId, title: calendar.name };
    }

    throw new NotFoundException(
      `Resource type '${resourceType}' not supported.`,
    );
  }

  async shareResource(
    userId: string,
    dto: CreateShareDto,
  ): Promise<ResourceShare> {
    const { ownerId, title } = await this.verifyResourceOwner(
      dto.resourceType,
      dto.resourceId,
    );

    // Caller must be owner or existing ADMIN collaborator
    const access = await this.checkAccess(
      userId,
      undefined,
      dto.resourceType,
      dto.resourceId,
      "ADMIN",
    );
    if (!access.hasAccess) {
      throw new ForbiddenException(
        "You do not have administrative permissions to share this resource.",
      );
    }

    // Owner cannot share with themselves
    const collaborator = await this.prisma.user.findFirst({
      where: { email: dto.email.toLowerCase(), deletedAt: null },
    });

    if (collaborator && collaborator.id === ownerId) {
      throw new ConflictException(
        "Cannot share a resource with the resource owner.",
      );
    }

    // Check for existing active share
    const existing = Array.from(this.shares.values()).find(
      (s) =>
        s.resourceType === dto.resourceType &&
        s.resourceId === dto.resourceId &&
        s.sharedWithEmail.toLowerCase() === dto.email.toLowerCase(),
    );

    if (existing) {
      throw new ConflictException(
        `Resource is already shared with '${dto.email}'. Update their role instead.`,
      );
    }

    const share: ResourceShare = {
      id: uuidv4(),
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      ownerId,
      sharedWithUserId: collaborator?.id,
      sharedWithEmail: dto.email.toLowerCase(),
      role: dto.role,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.shares.set(share.id, share);

    await this.auditLogService.recordAuditLog({
      userId,
      action: AuditAction.DEVICE_ADDED,
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      metadata: {
        actionType: "RESOURCE_SHARED",
        sharedWithEmail: dto.email,
        role: dto.role,
        resourceTitle: title,
      },
    });

    this.logger.log(
      `Resource ${dto.resourceType}:${dto.resourceId} shared with ${dto.email} [${dto.role}] by ${userId}`,
    );

    return share;
  }

  async getSharesForResource(
    userId: string,
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<ResourceShare[]> {
    await this.verifyResourceOwner(resourceType, resourceId);

    const access = await this.checkAccess(
      userId,
      undefined,
      resourceType,
      resourceId,
      "VIEWER",
    );
    if (!access.hasAccess) {
      throw new ForbiddenException(
        "You do not have permission to view collaborators for this resource.",
      );
    }

    return Array.from(this.shares.values()).filter(
      (s) => s.resourceType === resourceType && s.resourceId === resourceId,
    );
  }

  async updateShareRole(
    userId: string,
    shareId: string,
    dto: UpdateShareDto,
  ): Promise<ResourceShare> {
    const share = this.shares.get(shareId);
    if (!share) {
      throw new NotFoundException(`Share with ID '${shareId}' not found.`);
    }

    const access = await this.checkAccess(
      userId,
      undefined,
      share.resourceType,
      share.resourceId,
      "ADMIN",
    );
    if (!access.hasAccess) {
      throw new ForbiddenException(
        "Only resource owners or administrators can change collaborator roles.",
      );
    }

    share.role = dto.role;
    share.updatedAt = new Date().toISOString();
    this.shares.set(share.id, share);

    return share;
  }

  async revokeShare(userId: string, shareId: string): Promise<void> {
    const share = this.shares.get(shareId);
    if (!share) {
      throw new NotFoundException(`Share with ID '${shareId}' not found.`);
    }

    const access = await this.checkAccess(
      userId,
      undefined,
      share.resourceType,
      share.resourceId,
      "ADMIN",
    );
    // Collaborator can also remove themselves
    const isSelfRevocation = share.sharedWithUserId === userId;

    if (!access.hasAccess && !isSelfRevocation) {
      throw new ForbiddenException(
        "You do not have permission to revoke this share.",
      );
    }

    this.shares.delete(shareId);

    await this.auditLogService.recordAuditLog({
      userId,
      action: AuditAction.DEVICE_REVOKED,
      resourceType: share.resourceType,
      resourceId: share.resourceId,
      metadata: {
        actionType: "RESOURCE_SHARE_REVOKED",
        revokedShareId: shareId,
        revokedEmail: share.sharedWithEmail,
      },
    });
  }

  async getResourcesSharedWithUser(
    userId: string,
    userEmail?: string,
    query?: QuerySharedResourcesDto,
  ): Promise<{
    data: ResourceShare[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query?.page || 1;
    const limit = query?.limit || 20;

    let allShares = Array.from(this.shares.values()).filter(
      (s) =>
        s.sharedWithUserId === userId ||
        (userEmail &&
          s.sharedWithEmail.toLowerCase() === userEmail.toLowerCase()),
    );

    if (query?.resourceType) {
      allShares = allShares.filter(
        (s) => s.resourceType === query.resourceType,
      );
    }

    const total = allShares.length;
    const offset = (page - 1) * limit;
    const data = allShares.slice(offset, offset + limit);

    return { data, total, page, limit };
  }

  async checkAccess(
    userId: string,
    userEmail: string | undefined,
    resourceType: ResourceType,
    resourceId: string,
    requiredRole: ShareRole = "VIEWER",
  ): Promise<SharePermissionResult> {
    try {
      const { ownerId } = await this.verifyResourceOwner(
        resourceType,
        resourceId,
      );

      if (ownerId === userId) {
        return { hasAccess: true, role: "ADMIN", isOwner: true };
      }
    } catch (_) {
      // Resource may not exist or not be owned by caller
    }

    const requiredWeight = this.getRoleWeight(requiredRole);

    const activeShare = Array.from(this.shares.values()).find(
      (s) =>
        s.resourceType === resourceType &&
        s.resourceId === resourceId &&
        (s.sharedWithUserId === userId ||
          (userEmail &&
            s.sharedWithEmail.toLowerCase() === userEmail.toLowerCase())),
    );

    if (!activeShare) {
      return { hasAccess: false, isOwner: false };
    }

    const hasAccess = this.getRoleWeight(activeShare.role) >= requiredWeight;
    return {
      hasAccess,
      role: activeShare.role,
      isOwner: false,
    };
  }
}
