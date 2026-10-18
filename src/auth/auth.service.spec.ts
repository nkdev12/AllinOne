import { Test, TestingModule } from "@nestjs/testing";
import { AuthService } from "./auth.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { UsersService } from "@/users/users.service";
import { JwtService } from "@nestjs/jwt";
import { ConfigurationService } from "@/config/configuration.service";
import { OtpService } from "@/common/otp/otp.service";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { AuditAction } from "@prisma/client";
import { AuditLogService } from "@/common/audit/audit-log.service";
import { ErrorCode } from "@/common/errors/error-code";
import { RefreshTokenGraceStore } from "./refresh-token-grace.store";
import * as argon2 from "argon2";
import * as crypto from "crypto";
import { generateSecret, generateURI, verify } from "otplib";

jest.mock("argon2");
jest.mock("otplib");

describe("AuthService", () => {
  let service: AuthService;
  let prismaService: any;
  let usersService: any;
  let jwtService: any;
  let configService: any;
  let otpService: any;
  let auditLogService: any;

  const mockUser = {
    id: "user-uuid-123",
    email: "test@example.com",
    displayName: "Test User",
    locale: "en-US",
    timezone: "UTC",
    status: "ACTIVE",
    createdAt: new Date(),
    deletedAt: null,
    emailVerifiedAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
  };

  const mockDevice = {
    id: "device-uuid-456",
    userId: "user-uuid-123",
    name: "Primary Web/Client Device",
    platform: "WEB",
    appVersion: "1.0.0",
  };

  const mockSession = {
    id: "session-uuid-789",
    userId: "user-uuid-123",
    deviceId: "device-uuid-456",
    accessToken: "mock-access-token",
    refreshToken: "mock-refresh-token",
    refreshExpiresAt: new Date(Date.now() + 100000),
    revokedAt: null,
    user: mockUser,
  };

  const mockMfaSetting = {
    id: "mfa-uuid-1",
    userId: "user-uuid-123",
    totpEnabled: true,
    totpSecret: "MOCKSECRET123",
    recoveryCodes: JSON.stringify(["mock-hashed-code"]),
  };

  function sameStoredValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }
    return false;
  }

  /**
   * A stand-in for the `User` row that behaves like the Mongo document it
   * replaces.
   *
   * It is here because the previous stub — `update` answering with one frozen
   * `mockUser` no matter what was written — could not tell the two shapes of
   * failed-attempt bookkeeping apart. Writing an absolute `attempts` this
   * request computed for itself and handing MongoDB an `$inc` both satisfied it,
   * which is exactly how the lost-increment bug survived a green suite. This
   * store adds each operator's amount to whatever the row holds at that moment
   * and answers with the row as it looks afterwards, the way Prisma's MongoDB
   * connector answers an `update` that carries a `select`.
   */
  function useUserRowStore(initial: Record<string, unknown> = {}) {
    const row: Record<string, any> = {
      id: mockUser.id,
      failedLoginAttempts: 0,
      lockedUntil: null,
      ...initial,
    };

    const apply = (data: Record<string, unknown>) => {
      for (const [field, value] of Object.entries(data || {})) {
        const increment = (value as { increment?: unknown })?.increment;
        if (typeof increment === "number") {
          // A missing field starts from 0, as `$inc` does on a document written
          // before `failedLoginAttempts` was added to the schema.
          row[field] = (row[field] ?? 0) + increment;
        } else {
          row[field] = value;
        }
      }
    };

    prismaService.user.update.mockImplementation(
      ({ where, data, select }: any) => {
        if (where?.id !== row.id) {
          return Promise.reject(new Error("P2025"));
        }
        apply(data);
        return Promise.resolve(
          select
            ? Object.fromEntries(
                Object.keys(select).map((field) => [field, row[field]]),
              )
            : { ...row },
        );
      },
    );

    // The compare-and-swap rides on `updateMany`, so this has to honour the
    // filter rather than always reporting a hit: a write that no longer matches
    // the value it read applies to nothing.
    prismaService.user.updateMany.mockImplementation(({ where, data }: any) => {
      const matched =
        where?.id === row.id &&
        sameStoredValue(where?.lockedUntil, row.lockedUntil);
      if (matched) apply(data);
      return Promise.resolve({ count: matched ? 1 : 0 });
    });

    return row;
  }

  beforeEach(async () => {
    prismaService = {
      $transaction: jest.fn((cb) => cb(prismaService)),
      $runCommandRaw: jest.fn(),
      user: {
        create: jest.fn().mockResolvedValue(mockUser),
        update: jest.fn().mockResolvedValue(mockUser),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(mockUser),
      },
      authentication: {
        create: jest.fn().mockResolvedValue({ id: "auth-1" }),
        findFirst: jest.fn(),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: "oauth-1", userId: "user-uuid-123" }]),
        findUnique: jest.fn().mockResolvedValue({ id: "auth-1" }),
        update: jest.fn().mockResolvedValue({ id: "auth-1" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      device: {
        create: jest.fn().mockResolvedValue(mockDevice),
        findFirst: jest.fn().mockResolvedValue(mockDevice),
      },
      session: {
        // Echoes the caller's `data` back, the way the real row does — the
        // service mints the session id itself, and tests need to see the one
        // that was stored.
        create: jest.fn((args: any) =>
          Promise.resolve({ ...mockSession, ...args.data }),
        ),
        findUnique: jest.fn().mockResolvedValue(mockSession),
        update: jest.fn().mockResolvedValue(mockSession),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      mFASetting: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue(mockMfaSetting),
        update: jest.fn().mockResolvedValue(mockMfaSetting),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      emailVerificationOtp: {
        upsert: jest.fn(),
        findFirst: jest.fn(),
        delete: jest.fn(),
      },
    };

    usersService = {
      findByEmail: jest.fn(),
      getUserById: jest.fn().mockResolvedValue(mockUser),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue("mock-jwt-token"),
      verify: jest
        .fn()
        .mockReturnValue({ sub: "user-uuid-123", purpose: "MFA_CHALLENGE" }),
      decode: jest.fn().mockReturnValue({
        sub: "apple-123",
        email: "test@example.com",
        name: "Test User",
      }),
    };

    configService = {
      jwtAccessSecret: "access-secret",
      jwtRefreshSecret: "refresh-secret",
      // Not 900 / 604800, the two literals this file used to have no way to
      // contradict: standing in for `JWT_ACCESS_EXPIRATION=1h` and
      // `JWT_REFRESH_EXPIRATION=1d` so a leftover literal is visible.
      jwtAccessExpiresInSeconds: 3600,
      jwtRefreshExpiresInSeconds: 86400,
      emailVerifyEnabled: false,
      googleClientId: "google-client-id",
      appleClientId: "apple-client-id",
      microsoftClientId: "microsoft-client-id",
      jwtMfaSecret: "mfa-secret",
      // A real `ENCRYPTION_KEY`, the way `validateConfiguration()` demands one
      // before the process boots. `getTotpEncryptionKey()` now refuses outright
      // rather than reaching for a checked-in literal, so omitting it would have
      // every MFA test here exercise a broken deployment instead of the one it
      // means to describe.
      encryptionKey: "unit-test-totp-encryption-key-0123456789abcdef",
      // OTP printing is opted into by naming the environment, not by the absence
      // of a production label. `false` puts this suite on the same side of that
      // gate as staging.
      isDevelopment: false,
      // The rotation window is Redis-backed in a deployed process and in-process
      // here. Spelled out rather than left undefined so this suite keeps saying
      // "no Redis", the way `APP_ENV=test` does for the throttler's storage.
      usesRedisThrottlerStorage: false,
    };

    otpService = {
      issue: jest.fn().mockResolvedValue("123456"),
      consume: jest.fn().mockResolvedValue(true),
    };

    auditLogService = {
      recordAuditLog: jest.fn().mockResolvedValue({ id: "audit-1" }),
    };

    (generateSecret as jest.Mock).mockReturnValue("MOCKSECRET123");
    (generateURI as jest.Mock).mockReturnValue("otpauth://totp/mock");
    (verify as jest.Mock).mockResolvedValue({ valid: true });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaService },
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigurationService, useValue: configService },
        { provide: OtpService, useValue: otpService },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("register", () => {
    it("should throw ConflictException if email is already taken", async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);

      await expect(
        service.register({
          email: "test@example.com",
          password: "Password123!",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("should successfully register a new user and return tokens", async () => {
      usersService.findByEmail.mockResolvedValue(null);
      (argon2.hash as jest.Mock).mockResolvedValue("hashed_password");

      const result = await service.register({
        email: "new@example.com",
        password: "Password123!",
      });

      expect(result).toBeDefined();
      expect(result.user?.email).toBe("test@example.com");
      expect(result.tokens?.accessToken).toBe("mock-jwt-token");
      expect(result.sessionId).toEqual(expect.any(String));
      const sessionCreate = prismaService.session.create.mock.calls[0][0];
      expect(sessionCreate.data.accessToken).toBe(sessionCreate.data.id);
      expect(sessionCreate.data.refreshToken).not.toBe("mock-jwt-token");
      expect(auditLogService.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ACCOUNT_CREATED,
        }),
      );
    });

    it("names the device row the new account starts on", async () => {
      usersService.findByEmail.mockResolvedValue(null);
      (argon2.hash as jest.Mock).mockResolvedValue("hashed_password");

      const result = await service.register({
        email: "new@example.com",
        password: "Password123!",
      });

      expect(prismaService.device.create).toHaveBeenCalled();
      expect(result.user?.id).toBe(mockUser.id);
      expect(result.deviceId).toBe(mockDevice.id);
    });

    it("requires email verification before registration can issue a session", async () => {
      usersService.findByEmail.mockResolvedValue(null);
      configService.emailVerifyEnabled = true;
      (argon2.hash as jest.Mock).mockResolvedValue("hashed_password");

      const result = await service.register({
        email: "new@example.com",
        password: "Password123!",
      });

      expect(result.tokens).toBeUndefined();
      expect(result.sessionId).toBeUndefined();
      expect(result.deviceId).toBeUndefined();
      expect(prismaService.session.create).not.toHaveBeenCalled();
    });
  });

  describe("email verification OTP", () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("stores only a hashed OTP in MongoDB", async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      jest.spyOn(Math, "random").mockReturnValue(0);

      await service.requestEmailVerification(mockUser.email);

      expect(prismaService.$runCommandRaw).toHaveBeenCalledWith(
        expect.objectContaining({
          update: "email_verification_otps",
          updates: [
            expect.objectContaining({
              q: { userId: mockUser.id },
              u: expect.objectContaining({
                $set: expect.objectContaining({
                  codeHash: expect.not.stringMatching("100000"),
                }),
              }),
            }),
          ],
        }),
      );
    });

    it("accepts a valid MongoDB OTP once and removes it atomically", async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      prismaService.$runCommandRaw.mockResolvedValueOnce({
        value: { _id: "otp-id" },
      });

      await expect(
        service.confirmEmailVerification(undefined, mockUser.email, "100000"),
      ).resolves.toEqual({ message: "Email address successfully verified" });

      expect(prismaService.$runCommandRaw).toHaveBeenCalledWith(
        expect.objectContaining({
          findAndModify: "email_verification_otps",
          remove: true,
        }),
      );
    });
  });

  describe("OTP console logging", () => {
    let debug: jest.SpyInstance;

    beforeEach(() => {
      debug = jest.spyOn(Logger.prototype, "debug").mockImplementation();
      usersService.findByEmail.mockResolvedValue(mockUser);
      prismaService.$runCommandRaw.mockResolvedValue({});
    });

    afterEach(() => {
      debug.mockRestore();
    });

    it("prints the code only where the environment has named itself development", async () => {
      configService.isDevelopment = true;

      await service.requestEmailVerification(mockUser.email);
      await service.forgotPassword(mockUser.email);

      expect(debug).toHaveBeenCalledWith(expect.stringContaining("OTP CODE"));
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining(
          "PASSWORD RESET OTP FOR test@example.com: 123456",
        ),
      );
    });

    it("logs that a code exists, never the code, wherever isProduction is merely absent", async () => {
      // The gate used to be `!isProduction`, which is a different question and
      // the more permissive one: staging, a mislabelled deployment, and a
      // container that never read `APP_ENV` all answer "not production" and went
      // on printing codes that are live credentials for the next hour.
      configService.isDevelopment = false;
      configService.isProduction = false;

      await service.requestEmailVerification(mockUser.email);
      await service.forgotPassword(mockUser.email);

      // Six digits is the shape of every code either flow issues, so a six-digit
      // run anywhere in the console output is the leak, whatever the wording.
      const printed = debug.mock.calls.map(([line]) => String(line));
      expect(printed.filter((line) => /\d{6}/.test(line))).toEqual([]);
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining("Verification OTP issued for test@example.com"),
      );
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining(
          "Password reset OTP issued for test@example.com",
        ),
      );
    });
  });

  describe("login and account lockout", () => {
    const validAuthRecord = {
      id: "auth-1",
      userId: "user-uuid-123",
      type: "EMAIL_PASSWORD",
      identifier: "test@example.com",
      passwordHash: "valid-hash",
      user: {
        ...mockUser,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    };

    it("should throw UnauthorizedException if auth record is missing", async () => {
      prismaService.authentication.findFirst.mockResolvedValue(null);

      await expect(
        service.login({
          email: "missing@example.com",
          password: "Password123!",
        }),
      ).rejects.toThrow(UnauthorizedException);

      expect(auditLogService.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.LOGIN_FAILURE,
        }),
      );
      expect(argon2.verify).toHaveBeenCalledWith(
        expect.stringContaining("$argon2id$"),
        "Password123!",
      );
    });

    it("rejects an unverified email when verification is required", async () => {
      configService.emailVerifyEnabled = true;
      prismaService.authentication.findFirst.mockResolvedValue(validAuthRecord);
      (argon2.verify as jest.Mock).mockResolvedValue(true);

      await expect(
        service.login({
          email: "test@example.com",
          password: "CorrectPassword123!",
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.EMAIL_NOT_VERIFIED },
      });
      expect(prismaService.session.create).not.toHaveBeenCalled();
    });

    it("should throw UnauthorizedException if account is currently locked", async () => {
      const lockedUntil = new Date(Date.now() + 10 * 60 * 1000);
      prismaService.authentication.findFirst.mockResolvedValue({
        ...validAuthRecord,
        user: {
          ...mockUser,
          failedLoginAttempts: 5,
          lockedUntil,
        },
      });

      await expect(
        service.login({
          email: "test@example.com",
          password: "Password123!",
        }),
      ).rejects.toThrow(UnauthorizedException);

      expect(auditLogService.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.LOGIN_FAILURE,
          userId: "user-uuid-123",
        }),
      );
    });

    it("hands the failed-attempt counter to MongoDB instead of computing it", async () => {
      const row = useUserRowStore({ failedLoginAttempts: 2 });
      prismaService.authentication.findFirst.mockResolvedValue({
        ...validAuthRecord,
        user: {
          ...mockUser,
          failedLoginAttempts: 2,
          lockedUntil: null,
        },
      });
      (argon2.verify as jest.Mock).mockResolvedValue(false);

      await expect(
        service.login({
          email: "test@example.com",
          password: "WrongPassword!",
        }),
      ).rejects.toThrow(UnauthorizedException);

      // No absolute `3` anywhere in the write: the number the row ends at is
      // produced by the operator, so no value this request read can decide it.
      expect(prismaService.user.update).toHaveBeenCalledWith({
        where: { id: "user-uuid-123" },
        data: { failedLoginAttempts: { increment: 1 } },
        select: { failedLoginAttempts: true, lockedUntil: true },
      });
      expect(row.failedLoginAttempts).toBe(3);
      // A failure short of the threshold leaves no `lockedUntil` behind — and
      // specifically does not write `null` over a lock another request opened.
      expect(row.lockedUntil).toBeNull();
      expect(auditLogService.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.LOGIN_FAILURE,
          userId: "user-uuid-123",
        }),
      );
    });

    it("loses no attempt when two failures land on the same row at once", async () => {
      const row = useUserRowStore({ failedLoginAttempts: 4 });
      // One snapshot of the row, two requests — the shape a retry storm or a
      // spray from several IPs produces, and the reason this counter is the one
      // an attacker wants kept low.
      prismaService.authentication.findFirst.mockResolvedValue({
        ...validAuthRecord,
        user: {
          ...mockUser,
          failedLoginAttempts: 4,
          lockedUntil: null,
        },
      });
      (argon2.verify as jest.Mock).mockResolvedValue(false);

      const attempt = () =>
        service.login({
          email: "test@example.com",
          password: "WrongPassword!",
        });

      const settled = await Promise.allSettled([attempt(), attempt()]);
      expect(settled.every((result) => result.status === "rejected")).toBe(
        true,
      );

      // Under read-compute-write both requests read `4`, both wrote `5`, and the
      // second failure bought itself a free pass. Each one now carries its own
      // increment, so the row ends at 6.
      expect(row.failedLoginAttempts).toBe(6);
      expect(row.lockedUntil).toBeInstanceOf(Date);
      // Two writes, and neither of them an absolute value: no request can undo
      // arithmetic it never saw.
      expect(prismaService.user.update).toHaveBeenCalledTimes(2);
      for (const [args] of prismaService.user.update.mock.calls) {
        expect(args.data).toEqual({ failedLoginAttempts: { increment: 1 } });
      }
    });

    it("should lock account for 15 minutes when reaching 5 failed attempts", async () => {
      const row = useUserRowStore({ failedLoginAttempts: 4 });
      prismaService.authentication.findFirst.mockResolvedValue({
        ...validAuthRecord,
        user: {
          ...mockUser,
          failedLoginAttempts: 4,
          lockedUntil: null,
        },
      });
      (argon2.verify as jest.Mock).mockResolvedValue(false);

      await expect(
        service.login({
          email: "test@example.com",
          password: "WrongPassword!",
        }),
      ).rejects.toThrow("Account has been temporarily locked for 15 minutes");

      expect(row.failedLoginAttempts).toBe(5);
      expect(row.lockedUntil).toBeInstanceOf(Date);
      const cooldownMs = row.lockedUntil.getTime() - Date.now();
      expect(cooldownMs).toBeGreaterThan(14 * 60 * 1000);
      expect(cooldownMs).toBeLessThanOrEqual(15 * 60 * 1000);
      expect(auditLogService.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ACCOUNT_LOCKED,
          userId: "user-uuid-123",
        }),
      );
    });

    it("should reset failedLoginAttempts to 0 upon successful login", async () => {
      const row = useUserRowStore({ failedLoginAttempts: 3 });
      prismaService.authentication.findFirst.mockResolvedValue({
        ...validAuthRecord,
        user: {
          ...mockUser,
          failedLoginAttempts: 3,
          lockedUntil: null,
        },
      });
      (argon2.verify as jest.Mock).mockResolvedValue(true);

      const result = await service.login({
        email: "test@example.com",
        password: "CorrectPassword123!",
      });

      expect(result).toBeDefined();
      expect(result.tokens?.accessToken).toBe("mock-jwt-token");
      // The reset is a compare-and-swap: it names the lock state this request
      // read, so it can only undo what it actually saw.
      expect(prismaService.user.updateMany).toHaveBeenCalledWith({
        where: { id: "user-uuid-123", lockedUntil: null },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
      expect(row.failedLoginAttempts).toBe(0);
      expect(row.lockedUntil).toBeNull();
    });

    it("does not undo a lock that opened while the password was being verified", async () => {
      const lockedAt = new Date(Date.now() + 15 * 60 * 1000);
      const row = useUserRowStore({ failedLoginAttempts: 4 });
      prismaService.authentication.findFirst.mockResolvedValue({
        ...validAuthRecord,
        user: {
          ...mockUser,
          failedLoginAttempts: 4,
          lockedUntil: null,
        },
      });
      // `argon2.verify` is the slow step of `login`, and that is the point: a
      // concurrent failure crosses the threshold inside it, hundreds of
      // milliseconds after this request read an unlocked row.
      (argon2.verify as jest.Mock).mockImplementation(async () => {
        row.failedLoginAttempts = 5;
        row.lockedUntil = lockedAt;
        return true;
      });

      const result = await service.login({
        email: "test@example.com",
        password: "CorrectPassword123!",
      });

      expect(result.tokens?.accessToken).toBe("mock-jwt-token");
      expect(row.lockedUntil).toBe(lockedAt);
      expect(row.failedLoginAttempts).toBe(5);
    });

    it("names the session row inside the tokens it mints", async () => {
      prismaService.authentication.findFirst.mockResolvedValue({
        ...validAuthRecord,
        user: {
          ...mockUser,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      (argon2.verify as jest.Mock).mockResolvedValue(true);

      const result = await service.login({
        email: "test@example.com",
        password: "CorrectPassword123!",
      });

      // `JwtStrategy` only compares a token against its session row when the
      // token says which session it is, and `POST /auth/logout` reads the id
      // from that same claim. A login that minted tokens without one handed out
      // a session the client could not sign out of.
      const stored = prismaService.session.create.mock.calls.at(-1)[0].data;
      const signed = jwtService.sign.mock.calls.map(
        ([payload]: [Record<string, unknown>]) => payload,
      );

      expect(stored.id).toEqual(expect.any(String));
      expect(result.sessionId).toBe(stored.id);
      expect(signed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sub: mockUser.id, sessionId: stored.id }),
        ]),
      );
    });

    it("mints, reports and stores one access lifetime rather than three", async () => {
      prismaService.authentication.findFirst.mockResolvedValue({
        ...validAuthRecord,
        user: { ...mockUser, failedLoginAttempts: 0, lockedUntil: null },
      });
      (argon2.verify as jest.Mock).mockResolvedValue(true);

      await service.login({
        email: "test@example.com",
        password: "CorrectPassword123!",
      });

      // The lifetime used to be stated three times over — the `sign()` option,
      // the `expiresIn` the client counts down, and the session row's
      // `accessExpiresAt` — all as literals, while `JWT_ACCESS_EXPIRATION`
      // appeared in `.env.example` and in both Joi schemas and reached none of
      // them. A deployment that set an hour went on issuing a 900-second
      // promise for a 15-minute token, and the session row said something third.
      const signOptions = jwtService.sign.mock.calls.map(
        (call: any[]) => call[1],
      );
      expect(signOptions[0]).toEqual(
        expect.objectContaining({ expiresIn: 3600 }),
      );
      expect(signOptions[1]).toEqual(
        expect.objectContaining({ expiresIn: 86400 }),
      );

      const stored = prismaService.session.create.mock.calls.at(-1)[0].data;
      const minute = 60 * 1000;
      expect(stored.accessExpiresAt.getTime()).toBeGreaterThan(
        Date.now() + 59 * minute,
      );
      expect(stored.accessExpiresAt.getTime()).toBeLessThan(
        Date.now() + 61 * minute,
      );
      expect(stored.refreshExpiresAt.getTime()).toBeGreaterThan(
        Date.now() + 23 * 60 * minute,
      );
      expect(stored.refreshExpiresAt.getTime()).toBeLessThan(
        Date.now() + 25 * 60 * minute,
      );
    });

    it("hands back the device row the saved session belongs to", async () => {
      prismaService.authentication.findFirst.mockResolvedValue(validAuthRecord);
      (argon2.verify as jest.Mock).mockResolvedValue(true);
      const savedDeviceId = "0f2c1c6a-2f3e-4a5b-8c9d-0e1f2a3b4c5d";
      prismaService.device.findFirst.mockResolvedValue({
        ...mockDevice,
        id: savedDeviceId,
      });

      const result = await service.login({
        email: "test@example.com",
        password: "CorrectPassword123!",
        deviceId: savedDeviceId,
      });

      expect(prismaService.device.findFirst).toHaveBeenCalledTimes(1);
      expect(prismaService.device.findFirst).toHaveBeenCalledWith({
        where: { id: savedDeviceId, userId: "user-uuid-123", revokedAt: null },
      });
      expect(prismaService.device.create).not.toHaveBeenCalled();
      expect(result.deviceId).toBe(savedDeviceId);
    });

    it("ignores a device id that does not belong to this user", async () => {
      prismaService.authentication.findFirst.mockResolvedValue(validAuthRecord);
      (argon2.verify as jest.Mock).mockResolvedValue(true);
      prismaService.device.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...mockDevice, platform: "LINUX" });

      const result = await service.login({
        email: "test@example.com",
        password: "CorrectPassword123!",
        deviceId: "11111111-1111-4111-8111-111111111111",
        deviceName: "AllInOne Desktop",
        platform: "LINUX",
      });

      expect(prismaService.device.create).not.toHaveBeenCalled();
      expect(result.deviceId).toBe(mockDevice.id);
    });
  });

  describe("verifyMfaLogin", () => {
    const challenge = {
      sub: "user-uuid-123",
      email: "test@example.com",
      deviceId: "device-uuid-456",
      purpose: "MFA_CHALLENGE",
    };

    beforeEach(() => {
      jwtService.verify.mockReturnValue(challenge);
      prismaService.mFASetting.findUnique.mockResolvedValue(mockMfaSetting);
    });

    it("completes the sign-in the challenge started", async () => {
      (verify as jest.Mock).mockResolvedValue({ valid: true });

      const result = await service.verifyMfaLogin({
        mfaToken: "mfa-token",
        totpCode: "123456",
      });

      expect(result.tokens?.accessToken).toBe("mock-jwt-token");
      expect(result.deviceId).toBe("device-uuid-456");
    });

    it("refuses a code the authenticator did not produce", async () => {
      (verify as jest.Mock).mockResolvedValue({ valid: false });

      const thrown = (await service
        .verifyMfaLogin({ mfaToken: "mfa-token", totpCode: "000000" })
        .catch((error: unknown) => error)) as HttpException;

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown.getResponse() as { code?: string }).code).toBe(
        ErrorCode.MFA_CODE_INVALID,
      );
    });

    it("locks account when 5 failed MFA attempts occur", async () => {
      const row = useUserRowStore({ failedLoginAttempts: 4 });
      (verify as jest.Mock).mockResolvedValue({ valid: false });
      usersService.getUserById.mockResolvedValue({
        ...mockUser,
        failedLoginAttempts: 4,
      });

      const thrown = (await service
        .verifyMfaLogin({ mfaToken: "mfa-token", totpCode: "000000" })
        .catch((error: unknown) => error)) as HttpException;

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown.getResponse() as { code?: string }).code).toBe(
        ErrorCode.RATE_LIMITED,
      );
      expect(prismaService.user.update).toHaveBeenCalledWith({
        where: { id: "user-uuid-123" },
        data: { failedLoginAttempts: { increment: 1 } },
        select: { failedLoginAttempts: true, lockedUntil: true },
      });
      expect(row.failedLoginAttempts).toBe(5);
      expect(row.lockedUntil).toBeInstanceOf(Date);
    });

    it("counts every guess when two codes are checked against one challenge", async () => {
      const row = useUserRowStore({ failedLoginAttempts: 4 });
      (verify as jest.Mock).mockResolvedValue({ valid: false });
      usersService.getUserById.mockResolvedValue({
        ...mockUser,
        failedLoginAttempts: 4,
      });

      const attempt = () =>
        service.verifyMfaLogin({ mfaToken: "mfa-token", totpCode: "000000" });
      const settled = await Promise.allSettled([attempt(), attempt()]);
      expect(settled.every((result) => result.status === "rejected")).toBe(
        true,
      );

      // The same read-compute-write that let a password spray hide attempts: here
      // both requests saw `4` and each got its own increment anyway.
      expect(row.failedLoginAttempts).toBe(6);
      expect(prismaService.user.update).toHaveBeenCalledTimes(2);
      for (const [args] of prismaService.user.update.mock.calls) {
        expect(args.data).toEqual({ failedLoginAttempts: { increment: 1 } });
      }
    });

    it("refuses MFA verification when account is locked", async () => {
      usersService.getUserById.mockResolvedValue({
        ...mockUser,
        lockedUntil: new Date(Date.now() + 60000),
      });

      const thrown = (await service
        .verifyMfaLogin({ mfaToken: "mfa-token", totpCode: "123456" })
        .catch((error: unknown) => error)) as HttpException;

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown.getResponse() as { code?: string }).code).toBe(
        ErrorCode.RATE_LIMITED,
      );
    });
  });

  /**
   * Spending a recovery code is a read-modify-write on a JSON array that two
   * concurrent MFA logins can each hold their own snapshot of. A MongoDB
   * transaction does not lock that document against a reader of the same shape,
   * so the old version let each writer put back the array it had read: a code the
   * other request just spent came back to life, and the loser silently reverted
   * the bookkeeping. These drive `redeemRecoveryCode` directly because the
   * double-spend is a property of that write, not of the login around it.
   */
  describe("recovery code redemption", () => {
    const codeA = "AAAA-1111";
    const codeB = "BBBB-2222";
    const hashOf = (code: string) =>
      crypto.createHash("sha256").update(code).digest("hex");

    function useMFASettingRow(initial: {
      recoveryCodes: string[];
      backupCodesUsed: string[] | null;
    }) {
      const row: Record<string, any> = {
        id: "mfa-uuid-1",
        userId: mockUser.id,
        totpEnabled: true,
        totpSecret: "MOCKSECRET123",
        recoveryCodes: JSON.stringify(initial.recoveryCodes),
        // `null` is the state a document that has never spent a code is in, and
        // the filter has to pin it rather than normalise it away.
        backupCodesUsed:
          initial.backupCodesUsed === null
            ? null
            : JSON.stringify(initial.backupCodesUsed),
      };

      prismaService.mFASetting.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.userId === row.userId ? { ...row } : null),
      );

      // The compare-and-swap: the write lands only while the document still holds
      // the exact arrays this request read, which is what a `where` on those
      // fields means to the connector and what an unconditional `update` could
      // never express.
      prismaService.mFASetting.updateMany.mockImplementation(
        ({ where, data }: any) => {
          const matched =
            where?.userId === row.userId &&
            where.recoveryCodes === row.recoveryCodes &&
            (where.backupCodesUsed ?? null) === (row.backupCodesUsed ?? null);
          if (matched) Object.assign(row, data);
          return Promise.resolve({ count: matched ? 1 : 0 });
        },
      );

      return row;
    }

    const redeem = (code: string) =>
      (service as any).redeemRecoveryCode(
        mockUser.id,
        code,
      ) as Promise<boolean>;

    it("spends a code once when two logins present it at the same time", async () => {
      const row = useMFASettingRow({
        recoveryCodes: [hashOf(codeA), hashOf(codeB)],
        backupCodesUsed: [],
      });

      const results = await Promise.all([redeem(codeA), redeem(codeA)]);

      expect(results.filter((spent) => spent)).toHaveLength(1);
      // The attempt that lost the race never wrote, so the spent code is not back
      // in the list and the winner's bookkeeping stands.
      expect(JSON.parse(row.recoveryCodes)).toEqual([hashOf(codeB)]);
      expect(JSON.parse(row.backupCodesUsed)).toEqual([hashOf(codeA)]);
    });

    it("spends one of two concurrent codes rather than resurrecting either", async () => {
      const row = useMFASettingRow({
        recoveryCodes: [hashOf(codeA), hashOf(codeB)],
        backupCodesUsed: [],
      });

      const results = await Promise.all([redeem(codeA), redeem(codeB)]);

      expect(results.filter((spent) => spent)).toHaveLength(1);
      const remaining: string[] = JSON.parse(row.recoveryCodes);
      const spent: string[] = JSON.parse(row.backupCodesUsed);
      expect(remaining).toHaveLength(1);
      expect(spent).toHaveLength(1);
      // No hash sits on both sides of the document, which is the shape a
      // resurrected code has.
      expect(remaining).not.toContain(spent[0]);
    });

    it("refuses the attempt and leaves the document untouched when it changed after the read", async () => {
      const row = useMFASettingRow({
        recoveryCodes: [hashOf(codeA), hashOf(codeB)],
        backupCodesUsed: [hashOf("CCCC-3333")],
      });
      // The read answers with a snapshot taken before somebody else spent a code.
      prismaService.mFASetting.findUnique.mockResolvedValueOnce({
        ...row,
        backupCodesUsed: JSON.stringify([]),
      });
      const untouched = { ...row };

      await expect(redeem(codeA)).resolves.toBe(false);

      expect(row.recoveryCodes).toBe(untouched.recoveryCodes);
      expect(row.backupCodesUsed).toBe(untouched.backupCodesUsed);
    });

    it("guards a document whose used-code list has never been written", async () => {
      const row = useMFASettingRow({
        recoveryCodes: [hashOf(codeA)],
        backupCodesUsed: null,
      });

      await expect(redeem(codeA)).resolves.toBe(true);

      expect(JSON.parse(row.backupCodesUsed)).toEqual([hashOf(codeA)]);
      expect(JSON.parse(row.recoveryCodes)).toEqual([]);
      // The `null` this request read is part of the filter it wrote with, so the
      // first spend is guarded like every later one.
      expect(prismaService.mFASetting.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: mockUser.id,
            recoveryCodes: JSON.stringify([hashOf(codeA)]),
            backupCodesUsed: null,
          }),
        }),
      );
    });

    it("refuses a code that has already been spent", async () => {
      useMFASettingRow({
        recoveryCodes: [hashOf(codeA)],
        backupCodesUsed: [hashOf(codeA)],
      });

      await expect(redeem(codeA)).resolves.toBe(false);
      expect(prismaService.mFASetting.updateMany).not.toHaveBeenCalled();
    });

    it("performs the swap without a transaction", async () => {
      useMFASettingRow({ recoveryCodes: [hashOf(codeA)], backupCodesUsed: [] });

      await expect(redeem(codeA)).resolves.toBe(true);

      // Nothing else in the old callback touched `tx`; the conditional write is
      // what makes the spend atomic, so the transaction was dead weight.
      expect(prismaService.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("MFA secret encryption", () => {
    it("stores encrypted totpSecret and verifies successfully with decrypted secret", async () => {
      let storedSecret: string | null = null;
      prismaService.mFASetting.upsert.mockImplementation(
        async ({ create }: any) => {
          storedSecret = create.totpSecret;
          return { ...mockMfaSetting, totpSecret: storedSecret };
        },
      );

      const genResult = await service.generateMfaSecret("user-uuid-123");
      expect(genResult.secret).toBe("MOCKSECRET123");
      expect(storedSecret).toMatch(/^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);

      prismaService.mFASetting.findUnique.mockResolvedValue({
        ...mockMfaSetting,
        totpSecret: storedSecret,
      });

      await service.enableMfa("user-uuid-123", { totpCode: "123456" });
      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "123456",
          secret: "MOCKSECRET123",
        }),
      );
    });
  });

  describe("TOTP encryption key", () => {
    const CHECKED_IN_FALLBACK = "allinone-default-dev-totp-encryption-key-32b";

    /** Enrols a secret and hands back the ciphertext the row would hold. */
    async function sealASecret(): Promise<string> {
      let stored = "";
      prismaService.mFASetting.upsert.mockImplementation(
        async ({ create }: any) => {
          stored = create.totpSecret;
          return { ...mockMfaSetting, totpSecret: stored };
        },
      );
      await service.generateMfaSecret("user-uuid-123");
      return stored;
    }

    it("refuses to enrol rather than seal a secret under a default key", async () => {
      delete configService.encryptionKey;

      const thrown = (await service
        .generateMfaSecret("user-uuid-123")
        .catch((error: unknown) => error)) as HttpException;

      expect(thrown).toBeInstanceOf(InternalServerErrorException);
      expect(thrown.message).toContain("ENCRYPTION_KEY");
      // Nothing half-written. An enrolment that "succeeded" under a key anyone
      // can read out of the repository is the outcome this replaces.
      expect(prismaService.mFASetting.upsert).not.toHaveBeenCalled();
    });

    it("refuses a key that is set but blank", async () => {
      // `ENCRYPTION_KEY="   "` clears `validateConfiguration`'s falsiness check,
      // so the emptiness test here trims even though the bytes fed to the hash do
      // not — re-deriving a key would strand the secrets already sealed with it.
      configService.encryptionKey = "   ";

      await expect(
        service.generateMfaSecret("user-uuid-123"),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(prismaService.mFASetting.upsert).not.toHaveBeenCalled();
    });

    it("writes a secret the checked-in fallback key cannot read back", async () => {
      const stored = await sealASecret();
      expect(stored).toMatch(/^v1:/);

      const [, ivHex, tagHex, dataHex] = stored.split(":");
      const replayedKey = crypto
        .createHash("sha256")
        .update(CHECKED_IN_FALLBACK)
        .digest();
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        replayedKey,
        Buffer.from(ivHex, "hex"),
      );
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));

      expect(() =>
        Buffer.concat([
          decipher.update(Buffer.from(dataHex, "hex")),
          decipher.final(),
        ]),
      ).toThrow();
    });

    it("surfaces a missing key as a deployment fault, not as a wrong code", async () => {
      delete configService.encryptionKey;
      prismaService.mFASetting.findUnique.mockResolvedValue({
        ...mockMfaSetting,
        totpSecret:
          "v1:000000000000000000000000:00000000000000000000000000000000:00",
      });
      (verify as jest.Mock).mockClear();

      // `decryptTotpSecret` used to resolve the key inside a `try` whose handler
      // answered with the ciphertext, and otplib then reported that as the user
      // mistyping their code: a server that cannot decrypt anything at all looked
      // like a stream of failed logins.
      await expect(
        service.verifyMfaLogin({ mfaToken: "mfa-token", totpCode: "123456" }),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(verify).not.toHaveBeenCalled();
    });
  });

  /**
   * `ENCRYPTION_KEY` holds two jobs: it peppers every vault verifier, and it derives
   * the AES key sealing each TOTP secret. Rotating it used to convert every enrolled
   * account's second factor into ciphertext only the retired key could read — for
   * good, with each correct code its owner typed burning one of five attempts toward
   * a 15-minute lockout. The vault already solved that for its pepper, so this is the
   * same contract: `ENCRYPTION_KEY_PREVIOUS` set *before* `ENCRYPTION_KEY` changes,
   * both keys tryable, and a secret that opened under the retired one re-sealed on the
   * way through so the window drains by use instead of by a migration nothing here
   * could run offline.
   */
  describe("TOTP key ring rotation", () => {
    const CURRENT_KEY = "unit-test-totp-encryption-key-0123456789abcdef";
    const RETIRED_KEY = "retired-totp-encryption-key-0123456789abcdef-0123";
    const FOREIGN_KEY = "never-in-this-ring-encryption-key-0123456789";

    beforeEach(() => {
      // Pinned rather than inherited from the outer literal, so the three names above
      // are compared against a key this block controls.
      configService.encryptionKey = CURRENT_KEY;
      configService.encryptionKeyPrevious = undefined;
      jwtService.verify.mockReturnValue({
        sub: mockUser.id,
        purpose: "MFA_CHALLENGE",
        deviceId: mockDevice.id,
      });
    });

    /** The service's own KDF, repeated only to ask which key a row now sits under. */
    const derivedKey = (rawKey: string) =>
      crypto.createHash("sha256").update(rawKey).digest();

    /**
     * Seals through the service's writer with the key the deployment held at that
     * moment — what an operator's rows look like after a rotation, and the proof that
     * the ring reads the bytes the writer wrote, untrimmed.
     */
    function sealWithServiceKey(
      rawKey: string,
      secret = "MOCKSECRET123",
    ): string {
      const configured = configService.encryptionKey;
      configService.encryptionKey = rawKey;
      try {
        return (service as any).encryptTotpSecret(secret) as string;
      } finally {
        configService.encryptionKey = configured;
      }
    }

    /** A blob no key this process holds sealed: the ciphertext nothing can open. */
    function sealUnder(rawKey: string, secret: string): string {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(
        "aes-256-gcm",
        derivedKey(rawKey),
        iv,
      );
      const encrypted = Buffer.concat([
        cipher.update(secret, "utf8"),
        cipher.final(),
      ]);
      return `v1:${iv.toString("hex")}:${cipher
        .getAuthTag()
        .toString("hex")}:${encrypted.toString("hex")}`;
    }

    function opensUnder(rawKey: string, stored: string): string | undefined {
      const [, ivHex, tagHex, dataHex] = stored.split(":");
      try {
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          derivedKey(rawKey),
          Buffer.from(ivHex, "hex"),
        );
        decipher.setAuthTag(Buffer.from(tagHex, "hex"));
        return Buffer.concat([
          decipher.update(Buffer.from(dataHex, "hex")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        return undefined;
      }
    }

    /**
     * The `MFASetting` row as something a write can actually land on. A stubbed
     * `mockResolvedValue` cannot answer these questions: it would let a re-seal that
     * wrote the *old* ciphertext back, or a drain that never happened at all, satisfy
     * every assertion below.
     */
    function useSealedRow(totpSecret: string) {
      const row: Record<string, any> = {
        id: "mfa-uuid-1",
        userId: mockUser.id,
        totpEnabled: true,
        totpSecret,
      };

      prismaService.mFASetting.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.userId === row.userId ? { ...row } : null),
      );
      prismaService.mFASetting.update.mockImplementation(
        ({ where, data }: any) => {
          if (where?.userId !== row.userId) {
            return Promise.reject(new Error("P2025"));
          }
          Object.assign(row, data);
          return Promise.resolve({ ...row });
        },
      );

      return row;
    }

    const signIn = () =>
      service.verifyMfaLogin({ mfaToken: "mfa-token", totpCode: "123456" });

    it("verifies a secret sealed under the retired key and re-seals it under the current one", async () => {
      const sealedByRetiredKey = sealWithServiceKey(RETIRED_KEY);
      // The rotation in the order it has to happen: retire first, then change.
      Object.assign(configService, {
        encryptionKey: CURRENT_KEY,
        encryptionKeyPrevious: RETIRED_KEY,
      });
      const row = useSealedRow(sealedByRetiredKey);

      const result = await signIn();

      expect(result.tokens?.accessToken).toBe("mock-jwt-token");
      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({ secret: "MOCKSECRET123" }),
      );
      expect(row.totpSecret).not.toBe(sealedByRetiredKey);
      expect(opensUnder(CURRENT_KEY, row.totpSecret)).toBe("MOCKSECRET123");
      // And once that is true of every row, `ENCRYPTION_KEY_PREVIOUS` can be cleared —
      // which is what the re-seal is for: a retired key should not live in the
      // environment forever just because a secret was enrolled before it was retired.
      expect(opensUnder(RETIRED_KEY, row.totpSecret)).toBeUndefined();
    });

    it("writes nothing when the current key opened the secret", async () => {
      const sealedByCurrentKey = sealWithServiceKey(CURRENT_KEY);
      // Window open and irrelevant: only a non-current hit converts, so a steady-state
      // login stays the single write-free path it was before the ring existed.
      configService.encryptionKeyPrevious = RETIRED_KEY;
      useSealedRow(sealedByCurrentKey);

      await expect(signIn()).resolves.toHaveProperty("tokens");

      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({ secret: "MOCKSECRET123" }),
      );
      expect(prismaService.mFASetting.update).not.toHaveBeenCalled();
    });

    it("changes nothing for a rotation done without ENCRYPTION_KEY_PREVIOUS", async () => {
      const sealedByRetiredKey = sealWithServiceKey(RETIRED_KEY);
      Object.assign(configService, {
        encryptionKey: CURRENT_KEY,
        encryptionKeyPrevious: undefined,
      });
      const row = useSealedRow(sealedByRetiredKey);
      (verify as jest.Mock).mockResolvedValue({ valid: false });
      const logged = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);

      // Unset means exactly one candidate, and the old swallow-and-return stands.
      // Deliberately not newly thrown: the callers' "Invalid TOTP verification code"
      // answer, and the tests over there, have to survive this change untouched.
      const thrown = (await service
        .enableMfa(mockUser.id, { totpCode: "123456" })
        .catch((error: unknown) => error)) as HttpException;

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect(thrown.message).toBe("Invalid TOTP verification code");
      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({ secret: sealedByRetiredKey }),
      );
      expect(logged).toHaveBeenCalledTimes(1);
      expect(row.totpSecret).toBe(sealedByRetiredKey);
      expect(prismaService.mFASetting.update).not.toHaveBeenCalled();
      logged.mockRestore();
    });

    it("returns the stored ciphertext when no key in the ring can open it", async () => {
      // Two candidates and neither right: the shape of a rotation whose retired value
      // was misremembered. One log for the whole ring rather than one per failed key.
      const foreign = sealUnder(FOREIGN_KEY, "MOCKSECRET123");
      Object.assign(configService, {
        encryptionKey: CURRENT_KEY,
        encryptionKeyPrevious: RETIRED_KEY,
      });
      const row = useSealedRow(foreign);
      (verify as jest.Mock).mockResolvedValue({ valid: false });
      const logged = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);

      const thrown = (await signIn().catch(
        (error: unknown) => error,
      )) as HttpException;

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown.getResponse() as { code?: string }).code).toBe(
        ErrorCode.MFA_CODE_INVALID,
      );
      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({ secret: foreign }),
      );
      expect(logged).toHaveBeenCalledTimes(1);
      // Nothing written: there is no plaintext to re-seal, and overwriting the row here
      // would destroy the only copy of a secret its owner may still be able to recover.
      expect(row.totpSecret).toBe(foreign);
      logged.mockRestore();
    });

    it("answers an unset ENCRYPTION_KEY with a 500 even while a retired key is in the ring", async () => {
      // The ring must not become a way to keep running on the retired key alone: a
      // deployment that lost its current key has to hear about it, and its users must
      // not be told their correct code is wrong because of a fault in the server.
      const sealedByRetiredKey = sealWithServiceKey(RETIRED_KEY);
      Object.assign(configService, {
        encryptionKey: undefined,
        encryptionKeyPrevious: RETIRED_KEY,
      });
      useSealedRow(sealedByRetiredKey);
      (verify as jest.Mock).mockClear();

      await expect(signIn()).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(verify).not.toHaveBeenCalled();
      expect(prismaService.mFASetting.update).not.toHaveBeenCalled();
    });

    it("answers a blank ENCRYPTION_KEY as the same deployment fault", async () => {
      const sealedByRetiredKey = sealWithServiceKey(RETIRED_KEY);
      Object.assign(configService, {
        encryptionKey: "   ",
        encryptionKeyPrevious: RETIRED_KEY,
      });
      useSealedRow(sealedByRetiredKey);
      (verify as jest.Mock).mockClear();

      const thrown = (await signIn().catch(
        (error: unknown) => error,
      )) as HttpException;

      expect(thrown).toBeInstanceOf(InternalServerErrorException);
      expect(thrown.message).toContain("ENCRYPTION_KEY");
      expect(verify).not.toHaveBeenCalled();
    });

    it("does not let a failed re-seal break the sign-in that just verified", async () => {
      const sealedByRetiredKey = sealWithServiceKey(RETIRED_KEY);
      Object.assign(configService, {
        encryptionKey: CURRENT_KEY,
        encryptionKeyPrevious: RETIRED_KEY,
      });
      useSealedRow(sealedByRetiredKey);
      prismaService.mFASetting.update.mockRejectedValue(
        new Error("connection reset"),
      );
      const logged = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);

      // The user's second factor passed; whether the row moved onto the current key is
      // our bookkeeping. Failing the write here would reject a legitimate login and
      // leave the owner unable to tell what they did wrong.
      await expect(signIn()).resolves.toHaveProperty("tokens");
      expect(logged).toHaveBeenCalledTimes(1);
      logged.mockRestore();
    });
  });

  describe("security regressions", () => {
    it("refuses to replace enabled MFA even with a valid session", async () => {
      prismaService.mFASetting.findUnique.mockResolvedValue(mockMfaSetting);
      await expect(service.generateMfaSecret(mockUser.id)).rejects.toThrow(
        "Disable existing MFA",
      );
      expect(prismaService.mFASetting.upsert).not.toHaveBeenCalled();
    });

    it("accepts a real asynchronous otplib verification result", async () => {
      const actual = jest.requireActual("otplib");
      const secret = actual.generateSecret();
      const token = await actual.generate({ secret });
      (verify as jest.Mock).mockImplementation(actual.verify);
      prismaService.mFASetting.findUnique.mockResolvedValue({
        ...mockMfaSetting,
        totpEnabled: false,
        totpSecret: secret,
      });
      await expect(
        service.enableMfa(mockUser.id, { totpCode: token }),
      ).resolves.toHaveProperty("recoveryCodes");
    });

    it("never attaches an unbound provider identity to an existing email", async () => {
      prismaService.authentication.findMany.mockResolvedValue([]);
      await expect(
        (service as any).processOAuthLogin(
          "GOOGLE",
          "unbound-sub",
          mockUser.email,
        ),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.EMAIL_ALREADY_REGISTERED },
      });
      expect(prismaService.authentication.create).not.toHaveBeenCalled();
      expect(prismaService.session.create).not.toHaveBeenCalled();
    });

    it("uses the bound provider subject even after its email changes", async () => {
      const result = await (service as any).processOAuthLogin(
        "GOOGLE",
        "bound-sub",
        "changed@example.com",
      );
      expect(usersService.getUserById).toHaveBeenCalledWith(mockUser.id);
      expect(prismaService.user.findFirst).not.toHaveBeenCalled();
      expect(result.user.id).toBe(mockUser.id);
    });

    it("requires account MFA after OAuth instead of issuing session tokens", async () => {
      prismaService.mFASetting.findUnique.mockResolvedValue(mockMfaSetting);
      const result = await (service as any).processOAuthLogin(
        "GOOGLE",
        "bound-sub",
        mockUser.email,
      );
      expect(result.mfaRequired).toBe(true);
      expect(result.tokens).toBeUndefined();
      expect(prismaService.session.create).not.toHaveBeenCalled();
    });

    it("rejects ambiguous legacy provider bindings", async () => {
      prismaService.authentication.findMany.mockResolvedValue([
        { userId: "a" },
        { userId: "b" },
      ]);
      await expect(
        (service as any).processOAuthLogin(
          "GOOGLE",
          "duplicate-sub",
          mockUser.email,
        ),
      ).rejects.toThrow("Ambiguous OAuth identity");
      expect(prismaService.session.create).not.toHaveBeenCalled();
    });
  });

  describe("OAuth integration", () => {
    it("should authenticate user with Apple ID token", async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      jest.spyOn(service, "verifyAppleToken").mockResolvedValue({
        sub: "apple-123",
        email: "test@example.com",
        name: "Test User",
      });

      const result = await service.loginWithApple({
        idToken: "valid-apple-id-token",
      });

      expect(result).toBeDefined();
      expect(result.user?.email).toBe("test@example.com");
      expect(result.tokens?.accessToken).toBe("mock-jwt-token");
    });

    it("should authenticate user with Microsoft ID token", async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      jest.spyOn(service, "verifyMicrosoftToken").mockResolvedValue({
        sub: "ms-123",
        email: "test@example.com",
        name: "Test User",
      });

      const result = await service.loginWithMicrosoft({
        idToken: "valid-microsoft-id-token",
      });

      expect(result).toBeDefined();
      expect(result.user?.email).toBe("test@example.com");
      expect(result.tokens?.accessToken).toBe("mock-jwt-token");
    });

    it("fails closed if Google client ID is not configured", async () => {
      (configService as any).googleClientId = undefined;
      await expect(
        (service as any).verifyGoogleToken("some-id-token"),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("fails closed if Apple client ID is not configured", async () => {
      (configService as any).appleClientId = undefined;
      await expect(service.verifyAppleToken("some-id-token")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("fails closed if Microsoft client ID is not configured", async () => {
      (configService as any).microsoftClientId = undefined;
      await expect(
        service.verifyMicrosoftToken("some-id-token"),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects OAuth login if user account is deleted or inactive", async () => {
      usersService.getUserById.mockResolvedValue({
        ...mockUser,
        deletedAt: new Date(),
      });

      await expect(
        (service as any).processOAuthLogin(
          "GOOGLE",
          "google-123",
          "test@example.com",
        ),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ACCOUNT_DISABLED },
      });
    });
  });

  describe("disableMfa", () => {
    it("should require both password and totpCode/recoveryCode", async () => {
      prismaService.authentication.findFirst.mockResolvedValue({
        id: "auth-1",
        userId: "user-uuid-123",
        passwordHash: "valid-hash",
      });
      (argon2.verify as jest.Mock).mockResolvedValue(true);
      prismaService.mFASetting.findUnique.mockResolvedValue({
        id: "mfa-1",
        userId: "user-uuid-123",
        totpEnabled: true,
        totpSecret: "MOCKSECRET123",
      });

      const result = await service.disableMfa("user-uuid-123", {
        password: "Password123!",
        totpCode: "123456",
      });

      expect(result.success).toBe(true);
      expect(prismaService.mFASetting.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-uuid-123" },
          data: expect.objectContaining({ totpEnabled: false }),
        }),
      );
    });
  });

  describe("password reset", () => {
    it("issues a PASSWORD_RESET code for the account email", async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);

      const result = await service.forgotPassword("test@example.com");

      expect(otpService.issue).toHaveBeenCalledWith(
        "user-uuid-123",
        "PASSWORD_RESET",
        expect.any(Number),
      );
      expect(result.message).toContain("If the account exists");
    });

    it("does not reveal whether the email is registered", async () => {
      usersService.findByEmail.mockResolvedValue(null);

      const result = await service.forgotPassword("nobody@example.com");

      expect(otpService.issue).not.toHaveBeenCalled();
      expect(result.message).toContain("If the account exists");
    });

    it("re-hashes the password, unlocks the account and revokes sessions", async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      (argon2.hash as jest.Mock).mockResolvedValue("new_hashed_password");

      const result = await service.resetPassword(
        "test@example.com",
        "123456",
        "NewPassword123!",
      );

      expect(otpService.consume).toHaveBeenCalledWith(
        "user-uuid-123",
        "PASSWORD_RESET",
        "123456",
      );
      expect(prismaService.authentication.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { passwordHash: "new_hashed_password" },
        }),
      );
      expect(prismaService.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { failedLoginAttempts: 0, lockedUntil: null },
        }),
      );
      expect(prismaService.session.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { revokedAt: expect.any(Date) },
        }),
      );
      expect(result.message).toContain("Password successfully reset");
    });

    it("refuses to set a password when the code does not verify", async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      otpService.consume.mockResolvedValue(false);

      await expect(
        service.resetPassword("test@example.com", "000000", "NewPassword123!"),
      ).rejects.toThrow("Invalid or expired verification code");
      expect(prismaService.authentication.updateMany).not.toHaveBeenCalled();
    });

    it("refuses to set a password on an account without a password auth", async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);
      prismaService.authentication.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.resetPassword("test@example.com", "123456", "NewPassword123!"),
      ).rejects.toThrow("does not use a password");
    });
  });

  describe("refreshTokens", () => {
    const mockSession = {
      id: "session-uuid-789",
      userId: "user-uuid-123",
      deviceId: "device-uuid-456",
      accessToken: "old-access-token",
      refreshToken: "valid-refresh-token",
      accessExpiresAt: new Date(Date.now() + 3600000),
      refreshExpiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
      user: mockUser,
    };

    it("should successfully refresh tokens and update session", async () => {
      jwtService.verify.mockReturnValue({
        sub: "user-uuid-123",
        type: "refresh",
      });
      prismaService.session.findUnique.mockResolvedValue(mockSession);
      prismaService.session.update.mockResolvedValue({
        ...mockSession,
        refreshToken: "new-refresh-token",
      });

      const result = await service.refreshTokens({
        refreshToken: "valid-refresh-token",
      });

      expect(result.tokens).toBeDefined();
      expect(result.deviceId).toBe("device-uuid-456");
      expect(prismaService.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "session-uuid-789" },
          data: expect.objectContaining({
            accessToken: "session-uuid-789",
            refreshToken: expect.any(String),
          }),
        }),
      );
    });

    it("tolerates concurrent requests using rotated token within grace period", async () => {
      jwtService.verify.mockReturnValue({
        sub: "user-uuid-123",
        type: "refresh",
      });
      prismaService.session.findUnique.mockResolvedValue(mockSession);
      prismaService.session.update.mockResolvedValue(mockSession);

      // First refresh
      const firstResult = await service.refreshTokens({
        refreshToken: "race-refresh-token",
      });

      // Second concurrent refresh with the same old token (findUnique for grace
      // check). The grace branch re-reads the account the row belongs to, so the
      // row it answers with carries that selection; a double without it would be
      // describing a query the service no longer makes.
      prismaService.session.findUnique.mockResolvedValueOnce({
        id: "session-uuid-789",
        revokedAt: null,
        refreshExpiresAt: new Date(Date.now() + 86400000),
        user: { status: "ACTIVE", deletedAt: null },
      });

      const secondResult = await service.refreshTokens({
        refreshToken: "race-refresh-token",
      });

      expect(secondResult.tokens.accessToken).toBe(
        firstResult.tokens.accessToken,
      );
      expect(secondResult.tokens.refreshToken).toBe(
        firstResult.tokens.refreshToken,
      );
      expect(secondResult.deviceId).toBe("device-uuid-456");
    });

    it("throws unauthorized when refresh token is invalid or expired", async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error("jwt expired");
      });

      await expect(
        service.refreshTokens({ refreshToken: "expired-token" }),
      ).rejects.toThrow(UnauthorizedException);
    });

    /**
     * A refresh credential lives for `JWT_REFRESH_EXPIRATION` — days — and
     * `/auth/refresh` is the only other path that mints an access token, so a
     * status gate that runs at login alone lets an account suspended, deleted or
     * still pending keep signing itself back in for the whole lifetime of a
     * session it no longer qualifies for.
     *
     * Each case asserts the refusal is the *same* 401 body an unknown token
     * produces: this route is unauthenticated, so a message naming the reason
     * would confirm the account state behind a stolen cookie.
     */
    const blockedAccounts: Array<[string, Record<string, unknown>]> = [
      ["SUSPENDED", { status: "SUSPENDED", deletedAt: null }],
      ["DELETED", { status: "DELETED", deletedAt: null }],
      ["PENDING", { status: "PENDING", deletedAt: null }],
      ["ACTIVE but soft-deleted", { status: "ACTIVE", deletedAt: new Date() }],
    ];

    describe("account status re-check", () => {
      function useAccountRow(user: Record<string, unknown>) {
        jwtService.verify.mockReturnValue({
          sub: "user-uuid-123",
          type: "refresh",
        });
        prismaService.session.findUnique.mockResolvedValue({
          ...mockSession,
          user,
        });
      }

      it.each(blockedAccounts)(
        "refuses to rotate a session whose user is %s",
        async (_label, user) => {
          useAccountRow(user);
          const graceSet = jest.spyOn(
            (service as any).rotatedRefreshGrace,
            "set",
          );

          const thrown = (await service
            .refreshTokens({ refreshToken: "valid-refresh-token" })
            .catch((error: unknown) => error)) as HttpException;

          expect(thrown).toBeInstanceOf(UnauthorizedException);
          expect(thrown.getResponse()).toEqual({
            code: ErrorCode.TOKEN_INVALID,
            message: "Invalid or expired refresh token",
          });
          expect(prismaService.session.update).not.toHaveBeenCalled();
          expect(graceSet).not.toHaveBeenCalled();
        },
      );

      it.each(blockedAccounts)(
        "refuses a grace-window replay for a session whose user is %s",
        async (_label, user) => {
          jwtService.verify.mockReturnValue({
            sub: "user-uuid-123",
            type: "refresh",
          });
          // The window hands back an already-minted pair without rotating, which
          // is a mint all the same, so it needs the same gate.
          const window = (service as any)
            .rotatedRefreshGrace as RefreshTokenGraceStore;
          await window.set(
            "grace-window-token",
            {
              tokens: {
                accessToken: "grace-minted-access",
                refreshToken: "grace-minted-refresh",
                expiresIn: 3600,
              },
              deviceId: "device-uuid-456",
              sessionId: mockSession.id,
              userId: mockSession.userId,
            },
            AuthService.REFRESH_ROTATION_GRACE_MS,
          );
          prismaService.session.findUnique.mockResolvedValue({
            id: mockSession.id,
            revokedAt: null,
            refreshExpiresAt: new Date(Date.now() + 86400000),
            user,
          });

          const thrown = (await service
            .refreshTokens({ refreshToken: "grace-window-token" })
            .catch((error: unknown) => error)) as HttpException;

          expect(thrown).toBeInstanceOf(UnauthorizedException);
          expect(thrown.getResponse()).toEqual({
            code: ErrorCode.TOKEN_INVALID,
            message: "Invalid or expired refresh token",
          });
          expect(prismaService.session.update).not.toHaveBeenCalled();
        },
      );

      it("still rotates when the account is active and not deleted", async () => {
        useAccountRow({
          ...mockUser,
          status: "ACTIVE",
          deletedAt: null,
        });

        await expect(
          service.refreshTokens({ refreshToken: "valid-refresh-token" }),
        ).resolves.toHaveProperty("tokens");
      });
    });

    /**
     * Two `AuthService` instances over one grace store, which is what two API
     * replicas over one Redis are.
     *
     * The window used to be a field on the service, so a replay routed to the
     * other replica found no record there and the reuse signal — the only thing
     * that tells a laggy client apart from somebody who copied the token out of
     * the database — was decided by which worker happened to answer.
     */
    describe("rotation window across workers", () => {
      async function buildWorker(graceStore: RefreshTokenGraceStore) {
        const workerModule = await Test.createTestingModule({
          providers: [
            AuthService,
            { provide: PrismaService, useValue: prismaService },
            { provide: UsersService, useValue: usersService },
            { provide: JwtService, useValue: jwtService },
            { provide: ConfigurationService, useValue: configService },
            { provide: OtpService, useValue: otpService },
            { provide: AuditLogService, useValue: auditLogService },
            { provide: RefreshTokenGraceStore, useValue: graceStore },
          ],
        }).compile();

        return workerModule.get<AuthService>(AuthService);
      }

      /**
       * A `Session` row that keeps its own `refreshToken` column the way MongoDB
       * does: the row starts on the legacy plaintext representation, which the
       * service's compatibility read picks up, and the rotation replaces it with
       * the digest of a credential nobody presented. A lookup by anything the row
       * no longer holds finds nothing. The frozen stub answered every token with
       * the same row, so a test that turned on rotation could not tell reuse from
       * a first-time refresh.
       */
      function useRefreshTokenRow(storedToken: string) {
        const row: any = {
          ...mockSession,
          refreshToken: storedToken,
          ipAddress: "203.0.113.9",
          userAgent: "curl/8.5.0",
        };

        prismaService.session.findUnique.mockImplementation(
          ({ where }: any) => {
            if ("refreshToken" in where) {
              return Promise.resolve(
                where.refreshToken === row.refreshToken ? { ...row } : null,
              );
            }
            return Promise.resolve(where.id === row.id ? { ...row } : null);
          },
        );

        prismaService.session.update.mockImplementation(
          ({ where, data }: any) => {
            if (where.id !== row.id) return Promise.reject(new Error("P2025"));
            Object.assign(row, data);
            return Promise.resolve({ ...row });
          },
        );

        // The row has to answer a filter the way MongoDB does, otherwise a test
        // that asserts "the reuse path revoked the family" is satisfied by a stub
        // that revoked nothing at all.
        prismaService.session.updateMany.mockImplementation(
          ({ where, data }: any) => {
            const matches =
              (where.id === undefined || where.id === row.id) &&
              (where.userId === undefined || where.userId === row.userId) &&
              (!("revokedAt" in where) || where.revokedAt === row.revokedAt);
            if (matches) Object.assign(row, data);
            return Promise.resolve({ count: matches ? 1 : 0 });
          },
        );

        return row;
      }

      beforeEach(() => {
        // Each mint has to be distinguishable, otherwise "returned the pair the
        // other worker minted" and "minted a second pair" look identical.
        let mintCount = 0;
        jwtService.verify.mockReturnValue({
          sub: "user-uuid-123",
          type: "refresh",
        });
        jwtService.sign.mockImplementation((payload: any) => {
          mintCount += 1;
          return `${payload.type}-token-${mintCount}`;
        });
      });

      it("answers a replay routed to the second worker with the pair the first one minted", async () => {
        const graceStore = new RefreshTokenGraceStore(configService);
        const firstWorker = await buildWorker(graceStore);
        const secondWorker = await buildWorker(graceStore);
        useRefreshTokenRow("presented-refresh-token");

        const first = await firstWorker.refreshTokens({
          refreshToken: "presented-refresh-token",
        });

        // The row now holds the digest of the rotated credential, so the second
        // worker can only answer from the shared window.
        const replay = await secondWorker.refreshTokens({
          refreshToken: "presented-refresh-token",
        });

        expect(replay).toEqual(first);
        expect(prismaService.session.update).toHaveBeenCalledTimes(1);
      });

      it("refuses the presented token once the window has passed", async () => {
        const graceStore = new RefreshTokenGraceStore(configService);
        const worker = await buildWorker(graceStore);
        useRefreshTokenRow("presented-refresh-token");

        await worker.refreshTokens({
          refreshToken: "presented-refresh-token",
        });

        jest.useFakeTimers();
        try {
          jest.advanceTimersByTime(AuthService.REFRESH_ROTATION_GRACE_MS + 1);

          await expect(
            worker.refreshTokens({ refreshToken: "presented-refresh-token" }),
          ).rejects.toThrow(UnauthorizedException);
        } finally {
          jest.useRealTimers();
        }
      });

      it("clears the window of the session logout revokes", async () => {
        const graceStore = new RefreshTokenGraceStore(configService);
        const cleared = jest.spyOn(graceStore, "deleteForSession");
        const worker = await buildWorker(graceStore);
        useRefreshTokenRow("presented-refresh-token");

        await worker.refreshTokens({ refreshToken: "presented-refresh-token" });
        await worker.logout(mockSession.id);

        expect(cleared).toHaveBeenCalledWith(mockSession.id);
      });

      /**
       * A credential that was valid, was rotated by this service, and has now
       * come back after the grace window closed is not a laggy client — somebody
       * else holds a copy. Before the rotation marker existed this case was
       * answered with the same silent 401 as a random string, so the one signal
       * that separates a stale retry from a theft was thrown away.
       *
       * The client-visible shape must not change: this route is unauthenticated,
       * and an answer that differed between "unknown token" and "your token was
       * reused" would tell the holder of a copied cookie that the copy is real.
       */
      describe("reuse of a rotated token", () => {
        let warn: jest.SpyInstance;

        beforeEach(() => {
          warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
        });

        afterEach(() => {
          warn.mockRestore();
        });

        const reuseAlerts = () =>
          warn.mock.calls
            .map(([message]) => (typeof message === "string" ? message : ""))
            .filter((message) =>
              message.includes("CONFIRMED refresh-token reuse"),
            );

        /**
         * Run the replay past the window, where the grace record has expired and
         * the marker — written for the credential's own lifetime — has not. The
         * await stays inside the fake clock: restoring real timers first would
         * put `Date.now()` back behind the window it just advanced past, and the
         * test would silently be exercising the grace path.
         */
        async function replayAfterWindow<T>(run: () => Promise<T>): Promise<T> {
          jest.useFakeTimers();
          try {
            jest.advanceTimersByTime(AuthService.REFRESH_ROTATION_GRACE_MS + 1);
            return await run();
          } finally {
            jest.useRealTimers();
          }
        }

        it("revokes the family and alerts once the window has passed", async () => {
          const graceStore = new RefreshTokenGraceStore(configService);
          const worker = await buildWorker(graceStore);
          const row = useRefreshTokenRow("presented-refresh-token");
          await worker.refreshTokens({
            refreshToken: "presented-refresh-token",
          });
          prismaService.session.updateMany.mockClear();

          const thrown = (await replayAfterWindow(() =>
            worker
              .refreshTokens({ refreshToken: "presented-refresh-token" })
              .catch((error: unknown) => error),
          )) as HttpException;

          expect(thrown).toBeInstanceOf(UnauthorizedException);
          expect(thrown.getResponse()).toEqual({
            code: ErrorCode.TOKEN_INVALID,
            message: "Invalid or expired refresh token",
          });
          // The reused row is the token family: no family column, and rotation
          // rewrites this row rather than creating one.
          expect(row.revokedAt).toBeInstanceOf(Date);
          // Then every session the user holds, the same operation
          // `resetPassword` performs, because access tokens are self-validating
          // JWTs and revoking the rows is the only way to reach them.
          expect(prismaService.session.updateMany).toHaveBeenCalledWith({
            where: { userId: "user-uuid-123", revokedAt: null },
            data: { revokedAt: expect.any(Date) },
          });

          const alerts = reuseAlerts();
          expect(alerts).toHaveLength(1);
          expect(alerts[0]).toContain("user-uuid-123");
          expect(alerts[0]).toContain("session-uuid-789");
          expect(alerts[0]).toContain("203.0.113.9");
          expect(alerts[0]).toContain("curl/8.5.0");
        });

        it("degrades to a plain refusal when the marker lookup itself fails", async () => {
          const graceStore = new RefreshTokenGraceStore(configService);
          jest
            .spyOn(graceStore, "getRotationMarker")
            .mockRejectedValue(new Error("ECONNRESET"));
          const worker = await buildWorker(graceStore);
          const row = useRefreshTokenRow("presented-refresh-token");
          await worker.refreshTokens({
            refreshToken: "presented-refresh-token",
          });
          prismaService.session.updateMany.mockClear();

          await expect(
            replayAfterWindow(() =>
              worker.refreshTokens({ refreshToken: "presented-refresh-token" }),
            ),
          ).rejects.toBeInstanceOf(UnauthorizedException);

          // A read that did not happen is not evidence: nothing is revoked, and
          // the failure is a 401 rather than a 500.
          expect(row.revokedAt).toBeNull();
          expect(prismaService.session.updateMany).not.toHaveBeenCalled();
          expect(reuseAlerts()).toHaveLength(0);
        });

        it("revokes nothing for a credential that was never rotated", async () => {
          const graceStore = new RefreshTokenGraceStore(configService);
          const worker = await buildWorker(graceStore);
          useRefreshTokenRow("presented-refresh-token");

          await expect(
            worker.refreshTokens({ refreshToken: "never-issued-token" }),
          ).rejects.toBeInstanceOf(UnauthorizedException);

          expect(prismaService.session.updateMany).not.toHaveBeenCalled();
          expect(reuseAlerts()).toHaveLength(0);
        });

        it("refuses a replay against a family already shut down without alerting twice", async () => {
          const graceStore = new RefreshTokenGraceStore(configService);
          const worker = await buildWorker(graceStore);
          const row = useRefreshTokenRow("presented-refresh-token");
          await worker.refreshTokens({
            refreshToken: "presented-refresh-token",
          });

          // Logout, device revocation or a password reset closed the family
          // between the rotation and the replay.
          row.revokedAt = new Date(Date.now() - 1000);
          prismaService.session.updateMany.mockClear();

          await expect(
            replayAfterWindow(() =>
              worker.refreshTokens({ refreshToken: "presented-refresh-token" }),
            ),
          ).rejects.toBeInstanceOf(UnauthorizedException);

          expect(prismaService.session.updateMany).not.toHaveBeenCalled();
          expect(reuseAlerts()).toHaveLength(0);
        });

        it("still answers a retry inside the window, and calls it no reuse", async () => {
          const graceStore = new RefreshTokenGraceStore(configService);
          const worker = await buildWorker(graceStore);
          useRefreshTokenRow("presented-refresh-token");

          const first = await worker.refreshTokens({
            refreshToken: "presented-refresh-token",
          });
          const retry = await worker.refreshTokens({
            refreshToken: "presented-refresh-token",
          });

          expect(retry).toEqual(first);
          expect(prismaService.session.updateMany).not.toHaveBeenCalled();
          expect(reuseAlerts()).toHaveLength(0);
        });
      });
    });
  });

  describe("logout", () => {
    it("should revoke user session", async () => {
      const result = await service.logout("session-uuid-789");
      expect(result.success).toBe(true);
      expect(prismaService.session.updateMany).toHaveBeenCalled();
    });
  });
});
