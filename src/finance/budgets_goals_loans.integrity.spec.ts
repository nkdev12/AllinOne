import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import {
  FinanceBudgetPeriod,
  FinanceLoanType,
  FinanceTransactionType,
} from "@prisma/client";
import { createValidationPipe } from "@/common/errors/validation.pipe";
import { BudgetsService } from "./budgets/budgets.service";
import { BudgetListQueryDto } from "./budgets/dto/budget-list-query.dto";
import { CreateBudgetDto } from "./budgets/dto/create-budget.dto";
import { GoalsService } from "./goals/goals.service";
import { CreateGoalDto } from "./goals/dto/create-goal.dto";
import { LoansService } from "./loans/loans.service";
import { CreateLoanDto } from "./loans/dto/create-loan.dto";

const USER = "user-1";
const OTHER_USER = "user-2";
/** A Monday at 04:00 UTC: 09:30 in +05:30, where a local-month window drifts. */
const NOW = new Date("2026-10-05T04:00:00.000Z");
const BUDGET_ID = "bgt-1";
const GOAL_ID = "goal-1";
const LOAN_ID = "loan-1";
const RENT_CATEGORY = "cat-rent";

const queryPipe = createValidationPipe();
const queryContext = {
  type: "query" as const,
  metatype: BudgetListQueryDto,
};
const bodyContext = (metatype: any) => ({ type: "body" as const, metatype });

function utc(iso: string): Date {
  return new Date(iso);
}

function minorOps(
  doc: Record<string, any>,
  data: Record<string, any>,
): Record<string, any> {
  for (const [key, value] of Object.entries(data)) {
    const operator =
      value !== null && typeof value === "object" ? (value as any) : null;
    if (operator && "increment" in operator) {
      doc[key] =
        typeof doc[key] === "bigint"
          ? (doc[key] as bigint) + BigInt(operator.increment)
          : Number(doc[key]) + Number(operator.increment);
    } else if (operator && "decrement" in operator) {
      doc[key] =
        typeof doc[key] === "bigint"
          ? (doc[key] as bigint) - BigInt(operator.decrement)
          : Number(doc[key]) - Number(operator.decrement);
    } else {
      doc[key] = value;
    }
  }
  return doc;
}

/**
 * A store-backed Prisma double: `findMany` really applies the `where` the service
 * wrote (so a window that is too narrow shows up as missing spend), `update`
 * really resolves `$inc`/`$dec` operators against the stored document (so an
 * absolute read-modify-write shows up as a lost update), and a throw inside
 * `$transaction` really rolls the document back.
 */
