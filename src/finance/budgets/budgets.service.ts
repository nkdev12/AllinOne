import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import { CreateBudgetDto } from "./dto/create-budget.dto";
import { UpdateBudgetDto } from "./dto/update-budget.dto";
import { appendChange } from "@/sync/change-cursor";
import { toDateOrThrow, toMinorUnits } from "@/finance/finance.helpers";
import {
  ChangeOperation,
  FinanceBudgetPeriod,
  FinanceTransactionType,
} from "@prisma/client";

/**
 * Spend is only ever summed over transactions in this currency.
 *
 * `FinanceBudget` carries no currency column, so a budget cannot express which
 * currency it caps. Rather than guess per row, the spend query stays pinned to
 * the one currency every account is seeded with. Adding the column is a schema
 * decision (`prisma db push`), not a service fix, so the limitation is stated
 * here in a single place instead of being scattered through the filter: a budget
 * meant for a USD account currently measures nothing.
 */
const BUDGET_SPEND_CURRENCY = "INR";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type BudgetSpendWindow = { start: Date; end: Date };

/**
 * The calendar cycle the spend windows are anchored to. `monthOneBased` is 1 =
 * January: the HTTP layer, this service and every window derived below speak the
 * same 1-based convention, and the only places the 0-based `Date`/`Date.UTC`
 * index appears are the `- 1` conversions in `utcCycleWindow` and the quarter
 * maths. Everything is UTC — the local `getFullYear()`/`getMonth()` pair
 * disagreed with the UTC buckets the alert cycle and analytics use either side
 * of a month boundary in +05:30.
 */
type ReferenceCycle = {
  year: number;
  monthOneBased: number;
  anchor: Date;
};

function utcStartOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** Exclusive upper bound for a day that is stored as an inclusive date. */
function nextUtcDay(startOfDay: Date): Date {
  return new Date(startOfDay.getTime() + MS_PER_DAY);
}

function utcCycleWindow(
  year: number,
  monthOneBased: number,
): BudgetSpendWindow {
  return {
    start: new Date(Date.UTC(year, monthOneBased - 1, 1)),
    end: new Date(Date.UTC(year, monthOneBased, 1)),
  };
}

/**
 * The window a budget's cap applies to, derived from the budget itself.
 *
 * `end` is exclusive. A CUSTOM budget lives between its own `startDate` and
 * `endDate` (inclusive day boundaries); every other period rolls up from the
 * reference cycle, and `startDate`/`endDate` then clamp that cycle so spend from
 * before the budget existed, or after it ended, is not charged to it.
 */
function resolveBudgetSpendWindow(
  budget: {
    period?: FinanceBudgetPeriod | null;
    startDate?: Date | null;
    endDate?: Date | null;
  },
  cycle: ReferenceCycle,
): BudgetSpendWindow {
  const period = budget.period ?? FinanceBudgetPeriod.MONTHLY;
  const monthly = utcCycleWindow(cycle.year, cycle.monthOneBased);
  let window: BudgetSpendWindow;

  switch (period) {
    case FinanceBudgetPeriod.WEEKLY: {
      const isoWeekday = (cycle.anchor.getUTCDay() + 6) % 7; // Monday = 0
      const start = new Date(
        utcStartOfDay(cycle.anchor).getTime() - isoWeekday * MS_PER_DAY,
      );
      window = { start, end: new Date(start.getTime() + 7 * MS_PER_DAY) };
      break;
    }
    case FinanceBudgetPeriod.QUARTERLY: {
      const firstMonth = Math.floor((cycle.monthOneBased - 1) / 3) * 3; // 0-based
      window = {
        start: new Date(Date.UTC(cycle.year, firstMonth, 1)),
        end: new Date(Date.UTC(cycle.year, firstMonth + 3, 1)),
      };
      break;
    }
    case FinanceBudgetPeriod.YEARLY:
      window = {
        start: new Date(Date.UTC(cycle.year, 0, 1)),
        end: new Date(Date.UTC(cycle.year + 1, 0, 1)),
      };
      break;
    case FinanceBudgetPeriod.CUSTOM: {
      const start = budget.startDate
        ? utcStartOfDay(toDateOrThrow(budget.startDate, "startDate"))
        : monthly.start;
      const end = budget.endDate
        ? nextUtcDay(utcStartOfDay(toDateOrThrow(budget.endDate, "endDate")))
        : monthly.end;
      window = { start, end };
      break;
    }
    case FinanceBudgetPeriod.MONTHLY:
    default:
      window = monthly;
      break;
  }

  if (period !== FinanceBudgetPeriod.CUSTOM) {
    if (budget.startDate) {
      const from = utcStartOfDay(toDateOrThrow(budget.startDate, "startDate"));
      if (from > window.start) window = { ...window, start: from };
    }
    if (budget.endDate) {
      const to = nextUtcDay(
        utcStartOfDay(toDateOrThrow(budget.endDate, "endDate")),
      );
      if (to < window.end) window = { ...window, end: to };
    }
  }

  // An inverted CUSTOM range is an empty window, not a range that swallows the
  // whole union of the other budgets.
  if (window.end <= window.start) {
    window = { start: window.start, end: window.start };
  }
  return window;
}

