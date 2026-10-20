import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import {
  RecurringService,
  calculateNextOccurrence,
  recurringTransactionId,
} from "./recurring.service";
import { CreateRecurringDto } from "./dto/create-recurring.dto";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import { validate } from "class-validator";
import {
  ChangeOperation,
  FinanceAccountType,
  FinanceRecurringFrequency,
  FinanceTransactionType,
} from "@prisma/client";

const USER = "user-a";
const OTHER_USER = "user-b";
const OWN_ACCOUNT = "acc-owned-by-a";
const OWN_ACCOUNT_2 = "acc-owned-by-a-2";
const FOREIGN_ACCOUNT = "acc-owned-by-b";
const OWN_CATEGORY = "cat-owned-by-a";
const GLOBAL_CATEGORY = "cat-system-global";
const FOREIGN_CATEGORY = "cat-owned-by-b";
const RULE_ID = "rule-1";

/**
 * `find*` here behaves like a real filtered query: a document is only handed
 * back when the `where` the service wrote actually matches its owner. That is
 * what turns a missing `userId` filter into a visible cross-user write instead
 * of a mock that happily returns anything.
 */
describe("Recurring rule ownership and scheduling", () => {
  let accounts: Record<string, any>;
  let categories: Record<string, any>;
  let rulesById: Record<string, any>;
  let dueRules: any[];
  let generated: any[];
  let changes: any[];
  let concurrentIncomeDeltaMinor: bigint | null;
  let prisma: any;
  let notifier: { notifyMutation: jest.Mock };
  let service: RecurringService;

  function seedAccount(overrides: Record<string, any> = {}) {
    const account = {
      id: OWN_ACCOUNT,
      userId: USER,
      name: "A Bank",
      type: FinanceAccountType.BANK,
      currency: "INR",
      openingBalanceMinor: BigInt(100000),
      currentBalanceMinor: BigInt(100000),
      isArchived: false,
      deletedAt: null,
      version: 3,
      createdAt: new Date("2026-01-05T00:00:00.000Z"),
      updatedAt: new Date("2026-01-05T00:00:00.000Z"),
      ...overrides,
    };
    accounts[account.id] = account;
    return account;
  }

  function seedRule(overrides: Record<string, any> = {}) {
    const rule = {
      id: RULE_ID,
      userId: USER,
      accountId: OWN_ACCOUNT,
      categoryId: null,
      type: FinanceTransactionType.EXPENSE,
      amountMinor: BigInt(64900),
      title: "Netflix",
      frequency: FinanceRecurringFrequency.MONTHLY,
      interval: 1,
      startDate: new Date("2026-01-31T00:00:00.000Z"),
      endDate: null,
      // Past the fake clock (2026-10-19) and inside the worker's catch-up
      // window, so the default fixture reaches the generator at all: the cron
      // only owes bills that came due in the last few days, because anything
      // older is the phone's own backlog.
      nextDueDate: new Date("2026-10-18T00:00:00.000Z"),
      lastGeneratedAt: null,
      autoGenerate: true,
      deletedAt: null,
      version: 4,
      createdAt: new Date("2026-01-05T00:00:00.000Z"),
      updatedAt: new Date("2026-01-05T00:00:00.000Z"),
      ...overrides,
    };
    rulesById[rule.id] = rule;
    return rule;
  }

  function changesFor(entityType: string) {
    return changes.filter((entry) => entry.data.entityType === entityType);
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-19T09:00:00.000Z"));

    accounts = {};
    categories = {};
    rulesById = {};
    dueRules = [];
    generated = [];
    changes = [];
    concurrentIncomeDeltaMinor = null;

    seedAccount();
    seedAccount({
      id: OWN_ACCOUNT_2,
      name: "A Wallet",
      currentBalanceMinor: BigInt(20000),
      openingBalanceMinor: BigInt(20000),
    });
    // User B's money, reachable only by an unscoped lookup.
    seedAccount({
      id: FOREIGN_ACCOUNT,
      userId: OTHER_USER,
      name: "B Vault",
      currency: "USD",
      openingBalanceMinor: BigInt(99900000),
      currentBalanceMinor: BigInt(99900000),
      version: 7,
    });

    categories[OWN_CATEGORY] = {
      id: OWN_CATEGORY,
      userId: USER,
      name: "Rent",
      type: FinanceTransactionType.EXPENSE,
      isSystem: false,
      deletedAt: null,
      version: 1,
    };
    categories[GLOBAL_CATEGORY] = {
      id: GLOBAL_CATEGORY,
      userId: null,
      name: "Salary",
      type: FinanceTransactionType.INCOME,
      isSystem: true,
      deletedAt: null,
      version: 1,
    };
    categories[FOREIGN_CATEGORY] = {
      id: FOREIGN_CATEGORY,
      userId: OTHER_USER,
      name: "B Gym",
      type: FinanceTransactionType.EXPENSE,
      isSystem: false,
      deletedAt: null,
      version: 1,
    };

    const findAccount = jest
      .fn()
      .mockImplementation(({ where }: { where: any }) => {
        const row = accounts[where.id];
        if (!row) return Promise.resolve(null);
        if (where.userId !== undefined && row.userId !== where.userId) {
          return Promise.resolve(null);
        }
        if (
          where.deletedAt !== undefined &&
          row.deletedAt !== where.deletedAt
        ) {
          return Promise.resolve(null);
        }

        const snapshot = { ...row };
        if (concurrentIncomeDeltaMinor !== null) {
          // A concurrent `createTransaction` commits between this read and the
          // balance write that follows it: the snapshot is already stale.
          row.currentBalanceMinor += concurrentIncomeDeltaMinor;
          row.version += 1;
          concurrentIncomeDeltaMinor = null;
        }
        return Promise.resolve(snapshot);
      });

    const updateAccount = jest
      .fn()
      .mockImplementation(({ where, data }: { where: any; data: any }) => {
        const row = accounts[where.id];
        const written = data.currentBalanceMinor;
        row.currentBalanceMinor =
          written !== null && typeof written === "object"
            ? row.currentBalanceMinor + (written.increment ?? BigInt(0))
            : BigInt(written);
        if (data.version?.increment) row.version += data.version.increment;
        return Promise.resolve({ ...row });
      });

    const findCategory = jest
      .fn()
      .mockImplementation(({ where }: { where: any }) => {
        const row = categories[where.id];
        if (!row) return Promise.resolve(null);
        if (
          where.deletedAt !== undefined &&
          row.deletedAt !== where.deletedAt
        ) {
          return Promise.resolve(null);
        }
        const clauses: any[] = where.OR ?? [
          { userId: where.userId },
          { userId: null },
        ];
        const ownerMatches = clauses.some((c) => c.userId === row.userId);
        return Promise.resolve(ownerMatches ? { ...row } : null);
      });

    const clientMock: any = {
      financeAccount: {
        findFirst: findAccount,
        update: updateAccount,
      },
      financeCategory: { findFirst: findCategory },
      financeTransaction: {
        create: jest.fn().mockImplementation(({ data }: { data: any }) => {
          const row = {
            id: "tx-1",
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            ...data,
          };
          generated.push(row);
          return Promise.resolve({ ...row });
        }),
        // The generator's idempotency read, over the rows it has already
        // written: `recurringRuleId` plus the occurrence's UTC day, which is
        // what recognises a bill the phone minted and pushed as well as one
        // this server minted on an earlier tick.
        findMany: jest.fn().mockImplementation(({ where }: { where: any }) => {
          const rows = generated.filter((row) => {
            if (
              where.recurringRuleId !== undefined &&
              row.recurringRuleId !== where.recurringRuleId
            ) {
              return false;
            }
            if (
              where.deletedAt !== undefined &&
              (row.deletedAt ?? null) !== where.deletedAt
            ) {
              return false;
            }
            if (Array.isArray(where.OR)) {
              return where.OR.some((clause: any) => {
                if (clause.id !== undefined) return clause.id === row.id;
                const range = clause.transactionDate;
                if (!range) return false;
                const time = row.transactionDate.getTime();
                if (range.gte && time < range.gte.getTime()) return false;
                if (range.lt && time >= range.lt.getTime()) return false;
                return true;
              });
            }
            return true;
          });
          return Promise.resolve(
            typeof where.take === "number" ? rows.slice(0, where.take) : rows,
          );
        }),
      },
      financeRecurringRule: {
        create: jest.fn().mockImplementation(({ data }: { data: any }) => {
          const rule = {
            id: RULE_ID,
            version: 1,
            autoGenerate: true,
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          };
          rulesById[rule.id] = rule;
          return Promise.resolve({ ...rule });
        }),
        findFirst: jest.fn().mockImplementation(({ where }: { where: any }) => {
          const row = rulesById[where.id];
          if (!row) return Promise.resolve(null);
          if (where.userId !== undefined && row.userId !== where.userId) {
            return Promise.resolve(null);
          }
          return Promise.resolve({ ...row });
        }),
        findMany: jest.fn().mockImplementation(({ where }: { where: any }) =>
          Promise.resolve(
            dueRules
              .filter(
                (rule) =>
                  (where.userId === undefined ||
                    rule.userId === where.userId) &&
                  // The due query filters here instead of handing back
                  // whatever the test parked in `dueRules`: the generator now
                  // walks a rule through several occurrences per call and
                  // stops at `now`, so a fixture with a future `nextDueDate`
                  // has to be invisible rather than silently minted.
                  (where.nextDueDate?.lte === undefined ||
                    rule.nextDueDate.getTime() <=
                      where.nextDueDate.lte.getTime()) &&
                  (where.autoGenerate === undefined ||
                    rule.autoGenerate === where.autoGenerate) &&
                  (where.deletedAt === undefined ||
                    (rule.deletedAt ?? null) === where.deletedAt),
              )
              .map((rule) => ({ ...rule })),
          ),
        ),
        update: jest.fn().mockImplementation(({ where, data }: any) => {
          const row = rulesById[where.id];
          for (const [key, value] of Object.entries(data)) {
            if (key === "version") continue;
            row[key] = value;
          }
          if (data.version?.increment) row.version += data.version.increment;
          return Promise.resolve({ ...row });
        }),
      },
      change: {
        create: jest.fn().mockImplementation(({ data }: any) => {
          const row = { id: `change-${changes.length + 1}`, data };
          changes.push(row);
          return Promise.resolve(row);
        }),
      },
      syncCursor: {
        upsert: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve({ seq: BigInt(changes.length) }),
          ),
        findUnique: jest.fn().mockResolvedValue({ seq: BigInt(0) }),
      },
    };

    prisma = {
      ...clientMock,
      $transaction: jest.fn().mockImplementation((fn: any) => fn(clientMock)),
    };

    notifier = { notifyMutation: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecurringService,
        { provide: PrismaService, useValue: prisma },
        { provide: SyncNotificationService, useValue: notifier },
      ],
    }).compile();

    service = module.get<RecurringService>(RecurringService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("updateRecurringRule account ownership", () => {
    it("rejects re-pointing a rule at another user's account", async () => {
      seedRule();

      await expect(
        service.updateRecurringRule(USER, RULE_ID, {
          accountId: FOREIGN_ACCOUNT,
        }),
      ).rejects.toThrow(NotFoundException);

      // The guard has to filter by owner, not just by id.
      expect(prisma.financeAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: FOREIGN_ACCOUNT,
            userId: USER,
            deletedAt: null,
          }),
        }),
      );

      // Nothing was written: no rule update, no balance move, no Change.
      expect(prisma.financeRecurringRule.update).not.toHaveBeenCalled();
      expect(prisma.financeAccount.update).not.toHaveBeenCalled();
      expect(changes).toHaveLength(0);
      expect(rulesById[RULE_ID].accountId).toBe(OWN_ACCOUNT);
    });

    it("never queries an account without scoping it to the caller", async () => {
      seedRule();

      await service
        .updateRecurringRule(USER, RULE_ID, { accountId: FOREIGN_ACCOUNT })
        .catch(() => undefined);
      await service
        .updateRecurringRule(USER, RULE_ID, { categoryId: FOREIGN_CATEGORY })
        .catch(() => undefined);

      const unscoped = prisma.financeAccount.findFirst.mock.calls.filter(
        ([args]: any[]) => args.where.userId !== USER,
      );
      expect(unscoped).toEqual([]);
    });

    it("still allows moving a rule onto another account the caller owns", async () => {
      seedRule();

      const updated = await service.updateRecurringRule(USER, RULE_ID, {
        accountId: OWN_ACCOUNT_2,
      });

      expect(updated.accountId).toBe(OWN_ACCOUNT_2);
      expect(prisma.financeAccount.update).not.toHaveBeenCalled();
      expect(changesFor("finance_recurring_rule")).toHaveLength(1);
    });

    it("rejects a category owned by another user but accepts a global system one", async () => {
      seedRule();

      await expect(
        service.updateRecurringRule(USER, RULE_ID, {
          categoryId: FOREIGN_CATEGORY,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.financeRecurringRule.update).not.toHaveBeenCalled();

      const global = await service.updateRecurringRule(USER, RULE_ID, {
        categoryId: GLOBAL_CATEGORY,
      });
      expect(global.categoryId).toBe(GLOBAL_CATEGORY);

      const own = await service.updateRecurringRule(USER, RULE_ID, {
        categoryId: OWN_CATEGORY,
      });
      expect(own.categoryId).toBe(OWN_CATEGORY);
    });

    it("validates a foreign accountId on create the same way", async () => {
      await expect(
        service.createRecurringRule(USER, {
          accountId: FOREIGN_ACCOUNT,
          type: FinanceTransactionType.EXPENSE,
          amountMinor: 64900,
          title: "Netflix",
          startDate: "2026-10-31T00:00:00.000Z",
        }),
      ).rejects.toThrow();
      expect(prisma.financeRecurringRule.create).not.toHaveBeenCalled();
    });

    it("rejects impossible calendar dates like February 30 on create and update", async () => {
      await expect(
        service.createRecurringRule(USER, {
          accountId: OWN_ACCOUNT,
          type: FinanceTransactionType.EXPENSE,
          amountMinor: 64900,
          title: "Netflix",
          startDate: "2026-02-30T00:00:00.000Z",
        }),
      ).rejects.toThrow(
        "startDate '2026-02-30T00:00:00.000Z' is not a valid calendar date",
      );

      seedRule();
      await expect(
        service.updateRecurringRule(USER, RULE_ID, {
          startDate: "2026-02-30T00:00:00.000Z",
        }),
      ).rejects.toThrow(
        "startDate '2026-02-30T00:00:00.000Z' is not a valid calendar date",
      );
    });

    it("rejects endDate earlier than startDate", async () => {
      await expect(
        service.createRecurringRule(USER, {
          accountId: OWN_ACCOUNT,
          type: FinanceTransactionType.EXPENSE,
          amountMinor: 64900,
          title: "Netflix",
          startDate: "2026-05-15T00:00:00.000Z",
          endDate: "2026-05-10T00:00:00.000Z",
        }),
      ).rejects.toThrow("endDate must be on or after startDate");
    });
  });

  describe("processAllDueRules account scoping", () => {
    it("mints nothing when the rule points at another user's account", async () => {
      seedRule({ accountId: FOREIGN_ACCOUNT });
      dueRules = [rulesById[RULE_ID]];

      const result = await service.processAllDueRules();

      expect(result).toEqual({ processed: 0 });
      expect(prisma.financeTransaction.create).not.toHaveBeenCalled();
      expect(prisma.financeAccount.update).not.toHaveBeenCalled();
      expect(accounts[FOREIGN_ACCOUNT].currentBalanceMinor).toBe(
        BigInt(99900000),
      );

      // B's account row must never be projected into A's pull stream.
      expect(changesFor("finance_account")).toHaveLength(0);
      expect(
        JSON.stringify(changes, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ).not.toContain("B Vault");

      // And the dead rule stops being re-fetched on every tick.
      expect(prisma.financeRecurringRule.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: RULE_ID },
          data: expect.objectContaining({ autoGenerate: false }),
        }),
      );
    });

    it("loads the account scoped to the rule's own user", async () => {
      seedRule();
      dueRules = [rulesById[RULE_ID]];

      await service.processAllDueRules();

      expect(prisma.financeAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: OWN_ACCOUNT,
            userId: USER,
            deletedAt: null,
          }),
        }),
      );
    });

    it("writes only the caller's own account data into the Change payload", async () => {
      seedRule();
      dueRules = [rulesById[RULE_ID]];

      const result = await service.processAllDueRules();

      expect(result).toEqual({ processed: 1 });
      const accountChange = changesFor("finance_account")[0];
      expect(accountChange.data.userId).toBe(USER);
      expect(accountChange.data.payload.name).toBe("A Bank");
      expect(accountChange.data.payload.currentBalanceMinor).toBe(35100);
      expect(accountChange.data.version).toBe(accounts[OWN_ACCOUNT].version);
    });

    it("drops a foreign category from the generated transaction", async () => {
      seedRule({ categoryId: FOREIGN_CATEGORY });
      dueRules = [rulesById[RULE_ID]];

      await service.processAllDueRules();

      expect(prisma.financeTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ categoryId: null }),
        }),
      );
    });

    it("keeps the caller's own and global system categories", async () => {
      for (const categoryId of [OWN_CATEGORY, GLOBAL_CATEGORY]) {
        seedRule({ categoryId, id: `rule-${categoryId}` });
        dueRules = [rulesById[`rule-${categoryId}`]];
        prisma.financeTransaction.create.mockClear();

        await service.processAllDueRules();

        expect(prisma.financeTransaction.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ categoryId }),
          }),
        );
      }
    });
  });

  describe("processAllDueRules balance write", () => {
    it("adjusts with an atomic increment instead of a stale absolute read", async () => {
      seedRule();
      dueRules = [rulesById[RULE_ID]];
      concurrentIncomeDeltaMinor = BigInt(5000);

      await service.processAllDueRules();

      expect(prisma.financeAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: OWN_ACCOUNT },
          data: expect.objectContaining({
            currentBalanceMinor: { increment: BigInt(-64900) },
            version: { increment: 1 },
          }),
        }),
      );

      // 100000 + the concurrent 5000 income - the 64900 bill: an absolute write
      // computed from the pre-race read would drop the income and land on 35100.
      expect(accounts[OWN_ACCOUNT].currentBalanceMinor).toBe(BigInt(40100));
      const accountChange = changesFor("finance_account")[0];
      expect(accountChange.data.payload.currentBalanceMinor).toBe(40100);
      expect(accountChange.data.version).toBe(5);
    });

    it("increments the balance for an INCOME rule", async () => {
      seedRule({
        type: FinanceTransactionType.INCOME,
        amountMinor: BigInt(5000),
      });
      dueRules = [rulesById[RULE_ID]];

      await service.processAllDueRules();

      expect(prisma.financeAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            currentBalanceMinor: { increment: BigInt(5000) },
          }),
        }),
      );
      expect(accounts[OWN_ACCOUNT].currentBalanceMinor).toBe(BigInt(105000));
    });
  });

  describe("calculateNextOccurrence", () => {
    const iso = (date: Date) => date.toISOString();
    const utc = (value: string) => new Date(value);

    it("clamps a Jan-31 monthly rule to Feb 28 and back to Mar 31", () => {
      const startDate = utc("2026-01-31T00:00:00.000Z");

      const feb = calculateNextOccurrence(
        startDate,
        FinanceRecurringFrequency.MONTHLY,
        1,
        startDate,
      );
      expect(iso(feb)).toBe("2026-02-28T00:00:00.000Z");

      const mar = calculateNextOccurrence(
        feb,
        FinanceRecurringFrequency.MONTHLY,
        1,
        startDate,
      );
      expect(iso(mar)).toBe("2026-03-31T00:00:00.000Z");

      const apr = calculateNextOccurrence(
        mar,
        FinanceRecurringFrequency.MONTHLY,
        1,
        startDate,
      );
      expect(iso(apr)).toBe("2026-04-30T00:00:00.000Z");
    });

    it("keeps a Feb-29 yearly rule on Feb 28 in non-leap years", () => {
      const startDate = utc("2028-02-29T00:00:00.000Z");

      const next = calculateNextOccurrence(
        startDate,
        FinanceRecurringFrequency.YEARLY,
        1,
        startDate,
      );
      expect(iso(next)).toBe("2029-02-28T00:00:00.000Z");

      const leapAgain = calculateNextOccurrence(
        next,
        FinanceRecurringFrequency.YEARLY,
        1,
        startDate,
      );
      expect(iso(leapAgain)).toBe("2030-02-28T00:00:00.000Z");
    });

    it("clamps quarterly the same way", () => {
      const startDate = utc("2026-11-30T00:00:00.000Z");

      const next = calculateNextOccurrence(
        startDate,
        FinanceRecurringFrequency.QUARTERLY,
        1,
        startDate,
      );
      expect(iso(next)).toBe("2027-02-28T00:00:00.000Z");
    });

    it("steps day-based frequencies in UTC across month boundaries", () => {
      const from = utc("2026-01-30T23:30:00.000Z");

      expect(
        iso(calculateNextOccurrence(from, FinanceRecurringFrequency.DAILY, 1)),
      ).toBe("2026-01-31T23:30:00.000Z");
      expect(
        iso(calculateNextOccurrence(from, FinanceRecurringFrequency.DAILY, 2)),
      ).toBe("2026-02-01T23:30:00.000Z");
      expect(
        iso(calculateNextOccurrence(from, FinanceRecurringFrequency.WEEKLY, 1)),
      ).toBe("2026-02-06T23:30:00.000Z");
      expect(
        iso(
          calculateNextOccurrence(from, FinanceRecurringFrequency.BIWEEKLY, 1),
        ),
      ).toBe("2026-02-13T23:30:00.000Z");
    });

    it("carries the anchor day through every occurrence of a catch-up run", async () => {
      // Nine months behind the fake clock, so one call walks the whole backlog.
      // The anchor is the point: a Jan-31 rule that was clamped to Feb 28 has to
      // be back on the 31st in March, and a run that decays the day would land
      // the last bill of the walk on the 28th instead of the 31st.
      seedRule({
        startDate: utc("2026-01-31T00:00:00.000Z"),
        nextDueDate: utc("2026-01-31T00:00:00.000Z"),
      });
      dueRules = [rulesById[RULE_ID]];

      // The cron would not touch a backlog this old; the explicit per-user call
      // owns it (see the catch-up window in `recurring.generation.spec.ts`).
      const result = await service.processDueRulesForUser(USER);

      expect(result).toEqual({ processed: 9 });
      expect(generated.map((row) => iso(row.transactionDate))).toEqual([
        "2026-01-31T00:00:00.000Z",
        "2026-02-28T00:00:00.000Z",
        "2026-03-31T00:00:00.000Z",
        "2026-04-30T00:00:00.000Z",
        "2026-05-31T00:00:00.000Z",
        "2026-06-30T00:00:00.000Z",
        "2026-07-31T00:00:00.000Z",
        "2026-08-31T00:00:00.000Z",
        "2026-09-30T00:00:00.000Z",
      ]);
      expect(iso(rulesById[RULE_ID].nextDueDate)).toBe(
        "2026-10-31T00:00:00.000Z",
      );
    });
  });

  describe("processAllDueRules end-of-schedule handling", () => {
    it("mints a late occurrence that still falls on or before endDate", async () => {
      // First picked up on 2026-11-02: the 10-31 bill is late but inside both
      // the schedule and the cron's catch-up window, so it is generated and the
      // rule moves on to 11-30.
      jest.setSystemTime(new Date("2026-11-02T12:00:00.000Z"));
      seedRule({
        nextDueDate: new Date("2026-10-31T00:00:00.000Z"),
        endDate: new Date("2026-11-02T00:00:00.000Z"),
      });
      dueRules = [rulesById[RULE_ID]];

      const result = await service.processAllDueRules();

      expect(result).toEqual({ processed: 1 });
      expect(prisma.financeTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transactionDate: new Date("2026-10-31T00:00:00.000Z"),
          }),
        }),
      );
      expect(rulesById[RULE_ID].nextDueDate.toISOString()).toBe(
        "2026-11-30T00:00:00.000Z",
      );
    });

    it("never mints an occurrence that falls after endDate", async () => {
      // The occurrence and `now` are both past endDate here, which is the case
      // the old `endDate < now` comparison got wrong in the other direction: it
      // retired a rule that still owed a bill inside its schedule. The gate is
      // on the occurrence, so this one mints nothing.
      jest.setSystemTime(new Date("2026-12-21T12:00:00.000Z"));
      seedRule({
        nextDueDate: new Date("2026-12-20T00:00:00.000Z"),
        endDate: new Date("2026-12-15T00:00:00.000Z"),
      });
      dueRules = [rulesById[RULE_ID]];

      const result = await service.processAllDueRules();

      expect(result).toEqual({ processed: 0 });
      expect(prisma.financeTransaction.create).not.toHaveBeenCalled();
      expect(prisma.financeAccount.update).not.toHaveBeenCalled();
    });

    it("settles an exhausted rule so it stops being due", async () => {
      seedRule({
        nextDueDate: new Date("2026-10-18T00:00:00.000Z"),
        endDate: new Date("2026-10-15T00:00:00.000Z"),
      });
      dueRules = [rulesById[RULE_ID]];

      const result = await service.processAllDueRules();

      expect(result).toEqual({ processed: 0 });
      expect(rulesById[RULE_ID].autoGenerate).toBe(false);
      expect(prisma.financeRecurringRule.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ autoGenerate: false }),
        }),
      );

      const ruleChanges = changesFor("finance_recurring_rule");
      const ruleChange = ruleChanges[ruleChanges.length - 1];
      expect(ruleChange?.data).toEqual(
        expect.objectContaining({
          entityType: "finance_recurring_rule",
          entityId: RULE_ID,
          operation: ChangeOperation.UPDATE,
          userId: USER,
        }),
      );
      expect(ruleChange?.data.payload.autoGenerate).toBe(false);
    });

    it("settles a rule whose account has been soft deleted", async () => {
      seedRule();
      accounts[OWN_ACCOUNT].deletedAt = new Date("2026-10-01T00:00:00.000Z");
      dueRules = [rulesById[RULE_ID]];

      const result = await service.processAllDueRules();

      expect(result).toEqual({ processed: 0 });
      expect(prisma.financeTransaction.create).not.toHaveBeenCalled();
      expect(rulesById[RULE_ID].autoGenerate).toBe(false);
    });
  });

  describe("idempotent catch-up under tenant scoping", () => {
    /**
     * The generator now recognises an occurrence it has already billed. That
     * read has to stay as scoped as the write it replaces: it is keyed on the
     * rule's own id, so a foreign transaction can neither be picked up as this
     * user's bill nor be moved by this user's rule.
     */
    it("keys the already-generated read on the rule, never on another tenant", async () => {
      seedRule();
      dueRules = [rulesById[RULE_ID]];

      await service.processDueRulesForUser(USER);

      const [read] = prisma.financeTransaction.findMany.mock.calls;
      expect(read[0].where.recurringRuleId).toBe(RULE_ID);
      // No `deletedAt: null`: a tombstone spends the occurrence too (see
      // `occurrenceAlreadyGenerated`).
      expect(read[0].where.deletedAt).toBeUndefined();
      expect(read[0].where.userId).toBeUndefined();
      expect(read[0].take).toBe(1);
      // Two halves of one question: has this exact occurrence been billed by a
      // server that already knows the id, and has this UTC day been billed at
      // all — which is the only way a row the phone minted itself is recognised.
      expect(read[0].where.OR).toEqual([
        {
          id: recurringTransactionId(
            RULE_ID,
            new Date("2026-10-18T00:00:00.000Z"),
          ),
        },
        {
          transactionDate: {
            gte: new Date("2026-10-18T00:00:00.000Z"),
            lt: new Date("2026-10-19T00:00:00.000Z"),
          },
        },
      ]);
    });

    it("replays a catch-up tick without minting a second bill for any occurrence", async () => {
      seedRule({
        frequency: FinanceRecurringFrequency.WEEKLY,
        startDate: new Date("2026-09-27T00:00:00.000Z"),
        nextDueDate: new Date("2026-09-27T00:00:00.000Z"),
      });
      dueRules = [rulesById[RULE_ID]];

      const first = await service.processDueRulesForUser(USER);
      const firstCount = generated.length;
      expect(first).toEqual({ processed: firstCount });
      const balance = accounts[OWN_ACCOUNT].currentBalanceMinor;
      expect(firstCount).toBeGreaterThan(1);

      // The worker restarts and its startup job runs the same rule again while
      // every occurrence is still inside the schedule.
      const replay = await service.processDueRulesForUser(USER);

      expect(replay).toEqual({ processed: 0 });
      expect(generated).toHaveLength(firstCount);
      expect(accounts[OWN_ACCOUNT].currentBalanceMinor).toBe(balance);
      // One bill per week, no repeats.
      const dates = generated.map((row) => row.transactionDate.toISOString());
      expect(new Set(dates).size).toBe(dates.length);
    });

    it("catches up only the caller's rules from the per-user entry point", async () => {
      seedRule();
      seedRule({
        id: "rule-of-b",
        userId: OTHER_USER,
        accountId: FOREIGN_ACCOUNT,
      });
      dueRules = [rulesById[RULE_ID], rulesById["rule-of-b"]];

      const result = await service.processDueRulesForUser(USER);

      expect(result).toEqual({ processed: 1 });
      expect(generated.every((row) => row.userId === USER)).toBe(true);
      expect(accounts[FOREIGN_ACCOUNT].currentBalanceMinor).toBe(
        BigInt(99900000),
      );
      // B's rule is only ever *read* through a filter that names its owner.
      const scopedReads =
        prisma.financeRecurringRule.findMany.mock.calls.filter(
          ([args]: any[]) => args.where.userId === undefined,
        );
      expect(scopedReads).toEqual([]);
    });
  });

  describe("CreateRecurringDto date and amount guards", () => {
    function dtoWith(overrides: Record<string, any>) {
      return Object.assign(new CreateRecurringDto(), {
        accountId: OWN_ACCOUNT,
        type: FinanceTransactionType.EXPENSE,
        amountMinor: 64900,
        title: "Netflix",
        frequency: FinanceRecurringFrequency.MONTHLY,
        interval: 1,
        startDate: "2026-10-31T00:00:00.000Z",
        ...overrides,
      });
    }

    it("accepts ISO-8601 start and end dates", async () => {
      const errors = await validate(
        dtoWith({ endDate: "2027-10-31T00:00:00.000Z" }),
      );
      expect(errors).toEqual([]);
    });

    it("rejects a startDate that is not a date instead of writing Invalid Date", async () => {
      const errors = await validate(dtoWith({ startDate: "31/10/2026" }));
      expect(errors.map((e) => e.property)).toContain("startDate");

      const bad = new Date("31/10/2026");
      expect(Number.isNaN(bad.getTime())).toBe(true);
    });

    it("rejects a non-ISO endDate", async () => {
      const errors = await validate(dtoWith({ endDate: "next month" }));
      expect(errors.map((e) => e.property)).toContain("endDate");
    });

    it("rejects non-positive or unsafe amounts and intervals", async () => {
      expect(
        (await validate(dtoWith({ amountMinor: 0 }))).map((e) => e.property),
      ).toContain("amountMinor");
      expect(
        (await validate(dtoWith({ amountMinor: 1.5 }))).map((e) => e.property),
      ).toContain("amountMinor");
      expect(
        (
          await validate(dtoWith({ amountMinor: Number.MAX_SAFE_INTEGER + 10 }))
        ).map((e) => e.property),
      ).toContain("amountMinor");
      expect(
        (await validate(dtoWith({ interval: 0 }))).map((e) => e.property),
      ).toContain("interval");
      expect(
        (await validate(dtoWith({ interval: -3 }))).map((e) => e.property),
      ).toContain("interval");
    });
  });
});
