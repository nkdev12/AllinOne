import {
  ConfigurationService,
  SECRET_MIN_ENTROPY_BITS,
  SECRET_MIN_LENGTH,
  SHIPPED_TEMPLATE_SECRETS,
  TEMPLATE_SENTINEL_PREFIX,
  TEMPLATE_SENTINEL_SUFFIX,
  estimateSecretEntropyBits,
  isShippedTemplateSecret,
  parseTokenLifetime,
  secretDefect,
  secretFingerprint,
} from "./configuration.service";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";

/** The variable named in a rejection, which is the operator's only clue. */
const VAR = "JWT_ACCESS_EXPIRATION";

/**
 * The one reading of a token lifetime that every consumer now shares: the
 * `exp` stamped into the token, the `expiresIn` a client counts down, the
 * `Session.accessExpiresAt` row and the refresh cookie's `maxAge` are all this
 * number. Before it existed they were four literals, and `JWT_*_EXPIRATION` was
 * a setting that changed none of them.
 *
 * What matters here is not only that the accepted forms come out right, but
 * that nothing else does: a unit this function invents would be a lifetime the
 * session row believes and the token does not.
 */
describe("parseTokenLifetime", () => {
  it("reads what .env.example and the Joi defaults ship", () => {
    expect(parseTokenLifetime("15m", VAR)).toBe(900);
    expect(parseTokenLifetime("7d", VAR)).toBe(7 * 24 * 60 * 60);
  });

  it("reads a bare number as seconds, the way jsonwebtoken does", () => {
    expect(parseTokenLifetime("900", VAR)).toBe(900);
    expect(parseTokenLifetime(900 as unknown as string, VAR)).toBe(900);
  });

  it("reads the long and spaced spellings of each unit", () => {
    expect(parseTokenLifetime("1h", VAR)).toBe(3600);
    expect(parseTokenLifetime("2 hours", VAR)).toBe(7200);
    expect(parseTokenLifetime("45 seconds", VAR)).toBe(45);
    expect(parseTokenLifetime(" 10 MINUTES ", VAR)).toBe(600);
    expect(parseTokenLifetime("2 days", VAR)).toBe(172800);
  });

  it("refuses a unit jsonwebtoken has no meaning for", () => {
    // "1w" is the one an operator reaches for. Accepting it here would put a
    // number in the session row that `sign()` rejects or reads differently.
    expect(() => parseTokenLifetime("1w", VAR)).toThrow(
      /JWT_ACCESS_EXPIRATION/,
    );
    expect(() => parseTokenLifetime("1 week", VAR)).toThrow(/token lifetime/);
    expect(() => parseTokenLifetime("soon", VAR)).toThrow();
    expect(() => parseTokenLifetime("15mm", VAR)).toThrow();
  });

  it("refuses a lifetime that is zero, negative or missing", () => {
    // A zero here is a token born expired and a session row already stale —
    // worse than an aborted boot, and silent on every request after it.
    expect(() => parseTokenLifetime("0", VAR)).toThrow();
    expect(() => parseTokenLifetime("", VAR)).toThrow();
    expect(() =>
      parseTokenLifetime(undefined as unknown as string, VAR),
    ).toThrow(/JWT_ACCESS_EXPIRATION/);
  });
});

/** A `ConfigService` double that answers exactly what a deployment set. */
function config(values: Record<string, unknown>) {
  return {
    get: (key: string, fallback?: unknown) =>
      key in values ? values[key] : fallback,
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`missing ${key}`);
      return values[key];
    },
  } as any;
}

const PRESENT = {
  DATABASE_URL: "mongodb://localhost:27017/x",
  // Named, because outside development and a test run the service refuses a
  // deployment that leaves it to the localhost fallback — see
  // `usesRedisThrottlerStorage` below.
  REDIS_URL: "redis://redis:6379",
  JWT_ACCESS_SECRET: "a".repeat(32),
  JWT_REFRESH_SECRET: "b".repeat(32),
  OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
  OBJECT_STORAGE_ACCESS_KEY: "key",
  OBJECT_STORAGE_SECRET_KEY: "secret",
  OBJECT_STORAGE_BUCKET: "bucket",
  ENCRYPTION_KEY: "c".repeat(32),
};

