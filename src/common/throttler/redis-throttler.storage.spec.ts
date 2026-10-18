import { RedisThrottlerStorage } from "./redis-throttler.storage";

interface Entry {
  value: number | string;
  expiresAt: number | null;
}

const WINDOW = 60_000;
const BLOCK = 30_000;
const PREFIXED = "throttler:route-a";

/**
 * A Redis double that keeps state, because what is being checked is arithmetic:
 * what the counter holds after a request, and when it stops holding it.
 *
 * `multi` and `pipeline` differ in one way that matters here, and the double models
 * it — Redis runs a transaction as a unit, while a pipeline is a batch another
 * client's commands can slip between. So a transaction applies its whole queued
 * list without yielding and a pipeline yields between commands.
 */
class FakeRedis {
  readonly entries = new Map<string, Entry>();
  /** One array per round trip, listing the commands it carried in order. */
  readonly transactions: string[][] = [];
  /** Commands sent on their own rather than inside a batch. */
  readonly direct: string[] = [];
  readonly connectionHandlers: Array<(err: Error) => void> = [];

  /** Virtual clock; a window that cannot be advanced cannot be shown to reset. */
  now = 0;
  /** Set to make every command fail, the way an unreachable server does. */
  unreachable: Error | null = null;
  /** Set to make a round trip succeed while the commands inside it fail. */
  failedReply: Error | null = null;

  /** `PEXPIRE` calls that wrote an expiry — the window's start, counted. */
  arms = 0;
  setCalls = 0;

  on(_event: string, handler: (err: Error) => void) {
    this.connectionHandlers.push(handler);
    return this;
  }

  get status() {
    return "ready";
  }

  quit() {
    return Promise.resolve("OK");
  }

  disconnect() {}

  multi() {
    return new FakeChain(this, true);
  }

  pipeline() {
    return new FakeChain(this, false);
  }

  pttl(key: string) {
    return this.send("pttl", () => this.remaining(key));
  }

  get(key: string) {
    return this.send("get", () => {
      const entry = this.live(key);
      return entry ? String(entry.value) : null;
    });
  }

  set(key: string, value: string, _px: "PX", ms: number) {
    return this.send("set", () => {
      this.setCalls += 1;
      this.entries.set(key, { value, expiresAt: this.now + ms });
      return "OK";
    });
  }

  /** The caller sees the expiry the key actually carries, not what was asked for. */
  expiresAt(key: string): number | null {
    return this.live(key)?.expiresAt ?? null;
  }

  hits(key: string): number {
    return Number(this.live(key)?.value ?? 0);
  }

  applyIncr(key: string): number {
    const entry = this.live(key) ?? this.open(key);
    entry.value = Number(entry.value) + 1;
    return entry.value;
  }

  /** `NX` writes only where the key has no expiry, which is the whole point of it. */
  applyPexpire(key: string, ms: number, mode?: "NX"): number {
    const entry = this.live(key);
    if (!entry || (mode === "NX" && entry.expiresAt !== null)) {
      return 0;
    }
    entry.expiresAt = this.now + ms;
    this.arms += 1;
    return 1;
  }

  applyPttl(key: string): number {
    return this.remaining(key);
  }

  applyGet(key: string): string | null {
    const entry = this.live(key);
    return entry ? String(entry.value) : null;
  }

  private open(key: string): Entry {
    const entry: Entry = { value: 0, expiresAt: null };
    this.entries.set(key, entry);
    return entry;
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private remaining(key: string): number {
    const entry = this.live(key);
    if (!entry) {
      return -2;
    }
    return entry.expiresAt === null ? -1 : entry.expiresAt - this.now;
  }

  private send(name: string, run: () => unknown) {
    this.direct.push(name);
    return this.unreachable
      ? Promise.reject(this.unreachable)
      : Promise.resolve(run());
  }
}

class FakeChain {
  private queue: Array<{ name: string; run: () => unknown }> = [];

  constructor(
    private readonly redis: FakeRedis,
    private readonly atomic: boolean,
  ) {}

  incr(key: string) {
    return this.push("incr", () => this.redis.applyIncr(key));
  }

  pexpire(key: string, ms: number, mode?: "NX") {
    return this.push("pexpire", () => this.redis.applyPexpire(key, ms, mode));
  }

