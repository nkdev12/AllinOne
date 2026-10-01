import { Injectable } from "@nestjs/common";
import * as crypto from "crypto";
import { OtpPurpose } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";

/**
 * Single-use 6-digit codes that prove the user controls their email address.
 * Only the SHA-256 of a code is stored, and verifying it deletes the row, so a
 * code can never be replayed and a leaked database cannot mint codes.
 *
 * Each token is bounded by an attempt counter (max 5 attempts) to prevent brute-forcing
 * within the validity window.
 */
@Injectable()
export class OtpService {
  static readonly MAX_ATTEMPTS = 5;

  constructor(private readonly prisma: PrismaService) {}

  /** Returns the plaintext code once, for the caller to email out. */
  async issue(
    userId: string,
    purpose: OtpPurpose,
    ttlMinutes: number,
  ): Promise<string> {
    const code = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    await this.prisma.otpToken.upsert({
      where: { userId_purpose: { userId, purpose } },
      create: { userId, purpose, codeHash: this.hash(code), expiresAt, attempts: 0 },
      update: { codeHash: this.hash(code), expiresAt, attempts: 0 },
    });

    return code;
  }

  /** True for exactly one call per issued code. */
  async consume(
    userId: string,
    purpose: OtpPurpose,
    code: string,
  ): Promise<boolean> {
    const token = await this.prisma.otpToken.findUnique({
      where: { userId_purpose: { userId, purpose } },
    });

    if (
      !token ||
      token.expiresAt <= new Date() ||
      token.attempts >= OtpService.MAX_ATTEMPTS
    ) {
      if (
        token &&
        (token.expiresAt <= new Date() ||
          token.attempts >= OtpService.MAX_ATTEMPTS)
      ) {
        await this.prisma.otpToken.deleteMany({
          where: { userId, purpose },
        });
      }
      return false;
    }

    const hashedInput = this.hash(code.trim());
    const bufStored = Buffer.from(token.codeHash);
    const bufInput = Buffer.from(hashedInput);
    const matches =
      bufStored.length === bufInput.length &&
      crypto.timingSafeEqual(bufStored, bufInput);

    if (matches) {
      await this.prisma.otpToken.deleteMany({
        where: { userId, purpose },
      });
      return true;
    }

    const newAttempts = token.attempts + 1;
    if (newAttempts >= OtpService.MAX_ATTEMPTS) {
      await this.prisma.otpToken.deleteMany({
        where: { userId, purpose },
      });
    } else {
      await this.prisma.otpToken.update({
        where: { userId_purpose: { userId, purpose } },
        data: { attempts: { increment: 1 } },
      });
    }

    return false;
  }

  private hash(code: string): string {
    return crypto.createHash("sha256").update(code).digest("hex");
  }
}
