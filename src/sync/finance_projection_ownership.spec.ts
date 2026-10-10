import { Logger } from "@nestjs/common";
import { ChangeOperation } from "@prisma/client";
import {
  projectAcceptedChange,
  type ProjectableChange,
} from "./change-projection";

/**
 * The three rules a finance projection was missing: whose parent a child row
 * answers to, which version is allowed to overwrite what the table already
 * holds, and whose accounts a transaction may name.
 *
 * Each guard is proven from both sides — the push that must not write anything
 * and the owner's own push that must still land — because a projection that
 * refuses everything is as useless as one that accepts everything.
 */

const userId = "user-owner-11111111-1111-4111-8111-111111111111";
const victimId = "user-victim-22222222-2222-4222-8222-222222222222";

const tripId = "trip-33333333-3333-4333-8333-333333333333";
const itemId = "item-44444444-4444-4444-8444-444444444444";

// The `finance_account` row this file's account changes are keyed by is the same
// row a transaction names as its account, which is the whole point of the chain
// the reference check has to break.
const accountId = "acc-55555555-5555-4555-8555-555555555555";
const toAccountId = "acc-66666666-6666-4666-8666-666666666666";
const victimAccountId = "acc-77777777-7777-4777-8777-777777777777";
const categoryId = "cat-88888888-8888-4888-8888-888888888888";
const victimCategoryId = "cat-99999999-9999-4999-8999-999999999999";
const transactionId = "txn-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const delegates = (id: string, overrides: Record<string, jest.Mock> = {}) => ({
  findUnique: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({ id }),
  update: jest.fn().mockResolvedValue({ id }),
  ...overrides,
});

/**
 * A delegate that answers "whose row is this?" per id, the way the tables do:
 * `ownersById` maps an id to its owner, and anything not listed is a row the
 * collection has never seen.
 */
function ownerLookup(ownersById: Record<string, string>) {
  return jest.fn().mockImplementation((args: any) => {
    const id = args?.where?.id;
    return Promise.resolve(
      typeof id === "string" && ownersById[id] !== undefined
        ? { userId: ownersById[id] }
        : null,
    );
  });
}

function fakeFinanceTx(
  overrides: Record<string, Record<string, jest.Mock>> = {},
) {
  return {
    financeTrip: delegates(tripId, overrides.financeTrip),
    financeTripItinerary: delegates(itemId, overrides.financeTripItinerary),
    financeAccount: delegates(accountId, overrides.financeAccount),
    financeCategory: delegates(categoryId, overrides.financeCategory),
    financeTransaction: delegates(transactionId, overrides.financeTransaction),
  };
}

function change(over: Partial<ProjectableChange>): ProjectableChange {
  return {
    entityType: "finance_trip_itinerary",
    entityId: itemId,
    operation: ChangeOperation.CREATE,
    version: 1,
    payload: {},
    ...over,
  };
}

/** The row a projection reads before it decides; `version` is the whole point. */
function storedRow(over: Record<string, any> = {}): Record<string, any> {
  return { userId, deletedAt: null, version: 1, ...over };
}

function itineraryRow(over: Record<string, any> = {}): Record<string, any> {
  return { tripId, deletedAt: null, version: 1, ...over };
}

