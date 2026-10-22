import { BadRequestException } from "@nestjs/common";
import { FinanceTransactionKind, Prisma } from "@prisma/client";

/**
 * The `where` fragment that keeps a balance correction out of an income or
 * spending total.
 *
 * Spread it into every money read that adds cash flow up, and only ever as it is
 * written here — a *negative* clause. The MongoDB connector does not match an
 * absent key with an equality filter, so `{ transactionKind: "NORMAL" }` silently
 * drops every document written before the column existed and moves every user's
 * historical figures. `{ NOT: { transactionKind: "BALANCE_ADJUSTMENT" } }` is the
 * `$not` form, which a missing key satisfies, so a legacy row keeps counting as
 * the ordinary income or expense it always was. (`deletedAt: null` needs no such
 * care: Mongo null-matches an absent key.)
 *
 * An adjustment still moves the account balance — `type` is the money direction
 * and is untouched — so this clause belongs on cash-flow aggregation only, never
 * on a ledger listing or a balance write.
 */
export const EXCLUDE_BALANCE_ADJUSTMENTS = {
  NOT: { transactionKind: FinanceTransactionKind.BALANCE_ADJUSTMENT },
} as const satisfies Prisma.FinanceTransactionWhereInput;

export const EXCLUDE_NON_CASH_FLOW = {
  NOT: [
    { transactionKind: FinanceTransactionKind.BALANCE_ADJUSTMENT },
    { loanId: { not: null } },
  ],
} as const satisfies Prisma.FinanceTransactionWhereInput;

/**
 * `BigInt()` on a non-integer throws a `RangeError` and on `Infinity`/`NaN` blows
 * up the whole request as a 500, so every conversion is fenced by the safe
 * integer check first and reported as a 400 (same guard the transaction service
 * uses).
 *
 * `AccountsService.toMinorUnits` is a deliberately different helper — it accepts
 * `undefined`/`null` as zero and carries its own message — and stays where it is.
 */
/**
 * Normalise currency string to standard 3-letter upper case code (defaults to 'INR').
 */
export function normaliseCurrency(currency?: string | null): string {
  return (currency ?? "INR").trim().toUpperCase();
}

/**
 * The currency a stored money row is measured in: `normaliseCurrency`, with the
 * blank code folded into the same `INR` default as `null` and `undefined`.
 *
 * `normaliseCurrency` is `??`-based, so a row whose code arrived as `""` (or only
 * spaces) comes back as `""` — and an empty code matches no expense row, no
 * currency filter and no client view, which reads as money that measures nothing.
 * A `""` is reachable without a schema change: the push validator only asks
 * whether `currency` is a string (`change-payload.validator.ts`,
 * `FINANCE_BUDGET_FIELDS`), so a device can put one on the log.
 *
 * Use this wherever a stored code decides what gets summed (and on the budget
 * write, so a budget row cannot land blank). The other money writers keep calling
 * `normaliseCurrency`, which is also what `change-projection.ts` calls, so the
 * stored shape of an account, transaction, group or trip currency is unchanged.
 */
export function resolveCurrency(value?: string | null): string {
  const code = normaliseCurrency(value);
  return code.length === 0 ? "INR" : code;
}

/**
 * Normalise currency string to standard upper case code, returning undefined if empty or not provided.
 */
export function normaliseCurrencyCode(
  value?: string | null,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.toUpperCase();
}

export function toMinorUnits(value: number, field: string): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new BadRequestException(`${field} must be a safe integer.`);
  }
  return BigInt(value);
}

export function toDateOrThrow(
  value: string | number | Date,
  field: string,
): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} must be a valid ISO-8601 date.`);
  }
  return parsed;
}

/**
 * Resolve what a `$inc`/`$set`-style write actually left in the row.
 *
 * Prisma applies `{ increment: n }` / `{ decrement: n }` server-side and returns
 * the post-update document, so `posted` normally *is* the stored BigInt and
 * already contains a write that raced in between our read and our commit — which
 * is the whole reason the delta is written as an operator. A delegate that
 * echoes the operator object back instead of resolving it (the naive update mock
 * in the shared service harness; the account mock there does resolve) falls back
 * to read + delta. Falling back is deliberate: `Number(posted)` on an object is
 * NaN, and a NaN amount in the emitted payload is a NaN every device replays.
 */
export function minorUnitsAfter(
  posted: unknown,
  before: bigint,
  delta: bigint,
): bigint {
  if (typeof posted === "bigint") return posted;
  if (typeof posted === "number" && Number.isSafeInteger(posted)) {
    return BigInt(posted);
  }
  return before + delta;
}
