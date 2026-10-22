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

  describe("the cash-flow classification on a pushed transaction", () => {
    /** A row that already exists and holds version 1, so version 2 wins the tie. */
    function existingRow(overrides: Record<string, any> = {}) {
      return delegates(txId, {
        findUnique: jest.fn().mockResolvedValue({
          id: txId,
          userId,
          version: 1,
          deletedAt: null,
          ...overrides,
        }),
      });
    }

    const bill = {
      accountId,
      type: "EXPENSE",
      amountMinor: 2500,
      currency: "INR",
      title: "Lunch",
      transactionDate: "2026-10-10T12:00:00.000Z",
    };

    it("minted a row with the classification and the reversal link it was pushed", async () => {
      const tx = fakeFinanceTx();

      await projectAcceptedChange(
        tx,
        userId,
        change({
          payload: {
            ...bill,
            transactionKind: "BALANCE_ADJUSTMENT",
            reversalOfTransactionId:
              "txn-33333333-3333-4333-8333-333333333333",
          },
        }),
      );

      expect(tx.financeTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: txId,
          type: "EXPENSE",
          // Orthogonal to `type`, exactly as the client sends it: the direction
          // the money moved and the reason it moved.
          transactionKind: "BALANCE_ADJUSTMENT",
          reversalOfTransactionId: "txn-33333333-3333-4333-8333-333333333333",
        }),
      });
    });

    it("minted a NORMAL row from a push that predates the classification", async () => {
      const tx = fakeFinanceTx();

      await projectAcceptedChange(tx, userId, change({ payload: bill }));

      expect(tx.financeTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ transactionKind: "NORMAL" }),
      });
      // And no invented link: the column is null, not absent-with-a-guess.
      expect(tx.financeTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ reversalOfTransactionId: null }),
      });
    });

    it("left both new columns alone on an update whose payload never mentioned them", async () => {
      // The whole point of gating on `!== undefined`, as `isExcludedFromBudget`
      // is: a phone on last month's build pushes the six keys it knows, and a
      // reconciliation made on another device would otherwise be erased back to
      // ordinary income on this one.
      const tx = fakeFinanceTx({ financeTransaction: existingRow() });

      await projectAcceptedChange(
        tx,
        userId,
        change({ operation: ChangeOperation.UPDATE, version: 2, payload: bill }),
      );

      const data = tx.financeTransaction.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty("transactionKind");
      expect(data).not.toHaveProperty("reversalOfTransactionId");
      // The edit it did speak about still lands.
      expect(data).toMatchObject({ title: "Lunch", version: 2 });
    });

    it("wrote the classification on the update branch when the payload carried it", async () => {
      const tx = fakeFinanceTx({ financeTransaction: existingRow() });

      await projectAcceptedChange(
        tx,
        userId,
        change({
          operation: ChangeOperation.UPDATE,
          version: 2,
          payload: {
            ...bill,
            transactionKind: "BALANCE_ADJUSTMENT",
            reversalOfTransactionId:
              "txn-33333333-3333-4333-8333-333333333333",
          },
        }),
      );

      expect(tx.financeTransaction.update).toHaveBeenCalledWith({
        where: { id: txId },
        data: expect.objectContaining({
          transactionKind: "BALANCE_ADJUSTMENT",
          reversalOfTransactionId: "txn-33333333-3333-4333-8333-333333333333",
        }),
      });
    });

    it("cleared a reversal link only for a payload that said null", async () => {
      const silent = fakeFinanceTx({ financeTransaction: existingRow() });
      await projectAcceptedChange(
        silent,
        userId,
        change({
          operation: ChangeOperation.UPDATE,
          version: 2,
          payload: { ...bill, transactionKind: "NORMAL" },
        }),
      );
      expect(silent.financeTransaction.update.mock.calls[0][0].data).not.toHaveProperty(
        "reversalOfTransactionId",
      );

      const explicit = fakeFinanceTx({ financeTransaction: existingRow() });
      await projectAcceptedChange(
        explicit,
        userId,
        change({
          operation: ChangeOperation.UPDATE,
          version: 2,
          payload: { ...bill, reversalOfTransactionId: null },
        }),
      );
      expect(explicit.financeTransaction.update).toHaveBeenCalledWith({
        where: { id: txId },
        data: expect.objectContaining({ reversalOfTransactionId: null }),
      });
    });

    it("wrote no classification at all for a value the column cannot hold", async () => {
      // `changePayloadRejection` refuses this push before the projection sees it,
      // so the only way here is another entry point — and an unreadable value
      // would strand the row outside the `NOT` clause the money reads use.
      const tx = fakeFinanceTx({ financeTransaction: existingRow() });

      await projectAcceptedChange(
        tx,
        userId,
        change({
          operation: ChangeOperation.UPDATE,
          version: 2,
          payload: { ...bill, transactionKind: "RECONCILE" },
        }),
      );

      const data = tx.financeTransaction.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty("transactionKind");
    });

    it("degraded a duplicate-key create into the same silent update", async () => {
      // The race path shares `updateData` with the plain update, so a phone and
      // the worker minting one row cannot disagree about what an omitted key
      // means.
      const tx = fakeFinanceTx({
        financeTransaction: delegates(txId, {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ userId, deletedAt: null, version: 1 }),
          create: jest.fn().mockRejectedValueOnce(
            Object.assign(
              new Error("Unique constraint failed on the fields: (`_id`)"),
              { code: "P2002", meta: { target: "_id" } },
            ),
          ),
        }),
      });

      await projectAcceptedChange(
        tx,
        userId,
        change({
          operation: ChangeOperation.CREATE,
          payload: { ...bill, transactionKind: "BALANCE_ADJUSTMENT" },
        }),
      );

      expect(tx.financeTransaction.update).toHaveBeenCalledWith({
        where: { id: txId },
        data: expect.objectContaining({ transactionKind: "BALANCE_ADJUSTMENT" }),
      });
      expect(
        tx.financeTransaction.update.mock.calls[0][0].data,
      ).not.toHaveProperty("reversalOfTransactionId");
    });
  });
});
