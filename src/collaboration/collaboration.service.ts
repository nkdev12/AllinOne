import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
import {
  AuditAction,
  Prisma,
  ResourceShare as ResourceShareRow,
} from "@prisma/client";
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

/**
 * Grants are read from and written to the `ResourceShare` collection — there is
 * no process-local copy any more, which is the whole point of the row existing:
 * an in-memory `Map` lost every share on restart, hid them from every other
 * worker, and could not hold the duplicate rule anywhere two racing requests
 * both had to lose.
 *
 * What the response shape promises is unchanged (`docs/API_REFERENCE.md` and the
 * Flutter client read these keys), so `toResourceShare` maps Prisma's `Date`s
 * back to ISO strings and hands the id through as the UUID string the schema
 * stores in `_id`.
 */
@Injectable()
export class CollaborationService {
  private readonly logger = new Logger(CollaborationService.name);

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

  private toResourceShare(row: ResourceShareRow): ResourceShare {
    return {
      id: row.id,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      ownerId: row.ownerId,
      sharedWithUserId: row.sharedWithUserId,
      sharedWithEmail: row.sharedWithEmail,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
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

  private async findActiveShare(shareId: string): Promise<ResourceShareRow> {
    const row = await this.prisma.resourceShare.findFirst({
      where: { id: shareId, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException(`Share with ID '${shareId}' not found.`);
    }
    return row;
  }

  async shareResource(
    userId: string,
    dto: CreateShareDto,
  ): Promise<ResourceShare> {
    // 1. The resource has to exist and not be in the bin.
    const { ownerId, title } = await this.verifyResourceOwner(
      dto.resourceType,
      dto.resourceId,
    );

    // 2. Caller must be owner or existing ADMIN collaborator.
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

    // 3. The recipient has to be somebody the access check can later recognise.
    //
    // An invite to an unregistered address used to be stored with
    // `sharedWithUserId: undefined`, and nothing ever filled it in: the notes
    // read/write path calls `checkAccess(userId, undefined, …)` — email never
    // reaches it — so such a share matched neither by id nor by email and
    // granted precisely nothing while still listing as a collaborator. The
    // schema now requires `sharedWithUserId`, so a grant is refused here rather
    // than written as a lie; the invite can be re-sent once the account exists.
    const collaborator = await this.prisma.user.findFirst({
      where: { email: dto.email.toLowerCase(), deletedAt: null },
    });

    if (!collaborator) {
      throw new ConflictException(
        `No registered account found for '${dto.email}'. The person you are sharing with must have an account before access can be granted.`,
      );
    }

    if (collaborator.id === ownerId) {
      throw new ConflictException(
        "Cannot share a resource with the resource owner.",
      );
    }

    const sharedWithEmail = collaborator.email.toLowerCase();

    // 4. One grant per (resource, recipient). Read-then-write goes in a
    // transaction because the read is only an optimisation: the unique key on
    // `ResourceShare` is what actually refuses a second active grant, so a
    // concurrent request that slips past the read loses on the write and gets
    // the same 409 wording.
    let row: ResourceShareRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const clash = await tx.resourceShare.findFirst({
          where: {
            resourceType: dto.resourceType,
            resourceId: dto.resourceId,
            sharedWithEmail,
          },
        });

        if (clash && !clash.deletedAt) {
          throw new ConflictException(
            `Resource is already shared with '${dto.email}'. Update their role instead.`,
          );
        }

        if (clash) {
          // A revoked grant to the same address, tombstoned but kept. Revive it
          // rather than collide with the unique key, so re-sharing with somebody
          // you already revoked works the way it did from memory. `createdAt`
          // stays on the original grant: it is the same collaborator record.
          return tx.resourceShare.update({
            where: { id: clash.id },
            data: {
              role: dto.role,
              ownerId,
              sharedWithUserId: collaborator.id,
              sharedWithEmail,
              deletedAt: null,
            },
          });
        }

        return tx.resourceShare.create({
          data: {
            resourceType: dto.resourceType,
            resourceId: dto.resourceId,
            ownerId,
            sharedWithUserId: collaborator.id,
            sharedWithEmail,
            role: dto.role,
          },
        });
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          `Resource is already shared with '${dto.email}'. Update their role instead.`,
        );
      }
      throw error;
    }

    const share = this.toResourceShare(row);

    // Audit sits outside the transaction, the way every sibling service does it:
    // a failed log write must not roll back the grant, and a grant must not
    // depend on the log being reachable.
    await this.auditLogService.recordAuditLog({
      userId,
      action: AuditAction.RESOURCE_SHARED,
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      metadata: {
        actionType: "RESOURCE_SHARED",
        sharedWithEmail,
        sharedWithUserId: collaborator.id,
        role: dto.role,
        resourceTitle: title,
        shareId: share.id,
      },
    });

    this.logger.log(
      `Resource ${dto.resourceType}:${dto.resourceId} shared with ${sharedWithEmail} [${dto.role}] by ${userId}`,
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

    const rows = await this.prisma.resourceShare.findMany({
      where: { resourceType, resourceId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });

    const isOwnerOrAdmin = access.isOwner || access.role === "ADMIN";
    const visibleRows = isOwnerOrAdmin
      ? rows
      : rows.filter((row) => row.sharedWithUserId === userId);

    return visibleRows.map((row) => this.toResourceShare(row));
  }

  async updateShareRole(
    userId: string,
    shareId: string,
    dto: UpdateShareDto,
  ): Promise<ResourceShare> {
    const share = await this.findActiveShare(shareId);

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

    const row = await this.prisma.resourceShare.update({
      where: { id: share.id },
      data: { role: dto.role },
    });

    return this.toResourceShare(row);
  }

  async revokeShare(userId: string, shareId: string): Promise<void> {
    const share = await this.findActiveShare(shareId);

    const access = await this.checkAccess(
      userId,
      undefined,
      share.resourceType,
      share.resourceId,
      "ADMIN",
    );
    // A collaborator may always drop themselves, even without ADMIN weight —
    // deliberate: nobody should be stranded inside a resource they were granted
    // into and cannot leave.
    const isSelfRevocation = share.sharedWithUserId === userId;

    if (!access.hasAccess && !isSelfRevocation) {
      throw new ForbiddenException(
        "You do not have permission to revoke this share.",
      );
    }

    // Soft delete, mirroring the `deletedAt` the rest of the schema uses for
    // rows that must stop answering queries while keeping the grant trail: every
    // read here filters `deletedAt: null`.
    await this.prisma.resourceShare.update({
      where: { id: share.id },
      data: { deletedAt: new Date() },
    });

    await this.auditLogService.recordAuditLog({
      userId,
      action: AuditAction.RESOURCE_SHARE_REVOKED,
      resourceType: share.resourceType,
      resourceId: share.resourceId,
      metadata: {
        actionType: "RESOURCE_SHARE_REVOKED",
        revokedShareId: share.id,
        revokedEmail: share.sharedWithEmail,
        selfRevocation: isSelfRevocation,
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

    const where: Prisma.ResourceShareWhereInput = {
      deletedAt: null,
      OR: [
        { sharedWithUserId: userId },
        ...(userEmail ? [{ sharedWithEmail: userEmail.toLowerCase() }] : []),
      ],
    };

    if (query?.resourceType) {
      where.resourceType = query.resourceType;
    }

    const [rows, total] = await Promise.all([
      this.prisma.resourceShare.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.resourceShare.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.toResourceShare(row)),
      total,
      page,
      limit,
    };
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

    const activeShare = await this.prisma.resourceShare.findFirst({
      where: {
        resourceType,
        resourceId,
        deletedAt: null,
        OR: [
          { sharedWithUserId: userId },
          ...(userEmail ? [{ sharedWithEmail: userEmail.toLowerCase() }] : []),
        ],
      },
      orderBy: { createdAt: "asc" },
    });

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
