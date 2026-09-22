import { Test, TestingModule } from "@nestjs/testing";
import { PasskeysService } from "./passkeys.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { JwtService } from "@nestjs/jwt";
import { ConfigurationService } from "@/config/configuration.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { AuthType, UserStatus } from "@prisma/client";

describe("PasskeysService", () => {
  let service: PasskeysService;
  let prismaMock: any;
  let jwtServiceMock: any;
  let configServiceMock: any;
  let auditLogServiceMock: any;

  beforeEach(async () => {
    prismaMock = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      authentication: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      session: {
        create: jest.fn().mockResolvedValue({ id: "session-passkey-1" }),
      },
      device: {
        findFirst: jest.fn().mockResolvedValue({ id: "device-web-1" }),
        create: jest.fn().mockResolvedValue({ id: "device-web-1" }),
      },
      $transaction: jest.fn().mockImplementation(async (promises) => {
        return Promise.all(promises);
      }),
    };

    jwtServiceMock = {
      sign: jest.fn().mockReturnValue("mocked-jwt-token"),
    };

    configServiceMock = {
      jwtAccessSecret: "secret",
      jwtAccessExpiration: "15m",
      jwtRefreshSecret: "refresh-secret",
      jwtRefreshExpiration: "7d",
    };

    auditLogServiceMock = {
      recordAuditLog: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasskeysService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: JwtService, useValue: jwtServiceMock },
        { provide: ConfigurationService, useValue: configServiceMock },
        { provide: AuditLogService, useValue: auditLogServiceMock },
      ],
    }).compile();

    service = module.get<PasskeysService>(PasskeysService);
  });

  describe("generateRegistrationOptions", () => {
    it("should generate WebAuthn options and cache challenge", async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: "user-passkey-1",
        email: "alice@example.com",
        displayName: "Alice",
      });

      const options =
        await service.generateRegistrationOptions("user-passkey-1");

      expect(options).toBeDefined();
      expect(options.challenge).toBeDefined();
      expect(options.rp.name).toBe("Allinone");
      expect(options.user.name).toBe("alice@example.com");
      expect(options.pubKeyCredParams.length).toBeGreaterThan(0);
    });
  });

  describe("verifyRegistration", () => {
    it("should verify valid clientDataJSON and persist passkey credential", async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: "user-passkey-2",
        email: "bob@example.com",
      });

      const options =
        await service.generateRegistrationOptions("user-passkey-2");

      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge: options.challenge,
          origin: "https://localhost:3000",
        }),
      ).toString("base64url");

      prismaMock.authentication.findFirst.mockResolvedValue(null);
      prismaMock.authentication.create.mockResolvedValue({
        id: "auth-1",
        type: AuthType.PASSKEY,
        identifier: "cred-123",
      });

      const result = await service.verifyRegistration("user-passkey-2", {
        id: "cred-123",
        clientDataJSON,
        attestationObject: "mock-attestation-object",
        deviceName: "MacBook TouchID",
      });

      expect(result.success).toBe(true);
      expect(result.credentialId).toBe("cred-123");
      expect(prismaMock.authentication.create).toHaveBeenCalled();
      expect(auditLogServiceMock.recordAuditLog).toHaveBeenCalled();
    });

    it("should reject if challenge mismatch", async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: "user-passkey-3",
        email: "charlie@example.com",
      });

      await service.generateRegistrationOptions("user-passkey-3");

      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge: "invalid-challenge-mismatch",
          origin: "https://localhost:3000",
        }),
      ).toString("base64url");

      await expect(
        service.verifyRegistration("user-passkey-3", {
          id: "cred-456",
          clientDataJSON,
          attestationObject: "mock",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("login and assertion verification", () => {
    it("should issue access/refresh tokens upon valid passkey verification", async () => {
      const options = await service.generateLoginOptions({
        email: "alice@example.com",
      });

      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: options.challenge,
          origin: "https://localhost:3000",
        }),
      ).toString("base64url");

      prismaMock.authentication.findFirst.mockResolvedValue({
        id: "auth-passkey-1",
        type: AuthType.PASSKEY,
        identifier: "cred-alice",
        user: {
          id: "user-alice",
          email: "alice@example.com",
          status: UserStatus.ACTIVE,
          lockedUntil: null,
        },
      });

      const loginResult = await service.verifyLogin(
        {
          id: "cred-alice",
          clientDataJSON,
          authenticatorData: "mock-auth-data",
          signature: "mock-signature",
        },
        "127.0.0.1",
        "Mozilla/5.0",
      );

      expect(loginResult).toBeDefined();
      expect(loginResult.tokens.accessToken).toBe("mocked-jwt-token");
      expect(loginResult.sessionId).toBe("session-passkey-1");
      expect(auditLogServiceMock.recordAuditLog).toHaveBeenCalled();
    });

    it("should reject if passkey credential is unknown", async () => {
      const options = await service.generateLoginOptions();

      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: options.challenge,
          origin: "https://localhost:3000",
        }),
      ).toString("base64url");

      prismaMock.authentication.findFirst.mockResolvedValue(null);

      await expect(
        service.verifyLogin({
          id: "unknown-cred",
          clientDataJSON,
          authenticatorData: "mock",
          signature: "mock",
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
