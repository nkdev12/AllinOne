import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, UnauthorizedException } from "@nestjs/common";
import { createHmac } from "node:crypto";
import request from "supertest";
import { VaultSettingsController } from "@/vault/controllers/vault-settings.controller";
import { VaultSettingsService } from "@/vault/services/vault-settings.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { OtpService } from "@/common/otp/otp.service";
import { UsersService } from "@/users/users.service";
import { ConfigurationService } from "@/config/configuration.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { TracingModule } from "@/common/tracing/tracing.module";
import { TracingInterceptor } from "@/common/tracing/tracing.interceptor";
import { ErrorHandlingModule } from "@/common/error-handling/error-handling.module";
import { createValidationPipe } from "@/common/errors/validation.pipe";
import { APP_INTERCEPTOR } from "@nestjs/core";

const PEPPER = "a-server-only-pepper-value-0123456789";
const peppered = (verifier: string) =>
  `hmac-sha256:${createHmac("sha256", PEPPER).update(verifier).digest("base64")}`;

/**
 * How the connector answers a write: an `{ increment }` operator moves the
 * number already stored, a bare value replaces it. A fake that only spread
 * `data` over the row would file the operator object as if it were a number, so
 * every assertion about the failed-attempt counter would be reading a mock.
 */
function writtenValue(current: unknown, value: unknown): unknown {
  const operator =
    value !== null && typeof value === "object" && "increment" in value
      ? (value as { increment: number }).increment
      : undefined;
  return operator === undefined ? value : (Number(current) || 0) + operator;
}

/**
 * Enough of the filter language for the two conditional writes the vault makes:
 * equality, which is how a recovery grant is claimed, and "only if it moves
 * forward", which is how a cooldown escalates. A fake that agreed to every
 * filter would let a late, smaller guess overwrite a longer wait, which is the
 * exact lost update these tests are about.
 */
function matchesFilter(
  row: Record<string, any>,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([field, expected]) => {
    if (field === "OR") {
      return (expected as Record<string, unknown>[]).some((alternative) =>
        matchesFilter(row, alternative),
      );
    }
    const actual = row[field];
    if (
      expected !== null &&
      typeof expected === "object" &&
      "lt" in (expected as object)
    ) {
      const bound = (expected as { lt: Date }).lt;
      return actual instanceof Date && actual.getTime() < bound.getTime();
    }
    if (actual instanceof Date && expected instanceof Date) {
      return actual.getTime() === expected.getTime();
    }
    return actual === expected || (actual == null && expected === null);
  });
}

/**
 * The vault endpoints judged the way a device meets them: through the guard, the
 * global validation pipe and the error handler, so what is asserted is the status
 * code and body a client branches on. `vault-settings.service.spec.ts` already
 * covers the decisions themselves; a service-level test cannot see that a
 * `conflict()` reaches the caller as a 409 or that the not-configured `GET` has
 * no `updatedAt` key at all.
 *
 * One in-memory row backs the whole suite, because the interesting cases are
 * about state a previous request left behind — a second setup, a fifth wrong
 * password, a recovery grant that expired.
 */
