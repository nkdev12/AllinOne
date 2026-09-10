import { Test, TestingModule } from "@nestjs/testing";
import { AdminService } from "./admin.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
import { NotFoundException } from "@nestjs/common";
import { AuditAction, UserStatus } from "@prisma/client";

describe("AdminService", () => {
  let service: AdminService;
  let prisma: any;
  let auditLogService: any;

  const mockUser = {
    id: "user-123",
    email: "target@example.com",
    displayName: "Target User",
    status: UserStatus.ACTIVE,
    createdAt: new Date(),
    sessions: [{ id: "s1" }],
    devices: [{ id: "d1" }],
    mfaSettings: { totpEnabled: true },
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(mockUser),
        update: jest.fn().mockImplementation(({ data }) => ({
          ...mockUser,
          ...data,
        })),
      },
      session: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      mFASetting: {
        update: jest.fn().mockResolvedValue({ totpEnabled: false }),
      },
      auditLog: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    auditLogService = {
      recordAuditLog: jest.fn().mockResolvedValue({ id: "audit-1" }),
      queryLogs: jest.fn().mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("queryAuditLogs", () => {
    it("should delegate to AuditLogService.queryLogs", async () => {
      const result = await service.queryAuditLogs({
        userId: "user-123",
        action: AuditAction.LOGIN_FAILURE,
      });

      expect(auditLogService.queryLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-123",
          action: AuditAction.LOGIN_FAILURE,
        }),
      );
      expect(result).toBeDefined();
    });
  });

  describe("revokeUserSessions", () => {
    it("should revoke all active sessions and record an audit log", async () => {
      const result = await service.revokeUserSessions(
        "user-123",
        "operator-456",
        { reason: "Compromise detected" },
      );

      expect(result.success).toBe(true);
      expect(result.revokedSessionsCount).toBe(3);
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-123", revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      });
      expect(auditLogService.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "operator-456",
          action: AuditAction.DEVICE_REVOKED,
          resourceId: "user-123",
        }),
      );
    });

    it("should throw NotFoundException if user does not exist", async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.revokeUserSessions("non-existent", "operator-456"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("disableUserMfa", () => {
    it("should reset MFA and record an audit log", async () => {
      const result = await service.disableUserMfa("user-123", "operator-456", {
        reason: "User verified in person",
      });

      expect(result.success).toBe(true);
      expect(prisma.mFASetting.update).toHaveBeenCalledWith({
        where: { userId: "user-123" },
        data: expect.objectContaining({ totpEnabled: false, totpSecret: null }),
      });
      expect(auditLogService.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "operator-456",
          action: AuditAction.MFA_DISABLED,
        }),
      );
    });
  });

  describe("updateUserStatus", () => {
    it("should update status to SUSPENDED and revoke active sessions", async () => {
      const result = await service.updateUserStatus(
        "user-123",
        "operator-456",
        { status: UserStatus.SUSPENDED, reason: "Abuse report" },
      );

      expect(result.status).toBe(UserStatus.SUSPENDED);
      expect(prisma.session.updateMany).toHaveBeenCalled();
      expect(auditLogService.recordAuditLog).toHaveBeenCalled();
    });
  });
});
