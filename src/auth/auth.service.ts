import {
  Injectable,
  HttpException,
  UnauthorizedException,
  BadRequestException,
  Logger,
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
import * as jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { PrismaService } from "@/common/prisma/prisma.service";
import { UsersService } from "@/users/users.service";
import { ConfigurationService } from "@/config/configuration.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
import { MailService } from "@/common/mail/mail.service";
import { OtpService } from "@/common/otp/otp.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { OAuthLoginDto } from "./dto/oauth.dto";
import { AuthResponseDto, AuthTokenDataDto } from "./dto/auth-response.dto";
import {
  EnableMfaDto,
  VerifyMfaLoginDto,
  DisableMfaDto,
  MfaSecretResponseDto,
  MfaEnableResponseDto,
} from "./dto/mfa.dto";
import { AuthType, Platform, AuditAction, OtpPurpose } from "@prisma/client";
import { Session } from "@prisma/client";

interface RotatedRefreshGraceRecord {
  tokens: AuthTokenDataDto;
  deviceId: string;
  sessionId: string;
  userId: string;
  expiresAt: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClient = new OAuth2Client();
  private appleJwksCache: { keys: any[]; fetchedAt: number } | null = null;
  private microsoftJwksCache: { keys: any[]; fetchedAt: number } | null = null;
  private readonly JWKS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly RESET_OTP_TTL_MINUTES = 15;

  /**
   * Grace period window (30 seconds) during which a recently rotated refresh
   * token is accepted to tolerate concurrent client requests or network retries
   * without invalidating the session.
   */
  static readonly REFRESH_ROTATION_GRACE_MS = 30 * 1000;
  private readonly rotatedTokensGraceMap = new Map<string, RotatedRefreshGraceRecord>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigurationService,
    private readonly otpService: OtpService,
    @Optional() private readonly auditLogService?: AuditLogService,
    @Optional() private readonly mailService?: MailService,
  ) {}

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

    const { tokens, session } = await this.issueSession({
      userId: result.user.id,
      email: result.user.email,
      deviceId: result.device.id,
    });

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
      tokens,
      sessionId: session.id,
      deviceId: result.device.id,
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
      const attempts = (user.failedLoginAttempts || 0) + 1;
      const MAX_FAILED_ATTEMPTS = 5;
      const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
      const isNowLocked = attempts >= MAX_FAILED_ATTEMPTS;
      const lockedUntil = isNowLocked
        ? new Date(Date.now() + LOCKOUT_DURATION_MS)
        : null;

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil,
        },
      });

      if (isNowLocked) {
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

    // Reset failed login attempts and lockout upon successful authentication
    if (user.failedLoginAttempts > 0 || user.lockedUntil !== null) {
      await this.prisma.user.update({
        where: { id: user.id },
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

  // ========================================================================
  // OAuth Integration (Google, Apple, Microsoft)
  // ========================================================================

  async loginWithGoogle(
    dto: OAuthLoginDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    const verified = await this.verifyGoogleToken(dto.idToken);
    return this.processOAuthLogin(
      AuthType.GOOGLE,
      verified.sub,
      verified.email,
      verified.name,
      verified.picture,
      dto,
      ipAddress,
      userAgent,
    );
  }

  async loginWithApple(
    dto: OAuthLoginDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    const verified = await this.verifyAppleToken(dto.idToken);

    return this.processOAuthLogin(
      AuthType.APPLE,
      verified.sub,
      verified.email,
      verified.name || verified.email.split("@")[0],
      undefined,
      dto,
      ipAddress,
      userAgent,
    );
  }

  async loginWithMicrosoft(
    dto: OAuthLoginDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    const verified = await this.verifyMicrosoftToken(dto.idToken);

    return this.processOAuthLogin(
      AuthType.MICROSOFT,
      verified.sub,
      verified.email,
      verified.name || verified.email.split("@")[0],
      undefined,
      dto,
      ipAddress,
      userAgent,
    );
  }

  private async getAppleJwks(): Promise<any[]> {
    const now = Date.now();
    if (
      this.appleJwksCache &&
      now - this.appleJwksCache.fetchedAt < this.JWKS_CACHE_TTL
    ) {
      return this.appleJwksCache.keys;
    }
    try {
      const res = await fetch("https://appleid.apple.com/auth/keys");
      if (!res.ok) {
        throw new Error(`Failed to fetch Apple JWKS: HTTP ${res.status}`);
      }
      const data = (await res.json()) as { keys: any[] };
      this.appleJwksCache = { keys: data.keys, fetchedAt: now };
      return data.keys;
    } catch (err: any) {
      this.logger.error("Failed to fetch Apple JWKS", err);
      if (this.appleJwksCache) {
        return this.appleJwksCache.keys;
      }
      throw new UnauthorizedException(
        "Unable to verify Apple ID token signature",
      );
    }
  }

  private async getMicrosoftJwks(): Promise<any[]> {
    const now = Date.now();
    if (
      this.microsoftJwksCache &&
      now - this.microsoftJwksCache.fetchedAt < this.JWKS_CACHE_TTL
    ) {
      return this.microsoftJwksCache.keys;
    }
    try {
      const res = await fetch(
        "https://login.microsoftonline.com/common/discovery/v2.0/keys",
      );
      if (!res.ok) {
        throw new Error(`Failed to fetch Microsoft JWKS: HTTP ${res.status}`);
      }
      const data = (await res.json()) as { keys: any[] };
      this.microsoftJwksCache = { keys: data.keys, fetchedAt: now };
      return data.keys;
    } catch (err: any) {
      this.logger.error("Failed to fetch Microsoft JWKS", err);
      if (this.microsoftJwksCache) {
        return this.microsoftJwksCache.keys;
      }
      throw new UnauthorizedException(
        "Unable to verify Microsoft ID token signature",
      );
    }
  }

  async verifyAppleToken(
    idToken: string,
  ): Promise<{ sub: string; email: string; name?: string }> {
    try {
      const decoded = jwt.decode(idToken, { complete: true }) as any;
      if (!decoded?.header?.kid) {
        throw new UnauthorizedException("Invalid Apple ID token header");
      }
      const keys = await this.getAppleJwks();
      const matchingKey = keys.find((k) => k.kid === decoded.header.kid);
      if (!matchingKey) {
        throw new UnauthorizedException("Unknown Apple signing key (kid)");
      }
      const publicKey = crypto.createPublicKey({
        key: matchingKey,
        format: "jwk",
      });

      const appleClientId = this.configService.appleClientId;
      if (!appleClientId) {
        throw new UnauthorizedException("Apple OAuth is not configured on this server");
      }
      const verifyOptions: jwt.VerifyOptions = {
        algorithms: ["RS256"],
        issuer: "https://appleid.apple.com",
        audience: appleClientId,
      };

      const payload = jwt.verify(idToken, publicKey, verifyOptions) as any;
      if (!payload || !payload.sub || !payload.email) {
        throw new UnauthorizedException("Invalid Apple ID token claims");
      }
      return {
        sub: payload.sub,
        email: payload.email,
        name: payload.email.split("@")[0],
      };
    } catch (error: any) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error("Failed to verify Apple ID token signature", error);
      throw new UnauthorizedException("Invalid or forged Apple ID token");
    }
  }

  async verifyMicrosoftToken(
    idToken: string,
  ): Promise<{ sub: string; email: string; name?: string }> {
    try {
      const decoded = jwt.decode(idToken, { complete: true }) as any;
      if (!decoded?.header?.kid) {
        throw new UnauthorizedException("Invalid Microsoft ID token header");
      }
      const keys = await this.getMicrosoftJwks();
      const matchingKey = keys.find((k) => k.kid === decoded.header.kid);
      if (!matchingKey) {
        throw new UnauthorizedException("Unknown Microsoft signing key (kid)");
      }
      const publicKey = crypto.createPublicKey({
        key: matchingKey,
        format: "jwk",
      });

      const microsoftClientId = this.configService.microsoftClientId;
      if (!microsoftClientId) {
        throw new UnauthorizedException("Microsoft OAuth is not configured on this server");
      }
      const verifyOptions: jwt.VerifyOptions = {
        algorithms: ["RS256"],
        audience: microsoftClientId,
      };

      const payload = jwt.verify(idToken, publicKey, verifyOptions) as any;
      const email = payload?.email || payload?.preferred_username;
      if (!payload || !payload.sub || !email) {
        throw new UnauthorizedException("Invalid Microsoft ID token claims");
      }
      const iss = payload.iss as string;
      if (
        !iss ||
        (!iss.startsWith("https://login.microsoftonline.com/") &&
          !iss.startsWith("https://sts.windows.net/"))
      ) {
        throw new UnauthorizedException("Invalid Microsoft ID token issuer");
      }
      return {
        sub: payload.sub,
        email,
        name: payload.name || email.split("@")[0],
      };
    } catch (error: any) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error("Failed to verify Microsoft ID token signature", error);
      throw new UnauthorizedException("Invalid or forged Microsoft ID token");
    }
  }

  private async verifyGoogleToken(idToken: string) {
    const googleClientId = this.configService.googleClientId;
    if (!googleClientId) {
      throw new UnauthorizedException("Google OAuth is not configured on this server");
    }
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: googleClientId,
      });
      const payload = ticket.getPayload();
      if (!payload || !payload.email) {
        throw new UnauthorizedException("Invalid Google ID token payload");
      }
      return {
        email: payload.email,
        sub: payload.sub,
        name: payload.name,
        picture: payload.picture,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error("Failed to verify Google ID token", error);
      throw new UnauthorizedException("Invalid or expired Google ID token");
    }
  }

  private async processOAuthLogin(
    authType: AuthType,
    identifier: string,
    email: string,
    displayName?: string,
    avatar?: string,
    dto?: OAuthLoginDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    const normalizedEmail = email.toLowerCase();

    let user = await this.prisma.user.findFirst({
      where: { email: normalizedEmail },
    });

    if (user) {
      if (user.deletedAt || user.status !== "ACTIVE") {
        throw unauthorized(
          ErrorCode.ACCOUNT_DISABLED,
          "User account is inactive or deleted",
        );
      }
    } else {
      user = await this.prisma.user.create({
        data: {
          email: normalizedEmail,
          displayName: displayName || null,
          avatar: avatar || null,
          emailVerifiedAt: new Date(),
          status: "ACTIVE",
        },
      });
    }

    let authRecord = await this.prisma.authentication.findUnique({
      where: {
        userId_type_identifier: {
          userId: user.id,
          type: authType,
          identifier,
        },
      },
    });

    if (!authRecord) {
      authRecord = await this.prisma.authentication.create({
        data: {
          userId: user.id,
          type: authType,
          identifier,
          emailVerified: true,
          lastUsedAt: new Date(),
        },
      });
    } else {
      await this.prisma.authentication.update({
        where: { id: authRecord.id },
        data: { lastUsedAt: new Date() },
      });
    }

    let device = await this.prisma.device.findFirst({
      where: {
        userId: user.id,
        name: dto?.deviceName || "OAuth Client Device",
        platform: dto?.platform || Platform.WEB,
        revokedAt: null,
      },
    });

    if (!device) {
      device = await this.prisma.device.create({
        data: {
          userId: user.id,
          name: dto?.deviceName || "OAuth Client Device",
          platform: dto?.platform || Platform.WEB,
          appVersion: dto?.appVersion || "1.0.0",
          publicKey: dto?.publicKey || "",
        },
      });
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
      action: AuditAction.OAUTH_CONNECTED,
      ipAddress,
      userAgent,
      metadata: { authType, identifier },
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

      this.pruneExpiredGraceTokens();

      // If a recently rotated token arrives within the grace window (e.g. concurrent
      // requests or network retries), return the already generated active tokens.
      const graceRecord = this.rotatedTokensGraceMap.get(dto.refreshToken);
      if (graceRecord && graceRecord.expiresAt > Date.now()) {
        const session = await this.prisma.session.findUnique({
          where: { id: graceRecord.sessionId },
          select: { id: true, revokedAt: true, refreshExpiresAt: true },
        });
        if (
          session &&
          !session.revokedAt &&
          session.refreshExpiresAt > new Date()
        ) {
          this.logger.log(
            `[AuthService] Reused rotated refresh token within grace period for session ${graceRecord.sessionId}. Returning active tokens.`,
          );
          return { tokens: graceRecord.tokens, deviceId: graceRecord.deviceId };
        }
      }

      const session = await this.prisma.session.findUnique({
        where: { refreshToken: dto.refreshToken },
        include: { user: true },
      });

      if (
        !session ||
        session.revokedAt ||
        session.refreshExpiresAt < new Date() ||
        session.userId !== payload.sub
      ) {
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
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessExpiresAt,
          refreshExpiresAt,
          lastActivityAt: new Date(),
        },
      });

      // Keep previous refresh token in grace map for a short window to tolerate concurrent requests
      this.rotatedTokensGraceMap.set(dto.refreshToken, {
        tokens,
        deviceId: session.deviceId,
        sessionId: session.id,
        userId: session.userId,
        expiresAt: Date.now() + AuthService.REFRESH_ROTATION_GRACE_MS,
      });

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

  private pruneExpiredGraceTokens(): void {
    const now = Date.now();
    for (const [token, record] of this.rotatedTokensGraceMap.entries()) {
      if (record.expiresAt <= now) {
        this.rotatedTokensGraceMap.delete(token);
      }
    }
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
    for (const [token, record] of this.rotatedTokensGraceMap.entries()) {
      if (record.sessionId === sessionId) {
        this.rotatedTokensGraceMap.delete(token);
      }
    }

    return { success: true };
  }

  async requestEmailVerification(email: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);
    if (user && !user.emailVerifiedAt) {
      const otp = crypto.randomInt(100000, 1000000).toString();
      const codeHash = crypto.createHash("sha256").update(otp).digest("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await this.prisma.$runCommandRaw({
        update: "email_verification_otps",
        updates: [
          {
            q: { userId: user.id },
            u: {
              $set: { codeHash, expiresAt },
              $setOnInsert: { userId: user.id, createdAt: new Date() },
            },
            upsert: true,
          },
        ],
      });

      // Dev-only console fallback so OTP is visible even if SMTP is down.
      if (!this.configService.isProduction) {
        this.logger.debug(
          `OTP CODE FOR ${user.email}: ${otp} (expires in 60 minutes)`,
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
    try {
      let userId: string;

      if (email && otp) {
        // OTP verification from MongoDB
        const user = await this.usersService.findByEmail(email);
        if (!user) throw new BadRequestException("User not found");
        const codeHash = crypto.createHash("sha256").update(otp).digest("hex");
        const result = (await this.prisma.$runCommandRaw({
          findAndModify: "email_verification_otps",
          query: {
            userId: user.id,
            codeHash,
            expiresAt: { $gt: new Date() },
          },
          remove: true,
        })) as { value?: { _id: any } | null };
        const storedOtp = result.value;
        if (!storedOtp) {
          throw badRequest(ErrorCode.OTP_INVALID, "Invalid or expired OTP");
        }
        userId = user.id;
      } else if (token) {
        // Token verification
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
      } else {
        throw badRequest(
          ErrorCode.VALIDATION_ERROR,
          "Must provide either a token or email and OTP",
        );
      }

      await this.prisma.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: new Date() },
      });

      await this.prisma.authentication.updateMany({
        where: { userId: userId, type: "EMAIL_PASSWORD" },
        data: { emailVerified: true },
      });

      return { message: "Email address successfully verified" };
    } catch (error) {
      this.logger.error("Failed to confirm email verification", error);
      throw badRequest(
        ErrorCode.TOKEN_INVALID,
        "Invalid or expired email verification token",
      );
    }
  }

  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);
    if (user) {
      const otp = await this.otpService.issue(
        user.id,
        OtpPurpose.PASSWORD_RESET,
        this.RESET_OTP_TTL_MINUTES,
      );

      // Dev-only console fallback so the code is visible even if SMTP is down.
      if (!this.configService.isProduction) {
        this.logger.debug(`PASSWORD RESET OTP FOR ${user.email}: ${otp}`);
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
      // An OAuth-only account can't have a password set through this flow.
      throw new BadRequestException(
        "This account does not use a password. Sign in with your provider instead.",
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

  private getTotpEncryptionKey(): Buffer {
    const rawKey =
      this.configService.encryptionKey ||
      "allinone-default-dev-totp-encryption-key-32b";
    return crypto.createHash("sha256").update(rawKey).digest();
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

  private decryptTotpSecret(stored: string): string {
    if (!stored.startsWith("v1:")) {
      // Backward compatibility for existing plaintext / unencrypted secrets
      return stored;
    }
    const parts = stored.split(":");
    if (parts.length !== 4) {
      return stored;
    }
    const [, ivHex, tagHex, dataHex] = parts;
    try {
      const key = this.getTotpEncryptionKey();
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
      return decrypted.toString("utf8");
    } catch (err) {
      this.logger.error("Failed to decrypt TOTP secret", err);
      return stored;
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

    await this.prisma.mFASetting.upsert({
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

    const verifyRes = verify({
      token: dto.totpCode,
      secret: this.decryptTotpSecret(mfaSetting.totpSecret),
    });
    const isValid = Boolean(
      verifyRes &&
      (typeof verifyRes === "boolean" ? verifyRes : (verifyRes as any).valid),
    );

    if (!isValid) {
      throw new BadRequestException("Invalid TOTP verification code");
    }

    const rawRecoveryCodes: string[] = [];
    const hashedRecoveryCodes: string[] = [];

    for (let i = 0; i < 10; i++) {
      const part1 = crypto.randomBytes(2).toString("hex").toUpperCase();
      const part2 = crypto.randomBytes(2).toString("hex").toUpperCase();
      const code = `${part1}-${part2}`;
      rawRecoveryCodes.push(code);

      const hash = crypto.createHash("sha256").update(code).digest("hex");
      hashedRecoveryCodes.push(hash);
    }

    await this.prisma.mFASetting.update({
      where: { userId },
      data: {
        totpEnabled: true,
        recoveryCodes: JSON.stringify(hashedRecoveryCodes),
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

  private async redeemRecoveryCode(
    userId: string,
    rawCode: string,
  ): Promise<boolean> {
    const codeHash = crypto
      .createHash("sha256")
      .update(rawCode.trim())
      .digest("hex");

    return this.prisma.$transaction(async (tx) => {
      const mfaSetting = await tx.mFASetting.findUnique({
        where: { userId },
      });

      if (!mfaSetting || !mfaSetting.totpEnabled || !mfaSetting.recoveryCodes) {
        return false;
      }

      const recoveryCodes: string[] = JSON.parse(mfaSetting.recoveryCodes);
      const usedCodes: string[] = mfaSetting.backupCodesUsed
        ? JSON.parse(mfaSetting.backupCodesUsed)
        : [];

      if (usedCodes.includes(codeHash)) {
        return false;
      }

      const codeIndex = recoveryCodes.indexOf(codeHash);
      if (codeIndex === -1) {
        return false;
      }

      recoveryCodes.splice(codeIndex, 1);
      usedCodes.push(codeHash);

      await tx.mFASetting.update({
        where: { userId },
        data: {
          recoveryCodes: JSON.stringify(recoveryCodes),
          backupCodesUsed: JSON.stringify(usedCodes),
          lastVerifiedAt: new Date(),
        },
      });

      return true;
    });
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
      const verifyRes = verify({
        token: dto.totpCode,
        secret: this.decryptTotpSecret(mfaSetting.totpSecret),
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
      const verifyRes = verify({
        token: dto.totpCode,
        secret: this.decryptTotpSecret(mfaSetting.totpSecret),
      });
      isCodeValid = Boolean(
        verifyRes &&
        (typeof verifyRes === "boolean" ? verifyRes : (verifyRes as any).valid),
      );
    } else if (dto.recoveryCode) {
      isCodeValid = await this.redeemRecoveryCode(userId, dto.recoveryCode);
    }

    if (!isCodeValid) {
      const attempts = (user.failedLoginAttempts || 0) + 1;
      const MAX_FAILED_ATTEMPTS = 5;
      const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
      const isNowLocked = attempts >= MAX_FAILED_ATTEMPTS;
      const lockedUntil = isNowLocked
        ? new Date(Date.now() + LOCKOUT_DURATION_MS)
        : null;

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil,
        },
      });

      if (isNowLocked) {
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
      await this.prisma.user.update({
        where: { id: user.id },
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
    const basePayload = { sub: userId, email, ...(sessionId ? { sessionId } : {}) };

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
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessExpiresAt,
        refreshExpiresAt,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
      },
    });

    return { tokens, session };
  }
}
