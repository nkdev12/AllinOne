import { ChangeOperation } from "@prisma/client";
import { Logger } from "@nestjs/common";
import {
  projectAcceptedChange,
  type ProjectableChange,
} from "./change-projection";

/**
 * The four things the finance projection still got wrong after the first round of
 * fixes: a recurring rule could be attached to somebody else's account, a
 * reference the collection does not answer for was treated as the pusher's own,
 * a currency stored lowercase on a device landed lowercase and vanished from
 * every exact-upper-case money read, and a tombstone could roll a row's version
 * backwards.
 *
 * Each case is written so it fails against the pre-fix projection — the refusal
 * asserts nothing was written where the pre-fix code wrote, and the landing case
 * asserts the normalised value where the pre-fix code wrote the payload verbatim.
 */

const userId = "user-owner-11111111-1111-4111-8111-111111111111";
const victimId = "user-victim-22222222-2222-4222-8222-222222222222";
const peerId = "user-peer-33333333-3333-4333-8333-333333333333";

const ruleId = "rule-44444444-4444-4444-8444-444444444444";
const accountId = "acc-55555555-5555-4555-8555-555555555555";
const victimAccountId = "acc-66666666-6666-4666-8666-666666666666";
const unknownAccountId = "acc-00000000-0000-4000-8000-000000000000";
const categoryId = "cat-77777777-7777-4777-8777-777777777777";
const victimCategoryId = "cat-88888888-8888-4888-8888-888888888888";
const groupId = "grp-99999999-9999-4999-8999-999999999999";
const tripId = "trip-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const itemId = "item-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const expenseId = "sexp-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const settlementId = "strn-dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const transactionId = "txn-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const budgetId = "bud-ffffffff-ffff-4fff-8fff-ffffffffffff";
const goalId = "goal-11111111-1111-4111-9111-111111111111";
const loanId = "loan-22222222-2222-4222-9222-222222222222";

const delegates = (id: string, overrides: Record<string, jest.Mock> = {}) => ({
  findUnique: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({ id }),
  update: jest.fn().mockResolvedValue({ id }),
  ...overrides,
});

/** Answers "whose row is this?" per id; anything unlisted does not exist. */
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

const accounts = (ownersById: Record<string, string> = {}) =>
  delegates(accountId, {
    findUnique: ownerLookup({ [accountId]: userId, ...ownersById }),
  });

const categories = (ownersById: Record<string, string> = {}) =>
  delegates(categoryId, {
    findUnique: ownerLookup({ [categoryId]: userId, ...ownersById }),
  });

/** The row a projection reads before it decides anything. */
function storedRow(over: Record<string, any> = {}): Record<string, any> {
  return { userId, deletedAt: null, version: 1, ...over };
}

function fake(over: Record<string, any> = {}): Record<string, any> {
  return {
    financeAccount: accounts(),
    financeCategory: categories(),
    financeRecurringRule: delegates(ruleId),
    financeTransaction: delegates(transactionId),
    financeBudget: delegates(budgetId),
    financeSavingsGoal: delegates(goalId),
    financeLoan: delegates(loanId),
    financeGroup: delegates(groupId, {
      findUnique: jest.fn().mockResolvedValue({
        ownerId: userId,
        currency: "INR",
        deletedAt: null,
      }),
    }),
    financeTrip: delegates(tripId, {
      findUnique: jest.fn().mockResolvedValue({
        ownerId: userId,
        baseCurrency: "INR",
        deletedAt: null,
      }),
    }),
    financeSharedExpense: delegates(expenseId),
    financeSettlement: delegates(settlementId),
    financeTripItinerary: delegates(itemId),
    ...over,
  };
}

function change(over: Partial<ProjectableChange>): ProjectableChange {
  return {
    entityType: "finance_recurring_rule",
    entityId: ruleId,
    operation: ChangeOperation.CREATE,
    version: 1,
    payload: {},
    ...over,
  };
}

