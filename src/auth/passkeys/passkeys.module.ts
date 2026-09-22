import { Module } from "@nestjs/common";
import { PasskeysService } from "./passkeys.service";
import { PasskeysController } from "./passkeys.controller";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { JwtModule } from "@nestjs/jwt";
import { ConfigurationModule } from "@/config/configuration.module";
import { AuditLogModule } from "@/common/audit/audit-log.module";

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({}),
    ConfigurationModule,
    AuditLogModule,
  ],
  controllers: [PasskeysController],
  providers: [PasskeysService],
  exports: [PasskeysService],
})
export class PasskeysModule {}