beforeAll(() => {
  // Every refusal below is a silent one on the log and a `logger.warn` in the
  // projection; the assertions are about the writes.
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

afterAll(() => jest.restoreAllMocks());

describe("finance_trip_itinerary ownership through its parent trip", () => {
  it("refuses a CREATE that plants an item on another user's trip", async () => {
    const tx = fakeFinanceTx({
      financeTrip: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ownerId: victimId, deletedAt: null }),
      },
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        payload: { tripId, title: "Airport pickup", dayIndex: 1 },
      }),
    );

    expect(tx.financeTripItinerary.create).not.toHaveBeenCalled();
  });

  it("refuses an UPDATE of an item that sits under another user's trip", async () => {
    const tx = fakeFinanceTx({
      financeTripItinerary: {
        findUnique: jest.fn().mockResolvedValue(itineraryRow({ version: 1 })),
      },
      financeTrip: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ownerId: victimId, deletedAt: null }),
      },
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        operation: ChangeOperation.UPDATE,
        version: 6,
        payload: { title: "Rewritten by a stranger" },
      }),
    );

    expect(tx.financeTripItinerary.update).not.toHaveBeenCalled();
  });

  it("resolves the owner before the DELETE branch, not after it", async () => {
    // The tombstone is the easiest cross-user write to hide: pre-fix it was the
    // first thing the function did, so nobody had yet been asked whose row it
    // was blanking out.
    const tx = fakeFinanceTx({
      financeTripItinerary: {
        findUnique: jest.fn().mockResolvedValue(itineraryRow({ version: 2 })),
      },
      financeTrip: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ownerId: victimId, deletedAt: new Date() }),
      },
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({ operation: ChangeOperation.DELETE, version: 9 }),
    );

    expect(tx.financeTripItinerary.update).not.toHaveBeenCalled();
  });

  it("refuses any change whose parent trip the table does not answer for", async () => {
    const tx = fakeFinanceTx();

    await projectAcceptedChange(
      tx,
      userId,
      change({ payload: { tripId, title: "Orphan item" } }),
    );

    expect(tx.financeTripItinerary.create).not.toHaveBeenCalled();
    expect(tx.financeTripItinerary.update).not.toHaveBeenCalled();
  });

  it("refuses a CREATE whose payload names no trip at all", async () => {
    const tx = fakeFinanceTx({
      financeTrip: {
        findUnique: jest.fn().mockResolvedValue({ ownerId: userId }),
      },
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({ payload: { title: "Tripless item" } }),
    );

    expect(tx.financeTrip.findUnique).not.toHaveBeenCalled();
    expect(tx.financeTripItinerary.create).not.toHaveBeenCalled();
  });

  it("trusts the row over the payload when both name a trip", async () => {
    // The caller owns the item and its trip, so the write goes through — but to
    // the trip the row is already under, and a payload `tripId` pointing
    // somewhere else is never written or even read.
    const tx = fakeFinanceTx({
      financeTripItinerary: {
        findUnique: jest.fn().mockResolvedValue(itineraryRow({ version: 1 })),
      },
      financeTrip: {
        findUnique: jest.fn().mockResolvedValue({ ownerId: userId }),
      },
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        operation: ChangeOperation.UPDATE,
        version: 2,
        payload: { tripId: victimAccountId, title: "Renamed" },
      }),
    );

    expect(tx.financeTrip.findUnique).toHaveBeenCalledWith({
      where: { id: tripId },
      select: { ownerId: true },
    });
    expect(tx.financeTripItinerary.update).toHaveBeenCalledTimes(1);
    expect(
      tx.financeTripItinerary.update.mock.calls[0][0].data,
    ).not.toHaveProperty("tripId");
  });

  it("still lets the trip's owner create, edit and tombstone their own item", async () => {
    const owned = {
      financeTrip: {
        findUnique: jest.fn().mockResolvedValue({ ownerId: userId }),
      },
    };

    const created = fakeFinanceTx(owned);
    await projectAcceptedChange(
      created,
      userId,
      change({ payload: { tripId, title: "Ferry to the island" } }),
    );
    expect(created.financeTripItinerary.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: itemId,
        tripId,
        title: "Ferry to the island",
        version: 1,
      }),
    });

    const edited = fakeFinanceTx({
      ...owned,
      financeTripItinerary: {
        findUnique: jest.fn().mockResolvedValue(itineraryRow({ version: 3 })),
      },
    });
    await projectAcceptedChange(
      edited,
      userId,
      change({
        operation: ChangeOperation.UPDATE,
        version: 4,
        payload: { tripId, title: "Ferry, 09:15" },
      }),
    );
    expect(edited.financeTripItinerary.update).toHaveBeenCalledWith({
      where: { id: itemId },
      data: expect.objectContaining({ title: "Ferry, 09:15", version: 4 }),
    });

    const deleted = fakeFinanceTx({
      ...owned,
      financeTripItinerary: {
        findUnique: jest.fn().mockResolvedValue(itineraryRow({ version: 4 })),
      },
    });
    await projectAcceptedChange(
      deleted,
      userId,
      change({ operation: ChangeOperation.DELETE, version: 5, payload: {} }),
    );
    expect(deleted.financeTripItinerary.update).toHaveBeenCalledWith({
      where: { id: itemId },
      data: expect.objectContaining({
        deletedAt: expect.any(Date),
        version: 5,
      }),
    });
  });
});

