import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { FinanceTransactionType } from "@prisma/client";
import { EXCLUDE_BALANCE_ADJUSTMENTS } from "@/finance/finance.helpers";
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

function normaliseCurrencyCode(value?: string | null): string | undefined {
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
function parseReportDate(
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
        // Spending is what left the wallet. A Reconcile correction is booked as
        // an `EXPENSE` for the balance's sake but bought nothing, so it does not
        // belong in a category breakdown — and the clause has to be a `NOT`, or
        // every row written before the column existed vanishes from the report.
        ...EXCLUDE_BALANCE_ADJUSTMENTS,
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
      // Income and spending both exclude a balance correction: it reconciles an
      // account against the bank, it does not earn or cost anything. Negative
      // clause for the legacy-document reason — see `EXCLUDE_BALANCE_ADJUSTMENTS`.
      ...EXCLUDE_BALANCE_ADJUSTMENTS,
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

  // -------------------------------------------------------------
  // Financial Health Check (5 Vitals & Composite Grade)
  // -------------------------------------------------------------

  async getFinancialHealthCheck(userId: string, currency = "INR") {
    const requested = normaliseCurrencyCode(currency) ?? "INR";

    const [accounts, loans, budgets, categories] = await Promise.all([
      this.prisma.financeAccount.findMany({
        where: {
          userId,
          deletedAt: null,
          isArchived: false,
          currency: requested,
        },
      }),
      this.prisma.financeLoan.findMany({
        where: { userId, deletedAt: null, isSettled: false },
      }),
      this.prisma.financeBudget.findMany({
        where: { userId, deletedAt: null },
      }),
      this.prisma.financeCategory.findMany({
        where: { OR: [{ userId }, { isSystem: true }] },
      }),
    ]);

    // Read last 90 days of transactions for baseline cash flow
    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * MS_PER_DAY);
    const { rows: txns } = await this.fetchTransactions({
      userId,
      // The five vitals read savings rate, essential ratio and burn off these
      // rows, and every one of them means cash that actually moved in or out. A
      // reconcile correction would inflate all three. Excluded from the fetch
      // rather than from each loop, so the budget-adherence filter below — which
      // walks the same `txns` — inherits the exclusion instead of repeating it.
      ...EXCLUDE_BALANCE_ADJUSTMENTS,
      deletedAt: null,
      currency: requested,
      transactionDate: { gte: ninetyDaysAgo },
    });

    const categoryMap = new Map<string, string>();
    for (const c of categories) categoryMap.set(c.id, c.name.toLowerCase());

    const essentialKeywords = [
      "rent",
      "mortgage",
      "housing",
      "grocer",
      "food",
      "utilit",
      "electric",
      "water",
      "gas",
      "bill",
      "internet",
      "wifi",
      "broadband",
      "health",
      "medic",
      "doctor",
      "pharmacy",
      "insuran",
      "tax",
      "educat",
      "tuition",
      "transport",
      "transit",
      "fuel",
      "petrol",
    ];

    let totalIncomeMinor = 0;
    let totalExpenseMinor = 0;
    let essentialExpenseMinor = 0;

    for (const tx of txns) {
      const amt = Number(tx.amountMinor);
      if (tx.type === FinanceTransactionType.INCOME) {
        totalIncomeMinor += amt;
      } else if (tx.type === FinanceTransactionType.EXPENSE) {
        totalExpenseMinor += amt;
        const catName = tx.categoryId
          ? (categoryMap.get(tx.categoryId) ?? "")
          : "";
        if (essentialKeywords.some((kw) => catName.includes(kw))) {
          essentialExpenseMinor += amt;
        }
      }
    }

    // Liquid savings
    let liquidSavingsMinor = 0;
    for (const acc of accounts) {
      const bal = Number(acc.currentBalanceMinor);
      if (
        bal > 0 &&
        (acc.type === "BANK" ||
          acc.type === "CASH" ||
          acc.type === "SAVINGS" ||
          acc.type === "WALLET")
      ) {
        liquidSavingsMinor += bal;
      }
    }

    // Remaining borrowed debt
    let remainingBorrowedMinor = 0;
    for (const loan of loans) {
      if (loan.type === "BORROWED") {
        remainingBorrowedMinor += Math.max(
          0,
          Number(loan.remainingAmountMinor),
        );
      }
    }

    // Indicator 1: Savings rate
    const savingsRate =
      totalIncomeMinor > 0
        ? roundRatioToPercent(
            totalIncomeMinor - totalExpenseMinor,
            totalIncomeMinor,
          )
        : 0;
    let savingsScore = 50;
    let savingsStatus: "healthy" | "moderate" | "needsAttention" = "moderate";
    let savingsDesc = "No income recorded this period.";
    let savingsRec =
      "Record your regular income or paycheck to establish an accurate savings baseline.";

    if (totalIncomeMinor > 0) {
      if (savingsRate >= 20) {
        savingsScore = Math.min(100, Math.round(70 + (savingsRate - 20) * 1.5));
        savingsStatus = "healthy";
        savingsDesc = `You saved ${savingsRate}% of your income, comfortably above the 20% healthy benchmark.`;
        savingsRec =
          "Consider directing surplus savings toward long-term goals or an interest-bearing account.";
      } else if (savingsRate >= 5) {
        savingsScore = Math.round(40 + (savingsRate / 20) * 30);
        savingsStatus = "moderate";
        savingsDesc = `You saved ${savingsRate}% of your income, positive but below the recommended 20% target.`;
        savingsRec =
          "Review flexible spending categories to gradually lift your savings rate closer to 20%.";
      } else {
        savingsScore = savingsRate <= 0 ? 15 : 30;
        savingsStatus = "needsAttention";
        savingsDesc =
          savingsRate <= 0
            ? `Spending exceeded earnings by ${Math.abs(totalIncomeMinor - totalExpenseMinor)} minor units.`
            : `Savings rate is only ${savingsRate}%, leaving little margin for error.`;
        savingsRec =
          "Pause discretionary spending until expenses fall back below incoming earnings.";
      }
    }

    // Indicator 2: Essential Expenses
    const essentialRatio =
      totalIncomeMinor > 0
        ? roundRatioToPercent(essentialExpenseMinor, totalIncomeMinor)
        : totalExpenseMinor > 0
          ? 100
          : 0;
    let essentialScore = 75;
    let essentialStatus: "healthy" | "moderate" | "needsAttention" = "healthy";
    let essentialDesc = "No living expenses recorded yet for this period.";
    let essentialRec =
      "Categorize your bills, groceries, and housing to track your baseline living costs.";

    if (totalIncomeMinor > 0 || totalExpenseMinor > 0) {
      if (essentialRatio <= 50) {
        essentialScore = 90;
        essentialStatus = "healthy";
        essentialDesc = `Essential living expenses take up ${essentialRatio}% of earnings, within the healthy 50% guideline.`;
        essentialRec = "Your core cost of living is lean and sustainable.";
      } else if (essentialRatio <= 70) {
        essentialScore = 60;
        essentialStatus = "moderate";
        essentialDesc = `Essentials consume ${essentialRatio}% of income, leaving moderate breathing room.`;
        essentialRec =
          "Check if utility, subscription, or grocery bills can be trimmed without sacrificing comfort.";
      } else {
        essentialScore = 30;
        essentialStatus = "needsAttention";
        essentialDesc = `Core expenses consume ${essentialRatio}% of earnings, creating high financial fixed overhead.`;
        essentialRec =
          "Look for ways to reduce fixed recurring overheads (rent, subscriptions, utilities) to lower baseline stress.";
      }
    }

    // Indicator 3: Debt Burden
    let debtScore = 100;
    let debtStatus: "healthy" | "moderate" | "needsAttention" = "healthy";
    let debtDesc =
      "You have zero active borrowed debts recorded in your ledger.";
    let debtRec =
      "Maintain your debt-free status and avoid unnecessary high-interest liabilities.";

    if (remainingBorrowedMinor > 0) {
      const monthlyRef =
        totalIncomeMinor > 0 ? totalIncomeMinor / 3 : totalExpenseMinor / 3;
      if (monthlyRef > 0 && remainingBorrowedMinor <= monthlyRef) {
        debtScore = 80;
        debtStatus = "healthy";
        debtDesc =
          "Outstanding borrowed debt is under 1 month of earnings, keeping debt risk low.";
        debtRec = "Pay down this debt promptly to clear all obligations.";
      } else if (monthlyRef > 0 && remainingBorrowedMinor <= monthlyRef * 3) {
        debtScore = 55;
        debtStatus = "moderate";
        debtDesc =
          "Outstanding borrowed debt is moderate relative to your cash flow.";
        debtRec =
          "Set a structured repayment plan to avoid letting interest or repayment deadlines accumulate.";
      } else {
        debtScore = 30;
        debtStatus = "needsAttention";
        debtDesc = "Total borrowed debt poses a notable financial liability.";
        debtRec =
          "Focus on high-cost loan repayments first before allocating funds to non-essential spending.";
      }
    }

    // Indicator 4: Emergency Savings Runway
    const monthlyBurn = totalExpenseMinor > 0 ? totalExpenseMinor / 3 : 1;
    const runwayMonths =
      Math.round((liquidSavingsMinor / monthlyBurn) * 10) / 10;
    let runwayScore = 20;
    let runwayStatus: "healthy" | "moderate" | "needsAttention" =
      "needsAttention";
    let runwayDesc = `Liquid emergency savings cover less than 1 month of typical expenses (${runwayMonths} mo).`;
    let runwayRec =
      "Building an initial emergency safety net should be your top financial priority.";

    if (runwayMonths >= 6) {
      runwayScore = 100;
      runwayStatus = "healthy";
      runwayDesc = `Your liquid savings cover ${runwayMonths} months of typical expenses, providing a bulletproof safety cushion.`;
      runwayRec =
        "You have achieved the gold standard 6-month emergency buffer.";
    } else if (runwayMonths >= 3) {
      runwayScore = 80;
      runwayStatus = "healthy";
      runwayDesc = `You have ${runwayMonths} months of emergency buffer in liquid accounts, meeting the standard 3-month safety mark.`;
      runwayRec =
        "Aim to gradually build toward 6 months for added peace of mind.";
    } else if (runwayMonths >= 1) {
      runwayScore = 50;
      runwayStatus = "moderate";
      runwayDesc = `Liquid savings cover ${runwayMonths} month(s) of expenses. A minor disruption could strain your finances.`;
      runwayRec =
        "Channel extra savings to build your emergency fund to at least 3 months of basic living costs.";
    }

    // Indicator 5: Budget Adherence
    let budgetScore = 70;
    let budgetStatus: "healthy" | "moderate" | "needsAttention" = "healthy";
    let budgetDesc = "No monthly category budgets are set up yet.";
    let budgetRec = "Creating spending budgets helps keep costs predictable.";
    let adherenceRate = 100;

    if (budgets.length > 0) {
      const currentMonthStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      const currentMonthTxns = txns.filter(
        (t) =>
          t.transactionDate >= currentMonthStart &&
          t.type === FinanceTransactionType.EXPENSE,
      );
      const spentByCat = new Map<string, number>();
      for (const t of currentMonthTxns) {
        if (t.categoryId) {
          spentByCat.set(
            t.categoryId,
            (spentByCat.get(t.categoryId) ?? 0) + Number(t.amountMinor),
          );
        }
      }
      let onTrack = 0;
      for (const b of budgets) {
        const spent = b.categoryId ? (spentByCat.get(b.categoryId) ?? 0) : 0;
        if (spent <= Number(b.amountMinor)) onTrack++;
      }
      adherenceRate = Math.round((onTrack / budgets.length) * 100);
      if (adherenceRate >= 85) {
        budgetScore = 95;
        budgetStatus = "healthy";
        budgetDesc = `${onTrack} of ${budgets.length} budgets are currently on track (${adherenceRate}% adherence).`;
        budgetRec = "Great job staying disciplined with your spending limits.";
      } else if (adherenceRate >= 60) {
        budgetScore = 65;
        budgetStatus = "moderate";
        budgetDesc = `${onTrack} of ${budgets.length} budgets remain within limit (${adherenceRate}% adherence).`;
        budgetRec =
          "Slow down purchases in categories that have exceeded or are near 100% of their limit.";
      } else {
        budgetScore = 35;
        budgetStatus = "needsAttention";
        budgetDesc = `Only ${onTrack} of ${budgets.length} budgets are within limit (${adherenceRate}% adherence).`;
        budgetRec =
          "Review overspent categories and adjust spending habits or rebalance limits to match reality.";
      }
    }

    const overallScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          savingsScore * 0.25 +
            essentialScore * 0.2 +
            debtScore * 0.2 +
            runwayScore * 0.2 +
            budgetScore * 0.15,
        ),
      ),
    );

    let grade: "strong" | "stable" | "needsAttention" = "stable";
    let summaryTitle = "Stable Foundation";
    let summaryDesc =
      "Your finances are functioning steadily, with clear opportunities to boost emergency savings or trim expenses.";

    if (overallScore >= 75) {
      grade = "strong";
      summaryTitle = "Strong & Resilient";
      summaryDesc =
        "Your money vitals are in excellent shape with strong savings, low debt, and an active safety buffer.";
    } else if (overallScore < 50) {
      grade = "needsAttention";
      summaryTitle = "Needs Attention";
      summaryDesc =
        "High fixed commitments, debt burden, or low emergency savings indicate vulnerability to unexpected financial shocks.";
    }

    const actionItems: string[] = [];
    if (savingsStatus !== "healthy") actionItems.push(savingsRec);
    if (essentialStatus !== "healthy") actionItems.push(essentialRec);
    if (debtStatus !== "healthy") actionItems.push(debtRec);
    if (runwayStatus !== "healthy") actionItems.push(runwayRec);
    if (budgetStatus !== "healthy") actionItems.push(budgetRec);
    if (actionItems.length === 0) {
      actionItems.push(
        "Keep up your healthy financial routine and periodically review your savings goals.",
      );
    }

    return {
      currency: requested,
      overallScore,
      grade,
      summaryTitle,
      summaryDescription: summaryDesc,
      indicators: {
        savingsRate: {
          name: "Savings Rate",
          valueDisplay: `${savingsRate}%`,
          score: savingsScore,
          status: savingsStatus,
          explanation: savingsDesc,
          recommendation: savingsRec,
        },
        essentialExpenses: {
          name: "Essential Living Costs",
          valueDisplay: `${essentialRatio}% of income`,
          score: essentialScore,
          status: essentialStatus,
          explanation: essentialDesc,
          recommendation: essentialRec,
        },
        debtBurden: {
          name: "Debt Burden",
          valueDisplay:
            remainingBorrowedMinor === 0
              ? "Debt Free"
              : `${remainingBorrowedMinor}`,
          score: debtScore,
          status: debtStatus,
          explanation: debtDesc,
          recommendation: debtRec,
        },
        emergencyRunway: {
          name: "Emergency Savings Buffer",
          valueDisplay: `${runwayMonths} months`,
          score: runwayScore,
          status: runwayStatus,
          explanation: runwayDesc,
          recommendation: runwayRec,
        },
        budgetAdherence: {
          name: "Budget Discipline",
          valueDisplay:
            budgets.length === 0
              ? "Not Configured"
              : `${adherenceRate}% on track`,
          score: budgetScore,
          status: budgetStatus,
          explanation: budgetDesc,
          recommendation: budgetRec,
        },
      },
      actionItems,
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
