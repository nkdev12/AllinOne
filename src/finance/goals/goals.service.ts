import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import { CreateGoalDto } from "./dto/create-goal.dto";
import { DepositGoalDto } from "./dto/deposit-goal.dto";
import { UpdateGoalDto } from "./dto/update-goal.dto";
import { appendChange } from "@/sync/change-cursor";
import { ChangeOperation } from "@prisma/client";

export function formatGoalResponse(goal: any) {
  return {
    ...goal,
    targetAmountMinor: Number(goal.targetAmountMinor),
    currentAmountMinor: Number(goal.currentAmountMinor),
  };
}

export function goalChangePayload(goal: any): Record<string, any> {
  return {
    name: goal.name,
    targetAmountMinor: Number(goal.targetAmountMinor),
    currentAmountMinor: Number(goal.currentAmountMinor),
    targetDate:
      goal.targetDate instanceof Date
        ? goal.targetDate.toISOString()
        : (goal.targetDate ?? null),
    color: goal.color ?? null,
    iconKey: goal.iconKey ?? null,
    isCompleted: goal.isCompleted ?? false,
    createdAt:
      goal.createdAt instanceof Date
        ? goal.createdAt.toISOString()
        : (goal.createdAt ?? null),
    version: goal.version ?? 1,
  };
}

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly syncNotifications?: SyncNotificationService,
  ) {}

  async createGoal(userId: string, dto: CreateGoalDto) {
    const targetAmountMinor = BigInt(Math.round(dto.targetAmountMinor));
    const currentAmountMinor = BigInt(Math.round(dto.currentAmountMinor ?? 0));
    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const goal = await tx.financeSavingsGoal.create({
        data: {
          userId,
          name: dto.name,
          targetAmountMinor,
          currentAmountMinor,
          targetDate: dto.targetDate ? new Date(dto.targetDate) : undefined,
          color: dto.color,
          iconKey: dto.iconKey,
          isCompleted: currentAmountMinor >= targetAmountMinor,
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_savings_goal",
        entityId: goal.id,
        operation: ChangeOperation.CREATE,
        version: goal.version,
        payload: goalChangePayload(goal),
        userId,
      });
      highestCursor = logged.cursor;

      return goal;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatGoalResponse(created);
  }

  async getGoals(userId: string) {
    const goals = await this.prisma.financeSavingsGoal.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
    return goals.map(formatGoalResponse);
  }

  async getGoalById(userId: string, id: string) {
    const goal = await this.prisma.financeSavingsGoal.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!goal) {
      throw new NotFoundException(`Savings goal with ID ${id} not found`);
    }
    return formatGoalResponse(goal);
  }

  async depositToGoal(userId: string, id: string, dto: DepositGoalDto) {
    const existing = await this.prisma.financeSavingsGoal.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException(`Savings goal with ID ${id} not found`);
    }

    const depositMinor = BigInt(Math.round(dto.amountMinor));
    const newCurrent = existing.currentAmountMinor + depositMinor;
    const isCompleted = newCurrent >= existing.targetAmountMinor;
    let highestCursor: bigint | undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const goal = await tx.financeSavingsGoal.update({
        where: { id },
        data: {
          currentAmountMinor: newCurrent,
          isCompleted,
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_savings_goal",
        entityId: goal.id,
        operation: ChangeOperation.UPDATE,
        version: goal.version,
        payload: goalChangePayload(goal),
        userId,
      });
      highestCursor = logged.cursor;

      return goal;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatGoalResponse(updated);
  }

  async updateGoal(userId: string, id: string, dto: UpdateGoalDto) {
    const existing = await this.prisma.financeSavingsGoal.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException(`Savings goal with ID ${id} not found`);
    }

    let highestCursor: bigint | undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const targetAmount =
        dto.targetAmountMinor !== undefined
          ? BigInt(Math.round(dto.targetAmountMinor))
          : existing.targetAmountMinor;
      const currentAmount =
        dto.currentAmountMinor !== undefined
          ? BigInt(Math.round(dto.currentAmountMinor))
          : existing.currentAmountMinor;
      const isCompleted = currentAmount >= targetAmount;

      const goal = await tx.financeSavingsGoal.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.targetAmountMinor !== undefined
            ? { targetAmountMinor: targetAmount }
            : {}),
          ...(dto.currentAmountMinor !== undefined
            ? { currentAmountMinor: currentAmount }
            : {}),
          isCompleted,
          ...(dto.targetDate !== undefined
            ? { targetDate: dto.targetDate ? new Date(dto.targetDate) : null }
            : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
          ...(dto.iconKey !== undefined ? { iconKey: dto.iconKey } : {}),
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_savings_goal",
        entityId: goal.id,
        operation: ChangeOperation.UPDATE,
        version: goal.version,
        payload: goalChangePayload(goal),
        userId,
      });
      highestCursor = logged.cursor;

      return goal;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatGoalResponse(updated);
  }

  async deleteGoal(userId: string, id: string) {
    const existing = await this.prisma.financeSavingsGoal.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException(`Savings goal with ID ${id} not found`);
    }

    let highestCursor: bigint | undefined;

    await this.prisma.$transaction(async (tx) => {
      const goal = await tx.financeSavingsGoal.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_savings_goal",
        entityId: goal.id,
        operation: ChangeOperation.DELETE,
        version: goal.version,
        payload: {},
        userId,
      });
      highestCursor = logged.cursor;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return { success: true };
  }
}
