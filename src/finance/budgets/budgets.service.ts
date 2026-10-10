import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import { CreateBudgetDto } from "./dto/create-budget.dto";
import { UpdateBudgetDto } from "./dto/update-budget.dto";
import { appendChange } from "@/sync/change-cursor";
import {
  ChangeOperation,
  FinanceBudgetPeriod,
  FinanceTransactionType,
} from "@prisma/client";

export function formatBudgetResponse(budget: any) {
  return {
    ...budget,
    amountMinor: Number(budget.amountMinor),
  };
}

export function budgetChangePayload(budget: any): Record<string, any> {
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
    const amountMinor = BigInt(Math.round(dto.amountMinor));
    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const budget = await tx.financeBudget.create({
        data: {
          userId,
          categoryId: dto.categoryId,
          amountMinor,
          period: dto.period ?? FinanceBudgetPeriod.MONTHLY,
          startDate: dto.startDate ? new Date(dto.startDate) : undefined,
          endDate: dto.endDate ? new Date(dto.endDate) : undefined,
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

  async getBudgetsWithSpending(userId: string, month?: number, year?: number) {
    const now = new Date();
    const targetYear = year ?? now.getFullYear();
    const targetMonth = month !== undefined ? month : now.getMonth();

    const startOfMonth = new Date(
      Date.UTC(targetYear, targetMonth, 1, 0, 0, 0, 0),
    );
    const endOfMonth = new Date(
      Date.UTC(targetYear, targetMonth + 1, 0, 23, 59, 59, 999),
    );

    const [budgets, expenses] = await Promise.all([
      this.prisma.financeBudget.findMany({
        where: { userId, deletedAt: null },
        include: { category: true },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.financeTransaction.findMany({
        where: {
          account: { userId },
          type: FinanceTransactionType.EXPENSE,
          isExcludedFromBudget: false,
          currency: "INR",
          deletedAt: null,
          transactionDate: {
            gte: startOfMonth,
            lte: endOfMonth,
          },
        },
      }),
    ]);

    return budgets.map((b) => {
      const budgetAmount = Number(b.amountMinor);
      let spentMinor = 0;

      for (const tx of expenses) {
        if (!b.categoryId) {
          spentMinor += Number(tx.amountMinor);
        } else if (tx.categoryId === b.categoryId) {
          spentMinor += Number(tx.amountMinor);
        }
      }

      const percentUsed =
        budgetAmount > 0 ? (spentMinor / budgetAmount) * 100 : 0;

      return {
        ...formatBudgetResponse(b),
        spentMinor,
        remainingMinor: budgetAmount - spentMinor,
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
            ? { amountMinor: BigInt(Math.round(dto.amountMinor)) }
            : {}),
          ...(dto.period !== undefined ? { period: dto.period } : {}),
          ...(dto.startDate !== undefined
            ? { startDate: dto.startDate ? new Date(dto.startDate) : null }
            : {}),
          ...(dto.endDate !== undefined
            ? { endDate: dto.endDate ? new Date(dto.endDate) : null }
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
