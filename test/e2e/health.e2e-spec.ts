import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { HealthController } from "@/health/health.controller";
import { HealthService } from "@/health/health.service";
import { AppController } from "@/app/app.controller";
import { AppService } from "@/app/app.service";
import { TracingModule } from "@/common/tracing/tracing.module";
import { TracingInterceptor } from "@/common/tracing/tracing.interceptor";
import { ErrorHandlingModule } from "@/common/error-handling/error-handling.module";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";

describe("Health & System Telemetry (E2E)", () => {
  let app: INestApplication;
  let healthServiceMock: any;

  beforeAll(async () => {
    healthServiceMock = {
      checkTerminusHealth: jest.fn().mockResolvedValue({
        status: "ok",
        info: {
          database: { status: "up", latency: 4 },
          redis: { status: "up" },
        },
        error: {},
        details: {
          database: { status: "up", latency: 4 },
          redis: { status: "up" },
        },
      }),
      getInfo: jest.fn().mockReturnValue({
        name: "allinone-backend",
        version: "0.1.0",
        environment: "test",
        uptime: 123,
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TracingModule, ErrorHandlingModule],
      controllers: [AppController, HealthController],
      providers: [
        AppService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === "APP_ENV" ? "test" : undefined),
          },
        },
        { provide: HealthService, useValue: healthServiceMock },
        { provide: APP_INTERCEPTOR, useClass: TracingInterceptor },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /", () => {
    it("should return root application information and correlation headers", async () => {
      const response = await request(app.getHttpServer()).get("/").expect(200);

      expect(response.body).toBeDefined();
      expect(response.headers["x-trace-id"]).toMatch(/^[0-9a-f]{32}$/);
      expect(response.headers["traceparent"]).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
      );
    });
  });

  describe("GET /health", () => {
    it("should return 200 with canonical Terminus health payload", async () => {
      const response = await request(app.getHttpServer())
        .get("/health")
        .expect(200);

      expect(response.body.status).toBe("ok");
      expect(response.body.info.database.status).toBe("up");
      expect(response.body.info.redis.status).toBe("up");
      expect(response.headers["x-trace-id"]).toBeDefined();
    });

    it("should return 503 when critical subsystem reports degraded health", async () => {
      healthServiceMock.checkTerminusHealth.mockResolvedValueOnce({
        status: "error",
        info: {},
        error: { database: { status: "down", error: "Connection refused" } },
        details: { database: { status: "down", error: "Connection refused" } },
      });

      const response = await request(app.getHttpServer())
        .get("/health")
        .expect(503);

      expect(response.body.status).toBe("error");
      expect(response.body.error.database.status).toBe("down");
    });
  });

  describe("GET /health/live", () => {
    it("should return 200 with process liveness status", async () => {
      const response = await request(app.getHttpServer())
        .get("/health/live")
        .expect(200);

      expect(response.body).toEqual({ status: "ok" });
    });
  });

  describe("GET /info", () => {
    it("should return 200 with static build and runtime metadata", async () => {
      const response = await request(app.getHttpServer())
        .get("/info")
        .expect(200);

      expect(response.body.name).toBe("Allinone Backend");
      expect(response.body.version).toBe("1.0.0");
    });
  });

  describe("Distributed TraceContext Ingestion & Propagation", () => {
    it("should propagate incoming W3C traceparent header to response", async () => {
      const inboundTrace =
        "00-e8b28014e3654d0d82914ff0e6e736e4-00f067aa0ba902b7-01";

      const response = await request(app.getHttpServer())
        .get("/health/live")
        .set("traceparent", inboundTrace)
        .expect(200);

      expect(response.headers["x-trace-id"]).toBe(
        "e8b28014e3654d0d82914ff0e6e736e4",
      );
      expect(response.headers["traceparent"]).toContain(
        "e8b28014e3654d0d82914ff0e6e736e4",
      );
    });
  });
});