const rulePayload = (over: Record<string, any> = {}) => ({
  accountId,
  categoryId,
  type: "EXPENSE",
  amountMinor: 450000,
  title: "Rent",
  frequency: "MONTHLY",
  startDate: "2026-11-01T00:00:00.000Z",
  nextDueDate: "2026-11-01T00:00:00.000Z",
  ...over,
});

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe("a pushed finance_recurring_rule may not name somebody else's account", () => {
  it("drops a CREATE whose accountId belongs to another user", async () => {
    // Pre-fix the id went straight into the row. The processor half of the chain
    // was already closed (`recurring.service.ts` re-resolves `rule.accountId`
    // under `rule.userId` before it mints a bill and settles the rule if the
    // account is not there), which left the projection as the only door: the rule
    // row itself sat on the victim's account, and every transaction the owner
    // later booked against it moved the wrong balance.
    const tx = fake({
      financeAccount: accounts({ [victimAccountId]: victimId }),
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({ payload: rulePayload({ accountId: victimAccountId }) }),
    );

    expect(tx.financeRecurringRule.create).not.toHaveBeenCalled();
    expect(tx.financeRecurringRule.update).not.toHaveBeenCalled();
  });

  it("drops a CREATE whose accountId the collection does not answer for", async () => {
    // Fail closed, the same way the transaction branch now does it: an id with no
    // account behind it is not the pusher's account.
    const tx = fake();

    await projectAcceptedChange(
      tx,
      userId,
      change({ payload: rulePayload({ accountId: unknownAccountId }) }),
    );

    expect(tx.financeAccount.findUnique).toHaveBeenCalledWith({
      where: { id: unknownAccountId },
      select: { userId: true },
    });
    expect(tx.financeRecurringRule.create).not.toHaveBeenCalled();
  });

  it("refuses an UPDATE that re-points the rule at another user's account", async () => {
    const tx = fake({
      financeRecurringRule: delegates(ruleId, {
        findUnique: jest.fn().mockResolvedValue(storedRow({ version: 3 })),
      }),
      financeAccount: accounts({ [victimAccountId]: victimId }),
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        operation: ChangeOperation.UPDATE,
        version: 4,
        payload: { accountId: victimAccountId, amountMinor: 1 },
      }),
    );

    expect(tx.financeRecurringRule.update).not.toHaveBeenCalled();
  });

  it("keeps an unusable categoryId out of the write and lands the rule anyway", async () => {
    // Identical to the transaction branch's rule: a label is metadata about the
    // money, not where the money sits, so it costs the label and not the row.
    const tx = fake({
      financeCategory: categories({ [victimCategoryId]: victimId }),
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({ payload: rulePayload({ categoryId: victimCategoryId }) }),
    );

    expect(tx.financeRecurringRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ accountId, categoryId: null }),
    });
  });

  it("lands a CREATE whose account and category are the caller's own", async () => {
    const tx = fake();

    await projectAcceptedChange(tx, userId, change({ payload: rulePayload() }));

    expect(tx.financeRecurringRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: ruleId,
        userId,
        accountId,
        categoryId,
        amountMinor: BigInt(450000),
        version: 1,
      }),
    });
  });

  it("asks the account who owns it before the recurring rule is written", async () => {
    const tx = fake();

    await projectAcceptedChange(tx, userId, change({ payload: rulePayload() }));

    expect(tx.financeAccount.findUnique).toHaveBeenCalledWith({
      where: { id: accountId },
      select: { userId: true },
    });
    expect(tx.financeCategory.findUnique).toHaveBeenCalledWith({
      where: { id: categoryId },
      select: { userId: true },
    });
  });

  it("still lets the owner tombstone their own rule without naming an account", async () => {
    const tx = fake({
      financeRecurringRule: delegates(ruleId, {
        findUnique: jest.fn().mockResolvedValue(storedRow({ version: 5 })),
      }),
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({ operation: ChangeOperation.DELETE, version: 6, payload: {} }),
    );

    expect(tx.financeRecurringRule.update).toHaveBeenCalledWith({
      where: { id: ruleId },
      data: expect.objectContaining({
        deletedAt: expect.any(Date),
        version: 6,
      }),
    });
    expect(tx.financeAccount.findUnique).not.toHaveBeenCalled();
  });
});

