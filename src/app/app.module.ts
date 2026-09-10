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
import { QueuesModule } from "@/queues/queues.module";
import { ErrorHandlingModule } from "@/common/error-handling/error-handling.module";
import { AuditLogModule } from "@/common/audit/audit-log.module";
import { MetricsModule } from "@/common/metrics/metrics.module";
import { MetricsInterceptor } from "@/common/metrics/metrics.interceptor";
import { CustomThrottlerGuard } from "@/common/guards/custom-throttler.guard";
import { IdempotencyInterceptor } from "@/common/interceptors/idempotency.interceptor";
import { RedisThrottlerStorage } from "@/common/throttler/redis-throttler.storage";
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
        APP_URL: Joi.string().required(),
        NODE_ENV: Joi.string()
          .valid("development", "production")
          .default("development"),
        LOG_LEVEL: Joi.string().default("debug"),

        // Database
        DATABASE_URL: Joi.string().required(),

        // Redis
        REDIS_URL: Joi.string().required(),

        // JWT
        JWT_ACCESS_SECRET: Joi.string().required(),
        JWT_ACCESS_EXPIRATION: Joi.string().default("15m"),
        JWT_REFRESH_SECRET: Joi.string().required(),
        JWT_REFRESH_EXPIRATION: Joi.string().default("7d"),

        // Object Storage
        OBJECT_STORAGE_ENDPOINT: Joi.string().required(),
        OBJECT_STORAGE_REGION: Joi.string().default("us-east-1"),
        OBJECT_STORAGE_BUCKET: Joi.string().required(),
        OBJECT_STORAGE_ACCESS_KEY: Joi.string().required(),
        OBJECT_STORAGE_SECRET_KEY: Joi.string().required(),
        OBJECT_STORAGE_USE_SSL: Joi.boolean().default(false),

        // SMTP
        SMTP_HOST: Joi.string().required(),
        SMTP_PORT: Joi.number().required(),
        SMTP_USER: Joi.string().optional(),
        SMTP_PASSWORD: Joi.string().optional(),
        SMTP_FROM: Joi.string().required(),
        SMTP_TLS: Joi.boolean().default(true),
        EMAIL_VERIFY_ENABLED: Joi.boolean().default(true),

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
    QueuesModule,
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
        storage: new RedisThrottlerStorage(config),
      }),
    }),

    // ====================================================================
    // Feature Modules
    // ====================================================================
    HealthModule,
    UsersModule,
    AuthModule,
    DevicesModule,
    SyncModule,
    NotesModule,
    TasksModule,
    CalendarModule,
    VaultModule,
    AdminModule,
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