  pttl(key: string) {
    return this.push("pttl", () => this.redis.applyPttl(key));
  }

  get(key: string) {
    return this.push("get", () => this.redis.applyGet(key));
  }

  async exec(): Promise<Array<[Error | null, unknown]>> {
    if (this.redis.unreachable) {
      throw this.redis.unreachable;
    }

    const names: string[] = [];
    const results: Array<[Error | null, unknown]> = [];
    for (const command of this.queue) {
      names.push(command.name);
      if (!this.atomic) {
        // The gap a pipeline leaves and Redis fills with someone else's command.
        await Promise.resolve();
      }
      try {
        results.push([null, command.run()]);
      } catch (err) {
        results.push([err as Error, null]);
      }
    }

    this.redis.transactions.push(names);
    if (this.redis.failedReply) {
      // The round trip succeeded and every command in it failed: `EXEC` reports
      // that as pairs, not as a rejection.
      return names.map(() => [this.redis.failedReply as Error, null]);
    }
    return results;
  }

  private push(name: string, run: () => unknown) {
    this.queue.push({ name, run });
    return this;
  }
}

function build() {
  const redis = new FakeRedis();
  const configService = { redisUrl: "redis://127.0.0.1:6379" } as any;
  const storage = new RedisThrottlerStorage(configService, redis as any);
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  (storage as any).logger = logger;
  return { redis, storage, logger };
}

/** The round trip that carried `INCR`, i.e. the one that counted the request. */
function countingTransaction(redis: FakeRedis): string[] {
  const names = redis.transactions.find((entry) => entry.includes("incr"));
  if (!names) {
    throw new Error("nothing was counted");
  }
  return names;
}

describe("RedisThrottlerStorage", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("counting a hit", () => {
    it("writes the count and arms the window in one round trip", async () => {
      const { redis, storage } = build();

      await storage.increment("route-a", WINDOW, 3, 0);

      expect(redis.transactions).toEqual([["incr", "pexpire", "pttl"]]);
      expect(redis.direct).toEqual(["pttl"]);
      expect(redis.expiresAt(PREFIXED)).toBe(WINDOW);
    });

    it("reports the count INCR returned, not one read back after it", async () => {
      const { redis, storage } = build();

      const first = await storage.increment("route-a", WINDOW, 3, 0);
      const second = await storage.increment("route-a", WINDOW, 3, 0);

      expect([first.totalHits, second.totalHits]).toEqual([1, 2]);
      expect(countingTransaction(redis)).not.toContain("get");
    });

    it("collapses two concurrent hits into two counts and one window", async () => {
      const { redis, storage } = build();

      const [a, b] = await Promise.all([
        storage.increment("route-a", WINDOW, 3, 0),
        storage.increment("route-a", WINDOW, 3, 0),
      ]);

      expect([a.totalHits, b.totalHits].sort()).toEqual([1, 2]);
      // One window, opened by the first hit: a re-armed expiry would slide the
      // window forward every time a burst arrived, so a busy client never runs out.
      expect(redis.arms).toBe(1);
      expect(redis.expiresAt(PREFIXED)).toBe(WINDOW);
      expect([a.timeToExpire, b.timeToExpire]).toEqual([60, 60]);
    });

    it("counts each of ten simultaneous requests once", async () => {
      const { redis, storage } = build();

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          storage.increment("route-a", WINDOW, 100, 0),
        ),
      );

      expect(results.map((r) => r.totalHits).sort((x, y) => x - y)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      expect(redis.arms).toBe(1);
    });

    it("leaves an already armed window alone", async () => {
      const { redis, storage } = build();

      await storage.increment("route-a", WINDOW, 3, 0);
      redis.now = 30_000;
      const later = await storage.increment("route-a", WINDOW, 3, 0);

      expect(later.totalHits).toBe(2);
      expect(later.timeToExpire).toBe(30);
      expect(redis.expiresAt(PREFIXED)).toBe(WINDOW);
    });
  });

