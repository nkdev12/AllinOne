import { ChangeOperation } from "@prisma/client";
import {
  projectAcceptedChange,
  type ProjectableChange,
} from "../../src/sync/change-projection";

const userId = "user-finance-test-123";
const accountId = "acc-11111111-1111-4111-8111-111111111111";
const txId = "txn-22222222-2222-4222-8222-222222222222";
const categoryId = "cat-33333333-3333-4333-8333-333333333333";

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
 * The projection resolves every reference a change names before it writes
 * (`resolveReferenceOwner` / `referenceIsUnusable`), and it fails closed: a
 * `null` is "the collection does not answer for this id", which is a refusal,
 * not a licence. A fake that resolves every delegate to `null` therefore cannot
 * test a landing CREATE — it only tests the drop. The fixture names the owners
 * and leaves an unlisted id genuinely unlisted.
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
      owningDelegates(accountId, { [accountId]: userId }),
    financeCategory:
      overrides.financeCategory ||
      owningDelegates(categoryId, { [categoryId]: userId }),
    ...overrides,
  };
}

describe("test/finance/sync_projection_test.ts", () => {
  // `sync:invalidation` is not this function's output: the projection only
  // writes rows, and `SyncGateway.broadcastToUser` (`src/sync/sync.gateway.ts`)
  // emits the socket signal after `sync.service.ts` commits the push. The title
  // used to promise that signal from `projectAcceptedChange` alone.
  it("projects a pushed finance_transaction CREATE onto Prisma once its references resolve to the pusher", async () => {
    const tx = fakeFinanceTx();

    const change: ProjectableChange = {
      entityType: "finance_transaction",
      entityId: txId,
      operation: ChangeOperation.CREATE,
      version: 1,
      payload: {
        accountId,
        categoryId,
        type: "EXPENSE",
        amountMinor: 250000, // ₹2,500.00
        currency: "INR",
        title: "Grocery Store",
        transactionDate: "2026-10-10T12:00:00.000Z",
        version: 1,
      },
    };

    await projectAcceptedChange(tx, userId, change);

    expect(tx.financeTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: txId,
        userId,
        accountId,
        categoryId,
        type: "EXPENSE",
        amountMinor: BigInt(250000),
        currency: "INR",
        title: "Grocery Store",
        version: 1,
      }),
    });

    // The row only lands because the guard was asked and answered. Dropping
    // these two calls would mean the fixture stopped modelling the tables the
    // projection reads, which is exactly how a foreign reference starts passing.
    expect(tx.financeAccount.findUnique).toHaveBeenCalledWith({
      where: { id: accountId },
      select: { userId: true },
    });
    expect(tx.financeCategory.findUnique).toHaveBeenCalledWith({
      where: { id: categoryId },
      select: { userId: true },
    });
  });

  it("drops a CREATE that names an account the collection does not answer for", async () => {
    const unknownAccount = "acc-00000000-0000-4000-8000-000000000000";
    const tx = fakeFinanceTx();

    await projectAcceptedChange(tx, userId, {
      entityType: "finance_transaction",
      entityId: txId,
      operation: ChangeOperation.CREATE,
      version: 1,
      payload: {
        accountId: unknownAccount,
        categoryId,
        type: "EXPENSE",
        amountMinor: 250000,
        currency: "INR",
        title: "Ghost Account",
        version: 1,
      },
    });

    expect(tx.financeTransaction.create).not.toHaveBeenCalled();
  });
});
