import "reflect-metadata";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ChangeOperation, FinanceSplitType } from "@prisma/client";
import { GroupsService } from "./groups.service";
import { TripsService } from "../trips/trips.service";
import { allocateExpenseShares } from "./group-validation";
import { CreateSharedExpenseDto } from "./dto/create-shared-expense.dto";
import { CreateSettlementDto } from "./dto/create-settlement.dto";
import { CreateTripDto } from "../trips/dto/create-trip.dto";
import { CreateItineraryItemDto } from "../trips/dto/create-itinerary-item.dto";
import { UpdateSharedExpenseDto } from "./dto/update-shared-expense.dto";
import { UpdateSettlementDto } from "./dto/update-settlement.dto";
import { changePayloadViolations } from "@/sync/change-payload.validator";

const USER = "user-owner";
const FOREIGN_USER = "user-someone-else";
const EDITOR = "user-editor";
const VIEWER = "user-viewer";
const GROUP = "group-1";
const TRIP = "trip-1";
const FOREIGN_TRIP = "trip-foreign";
const UUID = "2f8e8c96-4a5b-4c11-9d3e-77f0a1c2b3d4";
const FOREIGN_UUID = "7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

function matchesWhere(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, condition]) => {
    const value = row[key];
    if (condition === null) return value === null || value === undefined;
    const isFilter =
      condition &&
      typeof condition === "object" &&
      !(condition instanceof Date);
    if (isFilter) {
      return Object.entries(condition as any).every(
        ([op, operand]: [string, any]) => {
          if (op === "in") return operand.includes(value);
          if (op === "not") return value !== operand;
          if (op === "gte") return value >= operand;
          if (op === "lte") return value <= operand;
          throw new Error(`unsupported operator ${op}`);
        },
      );
    }
    return value === condition;
  });
}

function bump(row: any, data: any) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (key === "version" && (value as any)?.increment) {
      row.version += (value as any).increment;
    } else if (key === "shares" && (value as any)?.create) {
      continue;
    } else {
      row[key] = value;
    }
  }
}

/**
 * A store that filters on the `where` the service actually wrote, so a missing
 * owner check shows up as a rejected request instead of a mock that returns any
 * row it is asked for. `$transaction` bodies are run one at a time, which is the
 * property the settlement fix leans on: the balance read and the settlement
 * write share a critical section.
 */
function createStore() {
  const state = {
    groups: [] as any[],
    trips: [] as any[],
    itineraries: [] as any[],
    expenses: [] as any[],
    shares: [] as any[],
    settlements: [] as any[],
    accounts: [] as any[],
    attachments: [] as any[],
    grants: [] as any[],
    changes: [] as any[],
    ops: [] as string[],
    cursor: BigInt(0),
  };

  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;

  const sharesOf = (expenseId: string) =>
    state.shares.filter((share) => share.sharedExpenseId === expenseId);

  const byUserId = (rows: any[]) =>
    [...rows].sort((a, b) =>
      a.userId === b.userId ? 0 : a.userId < b.userId ? -1 : 1,
    );

  /**
   * Mirrors `include: { shares: { where: … } }` — the nested filter is applied
   * here rather than ignored, so a read path that forgets `deletedAt: null` gets
   * the tombstoned rows back and a test notices. An ignored `where` would have
   * made the whole half-migration invisible from inside this suite.
   *
   * Rows are handed back as copies, because that is what a query returns: a live
   * object out of `state` would let the service read its own write back through
   * the row it had already bumped, and a version it never advanced would look
   * correct here and be wrong against the database.
   */
  const withShares = (row: any, include: any) => {
    if (!include?.shares) return { ...row };
    const where = include.shares.where;
    return {
      ...row,
      shares: sharesOf(row.id)
        .filter((share) => where === undefined || matchesWhere(share, where))
        .map((share) => ({ ...share })),
    };
  };

  const client: any = {
    $transaction: async (fn: any) => {
      state.ops.push("$transaction");
      const run = () => fn(client);
      client.__queue = (client.__queue ?? Promise.resolve()).then(run, run);
      return client.__queue;
    },
    financeGroup: {
      create: async ({ data }: any) => {
        const row = {
          id: id("group"),
          members: [],
          version: 1,
          deletedAt: null,
          isArchived: false,
          createdAt: new Date(),
          ...data,
        };
        state.groups.push(row);
        return { ...row };
      },
      findFirst: async ({ where }: any) =>
        state.groups.find((row) => matchesWhere(row, where)) ?? null,
      findMany: async ({ where }: any) =>
        state.groups.filter((row) => matchesWhere(row, where ?? {})),
      update: async ({ where, data }: any) => {
        const row = state.groups.find((g) => g.id === where.id)!;
        bump(row, data);
        return { ...row };
      },
    },
    financeTrip: {
      create: async ({ data }: any) => {
        const row = {
          id: id("trip"),
          destinations: [],
          version: 1,
          deletedAt: null,
          isArchived: false,
          itineraryItems: [],
          createdAt: new Date(),
          ...data,
        };
        state.trips.push(row);
        return { ...row };
      },
      findFirst: async ({ where }: any) => {
        const row = state.trips.find((trip) => matchesWhere(trip, where));
        if (!row) return null;
        return {
          ...row,
          itineraryItems: state.itineraries.filter(
            (item) => item.tripId === row.id && item.deletedAt === null,
          ),
        };
      },
      findMany: async ({ where }: any) =>
        state.trips.filter((row) => matchesWhere(row, where ?? {})),
      update: async ({ where, data }: any) => {
        const row = state.trips.find((trip) => trip.id === where.id)!;
        bump(row, data);
        return { ...row, itineraryItems: [] };
      },
    },
    financeTripItinerary: {
      create: async ({ data }: any) => {
        const row = {
          id: id("iti"),
          sortOrder: 0,
          version: 1,
          deletedAt: null,
          createdAt: new Date(),
          ...data,
        };
        state.itineraries.push(row);
        return { ...row };
      },
      findFirst: async ({ where }: any) =>
        state.itineraries.find((row) => matchesWhere(row, where)) ?? null,
      findMany: async ({ where }: any) =>
        state.itineraries.filter((row) => matchesWhere(row, where ?? {})),
      update: async ({ where, data }: any) => {
        const row = state.itineraries.find((item) => item.id === where.id)!;
        bump(row, data);
        return { ...row };
      },
    },
    financeSharedExpense: {
      create: async ({ data, include }: any) => {
        const row: any = {
          id: id("exp"),
          version: 1,
          deletedAt: null,
          createdAt: new Date(),
          ...data,
          shares: undefined,
        };
        state.expenses.push(row);
        for (const share of data.shares?.create ?? []) {
          state.shares.push({
            id: id("share"),
            sharedExpenseId: row.id,
            isSettled: false,
            settledAt: null,
            deletedAt: null,
            version: 1,
            createdAt: new Date(),
            ...share,
          });
        }
        return withShares(row, include);
      },
      findFirst: async ({ where, include }: any) => {
        const row = state.expenses.find((exp) => matchesWhere(exp, where));
        return row ? withShares(row, include) : null;
      },
      findMany: async ({ where, include }: any) =>
        state.expenses
          .filter((exp) => matchesWhere(exp, where ?? {}))
          .map((exp) => withShares(exp, include)),
      update: async ({ where, data }: any) => {
        const row = state.expenses.find((exp) => exp.id === where.id)!;
        bump(row, data);
        return { ...row };
      },
    },
    financeExpenseShare: {
      findMany: async ({ where, orderBy }: any) => {
        state.ops.push("read:share");
        const rows = state.shares.filter((share) =>
          matchesWhere(share, where ?? {}),
        );
        const ordered = orderBy?.userId === "asc" ? byUserId(rows) : rows;
        return ordered.map((share) => ({ ...share }));
      },
      create: async ({ data }: any) => {
        state.ops.push("create:share");
        const row = {
          id: id("share"),
          isSettled: false,
          settledAt: null,
          deletedAt: null,
          version: 1,
          createdAt: new Date(),
          ...data,
        };
        state.shares.push(row);
        return { ...row };
      },
      update: async ({ where, data }: any) => {
        state.ops.push("update:share");
        const row = state.shares.find((share) => share.id === where.id)!;
        bump(row, data);
        return { ...row };
      },
    },
    resourceShare: {
      findFirst: async ({ where }: any) =>
        state.grants.find((grant) => matchesWhere(grant, where)) ?? null,
      findMany: async ({ where }: any) =>
        state.grants.filter((grant) => matchesWhere(grant, where ?? {})),
    },
    financeSettlement: {
      create: async ({ data }: any) => {
        state.ops.push("create:settlement");
        const row = {
          id: id("set"),
          version: 1,
          deletedAt: null,
          createdAt: new Date(),
          ...data,
        };
        state.settlements.push(row);
        return { ...row };
      },
      findFirst: async ({ where }: any) =>
        state.settlements.find((row) => matchesWhere(row, where)) ?? null,
      findMany: async ({ where }: any) => {
        state.ops.push("read:settlement");
        return state.settlements.filter((row) =>
          matchesWhere(row, where ?? {}),
        );
      },
      update: async ({ where, data }: any) => {
        const row = state.settlements.find((s) => s.id === where.id)!;
        bump(row, data);
        return { ...row };
      },
    },
    financeAccount: {
      findFirst: async ({ where }: any) =>
        state.accounts.find((row) => matchesWhere(row, where)) ?? null,
    },
    attachment: {
      findFirst: async ({ where }: any) =>
        state.attachments.find((row) => matchesWhere(row, where)) ?? null,
    },
    syncCursor: {
      upsert: async () => {
        state.cursor += BigInt(1);
        return { seq: state.cursor };
      },
    },
    change: {
      create: async ({ data }: any) => {
        const row = { id: id("chg"), ...data };
        state.changes.push(row);
        return row;
      },
    },
  };

  return { client, state };
}

