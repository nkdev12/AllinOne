import { Module } from "@nestjs/common";
import { DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { AuditLogModule } from "@/common/audit/audit-log.module";

@Module({
  imports: [PrismaModule, AuditLogModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