describe("the version tie rule on the three projections that skipped it", () => {
  const types: Array<{
    entityType: string;
    delegate: "financeAccount" | "financeCategory" | "financeTransaction";
    entityId: string;
    payload: Record<string, any>;
  }> = [
    {
      entityType: "finance_account",
      delegate: "financeAccount",
      entityId: accountId,
      payload: { name: "Renamed offline", currentBalanceMinor: 1 },
    },
    {
      entityType: "finance_category",
      delegate: "financeCategory",
      entityId: categoryId,
      payload: { name: "Renamed offline" },
    },
    {
      entityType: "finance_transaction",
      delegate: "financeTransaction",
      entityId: transactionId,
      payload: { title: "Renamed offline" },
    },
  ];

  for (const { entityType, delegate, entityId, payload } of types) {
    it(`asks the ${entityType} row for the version it holds`, async () => {
      const tx = fakeFinanceTx();

      await projectAcceptedChange(
        tx,
        userId,
        change({
          entityType,
          entityId,
          operation: ChangeOperation.UPDATE,
          version: 2,
          payload,
        }),
      );

      expect(tx[delegate].findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: entityId },
          select: expect.objectContaining({ version: true }),
        }),
      );
    });

    it(`refuses a stale ${entityType} UPDATE instead of rolling the version back`, async () => {
      // An offline device pushing version 3 over a row at 40 used to overwrite
      // it and stamp 3, after which every legitimate later change is refused as
      // stale by `sync.service.ts`.
      const tx = fakeFinanceTx({
        [delegate]: {
          findUnique: jest
            .fn()
            .mockResolvedValue(storedRow({ version: 40, deletedAt: null })),
        },
      });

      await projectAcceptedChange(
        tx,
        userId,
        change({
          entityType,
          entityId,
          operation: ChangeOperation.UPDATE,
          version: 3,
          payload,
        }),
      );

      expect(tx[delegate].update).not.toHaveBeenCalled();
    });

    it(`will not let an equal-versioned ${entityType} UPDATE clear a tombstone`, async () => {
      const tx = fakeFinanceTx({
        [delegate]: {
          findUnique: jest
            .fn()
            .mockResolvedValue(
              storedRow({ version: 7, deletedAt: new Date("2026-10-01") }),
            ),
        },
      });

      await projectAcceptedChange(
        tx,
        userId,
        change({
          entityType,
          entityId,
          operation: ChangeOperation.UPDATE,
          version: 7,
          payload,
        }),
      );

      expect(tx[delegate].update).not.toHaveBeenCalled();
    });

    it(`still projects a ${entityType} UPDATE that outranks what the row holds`, async () => {
      const tx = fakeFinanceTx({
        [delegate]: {
          findUnique: jest
            .fn()
            .mockResolvedValue(storedRow({ version: 40, deletedAt: null })),
        },
      });

      await projectAcceptedChange(
        tx,
        userId,
        change({
          entityType,
          entityId,
          operation: ChangeOperation.UPDATE,
          version: 41,
          payload,
        }),
      );

      expect(tx[delegate].update).toHaveBeenCalledWith({
        where: { id: entityId },
        data: expect.objectContaining({ version: 41, deletedAt: null }),
      });
    });
  }
});

