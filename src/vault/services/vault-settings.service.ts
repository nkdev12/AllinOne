import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { OtpPurpose, AuditAction } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { OtpService } from "@/common/otp/otp.service";
import { MailService } from "@/common/mail/mail.service";
import {
  ConfigurationService,
  secretFingerprint,
} from "@/config/configuration.service";
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
const PEPPERED_VERIFIER_PREFIX = "hmac-sha256:";

/** Consecutive failed verifications tolerated before the endpoint cools down. */
const UNLOCK_MAX_FAILED_ATTEMPTS = 5;
const UNLOCK_COOLDOWN_BASE_MS = 60 * 1000;
const UNLOCK_COOLDOWN_MAX_MS = 60 * 60 * 1000;

/**
 * One pepper of the ring: the name a row carries and the secret behind it.
 *
 * The name is stored beside every digest because the secret cannot be — a row
 * that says only "an HMAC" cannot be re-sealed once there is a second candidate
 * to have made it, and guessing by trying every key forever is how a rotation
 * turns into a slow denial of service on the unlock path.
 */
interface PepperKey {
  readonly id: string;
  readonly secret: string;
}

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
   * The pepper that seals new rows: the current key, under the name the operator
   * gave it.
   *
   * The fallback to a fingerprint is not decoration. A `ConfigurationService`
   * doubled in a test or a stub carries `encryptionKey` and no id getter, and an
   * id of `undefined` written into `masterKeyHashPepper` names a key nothing holds
   * — the next unlock of that row would then report our own bookkeeping as a wrong
   * master password.
   */
  private currentPepper(): PepperKey {
    return pepperKey(
      this.configService.encryptionKey,
      this.configService.encryptionKeyId,
    );
  }

  /**
   * The keys a stored verifier may have been sealed under, current first.
   *
   * Rotation is the only reason this is a list. What a row holds is a digest, not
   * the verifier it digests, so an old row cannot be converted offline: it can
   * only be converted on an unlock that presents the verifier, and refusing that
   * unlock is exactly what used to make rotating `ENCRYPTION_KEY` equivalent to
   * dropping the column. The retired key therefore stays in the ring for as long
   * as any row still names it, and the re-seal below is what drains the window.
   */
  private pepperRing(): PepperKey[] {
    const current = this.currentPepper();
    const previous = this.configService.encryptionKeyPrevious;
    if (!previous) {
      return [current];
    }
    return [
      current,
      pepperKey(previous, this.configService.encryptionKeyPreviousId),
    ];
  }

  /**
   * The digest and the stamp for one write of a verifier under the current key.
   * They travel together: a digest written without its name is a row the next
   * rotation has to guess about.
   */
  private sealedRow(verifier: string): {
    masterKeyHash: string;
    masterKeyHashPepper: string;
  } {
    const key = this.currentPepper();
    return {
      masterKeyHash: sealWith(key, verifier),
      masterKeyHashPepper: key.id,
    };
  }

  /**
   * Which pepper, if any, this row accepts the presented verifier under, or
   * `undefined` when the master password is simply wrong.
   *
   * Rows written before the pepper still hold the value the client sent, and
   * refusing them would lock out every vault that existed first; they open the
   * vault and are rewritten on the way out, because a successful unlock is the
   * only moment the raw verifier is in hand to convert.
   *
   * A row with no stamp was sealed before identifiers existed, which leaves only
   * trying: the current key first, because a database that has never rotated holds
   * nothing else, then the rotation-window key. A stamp that names no key this
   * process holds fails closed and says so — a deployment that dropped a ring
   * entry while rows still depend on it is our misconfiguration, and answering
   * 401 would blame the owner of every one of those vaults and then count five of
   * their correct passwords into a cooldown that locks them out for an hour.
   */
  private findSealingKey(
    setting: { masterKeyHash: string; masterKeyHashPepper?: string | null },
    presented: string,
  ): PepperKey | undefined {
    if (!setting.masterKeyHash.startsWith(PEPPERED_VERIFIER_PREFIX)) {
      return verifiersMatch(setting.masterKeyHash, presented)
        ? this.currentPepper()
        : undefined;
    }

    const stamp = setting.masterKeyHashPepper;
    const ring = this.pepperRing();
    const candidates = stamp ? ring.filter((key) => key.id === stamp) : ring;
    if (stamp && candidates.length === 0) {
      this.logger.error(
        `Vault row is sealed under pepper "${stamp}", which is not in this process's key ring. Set ENCRYPTION_KEY_PREVIOUS (and ENCRYPTION_KEY_PREVIOUS_ID) to the retired key, or the owner must recover the vault.`,
      );
      throw pepperKeyUnavailable(stamp);
    }

    return candidates.find((key) =>
      verifiersMatch(setting.masterKeyHash, sealWith(key, presented)),
    );
  }

  /**
   * Whether a stored row already holds this verifier — the retry-after-lost-response
   * comparison in `completeRecovery`, which decides only whether to write.
   *
   * Deliberately never fails closed on an unknown stamp: recovery is how a vault
   * stranded by a dropped ring key gets back, and refusing it here would remove the
   * one path that still works without the key. Nor does it reach for the recovery
   * envelope: after a recovery the row's verifier is `hash(passwordKey)` while the
   * envelope wraps the *data* key, and the two are different secrets that must not
   * be compared to each other.
   */
  private alreadyHolds(stored: string, presented: string): boolean {
    if (!stored.startsWith(PEPPERED_VERIFIER_PREFIX)) {
      return verifiersMatch(stored, presented);
    }
    return this.pepperRing().some((key) =>
      verifiersMatch(stored, sealWith(key, presented)),
    );
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

    // Both branches write the same digest and the same stamp: a setup that stored
    // a verifier without naming its pepper would leave the next rotation to guess.
    const sealed = this.sealedRow(dto.masterKeyHash);

    const vaultSetting = await this.prisma.vaultSetting.upsert({
      where: { userId },
      create: {
        userId,
        ...sealed,
        keySalt: dto.keySalt,
        kdfIterations: dto.kdfIterations ?? DEFAULT_KDF_ITERATIONS,
        kdfMemory: dto.kdfMemory ?? DEFAULT_KDF_MEMORY_KIB,
        isVaultConfigured: true,
        recoveryKdfSalt: dto.recoveryKdfSalt ?? null,
        // A setup is the one moment the client definitely holds the master key,
        // so it is also the moment a legacy plaintext wrapping key can be
        // deleted without stranding anyone.
        recoveryKey: null,
        wrappedMasterKey: dto.wrappedMasterKey ?? null,
        wrappedMasterIv: dto.wrappedMasterIv ?? null,
        wrappedMasterTag: dto.wrappedMasterTag ?? null,
      },
      update: {
        ...sealed,
        keySalt: dto.keySalt,
        kdfIterations: dto.kdfIterations ?? DEFAULT_KDF_ITERATIONS,
        kdfMemory: dto.kdfMemory ?? DEFAULT_KDF_MEMORY_KIB,
        isVaultConfigured: true,
        recoveryKdfSalt: dto.recoveryKdfSalt ?? null,
        recoveryKey: null,
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
      throw vaultNotConfigured();
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

    const sealingKey = this.findSealingKey(setting, dto.masterKeyHash);
    if (!sealingKey) {
      // A single atomic `$inc`, not "read, add one, write": two guesses from two
      // devices that both read `3` used to both write `4`, and this is the one
      // counter an attacker races on purpose. The row the connector hands back
      // is the row *after* that increment, so the cooldown is computed from the
      // count the vault now carries instead of the count this request happened
      // to observe.
      const burned = await this.prisma.vaultSetting
        .update({
          where: { userId },
          data: { unlockFailedAttempts: { increment: 1 } },
        })
        .catch((err) => mapMissingRow(err, vaultNotConfigured));
      const attempts = burned.unlockFailedAttempts;
      const cooldown = this.unlockCooldownMs(attempts);
      if (cooldown) {
        // Only ever forward. Within a burst the writes land in whatever order
        // the connector finishes them, so the guess that counted least can be
        // the one that writes last — an unconditional `update` here would let a
        // hundred parallel guesses collapse an escalation the row had already
        // earned back to the base cooldown, which is exactly what the racing
        // attacker is trying to buy. The filter is what makes "extend, never
        // shorten" one statement instead of a read-check-write.
        const lockedUntil = new Date(Date.now() + cooldown);
        await this.prisma.vaultSetting.updateMany({
          where: {
            userId,
            OR: [
              { unlockLockedUntil: null },
              { unlockLockedUntil: { lt: lockedUntil } },
            ],
          },
          data: { unlockLockedUntil: lockedUntil },
        });
      }
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

    // A clean unlock writes nothing: the counters it might clear are already clear,
    // the digest is the current key's, and the row already names it. Anything else
    // is converted here, on the way out, because this is the only moment the bare
    // verifier is in hand — a row still sealed under the retired key, or one whose
    // pepper has never been stamped, or one that predates the pepper altogether.
    const current = this.currentPepper();
    const needsReseal =
      !setting.masterKeyHash.startsWith(PEPPERED_VERIFIER_PREFIX) ||
      sealingKey.id !== current.id ||
      setting.masterKeyHashPepper !== current.id;
    const countersToClear = (setting.unlockFailedAttempts ?? 0) > 0;
    if (needsReseal) {
      // Guarded on the digest this request read, so a second unlock that had
      // already re-sealed the row wins and this write simply matches nothing:
      // without the filter the slower request stamps the row back to a pepper the
      // faster one has already replaced, and the row then names a key nothing
      // sealed it with. `updateMany` rather than `update` for the same reason a
      // vanished row must not arrive as a database error — a lost race and a lost
      // row are both answered by the count, not by an exception.
      await this.prisma.vaultSetting.updateMany({
        where: { userId, masterKeyHash: setting.masterKeyHash },
        data: {
          ...this.sealedRow(dto.masterKeyHash),
          ...(countersToClear
            ? { unlockFailedAttempts: 0, unlockLockedUntil: null }
            : {}),
        },
      });
    } else if (countersToClear) {
      // Cleared by constant rather than by arithmetic on the count this request
      // read, so a guess that landed during it is never resurrected as a number
      // this request invented — only a verified master password resets the streak.
      await this.prisma.vaultSetting
        .update({
          where: { userId },
          data: { unlockFailedAttempts: 0, unlockLockedUntil: null },
        })
        .catch((err) => mapMissingRow(err, vaultNotConfigured));
    }

    return {
      success: true,
      unlockedAt: new Date(),
    };
  }

  /**
   * How long the unlock endpoint refuses after `attempts` consecutive failures,
   * or null when it still answers. Five guesses is free, then a minute, then
   * doubling to an hour. `attempts` is the count the row holds *after* this
   * request's `$inc`, which is what keeps the curve honest under parallel
   * guessing.
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
      throw vaultNotConfigured();
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

    // A logged recovery code is a credential — with the 12-word phrase it hands
    // over the wrapped master key — so it is printed only where development is
    // *declared* (`APP_ENV=development`), never merely where production is not
    // labelled, which an unset or mistyped `APP_ENV` also satisfies.
    if (this.configService.isDevelopment) {
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
        if (this.configService.isProduction) {
          throw badRequest(
            ErrorCode.VAULT_RECOVERY_UNAVAILABLE,
            "The recovery code could not be emailed. Please try again later.",
          );
        }
      }
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("could not be emailed")
      ) {
        throw err;
      }
      this.logger.error(
        `Failed to send vault recovery OTP email to ${user.email}`,
        err,
      );
      if (this.configService.isProduction) {
        throw badRequest(
          ErrorCode.VAULT_RECOVERY_UNAVAILABLE,
          "The recovery code could not be emailed. Please try again later.",
        );
      }
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
    if (!setting?.wrappedMasterKey) {
      throw noRecoveryMaterialStored();
    }
    // `recoveryKdfSalt` is the modern envelope: the client re-derives the
    // wrapping key from the phrase, so nothing here is key material. A row that
    // predates that only has the unwrapped key an old app uploaded, and its
    // owner must not be stranded by the fix — it is served as before.
    if (!setting.recoveryKdfSalt && !setting.recoveryKey) {
      throw badRequest(
        ErrorCode.VAULT_RECOVERY_UNAVAILABLE,
        "This vault's recovery material is incomplete.",
      );
    }

    // Marks the window in which completeRecovery may rewrite the vault, so a
    // bare access token is never enough to swap out the master key. The account
    // can cascade away between the read above and this write — the row owning the
    // recovery material is gone, so the answer is the one this method already
    // gives for a row with no wrap, not `P2025`'s generic 404.
    await this.prisma.vaultSetting
      .update({
        where: { userId },
        data: { recoveryGrantedAt: new Date() },
      })
      .catch((err) => mapMissingRow(err, noRecoveryMaterialStored));

    return {
      keySalt: setting.keySalt,
      recoveryKdfSalt: setting.recoveryKdfSalt,
      recoveryKey: setting.recoveryKdfSalt ? null : setting.recoveryKey,
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
      this.alreadyHolds(existing.masterKeyHash, dto.masterKeyHash) &&
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
        // A recovery writes a verifier the pepper has never seen, so it is
        // sealed and stamped under the current key: the row leaves the flow
        // readable by the rotation logic rather than joining the rows that have
        // to be guessed about.
        ...this.sealedRow(dto.masterKeyHash),
        keySalt: dto.keySalt,
        kdfIterations: dto.kdfIterations,
        kdfMemory: dto.kdfMemory,
        passwordWrappedKey: dto.passwordWrappedKey,
        passwordWrappedIv: dto.passwordWrappedIv,
        passwordWrappedTag: dto.passwordWrappedTag,
        recoveryGrantedAt: null,
        unlockFailedAttempts: 0,
        unlockLockedUntil: null,
        // The phrase-derived wrap and the plaintext key it replaces travel in
        // the same write, so a vault can never be left with neither.
        ...(dto.recoveryKdfSalt &&
        dto.wrappedMasterKey &&
        dto.wrappedMasterIv &&
        dto.wrappedMasterTag
          ? {
              recoveryKdfSalt: dto.recoveryKdfSalt,
              wrappedMasterKey: dto.wrappedMasterKey,
              wrappedMasterIv: dto.wrappedMasterIv,
              wrappedMasterTag: dto.wrappedMasterTag,
              recoveryKey: null,
            }
          : {}),
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
    ["recoveryKdfSalt", dto.recoveryKdfSalt],
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

/**
 * The verifier a client sends is a bearer secret — holding it is holding the
 * unlock. It is stored as an HMAC under a server-only key so that reading the
 * table is not reading every vault. Unlike a password hash this needs no
 * per-row salt: the input is already 256 bits of Argon2id output, so guessing
 * is not what the pepper defends against.
 */
function sealWith(key: PepperKey, verifier: string): string {
  return (
    PEPPERED_VERIFIER_PREFIX +
    createHmac("sha256", key.secret).update(verifier).digest("base64")
  );
}

/**
 * Names a pepper without trusting whoever supplied the name: an id is only a
 * label, and the fingerprint of the secret is what makes two entries of the ring
 * distinguishable when an operator sets a key and forgets the id beside it.
 */
function pepperKey(secret: string, declaredId?: string): PepperKey {
  return { id: declaredId?.trim() || secretFingerprint(secret), secret };
}

/** What a vault row that is not there reads like, from every method here. */
function vaultNotConfigured(): ReturnType<typeof notFound> {
  return notFound(
    ErrorCode.VAULT_NOT_CONFIGURED,
    "Password vault has not been configured yet.",
  );
}

function noRecoveryMaterialStored(): ReturnType<typeof badRequest> {
  return badRequest(
    ErrorCode.VAULT_RECOVERY_UNAVAILABLE,
    "This vault has no recovery material stored.",
  );
}

/**
 * Prisma answers an `update` on a row that cascaded away mid-request with
 * `P2025`, and the exception filter turns that into a generic `NOT_FOUND` body —
 * a different shape from the one the calling method already raises for the same
 * missing row, which is the shape the client branches on. Same failure, same
 * answer, same status.
 */
function mapMissingRow(err: unknown, missing: () => Error): never {
  if ((err as { code?: string } | null)?.code !== "P2025") throw err;
  throw missing();
}

/**
 * A row stamped with a pepper this process does not hold.
 *
 * 503 with a code of its own, not a 401: nothing the person typed is wrong, the
 * vault is intact, and the fix is an environment variable. A 401 would send them
 * to try the password again — five times, after which the cooldown this method
 * deliberately never reaches would lock a valid vault out of itself for an hour.
 * The stamp is the only thing named here, and a stamp is a label rather than a
 * secret.
 */
function pepperKeyUnavailable(
  pepperKeyId: string,
): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: ErrorCode.VAULT_PEPPER_KEY_UNAVAILABLE,
    message:
      "This vault is sealed under a server key that is not configured here. Nothing you entered is wrong; the service owner has to restore the retired key or you can recover the vault with your recovery code.",
    details: { pepperKeyId },
  });
}
