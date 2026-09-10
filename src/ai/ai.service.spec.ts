import { Test, TestingModule } from "@nestjs/testing";
import { AiService } from "./ai.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import { BadRequestException, NotFoundException } from "@nestjs/common";

describe("AiService", () => {
  let service: AiService;
  let prismaMock: any;
  let configServiceMock: any;

  beforeEach(async () => {
    prismaMock = {
      note: {
        findFirst: jest.fn(),
      },
      task: {
        create: jest.fn(),
      },
      change: {
        create: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return callback(prismaMock);
      }),
    };

    configServiceMock = {
      get: jest.fn().mockReturnValue(undefined), // No Gemini key -> test heuristic fallback
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: configServiceMock },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
  });

  describe("summarize", () => {
    it("should throw BadRequestException if neither text nor noteId is given", async () => {
      await expect(service.summarize("user-1", {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should summarize text using heuristic fallback", async () => {
      const sampleText = `
        Distributed systems require robust tracing and observability to diagnose performance bottlenecks.
        Every request should carry a W3C traceparent header across network hops.
        OpenTelemetry provides a vendor-neutral standard for metrics, logs, and traces.
        Database connection pooling and Redis caching further reduce request latency.
      `;

      const result = await service.summarize("user-1", {
        text: sampleText,
        length: "brief",
        format: "paragraph",
      });

      expect(result).toBeDefined();
      expect(result.provider).toBe("heuristic");
      expect(result.summary.length).toBeGreaterThan(0);
      expect(result.compressionRatio).toBeLessThanOrEqual(1.0);
    });

    it("should retrieve note content and summarize note by noteId", async () => {
      prismaMock.note.findFirst.mockResolvedValue({
        id: "note-1",
        title: "Kubernetes Deployments",
        content:
          "Production clusters require ingress controllers, TLS certificates, and replica sets. Continuous deployment should run health checks after every rollout.",
      });

      const result = await service.summarize("user-1", {
        noteId: "note-1",
        length: "brief",
        format: "bullet_points",
      });

      expect(result).toBeDefined();
      expect(result.summary).toContain("•");
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

    it("should throw NotFoundException if note is not found", async () => {
      prismaMock.note.findFirst.mockResolvedValue(null);

      await expect(
        service.convertTasksForNote("user-1", "missing-note", { tasks: [] }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
