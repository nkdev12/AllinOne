import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { ValidationPipe, Logger } from "@nestjs/common";
import helmet from "helmet";
import { AppModule } from "./app/app.module";
import { ConfigService } from "@nestjs/config";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ["log", "error", "warn", "debug", "verbose"],
  });

  const configService = app.get(ConfigService);
  const logger = new Logger("Bootstrap");

  // ========================================================================
  // Security (Helmet & CORS)
  // ========================================================================
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "ws:", "wss:"],
        },
      },
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    }),
  );
  app.enableCors({
    origin: configService.get<string>("CORS_ORIGIN", "http://localhost:3000"),
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Request-ID",
      "X-Trace-ID",
      "traceparent",
      "tracestate",
    ],
    exposedHeaders: ["X-Request-ID", "X-Trace-ID", "traceparent"],
  });

  // ========================================================================
  // Global middleware and pipes
  // ========================================================================
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // ========================================================================
  // OpenAPI/Swagger Documentation
  // ========================================================================
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
      persistAuthorization: true,
      docExpansion: "list",
    },
  });

  // ========================================================================
  // Start server
  // ========================================================================
  const port = configService.get<number>("APP_PORT", 3000);
  const environment = configService.get<string>("APP_ENV", "development");

  await app.listen(port, "0.0.0.0");

  logger.log(`🚀 Allinone Backend started on http://localhost:${port}`);
  logger.log(`📚 API Documentation: http://localhost:${port}/api`);
  logger.log(`Environment: ${environment}`);
  logger.log(`Database: ${configService.get("DATABASE_URL")?.split("@")[1]}`);
}

bootstrap().catch((error) => {
  console.error("Failed to start application:", error);
  process.exit(1);
});
