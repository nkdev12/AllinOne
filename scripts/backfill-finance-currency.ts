import { ChangeOperation, PrismaClient } from "@prisma/client";

/**
 * Upper-cases the currency codes finance rows were written with before the
 * normalisation landed.
 *
 * `accounts.service.ts`, `transactions.service.ts`, `groups.service.ts`,
 * `trips.service.ts`, `recurring.service.ts` and the sync projection now all
 * write `normaliseCurrency(value)` — trimmed, upper-case — and every aggregation
 * matches that exact-upper spelling (`where: { currency: "INR" }`). Rows written
 * before that carry `inr`, `Inr` or ` EUR `. They are invisible to those filters:
 * a balance computed over `"INR"` silently excludes them, and a device pulling
 * its own history keeps the lowercase copy forever because nothing has ever
 * logged a change for it.
 *
 * So this is not just a column rewrite. Every row it touches gets a `version`
 * bump and an UPDATE `Change` appended through the same per-user cursor counter
 * a live write uses (`src/sync/change-cursor.ts` `appendChange`), because a row
 * corrected in place while its log stays silent is a row the other devices are
 * still wrong about — and the next push from a device holding the old copy would
 * look like a user edit that re-introduces the lowercase code.
 *
 * Collections covered (the finance tables that hold a currency column at all, per
 * `prisma/schema.prisma`):
 *   finance_accounts.currency, finance_transactions.currency,
 *   finance_groups.currency, finance_shared_expenses.currency,
 *   finance_settlements.currency, finance_trips.baseCurrency.
 * Budgets, goals, loans and recurring rules carry no currency column, so they are
 * not touched: nothing here invents a field.
 *
 * Idempotent: a row whose code already equals its own upper-case form is skipped,
 * so a second pass writes nothing and appends nothing.
 *
 * Dry run by default. Nothing is written without `--apply`:
 *   npx ts-node scripts/backfill-finance-currency.ts            # report only
 *   npx ts-node scripts/backfill-finance-currency.ts --apply    # write
 *
 * Deliberately NOT wired into `package.json`, the Dockerfiles, or any migrate /
 * deploy step — a data rewrite has to be an explicit operator decision, made
 * against a backup, and it needs a replica set because the `Change` append runs
 * in a transaction.
 *
 * Note also that `tsconfig.json` includes only the `src` tree, so nothing in
 * this repo typechecks `scripts/`: the file is self-contained on purpose (no
 * `@/` path aliases, no imports from `src`, only `@prisma/client`) and is
 * validated with `npx ts-node --transpile-only` rather than `npx tsc --noEmit`.
 */

const SCAN_BATCH_SIZE = 200;

/** The rows this script is looking at, before or after the rewrite. */
interface FinanceRow {
  id: string;
  version: number;
  currency?: string;
  baseCurrency?: string;
  [field: string]: unknown;
}

interface TableSpec {
  /** Prisma delegate name, e.g. `financeAccount`. */
  delegate: string;
  /** The `Change.entityType` string `src/sync/change-projection.ts` switches on. */
  entityType: string;
  /** The currency-bearing column on this table. */
  currencyField: "currency" | "baseCurrency";
  /** Field(s) naming the account a row belongs to. */
  ownerFields: string[];
  /**
   * The remaining payload fields, mirroring the shapes the finance services
   * already append — a device that receives this change must be able to rebuild
   * the row, not just the one corrected column.
   */
  payloadFields: string[];
}

