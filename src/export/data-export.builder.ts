import { Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  accountWhere,
  USER_DATA_COLLECTIONS,
  type UserDataCollection,
} from "./user-data.collections";

const logger = new Logger("DataExport");

/** Format key a consumer can check before parsing a line it did not expect. */
export const EXPORT_FORMAT = "allinone-account-export";
export const EXPORT_FORMAT_VERSION = 1;

/**
 * Rows fetched per query, and equally the size of the id list handed to a child
 * collection's `in` clause.
 *
 * A whole account's note library used to be read with one unbounded `findMany`,
 * which is fine until it is the request that takes the process: an export is the
 * one endpoint a caller is *expected* to point at their largest account. Paging
 * here bounds the server's memory and the size of any one query, and the format
 * below is what makes it possible to stream the result instead of buffering it —
 * the bundle is written line by line and never assembled as one object.
 */
export const EXPORT_PAGE_SIZE = 200;

/** A collection that left partially withheld, and why. */
export interface DataExportRedaction {
  readonly collection: string;
  readonly fields: readonly string[];
  readonly reason: string;
}

export interface DataExportSummary {
  readonly userId: string;
  readonly records: number;
  readonly collections: Readonly<Record<string, number>>;
  /** Collections whose rows left partially redacted, and what was withheld. */
  readonly redacted: readonly DataExportRedaction[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface WriteDataExportOptions {
  readonly pageSize?: number;
}

type LineSink = (line: string) => void;

/**
 * `BigInt` is the one value type JSON cannot carry, and `Change.cursor` is a
 * `BigInt` column: serialising the change log without this replacer throws on the
 * first row. Dates need nothing — `JSON.stringify` already takes them through
 * `toJSON()` into ISO strings.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function line(payload: Record<string, unknown>, write: LineSink): void {
  write(JSON.stringify(payload, jsonReplacer));
}

function redact(
  row: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const copy = { ...row };
  for (const field of fields) delete copy[field];
  return copy;
}

function delegateOf(
  client: Prisma.TransactionClient,
  entry: UserDataCollection,
): any {
  return (client as any)[entry.delegate];
}

/**
 * One scoped read, paged by cursor over the unique `id` so no page re-reads or
 * skips a row the previous page moved past.
 *
 * `skip: 1` with a cursor is Prisma's own idiom: the cursor row is returned again,
 * and this discards it.
 */
async function eachPage(
  client: Prisma.TransactionClient,
  entry: UserDataCollection,
  where: Record<string, unknown>,
  pageSize: number,
  onPage: (rows: any[]) => void,
): Promise<void> {
  const delegate = delegateOf(client, entry);
  if (!delegate?.findMany) {
    logger.warn(
      `[DataExport] No delegate for collection "${entry.collection}"; the bundle's summary says zero for it rather than pretending it was empty.`,
    );
    return;
  }

  let cursor: { id: string } | undefined;

  for (;;) {
    const rows: any[] = await delegate.findMany({
      where,
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { cursor, skip: 1 } : {}),
    });

    if (rows.length === 0) return;
    onPage(rows);
    cursor = { id: rows[rows.length - 1].id };
    if (rows.length < pageSize) return;
  }
}

/**
 * The ids of an account's parent rows, paged. Children (`NoteHistory`, `NoteTag`,
 * `TaskLabel`, `Section`, `EventAttendee`, `DeviceSyncState`,
 * `FinanceTripItinerary`) have no owner column, so this is the only way to bound
 * their read: one page of parent ids becomes one `in` list of children.
 */
async function eachParentPage(
  client: Prisma.TransactionClient,
  parent: UserDataCollection,
  userId: string,
  pageSize: number,
  onPage: (ids: string[]) => Promise<void> | void,
): Promise<void> {
  const delegate = delegateOf(client, parent);
  if (!delegate?.findMany) return;

  let cursor: { id: string } | undefined;

  for (;;) {
    const rows: any[] = await delegate.findMany({
      where: accountWhere(parent, userId),
      select: { id: true },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { cursor, skip: 1 } : {}),
    });

    if (rows.length === 0) return;
    const ids = rows.map((row) => row.id as string);
    await onPage(ids);
    cursor = { id: ids[ids.length - 1] };
    if (rows.length < pageSize) return;
  }
}