/**
 * What `openssl rand -base64 48` produces, which is the value the rejection
 * message tells an operator to generate — so a fixture that is supposed to boot
 * has to clear the rule the message actually enforces.
 */
function generatedSecret(): string {
  return crypto.randomBytes(48).toString("base64");
}

const DEPLOYMENT = {
  JWT_ACCESS_SECRET: generatedSecret(),
  JWT_REFRESH_SECRET: generatedSecret(),
  ENCRYPTION_KEY: generatedSecret(),
};

describe("ConfigurationService token lifetimes", () => {
  it("falls back to 15m and 7d when nothing is set", () => {
    const service = new ConfigurationService(config({ ...PRESENT }));

    expect(service.jwtAccessExpiresInSeconds).toBe(900);
    expect(service.jwtRefreshExpiresInSeconds).toBe(604800);
  });

  it("treats a cleared setting as unset rather than fatal", () => {
    // `JWT_ACCESS_EXPIRATION=` is a plausible thing for an operator to write when
    // they mean "use the default". Reading the ConfigService fallback alone would
    // return the empty string for it, and an empty lifetime is one this file
    // cannot parse — so clearing a variable would have aborted the boot.
    const service = new ConfigurationService(
      config({
        ...PRESENT,
        JWT_ACCESS_EXPIRATION: "  ",
        JWT_REFRESH_EXPIRATION: "",
      }),
    );

    expect(service.jwtAccessExpiresInSeconds).toBe(900);
    expect(service.jwtRefreshExpiresInSeconds).toBe(604800);
  });

  it("aborts the boot on a lifetime it cannot read", () => {
    // The alternative is the first login of the day answering 500, for a value
    // that has been wrong since the container started.
    expect(
      () =>
        new ConfigurationService(
          config({ ...PRESENT, JWT_ACCESS_EXPIRATION: "15 minutes ago" }),
        ),
    ).toThrow(/JWT_ACCESS_EXPIRATION/);

    expect(
      () =>
        new ConfigurationService(
          config({ ...PRESENT, JWT_REFRESH_EXPIRATION: "1w" }),
        ),
    ).toThrow(/JWT_REFRESH_EXPIRATION/);
  });

  it("applies the settings to both the seconds and the string", () => {
    const service = new ConfigurationService(
      config({
        ...PRESENT,
        JWT_ACCESS_EXPIRATION: "1h",
        JWT_REFRESH_EXPIRATION: "30d",
      }),
    );

    expect(service.jwtAccessExpiration).toBe("1h");
    expect(service.jwtAccessExpiresInSeconds).toBe(3600);
    expect(service.jwtRefreshExpiresInSeconds).toBe(30 * 24 * 60 * 60);
  });
});

/**
 * `ConfigurationService.isTestEnvironment` reads `NODE_ENV`, and jest owns that
 * value — so without clearing it every case below would take the test escape
 * hatch and assert nothing.
 *
 * The hatch is now decided in one place instead of per process: both boot schemas
 * validate `NODE_ENV` against `ACCEPTED_NODE_ENV`, which admits `test` — the
 * worker specs import and compile `WorkerModule`, and that value is already in
 * `process.env` when the schema runs — and refuses every other spelling in either
 * process. So `test` reaches this path only where an operator wrote that word down
 * deliberately; it is no longer a value the API rejects while the worker passes it
 * through undeclared and skips the gate.
 */
