import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import * as Joi from "joi";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { ConfigurationModule } from "@/config/configuration.module";
import { ConfigurationService } from "@/config/configuration.service";
import { LoggingModule } from "@/common/logging/logging.module";
import { HealthModule } from "@/health/health.module";
import { UsersModule } from "@/users/users.module";
import { AuthModule } from "@/auth/auth.module";
import { DevicesModule } from "@/devices/devices.module";
import { SyncModule } from "@/sync/sync.module";
import { NotesModule } from "@/notes/notes.module";
import { TasksModule } from "@/tasks/tasks.module";
import { CalendarModule } from "@/calendar/calendar.module";
import { VaultModule } from "@/vault/vault.module";
import { AdminModule } from "@/admin/admin.module";
import { CollaborationModule } from "@/collaboration/collaboration.module";
import { AiModule } from "@/ai/ai.module";
import { PasskeysModule } from "@/auth/passkeys/passkeys.module";
import { ErrorHandlingModule } from "@/common/error-handling/error-handling.module";
import { AuditLogModule } from "@/common/audit/audit-log.module";
import { MetricsModule } from "@/common/metrics/metrics.module";
import { MetricsInterceptor } from "@/common/metrics/metrics.interceptor";
import { CustomThrottlerGuard } from "@/common/guards/custom-throttler.guard";
import { IdempotencyInterceptor } from "@/common/interceptors/idempotency.interceptor";
import { TracingModule } from "@/common/tracing/tracing.module";
import { TracingInterceptor } from "@/common/tracing/tracing.interceptor";

