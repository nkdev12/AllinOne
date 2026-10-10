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
  {
    name: "Food & Dining",
    type: FinanceTransactionType.EXPENSE,
    iconKey: "utensils",
    color: "#FF5722",
  },
  {
    name: "Groceries",
    type: FinanceTransactionType.EXPENSE,
    iconKey: "shopping-cart",
    color: "#4CAF50",
  },
  {
    name: "Transportation",
    type: FinanceTransactionType.EXPENSE,
    iconKey: "car",
    color: "#2196F3",
  },
  {
    name: "Utilities",
    type: FinanceTransactionType.EXPENSE,
    iconKey: "zap",
    color: "#FFC107",
  },
  {
    name: "Housing & Rent",
    type: FinanceTransactionType.EXPENSE,
    iconKey: "home",
    color: "#9C27B0",
  },
  {
    name: "Entertainment",
    type: FinanceTransactionType.EXPENSE,
    iconKey: "film",
    color: "#E91E63",
  },
  {
    name: "Healthcare",
    type: FinanceTransactionType.EXPENSE,
    iconKey: "activity",
    color: "#00BCD4",
  },
  {
    name: "Shopping",
    type: FinanceTransactionType.EXPENSE,
    iconKey: "bag",
    color: "#FF9800",
  },
  {
    name: "Education",
    type: FinanceTransactionType.EXPENSE,
    iconKey: "book",
    color: "#3F51B5",
  },
  {
    name: "Personal Care",
    type: FinanceTransactionType.EXPENSE,
    iconKey: "heart",
    color: "#F06292",
  },
  {
    name: "Salary",
    type: FinanceTransactionType.INCOME,
    iconKey: "briefcase",
    color: "#4CAF50",
  },
  {
    name: "Investments",
    type: FinanceTransactionType.INCOME,
    iconKey: "trending-up",
    color: "#009688",
  },
  {
    name: "Freelance",
    type: FinanceTransactionType.INCOME,
    iconKey: "laptop",
    color: "#8BC34A",
  },
  {
    name: "Gifts",
    type: FinanceTransactionType.INCOME,
    iconKey: "gift",
    color: "#AB47BC",
  },
  {
    name: "Other Income",
    type: FinanceTransactionType.INCOME,
    iconKey: "plus-circle",
    color: "#26A69A",
  },
  {
    name: "Other Expense",
    type: FinanceTransactionType.EXPENSE,
    iconKey: "more-horizontal",
    color: "#78909C",
  },
];

/**
 * The id a seeded default always gets for a given account.
 *
 * Seeding used to mint a fresh `uuid()` per row per call, so two devices that
 * hit `GET /finance/categories` while the account was empty produced two
 * different sets of the same sixteen labels, and a transaction booked against
 * one copy meant nothing on the other device. A deterministic id makes the seed
 * a no-op the second time: the row either exists or it does not, and the id is
 * known before the write.
 *
 * The shape is `system:<owner>:<slug>`, the scheme the Flutter client adopted
 * for its own local seeding. Canonicalising the name into the slug is the part
 * two implementations can disagree about, so it is spelled out: lowercase, every
 * run of characters outside `a-z0-9` collapses to a single `-`, no leading or
 * trailing `-`. "Food & Dining" -> `food-dining`, "Housing & Rent" ->
 * `housing-rent`.
 */
export function seedCategorySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function seededCategoryId(userId: string, name: string): string {
  return `system:${userId}:${seedCategorySlug(name)}`;
}

/**
 * The read `seedDefaults` needs, satisfied by both the client and a transaction
 * client so the pre-check and the in-transaction re-check share one code path.
 */
type CategoryReader = {
  financeCategory: {
    findMany: (args: any) => Promise<any[]>;
  };
};

/**
 * Whether a failed seed write means "somebody else created these rows first".
 *
 * Two concurrent GETs both see an empty account and both open a transaction over
 * the same deterministic ids; Prisma on MongoDB reports that as `P2002` (and,
 * depending on where the transaction aborts, as a raw duplicate-key error). It
 * is the expected outcome of the race, not a failure: the winner's rows are
 * already there, with their `Change` rows already appended, so the loser simply
 * stops. Anything else — a missing delegate, a bad document — still throws.
 */