function seedGroup(store: ReturnType<typeof createStore>, overrides: any = {}) {
  const row = {
    id: GROUP,
    ownerId: USER,
    name: "Roadtrip",
    members: [],
    currency: "INR",
    version: 1,
    isArchived: false,
    deletedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
  store.state.groups.push(row);
  return row;
}

function seedTrip(store: ReturnType<typeof createStore>, overrides: any = {}) {
  const row = {
    id: TRIP,
    ownerId: USER,
    title: "Goa",
    destinations: ["Goa"],
    startDate: new Date("2026-11-01"),
    endDate: new Date("2026-11-05"),
    baseCurrency: "INR",
    totalBudgetMinor: BigInt(500000),
    isArchived: false,
    version: 1,
    deletedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
  store.state.trips.push(row);
  return row;
}

function expenseDto(overrides: any = {}): any {
  return {
    title: "Dinner",
    totalAmountMinor: 10000,
    paidByUserId: "Alice",
    date: "2026-10-10T20:00:00.000Z",
    splitType: FinanceSplitType.EQUAL,
    shares: [{ userId: "Alice" }, { userId: "Bob" }, { userId: "Charlie" }],
    ...overrides,
  };
}

function settlementDto(overrides: any = {}): any {
  return {
    fromUserId: "Bob",
    toUserId: "Alice",
    amountMinor: 10000,
    date: "2026-10-11T20:00:00.000Z",
    ...overrides,
  };
}

function changesFor(state: any, entityType: string, operation?: string) {
  return state.changes.filter(
    (entry: any) =>
      entry.entityType === entityType &&
      (operation === undefined || entry.operation === operation),
  );
}

function deletedIds(state: any, entityType: string): string[] {
  return changesFor(state, entityType, ChangeOperation.DELETE).map(
    (change: any) => change.entityId,
  );
}

/** A `ResourceShare` grant on the seeded group, in the shape the store reads. */
function seedGrant(store: ReturnType<typeof createStore>, overrides: any = {}) {
  const row = {
    id: `grant-${store.state.grants.length + 1}`,
    resourceType: "EXPENSE_GROUP",
    resourceId: GROUP,
    ownerId: USER,
    sharedWithUserId: EDITOR,
    sharedWithEmail: "editor@example.test",
    role: "EDITOR",
    deletedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
  store.state.grants.push(row);
  return row;
}

function last(rows: any[]) {
  return rows[rows.length - 1];
}

/**
 * A three-person split with known amounts, so a test can say exactly which rows
 * an edit was allowed to touch: `EXACT` keeps the client's numbers instead of
 * reallocating them, and the rows come back ordered by `userId`.
 */
async function seedExactSplit(store: ReturnType<typeof createStore>) {
  seedGroup(store);
  const service = new GroupsService(store.client);
  const expense = await service.addSharedExpense(
    USER,
    GROUP,
    expenseDto({
      splitType: FinanceSplitType.EXACT,
      paidByUserId: "Alice",
      totalAmountMinor: 10000,
      shares: [
        { userId: "Alice", owedAmountMinor: 4000 },
        { userId: "Bob", owedAmountMinor: 3000 },
        { userId: "Charlie", owedAmountMinor: 3000 },
      ],
    }),
  );
  return { service, expense };
}

async function invalidFields(dtoClass: any, payload: any): Promise<string[]> {
  const instance = plainToInstance(dtoClass, payload);
  const errors = await validate(instance, { skipMissingProperties: false });
  return errors.map((error) => error.property);
}

describe("group share allocation", () => {
  it("splits 10000 three ways as 3334/3333/3333 and sums to the total", () => {
    const shares = allocateExpenseShares(
      10000,
      [{ userId: "Charlie" }, { userId: "Alice" }, { userId: "Bob" }],
      FinanceSplitType.EQUAL,
    );

    expect(shares.map((s) => s.userId)).toEqual(["Alice", "Bob", "Charlie"]);
    expect(shares.map((s) => s.owedAmountMinor)).toEqual([3334, 3333, 3333]);
    expect(shares.reduce((sum, s) => sum + s.owedAmountMinor, 0)).toBe(10000);
  });

  it("is order-independent, so two devices compute the same rows", () => {
    const a = allocateExpenseShares(
      10000,
      [{ userId: "Zed" }, { userId: "Ann" }, { userId: "Mia" }],
      FinanceSplitType.EQUAL,
    );
    const b = allocateExpenseShares(
      10000,
      [{ userId: "Mia" }, { userId: "Zed" }, { userId: "Ann" }],
      FinanceSplitType.EQUAL,
    );
    expect(a).toEqual(b);
  });

  it("honours weights for PERCENTAGE and SHARES", () => {
    expect(
      allocateExpenseShares(
        1000,
        [
          { userId: "Ann", shareUnits: 70 },
          { userId: "Bob", shareUnits: 30 },
        ],
        FinanceSplitType.PERCENTAGE,
      ).map((s) => s.owedAmountMinor),
    ).toEqual([700, 300]);

    expect(
      allocateExpenseShares(
        999,
        [
          { userId: "Ann", shareUnits: 2 },
          { userId: "Bob", shareUnits: 1 },
        ],
        FinanceSplitType.SHARES,
      ).map((s) => s.owedAmountMinor),
    ).toEqual([666, 333]);
  });

  it("only checks the sum for EXACT, and rejects an unbalanced EXACT set", () => {
    expect(
      allocateExpenseShares(
        10000,
        [
          { userId: "Ann", owedAmountMinor: 6000 },
          { userId: "Bob", owedAmountMinor: 4000 },
        ],
        FinanceSplitType.EXACT,
      ).map((s) => s.owedAmountMinor),
    ).toEqual([6000, 4000]);

    expect(() =>
      allocateExpenseShares(
        10000,
        [
          { userId: "Ann", owedAmountMinor: 6000 },
          { userId: "Bob", owedAmountMinor: 3999 },
        ],
        FinanceSplitType.EXACT,
      ),
    ).toThrow(BadRequestException);
  });
});

describe("GroupsService shared expenses", () => {
  it("accepts an honest three-way EQUAL split the old sum check rejected", async () => {
    const store = createStore();
    seedGroup(store);
    const service = new GroupsService(store.client);

    const expense = await service.addSharedExpense(USER, GROUP, expenseDto());

    expect(expense.shares.map((s: any) => s.owedAmountMinor)).toEqual([
      3334, 3333, 3333,
    ]);
    expect(expense.totalAmountMinor).toBe(10000);
  });

  it("stores the split type and weights it derived the amounts from", async () => {
    const store = createStore();
    seedGroup(store);
    const service = new GroupsService(store.client);

    await service.addSharedExpense(
      USER,
      GROUP,
      expenseDto({
        totalAmountMinor: 999,
        splitType: FinanceSplitType.SHARES,
        shares: [
          { userId: "Bob", shareUnits: 1 },
          { userId: "Alice", shareUnits: 2 },
        ],
      }),
    );

    const row = store.state.expenses[0];
    expect(row.splitType).toBe(FinanceSplitType.SHARES);
    const stored = store.state.shares.map((share: any) => [
      share.userId,
      String(share.owedAmountMinor),
    ]);
    expect(stored).toEqual([
      ["Alice", "666"],
      ["Bob", "333"],
    ]);
  });

  it("normalises the currency it writes for the group", async () => {
    const store = createStore();
    const group = seedGroup(store, { currency: "inr" });
    const service = new GroupsService(store.client);

    const created = await service.createGroup(USER, {
      name: "Cabin",
      currency: "usd",
    } as any);
    expect(created.currency).toBe("USD");

    const expense = await service.addSharedExpense(
      USER,
      group.id,
      expenseDto({ currency: "inr" }),
    );
    expect(store.state.expenses[0].id).toBe(expense.id);
    expect(store.state.expenses[0].currency).toBe("INR");
  });

  it("rejects a tripId that belongs to somebody else", async () => {
    const store = createStore();
    seedGroup(store);
    seedTrip(store, {
      id: FOREIGN_TRIP,
      ownerId: FOREIGN_USER,
      baseCurrency: "INR",
    });
    const service = new GroupsService(store.client);

    await expect(
      service.addSharedExpense(
        USER,
        GROUP,
        expenseDto({ tripId: FOREIGN_TRIP }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.state.expenses).toHaveLength(0);
    expect(changesFor(store.state, "finance_shared_expense")).toHaveLength(0);
  });

  it("rejects a payer account the user does not own", async () => {
    const store = createStore();
    seedGroup(store);
    store.state.accounts.push({
      id: FOREIGN_UUID,
      userId: FOREIGN_USER,
      currency: "INR",
      deletedAt: null,
    });
    const service = new GroupsService(store.client);

    await expect(
      service.addSharedExpense(
        USER,
        GROUP,
        expenseDto({ payerAccountId: FOREIGN_UUID }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    store.state.accounts.push({
      id: UUID,
      userId: USER,
      currency: "INR",
      deletedAt: null,
    });
    const expense = await service.addSharedExpense(
      USER,
      GROUP,
      expenseDto({ payerAccountId: UUID }),
    );
    expect(expense.payerAccountId).toBe(UUID);
  });

  it("rejects a receipt attachment that is not the user's", async () => {
    const store = createStore();
    seedGroup(store);
    store.state.attachments.push({ id: FOREIGN_UUID, userId: FOREIGN_USER });
    const service = new GroupsService(store.client);

    await expect(
      service.addSharedExpense(
        USER,
        GROUP,
        expenseDto({ receiptAttachmentId: FOREIGN_UUID }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("answers 400, not RangeError, for an out-of-range total", async () => {
    const store = createStore();
    seedGroup(store);
    const service = new GroupsService(store.client);

    await expect(
      service.addSharedExpense(
        USER,
        GROUP,
        expenseDto({ totalAmountMinor: Number.POSITIVE_INFINITY }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.addSharedExpense(
        USER,
        GROUP,
        expenseDto({ totalAmountMinor: 2 ** 53 }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("settlement overdraft", () => {
  async function seedDebt(store: ReturnType<typeof createStore>) {
    seedGroup(store);
    const service = new GroupsService(store.client);
    await service.addSharedExpense(
      USER,
      GROUP,
      expenseDto({
        totalAmountMinor: 10000,
        splitType: FinanceSplitType.EXACT,
        shares: [
          { userId: "Alice", owedAmountMinor: 0 },
          { userId: "Bob", owedAmountMinor: 10000 },
        ],
        paidByUserId: "Alice",
      }),
    );
    return service;
  }

  it("refuses the second of two full-balance settlements", async () => {
    const store = createStore();
    const service = await seedDebt(store);

    const results = await Promise.allSettled([
      service.createSettlement(USER, GROUP, settlementDto()),
      service.createSettlement(USER, GROUP, settlementDto()),
    ]);

    const accepted = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as any).reason).toBeInstanceOf(BadRequestException);

    const summary = await service.getGroupBalancesAndSimplifiedDebts(
      USER,
      GROUP,
    );
    expect(summary.balances["Bob"]).toBe(0);
    expect(summary.balances["Alice"]).toBe(0);
  });

  it("reads the balances it checks against inside the transaction", async () => {
    const store = createStore();
    const service = await seedDebt(store);

    store.state.ops = [];
    await service.createSettlement(
      USER,
      GROUP,
      settlementDto({ amountMinor: 4000 }),
    );

    const tx = store.state.ops.indexOf("$transaction");
    const read = store.state.ops.indexOf("read:settlement");
    const write = store.state.ops.indexOf("create:settlement");
    expect(tx).toBe(0);
    expect(read).toBeGreaterThan(tx);
    expect(write).toBeGreaterThan(read);
  });

  it("keeps the group currency on the settlement row", async () => {
    const store = createStore();
    const service = await seedDebt(store);

    await service.createSettlement(
      USER,
      GROUP,
      settlementDto({ currency: "inr" }),
    );
    expect(store.state.settlements[0].currency).toBe("INR");

    await expect(
      service.createSettlement(USER, GROUP, settlementDto({ currency: "USD" })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("delete cascades to children", () => {
  it("tombstones a group's expenses and settlements with a DELETE change each", async () => {
    const store = createStore();
    const service = new GroupsService(store.client);
    seedGroup(store);
    await service.addSharedExpense(USER, GROUP, expenseDto());
    await service.addSharedExpense(USER, GROUP, expenseDto({ title: "Taxi" }));
    seedTrip(store);
    await service.createSettlement(
      USER,
      GROUP,
      settlementDto({ amountMinor: 100, tripId: TRIP }),
    );

    const expenseIds = store.state.expenses.map((row) => row.id);
    const settlementIds = store.state.settlements.map((row) => row.id);
    store.state.changes = [];

    await service.deleteGroup(USER, GROUP);

    expect(store.state.expenses.every((row) => row.deletedAt)).toBe(true);
    expect(store.state.settlements.every((row) => row.deletedAt)).toBe(true);
    expect(deletedIds(store.state, "finance_group")).toEqual([GROUP]);
    expect(deletedIds(store.state, "finance_shared_expense")).toEqual(
      expenseIds,
    );
    expect(deletedIds(store.state, "finance_settlement")).toEqual(
      settlementIds,
    );
    const cursors = store.state.changes.map((c) => c.cursor);
    expect(new Set(cursors.map(String)).size).toBe(cursors.length);
    await expect(service.getGroupById(USER, GROUP)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("tombstones a trip's plan, expenses and settlements", async () => {
    const store = createStore();
    const groups = new GroupsService(store.client);
    const trips = new TripsService(store.client);
    seedGroup(store);
    seedTrip(store);

    await trips.addItineraryItem(USER, TRIP, {
      dayIndex: 1,
      title: "Beach",
    } as any);
    await groups.addSharedExpense(USER, GROUP, expenseDto({ tripId: TRIP }));
    await groups.createSettlement(
      USER,
      GROUP,
      settlementDto({ amountMinor: 100, tripId: TRIP }),
    );

    const itineraryIds = store.state.itineraries.map((row) => row.id);
    const expenseIds = store.state.expenses.map((row) => row.id);
    const settlementIds = store.state.settlements.map((row) => row.id);
    store.state.changes = [];

    await trips.deleteTrip(USER, TRIP);

    expect(store.state.itineraries.every((row) => row.deletedAt)).toBe(true);
    expect(store.state.expenses.every((row) => row.deletedAt)).toBe(true);
    expect(store.state.settlements.every((row) => row.deletedAt)).toBe(true);
    expect(deletedIds(store.state, "finance_trip_itinerary")).toEqual(
      itineraryIds,
    );
    expect(deletedIds(store.state, "finance_shared_expense")).toEqual(
      expenseIds,
    );
    expect(deletedIds(store.state, "finance_settlement")).toEqual(
      settlementIds,
    );
    expect(deletedIds(store.state, "finance_trip")).toEqual([TRIP]);
  });
});

describe("trip currency", () => {
  it("rejects a trip expense in a currency other than the trip base currency", async () => {
    const store = createStore();
    const service = new GroupsService(store.client);
    seedGroup(store);
    seedTrip(store, { baseCurrency: "USD" });

    await expect(
      service.addSharedExpense(USER, GROUP, expenseDto({ tripId: TRIP })),
    ).rejects.toBeInstanceOf(BadRequestException);

    seedGroup(store, { id: "group-usd", currency: "USD" });
    await expect(
      service.addSharedExpense(
        USER,
        "group-usd",
        expenseDto({ tripId: TRIP, currency: "USD" }),
      ),
    ).resolves.toBeTruthy();
    expect(store.state.expenses[0].currency).toBe("USD");
  });

  it("reports per-currency subtotals instead of one mixed sum", async () => {
    const store = createStore();
    const trips = new TripsService(store.client);
    seedTrip(store, { baseCurrency: "INR", totalBudgetMinor: BigInt(300000) });
    const legacy = (id: string, currency: string, amount: number) => ({
      id,
      tripId: TRIP,
      groupId: null,
      totalAmountMinor: BigInt(amount),
      currency,
      paidByUserId: "Alice",
      deletedAt: null,
      version: 1,
    });
    store.state.expenses.push(
      legacy("exp-inr", "INR", 10000),
      legacy("exp-usd", "USD", 200000),
      legacy("exp-inr2", "inr", 5000),
    );
    store.state.itineraries.push({
      id: "iti-1",
      tripId: TRIP,
      dayIndex: 1,
      title: "Hotel",
      plannedCostMinor: BigInt(45000),
      sortOrder: 0,
      deletedAt: null,
      version: 1,
    });

    const stats: any = await trips.getTripStats(USER, TRIP);

    expect(stats.currency).toBe("INR");
    expect(stats.totalActualSpentMinor).toBe(15000);
    expect(stats.remainingBudgetMinor).toBe(285000);
    expect(stats.totalPlannedCostMinor).toBe(45000);
    expect(stats.expenseCount).toBe(3);
    expect(stats.subtotalsByCurrency).toEqual([
      { currency: "INR", totalAmountMinor: 15000, expenseCount: 2 },
      { currency: "USD", totalAmountMinor: 200000, expenseCount: 1 },
    ]);
  });

  it("normalises the base currency on write", async () => {
    const store = createStore();
    const trips = new TripsService(store.client);

    const trip: any = await trips.createTrip(USER, {
      title: "Dubai",
      startDate: "2026-12-01T00:00:00.000Z",
      endDate: "2026-12-08T00:00:00.000Z",
      baseCurrency: "aed",
      totalBudgetMinor: 100000,
    } as any);

    expect(trip.baseCurrency).toBe("AED");
    expect(store.state.trips[0].baseCurrency).toBe("AED");
  });
});

describe("DTO bounds", () => {
  const baseTrip = {
    title: "Goa",
    startDate: "2026-11-01T00:00:00.000Z",
    endDate: "2026-11-05T00:00:00.000Z",
  };

  it("caps the destination list", async () => {
    expect(await invalidFields(CreateTripDto, baseTrip)).toEqual([]);
    expect(
      await invalidFields(CreateTripDto, {
        ...baseTrip,
        destinations: ["somewhere"],
      }),
    ).toEqual([]);
    expect(
      await invalidFields(CreateTripDto, {
        ...baseTrip,
        destinations: Array.from({ length: 21 }, (_, i) => `place-${i}`),
      }),
    ).toContain("destinations");
    expect(
      await invalidFields(CreateTripDto, {
        ...baseTrip,
        totalBudgetMinor: Number.POSITIVE_INFINITY,
      }),
    ).toContain("totalBudgetMinor");
    expect(
      await invalidFields(CreateTripDto, {
        ...baseTrip,
        totalBudgetMinor: 1.5,
      }),
    ).toContain("totalBudgetMinor");
  });

  it("requires uuid-shaped references and bounded money on a shared expense", async () => {
    const valid = {
      title: "Dinner",
      totalAmountMinor: 10000,
      paidByUserId: "Alice",
      date: "2026-10-10T20:00:00.000Z",
      shares: [{ userId: "Alice" }],
    };
    expect(await invalidFields(CreateSharedExpenseDto, valid)).toEqual([]);
    expect(
      await invalidFields(CreateSharedExpenseDto, {
        ...valid,
        tripId: "not-a-uuid",
      }),
    ).toContain("tripId");
    expect(
      await invalidFields(CreateSharedExpenseDto, {
        ...valid,
        payerAccountId: "not-a-uuid",
      }),
    ).toContain("payerAccountId");
    expect(
      await invalidFields(CreateSharedExpenseDto, {
        ...valid,
        receiptAttachmentId: "not-a-uuid",
      }),
    ).toContain("receiptAttachmentId");
    expect(
      await invalidFields(CreateSharedExpenseDto, {
        ...valid,
        totalAmountMinor: Number.POSITIVE_INFINITY,
      }),
    ).toContain("totalAmountMinor");
    expect(
      await invalidFields(CreateSharedExpenseDto, { ...valid, shares: [] }),
    ).toContain("shares");
    expect(
      await invalidFields(CreateSharedExpenseDto, {
        ...valid,
        shares: Array.from({ length: 101 }, (_, i) => ({ userId: `u-${i}` })),
      }),
    ).toContain("shares");
    expect(
      await invalidFields(CreateSharedExpenseDto, {
        ...valid,
        shares: [{ userId: "Alice", shareUnits: -1 }],
      }),
    ).toContain("shares");
    expect(
      await invalidFields(CreateSharedExpenseDto, {
        ...valid,
        shares: [{ userId: "Alice", owedAmountMinor: 1.5 }],
      }),
    ).toContain("shares");
  });

  it("bounds settlement ids and amounts", async () => {
    expect(await invalidFields(CreateSettlementDto, settlementDto())).toEqual(
      [],
    );
    expect(
      await invalidFields(CreateSettlementDto, {
        ...settlementDto(),
        tripId: "nope",
      }),
    ).toContain("tripId");
    expect(
      await invalidFields(CreateSettlementDto, {
        ...settlementDto(),
        amountMinor: Number.POSITIVE_INFINITY,
      }),
    ).toContain("amountMinor");
    expect(
      await invalidFields(CreateSettlementDto, {
        ...settlementDto(),
        amountMinor: 0,
      }),
    ).toContain("amountMinor");
    expect(
      await invalidFields(CreateSettlementDto, {
        ...settlementDto(),
        fromUserId: "x".repeat(101),
      }),
    ).toContain("fromUserId");
  });

  it("bounds itinerary costs and day indexes", async () => {
    expect(
      await invalidFields(CreateItineraryItemDto, {
        dayIndex: 1,
        title: "Beach",
      }),
    ).toEqual([]);
    expect(
      await invalidFields(CreateItineraryItemDto, {
        dayIndex: 1,
        title: "Beach",
        plannedCostMinor: 2 ** 53,
      }),
    ).toContain("plannedCostMinor");
    expect(
      await invalidFields(CreateItineraryItemDto, {
        dayIndex: 0,
        title: "Beach",
      }),
    ).toContain("dayIndex");
  });

  it("keeps every create rule reachable one field at a time on the update DTOs", async () => {
    // An edit form sends one field. If `PartialType` had kept any of the create
    // DTO's `@IsNotEmpty`/`@ArrayNotEmpty` obligations, the form would 400 on a
    // payload that only renames the title.
    expect(await invalidFields(UpdateSharedExpenseDto, {})).toEqual([]);
    expect(
      await invalidFields(UpdateSharedExpenseDto, { title: "renamed" }),
    ).toEqual([]);
    expect(await invalidFields(UpdateSettlementDto, {})).toEqual([]);

    // …and the bounds themselves still bite when the field is sent.
    expect(
      await invalidFields(UpdateSharedExpenseDto, { shares: [] }),
    ).toContain("shares");
    expect(
      await invalidFields(UpdateSharedExpenseDto, {
        shares: Array.from({ length: 101 }, (_, i) => ({ userId: `u-${i}` })),
      }),
    ).toContain("shares");
    expect(
      await invalidFields(UpdateSharedExpenseDto, {
        shares: [{ userId: "Alice", owedAmountMinor: 1.5 }],
      }),
    ).toContain("shares");
    expect(
      await invalidFields(UpdateSharedExpenseDto, {
        payerAccountId: "not-a-uuid",
      }),
    ).toContain("payerAccountId");
    expect(
      await invalidFields(UpdateSettlementDto, { amountMinor: 0 }),
    ).toContain("amountMinor");
    expect(
      await invalidFields(UpdateSettlementDto, { tripId: "nope" }),
    ).toContain("tripId");
  });
});

describe("PATCH a shared expense", () => {
  it("edits one participant without recreating the others", async () => {
    const store = createStore();
    const { service, expense } = await seedExactSplit(store);
    const idsBefore = store.state.shares.map((row) => row.id);
    store.state.ops = [];
    store.state.changes = [];

    const updated = await service.updateSharedExpense(USER, GROUP, expense.id, {
      shares: [
        { userId: "Bob", owedAmountMinor: 3500 },
        { userId: "Charlie", owedAmountMinor: 2500 },
        { userId: "Alice", owedAmountMinor: 4000 },
      ],
    });

    // The whole point of the fix: the rows are the same rows, in the same order,
    // with new numbers on them.
    expect(store.state.shares.map((row) => row.id)).toEqual(idsBefore);
    expect(store.state.shares).toHaveLength(3);
    expect(store.state.ops.filter((op) => op === "create:share")).toHaveLength(
      0,
    );
    expect(store.state.ops.filter((op) => op === "update:share")).toHaveLength(
      2,
    );

    expect(
      updated.shares.map((s: any) => [s.userId, s.owedAmountMinor]),
    ).toEqual([
      ["Alice", 4000],
      ["Bob", 3500],
      ["Charlie", 2500],
    ]);

    // Only the rows that actually moved were written, so a version reads as the
    // history it claims: Alice's share was never touched by this request.
    const versions = new Map(
      store.state.shares.map((row) => [row.userId, row.version]),
    );
    expect(versions.get("Alice")).toBe(1);
    expect(versions.get("Bob")).toBe(2);
    expect(versions.get("Charlie")).toBe(2);
  });

  it("leaves every share row alone when the request does not mention the split", async () => {
    const store = createStore();
    const { service, expense } = await seedExactSplit(store);
    store.state.ops = [];

    await service.updateSharedExpense(USER, GROUP, expense.id, {
      title: "Dinner, with tips",
    });

    expect(
      store.state.ops.filter(
        (op) => op === "update:share" || op === "create:share",
      ),
    ).toHaveLength(0);
    expect(store.state.expenses[0].title).toBe("Dinner, with tips");
    expect(store.state.shares.every((row) => row.deletedAt === null)).toBe(
      true,
    );
  });

  it("tombstones a dropped participant instead of deleting the row", async () => {
    const store = createStore();
    const { service, expense } = await seedExactSplit(store);
    const charlie = store.state.shares.find((row) => row.userId === "Charlie");
    store.state.changes = [];

    await service.updateSharedExpense(USER, GROUP, expense.id, {
      shares: [
        { userId: "Alice", owedAmountMinor: 6000 },
        { userId: "Bob", owedAmountMinor: 4000 },
      ],
    });

    const kept = store.state.shares.find((row) => row.id === charlie.id);
    expect(kept).toBeTruthy();
    expect(kept.owedAmountMinor).toBe(BigInt(3000));
    expect(kept.deletedAt).toBeInstanceOf(Date);
    expect(kept.version).toBe(2);

    const listed = await service.getSharedExpenses(USER, GROUP);
    expect(listed[0].shares.map((s: any) => s.userId)).toEqual([
      "Alice",
      "Bob",
    ]);

    const change = last(
      changesFor(store.state, "finance_shared_expense", ChangeOperation.UPDATE),
    );
    expect(change.payload.shares.map((s: any) => s.userId)).toEqual([
      "Alice",
      "Bob",
    ]);
  });

  it("keeps a settled share settled when another field set is edited", async () => {
    const store = createStore();
    const { service, expense } = await seedExactSplit(store);
    const settledAt = new Date("2026-10-12T09:00:00.000Z");
    // What a second device left behind: Bob marked his own half paid.
    const bob = store.state.shares.find((row) => row.userId === "Bob");
    bob.isSettled = true;
    bob.settledAt = settledAt;
    store.state.changes = [];

    const updated = await service.updateSharedExpense(USER, GROUP, expense.id, {
      title: "Dinner, corrected",
      shares: [
        { userId: "Alice", owedAmountMinor: 5000 },
        { userId: "Bob", owedAmountMinor: 2500 },
        { userId: "Charlie", owedAmountMinor: 2500 },
      ],
    });

    // Bob's row is written by this edit (his amount moved) and still settles.
    const storedBob = store.state.shares.find((row) => row.userId === "Bob");
    expect(storedBob.isSettled).toBe(true);
    expect(storedBob.settledAt).toBe(settledAt);
    expect(Number(storedBob.owedAmountMinor)).toBe(2500);
    expect(
      (updated.shares as any[]).find((s) => s.userId === "Bob").isSettled,
    ).toBe(true);

    const payload = last(
      changesFor(store.state, "finance_shared_expense", ChangeOperation.UPDATE),
    ).payload;
    expect(payload.shares).toEqual([
      {
        userId: "Alice",
        owedAmountMinor: 5000,
        shareUnits: null,
        isSettled: false,
        settledAt: null,
        version: 2,
      },
      {
        userId: "Bob",
        owedAmountMinor: 2500,
        shareUnits: null,
        isSettled: true,
        settledAt: settledAt.toISOString(),
        version: 2,
      },
      {
        userId: "Charlie",
        owedAmountMinor: 2500,
        shareUnits: null,
        isSettled: false,
        settledAt: null,
        version: 2,
      },
    ]);
  });

  it("bumps the version, appends one UPDATE per recipient and notifies", async () => {
    const store = createStore();
    const notifications: any[] = [];
    const service = new GroupsService(store.client, {
      notifyMutation: (entry: any) => notifications.push(entry),
    } as any);
    seedGroup(store);
    seedGrant(store, { sharedWithUserId: EDITOR, role: "EDITOR" });
    const expense = await service.addSharedExpense(USER, GROUP, expenseDto());
    store.state.changes = [];
    // The CREATE notified too; only what the edit notifies is under test here.
    notifications.length = 0;

    await service.updateSharedExpense(USER, GROUP, expense.id, {
      title: "Dinner, split again",
    });

    expect(store.state.expenses[0].version).toBe(2);
    const updates = changesFor(
      store.state,
      "finance_shared_expense",
      ChangeOperation.UPDATE,
    );
    // owner + actor collapse to one recipient, the EDITOR grantee is the second.
    expect(updates).toHaveLength(2);
    expect(new Set(updates.map((change: any) => change.userId))).toEqual(
      new Set([USER, EDITOR]),
    );
    expect(updates.every((c: any) => c.version === 2)).toBe(true);
    expect(new Set(notifications.map((n) => String(n.highestCursor)))).toEqual(
      new Set(updates.map((c: any) => String(c.cursor))),
    );
  });

  it("re-runs the create path's rules on the fields it edits, and writes nothing", async () => {
    const store = createStore();
    const { service, expense } = await seedExactSplit(store);
    seedTrip(store, { id: FOREIGN_TRIP, ownerId: FOREIGN_USER });
    store.state.accounts.push({
      id: FOREIGN_UUID,
      userId: FOREIGN_USER,
      currency: "INR",
      deletedAt: null,
    });
    store.state.attachments.push({ id: FOREIGN_UUID, userId: FOREIGN_USER });
    const versionBefore = store.state.expenses[0].version;
    const idsBefore = store.state.shares.map((row) => row.id);

    const refused: Array<[any, any]> = [
      [{ currency: "USD" }, BadRequestException],
      [{ tripId: FOREIGN_TRIP }, ForbiddenException],
      [{ payerAccountId: FOREIGN_UUID }, BadRequestException],
      [{ receiptAttachmentId: FOREIGN_UUID }, BadRequestException],
      // 1..100 participants, unique ids, non-negative safe integers, and the
      // exact-sum contract — the same allocator the create path runs.
      [{ shares: [] }, BadRequestException],
      [
        { shares: [{ userId: "Alice" }, { userId: "Alice" }] },
        BadRequestException,
      ],
      [
        { shares: [{ userId: "Alice", owedAmountMinor: -1 }] },
        BadRequestException,
      ],
      [
        { shares: [{ userId: "Alice", owedAmountMinor: 9999 }] },
        BadRequestException,
      ],
      [{ totalAmountMinor: Number.POSITIVE_INFINITY }, BadRequestException],
      [
        {
          totalAmountMinor: 0,
          shares: [{ userId: "Alice", owedAmountMinor: 0 }],
        },
        BadRequestException,
      ],
    ];

    for (const [body, errorType] of refused) {
      await expect(
        service.updateSharedExpense(USER, GROUP, expense.id, body),
      ).rejects.toBeInstanceOf(errorType);
    }

    expect(store.state.expenses[0].version).toBe(versionBefore);
    expect(store.state.shares.map((row) => row.id)).toEqual(idsBefore);
    expect(store.state.shares.every((row) => row.deletedAt === null)).toBe(
      true,
    );
    expect(changesFor(store.state, "finance_shared_expense")).toHaveLength(1);
  });

  it("keeps a tombstoned share out of the balances and the suggested plan", async () => {
    const store = createStore();
    const { service, expense } = await seedExactSplit(store);

    await service.updateSharedExpense(USER, GROUP, expense.id, {
      shares: [
        { userId: "Alice", owedAmountMinor: 7000 },
        { userId: "Bob", owedAmountMinor: 3000 },
      ],
    });

    const summary = await service.getGroupBalancesAndSimplifiedDebts(
      USER,
      GROUP,
    );
    expect(summary.balances).toEqual({ Alice: 3000, Bob: -3000 });
    expect(Object.keys(summary.balances)).not.toContain("Charlie");
    expect(summary.simplifiedDebts).toEqual([
      { fromUserId: "Bob", toUserId: "Alice", amountMinor: 3000 },
    ]);
  });

  it("revives the dropped participant's own row when they are added back", async () => {
    const store = createStore();
    const { service, expense } = await seedExactSplit(store);
    const charlie = store.state.shares.find((row) => row.userId === "Charlie");

    await service.updateSharedExpense(USER, GROUP, expense.id, {
      shares: [
        { userId: "Alice", owedAmountMinor: 7000 },
        { userId: "Bob", owedAmountMinor: 3000 },
      ],
    });
    expect(charlie.deletedAt).toBeInstanceOf(Date);
    const versionAfterDrop = charlie.version;
    store.state.ops = [];
    store.state.changes = [];

    const updated = await service.updateSharedExpense(USER, GROUP, expense.id, {
      shares: [
        { userId: "Alice", owedAmountMinor: 4000 },
        { userId: "Bob", owedAmountMinor: 3000 },
        { userId: "Charlie", owedAmountMinor: 3000 },
      ],
    });

    // A rejoin writes the row that is already in the table, so nothing is
    // created and the expense still holds exactly one row per participant —
    // which is the property `@@index([sharedExpenseId, userId])` is documented
    // on, and the one the `/sync/push` diff and the client's `_syncShares`
    // already honour. Inserting instead leaves the tombstone orphaned forever.
    expect(store.state.ops.filter((op) => op === "create:share")).toHaveLength(
      0,
    );
    expect(store.state.shares).toHaveLength(3);
    const forCharlie = store.state.shares.filter(
      (row) => row.userId === "Charlie",
    );
    expect(forCharlie).toHaveLength(1);
    expect(forCharlie[0].id).toBe(charlie.id);
    expect(forCharlie[0].deletedAt).toBeNull();
    expect(Number(forCharlie[0].owedAmountMinor)).toBe(3000);
    expect(forCharlie[0].version).toBe(versionAfterDrop + 1);

    // Both the response and the appended change have to say "live", or a device
    // applying the payload would drop him again on arrival.
    const responded = (updated.shares as any[]).find(
      (share) => share.userId === "Charlie",
    );
    expect(responded).toMatchObject({ owedAmountMinor: 3000, deletedAt: null });
    const change = last(
      changesFor(store.state, "finance_shared_expense", ChangeOperation.UPDATE),
    );
    expect(change.payload.shares.map((s: any) => s.userId)).toEqual([
      "Alice",
      "Bob",
      "Charlie",
    ]);

    const listed = await service.getSharedExpenses(USER, GROUP);
    expect(listed[0].shares.map((s: any) => s.userId)).toEqual([
      "Alice",
      "Bob",
      "Charlie",
    ]);
  });

  it("writes nothing when a request replays a split that already has the rejoined participant", async () => {
    const store = createStore();
    const { service, expense } = await seedExactSplit(store);

    await service.updateSharedExpense(USER, GROUP, expense.id, {
      shares: [
        { userId: "Alice", owedAmountMinor: 7000 },
        { userId: "Bob", owedAmountMinor: 3000 },
      ],
    });
    const rejoined = [
      { userId: "Alice", owedAmountMinor: 4000 },
      { userId: "Bob", owedAmountMinor: 3000 },
      { userId: "Charlie", owedAmountMinor: 3000 },
    ];
    await service.updateSharedExpense(USER, GROUP, expense.id, {
      shares: rejoined,
    });

    const ids = store.state.shares.map((row) => row.id);
    const versions = new Map(
      store.state.shares.map((row) => [row.userId, row.version]),
    );
    store.state.ops = [];

    // The same request again: a second device replaying a split it already sent.
    // A revive that fired on "this participant has row history" instead of "this
    // participant's row is a tombstone" would bump every version on every replay.
    await service.updateSharedExpense(USER, GROUP, expense.id, {
      shares: rejoined,
    });

    expect(
      store.state.ops.filter(
        (op) => op === "update:share" || op === "create:share",
      ),
    ).toHaveLength(0);
    expect(store.state.shares.map((row) => row.id)).toEqual(ids);
    expect(
      new Map(store.state.shares.map((row) => [row.userId, row.version])),
    ).toEqual(versions);
  });

  it("neither invents a settlement on a rejoin nor erases the one it finds", async () => {
    const store = createStore();
    const { service, expense } = await seedExactSplit(store);
    const settledAt = new Date("2026-10-12T09:00:00.000Z");
    const bob = store.state.shares.find((row) => row.userId === "Bob");
    const charlie = store.state.shares.find((row) => row.userId === "Charlie");
    // What the settlement flow left behind: Bob paid, Charlie never did.
    bob.isSettled = true;
    bob.settledAt = settledAt;

    await service.updateSharedExpense(USER, GROUP, expense.id, {
      shares: [{ userId: "Alice", owedAmountMinor: 10000 }],
    });
    store.state.ops = [];

    await service.updateSharedExpense(USER, GROUP, expense.id, {
      shares: [
        { userId: "Alice", owedAmountMinor: 4000 },
        { userId: "Bob", owedAmountMinor: 3000 },
        { userId: "Charlie", owedAmountMinor: 3000 },
      ],
    });

    // The two rows the rejoin brought back are the ones a client actually reads,
    // and each keeps exactly the settle state it was left with: `isSettled` and
    // `settledAt` are not in an expense-edit payload, so the revive can neither
    // restore a settle nobody recorded for Charlie nor drop Bob's.
    const liveBob = store.state.shares.find(
      (row) => row.userId === "Bob" && row.deletedAt == null,
    );
    const liveCharlie = store.state.shares.find(
      (row) => row.userId === "Charlie" && row.deletedAt == null,
    );
    expect(liveBob.id).toBe(bob.id);
    expect(liveBob.isSettled).toBe(true);
    expect(liveBob.settledAt).toBe(settledAt);
    expect(liveCharlie.id).toBe(charlie.id);
    expect(liveCharlie.isSettled).toBe(false);
    expect(liveCharlie.settledAt).toBeNull();

    const payload = last(
      changesFor(store.state, "finance_shared_expense", ChangeOperation.UPDATE),
    ).payload;
    expect(payload.shares.map((s: any) => [s.userId, s.isSettled])).toEqual([
      ["Alice", false],
      ["Bob", true],
      ["Charlie", false],
    ]);
  });

  it("prefers the live row when an old rejoin left a participant both", async () => {
    const store = createStore();
    const { service, expense } = await seedExactSplit(store);
    const original = store.state.shares.find((row) => row.userId === "Charlie");
    // The artefact the pre-fix diff produced, in exactly this shape: the
    // tombstone it never looked at, plus the fresh live row its rejoin created.
    // Widening the read must not let the orphan win the key.
    original.deletedAt = new Date();
    original.version = 2;
    store.state.shares.push({
      ...original,
      id: "share-rejoined",
      deletedAt: null,
      version: 1,
      createdAt: new Date(original.createdAt.getTime() + 86_400_000),
      owedAmountMinor: BigInt(3000),
    });
    store.state.ops = [];
    store.state.changes = [];

    await service.updateSharedExpense(USER, GROUP, expense.id, {
      shares: [
        { userId: "Alice", owedAmountMinor: 5000 },
        { userId: "Bob", owedAmountMinor: 3000 },
        { userId: "Charlie", owedAmountMinor: 2000 },
      ],
    });

    expect(store.state.ops.filter((op) => op === "create:share")).toHaveLength(
      0,
    );
    const live = store.state.shares.find((row) => row.id === "share-rejoined");
    expect(live.deletedAt).toBeNull();
    expect(Number(live.owedAmountMinor)).toBe(2000);
    expect(live.version).toBe(2);
    // The orphan is not revived, and the departure loop — which still only walks
    // live rows — does not re-tombstone it either.
    expect(original.deletedAt).toBeInstanceOf(Date);
    expect(Number(original.owedAmountMinor)).toBe(3000);
    expect(original.version).toBe(2);
    expect(
      (await service.getSharedExpenses(USER, GROUP))[0].shares.filter(
        (s: any) => s.userId === "Charlie",
      ),
    ).toHaveLength(1);
  });

  it("revives the newest row when a participant has two tombstones", async () => {
    const store = createStore();
    const { service, expense } = await seedExactSplit(store);
    const charlie = store.state.shares.find((row) => row.userId === "Charlie");

    await service.updateSharedExpense(USER, GROUP, expense.id, {
      shares: [
        { userId: "Alice", owedAmountMinor: 6000 },
        { userId: "Bob", owedAmountMinor: 4000 },
      ],
    });
    const versionAfterDrop = charlie.version;
    // A second, older tombstone for the same participant — what two departures
    // across two transports leave behind. The row the other devices saw most
    // recently is the one that comes back.
    store.state.shares.push({
      ...charlie,
      id: "share-older-tombstone",
      version: 9,
      createdAt: new Date(charlie.createdAt.getTime() - 86_400_000),
    });
    store.state.ops = [];

    await service.updateSharedExpense(USER, GROUP, expense.id, {
      shares: [
        { userId: "Alice", owedAmountMinor: 4000 },
        { userId: "Bob", owedAmountMinor: 3000 },
        { userId: "Charlie", owedAmountMinor: 3000 },
      ],
    });

    expect(store.state.ops.filter((op) => op === "create:share")).toHaveLength(
      0,
    );
    expect(charlie.deletedAt).toBeNull();
    expect(charlie.version).toBe(versionAfterDrop + 1);
    const older = store.state.shares.find(
      (row) => row.id === "share-older-tombstone",
    );
    expect(older.deletedAt).toBeInstanceOf(Date);
    expect(older.version).toBe(9);
  });
});

describe("PATCH a settlement", () => {
  async function seededPayment() {
    const store = createStore();
    seedGroup(store);
    const service = new GroupsService(store.client);
    await service.addSharedExpense(
      USER,
      GROUP,
      expenseDto({
        splitType: FinanceSplitType.EXACT,
        paidByUserId: "Alice",
        totalAmountMinor: 10000,
        shares: [
          { userId: "Alice", owedAmountMinor: 0 },
          { userId: "Bob", owedAmountMinor: 10000 },
        ],
      }),
    );
    const settlement = await service.createSettlement(
      USER,
      GROUP,
      settlementDto({ amountMinor: 4000 }),
    );
    return { store, service, settlement };
  }

  it("corrects the payment against the balances that ignore it", async () => {
    const { store, service, settlement } = await seededPayment();
    store.state.changes = [];

    const updated = await service.updateSettlement(USER, GROUP, settlement.id, {
      amountMinor: 10000,
      paymentMethod: "UPI",
      notes: "the whole debt",
    });

    // Measured against the balances *including* this row, 10000 would look like a
    // 6000 overdraw and this honest correction would be refused.
    expect(Number(store.state.settlements[0].amountMinor)).toBe(10000);
    expect(store.state.settlements[0].paymentMethod).toBe("UPI");
    expect(updated.version).toBe(2);

    const summary = await service.getGroupBalancesAndSimplifiedDebts(
      USER,
      GROUP,
    );
    expect(summary.balances).toEqual({ Alice: 0, Bob: 0 });
    expect(summary.simplifiedDebts).toEqual([]);

    const change = last(
      changesFor(store.state, "finance_settlement", ChangeOperation.UPDATE),
    );
    expect(change.payload.amountMinor).toBe(10000);
    expect(change.payload.notes).toBe("the whole debt");
    expect(change.payload.createdAt).toBe(
      store.state.settlements[0].createdAt.toISOString(),
    );
  });

  it("refuses a correction that overdraws the debt, and writes nothing", async () => {
    const { store, service, settlement } = await seededPayment();
    store.state.changes = [];

    await expect(
      service.updateSettlement(USER, GROUP, settlement.id, {
        amountMinor: 10001,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(Number(store.state.settlements[0].amountMinor)).toBe(4000);
    expect(store.state.settlements[0].version).toBe(1);
    // The log was cleared above, so any row now would be the refused edit's own.
    expect(changesFor(store.state, "finance_settlement")).toHaveLength(0);
  });

  it("holds the currency lock and the party rules of the create path", async () => {
    const { store, service, settlement } = await seededPayment();
    seedTrip(store, { id: FOREIGN_TRIP, ownerId: FOREIGN_USER });

    await expect(
      service.updateSettlement(USER, GROUP, settlement.id, { currency: "usd" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateSettlement(USER, GROUP, settlement.id, { toUserId: "Bob" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateSettlement(USER, GROUP, settlement.id, {
        tripId: FOREIGN_TRIP,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(store.state.settlements[0].currency).toBe("INR");
    expect(store.state.settlements[0].toUserId).toBe("Alice");
  });
});

describe("PATCH authority", () => {
  async function seeded() {
    const store = createStore();
    const { service, expense } = await seedExactSplit(store);
    const settlement = await service.createSettlement(
      USER,
      GROUP,
      settlementDto({ amountMinor: 1000 }),
    );
    return { store, service, expense, settlement };
  }

  it("403s a VIEWER grantee and 404s a stranger on both routes", async () => {
    const { store, service, expense, settlement } = await seeded();
    seedGrant(store, {
      sharedWithUserId: VIEWER,
      role: "VIEWER",
      sharedWithEmail: "viewer@example.test",
    });

    await expect(
      service.updateSharedExpense(VIEWER, GROUP, expense.id, { title: "mine" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.updateSettlement(VIEWER, GROUP, settlement.id, { notes: "mine" }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      service.updateSharedExpense(FOREIGN_USER, GROUP, expense.id, {
        title: "mine",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.updateSettlement(FOREIGN_USER, GROUP, settlement.id, {
        notes: "mine",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(store.state.expenses[0].title).toBe("Dinner");
    expect(store.state.settlements[0].notes ?? null).toBe(null);
  });

  it("403s a revoked grant instead of reading the tombstone as a licence", async () => {
    const { store, service, expense } = await seeded();
    seedGrant(store, { deletedAt: new Date() });

    await expect(
      service.updateSharedExpense(EDITOR, GROUP, expense.id, { title: "mine" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // `getGroupById` has no live grant to find either, so the group stays
    // invisible to a revoked collaborator on both steps — never writable.
    expect(store.state.expenses[0].title).toBe("Dinner");
  });

  it("lets an EDITOR grantee through, the same caller the create path accepts", async () => {
    const { store, service, expense, settlement } = await seeded();
    seedGrant(store, {});
    const expenseVersion = store.state.expenses[0].version;
    store.state.changes = [];

    await expect(
      service.updateSharedExpense(EDITOR, GROUP, expense.id, {
        title: "renamed by the editor",
      }),
    ).resolves.toBeTruthy();
    await expect(
      service.updateSettlement(EDITOR, GROUP, settlement.id, {
        paymentMethod: "Cash",
      }),
    ).resolves.toBeTruthy();

    expect(store.state.expenses[0].version).toBe(expenseVersion + 1);
    expect(
      changesFor(store.state, "finance_shared_expense", ChangeOperation.UPDATE),
    ).toHaveLength(2);
    expect(
      changesFor(store.state, "finance_settlement", ChangeOperation.UPDATE),
    ).toHaveLength(2);
  });
});

describe("shares on the sync wire", () => {
  function expenseChange(shares: any, splitType = "EXACT") {
    return {
      entityType: "finance_shared_expense",
      operation: ChangeOperation.CREATE,
      payload: {
        groupId: GROUP,
        paidByUserId: "Alice",
        title: "Dinner",
        totalAmountMinor: 10000,
        currency: "INR",
        splitType,
        date: "2026-10-10T20:00:00.000Z",
        shares,
      },
    };
  }

  it("still accepts the three-key share the shipping builds send", () => {
    // Every phone that queued a split before this deploy sent exactly this, and
    // a rule that made the new keys mandatory would reject its own history.
    expect(
      changePayloadViolations(
        expenseChange([
          { userId: "Alice", owedAmountMinor: 4000, shareUnits: null },
          { userId: "Bob", owedAmountMinor: 6000, shareUnits: null },
        ]),
        0,
      ),
    ).toEqual([]);
    expect(
      changePayloadViolations(
        expenseChange([{ userId: "Alice", owedAmountMinor: 10000 }]),
        0,
      ),
    ).toEqual([]);
  });

  it("accepts a share that reports its own settlement state", () => {
    expect(
      changePayloadViolations(
        expenseChange([
          {
            userId: "Alice",
            owedAmountMinor: 4000,
            shareUnits: null,
            isSettled: true,
            settledAt: "2026-10-12T09:00:00.000Z",
            version: 3,
          },
          {
            userId: "Bob",
            owedAmountMinor: 6000,
            shareUnits: null,
            isSettled: false,
            settledAt: null,
            version: 1,
          },
        ]),
        0,
      ),
    ).toEqual([]);

    // The weight-only half of the rule agrees, or an EQUAL split carrying the
    // same keys would be refused by the branch that never saw them.
    expect(
      changePayloadViolations(
        expenseChange(
          [
            { userId: "Alice", shareUnits: 1, isSettled: false, version: 1 },
            { userId: "Bob", shareUnits: 2, settledAt: null },
          ],
          "SHARES",
        ),
        0,
      ),
    ).toEqual([]);
  });

  it("refuses a settlement flag no device could replay", () => {
    const refused = [
      { userId: "Alice", owedAmountMinor: 10000, isSettled: "yes" },
      { userId: "Alice", owedAmountMinor: 10000, settledAt: "last tuesday" },
      { userId: "Alice", owedAmountMinor: 10000, version: 0 },
      { userId: "Alice", owedAmountMinor: 10000, version: 1.5 },
    ];

    for (const share of refused) {
      expect(
        changePayloadViolations(expenseChange([share]), 0).map((v) => v.field),
      ).toEqual(["changes[0].payload.shares"]);
    }

    expect(
      changePayloadViolations(
        expenseChange(
          [{ userId: "Alice", shareUnits: 1, isSettled: 1 }],
          "EQUAL",
        ),
        0,
      ).map((v) => v.field),
    ).toEqual(["changes[0].payload.shares"]);
  });
});