@Module({
  imports: [
    // ====================================================================
    // Environment Configuration
    // ====================================================================
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
      validationSchema: Joi.object({
        // App
        APP_ENV: Joi.string()
          .valid("development", "staging", "production")
          .default("development"),
        APP_PORT: Joi.number().default(3000),
        APP_URL: Joi.string().default("http://localhost:3000"),
        NODE_ENV: Joi.string()
          .valid("development", "production")
          .default("development"),
        LOG_LEVEL: Joi.string().default("debug"),

        // Database
        DATABASE_URL: Joi.string().required(),

        // Email (SMTP — required so OTP / password-reset mails can be sent)
        SMTP_HOST: Joi.string().required(),
        SMTP_PORT: Joi.number().default(587),
        SMTP_USER: Joi.string().allow("").optional(),
        SMTP_PASSWORD: Joi.string().allow("").optional(),
        SMTP_FROM: Joi.string().required(),
        SMTP_TLS: Joi.boolean().default(true),
        EMAIL_VERIFY_ENABLED: Joi.boolean().default(false),
        EMAIL_VERIFY_TOKEN_EXPIRY: Joi.string().default("24h"),

        // Redis

        // JWT
        JWT_ACCESS_SECRET: Joi.string().required(),
        JWT_ACCESS_EXPIRATION: Joi.string().default("15m"),
        JWT_REFRESH_SECRET: Joi.string().required(),
        JWT_REFRESH_EXPIRATION: Joi.string().default("7d"),
        JWT_MFA_SECRET: Joi.string().allow("").optional(),

        // OAuth Providers
        OAUTH_GOOGLE_CLIENT_ID: Joi.string().allow("").optional(),
        OAUTH_APPLE_CLIENT_ID: Joi.string().allow("").optional(),
        OAUTH_MICROSOFT_CLIENT_ID: Joi.string().allow("").optional(),
        GOOGLE_CLIENT_ID: Joi.string().allow("").optional(),
        APPLE_CLIENT_ID: Joi.string().allow("").optional(),
        MICROSOFT_CLIENT_ID: Joi.string().allow("").optional(),

        // Admin access (AdminGuard). Optional and with NO default on purpose:
        // unset or empty means the corresponding admit path is closed, so a
        // deployment that never provisions these simply has no admin API.
        // ConfigurationService enforces the ADMIN_SECRET length floor.
        ADMIN_EMAILS: Joi.string().allow("").optional(),
        ADMIN_USER_IDS: Joi.string().allow("").optional(),
        ADMIN_SECRET: Joi.string().allow("").optional(),

        // Cross-origin policy. `CORS_ORIGIN` answers the HTTP app's
        // `enableCors()`; the `WS_*` keys answer the `/sync` namespace, which
        // `SyncIoAdapter` builds from configuration at boot
        // (`src/sync/adapters/sync-io.adapter.ts`). Declared so the surface
        // exists in the same place the other transport settings do — the real
        // documentation is `.env.example`, since `allowUnknown` means a typo
        // here is not what catches it.
        //
        // `WS_CORS_ALLOW_NULL_ORIGIN` and `WS_REDIS_ADAPTER` stay strings
        // rather than `Joi.boolean()` because the adapter parses the truthy
        // spellings itself (`true`/`1`/`yes`/`on`) and a boolean here would
        // reject values the code supports.
        CORS_ORIGIN: Joi.string().allow("").optional(),
        WS_CORS_ORIGINS: Joi.string().allow("").optional(),
        WS_CORS_ALLOW_NULL_ORIGIN: Joi.string().allow("").optional(),
        WS_REDIS_ADAPTER: Joi.string().allow("").optional(),

        // AI summarization (Google Gemini). Optional and opt-in like the admin
        // keys: a missing or blank GEMINI_API_KEY leaves AiService on its
        // deterministic heuristics and no request is ever sent. The model and
        // timeout defaults mirror src/ai/gemini.client.ts, which still re-checks
        // each value itself, so a blank or non-positive setting cannot break it.
        GEMINI_API_KEY: Joi.string().allow("").optional(),
        GEMINI_MODEL: Joi.string().default("gemini-1.5-flash"),
        GEMINI_TIMEOUT_MS: Joi.number().default(5000),

        // Object Storage
        OBJECT_STORAGE_ENDPOINT: Joi.string().required(),
        OBJECT_STORAGE_REGION: Joi.string().default("us-east-1"),
        OBJECT_STORAGE_BUCKET: Joi.string().required(),
        OBJECT_STORAGE_ACCESS_KEY: Joi.string().required(),
        OBJECT_STORAGE_SECRET_KEY: Joi.string().required(),
        OBJECT_STORAGE_USE_SSL: Joi.boolean().default(false),

        // Encryption
        ENCRYPTION_KEY: Joi.string().min(32).required(),

        // Rate Limiting
        RATE_LIMIT_WINDOW_MS: Joi.number().default(60000),
        RATE_LIMIT_MAX_REQUESTS: Joi.number().default(100),

        // Logging
        LOG_FORMAT: Joi.string().valid("json", "simple").default("json"),
        LOG_OUTPUT: Joi.string().default("console"),

        // Monitoring
        METRICS_ENABLED: Joi.boolean().default(true),
        PROMETHEUS_PORT: Joi.number().default(9090),

        // OpenTelemetry
        OTEL_ENABLED: Joi.boolean().default(false),
        OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().optional(),

        // Backup
        BACKUP_ENABLED: Joi.boolean().default(true),
        BACKUP_SCHEDULE: Joi.string().default("0 2 * * *"),
        BACKUP_RETENTION_DAYS: Joi.number().default(30),
      }),
      validationOptions: {
        abortEarly: true,
      },
    }),

    // ====================================================================
    // Core Modules
    // ====================================================================
    ConfigurationModule,
    LoggingModule,
    PrismaModule,
    TracingModule,
    ErrorHandlingModule,
    AuditLogModule,
    MetricsModule,

    // ====================================================================
    // Rate Limiting Module
    // ====================================================================
    ThrottlerModule.forRootAsync({
      imports: [ConfigurationModule],
      inject: [ConfigurationService],
      useFactory: (config: ConfigurationService) => ({
        throttlers: [
          {
            ttl: config.rateLimitWindowMs,
            limit: config.rateLimitMaxRequests,
          },
        ],
      }),
    }),

    // ====================================================================
    // Feature Modules
    // ====================================================================
    HealthModule,
    UsersModule,
    AuthModule,
    PasskeysModule,
    DevicesModule,
    SyncModule,
    NotesModule,
    TasksModule,
    CalendarModule,
    VaultModule,
    AdminModule,
    CollaborationModule,
    AiModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TracingInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
  ],
})
export class AppModule {}