const TABLES: TableSpec[] = [
  {
    delegate: "financeAccount",
    entityType: "finance_account",
    currencyField: "currency",
    ownerFields: ["userId"],
    payloadFields: [
      "name",
      "type",
      "openingBalanceMinor",
      "currentBalanceMinor",
      "color",
      "iconKey",
      "isArchived",
      "sortOrder",
      "createdAt",
    ],
  },
  {
    delegate: "financeTransaction",
    entityType: "finance_transaction",
    currencyField: "currency",
    ownerFields: ["userId"],
    payloadFields: [
      "accountId",
      "toAccountId",
      "categoryId",
      "type",
      "amountMinor",
      "title",
      "notes",
      "tags",
      "transactionDate",
      "receiptAttachmentId",
      "recurringRuleId",
      "sharedExpenseId",
      "isExcludedFromBudget",
      "createdAt",
    ],
  },
  {
    delegate: "financeGroup",
    entityType: "finance_group",
    currencyField: "currency",
    ownerFields: ["ownerId"],
    payloadFields: [
      "name",
      "members",
      "description",
      "iconKey",
      "isArchived",
      "createdAt",
    ],
  },
  {
    delegate: "financeSharedExpense",
    entityType: "finance_shared_expense",
    currencyField: "currency",
    ownerFields: ["paidByUserId"],
    payloadFields: [
      "groupId",
      "tripId",
      "paidByUserId",
      "payerAccountId",
      "title",
      "totalAmountMinor",
      "splitType",
      "date",
      "notes",
      "receiptAttachmentId",
      "createdAt",
    ],
  },
  {
    delegate: "financeSettlement",
    // Both sides hold a local copy of a settlement, so the correction has to
    // land in both change logs or one of them keeps the stale code.
    entityType: "finance_settlement",
    currencyField: "currency",
    ownerFields: ["fromUserId", "toUserId"],
    payloadFields: [
      "groupId",
      "tripId",
      "fromUserId",
      "toUserId",
      "amountMinor",
      "date",
      "notes",
      "paymentMethod",
      "createdAt",
    ],
  },
  {
    delegate: "financeTrip",
    entityType: "finance_trip",
    currencyField: "baseCurrency",
    ownerFields: ["ownerId"],
    payloadFields: [
      "title",
      "destinations",
      "startDate",
      "endDate",
      "totalBudgetMinor",
      "notes",
      "isArchived",
      "createdAt",
    ],
  },
];

/** `inr` / ` EUR ` -> `INR`. The same rule the services apply on write. */
function normaliseCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * JSON carries a minor-unit amount as a number, the way `groups.service.ts` and
 * the projection's own `Number(payload.amountMinor)` readers already do. A
 * `BigInt` cannot be handed to `JSON.stringify` at all, so the conversion is not
 * a choice — it is the only shape this log can hold.
 */
