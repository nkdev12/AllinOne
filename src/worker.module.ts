import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import * as Joi from "joi";
import { ConfigurationModule } from "@/config/configuration.module";
import { ENV_GATING_SCHEMA_KEYS } from "@/config/configuration.service";
import { LoggingModule } from "@/common/logging/logging.module";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { MailModule } from "@/common/mail/mail.module";
import { MetricsModule } from "@/common/metrics/metrics.module";
import { QueuesModule } from "@/queues/queues.module";

/**
 * The worker's boot schema, exported so its env-gating keys are testable as an
 * object (`src/worker.module.spec.ts`, `src/config/configuration.service.spec.ts`)
 * rather than only by observing whether a Nest compile survives them.
 *
 * This is a deliberate copy of `ENV_VALIDATION_SCHEMA` in `src/app/app.module.ts`,
 * narrowed to what a headless process needs. The duplication is the risk: an
 * `APP_ENV` default on one side and not the other is how a worker began skipping
 * `validateProductionSecrets()` that the API refused to boot through. So every key
 * `ConfigurationService` decides on is spread from `ENV_GATING_SCHEMA_KEYS` and this
 * file declares only what a worker alone has — `GEMINI_*` and the SMTP transport
 * keys — and `src/app/app.module.spec.ts` asserts that the two still answer the same
 * way for the shared set.
 */
export const WORKER_ENV_VALIDATION_SCHEMA = Joi.object({
  // `APP_ENV` and `NODE_ENV` come from here, not from a local copy, for the reason
  // spelled out in `src/app/app.module.ts`: a schema default is written back into
  // `process.env`, so `development` inferred from an absent `APP_ENV` is not a
  // development environment. The worker seals TOTP secrets with `ENCRYPTION_KEY` and
  // counts its rate limits in Redis, so the branch this value selects is the one
  // that matters most, not least. `REDIS_URL` has no default in the same set for the
  // same kind of reason — `ConfigurationService.declaredRedisUrl` is the "was it
  // actually declared?" test behind refusing an unnamed Redis outside development.
  ...ENV_GATING_SCHEMA_KEYS,

  SMTP_HOST: Joi.string().allow("").optional(),
  SMTP_PORT: Joi.number().port().optional(),
  SMTP_USER: Joi.string().allow("").optional(),
  // Optional in both processes: `MailService.isConfigured` reads a blank one as
  // "mail is off", and a written one is gated as a passphrase outside development
  // by `validateProductionSecrets()`. `SMTP_PASSWORD` itself is in the shared set.
  SMTP_FROM: Joi.string().allow("").optional(),
  SMTP_TLS: Joi.boolean().default(true),
  // Admin access keys are declared here too so `ConfigurationService`
  // sees one schema across both processes. Optional, no default: unset
  // means no admin admit path, and the worker serves no /admin routes.
  // A *set* value is held to the JWT rules in every environment, so the
  // length-and-entropy checks cannot be satisfied here and skipped there.
  // `ADMIN_SECRET` is in the shared set.
  ADMIN_EMAILS: Joi.string().allow("").optional(),
  ADMIN_USER_IDS: Joi.string().allow("").optional(),
  // Gemini settings, declared here too so this schema and AppModule's stay
  // in step. Nothing in the worker calls the AI module today; an unset or
  // blank key leaves it on the heuristic fallback.
  GEMINI_API_KEY: Joi.string().allow("").optional(),
  GEMINI_MODEL: Joi.string().default("gemini-1.5-flash"),
  GEMINI_TIMEOUT_MS: Joi.number().default(5000),
});

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
      validationSchema: WORKER_ENV_VALIDATION_SCHEMA,
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
