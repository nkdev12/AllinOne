import { BadRequestException } from "@nestjs/common";
import { ChangeOperation } from "@prisma/client";
import { assertPushableChanges } from "./change-payload.validator";
import {
  projectAcceptedChange,
  type ChangeProjectionClient,
  type ProjectableChange,
} from "./change-projection";

/**
 * The share half of a pushed `finance_shared_expense` CREATE.
 *
 * `projection_share_diff.spec.ts` pins what the projection does to share rows
 * that already exist. This file pins the other half — the expense a device is
 * sending for the first time — because the same defect had two mouths and today
 * only one was closed. A phone that recorded "Bala paid me back" and then pushes
 * the expense for the first time states `isSettled`/`settledAt` on its share; the
 * UPDATE diff carries those two keys onto the row it inserts, and the CREATE
 * branch nested `shares: { create: shareData }` with `shareData` built from
 * exactly three keys, so the identical payload silently meant something different
 * depending on whether the row already existed. That is the "one action, two
 * answers by transport" bug again, one column over.
 *
 * Each `it` names the mutation of `change-projection.ts` that would make it fail,
 * so a later "simplification" back to the three-key list is caught by the test
 * that says why the list grew.
 */

const userId = "user-uuid-123";
const expenseId = "66666666-6666-4666-8666-666666666666";
const groupId = "77777777-7777-4777-8777-777777777777";
const alice = "user-a";
const bob = "user-b";

const SETTLED_AT = "2026-10-12T09:00:00.000Z";

/** Loose on purpose: the projection reads methods off each delegate. */
type Fake = Record<string, any>;

type StoredShare = {
  id: string;
  sharedExpenseId: string;
  userId: string;
  owedAmountMinor: bigint;
  shareUnits: number | null;
  isSettled: boolean;
  settledAt: Date | null;
  deletedAt: Date | null;
  version: number;
};

function storedShare(
  over: Partial<StoredShare> & { id: string; userId: string },
): StoredShare {
  return {
    sharedExpenseId: expenseId,
    owedAmountMinor: BigInt(0),
    shareUnits: null,
    isSettled: false,
    settledAt: null,
    deletedAt: null,
    version: 1,
    ...over,
  };
}

/**
 * What the column defaults in `prisma/schema.prisma` (`FinanceExpenseShare`) turn
 * a handed create into: `isSettled Boolean @default(false)`, `settledAt DateTime?`
 * and `version Int @default(1)` are filled by Prisma when the key is absent, so
 * asserting through this helper is asserting about the stored row rather than
 * about the argument — which is what makes a dropped settle fact show up as
 * `isSettled: false` instead of as a key nobody thought to look for.
 */
function asRowCreated(data: Record<string, any>) {
  return {
    userId: data.userId,
    owedAmountMinor: data.owedAmountMinor,
    shareUnits: data.shareUnits ?? null,
    isSettled: data.isSettled ?? false,
    settledAt: data.settledAt ?? null,
    deletedAt: data.deletedAt ?? null,
    version: data.version ?? 1,
  };
}

/**
 * The transaction `/sync/push` hands the projection. `financeSharedExpense.create`
 * is where the nested `shares: { create: shareData }` lands — Prisma inserts those
 * rows for us, so this fake records the argument exactly as given, which is the
 * whole of what the create path can be held to.
 */
function txWith(
  existing: Record<string, any> | null,
  shareRows: StoredShare[] = [],
) {
  const tx: Fake = {
    financeGroup: {
      findUnique: jest.fn().mockResolvedValue({
        ownerId: userId,
        deletedAt: null,
        currency: "INR",
      }),
    },
    financeSharedExpense: {
      findUnique: jest
        .fn()
        .mockResolvedValue(existing ? { ...existing } : null),
      create: jest.fn().mockResolvedValue({ id: expenseId }),
      update: jest.fn().mockResolvedValue({ id: expenseId }),
    },
    financeExpenseShare: {
      findMany: jest.fn(async () => shareRows.map((row) => ({ ...row }))),
      create: jest.fn(async ({ data }: any) => {
        const row: StoredShare = {
          id: `share-new-${shareRows.length + 1}`,
          ...asRowCreated(data),
          sharedExpenseId: data.sharedExpenseId,
        };
        shareRows.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const target = shareRows.find((row) => row.id === where.id);
        if (!target) throw new Error(`P2025: no share row with id ${where.id}`);
        for (const [key, value] of Object.entries(
          data as Record<string, any>,
        )) {
          if (
            value &&
            typeof value === "object" &&
            "increment" in (value as Record<string, any>)
          ) {
            (target as any)[key] =
              Number((target as any)[key]) +
              Number((value as Record<string, any>).increment);
            continue;
          }
          (target as any)[key] = value;
        }
        return { ...target };
      }),
    },
  };
  return { tx, shareRows };
}

function expenseRow(over: Record<string, any> = {}) {
  return {
    groupId,
    tripId: null,
    totalAmountMinor: BigInt(10000),
    splitType: "EXACT",
    deletedAt: null,
    version: 1,
    ...over,
  };
}

