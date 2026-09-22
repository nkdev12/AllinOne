import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { JwtService } from "@nestjs/jwt";
import { ConfigurationService } from "@/config/configuration.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
import { AuthType, AuditAction, UserStatus, Platform } from "@prisma/client";
import * as crypto from "crypto";
import {
  LoginOptionsResponse,
  RegistrationOptionsResponse,
} from "./passkeys.interface";
import {
  LoginOptionsDto,
  LoginVerifyDto,
  RegisterOptionsDto,
  RegisterVerifyDto,
} from "./dto/passkeys.dto";

interface StoredChallenge {
  challenge: string;
  userId?: string;
  email?: string;
  expiresAt: number;
}

@Injectable()
export class PasskeysService {
  private readonly logger = new Logger(PasskeysService.name);
  private readonly registrationChallenges = new Map<string, StoredChallenge>();
  private readonly loginChallenges = new Map<string, StoredChallenge>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigurationService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private cleanExpiredChallenges(): void {
    const now = Date.now();
    for (const [key, value] of this.registrationChallenges.entries()) {
      if (value.expiresAt < now) {
        this.registrationChallenges.delete(key);
      }
    }
    for (const [key, value] of this.loginChallenges.entries()) {
      if (value.expiresAt < now) {
        this.loginChallenges.delete(key);
      }
    }
  }

  async generateRegistrationOptions(
    userId: string,
    _dto?: RegisterOptionsDto,
  ): Promise<RegistrationOptionsResponse> {
    this.cleanExpiredChallenges();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException("User not found.");
    }

    const challenge = crypto.randomBytes(32).toString("base64url");