describe("the references a pushed finance_transaction may name", () => {
  const createPayload = (over: Record<string, any> = {}) => ({
    accountId,
    type: "EXPENSE",
    amountMinor: 150000,
    title: "Team lunch",
    transactionDate: "2026-10-10T12:00:00.000Z",
    ...over,
  });

  it("drops a CREATE parked on another user's account", async () => {
    // Chained with REST: `deleteTransaction` and `updateTransaction` call
    // `adjustAccount`, which updates `financeAccount` by `{id}` alone, so a row
    // naming the victim's account moves the victim's balance the next time they
    // touch their own transaction.
    const tx = fakeFinanceTx({
      financeAccount: {
        findUnique: ownerLookup({ [victimAccountId]: victimId }),
      },
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        entityType: "finance_transaction",
        entityId: transactionId,
        payload: createPayload({ accountId: victimAccountId }),
      }),
    );

    expect(tx.financeTransaction.create).not.toHaveBeenCalled();
  });

  it("drops a TRANSFER whose destination is another user's account", async () => {
    const tx = fakeFinanceTx({
      financeAccount: {
        findUnique: ownerLookup({
          [accountId]: userId,
          [victimAccountId]: victimId,
        }),
      },
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        entityType: "finance_transaction",
        entityId: transactionId,
        payload: createPayload({
          type: "TRANSFER",
          toAccountId: victimAccountId,
        }),
      }),
    );

    expect(tx.financeTransaction.create).not.toHaveBeenCalled();
  });

  it("refuses an UPDATE that re-points the row at another user's account", async () => {
    const tx = fakeFinanceTx({
      financeTransaction: {
        findUnique: jest
          .fn()
          .mockResolvedValue(storedRow({ version: 1, deletedAt: null })),
      },
      financeAccount: {
        findUnique: ownerLookup({
          [accountId]: userId,
          [victimAccountId]: victimId,
        }),
      },
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        entityType: "finance_transaction",
        entityId: transactionId,
        operation: ChangeOperation.UPDATE,
        version: 2,
        payload: { accountId: victimAccountId },
      }),
    );

    expect(tx.financeTransaction.update).not.toHaveBeenCalled();
  });

  it("keeps another user's categoryId out of the write and lands the row anyway", async () => {
    const tx = fakeFinanceTx({
      financeAccount: { findUnique: ownerLookup({ [accountId]: userId }) },
      financeCategory: {
        findUnique: ownerLookup({ [victimCategoryId]: victimId }),
      },
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        entityType: "finance_transaction",
        entityId: transactionId,
        payload: createPayload({ categoryId: victimCategoryId }),
      }),
    );

    expect(tx.financeTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: transactionId,
        userId,
        accountId,
        categoryId: null,
      }),
    });
  });

  it("lands a CREATE whose references are all the caller's own", async () => {
    const tx = fakeFinanceTx({
      financeAccount: {
        findUnique: ownerLookup({
          [accountId]: userId,
          [toAccountId]: userId,
        }),
      },
      financeCategory: { findUnique: ownerLookup({ [categoryId]: userId }) },
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        entityType: "finance_transaction",
        entityId: transactionId,
        payload: createPayload({
          type: "TRANSFER",
          toAccountId,
          categoryId,
        }),
      }),
    );

    expect(tx.financeTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: transactionId,
        userId,
        accountId,
        toAccountId,
        categoryId,
        amountMinor: BigInt(150000),
      }),
    });
  });

  it("asks each account reference who owns it before writing either", async () => {
    const tx = fakeFinanceTx({
      financeAccount: {
        findUnique: ownerLookup({
          [accountId]: userId,
          [toAccountId]: userId,
        }),
      },
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        entityType: "finance_transaction",
        entityId: transactionId,
        payload: createPayload({ toAccountId }),
      }),
    );

    expect(tx.financeAccount.findUnique).toHaveBeenCalledWith({
      where: { id: accountId },
      select: { userId: true },
    });
    expect(tx.financeAccount.findUnique).toHaveBeenCalledWith({
      where: { id: toAccountId },
      select: { userId: true },
    });
  });
});