  describe("windows and tiers", () => {
    it.each([
      [60_000, 60],
      [3_600_000, 3_600],
    ])("arms a %sms tier for exactly its own window", async (ttl, seconds) => {
      const { redis, storage } = build();

      const result = await storage.increment("route-a", ttl, 3, 0);

      expect(redis.expiresAt(PREFIXED)).toBe(ttl);
      expect(result.timeToExpire).toBe(seconds);
    });

    it("keeps two tiers on one route in two independent windows", async () => {
      const { redis, storage } = build();

      await storage.increment("AuthController-login-default-abc", 60_000, 5, 0);
      const hourTier = await storage.increment(
        "AuthController-refresh-default-abc",
        3_600_000,
        3,
        0,
      );

      expect(hourTier.totalHits).toBe(1);
      expect(
        redis.expiresAt("throttler:AuthController-login-default-abc"),
      ).toBe(60_000);
      expect(
        redis.expiresAt("throttler:AuthController-refresh-default-abc"),
      ).toBe(3_600_000);
    });

    it("counts a hit against no other route's budget", async () => {
      const { storage } = build();

      await storage.increment("route-a", WINDOW, 3, 0);
      await storage.increment("route-a", WINDOW, 3, 0);
      const otherRoute = await storage.increment("route-b", WINDOW, 3, 0);

      expect(otherRoute.totalHits).toBe(1);
      expect(otherRoute.isBlocked).toBe(false);
    });
  });

  describe("the limit boundary", () => {
    it("allows the Nth hit, blocks the N+1th, and resets with the window", async () => {
      const { redis, storage } = build();
      const limit = 3;

      for (let hit = 1; hit <= limit; hit++) {
        const result = await storage.increment(
          "route-a",
          WINDOW,
          limit,
          WINDOW,
        );
        expect(result.totalHits).toBe(hit);
        expect(result.isBlocked).toBe(false);
      }

      const blocked = await storage.increment("route-a", WINDOW, limit, WINDOW);
      expect(blocked).toEqual({
        totalHits: 4,
        timeToExpire: 60,
        isBlocked: true,
        timeToBlockExpire: 60,
      });

      redis.now = WINDOW + 1;
      const afterWindow = await storage.increment(
        "route-a",
        WINDOW,
        limit,
        WINDOW,
      );
      expect(afterWindow.totalHits).toBe(1);
      expect(afterWindow.isBlocked).toBe(false);
    });

    it("counts nothing while a block runs and never stretches it", async () => {
      const { redis, storage } = build();

      await storage.increment("route-a", WINDOW, 1, WINDOW);
      await storage.increment("route-a", WINDOW, 1, WINDOW);
      expect(redis.setCalls).toBe(1);
      expect(redis.expiresAt(`${PREFIXED}:block`)).toBe(WINDOW);

      redis.now = 30_000;
      const stillBlocked = await storage.increment(
        "route-a",
        WINDOW,
        1,
        WINDOW,
      );

      expect(stillBlocked).toEqual({
        totalHits: 2,
        timeToExpire: 30,
        isBlocked: true,
        // The wait the client is told about counts down rather than restarting, so
        // a caller flooding a blocked route cannot make its own penalty longer.
        timeToBlockExpire: 30,
      });
      expect(redis.setCalls).toBe(1);
      expect(redis.hits(PREFIXED)).toBe(2);
    });

    it("reports a spent quota when the block outlived its counter", async () => {
      const { redis, storage } = build();

      await storage.increment("route-a", WINDOW, 2, 120_000);
      await storage.increment("route-a", WINDOW, 2, 120_000);
      const over = await storage.increment("route-a", WINDOW, 2, 120_000);
      redis.entries.delete(PREFIXED);

      const result = await storage.increment("route-a", WINDOW, 2, 120_000);

      expect(over.isBlocked).toBe(true);
      expect(result.totalHits).toBe(3);
      expect(result.isBlocked).toBe(true);
      // Nothing left to read a window from, so the tier's own length is reported
      // rather than the `-2` a missing key answers with.
      expect(result.timeToExpire).toBe(60);
    });

    it("never blocks a tier that asked for no block duration", async () => {
      const { storage } = build();

      for (let hit = 0; hit < 5; hit++) {
        const result = await storage.increment("route-a", WINDOW, 2, 0);
        expect(result.isBlocked).toBe(false);
      }
    });
  });

