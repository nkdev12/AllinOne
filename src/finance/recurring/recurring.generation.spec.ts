import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import {
  MAX_CATCH_UP_OCCURRENCES,
  RECURRING_CRON_CATCH_UP_WINDOW_DAYS,
  RecurringService,
  recurringTransactionId,
  utcDayOf,
} from "./recurring.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import {
  FinanceAccountType,
  FinanceRecurringFrequency,
  FinanceTransactionType,
  Prisma,
} from "@prisma/client";

const USER = "user-a";
const OTHER_USER = "user-b";
const RULE_ID = "rule-netflix";
const ACCOUNT_ID = "acc-a";
const OTHER_ACCOUNT = "acc-b";

/** A UTC calendar day, for fixtures that count days rather than instants. */
function day(year: number, monthIndex: number, date: number): Date {
  return new Date(Date.UTC(year, monthIndex, date));
}

/**
 * Generation runs against an in-memory stand-in for the `finance_transactions`
 * collection rather than against call-count spies, because the property being
 * tested *is* a collection property: one document per `_id`, and one live
 * document per `(recurringRuleId, occurrence)`. A mock that answers any write
 * happily would have reported the double mint as two successful, unrelated
 * inserts — which is exactly how the duplicate went unnoticed.
 */

/** Monday of the week the fixture rule came due on. */
const OCCURRENCE = new Date("2026-10-19T00:00:00.000Z");
const NOW = new Date("2026-10-20T09:00:00.000Z");

type Write = string;

interface Unit {
  writes: Write[];
}

interface Harness {
  service: RecurringService;
  units: Unit[];
  store: {
    accounts: Record<string, any>;
    rules: Record<string, any>;
    transactions: Record<string, any>;
    changes: any[];
  };
  notifier: { notifyMutation: jest.Mock };
  prisma: any;
  failNextCreateWith: (error: unknown) => void;
}

function mongoDuplicateKey(id: string): Error {
  return Object.assign(
    new Error(
      `E11000 duplicate key error collection: allinone.finance_transactions index: _id_ dup key: { _id: "${id}" }`,
    ),
    { code: "E11000" },
  );
}

function prismaUniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`_id`)",
    { code: "P2002", clientVersion: "5.22.0" },
  );
}

function rangeMatches(value: Date, clause: any): boolean {
  const time = value.getTime();
  if (clause.gte && time < clause.gte.getTime()) return false;
  if (clause.gt && time <= clause.gt.getTime()) return false;
  if (clause.lte && time > clause.lte.getTime()) return false;
  if (clause.lt && time >= clause.lt.getTime()) return false;
  return true;
}

