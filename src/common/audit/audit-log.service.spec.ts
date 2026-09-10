import { Test, TestingModule } from "@nestjs/testing";
import { AuditLogService } from "./audit-log.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AuditAction } from "@prisma/client";

describe("AuditLogService", () => {
  let service: AuditLogService;
  let prismaService: any;

  const mockAuditEntry = {
    id: "audit-uuid-1",
    userId: "user-uuid-123",
    action: AuditAction.LOGIN_SUCCESS,
    resourceType: "User",
    resourceId: "user-uuid-123",
    ipAddress: "127.0.0.1",
    userAgent: "Jest Test Agent",
    metadata: { correlationId: "test-correlation-id" },
    createdAt: new Date(),
  };

  beforeEach(async () => {
    prismaService = {
      auditLog: {
        create: jest.fn().mockResolvedValue(mockAuditEntry),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogService,
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    service = module.get<AuditLogService>(AuditLogService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("recordAuditLog", () => {
    it("should successfully create an AuditLog entry with IP address and metadata", async () => {
      const result = await service.recordAuditLog({
        userId: "user-uuid-123",
        action: AuditAction.LOGIN_SUCCESS,
        resourceType: "User",
        resourceId: "user-uuid-123",
        ipAddress: "127.0.0.1",
        userAgent: "Jest Test Agent",
        metadata: { loginType: "EMAIL_PASSWORD" },
      });

      expect(result).toBeDefined();
      expect(result.action).toBe(AuditAction.LOGIN_SUCCESS);
      expect(prismaService.auditLog.create).toHaveBeenCalled();
    });

    it("should handle missing optional fields gracefully", async () => {
      await service.recordAuditLog({
        userId: "user-uuid-123",
        action: AuditAction.MFA_ENABLED,
      });

      expect(prismaService.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-uuid-123",
          action: AuditAction.MFA_ENABLED,
          resourceType: null,
          resourceId: null,
          ipAddress: null,
          userAgent: null,
        }),
      });
    });
  });

  describe("queryLogs", () => {
    it("should query logs with filters and pagination", async () => {
      prismaService.auditLog.findMany = jest
        .fn()
        .mockResolvedValue([mockAuditEntry]);
      prismaService.auditLog.count = jest.fn().mockResolvedValue(1);

      const result = await service.queryLogs({
        userId: "user-uuid-123",
        action: AuditAction.LOGIN_SUCCESS,
        page: 1,
        limit: 10,
      });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
      expect(prismaService.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: "user-uuid-123",
            action: AuditAction.LOGIN_SUCCESS,
          }),
          skip: 0,
          take: 10,
        }),
      );
    });
  });
});
