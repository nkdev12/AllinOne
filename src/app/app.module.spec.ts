import { Test } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import Redis from "ioredis";
import * as Joi from "joi";
import * as crypto from "node:crypto";
import {
  ACCEPTED_NODE_ENV,
  ConfigurationService,
  ENV_GATING_SCHEMA_KEYS,
} from "@/config/configuration.service";
import { RedisThrottlerStorage } from "@/common/throttler/redis-throttler.storage";

/**
 * The throttler's storage is chosen in two places that have to agree: a provider
 * that only exists in a deployed process, and the options object the dynamic
 * `ThrottlerModule` reads it from. Both are asserted here without booting the app,
 * because the failure mode of either one is silent — an absent `storage` key just
 * means the counters went back to being per-worker and per-boot.
 */

/**
 * Importing `app.module.ts` evaluates `ConfigModule.forRoot`, which validates
 * `process.env` against the boot schema — and jest owns `NODE_ENV=test`, so that
 * spelling has to be on the accepted list (`ACCEPTED_NODE_ENV`) for this file and
 * `src/worker.module.spec.ts` to import either boot module at all. Same reason the
 * worker schema cannot leave `NODE_ENV` undeclared: a module import that fails
 * validation rejects the `forRoot` promise, and `compile()` surfaces it as a boot
 * error.
 */
import {
  AppModule,
  ENV_VALIDATION_SCHEMA,
  ThrottlerStorageModule,
} from "./app.module";
import { WORKER_ENV_VALIDATION_SCHEMA } from "@/worker.module";

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

/**
 * The two boot schemas, compared to each other and booted as themselves.
 *
 * `ConfigurationService` decides on values that only exist after a schema has run,
 * and both processes build that schema from the same `ENV_GATING_SCHEMA_KEYS`. That
 * shared set is the fix for the P1 defect — `APP_ENV` carried
 * `.default("development")` in *both* copies, `@nestjs/config` writes schema
 * defaults back into `process.env`, and a deployment that never named an environment
 * got the lenient branch. Two properties have to hold for that to stay fixed, and
 * neither is provable from one schema alone:
 *
 * 1. neither copy may re-declare a gating key with a different shape, because the
 *    worker that answers `development` while the API refuses to boot is the same bug
 *    wearing a different hat;
 * 2. a boot through *either* schema must leave an absent `APP_ENV` absent, so the
 *    strict path — `validateProductionSecrets()` and the `REDIS_URL` requirement —
 *    is reached by omission rather than avoided by one.
 *
 * Both are asserted here against the objects the two `ConfigModule.forRoot` calls
 * actually receive, not a paraphrase of them.
 */
