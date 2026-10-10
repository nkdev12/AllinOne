import { ChangeOperation, FinanceTransactionType } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  CategoriesService,
  seedCategorySlug,
  seededCategoryId,
} from "./categories.service";

/** How many labels the default set carries; the spec asserts against it. */
const DEFAULT_LABELS = 16;
const userId = "user-cccccccc-cccc-cccc-cccc-cccccccccccc";
const otherUserId = "user-ffffffff-ffff-ffff-ffff-ffffffffffff";

interface Row {
  id: string;
  userId: string | null;
  name: string;
  type: string;
  iconKey: string | null;
  color: string | null;
  parentId: string | null;
  isSystem: boolean;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
}

interface FakeOptions {
  /**
   * Makes the read inside the transaction answer as it did before anybody else
   * committed — the shape of the race two concurrent GETs actually create, where
   * the duplicate key only surfaces at write time.
   */
  staleReadInsideTransaction?: boolean;
  /** Runs when `$transaction` opens, i.e. after the caller's pre-check. */
  onTransactionStart?: () => void;
}

/**
 * A category table with the two delegate shapes `seedDefaults` touches, plus the
 * `change` / `syncCursor` pair `appendChange` writes through.
 *
 * `deletedAt: null` is matched as MongoDB matches it — absent or null — so a row
 * created without the field is still listed.
 */
function fakeStore(options: FakeOptions = {}) {
  const categories: Row[] = [];
  const changes: any[] = [];
  let seq = BigInt(0);
  let transactionCount = 0;

  const matches = (row: Row, where: any) =>
    (!where?.userId || row.userId === where.userId) &&
    (where?.deletedAt === undefined ||
      (where.deletedAt === null
        ? !row.deletedAt
        : row.deletedAt === undefined));

  const financeCategory = {
    findMany: jest.fn(async ({ where }: any = {}) => {
      const hits = categories.filter((row) => matches(row, where));
      return hits.map((row) => ({ ...row }));
    }),
    count: jest.fn(async ({ where }: any = {}) => {
      return categories.filter((row) => matches(row, where)).length;
    }),
    create: jest.fn(async ({ data }: any) => {
      if (categories.some((row) => row.id === data.id)) {
        throw Object.assign(new Error("Unique constraint failed E11000"), {
          code: "P2002",
        });
      }
      const row: Row = {
        parentId: null,
        isSystem: false,
        version: 1,
        deletedAt: null,
        createdAt: new Date(),
        ...data,
      };
      categories.push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ data }: any) => ({ id: "unused", ...data })),
  };

  const prisma: any = {
    financeCategory,
    change: {
      create: jest.fn(async ({ data }: any) => {
        changes.push(data);
        return { id: `change-${changes.length}`, ...data };
      }),
    },
    syncCursor: {
      upsert: jest.fn(async () => {
        seq += BigInt(1);
        return { seq };
      }),
    },
    $transaction: jest.fn(async (fn: any) => {
      transactionCount += 1;
      options.onTransactionStart?.();
      const tx: any = {
        financeCategory,
        change: prisma.change,
        syncCursor: prisma.syncCursor,
      };
      if (options.staleReadInsideTransaction) {
        // The loser of the race re-reads a snapshot taken before the winner
        // committed, and only finds out at write time.
        tx.financeCategory = {
          ...financeCategory,
          findMany: jest.fn(async () => []),
        };
      }
      return fn(tx);
    }),
    __state: { categories, changes },
    __transactionCount: () => transactionCount,
  };

  return prisma;
}

function serviceFor(prisma: any) {
  const notifyMutation = jest.fn();
  const service = new CategoriesService(
    prisma as unknown as PrismaService,
    { notifyMutation } as any,
  );
  return { service, notifyMutation };
}

