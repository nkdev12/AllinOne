import { Test, TestingModule } from "@nestjs/testing";
import { AuthService } from "./auth.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { UsersService } from "@/users/users.service";
import { JwtService } from "@nestjs/jwt";
import { ConfigurationService } from "@/config/configuration.service";
import { MailService } from "@/common/mail/mail.service";
import { ConflictException } from "@nestjs/common";
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
  let mailService: any;

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

    mailService = {
      sendVerificationEmail: jest.fn().mockResolvedValue(true),
      sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
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
        { provide: MailService, useValue: mailService },
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

  describe("OAuth integration", () => {
    it("should authenticate user with Apple ID token", async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);

      const result = await service.loginWithApple({
        idToken: "valid-apple-id-token",
      });

      expect(result).toBeDefined();
      expect(result.user?.email).toBe("test@example.com");
      expect(result.tokens?.accessToken).toBe("mock-jwt-token");
    });

    it("should authenticate user with Microsoft ID token", async () => {
      usersService.findByEmail.mockResolvedValue(mockUser);

      const result = await service.loginWithMicrosoft({
        idToken: "valid-microsoft-id-token",
      });

      expect(result).toBeDefined();
      expect(result.user?.email).toBe("test@example.com");
      expect(result.tokens?.accessToken).toBe("mock-jwt-token");
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
