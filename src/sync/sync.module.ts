import { Module } from "@nestjs/common";
import { SyncController } from "./sync.controller";
import { SyncService } from "./sync.service";
import { SyncGateway } from "./sync.gateway";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { JwtModule } from "@nestjs/jwt";
import { ConfigurationModule } from "@/config/configuration.module";
import { MetricsModule } from "@/common/metrics/metrics.module";

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({}),
    ConfigurationModule,
    MetricsModule,
  ],
  controllers: [SyncController],
  providers: [SyncService, SyncGateway],
  exports: [SyncService, SyncGateway],
})
export class SyncModule {}
