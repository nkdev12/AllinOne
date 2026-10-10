import { Injectable, Logger, Optional } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
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
import {
  SetupVaultDto,
  CompleteVaultRecoveryDto,
} from "../dto/setup-vault.dto";
import { UnlockVaultDto } from "../dto/unlock-vault.dto";

const RECOVERY_OTP_TTL_MINUTES = 15;

/**
 * What a `VaultSetting.masterKeyHash` looks like once the pepper has been
 * applied. Rows written before it hold the verifier exactly as it arrived and
 * are recognised by the absence of this prefix.
 */
const PEEPERED_VERIFIER_PREFIX = "hmac-sha256:";

/** Consecutive failed verifications tolerated before the endpoint cools down. */
const UNLOCK_MAX_FAILED_ATTEMPTS = 5;
const UNLOCK_COOLDOWN_BASE_MS = 60 * 1000;
const UNLOCK_COOLDOWN_MAX_MS = 60 * 60 * 1000;

/**
 * The Argon2id parameters the shipped client derives with (`p = 4` is not
 * stored), used as the fallback when a request omits them.
 *
 * These columns are a record, not a setting: the server never reads them to
 * configure a KDF, and the copy that a future build can trust is the `_kdf`
 * marker sealed inside each blob. They used to fall back to `100000` — a
 * PBKDF2-shaped number written before this client existed — which meant every
 * row on the server misdescribed the vault beside it.
 */
