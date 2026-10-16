/**
 * Escaping for every user-supplied string that reaches a Prisma Mongo filter.
 *
 * `contains`/`startsWith` on the MongoDB connector are not substring matches:
 * the value is interpolated verbatim into `$regex` (verified against prisma
 * 5.22 by logging the emitted command — `contains: "a.b(c+)+$"` becomes
 * `regex: ".*a.b(c+)+$.*"`). Unescaped user text therefore either matches rows
 * it should not (`a.b` also hits `axb`) or hands Mongo a backtracking bomb such
 * as `(a+)+$`, which is a one-request denial of service. Escaping first
 * restores literal substring semantics.
 *
 * Lives here rather than beside any one service because notes, tasks, calendar,
 * finance and users all search, and a helper that has to be remembered
 * per-module is a helper that gets missed in the next one.
 */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