  describe("when Redis is not there", () => {
    it("counts in memory and says so once per interval, not per request", async () => {
      const { redis, storage, logger } = build();
      const now = jest.spyOn(Date, "now");
      redis.unreachable = new Error("connect ECONNREFUSED 127.0.0.1:6379");

      now.mockReturnValue(1_000);
      const results = await Promise.all([
        storage.increment("route-a", WINDOW, 3, 0),
        storage.increment("route-b", WINDOW, 3, 0),
        storage.increment("route-c", WINDOW, 3, 0),
      ]);
      now.mockReturnValue(2_000);
      await storage.increment("route-d", WINDOW, 3, 0);

      expect(results.every((r) => r.isBlocked === false)).toBe(true);
      expect(results[0].totalHits).toBe(1);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][0]).toMatch(
        /degraded to this process only/,
      );
      expect(logger.error.mock.calls[0][0]).toContain("1 request(s)");

      now.mockReturnValue(31_000);
      await storage.increment("route-e", WINDOW, 3, 0);
      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error.mock.calls[1][0]).toContain("5 request(s)");
    });

    it("keeps enforcing the limit in this process while Redis is down", async () => {
      // The point of the fallback: an outage used to mean no login, OTP or
      // vault-unlock limit applied anywhere, which is the window a brute-force
      // run aims for. The ceiling is now per replica instead of unlimited.
      const { redis, storage } = build();
      const now = jest.spyOn(Date, "now");
      redis.unreachable = new Error("connect ECONNREFUSED 127.0.0.1:6379");

      now.mockReturnValue(1_000);
      const first = await storage.increment("route-a", WINDOW, 2, BLOCK);
      const second = await storage.increment("route-a", WINDOW, 2, BLOCK);
      const over = await storage.increment("route-a", WINDOW, 2, BLOCK);
      now.mockReturnValue(20_000);
      const during = await storage.increment("route-a", WINDOW, 2, BLOCK);

      expect([first.totalHits, second.totalHits]).toEqual([1, 2]);
      expect(over.isBlocked).toBe(true);
      expect(over.timeToBlockExpire).toBe(BLOCK / 1000);
      expect(during.isBlocked).toBe(true);
      // Not counted while blocked, and reported as over the limit rather than
      // zeroed — the same rule `readCounter()` follows on the Redis path.
      expect(during.totalHits).toBe(3);
      expect(during.timeToBlockExpire).toBeLessThan(BLOCK / 1000);
    });

    it("treats a command that failed inside the transaction as an outage", async () => {
      const { redis, storage, logger } = build();
      redis.failedReply = new Error(
        "WRONGTYPE Operation against a key holding the wrong kind of value",
      );

      const result = await storage.increment("route-a", WINDOW, 3, 0);

      expect(result.isBlocked).toBe(false);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][0]).toMatch(/WRONGTYPE/);
    });

    it("stops counting permitted requests once Redis answers again", async () => {
      const { redis, storage, logger } = build();
      const now = jest.spyOn(Date, "now").mockReturnValue(1_000);

      redis.unreachable = new Error("connect ECONNREFUSED");
      await storage.increment("route-a", WINDOW, 3, 0);
      await storage.increment("route-a", WINDOW, 3, 0);
      redis.unreachable = null;
      const counted = await storage.increment("route-a", WINDOW, 3, 0);

      now.mockReturnValue(31_000);
      redis.unreachable = new Error("connect ECONNREFUSED");
      await storage.increment("route-a", WINDOW, 3, 0);

      expect(counted.totalHits).toBe(1);
      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error.mock.calls[1][0]).toContain("1 request(s)");
    });

    it("announces a reconnect failure through the same gate, once", () => {
      const { redis, logger } = build();
      jest.spyOn(Date, "now").mockReturnValue(1_000);

      expect(redis.connectionHandlers).toHaveLength(1);
      redis.connectionHandlers[0](
        new Error("READONLY You can't write against a read only replica."),
      );
      redis.connectionHandlers[0](new Error("connect ECONNREFUSED"));

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][0]).toMatch(
        /degraded to this process only/,
      );
      expect(logger.error.mock.calls[0][0]).not.toContain("request(s)");
    });
  });
});
