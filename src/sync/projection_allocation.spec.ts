import { BadRequestException } from "@nestjs/common";
import { ChangeOperation } from "@prisma/client";
import { allocateExpenseShares } from "../finance/groups/group-validation";
import { assertPushableChanges } from "./change-payload.validator";
import {
  projectAcceptedChange,
  type ChangeProjectionClient,
  type ProjectableChange,
} from "./change-projection";

const userId = "user-uuid-123";
const noteId = "11111111-1111-4111-8111-111111111111";
const folderId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const calendarId = "55555555-5555-4555-8555-555555555555";
const expenseId = "66666666-6666-4666-8666-666666666666";
const groupId = "77777777-7777-4777-8777-777777777777";

/**
 * The three participants a device would queue for a shared dinner, in the order
 * a client's `Map` happens to hand them back — deliberately not sorted, because
 * the allocator's whole promise is that the answer does not depend on this.
 */
const trio = [
  { userId: "user-c", owedAmountMinor: 3333 },
  { userId: "user-a", owedAmountMinor: 3333 },
  { userId: "user-b", owedAmountMinor: 3333 },
];

const group = {
  ownerId: userId,
  deletedAt: null,
  currency: "INR",
};

function expenseTx(row: Record<string, any> | null, shares: any[] = []): Fake {
  return {
    financeGroup: stubGroup(),
    financeSharedExpense: {
      findUnique: jest.fn().mockResolvedValue(row),
      create: jest.fn().mockResolvedValue({ id: expenseId }),
      update: jest.fn().mockResolvedValue({ id: expenseId }),
    },
    // The share table, row by row. An UPDATE branch that still nested
    // `shares: { deleteMany: {}, create: [...] }` would never be seen here at all,
    // which is exactly how the rebuild hid from this file for so long.
    financeExpenseShare: {
      findMany: jest
        .fn()
        .mockResolvedValue(shares.map((share) => ({ ...share }))),
      create: jest.fn().mockImplementation(async ({ data }) => ({
        id: `share-${data.userId}`,
        ...data,
      })),
      update: jest.fn().mockImplementation(async ({ data }) => ({ ...data })),
    },
  };
}

const stubGroup = () => ({
  findUnique: jest.fn().mockResolvedValue(group),
  create: jest.fn(),
  update: jest.fn(),
});

/** Loose on purpose: the projection reads three methods off each delegate. */
type Fake = Record<string, any>;

const push = (tx: Fake, user: string, change: ProjectableChange) =>
  projectAcceptedChange(tx as unknown as ChangeProjectionClient, user, change);

function expenseChange(
  payload: Record<string, any>,
  over: Partial<ProjectableChange> = {},
): ProjectableChange {
  return {
    entityType: "finance_shared_expense",
    entityId: expenseId,
    operation: ChangeOperation.CREATE,
    version: 1,
    payload: {
      groupId,
      paidByUserId: userId,
      title: "Dinner",
      totalAmountMinor: 10000,
      currency: "INR",
      date: "2026-10-01T19:00:00.000Z",
      ...payload,
    },
    ...over,
  };
}

const createdShares = (tx: any) =>
  tx.financeSharedExpense.create.mock.calls[0][0].data.shares.create;

/** What the UPDATE branch wrote straight onto the share table, row by row. */
const projectedShares = (tx: any) =>
  tx.financeExpenseShare.create.mock.calls.map((call: any) => call[0].data);

const minor = (share: any) => Number(share.owedAmountMinor);