    this.registrationChallenges.set(userId, {
      challenge,
      userId,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    return {
      challenge,
      rp: {
        name: "Allinone",
        id: "localhost",
      },
      user: {
        id: user.id,
        name: user.email,
        displayName: user.displayName || user.email,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      timeout: 60000,
      attestation: "none",
    };
  }

  async verifyRegistration(
    userId: string,
    dto: RegisterVerifyDto,
  ): Promise<{ success: boolean; credentialId: string }> {
    const stored = this.registrationChallenges.get(userId);
    if (!stored || stored.expiresAt < Date.now()) {
      throw new BadRequestException(
        "Registration challenge expired or invalid.",
      );
    }

    // Validate clientDataJSON
    let clientData: any;
    try {
      const decodedClientData = Buffer.from(
        dto.clientDataJSON,
        "base64url",
      ).toString("utf-8");
      clientData = JSON.parse(decodedClientData);
    } catch (_) {
      throw new BadRequestException("Invalid clientDataJSON format.");
    }

    if (clientData.type !== "webauthn.create") {
      throw new BadRequestException(
        `Invalid clientData type: expected 'webauthn.create', got '${clientData.type}'.`,
      );
    }

    if (clientData.challenge !== stored.challenge) {
      throw new BadRequestException("Registration challenge mismatch.");
    }

    // Check for duplicate credential
    const existing = await this.prisma.authentication.findFirst({
      where: {
        type: AuthType.PASSKEY,
        identifier: dto.id,
      },
    });

    if (existing) {
      throw new BadRequestException("This passkey is already registered.");
    }

    await this.prisma.authentication.create({
      data: {
        userId,
        type: AuthType.PASSKEY,
        identifier: dto.id,
        passwordHash: JSON.stringify({
          publicKey: dto.attestationObject,
          counter: 0,
          deviceName: dto.deviceName || "Passkey Authenticator",
          transports: dto.transports || [],
        }),
        emailVerified: true,
      },
    });

    this.registrationChallenges.delete(userId);

    await this.auditLogService.recordAuditLog({
      userId,
      action: AuditAction.DEVICE_ADDED,
      metadata: {
        authType: "PASSKEY",
        credentialId: dto.id,
        deviceName: dto.deviceName || "Passkey Authenticator",
      },
    });

    this.logger.log(`Passkey registered for user ${userId} [${dto.id}]`);

    return { success: true, credentialId: dto.id };
  }

  async generateLoginOptions(
    dto?: LoginOptionsDto,
  ): Promise<LoginOptionsResponse> {
    this.cleanExpiredChallenges();

    const challenge = crypto.randomBytes(32).toString("base64url");
    let allowCredentials: any[] | undefined;

    if (dto?.email) {
      const user = await this.prisma.user.findFirst({
        where: { email: dto.email.toLowerCase(), deletedAt: null },
        include: {
          authentications: {
            where: { type: AuthType.PASSKEY },
          },
        },
      });

      if (user && user.authentications.length > 0) {
        allowCredentials = user.authentications.map((auth) => ({
          id: auth.identifier,
          type: "public-key",
        }));
      }
    }

    const key = challenge;
    this.loginChallenges.set(key, {
      challenge,
      email: dto?.email?.toLowerCase(),
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    return {
      challenge,
      timeout: 60000,
      rpId: "localhost",
      allowCredentials,
    };
  }

  async verifyLogin(
    dto: LoginVerifyDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{
    user: any;
    tokens: { accessToken: string; refreshToken: string };
    sessionId: string;
  }> {
    // Validate clientDataJSON
    let clientData: any;
    try {
      const decodedClientData = Buffer.from(
        dto.clientDataJSON,
        "base64url",
      ).toString("utf-8");
      clientData = JSON.parse(decodedClientData);
    } catch (_) {
      throw new BadRequestException("Invalid clientDataJSON format.");
    }

    if (clientData.type !== "webauthn.get") {
      throw new BadRequestException(
        `Invalid clientData type: expected 'webauthn.get', got '${clientData.type}'.`,
      );
    }

    // Verify against pending challenge
    const stored = this.loginChallenges.get(clientData.challenge);
    if (!stored || stored.expiresAt < Date.now()) {
      throw new BadRequestException("Login challenge expired or invalid.");
    }

    // Find authentication credential
    const auth = await this.prisma.authentication.findFirst({
      where: {
        type: AuthType.PASSKEY,
        identifier: dto.id,
      },
      include: {
        user: true,
      },
    });

    if (!auth || !auth.user) {
      throw new UnauthorizedException("Invalid passkey credential.");
    }

    const user = auth.user;

    // Check account status and lockout
    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException("Account is not active.");
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException("Account is temporarily locked.");
    }

    // Update credential and last login
    await this.prisma.$transaction([
      this.prisma.authentication.update({
        where: { id: auth.id },
        data: { lastUsedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
    ]);

    // Find or create default web device
    let device = await this.prisma.device.findFirst({
      where: { userId: user.id, platform: Platform.WEB, revokedAt: null },
    });
    if (!device) {
      device = await this.prisma.device.create({
        data: {
          userId: user.id,
          name: "Passkey Authenticator",
          platform: Platform.WEB,
          appVersion: "1.0.0",
          publicKey: "passkey",
        },
      });
    }

    // Generate JWT tokens
    const accessToken = this.jwtService.sign(
      { sub: user.id, email: user.email },
      {
        secret: this.configService.jwtAccessSecret,
        expiresIn: "15m",
      },
    );

    const refreshToken = this.jwtService.sign(
      { sub: user.id, email: user.email },
      {
        secret: this.configService.jwtRefreshSecret,
        expiresIn: "7d",
      },
    );

    // Create session
    const accessExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        deviceId: device.id,
        accessToken,
        refreshToken,
        accessExpiresAt,
        refreshExpiresAt,
        userAgent,
        ipAddress,
      },
    });

    this.loginChallenges.delete(clientData.challenge);

    await this.auditLogService.recordAuditLog({
      userId: user.id,
      action: AuditAction.LOGIN_SUCCESS,
      ipAddress,
      userAgent,
      metadata: {
        authType: "PASSKEY",
        credentialId: dto.id,
        sessionId: session.id,
      },
    });

    this.logger.log(`Passkey authentication successful for ${user.email}`);

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
      tokens: { accessToken, refreshToken },
      sessionId: session.id,
    };
  }
}
