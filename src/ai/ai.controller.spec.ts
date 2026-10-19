import { AiController } from "./ai.controller";

/**
 * The three AI routes inherit the app's global tier — `rateLimitMaxRequests` per
 * minute, 100 as shipped (`src/app/app.module.ts`) — and that tier was sized for
 * ordinary reads. These are not ordinary reads: each one spends a paid call to a
 * shared `GEMINI_API_KEY` on behalf of one account, and `convert-tasks` spends it
 * *and* writes rows. A route with no tier of its own is a route where one account
 * can burn the whole key.
 *
 * `@Throttle` is metadata, so the guard it feeds is not what this pins — the guard
 * is `AppModule`'s business and already covered there. What could silently regress
 * is the decorator itself: a handler that loses it keeps booting, keeps passing
 * every other test in this file, and goes back to 100 a minute against the shared
 * key.
 */
describe("AiController rate tiers", () => {
  const GLOBAL_LIMIT_PER_MINUTE = 100;
  const MINUTE_MS = 60_000;

  /**
   * A controller handler, passed around and never called. Spelled as a shape rather
   * than as `Function`, which the linter bans for being indistinguishable from
   * `any`.
   */
  type Handler = (this: unknown, ...args: never[]) => unknown;

  /** The keys `@nestjs/throttler`'s `@Throttle()` writes for the `default` tier. */
  const limitOf = (handler: Handler) =>
    Reflect.getMetadata("THROTTLER:LIMITdefault", handler);
  const ttlOf = (handler: Handler) =>
    Reflect.getMetadata("THROTTLER:TTLdefault", handler);
  const skipped = (handler: Handler) =>
    Reflect.getMetadata("THROTTLER:SKIPdefault", handler);

  const handler = (name: keyof typeof AiController.prototype) =>
    (AiController.prototype as any)[name];

  const routes = [
    "extractTasks",
    "suggestTags",
    "convertTasksForNote",
  ] as const;

  for (const name of routes) {
    it(`throttles ${name} instead of leaving it on the global tier`, () => {
      const fn = handler(name);

      expect(skipped(fn)).not.toBe(true);
      // Declared, per-minute, and tighter than the global allowance.
      expect(limitOf(fn)).toBeGreaterThan(0);
      expect(ttlOf(fn)).toBe(MINUTE_MS);
      expect(limitOf(fn)).toBeLessThan(GLOBAL_LIMIT_PER_MINUTE);
    });
  }

  it("throttles the route that writes the tightest", () => {
    // The two readers cost a model call; `convert-tasks` costs a model call, a
    // `Task` row and a `Change` row per item, replayed to every device of the
    // account for the life of the log.
    expect(limitOf(handler("convertTasksForNote"))).toBeLessThan(
      limitOf(handler("extractTasks")),
    );
    expect(limitOf(handler("convertTasksForNote"))).toBeLessThan(
      limitOf(handler("suggestTags")),
    );
  });
});
