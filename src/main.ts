import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { Logger } from "@nestjs/common";
import helmet from "helmet";
import { AppModule } from "./app/app.module";
import { ConfigService } from "@nestjs/config";
import { createValidationPipe } from "./common/errors/validation.pipe";
import { SyncIoAdapter } from "./sync/adapters/sync-io.adapter";

const PRODUCTION_WEB_ORIGINS = [
  "https://allmynote-frontend.nkdev12.workers.dev",
];

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ["log", "error", "warn", "debug", "verbose"],
  });

  const configService = app.get(ConfigService);
  const logger = new Logger("Bootstrap");
  const environment = configService.get<string>("APP_ENV", "development");

  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set("trust proxy", 1);

  // ========================================================================
  // Security (Helmet & CORS)
  // ========================================================================
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "ws:", "wss:"],
        },
      },
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    }),
  );
  const corsOriginConfig = configService.get<string>("CORS_ORIGIN", "");
  const corsOriginsConfig = configService.get<string>("CORS_ORIGINS", "");

  const explicitAllowedOrigins = [corsOriginConfig, corsOriginsConfig]
    .flatMap((val) => val.split(","))
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  const allowsWildcard =
    corsOriginConfig === "*" ||
    corsOriginsConfig === "*" ||
    explicitAllowedOrigins.includes("*");

  const allowedOrigins = new Set([
    ...(explicitAllowedOrigins.length > 0
      ? explicitAllowedOrigins
      : ["http://localhost:3000", "https://allmynote-frontend.nkdev12.workers.dev"]),
    ...PRODUCTION_WEB_ORIGINS,
  ]);

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Native clients, curl and server-to-server requests have no Origin.
      // A literal `null` origin is an opaque browser context and must not bypass
      // the configured browser allow-list.
      if (!origin) {
        return callback(null, true);
      }
      if (origin === "null") {
        return callback(null, false);
      }

      // A wildcard is an explicit operator choice. It never enables browser
      // credentials, otherwise any site could make authenticated cookie calls.
      if (allowsWildcard) {
        return callback(null, true);
      }

      // Local Flutter web builds can choose a port dynamically only when an
      // operator explicitly opts in; a development environment label is not
      // sufficient to widen a deployed API.
      if (
        configService.get<boolean>("ALLOW_LOCALHOST_CORS", false) &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ) {
        return callback(null, true);
      }

      const normalizedOrigin = origin.replace(/\/+$/, "");
      if (allowedOrigins.has(normalizedOrigin)) {
        return callback(null, true);
      }

      logger.warn(`[CORS] Blocked request from disallowed origin: ${origin}`);
      return callback(null, false);
    },
    credentials: !allowsWildcard,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Request-ID",
      "X-Trace-ID",
      "traceparent",
      "tracestate",
      "x-client-version",
      "x-device-id",
      "X-Client-Version",
      "X-Device-Id",
      "Accept",
      "Origin",
      "User-Agent",
      "Cache-Control",
      "Pragma",
    ],
    exposedHeaders: [
      "X-Request-ID",
      "X-Trace-ID",
      "traceparent",
      "x-client-version",
      "x-device-id",
    ],
    maxAge: 86400,
  });

  // ========================================================================
  // Global middleware and pipes
  // ========================================================================
  app.useGlobalPipes(createValidationPipe());

  // ========================================================================
  // OpenAPI/Swagger Documentation
  // ========================================================================
  if (configService.get<boolean>("SWAGGER_ENABLED", false)) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("Allinone Backend API")
      .setDescription(
        "Production-grade backend for Allinone - cross-platform personal information management",
      )
      .setVersion("1.0.0")
      .addBearerAuth(
        { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        "access-token",
      )
      .addTag("Health", "System health and status endpoints")
      .addTag("Auth", "Authentication endpoints")
      .addTag("Users", "User management endpoints")
      .addTag("Devices", "Device management endpoints")
      .addTag("Sync", "Synchronization endpoints")
      .addTag("Notes", "Notes, folders, and tags management")
      .addTag("Tasks", "Tasks, projects, sections, and reminders")
      .addTag("Calendar", "Calendars and events management")
      .addTag("Vault", "Zero-knowledge encrypted password and secret vault")
      .addTag("Admin", "Operational administration and incident response")
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup("api", app, document, {
      swaggerOptions: {
        persistAuthorization: false,
        docExpansion: "list",
      },
    });
  }

  // ========================================================================
  // WebSocket adapter (CORS + clustering) for the /sync namespace
  // ========================================================================
  // Must be installed before listen(): Nest binds every gateway to the adapter
  // that is configured at that moment, and the namespace's origin policy is
  // decided when its Socket.IO server is built — which is why it is not a
  // `@WebSocketGateway` option (decorator metadata cannot see injected config).
  // One adapter does both jobs: Redis rooms when `REDIS_URL` is configured and
  // reachable, in-memory otherwise.
  app.useWebSocketAdapter(await SyncIoAdapter.fromConfig(app, configService));

  // ========================================================================
  // Start server
  // ========================================================================
  // Container stop sends SIGTERM; without this the Nest lifecycle never runs,
  // so PrismaService.$disconnect() and RedisThrottlerStorage's teardown (both
  // OnModuleDestroy) would be skipped and connections dropped mid-flight.
  // Must be registered before listen() so the hooks exist once requests flow.
  app.enableShutdownHooks();

  const port =
    Number(process.env.PORT) || configService.get<number>("APP_PORT", 3000);
  await app.listen(port, "0.0.0.0");

  logger.log(`🚀 Allinone Backend started on http://localhost:${port}`);
  logger.log(`📚 API Documentation: http://localhost:${port}/api`);
  logger.log(`Environment: ${environment}`);
  const dbUrl = configService.get<string>("DATABASE_URL", "");
  logger.log(`Database: ${dbUrl?.split("@").pop() || "not configured"}`);
}

bootstrap().catch((error) => {
  console.error("Failed to start application:", error);
  process.exit(1);
});
