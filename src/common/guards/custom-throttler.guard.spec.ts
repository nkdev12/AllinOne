import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Throttle, ThrottlerException } from "@nestjs/throttler";
import { CustomThrottlerGuard } from "./custom-throttler.guard";

const MANAGED = [
  "APP_ENV",
  "NODE_ENV",
  "RATE_LIMIT_ENABLED",
  "DISABLE_RATE_LIMITING",
  "RATE_LIMIT_HEADER_BYPASS",
] as const;

/** One counted request as the storage saw it, plus the record it answered with. */
interface Counted {
  key: string;
  ttl: number;
  limit: number;
  blockDuration: number;
  totalHits: number;
}

/**
 * Fixtures rather than literals: the bucket is derived from the controller name,
 * the handler name, the throttler name and the tracker, so only a real decorated
 * method tests any of them. The tiers are the ones `src/auth/auth.controller.ts`
 * configures, and `NotesController` has none so the module default stays visible.
 */
class AuthController {
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  login() {}

  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  refresh() {}
}

class VaultSettingsController {
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  login() {}
}

class NotesController {
  list() {}
}

function httpContext(
  controller: { prototype: Record<string, any> },
  handler: string,
  req: Record<string, any>,
) {
  const res = { header: jest.fn() };
  return {
    res,
    context: {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getClass: () => controller,
      getHandler: () => controller.prototype[handler],
    } as unknown as ExecutionContext,
  };
}

/** Only the headers matter to `shouldSkip`, which is why it gets no controller. */
function skipContext(headers: Record<string, string> = {}) {
  return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as any;
}

/** An unauthenticated request for the address `trust proxy` resolved. */
function client(overrides: Record<string, unknown> = {}) {
  return { ip: "203.0.113.7", headers: {}, ...overrides };
}

function countingStorage() {
  const seen: Counted[] = [];
  return {
    seen,
    keys: () => new Set(seen.map((entry) => entry.key)),
    increment: jest.fn(
      async (
        key: string,
        ttl: number,
        limit: number,
        blockDuration: number,
      ) => {
        const totalHits = seen.filter((entry) => entry.key === key).length + 1;
        seen.push({ key, ttl, limit, blockDuration, totalHits });
        return {
          totalHits,
          timeToExpire: Math.ceil(ttl / 1000),
          isBlocked: false,
          timeToBlockExpire: 0,
        };
      },
    ),
  };
}

function scriptedStorage(record: {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}) {
  return { increment: jest.fn(async () => record) };
}

async function activeGuard(
  throttlers: Array<Record<string, unknown>>,
  storage: unknown,
) {
  // A fresh array per guard: `onModuleInit` sorts the options it is handed.
  const guard = new CustomThrottlerGuard(
    { throttlers } as any,
    storage as any,
    new Reflector(),
  );
  await guard.onModuleInit();
  return guard;
}