describe("boot schemas and the strict path", () => {
  /**
   * Every key either schema can answer for, plus `REDIS_URL`, which the API schema
   * inherits from the shared set and the sandbox has to own regardless: a key left
   * in `process.env` from this machine's repository `.env` would answer for a fixture
   * that deliberately omits it.
   */
  const MANAGED_KEYS = Array.from(
    new Set([
      ...Object.keys(ENV_VALIDATION_SCHEMA.describe().keys),
      ...Object.keys(WORKER_ENV_VALIDATION_SCHEMA.describe().keys),
      "REDIS_URL",
    ]),
  );

  /** The value `.env.example` ships, which is the pepper on every stored vault. */
  const TEMPLATE_ENCRYPTION_KEY =
    "your-super-secret-encryption-key-min-32-chars-change-prod";

  function generatedSecret(): string {
    return crypto.randomBytes(48).toString("base64");
  }

  /** Strong values for every key both schemas require. */
  const DEPLOYED = {
    DATABASE_URL: "mongodb://localhost:27017/boot_schema_test",
    REDIS_URL: "redis://redis:6379",
    JWT_ACCESS_SECRET: generatedSecret(),
    JWT_REFRESH_SECRET: generatedSecret(),
    OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
    OBJECT_STORAGE_BUCKET: "allinone-attachments",
    OBJECT_STORAGE_ACCESS_KEY: "allinone-attachments-service-account",
    OBJECT_STORAGE_SECRET_KEY: generatedSecret(),
    ENCRYPTION_KEY: generatedSecret(),
  };

  const apiEnv = (
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> => ({
    ...DEPLOYED,
    APP_URL: "https://app.example",
    ...overrides,
  });

  /** The worker requires no `APP_URL`: it serves no HTTP. */
  const workerEnv = (
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> => ({
    ...DEPLOYED,
    ...overrides,
  });

  /**
   * One boot through `schema` against a `process.env` the fixture owns, with every
   * read taken *inside* that window.
   *
   * `ConfigService.get()` falls through to `process.env`, and `process.env` is
   * restored before this returns, so a value read from the test body afterwards
   * would be this machine's `APP_ENV` rather than the boot's — the exact kind of
   * assertion that stays green while a deployment fails.
   */
  async function bootThrough(
    schema: Joi.ObjectSchema,
    env: Record<string, string | undefined>,
  ) {
    const saved = { ...process.env };
    MANAGED_KEYS.forEach((key) => delete process.env[key]);
    try {
      Object.entries(env).forEach(([key, value]) => {
        if (value !== undefined) process.env[key] = value;
      });

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: false,
            ignoreEnvFile: true,
            validationSchema: schema,
            validationOptions: { allowUnknown: true, abortEarly: true },
          }),
        ],
      }).compile();

      try {
        const configService = moduleRef.get(ConfigService);
        let service: ConfigurationService | undefined;
        let error: Error | undefined;
        try {
          service = new ConfigurationService(configService);
        } catch (cause) {
          error = cause as Error;
        }

        return {
          error,
          resolved: {
            APP_ENV: configService.get<string>("APP_ENV"),
            NODE_ENV: configService.get<string>("NODE_ENV"),
          },
          processEnv: {
            APP_ENV: process.env.APP_ENV,
            NODE_ENV: process.env.NODE_ENV,
          },
          isDevelopment: service?.isDevelopment,
          usesRedisThrottlerStorage: service?.usesRedisThrottlerStorage,
        };
      } finally {
        await moduleRef.close();
      }
    } finally {
      MANAGED_KEYS.forEach((key) => {
        if (key in saved) {
          process.env[key] = saved[key];
        } else {
          delete process.env[key];
        }
      });
    }
  }

  const BOTH: Array<[string, Joi.ObjectSchema, typeof apiEnv]> = [
    ["the API", ENV_VALIDATION_SCHEMA, apiEnv],
    ["the worker", WORKER_ENV_VALIDATION_SCHEMA, workerEnv],
  ];

  describe.each(BOTH)("%s schema", (_name, schema, fixture) => {
    it("leaves an undeclared APP_ENV undeclared", async () => {
      const { resolved, processEnv, isDevelopment, error } = await bootThrough(
        schema,
        fixture(),
      );

      expect(error).toBeUndefined();
      expect(resolved.APP_ENV).toBeUndefined();
      expect(processEnv.APP_ENV).toBeUndefined();
      expect(isDevelopment).toBe(false);
    });

    it("runs the secret gate for a boot that named no APP_ENV", async () => {
      const { error } = await bootThrough(
        schema,
        fixture({ ENCRYPTION_KEY: TEMPLATE_ENCRYPTION_KEY }),
      );

      expect(error?.message).toMatch(/ENCRYPTION_KEY/);
    });

    it("requires a declared Redis for a boot that named no APP_ENV", async () => {
      const { error, usesRedisThrottlerStorage } = await bootThrough(
        schema,
        fixture({ REDIS_URL: undefined }),
      );

      expect(error?.message).toMatch(
        /REDIS_URL is required outside development/,
      );
      expect(usesRedisThrottlerStorage).toBeUndefined();
    });

    it("still honours a written APP_ENV=development", async () => {
      // The opt-in has to stay reachable, or the fresh-clone workflow the docs
      // promise is what breaks next.
      const { error, isDevelopment, processEnv } = await bootThrough(
        schema,
        fixture({
          APP_ENV: "development",
          ENCRYPTION_KEY: TEMPLATE_ENCRYPTION_KEY,
          JWT_ACCESS_SECRET: TEMPLATE_ENCRYPTION_KEY,
          JWT_REFRESH_SECRET: generatedSecret(),
          REDIS_URL: undefined,
        }),
      );

      expect(processEnv.APP_ENV).toBe("development");
      expect(isDevelopment).toBe(true);
      expect(error).toBeUndefined();
    });

    it("does not let the NODE_ENV default overwrite a declared one", async () => {
      // The sibling variable, measured through this schema rather than reasoned
      // about: jest's `test` (and a container's `production`) survives a schema that
      // carries a default, because Joi defaults only an `undefined` input and
      // `assignVariablesToProcess` only writes keys `process.env` does not already
      // have. If this ever inverts, every spec that compiles a boot module breaks —
      // and, worse, a real production container silently loses its gate.
      const { resolved, processEnv, error, usesRedisThrottlerStorage } =
        await bootThrough(
          schema,
          fixture({
            NODE_ENV: "test",
            APP_ENV: "production",
            ENCRYPTION_KEY: TEMPLATE_ENCRYPTION_KEY,
          }),
        );

      expect(resolved.NODE_ENV).toBe("test");
      expect(processEnv.NODE_ENV).toBe("test");
      // The hatch is what keeps this boot clean, which is the behaviour the suites
      // rely on and the reason `test` stays on `ACCEPTED_NODE_ENV`.
      expect(error).toBeUndefined();
      // `isTestEnvironment` read through a decision it drives rather than through
      // the private getter: it compares `process.env.NODE_ENV`, so the default
      // could not have reached it even if Joi had overwritten the validated config.
      expect(usesRedisThrottlerStorage).toBe(false);
    });
  });

  describe.each(BOTH)(
    "%s schema declares the shared keys unchanged",
    (_name, schema) => {
      const described = schema.describe().keys;

      it("answers every gating key with the shared definition", () => {
        for (const [key, definition] of Object.entries(
          ENV_GATING_SCHEMA_KEYS,
        )) {
          // `toEqual` on the Joi description: a local re-declaration in either module
          // — a `.default()` put back, a `.valid()` list trimmed, a `.required()`
          // dropped — differs from the shared shape here even though the module still
          // compiles.
          expect({ key, schema: described[key] }).toEqual({
            key,
            schema: definition.describe(),
          });
        }
      });

      it("carries no default on any key that selects a hardened path", () => {
        // `NODE_ENV` is the one exception and the reason this is a list rather than a
        // blanket rule: its default is `development`, which grants nothing the gate
        // reads, and removing it would make `test` a refused boot for both suites.
        for (const key of Object.keys(ENV_GATING_SCHEMA_KEYS)) {
          if (key === "NODE_ENV") continue;
          expect(described[key].flags?.default).toBeUndefined();
        }
      });

      it("keeps APP_ENV a closed list with no fallback", () => {
        expect(described.APP_ENV.flags?.default).toBeUndefined();
        expect(described.APP_ENV.allow).toEqual([
          "development",
          "staging",
          "production",
        ]);
      });

      it("keeps NODE_ENV on the one accepted list, both processes sharing it", () => {
        expect(described.NODE_ENV.allow).toEqual(ACCEPTED_NODE_ENV);
        expect(described.NODE_ENV.flags?.default).toBe("development");
      });
    },
  );
});
