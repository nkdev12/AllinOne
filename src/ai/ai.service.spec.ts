import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { AiService } from "./ai.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { GeminiClient } from "./gemini.client";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import {
  GEMINI_TRUNCATION_MARKER,
  MAX_GEMINI_PROMPT_CHARS,
} from "./gemini.client";

/**
 * The stubbed upstream key for this whole file. Deliberately odd-looking, so an
 * assertion proving it stayed out of a URL, an error or a log line can only
 * pass for the right reason.
 */
const TEST_API_KEY = "AIzaTEST-key-must-never-appear-in-a-url";

/** Pinned input for the deterministic heuristic — see "byte-for-byte" below. */
const OBSERVABILITY_NOTES = `
        Distributed systems require robust tracing and observability to diagnose performance bottlenecks.
        Every request should carry a W3C traceparent header across network hops.
        OpenTelemetry provides a vendor-neutral standard for metrics, logs, and traces.
        Database connection pooling and Redis caching further reduce request latency.
      `;

/**
 * A `fetch` stand-in that behaves the way undici does when an abort deadline
 * fires: it never settles on its own, it rejects with the signal's reason.
 */
function stalledFetch(): (init: any) => Promise<any> {
  return (init: any) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(init.signal.reason ?? new Error("aborted without a reason"));
      });
    });
}

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
      // Nothing configured by default — no Gemini key — so every test that was
      // already here keeps exercising the heuristic path it was written for.
      get: jest.fn((key: string, fallback?: unknown) =>
        key in env ? env[key] : fallback,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        GeminiClient,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: configServiceMock },
        { provide: SyncNotificationService, useValue: syncNotificationsMock },
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
      const result = await service.summarize("user-1", {
        text: OBSERVABILITY_NOTES,
        length: "brief",
        format: "paragraph",
      });

      expect(result).toBeDefined();
      expect(result.provider).toBe("heuristic");
      expect(result.summary.length).toBeGreaterThan(0);
      expect(result.compressionRatio).toBeLessThanOrEqual(1.0);
    });

    it("keeps the heuristic summarizer byte-for-byte stable", async () => {
      // This is what the Flutter client renders whenever no provider key is
      // configured — which is every deployment today. Sentence scoring, the
      // 1.5/1.2/1.0 position weights, the top-2/5/3 selection and the re-sort
      // back into document order are all load-bearing, so the exact text plus
      // every derived length is pinned here instead of as "it gave something".
      const paragraph = await service.summarize("user-1", {
        text: OBSERVABILITY_NOTES,
        length: "brief",
        format: "paragraph",
      });

      expect(paragraph).toEqual({
        summary:
          "Distributed systems require robust tracing and observability to diagnose performance bottlenecks. Every request should carry a W3C traceparent header across network hops.",
        originalLength: 352,
        summaryLength: 170,
        compressionRatio: 0.48,
        format: "paragraph",
        provider: "heuristic",
      });

      const bullets = await service.summarize("user-1", {
        text: OBSERVABILITY_NOTES,
        length: "bullet_points",
        format: "bullet_points",
      });

      expect(bullets).toEqual({
        summary:
          "• Distributed systems require robust tracing and observability to diagnose performance bottlenecks.\n" +
          "• Every request should carry a W3C traceparent header across network hops.\n" +
          "• OpenTelemetry provides a vendor-neutral standard for metrics, logs, and traces.",
        originalLength: 352,
        summaryLength: 256,
        compressionRatio: 0.73,
        format: "bullet_points",
        provider: "heuristic",
      });

      // Same input, same answer: no hidden state, no clock, no randomness.
      await expect(
        service.summarize("user-1", {
          text: OBSERVABILITY_NOTES,
          length: "brief",
          format: "paragraph",
        }),
      ).resolves.toEqual(paragraph);
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

  describe("summarize with a configured Gemini provider", () => {
    let fetchMock: jest.Mock;
    let warnSpy: jest.SpyInstance;

    /** The single `{ url, headers, prompt, signal }` handed to fetch. */
    const sentRequest = () => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      return {
        url: url as string,
        headers: (init as any).headers as Record<string, string>,
        prompt: JSON.parse((init as any).body).contents[0].parts[0]
          .text as string,
        signal: (init as any).signal as AbortSignal | undefined,
      };
    };

    const okWith = (text: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    });

    beforeEach(() => {
      env.GEMINI_API_KEY = TEST_API_KEY;
      fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
    });

    afterEach(() => {
      delete (global as any).fetch;
      warnSpy.mockRestore();
    });

    it("carries the key in the x-goog-api-key header, never in the URL", async () => {
      fetchMock.mockResolvedValue(
        okWith("Tracing is how you find bottlenecks."),
      );

      const result = await service.summarize("user-1", {
        text: OBSERVABILITY_NOTES,
      });

      const { url, headers } = sentRequest();
      // The regression guard for the old `?key=${apiKey}` request: a URL is
      // echoed into proxy access logs and into error text, so the secret has
      // to stay out of it entirely.
      expect(url).not.toContain("key=");
      expect(url).not.toContain(TEST_API_KEY);
      expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
      );
      expect(headers["x-goog-api-key"]).toBe(TEST_API_KEY);
      expect(headers["Content-Type"]).toBe("application/json");
      expect(result.provider).toBe("gemini");
      expect(result.summary).toBe("Tracing is how you find bottlenecks.");
    });

    it("takes the model name from GEMINI_MODEL, with the shipped value as fallback", async () => {
      env.GEMINI_MODEL = "gemini-2.5-flash";
      fetchMock.mockResolvedValue(okWith("Summarized."));

      await service.summarize("user-1", { text: OBSERVABILITY_NOTES });
      expect(sentRequest().url).toContain(
        "/v1beta/models/gemini-2.5-flash:generateContent",
      );

      delete env.GEMINI_MODEL;
      fetchMock.mockClear();
      await service.summarize("user-1", { text: OBSERVABILITY_NOTES });
      expect(sentRequest().url).toContain(
        "/v1beta/models/gemini-1.5-flash:generateContent",
      );
    });

    it("bounds the call with an abort deadline", async () => {
      env.GEMINI_TIMEOUT_MS = "1500";
      fetchMock.mockResolvedValue(okWith("Summarized."));

      await service.summarize("user-1", { text: OBSERVABILITY_NOTES });

      const { signal } = sentRequest();
      expect(signal).toBeDefined();
      expect(typeof signal!.aborted).toBe("boolean");
    });

    it("truncates an over-long note instead of putting it all on the wire", async () => {
      fetchMock.mockResolvedValue(okWith("Summarized head only."));
      const tail = "TAIL-SENTINEL-THAT-MUST-NOT-BE-SENT";
      const content = `${"alpha bravo charlie delta ".repeat(600)}${tail}`;
      expect(content.length).toBeGreaterThan(MAX_GEMINI_PROMPT_CHARS);

      const result = await service.summarize("user-1", { text: content });
      const { prompt } = sentRequest();

      expect(prompt.length).toBeLessThanOrEqual(MAX_GEMINI_PROMPT_CHARS);
      expect(prompt).toContain(GEMINI_TRUNCATION_MARKER);
      expect(prompt).not.toContain(tail);
      // The cap bounds what Google sees, not what the caller sent: the lengths
      // in the response still describe the whole note.
      expect(result.originalLength).toBe(content.trim().length);
      expect(result.provider).toBe("gemini");
    });

    it("falls back to the heuristic on a non-2xx answer, without leaking the key", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: { message: "backend unavailable" } }),
      });

      const result = await service.summarize("user-1", {
        text: OBSERVABILITY_NOTES,
      });

      expect(result.provider).toBe("heuristic");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = String(warnSpy.mock.calls[0][0]);
      expect(logged).not.toContain(TEST_API_KEY);
      expect(logged).toContain("Gemini API call failed");
    });

    it("falls back to the heuristic when fetch throws a network error", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));

      const result = await service.summarize("user-1", {
        text: OBSERVABILITY_NOTES,
      });

      expect(result.provider).toBe("heuristic");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("falls back to the heuristic when the deadline fires", async () => {
      env.GEMINI_TIMEOUT_MS = "5";
      fetchMock.mockImplementation(stalledFetch());

      const result = await service.summarize("user-1", {
        text: OBSERVABILITY_NOTES,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.provider).toBe("heuristic");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).not.toContain(TEST_API_KEY);
    });

    it("falls back to the heuristic when Google returns no text", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [] }),
      });

      const result = await service.summarize("user-1", {
        text: OBSERVABILITY_NOTES,
      });

      expect(result.provider).toBe("heuristic");
    });

    it.each([
      ["unset", undefined],
      ["empty", ""],
      ["blank", "   "],
    ])(
      "skips the remote call entirely when GEMINI_API_KEY is %s",
      async (_label, raw) => {
        if (raw === undefined) {
          delete env.GEMINI_API_KEY;
        } else {
          env.GEMINI_API_KEY = raw;
        }

        const result = await service.summarize("user-1", {
          text: OBSERVABILITY_NOTES,
        });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
        expect(result.provider).toBe("heuristic");
      },
    );
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

    it("reports heuristic even with a Gemini key configured", async () => {
      // There is no remote path here, so `provider` has to read heuristic
      // whatever the environment says. Wiring one up is a budget decision.
      env.GEMINI_API_KEY = TEST_API_KEY;
      const fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await service.extractTasks("user-1", {
        text: "TODO: Deploy Redis clustering to staging",
      });

      expect(result.provider).toBe("heuristic");
      expect(fetchMock).not.toHaveBeenCalled();
      delete (global as any).fetch;
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

    it("reports heuristic even with a Gemini key configured", async () => {
      env.GEMINI_API_KEY = TEST_API_KEY;
      const fetchMock = jest.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await service.suggestTags("user-1", {
        text: "Kubernetes ingress and TLS certificates",
      });

      expect(result.provider).toBe("heuristic");
      expect(fetchMock).not.toHaveBeenCalled();
      delete (global as any).fetch;
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
