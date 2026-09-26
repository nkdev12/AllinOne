import { Module } from "@nestjs/common";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { OtpModule } from "@/common/otp/otp.module";
import { UsersModule } from "@/users/users.module";
import { AuditLogModule } from "@/common/audit/audit-log.module";
import { VaultSettingsService } from "./services/vault-settings.service";
import { VaultItemsService } from "./services/vault-items.service";
import { VaultSettingsController } from "./controllers/vault-settings.controller";
import { VaultItemsController } from "./controllers/vault-items.controller";

@Module({
  imports: [PrismaModule, OtpModule, UsersModule, AuditLogModule],
  controllers: [VaultSettingsController, VaultItemsController],
  providers: [VaultSettingsService, VaultItemsService],
  exports: [VaultSettingsService, VaultItemsService],
})
export class VaultModule {}
