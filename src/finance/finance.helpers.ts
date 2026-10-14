import { BadRequestException } from "@nestjs/common";

/**
 * `BigInt()` on a non-integer throws a `RangeError` and on `Infinity`/`NaN` blows
 * up the whole request as a 500, so every conversion is fenced by the safe
 * integer check first and reported as a 400 (same guard the transaction service
 * uses).
 *
 * `AccountsService.toMinorUnits` is a deliberately different helper — it accepts
 * `undefined`/`null` as zero and carries its own message — and stays where it is.
 */
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
