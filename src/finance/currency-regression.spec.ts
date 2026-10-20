import { BadRequestException } from "@nestjs/common";
import { FinanceBudgetPeriod, FinanceTransactionType } from "@prisma/client";
import { AnalyticsService } from "./analytics/analytics.service";
import { TransactionsService } from "./transactions/transactions.service";
import { BudgetsService } from "./budgets/budgets.service";
import { normaliseCurrency, resolveCurrency } from "./finance.helpers";

describe("Finance currency regressions", () => {
  let prisma: any;
  beforeEach(() => {
    prisma = {
      financeAccount: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
      financeBudget: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
      financeLoan: { findMany: jest.fn().mockResolvedValue([]) },
      financeTransaction: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
      financeCategory: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    };
  });

  it("uses signed balances and outstanding loans for net worth", async () => {
    prisma.financeAccount.findMany.mockResolvedValue([
      { currency: "INR", type: "BANK", currentBalanceMinor: 100000n },
      { currency: "INR", type: "CREDIT", currentBalanceMinor: 2000n },
      { currency: "INR", type: "CREDIT", currentBalanceMinor: -5000n },
      { currency: "INR", type: "BANK", currentBalanceMinor: -3000n },
    ]);
    prisma.financeLoan.findMany.mockResolvedValue([
      { type: "LENT", remainingAmountMinor: 4000n },
      { type: "BORROWED", remainingAmountMinor: 1000n },
      { type: "LENT", remainingAmountMinor: 999999n, isSettled: true },
    ]);
    const result = await new AnalyticsService(prisma).getNetWorth("user");
    expect(result).toMatchObject({
      currency: "INR",
      totalAssetsMinor: 106000,
      totalLiabilitiesMinor: 9000,
      netWorthMinor: 97000,
    });
    expect(prisma.financeAccount.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user",
        deletedAt: null,
        isArchived: false,
        currency: "INR",
      },
    });
    expect(prisma.financeLoan.findMany).toHaveBeenCalledWith({
      where: { userId: "user", deletedAt: null, isSettled: false },
    });
  });

  it("does not add INR loans to another currency", async () => {
    prisma.financeAccount.findMany.mockResolvedValue([
      { currency: "USD", currentBalanceMinor: 500n },
    ]);
    const result = await new AnalyticsService(prisma).getNetWorth(
      "user",
      "usd",
    );
    expect(result.netWorthMinor).toBe(500);
    expect(result.currency).toBe("USD");
    expect(prisma.financeLoan.findMany).not.toHaveBeenCalled();
    expect(prisma.financeAccount.findMany.mock.calls[0][0].where.currency).toBe(
      "USD",
    );
  });

  it("filters spending and cash flow by the requested currency", async () => {
    const service = new AnalyticsService(prisma);
    expect(
      (await service.getSpendingByCategory("user", undefined, undefined, "usd"))
        .currency,
    ).toBe("USD");
    expect(
      prisma.financeTransaction.findMany.mock.calls[0][0].where.currency,
    ).toBe("USD");
    expect((await service.getCashFlow("user", 2026, "eur")).currency).toBe(
      "EUR",
    );
    expect(
      prisma.financeTransaction.findMany.mock.calls[1][0].where.currency,
    ).toBe("EUR");
    expect(
      (
        await new TransactionsService(prisma).getCashFlowSummary(
          "user",
          undefined,
          undefined,
          "usd",
        )
      ).currency,
    ).toBe("USD");
    expect(
      prisma.financeTransaction.findMany.mock.calls[2][0].where.currency,
    ).toBe("USD");
  });

  const dto = {
    accountId: "source",
    toAccountId: "destination",
    type: FinanceTransactionType.TRANSFER,
    amountMinor: 100,
    title: "Transfer",
    transactionDate: "2026-10-10T12:00:00Z",
  };
  it("rejects cross-currency transfers before mutating balances", async () => {
    prisma.financeAccount.findFirst
      .mockResolvedValueOnce({ currency: "INR" })
      .mockResolvedValueOnce({ currency: "USD" });
    await expect(
      new TransactionsService(prisma).createTransaction("user", dto),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an explicit transaction currency that differs from the account", async () => {
    prisma.financeAccount.findFirst.mockResolvedValue({ currency: "USD" });
    await expect(
      new TransactionsService(prisma).createTransaction("user", {
        ...dto,
        currency: "INR",
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid minor-unit amount %s",
    async (amountMinor) => {
      prisma.financeAccount.findFirst.mockResolvedValue({ currency: "INR" });
      await expect(
        new TransactionsService(prisma).createTransaction("user", {
          ...dto,
          amountMinor,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("rejects changing a transfer to a destination with another currency", async () => {
    prisma.financeTransaction.findFirst.mockResolvedValue({
      ...dto,
      currency: "INR",
      amountMinor: 100n,
    });
    prisma.financeAccount.findFirst
      .mockResolvedValueOnce({ currency: "INR" })
      .mockResolvedValueOnce({ currency: "EUR" });
    await expect(
      new TransactionsService(prisma).updateTransaction("user", "tx", {
        toAccountId: "euro",
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  describe("budget spend is measured in the budget's own currency", () => {
    function budget(id: string, currency: unknown) {
      return {
        id,
        userId: "user",
        categoryId: null,
        amountMinor: BigInt(100000),
        currency,
        period: FinanceBudgetPeriod.MONTHLY,
        startDate: null,
        endDate: null,
        deletedAt: null,
        version: 1,
      };
    }

    function expense(currency: unknown, amountMinor: bigint) {
      return {
        accountId: "acc-1",
        categoryId: null,
        type: FinanceTransactionType.EXPENSE,
        currency,
        amountMinor,
        isExcludedFromBudget: false,
        deletedAt: null,
        transactionDate: new Date(),
      };
    }

    it("asks the database for exactly the currencies its budgets cap", async () => {
      prisma.financeBudget.findMany.mockResolvedValue([
        budget("bgt-usd", "USD"),
        budget("bgt-legacy", null),
        budget("bgt-blank", ""),
      ]);
      prisma.financeTransaction.findMany.mockResolvedValue([]);

      await new BudgetsService(prisma).getBudgetsWithSpending("user");

      // One round trip for three budgets in two currencies, and no code the
      // budgets did not name is fetched.
      expect(prisma.financeTransaction.findMany).toHaveBeenCalledTimes(1);
      expect(
        prisma.financeTransaction.findMany.mock.calls[0][0].where.currency,
      ).toEqual({ in: ["INR", "USD"] });
    });

    it("does not let rupee spend inflate a USD cap, or the other way round", async () => {
      prisma.financeBudget.findMany.mockResolvedValue([
        budget("bgt-usd", "USD"),
        budget("bgt-inr", "INR"),
      ]);
      // A naive delegate that ignores the filter still cannot mix the buckets:
      // the per-currency grouping happens after the rows come back.
      prisma.financeTransaction.findMany.mockResolvedValue([
        expense("USD", BigInt(50000)),
        expense("INR", BigInt(25000)),
        expense("INR", BigInt(25000)),
      ]);

      const results = await new BudgetsService(prisma).getBudgetsWithSpending(
        "user",
      );

      expect(results.map((b: any) => [b.id, b.spentMinor])).toEqual([
        ["bgt-usd", 50000],
        ["bgt-inr", 50000],
      ]);
      expect(results[0].currency).toBe("USD");
      expect(results[1].currency).toBe("INR");
    });

    it("resolves a blank or missing budget currency to the INR default", async () => {
      prisma.financeBudget.findMany.mockResolvedValue([
        budget("bgt-null", null),
        budget("bgt-blank", "   "),
        budget("bgt-lower", " usd "),
      ]);
      prisma.financeTransaction.findMany.mockResolvedValue([
        expense("INR", BigInt(700)),
        expense("USD", BigInt(300)),
      ]);

      const results = await new BudgetsService(prisma).getBudgetsWithSpending(
        "user",
      );

      expect(results.map((b: any) => [b.currency, b.spentMinor])).toEqual([
        ["INR", 700],
        ["INR", 700],
        ["USD", 300],
      ]);
    });

    it("resolveCurrency is the blank-tolerant form of normaliseCurrency", () => {
      expect(normaliseCurrency(undefined)).toBe("INR");
      expect(normaliseCurrency("")).toBe("");
      expect(resolveCurrency("")).toBe("INR");
      expect(resolveCurrency(" ")).toBe("INR");
      expect(resolveCurrency(null)).toBe("INR");
      expect(resolveCurrency(" usd ")).toBe("USD");
    });
  });
});