describe("every currency the projection writes is normalised", () => {
  // A device that stored "inr" pushes it verbatim, the row lands lowercase, and
  // `getCashFlowSummary`, `AnalyticsService.getNetWorth` and the budget reads all
  // match the column as exact upper case — so the money exists and every
  // dashboard reports zero. This is the same symptom `normaliseCurrency` closed
  // on the REST path; the push mirror simply had not been told.
  const cases: Array<{
    label: string;
    entityType: string;
    entityId: string;
    delegate: string;
    field: string;
    createPayload: Record<string, any>;
    updatePayload: Record<string, any>;
    existing?: Record<string, any>;
  }> = [
    {
      label: "finance_account",
      entityType: "finance_account",
      entityId: accountId,
      delegate: "financeAccount",
      field: "currency",
      createPayload: { name: "Savings", type: "BANK", currency: "inr" },
      updatePayload: { currency: " usd " },
    },
    {
      label: "finance_transaction",
      entityType: "finance_transaction",
      entityId: transactionId,
      delegate: "financeTransaction",
      field: "currency",
      createPayload: {
        accountId,
        type: "EXPENSE",
        amountMinor: 1000,
        title: "Chai",
        currency: "inr",
      },
      updatePayload: { currency: "eur" },
    },
    {
      label: "finance_group",
      entityType: "finance_group",
      entityId: groupId,
      delegate: "financeGroup",
      field: "currency",
      createPayload: { name: "Flatmates", members: [], currency: "inr" },
      updatePayload: { currency: "jpy" },
    },
    {
      label: "finance_trip",
      entityType: "finance_trip",
      entityId: tripId,
      delegate: "financeTrip",
      field: "baseCurrency",
      createPayload: { title: "Goa", baseCurrency: "inr" },
      updatePayload: { baseCurrency: "eur" },
    },
    {
      label: "finance_shared_expense",
      entityType: "finance_shared_expense",
      entityId: expenseId,
      delegate: "financeSharedExpense",
      field: "currency",
      createPayload: {
        groupId,
        paidByUserId: userId,
        title: "Weekshop groceries",
        totalAmountMinor: 5000,
        shares: [{ userId, owedAmountMinor: 5000 }],
        currency: "inr",
      },
      // Pinned to its group's currency, so the only thing this differs from the
      // parent by is case.
      updatePayload: { currency: " inr " },
      existing: {
        groupId,
        tripId: null,
        totalAmountMinor: 5000,
        version: 1,
        deletedAt: null,
      },
    },
    {
      label: "finance_settlement",
      entityType: "finance_settlement",
      entityId: settlementId,
      delegate: "financeSettlement",
      field: "currency",
      createPayload: {
        groupId,
        fromUserId: userId,
        toUserId: peerId,
        amountMinor: 2000,
        currency: "inr",
      },
      updatePayload: { currency: "INR " },
      existing: {
        groupId,
        tripId: null,
        fromUserId: userId,
        toUserId: peerId,
        version: 1,
        deletedAt: null,
      },
    },
  ];

  for (const c of cases) {
    it(`normalises the ${c.field} a ${c.label} CREATE carries`, async () => {
      const tx = fake();
      // The row the change is keyed by does not exist yet — that is what makes
      // this a CREATE — while the account and category delegates keep answering
      // reference probes.
      tx[c.delegate] = delegates(c.entityId);

      await projectAcceptedChange(
        tx,
        userId,
        change({
          entityType: c.entityType,
          entityId: c.entityId,
          payload: c.createPayload,
        }),
      );

      expect(tx[c.delegate].create).toHaveBeenCalledWith({
        data: expect.objectContaining({ [c.field]: "INR" }),
      });
    });

    it(`normalises the ${c.field} a ${c.label} UPDATE carries`, async () => {
      const tx = fake();
      // The row the change is keyed by: already there, one version behind, and
      // owned by the caller (`finance_group` and `finance_trip` answer to
      // `ownerId`, everything else to `userId`).
      const parentOwned =
        c.entityType === "finance_group" || c.entityType === "finance_trip";
      const liveRow = parentOwned
        ? { ownerId: userId, deletedAt: null, version: 1 }
        : storedRow({ version: 1 });
      tx[c.delegate].findUnique = jest
        .fn()
        .mockResolvedValue(c.existing ? { ...c.existing } : liveRow);

      await projectAcceptedChange(
        tx,
        userId,
        change({
          entityType: c.entityType,
          entityId: c.entityId,
          operation: ChangeOperation.UPDATE,
          version: 2,
          payload: c.updatePayload,
        }),
      );

      expect(tx[c.delegate].update).toHaveBeenCalledWith({
        where: { id: c.entityId },
        data: expect.objectContaining({
          [c.field]: c.updatePayload[c.field].trim().toUpperCase(),
        }),
      });
    });
  }

  it("keeps the INR default for a change that never mentions a currency", async () => {
    const tx = fake();
    tx.financeAccount = delegates(accountId);

    await projectAcceptedChange(
      tx,
      userId,
      change({
        entityType: "finance_account",
        entityId: accountId,
        payload: { name: "Savings", type: "BANK" },
      }),
    );

    expect(tx.financeAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ currency: "INR" }),
    });
  });

  it("no longer aborts a whole push over a case difference with the group currency", async () => {
    // `assertSharedScope` pins a shared expense to its parent's currency. Compared
    // raw, a device that stored "inr" was refused with a 400 that rolled the
    // entire batch back — over a value the projection then normalises anyway.
    const tx = fake();

    await projectAcceptedChange(
      tx,
      userId,
      change({
        entityType: "finance_shared_expense",
        entityId: expenseId,
        payload: {
          groupId,
          paidByUserId: userId,
          title: "Groceries",
          totalAmountMinor: 5000,
          shares: [{ userId, owedAmountMinor: 5000 }],
          currency: "inr",
        },
      }),
    );

    expect(tx.financeSharedExpense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ currency: "INR" }),
    });
  });
});

