import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import * as Joi from "joi";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { ConfigurationModule } from "@/config/configuration.module";
import {
  ConfigurationService,
  ENV_GATING_SCHEMA_KEYS,
} from "@/config/configuration.service";
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
import { FinanceModule } from "@/finance/finance.module";
import { PasskeysModule } from "@/auth/passkeys/passkeys.module";
import { ErrorHandlingModule } from "@/common/error-handling/error-handling.module";
import { AuditLogModule } from "@/common/audit/audit-log.module";
import { MetricsModule } from "@/common/metrics/metrics.module";
import { MetricsInterceptor } from "@/common/metrics/metrics.interceptor";
import { CustomThrottlerGuard } from "@/common/guards/custom-throttler.guard";
import { RedisThrottlerStorage } from "@/common/throttler/redis-throttler.storage";
import { IdempotencyInterceptor } from "@/common/interceptors/idempotency.interceptor";
import { TracingModule } from "@/common/tracing/tracing.module";
import { TracingInterceptor } from "@/common/tracing/tracing.interceptor";

/**
 * Exists for one decision: whether the rate-limit counters live in Redis or in the
 * process's memory.
 *
 * `RedisThrottlerStorage` is a class Nest only constructs when the environment
 * wants it, because the alternative is worse than the bug this fixes — an
 * `ioredis` client opens its socket on the first command, and the Jest suites
 * (unit and e2e) build this module with no Redis listening, so registering the
 * class unconditionally would have every throttled request in a suite spend its
 * retries failing and then land in the storage's degraded in-process path. The
 * rule itself is `ConfigurationService
 * .usesRedisThrottlerStorage`, so the suites that depend on the in-memory default
 * keep it, and a real container does not.
 *
 * Owning it in a module rather than building it inside the throttler's options
 * factory is what lets Nest see it: a value created in a factory is invisible to
 * the shutdown hooks, and an un-quit Redis client is an open handle in a process
 * that is trying to exit cleanly.
 */
@Module({
  imports: [ConfigurationModule],
  providers: [
    {
      provide: RedisThrottlerStorage,
      inject: [ConfigurationService],
      useFactory: (config: ConfigurationService) =>
        config.usesRedisThrottlerStorage
          ? new RedisThrottlerStorage(config)
          : undefined,
    },
  ],
  exports: [RedisThrottlerStorage],
})
export class ThrottlerStorageModule {}

/**
 * The API process's boot schema, exported instead of written inline so the rule it
 * encodes is testable as an object rather than only as a boot outcome —
 * `src/app/app.module.spec.ts` validates fixtures against it and against
 * `WORKER_ENV_VALIDATION_SCHEMA` in the same breath.
 *
 * The keys `ConfigurationService` decides on come from `ENV_GATING_SCHEMA_KEYS`,
 * shared with `src/worker.module.ts`, because that is the exact set on which the
 * two copies were free to disagree: `APP_ENV` carried a `.default("development")` in
 * both, and a schema default is written back into `process.env`, so an unnamed
 * environment silently took the development branch — skipping
 * `validateProductionSecrets()`, skipping the `REDIS_URL` requirement, and letting
 * `auth.service.ts` print live email-verification OTPs to stdout. Sharing the
 * definitions is the only version of "keep them in lockstep" that does not depend on
 * the next reader remembering to.
 *
 * What is left here is what only the HTTP process has: the port it binds, the URL it
 * advertises, logging, CORS, rate limits, Swagger, backups.
 */
