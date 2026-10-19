import {
  ACCEPTED_NODE_ENV,
  ADMIN_SECRET_MIN_LENGTH,
  ConfigurationService,
  CREDENTIAL_IDENTIFIER,
  KEY_MATERIAL,
  PASSPHRASE,
  PASSPHRASE_MIN_ENTROPY_BITS,
  PASSPHRASE_MIN_LENGTH,
  SECRET_MIN_ENTROPY_BITS,
  SECRET_MIN_LENGTH,
  SHIPPED_DEFAULT_CREDENTIALS,
  SHIPPED_TEMPLATE_SECRETS,
  TEMPLATE_SENTINEL_PREFIX,
  TEMPLATE_SENTINEL_SUFFIX,
  credentialDefect,
  estimateSecretEntropyBits,
  isShippedDefaultCredential,
  isShippedTemplateSecret,
  parseTokenLifetime,
  secretDefect,
  secretFingerprint,
} from "./configuration.service";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
// The API's boot schema, imported as an object rather than through a module boot.
// This spec is where the secret gate is tested, and until now every case in it
// handed `ConfigurationService` a hand-built `ConfigService` double — which meant
// the one thing that could open the gate, a Joi `.default()` on `APP_ENV` being
// written back into the validated config, was invisible to it. Reading the real
// schema here is the only way to assert against the mechanism and not a model of
// it. `src/app/app.module.ts` carries no side effects at import beyond the
// `ConfigModule.forRoot` call every boot spec already survives.
import { ENV_VALIDATION_SCHEMA } from "@/app/app.module";
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
  // Not `key` and `secret` any more: `validateProductionSecrets()` reads this pair
  // now, so a fixture that is supposed to reach the strict branch has to clear the
  // rule it enforces. The case the rule exists for is the `minioadmin` pair
  // `.env.example` ships, asserted against the real file below.
  OBJECT_STORAGE_ACCESS_KEY: "allinone-attachments-service-account",
  OBJECT_STORAGE_SECRET_KEY: crypto.randomBytes(32).toString("base64"),
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

  // The case this used to assert from a fixture — an undeclared `APP_ENV` reaching
  // the strict branch — is now asserted against the boot schema itself, in
  // `describe("ConfigurationService strict path through the real boot schema")`
  // below. Nothing here can prove it: `config()` hands the service a
  // `ConfigService` double, so it never runs the Joi pass where the
  // `.default("development")` lived, and the test stayed green for the whole time
  // a real deployment was skipping the gate. What this describe does prove is the
  // behaviour of `declaredAppEnv` once the schema has left the value genuinely
  // absent — which is what `treats an APP_ENV it does not recognise as deployed`
  // and every case below depend on.
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

  // The secrets that sat outside the gate. Each of these five is a credential a
  // request can present or a service can dial, and none of them was read by
  // `validateProductionSecrets()` before: `adminSecret` measured length and nothing
  // else, so the zero-entropy value below was a working bearer credential for
  // `GET /metrics` — an endpoint `MetricsScrapeGuard` answers on that header alone,
  // with no user identity behind it. They are held to the same rule as the JWT pair
  // now, each with the profile of the kind of value it is, and each still
  // switchable-off by leaving it unset.

  it("refuses a zero-entropy ADMIN_SECRET that the length floor let through", () => {
    // Thirty-two copies of one character: `ADMIN_SECRET_MIN_LENGTH` satisfied, and
    // `estimateSecretEntropyBits` on this very file's helper says 0 bits.
    expect(estimateSecretEntropyBits("a".repeat(32))).toBe(0);
    expect(() =>
      boot({ APP_ENV: "production", ADMIN_SECRET: "a".repeat(32) }),
    ).toThrow(/ADMIN_SECRET/);

    // The shipped JWT template is a shipped template in this slot too.
    expect(() =>
      boot({
        APP_ENV: "production",
        ADMIN_SECRET: SHIPPED_TEMPLATE_SECRETS[0],
      }),
    ).toThrow(/ADMIN_SECRET/);

    expect(() =>
      boot({ APP_ENV: "production", ADMIN_SECRET: generatedSecret() }),
    ).not.toThrow();
  });

  it("refuses a short ADMIN_SECRET instead of silently disabling the path", () => {
    // Twenty characters is under `ADMIN_SECRET_MIN_LENGTH`, so the getter returned
    // `undefined` and the operator's `x-admin-secret` never worked — a
    // half-configured credential, which is the same failure the rotation window is
    // gated for. Absent and blank stay a deliberate opt-out.
    expect(() =>
      boot({ APP_ENV: "production", ADMIN_SECRET: "x".repeat(20) }),
    ).toThrow(/ADMIN_SECRET/);
    expect(() => boot({ APP_ENV: "production" })).not.toThrow();
    expect(() =>
      boot({ APP_ENV: "production", ADMIN_SECRET: "   " }),
    ).not.toThrow();
  });

  it("gates a custom JWT_MFA_SECRET and leaves the derived fallback alone", () => {
    expect(() =>
      boot({ APP_ENV: "production", JWT_MFA_SECRET: "mfa" }),
    ).toThrow(/JWT_MFA_SECRET/);
    expect(() =>
      boot({ APP_ENV: "production", JWT_MFA_SECRET: "b".repeat(32) }),
    ).toThrow(/JWT_MFA_SECRET/);
    expect(() =>
      boot({ APP_ENV: "production", JWT_MFA_SECRET: generatedSecret() }),
    ).not.toThrow();

    // Unset is the documented default, and it is not weak: the getter derives an
    // HMAC of the already-gated `JWT_ACCESS_SECRET`, which the rule above has to
    // have cleared for the boot to reach this point.
    const service = boot({ APP_ENV: "production" });
    expect(() => service.jwtMfaSecret).not.toThrow();
    expect(secretDefect(service.jwtMfaSecret)).toBeUndefined();
  });

  it("refuses the MinIO credentials .env.example ships in both slots", () => {
    expect(() =>
      boot({
        APP_ENV: "production",
        OBJECT_STORAGE_ACCESS_KEY: "minioadmin",
        OBJECT_STORAGE_SECRET_KEY: "minioadmin",
      }),
    ).toThrow(/OBJECT_STORAGE_ACCESS_KEY/);

    expect(() =>
      boot({ APP_ENV: "production", OBJECT_STORAGE_SECRET_KEY: "minioadmin" }),
    ).toThrow(/OBJECT_STORAGE_SECRET_KEY/);

    // Presence is not this rule's job: both variables are `.required()` in the two
    // schemas and listed in `requiredVars`, so an absent one already failed the
    // boot before anything here ran.
    expect(() =>
      boot({
        APP_ENV: "production",
        OBJECT_STORAGE_ACCESS_KEY: undefined,
      }),
    ).toThrow(/Missing required environment variables/);
  });

  it("does not hold an access key ID to a secret's length", () => {
    // An identifier rather than a credential. AWS's own access key IDs are twenty
    // characters and land near 78 bits, so the key-material floor would refuse a
    // deployment that is configured correctly — and buy nothing, since the value
    // travels in the clear next to a signature the attacker cannot make.
    expect(estimateSecretEntropyBits("AKIAIOSFODNN7EXAMPLE")).toBeLessThan(
      SECRET_MIN_ENTROPY_BITS,
    );
    expect(() =>
      boot({
        APP_ENV: "production",
        OBJECT_STORAGE_ACCESS_KEY: "AKIAIOSFODNN7EXAMPLE",
      }),
    ).not.toThrow();
  });

  it("gates an SMTP password as a password, not as key material", () => {
    // `MailService.isConfigured` treats a blank one as "mail is off" and warns, so
    // refusing the boot for an absent `SMTP_PASSWORD` would turn an opt-out into an
    // outage. A written one is a credential against a live mailbox.
    expect(() =>
      boot({ APP_ENV: "production", SMTP_PASSWORD: undefined }),
    ).not.toThrow();
    expect(() =>
      boot({ APP_ENV: "production", SMTP_PASSWORD: "password" }),
    ).toThrow(/SMTP_PASSWORD/);
    expect(() =>
      boot({ APP_ENV: "production", SMTP_PASSWORD: "12345678" }),
    ).toThrow(/SMTP_PASSWORD/);
    expect(() =>
      boot({
        APP_ENV: "production",
        SMTP_PASSWORD: SHIPPED_DEFAULT_CREDENTIALS[0],
      }),
    ).toThrow(/SMTP_PASSWORD/);

    // A Gmail app password is sixteen lowercase characters. At the 128-bit
    // key-material floor it would be rejected, and it is the exact value the file
    // this gate protects recommends.
    const appPassword = "kmzqvtbjxpdnhswg";
    expect(estimateSecretEntropyBits(appPassword)).toBeGreaterThanOrEqual(
      PASSPHRASE_MIN_ENTROPY_BITS,
    );
    expect(() =>
      boot({ APP_ENV: "production", SMTP_PASSWORD: appPassword }),
    ).not.toThrow();

    // Development keeps all of it, because a laptop with no mail server is a
    // supported configuration.
    expect(() =>
      boot({ APP_ENV: "development", SMTP_PASSWORD: "password" }),
    ).not.toThrow();
  });

  it("gates the storage and mail credentials only on the strict path", () => {
    // The single condition `validateConfiguration()` uses, unchanged: this is not a
    // second, wider gate that would break a fresh clone. An attachment bucket on
    // `minioadmin` is a deployment's problem, and a laptop's mailbox password is
    // nobody's problem.
    const weak = {
      OBJECT_STORAGE_ACCESS_KEY: "minioadmin",
      OBJECT_STORAGE_SECRET_KEY: "minioadmin",
      SMTP_PASSWORD: "password",
    };

    expect(() => boot({ APP_ENV: "development", ...weak })).not.toThrow();
    expect(() => boot({ APP_ENV: "test", ...weak })).not.toThrow();
    expect(() => boot(weak)).toThrow(/OBJECT_STORAGE_ACCESS_KEY/);
  });

  it("gates ADMIN_SECRET and JWT_MFA_SECRET in development as well", () => {
    // The exception to the case above, and the one the strict path used to own:
    // these two are only ever compared by a guard, so `APP_ENV=development` buys an
    // operator nothing here. Thirty-two copies of one character cleared
    // `ADMIN_SECRET_MIN_LENGTH` and is zero bits — and that header alone is what
    // `MetricsScrapeGuard` needs to answer `GET /metrics`, with no user identity
    // behind it, in a development process reachable from a shared network just as
    // much as in a container.
    for (const appEnv of ["development", "staging", undefined]) {
      expect(() =>
        boot({ APP_ENV: appEnv, ADMIN_SECRET: "a".repeat(32) }),
      ).toThrow(/ADMIN_SECRET/);
      expect(() => boot({ APP_ENV: appEnv, JWT_MFA_SECRET: "mfa" })).toThrow(
        /JWT_MFA_SECRET/,
      );
    }

    // The rejection names what the value protects, like the other gates do: an
    // operator reading a deploy log has to learn which route the weak value was
    // the only credential for, without this file having to be opened.
    expect(() =>
      boot({ APP_ENV: "development", ADMIN_SECRET: "a".repeat(32) }),
    ).toThrow(/ADMIN_SECRET .*identity-free GET \/metrics/);
    expect(() =>
      boot({ APP_ENV: "development", JWT_MFA_SECRET: "mfa" }),
    ).toThrow(/JWT_MFA_SECRET .*MFA challenge/);

    // Omitting them is still the supported way to have neither feature: the admin
    // header path stays closed, and MFA challenges fall back to the HMAC of the
    // already-gated `JWT_ACCESS_SECRET`.
    expect(() => boot({ APP_ENV: "development" })).not.toThrow();
    expect(() =>
      boot({ APP_ENV: "development", ADMIN_SECRET: "  " }),
    ).not.toThrow();
    expect(() =>
      boot({
        APP_ENV: "development",
        ADMIN_SECRET: generatedSecret(),
        JWT_MFA_SECRET: generatedSecret(),
      }),
    ).not.toThrow();

    // A test run keeps the hatch — the guard suites hand this service a
    // seven-character secret precisely to assert the guard rejects it.
    expect(() =>
      boot({ APP_ENV: "test", ADMIN_SECRET: "hunter2" }),
    ).not.toThrow();
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

    // The storage pair is not a `REPLACE_WITH__` sentinel — it is the credential a
    // stock MinIO answers with, which is why it needs its own list. Both slots ship
    // filled, both have to be refused, and the file being the source of truth here
    // is the point: someone editing either default has to move this test with it.
    for (const variable of [
      "OBJECT_STORAGE_ACCESS_KEY",
      "OBJECT_STORAGE_SECRET_KEY",
    ] as const) {
      const shipped = example[variable];
      expect(shipped).toBeDefined();
      expect(isShippedDefaultCredential(shipped)).toBe(true);
      expect(
        credentialDefect(
          shipped,
          variable === "OBJECT_STORAGE_ACCESS_KEY"
            ? CREDENTIAL_IDENTIFIER
            : KEY_MATERIAL,
        ),
      ).toMatch(/default credential|at least|distinct characters/);
    }

    // The two values this gate treats as optional have to stay *un*shipped, or an
    // operator copying the template would deploy a credential nobody meant to
    // publish: `ADMIN_SECRET` commented out (no admin header path) and
    // `SMTP_PASSWORD` blank (mail off).
    expect(example.ADMIN_SECRET).toBeUndefined();
    expect(example.SMTP_PASSWORD).toBe("");
    expect(example.JWT_MFA_SECRET).toBeUndefined();
  });
});

