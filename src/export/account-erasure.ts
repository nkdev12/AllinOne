import { Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  accountWhere,
  ERASED_COLLECTIONS,
  type UserDataCollection,
} from "./user-data.collections";

const logger = new Logger("AccountData");

/** Rows deleted per `deleteMany`, and the id list size for a parent's children. */
export const ERASURE_PAGE_SIZE = 200;

type Delegate = {
  findMany?: (args: any) => Promise<any[]>;
  deleteMany?: (args: any) => Promise<{ count: number }>;
};

function delegateOf(
  client: Prisma.TransactionClient,
  entry: UserDataCollection,
): Delegate | undefined {
  return (client as any)[entry.delegate];
}

/**
 * Paged `deleteMany` over one collection: bounded work per statement, and a child
 * collection is reached through pages of its parent's ids so no `$in` list grows
 * with the account.
 */
async function deleteCollection(
  client: Prisma.TransactionClient,
  entry: UserDataCollection,
  userId: string,
  pageSize: number,
): Promise<number> {
  const delegate = delegateOf(client, entry);
  if (!delegate?.deleteMany) {
    // Refuse loudly rather than reporting a clean erasure of a collection this
    // could not reach: the caller is about to tombstone the account it claims to
    // have emptied.
    throw new Error(
      `Cannot erase collection "${entry.collection}": no delegate on the Prisma client.`,
    );
  }

  if (entry.scope.by !== "parent") {
    const { count } = await delegate.deleteMany({
      where: accountWhere(entry, userId),
    });
    return count;
  }

  // A child row is found through its parent, and only through parents this account
  // owns — the same `accountWhere` the export read them with.
  const parent = delegateOf(client, entry.scope.parent);
  if (!parent?.findMany) return 0;

  const key = entry.scope.key;
  let deleted = 0;
  let cursor: { id: string } | undefined;

  for (;;) {
    const parentRows: any[] = await parent.findMany({
      where: accountWhere(entry.scope.parent, userId),
      select: { id: true },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { cursor, skip: 1 } : {}),
    });

    if (parentRows.length === 0) return deleted;

    const ids = parentRows.map((row) => row.id as string);
    const { count } = await delegate.deleteMany({
      where: { [key]: { in: ids } },
    });
    deleted += count;
    cursor = { id: ids[ids.length - 1] };
    if (parentRows.length < pageSize) return deleted;
  }
}

/**
 * Hard-deletes every collection an account's content is made of, and returns the
 * per-collection counts it removed.
 *
 * Reads `USER_DATA_COLLECTIONS` — the same list `writeDataExport` streams — so the
 * two cannot drift apart, and `src/users/account-erasure.spec.ts` holds them
 * against each other: a row this removes is a row the bundle carried. The
 * collections the finding listed as surviving (`Change` included, whose `payload`
 * is plaintext note, task and event content) are exactly the entries marked
 * `erasure: true`.
 *
 * Ordering is the manifest's: children before the parents their ids were resolved
 * from, and `change`/`syncCursor` last so the oplog outlives the rows it describes
 * for the whole pass.
 *
 * Every step is a `deleteMany`, which is idempotent: run it twice and the second
 * pass reports zeroes. That is what makes the caller's degrade-to-sequential path
 * safe — on a standalone MongoDB, where `$transaction` cannot span these
 * collections, a first attempt that died halfway leaves a state a retry finishes
 * rather than one it has to reason about.
 */
export async function deleteAccountData(
  client: Prisma.TransactionClient,
  userId: string,
  pageSize = ERASURE_PAGE_SIZE,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const entry of ERASED_COLLECTIONS) {
    counts[entry.collection] = await deleteCollection(
      client,
      entry,
      userId,
      pageSize,
    );
  }

  const removed = Object.values(counts).reduce((total, n) => total + n, 0);
  logger.log(
    `[AccountData] Erased ${removed} row(s) across ${Object.keys(counts).length} collection(s) for user ${userId}.`,
  );

  return counts;
}
