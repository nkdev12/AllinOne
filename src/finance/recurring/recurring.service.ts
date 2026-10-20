import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
} from "@nestjs/common";
import { v5 as uuidv5 } from "uuid";
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
 * Midnight UTC of the day `value` falls on.
 *
 * The occurrence identity is a calendar day, not an instant: the loop that mints
 * bills already does all of its month/day arithmetic through `Date.UTC` (see
 * `addUtcMonths`), and the Flutter generator hands over whatever its local rule
 * row carried. Collapsing to the UTC day is the one normalisation both halves can
 * agree on, and it is deliberately the *only* format introduced here — the stored
 * `transactionDate` keeps the instant the rule was due at.
 */
export function utcDayOf(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

/**
 * Fixed v5 namespace for recurring occurrence ids.
 *
 * Hard-coded rather than derived at boot because it is part of the id contract:
 * changing it re-mints every historical occurrence under a new `_id`, which is
 * precisely the double bill this exists to prevent.
 */
export const RECURRING_ID_NAMESPACE = "12026111-48f3-52d2-b0d8-ee792a9cdde6";

/**
 * The `_id` the bill for one occurrence of one rule always gets.
 *
 * `FinanceTransaction.id` is `String @default(uuid())` on a MongoDB collection,
 * so `_id` accepts any string and a duplicate insert is refused by the primary
 * key instead of by whichever reader happened to look first. Deriving it from
 * `rule.id` + the occurrence's UTC day is what turns "the cron ticked twice" or
 * "the worker restarted and its startup job ran again" from two Netflix charges
 * into one write and one no-op.
 *
 * The scope is narrow and it matters: this can only make *server-authored*
 * occurrences collide. The phone mints its own rows with `newLocalUuid()`
 * (`allmynote_frontend/lib/repositories/finance_transaction_repository.dart`),
 * so a bill the client generated offline arrives through
 * `src/sync/change-projection.ts` under a different `_id` and cannot collide
 * with this one — the `(recurringRuleId, UTC day)` pre-check in
 * `occurrenceAlreadyGenerated` is what covers that direction.
 */
export function recurringTransactionId(
  ruleId: string,
  occurrence: Date,
): string {
  return uuidv5(
    `recurring:${ruleId}:${utcDayOf(occurrence).toISOString()}`,
    RECURRING_ID_NAMESPACE,
  );
}

/**
 * Upper bound on the occurrences one invocation may write for one rule.
 *
 * Mirrors the Flutter client's `maxCatchUpOccurrences` (`lib/repositories/
 * finance_recurring_repository.dart`) so both halves of the app catch up a long
 * offline stretch over several runs instead of one unbounded write loop. Reaching
 * the bound is not a truncation of the schedule: `nextDueDate` is left exactly
 * where the clamp stopped, still in the past, so the next tick or the next
 * `POST /finance/recurring/process-due` picks the backlog up. Fast-forwarding
 * instead would push a later `nextDueDate` to the phone through the rule's
 * `Change` and drop the un-minted bills app-wide.
 */
export const MAX_CATCH_UP_OCCURRENCES = 24;

/**
 * How far back the Bull cron will reach for a rule.
 *
 * The client owns generation — the user settled that on 2026-10-19, because the
 * app has to work offline — so the worker's job is only to pick up a bill the
 * phone could not: one that came due while the device was connected but idle.
 * Daily tick + two missed ticks + the startup job that every deploy adds is
 * covered by three UTC days; anything older means the account has not been
 * reachable for days, and the phone's own catch-up (24 per launch, from the
 * local rule row) is the authoritative generator for that backlog. The explicit
 * per-user REST call keeps the unbounded-by-window behaviour, which is what an
 * operator or an AI tool reaches for to repair a schedule on demand.
 */
export const RECURRING_CRON_CATCH_UP_WINDOW_DAYS = 3;

/**
 * Whether a failed write means "this occurrence is already billed".
 *
 * Prisma on MongoDB reports a duplicate `_id` as `P2002` for an interactive
 * transaction and as a raw `E11000` further down the stack; both are the expected
 * outcome of two writers picking the same deterministic id, not a failure. The
 * winner's transaction row and its `Change` are already committed, so the loser
 * only owes the schedule its step forward. Anything else still throws.
 */
function isAlreadyMintedError(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? "";
  const message = (error as { message?: string })?.message ?? "";
  const target = JSON.stringify(
    (error as { meta?: { target?: unknown } })?.meta?.target,
  );
  return (
    code === "P2002" ||
    code === "E11000" ||
    message.includes("E11000") ||
    message.includes("DuplicateKey") ||
    target?.includes("_id") === true
  );
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

/**
 * The slice of a due rule the generator reads. Declared rather than inferred
 * from the Prisma payload so the same shape works for a row straight off
 * `findMany` and for the row a catch-up loop is walking forward through.
 */
type DueRule = {
  id: string;
  userId: string;
  accountId: string;
  categoryId: string | null;
  type: FinanceTransactionType;
  amountMinor: bigint;
  title: string;
  frequency: FinanceRecurringFrequency;
  interval: number;
  startDate: Date;
  endDate: Date | null;
  nextDueDate: Date;
};

/**
 * What one occurrence cost the run that processed it.
 *
 * `generated` — a bill and its balance movement. `already` — the bill was
 * already there, so only the schedule moved. `settled` — the rule is retired
 * (past `endDate`, or its account is gone) and there is nothing further to
 * walk. `highestCursor` is the log position of whatever was written, and it is
 * what wakes the user's other devices once the run is over.
 */
type OccurrenceOutcome = {
  generated?: boolean;
  already?: boolean;
  settled?: boolean;
  nextDueDate?: Date;
  highestCursor?: bigint;
};

@Injectable()
export class RecurringService {
  private readonly logger = new Logger(RecurringService.name);

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

    assertCalendarDate(dto.startDate, "startDate");
    if (dto.endDate) assertCalendarDate(dto.endDate, "endDate");
    if (dto.endDate && new Date(dto.endDate) < new Date(dto.startDate)) {
      throw new BadRequestException("endDate must be on or after startDate");
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
   *
   * The cursor of that `Change` comes back to the caller so a retirement wakes
   * the rule's other devices too: `autoGenerate: false` is a fact every copy of
   * the schedule has to agree on.
   */
  private async settleRule(
    tx: Prisma.TransactionClient,
    rule: { id: string; userId: string },
  ): Promise<bigint> {
    const settled = await tx.financeRecurringRule.update({
      where: { id: rule.id },
      data: {
        autoGenerate: false,
        version: { increment: 1 },
      },
    });

    const logged = await appendChange(tx, {
      entityType: "finance_recurring_rule",
      entityId: settled.id,
      operation: ChangeOperation.UPDATE,
      version: settled.version,
      payload: recurringChangePayload(settled),
      userId: rule.userId,
    });

    return logged.cursor;
  }

  /**
   * Run the rules due for one account, up to the catch-up clamp.
   *
   * `POST /finance/recurring/process-due`, and the only server path that reaches
   * further back than the cron's window: an explicit call means "this schedule is
   * behind, repair it", which is what the phone does when it has been offline for
   * weeks and what an operator or an AI tool calls by hand.
   */
  async processDueRulesForUser(userId: string): Promise<{ processed: number }> {
    return this.processDueRulesScoped({ userId }, null);
  }

  /**
   * Catch-up for *every* account, bounded to the recent window. The Bull
   * `process-recurring` handler's entry point, and the only caller allowed the
   * all-tenant scope.
   */
  async processAllDueRules(): Promise<{ processed: number }> {
    return this.processDueRulesScoped({}, RECURRING_CRON_CATCH_UP_WINDOW_DAYS);
  }

  /**
   * The one implementation, reached only through the two named entry points
   * above. Both server paths — the REST route the client calls and the worker's
   * daily tick — are thin views of this function now, so they cannot disagree
   * about who owns generation, and both are idempotent per occurrence.
   *
   * It replaces `processDueRules(userId?: string)`, which built its filter with
   * `...(userId ? { userId } : {})`. That made the unsafe scope the default: one
   * forgotten argument dropped the owner filter and the tick wrote transactions,
   * balances and oplog entries across every tenant. Here the scope is an
   * argument with no optional form — a caller has to spell out either
   * `{ userId }` or `{}`, so cross-tenant is a decision rather than an accident.
   *
   * @param catchUpWindowDays how far behind `nextDueDate` may be for this scope
   * to touch the rule at all; `null` is the explicit per-user repair call.
   */
  private async processDueRulesScoped(
    ownerFilter: { userId: string } | Record<string, never>,
    catchUpWindowDays: number | null,
  ): Promise<{ processed: number }> {
    const now = new Date();
    const dueRules = await this.prisma.financeRecurringRule.findMany({
      where: {
        ...ownerFilter,
        nextDueDate: { lte: now },
        autoGenerate: true,
        deletedAt: null,
      },
    });

    const windowStart =
      catchUpWindowDays === null
        ? null
        : addUtcDays(utcDayOf(now), -catchUpWindowDays);

    let processedCount = 0;

    // One wake-up per user per run. Server-authored changes used to be appended
    // without anybody being told: the rows were durable, but other devices and
    // collaborators only saw the generated bill on their next pull.
    const highestCursorByUser = new Map<string, bigint>();

    for (const rule of dueRules) {
      // Older than the window, so the phone has been unreachable for days — and
      // a device that has been off that long is the one that owns the backlog:
      // its own catch-up reads the local rule row and pushes the bills it mints.
      // The cron leaves the rule exactly where it is (still due, untouched)
      // rather than racing that backlog from the server side.
      if (windowStart && rule.nextDueDate < windowStart) {
        this.logger.warn(
          `Skipped recurring rule ${rule.id} for user ${rule.userId}: next due ${rule.nextDueDate.toISOString()} is outside the ${catchUpWindowDays}-day cron catch-up window.`,
        );
        continue;
      }

      let occurrence = rule.nextDueDate;
      let stepped = 0;
      while (stepped < MAX_CATCH_UP_OCCURRENCES && occurrence <= now) {
        const outcome = await this.processOccurrence(rule, occurrence, now);
        stepped++;

        if (outcome.highestCursor !== undefined) {
          const seen = highestCursorByUser.get(rule.userId);
          if (seen === undefined || outcome.highestCursor > seen) {
            highestCursorByUser.set(rule.userId, outcome.highestCursor);
          }
        }

        // A settled rule (past `endDate`, or its account is gone) stops here;
        // there is no later occurrence worth computing for it.
        if (outcome.settled || !outcome.nextDueDate) break;

        occurrence = outcome.nextDueDate;

        // Only an occurrence this run actually minted counts as processed;
        // settled rules are not work, and neither is a bill that was already
        // there — counting either hid an ever-growing due queue.
        if (outcome.generated) processedCount++;
      }

      if (stepped === MAX_CATCH_UP_OCCURRENCES && occurrence <= now) {
        this.logger.warn(
          `Paused recurring catch-up for rule ${rule.id} after ${MAX_CATCH_UP_OCCURRENCES} occurrences; the next due date ${occurrence.toISOString()} remains pending.`,
        );
      }
    }

    for (const [userId, highestCursor] of highestCursorByUser) {
      this.syncNotifications?.notifyMutation({ userId, highestCursor });
    }

    return { processed: processedCount };
  }

  /**
   * Mint one occurrence of one rule — or recognise that it is already minted.
   *
   * One transaction moves everything the bill touches: the transaction row, the
   * account balance, the rule's `nextDueDate`, and the three `Change` rows that
   * let the account's other devices and its collaborators converge on all of it.
   * A failure anywhere in that list rolls the occurrence back rather than leaving
   * a bill that nobody paid for.
   */
  private async processOccurrence(
    rule: DueRule,
    occurrence: Date,
    now: Date,
  ): Promise<OccurrenceOutcome> {
    // Step 3 below advances the schedule from the occurrence it just billed,
    // anchored on the day the rule started on. Both the minted and the
    // already-minted outcome need it, so it is computed once, up here.
    const nextDueDate = calculateNextOccurrence(
      occurrence,
      rule.frequency,
      rule.interval,
      rule.startDate,
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Gate on the occurrence, not on `now`: a rule scheduled for 10-31 with
        // `endDate` 11-02 still owes that bill when it is first picked up on
        // 11-05, while a rule due 10-20 that ends 10-15 must never mint a bill
        // past its end.
        if (rule.endDate && occurrence > rule.endDate) {
          return {
            settled: true,
            highestCursor: await this.settleRule(tx, rule),
          };
        }

        const account = await tx.financeAccount.findFirst({
          where: {
            id: rule.accountId,
            userId: rule.userId,
            deletedAt: null,
          },
        });
        if (!account) {
          return {
            settled: true,
            highestCursor: await this.settleRule(tx, rule),
          };
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

        // 1. The bill, unless this occurrence already has one.
        if (await this.occurrenceAlreadyGenerated(tx, rule.id, occurrence)) {
          // Somebody else billed this day: an earlier tick, the other entry
          // point racing this one, or the phone's own generator pushing its row
          // through `POST /sync/push`. The money has moved once and its `Change`
          // is already in the log — only the schedule still owes its step.
          const { cursor } = await this.advanceRule(
            tx,
            rule,
            nextDueDate,
            now,
            false,
          );
          return { already: true, nextDueDate, highestCursor: cursor };
        }

        const newTx = await tx.financeTransaction.create({
          data: {
            // Deterministic rather than a fresh `uuid()`: see
            // `recurringTransactionId`. This is the write that makes a replay of
            // the same occurrence cost a duplicate-key error instead of money.
            id: recurringTransactionId(rule.id, occurrence),
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

        // 3. Log sync oplogs
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

        // 4. Advance nextDueDate, anchored on the day the rule started on, and
        // append the rule's own Change with it. Last, as it was before, so the
        // cursor this returns is the highest of the three the occurrence wrote
        // and the wake-up below cannot under-report the log.
        const { cursor } = await this.advanceRule(
          tx,
          rule,
          nextDueDate,
          now,
          true,
        );

        return { generated: true, nextDueDate, highestCursor: cursor };
      });
    } catch (error) {
      if (!isAlreadyMintedError(error)) throw error;

      // The `_id` collision is the first write of the transaction above, so
      // nothing was half-applied: this loser's balance increment and oplog rows
      // never ran. The winner already committed the bill and its own changes, so
      // all that is left is the schedule step, in a transaction of its own.
      return this.prisma.$transaction(async (tx) => {
        const { cursor } = await this.advanceRule(
          tx,
          rule,
          nextDueDate,
          now,
          false,
        );
        return { already: true, nextDueDate, highestCursor: cursor };
      });
    }
  }

  /**
   * The rule's half of an occurrence: `nextDueDate` forward, `version` up, and
   * the `Change` that carries both to the other devices — always in that order,
   * in the caller's transaction, matching every other recurring mutation.
   *
   * `lastGeneratedAt` is only stamped when this run really did mint a bill. A
   * no-op that recognised somebody else's write is not a generation, and the
   * client's own catch-up reads that field to decide whether a rule is idle.
   */
  private async advanceRule(
    tx: Prisma.TransactionClient,
    rule: { id: string; userId: string },
    nextDueDate: Date,
    now: Date,
    generated: boolean,
  ): Promise<{ updated: any; cursor: bigint }> {
    const updated = await tx.financeRecurringRule.update({
      where: { id: rule.id },
      data: {
        ...(generated ? { lastGeneratedAt: now } : {}),
        nextDueDate,
        version: { increment: 1 },
      },
    });

    const logged = await appendChange(tx, {
      entityType: "finance_recurring_rule",
      entityId: updated.id,
      operation: ChangeOperation.UPDATE,
      version: updated.version,
      payload: recurringChangePayload(updated),
      userId: rule.userId,
    });

    return { updated, cursor: logged.cursor };
  }

  /**
   * Whether one occurrence of one rule is already billed.
   *
   * Two halves, and both are needed because they answer for different writers:
   * the deterministic `_id` catches a server replay of the same occurrence,
   * while the `(recurringRuleId, UTC day)` window catches a row the phone
   * generated itself — that one arrives through `change-projection.ts` under a
   * local UUID, so no id scheme can ever recognise it. Day granularity, not
   * instant equality: `nextDueDate` reaches the server as whatever the device
   * that last advanced it stored, and a timezone-shifted copy of the same due day
   * is the same bill.
   *
   * A soft-deleted row still counts as a match, on purpose. The deterministic id
   * is spent the moment it is written — Mongo will refuse it whether or not the
   * document is still live — so "mint the deleted bill again" is not available to
   * this server anyway, and reading the tombstone makes the answer explicit
   * instead of paying for it with a duplicate-key error. Deleting a generated
   * bill is therefore a decision about that occurrence, and repairing it means
   * restoring the row, not re-running the catch-up.
   *
   * Best-effort by design. If the read cannot be answered, this returns false
   * and the write still goes in under the deterministic id, where the primary
   * key is the backstop; a scheduler that cannot see the collection must not
   * block the money.
   */
  private async occurrenceAlreadyGenerated(
    tx: Prisma.TransactionClient,
    ruleId: string,
    occurrence: Date,
  ): Promise<boolean> {
    const dayStart = utcDayOf(occurrence);
    const dayEnd = addUtcDays(dayStart, 1);

    try {
      const existing = await tx.financeTransaction.findMany({
        where: {
          recurringRuleId: ruleId,
          OR: [
            { id: recurringTransactionId(ruleId, occurrence) },
            { transactionDate: { gte: dayStart, lt: dayEnd } },
          ],
        },
        select: { id: true },
        take: 1,
      });
      return existing.length > 0;
    } catch (error: any) {
      this.logger.warn(
        `Could not check whether recurring rule ${ruleId} had already billed ${dayStart.toISOString()}; falling back to the deterministic id. ${error?.message}`,
      );
      return false;
    }
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

    if (dto.startDate !== undefined)
      assertCalendarDate(dto.startDate, "startDate");
    if (dto.endDate !== undefined && dto.endDate)
      assertCalendarDate(dto.endDate, "endDate");
    const effectiveStart = dto.startDate ?? existing.startDate.toISOString();
    const effectiveEnd =
      dto.endDate !== undefined ? dto.endDate : existing.endDate?.toISOString();
    if (effectiveEnd && new Date(effectiveEnd) < new Date(effectiveStart)) {
      throw new BadRequestException("endDate must be on or after startDate");
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
