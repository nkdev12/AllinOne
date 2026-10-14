import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import { CreateGoalDto } from "./dto/create-goal.dto";
import { DepositGoalDto } from "./dto/deposit-goal.dto";
import { UpdateGoalDto } from "./dto/update-goal.dto";
import { appendChange } from "@/sync/change-cursor";
import {
  minorUnitsAfter,
  toDateOrThrow,
  toMinorUnits,
} from "@/finance/finance.helpers";
import { ChangeOperation } from "@prisma/client";

function formatGoalResponse(goal: any) {
  return {
    ...goal,
    targetAmountMinor: Number(goal.targetAmountMinor),
    currentAmountMinor: Number(goal.currentAmountMinor),
  };
}

function goalChangePayload(goal: any): Record<string, any> {
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
    const targetAmountMinor = toMinorUnits(
      dto.targetAmountMinor,
      "targetAmountMinor",
    );
    const currentAmountMinor = toMinorUnits(
      dto.currentAmountMinor ?? 0,
      "currentAmountMinor",
    );
    if (targetAmountMinor <= 0n) {
      throw new BadRequestException("targetAmountMinor must be positive.");
    }
    if (currentAmountMinor < 0n) {
      throw new BadRequestException(
        "currentAmountMinor cannot be negative — use a deposit to add to a goal.",
      );
    }
    const targetDate = dto.targetDate
      ? toDateOrThrow(dto.targetDate, "targetDate")
      : undefined;
    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const goal = await tx.financeSavingsGoal.create({
        data: {
          userId,
          name: dto.name,
          targetAmountMinor,
          currentAmountMinor,
          targetDate,
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

    const depositMinor = toMinorUnits(dto.amountMinor, "amountMinor");
    if (depositMinor <= 0n) {
      throw new BadRequestException("amountMinor must be greater than zero.");
    }
    let highestCursor: bigint | undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      // `$inc`, not `existing.currentAmountMinor + depositMinor` written as an
      // absolute value: two deposits that read the same 1000 used to both write
      // 1500, so one of them evaporated. The row handed back is the post-increment
      // document, so the flag, the payload and the response all describe the value
      // that is actually stored even when another writer committed mid-tx.
      let goal = await tx.financeSavingsGoal.update({
        where: { id },
        data: {
          currentAmountMinor: { increment: depositMinor },
          version: { increment: 1 },
        },
      });

      const currentAmountMinor = minorUnitsAfter(
        goal.currentAmountMinor,
        existing.currentAmountMinor,
        depositMinor,
      );
      const isCompleted = currentAmountMinor >= goal.targetAmountMinor;
      if (Boolean(goal.isCompleted) !== isCompleted) {
        // Only the deposit that really crosses the target rewrites the flag.
        goal = await tx.financeSavingsGoal.update({
          where: { id },
          data: { isCompleted },
        });
      }

      const postImage = { ...goal, currentAmountMinor, isCompleted };

      const logged = await appendChange(tx, {
        entityType: "finance_savings_goal",
        entityId: postImage.id,
        operation: ChangeOperation.UPDATE,
        version: postImage.version,
        payload: goalChangePayload(postImage),
        userId,
      });
      highestCursor = logged.cursor;

      return postImage;
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
      // An explicit amount here is the author of the goal stating the saved
      // total, so it is written as given (guarded) rather than as a delta.
      const targetAmount =
        dto.targetAmountMinor !== undefined
          ? toMinorUnits(dto.targetAmountMinor, "targetAmountMinor")
          : existing.targetAmountMinor;
      const currentAmount =
        dto.currentAmountMinor !== undefined
          ? toMinorUnits(dto.currentAmountMinor, "currentAmountMinor")
          : existing.currentAmountMinor;
      if (targetAmount <= 0n) {
        throw new BadRequestException("targetAmountMinor must be positive.");
      }
      if (currentAmount < 0n) {
        throw new BadRequestException("currentAmountMinor cannot be negative.");
      }
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
            ? {
                targetDate: dto.targetDate
                  ? toDateOrThrow(dto.targetDate, "targetDate")
                  : null,
              }
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
