import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AdminGuard } from "./guards/admin.guard";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { AuditLogModule } from "@/common/audit/audit-log.module";

@Module({
  imports: [PrismaModule, AuditLogModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
  exports: [AdminService, AdminGuard],
})
export class AdminModule {}
