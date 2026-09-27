import { Test, TestingModule } from "@nestjs/testing";
import {
  MailProcessor,
  SendVerificationEmailJobData,
  SendPasswordResetEmailJobData,
} from "./mail.processor";
import {
  NotificationProcessor,
  SendNotificationJobData,
} from "./notification.processor";
import { ExportProcessor, ProcessExportJobData } from "./export.processor";
import { MaintenanceProcessor } from "./maintenance.processor";
import { PrismaService } from "@/common/prisma/prisma.service";
import { MailService } from "@/common/mail/mail.service";
import { Job } from "bull";

describe("Queue Processors", () => {
  let mailProcessor: MailProcessor;
  let notificationProcessor: NotificationProcessor;
  let exportProcessor: ExportProcessor;
  let maintenanceProcessor: MaintenanceProcessor;
  let prismaService: any;
  let mailService: any;

  const mockUser = {
    id: "user-uuid-123",
    email: "test@example.com",
    createdAt: new Date(),
  };

  beforeEach(async () => {
    prismaService = {
      session: {
        deleteMany: jest.fn().mockResolvedValue({ count: 5 }),
      },
      idempotencyKey: {
        deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      change: {
        deleteMany: jest.fn().mockResolvedValue({ count: 12 }),
        // One user with 12 rows past the retention cutoff.
        groupBy: jest
          .fn()
          .mockResolvedValue([{ userId: mockUser.id, _count: { _all: 12 } }]),
      },
      device: {
        // No live device asks for anything, by default.
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue(mockUser),
      },
    };

    mailService = {
      sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
      sendPasswordResetOtpEmail: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailProcessor,
        NotificationProcessor,
        ExportProcessor,
        MaintenanceProcessor,
        { provide: PrismaService, useValue: prismaService },
        { provide: MailService, useValue: mailService },
      ],
    }).compile();

    mailProcessor = module.get<MailProcessor>(MailProcessor);
    notificationProcessor = module.get<NotificationProcessor>(
      NotificationProcessor,
    );
    exportProcessor = module.get<ExportProcessor>(ExportProcessor);
    maintenanceProcessor =
      module.get<MaintenanceProcessor>(MaintenanceProcessor);
  });

  describe("MailProcessor", () => {
    it("should process send-verification-email job successfully", async () => {
      const mockJob = {
        id: 1,
        data: {
          email: "test@example.com",
          token: "12345",
        } as SendVerificationEmailJobData,
      } as Job<SendVerificationEmailJobData>;

      const result = await mailProcessor.handleSendVerificationEmail(mockJob);
      expect(result).toBeDefined();
      expect(mailService.sendVerificationEmail).toHaveBeenCalledWith(
        "test@example.com",
        "12345",
        undefined,
      );
    });

    it("should process send-password-reset-email job successfully", async () => {
      const mockJob = {
        id: 2,
        data: {
          email: "test@example.com",
          otp: "678901",
        } as SendPasswordResetEmailJobData,
      } as Job<SendPasswordResetEmailJobData>;

      const result = await mailProcessor.handleSendPasswordResetEmail(mockJob);
      expect(result).toBeDefined();
      expect(mailService.sendPasswordResetOtpEmail).toHaveBeenCalledWith(
        "test@example.com",
        "678901",
      );
    });
  });

  describe("NotificationProcessor", () => {
    it("should process send-notification job successfully", async () => {
      const mockJob = {
        id: 2,
        data: {
          userId: "user-uuid-123",
          title: "Task Reminder",
          body: "Your task is due soon",
          channel: "NOTIFICATION",
        } as SendNotificationJobData,
      } as Job<SendNotificationJobData>;

      const result =
        await notificationProcessor.handleSendNotification(mockJob);
      expect(result).toBeDefined();
      expect(result.userId).toBe("user-uuid-123");
    });
  });

  describe("ExportProcessor", () => {
    it("should process process-export job successfully", async () => {
      const mockJob = {
        id: 3,
        data: {
          userId: "user-uuid-123",
          exportType: "ALL",
        } as ProcessExportJobData,
      } as Job<ProcessExportJobData>;

      const result = await exportProcessor.handleProcessExport(mockJob);
      expect(result).toBeDefined();
      expect(result.user.id).toBe("user-uuid-123");
      expect(result.exportType).toBe("ALL");
    });
  });

  describe("MaintenanceProcessor", () => {
    it("should process cleanup-expired job and purge expired sessions and idempotency keys", async () => {
      const mockJob = {
        id: 4,
        data: {},
      } as Job;

      const result = await maintenanceProcessor.handleCleanupExpired(mockJob);
      expect(result).toBeDefined();
      expect(result.purgedSessions).toBe(5);
      expect(result.purgedIdempotencyKeys).toBe(3);
      expect(result.purgedChanges).toBe(12);
      expect(prismaService.session.deleteMany).toHaveBeenCalled();
      expect(prismaService.idempotencyKey.deleteMany).toHaveBeenCalled();
      expect(prismaService.change.deleteMany).toHaveBeenCalled();
    });

    it("prunes the whole expired span when no live device is still reading it", async () => {
      await maintenanceProcessor.handleCleanupExpired({ id: 5, data: {} } as Job);

      // The old query was one global `deleteMany({createdAt})`. Per user is what
      // lets the floor below exist at all, since cursors count per user.
      expect(prismaService.change.deleteMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ userId: mockUser.id }),
      });
      const where = prismaService.change.deleteMany.mock.calls[0][0].where;
      expect(where.cursor).toBeUndefined();
    });

    it("stops the prune at the oldest cursor a live device has not pulled", async () => {
      // 52 expired rows, of which the slow device has read up to cursor 40.
      prismaService.change.groupBy.mockResolvedValue([
        { userId: mockUser.id, _count: { _all: 52 } },
      ]);
      prismaService.device.findMany.mockResolvedValue([
        { userId: mockUser.id, syncStates: [{ lastPulledCursor: "40" }] },
        { userId: mockUser.id, syncStates: [{ lastPulledCursor: "900" }] },
      ]);
      prismaService.change.deleteMany.mockResolvedValue({ count: 40 });

      const result = await maintenanceProcessor.handleCleanupExpired({
        id: 6,
        data: {},
      } as Job);

      const where = prismaService.change.deleteMany.mock.calls[0][0].where;
      // The slower of the two devices holds the floor, not the newer.
      expect(where.cursor).toEqual({ lt: BigInt(40) });
      expect(result.purgedChanges).toBe(40);
      expect(result.heldBackForIdleDevices).toBe(12);
    });

    it("leaves the log alone while a live device has never pulled", async () => {
      prismaService.device.findMany.mockResolvedValue([
        { userId: mockUser.id, syncStates: [] },
      ]);
      prismaService.change.deleteMany.mockResolvedValue({ count: 0 });

      const result = await maintenanceProcessor.handleCleanupExpired({
        id: 7,
        data: {},
      } as Job);

      const where = prismaService.change.deleteMany.mock.calls[0][0].where;
      expect(where.cursor).toEqual({ lt: BigInt(0) });
      // The row that would have been deleted is reported rather than dropped:
      // a log that outlives its nominal retention is the signal that somebody
      // is far behind, not a failure of this job.
      expect(result.purgedChanges).toBe(0);
      expect(result.heldBackForIdleDevices).toBe(12);
    });

    it("asks only about devices that can still pull", async () => {
      await maintenanceProcessor.handleCleanupExpired({ id: 8, data: {} } as Job);

      // A revoked device cannot pull again, so leaving it in would pin the log
      // open forever on a checkpoint nobody will ever advance.
      expect(prismaService.device.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            revokedAt: null,
            userId: { in: [mockUser.id] },
          }),
        }),
      );
    });
  });
});
