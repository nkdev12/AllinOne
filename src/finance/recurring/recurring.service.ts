import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import { CreateRecurringDto } from "./dto/create-recurring.dto";
import { UpdateRecurringDto } from "./dto/update-recurring.dto";
import { appendChange } from "@/sync/change-cursor";
import { accountChangePayload } from "../accounts/accounts.service";
import { transactionChangePayload } from "../transactions/transactions.service";
import {
  ChangeOperation,
  FinanceRecurringFrequency,
  FinanceTransactionType,
  Prisma,
} from "@prisma/client";

function formatRecurringResponse(rule: any) {
  return {
    ...rule,
    amountMinor: Number(rule.amountMinor),
  };
}

function recurringChangePayload(rule: any): Record<string, any> {
  return {
    accountId: rule.accountId,
    categoryId: rule.categoryId ?? null,
    type: rule.type,
    amountMinor: Number(rule.amountMinor),
    title: rule.title,
    frequency: rule.frequency,
    interval: rule.interval ?? 1,
    startDate:
      rule.startDate instanceof Date
        ? rule.startDate.toISOString()
        : rule.startDate,
    endDate:
      rule.endDate instanceof Date
        ? rule.endDate.toISOString()
        : (rule.endDate ?? null),
    nextDueDate:
      rule.nextDueDate instanceof Date
        ? rule.nextDueDate.toISOString()
        : rule.nextDueDate,
    lastGeneratedAt:
      rule.lastGeneratedAt instanceof Date
        ? rule.lastGeneratedAt.toISOString()
        : (rule.lastGeneratedAt ?? null),
    autoGenerate: rule.autoGenerate ?? true,
    createdAt:
      rule.createdAt instanceof Date
        ? rule.createdAt.toISOString()
        : (rule.createdAt ?? null),
    version: rule.version ?? 1,
  };
}

/**
 * Last day of a UTC month, given as `year` / zero-based `monthIndex`.
 * Day 0 of the following month is what `Date.UTC` normalises to that.
 */
