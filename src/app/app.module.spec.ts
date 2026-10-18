import { Test } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import Redis from "ioredis";
import { ConfigurationService } from "@/config/configuration.service";
import { RedisThrottlerStorage } from "@/common/throttler/redis-throttler.storage";

/**
 * The throttler's storage is chosen in two places that have to agree: a provider
 * that only exists in a deployed process, and the options object the dynamic
 * `ThrottlerModule` reads it from. Both are asserted here without booting the app,
 * because the failure mode of either one is silent — an absent `storage` key just
 * means the counters went back to being per-worker and per-boot.
 */

// `app.module.ts` evaluates `ConfigModule.forRoot` as a decorator, which validates
// `process.env` against a schema whose `NODE_ENV` admits only development and
// production — and jest owns the value `test`. So the module is required with the
// value rewritten, and put back afterwards: the write is global to this worker, and
// a suite that runs after this one would otherwise inherit a development `NODE_ENV`
// and start throttling requests it expects to skip.
//
// That same refusal is the proof that a real container cannot reach `NODE_ENV=test`,
// which is why the in-memory-storage escape hatch is safe to hang on it.
const savedNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "development";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule, ThrottlerStorageModule } = require("./app.module");

afterAll(() => {
  process.env.NODE_ENV = savedNodeEnv;
});

/** A `ConfigurationService` double carrying only what the storage choice reads. */
function configDouble(overrides: Record<string, unknown> = {}) {
  return {
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 100,
    redisUrl: "redis://127.0.0.1:1",
    usesRedisThrottlerStorage: true,
    ...overrides,
  } as unknown as ConfigurationService;
}

/** The options object `ThrottlerModule.forRootAsync` builds, pulled off AppModule. */
function throttlerOptionsFactory() {
  const imports = Reflect.getMetadata("imports", AppModule) as Array<{
    module?: unknown;
    providers?: Array<{
      provide: unknown;
      inject?: unknown[];
      useFactory?: (...args: any[]) => any;
    }>;
  }>;
  const dynamic = imports.find((entry) => entry?.module === ThrottlerModule);
  const provider = dynamic?.providers?.find(
    // The options provider is the one that injects the storage; the library's own
    // `ThrottlerStorageProvider` injects only the options token.
    (entry) => entry.inject?.includes(RedisThrottlerStorage),
  );
  if (!provider?.useFactory) {
    throw new Error(
      "ThrottlerModule.forRootAsync no longer builds its own options",
    );
  }
  return provider.useFactory;
}

describe("ThrottlerModule storage wiring", () => {
  it("passes the Redis storage to the throttler when the environment wants it", () => {
    const storage = new RedisThrottlerStorage(configDouble());
    const options = throttlerOptionsFactory()(configDouble(), storage);

    expect(options.storage).toBe(storage);
    expect(options.throttlers).toEqual([{ ttl: 60000, limit: 100 }]);
  });

  it("leaves the in-memory default alone when there is no storage", () => {
    // `ThrottlerStorageProvider` inside the library falls back to its own
    // `ThrottlerStorageService` only when `storage` is absent, so the key has to
    // be missing rather than set to `undefined`.
    const options = throttlerOptionsFactory()(configDouble(), undefined);

    expect("storage" in options).toBe(false);
  });

  it("does not build a client for a test run", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerStorageModule],
    })
      .overrideProvider(ConfigurationService)
      .useValue(configDouble({ usesRedisThrottlerStorage: false }))
      .compile();

    expect(moduleRef.get(RedisThrottlerStorage)).toBeUndefined();
    await moduleRef.close();
  });

  it("builds one for a deployed process without opening a socket", async () => {
    // Port 1 is closed on purpose. `lazyConnect` must keep the client idle until a
    // request actually needs a counter, and shutdown must not `quit()` its way into
    // a connection to say goodbye — otherwise a container that never served a
    // throttled route still pays for a Redis dial, and a pod that comes up, fails
    // its own config gate and shuts down again leaves a reconnect loop behind.
    const connect = jest
      .spyOn(Redis.prototype, "connect")
      .mockImplementation(() => Promise.resolve());

    try {
      const moduleRef = await Test.createTestingModule({
        imports: [ThrottlerStorageModule],
      })
        .overrideProvider(ConfigurationService)
        .useValue(configDouble({ usesRedisThrottlerStorage: true }))
        .compile();

      const storage = moduleRef.get(RedisThrottlerStorage);
      expect(storage).toBeInstanceOf(RedisThrottlerStorage);

      await moduleRef.close();

      // That the status moved at all is the point: the shutdown hook ran, which is
      // why the storage is a provider of a module rather than an object built
      // inside the throttler's options factory. And it ran `disconnect()` on an idle
      // client instead of dialing one.
      expect(connect).not.toHaveBeenCalled();
      expect(["end", "close"]).toContain(
        (storage as unknown as { redis: { status: string } }).redis.status,
      );
    } finally {
      connect.mockRestore();
    }
  });
});
