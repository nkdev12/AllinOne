import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { VaultSettingsService } from "./vault-settings.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { OtpService } from "@/common/otp/otp.service";
import { UsersService } from "@/users/users.service";
import { ConfigurationService } from "@/config/configuration.service";
import { MailService } from "@/common/mail/mail.service";
import { AuditLogService } from "@/common/audit/audit-log.service";

describe("VaultSettingsService recovery", () => {
  let service: VaultSettingsService;
  let prisma: any;
  let otpService: any;
  let usersService: any;
  let mailService: any;

  const setting = {
    userId: "user-1",
    masterKeyHash: "old-hash",
    keySalt: "old-salt",
    kdfIterations: 100000,
    kdfMemory: 65536,
    isVaultConfigured: true,
    recoveryKey: "recovery-key",
    wrappedMasterKey: "wrapped",
    wrappedMasterIv: "iv",
    wrappedMasterTag: "tag",
    recoveryGrantedAt: null as Date | null,
  };

  const newKeyMaterial = {
    masterKeyHash: "new-hash",
    keySalt: "new-salt",
    recoveryKey: "new-recovery-key",
    wrappedMasterKey: "new-wrapped",
    wrappedMasterIv: "new-iv",
    wrappedMasterTag: "new-tag",
  };

  beforeEach(async () => {
    prisma = {
      vaultSetting: {
        findUnique: jest.fn().mockResolvedValue(setting),
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ ...setting, ...data }),
          ),
        upsert: jest.fn(),
      },
    };
    otpService = {
      issue: jest.fn().mockResolvedValue("246810"),
      consume: jest.fn().mockResolvedValue(true),
    };
    usersService = {
      getUserById: jest
        .fn()
        .mockResolvedValue({ id: "user-1", email: "user@example.com" }),
    };
    mailService = {
      sendVaultRecoveryOtpEmail: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VaultSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: OtpService, useValue: otpService },
        { provide: UsersService, useValue: usersService },
        { provide: ConfigurationService, useValue: { isProduction: true } },
        { provide: MailService, useValue: mailService },
        {
          provide: AuditLogService,
          useValue: { recordAuditLog: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<VaultSettingsService>(VaultSettingsService);
  });

  it("emails a single-use recovery code", async () => {
    const result = await service.requestRecoveryOtp("user-1");

    expect(otpService.issue).toHaveBeenCalledWith(
      "user-1",
      "VAULT_RECOVERY",
      expect.any(Number),
    );
    expect(mailService.sendVaultRecoveryOtpEmail).toHaveBeenCalledWith(
      "user@example.com",
      "246810",
    );
    expect(result.message).toContain("If the vault can be recovered");
  });

  it("refuses recovery for vaults stored without recovery material", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      wrappedMasterKey: null,
    });

    await expect(service.requestRecoveryOtp("user-1")).rejects.toThrow(
      BadRequestException,
    );
    expect(otpService.issue).not.toHaveBeenCalled();
  });

  it("returns the wrapped key and opens a completion window", async () => {
    const result = await service.verifyRecoveryOtp("user-1", "246810");

    expect(result.wrappedMasterKey).toBe("wrapped");
    expect(result.recoveryKey).toBe("recovery-key");
    expect(prisma.vaultSetting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { recoveryGrantedAt: expect.any(Date) },
      }),
    );
  });

  it("rejects an invalid code before touching the vault", async () => {
    otpService.consume.mockResolvedValue(false);

    await expect(service.verifyRecoveryOtp("user-1", "000000")).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.vaultSetting.update).not.toHaveBeenCalled();
  });

  it("stores the re-keyed settings and closes the window", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      recoveryGrantedAt: new Date(),
    });

    const result = await service.completeRecovery("user-1", {
      ...newKeyMaterial,
    } as any);

    expect(result.keySalt).toBe("new-salt");
    expect(prisma.vaultSetting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          masterKeyHash: "new-hash",
          recoveryGrantedAt: null,
        }),
      }),
    );
  });

  it("refuses to rotate the master key once the window has passed", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      recoveryGrantedAt: new Date(Date.now() - 16 * 60 * 1000),
    });

    await expect(
      service.completeRecovery("user-1", newKeyMaterial as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("refuses to rotate a vault that never verified a code", async () => {
    await expect(
      service.completeRecovery("user-1", newKeyMaterial as any),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.vaultSetting.update).not.toHaveBeenCalled();
  });
});
