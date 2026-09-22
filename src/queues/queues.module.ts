import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { ConfigurationModule } from "@/config/configuration.module";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { MailModule } from "@/common/mail/mail.module";
import { MailProcessor } from "./processors/mail.processor";
import { NotificationProcessor } from "./processors/notification.processor";
import { ExportProcessor } from "./processors/export.processor";
import { MaintenanceProcessor } from "./processors/maintenance.processor";

@Module({
  imports: [
    ConfigurationModule,
    PrismaModule,
    MailModule,
    BullModule.forRootAsync({
      imports: [ConfigurationModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: configService.get<string>("REDIS_HOST") || "localhost",
          port: Number(configService.get<number>("REDIS_PORT")) || 6379,
          password: configService.get<string>("REDIS_PASSWORD") || undefined,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: "mail" },
      { name: "notification" },
      { name: "export" },
      { name: "maintenance" },
    ),
  ],
  providers: [
    MailProcessor,
    NotificationProcessor,
    ExportProcessor,
    MaintenanceProcessor,
  ],
  exports: [
    BullModule,
    MailProcessor,
    NotificationProcessor,
    ExportProcessor,
    MaintenanceProcessor,
  ],
})
export class QueuesModule {}
