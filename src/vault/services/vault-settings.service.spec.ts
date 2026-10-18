import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import * as crypto from "node:crypto";
import { VaultSettingsService } from "./vault-settings.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { OtpService } from "@/common/otp/otp.service";
import { UsersService } from "@/users/users.service";
import { ConfigurationService } from "@/config/configuration.service";
import { MailService } from "@/common/mail/mail.service";
import { AuditLogService } from "@/common/audit/audit-log.service";

/** The pepper this deployment seals with today. */
const PEPPER = "a-server-only-pepper-value-0123456789";
const PEPPER_ID = "v2-2026-10";
/** The one it retired, and the rows still stamped with it. */
const RETIRED_PEPPER = "the-pepper-this-server-retired-01234567";
const RETIRED_PEPPER_ID = "v1-2026-04";

/**
 * Counts the HMACs a service call computes, which is the number of pepper keys it
 * tried.
 *
 * `createHmac` itself cannot be spied — `node:crypto`'s exports are
 * non-configurable — and the count is the thing worth asserting: the rotation
 * window is paid for on every unlock, so a steady-state deployment that tried two
 * keys would be doubling the cost of the hottest credential check in the app.
 */
jest.mock("node:crypto", () => {
  const real = jest.requireActual("node:crypto");
  const counter = hmacCounter();
  return {
    ...real,
    createHmac: (...args: unknown[]) => {
      counter.secrets.push(args[1]);
      return real.createHmac(...args);
    },
  };
});

/** The shared tally, reachable without letting the factory reference a binding. */
function hmacCounter(): { secrets: unknown[] } {
  const holder = globalThis as typeof globalThis & {
    __pepperHmacSecrets?: { secrets: unknown[] };
  };
  holder.__pepperHmacSecrets ??= { secrets: [] };
  return holder.__pepperHmacSecrets;
}

/** The secrets tried since the last reset. */
const secretsTried = () => {
  const counter = hmacCounter();
  const seen = counter.secrets.splice(0, counter.secrets.length);
  return seen;
};

/** What the service stores for a client that sent [verifier]. */
const pepperedWith = (pepper: string, verifier: string) =>
  `hmac-sha256:${crypto
    .createHmac("sha256", pepper)
    .update(verifier)
    .digest("base64")}`;

const peppered = (verifier: string) => pepperedWith(PEPPER, verifier);

/** The body a Nest exception carries, which is what the client branches on. */
function responseBody(err: unknown): Record<string, any> {
  return (err as { getResponse?: () => any }).getResponse?.() ?? {};
}

/**
 * What a row holds after a write. MongoDB applies `increment` to the number
 * already stored rather than replacing it with the operator object, and a double
 * that only spreads `data` over the row cannot show the counter moving — which
 * is the only behaviour worth testing about it.
 */
function mergeWrite(
  stored: Record<string, any>,
  data: Record<string, unknown>,
): Record<string, any> {
  const next: Record<string, any> = { ...stored };
  for (const [field, value] of Object.entries(data)) {
    const operator =
      value !== null && typeof value === "object" && "increment" in value
        ? (value as { increment: number })
        : undefined;
    next[field] = operator
      ? (Number(stored[field]) || 0) + operator.increment
      : value;
  }
  return next;
}

/** The `data` of every `update` the service issued, in order. */
function updateWrites(prisma: any): Record<string, unknown>[] {
  return prisma.vaultSetting.update.mock.calls.map(
    ([args]: [{ data: Record<string, unknown> }]) => args.data,
  );
}

/** The `data` of every `updateMany` the service issued, in order. */
function updateManyWrites(prisma: any): Record<string, unknown>[] {
  return prisma.vaultSetting.updateMany.mock.calls.map(
    ([args]: [{ data: Record<string, unknown> }]) => args.data,
  );
}