function formatBudgetResponse(budget: any) {
  return {
    ...budget,
    amountMinor: Number(budget.amountMinor),
  };
}

function budgetChangePayload(budget: any): Record<string, any> {
  return {
    categoryId: budget.categoryId ?? null,
    amountMinor: Number(budget.amountMinor),
    period: budget.period,
    startDate:
      budget.startDate instanceof Date
        ? budget.startDate.toISOString()
        : (budget.startDate ?? null),
    endDate:
      budget.endDate instanceof Date
        ? budget.endDate.toISOString()
        : (budget.endDate ?? null),
    alertAt80: budget.alertAt80 ?? true,
    alertAt100: budget.alertAt100 ?? true,
    alertSentAt:
      budget.alertSentAt instanceof Date
        ? budget.alertSentAt.toISOString()
        : (budget.alertSentAt ?? null),
    createdAt:
      budget.createdAt instanceof Date
        ? budget.createdAt.toISOString()
        : (budget.createdAt ?? null),
    version: budget.version ?? 1,
  };
}

@Injectable()
export class BudgetsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly syncNotifications?: SyncNotificationService,
  ) {}

  async createBudget(userId: string, dto: CreateBudgetDto) {
    const amountMinor = toMinorUnits(dto.amountMinor, "amountMinor");
    // Stored exactly as sent (only validated); the day-granular truncation
    // happens when the spend window is derived, so a write never silently moves
    // a timestamp the client will read back.
    const startDate = dto.startDate
      ? toDateOrThrow(dto.startDate, "startDate")
      : undefined;
    const endDate = dto.endDate
      ? toDateOrThrow(dto.endDate, "endDate")
      : undefined;
    if (startDate && endDate && endDate < startDate) {
      throw new BadRequestException("endDate must not be before startDate.");
    }
    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const budget = await tx.financeBudget.create({
        data: {
          userId,
          categoryId: dto.categoryId,
          amountMinor,
          period: dto.period ?? FinanceBudgetPeriod.MONTHLY,
          startDate,
          endDate,
          alertAt80: dto.alertAt80 ?? true,
          alertAt100: dto.alertAt100 ?? true,
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_budget",
        entityId: budget.id,
        operation: ChangeOperation.CREATE,
        version: budget.version,
        payload: budgetChangePayload(budget),
        userId,
      });
      highestCursor = logged.cursor;

      return budget;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatBudgetResponse(created);
  }

  async getBudgets(userId: string) {
    const budgets = await this.prisma.financeBudget.findMany({
      where: { userId, deletedAt: null },
      include: { category: true },
      orderBy: { createdAt: "desc" },
    });
    return budgets.map(formatBudgetResponse);
  }

  /**
   * `month` is 1-based (January = 1) and both parameters are UTC, so an
   * `?month=` from HTTP, the alert cycle and the windows below agree. Anything
   * else is rejected rather than fed into `Date.UTC`, which used to turn
   * `?month=abc` into an Invalid Date inside a Prisma filter.
   */
  private resolveReferenceCycle(month?: number, year?: number): ReferenceCycle {
    if (month !== undefined) {
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new BadRequestException(
          "month must be an integer between 1 and 12.",
        );
      }
    }
    if (year !== undefined) {
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        throw new BadRequestException("year must be between 2000 and 2100.");
      }
    }

    const now = new Date();
    const utcYear = now.getUTCFullYear();
    const utcMonthOneBased = now.getUTCMonth() + 1;

    if (month === undefined) {
      return {
        year: year ?? utcYear,
        monthOneBased: utcMonthOneBased,
        anchor: now,
      };
    }
    // An explicit cycle is an anchor at its first instant, so WEEKLY and
    // QUARTERLY budgets resolve against the requested month too.
    return {
      year: year ?? utcYear,
      monthOneBased: month,
      anchor: new Date(Date.UTC(year ?? utcYear, month - 1, 1)),
    };
  }

  async getBudgetsWithSpending(userId: string, month?: number, year?: number) {
    const cycle = this.resolveReferenceCycle(month, year);

    const budgets = await this.prisma.financeBudget.findMany({
      where: { userId, deletedAt: null },
      include: { category: true },
      orderBy: { createdAt: "desc" },
    });
    if (budgets.length === 0) return [];

    // One query over the union of every budget's window, then bucket in memory.
    // Going per budget would be N round trips for the same rows, since a MONTHLY
    // budget's window is always inside a YEARLY one anyway.
    const windows = budgets.map((b) => resolveBudgetSpendWindow(b, cycle));
    const unionStart = new Date(
      Math.min(...windows.map((w) => w.start.getTime())),
    );
    const unionEnd = new Date(Math.max(...windows.map((w) => w.end.getTime())));

    const expenses =
      unionEnd > unionStart
        ? await this.prisma.financeTransaction.findMany({
            where: {
              account: { userId },
              type: FinanceTransactionType.EXPENSE,
              isExcludedFromBudget: false,
              currency: BUDGET_SPEND_CURRENCY,
              deletedAt: null,
              transactionDate: {
                gte: unionStart,
                lt: unionEnd,
              },
            },
          })
        : [];

    return budgets.map((b, index) => {
      const budgetAmount = Number(b.amountMinor);
      const window = windows[index];
      // Summed in minor units so a year of rupee spend cannot drift on a float.
      let spentMinor = 0n;

      for (const expense of expenses) {
        if (b.categoryId && expense.categoryId !== b.categoryId) continue;
        const date = expense.transactionDate;
        if (date < window.start || date >= window.end) continue;
        spentMinor += BigInt(expense.amountMinor);
      }

      const spent = Number(spentMinor);
      const percentUsed = budgetAmount > 0 ? (spent / budgetAmount) * 100 : 0;

      return {
        ...formatBudgetResponse(b),
        spentWindowStart: window.start.toISOString(),
        spentWindowEnd: window.end.toISOString(),
        spentMinor: spent,
        remainingMinor: budgetAmount - spent,
        percentUsed,
      };
    });
  }

  async getBudgetById(userId: string, id: string) {
    const budget = await this.prisma.financeBudget.findFirst({
      where: { id, userId, deletedAt: null },
      include: { category: true },
    });
    if (!budget) {
      throw new NotFoundException(`Budget with ID ${id} not found`);
    }
    return formatBudgetResponse(budget);
  }

  async updateBudget(userId: string, id: string, dto: UpdateBudgetDto) {
    const existing = await this.prisma.financeBudget.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException(`Budget with ID ${id} not found`);
    }

    let highestCursor: bigint | undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const budget = await tx.financeBudget.update({
        where: { id },
        data: {
          ...(dto.categoryId !== undefined
            ? { categoryId: dto.categoryId }
            : {}),
          ...(dto.amountMinor !== undefined
            ? { amountMinor: toMinorUnits(dto.amountMinor, "amountMinor") }
            : {}),
          ...(dto.period !== undefined ? { period: dto.period } : {}),
          ...(dto.startDate !== undefined
            ? {
                startDate: dto.startDate
                  ? toDateOrThrow(dto.startDate, "startDate")
                  : null,
              }
            : {}),
          ...(dto.endDate !== undefined
            ? {
                endDate: dto.endDate
                  ? toDateOrThrow(dto.endDate, "endDate")
                  : null,
              }
            : {}),
          ...(dto.alertAt80 !== undefined ? { alertAt80: dto.alertAt80 } : {}),
          ...(dto.alertAt100 !== undefined
            ? { alertAt100: dto.alertAt100 }
            : {}),
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_budget",
        entityId: budget.id,
        operation: ChangeOperation.UPDATE,
        version: budget.version,
        payload: budgetChangePayload(budget),
        userId,
      });
      highestCursor = logged.cursor;

      return budget;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatBudgetResponse(updated);
  }

  async deleteBudget(userId: string, id: string) {
    const existing = await this.prisma.financeBudget.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException(`Budget with ID ${id} not found`);
    }

    let highestCursor: bigint | undefined;

    await this.prisma.$transaction(async (tx) => {
      const budget = await tx.financeBudget.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_budget",
        entityId: budget.id,
        operation: ChangeOperation.DELETE,
        version: budget.version,
        payload: {},
        userId,
      });
      highestCursor = logged.cursor;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return { success: true };
  }
}