function expenseChange(
  payload: Record<string, any>,
  over: Partial<ProjectableChange> = {},
): ProjectableChange {
  return {
    entityType: "finance_shared_expense",
    entityId: expenseId,
    operation: ChangeOperation.CREATE,
    version: 3,
    payload: {
      groupId,
      paidByUserId: userId,
      title: "Dinner",
      totalAmountMinor: 10000,
      currency: "INR",
      splitType: "EXACT",
      date: "2026-10-01T19:00:00.000Z",
      ...payload,
    },
    ...over,
  };
}

const push = (tx: Fake, change: ProjectableChange) =>
  projectAcceptedChange(
    tx as unknown as ChangeProjectionClient,
    userId,
    change,
  );

/** The nested row the create handed Prisma for one participant. */
function nestedShare(tx: Fake, who: string): Record<string, any> {
  const call = tx.financeSharedExpense.create.mock.calls[0];
  expect(call).toBeDefined();
  const nested = call[0].data.shares?.create;
  expect(nested).toBeDefined();
  const row = nested.find((share: any) => share.userId === who);
  if (!row) throw new Error(`no nested share row was created for ${who}`);
  return row;
}

describe("a pushed finance_shared_expense CREATE carries its shares' settle facts", () => {
  it("writes the stated isSettled / settledAt onto the share it creates", async () => {
    // Break this by building `shareData` from the three keys the allocator returns
    // (the shipped defect): the expense lands, the share lands next to it, and the
    // repayment that was already true on the phone is false on the server, for
    // every device that pulls it. `applyProjectedShareDiff` already carries the
    // same two keys onto the rows it inserts — a mutation that only fixed the
    // UPDATE half is what this test exists to catch.
    const change = expenseChange({
      shares: [
        { userId: alice, owedAmountMinor: 6000 },
        {
          userId: bob,
          owedAmountMinor: 4000,
          isSettled: true,
          settledAt: SETTLED_AT,
        },
      ],
    });
    expect(() => assertPushableChanges([change])).not.toThrow();

    const { tx } = txWith(null);
    await push(tx, change);

    const row = nestedShare(tx, bob);
    expect(row.isSettled).toBe(true);
    expect(row.settledAt).toBeInstanceOf(Date);
    expect((row.settledAt as Date).toISOString()).toBe(SETTLED_AT);
    expect(asRowCreated(row)).toMatchObject({
      isSettled: true,
      settledAt: new Date(SETTLED_AT),
    });

    // The participant who stated nothing is not settled by somebody else's push.
    expect(asRowCreated(nestedShare(tx, alice))).toMatchObject({
      isSettled: false,
      settledAt: null,
    });
  });

  it("still creates the legacy three-key split as rows with the schema defaults", async () => {
    // Break this by making the new keys mandatory, or by always spreading
    // `{ isSettled: false, settledAt: null }`: every build in the wild queues
    // exactly `{userId, owedAmountMinor, shareUnits}`, and this is the payload that
    // has to keep replaying unchanged after the fix — byte-identical nested rows,
    // filled by the column defaults and nothing invented here.
    const change = expenseChange({
      shares: [
        { userId: alice, owedAmountMinor: 6000, shareUnits: null },
        { userId: bob, owedAmountMinor: 4000, shareUnits: null },
      ],
    });
    expect(() => assertPushableChanges([change])).not.toThrow();

    const { tx } = txWith(null);
    await push(tx, change);

    for (const who of [alice, bob]) {
      const row = nestedShare(tx, who);
      expect(Object.keys(row).sort()).toEqual([
        "owedAmountMinor",
        "shareUnits",
        "userId",
      ]);
      expect(asRowCreated(row)).toEqual({
        userId: who,
        owedAmountMinor: BigInt(who === alice ? 6000 : 4000),
        shareUnits: null,
        isSettled: false,
        settledAt: null,
        deletedAt: null,
        version: 1,
      });
    }
  });

  it("refuses to let a create claim an edit history through a stated share version", async () => {
    // Break this by copying `share.version` off the payload onto the new row: the
    // parent takes `version: change.version` because the log entry it is filed
    // under really is that edit, while `applyProjectedShareDiff` increments per
    // edit it applies. A row that has never existed has no such history, so a
    // client that wrote `version: 40` here would start the split at a number no
    // server edit ever produced — and every later real edit would look stale to a
    // device reading it back.
    const change = expenseChange(
      {
        shares: [
          { userId: alice, owedAmountMinor: 6000 },
          {
            userId: bob,
            owedAmountMinor: 4000,
            isSettled: true,
            settledAt: SETTLED_AT,
            version: 40,
          },
        ],
      },
      { version: 3 },
    );
    expect(() => assertPushableChanges([change])).not.toThrow();

    const { tx } = txWith(null);
    await push(tx, change);

    const row = nestedShare(tx, bob);
    expect(row).not.toHaveProperty("version");
    expect(asRowCreated(row).version).toBe(1);

    // The parent row does take the change's version, and keeps its own edit count.
    expect(tx.financeSharedExpense.create.mock.calls[0][0].data.version).toBe(
      3,
    );
    // The settle facts still ride along — ignoring `version` is not ignoring the
    // rest of what the share stated.
    expect(row.isSettled).toBe(true);
  });

  it("refuses a malformed settle stamp at the wire gate instead of storing it", async () => {
    // Break this by dropping the settlement keys into the create path with a raw
    // `new Date(share.settledAt)`: an `Invalid Date` is a value a `DateTime?`
    // column accepts, so the row would carry a settlement at no time at all —
    // garbage stored instead of refused. `assertPushableChanges` refuses the shape
    // (`validShareSettlementFlags`), and for an `EXACT` split the projection
    // refuses it too, because the allocator runs the same shared predicate.
    const malformed = expenseChange({
      shares: [
        { userId: alice, owedAmountMinor: 6000 },
        {
          userId: bob,
          owedAmountMinor: 4000,
          isSettled: "yes",
          settledAt: "the day Bala paid me back",
        },
      ],
    });

    expect(() => assertPushableChanges([malformed])).toThrow(
      BadRequestException,
    );

    const tx = txWith(null).tx;
    await expect(push(tx, malformed)).rejects.toThrow(BadRequestException);
    expect(tx.financeSharedExpense.create).not.toHaveBeenCalled();
  });

  it("keeps a settle stamp it cannot parse out of the row it creates", async () => {
    // The other half, and the one the projection owns: a caller that reached
    // `projectAcceptedChange` without the wire gate. A `SHARES` weight list is not
    // judged for settle facts by the allocator (`validShareTargets` cares about
    // participants and weights), so the only thing between this payload and the
    // table is `pushedShareSettlement()` — which reads the same two keys the diff
    // reads and treats an unparseable one as "this share states nothing".
    // Break it by handing the create path its own payload read.
    const unparseable = expenseChange({
      splitType: "SHARES",
      shares: [
        { userId: alice, shareUnits: 6 },
        {
          userId: bob,
          shareUnits: 4,
          isSettled: "yes",
          settledAt: "the day Bala paid me back",
        },
      ],
    });
    expect(() => assertPushableChanges([unparseable])).toThrow(
      BadRequestException,
    );

    const { tx } = txWith(null);
    await push(tx, unparseable);

    const row = nestedShare(tx, bob);
    expect(row).not.toHaveProperty("isSettled");
    expect(row).not.toHaveProperty("settledAt");
    expect(asRowCreated(row)).toMatchObject({
      isSettled: false,
      settledAt: null,
    });
    // The amount still lands: a bad settle stamp is no reason to lose the split.
    expect(row.owedAmountMinor).toBe(BigInt(4000));
  });

  it("answers one payload once: settled on create, untouched on an existing live row", async () => {
    // Break this by letting the UPDATE path's live-row write carry the payload's
    // flags as the CREATE's does: only the participant who owes the money settles
    // it, so a second device pushing an amount change must not be able to
    // re-stamp — or undo — a settlement the REST settlement flow already recorded.
    // The asymmetry is deliberate, and this is the test that says so in both
    // directions at once.
    const payload = {
      totalAmountMinor: 10000,
      shares: [
        { userId: alice, owedAmountMinor: 6000 },
        {
          userId: bob,
          owedAmountMinor: 4000,
          isSettled: true,
          settledAt: SETTLED_AT,
        },
      ],
    };

    const fresh = txWith(null).tx;
    await push(fresh, expenseChange(payload));
    expect(asRowCreated(nestedShare(fresh, bob))).toMatchObject({
      isSettled: true,
      settledAt: new Date(SETTLED_AT),
    });

    const stored = [
      storedShare({
        id: "share-alice",
        userId: alice,
        owedAmountMinor: BigInt(7000),
      }),
      storedShare({
        id: "share-bob",
        userId: bob,
        owedAmountMinor: BigInt(3000),
      }),
    ];
    const edited = txWith(
      expenseRow({ totalAmountMinor: BigInt(10000) }),
      stored,
    );
    await push(
      edited.tx,
      expenseChange(payload, { operation: ChangeOperation.UPDATE, version: 2 }),
    );
    // The expense really was found and really was updated: without this, the
    // "no settle keys on the share write" assertions below would pass simply
    // because the projection never reached the share table at all.
    expect(edited.tx.financeSharedExpense.update).toHaveBeenCalled();

    const writes: any[] = edited.tx.financeExpenseShare.update.mock.calls.map(
      ([arg]: any) => arg,
    );
    const bobWrite = writes.find((arg: any) => arg.where.id === "share-bob");
    expect(bobWrite).toBeDefined();
    expect(bobWrite.data.owedAmountMinor).toBe(BigInt(4000));
    expect(bobWrite.data).not.toHaveProperty("isSettled");
    expect(bobWrite.data).not.toHaveProperty("settledAt");

    const bobRow = edited.shareRows.find((row) => row.id === "share-bob")!;
    expect(Number(bobRow.owedAmountMinor)).toBe(4000);
    expect(bobRow.isSettled).toBe(false);
    expect(bobRow.settledAt).toBeNull();
    expect(edited.tx.financeExpenseShare.create).not.toHaveBeenCalled();
  });
});