describe("a stale DELETE cannot roll a finance row's version backwards", () => {
  // The push gate in `sync.service.ts:97` compares the incoming version with the
  // last row in the caller's *oplog*, and `adjustAccount` bumps a
  // `finance_account`'s version on every transaction booked against it without
  // ever logging a `finance_account` change. So an account row routinely sits at
  // version 40 while its own log tail is at version 1, and an offline device's
  // queued DELETE at version 3 walks straight through the gate. Pre-fix the
  // DELETE branches stamped `version: change.version` unconditionally: the row
  // was tombstoned *and* rewound to 3, after which every legitimate later change
  // looked current and could revive it with stale content (`deletedAt: null`).
  const tombstoneCases: Array<{
    entityType: string;
    entityId: string;
    delegate: string;
    row: Record<string, any>;
  }> = [
    {
      entityType: "finance_account",
      entityId: accountId,
      delegate: "financeAccount",
      row: storedRow({ version: 40 }),
    },
    {
      entityType: "finance_category",
      entityId: categoryId,
      delegate: "financeCategory",
      row: storedRow({ version: 40 }),
    },
    {
      entityType: "finance_transaction",
      entityId: transactionId,
      delegate: "financeTransaction",
      row: storedRow({ version: 40 }),
    },
    {
      entityType: "finance_budget",
      entityId: budgetId,
      delegate: "financeBudget",
      row: storedRow({ version: 40 }),
    },
    {
      entityType: "finance_savings_goal",
      entityId: goalId,
      delegate: "financeSavingsGoal",
      row: storedRow({ version: 40 }),
    },
    {
      entityType: "finance_recurring_rule",
      entityId: ruleId,
      delegate: "financeRecurringRule",
      row: storedRow({ version: 40 }),
    },
    {
      entityType: "finance_loan",
      entityId: loanId,
      delegate: "financeLoan",
      row: storedRow({ version: 40 }),
    },
    {
      entityType: "finance_group",
      entityId: groupId,
      delegate: "financeGroup",
      row: { ownerId: userId, version: 40, deletedAt: null },
    },
    {
      entityType: "finance_trip",
      entityId: tripId,
      delegate: "financeTrip",
      row: { ownerId: userId, version: 40, deletedAt: null },
    },
    {
      entityType: "finance_shared_expense",
      entityId: expenseId,
      delegate: "financeSharedExpense",
      row: {
        groupId,
        tripId: null,
        totalAmountMinor: 5000,
        version: 40,
        deletedAt: null,
      },
    },
    {
      entityType: "finance_settlement",
      entityId: settlementId,
      delegate: "financeSettlement",
      row: {
        groupId,
        tripId: null,
        fromUserId: userId,
        toUserId: peerId,
        version: 40,
        deletedAt: null,
      },
    },
    {
      entityType: "finance_trip_itinerary",
      entityId: itemId,
      delegate: "financeTripItinerary",
      row: { tripId, version: 40, deletedAt: null },
    },
  ];

  for (const c of tombstoneCases) {
    it(`refuses a stale ${c.entityType} DELETE at version 3 against a row at 40`, async () => {
      const tx = fake();
      tx.financeTrip = delegates(tripId, {
        findUnique: jest.fn().mockResolvedValue({
          ownerId: userId,
          baseCurrency: "INR",
          version: 40,
          deletedAt: null,
        }),
      });
      tx[c.delegate] = delegates(c.entityId, {
        findUnique: jest.fn().mockResolvedValue(c.row),
      });

      await projectAcceptedChange(
        tx,
        userId,
        change({
          entityType: c.entityType,
          entityId: c.entityId,
          operation: ChangeOperation.DELETE,
          version: 3,
          payload: {},
        }),
      );

      expect(tx[c.delegate].update).not.toHaveBeenCalled();
    });

    it(`still tombstones a ${c.entityType} whose DELETE outranks the row`, async () => {
      const tx = fake();
      tx.financeTrip = delegates(tripId, {
        findUnique: jest.fn().mockResolvedValue({
          ownerId: userId,
          baseCurrency: "INR",
          version: 40,
          deletedAt: null,
        }),
      });
      tx[c.delegate] = delegates(c.entityId, {
        findUnique: jest.fn().mockResolvedValue(c.row),
      });

      await projectAcceptedChange(
        tx,
        userId,
        change({
          entityType: c.entityType,
          entityId: c.entityId,
          operation: ChangeOperation.DELETE,
          version: 41,
          payload: {},
        }),
      );

      expect(tx[c.delegate].update).toHaveBeenCalledWith({
        where: { id: c.entityId },
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
          version: 41,
        }),
      });
    });
  }

  it("lets a RESTORE at an older version still bring the row back", async () => {
    // The exemption is the point of `losesToWhatTheRowHolds`: coming back is the
    // whole meaning of a RESTORE, so the tie rule must not swallow it.
    const tx = fake({
      financeAccount: delegates(accountId, {
        findUnique: jest
          .fn()
          .mockResolvedValue(storedRow({ version: 40, deletedAt: null })),
        update: jest.fn().mockResolvedValue({ id: accountId }),
      }),
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        entityType: "finance_account",
        entityId: accountId,
        operation: ChangeOperation.RESTORE,
        version: 2,
        payload: { name: "Savings" },
      }),
    );

    expect(tx.financeAccount.update).toHaveBeenCalledWith({
      where: { id: accountId },
      data: expect.objectContaining({ name: "Savings", deletedAt: null }),
    });
  });
});