async function buildHarness(): Promise<Harness> {
  const store = {
    accounts: {} as Record<string, any>,
    rules: {} as Record<string, any>,
    transactions: {} as Record<string, any>,
    categories: {} as Record<string, any>,
    changes: [] as any[],
    cursors: {} as Record<string, bigint>,
  };

  const units: Unit[] = [];
  let injectedCreateError: unknown = null;

  const makeClient = (record: (write: Write) => void) => ({
    financeAccount: {
      findFirst: async ({ where }: any) => {
        const row = store.accounts[where.id];
        if (!row) return null;
        if (where.userId !== undefined && row.userId !== where.userId) {
          return null;
        }
        if (
          where.deletedAt !== undefined &&
          (row.deletedAt ?? null) !== where.deletedAt
        ) {
          return null;
        }
        return { ...row };
      },
      update: async ({ where, data }: any) => {
        const row = store.accounts[where.id];
        const written = data.currentBalanceMinor;
        row.currentBalanceMinor =
          written !== null && typeof written === "object"
            ? row.currentBalanceMinor + (written.increment ?? BigInt(0))
            : BigInt(written);
        if (data.version?.increment) row.version += data.version.increment;
        record(`finance_account:update:${row.id}`);
        return { ...row };
      },
    },
    financeCategory: {
      findFirst: async ({ where }: any) => {
        const row = store.categories?.[where.id];
        return row ? { ...row } : null;
      },
    },
    financeTransaction: {
      create: async ({ data }: any) => {
        const id =
          data.id ??
          `server-uuid-${Object.keys(store.transactions).length + 1}`;
        if (store.transactions[id]) throw mongoDuplicateKey(id);
        if (injectedCreateError) {
          const error = injectedCreateError;
          injectedCreateError = null;
          throw error;
        }
        const row = {
          toAccountId: null,
          categoryId: null,
          notes: null,
          tags: [],
          receiptAttachmentId: null,
          recurringRuleId: null,
          sharedExpenseId: null,
          isExcludedFromBudget: false,
          deletedAt: null,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
          id,
        };
        row.deletedAt = row.deletedAt ?? null;
        store.transactions[id] = row;
        record(`finance_transaction:create:${id}`);
        return { ...row };
      },
      findMany: async ({ where, take }: any) => {
        let rows = Object.values(store.transactions) as any[];
        if (where?.recurringRuleId !== undefined) {
          rows = rows.filter(
            (r) => r.recurringRuleId === where.recurringRuleId,
          );
        }
        if (where?.deletedAt !== undefined) {
          rows = rows.filter((r) => (r.deletedAt ?? null) === where.deletedAt);
        }
        if (Array.isArray(where?.OR)) {
          rows = rows.filter((row) =>
            where.OR.some((clause: any) => {
              if (clause.id !== undefined) return clause.id === row.id;
              if (clause.transactionDate) {
                return rangeMatches(
                  row.transactionDate,
                  clause.transactionDate,
                );
              }
              return false;
            }),
          );
        }
        return typeof take === "number" ? rows.slice(0, take) : rows;
      },
      findFirst: async (args: any) => {
        const rows = await makeClient(
          () => undefined,
        ).financeTransaction.findMany(args);
        return rows[0] ?? null;
      },
    },
    financeRecurringRule: {
      findMany: async ({ where }: any) => {
        const clauses = Array.isArray(where?.AND) ? where.AND : [where ?? {}];
        const flat: Record<string, any> = {};
        for (const clause of clauses) Object.assign(flat, clause ?? {});

        return Object.values(store.rules)
          .filter((rule: any) => {
            if (
              flat.userId !== undefined &&
              rule.userId !== flat.userId &&
              where?.userId !== undefined
            ) {
              return false;
            }
            if (where?.userId !== undefined && rule.userId !== where.userId) {
              return false;
            }
            if (
              where?.autoGenerate !== undefined &&
              rule.autoGenerate !== where.autoGenerate
            ) {
              return false;
            }
            if (
              where?.deletedAt !== undefined &&
              (rule.deletedAt ?? null) !== where.deletedAt
            ) {
              return false;
            }
            if (where?.nextDueDate?.lte) {
              if (
                rule.nextDueDate.getTime() > where.nextDueDate.lte.getTime()
              ) {
                return false;
              }
            }
            return true;
          })
          .map((rule: any) => ({ ...rule }));
      },
      findFirst: async ({ where }: any) => {
        const row = store.rules[where?.id];
        if (!row) return null;
        if (where.userId !== undefined && row.userId !== where.userId) {
          return null;
        }
        return { ...row };
      },
      update: async ({ where, data }: any) => {
        const row = store.rules[where.id];
        for (const [key, value] of Object.entries(data)) {
          if (key === "version") continue;
          row[key] = value;
        }
        if (data.version?.increment) row.version += data.version.increment;
        record(`finance_recurring_rule:update:${row.id}`);
        return { ...row };
      },
    },
    change: {
      create: async ({ data }: any) => {
        const row = { id: `change-${store.changes.length + 1}`, ...data };
        store.changes.push(row);
        record(`change:create:${data.entityType}:${data.entityId}`);
        return row;
      },
    },
    syncCursor: {
      upsert: async ({ where, update, create }: any) => {
        const userId = where.userId;
        const current = store.cursors[userId] ?? BigInt(0);
        const next = current + (update?.seq?.increment ?? BigInt(1));
        store.cursors[userId] = next;
        if (create && current === BigInt(0)) {
          store.cursors[userId] = create.seq ?? next;
        }
        return { seq: store.cursors[userId] };
      },
      findUnique: async ({ where }: any) => ({
        seq: store.cursors[where.userId] ?? BigInt(0),
      }),
    },
  });

  const prisma: any = {
    ...makeClient(() => undefined),
    $transaction: jest.fn().mockImplementation(async (fn: any) => {
      const unit: Unit = { writes: [] };
      units.push(unit);
      const record = (write: Write) => unit.writes.push(write);
      return fn(makeClient(record));
    }),
  };

  const notifier = { notifyMutation: jest.fn() };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RecurringService,
      { provide: PrismaService, useValue: prisma },
      { provide: SyncNotificationService, useValue: notifier },
    ],
  }).compile();

  return {
    service: module.get<RecurringService>(RecurringService),
    units,
    store: store as any,
    notifier,
    prisma,
    failNextCreateWith: (error: unknown) => {
      injectedCreateError = error;
    },
  };
}

