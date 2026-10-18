import { Injectable } from "@nestjs/common";
import * as crypto from "crypto";
import { OtpPurpose } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";

/**
 * Single-use 6-digit codes that prove the user controls their email address.
 * Only the SHA-256 of a code is stored, and spending it is a conditional delete
 * — the request whose delete matches a document is the only one told "yes" — so
 * a code can never be replayed, by a racer or by anyone else, and a leaked
 * database cannot mint codes.
 *
 * Each token is bounded by an attempt counter (max 5 attempts) to prevent
 * brute-forcing within the validity window. A guess is reserved with `$inc`
 * *before* the code is compared, for the same reason the spend is conditional:
 * a budget judged from a value read first is a budget an attacker multiplies by
 * their concurrency, because every racer that read `attempts: 0` gets to present
 * a code before the row is ever burned.
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
      create: {
        userId,
        purpose,
        codeHash: this.hash(code),
        expiresAt,
        attempts: 0,
      },
      // A fresh code carries a fresh budget, so this is a reset rather than a
      // counter to increment: the row it overwrites may belong to a code that
      // was never guessed at all.
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

    if (!token) return false;

    if (token.expiresAt <= new Date()) {
      // Out of its window: the row goes away instead of being answered from, so
      // a later request cannot probe it either.
      await this.prisma.otpToken.deleteMany({
        where: { userId, purpose },
      });
      return false;
    }

    // The reservation, taken before the code is looked at. `$inc` because two
    // racers that both read `4` used to both write `5`, and because the answer
    // to "may this guess be compared at all" has to come from the count the row
    // carries rather than from a snapshot this request read a moment ago.
    const burned = await this.prisma.otpToken
      .update({
        where: { userId_purpose: { userId, purpose } },
        data: { attempts: { increment: 1 } },
      })
      .catch((err: unknown) => {
        // A racer whose guess crossed the ceiling already deleted the row. Its
        // P2025 is the answer "no" wearing a database error: turned into a 404
        // by the error filter, it would break the `OTP_INVALID` 401 every client
        // that retries a recovery code branches on.
        if ((err as { code?: string } | null)?.code !== "P2025") throw err;
        return null;
      });

    if (!burned) return false;

    if (burned.attempts > OtpService.MAX_ATTEMPTS) {
      // Past the budget the row was issued with, so the code is never even
      // compared here. Deleting again is what makes the burn stick for the next
      // request rather than for this one alone.
      await this.prisma.otpToken.deleteMany({
        where: { userId, purpose },
      });
      return false;
    }

    const hashedInput = this.hash(code.trim());
    const bufStored = Buffer.from(token.codeHash);
    const bufInput = Buffer.from(hashedInput);
    const matches =
      bufStored.length === bufInput.length &&
      crypto.timingSafeEqual(bufStored, bufInput);

    if (matches) {
      // The claim, not a read-then-delete: `codeHash` pins the filter to the
      // exact code that was just compared, so of two racing requests carrying it
      // only the one whose delete matched a document spends the code. The loser
      // reads `count: 0` and says "no" — a spent code is never spent twice.
      const claimed = await this.prisma.otpToken.deleteMany({
        where: { userId, purpose, codeHash: token.codeHash },
      });
      return claimed.count === 1;
    }

    if (burned.attempts >= OtpService.MAX_ATTEMPTS) {
      await this.prisma.otpToken.deleteMany({
        where: { userId, purpose },
      });
    }

    return false;
  }

  private hash(code: string): string {
    return crypto.createHash("sha256").update(code).digest("hex");
  }
}
