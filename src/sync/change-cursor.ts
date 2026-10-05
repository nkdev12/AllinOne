import { Prisma } from "@prisma/client";

/**
 * The slice of a Prisma client this module needs. Passing it explicitly (rather
 * than importing PrismaService) keeps these calls usable both inside an
 * interactive transaction and straight off the client, so any module that owns a
 * `change.create` can adopt the same cursor without depending on `src/sync`.
 */
export type ChangeCursorClient = Pick<
  Prisma.TransactionClient,
  "change" | "syncCursor"
>;

/**
 * Hands out the next cursor for a user. Every accepted change takes exactly one
 * increment, so cursor order is the order the client queued its changes in —
 * which is what makes a pull replay edits before the delete that followed them.
 *
 * The counter is a document of its own because Mongo has no sequence primitive:
 * the atomic `$inc` on the same `userId` row is what stops two concurrent
 * pushes from being handed the same cursor, and the caller runs it inside the
 * transaction that writes the Change row so a rolled-back push cannot burn a
 * number that later looks like a gap in the log.
 */
export async function allocateNextChangeCursor(
  client: ChangeCursorClient,
  userId: string,
): Promise<bigint> {
  const row = await client.syncCursor.upsert({
    where: { userId },
    update: { seq: { increment: BigInt(1) } },
    create: { userId, seq: BigInt(1) },
    select: { seq: true },
  });

  return row.seq;
}

/**
 * End of a user's change log: the highest cursor that has ever been handed out,
 * whether or not its row is still stored.
 *
 * Reading only the newest Change would go backwards whenever old rows are pruned
 * or when the counter was seeded past what is still on disk, and a client that
 * compares this against its own cursor would then conclude it has nothing left
 * to pull while the log really does run further.
 */
export async function getHighestChangeCursor(
  client: ChangeCursorClient,
  userId: string,
): Promise<bigint> {
  const counter = await client.syncCursor.findUnique({
    where: { userId },
    select: { seq: true },
  });

  const newestStored = await client.change.findFirst({
    where: { userId },
    orderBy: { cursor: "desc" },
    select: { cursor: true },
  });

  const stored = newestStored?.cursor ?? BigInt(0);
  const seq = counter?.seq ?? BigInt(0);

  return seq > stored ? seq : stored;
}

/**
 * Write one row to a user's change log, and hand it a cursor.
 *
 * This is the only way to append, on purpose. `cursor` defaults to 0 in the
 * schema and a pull asks for `cursor > <this device's checkpoint>`, so a row
 * written without one is not merely mis-numbered — it is invisible to every
 * device that has ever synced successfully, forever, and nothing on the read
 * path can tell it apart from a row that was simply already delivered. Four
 * modules (`notes`, `tasks`, `calendar`, `ai`) log changes outside `src/sync`
 * and each used to allocate by hand or, more often, not at all; taking
 * `cursor` out of the caller's argument list is what makes the omission
 * impossible rather than unlikely.
 *
 * The allocation runs in the caller's transaction, so a write that later rolls
 * back cannot burn a number that would then look like a gap in the log. What a
 * caller passes is everything the row is made of — `deviceId` stays optional
 * and NULL for a change the server authored itself, which is what the schema
 * says it means.
 */
export async function appendChange(
  client: ChangeCursorClient,
  data: Omit<Prisma.ChangeUncheckedCreateInput, "cursor">,
): Promise<{ id: string; cursor: bigint }> {
  const cursor = await allocateNextChangeCursor(client, data.userId);
  const created = await client.change.create({ data: { ...data, cursor } });

  // The cursor handed out, not the one read back off the row: a caller that
  // reports the end of the log to a device must answer even when the write
  // returned a bare id.
  return { id: created.id, cursor };
}
