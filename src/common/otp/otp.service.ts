import { Injectable } from "@nestjs/common";
import * as crypto from "crypto";
import { OtpPurpose } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";

/**
 * Single-use 6-digit codes that prove the user controls their email address.
 * Only the SHA-256 of a code is stored, and verifying it deletes the row, so a
 * code can never be replayed and a leaked database cannot mint codes.
 */
@Injectable()
export class OtpService {
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
      create: { userId, purpose, codeHash: this.hash(code), expiresAt },
      update: { codeHash: this.hash(code), expiresAt },
    });

    return code;
  }

  /** True for exactly one call per issued code. */
  async consume(
    userId: string,
    purpose: OtpPurpose,
    code: string,
  ): Promise<boolean> {
    const spent = await this.prisma.otpToken.deleteMany({
      where: {
        userId,
        purpose,
        codeHash: this.hash(code.trim()),
        expiresAt: { gt: new Date() },
      },
    });

    return spent.count === 1;
  }

  private hash(code: string): string {
    return crypto.createHash("sha256").update(code).digest("hex");
  }
}
