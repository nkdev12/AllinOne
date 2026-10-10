import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";
import { appendChange } from "@/sync/change-cursor";
import { ChangeOperation, FinanceTransactionType } from "@prisma/client";

export function categoryChangePayload(cat: any): Record<string, any> {
  return {
    name: cat.name,
    type: cat.type,
    iconKey: cat.iconKey ?? null,
    color: cat.color ?? null,
    parentId: cat.parentId ?? null,
    isSystem: cat.isSystem ?? false,
    createdAt:
      cat.createdAt instanceof Date
        ? cat.createdAt.toISOString()
        : (cat.createdAt ?? null),
    version: cat.version ?? 1,
  };
}

const DEFAULT_CATEGORIES = [
  { name: "Food & Dining", type: FinanceTransactionType.EXPENSE, iconKey: "utensils", color: "#FF5722" },
  { name: "Groceries", type: FinanceTransactionType.EXPENSE, iconKey: "shopping-cart", color: "#4CAF50" },
  { name: "Transportation", type: FinanceTransactionType.EXPENSE, iconKey: "car", color: "#2196F3" },
  { name: "Utilities", type: FinanceTransactionType.EXPENSE, iconKey: "zap", color: "#FFC107" },
  { name: "Housing & Rent", type: FinanceTransactionType.EXPENSE, iconKey: "home", color: "#9C27B0" },
  { name: "Entertainment", type: FinanceTransactionType.EXPENSE, iconKey: "film", color: "#E91E63" },
  { name: "Healthcare", type: FinanceTransactionType.EXPENSE, iconKey: "activity", color: "#00BCD4" },
  { name: "Shopping", type: FinanceTransactionType.EXPENSE, iconKey: "bag", color: "#FF9800" },
  { name: "Education", type: FinanceTransactionType.EXPENSE, iconKey: "book", color: "#3F51B5" },
  { name: "Personal Care", type: FinanceTransactionType.EXPENSE, iconKey: "heart", color: "#F06292" },
  { name: "Salary", type: FinanceTransactionType.INCOME, iconKey: "briefcase", color: "#4CAF50" },
  { name: "Investments", type: FinanceTransactionType.INCOME, iconKey: "trending-up", color: "#009688" },
  { name: "Freelance", type: FinanceTransactionType.INCOME, iconKey: "laptop", color: "#8BC34A" },
  { name: "Gifts", type: FinanceTransactionType.INCOME, iconKey: "gift", color: "#AB47BC" },
  { name: "Other Income", type: FinanceTransactionType.INCOME, iconKey: "plus-circle", color: "#26A69A" },
  { name: "Other Expense", type: FinanceTransactionType.EXPENSE, iconKey: "more-horizontal", color: "#78909C" },
];

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly syncNotifications?: SyncNotificationService,
  ) {}

  async getCategories(userId: string, type?: FinanceTransactionType) {
    const userCount = await this.prisma.financeCategory.count({
      where: { userId, deletedAt: null },
    });

    if (userCount === 0) {
      await this.seedDefaults(userId);
    }

    const where: any = {
      userId,
      deletedAt: null,
    };
    if (type) {
      where.type = type;
    }

    return this.prisma.financeCategory.findMany({
      where,
      orderBy: [{ name: "asc" }],
    });
  }

  async seedDefaults(userId: string) {
    for (const def of DEFAULT_CATEGORIES) {
      await this.prisma.financeCategory.create({
        data: {
          userId,
          name: def.name,
          type: def.type,
          iconKey: def.iconKey,
          color: def.color,
          isSystem: true,
        },
      });
    }
  }

  async getCategoryById(userId: string, id: string) {
    const category = await this.prisma.financeCategory.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!category) {
      throw new NotFoundException(`Finance category with ID '${id}' not found.`);
    }

    return category;
  }

  async createCategory(userId: string, dto: CreateCategoryDto) {
    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const category = await tx.financeCategory.create({
        data: {
          userId,
          name: dto.name,
          type: dto.type ?? FinanceTransactionType.EXPENSE,
          iconKey: dto.iconKey,
          color: dto.color,
          parentId: dto.parentId,
          isSystem: false,
        },
      });

      const logged = await appendChange(tx, {
        userId,
        entityType: "finance_category",
        entityId: category.id,
        operation: ChangeOperation.CREATE,
        version: category.version,
        payload: categoryChangePayload(category),
      });
      highestCursor = logged.cursor;

      return category;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });
    return created;
  }

  async updateCategory(userId: string, id: string, dto: UpdateCategoryDto) {
    const existing = await this.prisma.financeCategory.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Finance category with ID '${id}' not found.`);
    }

    let highestCursor: bigint | undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const category = await tx.financeCategory.update({
        where: { id },
        data: {
          name: dto.name,
          type: dto.type,
          iconKey: dto.iconKey,
          color: dto.color,
          parentId: dto.parentId,
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        userId,
        entityType: "finance_category",
        entityId: category.id,
        operation: ChangeOperation.UPDATE,
        version: category.version,
        payload: categoryChangePayload(category),
      });
      highestCursor = logged.cursor;

      return category;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });
    return updated;
  }

  async deleteCategory(userId: string, id: string) {
    const existing = await this.prisma.financeCategory.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Finance category with ID '${id}' not found.`);
    }

    if (existing.isSystem) {
      throw new BadRequestException("System categories cannot be deleted.");
    }

    let highestCursor: bigint | undefined;

    const deleted = await this.prisma.$transaction(async (tx) => {
      const category = await tx.financeCategory.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        userId,
        entityType: "finance_category",
        entityId: category.id,
        operation: ChangeOperation.DELETE,
        version: category.version,
        payload: {},
      });
      highestCursor = logged.cursor;

      return { success: true };
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });
    return deleted;
  }
}
