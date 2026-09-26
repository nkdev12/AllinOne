import { Injectable, Logger, Optional } from "@nestjs/common";
import { OtpPurpose, AuditAction } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { OtpService } from "@/common/otp/otp.service";
import { MailService } from "@/common/mail/mail.service";
import { ConfigurationService } from "@/config/configuration.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
import { UsersService } from "@/users/users.service";
import { ErrorCode } from "@/common/errors/error-code";
import {
  badRequest,
  conflict,
  notFound,
  unauthorized,
} from "@/common/errors/http-errors";
import { SetupVaultDto } from "../dto/setup-vault.dto";
import { UnlockVaultDto } from "../dto/unlock-vault.dto";

const RECOVERY_OTP_TTL_MINUTES = 15;

@Injectable()
export class VaultSettingsService {
  private readonly logger = new Logger(VaultSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otpService: OtpService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigurationService,
    @Optional() private readonly mailService?: MailService,
    @Optional() private readonly auditLogService?: AuditLogService,
  ) {}

  async setupVault(userId: string, dto: SetupVaultDto) {
    const existing = await this.prisma.vaultSetting.findUnique({
      where: { userId },
    });

    if (existing && existing.isVaultConfigured) {
      throw conflict(
        ErrorCode.VAULT_ALREADY_CONFIGURED,
        "Password vault is already configured for this account. Use the recovery flow to change the master password.",
      );
    }

    const vaultSetting = await this.prisma.vaultSetting.upsert({
      where: { userId },
      create: {
        userId,
        masterKeyHash: dto.masterKeyHash,
        keySalt: dto.keySalt,
        kdfIterations: dto.kdfIterations ?? 100000,
        kdfMemory: dto.kdfMemory ?? 65536,
        isVaultConfigured: true,
        recoveryKey: dto.recoveryKey ?? null,
        wrappedMasterKey: dto.wrappedMasterKey ?? null,
        wrappedMasterIv: dto.wrappedMasterIv ?? null,
        wrappedMasterTag: dto.wrappedMasterTag ?? null,
      },
      update: {
        masterKeyHash: dto.masterKeyHash,
        keySalt: dto.keySalt,
        kdfIterations: dto.kdfIterations ?? 100000,
        kdfMemory: dto.kdfMemory ?? 65536,
        isVaultConfigured: true,
        recoveryKey: dto.recoveryKey ?? null,
        wrappedMasterKey: dto.wrappedMasterKey ?? null,
        wrappedMasterIv: dto.wrappedMasterIv ?? null,
        wrappedMasterTag: dto.wrappedMasterTag ?? null,
      },
    });

    return {
      isVaultConfigured: vaultSetting.isVaultConfigured,
      keySalt: vaultSetting.keySalt,
      kdfIterations: vaultSetting.kdfIterations,
      kdfMemory: vaultSetting.kdfMemory,
      updatedAt: vaultSetting.updatedAt,
    };
  }

  async getVaultSettings(userId: string) {
    const setting = await this.prisma.vaultSetting.findUnique({
      where: { userId },
    });

    if (!setting) {
      return {
        isVaultConfigured: false,
        keySalt: null,
        kdfIterations: null,
        kdfMemory: null,
      };
    }

    return {
      isVaultConfigured: setting.isVaultConfigured,
      keySalt: setting.keySalt,
      kdfIterations: setting.kdfIterations,
      kdfMemory: setting.kdfMemory,
      updatedAt: setting.updatedAt,
    };
  }

  async unlockVault(userId: string, dto: UnlockVaultDto) {
    const setting = await this.prisma.vaultSetting.findUnique({
      where: { userId },
    });

    if (!setting || !setting.isVaultConfigured) {
      throw notFound(
        ErrorCode.VAULT_NOT_CONFIGURED,
        "Password vault has not been configured yet.",
      );
    }

    if (setting.masterKeyHash !== dto.masterKeyHash) {
      throw unauthorized(
        ErrorCode.VAULT_MASTER_KEY_MISMATCH,
        "Invalid master password verification key.",
      );
    }

    return {
      success: true,
      unlockedAt: new Date(),
    };
  }

