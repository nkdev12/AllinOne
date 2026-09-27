import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import * as Joi from "joi";
import { ConfigurationModule } from "@/config/configuration.module";
import { LoggingModule } from "@/common/logging/logging.module";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { MailModule } from "@/common/mail/mail.module";
import { MetricsModule } from "@/common/metrics/metrics.module";
import { QueuesModule } from "@/queues/queues.module";

/**
 * WorkerModule encapsulates the dependency injection tree required for
 * headless background queue processing (BullMQ / Redis).
 *
 * Keeping this distinct from AppModule ensures the HTTP API can run
 * independently in development and testing environments without requiring
 * an active Redis instance.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
      validationSchema: Joi.object({
        APP_ENV: Joi.string()
          .valid("development", "staging", "production")
          .default("development"),
        DATABASE_URL: Joi.string().required(),
        REDIS_URL: Joi.string().default("redis://localhost:6379"),
        JWT_ACCESS_SECRET: Joi.string().required(),
        JWT_REFRESH_SECRET: Joi.string().required(),
        OBJECT_STORAGE_ENDPOINT: Joi.string().required(),
        OBJECT_STORAGE_ACCESS_KEY: Joi.string().required(),
        OBJECT_STORAGE_SECRET_KEY: Joi.string().required(),
        OBJECT_STORAGE_BUCKET: Joi.string().required(),
        ENCRYPTION_KEY: Joi.string().min(32).required(),
        SMTP_HOST: Joi.string().default("localhost"),
        SMTP_PORT: Joi.number().default(587),
        SMTP_USER: Joi.string().allow("").optional(),
        SMTP_PASSWORD: Joi.string().allow("").optional(),
        SMTP_FROM: Joi.string().default("noreply@localhost"),
        SMTP_TLS: Joi.boolean().default(false),
        // Admin access keys are declared here too so `ConfigurationService`
        // sees one schema across both processes. Optional, no default: unset
        // means no admin admit path, and the worker serves no /admin routes.
        ADMIN_EMAILS: Joi.string().allow("").optional(),
        ADMIN_USER_IDS: Joi.string().allow("").optional(),
        ADMIN_SECRET: Joi.string().allow("").optional(),
        // Gemini settings, declared here too so this schema and AppModule's stay
        // in step. Nothing in the worker calls the AI module today; an unset or
        // blank key leaves it on the heuristic fallback.
        GEMINI_API_KEY: Joi.string().allow("").optional(),
        GEMINI_MODEL: Joi.string().default("gemini-1.5-flash"),
        GEMINI_TIMEOUT_MS: Joi.number().default(5000),
      }),
      validationOptions: {
        allowUnknown: true,
        abortEarly: true,
      },
    }),
    ConfigurationModule,
    LoggingModule,
    PrismaModule,
    MailModule,
    MetricsModule,
    QueuesModule,
  ],
})
export class WorkerModule {}
