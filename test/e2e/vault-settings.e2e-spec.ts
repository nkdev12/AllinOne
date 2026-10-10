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
    recoveryKey: "cmVjb3Zlcnkt",
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

  beforeAll(async () => {
    prisma = {
      vaultSetting: {
        findUnique: jest.fn().mockImplementation(async () => row),
        upsert: jest.fn().mockImplementation(async ({ create }) => {
          row = { id: "vault-row", ...create, updatedAt: new Date() };
          return row;
        }),
        updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
          if (
            !row ||
            row.masterKeyHash !== where.masterKeyHash ||
            row.recoveryGrantedAt?.getTime() !==
              where.recoveryGrantedAt?.getTime()
          )
            return { count: 0 };
          row = { ...row, ...data };
          return { count: 1 };
        }),
        update: jest.fn().mockImplementation(async ({ data }) => {
          row = { ...(row ?? {}), ...data };
          return row;
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
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => ({ Authorization: "Bearer valid-token" });

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

    it("refuses to configure a vault that is already configured", async () => {
      await request(app.getHttpServer())
        .post("/vault/settings/setup")
        .set(auth())
        .send(setupBody)
        .expect(201);

      const response = await request(app.getHttpServer())
        .post("/vault/settings/setup")
        .set(auth())
        .send({ ...setupBody, keySalt: "bmV3LXNhbHQ=" })
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
        recoveryKey: setupBody.recoveryKey,
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

    it("completes recovery atomically, preserves the old recovery blob, and supports retry", async () => {
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
      expect(row?.recoveryKey).toBe(setupBody.recoveryKey);
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
        recoveryKey: setupBody.recoveryKey,
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
        recoveryKey: setupBody.recoveryKey,
        wrappedMasterKey: setupBody.wrappedMasterKey,
        wrappedMasterIv: setupBody.wrappedMasterIv,
        wrappedMasterTag: setupBody.wrappedMasterTag,
      });
      expect(row?.recoveryGrantedAt).toBeInstanceOf(Date);
    });
  });
});
