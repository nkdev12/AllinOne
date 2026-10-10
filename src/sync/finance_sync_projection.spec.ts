import { ChangeOperation } from "@prisma/client";
import {
  projectAcceptedChange,
  type ProjectableChange,
} from "./change-projection";

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

describe("Finance Sync Projection", () => {
  it("projects a pushed finance_transaction CREATE change onto Prisma", async () => {
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
        amountMinor: 150000, // ₹1,500.00
        currency: "INR",
        title: "Team Lunch",
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
        amountMinor: BigInt(150000),
        currency: "INR",
        title: "Team Lunch",
        version: 1,
      }),
    });
  });

  it("projects a pushed finance_transaction DELETE change (soft delete) onto Prisma", async () => {
    const tx = fakeFinanceTx({
      financeTransaction: {
        findUnique: jest.fn().mockResolvedValue({
          id: txId,
          userId,
          deletedAt: null,
        }),
        update: jest.fn().mockResolvedValue({ id: txId }),
      },
    });

    const change: ProjectableChange = {
      entityType: "finance_transaction",
      entityId: txId,
      operation: ChangeOperation.DELETE,
      version: 2,
      payload: {},
    };

    await projectAcceptedChange(tx, userId, change);

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
      financeTransaction: {
        findUnique: jest.fn().mockResolvedValue({
          id: txId,
          userId: "different-user-999",
          deletedAt: null,
        }),
        update: jest.fn().mockResolvedValue({ id: txId }),
      },
    });

    const change: ProjectableChange = {
      entityType: "finance_transaction",
      entityId: txId,
      operation: ChangeOperation.UPDATE,
      version: 2,
      payload: { title: "Malicious Edit Attempt" },
    };

    await projectAcceptedChange(tx, userId, change);

    expect(tx.financeTransaction.update).not.toHaveBeenCalled();
  });
});

