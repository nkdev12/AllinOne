import { Test, TestingModule } from "@nestjs/testing";
import { AuthService } from "./auth.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { UsersService } from "@/users/users.service";
import { JwtService } from "@nestjs/jwt";
import { ConfigurationService } from "@/config/configuration.service";
import { OtpService } from "@/common/otp/otp.service";
import {
  ConflictException,
  HttpException,
  UnauthorizedException,
} from "@nestjs/common";
import { AuditAction } from "@prisma/client";
import { AuditLogService } from "@/common/audit/audit-log.service";
import { ErrorCode } from "@/common/errors/error-code";
import * as argon2 from "argon2";
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

  beforeEach(async () => {
    prismaService = {
      $transaction: jest.fn((cb) => cb(prismaService)),
      $runCommandRaw: jest.fn(),
      user: {
        create: jest.fn().mockResolvedValue(mockUser),
        update: jest.fn().mockResolvedValue(mockUser),
      },
      authentication: {
        create: jest.fn().mockResolvedValue({ id: "auth-1" }),
        findFirst: jest.fn(),
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
    (verify as jest.Mock).mockReturnValue(true);

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

    it("should increment failedLoginAttempts on incorrect password", async () => {
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

      expect(prismaService.user.update).toHaveBeenCalledWith({
        where: { id: "user-uuid-123" },
        data: {
          failedLoginAttempts: 3,
          lockedUntil: null,
        },
      });
      expect(auditLogService.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.LOGIN_FAILURE,
          userId: "user-uuid-123",
        }),
      );
    });

    it("should lock account for 15 minutes when reaching 5 failed attempts", async () => {
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

      expect(prismaService.user.update).toHaveBeenCalledWith({
        where: { id: "user-uuid-123" },
        data: {
          failedLoginAttempts: 5,
          lockedUntil: expect.any(Date),
        },
      });
      expect(auditLogService.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ACCOUNT_LOCKED,
          userId: "user-uuid-123",
        }),
      );
    });

    it("should reset failedLoginAttempts to 0 upon successful login", async () => {
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
      expect(prismaService.user.update).toHaveBeenCalledWith({
        where: { id: "user-uuid-123" },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
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
      (verify as jest.Mock).mockReturnValue(true);

      const result = await service.verifyMfaLogin({
        mfaToken: "mfa-token",
        totpCode: "123456",
      });

      expect(result.tokens?.accessToken).toBe("mock-jwt-token");
      expect(result.deviceId).toBe("device-uuid-456");
    });

    it("refuses a code the authenticator did not produce", async () => {
      (verify as jest.Mock).mockReturnValue(false);

      const thrown = (await service
        .verifyMfaLogin({ mfaToken: "mfa-token", totpCode: "000000" })
        .catch((error: unknown) => error)) as HttpException;

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown.getResponse() as { code?: string }).code).toBe(
        ErrorCode.MFA_CODE_INVALID,
      );
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

  describe("logout", () => {
    it("should revoke user session", async () => {
      const result = await service.logout("session-uuid-789");
      expect(result.success).toBe(true);
      expect(prismaService.session.updateMany).toHaveBeenCalled();
    });
  });
});