function jsonable(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

function payloadFor(spec: TableSpec, row: FinanceRow, currency: string) {
  const payload: Record<string, unknown> = {};
  for (const field of spec.payloadFields) {
    payload[field] = jsonable(row[field]);
  }
  payload[spec.currencyField] = currency;
  // The bumped version, so a device applying this change is at the same number
  // the row now carries and a later real edit is not read as stale.
  payload.version = Number(row.version) + 1;
  return payload;
}

/**
 * Whose change log a row's correction belongs in, read off the same fields the
 * schema uses to say who the row is about (`userId`, `ownerId`, `paidByUserId`,
 * and both sides of a settlement).
 */
function rowOwners(spec: TableSpec, row: FinanceRow): string[] {
  return [
    ...new Set(
      spec.ownerFields
        .map((field) => row[field])
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];
}

/** Mirrors `allocateNextChangeCursor` — the counter a live push increments. */
async function appendUpdateChange(
  prisma: PrismaClient,
  userId: string,
  spec: TableSpec,
  entityId: string,
  version: number,
  payload: Record<string, unknown>,
): Promise<bigint> {
  const cursor = await prisma.$transaction(async (tx) => {
    const counter = await tx.syncCursor.upsert({
      where: { userId },
      update: { seq: { increment: BigInt(1) } },
      create: { userId, seq: BigInt(1) },
      select: { seq: true },
    });

    await tx.change.create({
      data: {
        userId,
        deviceId: null,
        entityType: spec.entityType,
        entityId,
        operation: ChangeOperation.UPDATE,
        version,
        payload: payload as any,
        cursor: counter.seq,
      },
    });

    return counter.seq;
  });

  return cursor;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    chunks.push(rows.slice(offset, offset + size));
  }
  return chunks;
}

function usage(): string {
  return [
    "Usage: npx ts-node scripts/backfill-finance-currency.ts [--apply] [--dry-run] [--limit=<n>]",
    "",
    "Upper-cases finance currency codes and appends a versioned UPDATE Change per",
    "touched row, so devices stop holding a lowercase copy.",
    "",
    "  --apply    write the corrected rows and append the changes",
    "  --dry-run  report only (the default; an extra flag changes nothing)",
    "  --limit=n  scan at most n rows per table, for a staged run",
    "  --help     this text",
    "",
    "Not wired into any deploy step, and not typechecked by `tsconfig.json`",
    "(which includes only src/**/*); run it against a backup, not against prod",
    "on a first pass.",
  ].join("\n");
}

function flags(argv: string[]) {
  const apply = argv.includes("--apply");
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

  return {
    apply,
    dryRun: !apply,
    limit: Number.isFinite(limit) && limit! > 0 ? limit : undefined,
  };
}

async function backfillTable(
  prisma: PrismaClient,
  spec: TableSpec,
  options: { dryRun: boolean; limit?: number },
): Promise<{ scanned: number; touched: number }> {
  const delegate = (prisma as any)[spec.delegate];
  if (!delegate) {
    console.warn(`Prisma client has no ${spec.delegate} delegate; skipped.`);
    return { scanned: 0, touched: 0 };
  }

  const rows: FinanceRow[] = await delegate.findMany({
    ...(options.limit ? { take: options.limit } : {}),
    orderBy: { createdAt: "asc" },
  });

  // Only rows whose code differs from its own normalised form. A row already
  // upper-case answers `false` here forever, which is what makes a re-run a
  // no-op rather than a second round of version bumps and changes.
  const stale = rows.filter((row) => {
    const raw = row[spec.currencyField];
    const wanted = normaliseCurrency(raw);
    return wanted !== null && raw !== wanted;
  });

  for (const row of stale) {
    const currency = normaliseCurrency(row[spec.currencyField])!;
    const payload = payloadFor(spec, row, currency);
    const owners = rowOwners(spec, row);

    if (options.dryRun) {
      console.log(
        `  would rewrite ${spec.delegate} ${row.id}: ${JSON.stringify(
          row[spec.currencyField],
        )} -> ${JSON.stringify(
          currency,
        )}, version ${row.version} -> ${row.version + 1}, ` +
          `${owners.length} change log(s) [${owners.join(", ")}]`,
      );
      continue;
    }

    await delegate.update({
      where: { id: row.id },
      data: {
        [spec.currencyField]: currency,
        version: { increment: 1 },
      },
    });

    for (const userId of owners) {
      await appendUpdateChange(
        prisma,
        userId,
        spec,
        row.id,
        Number(row.version) + 1,
        payload,
      );
    }
  }

  return { scanned: rows.length, touched: stale.length };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const options = flags(argv);
  console.log(
    options.dryRun
      ? "Dry run (default): reporting only. Pass --apply to write."
      : "APPLY: rewriting rows and appending Changes.",
  );

  // Built after the `--help` exit so that reading the usage never opens a
  // database connection.
  const prisma = new PrismaClient();

  try {
    let totalTouched = 0;

    for (const spec of TABLES) {
      const result = await backfillTable(prisma, spec, options);
      totalTouched += result.touched;
      console.log(
        `${spec.delegate}: ${result.scanned} row(s) scanned, ${result.touched} stale currency code(s).`,
      );

      if (result.touched > SCAN_BATCH_SIZE) {
        // Purely a heads-up: this script appends one transaction per row, so a
        // table-wide pass on a big account is slow by design.
        console.warn(
          `  ${result.touched} rows is a large batch; a staged run with --limit=n keeps the log appendable.`,
        );
      }
    }

    console.log(
      options.dryRun
        ? `Dry run finished: ${totalTouched} row(s) would change. Nothing was written.`
        : `Backfill complete: ${totalTouched} row(s) rewritten with a matching Change each.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Currency backfill failed:", error);
  process.exitCode = 1;
});