describe("ConfigurationService secret gate", () => {
  const saved = { NODE_ENV: process.env.NODE_ENV };

  beforeAll(() => {
    delete process.env.NODE_ENV;
  });

  afterAll(() => {
    if (saved.NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = saved.NODE_ENV;
    }
  });

  const boot = (overrides: Record<string, unknown> = {}) =>
    new ConfigurationService(
      config({ ...PRESENT, ...DEPLOYMENT, ...overrides }),
    );

  it("rejects the template ENCRYPTION_KEY in production", () => {
    // The 57-character template value used to pass: it is longer than the old
    // 32-character floor and does not contain the one substring the old rule
    // looked for. It is the pepper on every stored vault verifier.
    expect(() =>
      boot({
        APP_ENV: "production",
        ENCRYPTION_KEY:
          "your-super-secret-encryption-key-min-32-chars-change-prod",
      }),
    ).toThrow(/ENCRYPTION_KEY/);
  });

  it("rejects the template ENCRYPTION_KEY when APP_ENV is not declared", () => {
    // The gate used to be keyed on `APP_ENV === "production"`, so the container
    // that simply never set it — `appEnv` then reading "development" — skipped
    // every check. Unset is now treated as deployed, not as local.
    expect(() =>
      boot({
        ENCRYPTION_KEY:
          "your-super-secret-encryption-key-min-32-chars-change-prod",
      }),
    ).toThrow(/ENCRYPTION_KEY/);
  });

  it("treats an APP_ENV it does not recognise as deployed", () => {
    for (const appEnv of ["staging", "prod", "Production ", ""]) {
      expect(() =>
        boot({
          APP_ENV: appEnv,
          ENCRYPTION_KEY:
            "your-super-secret-encryption-key-min-32-chars-change-prod",
        }),
      ).toThrow(/ENCRYPTION_KEY/);
    }
  });

  it("rejects the template JWT secrets by name", () => {
    expect(() =>
      boot({
        APP_ENV: "production",
        JWT_ACCESS_SECRET:
          "your-super-secret-access-token-key-change-in-production",
      }),
    ).toThrow(/JWT_ACCESS_SECRET/);

    expect(() =>
      boot({
        APP_ENV: "production",
        JWT_REFRESH_SECRET:
          "your-super-secret-refresh-token-key-change-in-production",
      }),
    ).toThrow(/JWT_REFRESH_SECRET/);
  });

  it("accepts generated secrets in production", () => {
    expect(() => boot({ APP_ENV: "production" })).not.toThrow();
  });

  it("rejects the unfilled sentinel the template now points at", () => {
    // `.env.example` moved off the sentence-shaped placeholders to
    // `REPLACE_WITH__<generate a value>__DO_NOT_SHIP`. That is longer than the
    // length floor and carries a wide alphabet, so nothing but this rule stands
    // between an operator who skipped the substitution and a deployed default.
    for (const sentinel of [
      `${TEMPLATE_SENTINEL_PREFIX}openssl_rand_-base64_48${TEMPLATE_SENTINEL_SUFFIX}`,
      `${TEMPLATE_SENTINEL_PREFIX}<your own random secret>${TEMPLATE_SENTINEL_SUFFIX}`,
    ]) {
      expect(isShippedTemplateSecret(sentinel)).toBe(true);
      expect(() =>
        boot({ APP_ENV: "production", ENCRYPTION_KEY: sentinel }),
      ).toThrow(/ENCRYPTION_KEY/);
    }
  });

  it("anchors the sentinel at both ends of the value, not inside it", () => {
    // The property that made the old substring list unsafe: a generated key with
    // the sentinel sitting in the middle of it is a coincidence, not a template.
    const unlucky = `${generatedSecret()}${TEMPLATE_SENTINEL_PREFIX}abc`;

    expect(isShippedTemplateSecret(unlucky)).toBe(false);
    expect(() =>
      boot({ APP_ENV: "production", ENCRYPTION_KEY: unlucky }),
    ).not.toThrow();
  });

  it("refuses a reused access and refresh secret", () => {
    const shared = generatedSecret();
    expect(() =>
      boot({
        APP_ENV: "production",
        JWT_ACCESS_SECRET: shared,
        JWT_REFRESH_SECRET: shared,
      }),
    ).toThrow(/must be different/);
  });

  it("refuses wildcard HTTP or WebSocket CORS origins", () => {
    expect(() => boot({ APP_ENV: "production", CORS_ORIGIN: "*" })).toThrow(
      /Wildcard CORS/,
    );

    expect(() =>
      boot({ APP_ENV: "production", WS_CORS_ORIGINS: "https://app.test, *" }),
    ).toThrow(/Wildcard CORS/);
  });

  it("refuses a short key and one with too few distinct characters", () => {
    // Length alone was the other half of the old rule's blind spot: 40 copies of
    // one character satisfy it and carry no entropy at all.
    expect(() =>
      boot({ APP_ENV: "production", ENCRYPTION_KEY: "a".repeat(16) }),
    ).toThrow(/ENCRYPTION_KEY/);
    expect(() =>
      boot({ APP_ENV: "production", ENCRYPTION_KEY: "a".repeat(40) }),
    ).toThrow(/ENCRYPTION_KEY/);
  });

  it("no longer rejects a strong key for containing a placeholder word", () => {
    // The substring list could refuse a genuinely random value — `example` and
    // `xxx` occur in real base64 — and a false rejection at boot costs an
    // operator a regenerated key while teaching them to distrust the gate.
    const awkward = `${crypto
      .randomBytes(40)
      .toString("base64")}xxx-change-me-example`;
    expect(secretDefect(awkward)).toBeUndefined();
    expect(() =>
      boot({ APP_ENV: "production", ENCRYPTION_KEY: awkward }),
    ).not.toThrow();
  });

  it("keeps the template values allowed where the environment says local", () => {
    // The dev policy this file commits to: `APP_ENV=development` and a test run
    // boot with the shipped templates, so a fresh clone needs no key ceremony,
    // and every other spelling pays for one.
    const template = {
      JWT_ACCESS_SECRET: SHIPPED_TEMPLATE_SECRETS[0],
      JWT_REFRESH_SECRET: SHIPPED_TEMPLATE_SECRETS[1],
      ENCRYPTION_KEY: SHIPPED_TEMPLATE_SECRETS[2],
    };

    expect(() => boot({ APP_ENV: "development", ...template })).not.toThrow();
    expect(() => boot({ APP_ENV: "test", ...template })).not.toThrow();
    expect(() => boot(template)).toThrow(/JWT_ACCESS_SECRET/);
  });

  it("restores the test escape hatch the Jest suites build on", () => {
    // The e2e suites load the repository `.env`, which today declares
    // `APP_ENV=production` alongside template secrets; `NODE_ENV=test` is what
    // keeps them booting, and it is only reachable from a test runner.
    process.env.NODE_ENV = "test";
    try {
      expect(
        () =>
          new ConfigurationService(
            config({
              ...PRESENT,
              APP_ENV: "production",
              ENCRYPTION_KEY: SHIPPED_TEMPLATE_SECRETS[2],
            }),
          ),
      ).not.toThrow();
    } finally {
      delete process.env.NODE_ENV;
    }
  });

  it("guards exactly the values .env.example ships", () => {
    // Editing a template string without editing the denylist is how this gate
    // goes stale, and the staleness is silent: the boot it should refuse succeeds.
    const example = dotenv.parse(
      fs.readFileSync(path.join(__dirname, "../../.env.example")),
    );

    for (const variable of [
      "JWT_ACCESS_SECRET",
      "JWT_REFRESH_SECRET",
      "ENCRYPTION_KEY",
    ] as const) {
      const shipped = example[variable];
      expect(shipped).toBeDefined();
      expect(isShippedTemplateSecret(shipped)).toBe(true);
      expect(secretDefect(shipped)).toMatch(
        /template|distinct characters|at least/,
      );
    }
  });
});

