import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { ConfigurationModule } from "@/config/configuration.module";
import { ConfigurationService } from "@/config/configuration.service";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { MailModule } from "@/common/mail/mail.module";
import { FinanceModule } from "@/finance/finance.module";
import { MailProcessor } from "./processors/mail.processor";
import { NotificationProcessor } from "./processors/notification.processor";
import { ExportProcessor } from "./processors/export.processor";
import { MaintenanceProcessor } from "./processors/maintenance.processor";
import { FinanceProcessor } from "./processors/finance.processor";

@Module({
  imports: [
    ConfigurationModule,
    PrismaModule,
    MailModule,
    FinanceModule,
    BullModule.forRootAsync({
      imports: [ConfigurationModule],
      inject: [ConfigurationService],
      useFactory: (configService: ConfigurationService) => ({
        // Bull accepts a Redis connection URL. This also retains the TLS and
        // credentials required by managed Redis providers such as Upstash.
        //
        // `redisUrl` and not `getOrThrow("REDIS_URL")`: the worker's Joi schema
        // deliberately declares no default so the boot gate can tell an undeclared
        // `REDIS_URL` from a declared one, and a `getOrThrow` here would answer
        // "not set" by aborting the process before that gate ever ran. The getter
        // is the one place the localhost fallback lives, and the gate at
        // `ConfigurationService` is still what refuses a production worker that
        // declared nothing.
        redis: configService.redisUrl,
      }),
    }),
    BullModule.registerQueue(
      { name: "mail" },
      { name: "notification" },
      { name: "export" },
      { name: "maintenance" },
      { name: "finance" },
    ),
  ],
  providers: [
    MailProcessor,
    NotificationProcessor,
    ExportProcessor,
    MaintenanceProcessor,
    FinanceProcessor,
  ],
  exports: [
    BullModule,
    MailProcessor,
    NotificationProcessor,
    ExportProcessor,
    MaintenanceProcessor,
    FinanceProcessor,
  ],
})
export class QueuesModule {}