function isAlreadySeeded(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? "";
  const message = (error as { message?: string })?.message ?? "";
  return (
    code === "P2002" ||
    code === "E11000" ||
    message.includes("DuplicateKey") ||
    message.includes("E11000")
  );
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly syncNotifications?: SyncNotificationService,
  ) {}

  /**
   * Lists one account's categories, seeding the defaults first if it has none.
   *
   * Tenancy: the read is scoped to `userId`, and rows with `userId: null` are
   * never served. Nothing in this repository creates a global row — the seed
   * writes owned copies flagged `isSystem: true`, and no other path creates a
   * category without an owner — so "system category" here means "a label the
   * account owns that it may not delete", not "a row shared between accounts".
   * That is deliberate and it is the safe side of the split: the client dropped
   * `isSystem` from its tenancy filter, so an owner scope on the server is the
   * only thing standing between one account and another's labels. The
   * consequence to know about is that a hand-inserted `userId: null` row would
   * be invisible to every `GET` while still being referenceable — the sync
   * projection treats a null category owner as usable by anybody
   * (`src/sync/change-projection.ts` `referenceIsUnusable`), and
   * `getCategoryById`/`updateCategory`/`deleteCategory` would all answer 404 for
   * it. Global labels should either be materialised per account (what the seed
   * does) or given a read path of their own; they should not be left as rows
   * only the write-side of the system can see.
   */
  async getCategories(userId: string, type?: FinanceTransactionType) {
    await this.seedDefaults(userId);

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

  /**
   * Creates any default this account does not already have, in one transaction,
   * logging a `Change` per row.
   *
   * Three things this replaces: a non-transactional loop of eight-plus creates
   * (a failure halfway left the account with a partial set), no `appendChange`
   * at all (a seeded category never reached the account's other devices, so a
   * transaction pointing at one resolved to nothing on the second phone), and a
   * `userCount === 0` gate that two concurrent GETs could both pass and so
   * double-seed the account.
   *
   * An already-seeded account costs one `findMany` over its own categories and
   * opens no transaction, so this is safe to call from the read path. The seed
   * is bounded: it writes a row only when neither the deterministic id nor a
   * live label of the same name and type exists, so a repeat GET is read-only.
   */
  async seedDefaults(userId: string) {
    const desired = DEFAULT_CATEGORIES.map((def) => ({
      ...def,
      id: seededCategoryId(userId, def.name),
    }));

    const stillMissing = async (reader: CategoryReader) => {
      // Deliberately unfiltered by `deletedAt` in the id sense and read in code
      // for the live labels: a default this account has ever carried is not
      // re-created, so a seed can never resurrect a label the user removed, and
      // MongoDB need not match a `deletedAt: null` predicate against documents
      // written before the field existed.
      const owned = await reader.financeCategory.findMany({
        where: { userId },
        select: { id: true, name: true, type: true, deletedAt: true },
      });
      const present = new Set(owned.map((row) => row.id));
      const liveLabels = new Set(
        owned
          .filter((row) => !row.deletedAt)
          .map((row) => `${row.type}:${row.name}`),
      );

      // Labels the account already carries under a legacy id. Before
      // deterministic seeding every seed minted `uuid()`s, so an existing
      // account's defaults have no id this function can name; matching on
      // name+type keeps this from handing that account a second, parallel set
      // of the same sixteen labels.
      return desired.filter((row) => {
        if (present.has(row.id)) return false;
        return !liveLabels.has(`${row.type}:${row.name}`);
      });
    };

    const missing = await stillMissing(this.prisma);
    if (missing.length === 0) return;

    let highestCursor: bigint | undefined;

    try {
      await this.prisma.$transaction(async (tx) => {
        // Re-read inside the transaction. The check above is only an
        // optimisation: a device that raced this request commits its own seed
        // between the two reads, and the ids it wrote are the ids about to be
        // written here.
        for (const def of await stillMissing(tx)) {
          const category = await tx.financeCategory.create({
            data: {
              id: def.id,
              userId,
              name: def.name,
              type: def.type,
              iconKey: def.iconKey,
              color: def.color,
              isSystem: true,
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
        }
      });
    } catch (error) {
      if (!isAlreadySeeded(error)) throw error;
      return;
    }

    if (highestCursor !== undefined) {
      this.syncNotifications?.notifyMutation({ userId, highestCursor });
    }
  }

  async getCategoryById(userId: string, id: string) {
    const category = await this.prisma.financeCategory.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!category) {
      throw new NotFoundException(
        `Finance category with ID '${id}' not found.`,
      );
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
      throw new NotFoundException(
        `Finance category with ID '${id}' not found.`,
      );
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
      throw new NotFoundException(
        `Finance category with ID '${id}' not found.`,
      );
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
