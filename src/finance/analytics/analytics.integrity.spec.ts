import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { FinanceTransactionType } from "@prisma/client";
import { AnalyticsService } from "./analytics.service";
import { allocatePercentages, formatMinorUnits } from "./analytics.service";
import {
  CashFlowQueryDto,
  ExportTransactionsQueryDto,
  FinancialCalendarQueryDto,
  HealthCheckQueryDto,
  SpendingByCategoryQueryDto,
} from "./dto/analytics-query.dto";
import { createValidationPipe } from "@/common/errors/validation.pipe";

const USER = "user-1";

/** Percent shares summed back to hundredths of a percent, i.e. 10000 = 100%. */
const hundredths = (sum: number, value: number) =>
  sum + Math.round(value * 100);

function tx(overrides: Record<string, any>) {
  return {
    id: "tx-1",
    userId: USER,
    accountId: "acc-1",
    toAccountId: null,
    categoryId: null,
    type: FinanceTransactionType.EXPENSE,
    amountMinor: 1000n,
    currency: "INR",
    title: "Row",
    notes: null,
    transactionDate: new Date("2026-10-15T04:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function prismaWith(transactions: any[]) {
  const findMany = jest.fn().mockResolvedValue(transactions);
  return {
    financeTransaction: { findMany },
    financeCategory: {
      findMany: jest.fn().mockResolvedValue([
        { id: "cat-a", name: "A", color: null, iconKey: null },
        { id: "cat-b", name: "B", color: null, iconKey: null },
        { id: "cat-c", name: "C", color: null, iconKey: null },
      ]),
    },
    financeAccount: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
    },
    financeLoan: { findMany: jest.fn().mockResolvedValue([]) },
    financeBudget: { findMany: jest.fn().mockResolvedValue([]) },
    financeRecurringRule: { findMany: jest.fn().mockResolvedValue([]) },
    financeSavingsGoal: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
}

function service(transactions: any[]) {
  const db = prismaWith(transactions);
  return { service: new AnalyticsService(db), db };
}

describe("Analytics integrity", () => {
  describe("percentage allocation", () => {
    it("sums to exactly 100.00 instead of 99.99", () => {
      const percentages = allocatePercentages([100n, 100n, 100n], 300n);
      expect(percentages).toHaveLength(3);
      expect(percentages.reduce(hundredths, 0)).toBe(10000);
      expect(percentages.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
      // Deterministic: the remainder goes to the first inputs, in order.
      expect(percentages).toEqual([33.34, 33.33, 33.33]);
    });

    it("is zero for an empty or empty-valued split", () => {
      expect(allocatePercentages([], 0n)).toEqual([]);
      expect(allocatePercentages([0n, 0n], 0n)).toEqual([0, 0]);
    });
  });

  describe("spending by category", () => {
    it("answers a USD-only user in USD rather than zero INR", async () => {
      const { service: analytics } = service([
        tx({
          id: "u1",
          currency: "USD",
          amountMinor: 2500n,
          categoryId: "cat-a",
        }),
        tx({
          id: "u2",
          currency: "USD",
          amountMinor: 7500n,
          categoryId: "cat-b",
        }),
      ]);

      const report = await analytics.getSpendingByCategory(USER);

      expect(report.currency).toBe("USD");
      expect(report.totalSpendingMinor).toBe(10000);
      expect(report.mixedCurrencies).toBe(false);
      expect(report.byCurrency).toHaveLength(1);
      expect(report.byCurrency[0].currency).toBe("USD");
      expect(report.categories.map((c) => c.totalAmountMinor)).toEqual([
        7500, 2500,
      ]);
    });

    it("keeps one bucket per currency so minors never cross-add", async () => {
      const { service: analytics } = service([
        tx({
          id: "i1",
          currency: "INR",
          amountMinor: 4000n,
          categoryId: "cat-a",
        }),
        tx({
          id: "j1",
          currency: "JPY",
          amountMinor: 9000n,
          categoryId: "cat-b",
        }),
      ]);

      const report = await analytics.getSpendingByCategory(USER);

      expect(report.mixedCurrencies).toBe(true);
      expect(report.byCurrency.map((b) => b.currency).sort()).toEqual([
        "INR",
        "JPY",
      ]);
      // Top level stays a real single-currency figure, labelled with it.
      expect(["INR", "JPY"]).toContain(report.currency);
      for (const bucket of report.byCurrency) {
        const shares = bucket.categories.map((c) => c.percentage);
        expect(shares.reduce(hundredths, 0)).toBe(10000);
      }
    });

    it("still filters when a currency is asked for explicitly", async () => {
      const { service: analytics, db } = service([]);

      const report = await analytics.getSpendingByCategory(
        USER,
        undefined,
        undefined,
        "usd",
      );

      expect(report.currency).toBe("USD");
      expect(report.byCurrency).toEqual([]);
      expect(
        db.financeTransaction.findMany.mock.calls[0][0].where.currency,
      ).toBe("USD");
    });

    it("reads in bounded pages instead of one unbounded findMany", async () => {
      const page = Array.from({ length: 500 }, (_, i) =>
        tx({ id: `p1-${i}`, amountMinor: 1n }),
      );
      const db = prismaWith([]);
      db.financeTransaction.findMany
        .mockResolvedValueOnce(page)
        .mockResolvedValueOnce([tx({ id: "p2-0", amountMinor: 1n })]);

      const analytics = new AnalyticsService(db);
      const report = await analytics.getSpendingByCategory(USER);

      expect(db.financeTransaction.findMany).toHaveBeenCalledTimes(2);
      expect(db.financeTransaction.findMany.mock.calls[0][0].take).toBe(500);
      expect(db.financeTransaction.findMany.mock.calls[1][0].where.id).toEqual({
        gt: "p1-499",
      });
      expect(report.totalSpendingMinor).toBe(501);
      expect(report.truncated).toBe(false);
    });

    it("refuses a non-ISO date rather than querying with Invalid Date", async () => {
      const { service: analytics } = service([]);
      await expect(
        analytics.getSpendingByCategory(USER, "last tuesday"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("cash flow", () => {
    it("buckets months in UTC, matching the budget report", async () => {
      // 2026-10-01T00:30+05:30 is 2026-09-30T19:00Z: the local calendar says
      // October, the UTC calendar the budgets use says September.
      const { service: analytics } = service([
        tx({
          id: "drift",
          type: FinanceTransactionType.INCOME,
          amountMinor: 5000n,
          transactionDate: new Date("2026-09-30T19:00:00.000Z"),
        }),
      ]);

      const report = await analytics.getCashFlow(USER, 2026);

      expect(report.months[9].incomeMinor).toBe(0);
      expect(report.months[8].incomeMinor).toBe(5000);
    });

    it("reports each currency's twelve months separately", async () => {
      const { service: analytics } = service([
        tx({
          id: "inr",
          currency: "INR",
          type: FinanceTransactionType.INCOME,
          amountMinor: 100000n,
        }),
        tx({
          id: "usd",
          currency: "USD",
          type: FinanceTransactionType.EXPENSE,
          amountMinor: 40000n,
        }),
      ]);

      const report = await analytics.getCashFlow(USER, 2026);

      expect(report.byCurrency.map((b) => b.currency).sort()).toEqual([
        "INR",
        "USD",
      ]);
      const usd = report.byCurrency.find((b) => b.currency === "USD")!;
      expect(usd.totalExpenseMinor).toBe(40000);
      expect(usd.totalIncomeMinor).toBe(0);
      // Top level is one bucket, not a sum of incompatible minor units.
      expect(["INR", "USD"]).toContain(report.currency);
      expect(report.truncated).toBe(false);
    });

    it("turns a bogus year into a 400 instead of an Invalid Date", async () => {
      const { service: analytics } = service([]);
      await expect(analytics.getCashFlow(USER, NaN)).rejects.toThrow(
        BadRequestException,
      );
      await expect(analytics.getCashFlow(USER, 99999)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("export", () => {
    it("carries exact minor units and the row's own scale", async () => {
      const { service: analytics } = service([
        tx({
          id: "big",
          currency: "INR",
          amountMinor: 9007199254740993n,
        }),
        tx({ id: "yen", currency: "JPY", amountMinor: 1000n }),
        tx({ id: "unknown", currency: "XYZ", amountMinor: 1000n }),
      ]);

      const json: any = await analytics.exportTransactions(USER, "json");

      expect(json.transactions[0].amountMinor).toBe("9007199254740993");
      expect(json.transactions[0].amount).toBe("90071992547409.93");
      expect(json.transactions[0].amountScale).toBe(2);
      // JPY has no minor fraction: 1000 minor units are 1000 yen, not 10.00.
      expect(json.transactions[1].amount).toBe("1000");
      expect(json.transactions[1].amountScale).toBe(0);
      // An unlisted exponent is left as minor units only, never re-read as 2.
      expect(json.transactions[2].amount).toBeNull();
      expect(json.transactions[2].amountScale).toBeNull();
      expect(json.transactions[2].amountMinor).toBe("1000");
    });

    it("keeps minor units and currency as their own CSV columns", async () => {
      const { service: analytics } = service([
        tx({ id: "yen", currency: "JPY", amountMinor: 1000n }),
      ]);

      const csv: any = await analytics.exportTransactions(USER, "csv");
      const [header, firstRow] = csv.content.split("\n");

      expect(header).toBe(
        "Date,Type,Title,Amount,AmountMinor,Currency,Account,To Account,Category,Notes",
      );
      expect(firstRow.split(",")[3]).toBe("1000");
      expect(firstRow.split(",")[4]).toBe("1000");
      expect(firstRow.split(",")[5]).toBe("JPY");
    });

    it("filters by currency and bounds the read", async () => {
      const { service: analytics, db } = service([]);

      await analytics.exportTransactions(
        USER,
        "json",
        "2026-01-01",
        undefined,
        "usd",
      );

      const args = db.financeTransaction.findMany.mock.calls[0][0];
      expect(args.where.currency).toBe("USD");
      expect(args.take).toBe(500);
      expect(args.where.transactionDate.gte).toEqual(
        new Date("2026-01-01T00:00:00.000Z"),
      );
    });

    it("expands a bare end date to its whole UTC day", async () => {
      const { service: analytics, db } = service([]);

      await analytics.exportTransactions(
        USER,
        "json",
        "2026-03-31",
        "2026-03-31",
      );

      const where = db.financeTransaction.findMany.mock.calls[0][0].where;
      expect(where.transactionDate.gte).toEqual(
        new Date("2026-03-31T00:00:00.000Z"),
      );
      expect(where.transactionDate.lte).toEqual(
        new Date("2026-03-31T23:59:59.999Z"),
      );
    });

    it("rejects an unparseable export window", async () => {
      const { service: analytics } = service([]);
      await expect(
        analytics.exportTransactions(USER, "csv", "last tuesday"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("query DTO", () => {
    it("refuses the loose strings that used to reach the service", async () => {
      const pipe = createValidationPipe();
      const context = (metatype: any) => ({
        type: "query" as const,
        metatype,
      });

      await expect(
        pipe.transform(
          { startDate: "03/31/2026" },
          context(SpendingByCategoryQueryDto),
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        pipe.transform({ year: "abc" }, context(CashFlowQueryDto)),
      ).rejects.toThrow(BadRequestException);
      await expect(
        pipe.transform({ year: "2026" }, context(CashFlowQueryDto)),
      ).resolves.toMatchObject({ year: 2026 });
      await expect(
        pipe.transform(
          { format: "CSV", currency: "usd" },
          context(ExportTransactionsQueryDto),
        ),
      ).resolves.toMatchObject({ format: "csv", currency: "usd" });
      await expect(
        pipe.transform(
          { currency: "inr" },
          context(HealthCheckQueryDto),
        ),
      ).resolves.toMatchObject({ currency: "inr" });
      await expect(
        pipe.transform(
          { year: "2026", month: "10", currency: "INR" },
          context(FinancialCalendarQueryDto),
        ),
      ).resolves.toMatchObject({ year: 2026, month: 10, currency: "INR" });
      await expect(
        pipe.transform({ month: "13" }, context(FinancialCalendarQueryDto)),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("financial health check", () => {
    it("computes 5 vitals, overall score, and grade", async () => {
      const { service: analytics, db } = service([
        tx({
          type: FinanceTransactionType.INCOME,
          amountMinor: 10000000n, // 100,000 INR
          transactionDate: new Date(),
        }),
        tx({
          type: FinanceTransactionType.EXPENSE,
          amountMinor: 3000000n, // 30,000 INR
          transactionDate: new Date(),
        }),
      ]);

      db.financeAccount.findMany = jest.fn().mockResolvedValue([
        {
          id: "acc-1",
          type: "BANK",
          currentBalanceMinor: 20000000n, // 200,000 INR
          currency: "INR",
        },
      ]);

      const result = await analytics.getFinancialHealthCheck(USER, "INR");
      expect(result.currency).toBe("INR");
      expect(result.overallScore).toBeGreaterThanOrEqual(70);
      expect(result.grade).toBe("strong");
      expect(result.indicators.savingsRate.status).toBe("healthy");
      expect(result.indicators.debtBurden.valueDisplay).toBe("Debt Free");
      expect(result.indicators.emergencyRunway.status).toBe("healthy");
      expect(result.actionItems).toBeDefined();
    });
  });

  describe("financial calendar", () => {
    it("builds calendar with daily running balance and scheduled events", async () => {
      const { service: analytics, db } = service([]);
      db.financeAccount.findMany = jest.fn().mockResolvedValue([
        {
          id: "acc-1",
          type: "BANK",
          currentBalanceMinor: 10000000n, // 100,000 INR
          currency: "INR",
        },
      ]);
      db.financeRecurringRule.findMany = jest.fn().mockResolvedValue([
        {
          id: "rule-salary",
          type: "INCOME",
          amountMinor: 8000000n,
          title: "Salary",
          frequency: "MONTHLY",
          interval: 1,
          startDate: new Date("2026-01-01T00:00:00.000Z"),
          endDate: null,
        },
        {
          id: "rule-rent",
          type: "EXPENSE",
          amountMinor: 2500000n,
          title: "Rent",
          frequency: "MONTHLY",
          interval: 1,
          startDate: new Date("2026-01-05T00:00:00.000Z"),
          endDate: null,
        },
      ]);

      const calendar = await analytics.getFinancialCalendar(USER, 2026, 10, "INR");
      expect(calendar.year).toBe(2026);
      expect(calendar.month).toBe(10);
      expect(calendar.days.length).toBe(31);
      expect(calendar.totalExpectedInflowMinor).toBe(8000000);
      expect(calendar.totalExpectedOutflowMinor).toBe(2500000);
      expect(calendar.startingBalanceMinor).toBe(10000000);
      expect(calendar.projectedEndingBalanceMinor).toBe(10000000 + 8000000 - 2500000);
    });
  });

  describe("minor formatting", () => {
    it("formats without float rounding", () => {
      expect(formatMinorUnits(-1234n, "usd")).toBe("-12.34");
      expect(formatMinorUnits(5n, "INR")).toBe("0.05");
      expect(formatMinorUnits(1n, "ZZZ")).toBeNull();
    });
  });
});
