import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import * as Joi from "joi";
import { ConfigurationModule } from "@/config/configuration.module";
import { ACCEPTED_NODE_ENV } from "@/config/configuration.service";
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
        // Declared here too, from the one list `ACCEPTED_NODE_ENV`, so this process
        // cannot answer a `NODE_ENV` differently from the API. The combination of an
        // undeclared key and `allowUnknown` was the whole hole: `ConfigService`
        // passes unknown keys straight through, and
        // `ConfigurationService.isTestEnvironment` reads `NODE_ENV` as "skip the
        // secret gate", so a worker started with a borrowed or typo'd value could
        // drop checks the API refuses to boot without.
        NODE_ENV: Joi.string()
          .valid(...ACCEPTED_NODE_ENV)
          .default("development"),
        DATABASE_URL: Joi.string().required(),
        // No `.default()` on purpose. `@nestjs/config` writes every schema default
        // back into `process.env`, and `ConfigurationService.declaredRedisUrl` is
        // the "was `REDIS_URL` actually declared?" test behind the refusal of an
        // unnamed Redis outside development — a default here would answer that with
        // the default and switch the gate off forever. The `redis://localhost:6379`
        // fallback belongs in the `redisUrl` getter, which only consumers read.
        REDIS_URL: Joi.string().allow("").optional(),
        JWT_ACCESS_SECRET: Joi.string().required(),
        JWT_REFRESH_SECRET: Joi.string().required(),
        OBJECT_STORAGE_ENDPOINT: Joi.string().required(),
        OBJECT_STORAGE_ACCESS_KEY: Joi.string().required(),
        OBJECT_STORAGE_SECRET_KEY: Joi.string().required(),
        OBJECT_STORAGE_BUCKET: Joi.string().required(),
        ENCRYPTION_KEY: Joi.string().min(32).required(),
        // Pepper key ring, declared here too so this schema and AppModule's stay
        // in step. ENCRYPTION_KEY_PREVIOUS only exists inside a rotation window,
        // so blank has to validate as "no previous key".
        ENCRYPTION_KEY_ID: Joi.string().allow("").optional(),
        ENCRYPTION_KEY_PREVIOUS: Joi.string().min(32).allow("").optional(),
        ENCRYPTION_KEY_PREVIOUS_ID: Joi.string().allow("").optional(),
        SMTP_HOST: Joi.string().allow("").optional(),
        SMTP_PORT: Joi.number().port().optional(),
        SMTP_USER: Joi.string().allow("").optional(),
        SMTP_PASSWORD: Joi.string().allow("").optional(),
        SMTP_FROM: Joi.string().allow("").optional(),
        SMTP_TLS: Joi.boolean().default(true),
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