/**
 * The pepper key ring. `ENCRYPTION_KEY` is the verifier pepper on every stored
 * vault row, and only a digest is kept — never the verifier it digests — so a
 * rotation can only be survived by rows that can say which key sealed them.
 * These are the settings an operator has to be able to trust.
 */
describe("ConfigurationService pepper key ring", () => {
  const saved = { NODE_ENV: process.env.NODE_ENV };

  beforeAll(() => {
    delete process.env.NODE_ENV;
  });

  afterAll(() => {
    if (saved.NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = saved.NODE_ENV;
    }
  });

  const boot = (overrides: Record<string, unknown> = {}) =>
    new ConfigurationService(
      config({
        ...PRESENT,
        ...DEPLOYMENT,
        APP_ENV: "production",
        ...overrides,
      }),
    );

  it("names the pepper by a fingerprint when the operator declared no id", () => {
    // The default cannot be a role word: rows sealed today would say `current`,
    // and the next rotation makes that sentence false for every one of them —
    // they would be read under the wrong key and refuse their own owners.
    const service = boot();

    expect(service.encryptionKeyId).toBe(
      secretFingerprint(DEPLOYMENT.ENCRYPTION_KEY),
    );
    expect(service.encryptionKeyId).not.toBe("current");
  });

  it("prefers the operator's own label for each key", () => {
    const service = boot({
      ENCRYPTION_KEY_ID: " v3-2026-10 ",
      ENCRYPTION_KEY_PREVIOUS: generatedSecret(),
      ENCRYPTION_KEY_PREVIOUS_ID: "v2-2026-04",
    });

    expect(service.encryptionKeyId).toBe("v3-2026-10");
    expect(service.encryptionKeyPreviousId).toBe("v2-2026-04");
  });

  it("reads an unset retired key as no window at all", () => {
    // The steady state, and the common case: a deployment that has never rotated,
    // or whose last rotation has drained, must boot without a second variable and
    // hand the vault one pepper to try.
    const service = boot();

    expect(service.encryptionKeyPrevious).toBeUndefined();
    expect(service.encryptionKeyPreviousId).toBeUndefined();
    expect(() => boot({ ENCRYPTION_KEY_PREVIOUS: "   " })).not.toThrow();
    expect(
      boot({ ENCRYPTION_KEY_PREVIOUS: "" }).encryptionKeyPrevious,
    ).toBeUndefined();
  });

  it("names a retired key the same way it names the current one", () => {
    const retired = generatedSecret();
    const service = boot({ ENCRYPTION_KEY_PREVIOUS: retired });

    expect(service.encryptionKeyPrevious).toBe(retired);
    expect(service.encryptionKeyPreviousId).toBe(secretFingerprint(retired));
  });

  it("holds the retired key to the same rules as the key it replaced", () => {
    // A half-configured window is worse than none: pasting the template in here
    // means the operator believes the old rows are still readable, and the value
    // that keeps them readable is one anyone can find in this repository.
    for (const weak of [
      SHIPPED_TEMPLATE_SECRETS[2],
      "a".repeat(16),
      "a".repeat(40),
      `${TEMPLATE_SENTINEL_PREFIX}generated${TEMPLATE_SENTINEL_SUFFIX}`,
    ]) {
      expect(() => boot({ ENCRYPTION_KEY_PREVIOUS: weak })).toThrow(
        /ENCRYPTION_KEY_PREVIOUS/,
      );
    }
  });

  it("refuses a retired key that is the current key again", () => {
    // Two names for one secret is a rotation that did not happen, and the ring
    // would then keep a key that seals nothing beside the one everything uses.
    const current = boot().encryptionKey;

    expect(() => boot({ ENCRYPTION_KEY_PREVIOUS: current })).toThrow(
      /ENCRYPTION_KEY_PREVIOUS must be the key ENCRYPTION_KEY replaced/,
    );
  });

  it("refuses two peppers sharing one name", () => {
    // The stamp is the whole lookup. With one name for two secrets every row
    // sealed under the loser would be verified against the wrong key and answer
    // a correct master password as a wrong one.
    expect(() =>
      boot({
        ENCRYPTION_KEY_ID: "same-label",
        ENCRYPTION_KEY_PREVIOUS: generatedSecret(),
        ENCRYPTION_KEY_PREVIOUS_ID: "same-label",
      }),
    ).toThrow(/must be different/);
  });

  it("still boots where the template key is allowed through", () => {
    // `ENCRYPTION_KEY_PREVIOUS` is gated with the rest of them, not around them:
    // a laptop with the shipped templates keeps working, and nothing that is not
    // development or a test run gets the leniency.
    expect(
      () =>
        new ConfigurationService(
          config({
            ...PRESENT,
            APP_ENV: "development",
            ENCRYPTION_KEY: SHIPPED_TEMPLATE_SECRETS[2],
            ENCRYPTION_KEY_PREVIOUS: SHIPPED_TEMPLATE_SECRETS[2],
          }),
        ),
    ).not.toThrow();
  });
});

