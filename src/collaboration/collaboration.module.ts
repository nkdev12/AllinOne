import { Module, Global } from "@nestjs/common";
import { CollaborationService } from "./collaboration.service";
import { CollaborationController } from "./collaboration.controller";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { AuditLogModule } from "@/common/audit/audit-log.module";

@Global()
@Module({
  imports: [PrismaModule, AuditLogModule],
  controllers: [CollaborationController],
  providers: [CollaborationService],
  exports: [CollaborationService],
})
export class CollaborationModule {}

