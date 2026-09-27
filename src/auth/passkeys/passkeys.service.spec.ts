import { Test, TestingModule } from "@nestjs/testing";
import { PasskeysService } from "./passkeys.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
import { BadRequestException } from "@nestjs/common";
import { AuthType } from "@prisma/client";

describe("PasskeysService", () => {
  let service: PasskeysService;
  let prismaMock: any;
  let auditLogServiceMock: any;

  beforeEach(async () => {
    prismaMock = {
      user: {
        findUnique: jest.fn(),
      },
      authentication: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };

    auditLogServiceMock = {
      recordAuditLog: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasskeysService,
        { provide: PrismaService, useValue: prismaMock },
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
});
