import { Module } from "@nestjs/common";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { OtpModule } from "@/common/otp/otp.module";
import { UsersModule } from "@/users/users.module";
import { AuditLogModule } from "@/common/audit/audit-log.module";
import { VaultSettingsService } from "./services/vault-settings.service";
import { VaultSettingsController } from "./controllers/vault-settings.controller";

@Module({
  imports: [PrismaModule, OtpModule, UsersModule, AuditLogModule],
  controllers: [VaultSettingsController],
  providers: [VaultSettingsService],
  exports: [VaultSettingsService],
})
export class VaultModule {}