describe("categories.integrity — seeding", () => {
  it("mints a deterministic id per user and label", () => {
    expect(seedCategorySlug("Food & Dining")).toBe("food-dining");
    expect(seedCategorySlug("Housing & Rent")).toBe("housing-rent");
    expect(seedCategorySlug("Other Income")).toBe("other-income");
    expect(seededCategoryId(userId, "Groceries")).toBe(
      `system:${userId}:groceries`,
    );
    // The owner is in the id, so two accounts can never mint the same row.
    expect(seededCategoryId(otherUserId, "Groceries")).not.toBe(
      seededCategoryId(userId, "Groceries"),
    );
  });

  it("seeds every default in one transaction and logs a Change per row", async () => {
    const prisma = fakeStore();
    const { service, notifyMutation } = serviceFor(prisma);

    const rows = await service.getCategories(userId);

    expect(rows).toHaveLength(DEFAULT_LABELS);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.financeCategory.create).toHaveBeenCalledTimes(DEFAULT_LABELS);
    expect(prisma.change.create).toHaveBeenCalledTimes(DEFAULT_LABELS);

    // A seeded label the other devices have never heard of is a transaction
    // pointing at nothing, so the cursor the log reached must be handed to the
    // notification the fan-out listens for.
    expect(prisma.change.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId,
        entityType: "finance_category",
        entityId: seededCategoryId(userId, "Salary"),
        operation: ChangeOperation.CREATE,
        version: 1,
      }),
    });
    expect(notifyMutation).toHaveBeenCalledWith({
      userId,
      highestCursor: BigInt(DEFAULT_LABELS),
    });

    // Every cursor is distinct and ascending: two rows sharing one cursor are
    // skipped together by a pull that has already passed it.
    const cursors = prisma.__state.changes.map((c: any) => c.cursor.toString());
    expect(new Set(cursors).size).toBe(DEFAULT_LABELS);
  });

  it("is idempotent: a second GET writes nothing", async () => {
    const prisma = fakeStore();
    const { service, notifyMutation } = serviceFor(prisma);

    await service.getCategories(userId);
    prisma.financeCategory.create.mockClear();
    prisma.change.create.mockClear();
    prisma.$transaction.mockClear();
    notifyMutation.mockClear();

    const rows = await service.getCategories(userId);

    expect(rows).toHaveLength(DEFAULT_LABELS);
    expect(prisma.financeCategory.create).not.toHaveBeenCalled();
    expect(prisma.change.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notifyMutation).not.toHaveBeenCalled();
    expect(prisma.__state.categories).toHaveLength(DEFAULT_LABELS);
  });

  it("does not re-mint labels an account already carries under a legacy uuid id", async () => {
    const prisma = fakeStore();
    // The shape produced by the old seed: same names, random ids, no `Change`.
    for (const name of ["Food & Dining", "Groceries", "Salary"]) {
      await prisma.financeCategory.create({
        data: {
          id: `legacy-${name.replace(/\W+/g, "-")}`,
          userId,
          name,
          type: name === "Salary" ? "INCOME" : "EXPENSE",
          iconKey: null,
          color: null,
          isSystem: true,
          version: 1,
          deletedAt: null,
          createdAt: new Date(),
        },
      });
    }

    const { service } = serviceFor(prisma);
    const rows = await service.getCategories(userId);

    // Three legacy labels stay three rows; the thirteen the account lacks are
    // added under their deterministic ids. No parallel set of the same names.
    expect(rows).toHaveLength(DEFAULT_LABELS);
    expect(rows.filter((row: any) => row.name === "Groceries")).toHaveLength(1);
    const legacyGroceries = rows.find((row: any) => row.name === "Groceries");
    expect(legacyGroceries?.id).toBe("legacy-Groceries");
    expect(prisma.change.create).toHaveBeenCalledTimes(DEFAULT_LABELS - 3);
  });

  it("never resurrects a default the account removed", async () => {
    const prisma = fakeStore();
    const { service } = serviceFor(prisma);
    await service.getCategories(userId);

    await prisma.financeCategory.update({
      where: { id: seededCategoryId(userId, "Shopping") },
      data: { deletedAt: new Date() },
    });
    prisma.__state.categories.find(
      (row: Row) => row.id === seededCategoryId(userId, "Shopping"),
    ).deletedAt = new Date();

    prisma.financeCategory.create.mockClear();
    prisma.change.create.mockClear();

    const rows = await service.getCategories(userId);

    expect(prisma.financeCategory.create).not.toHaveBeenCalled();
    expect(prisma.change.create).not.toHaveBeenCalled();
    expect(rows.map((row: any) => row.name)).not.toContain("Shopping");
  });

  it("survives the concurrent-GET race without rejecting or double-seeding", async () => {
    // A second device commits the identical seed after this request's pre-check
    // and before its transaction reads, so the transaction sees nothing and its
    // first create collides on the deterministic id.
    const winner = fakeStore();
    const winnerService = new CategoriesService(
      winner as unknown as PrismaService,
    );
    await winnerService.seedDefaults(userId);
    expect(winner.__state.categories).toHaveLength(DEFAULT_LABELS);

    const loser = fakeStore({
      staleReadInsideTransaction: true,
      onTransactionStart: () =>
        loser.__state.categories.push(
          ...winner.__state.categories.map((row: Row) => ({ ...row })),
        ),
    });
    const { service: second } = serviceFor(loser);

    const rows = await second.getCategories(userId);

    expect(rows).toHaveLength(DEFAULT_LABELS);
    expect(new Set(rows.map((row: any) => row.id)).size).toBe(DEFAULT_LABELS);
    // The loser contributed no rows and no log entries: the winner's set, with
    // its sixteen `Change` rows, is the whole account.
    expect(loser.change.create).not.toHaveBeenCalled();
    expect(winner.__state.changes).toHaveLength(DEFAULT_LABELS);
  });

  it("refuses to seed into another account's rows and lists only its own", async () => {
    const prisma = fakeStore();
    const { service: owner } = serviceFor(prisma);
    await owner.getCategories(userId);

    // A global label somebody inserted by hand.
    await prisma.financeCategory.create({
      data: {
        id: "system:global:food-dining",
        userId: null,
        name: "Food & Dining",
        type: FinanceTransactionType.EXPENSE,
        isSystem: true,
        version: 1,
      },
    });

    const { service: neighbour } = serviceFor(prisma);
    const rows = await neighbour.getCategories(otherUserId);

    expect(rows.every((row: any) => row.userId === otherUserId)).toBe(true);
    // The owner-scoped read is the only tenancy filter left now that the client
    // has dropped `isSystem`: neither the neighbour nor the global row leaks.
    expect(rows.map((row: any) => row.id)).not.toContain(
      "system:global:food-dining",
    );
    expect(rows.filter((row: any) => row.userId === null)).toHaveLength(0);

    const backToOwner = await owner.getCategories(userId);
    expect(backToOwner).toHaveLength(DEFAULT_LABELS);
    expect(
      backToOwner.filter((row: any) => row.userId !== userId),
    ).toHaveLength(0);
  });
});