function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addUtcDays(from: Date, daysToAdd: number): Date {
  return new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate() + daysToAdd,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/**
 * Month-aware step, entirely in UTC.
 *
 * The target month's day is `Math.min(anchorDay, daysInMonth(target))`, so a
 * rule that started on the 31st runs Jan 31 -> Feb 28 -> Mar 31 -> Apr 30.
 * Rolling the month with `setUTCMonth` instead overflowed Feb 31 onto Mar 3,
 * which both skipped February's bill and drifted the anchor one day per month
 * — and the Flutter client clamps to the last day of Feb locally, so the two
 * halves disagreed about when a bill was due.
 */
function addUtcMonths(
  from: Date,
  monthsToAdd: number,
  anchorDay: number,
): Date {
  const totalMonths =
    from.getUTCFullYear() * 12 + from.getUTCMonth() + monthsToAdd;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12;
  const day = Math.min(Math.max(anchorDay, 1), daysInUtcMonth(year, month));

  return new Date(
    Date.UTC(
      year,
      month,
      day,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/**
 * @param anchorDate the rule's `startDate`. Month- and year-length frequencies
 * take their calendar day from it rather than from `from`, so a bill clamped to
 * Feb 28 still returns to the 31st in March instead of decaying to the 28th.
 */
export function calculateNextOccurrence(
  from: Date,
  frequency: FinanceRecurringFrequency,
  interval: number = 1,
  anchorDate?: Date | null,
): Date {
  const step =
    Number.isFinite(interval) && interval >= 1 ? Math.floor(interval) : 1;
  const anchorDay = (anchorDate ?? from).getUTCDate();

  switch (frequency) {
    case FinanceRecurringFrequency.DAILY:
      return addUtcDays(from, step);
    case FinanceRecurringFrequency.WEEKLY:
      return addUtcDays(from, step * 7);
    case FinanceRecurringFrequency.BIWEEKLY:
      return addUtcDays(from, step * 14);
    case FinanceRecurringFrequency.MONTHLY:
      return addUtcMonths(from, step, anchorDay);
    case FinanceRecurringFrequency.QUARTERLY:
      return addUtcMonths(from, step * 3, anchorDay);
    case FinanceRecurringFrequency.YEARLY:
      return addUtcMonths(from, step * 12, anchorDay);
    default:
      return addUtcMonths(from, step, anchorDay);
  }
}

/**
 * Validates that `iso` is a real calendar date (e.g. rejects 2026-02-30).
 * JavaScript's `Date` constructor silently overflows Feb 30 → Mar 2, so we
 * compare the UTC fields back against the original year/month/day integers.
 */
function assertCalendarDate(iso: string, fieldName: string): void {
  const parsed = new Date(iso);
  if (isNaN(parsed.getTime())) {
    throw new BadRequestException(`${fieldName} is not a valid date`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match) {
    const [, y, m, d] = match.map(Number);
    if (
      parsed.getUTCFullYear() !== y ||
      parsed.getUTCMonth() + 1 !== m ||
      parsed.getUTCDate() !== d
    ) {
      throw new BadRequestException(
        `${fieldName} '${iso}' is not a valid calendar date (e.g. February 30 does not exist)`,
      );
    }
  }
}

@Injectable()
export class RecurringService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly syncNotifications?: SyncNotificationService,
  ) {}

  /**
   * A rule may only bill against an account the caller owns. Without this, one
   * user could point a rule at another user's account id and have that account's
   * balance moved by their own amount — on `POST /finance/recurring/process-due`
   * or on the `finance` cron — with the victim's account row then projected into
   * the attacker's pull stream.
   */
  private async assertAccountOwned(userId: string, accountId: string) {
    const account = await this.prisma.financeAccount.findFirst({
      where: { id: accountId, userId, deletedAt: null },
    });
    if (!account) {
      throw new NotFoundException(`Account with ID '${accountId}' not found`);
    }
    return account;
  }

  /**
   * Same shape as the account check, but tolerates global system categories
   * (`userId: null`), which every user is allowed to reference.
   */
  private async assertCategoryUsable(userId: string, categoryId: string) {
    const category = await this.prisma.financeCategory.findFirst({
      where: {
        id: categoryId,
        deletedAt: null,
        OR: [{ userId }, { userId: null }],
      },
    });
    if (!category) {
      throw new NotFoundException(`Category with ID '${categoryId}' not found`);
    }
    return category;
  }

  async createRecurringRule(userId: string, dto: CreateRecurringDto) {
    const account = await this.prisma.financeAccount.findFirst({
      where: { id: dto.accountId, userId, deletedAt: null },
    });
    if (!account) {
      throw new BadRequestException(
        `Account with ID ${dto.accountId} not found`,
      );
    }

    if (dto.categoryId) {
      await this.assertCategoryUsable(userId, dto.categoryId);
    }

    assertCalendarDate(dto.startDate, 'startDate');
    if (dto.endDate) assertCalendarDate(dto.endDate, 'endDate');
    if (dto.endDate && new Date(dto.endDate) < new Date(dto.startDate)) {
      throw new BadRequestException('endDate must be on or after startDate');
    }

    const startDate = new Date(dto.startDate);
    const amountMinor = BigInt(Math.round(dto.amountMinor));
    const frequency = dto.frequency ?? FinanceRecurringFrequency.MONTHLY;
    const interval = dto.interval ?? 1;

    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const rule = await tx.financeRecurringRule.create({
        data: {
          userId,
          accountId: dto.accountId,
          categoryId: dto.categoryId,
          type: dto.type,
          amountMinor,
          title: dto.title,
          frequency,
          interval,
          startDate,
          endDate: dto.endDate ? new Date(dto.endDate) : undefined,
          nextDueDate: startDate,
          autoGenerate: dto.autoGenerate ?? true,
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_recurring_rule",
        entityId: rule.id,
        operation: ChangeOperation.CREATE,
        version: rule.version,
        payload: recurringChangePayload(rule),
        userId,
      });
      highestCursor = logged.cursor;

      return rule;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatRecurringResponse(created);
  }

  async getRecurringRules(userId: string) {
    const rules = await this.prisma.financeRecurringRule.findMany({
      where: { userId, deletedAt: null },
      orderBy: { nextDueDate: "asc" },
    });
    return rules.map(formatRecurringResponse);
  }

  async getRecurringRuleById(userId: string, id: string) {
    const rule = await this.prisma.financeRecurringRule.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!rule) {
      throw new NotFoundException(`Recurring rule with ID ${id} not found`);
    }
    return formatRecurringResponse(rule);
  }

  /**
   * Takes a rule out of the due queue and logs the mutation the way every other
   * recurring mutation is logged.
   *
   * Used when a rule has run past its `endDate` or lost the account it bills
   * against. Both would otherwise keep matching `nextDueDate <= now`, so the
   * scheduler would re-fetch and re-skip them on every tick while still
   * reporting them as work done. Flipping `autoGenerate` off — which the due
   * query already filters on — settles the rule without a new status column.
   */
  private async settleRule(
    tx: Prisma.TransactionClient,
    rule: { id: string; userId: string },
  ): Promise<void> {
    const settled = await tx.financeRecurringRule.update({
      where: { id: rule.id },
      data: {
        autoGenerate: false,
        version: { increment: 1 },
      },
    });

    await appendChange(tx, {
      entityType: "finance_recurring_rule",
      entityId: settled.id,
      operation: ChangeOperation.UPDATE,
      version: settled.version,
      payload: recurringChangePayload(settled),
      userId: rule.userId,
    });
  }

  async processDueRules(userId?: string): Promise<{ processed: number }> {
    const now = new Date();
    const dueRules = await this.prisma.financeRecurringRule.findMany({
      where: {
        ...(userId ? { userId } : {}),
        nextDueDate: { lte: now },
        autoGenerate: true,
        deletedAt: null,
      },
    });

    let processedCount = 0;

    for (const rule of dueRules) {
      const occurrence = rule.nextDueDate;

      const generated = await this.prisma.$transaction(async (tx) => {
        // Gate on the occurrence, not on `now`: a rule scheduled for 10-31 with
        // `endDate` 11-02 still owes that bill when it is first picked up on
        // 11-05, while a rule due 10-20 that ends 10-15 must never mint a bill
        // past its end.
        if (rule.endDate && occurrence > rule.endDate) {
          await this.settleRule(tx, rule);
          return false;
        }

        const account = await tx.financeAccount.findFirst({
          where: {
            id: rule.accountId,
            userId: rule.userId,
            deletedAt: null,
          },
        });
        if (!account) {
          await this.settleRule(tx, rule);
          return false;
        }

        // Same ownership scope as the account, but a category is metadata
        // rather than money: a foreign or deleted id left over from before this
        // check is dropped from the generated transaction instead of blocking
        // the bill.
        let categoryId: string | null = rule.categoryId ?? null;
        if (categoryId) {
          const category = await tx.financeCategory.findFirst({
            where: {
              id: categoryId,
              deletedAt: null,
              OR: [{ userId: rule.userId }, { userId: null }],
            },
          });
          if (!category) categoryId = null;
        }

        // 1. Create transaction
        const newTx = await tx.financeTransaction.create({
          data: {
            userId: rule.userId,
            accountId: rule.accountId,
            categoryId,
            type: rule.type,
            amountMinor: rule.amountMinor,
            currency: account.currency,
            title: rule.title,
            transactionDate: occurrence,
            recurringRuleId: rule.id,
          },
        });

        // 2. Adjust account balance
        const balanceDelta =
          rule.type === FinanceTransactionType.INCOME
            ? rule.amountMinor
            : -rule.amountMinor;

        // `{ increment }`, not an absolute value read outside this statement: a
        // concurrent `createTransaction` moves the same row (it uses increment
        // too), and an absolute write would drop that movement permanently.
        // The row returned here carries the post-update balance and version, so
        // the account Change below projects what is actually stored.
        const updatedAccount = await tx.financeAccount.update({
          where: { id: account.id },
          data: {
            currentBalanceMinor: { increment: balanceDelta },
            version: { increment: 1 },
          },
        });

        // 3. Advance nextDueDate, anchored on the day the rule started on.
        const nextDue = calculateNextOccurrence(
          occurrence,
          rule.frequency,
          rule.interval,
          rule.startDate,
        );

        const updatedRule = await tx.financeRecurringRule.update({
          where: { id: rule.id },
          data: {
            lastGeneratedAt: now,
            nextDueDate: nextDue,
            version: { increment: 1 },
          },
        });

        // 4. Log sync oplogs
        await appendChange(tx, {
          entityType: "finance_transaction",
          entityId: newTx.id,
          operation: ChangeOperation.CREATE,
          version: newTx.version,
          payload: transactionChangePayload(newTx),
          userId: rule.userId,
        });

        await appendChange(tx, {
          entityType: "finance_account",
          entityId: updatedAccount.id,
          operation: ChangeOperation.UPDATE,
          version: updatedAccount.version,
          payload: accountChangePayload(updatedAccount),
          userId: rule.userId,
        });

        await appendChange(tx, {
          entityType: "finance_recurring_rule",
          entityId: updatedRule.id,
          operation: ChangeOperation.UPDATE,
          version: updatedRule.version,
          payload: recurringChangePayload(updatedRule),
          userId: rule.userId,
        });

        return true;
      });

      // Only a rule that actually minted a bill counts as processed; settled
      // rules are not work, and counting them hid an ever-growing due queue.
      if (generated) processedCount++;
    }

    return { processed: processedCount };
  }

  async updateRecurringRule(
    userId: string,
    id: string,
    dto: UpdateRecurringDto,
  ) {
    const existing = await this.prisma.financeRecurringRule.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException(`Recurring rule with ID ${id} not found`);
    }

    // Moving a rule onto an account is precisely the cross-user write the create
    // path refuses, so re-home it only against an account this user owns.
    if (dto.accountId !== undefined && dto.accountId !== existing.accountId) {
      await this.assertAccountOwned(userId, dto.accountId);
    }
    if (dto.categoryId && dto.categoryId !== existing.categoryId) {
      await this.assertCategoryUsable(userId, dto.categoryId);
    }

    if (dto.startDate !== undefined) assertCalendarDate(dto.startDate, 'startDate');
    if (dto.endDate !== undefined && dto.endDate) assertCalendarDate(dto.endDate, 'endDate');
    const effectiveStart = dto.startDate ?? existing.startDate.toISOString();
    const effectiveEnd = dto.endDate !== undefined ? dto.endDate : existing.endDate?.toISOString();
    if (effectiveEnd && new Date(effectiveEnd) < new Date(effectiveStart)) {
      throw new BadRequestException('endDate must be on or after startDate');
    }

    let highestCursor: bigint | undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const rule = await tx.financeRecurringRule.update({
        where: { id },
        data: {
          ...(dto.accountId !== undefined ? { accountId: dto.accountId } : {}),
          ...(dto.categoryId !== undefined
            ? { categoryId: dto.categoryId }
            : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.amountMinor !== undefined
            ? { amountMinor: BigInt(Math.round(dto.amountMinor)) }
            : {}),
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.frequency !== undefined ? { frequency: dto.frequency } : {}),
          ...(dto.interval !== undefined ? { interval: dto.interval } : {}),
          ...(dto.startDate !== undefined
            ? { startDate: new Date(dto.startDate) }
            : {}),
          ...(dto.endDate !== undefined
            ? { endDate: dto.endDate ? new Date(dto.endDate) : null }
            : {}),
          ...(dto.autoGenerate !== undefined
            ? { autoGenerate: dto.autoGenerate }
            : {}),
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_recurring_rule",
        entityId: rule.id,
        operation: ChangeOperation.UPDATE,
        version: rule.version,
        payload: recurringChangePayload(rule),
        userId,
      });
      highestCursor = logged.cursor;

      return rule;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatRecurringResponse(updated);
  }

  async deleteRecurringRule(userId: string, id: string) {
    const existing = await this.prisma.financeRecurringRule.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException(`Recurring rule with ID ${id} not found`);
    }

    let highestCursor: bigint | undefined;

    await this.prisma.$transaction(async (tx) => {
      const rule = await tx.financeRecurringRule.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_recurring_rule",
        entityId: rule.id,
        operation: ChangeOperation.DELETE,
        version: rule.version,
        payload: {},
        userId,
      });
      highestCursor = logged.cursor;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return { success: true };
  }
}
