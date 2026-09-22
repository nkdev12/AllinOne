import { Test, TestingModule } from "@nestjs/testing";
import { AuthService } from "./auth.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { UsersService } from "@/users/users.service";
import { JwtService } from "@nestjs/jwt";
import { ConfigurationService } from "@/config/configuration.service";
import { getQueueToken } from "@nestjs/bull";
import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { AuditAction } from "@prisma/client";
import { AuditLogService } from "@/common/audit/audit-log.service";
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
        create: jest.fn().mockResolvedValue(mockSession),
        findUnique: jest.fn().mockResolvedValue(mockSession),
        update: jest.fn().mockResolvedValue(mockSession),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      mFASetting: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue(mockMfaSetting),
        update: jest.fn().mockResolvedValue(mockMfaSetting),
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
      emailVerifyEnabled: false,
      googleClientId: "google-client-id",
    };

    let mailQueue = {
      add: jest.fn().mockResolvedValue(true),
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
        { provide: getQueueToken("mail"), useValue: mailQueue },
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
      expect(result.sessionId).toBe("session-uuid-789");
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

  describe("logout", () => {
    it("should revoke user session", async () => {
      const result = await service.logout("session-uuid-789");
      expect(result.success).toBe(true);
      expect(prismaService.session.updateMany).toHaveBeenCalled();
    });
  });
});
