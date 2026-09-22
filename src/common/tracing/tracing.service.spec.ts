import { Test, TestingModule } from "@nestjs/testing";
import { TracingService } from "./tracing.service";
import { TracingInterceptor } from "./tracing.interceptor";
import {
  generateTraceId,
  generateSpanId,
  parseTraceParent,
  formatTraceParent,
} from "./tracing.interface";
import { of, throwError } from "rxjs";

describe("Distributed Tracing & W3C TraceContext", () => {
  let service: TracingService;
  let interceptor: TracingInterceptor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TracingService, TracingInterceptor],
    }).compile();

    service = module.get<TracingService>(TracingService);
    interceptor = module.get<TracingInterceptor>(TracingInterceptor);
  });

  describe("W3C TraceContext Utilities", () => {
    it("should generate valid 32-char hex trace IDs and 16-char hex span IDs", () => {
      const traceId = generateTraceId();
      const spanId = generateSpanId();

      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    });

    it("should correctly parse valid W3C traceparent headers", () => {
      const validHeader =
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
      const parsed = parseTraceParent(validHeader);

      expect(parsed).not.toBeNull();
      expect(parsed?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(parsed?.parentSpanId).toBe("00f067aa0ba902b7");
      expect(parsed?.sampled).toBe(true);
    });

    it("should reject invalid traceparent headers", () => {
      expect(parseTraceParent("")).toBeNull();
      expect(parseTraceParent("invalid")).toBeNull();
      expect(parseTraceParent("01-short-short-00")).toBeNull();
      // All zeroes trace ID is invalid per W3C spec
      expect(
        parseTraceParent(
          "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        ),
      ).toBeNull();
    });

    it("should format valid W3C traceparent headers", () => {
      const formatted = formatTraceParent("trace123", "span456", "01");
      expect(formatted).toBe("00-trace123-span456-01");
    });
  });

  describe("TracingService Context Propagation", () => {
    it("should preserve trace context across asynchronous execution", async () => {
      const context = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
      };

      expect(service.getCurrentTraceId()).toBeUndefined();

      await service.runWithContext(context, async () => {
        expect(service.getCurrentTraceId()).toBe(
          "4bf92f3577b34da6a3ce929d0e0e4736",
        );
        expect(service.getCurrentSpanId()).toBe("00f067aa0ba902b7");

        // Nested async delay
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(service.getCurrentTraceId()).toBe(
          "4bf92f3577b34da6a3ce929d0e0e4736",
        );
      });

      expect(service.getCurrentTraceId()).toBeUndefined();
    });

    it("should track span lifecycle with withSpan", async () => {
      let exportedSpan: any;
      service.setExporter((span) => {
        exportedSpan = span;
      });

      const result = await service.withSpan("database.query", async (span) => {
        span.attributes["db.statement"] = "SELECT * FROM users";
        return 42;
      });

      expect(result).toBe(42);
      expect(exportedSpan).toBeDefined();
      expect(exportedSpan.name).toBe("database.query");
      expect(exportedSpan.status).toBe("OK");
      expect(exportedSpan.durationMs).toBeGreaterThanOrEqual(0);
      expect(exportedSpan.attributes["db.statement"]).toBe(
        "SELECT * FROM users",
      );
    });

    it("should record error status when withSpan throws", async () => {
      let exportedSpan: any;
      service.setExporter((span) => {
        exportedSpan = span;
      });

      await expect(
        service.withSpan("failing.operation", async () => {
          throw new Error("Simulated failure");
        }),
      ).rejects.toThrow("Simulated failure");

      expect(exportedSpan).toBeDefined();
      expect(exportedSpan.status).toBe("ERROR");
      expect(exportedSpan.error).toBeDefined();
    });
  });

  describe("TracingInterceptor", () => {
    it("should inject trace headers and complete span on successful request", async () => {
      const headersSet: Record<string, string> = {};
      const mockReq: any = {
        method: "GET",
        url: "/health",
        headers: {},
        ip: "127.0.0.1",
      };
      const mockRes: any = {
        statusCode: 200,
        setHeader: (name: string, value: string) => {
          headersSet[name] = value;
        },
      };
      const mockContext: any = {
        getType: () => "http",
        switchToHttp: () => ({
          getRequest: () => mockReq,
          getResponse: () => mockRes,
        }),
      };
      const mockCallHandler: any = {
        handle: () => of({ status: "ok" }),
      };

      const observable = interceptor.intercept(mockContext, mockCallHandler);
      await new Promise<void>((resolve) => {
        observable.subscribe({
          next: () => {},
          complete: () => resolve(),
        });
      });

      expect(headersSet["X-Trace-ID"]).toBeDefined();
      expect(headersSet["X-Trace-ID"]).toMatch(/^[0-9a-f]{32}$/);
      expect(headersSet["traceparent"]).toBeDefined();
      expect(headersSet["traceparent"]).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
      );
    });

    it("should handle request failure and attach error details", async () => {
      const headersSet: Record<string, string> = {};
      const mockReq: any = {
        method: "POST",
        url: "/api/fail",
        headers: {},
      };
      const mockRes: any = {
        statusCode: 500,
        setHeader: (name: string, value: string) => {
          headersSet[name] = value;
        },
      };
      const mockContext: any = {
        getType: () => "http",
        switchToHttp: () => ({
          getRequest: () => mockReq,
          getResponse: () => mockRes,
        }),
      };
      const mockCallHandler: any = {
        handle: () => throwError(() => new Error("Internal Server Error")),
      };

      const observable = interceptor.intercept(mockContext, mockCallHandler);
      await new Promise<void>((resolve) => {
        observable.subscribe({
          error: () => resolve(),
        });
      });

      expect(headersSet["X-Trace-ID"]).toBeDefined();
    });
  });
});