/**
 * Streams an account's own data as NDJSON — one JSON object per line — into
 * `writeLine`, and returns the summary that goes into the audit row proving the
 * bundle was made.
 *
 * Shape of the file:
 *
 *     {"kind":"header","format":"allinone-account-export","version":1,...}
 *     {"kind":"record","collection":"user","data":{...}}
 *     {"kind":"record","collection":"note","data":{...}}
 *     ...
 *     {"kind":"collection","collection":"note","rows":1421}
 *     {"kind":"summary","records":..., "collections":{...},"redacted":[...]}
 *
 * The `collection` marker closes each section so a reader can skip what it has
 * already seen without holding the file, and the trailing `summary` is the part to
 * compare against the counts the erasure reports afterwards.
 *
 * Foreign content is bounded by construction, not by a filter after the fact: every
 * read is either keyed by the account's own owner column or by the ids of rows this
 * account owns, so a `NoteTag` of somebody else's note is unreachable and a
 * `ResourceShare` returns the grants this account issued and received — the shared
 * *document* stays with the owner who wrote it.
 *
 * The exported `vaultSetting` row keeps its KDF parameters and loses its verifier
 * and wrapped-key columns; the vault's content travels as `vault_item` payloads in
 * the `change` section, which are blobs only the owner's master password opens.
 */
export async function writeDataExport(
  client: Prisma.TransactionClient,
  userId: string,
  writeLine: LineSink,
  options: WriteDataExportOptions = {},
): Promise<DataExportSummary> {
  const pageSize = Math.max(1, options.pageSize ?? EXPORT_PAGE_SIZE);
  const startedAt = new Date().toISOString();
  const counts: Record<string, number> = {};
  const redacted: DataExportRedaction[] = [];
  let records = 0;

  const account: any = await (client as any).user?.findUnique?.({
    where: { id: userId },
  });

  line(
    {
      kind: "header",
      format: EXPORT_FORMAT,
      version: EXPORT_FORMAT_VERSION,
      userId,
      exportedAt: startedAt,
      pageSize,
    },
    writeLine,
  );

  if (account) {
    records += 1;
    counts.user = 1;
    line({ kind: "record", collection: "user", data: account }, writeLine);
    line({ kind: "collection", collection: "user", rows: 1 }, writeLine);
  }

  for (const entry of USER_DATA_COLLECTIONS) {
    let sectionRecords = 0;

    const emit = (rows: any[]): void => {
      for (const row of rows) {
        const data = entry.redact
          ? redact(row, entry.redact)
          : (row as Record<string, unknown>);
        line({ kind: "record", collection: entry.collection, data }, writeLine);
        sectionRecords += 1;
      }
    };

    if (entry.scope.by === "parent") {
      const key = entry.scope.key;
      await eachParentPage(
        client,
        entry.scope.parent,
        userId,
        pageSize,
        async (parentIds) => {
          // One parent page bounds one children read, so a ten-thousand-note
          // account never assembles a ten-thousand-element `in` list.
          await eachPage(
            client,
            entry,
            { [key]: { in: parentIds } },
            pageSize,
            emit,
          );
        },
      );
    } else {
      await eachPage(
        client,
        entry,
        accountWhere(entry, userId),
        pageSize,
        emit,
      );
    }

    counts[entry.collection] = sectionRecords;
    records += sectionRecords;
    line(
      { kind: "collection", collection: entry.collection, rows: sectionRecords },
      writeLine,
    );

    if (entry.redact?.length) {
      redacted.push({
        collection: entry.collection,
        fields: entry.redact,
        reason:
          "Bearer credential or server-side key material: it authenticates or unlocks, so it stays in the database.",
      });
    }
  }

  const summary: DataExportSummary = {
    userId,
    records,
    collections: counts,
    redacted,
    startedAt,
    finishedAt: new Date().toISOString(),
  };

  line({ kind: "summary", ...summary }, writeLine);
  return summary;
}
