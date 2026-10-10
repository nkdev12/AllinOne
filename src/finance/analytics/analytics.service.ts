import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { FinanceAccountType, FinanceTransactionType } from "@prisma/client";

export interface CategorySpending {
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  iconKey: string | null;
  totalAmountMinor: number;
  percentage: number;
  transactionCount: number;
}

export interface CashFlowMonth {
  year: number;
  month: number;
  monthLabel: string;
  incomeMinor: number;
  expenseMinor: number;
  netSavingsMinor: number;
  savingsRate: number;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------
  // Spending Breakdown by Category
  // -------------------------------------------------------------

  async getSpendingByCategory(
    userId: string,
    startDateStr?: string,
    endDateStr?: string,
  ) {
    const now = new Date();
    const start = startDateStr
      ? new Date(startDateStr)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = endDateStr ? new Date(endDateStr) : now;

    const [transactions, categories] = await Promise.all([
      this.prisma.financeTransaction.findMany({
        where: {
          userId,
          type: FinanceTransactionType.EXPENSE,
          deletedAt: null,
          transactionDate: {
            gte: start,
            lte: end,
          },
        },
      }),
      this.prisma.financeCategory.findMany({
        where: {
          OR: [{ userId }, { isSystem: true }],
          deletedAt: null,
        },
      }),
    ]);

    const categoryMap = new Map<string, any>();
    for (const c of categories) {
      categoryMap.set(c.id, c);
    }

    let totalSpendingMinor = 0;
    const groupMap = new Map<
      string | null,
      { totalMinor: number; count: number }
    >();

    for (const tx of transactions) {
      const amt = Number(tx.amountMinor);
      totalSpendingMinor += amt;
      const key = tx.categoryId ?? null;
      const existing = groupMap.get(key) ?? { totalMinor: 0, count: 0 };
      existing.totalMinor += amt;
      existing.count += 1;
      groupMap.set(key, existing);
    }

    const resultCategories: CategorySpending[] = [];

    for (const [catId, stats] of groupMap.entries()) {
      const cat = catId ? categoryMap.get(catId) : null;
      const pct =
        totalSpendingMinor > 0
          ? Math.round((stats.totalMinor / totalSpendingMinor) * 10000) / 100
          : 0;

      resultCategories.push({
        categoryId: catId,
        categoryName: cat?.name ?? "Uncategorized",
        color: cat?.color ?? null,
        iconKey: cat?.iconKey ?? null,
        totalAmountMinor: stats.totalMinor,
        percentage: pct,
        transactionCount: stats.count,
      });
    }

    resultCategories.sort((a, b) => b.totalAmountMinor - a.totalAmountMinor);

    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      totalSpendingMinor,
      categories: resultCategories,
    };
  }

  // -------------------------------------------------------------
  // Cash Flow (Income vs Expense over 12 Months)
  // -------------------------------------------------------------

  async getCashFlow(userId: string, year?: number) {
    const targetYear = year ?? new Date().getFullYear();
    const start = new Date(targetYear, 0, 1);
    const end = new Date(targetYear, 11, 31, 23, 59, 59, 999);

    const transactions = await this.prisma.financeTransaction.findMany({
      where: {
        userId,
        deletedAt: null,
        transactionDate: {
          gte: start,
          lte: end,
        },
      },
    });

    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];

    const months: CashFlowMonth[] = Array.from({ length: 12 }, (_, i) => ({
      year: targetYear,
      month: i + 1,
      monthLabel: monthNames[i],
      incomeMinor: 0,
      expenseMinor: 0,
      netSavingsMinor: 0,
      savingsRate: 0,
    }));

    for (const tx of transactions) {
      const m = tx.transactionDate.getMonth();
      const amt = Number(tx.amountMinor);

      if (tx.type === FinanceTransactionType.INCOME) {
        months[m].incomeMinor += amt;
      } else if (tx.type === FinanceTransactionType.EXPENSE) {
        months[m].expenseMinor += amt;
      }
    }

    for (const m of months) {
      m.netSavingsMinor = m.incomeMinor - m.expenseMinor;
      m.savingsRate =
        m.incomeMinor > 0
          ? Math.round((m.netSavingsMinor / m.incomeMinor) * 10000) / 100
          : 0;
    }

    const totalIncomeMinor = months.reduce((acc, m) => acc + m.incomeMinor, 0);
    const totalExpenseMinor = months.reduce(
      (acc, m) => acc + m.expenseMinor,
      0,
    );
    const totalNetSavingsMinor = totalIncomeMinor - totalExpenseMinor;
    const overallSavingsRate =
      totalIncomeMinor > 0
        ? Math.round((totalNetSavingsMinor / totalIncomeMinor) * 10000) / 100
        : 0;

    return {
      year: targetYear,
      totalIncomeMinor,
      totalExpenseMinor,
      totalNetSavingsMinor,
      overallSavingsRate,
      months,
    };
  }

  // -------------------------------------------------------------
  // Net Worth (Assets vs Liabilities)
  // -------------------------------------------------------------

  async getNetWorth(userId: string) {
    const accounts = await this.prisma.financeAccount.findMany({
      where: {
        userId,
        deletedAt: null,
        isArchived: false,
      },
    });

    let totalAssetsMinor = 0;
    let totalLiabilitiesMinor = 0;

    const formattedAccounts = accounts.map((acc) => {
      const balance = Number(acc.currentBalanceMinor);
      const isLiability = acc.type === FinanceAccountType.CREDIT;

      if (isLiability) {
        totalLiabilitiesMinor += Math.abs(balance);
      } else {
        totalAssetsMinor += balance;
      }

      return {
        id: acc.id,
        name: acc.name,
        type: acc.type,
        currency: acc.currency,
        currentBalanceMinor: balance,
        isLiability,
      };
    });

    const netWorthMinor = totalAssetsMinor - totalLiabilitiesMinor;

    return {
      totalAssetsMinor,
      totalLiabilitiesMinor,
      netWorthMinor,
      currency: accounts[0]?.currency ?? "INR",
      accounts: formattedAccounts,
    };
  }

  // -------------------------------------------------------------
  // Export Transactions (JSON / CSV)
  // -------------------------------------------------------------

  async exportTransactions(
    userId: string,
    format: "json" | "csv" = "json",
    startDateStr?: string,
    endDateStr?: string,
  ) {
    const where: any = {
      userId,
      deletedAt: null,
    };

    if (startDateStr || endDateStr) {
      where.transactionDate = {};
      if (startDateStr) where.transactionDate.gte = new Date(startDateStr);
      if (endDateStr) where.transactionDate.lte = new Date(endDateStr);
    }

    const [transactions, accounts, categories] = await Promise.all([
      this.prisma.financeTransaction.findMany({
        where,
        orderBy: { transactionDate: "desc" },
      }),
      this.prisma.financeAccount.findMany({
        where: { userId },
      }),
      this.prisma.financeCategory.findMany({
        where: { OR: [{ userId }, { isSystem: true }] },
      }),
    ]);

    const accountMap = new Map<string, string>();
    for (const a of accounts) accountMap.set(a.id, a.name);

    const categoryMap = new Map<string, string>();
    for (const c of categories) categoryMap.set(c.id, c.name);

    const mapped = transactions.map((tx) => ({
      id: tx.id,
      date: tx.transactionDate.toISOString().split("T")[0],
      type: tx.type,
      title: tx.title,
      amountMinor: Number(tx.amountMinor),
      amountFormatted: (Number(tx.amountMinor) / 100).toFixed(2),
      currency: tx.currency,
      accountName: accountMap.get(tx.accountId) ?? "Unknown",
      toAccountName: tx.toAccountId
        ? (accountMap.get(tx.toAccountId) ?? "Unknown")
        : null,
      categoryName: tx.categoryId
        ? (categoryMap.get(tx.categoryId) ?? "Uncategorized")
        : "Uncategorized",
      notes: tx.notes ?? "",
    }));

    if (format === "csv") {
      const headers = [
        "Date",
        "Type",
        "Title",
        "Amount",
        "Currency",
        "Account",
        "To Account",
        "Category",
        "Notes",
      ];

      const csvRows = mapped.map((row) =>
        [
          row.date,
          row.type,
          `"${(row.title || "").replace(/"/g, '""')}"`,
          row.amountFormatted,
          row.currency,
          `"${(row.accountName || "").replace(/"/g, '""')}"`,
          `"${(row.toAccountName || "").replace(/"/g, '""')}"`,
          `"${(row.categoryName || "").replace(/"/g, '""')}"`,
          `"${(row.notes || "").replace(/"/g, '""')}"`,
        ].join(","),
      );

      return {
        format: "csv",
        contentType: "text/csv",
        content: [headers.join(","), ...csvRows].join("\n"),
        count: mapped.length,
      };
    }

    return {
      format: "json",
      contentType: "application/json",
      transactions: mapped,
      count: mapped.length,
    };
  }
}