describe("secretFingerprint", () => {
  it("names a key without saying anything about it", () => {
    // The stamp lands in every `VaultSetting` row, so a fingerprint that carried
    // even part of the pepper would put key material in a readable column.
    const secret = generatedSecret();
    const printed = secretFingerprint(secret);

    expect(printed).not.toContain(secret);
    expect(printed.length).toBeLessThanOrEqual(16);
    expect(secretFingerprint(secret)).toBe(printed);
  });

  it("gives each key its own name, which is what the default is for", () => {
    expect(secretFingerprint(generatedSecret())).not.toBe(
      secretFingerprint(generatedSecret()),
    );
    expect(secretFingerprint("a".repeat(32))).not.toBe(
      secretFingerprint("b".repeat(32)),
    );
  });
});

/**
 * The other half of the throttler wiring: `ThrottlerModule.forRootAsync` in
 * `src/app/app.module.ts` reads this one getter to choose its storage, so the
 * rule the module follows is stated — and tested — here.
 */
describe("ConfigurationService usesRedisThrottlerStorage", () => {
  function choiceFor(env: Record<string, unknown>, nodeEnv?: string) {
    const savedNodeEnv = process.env.NODE_ENV;
    if (nodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = nodeEnv;
    }
    try {
      return new ConfigurationService(
        config({ ...PRESENT, ...DEPLOYMENT, ...env }),
      ).usesRedisThrottlerStorage;
    } finally {
      if (savedNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = savedNodeEnv;
      }
    }
  }

  it("shares the counters wherever a real process runs", () => {
    expect(choiceFor({ APP_ENV: "production" })).toBe(true);
    // A laptop that named a Redis gets the shared storage too, so `start:dev`
    // exercises the same code path a container does.
    expect(choiceFor({ APP_ENV: "development" })).toBe(true);
    // The undeclared environment takes the shared path too, exactly as the
    // secret gate does: an omitted `APP_ENV` is a deployment, not a laptop.
    expect(choiceFor({})).toBe(true);
  });

  it("keeps the in-memory storage for the suites that have no Redis", () => {
    expect(choiceFor({ APP_ENV: "test" })).toBe(false);
    expect(choiceFor({ APP_ENV: "production" }, "test")).toBe(false);
    // Development is the other in-memory case, and only when nobody named a
    // server: an unnamed Redis elsewhere is refused at boot, so the one process
    // that lands here without a counters server is one a person is sitting at.
    expect(choiceFor({ APP_ENV: "development", REDIS_URL: undefined })).toBe(
      false,
    );
  });

  it("refuses a deployment that never named its Redis", () => {
    // Without this, a container that omitted `REDIS_URL` would count against the
    // `localhost:6379` fallback — nothing listens there once
    // `docker-compose.prod.yml` publishes no ports — and `RedisThrottlerStorage`
    // answers a failed command by permitting the request. Every throttle in the
    // app would be off, quietly.
    expect(() =>
      choiceFor({ APP_ENV: "production", REDIS_URL: undefined }),
    ).toThrow(/REDIS_URL/);
    expect(() => choiceFor({ REDIS_URL: "   " })).toThrow(/REDIS_URL/);
    // And the same omission is still tolerated where it is a laptop's business.
    expect(() =>
      choiceFor({ APP_ENV: "test", REDIS_URL: undefined }),
    ).not.toThrow();
  });
});

describe("secretDefect", () => {
  it("reports nothing about a value that is fine", () => {
    expect(secretDefect(generatedSecret())).toBeUndefined();
  });

  it("names the defect without ever naming the value", () => {
    const weak = "a".repeat(40);
    const defect = secretDefect(weak);
    expect(defect).toBeDefined();
    expect(defect).not.toContain(weak);
    expect(defect).toContain(String(SECRET_MIN_ENTROPY_BITS));
  });

  it("measures entropy from the characters present, not the ones possible", () => {
    // Two symbols over forty characters is forty bits, whatever the length says.
    expect(estimateSecretEntropyBits("ab".repeat(20))).toBe(40);
    expect(estimateSecretEntropyBits("")).toBe(0);
    expect(estimateSecretEntropyBits(generatedSecret())).toBeGreaterThan(300);
  });

  it("keeps the floor and the Joi schema telling the same story", () => {
    // `ENCRYPTION_KEY: Joi.string().min(32)` in app.module.ts must not disagree
    // with what this file refuses, or a value passes one and fails the other.
    expect(SECRET_MIN_LENGTH).toBe(32);
    expect(secretDefect("x".repeat(31))).toMatch(/at least 32/);
  });
});
