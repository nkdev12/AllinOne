import { PrismaClient } from "@prisma/client";

/**
 * Backfills `Change.cursor` for rows written before the per-user cursor existed.
 *
 * Every such row carries the schema default of 0, and a pull asks for
 * `cursor > <stored checkpoint>`, so once a device has taken one real checkpoint
 * those rows sit permanently behind it: they are never replayed and never
 * pruned-into. This assigns ascending cursors per user, oldest change first, so
 * the historical log replays in the order it was written.
 *
 * - Rows that already carry a cursor are left alone, and numbering starts above
 *   the highest one a user already has. That keeps the uniqueness the pull
 *   filter depends on: two rows on the same cursor would be skipped together.
 * - The user's `SyncCursor` counter is then bumped to the same high-water mark,
 *   because a live push increments from the counter and would otherwise hand out
 *   a cursor that this script has already used.
 *
 * Safe to re-run: it only ever touches rows still sitting on the default 0. It
 * no longer needs to be repeated, though — every module that logs a change
 * outside `src/sync` (notes, tasks, calendar, ai) now does it through
 * `appendChange`, which takes its number from the same per-user counter a push
 * uses. What is left here is history: rows written before that, which no client
 * can ever have read.
 *
 * Run after `prisma db push`:
 *   npm run sync:backfill:cursor          # write
 *   npm run sync:backfill:cursor -- --dry-run
 */

const UPDATE_BATCH_SIZE = 500;

const prisma = new PrismaClient();

interface PendingRow {
  id: string;
  userId: string;
}

function groupByUser<T extends { userId: string }>(
  rows: T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.userId);
    if (bucket) bucket.push(row);
    else grouped.set(row.userId, [row]);
  }
  return grouped;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    chunks.push(rows.slice(offset, offset + size));
  }
  return chunks;
}

async function highestStoredCursor(userId: string): Promise<bigint> {
  const newest = await prisma.change.findFirst({
    where: { userId, cursor: { gt: BigInt(0) } },
    orderBy: { cursor: "desc" },
    select: { cursor: true },
  });

  return newest?.cursor ?? BigInt(0);
}

/**
 * Conditional bump: the `seq: { lt: target }` filter is part of the write
 * itself, so a push that raced ahead of this script is never overwritten
 * downwards. A plain read-then-write could.
 */
async function seedCursorCounter(
  userId: string,
  target: bigint,
): Promise<void> {
  const bumped = await prisma.syncCursor.updateMany({
    where: { userId, seq: { lt: target } },
    data: { seq: target },
  });
  if (bumped.count > 0) return;

  const existing = await prisma.syncCursor.findUnique({
    where: { userId },
    select: { seq: true },
  });
  if (existing) return;

  await prisma.syncCursor.create({ data: { userId, seq: target } });
}

async function backfillUser(
  userId: string,
  pending: PendingRow[],
  dryRun: boolean,
): Promise<{ from: bigint; to: bigint }> {
  const start = (await highestStoredCursor(userId)) + BigInt(1);

  let cursor = start;
  const numbered = pending.map((row) => ({ ...row, cursor: cursor++ }));

  for (const batch of chunk(numbered, UPDATE_BATCH_SIZE)) {
    if (dryRun) continue;
    await prisma.$transaction(
      batch.map((row) =>
        prisma.change.update({
          where: { id: row.id },
          data: { cursor: row.cursor },
        }),
      ),
    );
  }

  if (!dryRun) await seedCursorCounter(userId, cursor - BigInt(1));

  return { from: start, to: cursor - BigInt(1) };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(
    dryRun ? "Dry run: nothing is written." : "Backfilling Change.cursor...",
  );

  // One scan, ordered so each user's rows arrive oldest-first: the assignment
  // order below is exactly what a device will replay them in.
  const pending = await prisma.change.findMany({
    where: { cursor: BigInt(0) },
    orderBy: [{ userId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, userId: true },
  });

  const byUser = groupByUser(pending);
  if (byUser.size === 0) {
    console.log("No changes carry cursor 0. Nothing to do.");
    return;
  }

  console.log(
    `${pending.length} change(s) across ${byUser.size} user(s) need a cursor.`,
  );

  for (const [userId, rows] of byUser) {
    const { from, to } = await backfillUser(userId, rows, dryRun);
    console.log(
      `user ${userId}: ${rows.length} row(s) -> cursors ${from.toString()}..${to.toString()}`,
    );
  }

  console.log(dryRun ? "Dry run finished." : "Backfill complete.");
}

main()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