describe("CustomThrottlerGuard", () => {
  const guard = new CustomThrottlerGuard(
    { throttlers: [] },
    { increment: jest.fn(), get: jest.fn() } as any,
    new Reflector(),
  );
  const shouldSkip = (ctx: any) =>
    (guard as any).shouldSkip(ctx) as Promise<boolean>;
  const getTracker = (req: any) =>
    (guard as any).getTracker(req) as Promise<string>;

  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of MANAGED) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MANAGED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe("shouldSkip", () => {
    it("throttles in production", async () => {
      process.env.APP_ENV = "production";
      await expect(shouldSkip(skipContext())).resolves.toBe(false);
    });

    it("keeps development protected and stands down under test", async () => {
      process.env.APP_ENV = "development";
      await expect(shouldSkip(skipContext())).resolves.toBe(false);

      process.env.APP_ENV = "production";
      process.env.NODE_ENV = "test";
      await expect(shouldSkip(skipContext())).resolves.toBe(true);
    });

    it("stands down for either of the explicit kill switches", async () => {
      process.env.APP_ENV = "production";
      process.env.DISABLE_RATE_LIMITING = "true";
      await expect(shouldSkip(skipContext())).resolves.toBe(true);

      process.env.DISABLE_RATE_LIMITING = undefined;
      process.env.RATE_LIMIT_ENABLED = "false";
      await expect(shouldSkip(skipContext())).resolves.toBe(true);
    });

    it("keeps the limiter active when explicitly enabled", async () => {
      process.env.APP_ENV = "development";
      process.env.RATE_LIMIT_ENABLED = "true";
      await expect(shouldSkip(skipContext())).resolves.toBe(false);
    });

    it("cannot be switched off by the client", async () => {
      process.env.APP_ENV = "production";
      await expect(
        shouldSkip(skipContext({ "x-skip-throttle": "true" })),
      ).resolves.toBe(false);
      await expect(
        shouldSkip(skipContext({ "x-bypass-rate-limit": "true" })),
      ).resolves.toBe(false);
    });

    it("honours the header bypass only where an operator opened it", async () => {
      process.env.APP_ENV = "development";
      process.env.RATE_LIMIT_ENABLED = "false";
      process.env.RATE_LIMIT_HEADER_BYPASS = "true";
      await expect(
        shouldSkip(skipContext({ "x-skip-throttle": "true" })),
      ).resolves.toBe(true);
      await expect(shouldSkip(skipContext())).resolves.toBe(false);
    });

    it("refuses the bypass in production even with the flag set", async () => {
      process.env.APP_ENV = "production";
      process.env.RATE_LIMIT_HEADER_BYPASS = "true";
      await expect(
        shouldSkip(skipContext({ "x-skip-throttle": "true" })),
      ).resolves.toBe(false);
    });
  });

  describe("getTracker", () => {
    it("counts an authenticated caller per user, not per socket", async () => {
      expect(await getTracker({ headers: {}, user: { id: "user-1" } })).toBe(
        "user:user-1",
      );
    });

    it("ignores spoofed forwarding headers and uses the resolved address", async () => {
      expect(
        await getTracker({
          headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
          ip: "10.0.0.1",
        }),
      ).toBe("ip:10.0.0.1");
    });

    it("reads the resolved address without opening the headers at all", async () => {
      // No `headers` key to read: a tracker that consulted one would throw here.
      expect(await getTracker({ ip: "10.0.0.1" })).toBe("ip:10.0.0.1");
    });

    it("masks IPv6 to one bucket per subnet rather than per address", async () => {
      // A client owns a whole /64, so an unmasked address out of it is a fresh
      // allowance and the limit only looks enforced.
      expect(
        await getTracker({ headers: {}, ip: "2001:db8:1234:5678::1" }),
      ).toBe("ip:2001:db8:1234:5678::/64");
      expect(
        await getTracker({ headers: {}, ip: "2001:db8:1234:5678::abcd" }),
      ).toBe("ip:2001:db8:1234:5678::/64");
      expect(
        await getTracker({ headers: {}, ip: "2001:db8:1234:5679::1" }),
      ).toBe("ip:2001:db8:1234:5679::/64");
    });

    it("masks the peer address it falls back to as well", async () => {
      expect(
        await getTracker({
          headers: {},
          socket: { remoteAddress: "10.0.0.9" },
        }),
      ).toBe("ip:10.0.0.9");
      expect(
        await getTracker({
          headers: {},
          socket: { remoteAddress: "2001:db8:1234:5678::1" },
        }),
      ).toBe("ip:2001:db8:1234:5678::/64");
    });
  });

  describe("bucket keys", () => {
    it("keeps one route's hits out of another route's budget", async () => {
      const storage = countingStorage();
      const throttled = await activeGuard(
        [{ ttl: 60_000, limit: 100 }],
        storage,
      );
      const login = httpContext(AuthController, "login", client());
      const refresh = httpContext(AuthController, "refresh", client());

      await throttled.canActivate(login.context);
      await throttled.canActivate(login.context);
      await throttled.canActivate(refresh.context);

      const [first, second, third] = storage.seen;
      expect([first.ttl, second.ttl]).toEqual([60_000, 60_000]);
      // The route's own `@Throttle` tier, not the module default, is what reaches
      // storage — and its window is the ttl in ms, not in seconds.
      expect([first.limit, second.limit]).toEqual([5, 5]);
      expect(first.key).toBe(second.key);

      expect(third.key).not.toBe(first.key);
      expect(third.ttl).toBe(3_600_000);
      expect(third.limit).toBe(3);
      // Two requests spent the login budget; the hour tier on the same client and
      // the same socket still starts at one.
      expect(third.totalHits).toBe(1);
    });

    it("separates handlers that share a name across controllers", async () => {
      const storage = countingStorage();
      const throttled = await activeGuard([{ ttl: 60_000, limit: 5 }], storage);

      await throttled.canActivate(
        httpContext(AuthController, "login", client()).context,
      );
      await throttled.canActivate(
        httpContext(VaultSettingsController, "login", client()).context,
      );

      expect(storage.keys().size).toBe(2);
    });

    it("separates named tiers so two windows cannot spend one counter", async () => {
      const storage = countingStorage();
      const defaults = await activeGuard([{ ttl: 60_000, limit: 5 }], storage);
      const bursty = await activeGuard(
        [{ name: "burst", ttl: 1_000, limit: 2 }],
        storage,
      );

      await defaults.canActivate(
        httpContext(NotesController, "list", client()).context,
      );
      await bursty.canActivate(
        httpContext(NotesController, "list", client()).context,
      );

      expect(storage.keys().size).toBe(2);
      expect(storage.seen[1].limit).toBe(2);
      expect(storage.seen[1].ttl).toBe(1_000);
    });

    it("pays the whole window when a route sets no block duration", async () => {
      const storage = countingStorage();
      const throttled = await activeGuard([{ ttl: 60_000, limit: 3 }], storage);

      await throttled.canActivate(
        httpContext(NotesController, "list", client()).context,
      );

      // `Retry-After` counts down from this value, so a block duration that fell to
      // zero would tell a blocked client to come straight back.
      expect(storage.seen[0].blockDuration).toBe(60_000);
    });

    it("cannot be re-minted by rotating X-Forwarded-For", async () => {
      const storage = countingStorage();
      const throttled = await activeGuard([{ ttl: 60_000, limit: 5 }], storage);
      const hit = (headers: Record<string, string>, ip: string) =>
        throttled.canActivate(
          httpContext(AuthController, "login", { ip, headers }).context,
        );

      await hit({ "x-forwarded-for": "1.2.3.4" }, "10.0.0.5");
      await hit({ "x-forwarded-for": "5.6.7.8, 9.9.9.9" }, "10.0.0.5");
      expect(storage.keys().size).toBe(1);

      // What moves the bucket is the address Express resolved from the trusted hop.
      await hit({ "x-forwarded-for": "1.2.3.4" }, "10.0.0.6");
      expect(storage.keys().size).toBe(2);
    });

    it("gives one IPv6 client one bucket however many addresses it uses", async () => {
      const storage = countingStorage();
      const throttled = await activeGuard([{ ttl: 60_000, limit: 5 }], storage);
      const hit = (ip: string) =>
        throttled.canActivate(
          httpContext(AuthController, "login", client({ ip })).context,
        );

      await hit("2001:db8:1234:5678::1");
      await hit("2001:db8:1234:5678::abcd");
      expect(storage.keys().size).toBe(1);

      await hit("2001:db8:1234:5679::1");
      expect(storage.keys().size).toBe(2);
    });

    it("separates two users on one socket, and both from the socket itself", async () => {
      const storage = countingStorage();
      const throttled = await activeGuard([{ ttl: 60_000, limit: 5 }], storage);
      const route = httpContext(AuthController, "login", client());

      await throttled.canActivate(
        httpContext(AuthController, "login", client({ user: { id: "u-1" } }))
          .context,
      );
      await throttled.canActivate(
        httpContext(AuthController, "login", client({ user: { id: "u-2" } }))
          .context,
      );
      await throttled.canActivate(route.context);

      // One office NAT divides one account's login budget, and must not divide two
      // accounts' by the same amount twice over.
      expect(storage.keys().size).toBe(3);
    });
  });

  describe("what a blocked client is told", () => {
    const throttlers = [{ ttl: 60_000, limit: 3 }];

    it("reports the wait that is left rather than the window that was", async () => {
      const storage = scriptedStorage({
        totalHits: 4,
        timeToExpire: 12,
        isBlocked: true,
        timeToBlockExpire: 45,
      });
      const throttled = await activeGuard(throttlers, storage);
      const { context, res } = httpContext(NotesController, "list", client());

      const error = await throttled.canActivate(context).catch((err) => err);

      expect(error).toBeInstanceOf(ThrottlerException);
      expect((error as ThrottlerException).getStatus()).toBe(429);
      // `timeToExpire` is the 12s still on the counter and `timeToBlockExpire` the
      // 45s still on the block: a header built from the 60s window would have the
      // client sit out a wait that had already largely run.
      expect(res.header).toHaveBeenCalledWith("Retry-After", 45);
      expect(res.header).not.toHaveBeenCalledWith("Retry-After", 60);
    });

    it("sends the remaining window in X-RateLimit-Reset", async () => {
      const storage = scriptedStorage({
        totalHits: 3,
        timeToExpire: 12,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
      const throttled = await activeGuard(throttlers, storage);
      const { context, res } = httpContext(NotesController, "list", client());

      await expect(throttled.canActivate(context)).resolves.toBe(true);

      expect(res.header).toHaveBeenCalledWith("X-RateLimit-Limit", 3);
      expect(res.header).toHaveBeenCalledWith("X-RateLimit-Remaining", 0);
      expect(res.header).toHaveBeenCalledWith("X-RateLimit-Reset", 12);
      expect(res.header).not.toHaveBeenCalledWith("X-RateLimit-Reset", 60);
      expect(res.header).not.toHaveBeenCalledWith(
        "Retry-After",
        expect.anything(),
      );
    });

    it("keeps the body one message string, as docs/API_REFERENCE.md describes", async () => {
      const throttled = await activeGuard(
        throttlers,
        scriptedStorage({
          totalHits: 4,
          timeToExpire: 1,
          isBlocked: true,
          timeToBlockExpire: 1,
        }),
      );

      const error = (await throttled
        .canActivate(httpContext(NotesController, "list", client()).context)
        .catch((err) => err)) as ThrottlerException;

      expect((error as any).getStatus()).toBe(429);
      const body = error.getResponse();
      const message = typeof body === "string" ? body : (body as any).message;
      expect(typeof message).toBe("string");
      expect(Array.isArray(message)).toBe(false);
    });
  });
});
