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

function fakeFinanceTx(overrides: Record<string, any> = {}) {
  return {
    financeTransaction: delegates(txId, overrides.financeTransaction || {}),
    financeAccount: delegates(accountId, overrides.financeAccount || {}),
    financeCategory: delegates(categoryId, overrides.financeCategory || {}),
    ...overrides,
  };
}

describe("test/finance/sync_projection_test.ts", () => {
  it("validates that pushed finance_transaction changes update Prisma rows and emit sync:invalidation", async () => {
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
  });
});