describe("Vault settings endpoints (E2E)", () => {
  let app: INestApplication;
  let prisma: any;
  let otpService: any;
  let row: Record<string, any> | null = null;

  const verifier = "q7L1Z3mYxk1hZ8jH0lYXn0K8pQe1o2uW3r5t7y9b0cA=";
  const setupBody = {
    masterKeyHash: verifier,
    keySalt: "c2FsdF9iYXNlNjRfc3RyaW5n",
    // The recovery envelope is salt + ciphertext: the key that opens it is the
    // user's 12-word phrase, which no client is allowed to upload.
    recoveryKdfSalt: Buffer.alloc(16, 9).toString("base64"),
    wrappedMasterKey: "d3JhcHBlZA==",
    wrappedMasterIv: "aXY=",
    wrappedMasterTag: "dGFn",
  };

  const recoveryBody = {
    masterKeyHash: "new-verifier",
    keySalt: Buffer.alloc(16, 1).toString("base64"),
    passwordWrappedKey: Buffer.alloc(32, 2).toString("base64"),
    passwordWrappedIv: Buffer.alloc(12, 3).toString("base64"),
    passwordWrappedTag: Buffer.alloc(16, 4).toString("base64"),
    kdfIterations: 3,
    kdfMemory: 65536,
  };

  // Completion re-validates the envelope against the strict field lengths the
  // recovery DTO carries, so an upgrade cannot reuse setup's placeholder bytes.
  const upgradeEnvelope = {
    recoveryKdfSalt: Buffer.alloc(16, 9).toString("base64"),
    wrappedMasterKey: Buffer.alloc(32, 6).toString("base64"),
    wrappedMasterIv: Buffer.alloc(12, 7).toString("base64"),
    wrappedMasterTag: Buffer.alloc(16, 8).toString("base64"),
  };

  beforeAll(async () => {
    prisma = {
      vaultSetting: {
        // A copy, the way a read hands a document to one request: if every
        // caller shared the live object, a read-check-write counter would look
        // correct here because each racer would see the others' writes.
        findUnique: jest
          .fn()
          .mockImplementation(async () => (row ? { ...row } : null)),
        upsert: jest.fn().mockImplementation(async ({ create }) => {
          row = { id: "vault-row", ...create, updatedAt: new Date() };
          return { ...row };
        }),
        updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
          if (!row || !matchesFilter(row, where)) return { count: 0 };
          for (const [field, value] of Object.entries(data)) {
            row[field] = writtenValue(row[field], value);
          }
          return { count: 1 };
        }),
        update: jest.fn().mockImplementation(async ({ data }) => {
          row = row ?? { id: "vault-row", userId: "user-1" };
          for (const [field, value] of Object.entries(data)) {
            row[field] = writtenValue(row[field], value);
          }
          return { ...row };
        }),
      },
    };
    otpService = {
      issue: jest.fn().mockResolvedValue("246810"),
      consume: jest.fn().mockResolvedValue(true),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TracingModule, ErrorHandlingModule],
      controllers: [VaultSettingsController],
      providers: [
        VaultSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: OtpService, useValue: otpService },
        { provide: UsersService, useValue: { getUserById: jest.fn() } },
        {
          provide: ConfigurationService,
          useValue: { isProduction: true, encryptionKey: PEPPER },
        },
        { provide: APP_INTERCEPTOR, useClass: TracingInterceptor },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          if (req.headers.authorization !== "Bearer valid-token") {
            throw new UnauthorizedException("Unauthorized access");
          }
          req.user = { id: "user-1", email: "vault@example.com" };
          return true;
        },
      })
      .compile();

    // The pipe the app actually installs, not a looser stand-in: half of what
    // these tests assert is that a body the DTO refuses never reaches the
    // service at all.
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    // Bound once, before the first request: supertest only starts a listener for
    // a server that has no address, so a burst of parallel requests would
    // otherwise have eight callers binding and closing the same socket.
    await new Promise<void>((resolve) =>
      app.getHttpServer().listen(0, () => resolve()),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => ({ Authorization: "Bearer valid-token" });

  /**
   * Holds every read until `racers` of them are waiting, so the burst really
   * does answer from one snapshot. Reads served as they arrive would serialise
   * the racers — each sees the one before it write — and a read-check-write
   * counter looks flawless when nothing overlaps, which is the whole failure
   * these tests have to be able to see.
   */
  async function racingReads<T>(
    racers: number,
    requests: () => Promise<T>,
  ): Promise<T> {
    const findUnique = prisma.vaultSetting.findUnique;
    let arrive: () => void = () => undefined;
    const allIn = new Promise<void>((resolve) => {
      arrive = () => resolve();
      // A backstop, so a burst that never fills up cannot strand the suite.
      setTimeout(resolve, 25);
    });
    let waiting = 0;
    findUnique.mockImplementation(async () => {
      if (++waiting >= racers) arrive();
      await allIn;
      return row ? { ...row } : null;
    });
    try {
      return await requests();
    } finally {
      arrive();
      findUnique.mockImplementation(async () => (row ? { ...row } : null));
    }
  }

  it("answers a vault that does not exist with the shape the client reads", async () => {
    const response = await request(app.getHttpServer())
      .get("/vault/settings")
      .set(auth())
      .expect(200);

    expect(response.body).toEqual({
      isVaultConfigured: false,
      keySalt: null,
      kdfIterations: null,
      kdfMemory: null,
    });
    // `updatedAt` is absent rather than null here and present after setup. The
    // Flutter side reads the four fields above by name, so this asymmetry is
    // harmless today — recorded so a future change to either side is a choice.
    expect(response.body).not.toHaveProperty("updatedAt");
  });

  describe("after setup", () => {
    beforeEach(() => {
      row = null;
      prisma.vaultSetting.upsert.mockClear();
    });

    it("records the KDF parameters the client reports", async () => {
      const response = await request(app.getHttpServer())
        .post("/vault/settings/setup")
        .set(auth())
        .send({ ...setupBody, kdfIterations: 3, kdfMemory: 65536 })
        .expect(201);

      expect(response.body).toMatchObject({
        isVaultConfigured: true,
        keySalt: setupBody.keySalt,
        kdfIterations: 3,
        kdfMemory: 65536,
      });
    });

    it("stores a peppered copy of the verifier, never the one it was sent", async () => {
      await request(app.getHttpServer())
        .post("/vault/settings/setup")
        .set(auth())
        .send(setupBody)
        .expect(201);

      expect(row?.masterKeyHash).toBe(peppered(verifier));
      expect(row?.masterKeyHash).not.toBe(verifier);
    });

    it("refuses a setup that uploads an unwrapped recovery key", async () => {
      const response = await request(app.getHttpServer())
        .post("/vault/settings/setup")
        .set(auth())
        .send({
          ...setupBody,
          recoveryKey: Buffer.alloc(32, 5).toString("base64"),
        })
        .expect(400);

      expect(response.body.code).toBe("VALIDATION_ERROR");
      expect(prisma.vaultSetting.upsert).not.toHaveBeenCalled();
    });

    it("stores no material the server could open a vault with", async () => {
      await request(app.getHttpServer())
        .post("/vault/settings/setup")
        .set(auth())
        .send(setupBody)
        .expect(201);

      // A stored wrapping key would make every vault recoverable by anyone with
      // database access, which is the property the vault is supposed to have.
      expect(row?.recoveryKey).toBeNull();
      expect(row?.recoveryKdfSalt).toBe(setupBody.recoveryKdfSalt);
    });

    it("refuses to configure a vault that is already configured", async () => {
      await request(app.getHttpServer())
        .post("/vault/settings/setup")
        .set(auth())
        .send(setupBody)
        .expect(201);

      const response = await request(app.getHttpServer())
        .post("/vault/settings/setup")
        .set(auth())
        // A different salt, but still one `recovery/complete` could legally be
        // handed: the point of this test is the 409, not the shape of the body.
        .send({ ...setupBody, keySalt: Buffer.alloc(16, 2).toString("base64") })
        .expect(409);

      expect(response.body.code).toBe("VAULT_ALREADY_CONFIGURED");
      // The refusal has to be the reason nothing moved: a 409 that still wrote
      // the row would replace the salt every vault lives by.
      expect(row?.keySalt).toBe(setupBody.keySalt);
    });

    it("rejects a time cost of zero before the service sees the body", async () => {
      const response = await request(app.getHttpServer())
        .post("/vault/settings/setup")
        .set(auth())
        .send({ ...setupBody, kdfIterations: 0 })
        .expect(400);

      expect(response.body.code).toBe("VALIDATION_ERROR");
      const fields = response.body.details.fields as {
        field: string;
        messages: string[];
      }[];
      expect(fields.map((entry) => entry.field)).toContain("kdfIterations");
      expect(prisma.vaultSetting.upsert).not.toHaveBeenCalled();
    });
  });

  describe("unlock", () => {
    beforeEach(async () => {
      row = null;
      await request(app.getHttpServer())
        .post("/vault/settings/setup")
        .set(auth())
        .send(setupBody)
        .expect(201);
    });

    it("opens with the verifier the client holds", async () => {
      const response = await request(app.getHttpServer())
        .post("/vault/settings/unlock")
        .set(auth())
        .send({ masterKeyHash: verifier })
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it("answers a wrong master password with 401 and a code", async () => {
      const response = await request(app.getHttpServer())
        .post("/vault/settings/unlock")
        .set(auth())
        .send({ masterKeyHash: "bm90LXRoZS1oYXNo" })
        .expect(401);

      expect(response.body.code).toBe("VAULT_MASTER_KEY_MISMATCH");
    });

    it("cools down after repeated failures, and says so in the same 401 shape", async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app.getHttpServer())
          .post("/vault/settings/unlock")
          .set(auth())
          .send({ masterKeyHash: "bm90LXRoZS1oYXNo" })
          .expect(401);
      }

      const cooled = await request(app.getHttpServer())
        .post("/vault/settings/unlock")
        .set(auth())
        .send({ masterKeyHash: verifier })
        .expect(401);

      // The right password is refused too, which is the point: the cooldown
      // gates guessing, and a client that treated this as "wrong password"
      // would tell the user they mistyped it.
      expect(cooled.body.code).toBe("RATE_LIMITED");
      expect(cooled.body.details.retryInSeconds).toBeGreaterThan(0);
    });

    it("counts every guess in a burst of parallel wrong passwords and cools down from the total", async () => {
      // The endpoint an attacker actually races. Guesses that each read the same
      // row and each wrote back `1` never reach the five-attempt ceiling, so the
      // ceiling has to move by `$inc` and the wait has to be sized from the count
      // the row accumulated — not from the zero every racer happened to read.
      const burst = await racingReads(8, () =>
        Promise.all(
          Array.from({ length: 8 }, () =>
            request(app.getHttpServer())
              .post("/vault/settings/unlock")
              .set(auth())
              .send({ masterKeyHash: "bm90LXRoZS1oYXNo" }),
          ),
        ),
      );

      // A burst changes nothing about what each guess is answered with, and the
      // two answers are the only two there are: a guess counted at all gets
      // "wrong password", one that arrived after the row had cooled down gets
      // "rate limited" without moving the counter. So the count has to equal the
      // number of guesses that were answered as wrong — eight parallel racers
      // leaving the counter at `1` is the lost update this test exists for.
      const codes = burst.map((response) => {
        expect(response.status).toBe(401);
        return response.body.code;
      });
      expect(
        codes.every((code) =>
          ["VAULT_MASTER_KEY_MISMATCH", "RATE_LIMITED"].includes(code),
        ),
      ).toBe(true);
      const counted = codes.filter(
        (code) => code === "VAULT_MASTER_KEY_MISMATCH",
      ).length;
      expect(row?.unlockFailedAttempts).toBe(counted);
      expect(row?.unlockFailedAttempts).toBeGreaterThanOrEqual(5);

      const cooled = await request(app.getHttpServer())
        .post("/vault/settings/unlock")
        .set(auth())
        .send({ masterKeyHash: verifier })
        .expect(401);

      // The right password is refused too: the cooldown gates guessing, and a
      // client that read this as "wrong password" would blame the user.
      expect(cooled.body.code).toBe("RATE_LIMITED");
      // The wait standing in the row is the one the accumulated count bought, so
      // whichever racer's write landed last, the shortest deadline did not win.
      const expectedMs = Math.min(
        60_000 * 2 ** (row!.unlockFailedAttempts - 5),
        3_600_000,
      );
      expect(cooled.body.details.retryInSeconds * 1000).toBeGreaterThan(
        expectedMs - 15_000,
      );
      expect(cooled.body.details.retryInSeconds * 1000).toBeLessThanOrEqual(
        expectedMs + 2_000,
      );
    });

    it("starts the streak over when the master password verifies, and only then", async () => {
      // The reset is the one write allowed to move the counter without counting:
      // a verified master password is the owner proving it, whereas a guess that
      // wrote back a number it had read would let a burst decide where its own
      // streak stands. Four guesses, one unlock, four more guesses: still open.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await request(app.getHttpServer())
          .post("/vault/settings/unlock")
          .set(auth())
          .send({ masterKeyHash: "bm90LXRoZS1oYXNo" })
          .expect(401);
      }

      await request(app.getHttpServer())
        .post("/vault/settings/unlock")
        .set(auth())
        .send({ masterKeyHash: verifier })
        .expect(200);
      expect(row?.unlockFailedAttempts).toBe(0);
      expect(row?.unlockLockedUntil).toBeNull();

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await request(app.getHttpServer())
          .post("/vault/settings/unlock")
          .set(auth())
          .send({ masterKeyHash: "bm90LXRoZS1oYXNo" })
          .expect(401);
      }
      expect(row?.unlockFailedAttempts).toBe(4);
      expect(row?.unlockLockedUntil).toBeNull();

      // The fifth guess after the reset is what closes the endpoint, so the
      // threshold the client branches on is measured from the reset, not from
      // the guesses the unlock just wiped.
      await request(app.getHttpServer())
        .post("/vault/settings/unlock")
        .set(auth())
        .send({ masterKeyHash: "bm90LXRoZS1oYXNo" })
        .expect(401);
      expect(row?.unlockFailedAttempts).toBe(5);
      expect(row?.unlockLockedUntil).toBeInstanceOf(Date);
    });

    it("reports 404 rather than 401 when the account has no vault", async () => {
      row = null;

      const response = await request(app.getHttpServer())
        .post("/vault/settings/unlock")
        .set(auth())
        .send({ masterKeyHash: verifier })
        .expect(404);

      expect(response.body.code).toBe("VAULT_NOT_CONFIGURED");
    });
  });

  describe("recovery", () => {
    beforeEach(() => {
      row = null;
    });

    it("will not complete a rotation nobody authorised", async () => {
      row = {
        id: "vault-row",
        userId: "user-1",
        masterKeyHash: peppered(verifier),
        keySalt: setupBody.keySalt,
        kdfIterations: 3,
        kdfMemory: 65536,
        isVaultConfigured: true,
        recoveryKdfSalt: setupBody.recoveryKdfSalt,
        recoveryKey: null,
        wrappedMasterKey: setupBody.wrappedMasterKey,
        wrappedMasterIv: setupBody.wrappedMasterIv,
        wrappedMasterTag: setupBody.wrappedMasterTag,
        recoveryGrantedAt: null,
      };

      const response = await request(app.getHttpServer())
        .post("/vault/settings/recovery/complete")
        .set(auth())
        .send(recoveryBody)
        .expect(401);

      expect(response.body.code).toBe("VAULT_RECOVERY_NOT_PENDING");
      expect(row?.wrappedMasterKey).toBe(setupBody.wrappedMasterKey);
    });

    it("completes recovery atomically, keeps the recovery envelope, and supports retry", async () => {
      await request(app.getHttpServer())
        .post("/vault/settings/setup")
        .set(auth())
        .send(setupBody)
        .expect(201);
      await request(app.getHttpServer())
        .post("/vault/settings/recovery/verify")
        .set(auth())
        .send({ otp: "246810" })
        .expect(200);
      const completed = await request(app.getHttpServer())
        .post("/vault/settings/recovery/complete")
        .set(auth())
        .send(recoveryBody)
        .expect(200);
      expect(completed.body.passwordWrappedKey).toBe(
        recoveryBody.passwordWrappedKey,
      );
      expect(row?.recoveryKdfSalt).toBe(setupBody.recoveryKdfSalt);
      expect(row?.recoveryKey).toBeNull();
      expect(row?.wrappedMasterKey).toBe(setupBody.wrappedMasterKey);
      await request(app.getHttpServer())
        .post("/vault/settings/recovery/complete")
        .set(auth())
        .send(recoveryBody)
        .expect(200);
      await request(app.getHttpServer())
        .post("/vault/settings/unlock")
        .set(auth())
        .send({ masterKeyHash: recoveryBody.masterKeyHash })
        .expect(400);
      await request(app.getHttpServer())
        .post("/vault/settings/unlock")
        .set(auth())
        .send({
          masterKeyHash: recoveryBody.masterKeyHash,
          keyEnvelopeVersion: 1,
        })
        .expect(200);
    });

    it("rejects old destructive recovery requests at validation", async () => {
      await request(app.getHttpServer())
        .post("/vault/settings/recovery/complete")
        .set(auth())
        .send(setupBody)
        .expect(400);
    });

    it("spends a code and hands back the wrapped key, but not the verifier", async () => {
      row = {
        id: "vault-row",
        userId: "user-1",
        masterKeyHash: peppered(verifier),
        keySalt: setupBody.keySalt,
        kdfIterations: 3,
        kdfMemory: 65536,
        isVaultConfigured: true,
        recoveryKdfSalt: setupBody.recoveryKdfSalt,
        recoveryKey: null,
        wrappedMasterKey: setupBody.wrappedMasterKey,
        wrappedMasterIv: setupBody.wrappedMasterIv,
        wrappedMasterTag: setupBody.wrappedMasterTag,
        recoveryGrantedAt: null,
      };

      const response = await request(app.getHttpServer())
        .post("/vault/settings/recovery/verify")
        .set(auth())
        .send({ otp: "246810" })
        .expect(200);

      expect(response.body).toEqual({
        keySalt: setupBody.keySalt,
        recoveryKdfSalt: setupBody.recoveryKdfSalt,
        recoveryKey: null,
        wrappedMasterKey: setupBody.wrappedMasterKey,
        wrappedMasterIv: setupBody.wrappedMasterIv,
        wrappedMasterTag: setupBody.wrappedMasterTag,
      });
      expect(row?.recoveryGrantedAt).toBeInstanceOf(Date);
    });

    it("still opens a vault whose row predates the phrase-derived envelope", async () => {
      // Rows written by builds before 2026-10-17 hold the unwrapped key an old
      // client uploaded. Refusing them would strand their owners, so the key is
      // served as it always was — and no new row can be created with one.
      row = {
        id: "vault-row",
        userId: "user-1",
        masterKeyHash: peppered(verifier),
        keySalt: setupBody.keySalt,
        kdfIterations: 3,
        kdfMemory: 65536,
        isVaultConfigured: true,
        recoveryKdfSalt: null,
        recoveryKey: "bGVnYWN5LXdyYXBwaW5nLWtleQ==",
        wrappedMasterKey: setupBody.wrappedMasterKey,
        wrappedMasterIv: setupBody.wrappedMasterIv,
        wrappedMasterTag: setupBody.wrappedMasterTag,
        recoveryGrantedAt: null,
      };

      const response = await request(app.getHttpServer())
        .post("/vault/settings/recovery/verify")
        .set(auth())
        .send({ otp: "246810" })
        .expect(200);

      expect(response.body.recoveryKey).toBe("bGVnYWN5LXdyYXBwaW5nLWtleQ==");
    });

    it("replaces a legacy unwrapped key when recovery supplies a new envelope", async () => {
      row = {
        id: "vault-row",
        userId: "user-1",
        masterKeyHash: peppered(verifier),
        keySalt: setupBody.keySalt,
        kdfIterations: 3,
        kdfMemory: 65536,
        isVaultConfigured: true,
        recoveryKdfSalt: null,
        recoveryKey: "bGVnYWN5LXdyYXBwaW5nLWtleQ==",
        wrappedMasterKey: setupBody.wrappedMasterKey,
        wrappedMasterIv: setupBody.wrappedMasterIv,
        wrappedMasterTag: setupBody.wrappedMasterTag,
        recoveryGrantedAt: null,
      };

      await request(app.getHttpServer())
        .post("/vault/settings/recovery/verify")
        .set(auth())
        .send({ otp: "246810" })
        .expect(200);
      await request(app.getHttpServer())
        .post("/vault/settings/recovery/complete")
        .set(auth())
        .send({ ...recoveryBody, ...upgradeEnvelope })
        .expect(200);

      expect(row?.recoveryKey).toBeNull();
      expect(row?.recoveryKdfSalt).toBe(upgradeEnvelope.recoveryKdfSalt);
      expect(row?.wrappedMasterKey).toBe(upgradeEnvelope.wrappedMasterKey);
    });
  });
});