describe("Budgets, goals and loans integrity", () => {
  let budgets: any[];
  let expenses: any[];
  let store: { goal: Record<string, any>; loan: Record<string, any> };
  let durable: {
    goal: Record<string, any> | null;
    loan: Record<string, any> | null;
  };
  let changes: any[];
  let pendingRace: (() => void) | null;
  let capturedExpenseWhere: any;
  let expenseFindMany: jest.Mock;
  let budgetFindMany: jest.Mock;
  let goalUpdate: jest.Mock;
  let loanUpdate: jest.Mock;
  let goalCreate: jest.Mock;
  let loanCreate: jest.Mock;
  let prisma: any;
  let notifier: { notifyMutation: jest.Mock };
  let budgetsService: BudgetsService;
  let goalsService: GoalsService;
  let loansService: LoansService;

  function seedBudget(overrides: Record<string, any> = {}) {
    const budget = {
      id: BUDGET_ID,
      userId: USER,
      categoryId: null,
      amountMinor: BigInt(1000000),
      period: FinanceBudgetPeriod.MONTHLY,
      startDate: null,
      endDate: null,
      alertAt80: true,
      alertAt100: true,
      alertSentAt: null,
      deletedAt: null,
      version: 1,
      createdAt: utc("2026-01-01T00:00:00.000Z"),
      updatedAt: NOW,
      category: null,
      ...overrides,
    };
    budgets.push(budget);
    return budget;
  }

  function seedExpense(
    date: string,
    amountMinor: bigint,
    overrides: Record<string, any> = {},
  ) {
    const expense = {
      id: `exp-${expenses.length + 1}`,
      userId: USER,
      accountId: "acc-1",
      categoryId: null,
      type: FinanceTransactionType.EXPENSE,
      amountMinor,
      currency: "INR",
      isExcludedFromBudget: false,
      deletedAt: null,
      transactionDate: utc(date),
      ...overrides,
    };
    expenses.push(expense);
    return expense;
  }

  function seedGoal(overrides: Record<string, any> = {}) {
    store.goal = {
      id: GOAL_ID,
      userId: USER,
      name: "Emergency fund",
      targetAmountMinor: BigInt(5000),
      currentAmountMinor: BigInt(1000),
      targetDate: null,
      color: null,
      iconKey: null,
      isCompleted: false,
      deletedAt: null,
      version: 3,
      createdAt: utc("2026-01-01T00:00:00.000Z"),
      updatedAt: NOW,
      ...overrides,
    };
    return store.goal;
  }

  function seedLoan(overrides: Record<string, any> = {}) {
    store.loan = {
      id: LOAN_ID,
      userId: USER,
      type: FinanceLoanType.LENT,
      counterpartyName: "Bob",
      counterpartyContact: "+919876543210",
      principalAmountMinor: BigInt(1000),
      remainingAmountMinor: BigInt(1000),
      dueDate: utc("2026-12-31T00:00:00.000Z"),
      notes: "Trip share",
      isSettled: false,
      deletedAt: null,
      version: 4,
      createdAt: utc("2026-01-01T00:00:00.000Z"),
      updatedAt: NOW,
      ...overrides,
    };
    return store.loan;
  }

  /**
   * A write from another device that has already committed. Unlike what this
   * transaction writes, it survives a rollback — which is exactly why the delta
   * has to be an operator instead of an absolute value read beforehand.
   */
  function commitFromOtherDevice(
    entity: "goal" | "loan",
    ops: Record<string, any>,
  ) {
    minorOps(store[entity], ops);
    durable[entity] = { ...store[entity] };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);

    budgets = [];
    expenses = [];
    changes = [];
    pendingRace = null;
    capturedExpenseWhere = null;
    store = { goal: {}, loan: {} };
    durable = { goal: null, loan: null };
    seedGoal();
    seedLoan();

    budgetFindMany = jest
      .fn()
      .mockImplementation(({ where }: { where: any }) =>
        Promise.resolve(
          budgets
            .filter(
              (b) =>
                b.userId === where.userId &&
                b.deletedAt === (where.deletedAt ?? null),
            )
            .map((b) => ({ ...b })),
        ),
      );

    expenseFindMany = jest
      .fn()
      .mockImplementation(({ where }: { where: any }) => {
        capturedExpenseWhere = where;
        const range = where.transactionDate ?? {};
        return Promise.resolve(
          expenses
            .filter((e) => {
              if (where.account && e.userId !== where.account.userId) {
                return false;
              }
              if (where.type && e.type !== where.type) return false;
              if (where.currency && e.currency !== where.currency) return false;
              if (
                where.isExcludedFromBudget !== undefined &&
                e.isExcludedFromBudget !== where.isExcludedFromBudget
              ) {
                return false;
              }
              if (where.deletedAt !== undefined && e.deletedAt !== null) {
                return false;
              }
              const date = e.transactionDate as Date;
              if (range.gte && date < range.gte) return false;
              if (range.gt && date <= range.gt) return false;
              if (range.lt && date >= range.lt) return false;
              if (range.lte && date > range.lte) return false;
              return true;
            })
            .map((e) => ({ ...e })),
        );
      });

    goalUpdate = jest.fn().mockImplementation(({ where, data }: any) => {
      if (pendingRace) {
        // A second device commits between this service's read and its write.
        const race = pendingRace;
        pendingRace = null;
        race();
      }
      if (store.goal.id !== where.id) return Promise.resolve(null);
      minorOps(store.goal, data);
      return Promise.resolve({ ...store.goal });
    });

    loanUpdate = jest.fn().mockImplementation(({ where, data }: any) => {
      if (pendingRace) {
        const race = pendingRace;
        pendingRace = null;
        race();
      }
      if (store.loan.id !== where.id) return Promise.resolve(null);
      minorOps(store.loan, data);
      return Promise.resolve({ ...store.loan });
    });

    goalCreate = jest.fn().mockImplementation(({ data }: any) =>
      Promise.resolve({
        id: GOAL_ID,
        version: 1,
        deletedAt: null,
        targetDate: null,
        color: null,
        iconKey: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...data,
      }),
    );

    loanCreate = jest.fn().mockImplementation(({ data }: any) =>
      Promise.resolve({
        id: LOAN_ID,
        version: 1,
        deletedAt: null,
        counterpartyContact: null,
        dueDate: null,
        notes: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...data,
      }),
    );

    const client: any = {
      financeBudget: { findMany: budgetFindMany },
      financeTransaction: { findMany: expenseFindMany },
      financeSavingsGoal: {
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          const doc = store.goal;
          const found =
            doc.id === where.id &&
            doc.userId === where.userId &&
            doc.deletedAt === null;
          return Promise.resolve(found ? { ...doc } : null);
        }),
        create: goalCreate,
        update: goalUpdate,
      },
      financeLoan: {
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          const doc = store.loan;
          const found =
            doc.id === where.id &&
            doc.userId === where.userId &&
            doc.deletedAt === null;
          return Promise.resolve(found ? { ...doc } : null);
        }),
        create: loanCreate,
        update: loanUpdate,
      },
      change: {
        create: jest.fn().mockImplementation(({ data }: any) => {
          const row = { id: `change-${changes.length + 1}`, data };
          changes.push(row);
          return Promise.resolve({ ...row, cursor: BigInt(changes.length) });
        }),
      },
      syncCursor: {
        upsert: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve({ seq: BigInt(changes.length + 1) }),
          ),
      },
    };

    prisma = {
      ...client,
      $transaction: jest.fn().mockImplementation(async (fn: any) => {
        const snapshotGoal = { ...store.goal };
        const snapshotLoan = { ...store.loan };
        const loggedBefore = changes.length;
        try {
          return await fn(client);
        } catch (error) {
          // What a Mongo transaction does: nothing above commits, while a write
          // another device already committed stays put.
          store.goal = durable.goal ?? snapshotGoal;
          store.loan = durable.loan ?? snapshotLoan;
          changes.length = loggedBefore;
          throw error;
        }
      }),
    };

    notifier = { notifyMutation: jest.fn() };
    budgetsService = new BudgetsService(prisma, notifier as any);
    goalsService = new GoalsService(prisma, notifier as any);
    loansService = new LoansService(prisma, notifier as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("budget spend windows", () => {
    it("measures a YEARLY cap against the whole calendar year", async () => {
      seedBudget({
        period: FinanceBudgetPeriod.YEARLY,
        amountMinor: BigInt(1200000),
      });
      seedExpense("2026-03-10T10:00:00.000Z", BigInt(100000));
      seedExpense("2026-10-02T10:00:00.000Z", BigInt(100000));
      seedExpense("2025-12-31T10:00:00.000Z", BigInt(100000));

      const [budget] = await budgetsService.getBudgetsWithSpending(USER);

      // Pre-fix this reported 100000 / 8.33%: the annual cap was measured against
      // October alone, so alertAt100 could never fire and the 80% alert was ~12x
      // early.
      expect(budget.spentMinor).toBe(200000);
      expect(budget.remainingMinor).toBe(1000000);
      expect(budget.percentUsed).toBeCloseTo(16.6667, 3);
      expect(budget.spentWindowStart).toBe("2026-01-01T00:00:00.000Z");
      expect(budget.spentWindowEnd).toBe("2027-01-01T00:00:00.000Z");
      expect(capturedExpenseWhere.transactionDate).toEqual({
        gte: utc("2026-01-01T00:00:00.000Z"),
        lt: utc("2027-01-01T00:00:00.000Z"),
      });
    });

    it("reads ?month=1 as January, in UTC", async () => {
      seedBudget({ period: FinanceBudgetPeriod.MONTHLY });
      seedExpense("2026-01-15T10:00:00.000Z", BigInt(10000));
      seedExpense("2026-02-02T10:00:00.000Z", BigInt(5000));

      // `month` used to be handed to Date.UTC as a 0-based index, so 1 selected
      // February and the January spend simply vanished.
      const [budget] = await budgetsService.getBudgetsWithSpending(
        USER,
        1,
        2026,
      );

      expect(budget.spentMinor).toBe(10000);
      expect(budget.spentWindowStart).toBe("2026-01-01T00:00:00.000Z");
      expect(budget.spentWindowEnd).toBe("2026-02-01T00:00:00.000Z");
    });

    it("derives WEEKLY, QUARTERLY and CUSTOM windows and buckets in one query", async () => {
      seedBudget({
        id: "bgt-weekly",
        period: FinanceBudgetPeriod.WEEKLY,
        amountMinor: BigInt(200000),
      });
      seedBudget({
        id: "bgt-monthly",
        period: FinanceBudgetPeriod.MONTHLY,
        amountMinor: BigInt(1000000),
      });
      seedBudget({
        id: "bgt-quarterly",
        period: FinanceBudgetPeriod.QUARTERLY,
        amountMinor: BigInt(1200000),
      });
      seedBudget({
        id: "bgt-custom",
        period: FinanceBudgetPeriod.CUSTOM,
        amountMinor: BigInt(900000),
        startDate: utc("2026-09-20T06:00:00.000Z"),
        endDate: utc("2026-10-10T06:00:00.000Z"),
      });
      seedExpense("2026-03-15T10:00:00.000Z", BigInt(100000));
      seedExpense("2026-09-25T10:00:00.000Z", BigInt(200000));
      seedExpense("2026-10-02T10:00:00.000Z", BigInt(300000));
      seedExpense("2026-10-06T10:00:00.000Z", BigInt(400000));
      seedExpense("2026-11-02T10:00:00.000Z", BigInt(500000));

      const result = await budgetsService.getBudgetsWithSpending(USER);
      const byId = Object.fromEntries(result.map((b: any) => [b.id, b]));

      expect(expenseFindMany).toHaveBeenCalledTimes(1);
      // One round trip over the union of the four windows: CUSTOM starts
      // 2026-09-20, QUARTERLY runs to the end of the year. The March expense is
      // never even fetched.
      expect(capturedExpenseWhere.transactionDate).toEqual({
        gte: utc("2026-09-20T00:00:00.000Z"),
        lt: utc("2027-01-01T00:00:00.000Z"),
      });
      // 2026-10-05 is a Monday, so the week runs Mon 5th to Mon 12th.
      expect(byId["bgt-weekly"].spentWindowStart).toBe(
        "2026-10-05T00:00:00.000Z",
      );
      expect(byId["bgt-weekly"].spentWindowEnd).toBe(
        "2026-10-12T00:00:00.000Z",
      );
      expect(byId["bgt-weekly"].spentMinor).toBe(400000);
      expect(byId["bgt-weekly"].percentUsed).toBe(200);
      expect(byId["bgt-monthly"].spentMinor).toBe(700000);
      expect(byId["bgt-monthly"].remainingMinor).toBe(300000);
      expect(byId["bgt-quarterly"].spentWindowStart).toBe(
        "2026-10-01T00:00:00.000Z",
      );
      expect(byId["bgt-quarterly"].spentMinor).toBe(1200000);
      // CUSTOM keeps its own range, day-granular, with endDate inclusive.
      expect(byId["bgt-custom"].spentWindowStart).toBe(
        "2026-09-20T00:00:00.000Z",
      );
      expect(byId["bgt-custom"].spentWindowEnd).toBe(
        "2026-10-11T00:00:00.000Z",
      );
      expect(byId["bgt-custom"].spentMinor).toBe(900000);
      expect(byId["bgt-custom"].percentUsed).toBe(100);
    });

    it("clamps a MONTHLY budget to its own startDate", async () => {
      seedBudget({
        period: FinanceBudgetPeriod.MONTHLY,
        startDate: utc("2026-10-03T00:00:00.000Z"),
      });
      seedExpense("2026-10-01T10:00:00.000Z", BigInt(70000));
      seedExpense("2026-10-04T10:00:00.000Z", BigInt(30000));

      const [budget] = await budgetsService.getBudgetsWithSpending(USER);

      expect(budget.spentWindowStart).toBe("2026-10-03T00:00:00.000Z");
      expect(budget.spentMinor).toBe(30000);
    });

    it("keeps the server-side spend filters", async () => {
      seedBudget({ categoryId: RENT_CATEGORY, amountMinor: BigInt(60000) });
      seedBudget({ id: "bgt-all", categoryId: null });
      seedExpense("2026-10-03T10:00:00.000Z", BigInt(60000), {
        categoryId: RENT_CATEGORY,
      });
      seedExpense("2026-10-04T10:00:00.000Z", BigInt(25000), {
        categoryId: "cat-food",
      });

      const result = await budgetsService.getBudgetsWithSpending(USER);

      expect(result[0].spentMinor).toBe(60000);
      expect(result[0].remainingMinor).toBe(0);
      expect(result[1].spentMinor).toBe(85000);
      expect(capturedExpenseWhere).toMatchObject({
        account: { userId: USER },
        type: FinanceTransactionType.EXPENSE,
        isExcludedFromBudget: false,
        deletedAt: null,
        // The one currency a budget can currently cap, kept in one constant.
        currency: "INR",
      });
    });

    it("answers nothing when the user has no budgets", async () => {
      await expect(
        budgetsService.getBudgetsWithSpending(OTHER_USER),
      ).resolves.toEqual([]);
      expect(expenseFindMany).not.toHaveBeenCalled();
    });

    it("rejects a junk month instead of pushing an Invalid Date into Prisma", async () => {
      seedBudget();

      // Pre-fix: "abc" became NaN and 13 rolled into the next January, both
      // reaching a `transactionDate` filter as a real query.
      await expect(
        budgetsService.getBudgetsWithSpending(USER, 13, 2026),
      ).rejects.toThrow(BadRequestException);
      await expect(
        budgetsService.getBudgetsWithSpending(USER, Number.NaN, 2026),
      ).rejects.toThrow(BadRequestException);
      await expect(
        budgetsService.getBudgetsWithSpending(USER, 6, 1999),
      ).rejects.toThrow(BadRequestException);
      expect(budgetFindMany).not.toHaveBeenCalled();
      expect(expenseFindMany).not.toHaveBeenCalled();
    });

    it("returns 400 for the query strings that used to reach Date.UTC", async () => {
      await expect(
        queryPipe.transform(
          { withSpending: "true", month: "abc" },
          queryContext,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        queryPipe.transform(
          { withSpending: "true", month: "13" },
          queryContext,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        queryPipe.transform({ withSpending: "true", month: "0" }, queryContext),
      ).rejects.toThrow(BadRequestException);
      await expect(
        queryPipe.transform(
          { withSpending: "true", year: "1999" },
          queryContext,
        ),
      ).rejects.toThrow(BadRequestException);

      await expect(
        queryPipe.transform({ withSpending: "true", month: "1" }, queryContext),
      ).resolves.toMatchObject({ withSpending: true, month: 1 });
      await expect(
        queryPipe.transform({ month: "12", year: "2100" }, queryContext),
      ).resolves.toMatchObject({ month: 12, year: 2100 });
    });

    it("validates budget dates and amounts before they reach a Date column", async () => {
      await expect(
        queryPipe.transform(
          { amountMinor: "100000", startDate: "next friday" },
          bodyContext(CreateBudgetDto),
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        queryPipe.transform(
          { amountMinor: "100000", categoryId: "cat-rent" },
          bodyContext(CreateBudgetDto),
        ),
      ).rejects.toThrow(BadRequestException);

      await expect(
        budgetsService.createBudget(USER, {
          amountMinor: Number.MAX_SAFE_INTEGER,
          startDate: "tomorrow",
        } as any),
      ).rejects.toThrow(BadRequestException);
      await expect(
        budgetsService.createBudget(USER, {
          amountMinor: Infinity,
        } as any),
      ).rejects.toThrow(BadRequestException);
      await expect(
        budgetsService.createBudget(USER, {
          amountMinor: 100000,
          startDate: "2026-10-10",
          endDate: "2026-10-01",
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();

      await expect(
        queryPipe.transform(
          {
            amountMinor: 100000,
            startDate: "2026-10-01T00:00:00.000000Z",
            period: FinanceBudgetPeriod.CUSTOM,
            endDate: "2026-10-31",
          },
          bodyContext(CreateBudgetDto),
        ),
      ).resolves.toMatchObject({ amountMinor: 100000 });
    });
  });

  describe("goal deposits", () => {
    it("writes the deposit as an atomic increment, not an absolute balance", async () => {
      seedGoal({
        targetAmountMinor: BigInt(5000),
        currentAmountMinor: BigInt(1000),
      });

      const goal = await goalsService.depositToGoal(USER, GOAL_ID, {
        amountMinor: 500,
      });

      expect(goalUpdate).toHaveBeenCalledTimes(1);
      expect(goalUpdate.mock.calls[0][0].data).toEqual({
        currentAmountMinor: { increment: BigInt(500) },
        version: { increment: 1 },
      });
      expect(goal.currentAmountMinor).toBe(1500);
      expect(goal.isCompleted).toBe(false);
      expect(store.goal.currentAmountMinor).toBe(BigInt(1500));
    });

    it("keeps both deposits when one commits mid-transaction", async () => {
      seedGoal({
        targetAmountMinor: BigInt(5000),
        currentAmountMinor: BigInt(1000),
      });
      pendingRace = () =>
        commitFromOtherDevice("goal", {
          currentAmountMinor: { increment: BigInt(500) },
          version: { increment: 1 },
        });

      const goal = await goalsService.depositToGoal(USER, GOAL_ID, {
        amountMinor: 500,
      });

      // Pre-fix the service wrote `1000 + 500` absolutely: the other device's 500
      // was overwritten and the row landed on 1500.
      expect(store.goal.currentAmountMinor).toBe(BigInt(2000));
      expect(goal.currentAmountMinor).toBe(2000);
      const logged = changes[changes.length - 1].data;
      expect(logged.payload.currentAmountMinor).toBe(2000);
      expect(logged.version).toBe(store.goal.version);
      expect(logged.version).toBeGreaterThan(3);
    });

    it("flips isCompleted only on the deposit that actually crosses the target", async () => {
      seedGoal({
        targetAmountMinor: BigInt(2000),
        currentAmountMinor: BigInt(1500),
      });

      const goal = await goalsService.depositToGoal(USER, GOAL_ID, {
        amountMinor: 500,
      });

      expect(goal.isCompleted).toBe(true);
      expect(goalUpdate).toHaveBeenCalledTimes(2);
      expect(goalUpdate.mock.calls[1][0].data).toEqual({ isCompleted: true });
      expect(store.goal.isCompleted).toBe(true);
    });

    it("refuses a negative seed, an unsafe amount and a junk target date", async () => {
      await expect(
        goalsService.createGoal(USER, {
          name: "Emergency fund",
          targetAmountMinor: 5000,
          currentAmountMinor: -500,
        } as any),
      ).rejects.toThrow(BadRequestException);
      await expect(
        goalsService.depositToGoal(USER, GOAL_ID, {
          amountMinor: Infinity,
        } as any),
      ).rejects.toThrow(BadRequestException);
      await expect(
        goalsService.createGoal(USER, {
          name: "Emergency fund",
          targetAmountMinor: 5000,
          targetDate: "tomorrow",
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();

      await expect(
        queryPipe.transform(
          {
            name: "Emergency fund",
            targetAmountMinor: 5000,
            currentAmountMinor: -500,
          },
          bodyContext(CreateGoalDto),
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        queryPipe.transform(
          { name: "Emergency fund", targetAmountMinor: 5000 },
          bodyContext(CreateGoalDto),
        ),
      ).resolves.toMatchObject({ targetAmountMinor: 5000 });
    });

    it("accepts the microsecond ISO string the Flutter client sends", async () => {
      await expect(
        queryPipe.transform(
          {
            name: "MacBook",
            targetAmountMinor: 6000000,
            targetDate: "2026-12-20T00:00:00.000000Z",
          },
          bodyContext(CreateGoalDto),
        ),
      ).resolves.toMatchObject({ targetDate: "2026-12-20T00:00:00.000000Z" });
    });
  });

  describe("loan repayments", () => {
    it("writes the repayment as an atomic decrement", async () => {
      seedLoan({
        principalAmountMinor: BigInt(1000),
        remainingAmountMinor: BigInt(1000),
      });

      const loan = await loansService.recordRepayment(USER, LOAN_ID, {
        amountMinor: 200,
      });

      expect(loanUpdate).toHaveBeenCalledTimes(1);
      expect(loanUpdate.mock.calls[0][0].data).toEqual({
        remainingAmountMinor: { decrement: BigInt(200) },
        version: { increment: 1 },
      });
      expect(loan.remainingAmountMinor).toBe(800);
      expect(store.loan.remainingAmountMinor).toBe(BigInt(800));
    });

    it("keeps both repayments when one commits mid-transaction", async () => {
      seedLoan({ remainingAmountMinor: BigInt(1000) });
      pendingRace = () =>
        commitFromOtherDevice("loan", {
          remainingAmountMinor: { decrement: BigInt(400) },
          version: { increment: 1 },
        });

      const loan = await loansService.recordRepayment(USER, LOAN_ID, {
        amountMinor: 300,
      });

      // Pre-fix this stored `1000 - 300` and deleted the other 400 repayment.
      expect(store.loan.remainingAmountMinor).toBe(BigInt(300));
      expect(loan.remainingAmountMinor).toBe(300);
      const logged = changes[changes.length - 1].data;
      expect(logged.payload.remainingAmountMinor).toBe(300);
      expect(logged.version).toBe(store.loan.version);
    });

    it("rejects a repayment above the outstanding balance", async () => {
      seedLoan({ remainingAmountMinor: BigInt(500) });

      // Pre-fix the surplus was clamped away: 600 against 500 stored 0 and the
      // extra 100 was recorded nowhere.
      await expect(
        loansService.recordRepayment(USER, LOAN_ID, { amountMinor: 600 }),
      ).rejects.toThrow(BadRequestException);
      expect(loanUpdate).not.toHaveBeenCalled();
      expect(changes).toHaveLength(0);
      expect(store.loan.remainingAmountMinor).toBe(BigInt(500));
    });

    it("rolls back instead of clamping when a repayment overtakes it", async () => {
      seedLoan({ remainingAmountMinor: BigInt(1000) });
      pendingRace = () =>
        commitFromOtherDevice("loan", {
          remainingAmountMinor: { decrement: BigInt(1000) },
          isSettled: true,
          version: { increment: 1 },
        });

      await expect(
        loansService.recordRepayment(USER, LOAN_ID, { amountMinor: 500 }),
      ).rejects.toThrow(BadRequestException);
      expect(store.loan.remainingAmountMinor).toBe(BigInt(0));
      expect(store.loan.isSettled).toBe(true);
      expect(changes).toHaveLength(0);
    });

    it("settles the loan on the repayment that clears it", async () => {
      seedLoan({ remainingAmountMinor: BigInt(1000) });

      const loan = await loansService.recordRepayment(USER, LOAN_ID, {
        amountMinor: 1000,
      });

      expect(loan.isSettled).toBe(true);
      expect(loanUpdate).toHaveBeenCalledTimes(2);
      expect(loanUpdate.mock.calls[1][0].data).toEqual({ isSettled: true });
      expect(store.loan.isSettled).toBe(true);
    });

    it("refuses debt that exceeds what was lent, and a junk due date", async () => {
      await expect(
        loansService.createLoan(USER, {
          type: FinanceLoanType.BORROWED,
          counterpartyName: "Bank",
          principalAmountMinor: 1000,
          remainingAmountMinor: 5000,
        } as any),
      ).rejects.toThrow(BadRequestException);
      await expect(
        loansService.createLoan(USER, {
          type: FinanceLoanType.BORROWED,
          counterpartyName: "Bank",
          principalAmountMinor: 1000,
          remainingAmountMinor: -1,
        } as any),
      ).rejects.toThrow(BadRequestException);
      await expect(
        loansService.createLoan(USER, {
          type: FinanceLoanType.BORROWED,
          counterpartyName: "Bank",
          principalAmountMinor: 1000,
          dueDate: "next week",
        } as any),
      ).rejects.toThrow(BadRequestException);
      await expect(
        loansService.recordRepayment(USER, LOAN_ID, {
          amountMinor: Number.MAX_SAFE_INTEGER + 1,
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(loanCreate).not.toHaveBeenCalled();
    });

    it("marks a zero-outstanding loan settled on creation", async () => {
      const loan = await loansService.createLoan(USER, {
        type: FinanceLoanType.LENT,
        counterpartyName: "Bob",
        principalAmountMinor: 1000,
        remainingAmountMinor: 0,
      } as any);

      expect(loan.isSettled).toBe(true);
      expect(loan.remainingAmountMinor).toBe(0);
    });

    it("keeps the loan DTO honest about its dates", async () => {
      await expect(
        queryPipe.transform(
          {
            type: FinanceLoanType.LENT,
            counterpartyName: "Bob",
            principalAmountMinor: 1000,
            dueDate: "sometime in 2026",
          },
          bodyContext(CreateLoanDto),
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        queryPipe.transform(
          {
            type: FinanceLoanType.LENT,
            counterpartyName: "Bob",
            principalAmountMinor: 1000,
            dueDate: "2026-12-31T00:00:00.000000Z",
          },
          bodyContext(CreateLoanDto),
        ),
      ).resolves.toMatchObject({ dueDate: "2026-12-31T00:00:00.000000Z" });
    });
  });
});
