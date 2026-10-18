import { Test, TestingModule } from "@nestjs/testing";
import { OtpService } from "./otp.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { OtpPurpose } from "@prisma/client";
import * as crypto from "crypto";

const hash = (code: string) =>
  crypto.createHash("sha256").update(code).digest("hex");

type TokenRow = {
  userId: string;
  purpose: OtpPurpose;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
};

/** How the connector answers an `Int` write: `$inc` for an operator, `$set` for a bare number. */
function nextCount(
  current: number,
  written: number | { increment?: number },
): number {
  return typeof written === "number"
    ? written
    : current + (written.increment ?? 0);
}

describe("OtpService", () => {
  let service: OtpService;
  let prisma: any;

  /**
   * A row the service can actually race: `increment` is applied the way MongoDB
   * applies `$inc`, and a delete only answers for a document that still matches
   * its filter, so `count: 0` means "someone else got there first". A mock that
   * simply resolves `{ count: 1 }` cannot show that, because it agrees to every
   * claim.
   */
  function liveToken(overrides: Partial<TokenRow> = {}) {
    let row: TokenRow | null = {
      userId: "user-1",
      purpose: OtpPurpose.PASSWORD_RESET,
      codeHash: hash("123456"),
      attempts: 0,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      ...overrides,
    };

    prisma.otpToken.findUnique.mockImplementation(async () =>
      row ? { ...row } : null,
    );
    prisma.otpToken.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        if (!row) {
          // What the connector really answers for a document that is no longer
          // there, code included: the service has to read `P2025` rather than
          // some invented error, because that code is the only thing telling it
          // "a racer already burned this" instead of a 404 reaching the client.
          throw Object.assign(new Error("Record to update not found."), {
            code: "P2025",
          });
        }
        row = {
          ...row,
          attempts: nextCount(row.attempts, data.attempts as any),
        };
        return { ...row };
      },
    );
    prisma.otpToken.deleteMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => {
        if (!row) return { count: 0 };
        if (
          where.codeHash !== undefined &&
          where.codeHash !== (row as TokenRow).codeHash
        ) {
          return { count: 0 };
        }
        row = null;
        return { count: 1 };
      },
    );

    return {
      get row() {
        return row;
      },
      /** The document the row holds, as a snapshot a request could not have read. */
      staleSnapshotOf(overrides: Partial<TokenRow>) {
        prisma.otpToken.findUnique.mockResolvedValue({
          ...(row as TokenRow),
          ...overrides,
        });
      },
    };
  }

  beforeEach(async () => {
    prisma = {
      otpToken: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [OtpService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<OtpService>(OtpService);
  });

  it("issues a 6-digit OTP and stores its hash with attempts reset to 0", async () => {
    const code = await service.issue("user-1", OtpPurpose.PASSWORD_RESET, 15);

    expect(code).toMatch(/^\d{6}$/);
    expect(prisma.otpToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_purpose: {
            userId: "user-1",
            purpose: OtpPurpose.PASSWORD_RESET,
          },
        },
        create: expect.objectContaining({
          userId: "user-1",
          purpose: OtpPurpose.PASSWORD_RESET,
          attempts: 0,
        }),
        update: expect.objectContaining({
          attempts: 0,
        }),
      }),
    );
  });

  it("consumes successfully with correct code and deletes the token", async () => {
    const rawCode = "123456";

    prisma.otpToken.findUnique.mockResolvedValue({
      userId: "user-1",
      purpose: OtpPurpose.PASSWORD_RESET,
      codeHash: hash(rawCode),
      attempts: 0,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    prisma.otpToken.update.mockResolvedValue({ attempts: 1 });

    const result = await service.consume(
      "user-1",
      OtpPurpose.PASSWORD_RESET,
      "123456",
    );

    expect(result).toBe(true);
    // The guess is reserved before the code is looked at, because that is the
    // only ordering in which concurrency cannot hand an attacker a second
    // budget: a correct code pays for its one slot like any other.
    expect(prisma.otpToken.update).toHaveBeenCalledWith({
      where: {
        userId_purpose: {
          userId: "user-1",
          purpose: OtpPurpose.PASSWORD_RESET,
        },
      },
      data: { attempts: { increment: 1 } },
    });
    // The filter carries the code that was compared, which is what turns a
    // delete into a claim: a row already replaced by a re-issue matches nothing.
    expect(prisma.otpToken.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        purpose: OtpPurpose.PASSWORD_RESET,
        codeHash: hash(rawCode),
      },
    });
    // One claim only: the burn of an exhausted budget is a different filter.
    expect(prisma.otpToken.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("rejects when token is expired and cleans it up", async () => {
    const rawCode = "123456";
    const codeHash = hash(rawCode);

    prisma.otpToken.findUnique.mockResolvedValue({
      userId: "user-1",
      purpose: OtpPurpose.PASSWORD_RESET,
      codeHash,
      attempts: 0,
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await service.consume(
      "user-1",
      OtpPurpose.PASSWORD_RESET,
      "123456",
    );

    expect(result).toBe(false);
    expect(prisma.otpToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", purpose: OtpPurpose.PASSWORD_RESET },
    });
  });

  it("increments attempts on incorrect code without deleting token before max", async () => {
    prisma.otpToken.findUnique.mockResolvedValue({
      userId: "user-1",
      purpose: OtpPurpose.PASSWORD_RESET,
      codeHash: hash("123456"),
      attempts: 1,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    // What the connector returns is the row with the increment already applied,
    // which is the only reason the branch below can be trusted at all.
    prisma.otpToken.update.mockResolvedValue({ attempts: 2 });

    const result = await service.consume(
      "user-1",
      OtpPurpose.PASSWORD_RESET,
      "999999",
    );

    expect(result).toBe(false);
    expect(prisma.otpToken.update).toHaveBeenCalledWith({
      where: {
        userId_purpose: {
          userId: "user-1",
          purpose: OtpPurpose.PASSWORD_RESET,
        },
      },
      // An operator, never the absolute value this request computed: writing
      // `2` here is what let two racers agree on `1 + 1`.
      data: { attempts: { increment: 1 } },
    });
    expect(prisma.otpToken.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes token and returns false when max attempts reached on incorrect code", async () => {
    prisma.otpToken.findUnique.mockResolvedValue({
      userId: "user-1",
      purpose: OtpPurpose.PASSWORD_RESET,
      codeHash: hash("123456"),
      attempts: 4, // 5th attempt will reach MAX_ATTEMPTS
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    prisma.otpToken.update.mockResolvedValue({ attempts: 5 });

    const result = await service.consume(
      "user-1",
      OtpPurpose.PASSWORD_RESET,
      "999999",
    );

    expect(result).toBe(false);
    expect(prisma.otpToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", purpose: OtpPurpose.PASSWORD_RESET },
    });
  });

  describe("concurrency", () => {
    /** The deletes whose filter names a code — i.e. the guesses that got compared. */
    function claimAttempts(prisma: any) {
      return prisma.otpToken.deleteMany.mock.calls.filter(
        ([args]: [{ where: Record<string, unknown> }]) =>
          args.where.codeHash !== undefined,
      );
    }

    it("spends a code exactly once under a race between two identical requests", async () => {
      const live = liveToken();

      const results = await Promise.all([
        service.consume("user-1", OtpPurpose.PASSWORD_RESET, "123456"),
        service.consume("user-1", OtpPurpose.PASSWORD_RESET, "123456"),
      ]);

      // Both read the same row and both compare clean, so the only thing that
      // can separate them is the claim: one delete matched, the other did not.
      expect(results.sort()).toEqual([false, true]);
      expect(live.row).toBeNull();
      // Each racer reserved its guess before comparing, so both are counted.
      expect(prisma.otpToken.update).toHaveBeenCalledTimes(2);
    });

    it("refuses the claim when the code was re-issued between the read and the delete", async () => {
      const live = liveToken({ codeHash: hash("654321") });
      // The request is working from a snapshot of the code before the re-issue.
      live.staleSnapshotOf({ codeHash: hash("123456") });

      await expect(
        service.consume("user-1", OtpPurpose.PASSWORD_RESET, "123456"),
      ).resolves.toBe(false);

      // The live row survives: the filter named a code the row no longer holds,
      // so nothing was deleted that belongs to the newer request.
      expect(live.row?.codeHash).toBe(hash("654321"));
    });

    it("counts a burst of parallel wrong guesses against the row, not against what each read", async () => {
      const live = liveToken({ attempts: 3 });

      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          service.consume("user-1", OtpPurpose.PASSWORD_RESET, "999999"),
        ),
      );

      expect(results).toEqual([false, false, false]);
      // All three read `3`. Read-modify-write would have written `4` three times
      // and left a budget of three more guesses; `$inc` put the row past the
      // ceiling, so the token went away.
      expect(prisma.otpToken.update).toHaveBeenCalledTimes(3);
      for (const [args] of prisma.otpToken.update.mock.calls) {
        expect(args.data.attempts).toEqual({ increment: 1 });
      }
      expect(live.row).toBeNull();
    });

    it("hands a burst of concurrent racers no more guesses than the code was issued with", async () => {
      // The counter alone was not enough: with the budget judged from the value
      // each request read, all ten of these saw room to spare and each got to
      // present a code — a brute-force budget of ten where five was promised.
      // Reserving with `$inc` first means only the guess the row still has room
      // for is ever compared.
      const live = liveToken({ attempts: OtpService.MAX_ATTEMPTS - 1 });

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          service.consume("user-1", OtpPurpose.PASSWORD_RESET, "123456"),
        ),
      );

      // One claim, not one per racer: nine were refused before comparing, and
      // the tenth found no row to compare against at all.
      expect(results.filter((ok) => ok)).toHaveLength(1);
      expect(claimAttempts(prisma)).toHaveLength(1);
      // Every racer was counted rather than silently dropped.
      expect(prisma.otpToken.update).toHaveBeenCalledTimes(10);
      expect(live.row).toBeNull();
    });

    it("answers a guess whose token a racer already burned with a plain no", async () => {
      // Prisma answers an `$inc` against a deleted document with P2025, which
      // the error filter turns into a 404. A client retrying a recovery code
      // branches on the `OTP_INVALID` 401 instead, so the vanished row has to be
      // read as the answer "no" rather than as a database fault.
      liveToken();
      prisma.otpToken.update.mockRejectedValue(
        Object.assign(new Error("Record to update not found."), {
          code: "P2025",
        }),
      );

      await expect(
        service.consume("user-1", OtpPurpose.PASSWORD_RESET, "123456"),
      ).resolves.toBe(false);
      expect(claimAttempts(prisma)).toHaveLength(0);
    });

    it("judges exhaustion by the count the row holds, not the one the request observed", async () => {
      const live = liveToken({ attempts: OtpService.MAX_ATTEMPTS });
      // A stale snapshot still says there is room left; the row's own count,
      // which is what the reservation answers with, says the budget is gone.
      live.staleSnapshotOf({ attempts: 0 });

      await expect(
        service.consume("user-1", OtpPurpose.PASSWORD_RESET, "123456"),
      ).resolves.toBe(false);

      // The code was never even compared, so no claim-shaped delete could have
      // spent a token the row had already run out of guesses for.
      expect(live.row).toBeNull();
      expect(claimAttempts(prisma)).toHaveLength(0);
      expect(prisma.otpToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: "user-1", purpose: OtpPurpose.PASSWORD_RESET },
      });
    });
  });
});