describe("finance_shared_expense projection allocation", () => {
  it("splits an inexact EQUAL total instead of refusing it", async () => {
    const tx = expenseTx(null);

    await push(tx, userId, expenseChange({ splitType: "EQUAL", shares: trio }));

    const shares = createdShares(tx);
    // 10000 / 3 is not a whole number of minor units, so one participant takes
    // the extra paisa and the total is exact by construction. The residual goes
    // to `user-a`: every remainder is the same, so the tie-break is the userId.
    expect(shares.map((s: any) => [s.userId, minor(s)])).toEqual([
      ["user-a", 3334],
      ["user-b", 3333],
      ["user-c", 3333],
    ]);
    expect(shares.reduce((sum: number, s: any) => sum + minor(s), 0)).toBe(
      10000,
    );
    expect(tx.financeSharedExpense.update).not.toHaveBeenCalled();
  });

  it("is the allocator the REST path runs, not a second copy of it", async () => {
    const payload = {
      splitType: "SHARES",
      shares: [
        { userId: "user-b", shareUnits: 1 },
        { userId: "user-a", shareUnits: 1 },
        { userId: "user-c", shareUnits: 2 },
      ],
      totalAmountMinor: 1001,
    };

    const tx = expenseTx(null);
    await push(tx, userId, expenseChange(payload, { version: 4 }));

    // Byte-for-byte the answer `POST /finance/groups/:id/expenses` writes for the
    // same request. This is the assertion that keeps the two transports from
    // drifting again: it fails the moment either side grows its own arithmetic.
    expect(createdShares(tx)).toEqual(
      allocateExpenseShares(1001, payload.shares, "SHARES").map((share) => ({
        userId: share.userId,
        owedAmountMinor: BigInt(share.owedAmountMinor),
        shareUnits: share.shareUnits ?? null,
      })),
    );
  });

  it("hands the residual to the largest remainder, not the first row", async () => {
    const tx = expenseTx(null);

    await push(
      tx,
      userId,
      expenseChange({
        splitType: "SHARES",
        shares: [
          { userId: "user-z", shareUnits: 2, owedAmountMinor: 0 },
          { userId: "user-a", shareUnits: 1, owedAmountMinor: 0 },
          { userId: "user-m", shareUnits: 1, owedAmountMinor: 0 },
        ],
        totalAmountMinor: 1001,
      }),
    );

    // 500.5 / 250.25 / 250.25 floored to 500 / 250 / 250: the leftover paisa is
    // the largest remainder's, whoever holds it.
    expect(createdShares(tx).map((s: any) => [s.userId, minor(s)])).toEqual([
      ["user-a", 250],
      ["user-m", 250],
      ["user-z", 501],
    ]);
  });

  it("takes a weight-only list from a current client, and its amounts from an old one", async () => {
    const weightOnly = expenseChange({
      splitType: "PERCENTAGE",
      shares: [
        { userId: "user-a", shareUnits: 50 },
        { userId: "user-b", shareUnits: 50 },
      ],
    });
    const withAmounts = expenseChange({
      splitType: "PERCENTAGE",
      // The realistic device: an older `SplitCalculator` that already decided the
      // paisa and got the rounding wrong.
      shares: [
        { userId: "user-a", shareUnits: 50, owedAmountMinor: 3333 },
        { userId: "user-b", shareUnits: 50, owedAmountMinor: 3333 },
      ],
    });

    expect(() => assertPushableChanges([weightOnly])).not.toThrow();
    expect(() => assertPushableChanges([withAmounts])).not.toThrow();

    const fresh = expenseTx(null);
    await push(fresh, userId, weightOnly);
    const stale = expenseTx(null);
    await push(stale, userId, withAmounts);

    // Same row either way: the weights decide and the amounts are ignored, which
    // is what `ExpenseShareItemDto` already promises on the REST side.
    expect(createdShares(fresh).map((s: any) => minor(s))).toEqual([
      5000, 5000,
    ]);
    expect(createdShares(stale).map((s: any) => [s.userId, minor(s)])).toEqual(
      createdShares(fresh).map((s: any) => [s.userId, minor(s)]),
    );
  });

  it("keeps the exact-sum contract for EXACT and ITEMIZED", async () => {
    await expect(
      push(
        expenseTx(null),
        userId,
        expenseChange({ splitType: "EXACT", shares: trio }),
      ),
    ).rejects.toThrow(BadRequestException);

    const fine = expenseTx(null);
    await push(
      fine,
      userId,
      expenseChange({
        splitType: "EXACT",
        shares: [
          { userId: "user-a", owedAmountMinor: 6000 },
          { userId: "user-b", owedAmountMinor: 4000 },
        ],
      }),
    );
    expect(createdShares(fine).map((s: any) => minor(s))).toEqual([6000, 4000]);
  });

  it("still refuses the splits no transport accepts", async () => {
    const refused = async (payload: Record<string, any>) => {
      const tx = expenseTx(null);
      await expect(
        push(tx, userId, expenseChange({ splitType: "EQUAL", ...payload })),
      ).rejects.toThrow(BadRequestException);
      expect(tx.financeSharedExpense.create).not.toHaveBeenCalled();
    };

    // A negative amount, a participant listed twice, nobody taking a share, a
    // zero total: each was refused before this file touched the split, and the
    // allocator is what refuses them now.
    await refused({
      shares: [
        { userId: "user-a", owedAmountMinor: -1 },
        { userId: "user-b", owedAmountMinor: 10001 },
      ],
    });
    await refused({
      shares: [
        { userId: "user-a", owedAmountMinor: 5000 },
        { userId: "user-a", owedAmountMinor: 5000 },
      ],
    });
    await refused({ shares: [] });
    await refused({ totalAmountMinor: 0, shares: trio });
    await refused({
      shares: [{ userId: "user-a", shareUnits: 0 }],
      splitType: "SHARES",
    });
  });

  it("reallocates against the stored total when an update moves only the shares", async () => {
    const tx = expenseTx({
      groupId,
      tripId: null,
      totalAmountMinor: BigInt(1000),
      splitType: "EQUAL",
      deletedAt: null,
      version: 1,
    });

    await push(
      tx,
      userId,
      expenseChange(
        {
          splitType: "EQUAL",
          // No `totalAmountMinor`: the row's 1000 is the total being split, and
          // the device never said otherwise.
          totalAmountMinor: undefined,
          shares: [
            { userId: "user-a" },
            { userId: "user-b" },
            { userId: "user-c" },
          ],
        },
        { operation: ChangeOperation.UPDATE, version: 2 },
      ),
    );

    const data = tx.financeSharedExpense.update.mock.calls[0][0].data;
    // This asserted `expect(data.shares.deleteMany).toEqual({})` while the UPDATE
    // branch still rebuilt the table: the nested delete was the mechanism, and the
    // assertion was only ever pinning it. The allocation it proved is unchanged —
    // the same three amounts now reach the share table as three row inserts, and no
    // delete runs at all, because a device push that erased a tombstone also erased
    // the fact that somebody left. See `projection_share_diff.spec.ts` for the
    // tombstone half.
    expect(data).not.toHaveProperty("shares");
    expect(projectedShares(tx).map((s: any) => [s.userId, minor(s)])).toEqual([
      ["user-a", 334],
      ["user-b", 333],
      ["user-c", 333],
    ]);
    expect(tx.financeExpenseShare.findMany).toHaveBeenCalledTimes(1);
    // Nobody is in the table yet, so there is nothing to tombstone.
    expect(tx.financeExpenseShare.update).not.toHaveBeenCalled();
  });

  it("leaves the shares an update never mentions out of the write", async () => {
    const tx = expenseTx({
      groupId,
      tripId: null,
      totalAmountMinor: BigInt(999),
      splitType: "EQUAL",
      deletedAt: null,
      version: 1,
    });

    await push(
      tx,
      userId,
      expenseChange(
        { title: "Dinner, reworded", totalAmountMinor: 999 },
        { operation: ChangeOperation.UPDATE, version: 2 },
      ),
    );

    expect(
      tx.financeSharedExpense.update.mock.calls[0][0].data,
    ).not.toHaveProperty("shares");
    // A change that never spoke about the split does not even read it: no row is
    // touched, so no version moves and no `isSettled` can be lost.
    expect(tx.financeExpenseShare.findMany).not.toHaveBeenCalled();
    expect(tx.financeExpenseShare.create).not.toHaveBeenCalled();
    expect(tx.financeExpenseShare.update).not.toHaveBeenCalled();
  });
});