  /** Emails a single-use code that unlocks the recovery blob. */
  async requestRecoveryOtp(userId: string) {
    const setting = await this.prisma.vaultSetting.findUnique({
      where: { userId },
    });

    if (!setting || !setting.isVaultConfigured) {
      throw notFound(
        ErrorCode.VAULT_NOT_CONFIGURED,
        "Password vault has not been configured yet.",
      );
    }

    if (!setting.wrappedMasterKey) {
      throw badRequest(
        ErrorCode.VAULT_RECOVERY_UNAVAILABLE,
        "This vault was created before recovery codes were available. It can be set up again from scratch.",
      );
    }

    const user = await this.usersService.getUserById(userId);
    if (!user) {
      throw unauthorized(ErrorCode.TOKEN_INVALID, "Account not found");
    }

    const otp = await this.otpService.issue(
      userId,
      OtpPurpose.VAULT_RECOVERY,
      RECOVERY_OTP_TTL_MINUTES,
    );

    // Dev-only console fallback so the code is visible even if SMTP is down.
    if (!this.configService.isProduction) {
      this.logger.debug(`VAULT RECOVERY OTP FOR ${user.email}: ${otp}`);
    }

    try {
      const sent = await this.mailService?.sendVaultRecoveryOtpEmail(
        user.email,
        otp,
      );
      if (!sent) {
        this.logger.warn(
          `Vault recovery OTP could not be delivered to ${user.email}. Check SMTP configuration.`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to send vault recovery OTP email to ${user.email}`,
        err,
      );
    }

    return {
      message:
        "If the vault can be recovered, a code has been sent to the account email address.",
    };
  }

  /**
   * Spends the recovery code and hands back the wrapped master key. The
   * entries themselves stay encrypted; the client re-encrypts them under the
   * new master password and calls completeRecovery with the result.
   */
  async verifyRecoveryOtp(userId: string, otp: string) {
    const verified = await this.otpService.consume(
      userId,
      OtpPurpose.VAULT_RECOVERY,
      otp,
    );
    if (!verified) {
      throw unauthorized(
        ErrorCode.OTP_INVALID,
        "Invalid or expired recovery code",
      );
    }

    const setting = await this.prisma.vaultSetting.findUnique({
      where: { userId },
    });
    if (!setting?.wrappedMasterKey || !setting.recoveryKey) {
      throw badRequest(
        ErrorCode.VAULT_RECOVERY_UNAVAILABLE,
        "This vault has no recovery material stored.",
      );
    }

    // Marks the window in which completeRecovery may rewrite the vault, so a
    // bare access token is never enough to swap out the master key.
    await this.prisma.vaultSetting.update({
      where: { userId },
      data: { recoveryGrantedAt: new Date() },
    });

    return {
      keySalt: setting.keySalt,
      recoveryKey: setting.recoveryKey,
      wrappedMasterKey: setting.wrappedMasterKey,
      wrappedMasterIv: setting.wrappedMasterIv,
      wrappedMasterTag: setting.wrappedMasterTag,
      masterKeyHash: setting.masterKeyHash,
    };
  }

  /** Stores the re-keyed vault settings once the client has re-encrypted. */
  async completeRecovery(userId: string, dto: SetupVaultDto) {
    const existing = await this.prisma.vaultSetting.findUnique({
      where: { userId },
    });
    const grantedAt = existing?.recoveryGrantedAt?.getTime() ?? 0;
    const grantExpires = grantedAt + RECOVERY_OTP_TTL_MINUTES * 60 * 1000;
    if (!existing || Date.now() > grantExpires) {
      throw unauthorized(
        ErrorCode.VAULT_RECOVERY_NOT_PENDING,
        "Recovery grant has expired. Verify a recovery code again.",
      );
    }

    const vaultSetting = await this.prisma.vaultSetting.update({
      where: { userId },
      data: {
        masterKeyHash: dto.masterKeyHash,
        keySalt: dto.keySalt,
        kdfIterations: dto.kdfIterations ?? existing.kdfIterations,
        kdfMemory: dto.kdfMemory ?? existing.kdfMemory,
        recoveryKey: dto.recoveryKey,
        wrappedMasterKey: dto.wrappedMasterKey,
        wrappedMasterIv: dto.wrappedMasterIv,
        wrappedMasterTag: dto.wrappedMasterTag,
        recoveryGrantedAt: null,
      },
    });

    await this.auditLogService?.recordAuditLog({
      userId,
      action: AuditAction.PASSWORD_CHANGED,
    });

    return {
      isVaultConfigured: vaultSetting.isVaultConfigured,
      keySalt: vaultSetting.keySalt,
      kdfIterations: vaultSetting.kdfIterations,
      kdfMemory: vaultSetting.kdfMemory,
      updatedAt: vaultSetting.updatedAt,
    };
  }
}
