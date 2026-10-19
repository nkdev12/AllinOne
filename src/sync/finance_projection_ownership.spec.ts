import { ForbiddenException, Logger } from "@nestjs/common";
import { ChangeOperation } from "@prisma/client";
import {
  projectAcceptedChange,
  SYNC_PUSH_UNAUTHORIZED,
  type ChangeProjectionClient,
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

/**
 * The three references a shared expense carries about the people involved, all of
 * which the sync path used to copy out of the payload verbatim while
 * `POST /finance/groups/:id/expenses` resolved each one under the caller: who paid
 * (`paidByUserId`), whose money it came from (`payerAccountId`), and who owes what
 * back (`shares[].userId`).
 *
 * They matter out of proportion to one row. `replicateGroupChange`
 * (`sync.service.ts`) copies this change into the oplog of every account the group
 * answers to, so a forged id does not sit on the attacker's device — it lands in
 * the victim's own change stream and renders on their devices as something they
 * authored, while `readBalances` (`groups.service.ts:841`) settles from
 * `paidByUserId` who is owed and from the shares who owes. A group EDITOR could
 * therefore hand one of their own expenses to a richer member and take on a debt
 * they never had, in one push.
 */
describe("the payer, the payer account and the participants a pushed finance_shared_expense may name", () => {
  const groupId = "group-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const expenseId = "expense-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const memberId = "user-member-33333333-3333-4333-8333-333333333333";
  const granteeId = "user-grantee-44444444-4444-4444-8444-444444444444";
  const strangerId = "user-stranger-55555555-5555-5555-8555-555555555555";
  const tripOnlyId = "trip-66666666-6666-4666-8666-666666666666";

  type Fake = Record<string, any>;

  const groupRow = (over: Record<string, any> = {}) => ({
    ownerId: userId,
    deletedAt: null,
    currency: "INR",
    // The list the app itself writes: the pusher as `"You"` plus one registered
    // friend, both of which the client offers in its "Paid by" picker.
    members: [
      { id: "You", name: "You" },
      { id: memberId, name: "Priya" },
    ],
    ...over,
  });

  function expenseTx(
    over: {
      group?: Record<string, any> | null;
      grants?: Array<{ sharedWithUserId: string }> | undefined;
      canEdit?: boolean;
      accountOwners?: Record<string, string>;
      row?: Record<string, any> | null;
      trip?: Record<string, any> | null;
    } = {},
  ): Fake {
    return {
      financeGroup: {
        findUnique: jest
          .fn()
          .mockResolvedValue("group" in over ? over.group : groupRow()),
      },
      resourceShare: {
        // `findFirst` is the EDITOR/ADMIN grant `assertSharedScope` asks for;
        // `findMany` is that same grant list read whole as participants.
        findFirst: jest
          .fn()
          .mockResolvedValue(over.canEdit ? { id: "grant-1" } : null),
        findMany: jest
          .fn()
          .mockResolvedValue(over.grants ?? [{ sharedWithUserId: granteeId }]),
      },
      financeAccount: {
        findUnique: ownerLookup(over.accountOwners ?? { [accountId]: userId }),
      },
      financeTrip: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            "trip" in over
              ? over.trip
              : { ownerId: userId, deletedAt: null, baseCurrency: "INR" },
          ),
      },
      financeSharedExpense: {
        findUnique: jest.fn().mockResolvedValue(over.row ?? null),
        create: jest.fn().mockResolvedValue({ id: expenseId }),
        update: jest.fn().mockResolvedValue({ id: expenseId }),
      },
    };
  }

  const expensePayload = (over: Record<string, any> = {}) => ({
    groupId,
    paidByUserId: userId,
    title: "Weekend groceries",
    totalAmountMinor: 9000,
    currency: "INR",
    date: "2026-10-05T19:00:00.000Z",
    shares: [
      { userId, owedAmountMinor: 3000 },
      { userId: memberId, owedAmountMinor: 6000 },
    ],
    ...over,
  });

  const expenseChange = (
    payload: Record<string, any>,
    over: Partial<ProjectableChange> = {},
  ): ProjectableChange =>
    change({
      entityType: "finance_shared_expense",
      entityId: expenseId,
      payload: expensePayload(payload),
      ...over,
    });

  const pushExpense = (tx: Fake, target: ProjectableChange, user = userId) =>
    projectAcceptedChange(
      tx as unknown as ChangeProjectionClient,
      user,
      target,
    );

  const rejectionOf = async (
    tx: Fake,
    target: ProjectableChange,
    user = userId,
  ) => {
    const error: any = await pushExpense(tx, target, user).catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse().code).toBe(SYNC_PUSH_UNAUTHORIZED);
    return error.getResponse();
  };

  it("refuses a CREATE that credits the payment to somebody outside the group", async () => {
    const tx = expenseTx();

    const body = await rejectionOf(
      tx,
      expenseChange({ paidByUserId: strangerId }),
    );

    expect(body.details).toEqual({ groupId, paidByUserId: strangerId });
    expect(tx.financeSharedExpense.create).not.toHaveBeenCalled();
  });

  it("refuses an UPDATE that re-points an existing expense at a stranger", async () => {
    // The row already exists and the pusher may edit it, which is exactly the
    // half of the finding the create guard alone would not close: an EDITOR moves
    // the credit after the fact.
    const tx = expenseTx({
      row: {
        groupId,
        tripId: null,
        totalAmountMinor: BigInt(9000),
        splitType: "EXACT",
        deletedAt: null,
        version: 1,
      },
    });

    await rejectionOf(
      tx,
      expenseChange(
        { paidByUserId: strangerId },
        { operation: ChangeOperation.UPDATE, version: 2 },
      ),
    );

    expect(tx.financeSharedExpense.update).not.toHaveBeenCalled();
  });

  it("refuses a split that gives a share to somebody outside the group", async () => {
    const tx = expenseTx();

    const body = await rejectionOf(
      tx,
      expenseChange({
        shares: [
          { userId, owedAmountMinor: 3000 },
          { userId: strangerId, owedAmountMinor: 6000 },
        ],
      }),
    );

    // The offending id is named, because the change is already refused on its own
    // and the device has to be able to say which participant its picker offered.
    expect(body.details).toEqual({ groupId, participants: [strangerId] });
    expect(tx.financeSharedExpense.create).not.toHaveBeenCalled();
  });

  it("refuses a payer account that belongs to another user", async () => {
    const tx = expenseTx({
      accountOwners: { [victimAccountId]: victimId },
    });

    const body = await rejectionOf(
      tx,
      expenseChange({ payerAccountId: victimAccountId }),
    );

    expect(body.details).toEqual({ payerAccountId: victimAccountId });
    expect(tx.financeSharedExpense.create).not.toHaveBeenCalled();
  });

  it("refuses a foreign payer or participant on a trip-only expense, which has no list to check", async () => {
    const tx = expenseTx({ group: null });

    await rejectionOf(
      tx,
      expenseChange({
        groupId: null,
        tripId: tripOnlyId,
        paidByUserId: memberId,
      }),
    );
    expect(tx.financeSharedExpense.create).not.toHaveBeenCalled();

    const split = expenseTx({ group: null });
    await rejectionOf(
      split,
      expenseChange({
        groupId: null,
        tripId: tripOnlyId,
        shares: [{ userId: memberId, owedAmountMinor: 9000 }],
      }),
    );
    expect(split.financeSharedExpense.create).not.toHaveBeenCalled();
  });

  it("still credits a listed member, and lands the row", async () => {
    const tx = expenseTx();

    await pushExpense(tx, expenseChange({ paidByUserId: memberId }));

    expect(tx.financeSharedExpense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expenseId,
        groupId,
        paidByUserId: memberId,
      }),
    });
  });

  it('reads the client\'s local "You" as the pusher instead of an unknown id', async () => {
    // `"You"` is the self entry in the app's member list, not a user id, and a
    // device that queued an expense before its group snapshot landed would
    // otherwise lose it to a membership test it cannot pass yet.
    const tx = expenseTx();

    await pushExpense(tx, expenseChange({ paidByUserId: "You" }));

    expect(
      tx.financeSharedExpense.create.mock.calls[0][0].data.paidByUserId,
    ).toBe(userId);
  });

  it("accepts a group member's own account and the grant list as participants", async () => {
    // The pusher's own account for the money, and a participant who is not in the
    // `members` column but holds a live grant on the group — the same people
    // `replicateGroupChange` copies this row to.
    const tx = expenseTx({
      group: groupRow({ members: [{ id: "You", name: "You" }] }),
      grants: [{ sharedWithUserId: granteeId }],
    });

    await pushExpense(
      tx,
      expenseChange({
        payerAccountId: accountId,
        shares: [
          { userId, owedAmountMinor: 4000 },
          { userId: granteeId, owedAmountMinor: 5000 },
        ],
      }),
    );

    expect(tx.financeSharedExpense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paidByUserId: userId,
        payerAccountId: accountId,
      }),
    });
    expect(
      tx.financeSharedExpense.create.mock.calls[0][0].data.shares.create.map(
        (share: any) => share.userId,
      ),
    ).toEqual([granteeId, userId]);
  });

  it("lets an EDITOR who is not the owner write an honest split of their group", async () => {
    // The half that must not regress: this is the ordinary case the finding is not
    // about, and a guard that refused it would be worse than the hole.
    const tx = expenseTx({
      canEdit: true,
      grants: [{ sharedWithUserId: granteeId }],
    });

    await pushExpense(
      tx,
      expenseChange({
        paidByUserId: granteeId,
        shares: [
          { userId: granteeId, owedAmountMinor: 9000 },
          { userId: userId, owedAmountMinor: 0 },
        ],
      }),
      granteeId,
    );

    expect(tx.financeSharedExpense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ paidByUserId: granteeId }),
    });
  });

  it("asks the group once, not once per participant", async () => {
    const tx = expenseTx();

    await pushExpense(
      tx,
      expenseChange({
        shares: [
          { userId, owedAmountMinor: 1 },
          { userId: memberId, owedAmountMinor: 1 },
          { userId: granteeId, owedAmountMinor: 8998 },
        ],
      }),
    );

    // A split may name up to 100 participants, and this runs inside the same
    // transaction as the row write.
    expect(tx.resourceShare.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("the participants a pushed finance_settlement may name", () => {
  const groupId = "group-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const settlementId = "settlement-dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const memberId = "user-member-33333333-3333-4333-8333-333333333333";
  const granteeId = "user-grantee-44444444-4444-4444-8444-444444444444";
  const strangerId = "user-stranger-55555555-5555-5555-8555-555555555555";
  const tripOnlyId = "trip-66666666-6666-4666-8666-666666666666";

  type Fake = Record<string, any>;

  const groupRow = (over: Record<string, any> = {}) => ({
    ownerId: userId,
    deletedAt: null,
    currency: "INR",
    members: [
      { id: "You", name: "You" },
      { id: memberId, name: "Priya" },
    ],
    ...over,
  });

  function settlementTx(
    over: {
      group?: Record<string, any> | null;
      grants?: Array<{ sharedWithUserId: string }> | undefined;
      canEdit?: boolean;
      row?: Record<string, any> | null;
      trip?: Record<string, any> | null;
    } = {},
  ): Fake {
    return {
      financeGroup: {
        findUnique: jest
          .fn()
          .mockResolvedValue("group" in over ? over.group : groupRow()),
      },
      resourceShare: {
        findFirst: jest
          .fn()
          .mockResolvedValue(over.canEdit ? { id: "grant-1" } : null),
        findMany: jest
          .fn()
          .mockResolvedValue(over.grants ?? [{ sharedWithUserId: granteeId }]),
      },
      financeTrip: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            "trip" in over
              ? over.trip
              : { ownerId: userId, deletedAt: null, baseCurrency: "INR" },
          ),
      },
      financeSettlement: {
        findUnique: jest.fn().mockResolvedValue(over.row ?? null),
        create: jest.fn().mockResolvedValue({ id: settlementId }),
        update: jest.fn().mockResolvedValue({ id: settlementId }),
      },
    };
  }

  const settlementPayload = (over: Record<string, any> = {}) => ({
    groupId,
    fromUserId: userId,
    toUserId: memberId,
    amountMinor: 5000,
    currency: "INR",
    date: "2026-10-05T19:00:00.000Z",
    ...over,
  });

  const settlementChange = (
    payload: Record<string, any>,
    over: Partial<ProjectableChange> = {},
  ): ProjectableChange =>
    change({
      entityType: "finance_settlement",
      entityId: settlementId,
      payload: settlementPayload(payload),
      ...over,
    });

  const pushSettlement = (tx: Fake, target: ProjectableChange, user = userId) =>
    projectAcceptedChange(
      tx as unknown as ChangeProjectionClient,
      user,
      target,
    );

  const rejectionOf = async (
    tx: Fake,
    target: ProjectableChange,
    user = userId,
  ) => {
    const error: any = await pushSettlement(tx, target, user).catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse().code).toBe(SYNC_PUSH_UNAUTHORIZED);
    return error.getResponse();
  };

  it("refuses a CREATE whose fromUserId is somebody outside the group", async () => {
    const tx = settlementTx();
    const body = await rejectionOf(
      tx,
      settlementChange({ fromUserId: strangerId }),
    );
    expect(body.details).toEqual({ groupId, fromUserId: strangerId });
    expect(tx.financeSettlement.create).not.toHaveBeenCalled();
  });

  it("refuses a CREATE whose toUserId is somebody outside the group", async () => {
    const tx = settlementTx();
    const body = await rejectionOf(
      tx,
      settlementChange({ toUserId: strangerId }),
    );
    expect(body.details).toEqual({ groupId, toUserId: strangerId });
    expect(tx.financeSettlement.create).not.toHaveBeenCalled();
  });

  it("refuses an UPDATE that re-points fromUserId at a stranger", async () => {
    const tx = settlementTx({
      row: {
        groupId,
        tripId: null,
        fromUserId: userId,
        toUserId: memberId,
        amountMinor: BigInt(5000),
        deletedAt: null,
        version: 1,
      },
    });

    const body = await rejectionOf(
      tx,
      settlementChange(
        { fromUserId: strangerId },
        { operation: ChangeOperation.UPDATE, version: 2 },
      ),
    );
    expect(body.details).toEqual({ groupId, fromUserId: strangerId });
    expect(tx.financeSettlement.update).not.toHaveBeenCalled();
  });

  it("refuses an UPDATE that re-points toUserId at a stranger", async () => {
    const tx = settlementTx({
      row: {
        groupId,
        tripId: null,
        fromUserId: userId,
        toUserId: memberId,
        amountMinor: BigInt(5000),
        deletedAt: null,
        version: 1,
      },
    });

    const body = await rejectionOf(
      tx,
      settlementChange(
        { toUserId: strangerId },
        { operation: ChangeOperation.UPDATE, version: 2 },
      ),
    );
    expect(body.details).toEqual({ groupId, toUserId: strangerId });
    expect(tx.financeSettlement.update).not.toHaveBeenCalled();
  });

  it("refuses a settlement in a trip without a group when naming someone other than the pusher", async () => {
    const tx = settlementTx();
    const body = await rejectionOf(
      tx,
      settlementChange({
        groupId: null,
        tripId: tripOnlyId,
        fromUserId: userId,
        toUserId: memberId,
      }),
    );
    expect(body.details).toEqual({ tripId: tripOnlyId, toUserId: memberId });
    expect(tx.financeSettlement.create).not.toHaveBeenCalled();
  });

  it("refuses a settlement when write authority and destination membership disagree", async () => {
    const detachedAuthorId =
      "user-detached-66666666-6666-4666-8666-666666666666";
    const tx = settlementTx({
      group: groupRow({ ownerId: victimId }),
      // This simulates a stale/corrupt grant read: assertSharedScope has allowed
      // the write, but the membership set used for replication does not contain
      // the author. The settlement must not be written into that target group.
      canEdit: true,
      grants: [],
    });

    const body = await rejectionOf(
      tx,
      settlementChange({ fromUserId: detachedAuthorId, toUserId: memberId }),
      detachedAuthorId,
    );

    expect(body.details).toEqual({ groupId, userId: detachedAuthorId });
    expect(tx.financeSettlement.create).not.toHaveBeenCalled();
  });

  it("accepts a settlement between members and coerces 'You' to the pusher", async () => {
    const tx = settlementTx();
    await pushSettlement(
      tx,
      settlementChange({ fromUserId: "You", toUserId: memberId }),
    );

    expect(tx.financeSettlement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromUserId: userId,
        toUserId: memberId,
      }),
    });
  });

  it("admits a registered grantee as a settlement participant", async () => {
    const tx = settlementTx();
    await pushSettlement(
      tx,
      settlementChange({ fromUserId: userId, toUserId: granteeId }),
    );

    expect(tx.financeSettlement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromUserId: userId,
        toUserId: granteeId,
      }),
    });
  });
});
