import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { VaultSettingsService } from "./vault-settings.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { OtpService } from "@/common/otp/otp.service";
import { UsersService } from "@/users/users.service";
import { ConfigurationService } from "@/config/configuration.service";
import { MailService } from "@/common/mail/mail.service";
import { AuditLogService } from "@/common/audit/audit-log.service";

const PEPPER = "a-server-only-pepper-value-0123456789";

/** What the service stores for a client that sent [verifier]. */
const peppered = (verifier: string) =>
  `hmac-sha256:${createHmac("sha256", PEPPER).update(verifier).digest("base64")}`;

describe("VaultSettingsService recovery", () => {
  let service: VaultSettingsService;
  let prisma: any;
  let otpService: any;
  let usersService: any;
  let mailService: any;
  let auditLogService: any;
  const config = { isProduction: true, encryptionKey: PEPPER };

  const setting = {
    userId: "user-1",
    masterKeyHash: "old-hash",
    keySalt: "old-salt",
    // Deliberately the pre-fix placeholder, so a test can tell "recorded what
    // the client sent" apart from "copied the row it was replacing".
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
    auditLogService = { recordAuditLog: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VaultSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: OtpService, useValue: otpService },
        { provide: UsersService, useValue: usersService },
        { provide: ConfigurationService, useValue: config },
        { provide: MailService, useValue: mailService },
        {
          provide: AuditLogService,
          useValue: auditLogService,
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
          masterKeyHash: peppered("new-hash"),
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

  it("refuses a rotation that would leave the previous recovery wrap stored", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      recoveryGrantedAt: new Date(),
    });

    // Without this the stored wrappedMasterKey keeps wrapping the *old* master
    // key, and the next recovery hands back a key that opens nothing.
    await expect(
      service.completeRecovery("user-1", {
        masterKeyHash: "new-hash",
        keySalt: "new-salt",
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.vaultSetting.update).not.toHaveBeenCalled();
  });

  it("accepts the stored master-key verifier", async () => {
    const result = await service.unlockVault("user-1", {
      masterKeyHash: "old-hash",
    } as any);

    expect(result.success).toBe(true);
    expect(auditLogService.recordAuditLog).not.toHaveBeenCalled();
  });

  it("audits a rejected master password without leaking through a short verifier", async () => {
    // A length mismatch must not reach timingSafeEqual, which throws on it.
    await expect(
      service.unlockVault("user-1", { masterKeyHash: "old" } as any),
    ).rejects.toThrow(UnauthorizedException);

    await expect(
      service.unlockVault("user-1", { masterKeyHash: "old-hash!" } as any),
    ).rejects.toThrow(UnauthorizedException);

    expect(auditLogService.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        action: "LOGIN_FAILURE",
        resourceType: "vault",
      }),
    );
  });

  it("refuses a setup that would clear stored recovery material", async () => {
    // Reachable when a row carries the wrap but has not been marked configured
    // (an interrupted setup). Its upsert update branch null-coalesces the four
    // recovery columns, so an incomplete request would delete the only copy.
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      isVaultConfigured: false,
    });

    await expect(
      service.setupVault("user-1", {
        masterKeyHash: "new-hash",
        keySalt: "new-salt",
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.vaultSetting.upsert).not.toHaveBeenCalled();
  });

  it("accepts a first-time setup that stores no recovery material", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue(null);
    prisma.vaultSetting.upsert.mockResolvedValue({
      ...setting,
      isVaultConfigured: true,
      recoveryKey: null,
      wrappedMasterKey: null,
    });

    const result = await service.setupVault("user-1", {
      masterKeyHash: "new-hash",
      keySalt: "new-salt",
    } as any);

    expect(result.isVaultConfigured).toBe(true);
    expect(prisma.vaultSetting.upsert).toHaveBeenCalled();
  });

  it("stores the verifier as a keyed digest, never as the value it received", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue(null);
    prisma.vaultSetting.upsert.mockResolvedValue({ ...setting });

    await service.setupVault("user-1", {
      masterKeyHash: "new-hash",
      keySalt: "new-salt",
    } as any);

    const { create } = prisma.vaultSetting.upsert.mock.calls[0][0];
    expect(create.masterKeyHash).toBe(peppered("new-hash"));
    expect(create.masterKeyHash).not.toBe("new-hash");
  });

  it("records the KDF parameters the client reports", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue(null);
    prisma.vaultSetting.upsert.mockResolvedValue({ ...setting });

    await service.setupVault("user-1", {
      masterKeyHash: "new-hash",
      keySalt: "new-salt",
      kdfIterations: 3,
      kdfMemory: 65536,
    } as any);

    const { create } = prisma.vaultSetting.upsert.mock.calls[0][0];
    expect(create.kdfIterations).toBe(3);
    expect(create.kdfMemory).toBe(65536);
  });

  it("falls back to what the shipped client derives with, not to a placeholder", async () => {
    // 100000 was the previous fallback: a PBKDF2-shaped number no client of
    // this endpoint ever used, so a row written by an older build described a
    // derivation that had not happened. Nothing reads the column, so this is
    // about the record being true rather than about behaviour.
    prisma.vaultSetting.findUnique.mockResolvedValue(null);
    prisma.vaultSetting.upsert.mockResolvedValue({ ...setting });

    await service.setupVault("user-1", {
      masterKeyHash: "new-hash",
      keySalt: "new-salt",
    } as any);

    const { create, update } = prisma.vaultSetting.upsert.mock.calls[0][0];
    expect(create.kdfIterations).toBe(3);
    expect(create.kdfMemory).toBe(65536);
    expect(update.kdfIterations).toBe(3);
  });

  it("re-records the parameters on recovery instead of inheriting the stored row", async () => {
    // `setting` above holds the legacy 100000. A recovery derives a new key
    // with the current client, so carrying the old number forward would keep
    // every recovered vault misdescribing itself.
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      recoveryGrantedAt: new Date(),
    });

    await service.completeRecovery("user-1", newKeyMaterial as any);

    const { data } = prisma.vaultSetting.update.mock.calls.at(-1)[0];
    expect(data.kdfIterations).toBe(3);
    expect(data.kdfMemory).toBe(65536);
  });

  it("opens a peppered vault from the digest alone", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      masterKeyHash: peppered("old-hash"),
    });

    const result = await service.unlockVault("user-1", {
      masterKeyHash: "old-hash",
    } as any);

    expect(result.success).toBe(true);
    expect(prisma.vaultSetting.update).not.toHaveBeenCalled();
  });

  it("converts a legacy verifier row on the first unlock that succeeds", async () => {
    // "old-hash" is what rows written before the pepper hold. Refusing them
    // would lock out every vault that existed first, so the upgrade happens on
    // the way out — the only moment the raw value is in hand.
    const result = await service.unlockVault("user-1", {
      masterKeyHash: "old-hash",
    } as any);

    expect(result.success).toBe(true);
    expect(prisma.vaultSetting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { masterKeyHash: peppered("old-hash") },
      }),
    );
  });

  it("stops accepting the raw verifier once the row carries the digest", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      masterKeyHash: peppered("old-hash"),
    });

    await expect(
      service.unlockVault("user-1", {
        masterKeyHash: peppered("old-hash"),
      } as any),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("keeps the stored verifier out of the recovery answer", async () => {
    const material = await service.verifyRecoveryOtp("user-1", "246810");

    expect(material).not.toHaveProperty("masterKeyHash");
    expect(material.wrappedMasterKey).toBe("wrapped");
  });

  describe("unlock attempts", () => {
    /** A row that reads back what was last written to it, so the counter moves. */
    function liveRow(overrides: Record<string, unknown> = {}) {
      const row: any = {
        ...setting,
        masterKeyHash: peppered("old-hash"),
        unlockFailedAttempts: 0,
        unlockLockedUntil: null,
        ...overrides,
      };
      prisma.vaultSetting.findUnique.mockImplementation(() =>
        Promise.resolve(row),
      );
      prisma.vaultSetting.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      );
      return row;
    }

    it("cools the endpoint down once five guesses fail", async () => {
      const row = liveRow();

      for (let attempt = 1; attempt <= 5; attempt++) {
        await expect(
          service.unlockVault("user-1", { masterKeyHash: "wrong" } as any),
        ).rejects.toThrow(UnauthorizedException);
      }
      expect(row.unlockFailedAttempts).toBe(5);
      expect(row.unlockLockedUntil).toBeInstanceOf(Date);

      // The cooldown refuses the correct verifier too: what it stops is the
      // asking, not the wrongness.
      await expect(
        service.unlockVault("user-1", { masterKeyHash: "old-hash" } as any),
      ).rejects.toThrow(/Try again in/);
    });

    it("leaves the endpoint open for the first four guesses", async () => {
      const row = liveRow();

      for (let attempt = 1; attempt <= 4; attempt++) {
        await expect(
          service.unlockVault("user-1", { masterKeyHash: "wrong" } as any),
        ).rejects.toThrow(UnauthorizedException);
      }
      expect(row.unlockLockedUntil).toBeNull();

      await expect(
        service.unlockVault("user-1", { masterKeyHash: "old-hash" } as any),
      ).resolves.toMatchObject({ success: true });
    });

    it("starts the count over on a successful unlock", async () => {
      const row = liveRow({ unlockFailedAttempts: 4 });

      await service.unlockVault("user-1", {
        masterKeyHash: "old-hash",
      } as any);

      expect(row.unlockFailedAttempts).toBe(0);
    });

    it("counts a wrong master password on the vault, not the account", async () => {
      // The whole point of the separate columns: reusing
      // `User.failedLoginAttempts` would let a mistyped master password lock
      // the account out of notes, tasks and calendar. This fake has no `user`
      // delegate at all, so any write that strayed there throws.
      liveRow();

      await expect(
        service.unlockVault("user-1", { masterKeyHash: "wrong" } as any),
      ).rejects.toThrow(UnauthorizedException);

      expect(prisma.vaultSetting.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ unlockFailedAttempts: 1 }),
        }),
      );
    });
  });
});
