import Redis from "ioredis";
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Logger,
  Optional,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { generateSecret, generateURI, verify } from "otplib";
import * as qrcode from "qrcode";
import * as crypto from "crypto";
import * as jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { InjectQueue } from "@nestjs/bull";
import { Queue } from "bull";
import { PrismaService } from "@/common/prisma/prisma.service";
import { UsersService } from "@/users/users.service";
import { ConfigurationService } from "@/config/configuration.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
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
import { AuthType, Platform, AuditAction } from "@prisma/client";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClient = new OAuth2Client();
  private redisClient!: Redis;
  private appleJwksCache: { keys: any[]; fetchedAt: number } | null = null;
  private microsoftJwksCache: { keys: any[]; fetchedAt: number } | null = null;
  private readonly JWKS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigurationService,
    @InjectQueue("mail") private readonly mailQueue: Queue,
    @Optional() private readonly auditLogService?: AuditLogService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    const existingUser = await this.usersService.findByEmail(dto.email);
    if (existingUser) {
      throw new ConflictException("User with this email already exists");
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
      if (error.code === 'P2002') {
        throw new ConflictException("User with this email already exists");
      }
      throw error;
    }

    const tokens = await this.generateTokens(result.user.id, result.user.email);
    const session = await this.createSession(
      result.user.id,
      result.device.id,
      tokens.accessToken,
      tokens.refreshToken,
    );

    if (this.configService.emailVerifyEnabled) {
      this.requestEmailVerification(result.user.email).catch((err) => {
        this.logger.error(
          `Failed to send initial verification email to ${result.user.email}`,
          err,
        );
      });
    }

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
      throw new UnauthorizedException("Invalid email or password");
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
      throw new UnauthorizedException(
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

        throw new UnauthorizedException(
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

      throw new UnauthorizedException("Invalid email or password");
    }

    if (user.status !== "ACTIVE" || user.deletedAt) {
      throw new UnauthorizedException(
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

    let device = await this.prisma.device.findFirst({
      where: {
        userId: user.id,
        name: dto.deviceName || "Primary Client Device",
        platform: dto.platform || Platform.WEB,
        revokedAt: null,
      },
    });

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
        },
        { secret: this.configService.jwtAccessSecret, expiresIn: "5m" },
      );

      return {
        mfaRequired: true,
        mfaToken,
      };
    }

    const tokens = await this.generateTokens(user.id, user.email);
    const session = await this.createSession(
      user.id,
      device.id,
      tokens.accessToken,
      tokens.refreshToken,
      ipAddress,
      userAgent,
    );

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

      const verifyOptions: jwt.VerifyOptions = {
        algorithms: ["RS256"],
        issuer: "https://appleid.apple.com",
      };
      if (this.configService.appleClientId) {
        verifyOptions.audience = this.configService.appleClientId;
      }

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

      const verifyOptions: jwt.VerifyOptions = {
        algorithms: ["RS256"],
      };
      if (this.configService.microsoftClientId) {
        verifyOptions.audience = this.configService.microsoftClientId;
      }

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
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: this.configService.googleClientId,
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

    let user = await this.usersService.findByEmail(normalizedEmail);

    if (!user) {
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

    const tokens = await this.generateTokens(user.id, user.email);
    const session = await this.createSession(
      user.id,
      device.id,
      tokens.accessToken,
      tokens.refreshToken,
      ipAddress,
      userAgent,
    );

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
    };
  }

  async refreshTokens(
    dto: RefreshTokenDto,
  ): Promise<{ tokens: AuthTokenDataDto }> {
    try {
      if (!dto.refreshToken) {
        throw new UnauthorizedException("Invalid or expired refresh token");
      }
      const payload = this.jwtService.verify(dto.refreshToken, {
        secret: this.configService.jwtRefreshSecret,
      });

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
        throw new UnauthorizedException("Invalid or expired refresh token");
      }

      const tokens = await this.generateTokens(
        session.userId,
        session.user.email,
        session.id,
      );

      const accessExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
      const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

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

      return { tokens };
    } catch (error) {
      this.logger.error("Failed to refresh tokens", error);
      throw new UnauthorizedException("Invalid or expired refresh token");
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

    return { success: true };
  }

  async requestEmailVerification(email: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);
    if (user && !user.emailVerifiedAt) {
      const token = this.jwtService.sign(
        { sub: user.id, email: user.email, purpose: "EMAIL_VERIFICATION" },
        { secret: this.configService.jwtAccessSecret, expiresIn: "24h" },
      );
      
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      
      // LOG OTP TO TERMINAL FOR LOCAL TESTING
      console.log("\n=======================================================");
      console.log(`🔔 OTP CODE FOR ${user.email}: ${otp}`);
      console.log("=======================================================\n");
      await this.redisClient.set(`email_otp:${user.email}`, otp, "EX", 3600); // 1 hr expiration

      await this.mailQueue.add("send-verification-email", {
        email: user.email,
        token,
        otp
      });
    }

    return {
      message: "If the account exists, a verification link and OTP have been sent.",
    };
  }

  async confirmEmailVerification(token: string | undefined, email?: string, otp?: string): Promise<{ message: string }> {
    try {
      let userId: string;

      if (email && otp) {
        // OTP verification
        const storedOtp = await this.redisClient.get(`email_otp:${email}`);
        if (!storedOtp || storedOtp !== otp) {
          throw new BadRequestException("Invalid or expired OTP");
        }
        const user = await this.usersService.findByEmail(email);
        if (!user) throw new BadRequestException("User not found");
        userId = user.id;
        await this.redisClient.del(`email_otp:${email}`);
      } else if (token) {
        // Token verification
        const payload = this.jwtService.verify(token, {
          secret: this.configService.jwtAccessSecret,
        });

        if (payload.purpose !== "EMAIL_VERIFICATION") {
          throw new BadRequestException("Invalid verification token type");
        }
        userId = payload.sub;
      } else {
        throw new BadRequestException("Must provide either a token or email and OTP");
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
      throw new BadRequestException(
        "Invalid or expired email verification token",
      );
    }
  }

  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);
    if (user) {
      const token = this.jwtService.sign(
        { sub: user.id, email: user.email, purpose: "PASSWORD_RESET" },
        { secret: this.configService.jwtAccessSecret, expiresIn: "1h" },
      );

      await this.mailQueue.add("send-password-reset-email", {
        email: user.email,
        token,
      });

      // LOG RESET LINK TO TERMINAL FOR LOCAL TESTING
      console.log("\n=======================================================");
      console.log(`🔔 PASSWORD RESET LINK FOR ${user.email}:`);
      console.log(`${this.configService.appUrl}/auth/reset-password?token=${token}`);
      console.log("=======================================================\n");
    }

    return {
      message:
        "If the account exists, password reset instructions have been sent.",
    };
  }

  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.jwtAccessSecret,
      });

      if (payload.purpose !== "PASSWORD_RESET") {
        throw new BadRequestException("Invalid reset token type");
      }

      const hashedPassword = await argon2.hash(newPassword);

      await this.prisma.authentication.updateMany({
        where: { userId: payload.sub, type: "EMAIL_PASSWORD" },
        data: { passwordHash: hashedPassword },
      });

      await this.prisma.session.updateMany({
        where: { userId: payload.sub, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await this.auditLogService?.recordAuditLog({
        userId: payload.sub,
        action: AuditAction.PASSWORD_CHANGED,
      });

      return {
        message:
          "Password successfully reset. Please log in with your new password.",
      };
    } catch (error) {
      this.logger.error("Failed to reset password", error);
      throw new BadRequestException("Invalid or expired password reset token");
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
        totpSecret: secret,
        totpEnabled: false,
      },
      update: {
        totpSecret: secret,
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
      secret: mfaSetting.totpSecret,
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
        secret: mfaSetting.totpSecret,
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
        secret: this.configService.jwtAccessSecret,
      });

      if (payload.purpose !== "MFA_CHALLENGE") {
        throw new UnauthorizedException("Invalid MFA token purpose");
      }
    } catch (error) {
      this.logger.error("Failed to verify MFA login token", error);
      throw new UnauthorizedException("Invalid or expired MFA challenge token");
    }

    const userId = payload.sub;
    const deviceId = payload.deviceId;

    const user = await this.usersService.getUserById(userId);
    if (!user || user.status !== "ACTIVE" || user.deletedAt) {
      throw new UnauthorizedException("User account is inactive or deleted");
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
        secret: mfaSetting.totpSecret,
      });
      isCodeValid = Boolean(
        verifyRes &&
        (typeof verifyRes === "boolean" ? verifyRes : (verifyRes as any).valid),
      );
    } else if (dto.recoveryCode) {
      isCodeValid = await this.redeemRecoveryCode(userId, dto.recoveryCode);
    }

    if (!isCodeValid) {
      throw new UnauthorizedException(
        "Invalid TOTP verification code or recovery code",
      );
    }

    const tokens = await this.generateTokens(user.id, user.email);
    const session = await this.createSession(
      user.id,
      deviceId,
      tokens.accessToken,
      tokens.refreshToken,
      ipAddress,
      userAgent,
    );

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
    };
  }

  private async generateTokens(
    userId: string,
    email: string,
    sessionId?: string,
  ): Promise<AuthTokenDataDto> {
    const payload = { sub: userId, email, ...(sessionId ? { sessionId } : {}) };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.jwtAccessSecret,
      expiresIn: "15m",
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.jwtRefreshSecret,
      expiresIn: "7d",
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 900,
    };
  }

  private async createSession(
    userId: string,
    deviceId: string,
    accessToken: string,
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const accessExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    return this.prisma.session.create({
      data: {
        userId,
        deviceId,
        accessToken,
        refreshToken,
        accessExpiresAt,
        refreshExpiresAt,
        ipAddress,
        userAgent,
      },
    });
  }
}
