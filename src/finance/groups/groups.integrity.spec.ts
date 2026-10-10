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

const USER = "user-owner";
const FOREIGN_USER = "user-someone-else";
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
    changes: [] as any[],
    ops: [] as string[],
    cursor: BigInt(0),
  };

  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;

  const sharesOf = (expenseId: string) =>
    state.shares.filter((share) => share.sharedExpenseId === expenseId);

  const withShares = (row: any, include: any) =>
    include?.shares ? { ...row, shares: sharesOf(row.id) } : { ...row };

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
});