export const ENV_VALIDATION_SCHEMA = Joi.object({
  ...ENV_GATING_SCHEMA_KEYS,

  // App
  APP_PORT: Joi.number().default(3000),
  PORT: Joi.number().optional(),
  APP_URL: Joi.string().required(),
  LOG_LEVEL: Joi.string().default("debug"),

  // Email (SMTP; Gmail uses smtp.gmail.com:587 with an app password)
  // Every key stays optional because `MailService.isConfigured` treats a blank one
  // as "mail is switched off" and warns instead of failing: a deployment without an
  // SMTP server is a supported state. `SMTP_PASSWORD` — which is in the shared set,
  // and gated by `validateProductionSecrets()` only when an operator wrote one — is
  // gated as a passphrase rather than as key material, because a Gmail app password
  // is sixteen lowercase characters and the 128-bit rule would refuse a mailbox that
  // works.
  SMTP_HOST: Joi.string().allow("").optional(),
  SMTP_PORT: Joi.number().port().optional(),
  SMTP_USER: Joi.string().allow("").optional(),
  SMTP_FROM: Joi.string().allow("").optional(),
  SMTP_TLS: Joi.boolean().default(true),
  // Public accounts must prove control of their mailbox before they can
  // obtain a session. Local test suites may opt out explicitly.
  EMAIL_VERIFY_ENABLED: Joi.boolean().default(true),
  EMAIL_VERIFY_TOKEN_EXPIRY: Joi.string().default("24h"),

  // JWT
  JWT_ACCESS_EXPIRATION: Joi.string().default("15m"),
  JWT_REFRESH_EXPIRATION: Joi.string().default("7d"),

  // Admin access (AdminGuard). Optional and with NO default on purpose:
  // unset or empty means the corresponding admit path is closed, so a
  // deployment that never provisions these simply has no admin API.
  // `ADMIN_SECRET` itself — length and entropy floors in `ConfigurationService`,
  // in every environment including development, since a guarded route is the only
  // thing that ever reads it — is in the shared set.
  ADMIN_EMAILS: Joi.string().allow("").optional(),
  ADMIN_USER_IDS: Joi.string().allow("").optional(),

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
  CORS_ORIGINS: Joi.string().allow("").optional(),
  WS_CORS_ORIGINS: Joi.string().allow("").optional(),
  WS_CORS_ALLOW_NULL_ORIGIN: Joi.string().allow("").optional(),
  WS_REDIS_ADAPTER: Joi.string().allow("").optional(),
  // Localhost is useful while developing the web client, but accepting
  // arbitrary localhost ports must be an explicit operator choice.
  ALLOW_LOCALHOST_CORS: Joi.boolean().default(false),

  // API documentation carries the full route inventory. Keep it off
  // unless an operator deliberately enables it in a trusted environment.
  SWAGGER_ENABLED: Joi.boolean().default(false),

  // Object Storage
  OBJECT_STORAGE_REGION: Joi.string().default("us-east-1"),
  OBJECT_STORAGE_USE_SSL: Joi.boolean().default(false),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: Joi.number().default(60000),
  RATE_LIMIT_MAX_REQUESTS: Joi.number().default(100),

  // Logging
  LOG_FORMAT: Joi.string().valid("json", "simple").default("json"),
  LOG_OUTPUT: Joi.string().default("console"),

  // Monitoring
  METRICS_ENABLED: Joi.boolean().default(true),

  // OpenTelemetry
  OTEL_ENABLED: Joi.boolean().default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().optional(),

  // Backup
  BACKUP_ENABLED: Joi.boolean().default(true),
  BACKUP_SCHEDULE: Joi.string().default("0 2 * * *"),
  BACKUP_RETENTION_DAYS: Joi.number().default(30),
});

@Module({
  imports: [
    // ====================================================================
    // Environment Configuration
    // ====================================================================
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
      validationSchema: ENV_VALIDATION_SCHEMA,
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
      imports: [ConfigurationModule, ThrottlerStorageModule],
      inject: [ConfigurationService, RedisThrottlerStorage],
      useFactory: (
        config: ConfigurationService,
        storage?: RedisThrottlerStorage,
      ) => ({
        throttlers: [
          {
            ttl: config.rateLimitWindowMs,
            limit: config.rateLimitMaxRequests,
          },
        ],
        // Omitting `storage` is what selects the library's in-memory default, and
        // the throttler resolves it from this options object rather than from DI —
        // `ThrottlerStorageProvider` reads `options.storage` — so an absent key is
        // the only way to keep the default. `ThrottlerStorageModule` below hands
        // back `undefined` for exactly one environment: a Jest run, which builds
        // this graph with no Redis listening.
        ...(storage ? { storage } : {}),
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
    FinanceModule,
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