/**
 * Enough of the connector's filter language for the two conditional writes the
 * vault makes: equality, which is how a recovery grant is claimed, and
 * "only if it moves forward", which is how a cooldown escalates. A mock that
 * agreed to every filter cannot show a write that should have been refused.
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

describe("VaultSettingsService recovery", () => {
  let service: VaultSettingsService;
  let prisma: any;
  let otpService: any;
  let usersService: any;
  let mailService: any;
  let auditLogService: any;
  const config: Record<string, unknown> = {
    isProduction: true,
    isDevelopment: false,
    encryptionKey: PEPPER,
    encryptionKeyId: PEPPER_ID,
    encryptionKeyPrevious: undefined,
    encryptionKeyPreviousId: undefined,
  };

  const setting = {
    userId: "user-1",
    masterKeyHash: "old-hash",
    keySalt: "old-salt",
    // Deliberately the pre-fix placeholder, so a test can tell "recorded what
    // the client sent" apart from "copied the row it was replacing".
    kdfIterations: 100000,
    kdfMemory: 65536,
    isVaultConfigured: true,
    // A pre-2026-10 row: the app uploaded the unwrapped wrapping key itself.
    recoveryKdfSalt: null as string | null,
    recoveryKey: "recovery-key",
    wrappedMasterKey: "wrapped",
    wrappedMasterIv: "iv",
    wrappedMasterTag: "tag",
    recoveryGrantedAt: null as Date | null,
  };

  const newKeyMaterial = {
    masterKeyHash: "new-hash",
    keySalt: "new-salt",
    passwordWrappedKey: "new-password-wrap",
    passwordWrappedIv: "new-iv",
    passwordWrappedTag: "new-tag",
    kdfIterations: 3,
    kdfMemory: 65536,
  };

  beforeEach(async () => {
    Object.assign(config, {
      isProduction: true,
      isDevelopment: false,
      encryptionKey: PEPPER,
      encryptionKeyId: PEPPER_ID,
      // The steady state: one pepper in the ring, no rotation window open.
      encryptionKeyPrevious: undefined,
      encryptionKeyPreviousId: undefined,
    });
    prisma = {
      vaultSetting: {
        findUnique: jest.fn().mockResolvedValue(setting),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve(mergeWrite(setting, data)),
          ),
        updateMany: jest.fn().mockImplementation(async ({ data }) => {
          // A re-key is a whole-row write with no operators in it, so the row it
          // leaves behind is what the next read has to answer with.
          prisma.vaultSetting.findUnique.mockResolvedValue({
            ...setting,
            ...data,
          });
          return { count: 1 };
        }),
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

  /**
   * A row that reads back what was last written to it, so the counter moves and a
   * conditional write can be refused.
   *
   * Defaults to a row the current pepper sealed and stamped, because that is what
   * a clean unlock finds and the only state in which the endpoint writes nothing.
   * Every rotation case overrides the two columns that say otherwise.
   */
  function liveRow(overrides: Record<string, unknown> = {}) {
    const row: any = {
      ...setting,
      masterKeyHash: peppered("old-hash"),
      masterKeyHashPepper: PEPPER_ID,
      unlockFailedAttempts: 0,
      unlockLockedUntil: null,
      ...overrides,
    };
    prisma.vaultSetting.findUnique.mockImplementation(() =>
      // A copy per read, the way a connector hands a document to one request:
      // if every racer shared the live object, a read-check-write counter would
      // look correct here because each would see the others' writes.
      Promise.resolve({ ...row }),
    );
    prisma.vaultSetting.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(row, mergeWrite(row, data));
        return Promise.resolve({ ...row });
      },
    );
    // Both the cooldown and the re-seal are conditional writes, so the fake has to
    // answer for the filter the way the connector does: a deadline already further
    // out is not something a smaller guess may replace, and a digest that has since
    // moved is not something a slower request may stamp back.
    prisma.vaultSetting.updateMany.mockImplementation(
      ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (!matchesFilter(row, where)) return Promise.resolve({ count: 0 });
        Object.assign(row, mergeWrite(row, data));
        return Promise.resolve({ count: 1 });
      },
    );
    return row;
  }

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

  it("keeps the recovery code out of the log unless development is declared", async () => {
    // `isProduction: false` is what a staging box, a container with `APP_ENV`
    // never set, and a typo in the operator's label all look like — and a
    // recovery code printed there is half a credential: with the 12-word phrase
    // it hands over the wrapped master key. Only the positive declaration of
    // development prints it.
    Object.assign(config, { isProduction: false, isDevelopment: false });
    const debug = jest
      .spyOn((service as any).logger, "debug")
      .mockImplementation(() => undefined);

    await service.requestRecoveryOtp("user-1");

    expect(debug).not.toHaveBeenCalled();
    // The code still goes out by email; this is about the console, not delivery.
    expect(mailService.sendVaultRecoveryOtpEmail).toHaveBeenCalledWith(
      "user@example.com",
      "246810",
    );
    debug.mockRestore();
  });

  it("prints the code only where development is what the operator declared", async () => {
    Object.assign(config, { isProduction: false, isDevelopment: true });
    const debug = jest
      .spyOn((service as any).logger, "debug")
      .mockImplementation(() => undefined);

    await service.requestRecoveryOtp("user-1");

    expect(debug).toHaveBeenCalledWith(expect.stringContaining("246810"));
    debug.mockRestore();
  });

  it("does not claim a recovery code was sent when production email fails", async () => {
    mailService.sendVaultRecoveryOtpEmail.mockResolvedValue(false);
    const productionConfig = { ...config, isProduction: true };
    const module = await Test.createTestingModule({
      providers: [
        VaultSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: OtpService, useValue: otpService },
        { provide: UsersService, useValue: usersService },
        { provide: ConfigurationService, useValue: productionConfig },
        { provide: MailService, useValue: mailService },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();

    await expect(
      module
        .get<VaultSettingsService>(VaultSettingsService)
        .requestRecoveryOtp("user-1"),
    ).rejects.toThrow(BadRequestException);
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

  it("serves a phrase-derived envelope with no key material at all", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      recoveryKdfSalt: "cmVjb3Zlcnktc2FsdA==",
      // Still present from before the fix: the salt decides what is returned,
      // so an upgraded row must never leak the key it replaced.
      recoveryKey: "recovery-key",
    });

    const result = await service.verifyRecoveryOtp("user-1", "246810");

    expect(result.recoveryKdfSalt).toBe("cmVjb3Zlcnktc2FsdA==");
    expect(result.recoveryKey).toBeNull();
    expect(result.wrappedMasterKey).toBe("wrapped");
  });

  it("refuses recovery when the row holds neither envelope", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      recoveryKdfSalt: null,
      recoveryKey: null,
    });

    await expect(service.verifyRecoveryOtp("user-1", "246810")).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.vaultSetting.update).not.toHaveBeenCalled();
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
    expect(prisma.vaultSetting.updateMany).toHaveBeenCalledWith(
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

  it("preserves recovery material and never touches entry ciphertext", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      recoveryGrantedAt: new Date(),
    });
    await service.completeRecovery("user-1", newKeyMaterial);
    const { data } = prisma.vaultSetting.updateMany.mock.calls[0][0];
    expect(data).not.toHaveProperty("recoveryKey");
    expect(data).not.toHaveProperty("wrappedMasterKey");
    expect(data.passwordWrappedKey).toBe(newKeyMaterial.passwordWrappedKey);
  });

  it("replaces a legacy unwrapped key with the phrase-derived envelope", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      recoveryGrantedAt: new Date(),
    });
    await service.completeRecovery("user-1", {
      ...newKeyMaterial,
      recoveryKdfSalt: "cmVjb3Zlcnktc2FsdA==",
      wrappedMasterKey: "new-wrap",
      wrappedMasterIv: "new-wrap-iv",
      wrappedMasterTag: "new-wrap-tag",
    });

    const { data } = prisma.vaultSetting.updateMany.mock.calls[0][0];
    expect(data.recoveryKey).toBeNull();
    expect(data.recoveryKdfSalt).toBe("cmVjb3Zlcnktc2FsdA==");
    expect(data.wrappedMasterKey).toBe("new-wrap");
  });

  it("allows an identical completion retry after a lost response", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      recoveryGrantedAt: new Date(),
    });
    await service.completeRecovery("user-1", newKeyMaterial);
    await service.completeRecovery("user-1", newKeyMaterial);
    expect(prisma.vaultSetting.updateMany).toHaveBeenCalledTimes(1);
  });

  it("rejects a recovery grant consumed by a concurrent request", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      recoveryGrantedAt: new Date(),
    });
    prisma.vaultSetting.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.completeRecovery("user-1", newKeyMaterial),
    ).rejects.toThrow("Vault recovery changed");
  });

  it("refuses legacy clients access to the wrapped-key format", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      passwordWrappedKey: "wrapped-data-key",
    });
    await expect(
      service.unlockVault("user-1", { masterKeyHash: "old-hash" }),
    ).rejects.toThrow("Update this app");
    await expect(
      service.unlockVault("user-1", {
        masterKeyHash: "old-hash",
        keyEnvelopeVersion: 1,
      }),
    ).resolves.toHaveProperty("success", true);
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

  it("stores only the recovery salt and deletes any legacy unwrapped key", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      isVaultConfigured: false,
    });
    prisma.vaultSetting.upsert.mockResolvedValue({ ...setting });

    await service.setupVault("user-1", {
      masterKeyHash: "new-hash",
      keySalt: "new-salt",
      recoveryKdfSalt: "cmVjb3Zlcnktc2FsdA==",
      wrappedMasterKey: "wrap",
      wrappedMasterIv: "iv",
      wrappedMasterTag: "tag",
    } as any);

    const { create, update } = prisma.vaultSetting.upsert.mock.calls[0][0];
    for (const branch of [create, update]) {
      expect(branch.recoveryKdfSalt).toBe("cmVjb3Zlcnktc2FsdA==");
      expect(branch.recoveryKey).toBeNull();
    }
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

    const { data } = prisma.vaultSetting.updateMany.mock.calls.at(-1)[0];
    expect(data.kdfIterations).toBe(3);
    expect(data.kdfMemory).toBe(65536);
  });

  it("opens a peppered vault from the digest alone", async () => {
    prisma.vaultSetting.findUnique.mockResolvedValue({
      ...setting,
      masterKeyHash: peppered("old-hash"),
      masterKeyHashPepper: PEPPER_ID,
    });

    const result = await service.unlockVault("user-1", {
      masterKeyHash: "old-hash",
    } as any);

    expect(result.success).toBe(true);
    expect(prisma.vaultSetting.update).not.toHaveBeenCalled();
    expect(prisma.vaultSetting.updateMany).not.toHaveBeenCalled();
  });

  it("converts a legacy verifier row on the first unlock that succeeds", async () => {
    // "old-hash" is what rows written before the pepper hold. Refusing them
    // would lock out every vault that existed first, so the upgrade happens on
    // the way out — the only moment the raw value is in hand.
    const result = await service.unlockVault("user-1", {
      masterKeyHash: "old-hash",
    } as any);

    expect(result.success).toBe(true);
    expect(prisma.vaultSetting.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          masterKeyHash: peppered("old-hash"),
          masterKeyHashPepper: PEPPER_ID,
        },
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
          data: expect.objectContaining({
            unlockFailedAttempts: { increment: 1 },
          }),
        }),
      );
    });

    it("sends the increment, never the number it read", async () => {
      const row = liveRow({ unlockFailedAttempts: 3 });

      await expect(
        service.unlockVault("user-1", { masterKeyHash: "wrong" } as any),
      ).rejects.toThrow(UnauthorizedException);

      const writes = updateWrites(prisma);
      // Writing `4` here is the lost update: two guesses from two devices that
      // both read `3` would both set `4`, and the counter that decides the
      // lockout is the one an attacker races on purpose.
      expect(writes[0]).toEqual({ unlockFailedAttempts: { increment: 1 } });
      expect(
        writes.some((data) => typeof data.unlockFailedAttempts === "number"),
      ).toBe(false);
      expect(row.unlockFailedAttempts).toBe(4);
    });

    it("sizes the cooldown from the count the row holds, not the one it read", async () => {
      // A guess from elsewhere landed between this request's read and its own
      // `$inc`. The snapshot says four, the row says five; answering from the
      // snapshot would hand the attacker one more free step for every parallel
      // guesser, which is the bug the increment exists to close.
      const row = liveRow({ unlockFailedAttempts: 5 });
      prisma.vaultSetting.findUnique.mockResolvedValue({
        ...row,
        unlockFailedAttempts: 4,
      });

      await expect(
        service.unlockVault("user-1", { masterKeyHash: "wrong" } as any),
      ).rejects.toThrow(UnauthorizedException);

      // Six is one step past the ceiling, so: 60s * 2. Four would have been no
      // cooldown at all.
      expect(row.unlockFailedAttempts).toBe(6);
      expect(auditLogService.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { attempts: 6, cooldownMs: 120_000 },
        }),
      );
      expect(row.unlockLockedUntil).toBeInstanceOf(Date);
      expect(row.unlockLockedUntil.getTime() - Date.now()).toBeGreaterThan(
        60_000,
      );
    });

    it("counts every guess in a burst of parallel wrong passwords", async () => {
      // The exploit: ten guesses that all read the same row and all write back
      // `1` never reach the five-attempt ceiling, so the lockout an honest user
      // depends on is unreachable for anyone willing to race. Every racer has to
      // move the stored count, and the cooldown has to be sized from the ten
      // rather than from the zero each of them read.
      const row = liveRow();

      const outcomes = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          service.unlockVault("user-1", { masterKeyHash: "wrong" } as any),
        ),
      );

      // The response shape the client branches on is untouched by any of this.
      expect(outcomes.map((outcome) => outcome.status)).toEqual(
        Array(10).fill("rejected"),
      );
      for (const outcome of outcomes) {
        const reason = (outcome as PromiseRejectedResult).reason;
        expect(reason).toBeInstanceOf(UnauthorizedException);
        expect(reason.message).toBe(
          "Invalid master password verification key.",
        );
      }
      expect(row.unlockFailedAttempts).toBe(10);
      expect(updateWrites(prisma)).toEqual(
        Array.from({ length: 10 }, () => ({
          unlockFailedAttempts: { increment: 1 },
        })),
      );

      // Ten is five past the ceiling, so the curve says 32 minutes. Whichever
      // guess's write landed last, the row keeps the longest deadline offered:
      // the base 60s here would mean the burst had bought itself a shorter wait.
      const remaining = row.unlockLockedUntil.getTime() - Date.now();
      expect(remaining).toBeGreaterThan(600_000);
      expect(remaining).toBeLessThanOrEqual(1_920_000);
    });

    it("never shortens a cooldown a further-out guess already earned", async () => {
      // Bursts do not finish in the order they started. This guess only reached
      // six, so its 120s deadline must not overwrite the escalation standing in
      // the row — otherwise a hundred parallel guesses collapse the curve back
      // to the base wait, which is precisely what the racer is trying to buy.
      const row = liveRow({ unlockFailedAttempts: 5 });
      let injected = false;
      prisma.vaultSetting.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(row, mergeWrite(row, data));
          if (!injected) {
            injected = true;
            row.unlockLockedUntil = new Date(Date.now() + 30 * 60 * 1000);
          }
          return Promise.resolve({ ...row });
        },
      );

      await expect(
        service.unlockVault("user-1", { masterKeyHash: "wrong" } as any),
      ).rejects.toThrow(UnauthorizedException);

      expect(row.unlockLockedUntil.getTime() - Date.now()).toBeGreaterThan(
        20 * 60 * 1000,
      );
      // The write was issued against a filter that refused it, not skipped: the
      // request had nothing else to say about a deadline it did not own.
      expect(
        updateManyWrites(prisma).some(
          (data) =>
            data.unlockLockedUntil !== undefined &&
            (data.unlockLockedUntil as Date).getTime() - Date.now() <
              20 * 60 * 1000,
        ),
      ).toBe(true);
    });

    it("caps a runaway count at an hour, not at the top of the curve", async () => {
      // `2 ** escalations` on a count an attacker has pushed into the forties is
      // a nine-figure cooldown; the ceiling is what keeps the answer honest
      // ("try again in an hour") instead of a wait no client will parse.
      const row = liveRow({ unlockFailedAttempts: 40 });

      await expect(
        service.unlockVault("user-1", { masterKeyHash: "wrong" } as any),
      ).rejects.toThrow(UnauthorizedException);

      expect(row.unlockFailedAttempts).toBe(41);
      expect(auditLogService.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { attempts: 41, cooldownMs: 3_600_000 },
        }),
      );
      const remaining = row.unlockLockedUntil.getTime() - Date.now();
      expect(remaining).toBeGreaterThan(3_500_000);
      expect(remaining).toBeLessThanOrEqual(3_600_000);
    });

    it("clears the streak by constant, never by a count this request read", async () => {
      // The reset is the one place a computed number would be a gift to the
      // guesser: writing back the count this request observed would silently
      // drop the guesses a racing burst added, so only a verified master
      // password may zero the streak, and only as the constant zero.
      const row = liveRow({ unlockFailedAttempts: 4 });

      await service.unlockVault("user-1", { masterKeyHash: "old-hash" } as any);

      expect(row.unlockFailedAttempts).toBe(0);
      expect(row.unlockLockedUntil).toBeNull();
      expect(updateWrites(prisma)).toEqual([
        { unlockFailedAttempts: 0, unlockLockedUntil: null },
      ]);
    });

    it("refuses the next guess outright once the row is past the ceiling", async () => {
      // The row this request reads already carries the accumulated count, so a
      // burst that pushed it to eight is refused before the verifier is compared
      // — the count an attacker raced is the count that now locks them out.
      const row = liveRow({
        unlockFailedAttempts: 8,
        unlockLockedUntil: new Date(Date.now() + 30_000),
      });

      await expect(
        service.unlockVault("user-1", { masterKeyHash: "old-hash" } as any),
      ).rejects.toThrow(/Try again in/);
      expect(prisma.vaultSetting.update).not.toHaveBeenCalled();
      expect(row.unlockFailedAttempts).toBe(8);
    });
  });

  /**
   * Rotating `ENCRYPTION_KEY` used to be the vault equivalent of dropping the
   * column: only a digest is stored, never the verifier it digests, so a row
   * sealed under the old key could only be converted on an unlock the old key was
   * precisely what refused — and the boot gate now *forces* the operator to
   * rotate, because the shipped template value is rejected everywhere else.
   */
  describe("pepper rotation", () => {
    /** The environment an operator runs with the window open. */
    const rotating = {
      encryptionKey: PEPPER,
      encryptionKeyId: PEPPER_ID,
      encryptionKeyPrevious: RETIRED_PEPPER,
      encryptionKeyPreviousId: RETIRED_PEPPER_ID,
    };

    /** A row the retired key sealed, and named. */
    const retiredRow = (overrides: Record<string, unknown> = {}) => ({
      masterKeyHash: pepperedWith(RETIRED_PEPPER, "old-hash"),
      masterKeyHashPepper: RETIRED_PEPPER_ID,
      ...overrides,
    });

    it("opens a vault the retired key sealed and re-seals it under the current one", async () => {
      Object.assign(config, rotating);
      const row = liveRow(retiredRow());

      await expect(
        service.unlockVault("user-1", { masterKeyHash: "old-hash" } as any),
      ).resolves.toHaveProperty("success", true);

      expect(row.masterKeyHash).toBe(peppered("old-hash"));
      expect(row.masterKeyHashPepper).toBe(PEPPER_ID);
    });

    it("keeps the vault open after the retired key leaves the environment", async () => {
      // The rotation must not log out anybody: the unlock during the window is
      // what converts the row, so once the operator clears
      // `ENCRYPTION_KEY_PREVIOUS` the current key is the only one the row has
      // ever needed to name.
      Object.assign(config, rotating);
      liveRow(retiredRow());
      await service.unlockVault("user-1", { masterKeyHash: "old-hash" } as any);

      Object.assign(config, {
        encryptionKeyPrevious: undefined,
        encryptionKeyPreviousId: undefined,
      });

      await expect(
        service.unlockVault("user-1", { masterKeyHash: "old-hash" } as any),
      ).resolves.toHaveProperty("success", true);
    });

    it("refuses a row stamped with a key this server does not hold as its own fault", async () => {
      // `ENCRYPTION_KEY_PREVIOUS` cleared too early, or a restore from before the
      // last rotation. Nothing the person typed is wrong, and a 401 would send
      // them to try again — five times, after which the cooldown would lock a
      // valid vault out of itself for an hour for a mistake in our environment.
      const row = liveRow(
        retiredRow({
          masterKeyHash: pepperedWith(
            "a-key-nobody-configured-anymore-0123",
            "old-hash",
          ),
          masterKeyHashPepper: "v0-2025-11",
        }),
      );

      const err = await service
        .unlockVault("user-1", { masterKeyHash: "old-hash" } as any)
        .catch((reason) => reason);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(responseBody(err).code).toBe("VAULT_PEPPER_KEY_UNAVAILABLE");
      expect(responseBody(err).details).toEqual({ pepperKeyId: "v0-2025-11" });
      // Not counted as a guess: the streak belongs to a wrong password.
      expect(row.unlockFailedAttempts).toBe(0);
      expect(prisma.vaultSetting.update).not.toHaveBeenCalled();
      expect(auditLogService.recordAuditLog).not.toHaveBeenCalled();
    });

    it("stamps a row that matched the current key but never named it", async () => {
      // Rows written between the pepper landing and the stamp existing are the
      // backfill-free case: readable without a migration because null means "the
      // key configured before identifiers", and named from their next unlock.
      const row = liveRow({ masterKeyHashPepper: null });

      await expect(
        service.unlockVault("user-1", { masterKeyHash: "old-hash" } as any),
      ).resolves.toHaveProperty("success", true);

      expect(row.masterKeyHash).toBe(peppered("old-hash"));
      expect(row.masterKeyHashPepper).toBe(PEPPER_ID);
    });

    it("tries exactly one key when nothing is configured as retired", async () => {
      // Absent `ENCRYPTION_KEY_PREVIOUS` is the steady state, so it must not be
      // paid for on every unlock — and one HMAC is not the only thing at stake: a
      // `createHmac` handed an undefined secret throws, which would answer a
      // correct master password with a 500.
      const wrong = liveRow();
      secretsTried();
      await expect(
        service.unlockVault("user-1", { masterKeyHash: "wrong" } as any),
      ).rejects.toThrow(UnauthorizedException);
      expect(secretsTried()).toEqual([PEPPER]);
      expect(wrong.unlockFailedAttempts).toBe(1);

      // A row that names no pepper and was sealed under a key this process never
      // held stays a wrong password, as it was before the ring existed: nothing in
      // the row points at a missing configuration, so there is nothing to blame.
      const unnamedElsewhere = liveRow({
        masterKeyHash: pepperedWith(
          "a-key-never-configured-here-0123456789",
          "old-hash",
        ),
        masterKeyHashPepper: null,
      });
      secretsTried();
      await expect(
        service.unlockVault("user-1", { masterKeyHash: "old-hash" } as any),
      ).rejects.toThrow(UnauthorizedException);
      expect(secretsTried()).toEqual([PEPPER]);
      expect(unnamedElsewhere.unlockFailedAttempts).toBe(1);

      // With the window open, a row that has never named its pepper costs both
      // keys, current first — that is the reading of "null means the key that was
      // configured before identifiers", and the reason no backfill is needed.
      Object.assign(config, rotating);
      const unnamed = liveRow({
        masterKeyHash: pepperedWith(RETIRED_PEPPER, "old-hash"),
        masterKeyHashPepper: null,
      });
      secretsTried();
      await expect(
        service.unlockVault("user-1", { masterKeyHash: "old-hash" } as any),
      ).resolves.toHaveProperty("success", true);
      // Two keys tried, in that order, and a third digest computed to write the
      // one that matched under the current key.
      expect(secretsTried()).toEqual([PEPPER, RETIRED_PEPPER, PEPPER]);
      expect(unnamed.masterKeyHashPepper).toBe(PEPPER_ID);
    });

    it("leaves a digest a concurrent recovery wrote alone", async () => {
      // The re-seal is guarded on the digest this request read. Here the owner
      // finished a recovery while this unlock was in flight, so the row holds the
      // *new* master password's verifier: writing this request's stale value back
      // would move the vault to a password that no longer exists.
      Object.assign(config, rotating);
      const row = liveRow(retiredRow());
      const read = prisma.vaultSetting.findUnique.getMockImplementation() as (
        ...args: unknown[]
      ) => Promise<any>;
      prisma.vaultSetting.findUnique.mockImplementation(
        async (...args: unknown[]) => {
          const value = await read(...args);
          Object.assign(row, {
            masterKeyHash: peppered("new-hash"),
            masterKeyHashPepper: PEPPER_ID,
          });
          return value;
        },
      );

      await expect(
        service.unlockVault("user-1", { masterKeyHash: "old-hash" } as any),
      ).resolves.toHaveProperty("success", true);

      expect(row.masterKeyHash).toBe(peppered("new-hash"));
      // The write was issued against the digest this request read, and matched
      // nothing — an unguarded `update` would have replaced it silently.
      expect(updateManyWrites(prisma)).toEqual([
        expect.objectContaining({ masterKeyHash: peppered("old-hash") }),
      ]);
    });

    it("stamps both branches of a setup", async () => {
      prisma.vaultSetting.findUnique.mockResolvedValue(null);
      prisma.vaultSetting.upsert.mockResolvedValue({ ...setting });

      await service.setupVault("user-1", {
        masterKeyHash: "new-hash",
        keySalt: "new-salt",
      } as any);

      const { create, update } = prisma.vaultSetting.upsert.mock.calls[0][0];
      for (const branch of [create, update]) {
        expect(branch.masterKeyHash).toBe(peppered("new-hash"));
        expect(branch.masterKeyHashPepper).toBe(PEPPER_ID);
      }
    });

    it("seals a new row under the current key while the window is open", async () => {
      // A setup written under the retired pepper would be a rotation window that
      // never drains, so the write path ignores the ring and names the current key.
      Object.assign(config, rotating);
      prisma.vaultSetting.findUnique.mockResolvedValue(null);
      prisma.vaultSetting.upsert.mockResolvedValue({ ...setting });

      await service.setupVault("user-1", {
        masterKeyHash: "new-hash",
        keySalt: "new-salt",
      } as any);

      const { create } = prisma.vaultSetting.upsert.mock.calls[0][0];
      expect(create.masterKeyHash).toBe(peppered("new-hash"));
      expect(create.masterKeyHashPepper).toBe(PEPPER_ID);
    });

    it("completes recovery for a vault the retired key sealed, and stamps it", async () => {
      // `completeRecovery` writes a verifier the pepper has never seen, so it
      // must seal and stamp it: a row leaving recovery unnamed is a row the next
      // rotation has to guess about.
      Object.assign(config, rotating);
      prisma.vaultSetting.findUnique.mockResolvedValue({
        ...setting,
        recoveryGrantedAt: new Date(),
        ...retiredRow(),
      });

      const result = await service.completeRecovery(
        "user-1",
        newKeyMaterial as any,
      );

      const { data } = prisma.vaultSetting.updateMany.mock.calls.at(-1)[0];
      expect(data.masterKeyHash).toBe(peppered("new-hash"));
      expect(data.masterKeyHashPepper).toBe(PEPPER_ID);
      // The other half of the subtlety: after a recovery the stored verifier is
      // `hash(passwordKey)` and the envelope beside it wraps the *data* key. Two
      // different secrets — the write never reaches for the envelope, and the
      // password wrapper comes back as the client sent it.
      expect(data).not.toHaveProperty("wrappedMasterKey");
      expect(data).not.toHaveProperty("recoveryKdfSalt");
      expect(result.passwordWrappedKey).toBe(newKeyMaterial.passwordWrappedKey);
    });

    it("keeps recovery open to a vault stamped with a key this server lost", async () => {
      // The fail-closed answer belongs on the unlock path only. Recovery re-seals
      // the row from material that does not depend on the pepper at all, so
      // refusing it would strand the one vault with no way back.
      prisma.vaultSetting.findUnique.mockResolvedValue({
        ...setting,
        recoveryGrantedAt: new Date(),
        masterKeyHash: pepperedWith(
          "a-key-nobody-configured-anymore-0123",
          "old-hash",
        ),
        masterKeyHashPepper: "v0-2025-11",
      });

      await service.completeRecovery("user-1", newKeyMaterial as any);

      const { data } = prisma.vaultSetting.updateMany.mock.calls.at(-1)[0];
      expect(data.masterKeyHashPepper).toBe(PEPPER_ID);
    });

    it("hands the envelope back for a vault sealed under the retired key", async () => {
      // The OTP path compares nothing against the pepper, so a rotation in flight
      // cannot break the way out of a lost master password.
      Object.assign(config, rotating);
      prisma.vaultSetting.findUnique.mockResolvedValue({
        ...setting,
        ...retiredRow(),
      });

      const material = await service.verifyRecoveryOtp("user-1", "246810");

      expect(material.wrappedMasterKey).toBe("wrapped");
      expect(material).not.toHaveProperty("masterKeyHash");
    });
  });

  /**
   * The row this service writes can cascade away with its account between the read
   * and the write. `P2025` is that, and left loose the filter reports it as a
   * generic `NOT_FOUND` body where every other path here says
   * `VAULT_NOT_CONFIGURED` — the same failure answering in a shape the client does
   * not branch on.
   */
  describe("a row that vanishes mid-request", () => {
    const gone = Object.assign(
      new Error("No static resource vaultSetting.findMany"),
      {
        code: "P2025",
      },
    );

    it("answers the missing vault on the failed-guess write", async () => {
      liveRow();
      prisma.vaultSetting.update.mockRejectedValue(gone);

      const err = await service
        .unlockVault("user-1", { masterKeyHash: "wrong" } as any)
        .catch((reason) => reason);

      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.getStatus()).toBe(404);
      expect(responseBody(err).code).toBe("VAULT_NOT_CONFIGURED");
    });

    it("answers the missing vault on the verified clear", async () => {
      liveRow({ unlockFailedAttempts: 2 });
      prisma.vaultSetting.update.mockRejectedValue(gone);

      const err = await service
        .unlockVault("user-1", { masterKeyHash: "old-hash" } as any)
        .catch((reason) => reason);

      expect(err).toBeInstanceOf(NotFoundException);
      expect(responseBody(err).code).toBe("VAULT_NOT_CONFIGURED");
    });

    it("answers no recovery material on a lost grant write", async () => {
      prisma.vaultSetting.update.mockRejectedValue(gone);

      const err = await service
        .verifyRecoveryOtp("user-1", "246810")
        .catch((reason) => reason);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(responseBody(err).code).toBe("VAULT_RECOVERY_UNAVAILABLE");
    });

    it("keeps every other database error on its way to the filter", async () => {
      // A mapping this eager would swallow a real outage as "no vault here".
      const other = Object.assign(new Error("duplicate key"), {
        code: "P2002",
      });
      liveRow();
      prisma.vaultSetting.update.mockRejectedValue(other);

      await expect(
        service.unlockVault("user-1", { masterKeyHash: "wrong" } as any),
      ).rejects.toBe(other);
    });
  });
});
