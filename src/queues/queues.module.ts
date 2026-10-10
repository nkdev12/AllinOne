import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { ConfigurationModule } from "@/config/configuration.module";
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
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        // Bull accepts a Redis connection URL. This also retains the TLS and
        // credentials required by managed Redis providers such as Upstash.
        redis: configService.getOrThrow<string>("REDIS_URL"),
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
