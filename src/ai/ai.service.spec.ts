import { Test, TestingModule } from "@nestjs/testing";
import { AiService } from "./ai.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { SyncNotificationService } from "@/sync/sync-notification.service";

describe("AiService", () => {
  let service: AiService;
  let prismaMock: any;
  let configServiceMock: any;
  /** Env stand-in: an absent key behaves exactly like an unset variable. */
  let env: Record<string, unknown>;
  /** Stands in for the sync wake-up this service owes the other devices. */
  let syncNotificationsMock: { notifyMutation: jest.Mock };
  /** Flipped only once `$transaction` resolves — see the mock below. */
  let transactionSettled: boolean;
  /** For each notice: was the write already committed when it fired? */
  let noticesAfterCommit: boolean[];

  beforeEach(async () => {
    env = {};
    transactionSettled = false;
    noticesAfterCommit = [];

    syncNotificationsMock = {
      notifyMutation: jest.fn(() => {
        noticesAfterCommit.push(transactionSettled);
      }),
    };

    // The converter writes one log row per task it creates, and every row is
    // numbered from this counter — so the mock has to hand out a fresh number
    // and a row, the way the real document and collection do.
    let seq = BigInt(0);
    prismaMock = {
      note: {
        findFirst: jest.fn(),
      },
      task: {
        create: jest.fn(),
      },
      change: {
        create: jest.fn().mockResolvedValue({ id: "change-1" }),
      },
      syncCursor: {
        upsert: jest.fn(async () => ({ seq: ++seq })),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => {
        const outcome = await callback(prismaMock);
        // The real method commits only after the callback resolves, so this is
        // the earliest moment a caller may announce the write.
        transactionSettled = true;
        return outcome;
      }),
    };

    configServiceMock = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key in env ? env[key] : fallback,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: configServiceMock },
        { provide: SyncNotificationService, useValue: syncNotificationsMock },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
  });

  describe("resolveText (encrypted notes check)", () => {
    it("should throw BadRequestException if note is encrypted", async () => {
      prismaMock.note.findFirst.mockResolvedValue({
        id: "enc-note",
        title: "Secret",
        content: "Ciphertext",
        isEncrypted: true,
      });

      await expect(
        service.extractTasks("user-1", { noteId: "enc-note" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException if neither text nor noteId is given", async () => {
      await expect(service.extractTasks("user-1", {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw NotFoundException if noteId does not exist", async () => {
      prismaMock.note.findFirst.mockResolvedValue(null);

      await expect(
        service.extractTasks("user-1", { noteId: "missing-note" }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("extractTasks", () => {
    it("should extract actionable items and assign priorities", async () => {
      const meetingNotes = `
        Sprint Review Notes:
        - [ ] Review security audit checklist before release (urgent)
        TODO: Deploy Redis clustering to staging
        Some regular discussion about UI designs.
        - [ ] Consider adding optional dark mode later
      `;

      const result = await service.extractTasks("user-1", {
        text: meetingNotes,
      });

      expect(result.totalFound).toBe(3);
      expect(result.tasks[0].title).toContain(
        "Review security audit checklist",
      );
      expect(result.tasks[0].priority).toBe("HIGH");
      expect(result.tasks[1].title).toContain("Deploy Redis clustering");
      expect(result.tasks[1].priority).toBe("MEDIUM");
      expect(result.tasks[2].title).toContain(
        "Consider adding optional dark mode",
      );
      expect(result.tasks[2].priority).toBe("LOW");
      expect(result.provider).toBe("heuristic");
    });
  });

  describe("suggestTags", () => {
    it("should extract top terms and identify categories", async () => {
      const content = `
        OAuth2 authentication and JWT token rotation with passkey security.
        Enforce HTTPS and secure cookie handling across all endpoints.
      `;

      const result = await service.suggestTags("user-1", { text: content });

      expect(result.tags.length).toBeGreaterThan(0);
      expect(result.suggestedCategories).toContain("Security");
      expect(result.provider).toBe("heuristic");
    });
  });

  describe("convertTasksForNote", () => {
    it("should convert extracted tasks into Task records in the database", async () => {
      prismaMock.note.findFirst.mockResolvedValue({
        id: "note-10",
        title: "DevOps Checklist",
      });

      prismaMock.task.create.mockResolvedValue({
        id: "task-1",
        title: "Audit IAM roles",
        version: 1,
        priority: "HIGH",
      });

      const response = await service.convertTasksForNote("user-1", "note-10", {
        tasks: [
          {
            title: "Audit IAM roles",
            priority: "HIGH",
          },
        ],
      });

      expect(response.createdCount).toBe(1);
      expect(prismaMock.task.create).toHaveBeenCalled();
      expect(prismaMock.change.create).toHaveBeenCalled();
    });

    it("numbers every task change it logs, not just the first", async () => {
      prismaMock.note.findFirst.mockResolvedValue({
        id: "note-10",
        title: "DevOps Checklist",
      });
      prismaMock.task.create.mockResolvedValue({
        id: "task-1",
        title: "Audit IAM roles",
        version: 1,
        priority: "HIGH",
      });

      // One call, two tasks, two rows: this is the only module that logs inside
      // a loop, so it is where a shared cursor could have been handed out once
      // and reused. Two rows on one cursor are pulled as one — the second is
      // skipped for good, and nothing on the read path says so.
      await service.convertTasksForNote("user-1", "note-10", {
        tasks: [{ title: "Audit IAM roles" }, { title: "Rotate the JWT keys" }],
      });

      const cursors = prismaMock.change.create.mock.calls.map(
        ([arg]: any[]) => arg.data.cursor,
      );
      expect(cursors).toEqual([BigInt(1), BigInt(2)]);
    });

    it("wakes the other devices once, naming the end of the log it wrote", async () => {
      prismaMock.note.findFirst.mockResolvedValue({
        id: "note-10",
        title: "DevOps Checklist",
      });
      prismaMock.task.create.mockResolvedValue({
        id: "task-1",
        title: "Audit IAM roles",
        version: 1,
        priority: "HIGH",
      });

      await service.convertTasksForNote("user-1", "note-10", {
        tasks: [{ title: "Audit IAM roles" }, { title: "Rotate the JWT keys" }],
      });

      // One notice for the whole loop, carrying the highest cursor of the two
      // rows: a device pulls everything above its own checkpoint, so a notice
      // per task would be two wake-ups and one identical pull.
      expect(syncNotificationsMock.notifyMutation).toHaveBeenCalledTimes(1);
      expect(syncNotificationsMock.notifyMutation).toHaveBeenCalledWith({
        userId: "user-1",
        highestCursor: BigInt(2),
      });
    });

    it("announces the write only after the transaction commits", async () => {
      prismaMock.note.findFirst.mockResolvedValue({
        id: "note-10",
        title: "DevOps Checklist",
      });
      prismaMock.task.create.mockResolvedValue({
        id: "task-1",
        title: "Audit IAM roles",
        version: 1,
        priority: "HIGH",
      });

      await service.convertTasksForNote("user-1", "note-10", {
        tasks: [{ title: "Audit IAM roles" }],
      });

      // A notice fired inside the transaction announces rows a rollback then
      // removes: every other device pulls, finds nothing, and the signal was a
      // lie. This is the ordering the REST write paths all sit on.
      expect(noticesAfterCommit).toEqual([true]);
    });

    it("stays silent when the request converted nothing", async () => {
      prismaMock.note.findFirst.mockResolvedValue({
        id: "note-10",
        title: "DevOps Checklist",
      });

      // `tasks: []` clears the DTO's validation, so this is reachable input
      // rather than a hypothetical.
      await service.convertTasksForNote("user-1", "note-10", { tasks: [] });

      expect(syncNotificationsMock.notifyMutation).not.toHaveBeenCalled();
    });

    it("should throw NotFoundException if note is not found", async () => {
      prismaMock.note.findFirst.mockResolvedValue(null);

      await expect(
        service.convertTasksForNote("user-1", "missing-note", { tasks: [] }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
