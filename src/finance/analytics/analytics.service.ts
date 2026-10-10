import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { FinanceTransactionType } from "@prisma/client";
import { ErrorCode } from "@/common/errors/error-code";
import { badRequest } from "@/common/errors/http-errors";

export interface CategorySpending {
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  iconKey: string | null;
  totalAmountMinor: number;
  percentage: number;
  transactionCount: number;
}

/**
 * One currency's slice of a report. Minor units only ever add up inside their
 * own currency, so every aggregate these endpoints return is bucketed this way
 * and the long-standing top-level keys are one of these buckets.
 */
export interface CategoryCurrencyBucket {
  currency: string;
  totalSpendingMinor: number;
  categories: CategorySpending[];
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

export interface CashFlowCurrencyBucket {
  currency: string;
  totalIncomeMinor: number;
  totalExpenseMinor: number;
  totalNetSavingsMinor: number;
  overallSavingsRate: number;
  months: CashFlowMonth[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Rows per round-trip for the paging loops below. The reports used to be one
 * `findMany` with no `take`, i.e. the user's whole transaction history
 * materialised in Node on every dashboard paint, from an endpoint any signed-in
 * device can call repeatedly.
 */
const READ_PAGE_SIZE = 500;

/**
 * Ceiling on the paging loop, so a pathological store cannot spin one request
 * out forever. Reaching it is reported (`truncated: true`) instead of being
 * passed off as a complete figure.
 */
const MAX_READ_PAGES = 100;

/**
 * How many minor units make one major unit, per currency.
 *
 * The export divided every row by 100 and put it in a column called `Amount`,
 * which read a JPY 100 (zero decimals, so: one hundred yen) as 1.00 — one column
 * carrying two different scales. Where the exponent is unknown the row is only
 * ever returned in minor units.
 */
const MINOR_UNITS_PER_MAJOR: Record<string, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  SGD: 2,
  AED: 2,
  SAR: 2,
  ZAR: 2,
  RUB: 2,
  TRY: 2,
  BRL: 2,
  MXN: 2,
  NZD: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  PYG: 0,
  UGX: 0,
  RWF: 0,
  XAF: 0,
  XOF: 0,
};

export function normaliseCurrencyCode(
  value?: string | null,
): string | undefined {
  const trimmed = (value ?? "").trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function minorUnits(value: unknown): bigint {
  return typeof value === "bigint"
    ? value
    : BigInt(Math.round(Number(value ?? 0)));
}

function utcStartOfCurrentMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Analytics windows are UTC, the convention `budgets.service.ts` moved to in
 * this session, so the two reports now bucket the same row in the same month.
 * Local `getMonth()`/`getFullYear()` put a +05:30 user's first six hours of a
 * month into the previous one, which made the category report and the budget
 * report disagree on the first day of every month.
 */
export function parseReportDate(
  raw: string | undefined,
  field: "startDate" | "endDate",
  inclusiveEndOfDay = false,
): Date | undefined {
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest(
      ErrorCode.VALIDATION_ERROR,
      `${field}: must be an ISO 8601 date.`,
      { field, value: raw },
    );
  }
  // A bare `YYYY-MM-DD` names a calendar day, not an instant: Node reads it as
  // UTC midnight, so an upper bound has to cover that whole UTC day or every
  // transaction later in the day is silently dropped.
  if (inclusiveEndOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(parsed.getTime() + MS_PER_DAY - 1);
  }
  return parsed;
}

/**
 * Largest-remainder allocation, in hundredths of a percent.
 *
 * Rounding each share on its own never adds up: three equal categories came to
 * 33.33 + 33.33 + 33.33 = 99.99, and a pie drawn from those slices keeps a hole
 * the size of the rounding. The leftover hundredths go to the largest fractional
 * parts first, ties broken by input order, so the slices sum to exactly 100.00
 * and the same input always yields the same allocation.
 */
export function allocatePercentages(
  parts: readonly bigint[],
  total: bigint,
): number[] {
  const HUNDREDTHS = 10000n; // 100.00% in units of 0.01%
  if (parts.length === 0 || total <= 0n) return parts.map(() => 0);

  const allocated = parts.map((part) => (part * HUNDREDTHS) / total);
  let remaining =
    HUNDREDTHS - allocated.reduce((acc, value) => acc + value, 0n);

  const byRemainder = parts
    .map((part, index) => ({ index, remainder: (part * HUNDREDTHS) % total }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1,
    );

  // One pass is all a well-formed split needs, because the floors are short by
  // less than one slice per part. The cyclic form and the step cap only matter
  // for a signed part — a refund bigger than its own category — where the
  // floors can undershoot by more than `parts.length`.
  let step = 0;
  while (remaining > 0n && byRemainder.length > 0 && step < 10000) {
    allocated[byRemainder[step % byRemainder.length].index] += 1n;
    remaining -= 1n;
    step += 1;
  }

  return allocated.map((value) => Number(value) / 100);
}

/**
 * Exact minor units as a decimal string, built from `bigint` so a row past
 * 2^53 — which `Number()` rounds without telling anyone — still exports the
 * amount the ledger holds. Returns `null` for an unknown currency exponent
 * rather than guessing that it is 2.
 */
export function formatMinorUnits(
  minor: bigint,
  currency: string,
): string | null {
  const scale = MINOR_UNITS_PER_MAJOR[normaliseCurrencyCode(currency) ?? ""];
  if (scale === undefined) return null;
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const sign = negative ? "-" : "";
  if (scale === 0) return `${sign}${absolute.toString()}`;
  const base = 10n ** BigInt(scale);
  const whole = (absolute / base).toString();
  const fraction = (absolute % base).toString().padStart(scale, "0");
  return `${sign}${whole}.${fraction}`;
}

function roundRatioToPercent(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 10000) / 100;
}

function escapeCsv(value: string | null | undefined): string {
  return `"${(value ?? "").replace(/"/g, '""')}"`;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------
  // Spending Breakdown by Category
  // -------------------------------------------------------------

  /**
   * `currency` is a filter, not an assumption. Left out, the report reads every
   * currency the user has and answers per currency; it used to default to INR,
   * which returned a confidently empty breakdown for a USD-only user.
   */
  async getSpendingByCategory(
    userId: string,
    startDateStr?: string,
    endDateStr?: string,
    currency?: string,
  ) {
    const requested = normaliseCurrencyCode(currency);
    const now = new Date();
    const start =
      parseReportDate(startDateStr, "startDate") ?? utcStartOfCurrentMonth(now);
    const end = parseReportDate(endDateStr, "endDate", true) ?? now;

    const [{ rows, truncated }, categories] = await Promise.all([
      this.fetchTransactions({
        userId,
        type: FinanceTransactionType.EXPENSE,
        deletedAt: null,
        ...(requested ? { currency: requested } : {}),
        transactionDate: { gte: start, lte: end },
      }),
      this.prisma.financeCategory.findMany({
        where: {
          OR: [{ userId }, { isSystem: true }],
          deletedAt: null,
        },
      }),
    ]);

    const categoryMap = new Map<string, any>();
    for (const c of categories) categoryMap.set(c.id, c);

    // currency -> categoryId|null -> { totalMinor, count }
    const perCurrency = new Map<
      string,
      Map<string | null, { totalMinor: bigint; count: number }>
    >();

    for (const tx of rows) {
      const code = normaliseCurrencyCode(tx.currency) ?? "INR";
      let byCategory = perCurrency.get(code);
      if (!byCategory) {
        byCategory = new Map();
        perCurrency.set(code, byCategory);
      }
      const key = tx.categoryId ?? null;
      const existing = byCategory.get(key) ?? { totalMinor: 0n, count: 0 };
      existing.totalMinor += minorUnits(tx.amountMinor);
      existing.count += 1;
      byCategory.set(key, existing);
    }

    const buckets: CategoryCurrencyBucket[] = [];
    for (const [code, byCategory] of perCurrency.entries()) {
      const entries = [...byCategory.entries()];
      const totalMinor = entries.reduce(
        (acc, [, stats]) => acc + stats.totalMinor,
        0n,
      );
      const percentages = allocatePercentages(
        entries.map(([, stats]) => stats.totalMinor),
        totalMinor,
      );

      const formatted: CategorySpending[] = entries.map(
        ([catId, stats], index) => {
          const cat = catId ? categoryMap.get(catId) : null;
          return {
            categoryId: catId,
            categoryName: cat?.name ?? "Uncategorized",
            color: cat?.color ?? null,
            iconKey: cat?.iconKey ?? null,
            totalAmountMinor: Number(stats.totalMinor),
            percentage: percentages[index],
            transactionCount: stats.count,
          };
        },
      );
      formatted.sort((a, b) => b.totalAmountMinor - a.totalAmountMinor);

      buckets.push({
        currency: code,
        totalSpendingMinor: Number(totalMinor),
        categories: formatted,
      });
    }

    buckets.sort((a, b) => b.totalSpendingMinor - a.totalSpendingMinor);

    // The keys this endpoint has always returned now describe one real bucket:
    // the requested currency when it was filtered, otherwise the largest one. A
    // caller that knows nothing about `byCurrency` therefore still gets a figure
    // labelled with the currency it is in, instead of zeros or a cross-currency
    // sum that means nothing.
    let primary = buckets.find((bucket) => bucket.currency === requested);
    if (!primary) primary = buckets[0];
    if (!primary) {
      primary = {
        currency: requested ?? "INR",
        totalSpendingMinor: 0,
        categories: [],
      };
    }

    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      currency: primary.currency,
      totalSpendingMinor: primary.totalSpendingMinor,
      categories: primary.categories,
      byCurrency: buckets,
      mixedCurrencies: buckets.length > 1,
      truncated,
    };
  }

