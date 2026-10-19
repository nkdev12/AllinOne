import {
  Injectable,
  HttpException,
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { ErrorCode } from "@/common/errors/error-code";
import {
  badRequest,
  conflict,
  unauthorized,
} from "@/common/errors/http-errors";
import { generateSecret, generateURI, verify } from "otplib";
import * as qrcode from "qrcode";
import * as crypto from "crypto";
import { PrismaService } from "@/common/prisma/prisma.service";
import { UsersService } from "@/users/users.service";
import { ConfigurationService } from "@/config/configuration.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
import { MailService } from "@/common/mail/mail.service";
import { OtpService } from "@/common/otp/otp.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { AuthResponseDto, AuthTokenDataDto } from "./dto/auth-response.dto";
import {
  EnableMfaDto,
  VerifyMfaLoginDto,
  DisableMfaDto,
  MfaSecretResponseDto,
  MfaEnableResponseDto,
} from "./dto/mfa.dto";
import { Platform, AuditAction, OtpPurpose } from "@prisma/client";
import { Session } from "@prisma/client";
import { RefreshTokenGraceStore } from "./refresh-token-grace.store";
import {
  RecoveryCodeMatch,
  RecoveryCodePepper,
  generateRecoveryCode,
  matchRecoveryCode,
  recoveryCodePepper,
  sealRecoveryCode,
} from "./recovery-code-seal";

/**
 * Static dummy Argon2id hash used to mitigate timing side-channel attacks on login
 * when an identifier does not exist. Equalizes the CPU time with valid user verification.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$kIaBk8+Q+oR/A3ovCYSv5w$K2ZLxsl53yy8Bd0dFD0j5a992udAjB47HsvqsRw+LkA";

@Injectable()
export class AuthService implements OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);
  private readonly RESET_OTP_TTL_MINUTES = 15;

  /** The raw collection the email-verification codes live in — see `spendEmailVerificationOtp`. */
  private static readonly EMAIL_OTP_COLLECTION = "email_verification_otps";

  /**
   * An email-verification code lives an hour, which is what makes it convenient to
   * type and what made it guessable: a wrong code used to leave the row exactly as
   * it found it, so the only brake was the per-IP throttler — and that throttler
   * fails open whenever Redis is unreachable. The hour now carries a guess budget
   * with it rather than outliving one.
   */
  private static readonly EMAIL_OTP_TTL_MINUTES = 60;

  /**
   * Six guesses per code, spent one at a time against the row itself.
   *
   * The budget is this flow's own number rather than `OtpService.MAX_ATTEMPTS`, and
   * not for a reason anyone should have to rediscover: the codes `OtpService`
   * governs live fifteen minutes and belong to flows that say what went wrong, while
   * this one lives an hour and answers every refusal with the same generic sentence
   * so the route stays un-enumerable. A budget set for a fifteen-minute code and
   * applied here is a code that dies on the fifth fumble of a person reading six
   * digits off another app's window, and the only remedy they can see is to ask
   * support why their address will not verify.
   *
   * What the size of the number buys is arithmetic, and it is not the interesting
   * part: six guesses out of the 900,000 values `randomInt(100000, 1000000)` issues
   * is a 1-in-150,000 chance of a lucky hit per code, where the design this replaces
   * handed the same code to roughly three hundred guesses an hour — bounded only by
   * `@Throttle(5/60s)`, which is the component that fails open when Redis is down.
   *
   * Public so the specs count the budget out instead of repeating a literal that a
   * change here would silently invalidate.
   */
  static readonly EMAIL_OTP_MAX_ATTEMPTS = 6;

  /**
   * Codes handed out per MFA enrolment. Ten is the number a user can realistically
   * print and file, and it is unchanged: the defect this fixes was never the count,
   * it was that each of the ten was worth 32 bits and was stored unsalted.
   */
  private static readonly RECOVERY_CODE_COUNT = 10;

  /**
   * Grace period window (30 seconds) during which a recently rotated refresh
   * token is accepted to tolerate concurrent client requests or network retries
   * without invalidating the session.
   */
  static readonly REFRESH_ROTATION_GRACE_MS = 30 * 1000;
  private readonly rotatedRefreshGrace: RefreshTokenGraceStore;

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigurationService,
    private readonly otpService: OtpService,
    @Optional() private readonly auditLogService?: AuditLogService,
    @Optional() private readonly mailService?: MailService,
    // The grace window is shared state, so it does not live in a field on this
    // service — but `AuthModule`'s provider list is not this file to widen, so an
    // unregistered class dependency resolves to `undefined` and the store is built
    // here unless a caller (the specs, or a future provider) brings its own.
    @Optional() graceStore?: RefreshTokenGraceStore,
  ) {
    this.rotatedRefreshGrace =
      graceStore ?? new RefreshTokenGraceStore(this.configService);
  }

  async onModuleDestroy(): Promise<void> {
    await this.rotatedRefreshGrace.close();
  }

  /**
   * A database must never hold a reusable refresh credential. The value in the
   * existing `Session.refreshToken` column is a keyed one-way digest for new
   * sessions. Keeping the field name avoids a disruptive Mongo migration;
   * legacy plaintext values are accepted once and replaced on refresh.
   */
  private hashRefreshToken(token: string): string {
    return crypto
      .createHmac("sha256", this.configService.jwtRefreshSecret)
      .update(token)
      .digest("hex");
  }

  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    const existingUser = await this.usersService.findByEmail(dto.email);
    if (existingUser) {
      throw conflict(
        ErrorCode.EMAIL_ALREADY_REGISTERED,
        "User with this email already exists",
      );
    }

    const hashedPassword = await argon2.hash(dto.password);

    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: dto.email.toLowerCase(),
            displayName: dto.displayName || null,
            locale: dto.locale || "en-US",
            timezone: dto.timezone || "UTC",
            status: "ACTIVE",
          },
        });

        await tx.authentication.create({
          data: {
            userId: user.id,
            type: "EMAIL_PASSWORD",
            identifier: dto.email.toLowerCase(),
            passwordHash: hashedPassword,
            emailVerified: false,
          },
        });

        const device = await tx.device.create({
          data: {
            userId: user.id,
            name: "Primary Web/Client Device",
            platform: Platform.WEB,
            appVersion: "1.0.0",
            publicKey: "",
          },
        });

        return { user, device };
      });
    } catch (error: any) {
      if (error.code === "P2002") {
        throw conflict(
          ErrorCode.EMAIL_ALREADY_REGISTERED,
          "User with this email already exists",
        );
      }
      throw error;
    }

    this.requestEmailVerification(result.user.email).catch((err) => {
      this.logger.error(
        `Failed to generate initial verification OTP for ${result.user.email}`,
        err,
      );
    });

    await this.auditLogService?.recordAuditLog({
      userId: result.user.id,
      action: AuditAction.ACCOUNT_CREATED,
      resourceType: "User",
      resourceId: result.user.id,
    });

    // Do not hand out credentials before a mailbox has been proven. Keeping
    // this explicit opt-out makes local development possible without making a
    // production deployment silently authenticate unverified accounts.
    const issuedSession = this.configService.emailVerifyEnabled
      ? undefined
      : await this.issueSession({
          userId: result.user.id,
          email: result.user.email,
          deviceId: result.device.id,
        });

    return {
      user: {
        id: result.user.id,
        email: result.user.email,
        displayName: result.user.displayName,
        locale: result.user.locale,
        timezone: result.user.timezone,
        status: result.user.status,
        createdAt: result.user.createdAt,
      },
      ...(issuedSession
        ? {
            tokens: issuedSession.tokens,
            sessionId: issuedSession.session.id,
            deviceId: result.device.id,
          }
        : {}),
    };
  }

  async login(
    dto: LoginDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    const authRecord = await this.prisma.authentication.findFirst({
      where: {
        identifier: dto.email.toLowerCase(),
        type: "EMAIL_PASSWORD",
      },
      include: {
        user: true,
      },
    });

    if (!authRecord || !authRecord.passwordHash) {
      // Execute dummy argon2 verification to equalize CPU timing and prevent account enumeration
      await Promise.resolve()
        .then(() => argon2.verify(DUMMY_PASSWORD_HASH, dto.password))
        .catch(() => false);

      await this.auditLogService?.recordAuditLog({
        userId: authRecord
          ? authRecord.userId
          : "00000000-0000-0000-0000-000000000000",
        action: AuditAction.LOGIN_FAILURE,
        ipAddress,
        userAgent,
        metadata: {
          email: dto.email,
          reason: "Invalid identifier or password hash",
        },
      });
      throw unauthorized(
        ErrorCode.INVALID_CREDENTIALS,
        "Invalid email or password",
      );
    }

    const user = authRecord.user;

    // Check if account is currently locked due to failed attempts
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remainingMinutes = Math.max(
        1,
        Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000),
      );
      await this.auditLogService?.recordAuditLog({
        userId: user.id,
        action: AuditAction.LOGIN_FAILURE,
        ipAddress,
        userAgent,
        metadata: {
          email: dto.email,
          reason: "Account is temporarily locked",
          lockedUntil: user.lockedUntil,
        },
      });
      throw unauthorized(
        ErrorCode.RATE_LIMITED,
        `Account is temporarily locked due to multiple failed login attempts. Please try again in ${remainingMinutes} minute(s).`,
      );
    }

    const isPasswordValid = await argon2.verify(
      authRecord.passwordHash,
      dto.password,
    );

    if (!isPasswordValid) {
      const MAX_FAILED_ATTEMPTS = 5;
      const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

      // `$inc` is applied by MongoDB inside the update itself. Reading the row,
      // adding one and writing the absolute value back let two failures arriving
      // together each store `baseline + 1`, so a retry storm or a spray from
      // several IPs silently dropped the increments this threshold is built on —
      // the one counter an attacker is trying to keep low. `select` returns the
      // row as it looks *after* the increment, so the decision below is made
      // against what is really stored and not against a number this request
      // computed for itself. `?? 0` covers rows written before the field existed
      // and are only created by this increment.
      const counted = await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: { increment: 1 } },
        select: { failedLoginAttempts: true, lockedUntil: true },
      });
      const attempts = counted?.failedLoginAttempts ?? 0;
      const isNowLocked = attempts >= MAX_FAILED_ATTEMPTS;
      let lockedUntil: Date | null = null;

      if (isNowLocked) {
        lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
        // Compare-and-swap on the `lockedUntil` this request just read: the first
        // writer to cross the threshold installs the cooldown, and one racing it
        // matches zero rows instead of stretching or replacing a window that has
        // already opened.
        await this.prisma.user.updateMany({
          where: { id: user.id, lockedUntil: counted?.lockedUntil ?? null },
          data: { lockedUntil },
        });

        await this.auditLogService?.recordAuditLog({
          userId: user.id,
          action: AuditAction.ACCOUNT_LOCKED,
          ipAddress,
          userAgent,
          metadata: {
            email: dto.email,
            attempts,
            lockedUntil,
            reason: "Maximum failed password attempts reached",
          },
        });

        this.logger.warn(
          `[AuthService] Account ${user.id} locked for 15 minutes after ${attempts} failed attempts`,
        );

        throw unauthorized(
          ErrorCode.RATE_LIMITED,
          "Account has been temporarily locked for 15 minutes due to multiple failed login attempts.",
        );
      }

      await this.auditLogService?.recordAuditLog({
        userId: user.id,
        action: AuditAction.LOGIN_FAILURE,
        ipAddress,
        userAgent,
        metadata: {
          email: dto.email,
          failedLoginAttempts: attempts,
          reason: "Password verification failed",
        },
      });

      throw unauthorized(
        ErrorCode.INVALID_CREDENTIALS,
        "Invalid email or password",
      );
    }

    if (user.status !== "ACTIVE" || user.deletedAt) {
      throw unauthorized(
        ErrorCode.ACCOUNT_DISABLED,
        "Account is disabled or pending verification",
      );
    }

    if (this.configService.emailVerifyEnabled && !user.emailVerifiedAt) {
      throw unauthorized(
        ErrorCode.EMAIL_NOT_VERIFIED,
        "Verify your email address before signing in.",
      );
    }

    // Reset failed login attempts and lockout upon successful authentication
    if (user.failedLoginAttempts > 0 || user.lockedUntil !== null) {
      // `argon2.verify` sits between the row read at the top of `login` and this
      // write, so the window in which a concurrent failure can cross the
      // threshold and install a lock is a few hundred milliseconds wide rather
      // than theoretical. Matching on the `lockedUntil` this request read is what
      // stops a slow, already-successful login from wiping the cooldown another
      // request just opened: if the value no longer matches, that lock stands and
      // this reset simply applies to zero rows.
      await this.prisma.user.updateMany({
        where: { id: user.id, lockedUntil: user.lockedUntil ?? null },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
    }

    // A desktop app keeps the device row it was handed at sign-up and asks for
    // it by id, so signing out and back in does not pile up devices. An id that
    // is unknown, revoked or owned by someone else is ignored here; the lookup
    // below still finds (or creates) a device the caller can use.
    let device = dto.deviceId
      ? await this.prisma.device.findFirst({
          where: {
            id: dto.deviceId,
            userId: user.id,
            revokedAt: null,
          },
        })
      : undefined;

    if (!device) {
      device = await this.prisma.device.findFirst({
        where: {
          userId: user.id,
          name: dto.deviceName || "Primary Client Device",
          platform: dto.platform || Platform.WEB,
          revokedAt: null,
        },
      });
    }

    if (!device) {
      device = await this.prisma.device.create({
        data: {
          userId: user.id,
          name: dto.deviceName || "Primary Client Device",
          platform: dto.platform || Platform.WEB,
          appVersion: dto.appVersion || "1.0.0",
          publicKey: dto.publicKey || "",
        },
      });
    }

    const mfaSetting = await this.prisma.mFASetting.findUnique({
      where: { userId: user.id },
    });

    if (mfaSetting && mfaSetting.totpEnabled && mfaSetting.totpSecret) {
      const mfaToken = this.jwtService.sign(
        {
          sub: user.id,
          email: user.email,
          deviceId: device.id,
          purpose: "MFA_CHALLENGE",
          type: "mfa_challenge",
        },
        { secret: this.configService.jwtMfaSecret, expiresIn: "5m" },
      );

      return {
        mfaRequired: true,
        mfaToken,
      };
    }

    const { tokens, session } = await this.issueSession({
      userId: user.id,
      email: user.email,
      deviceId: device.id,
      ipAddress,
      userAgent,
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.auditLogService?.recordAuditLog({
      userId: user.id,
      action: AuditAction.LOGIN_SUCCESS,
      ipAddress,
      userAgent,
      metadata: { deviceId: device.id },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        locale: user.locale,
        timezone: user.timezone,
        status: user.status,
        createdAt: user.createdAt,
      },
      tokens,
      sessionId: session.id,
      deviceId: device.id,
    };
  }

  /**
   * The account-status gate `login` applies, on every path that can still mint.
   *
   * `User.status` and `deletedAt` change long after a session opens, and a
   * refresh credential lives for `JWT_REFRESH_EXPIRATION` — days — so a gate that
   * runs only at login leaves a suspended, deleted or still-pending account
   * minting fresh access tokens for the whole lifetime of a session it no longer
   * qualifies for. Every revocation and deactivation flow assumes the gate is on
   * the mint, not on the memory of one.
   */
  private isBlockedAccount(
    user: {
      status?: string;
      deletedAt?: Date | null;
    } | null,
  ): boolean {
    // A user that could not be read denies rather than passes: this is the one
    // place where a missing relation must not default to "still signed in".
    return !user || user.status !== "ACTIVE" || Boolean(user.deletedAt);
  }

  async refreshTokens(
    dto: RefreshTokenDto,
  ): Promise<{ tokens: AuthTokenDataDto; deviceId: string }> {
    try {
      if (!dto.refreshToken) {
        throw unauthorized(
          ErrorCode.TOKEN_INVALID,
          "Invalid or expired refresh token",
        );
      }
      const payload = this.jwtService.verify(dto.refreshToken, {
        secret: this.configService.jwtRefreshSecret,
      });

      // If a recently rotated token arrives within the grace window (e.g. concurrent
      // requests or network retries), return the already generated active tokens.
      // The window is read from shared storage rather than this process, so a
      // replay routed to a different replica is recognised as the same reuse.
      const graceRecord = await this.rotatedRefreshGrace.get(dto.refreshToken);
      if (graceRecord) {
        const session = await this.prisma.session.findUnique({
          where: { id: graceRecord.sessionId },
          select: {
            id: true,
            revokedAt: true,
            refreshExpiresAt: true,
            // The window hands back a minted pair without touching the rotation,
            // so it needs the account gate as much as the mint path below does.
            user: { select: { status: true, deletedAt: true } },
          },
        });
        if (
          session &&
          !session.revokedAt &&
          session.refreshExpiresAt > new Date()
        ) {
          if (this.isBlockedAccount(session.user)) {
            throw unauthorized(
              ErrorCode.TOKEN_INVALID,
              "Invalid or expired refresh token",
            );
          }
          this.logger.log(
            `[AuthService] Reused rotated refresh token within grace period for session ${graceRecord.sessionId}. Returning active tokens.`,
          );
          return { tokens: graceRecord.tokens, deviceId: graceRecord.deviceId };
        }
      }

      const refreshTokenHash = this.hashRefreshToken(dto.refreshToken);
      let session = await this.prisma.session.findUnique({
        where: { refreshToken: refreshTokenHash },
        include: { user: true },
      });

      // Existing sessions created before token-at-rest hardening contain the
      // raw token. Allow a single compatibility read so the next successful
      // refresh rotates it into the digest-only representation.
      if (!session) {
        session = await this.prisma.session.findUnique({
          where: { refreshToken: dto.refreshToken },
          include: { user: true },
        });
      }

      if (!session) {
        // No row holds this credential: it is either garbage or a token this
        // service rotated and replaced. The marker distinguishes the two.
        await this.reportConfirmedRefreshTokenReuse(dto.refreshToken);
        throw unauthorized(
          ErrorCode.TOKEN_INVALID,
          "Invalid or expired refresh token",
        );
      }

      if (
        session.revokedAt ||
        session.refreshExpiresAt < new Date() ||
        session.userId !== payload.sub
      ) {
        throw unauthorized(
          ErrorCode.TOKEN_INVALID,
          "Invalid or expired refresh token",
        );
      }

      // Refusing here rather than at login is the whole point: `/auth/refresh` is
      // unauthenticated, so the answer must be the same opaque 401 an unknown
      // token gets. Naming "suspended" would hand whoever holds a stolen cookie
      // the news that the account behind it is disabled.
      if (this.isBlockedAccount(session.user)) {
        throw unauthorized(
          ErrorCode.TOKEN_INVALID,
          "Invalid or expired refresh token",
        );
      }

      const tokens = await this.generateTokens(
        session.userId,
        session.user.email,
        session.id,
      );

      const accessExpiresAt = new Date(
        Date.now() + this.configService.jwtAccessExpiresInSeconds * 1000,
      );
      const refreshExpiresAt = new Date(
        Date.now() + this.configService.jwtRefreshExpiresInSeconds * 1000,
      );

      await this.prisma.session.update({
        where: { id: session.id },
        data: {
          // Access tokens are self-validating JWTs and do not need to be
          // retained. The session id is non-secret and preserves this legacy
          // required, unique field until a schema migration can remove it.
          accessToken: session.id,
          refreshToken: this.hashRefreshToken(tokens.refreshToken),
          accessExpiresAt,
          refreshExpiresAt,
          lastActivityAt: new Date(),
        },
      });

      // Keep previous refresh token's rotated pair available for a short window
      // so a concurrent request on any worker is answered instead of rejected.
      await this.rotatedRefreshGrace.set(
        dto.refreshToken,
        {
          tokens,
          deviceId: session.deviceId,
          sessionId: session.id,
          userId: session.userId,
        },
        AuthService.REFRESH_ROTATION_GRACE_MS,
      );

      // A second, longer-lived record: the presented credential is now one that
      // this service rotated. The 30-second window above forgives a lagging
      // client; this is what makes a copy that turns up after the window
      // readable as theft instead of as a random invalid token.
      await this.rotatedRefreshGrace.markRotated(
        dto.refreshToken,
        { sessionId: session.id, userId: session.userId },
        this.configService.jwtRefreshExpiresInSeconds * 1000,
      );

      // The session row knows which device it was opened on, so a client that
      // lost its saved device id gets it back here instead of having to sign in
      // again before /sync/* will accept it.
      return { tokens, deviceId: session.deviceId };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error("Failed to refresh tokens", error);
      throw unauthorized(
        ErrorCode.TOKEN_INVALID,
        "Invalid or expired refresh token",
      );
    }
  }

  /**
   * Decide whether a credential no row holds is a replay of a rotated token, and
   * shut that family down.
   *
   * Three things this refuses to do: answer the request, tell the caller which of
   * them it detected, or let a store outage turn either outcome into a 500. No
   * marker is readable when Redis is down — `getRotationMarker` answers "no
   * record" and then throws nothing — so the presented token is refused as
   * unknown and no revocation happens on the strength of a read that did not.
   */
  private async reportConfirmedRefreshTokenReuse(
    refreshToken: string,
  ): Promise<void> {
    const marker =
      await this.rotatedRefreshGrace.getRotationMarker(refreshToken);
    if (!marker) return;

    const reused = await this.prisma.session.findUnique({
      where: { id: marker.sessionId },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        ipAddress: true,
        userAgent: true,
      },
    });

    // Already shut down by logout, device revocation or a password reset, or the
    // row is gone with the account. The replay is refused below exactly as any
    // other invalid token, and incident response is not told twice about a reuse
    // whose first warning is already in the log.
    if (!reused || reused.revokedAt) {
      return;
    }

    // Warn before the write: the alert is the point of this function, and a
    // revocation that throws must not take it down with the request.
    this.logger.warn(
      `[AuthService] CONFIRMED refresh-token reuse: user ${reused.userId} session ${reused.id} (ip=${
        reused.ipAddress ?? "unknown"
      }, ua=${
        reused.userAgent ?? "unknown"
      }) presented a token this service had already rotated, outside the grace window. A second holder of the credential exists; every session for the user is being revoked.`,
    );

    // No family column, so the reused row is the only handle on the lineage —
    // and it *is* the lineage, since rotation rewrites this row rather than
    // creating one. Going on to the user's other sessions is the response
    // `resetPassword` already documents for "make the credentials this account
    // holds unusable": access tokens are self-validating JWTs, so revoking the
    // rows is the only thing that stops a second holder from refreshing into them.
    await this.prisma.session.updateMany({
      where: { userId: reused.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async logout(sessionId: string): Promise<{ success: boolean }> {
    if (!sessionId) {
      throw new BadRequestException("Session ID required");
    }

    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Invalidate any grace records associated with this session
    await this.rotatedRefreshGrace.deleteForSession(sessionId);

    return { success: true };
  }

  async requestEmailVerification(email: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);
    if (user && !user.emailVerifiedAt) {
      const otp = crypto.randomInt(100000, 1000000).toString();
      const codeHash = crypto.createHash("sha256").update(otp).digest("hex");
      const expiresAt = new Date(
        Date.now() + AuthService.EMAIL_OTP_TTL_MINUTES * 60 * 1000,
      );

      await this.prisma.$runCommandRaw({
        update: AuthService.EMAIL_OTP_COLLECTION,
        updates: [
          {
            q: { userId: user.id },
            u: {
              // The counter is reset here rather than left to carry over, the same
              // way `OtpService.issue` resets it: a re-mint hands out a brand-new
              // code, and guesses spent against the code that came before it would
              // otherwise be taken out of this one's budget before its owner had
              // typed a digit.
              //
              // `maxAttempts` travels with it as a record of the budget this code was
              // minted with — the way a `VaultSetting` stores the KDF parameters it
              // was created under, which the server never reads to configure
              // anything. It is deliberately not the bound: `spendEmailVerificationOtp`
              // compares against the constant, so a document that claimed a larger
              // budget would be a field a write bug could use to talk its way out of
              // the counter.
              $set: {
                codeHash,
                expiresAt,
                attempts: 0,
                maxAttempts: AuthService.EMAIL_OTP_MAX_ATTEMPTS,
              },
              $setOnInsert: { userId: user.id, createdAt: new Date() },
            },
            upsert: true,
          },
        ],
      });

      // A printed OTP is a live, single-use login credential for the next 60
      // minutes, so it reaches the console only when the operator has declared
      // `APP_ENV=development` by name. The old gate was `!isProduction`, which is
      // a different test: a staging box, a mislabelled deployment, a container
      // that never read `APP_ENV`, or a `.env` whose later `APP_ENV=production`
      // line lost the tie-up all fell through it and kept printing codes.
      // Development is now something to opt into, never something inferred from
      // the absence of a production label. Everywhere else the log records that a
      // code exists and whom it went to, which is the question support asks, and
      // never which code, which is the question an attacker asks.
      if (this.configService.isDevelopment) {
        this.logger.debug(
          `OTP CODE FOR ${user.email}: ${otp} (expires in ${AuthService.EMAIL_OTP_TTL_MINUTES} minutes)`,
        );
      } else {
        this.logger.debug(
          `Verification OTP issued for ${user.email} (expires in ${AuthService.EMAIL_OTP_TTL_MINUTES} minutes)`,
        );
      }

      // Send the OTP to the candidate's email address.
      try {
        const sent = await this.mailService?.sendOtpEmail(user.email, otp);
        if (!sent) {
          this.logger.warn(
            `OTP email could not be delivered to ${user.email}. Check SMTP configuration.`,
          );
        }
      } catch (err) {
        this.logger.error(`Failed to send OTP email to ${user.email}`, err);
      }
    }

    return {
      message:
        "If the account exists, a verification code has been sent to the email address.",
    };
  }

  async confirmEmailVerification(
    token: string | undefined,
    email?: string,
    otp?: string,
  ): Promise<{ message: string }> {
    if (email && otp) {
      const user = await this.usersService.findByEmail(email);
      // One answer for "no such account", "wrong code", "spent code" and "expired
      // code". This route is unauthenticated, and the failure it reports is a
      // statement about an address the caller typed, so the shape of a refusal is
      // the enumeration this endpoint would otherwise hand out.
      if (!user) {
        throw badRequest(ErrorCode.OTP_INVALID, "Invalid or expired OTP");
      }

      if (!(await this.spendEmailVerificationOtp(user.id, otp))) {
        throw badRequest(ErrorCode.OTP_INVALID, "Invalid or expired OTP");
      }

      // Deliberately not wrapped in a `catch` that re-raises it as a bad
      // credential: the code is already spent by the line above, so a write that
      // fails here is a server fault that has to surface as one. Answering
      // "invalid or expired" would send the user back to a code that no longer
      // exists and hide the account that never got marked verified.
      return this.setEmailVerified(user.id);
    }

    if (token) {
      let userId: string;
      try {
        const payload = this.jwtService.verify(token, {
          secret: this.configService.jwtAccessSecret,
        });

        if (payload.purpose !== "EMAIL_VERIFICATION") {
          throw badRequest(
            ErrorCode.TOKEN_INVALID,
            "Invalid verification token type",
          );
        }
        userId = payload.sub;
      } catch (error) {
        this.logger.error("Failed to confirm email verification", error);
        throw badRequest(
          ErrorCode.TOKEN_INVALID,
          "Invalid or expired email verification token",
        );
      }

      return this.setEmailVerified(userId);
    }

    throw badRequest(
      ErrorCode.VALIDATION_ERROR,
      "Must provide either a token or email and OTP",
    );
  }

  /**
   * Spends an email-verification code, and costs the sender one of the
   * `EMAIL_OTP_MAX_ATTEMPTS` guesses whether the code was right or not.
   *
   * This flow does not ride on `OtpService`, which is otherwise the right answer
   * for a bounded single-use code, because the model behind it cannot express
   * "email verification for this user": `OtpToken.purpose` is the `OtpPurpose` enum
   * and its only members are `PASSWORD_RESET` and `VAULT_RECOVERY`, so an
   * `EMAIL_VERIFICATION` purpose is a schema edit and a `db push` — and borrowing
   * `PASSWORD_RESET` instead would put two flows on the one row the composite
   * `userId`/`purpose` key allows, making a verification code a password reset code
   * and the other way round. The raw collection this flow already writes has the
   * same three fields `OtpService` leans on (`userId`, `codeHash`, `expiresAt`) and
   * now carries the counter as a fourth, so the bound is that service's shape — a
   * count held on the row and decremented inside the write — with this flow's window
   * deciding the number.
   *
   * Two commands, each atomic by itself, and neither one a read of the budget
   * followed by a write computed from it:
   *
   * 1. the claim — a conditional delete whose filter is the code itself, so a wrong
   *    guess matches nothing and only the request whose `findAndModify` hands back a
   *    document can say "verified";
   * 2. the burn — an `$inc` that runs when, and only when, the claim matched nothing.
   *
   * The order of those two is the part worth stating, because it is the whole of the
   * fix: burning first and claiming second would charge a guess to the request that
   * succeeds, and — once the last allowed burn deletes the row — would delete it
   * before the correct code inside the same request ever got compared. Claiming first
   * keeps the happy path to one write and keeps "budget spent" the only way a code
   * dies before its hour is up.
   *
   * The claim's filter carries every bound at once, which is what makes a spent row,
   * an expired row and an exhausted row answer the same `null` as a wrong code. The
   * `attempts` bound is in it even though the last burn deletes the row, because a
   * delete that failed is exactly the state in which a code that is still correct has
   * no guesses left to spend.
   */
  private async spendEmailVerificationOtp(
    userId: string,
    otp: string,
  ): Promise<boolean> {
    const codeHash = crypto
      .createHash("sha256")
      .update(otp.trim())
      .digest("hex");

    /**
     * A row minted before this counter existed carries no `attempts` field at all,
     * and MongoDB's comparison operators never match a document that is missing the
     * field they compare — so `$lt` alone would refuse every code issued in the hour
     * before this deploy. `attempts` absent therefore reads as "no guesses spent",
     * which is what it is.
     */
    const budgetIntact = {
      $or: [
        { attempts: { $lt: AuthService.EMAIL_OTP_MAX_ATTEMPTS } },
        { attempts: { $exists: false } },
      ],
    };

    const claimed = (await this.prisma.$runCommandRaw({
      findAndModify: AuthService.EMAIL_OTP_COLLECTION,
      query: {
        userId,
        codeHash,
        expiresAt: { $gt: new Date() },
        ...budgetIntact,
      },
      remove: true,
    })) as { value?: { _id?: unknown } | null };

    if (claimed?.value) return true;

    const burned = (await this.prisma.$runCommandRaw({
      findAndModify: AuthService.EMAIL_OTP_COLLECTION,
      query: { userId, expiresAt: { $gt: new Date() }, ...budgetIntact },
      update: { $inc: { attempts: 1 } },
      new: true,
      fields: { attempts: 1 },
    })) as { value?: { attempts?: number } | null };

    if (!burned?.value) {
      // Nothing live to burn. An expired row still sitting there is deleted rather
      // than left answerable, the way `OtpService.consume` deletes one it reads as
      // out of its window: a row a later request can probe is a budget a later
      // request gets.
      await this.prisma.$runCommandRaw({
        delete: AuthService.EMAIL_OTP_COLLECTION,
        deletes: [{ q: { userId, expiresAt: { $lte: new Date() } }, limit: 0 }],
      });
      return false;
    }

    if ((burned.value.attempts ?? 0) >= AuthService.EMAIL_OTP_MAX_ATTEMPTS) {
      // A `delete` with `limit: 0`, not a second `findAndModify`, because the raw
      // upsert that mints these codes has no unique index behind it to make it
      // exclusive: two concurrent requests for one account can leave two live
      // documents, and exhausting the budget has to take all of them with it rather
      // than leaving a second row with a budget of its own.
      await this.prisma.$runCommandRaw({
        delete: AuthService.EMAIL_OTP_COLLECTION,
        deletes: [{ q: { userId }, limit: 0 }],
      });
    }

    return false;
  }

  /**
   * Records the verification a caller has just proven. Reached once per code, since
   * the spend above is what gates it and a replay of the same code never gets here.
   */
  private async setEmailVerified(userId: string): Promise<{ message: string }> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });

    await this.prisma.authentication.updateMany({
      where: { userId, type: "EMAIL_PASSWORD" },
      data: { emailVerified: true },
    });

    return { message: "Email address successfully verified" };
  }

  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);
    if (user) {
      const otp = await this.otpService.issue(
        user.id,
        OtpPurpose.PASSWORD_RESET,
        this.RESET_OTP_TTL_MINUTES,
      );

      // A reset code alone re-owns the account once the mailbox is read, so it
      // gets the same treatment as the verification code: plaintext only where
      // `APP_ENV` names development, and elsewhere only the fact that one was
      // issued. This line used to sit under `!isProduction`, the permissive gate.
      if (this.configService.isDevelopment) {
        this.logger.debug(`PASSWORD RESET OTP FOR ${user.email}: ${otp}`);
      } else {
        this.logger.debug(`Password reset OTP issued for ${user.email}`);
      }

      try {
        const sent = await this.mailService?.sendPasswordResetOtpEmail(
          user.email,
          otp,
        );
        if (!sent) {
          this.logger.warn(
            `Password reset OTP could not be delivered to ${user.email}. Check SMTP configuration.`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Failed to send password reset OTP email to ${user.email}`,
          err,
        );
      }
    }

    return {
      message:
        "If the account exists, password reset instructions have been sent to the email address.",
    };
  }

  async resetPassword(
    email: string,
    otp: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      throw badRequest(
        ErrorCode.OTP_INVALID,
        "Invalid or expired verification code",
      );
    }

    const verified = await this.otpService.consume(
      user.id,
      OtpPurpose.PASSWORD_RESET,
      otp,
    );
    if (!verified) {
      throw badRequest(
        ErrorCode.OTP_INVALID,
        "Invalid or expired verification code",
      );
    }

    const hashedPassword = await argon2.hash(newPassword);

    const auth = await this.prisma.authentication.updateMany({
      where: { userId: user.id, type: "EMAIL_PASSWORD" },
      data: { passwordHash: hashedPassword },
    });
    if (auth.count === 0) {
      throw new BadRequestException(
        "No password-based authentication record found for this account.",
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    // No token-version column, so the only way to make old access tokens
    // unusable is to revoke the sessions that carry them.
    await this.prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.auditLogService?.recordAuditLog({
      userId: user.id,
      action: AuditAction.PASSWORD_CHANGED,
    });

    return {
      message:
        "Password successfully reset. Please log in with your new password.",
    };
  }

  /**
   * A checked-in fallback key is worse than a hard failure here, and the reason
   * is that it fails invisibly: enrolment succeeds, verification succeeds, the
   * operator sees nothing wrong, and every TOTP secret in the database is
   * decryptable by anyone who can read the repository — 2FA becomes decoration
   * while looking like 2FA. Refusing to proceed is the only way a missing key
   * arrives as an outage instead of a quiet weakening.
   *
   * The emptiness test trims, but the bytes fed into the KDF do not: a value with
   * surrounding whitespace was hashed as-is before, and trimming it here would
   * silently re-derive a different key and strand the secrets already sealed
   * under it.
   */
  private getTotpEncryptionKey(): Buffer {
    const rawKey = this.configService.encryptionKey;
    if (!rawKey?.trim()) {
      this.logger.error(
        "[AuthService] ENCRYPTION_KEY is unset or blank, so TOTP secrets can be neither encrypted nor decrypted. Set ENCRYPTION_KEY to a unique secret of at least 32 characters; there is no default and there never will be one.",
      );
      throw new InternalServerErrorException(
        "Two-factor authentication is unavailable on this server: ENCRYPTION_KEY is not configured.",
      );
    }
    return crypto.createHash("sha256").update(rawKey).digest();
  }

  /**
   * The keys a stored secret may have been sealed under, current first.
   *
   * The mirror of the vault's pepper ring, and for the same reason: a secret can
   * only be converted on a verification that presents it, so the retired key has to
   * stay tryable for as long as any row still holds its ciphertext. Deriving only
   * the current key made rotating `ENCRYPTION_KEY` equivalent to deleting everyone's
   * second factor — codes failed forever, and each failure burned a lockout attempt.
   *
   * The retired key is hashed over the untrimmed value too, and resolved outside the
   * caller's `try`, so a missing `ENCRYPTION_KEY` still surfaces as the deployment
   * fault it is instead of degrading into "the code you typed is wrong" — and never
   * falls back to the retired key to keep the current one's absence quiet.
   */
  private getTotpEncryptionKeyRing(): Buffer[] {
    const ring = [this.getTotpEncryptionKey()];
    const previous = this.configService.encryptionKeyPrevious;
    if (previous) {
      ring.push(crypto.createHash("sha256").update(previous).digest());
    }
    return ring;
  }

  private encryptTotpSecret(secret: string): string {
    const key = this.getTotpEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
  }

  private async decryptTotpSecret(
    stored: string,
    userId: string,
  ): Promise<string> {
    if (!stored.startsWith("v1:")) {
      // Backward compatibility for existing plaintext / unencrypted secrets
      return stored;
    }
    const parts = stored.split(":");
    if (parts.length !== 4) {
      return stored;
    }
    const [, ivHex, tagHex, dataHex] = parts;
    // Resolved before the `try`: a missing key is a deployment fault, and letting
    // the handler below swallow it would report a broken server to the client as
    // "the code you typed is wrong" — then return the ciphertext as if it were a
    // secret and let otplib fail against that.
    const ring = this.getTotpEncryptionKeyRing();

    let plaintext: string | undefined;
    let openedUnderCurrentKey = false;
    let lastError: unknown;
    for (const [index, key] of ring.entries()) {
      try {
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(ivHex, "hex"),
        );
        decipher.setAuthTag(Buffer.from(tagHex, "hex"));
        const decrypted = Buffer.concat([
          decipher.update(Buffer.from(dataHex, "hex")),
          decipher.final(),
        ]);
        plaintext = decrypted.toString("utf8");
        openedUnderCurrentKey = index === 0;
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (plaintext === undefined) {
      // Unchanged fallback: nothing in the ring opened this blob, so it is handed
      // back as it was found and the caller reports a wrong code. Newly throwing
      // here would turn a corrupt or foreign row into a 500 on the login path.
      this.logger.error("Failed to decrypt TOTP secret", lastError);
      return stored;
    }

    if (!openedUnderCurrentKey) {
      await this.resealTotpSecret(userId, plaintext);
    }
    return plaintext;
  }

  /**
   * Move a secret that opened under the retired key onto the current one, the way a
   * vault row re-seals on unlock: a successful verification is the only moment the
   * plaintext is in hand, and rewriting it is what drains the rotation window
   * instead of leaving every future sign-in to try two keys indefinitely — which is
   * also how a retired key ever gets cleared from the environment at all.
   *
   * Best-effort on purpose. The code just verified, so a write that fails here (a
   * row deleted since the read, a transient error) must not fail the sign-in the
   * user has already earned; the row stays sealed under the retired key and converts
   * on the next verification.
   */
  private async resealTotpSecret(
    userId: string,
    secret: string,
  ): Promise<void> {
    try {
      await this.prisma.mFASetting.update({
        where: { userId },
        data: { totpSecret: this.encryptTotpSecret(secret) },
      });
    } catch (err) {
      this.logger.error(
        `Failed to re-seal the TOTP secret for user ${userId} under the current ENCRYPTION_KEY. It remains sealed under the retired key; keep ENCRYPTION_KEY_PREVIOUS set until it converts.`,
        err,
      );
    }
  }

  async generateMfaSecret(userId: string): Promise<MfaSecretResponseDto> {
    const user = await this.usersService.getUserById(userId);
    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    const secret = generateSecret();
    const otpauthUrl = generateURI({
      secret,
      label: user.email,
      issuer: "Allinone",
    });
    const qrCodeDataUrl = await qrcode.toDataURL(otpauthUrl);

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.mFASetting.findUnique({ where: { userId } });
      if (existing?.totpEnabled) {
        throw new BadRequestException(
          "Disable existing MFA with your password and current code before replacing it",
        );
      }
      await tx.mFASetting.upsert({
        where: { userId },
        create: {
          userId,
          totpSecret: this.encryptTotpSecret(secret),
          totpEnabled: false,
        },
        update: {
          totpSecret: this.encryptTotpSecret(secret),
          totpEnabled: false,
        },
      });
    });

    return {
      secret,
      otpauthUrl,
      qrCodeDataUrl,
    };
  }

  async enableMfa(
    userId: string,
    dto: EnableMfaDto,
  ): Promise<MfaEnableResponseDto> {
    const mfaSetting = await this.prisma.mFASetting.findUnique({
      where: { userId },
    });

    if (!mfaSetting || !mfaSetting.totpSecret) {
      throw new BadRequestException(
        "MFA secret not generated. Call /auth/mfa/generate first.",
      );
    }

    const verifyRes = await verify({
      token: dto.totpCode,
      secret: await this.decryptTotpSecret(mfaSetting.totpSecret, userId),
    });
    const isValid = Boolean(
      verifyRes &&
      (typeof verifyRes === "boolean" ? verifyRes : (verifyRes as any).valid),
    );

    if (!isValid) {
      throw new BadRequestException("Invalid TOTP verification code");
    }

    const rawRecoveryCodes: string[] = [];
    const sealedRecoveryCodes: string[] = [];

    // The pepper is resolved before anything is minted, and a missing
    // `ENCRYPTION_KEY` is allowed to fail this request: sealing the new codes bare
    // would write rows weaker than the ones they replace, quietly, on the one call
    // whose whole job is to make the second factor stronger.
    const pepper = this.currentRecoveryCodePepper();

    // 96 bits apiece (`generateRecoveryCode`), which is the point of this loop: the
    // codes a leaked row used to describe were 32 bits each and digested with no
    // key, so ten of them were seconds of offline work and the five-guess lockout on
    // the login path was only ever limiting the online half of the attack. Storing
    // the keyed digest is what makes that lockout the actual budget.
    for (let i = 0; i < AuthService.RECOVERY_CODE_COUNT; i++) {
      const code = generateRecoveryCode();
      rawRecoveryCodes.push(code);
      sealedRecoveryCodes.push(sealRecoveryCode(code, pepper));
    }

    await this.prisma.mFASetting.update({
      where: { userId },
      data: {
        totpEnabled: true,
        recoveryCodes: JSON.stringify(sealedRecoveryCodes),
        backupCodesUsed: JSON.stringify([]),
        lastVerifiedAt: new Date(),
      },
    });

    await this.auditLogService?.recordAuditLog({
      userId,
      action: AuditAction.MFA_ENABLED,
    });

    return {
      recoveryCodes: rawRecoveryCodes,
    };
  }

  /**
   * The pepper new recovery codes are sealed under, and the name they are stamped
   * with. Separate from the vault's copy of this idea only because
   * `VaultSettingsService`'s helpers are module-private; the getters it reads are
   * the same four, so one `ENCRYPTION_KEY` rotation moves both.
   */
  private currentRecoveryCodePepper(): RecoveryCodePepper {
    return recoveryCodePepper(
      this.configService.encryptionKey,
      this.configService.encryptionKeyId,
    );
  }

  /**
   * The peppers a stored code may have been sealed under, current first — the same
   * dual-key window `getTotpEncryptionKeyRing` and the vault walk.
   *
   * A recovery code is a digest, so a rotation cannot convert a row offline and
   * cannot convert the live entries online either: spending a code deletes it, and
   * the plaintext of the entries beside it is never in hand to re-seal them — only
   * the one entry a redemption actually touches can be converted, which is what
   * `spentRecoveryCodeEntry` does for the spent marker. The ring is therefore the
   * whole of the mitigation for the live list, and `ENCRYPTION_KEY_PREVIOUS`
   * has to stay set until every account has re-enabled MFA at least once — which is
   * what a stamped entry makes possible to check, rather than discovering it by
   * failing to match.
   */
  private getRecoveryCodePepperRing(): RecoveryCodePepper[] {
    const current = this.currentRecoveryCodePepper();
    const previous = this.configService.encryptionKeyPrevious;
    if (!previous) {
      return [current];
    }

    return [
      current,
      recoveryCodePepper(previous, this.configService.encryptionKeyPreviousId),
    ];
  }

  /**
   * `getRecoveryCodePepperRing` with the deployment fault separated from the
   * answer.
   *
   * An unset `ENCRYPTION_KEY` throws from the configuration getter, and on this
   * path throwing would report our outage as "wrong recovery code" — then count
   * itself into the five failures that lock the account. A row of legacy digests
   * needs no pepper at all and still opens, so the empty ring is what an unkeyed
   * deployment redeems against; the error is logged, because it is exactly the kind
   * of failure that is invisible otherwise.
   */
  private recoveryCodePepperRingOrEmpty(userId: string): RecoveryCodePepper[] {
    try {
      return this.getRecoveryCodePepperRing();
    } catch (err) {
      this.logger.error(
        `[AuthService] Recovery codes sealed under a pepper cannot be checked for user ${userId}: ENCRYPTION_KEY is not configured. Legacy unsealed codes still redeem; set the key.`,
        err,
      );
      return [];
    }
  }

  private async redeemRecoveryCode(
    userId: string,
    rawCode: string,
  ): Promise<boolean> {
    const mfaSetting = await this.prisma.mFASetting.findUnique({
      where: { userId },
    });

    if (!mfaSetting || !mfaSetting.totpEnabled || !mfaSetting.recoveryCodes) {
      return false;
    }

    const recoveryCodes: string[] = JSON.parse(mfaSetting.recoveryCodes);
    const usedCodes: string[] = mfaSetting.backupCodesUsed
      ? JSON.parse(mfaSetting.backupCodesUsed)
      : [];

    const match = matchRecoveryCode(
      recoveryCodes,
      rawCode,
      this.recoveryCodePepperRingOrEmpty(userId),
    );

    if (match.strandedPepperIds.length > 0) {
      this.logger.error(
        `[AuthService] Recovery codes for user ${userId} are sealed under pepper(s) ${match.strandedPepperIds.join(", ")} which this process does not hold. Set ENCRYPTION_KEY_PREVIOUS (and ENCRYPTION_KEY_PREVIOUS_ID) to the retired key, or the owner must re-enable MFA to get new codes.`,
      );
    }

    // Nothing matched, or the code that matches is one this account has already
    // spent. The used list holds the digests, not the codes, because the codes are
    // never stored.
    if (match.index === -1) {
      return false;
    }

    const spentCode = recoveryCodes[match.index];
    if (usedCodes.includes(spentCode)) {
      return false;
    }

    recoveryCodes.splice(match.index, 1);
    usedCodes.push(
      this.spentRecoveryCodeEntry(match, rawCode, spentCode, userId),
    );

    // Spend the code with a compare-and-swap rather than by writing back an array
    // this request built from its own snapshot. A Mongo transaction does not lock
    // the document against a concurrent reader of the same shape, so two redeems
    // — of the same code or of two different ones — each wrote the list they had
    // read, and the loser's write resurrected the code the winner had just spent
    // while reverting its bookkeeping. Pinning both arrays in the `where` makes
    // the second writer match zero rows instead of rewriting the document, which
    // is also why the `$transaction` around the old version no longer earns its
    // keep: nothing else in that callback read or wrote through `tx`.
    const spent = await this.prisma.mFASetting.updateMany({
      where: {
        userId,
        recoveryCodes: mfaSetting.recoveryCodes,
        // `backupCodesUsed` is nullable, and a document nobody has spent from yet
        // reads as `null`. `?? null` keeps the guard pinning that exact state —
        // the connector treats it as "still absent or null", the same way the
        // `lockedUntil` compare-and-swaps in this file do — instead of dropping
        // the second half of the guard for the sake of a normalised literal.
        backupCodesUsed: mfaSetting.backupCodesUsed ?? null,
      },
      data: {
        recoveryCodes: JSON.stringify(recoveryCodes),
        backupCodesUsed: JSON.stringify(usedCodes),
        lastVerifiedAt: new Date(),
      },
    });

    // Anything but exactly one row is a document that moved between the read and
    // this write: the attempt is refused, and the code is not marked spent by a
    // write that did not happen.
    return spent.count === 1;
  }

  /**
   * The digest the spent list records for a redeemed code, which is the same
   * digest the row held — unless the row held it in the pre-pepper form.
   *
   * A spent code leaves the live list and reappears only here, so this is the one
   * place an old entry can be converted: redemption is the only moment the
   * plaintext exists to re-digest under the pepper, and the compare-and-swap above
   * is the only statement that can carry both halves of the change. Upgrading it
   * matters because a bare `sha256` of a legacy code is a 32-bit puzzle whoever
   * reads the row can work through offline, and a row whose owner has been using
   * their codes for a year holds up to ten of them in this field alone — the fix
   * would leave a second crackable set in the very document it set out to make
   * worthless.
   *
   * Exactly one entry moves per redemption, because the entries beside it are
   * digests of codes nobody has typed: there is nothing to seal them from. That is
   * why the fallback comparison stays in `matchRecoveryCode` rather than becoming
   * a migration — the row drains one entry at a time, and `disableMfa` clears both
   * arrays outright, so the last legacy digest is gone the moment its owner
   * re-enrols.
   *
   * An entry already sealed is written back untouched, including one sealed under
   * a pepper in the rotation window rather than the current one: the spent list is
   * a record of what was presented, and re-stamping it under a different key would
   * make it claim to have been made by a key that never made it.
   */
  private spentRecoveryCodeEntry(
    match: RecoveryCodeMatch,
    rawCode: string,
    spentEntry: string,
    userId: string,
  ): string {
    if (!match.viaLegacyDigest) {
      return spentEntry;
    }

    try {
      return sealRecoveryCode(rawCode, this.currentRecoveryCodePepper());
    } catch (err) {
      // No `ENCRYPTION_KEY`, so no pepper to move it to. Spending the code anyway
      // is the lesser harm — the alternative is refusing a second factor the row
      // still opens with, on an outage that is ours. The entry stays a bare digest,
      // which is a weaker row rather than a broken login.
      this.logger.error(
        `[AuthService] The spent recovery code for user ${userId} could not be re-recorded under a pepper because ENCRYPTION_KEY is not configured; its legacy digest stays in the used-code list. Set the key — every later redemption upgrades the entry it touches.`,
        err,
      );
      return spentEntry;
    }
  }

  async disableMfa(
    userId: string,
    dto: DisableMfaDto,
  ): Promise<{ success: boolean }> {
    const authRecord = await this.prisma.authentication.findFirst({
      where: { userId, type: "EMAIL_PASSWORD" },
    });

    if (!authRecord || !authRecord.passwordHash) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const isPasswordValid = await argon2.verify(
      authRecord.passwordHash,
      dto.password,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException("Invalid password");
    }

    const mfaSetting = await this.prisma.mFASetting.findUnique({
      where: { userId },
    });

    if (!mfaSetting || !mfaSetting.totpSecret || !mfaSetting.totpEnabled) {
      throw new BadRequestException(
        "MFA is not currently enabled for this account",
      );
    }

    if (!dto.totpCode && !dto.recoveryCode) {
      throw new BadRequestException(
        "Either a valid TOTP code or recovery code must be provided alongside your password to disable MFA",
      );
    }

    let isSecondFactorValid = false;

    if (dto.totpCode) {
      const verifyRes = await verify({
        token: dto.totpCode,
        secret: await this.decryptTotpSecret(mfaSetting.totpSecret, userId),
      });
      isSecondFactorValid = Boolean(
        verifyRes &&
        (typeof verifyRes === "boolean" ? verifyRes : (verifyRes as any).valid),
      );
    } else if (dto.recoveryCode) {
      isSecondFactorValid = await this.redeemRecoveryCode(
        userId,
        dto.recoveryCode,
      );
    }

    if (!isSecondFactorValid) {
      throw new BadRequestException(
        "Invalid TOTP verification code or recovery code",
      );
    }

    await this.prisma.mFASetting.update({
      where: { userId },
      data: {
        totpEnabled: false,
        totpSecret: null,
        recoveryCodes: null,
        backupCodesUsed: null,
      },
    });

    await this.auditLogService?.recordAuditLog({
      userId,
      action: AuditAction.MFA_DISABLED,
    });

    return { success: true };
  }

  async verifyMfaLogin(
    dto: VerifyMfaLoginDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    let payload: any;
    try {
      payload = this.jwtService.verify(dto.mfaToken, {
        secret: this.configService.jwtMfaSecret,
      });

      if (payload.purpose !== "MFA_CHALLENGE") {
        throw new UnauthorizedException("Invalid MFA token purpose");
      }
    } catch (error) {
      this.logger.error("Failed to verify MFA login token", error);
      throw unauthorized(
        ErrorCode.MFA_CHALLENGE_INVALID,
        "Invalid or expired MFA challenge token",
      );
    }

    const userId = payload.sub;
    const deviceId = payload.deviceId;

    const user = await this.usersService.getUserById(userId);
    if (!user || user.status !== "ACTIVE" || user.deletedAt) {
      throw new UnauthorizedException("User account is inactive or deleted");
    }

    if (user.lockedUntil && new Date() < new Date(user.lockedUntil)) {
      const remainingMs = new Date(user.lockedUntil).getTime() - Date.now();
      const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
      await this.auditLogService?.recordAuditLog({
        userId: user.id,
        action: AuditAction.LOGIN_FAILURE,
        ipAddress,
        userAgent,
        metadata: {
          email: user.email,
          reason: "Account is temporarily locked",
          remainingMinutes,
        },
      });
      throw unauthorized(
        ErrorCode.RATE_LIMITED,
        `Account is temporarily locked due to multiple failed login attempts. Please try again in ${remainingMinutes} minute(s).`,
      );
    }

    const mfaSetting = await this.prisma.mFASetting.findUnique({
      where: { userId },
    });

    if (!mfaSetting || !mfaSetting.totpEnabled || !mfaSetting.totpSecret) {
      throw new BadRequestException("MFA is not configured for this account");
    }

    let isCodeValid = false;

    if (dto.totpCode) {
      const verifyRes = await verify({
        token: dto.totpCode,
        secret: await this.decryptTotpSecret(mfaSetting.totpSecret, userId),
      });
      isCodeValid = Boolean(
        verifyRes &&
        (typeof verifyRes === "boolean" ? verifyRes : (verifyRes as any).valid),
      );
    } else if (dto.recoveryCode) {
      isCodeValid = await this.redeemRecoveryCode(userId, dto.recoveryCode);
    }

    if (!isCodeValid) {
      const MAX_FAILED_ATTEMPTS = 5;
      const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

      // Same shape as the password path in `login`: the increment happens inside
      // MongoDB, and the value that decides the cooldown is the one read back from
      // the updated row, so a burst of concurrent guesses against the same
      // `mfaToken` cannot each write `baseline + 1` and drop an attempt.
      const counted = await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: { increment: 1 } },
        select: { failedLoginAttempts: true, lockedUntil: true },
      });
      const attempts = counted?.failedLoginAttempts ?? 0;
      const isNowLocked = attempts >= MAX_FAILED_ATTEMPTS;
      let lockedUntil: Date | null = null;

      if (isNowLocked) {
        lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
        await this.prisma.user.updateMany({
          where: { id: user.id, lockedUntil: counted?.lockedUntil ?? null },
          data: { lockedUntil },
        });

        await this.auditLogService?.recordAuditLog({
          userId: user.id,
          action: AuditAction.ACCOUNT_LOCKED,
          ipAddress,
          userAgent,
          metadata: {
            email: user.email,
            attempts,
            lockedUntil,
            reason: "Maximum failed MFA attempts reached",
          },
        });

        this.logger.warn(
          `[AuthService] Account ${user.id} locked for 15 minutes after ${attempts} failed attempts`,
        );

        throw unauthorized(
          ErrorCode.RATE_LIMITED,
          "Account has been temporarily locked for 15 minutes due to multiple failed login attempts.",
        );
      }

      await this.auditLogService?.recordAuditLog({
        userId: user.id,
        action: AuditAction.LOGIN_FAILURE,
        ipAddress,
        userAgent,
        metadata: {
          email: user.email,
          failedLoginAttempts: attempts,
          reason: "MFA verification failed",
        },
      });

      throw unauthorized(
        ErrorCode.MFA_CODE_INVALID,
        "Invalid TOTP verification code or recovery code",
      );
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil !== null) {
      // Guarded the same way as in `login`: a code that lands while another
      // request is being locked out must not have that new lock erased.
      await this.prisma.user.updateMany({
        where: { id: user.id, lockedUntil: user.lockedUntil ?? null },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
    }

    const { tokens, session } = await this.issueSession({
      userId: user.id,
      email: user.email,
      deviceId,
      ipAddress,
      userAgent,
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        locale: user.locale,
        timezone: user.timezone,
        status: user.status,
        createdAt: user.createdAt,
      },
      tokens,
      sessionId: session.id,
      deviceId,
    };
  }

  private async generateTokens(
    userId: string,
    email: string,
    sessionId?: string,
  ): Promise<AuthTokenDataDto> {
    const basePayload = {
      sub: userId,
      email,
      ...(sessionId ? { sessionId } : {}),
    };

    // The seconds form, not the `JWT_*_EXPIRATION` string, goes to `sign()`:
    // then the `exp` stamped into the token and the `expiresIn` handed back for
    // the client to count down are the same number, and the only interpretation
    // of "15m" in the request path is the parser's. One setting, one decision,
    // three places that read it.
    const accessToken = this.jwtService.sign(
      { ...basePayload, type: "access" },
      {
        secret: this.configService.jwtAccessSecret,
        expiresIn: this.configService.jwtAccessExpiresInSeconds,
      },
    );

    const refreshToken = this.jwtService.sign(
      { ...basePayload, type: "refresh" },
      {
        secret: this.configService.jwtRefreshSecret,
        expiresIn: this.configService.jwtRefreshExpiresInSeconds,
      },
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.configService.jwtAccessExpiresInSeconds,
    };
  }

  /**
   * Open a session and mint the tokens that name it.
   *
   * The id is generated before the row exists so it can go inside the tokens:
   * `JwtStrategy` compares that claim against the row on every request, which
   * is the only thing that makes a logout land before the access token has
   * expired on its own. Tokens minted without it are never checked.
   */
  private async issueSession(data: {
    userId: string;
    email: string;
    deviceId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ tokens: AuthTokenDataDto; session: Session }> {
    const id = crypto.randomUUID();
    const tokens = await this.generateTokens(data.userId, data.email, id);
    // Derived from the same settings that minted the tokens above, so the row
    // cannot claim a lifetime the credential it stores does not have.
    const accessExpiresAt = new Date(
      Date.now() + this.configService.jwtAccessExpiresInSeconds * 1000,
    );
    const refreshExpiresAt = new Date(
      Date.now() + this.configService.jwtRefreshExpiresInSeconds * 1000,
    );

    const session = await this.prisma.session.create({
      data: {
        id,
        userId: data.userId,
        deviceId: data.deviceId,
        // Never persist bearer tokens. `accessToken` is a legacy required
        // column, so it holds the already-public session id until removed.
        accessToken: id,
        refreshToken: this.hashRefreshToken(tokens.refreshToken),
        accessExpiresAt,
        refreshExpiresAt,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
      },
    });

    return { tokens, session };
  }
}