function seedAccount(harness: Harness, overrides: Record<string, any> = {}) {
  const account = {
    id: ACCOUNT_ID,
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
  harness.store.accounts[account.id] = account;
  return account;
}

function seedRule(harness: Harness, overrides: Record<string, any> = {}) {
  const rule = {
    id: RULE_ID,
    userId: USER,
    accountId: ACCOUNT_ID,
    categoryId: null,
    type: FinanceTransactionType.EXPENSE,
    amountMinor: BigInt(64900),
    title: "Netflix",
    frequency: FinanceRecurringFrequency.MONTHLY,
    interval: 1,
    startDate: new Date("2026-09-19T00:00:00.000Z"),
    endDate: null,
    nextDueDate: OCCURRENCE,
    lastGeneratedAt: null,
    autoGenerate: true,
    deletedAt: null,
    version: 4,
    createdAt: new Date("2026-01-05T00:00:00.000Z"),
    updatedAt: new Date("2026-01-05T00:00:00.000Z"),
    ...overrides,
  };
  harness.store.rules[rule.id] = rule;
  return rule;
}

function liveBills(harness: Harness, ruleId = RULE_ID) {
  return Object.values(harness.store.transactions).filter(
    (row: any) => row.recurringRuleId === ruleId && row.deletedAt === null,
  );
}

function highestStoredCursor(harness: Harness): bigint {
  return harness.store.changes.reduce(
    (top: bigint, change: any) => (change.cursor > top ? change.cursor : top),
    BigInt(0),
  );
}

function transactionChanges(harness: Harness) {
  return harness.store.changes.filter(
    (entry) => entry.entityType === "finance_transaction",
  );
}

describe("Recurring transaction generation", () => {
  let harness: Harness;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    harness = await buildHarness();
    seedAccount(harness);
    seedRule(harness);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("one bill per occurrence", () => {
    it("mints a single transaction when the REST route and the cron race on the same rule", async () => {
      // Both entry points select the rule before either writes: `POST
      // /finance/recurring/process-due` from the phone's retry, the Bull
      // `process-recurring` handler from the daily tick.
      const results = await Promise.all([
        harness.service.processDueRulesForUser(USER),
        harness.service.processAllDueRules(),
      ]);

      const bills = liveBills(harness);
      expect(bills).toHaveLength(1);
      expect(bills[0].transactionDate.toISOString()).toBe(
        OCCURRENCE.toISOString(),
      );

      // The duplicate was never only a visual problem: each mint debited the
      // account, so the user is charged twice for one Netflix bill.
      expect(harness.store.accounts[ACCOUNT_ID].currentBalanceMinor).toBe(
        BigInt(100000) - BigInt(64900),
      );
      expect(
        results.reduce((total, r) => total + r.processed, 0),
      ).toBeLessThanOrEqual(1);
    });

    it("mints a single transaction when the same occurrence is processed twice", async () => {
      await harness.service.processDueRulesForUser(USER);

      // The phone was the first generator: it minted its bill offline and its
      // rule push re-homed `nextDueDate` back onto the occurrence the server
      // has already billed for. Re-processing must not add a second row.
      harness.store.rules[RULE_ID].nextDueDate = OCCURRENCE;

      const result = await harness.service.processDueRulesForUser(USER);

      expect(liveBills(harness)).toHaveLength(1);
      expect(result).toEqual({ processed: 0 });
      expect(harness.store.accounts[ACCOUNT_ID].currentBalanceMinor).toBe(
        BigInt(100000) - BigInt(64900),
      );
    });

    it("does not mint a second bill for a transaction the phone generated and pushed", async () => {
      // A client-generated row carries the rule id but the phone's own local
      // UUID, so a deterministic server id cannot collide with it — the
      // occurrence itself has to be recognised.
      harness.store.transactions["phone-local-uuid-1"] = {
        id: "phone-local-uuid-1",
        userId: USER,
        accountId: ACCOUNT_ID,
        categoryId: null,
        type: FinanceTransactionType.EXPENSE,
        amountMinor: BigInt(64900),
        currency: "INR",
        title: "Netflix",
        tags: [],
        notes: null,
        toAccountId: null,
        receiptAttachmentId: null,
        recurringRuleId: RULE_ID,
        sharedExpenseId: null,
        isExcludedFromBudget: false,
        transactionDate: new Date("2026-10-19T05:30:00.000Z"),
        deletedAt: null,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };

      const result = await harness.service.processAllDueRules();

      expect(Object.keys(harness.store.transactions)).toHaveLength(1);
      expect(result).toEqual({ processed: 0 });
      expect(harness.store.accounts[ACCOUNT_ID].currentBalanceMinor).toBe(
        BigInt(100000),
      );
      // The schedule still moves on, so the rule does not sit due forever.
      expect(
        harness.store.rules[RULE_ID].nextDueDate.getTime(),
      ).toBeGreaterThan(OCCURRENCE.getTime());
    });
  });

  describe("duplicate-key handling", () => {
    it("treats a duplicate _id as already generated and still advances the schedule", async () => {
      harness.failNextCreateWith(mongoDuplicateKey("whatever"));

      const result = await harness.service.processAllDueRules();

      expect(result).toEqual({ processed: 0 });
      expect(liveBills(harness)).toHaveLength(0);
      expect(harness.store.accounts[ACCOUNT_ID].currentBalanceMinor).toBe(
        BigInt(100000),
      );
      expect(
        harness.store.rules[RULE_ID].nextDueDate.getTime(),
      ).toBeGreaterThan(OCCURRENCE.getTime());
    });

    it("treats Prisma's P2002 shape the same way", async () => {
      harness.failNextCreateWith(prismaUniqueViolation());

      const result = await harness.service.processAllDueRules();

      expect(result).toEqual({ processed: 0 });
      expect(
        harness.store.rules[RULE_ID].nextDueDate.getTime(),
      ).toBeGreaterThan(OCCURRENCE.getTime());
    });
  });

  describe("occurrence identity", () => {
    it("mints one bill for any time of day on the occurrence's UTC day", async () => {
      const first = await harness.service.processAllDueRules();
      expect(first).toEqual({ processed: 1 });

      const minted = liveBills(harness)[0] as any;
      // A second run whose pointer says the same due day at a different hour is
      // the same bill: the id is keyed on the UTC day, not the instant.
      harness.store.rules[RULE_ID].nextDueDate = new Date(
        "2026-10-19T23:59:00.000Z",
      );
      await harness.service.processAllDueRules();

      expect(liveBills(harness)).toHaveLength(1);
      expect(liveBills(harness)[0]).toBe(minted);
      expect(harness.store.accounts[ACCOUNT_ID].currentBalanceMinor).toBe(
        BigInt(100000) - BigInt(64900),
      );
    });

    it("derives the id from the rule and the occurrence, and nothing else", () => {
      const id = recurringTransactionId(RULE_ID, OCCURRENCE);

      // Stable: a replay of the same occurrence resolves to the same `_id`,
      // which is what makes Mongo's primary key the deduplicator.
      expect(id).toBe(recurringTransactionId(RULE_ID, OCCURRENCE));
      expect(id).toBe(
        recurringTransactionId(RULE_ID, new Date("2026-10-19T23:59:59.999Z")),
      );
      // And distinct where the bill is a different bill.
      expect(id).not.toBe(recurringTransactionId(RULE_ID, day(2026, 10, 20)));
      expect(id).not.toBe(recurringTransactionId("rule-hulu", OCCURRENCE));
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      const minted = harness.service.processAllDueRules().then(() => {
        expect(Object.keys(harness.store.transactions)[0]).toBe(id);
      });
      return minted;
    });

    it("keys the identity on the UTC day the loop already bills against", () => {
      // `transactionDate` keeps the instant the rule was due at; the id is the
      // UTC day of that instant. Two times of day on one due day are one bill.
      expect(utcDayOf(new Date("2026-10-19T05:30:00.000Z")).toISOString()).toBe(
        "2026-10-19T00:00:00.000Z",
      );
      expect(utcDayOf(new Date("2026-10-19T23:59:00.000Z")).toISOString()).toBe(
        OCCURRENCE.toISOString(),
      );
    });

    it("stamps lastGeneratedAt only when this run actually minted a bill", async () => {
      await harness.service.processAllDueRules();
      expect(harness.store.rules[RULE_ID].lastGeneratedAt).toEqual(NOW);
      const versionAfterMint = harness.store.rules[RULE_ID].version;

      // Replay the same occurrence: the schedule moves, the stamp does not.
      harness.store.rules[RULE_ID].nextDueDate = OCCURRENCE;
      harness.store.rules[RULE_ID].lastGeneratedAt = null;
      await harness.service.processAllDueRules();

      expect(harness.store.rules[RULE_ID].lastGeneratedAt).toBeNull();
      expect(harness.store.rules[RULE_ID].version).toBe(versionAfterMint + 1);
    });
  });

  describe("a bill the user deleted", () => {
    it("spends the occurrence instead of re-minting a tombstone", async () => {
      // Whoever wrote it, one occurrence gets one row: the server's own
      // deterministic id is refused by `_id` once written, and a client row the
      // user deleted still answers the `(recurringRuleId, UTC day)` read. So a
      // rewound schedule does not charge the user twice for a bill they removed;
      // the schedule simply moves on.
      await harness.service.processAllDueRules();
      const mintedId = Object.keys(harness.store.transactions)[0];
      harness.store.transactions[mintedId].deletedAt = new Date(
        "2026-10-20T08:00:00.000Z",
      );

      harness.store.rules[RULE_ID].nextDueDate = OCCURRENCE;
      const result = await harness.service.processAllDueRules();

      expect(result).toEqual({ processed: 0 });
      expect(Object.keys(harness.store.transactions)).toHaveLength(1);
      expect(harness.store.accounts[ACCOUNT_ID].currentBalanceMinor).toBe(
        BigInt(100000) - BigInt(64900),
      );
      expect(harness.store.rules[RULE_ID].nextDueDate).toEqual(
        new Date("2026-11-19T00:00:00.000Z"),
      );
    });

    it("spends the occurrence for a deleted row the phone pushed", async () => {
      harness.store.transactions["phone-local-uuid-1"] = {
        id: "phone-local-uuid-1",
        userId: USER,
        accountId: ACCOUNT_ID,
        categoryId: null,
        type: FinanceTransactionType.EXPENSE,
        amountMinor: BigInt(64900),
        currency: "INR",
        title: "Netflix",
        tags: [],
        notes: null,
        toAccountId: null,
        receiptAttachmentId: null,
        recurringRuleId: RULE_ID,
        sharedExpenseId: null,
        isExcludedFromBudget: false,
        transactionDate: new Date("2026-10-19T05:30:00.000Z"),
        deletedAt: new Date("2026-10-20T08:00:00.000Z"),
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };

      const result = await harness.service.processAllDueRules();

      expect(result).toEqual({ processed: 0 });
      expect(Object.keys(harness.store.transactions)).toHaveLength(1);
      expect(harness.store.rules[RULE_ID].nextDueDate).toEqual(
        new Date("2026-11-19T00:00:00.000Z"),
      );
    });
  });

  describe("catch-up bounds", () => {
    it("mints at most the clamp per call and finishes the backlog on the next", async () => {
      // Thirty monthly occurrences behind the fake clock: a rule whose owner has
      // not opened the app in two and a half years.
      seedRule(harness, {
        startDate: new Date("2024-05-19T00:00:00.000Z"),
        nextDueDate: new Date("2024-05-19T00:00:00.000Z"),
      });

      const first = await harness.service.processDueRulesForUser(USER);
      expect(first).toEqual({ processed: MAX_CATCH_UP_OCCURRENCES });
      expect(liveBills(harness)).toHaveLength(MAX_CATCH_UP_OCCURRENCES);
      // Stopped at the clamp, not fast-forwarded: the six bills still owed are
      // still in the schedule, so the next run finishes them instead of the
      // server silently dropping money.
      expect(harness.store.rules[RULE_ID].nextDueDate).toEqual(
        new Date("2026-05-19T00:00:00.000Z"),
      );

      const second = await harness.service.processDueRulesForUser(USER);
      expect(second).toEqual({ processed: 30 - MAX_CATCH_UP_OCCURRENCES });
      expect(liveBills(harness)).toHaveLength(30);
      expect(
        harness.store.rules[RULE_ID].nextDueDate.getTime(),
      ).toBeGreaterThan(NOW.getTime());

      // No runaway: the walk is 30 rows, one per occurrence, and the two calls
      // never repeated a day.
      const dates = liveBills(harness).map((row: any) =>
        utcDayOf(row.transactionDate).toISOString(),
      );
      expect(new Set(dates).size).toBe(30);
      // And the balance moved exactly 30 bills, not 30+ per tick.
      expect(harness.store.accounts[ACCOUNT_ID].currentBalanceMinor).toBe(
        BigInt(100000) - BigInt(64900) * BigInt(30),
      );
    });

    it("leaves a backlog older than the cron window to the per-user call", async () => {
      // Ten days behind: outside the window the worker will reach for.
      seedRule(harness, {
        frequency: FinanceRecurringFrequency.DAILY,
        startDate: new Date("2026-10-10T00:00:00.000Z"),
        nextDueDate: new Date("2026-10-10T00:00:00.000Z"),
      });

      const before = { ...harness.store.rules[RULE_ID] };
      const ticked = await harness.service.processAllDueRules();
      expect(ticked).toEqual({ processed: 0 });
      expect(liveBills(harness)).toHaveLength(0);
      // Untouched, not retired: the phone is the generator for this backlog and
      // an explicit call can still repair it.
      expect(harness.store.rules[RULE_ID].nextDueDate).toEqual(
        before.nextDueDate,
      );
      expect(harness.store.rules[RULE_ID].autoGenerate).toBe(true);

      // The ten stale days plus 2026-10-20 itself, which is already due at the
      // fake clock's 09:00.
      const repaired = await harness.service.processDueRulesForUser(USER);
      expect(repaired).toEqual({ processed: 11 });
      expect(liveBills(harness)).toHaveLength(11);
      expect(
        harness.store.rules[RULE_ID].nextDueDate.getTime(),
      ).toBeGreaterThan(NOW.getTime());
    });

    it("catches up the window edge and nothing before it", async () => {
      const insideWindow = day(
        NOW.getUTCFullYear(),
        NOW.getUTCMonth(),
        utcDayOf(NOW).getUTCDate() - RECURRING_CRON_CATCH_UP_WINDOW_DAYS,
      );
      seedRule(harness, {
        frequency: FinanceRecurringFrequency.DAILY,
        startDate: insideWindow,
        nextDueDate: insideWindow,
      });

      const result = await harness.service.processAllDueRules();
      // The edge day itself is owed; the day before it is not this tick's work.
      expect(result).toEqual({
        processed: RECURRING_CRON_CATCH_UP_WINDOW_DAYS + 1,
      });
      expect(liveBills(harness)).toHaveLength(
        RECURRING_CRON_CATCH_UP_WINDOW_DAYS + 1,
      );
    });

    it("refuses to walk a rule backwards when the clamp is reached", async () => {
      seedRule(harness, {
        frequency: FinanceRecurringFrequency.DAILY,
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        nextDueDate: new Date("2026-01-01T00:00:00.000Z"),
      });

      await harness.service.processDueRulesForUser(USER);
      const stoppedAt = harness.store.rules[RULE_ID].nextDueDate;
      expect(liveBills(harness)).toHaveLength(MAX_CATCH_UP_OCCURRENCES);

      await harness.service.processDueRulesForUser(USER);
      expect(
        harness.store.rules[RULE_ID].nextDueDate.getTime(),
      ).toBeGreaterThan(stoppedAt.getTime());
      expect(liveBills(harness)).toHaveLength(MAX_CATCH_UP_OCCURRENCES * 2);
    });
  });

  describe("sync pairing", () => {
    it("emits one transaction Change per minted bill, each in its own transaction", async () => {
      seedRule(harness, {
        frequency: FinanceRecurringFrequency.DAILY,
        startDate: new Date("2026-10-16T00:00:00.000Z"),
        nextDueDate: new Date("2026-10-16T00:00:00.000Z"),
      });

      await harness.service.processDueRulesForUser(USER);

      const minting = harness.units.filter((unit) =>
        unit.writes.some((write) =>
          write.startsWith("finance_transaction:create"),
        ),
      );
      // Five due days (16, 17, 18, 19, 20) -> five transactions, and a generated
      // row without its Change would be invisible to every other device.
      expect(minting).toHaveLength(5);
      for (const unit of minting) {
        expect(
          unit.writes.filter((write) =>
            write.startsWith("change:create:finance_transaction"),
          ),
        ).toHaveLength(1);
        expect(
          unit.writes.filter((write) =>
            write.startsWith("change:create:finance_account"),
          ),
        ).toHaveLength(1);
        expect(
          unit.writes.filter((write) =>
            write.startsWith("change:create:finance_recurring_rule"),
          ),
        ).toHaveLength(1);
      }

      expect(transactionChanges(harness)).toHaveLength(5);
      expect(harness.store.changes).toHaveLength(15);
      expect(harness.notifier.notifyMutation).toHaveBeenCalledTimes(1);
      expect(harness.notifier.notifyMutation).toHaveBeenCalledWith({
        userId: USER,
        highestCursor: highestStoredCursor(harness),
      });
    });

    it("wakes the user whose rule retired, and nobody else", async () => {
      harness.store.rules["rule-b"] = seedRule(harness, {
        id: "rule-b",
        userId: OTHER_USER,
        accountId: OTHER_ACCOUNT,
        nextDueDate: new Date("2026-10-19T00:00:00.000Z"),
      });
      harness.store.accounts[OTHER_ACCOUNT] = {
        ...harness.store.accounts[ACCOUNT_ID],
        id: OTHER_ACCOUNT,
        userId: OTHER_USER,
      };
      // User B is a day late on the cron window and past its own end date.
      harness.store.rules["rule-b"].endDate = new Date(
        "2026-10-18T00:00:00.000Z",
      );

      const result = await harness.service.processAllDueRules();

      // The one bill counted is the default rule's; user B's retired rule mints
      // nothing but still has to reach B's other devices.
      expect(result).toEqual({ processed: 1 });
      const notified = harness.notifier.notifyMutation.mock.calls.map(
        ([notice]) => notice.userId,
      );
      expect(notified).toEqual(expect.arrayContaining([USER, OTHER_USER]));
      expect(liveBills(harness, "rule-b")).toHaveLength(0);
      expect(harness.store.rules["rule-b"].autoGenerate).toBe(false);
    });
  });

  describe("end of schedule", () => {
    it("retires a rule whose next occurrence falls after endDate", async () => {
      seedRule(harness, {
        nextDueDate: new Date("2026-10-19T00:00:00.000Z"),
        endDate: new Date("2026-09-30T00:00:00.000Z"),
      });

      const result = await harness.service.processAllDueRules();

      expect(result).toEqual({ processed: 0 });
      expect(liveBills(harness)).toHaveLength(0);
      expect(harness.store.rules[RULE_ID].autoGenerate).toBe(false);
    });
  });
});