/**
 * The gate's actual entry point.
 *
 * Every other case in this file builds `ConfigurationService` on a `ConfigService`
 * double, which is the right tool for asking what the service does with a value and
 * exactly the wrong tool for asking whether a value ever reaches it. The P1 defect
 * lived in the second question: `APP_ENV` carried `.default("development")` in both
 * boot schemas, `@nestjs/config` writes schema defaults into the validated config
 * *and* into `process.env`, and so an undeclared environment arrived at
 * `declaredAppEnv` as the string `development`. A fixture double cannot observe that
 * at any level of subterfuge, so these cases run the schema `src/app/app.module.ts`
 * exports through the real `ConfigModule` and the real `ConfigService`, against a
 * `process.env` the fixture owns.
 */
describe("ConfigurationService strict path through the real boot schema", () => {
  /**
   * Every key the schema can answer for, plus `REDIS_URL`.
   *
   * `REDIS_URL` has no declaration in the API schema — it reaches `ConfigService`
   * as an `allowUnknown` pass-through, and the worker's comment on that key explains
   * why it must not be defaulted either — but it is the other half of the strict
   * branch, so it is cleared alongside the declared set. `NODE_ENV` is in the
   * declared set, which is what lets a case here choose the test hatch or leave it
   * out.
   */
  const MANAGED = [
    ...Object.keys(ENV_VALIDATION_SCHEMA.describe().keys),
    "REDIS_URL",
  ];

  /**
   * A `process.env` with the schema-managed keys removed and the fixture's values
   * written in, restored exactly afterwards.
   *
   * The removal comes first and is not optional: `ConfigModule.forRoot` merges
   * `process.env` over the env file, so any key left over from this file's own
   * import of `app.module.ts` — which reads the repository `.env`, and which
   * `assignVariablesToProcess` then copies into `process.env` — would answer for a
   * key the fixture deliberately omitted. Deleting first is what makes "the operator
   * wrote nothing" mean what it says.
   */
  /**
   * What one sandboxed boot actually answered, every value read while the fixture
   * still owned `process.env`.
   *
   * That last clause is the reason this is a snapshot and not a live `ConfigService`
   * and `ConfigurationService`. `ConfigService.get()` falls through to `process.env`
   * whenever its own validated config has nothing for a key, and `boot()` restores
   * `process.env` before returning — to this machine's repository `.env`, which
   * declares `APP_ENV=production`. Reading `configService.get("APP_ENV")` from a
   * test body would therefore answer "what does the developer's shell say", not "what
   * did this boot see", and the one assertion that matters here — that a schema with
   * no `APP_ENV` default leaves the key genuinely absent — would be measuring the
   * wrong thing and could not fail for the reason it exists to catch.
   */
  type BootResult = {
    /** The refusal the constructor raised, or `undefined` for a boot that ran. */
    error?: Error;
    /** Each key straight out of the validated config, as the container held it. */
    resolved: {
      APP_ENV?: string;
      NODE_ENV?: string;
    };
    /**
     * `process.env` as the boot left it, after `assignVariablesToProcess` — the
     * write-back that turned an absent `APP_ENV` into `development` before the fix.
     */
    processEnv: {
      APP_ENV?: string;
      NODE_ENV?: string;
    };
    /** `undefined` when the boot was refused, so nothing here asserts on it. */
    decisions?: {
      appEnv: string;
      isDevelopment: boolean;
      isProduction: boolean;
      adminSecret?: string;
      usesRedisThrottlerStorage: boolean;
    };
  };

  async function boot(
    env: Record<string, string | undefined>,
  ): Promise<BootResult> {
    const saved = { ...process.env };
    MANAGED.forEach((key) => delete process.env[key]);
    try {
      Object.entries(env).forEach(([key, value]) => {
        if (value !== undefined) process.env[key] = value;
      });

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: false,
            // The repository `.env` is a developer's live configuration; a schema
            // test has to be answerable from its fixture alone.
            ignoreEnvFile: true,
            validationSchema: ENV_VALIDATION_SCHEMA,
            validationOptions: { abortEarly: true },
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
          // Read inside the sandbox, before the restore: this is what a real
          // container would be left holding after `assignVariablesToProcess`, which
          // is the whole mechanism the defect turned on.
          processEnv: {
            APP_ENV: process.env.APP_ENV,
            NODE_ENV: process.env.NODE_ENV,
          },
          decisions: service && {
            appEnv: service.appEnv,
            isDevelopment: service.isDevelopment,
            isProduction: service.isProduction,
            adminSecret: service.adminSecret,
            usesRedisThrottlerStorage: service.usesRedisThrottlerStorage,
          },
        };
      } finally {
        await moduleRef.close();
      }
    } finally {
      MANAGED.forEach((key) => {
        if (key in saved) {
          process.env[key] = saved[key];
        } else {
          delete process.env[key];
        }
      });
    }
  }

  /** A deployment that clears every rule, in the shape the schemas demand. */
  function deployment(
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> {
    return {
      APP_URL: "https://app.example",
      DATABASE_URL: "mongodb://localhost:27017/schema_boot_test",
      REDIS_URL: "redis://redis:6379",
      OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
      OBJECT_STORAGE_BUCKET: "allinone-dev",
      OBJECT_STORAGE_ACCESS_KEY: "allinone-attachments-service-account",
      OBJECT_STORAGE_SECRET_KEY: generatedSecret(),
      ...DEPLOYMENT,
      ...overrides,
    };
  }

  const templateEncryptionKey =
    "your-super-secret-encryption-key-min-32-chars-change-prod";

  it("declares no default for APP_ENV, and keeps the accepted list", () => {
    // The declarative half of the fix: `.valid(...)` unchanged, `.default()` gone.
    // A future edit putting the default back fails here before it can fail in a
    // deployment, which is the order this repository wants to learn things in.
    const described = ENV_VALIDATION_SCHEMA.describe();

    expect(described.keys.APP_ENV.flags?.default).toBeUndefined();
    expect(described.keys.APP_ENV.allow).toEqual([
      "development",
      "staging",
      "production",
    ]);
  });

  it("gives a boot that named no APP_ENV no APP_ENV at all", async () => {
    // Before the fix this read `development` in both the validated config and
    // `process.env`, and every strict-path decision downstream was switched off by
    // a value nobody wrote.
    const { resolved, processEnv, decisions, error } = await boot(deployment());

    expect(error).toBeUndefined();
    expect(resolved.APP_ENV).toBeUndefined();
    expect(processEnv.APP_ENV).toBeUndefined();
    expect(decisions?.isDevelopment).toBe(false);
    expect(decisions?.isProduction).toBe(false);
    // The other decision the same implicit default used to reach: with nothing
    // declared, the counters have to go to Redis, not to this process.
    expect(decisions?.usesRedisThrottlerStorage).toBe(true);
    // The display fallback the docs and `main.ts` still read is untouched; only the
    // decisions moved.
    expect(decisions?.appEnv).toBe("development");
  });

  it("runs validateProductionSecrets() for a boot that named no APP_ENV", async () => {
    // The assertion the fake `ConfigService` could never make: an absent
    // `APP_ENV` reaching the secret gate, through the schema that used to hide it.
    const { error } = await boot(
      deployment({ ENCRYPTION_KEY: templateEncryptionKey }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/ENCRYPTION_KEY/);
  });

  it("requires REDIS_URL for a boot that named no APP_ENV", async () => {
    const { error } = await boot(deployment({ REDIS_URL: undefined }));

    expect(error?.message).toMatch(/REDIS_URL is required outside development/);
  });

  it("gates the credentials outside the entropy list on the same unnamed path", async () => {
    // P2, proven through the schema rather than through a fixture: the zero-entropy
    // `ADMIN_SECRET` and the shipped `minioadmin` pair both reach the gate on a
    // boot that never declared an environment.
    const admin = await boot(deployment({ ADMIN_SECRET: "a".repeat(32) }));
    expect(admin.error?.message).toMatch(/ADMIN_SECRET/);

    const storage = await boot(
      deployment({
        OBJECT_STORAGE_ACCESS_KEY: "minioadmin",
        OBJECT_STORAGE_SECRET_KEY: "minioadmin",
      }),
    );
    expect(storage.error?.message).toMatch(/OBJECT_STORAGE_ACCESS_KEY/);
  });

  it("honours the written opt-in, in both directions", async () => {
    // `APP_ENV=development` spelled out is the one lenient path a deployment can
    // choose, and it still buys the fresh-clone experience: templates through, no
    // Redis required, the storage and mail credentials unchecked.
    const declared = await boot(
      deployment({
        APP_ENV: "development",
        JWT_ACCESS_SECRET: SHIPPED_TEMPLATE_SECRETS[0],
        JWT_REFRESH_SECRET: SHIPPED_TEMPLATE_SECRETS[1],
        ENCRYPTION_KEY: SHIPPED_TEMPLATE_SECRETS[2],
        REDIS_URL: undefined,
        OBJECT_STORAGE_ACCESS_KEY: "minioadmin",
        OBJECT_STORAGE_SECRET_KEY: "minioadmin",
        SMTP_PASSWORD: "password",
      }),
    );

    expect(declared.error).toBeUndefined();
    expect(declared.processEnv.APP_ENV).toBe("development");
    expect(declared.resolved.APP_ENV).toBe("development");
    expect(declared.decisions?.isDevelopment).toBe(true);
    // Unset is still an opt-out in development, and still read as one: no admin
    // header path, and nothing in the gate mistook the absence for a weak value.
    expect(declared.decisions?.adminSecret).toBeUndefined();
    // And the other half of "in both directions": the same fixture with the word
    // spelled `production` boots clean only because the secrets are strong, and its
    // `isDevelopment` is false — the leniency does not travel with the value.
    const named = await boot(
      deployment({ APP_ENV: "production", ADMIN_SECRET: undefined }),
    );
    expect(named.error).toBeUndefined();
    expect(named.decisions?.isDevelopment).toBe(false);
    expect(named.decisions?.isProduction).toBe(true);
  });

  it("carries the guard-credential rule through a development boot", async () => {
    // The one credential rule that does not travel with the lenient branch,
    // asserted through the real schema because the schema is what decides the
    // branch. A development process reachable from a shared network answers
    // `GET /metrics` on this header alone, so `APP_ENV=development` cannot be what
    // makes a zero-entropy secret acceptable — and a fresh clone loses nothing,
    // since `.env.example` ships `ADMIN_SECRET` commented out.
    const weak = await boot(
      deployment({
        APP_ENV: "development",
        ADMIN_SECRET: "a".repeat(32),
        JWT_ACCESS_SECRET: SHIPPED_TEMPLATE_SECRETS[0],
        ENCRYPTION_KEY: SHIPPED_TEMPLATE_SECRETS[2],
        REDIS_URL: undefined,
      }),
    );
    expect(weak.error?.message).toMatch(/ADMIN_SECRET/);
    expect(weak.decisions).toBeUndefined();

    const mfa = await boot(
      deployment({ APP_ENV: "development", JWT_MFA_SECRET: "mfa" }),
    );
    expect(mfa.error?.message).toMatch(/JWT_MFA_SECRET/);

    // Strong values, and omission, all still boot here.
    const fine = await boot(
      deployment({
        APP_ENV: "development",
        ADMIN_SECRET: generatedSecret(),
        JWT_MFA_SECRET: generatedSecret(),
      }),
    );
    expect(fine.error).toBeUndefined();
    expect(fine.decisions?.adminSecret?.length).toBeGreaterThanOrEqual(
      ADMIN_SECRET_MIN_LENGTH,
    );
  });

  it("refuses an APP_ENV outside the list instead of falling back to one", () => {
    // `prod` is the spelling an operator actually types, and it is not on the list:
    // reading it as development was how a whole deployment ended up unlabelled and
    // unchecked. The `.valid()` list refusing it is the same property the removed
    // default needed to keep, so it is asserted here rather than assumed.
    const { error } = ENV_VALIDATION_SCHEMA.validate(
      deployment({ APP_ENV: "prod" }),
      { allowUnknown: true, abortEarly: true },
    );

    expect(error?.message).toMatch(/APP_ENV/);
  });

  it("does not let the NODE_ENV default overwrite a real test run", async () => {
    // The sibling variable the P1 report asked about, measured rather than reasoned
    // about. Two independent mechanisms had to line up for this to be safe: Joi
    // applies a `.default()` only to an `undefined` input, and
    // `@nestjs/config`'s `assignVariablesToProcess` writes back only keys filtered on
    // `!(key in process.env)`. Both are what this case observes — `boot()` deletes
    // `NODE_ENV` from `process.env` first, so the `test` below is the fixture's own
    // declaration arriving through a schema that carries a default, exactly as a
    // container's `production` or jest's `test` does at import time. It is the only
    // reason `isTestEnvironment` can still mean what it says and
    // `src/worker.module.spec.ts` / `src/worker.boot.spec.ts` can still compile.
    const { resolved, processEnv, decisions, error } = await boot(
      deployment({
        NODE_ENV: "test",
        APP_ENV: "production",
        ENCRYPTION_KEY: templateEncryptionKey,
        OBJECT_STORAGE_ACCESS_KEY: "minioadmin",
        OBJECT_STORAGE_SECRET_KEY: "minioadmin",
        ADMIN_SECRET: "a".repeat(32),
      }),
    );

    expect(processEnv.NODE_ENV).toBe("test");
    expect(resolved.NODE_ENV).toBe("test");
    // The hatch is alive: `APP_ENV=production` plus template secrets, unchecked.
    // That this is *true* is the point of the case — a destructive default would make
    // it false, and the whole suite would start refusing fixtures.
    expect(error).toBeUndefined();
    // Read as a decision rather than as a private getter: `isTestEnvironment`
    // compares `process.env.NODE_ENV`, so it was never the resolved config's
    // `NODE_ENV` that the default could have overwritten.
    expect(decisions?.usesRedisThrottlerStorage).toBe(false);
  });

  it("lets the NODE_ENV default fill only an absence, which grants nothing", async () => {
    // The default is non-destructive in the direction that matters: it cannot
    // *produce* the one spelling the leniency reads. With `NODE_ENV` never written it
    // lands on `development` — a value that appears nowhere in `isTestEnvironment`'s
    // comparison — so the same weak `ADMIN_SECRET` that the unnamed boot in this
    // describe refuses is still refused here instead of sliding through the hatch.
    const { resolved, error } = await boot(
      deployment({ ADMIN_SECRET: "a".repeat(32) }),
    );

    expect(resolved.NODE_ENV).toBe("development");
    expect(error?.message).toMatch(/ADMIN_SECRET/);
  });

  it("keeps the NODE_ENV default inside the one accepted list", () => {
    // The shape behind both cases above, asserted declaratively so a future edit
    // cannot quietly widen it: `development` is the only value the default can ever
    // invent, `test` stays admitted because jest owns it and both boot modules are
    // validated at import, and every other spelling is refused by `.valid(...)`.
    const described = ENV_VALIDATION_SCHEMA.describe();
    const injected = described.keys.NODE_ENV.flags?.default as string;

    expect(described.keys.NODE_ENV.allow).toEqual(ACCEPTED_NODE_ENV);
    expect(ACCEPTED_NODE_ENV).toContain(injected);
    // The one spelling the gate's leniency reads is the one a default must never be
    // able to hand out: an unnamed process has to arrive at `development`, which is
    // neither the test hatch nor a refused boot.
    expect(injected).not.toBe("test");
    expect(injected).toBe("development");
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

/**
 * `secretDefect` is now one profile of `credentialDefect`, and the profiles are the
 * reason it exists: the gate reads credentials of three different kinds, and a
 * single floor either refuses a working deployment (an AWS access key ID is twenty
 * characters; a Gmail app password is about 48 bits) or lets a dictionary word
 * through. The denylist is shared by all three, so the taxonomy is only about where
 * the length and entropy floors sit.
 */
describe("credentialDefect", () => {
  it("is the same rule secretDefect always applied, under the key profile", () => {
    for (const value of [
      generatedSecret(),
      "a".repeat(40),
      "x".repeat(31),
      SHIPPED_TEMPLATE_SECRETS[2],
    ]) {
      expect(credentialDefect(value, KEY_MATERIAL)).toBe(secretDefect(value));
    }
  });

  it("refuses the stock MinIO credential under every profile", () => {
    // Whole value, case-folded and untrimmed like the template list. Under the
    // key-material profile the length floor fires first — different message, same
    // refusal — so the denylist itself is asserted where it is the check that
    // actually runs.
    expect(credentialDefect("minioadmin", KEY_MATERIAL)).toMatch(/at least 32/);
    for (const profile of [PASSPHRASE, CREDENTIAL_IDENTIFIER]) {
      for (const spelling of ["minioadmin", "MINIOADMIN", " minioadmin "]) {
        expect(credentialDefect(spelling, profile)).toMatch(
          /default credential/,
        );
      }
    }

    // Never a substring, which is what makes the rule safe to run against a real
    // service account named after the bucket it reads.
    expect(isShippedDefaultCredential("minioadmin-access-key")).toBe(false);
    expect(isShippedDefaultCredential("")).toBe(false);
  });

  it("holds a passphrase to a passphrase's floor", () => {
    expect(PASSPHRASE_MIN_LENGTH).toBe(8);
    expect(PASSPHRASE_MIN_ENTROPY_BITS).toBeLessThan(SECRET_MIN_ENTROPY_BITS);

    // The dictionary case, which is the entire reason the profile exists.
    for (const weak of ["password", "changeme", "12345678", "abc"]) {
      expect(estimateSecretEntropyBits(weak)).toBeLessThan(
        PASSPHRASE_MIN_ENTROPY_BITS,
      );
      expect(credentialDefect(weak, PASSPHRASE)).toBeDefined();
    }

    // The value the recommendation in the rejection message actually produces:
    // sixteen lowercase characters from a provider that issues nothing longer.
    expect(credentialDefect("kmzqvtbjxpdnhswg", PASSPHRASE)).toBeUndefined();
    expect(credentialDefect(generatedSecret(), PASSPHRASE)).toBeUndefined();
  });

  it("refuses only a placeholder in an identifier's slot", () => {
    // Not a secret, so it gets no length or entropy floor — and that is the whole
    // difference between this profile and the other two.
    const identifier = "AKIAIOSFODNN7EXAMPLE";
    expect(estimateSecretEntropyBits(identifier)).toBeLessThan(
      SECRET_MIN_ENTROPY_BITS,
    );
    expect(credentialDefect(identifier, CREDENTIAL_IDENTIFIER)).toBeUndefined();
    expect(
      credentialDefect(
        `${TEMPLATE_SENTINEL_PREFIX}generate${TEMPLATE_SENTINEL_SUFFIX}`,
        CREDENTIAL_IDENTIFIER,
      ),
    ).toMatch(/template/);
    expect(credentialDefect("   ", CREDENTIAL_IDENTIFIER)).toMatch(
      /at least 1 characters/,
    );
  });

  it("never puts the value in the message it writes about the value", () => {
    // These strings reach `logger.error` and an operator's terminal.
    const secretish = generatedSecret();
    expect(credentialDefect("a".repeat(40), KEY_MATERIAL)).not.toContain(
      "aaaa",
    );
    expect(credentialDefect(secretish, PASSPHRASE)).toBeUndefined();
  });
});