  // -------------------------------------------------------------
  // Cash Flow (Income vs Expense over 12 Months)
  // -------------------------------------------------------------

  async getCashFlow(userId: string, year?: number, currency?: string) {
    const requested = normaliseCurrencyCode(currency);
    // No `parseInt`-shaped hole left on this path either: `NaN` used to reach
    // `new Date(NaN, 0, 1)` and come back as an Invalid Date, which the database
    // rejects as a 500 over what is really a typo in the query string.
    if (
      year !== undefined &&
      (!Number.isInteger(year) || year < 1970 || year > 2100)
    ) {
      throw badRequest(
        ErrorCode.VALIDATION_ERROR,
        "year: must be an integer between 1970 and 2100.",
        { field: "year", value: year },
      );
    }

    const targetYear = year ?? new Date().getUTCFullYear();
    const start = new Date(Date.UTC(targetYear, 0, 1));
    const endExclusive = new Date(Date.UTC(targetYear + 1, 0, 1));

    const { rows, truncated } = await this.fetchTransactions({
      userId,
      deletedAt: null,
      ...(requested ? { currency: requested } : {}),
      transactionDate: { gte: start, lt: endExclusive },
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

    const emptyMonths = (): CashFlowMonth[] =>
      Array.from({ length: 12 }, (_, i) => ({
        year: targetYear,
        month: i + 1,
        monthLabel: monthNames[i],
        incomeMinor: 0,
        expenseMinor: 0,
        netSavingsMinor: 0,
        savingsRate: 0,
      }));

    // currency -> twelve months of income/expense, accumulated in minor
    // `bigint`s so a year of rows adds exactly and converts once.
    const perCurrency = new Map<
      string,
      { income: bigint[]; expense: bigint[] }
    >();

    for (const tx of rows) {
      const code = normaliseCurrencyCode(tx.currency) ?? "INR";
      let acc = perCurrency.get(code);
      if (!acc) {
        acc = {
          income: Array.from({ length: 12 }, () => 0n),
          expense: Array.from({ length: 12 }, () => 0n),
        };
        perCurrency.set(code, acc);
      }

      const monthIndex = tx.transactionDate.getUTCMonth();
      const amount = minorUnits(tx.amountMinor);
      if (tx.type === FinanceTransactionType.INCOME) {
        acc.income[monthIndex] += amount;
      } else if (tx.type === FinanceTransactionType.EXPENSE) {
        acc.expense[monthIndex] += amount;
      }
    }

    const buckets: CashFlowCurrencyBucket[] = [];
    for (const [code, acc] of perCurrency.entries()) {
      const months = emptyMonths();
      for (let i = 0; i < 12; i++) {
        months[i].incomeMinor = Number(acc.income[i]);
        months[i].expenseMinor = Number(acc.expense[i]);
        months[i].netSavingsMinor =
          months[i].incomeMinor - months[i].expenseMinor;
        months[i].savingsRate =
          acc.income[i] > 0n
            ? roundRatioToPercent(
                months[i].netSavingsMinor,
                months[i].incomeMinor,
              )
            : 0;
      }
      const totalIncomeMinor = months.reduce((a, m) => a + m.incomeMinor, 0);
      const totalExpenseMinor = months.reduce((a, m) => a + m.expenseMinor, 0);
      const totalNetSavingsMinor = totalIncomeMinor - totalExpenseMinor;
      buckets.push({
        currency: code,
        totalIncomeMinor,
        totalExpenseMinor,
        totalNetSavingsMinor,
        overallSavingsRate:
          totalIncomeMinor > 0
            ? roundRatioToPercent(totalNetSavingsMinor, totalIncomeMinor)
            : 0,
        months,
      });
    }

    buckets.sort((a, b) => b.totalIncomeMinor - a.totalIncomeMinor);

    let primary = buckets.find((bucket) => bucket.currency === requested);
    if (!primary) primary = buckets[0];
    if (!primary) {
      primary = {
        currency: requested ?? "INR",
        totalIncomeMinor: 0,
        totalExpenseMinor: 0,
        totalNetSavingsMinor: 0,
        overallSavingsRate: 0,
        months: emptyMonths(),
      };
    }

    return {
      year: targetYear,
      // Kept: the twelve-month figures of `primary`, i.e. of the same single
      // currency the `months` array belongs to.
      totalIncomeMinor: primary.totalIncomeMinor,
      totalExpenseMinor: primary.totalExpenseMinor,
      totalNetSavingsMinor: primary.totalNetSavingsMinor,
      currency: primary.currency,
      overallSavingsRate: primary.overallSavingsRate,
      months: primary.months,
      byCurrency: buckets,
      mixedCurrencies: buckets.length > 1,
      truncated,
    };
  }

  // -------------------------------------------------------------
  // Net Worth (Assets vs Liabilities)
  // -------------------------------------------------------------

  async getNetWorth(userId: string, currency = "INR") {
    currency = currency.toUpperCase();
    const [accounts, loans] = await Promise.all([
      this.prisma.financeAccount.findMany({
        where: { userId, deletedAt: null, isArchived: false, currency },
      }),
      // Loan records currently use INR; they have no currency field.
      currency === "INR"
        ? this.prisma.financeLoan.findMany({
            where: { userId, deletedAt: null, isSettled: false },
          })
        : Promise.resolve([]),
    ]);
    let totalAssetsMinor = 0;
    let totalLiabilitiesMinor = 0;
    const formattedAccounts = accounts.map((acc) => {
      const balance = Number(acc.currentBalanceMinor);
      // All account balances are signed, including credit and overdrafts.
      if (balance >= 0) totalAssetsMinor += balance;
      else totalLiabilitiesMinor -= balance;
      return {
        id: acc.id,
        name: acc.name,
        type: acc.type,
        currency: acc.currency,
        currentBalanceMinor: balance,
        isLiability: balance < 0,
      };
    });
    let remainingLentMinor = 0;
    let remainingBorrowedMinor = 0;
    for (const loan of loans) {
      if (loan.deletedAt || loan.isSettled) continue;
      const remaining = Math.max(0, Number(loan.remainingAmountMinor));
      if (loan.type === "LENT") remainingLentMinor += remaining;
      if (loan.type === "BORROWED") remainingBorrowedMinor += remaining;
    }
    totalAssetsMinor += remainingLentMinor;
    totalLiabilitiesMinor += remainingBorrowedMinor;
    return {
      totalAssetsMinor,
      totalLiabilitiesMinor,
      netWorthMinor: totalAssetsMinor - totalLiabilitiesMinor,
      remainingLentMinor,
      remainingBorrowedMinor,
      currency,
      accounts: formattedAccounts,
    };
  }

  // -------------------------------------------------------------
  // Export Transactions (JSON / CSV)
  // -------------------------------------------------------------

  /**
   * `currency` filters the export the way it filters the reports, and the rows
   * keep their own scale: every row travels with exact minor units plus a
   * currency column, and the decimal `Amount` only appears when the row's own
   * currency says how many minor units make a major one. A JPY row is no longer
   * printed as a hundredth of what it is.
   */
  async exportTransactions(
    userId: string,
    format: "json" | "csv" = "json",
    startDateStr?: string,
    endDateStr?: string,
    currency?: string,
  ) {
    const requested = normaliseCurrencyCode(currency);
    const where: Record<string, unknown> = {
      userId,
      deletedAt: null,
      ...(requested ? { currency: requested } : {}),
    };

    const startDate = parseReportDate(startDateStr, "startDate");
    const endDate = parseReportDate(endDateStr, "endDate", true);
    if (startDate || endDate) {
      const range: Record<string, Date> = {};
      if (startDate) range.gte = startDate;
      if (endDate) range.lte = endDate;
      where.transactionDate = range;
    }

    const [paged, accounts, categories] = await Promise.all([
      this.fetchTransactions(where, "desc"),
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

    const mapped = paged.rows.map((tx) => {
      const amountMinor = minorUnits(tx.amountMinor);
      const formatted = formatMinorUnits(amountMinor, tx.currency);
      const code = normaliseCurrencyCode(tx.currency) ?? "";
      const scale = MINOR_UNITS_PER_MAJOR[code];
      return {
        id: tx.id,
        date: tx.transactionDate.toISOString().split("T")[0],
        type: tx.type,
        title: tx.title,
        // Exact, as a string: `Number(9007199254740993n)` is 9007199254740992,
        // and an export is the user's copy of the ledger, not a chart.
        amountMinor: amountMinor.toString(),
        currency: tx.currency,
        // Null when the currency's exponent is unknown, so nothing here is a
        // re-reading of the number under a scale nobody agreed to.
        amount: formatted,
        amountScale: scale ?? null,
        accountName: accountMap.get(tx.accountId) ?? "Unknown",
        toAccountName: tx.toAccountId
          ? (accountMap.get(tx.toAccountId) ?? "Unknown")
          : null,
        categoryName: tx.categoryId
          ? (categoryMap.get(tx.categoryId) ?? "Uncategorized")
          : "Uncategorized",
        notes: tx.notes ?? "",
      };
    });

    if (format === "csv") {
      const headers = [
        "Date",
        "Type",
        "Title",
        "Amount",
        "AmountMinor",
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
          escapeCsv(row.title),
          // Blank rather than divided-by-100 when the scale is unknown.
          row.amount ?? "",
          row.amountMinor,
          row.currency,
          escapeCsv(row.accountName),
          escapeCsv(row.toAccountName ?? ""),
          escapeCsv(row.categoryName),
          escapeCsv(row.notes),
        ].join(","),
      );

      return {
        format: "csv",
        contentType: "text/csv",
        content: [headers.join(","), ...csvRows].join("\n"),
        count: mapped.length,
        truncated: paged.truncated,
      };
    }

    return {
      format: "json",
      contentType: "application/json",
      transactions: mapped,
      count: mapped.length,
      truncated: paged.truncated,
    };
  }

  /**
   * Reads every row matching `where` in bounded pages instead of one unbounded
   * `findMany`.
   *
   * The keyset is on `id`, not on the report's own ordering: `id` is unique, so
   * `id > lastId` can neither skip nor repeat a row when two transactions share
   * a `transactionDate` — which a date-ordered page would. The caller's ordering
   * is re-applied to the collected rows afterwards.
   */
  private async fetchTransactions(
    where: Record<string, unknown>,
    orderByDate?: "asc" | "desc",
  ): Promise<{ rows: any[]; truncated: boolean }> {
    const rows: any[] = [];
    let afterId: string | undefined;

    for (let page = 0; page < MAX_READ_PAGES; page++) {
      const batch = await this.prisma.financeTransaction.findMany({
        where: {
          ...where,
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        orderBy: { id: "asc" },
        take: READ_PAGE_SIZE,
      });
      rows.push(...batch);
      if (batch.length < READ_PAGE_SIZE) {
        return { rows: finish(rows, orderByDate), truncated: false };
      }
      afterId = batch[batch.length - 1].id;
    }

    this.logger.warn(
      `Analytics read for user ${String(where.userId)} stopped at the ${
        MAX_READ_PAGES * READ_PAGE_SIZE
      }-row ceiling; the result is marked truncated.`,
    );
    return { rows: finish(rows, orderByDate), truncated: true };
  }
}

function finish(rows: any[], orderByDate?: "asc" | "desc"): any[] {
  if (!orderByDate) return rows;
  const sign = orderByDate === "desc" ? -1 : 1;
  return rows.sort(
    (a, b) =>
      sign * (a.transactionDate.getTime() - b.transactionDate.getTime()),
  );
}
