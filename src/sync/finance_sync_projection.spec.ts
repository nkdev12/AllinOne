import { ChangeOperation } from "@prisma/client";
import {
  projectAcceptedChange,
  type ProjectableChange,
} from "./change-projection";

const userId = "user-finance-test-123";
const victimId = "victim-user-99999999-9999-4999-8999-999999999999";
const accountId = "acc-11111111-1111-4111-8111-111111111111";
const txId = "txn-22222222-2222-4222-8222-222222222222";
const categoryId = "cat-33333333-3333-4333-8333-333333333333";
// Somebody else's account, and an id no row in the collection answers for.
const victimAccountId = "acc-44444444-4444-4444-8444-444444444444";
const unknownAccountId = "acc-00000000-0000-4000-8000-000000000000";

const delegates = (id: string, overrides: Record<string, jest.Mock> = {}) => ({
  findUnique: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({ id }),
  update: jest.fn().mockResolvedValue({ id }),
  ...overrides,
});

/**
 * Answers "whose row is this?" per id, the way the account and category tables
 * do.
 *
 * A projection that has to resolve a reference cannot be tested against a fake
 * that answers `null` for everything: one shape conflates "this id is somebody
 * else's" with "this fixture never bothered to model the id", and the reference
 * guard decides on exactly that difference. So the fixtures name the owners, and
 * an id outside the map is an id the collection does not have — which is now a
 * refusal in its own right.
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

/** A delegate whose `findUnique` answers per id. */
function owningDelegates(id: string, ownersById: Record<string, string>) {
  return delegates(id, { findUnique: ownerLookup(ownersById) });
}

function fakeFinanceTx(overrides: Record<string, any> = {}) {
  return {
    financeTransaction: delegates(txId, overrides.financeTransaction || {}),
    financeAccount:
      overrides.financeAccount ||
      owningDelegates(accountId, {
        [accountId]: userId,
        [victimAccountId]: victimId,
      }),
    financeCategory:
      overrides.financeCategory ||
      owningDelegates(categoryId, { [categoryId]: userId }),
    ...overrides,
  };
}

function change(over: Partial<ProjectableChange>): ProjectableChange {
  return {
    entityType: "finance_transaction",
    entityId: txId,
    operation: ChangeOperation.CREATE,
    version: 1,
    payload: {},
    ...over,
  };
}

describe("Finance Sync Projection", () => {
  it("projects a pushed finance_transaction CREATE change onto Prisma", async () => {
    const tx = fakeFinanceTx();

    await projectAcceptedChange(
      tx,
      userId,
      change({
        payload: {
          accountId,
          categoryId,
          type: "EXPENSE",
          amountMinor: 150000, // ₹1,500.00
          currency: "INR",
          title: "Team Lunch",
          transactionDate: "2026-10-10T12:00:00.000Z",
          version: 1,
        },
      }),
    );

    expect(tx.financeTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: txId,
        userId,
        accountId,
        categoryId,
        type: "EXPENSE",
        amountMinor: BigInt(150000),
        currency: "INR",
        title: "Team Lunch",
        version: 1,
      }),
    });
  });

  it("refuses a CREATE whose account the collection does not answer for", async () => {
    // Fail closed: "nobody owns this account" is not "the pusher owns it". A row
    // parked on an id with no account behind it is a balance no path can
    // attribute, and that same id is what `adjustAccount` tries to move when the
    // owner later edits or deletes the row.
    const tx = fakeFinanceTx();

    await projectAcceptedChange(
      tx,
      userId,
      change({
        payload: {
          accountId: unknownAccountId,
          type: "EXPENSE",
          amountMinor: 150000,
          title: "Team Lunch",
        },
      }),
    );

    expect(tx.financeAccount.findUnique).toHaveBeenCalledWith({
      where: { id: unknownAccountId },
      select: { userId: true },
    });
    expect(tx.financeTransaction.create).not.toHaveBeenCalled();
    expect(tx.financeTransaction.update).not.toHaveBeenCalled();
  });

  it("refuses a CREATE parked on another user's account", async () => {
    const tx = fakeFinanceTx();

    await projectAcceptedChange(
      tx,
      userId,
      change({
        payload: {
          accountId: victimAccountId,
          type: "EXPENSE",
          amountMinor: 150000,
          title: "Not my money",
        },
      }),
    );

    expect(tx.financeTransaction.create).not.toHaveBeenCalled();
  });

  it("keeps an unresolvable categoryId out of the write and lands the row anyway", async () => {
    const tx = fakeFinanceTx();

    await projectAcceptedChange(
      tx,
      userId,
      change({
        payload: {
          accountId,
          categoryId: "cat-does-not-exist",
          type: "EXPENSE",
          amountMinor: 150000,
          title: "Team Lunch",
        },
      }),
    );

    expect(tx.financeTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ accountId, categoryId: null }),
    });
  });

  it("projects a pushed finance_transaction DELETE change (soft delete) onto Prisma", async () => {
    const tx = fakeFinanceTx({
      // The row holds version 1, and the delete below outranks it — the only
      // reason it is allowed to blank the row out.
      financeTransaction: delegates(txId, {
        findUnique: jest.fn().mockResolvedValue({
          id: txId,
          userId,
          version: 1,
          deletedAt: null,
        }),
      }),
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({ operation: ChangeOperation.DELETE, version: 2, payload: {} }),
    );

    expect(tx.financeTransaction.update).toHaveBeenCalledWith({
      where: { id: txId },
      data: expect.objectContaining({
        deletedAt: expect.any(Date),
        version: 2,
      }),
    });
  });

  it("ignores changes pushed for a finance_transaction owned by another user", async () => {
    const tx = fakeFinanceTx({
      financeTransaction: delegates(txId, {
        findUnique: jest.fn().mockResolvedValue({
          id: txId,
          userId: "different-user-999",
          version: 1,
          deletedAt: null,
        }),
      }),
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        operation: ChangeOperation.UPDATE,
        version: 2,
        payload: { title: "Malicious Edit Attempt" },
      }),
    );

    expect(tx.financeTransaction.update).not.toHaveBeenCalled();
  });
});
