import { Test, TestingModule } from "@nestjs/testing";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { UserStatus, AuditAction } from "@prisma/client";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { AdminGuard } from "./guards/admin.guard";

describe("AdminController", () => {
  let controller: AdminController;
  let adminService: any;

  beforeEach(async () => {
    adminService = {
      queryAuditLogs: jest.fn().mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      }),
      revokeUserSessions: jest.fn().mockResolvedValue({
        success: true,
        revokedSessionsCount: 2,
      }),
      disableUserMfa: jest.fn().mockResolvedValue({
        success: true,
        targetUserId: "user-1",
        message: "MFA has been administratively disabled",
      }),
      updateUserStatus: jest.fn().mockResolvedValue({
        id: "user-1",
        status: UserStatus.SUSPENDED,
      }),
      getUserOverview: jest.fn().mockResolvedValue({
        user: { id: "user-1", isLocked: false, failedLoginAttempts: 0 },
      }),
      unlockUserAccount: jest.fn().mockResolvedValue({
        success: true,
        targetUserId: "user-1",
        message: "User account unlocked successfully",
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: AdminService, useValue: adminService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AdminController>(AdminController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("getAuditLogs", () => {
    it("should delegate to AdminService.queryAuditLogs", async () => {
      const query = { userId: "u1", action: AuditAction.LOGIN_FAILURE };
      const res = await controller.getAuditLogs(query);
      expect(adminService.queryAuditLogs).toHaveBeenCalledWith(query);
      expect(res.total).toBe(0);
    });
  });

  describe("revokeSessions", () => {
    it("should delegate to AdminService.revokeUserSessions", async () => {
      const dto = { reason: "Security violation" };
      const res = await controller.revokeSessions("user-1", "operator-1", dto);
      expect(adminService.revokeUserSessions).toHaveBeenCalledWith(
        "user-1",
        "operator-1",
        dto,
      );
      expect(res.success).toBe(true);
    });
  });

  describe("disableMfa", () => {
    it("should delegate to AdminService.disableUserMfa", async () => {
      const dto = { reason: "Identity verified offline" };
      const res = await controller.disableMfa("user-1", "operator-1", dto);
      expect(adminService.disableUserMfa).toHaveBeenCalledWith(
        "user-1",
        "operator-1",
        dto,
      );
      expect(res.success).toBe(true);
    });
  });

  describe("updateUserStatus", () => {
    it("should delegate to AdminService.updateUserStatus", async () => {
      const dto = { status: UserStatus.SUSPENDED, reason: "Abuse" };
      const res = await controller.updateUserStatus(
        "user-1",
        "operator-1",
        dto,
      );
      expect(adminService.updateUserStatus).toHaveBeenCalledWith(
        "user-1",
        "operator-1",
        dto,
      );
      expect(res.status).toBe(UserStatus.SUSPENDED);
    });
  });

  describe("getUserOverview", () => {
    it("should delegate to AdminService.getUserOverview", async () => {
      const res = await controller.getUserOverview("user-1");
      expect(adminService.getUserOverview).toHaveBeenCalledWith("user-1");
      expect(res.user.id).toBe("user-1");
    });
  });

  describe("unlockUser", () => {
    it("should delegate to AdminService.unlockUserAccount", async () => {
      const dto = { reason: "Customer verified" };
      const res = await controller.unlockUser("user-1", "operator-1", dto);
      expect(adminService.unlockUserAccount).toHaveBeenCalledWith(
        "user-1",
        "operator-1",
        "Customer verified",
      );
      expect(res.success).toBe(true);
    });

    it("should fallback to default operator ID if undefined", async () => {
      const dto = { reason: "Customer verified" };
      const res = await controller.unlockUser("user-1", undefined as any, dto);
      expect(adminService.unlockUserAccount).toHaveBeenCalledWith(
        "user-1",
        "00000000-0000-0000-0000-000000000000",
        "Customer verified",
      );
      expect(res.success).toBe(true);
    });
  });
});
