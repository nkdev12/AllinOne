import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
import { AuthType, AuditAction } from "@prisma/client";
import * as crypto from "crypto";
import { ErrorCode } from "@/common/errors/error-code";
import { badRequest, notFound } from "@/common/errors/http-errors";
import { RegistrationOptionsResponse } from "./passkeys.interface";
import { RegisterOptionsDto, RegisterVerifyDto } from "./dto/passkeys.dto";

interface StoredChallenge {
  challenge: string;
  userId?: string;
  expiresAt: number;
}

/**
 * Registration only. The passwordless *login* half of this service was removed:
 * it minted access and refresh tokens after checking nothing but the shape of
 * `clientDataJSON`, which made it a working authentication bypass rather than a
 * half-built one, and the credential material `verifyRegistration` stores (a
 * raw `attestationObject`, not a parsed COSE key) could not be verified against
 * even by a correct implementation. Re-adding login means a real relying-party
 * library and re-enrolling every passkey that already exists — see the vault
 * audit plan, item 40.
 */
@Injectable()
export class PasskeysService {
  private readonly logger = new Logger(PasskeysService.name);
  private readonly registrationChallenges = new Map<string, StoredChallenge>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private cleanExpiredChallenges(): void {
    const now = Date.now();
    for (const [key, value] of this.registrationChallenges.entries()) {
      if (value.expiresAt < now) {
        this.registrationChallenges.delete(key);
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
      throw notFound(ErrorCode.NOT_FOUND, "User not found.");
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
      throw badRequest(
        ErrorCode.PASSKEY_CHALLENGE_INVALID,
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
      throw badRequest(
        ErrorCode.PASSKEY_CHALLENGE_INVALID,
        "Invalid clientDataJSON format.",
      );
    }

    if (clientData.type !== "webauthn.create") {
      throw badRequest(
        ErrorCode.PASSKEY_CHALLENGE_INVALID,
        `Invalid clientData type: expected 'webauthn.create', got '${clientData.type}'.`,
      );
    }

    if (clientData.challenge !== stored.challenge) {
      throw badRequest(
        ErrorCode.PASSKEY_CHALLENGE_INVALID,
        "Registration challenge mismatch.",
      );
    }

    // Check for duplicate credential
    const existing = await this.prisma.authentication.findFirst({
      where: {
        type: AuthType.PASSKEY,
        identifier: dto.id,
      },
    });

    if (existing) {
      throw badRequest(
        ErrorCode.ALREADY_EXISTS,
        "This passkey is already registered.",
      );
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
}
