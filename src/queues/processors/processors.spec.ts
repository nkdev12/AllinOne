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
      },
      user: {
        findUnique: jest.fn().mockResolvedValue(mockUser),
      },
    };

    mailService = {
      sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
      sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
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
          token: "67890",
        } as SendPasswordResetEmailJobData,
      } as Job<SendPasswordResetEmailJobData>;

      const result = await mailProcessor.handleSendPasswordResetEmail(mockJob);
      expect(result).toBeDefined();
      expect(mailService.sendPasswordResetEmail).toHaveBeenCalledWith(
        "test@example.com",
        "67890",
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
  });
});