const DEFAULT_KDF_ITERATIONS = 3;
const DEFAULT_KDF_MEMORY_KIB = 65536;

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

  /**
   * The verifier a client sends is a bearer secret — holding it is holding the
   * unlock. It is stored as an HMAC under a server-only key so that reading the
   * table is not reading every vault. Unlike a password hash this needs no
   * per-row salt: the input is already 256 bits of Argon2id output, so guessing
   * is not what the pepper defends against.
   */
  private pepperedVerifier(verifier: string): string {
    return (
      PEEPERED_VERIFIER_PREFIX +
      createHmac("sha256", this.configService.encryptionKey)
        .update(verifier)
        .digest("base64")
    );
  }

  /**
   * Rows written before the pepper still hold the value the client sent, and
   * refusing them would lock out every vault that existed first. They open the
   * vault and are rewritten on the way out, because a successful unlock is the
   * only moment the raw verifier is in hand to convert.
   */
  private matchesVerifier(stored: string, presented: string): boolean {
    return stored.startsWith(PEEPERED_VERIFIER_PREFIX)
      ? verifiersMatch(stored, this.pepperedVerifier(presented))
      : verifiersMatch(stored, presented);
  }

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

    // Setup may legitimately store no recovery material (a vault created by a
    // build that predates recovery), but it may never *erase* recovery material
    // that already works: the upsert's update branch would null the columns, and
    // the row is the only place the wrap lives.
    if (existing?.wrappedMasterKey) {
      assertRecoveryMaterialComplete(
        dto,
        "Re-setting a vault that already has recovery material must supply the new recovery material.",
      );
    }

    const vaultSetting = await this.prisma.vaultSetting.upsert({
      where: { userId },
      create: {
        userId,
        masterKeyHash: this.pepperedVerifier(dto.masterKeyHash),
        keySalt: dto.keySalt,
        kdfIterations: dto.kdfIterations ?? DEFAULT_KDF_ITERATIONS,
        kdfMemory: dto.kdfMemory ?? DEFAULT_KDF_MEMORY_KIB,
        isVaultConfigured: true,
        recoveryKey: dto.recoveryKey ?? null,
        wrappedMasterKey: dto.wrappedMasterKey ?? null,
        wrappedMasterIv: dto.wrappedMasterIv ?? null,
        wrappedMasterTag: dto.wrappedMasterTag ?? null,
      },
      update: {
        masterKeyHash: this.pepperedVerifier(dto.masterKeyHash),
        keySalt: dto.keySalt,
        kdfIterations: dto.kdfIterations ?? DEFAULT_KDF_ITERATIONS,
        kdfMemory: dto.kdfMemory ?? DEFAULT_KDF_MEMORY_KIB,
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
      passwordWrappedKey: setting.passwordWrappedKey ?? null,
      passwordWrappedIv: setting.passwordWrappedIv ?? null,
      passwordWrappedTag: setting.passwordWrappedTag ?? null,
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

    if (setting.passwordWrappedKey && dto.keyEnvelopeVersion !== 1) {
      throw badRequest(
        ErrorCode.VALIDATION_ERROR,
        "Update this app to unlock the recovered vault safely.",
      );
    }

    const lockedUntil = setting.unlockLockedUntil;
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      const retryInSeconds = Math.ceil(
        (lockedUntil.getTime() - Date.now()) / 1000,
      );
      await this.auditLogService?.recordAuditLog({
        userId,
        action: AuditAction.LOGIN_FAILURE,
        resourceType: "vault",
        resourceId: userId,
        metadata: { reason: "VAULT_UNLOCK_COOLDOWN", retryInSeconds },
      });
      throw unauthorized(
        ErrorCode.RATE_LIMITED,
        `Too many failed master password attempts. Try again in ${retryInSeconds} second(s).`,
        { retryInSeconds },
      );
    }

    if (!this.matchesVerifier(setting.masterKeyHash, dto.masterKeyHash)) {
      const attempts = (setting.unlockFailedAttempts ?? 0) + 1;
      const cooldown = this.unlockCooldownMs(attempts);
      await this.prisma.vaultSetting.update({
        where: { userId },
        data: {
          unlockFailedAttempts: attempts,
          ...(cooldown
            ? { unlockLockedUntil: new Date(Date.now() + cooldown) }
            : {}),
        },
      });
      await this.auditLogService?.recordAuditLog({
        userId,
        action: AuditAction.LOGIN_FAILURE,
        resourceType: "vault",
        resourceId: userId,
        metadata: { attempts, cooldownMs: cooldown },
      });
      throw unauthorized(
        ErrorCode.VAULT_MASTER_KEY_MISMATCH,
        "Invalid master password verification key.",
      );
    }

    // A clean unlock writes nothing: the counters it might clear are already
    // clear, and the row is already in the peppered form.
    const needsUpgrade = !setting.masterKeyHash.startsWith(
      PEEPERED_VERIFIER_PREFIX,
    );
    const countersToClear = (setting.unlockFailedAttempts ?? 0) > 0;
    if (needsUpgrade || countersToClear) {
      await this.prisma.vaultSetting.update({
        where: { userId },
        data: {
          ...(needsUpgrade
            ? { masterKeyHash: this.pepperedVerifier(dto.masterKeyHash) }
            : {}),
          ...(countersToClear
            ? { unlockFailedAttempts: 0, unlockLockedUntil: null }
            : {}),
        },
      });
    }

    return {
      success: true,
      unlockedAt: new Date(),
    };
  }

  /**
   * How long the unlock endpoint refuses after `attempts` consecutive failures,
   * or null when it still answers. Five guesses is free, then a minute, then
   * doubling to an hour.
   *
   * Counted per vault rather than per account, and deliberately not reusing
   * `User.failedLoginAttempts`: a wrong *master password* — which the user can
   * easily type while the app is asking for the *account* one — must never lock
   * the account out of its notes, tasks and calendar.
   */
  private unlockCooldownMs(attempts: number): number | null {
    if (attempts < UNLOCK_MAX_FAILED_ATTEMPTS) return null;
    const escalations = attempts - UNLOCK_MAX_FAILED_ATTEMPTS;
    return Math.min(
      UNLOCK_COOLDOWN_BASE_MS * 2 ** escalations,
      UNLOCK_COOLDOWN_MAX_MS,
    );
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
      // Deliberately not `masterKeyHash`: the client unwraps the master key
      // under the recovery key and authenticates it with the AES-GCM tag, so
      // handing it the verifier too would only put a bearer secret on a wire
      // that does not need one.
    };
  }

  /** Atomically changes the password wrapper; all entry ciphertext stays valid. */
  async completeRecovery(userId: string, dto: CompleteVaultRecoveryDto) {
    if (
      !dto.passwordWrappedKey ||
      !dto.passwordWrappedIv ||
      !dto.passwordWrappedTag
    ) {
      throw badRequest(
        ErrorCode.VALIDATION_ERROR,
        "Update this app to recover the vault without re-encrypting entries.",
      );
    }
    const existing = await this.prisma.vaultSetting.findUnique({
      where: { userId },
    });
    if (!existing) {
      throw unauthorized(
        ErrorCode.VAULT_RECOVERY_NOT_PENDING,
        "Verify a recovery code first.",
      );
    }
    // Retrying after a lost response must not require a second recovery code.
    if (
      existing.keySalt === dto.keySalt &&
      this.matchesVerifier(existing.masterKeyHash, dto.masterKeyHash) &&
      existing.passwordWrappedKey === dto.passwordWrappedKey &&
      existing.passwordWrappedIv === dto.passwordWrappedIv &&
      existing.passwordWrappedTag === dto.passwordWrappedTag
    ) {
      return this.getVaultSettings(userId);
    }
    const grantedAt = existing.recoveryGrantedAt;
    if (
      !grantedAt ||
      Date.now() > grantedAt.getTime() + RECOVERY_OTP_TTL_MINUTES * 60 * 1000
    ) {
      throw unauthorized(
        ErrorCode.VAULT_RECOVERY_NOT_PENDING,
        "Recovery grant has expired. Verify a recovery code again.",
      );
    }
    const result = await this.prisma.vaultSetting.updateMany({
      where: {
        userId,
        recoveryGrantedAt: grantedAt,
        masterKeyHash: existing.masterKeyHash,
      },
      data: {
        masterKeyHash: this.pepperedVerifier(dto.masterKeyHash),
        keySalt: dto.keySalt,
        kdfIterations: dto.kdfIterations,
        kdfMemory: dto.kdfMemory,
        passwordWrappedKey: dto.passwordWrappedKey,
        passwordWrappedIv: dto.passwordWrappedIv,
        passwordWrappedTag: dto.passwordWrappedTag,
        recoveryGrantedAt: null,
        unlockFailedAttempts: 0,
        unlockLockedUntil: null,
        // Keep the existing recovery key and wrap: they still wrap the SAME
        // data key, including entries absent from this client's local cache.
      },
    });
    if (result.count !== 1) {
      throw conflict(
        ErrorCode.VAULT_RECOVERY_NOT_PENDING,
        "Vault recovery changed. Verify a new recovery code.",
      );
    }
    await this.auditLogService?.recordAuditLog({
      userId,
      action: AuditAction.PASSWORD_CHANGED,
      resourceType: "vault",
    });
    return this.getVaultSettings(userId);
  }
}

/**
 * The four recovery columns are written together or not at all: `?? null`
 * defaults in the DTO would otherwise let a request that omits them clear the
 * only stored copy of the wrapped master key, which no client can undo.
 */
function assertRecoveryMaterialComplete(
  dto: SetupVaultDto,
  message: string,
): void {
  const missing = [
    ["recoveryKey", dto.recoveryKey],
    ["wrappedMasterKey", dto.wrappedMasterKey],
    ["wrappedMasterIv", dto.wrappedMasterIv],
    ["wrappedMasterTag", dto.wrappedMasterTag],
  ]
    .filter(([, value]) => !value)
    .map(([field]) => field);

  if (missing.length > 0) {
    throw badRequest(ErrorCode.VALIDATION_ERROR, message, { fields: missing });
  }
}

/**
 * Compares two base64 master-key verifiers. `timingSafeEqual` throws on a
 * length mismatch, and the length of a verifier is fixed by its encoding
 * rather than by any secret, so the early return leaks nothing.
 */
function verifiersMatch(stored: string, presented: string): boolean {
  const expected = Buffer.from(stored);
  const received = Buffer.from(presented);

  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}