describe("stale deletes on the non-finance entities", () => {
  /**
   * One delegate, keyed by the entity the change names: `projectAcceptedChange`
   * dispatches on `entityType`, so the other tables are never asked for.
   */
  const rowHolds = (
    key: string,
    id: string,
    row: Record<string, any> | null,
  ): Fake => ({
    [key]: {
      findUnique: jest.fn().mockResolvedValue(row),
      create: jest.fn().mockResolvedValue({ id }),
      update: jest.fn().mockResolvedValue({ id }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  });

  const del = (
    entityType: string,
    entityId: string,
    version: number,
  ): ProjectableChange => ({
    entityType,
    entityId,
    operation: ChangeOperation.DELETE,
    version,
    payload: { version },
  });

  for (const [entityType, key, id] of [
    ["note", "note", noteId],
    ["folder", "folder", folderId],
    ["task", "task", taskId],
    ["event", "event", eventId],
  ] as const) {
    it(`refuses ${entityType} a delete older than the row it lands on`, async () => {
      // The gate in `sync.service.ts` compares against the newest `Change` row,
      // and `MaintenanceProcessor` prunes those once they are past retention and
      // no live device is waiting on them. With the tail gone the row's own
      // version is the only thing standing between a 40-day-old delete and a
      // document the owner is still editing.
      const tx = rowHolds(key, id, {
        userId,
        version: 40,
        deletedAt: null,
      });

      await push(tx, userId, del(entityType, id, 3));

      expect(tx[key].update).not.toHaveBeenCalled();
    });

    it(`tombstones ${entityType} at the version the log just accepted`, async () => {
      const ahead = rowHolds(key, id, {
        userId,
        version: 40,
        deletedAt: null,
      });
      await push(ahead, userId, del(entityType, id, 41));
      expect(ahead[key].update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(
        Date,
      );
      expect(ahead[key].update.mock.calls[0][0].data.version).toBe(41);

      // The documented product decision is untouched: an equal remote version is
      // a retry or a genuine concurrent write, and either way it wins.
      const tie = rowHolds(key, id, {
        userId,
        version: 41,
        deletedAt: null,
      });
      await push(tie, userId, del(entityType, id, 41));
      expect(tie[key].update).toHaveBeenCalled();
    });

    it(`leaves a ${entityType} delete that names no row alone`, async () => {
      const tx = rowHolds(key, id, null);
      await push(tx, userId, del(entityType, id, 2));
      expect(tx[key].update).not.toHaveBeenCalled();
      expect(tx[key].create).not.toHaveBeenCalled();
    });
  }

  it("keeps a tombstoned row tombstoned against the delete that raced it", async () => {
    const tombstoned = () =>
      rowHolds("note", noteId, {
        userId,
        version: 12,
        deletedAt: new Date(),
      });

    // Same number, already deleted: writing again would only re-stamp `deletedAt`
    // and move the row's edit time. A newer delete still gets through.
    const raced = tombstoned();
    await push(raced, userId, del("note", noteId, 12));
    expect(raced.note.update).not.toHaveBeenCalled();

    const later = tombstoned();
    await push(later, userId, del("note", noteId, 13));
    expect(later.note.update).toHaveBeenCalled();
  });

  it("honours the same tie for the newer content a delete gave way to", async () => {
    const tx = rowHolds("note", noteId, {
      userId,
      version: 40,
      deletedAt: null,
    });

    // The stale delete was refused, so the note is still live at 40 — and the
    // owner's next edit has to land on it rather than on a version the delete
    // would have rolled back to 3.
    await push(tx, userId, {
      entityType: "note",
      entityId: noteId,
      operation: ChangeOperation.UPDATE,
      version: 41,
      payload: { title: "Still here", content: null },
    });

    expect(tx.note.update.mock.calls[0][0].data.version).toBe(41);
  });

  it("gives a calendar delete no version guard, because the row has none", async () => {
    const tx = rowHolds("calendar", calendarId, {
      userId,
      deletedAt: null,
    });

    // `Calendar` carries no `version` column, so this branch cannot answer the
    // question the guard asks — and it also cannot roll a stored version
    // backwards, since it writes no version at all. Pinned so the day the column
    // lands, this is the test that says what changed.
    await push(tx, userId, del("calendar", calendarId, 1));

    expect(tx.calendar.update).toHaveBeenCalledWith({
      where: { id: calendarId },
      data: { deletedAt: expect.any(Date) },
    });
  });
});
