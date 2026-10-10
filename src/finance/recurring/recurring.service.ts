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
} from "@prisma/client";

export function formatRecurringResponse(rule: any) {
  return {
    ...rule,
    amountMinor: Number(rule.amountMinor),
  };
}

export function recurringChangePayload(rule: any): Record<string, any> {
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

export function calculateNextOccurrence(
  from: Date,
  frequency: FinanceRecurringFrequency,
  interval: number = 1,
): Date {
  const next = new Date(from.getTime());
  switch (frequency) {
    case FinanceRecurringFrequency.DAILY:
      next.setUTCDate(next.getUTCDate() + interval);
      break;
    case FinanceRecurringFrequency.WEEKLY:
      next.setUTCDate(next.getUTCDate() + interval * 7);
      break;
    case FinanceRecurringFrequency.BIWEEKLY:
      next.setUTCDate(next.getUTCDate() + interval * 14);
      break;
    case FinanceRecurringFrequency.MONTHLY:
      next.setUTCMonth(next.getUTCMonth() + interval);
      break;
    case FinanceRecurringFrequency.QUARTERLY:
      next.setUTCMonth(next.getUTCMonth() + interval * 3);
      break;
    case FinanceRecurringFrequency.YEARLY:
      next.setUTCFullYear(next.getUTCFullYear() + interval);
      break;
    default:
      next.setUTCMonth(next.getUTCMonth() + interval);
      break;
  }
  return next;
}

@Injectable()
export class RecurringService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly syncNotifications?: SyncNotificationService,
  ) {}

  async createRecurringRule(userId: string, dto: CreateRecurringDto) {
    const account = await this.prisma.financeAccount.findFirst({
      where: { id: dto.accountId, userId, deletedAt: null },
    });
    if (!account) {
      throw new BadRequestException(`Account with ID ${dto.accountId} not found`);
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
      if (rule.endDate && rule.endDate < now) {
        continue;
      }

      await this.prisma.$transaction(async (tx) => {
        const account = await tx.financeAccount.findFirst({
          where: { id: rule.accountId, deletedAt: null },
        });
        if (!account) return;

        // 1. Create transaction
        const newTx = await tx.financeTransaction.create({
          data: {
            userId: rule.userId,
            accountId: rule.accountId,
            categoryId: rule.categoryId,
            type: rule.type,
            amountMinor: rule.amountMinor,
            currency: account.currency,
            title: rule.title,
            transactionDate: rule.nextDueDate,
            recurringRuleId: rule.id,
          },
        });

        // 2. Adjust account balance
        const balanceDelta =
          rule.type === FinanceTransactionType.INCOME
            ? rule.amountMinor
            : -rule.amountMinor;

        const updatedAccount = await tx.financeAccount.update({
          where: { id: account.id },
          data: {
            currentBalanceMinor: account.currentBalanceMinor + balanceDelta,
            version: { increment: 1 },
          },
        });

        // 3. Advance nextDueDate
        const nextDue = calculateNextOccurrence(
          rule.nextDueDate,
          rule.frequency,
          rule.interval,
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
      });

      processedCount++;
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
