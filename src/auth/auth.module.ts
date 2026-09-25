import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { UsersModule } from "@/users/users.module";
import { ConfigurationModule } from "@/config/configuration.module";
import { ConfigurationService } from "@/config/configuration.service";
import { AuditLogModule } from "@/common/audit/audit-log.module";
import { MailModule } from "@/common/mail/mail.module";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    ConfigurationModule,
    AuditLogModule,
    MailModule,
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.registerAsync({
      imports: [ConfigurationModule],
      useFactory: async (configService: ConfigurationService) => ({
        secret: configService.jwtAccessSecret,
        signOptions: {
          expiresIn: "15m",
        },
      }),
      inject: [ConfigurationService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, PassportModule, JwtModule],
})
export class AuthModule {}
