import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "node:crypto";

/**
 * Shorter ADMIN_SECRET values are treated as unset. 32 matches the
 * ENCRYPTION_KEY floor in the Joi schemas.
 */
export const ADMIN_SECRET_MIN_LENGTH = 32;

/**
 * Floor for anything used as key material rather than a passphrase. The same 32
 * the Joi schema already demands of `ENCRYPTION_KEY`, so the two cannot disagree
 * about what "too short" means.
 */
export const SECRET_MIN_LENGTH = 32;

/**
 * Guess-entropy floor for a deployed secret, in bits.
 *
 * Calibrated so that `openssl rand -hex 16` — the shortest thing the
 * recommendation in the rejection message can produce — lands exactly on it, and
 * so that a value which is 32 characters only in *appearance* does not: `a`
 * repeated forty times, or four characters pasted into a row, is one or two
 * symbols wide no matter how far it runs.
 *
 * It bounds the alphabet from the characters the value actually shows, so it is
 * a floor and not a proof — a 44-character base64 run copied out of somebody's
 * blog clears it easily. That is why the exact denylist below carries the real
 * weight and this only backs it up.
 */
export const SECRET_MIN_ENTROPY_BITS = 128;

/**
 * The `NODE_ENV` spellings both boot schemas accept, named in one place so the API
 * (`src/app/app.module.ts`) and the worker (`src/worker.module.ts`) cannot answer
 * the same value differently — which is how a worker started with `NODE_ENV=test`
 * skipped `validateProductionSecrets()` while the API refused to boot on it.
 *
 * Both modules validate `process.env` through `ConfigModule.forRoot` with
 * `allowUnknown`, so a key the schema does not declare passes through unchecked:
 * leaving `NODE_ENV` undeclared made an operator's typo a configuration choice.
 * Naming it here turns anything outside this list into a refused boot. `test` is in
 * the list because jest owns that value and both modules are validated the moment
 * they are imported, and `src/worker.module.spec.ts` / `src/worker.boot.spec.ts`
 * import — and compile — `WorkerModule`. Keeping `test` out would break those
 * suites instead of hardening anything; the leniency it buys is only reachable by
 * spelling the word deliberately.
 */
export const ACCEPTED_NODE_ENV: string[] = [
  "development",
  "production",
  "test",
];

/**
 * Secret values this repository *used* to ship as the `.env.example` template for
 * `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `ENCRYPTION_KEY`. The template now
 * carries the anchored `REPLACE_WITH__…__DO_NOT_SHIP` sentinel (`TEMPLATE_SENTINEL_*`
 * below), which the gate refuses too. Both forms are matched as whole values, never
 * as substrings.
 *
 * Whole values, never substrings. The substring rule this replaced was wrong in
 * both directions at once: it let
 * `your-super-secret-encryption-key-min-32-chars-change-prod` boot a deployment —
 * 57 characters, and it says `change-prod` rather than the
 * `change-in-production` the rule looked for — while it rejected genuinely random
 * keys that happened to contain `xxx`. `ENCRYPTION_KEY` is the bad case: it is the
 * pepper on every stored vault verifier, so shipping it means a published key for
 * the whole table, and the cost of the false rejection was one regenerated string
 * against the cost of the miss being every vault in the database.
 *
 * These three spellings are retired as template values but stay on the denylist:
 * they are in the `.env` of every clone made from the older template, and a value
 * that has already been deployed once is exactly the value that comes back.
 */
export const SHIPPED_TEMPLATE_SECRETS = [
  "your-super-secret-access-token-key-change-in-production",
  "your-super-secret-refresh-token-key-change-in-production",
  "your-super-secret-encryption-key-min-32-chars-change-prod",
] as const;

/**
 * Prefix and suffix of the "generate a value here" sentinel an operator is meant to
 * overwrite — the form `docs/SECURITY.md` recommends and the form `.env.example`
 * ships for those three keys, so the template and the documented recommendation are
 * the same spelling instead of two. The sentence spellings above are still refused:
 * an operator may copy an older template, and a value already deployed once is the
 * value that comes back.
 *
 * Anchored at both ends on purpose, which is the difference between this and the
 * substring rule that was removed: `REPLACE_WITH__` in the middle of a generated
 * key is a coincidence, and one that must not cost an operator a boot. Left in
 * place, the whole value is the template nobody filled in.
 */
export const TEMPLATE_SENTINEL_PREFIX = "REPLACE_WITH__";
export const TEMPLATE_SENTINEL_SUFFIX = "__DO_NOT_SHIP";

const TEMPLATE_SECRETS_EXACT = new Set<string>(
  SHIPPED_TEMPLATE_SECRETS.map((value) => value.trim()),
);

// Case is the one edit an operator makes when they "change" a template value in a
// hurry, and folding it can only ever reject more: a generated key has no reason
// to equal a template string modulo case, so this costs nothing in false
// positives. It is still whole-value equality, which is the property that makes
// the rule safe to run against real keys.
const TEMPLATE_SECRETS_CASE_FOLDED = new Set<string>(
  [...TEMPLATE_SECRETS_EXACT].map((value) => value.toLowerCase()),
);

/**
 * Whether a value is a shipped template or an unfilled sentinel — ignoring case
 * and padding, and only ever as a whole value.
 */
export function isShippedTemplateSecret(value: string): boolean {
  const trimmed = String(value ?? "").trim();
  if (
    TEMPLATE_SECRETS_EXACT.has(trimmed) ||
    TEMPLATE_SECRETS_CASE_FOLDED.has(trimmed.toLowerCase())
  ) {
    return true;
  }
  const folded = trimmed.toLowerCase();
  return (
    folded.startsWith(TEMPLATE_SENTINEL_PREFIX.toLowerCase()) &&
    folded.endsWith(TEMPLATE_SENTINEL_SUFFIX.toLowerCase())
  );
}

/**
 * Bits a value is worth, from the symbols it is actually built from.
 *
 * Never names the value: these strings reach a log and an operator's terminal.
 */
export function estimateSecretEntropyBits(value: string): number {
  const trimmed = String(value ?? "").trim();
  const alphabet = new Set(trimmed).size;
  if (!trimmed || alphabet < 2) {
    return 0;
  }
  return Math.floor(trimmed.length * Math.log2(alphabet));
}

/**
 * A short, stable label for one key, from a digest of it rather than from
 * anything the operator has to remember.
 *
 * This is what a `VaultSetting.masterKeyHashPepper` stamp holds when
 * `ENCRYPTION_KEY_ID` was left unset, and a role word would have been the wrong
 * default: rows written today would say `current`, and the day the key is rotated
 * again that sentence becomes false for every one of them — they would be looked
 * up under the new key, digest mismatch, and the owner would be told their own
 * master password is wrong. A digest prefix belongs to exactly one key forever.
 *
 * Publishing ten hex characters is not publishing the key: the stamp is a label,
 * and anyone holding the table already holds an HMAC to test candidates against.
 */
export function secretFingerprint(secret: string): string {
  return `k${crypto.createHash("sha256").update(secret).digest("hex").slice(0, 10)}`;
}

/**
 * Why a value cannot serve as a deployed key — too short to hold 32 bytes, still
 * the checked-in template, or too narrow an alphabet to be worth 32 bytes — or
 * `undefined` when it can. Pure so the gate and its tests read one rule.
 */
export function secretDefect(value: string): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length < SECRET_MIN_LENGTH) {
    return `must be at least ${SECRET_MIN_LENGTH} characters and is ${trimmed.length}`;
  }
  if (isShippedTemplateSecret(trimmed)) {
    return "is still the value .env.example ships as a template";
  }
  const entropyBits = estimateSecretEntropyBits(trimmed);
  if (entropyBits < SECRET_MIN_ENTROPY_BITS) {
    return (
      `is built from too few distinct characters to be a generated key ` +
      `(about ${entropyBits} bits, floor ${SECRET_MIN_ENTROPY_BITS})`
    );
  }
  return undefined;
}

/**
 * The truthy spellings `SyncIoAdapter` accepts for `WS_CORS_ALLOW_NULL_ORIGIN`
 * (`src/sync/adapters/sync-io.adapter.ts`), restated here because that file does
 * not export its list. The two must stay in step: a spelling this gate does not
 * recognise would let a deployment loosen the socket policy without noticing.
 */
const TRUTHY_SETTINGS = ["true", "1", "yes", "on"];

function isTruthySetting(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  return TRUTHY_SETTINGS.includes(
    String(raw ?? "")
      .trim()
      .toLowerCase(),
  );
}

/**
 * The spellings of a token lifetime this file recognises, in seconds.
 *
 * Deliberately the set `jsonwebtoken` itself reads, and nothing wider: the
 * number returned here is published to clients as the countdown to a refresh
 * and stored as a session's `accessExpiresAt`, so it has to be the *same*
 * duration the library stamps into the token's `exp`. A unit the library does
 * not know — `w` is the one an operator reaches for — is therefore rejected
 * rather than guessed at, because a silent mismatch means a session row that
 * outlives the credential it names.
 */
const LIFETIME_UNIT_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
};

/**
 * Read a `JWT_*_EXPIRATION` value as seconds: a bare number is already seconds,
 * otherwise a number with an optional space and a unit — `"15m"`, `"7d"`,
 * `"2 days"`, `"900"`.
 *
 * Throws on anything else, and the only caller that matters for boot is
 * `validateConfiguration()`, so a value that would otherwise surface as a 500
 * on someone's first login aborts the process instead.
 */
export function parseTokenLifetime(raw: string, variable: string): number {
  const match = String(raw ?? "")
    .trim()
    .match(/^(\d+)\s*([A-Za-z]*)$/);
  const amount = match ? Number(match[1]) : NaN;
  const multiplier = match
    ? match[2] === ""
      ? 1
      : LIFETIME_UNIT_SECONDS[match[2].toLowerCase()]
    : undefined;

  if (!match || !Number.isFinite(amount) || amount <= 0 || !multiplier) {
    throw new Error(
      `${variable}="${raw}" is not a readable token lifetime. Use a number of seconds ("900") or a number with one of s/m/h/d ("15m", "7d", "2 days").`,
    );
  }

  return amount * multiplier;
}

@Injectable()
export class ConfigurationService {
  private readonly logger = new Logger("ConfigurationService");

  constructor(private configService: ConfigService) {
    this.validateConfiguration();
  }

  /**
   * Validate all required configuration is present
   */
  private validateConfiguration(): void {
    const requiredVars = [
      "DATABASE_URL",
      "JWT_ACCESS_SECRET",
      "JWT_REFRESH_SECRET",
      "OBJECT_STORAGE_ENDPOINT",
      "OBJECT_STORAGE_ACCESS_KEY",
      "OBJECT_STORAGE_SECRET_KEY",
      "OBJECT_STORAGE_BUCKET",
      "ENCRYPTION_KEY",
    ];

    const missing = requiredVars.filter(
      (variable) => !this.configService.get(variable),
    );

    if (missing.length > 0) {
      const message = `Missing required environment variables: ${missing.join(", ")}`;
      this.logger.error(message);
      throw new Error(message);
    }

    // `ENCRYPTION_KEY` is also the pepper `VaultSettingsService` HMACs every
    // stored master-key verifier with, so a template value here is not a weak
    // default — it is the key that makes a single database read enough to crack
    // every vault offline. It is checked in every environment that has not said
    // out loud that it is development or a test run, because a deployment that
    // forgot to declare `APP_ENV` is the exact case this gate has to catch. The
    // rotation window is the same rule, so `ENCRYPTION_KEY_PREVIOUS` is checked
    // with it rather than around it.
    if (!this.isLocalDevelopment && !this.isTestEnvironment) {
      this.validateProductionSecrets();

      // A deployed process that never named its Redis counts its rate limits
      // against the `redis://localhost:6379` fallback below — nothing listens
      // there inside a container, since `docker-compose.prod.yml` publishes no
      // ports at all and Redis is only the `redis` service on the compose network.
      // `RedisThrottlerStorage.increment` then counts each request in its own
      // bounded in-process window: the allowance is per replica, and a restart
      // resets it mid-flight. Better than fail-open, still not enforcement.
      if (!this.declaredRedisUrl) {
        throw new Error(
          "REDIS_URL is required outside development: it is where the rate-limit counters live. Use redis://:<password>@<host>:6379",
        );
      }
    }

    // Both lifetimes are parsed here even though nothing reads the seconds until
    // a login happens. `JWT_*_EXPIRATION` had to become a setting that works
    // when someone changed it, and a value `jsonwebtoken` would reject is a far
    // worse surprise at boot than it is on the first sign-in attempt — where it
    // would land as a 500 for a user who did nothing wrong.
    parseTokenLifetime(this.jwtAccessExpiration, "JWT_ACCESS_EXPIRATION");
    parseTokenLifetime(this.jwtRefreshExpiration, "JWT_REFRESH_EXPIRATION");

    this.logger.log("✓ All required configuration variables are present");
  }

  /**
   * Refuse key material that is still the checked-in template, and refuse the
   * transports that were only ever closed by an operator's own hand.
   *
   * The name says "production" because that is what the audit called it and what
   * the docs point at; the gate that calls it no longer does. `TOTP_ENCRYPTION_KEY`
   * is not in this list because no such variable exists in `.env.example`, in the
   * Joi schema, or anywhere in `src/` — TOTP secrets are sealed with
   * `ENCRYPTION_KEY`, which is checked here.
   */
  private validateProductionSecrets(): void {
    // Optional, so it enters the list only when it is set. A rotation window that
    // is *half*-configured is worse than no window: an operator who pastes the
    // template into `ENCRYPTION_KEY_PREVIOUS` believes they have kept the old rows
    // readable and has in fact added a second key anyone can guess.
    const previousEncryptionKey = this.encryptionKeyPrevious;

    const secrets: ReadonlyArray<readonly [string, string]> = [
      ["JWT_ACCESS_SECRET", this.jwtAccessSecret],
      ["JWT_REFRESH_SECRET", this.jwtRefreshSecret],
      ["ENCRYPTION_KEY", this.encryptionKey],
      ...(previousEncryptionKey
        ? [["ENCRYPTION_KEY_PREVIOUS", previousEncryptionKey] as const]
        : []),
    ];

    for (const [variable, value] of secrets) {
      const defect = secretDefect(value);
      if (defect) {
        throw new Error(
          `${variable} ${defect}. Generate one with \`openssl rand -base64 48\` and keep it out of the repository.`,
        );
      }
    }

    // A shared access/refresh secret means a token signed for one purpose
    // verifies against the other, which no amount of key length fixes.
    if (this.jwtAccessSecret === this.jwtRefreshSecret) {
      throw new Error(
        "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different outside development",
      );
    }

    // Two names for one secret is a rotation that did not happen, and the ring
    // would then answer every row on the first entry while the second keeps a
    // key that seals nothing.
    if (previousEncryptionKey && previousEncryptionKey === this.encryptionKey) {
      throw new Error(
        "ENCRYPTION_KEY_PREVIOUS must be the key ENCRYPTION_KEY replaced, not the same value again",
      );
    }

    // The stamp is the whole lookup: a row whose pepper id matches another entry's
    // would be verified against the wrong secret and refuse its real master
    // password. Declared ids collide far more easily than fingerprints do.
    if (
      previousEncryptionKey &&
      this.encryptionKeyId === this.encryptionKeyPreviousId
    ) {
      throw new Error(
        "ENCRYPTION_KEY_ID and ENCRYPTION_KEY_PREVIOUS_ID must be different: every row sealed under the retired key would be read under the wrong one",
      );
    }

    const origins = [
      this.configService.get<string>("CORS_ORIGIN", ""),
      this.configService.get<string>("CORS_ORIGINS", ""),
      this.configService.get<string>("WS_CORS_ORIGINS", ""),
    ];
    if (
      origins.some((value) =>
        value
          .split(",")
          .map((v) => v.trim())
          .includes("*"),
      )
    ) {
      throw new Error(
        "Wildcard CORS origins are forbidden outside development; list each trusted origin explicitly",
      );
    }

    // The HTTP allow-list and the socket's null-origin escape hatch loosen the
    // same policy, so they are gated together: a deployment can pass the
    // wildcard check and still be accepting opaque-origin sockets.
    if (
      isTruthySetting(
        this.configService.get<string>("WS_CORS_ALLOW_NULL_ORIGIN", ""),
      )
    ) {
      throw new Error(
        "WS_CORS_ALLOW_NULL_ORIGIN must stay false outside development; name the client's origin in WS_CORS_ORIGINS instead",
      );
    }
  }

  // ========================================================================
  // Application Configuration
  // ========================================================================

  get appEnv(): string {
    return this.configService.get("APP_ENV", "development");
  }

  /**
   * `APP_ENV` exactly as written, with no default.
   *
   * `appEnv` above answers "development" when the variable is unset, and that
   * silent default is what made the secret gate skippable by omission: a host
   * that never declared an environment — or typo'd it as `prod` — got the
   * development behaviour. The default stays for display, but every decision
   * below reads this instead, so opting out of a hardened path has to be written
   * down. The values this returns are compared lowercased and trimmed, so
   * `Production` and `production` are the same environment here as they are in
   * the Joi schema.
   */
  private get declaredAppEnv(): string | undefined {
    const raw = this.configService.get<string>("APP_ENV");
    const trimmed = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    return trimmed || undefined;
  }

  /**
   * Local development is an opt-in, not an absence: say `APP_ENV=development`.
   *
   * The one environment in which the template secrets above are allowed through,
   * and deliberately so — a first `git clone` and `npm run start:dev` against a
   * throwaway mongod should not need a key ceremony. Nothing in `src/` widens
   * this path: `staging`, a typo, and an unset `APP_ENV` all take the strict
   * branch.
   */
  private get isLocalDevelopment(): boolean {
    return this.declaredAppEnv === "development";
  }

  /**
   * Unit and e2e suites build this service from fixtures, so they keep the
   * leniency a fixture depends on. `NODE_ENV` is the signal the repo already
   * uses for it (`CustomThrottlerGuard.disabledByDefault`) and jest sets it itself.
   *
   * Neither boot process reaches this by accident now: both schemas declare
   * `NODE_ENV` against the one list `ACCEPTED_NODE_ENV`, so a foreign value — a
   * typo, a host's `NODE_ENV=staging` — aborts the worker exactly where it always
   * aborted the API, instead of sliding through `allowUnknown` and switching the
   * secret gate off in one process but not the other.
   *
   * `test` is in the admitted list, so a container can still reach this path by
   * spelling it out: that is the price of the suites, not an oversight. Both boot
   * modules validate `process.env` the moment they are imported and jest owns the
   * value `test` by then, and `@nestjs/config` reports a schema failure as a
   * rejected `forRoot` that `Test.createTestingModule().compile()` turns into a boot
   * error — which is what `src/worker.module.spec.ts` and `src/worker.boot.spec.ts`
   * would hit. `APP_ENV` remains the deployment's own signal, validated to
   * `development`/`staging`/`production` in both schemas and never admitting `test`.
   */
  private get isTestEnvironment(): boolean {
    return this.declaredAppEnv === "test" || process.env.NODE_ENV === "test";
  }

  get appPort(): number {
    return Number(process.env.PORT) || this.configService.get("APP_PORT", 3000);
  }

  get appUrl(): string {
    return this.configService.get<string>("APP_URL", "http://localhost:3000");
  }

  get isProduction(): boolean {
    return this.declaredAppEnv === "production";
  }

  /**
   * Explicit `APP_ENV=development` only. `LoggerService` reads this to decide
   * whether to attach a stack trace to an error response, so a host that never
   * declared its environment used to be treated as development and leak one —
   * the same skippable-by-omission default the secret gate now refuses.
   */
  get isDevelopment(): boolean {
    return this.isLocalDevelopment;
  }

  // ========================================================================
  // Database Configuration
  // ========================================================================

  get databaseUrl(): string {
    return this.configService.getOrThrow<string>("DATABASE_URL");
  }

  // ========================================================================
  // Optional infrastructure configuration
  // ========================================================================

  /**
   * `REDIS_URL` exactly as written, or `undefined` when nobody set it.
   *
   * `redisUrl` below cannot answer the question because it substitutes a local
   * server, which is the right answer for a laptop and the wrong one for a
   * container.
   */
  private get declaredRedisUrl(): string | undefined {
    const raw = this.configService.get<string>("REDIS_URL");
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed || undefined;
  }

  get redisUrl(): string {
    return this.declaredRedisUrl ?? "redis://localhost:6379";
  }

  get smtpHost(): string {
    return this.configService.get<string>("SMTP_HOST")?.trim() || "";
  }

  get smtpPort(): number {
    const port = Number(this.configService.get("SMTP_PORT", 587));
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 587;
  }

  get smtpUser(): string {
    return this.configService.get<string>("SMTP_USER")?.trim() || "";
  }

  get smtpPassword(): string {
    return this.configService.get<string>("SMTP_PASSWORD") || "";
  }

  /** `true` requires STARTTLS on port 587, or implicit TLS on port 465. */
  get smtpTls(): boolean {
    return isTruthySetting(this.configService.get("SMTP_TLS", true));
  }

  get emailFrom(): string {
    return this.configService.get<string>("SMTP_FROM")?.trim() || "";
  }

  get emailVerifyEnabled(): boolean {
    const raw = this.configService.get("EMAIL_VERIFY_ENABLED", true);
    if (typeof raw === "boolean") return raw;
    return String(raw).toLowerCase() === "true";
  }

  get emailVerifyTokenExpiry(): string {
    return this.configService.get<string>("EMAIL_VERIFY_TOKEN_EXPIRY", "24h");
  }

  // ========================================================================
  // JWT Configuration
  // ========================================================================

  get jwtAccessSecret(): string {
    return this.configService.getOrThrow<string>("JWT_ACCESS_SECRET");
  }

  get jwtMfaSecret(): string {
    const custom = this.configService.get<string>("JWT_MFA_SECRET")?.trim();
    if (custom) return custom;
    return crypto
      .createHmac("sha256", this.jwtAccessSecret)
      .update("allinone:mfa:challenge:secret")
      .digest("hex");
  }

  /**
   * A cleared setting means "not set" here, the way a blank `GEMINI_API_KEY` and
   * a blank `ADMIN_SECRET` do: an operator who empties a value is opting out of
   * it, not asking the process to abort at boot. Reading the `ConfigService`
   * fallback argument alone would not be enough, because `get("X", "15m")` hands
   * back `""` for `X=` — and a lifetime of `""` is a value this file cannot
   * parse, so clearing the variable would have been fatal.
   */
  private lifetimeOr(variable: string, fallback: string): string {
    const raw = this.configService.get<string>(variable);
    return raw && raw.trim() ? raw.trim() : fallback;
  }

  get jwtAccessExpiration(): string {
    return this.lifetimeOr("JWT_ACCESS_EXPIRATION", "15m");
  }

  get jwtRefreshSecret(): string {
    return this.configService.getOrThrow<string>("JWT_REFRESH_SECRET");
  }

  get jwtRefreshExpiration(): string {
    return this.lifetimeOr("JWT_REFRESH_EXPIRATION", "7d");
  }

  /**
   * The same two lifetimes in seconds, for the places that cannot take a
   * duration string: `expiresIn` in the login response, which is a number a
   * client counts down, and the `accessExpiresAt` / `refreshExpiresAt` columns
   * on `Session`.
   *
   * These exist because the string form alone is not enough. The literals they
   * replaced — `900`, `15 * 60 * 1000`, `7 * 24 * 60 * 60 * 1000` in
   * `src/auth` — were correct only while the environment said `15m` and `7d`,
   * so `JWT_ACCESS_EXPIRATION` was a variable that appeared in `.env.example`
   * and both Joi schemas and changed nothing it was set to.
   */
  get jwtAccessExpiresInSeconds(): number {
    return parseTokenLifetime(
      this.jwtAccessExpiration,
      "JWT_ACCESS_EXPIRATION",
    );
  }

  get jwtRefreshExpiresInSeconds(): number {
    return parseTokenLifetime(
      this.jwtRefreshExpiration,
      "JWT_REFRESH_EXPIRATION",
    );
  }

  // ========================================================================
  // Object Storage Configuration
  // ========================================================================

  get objectStorageEndpoint(): string {
    return this.configService.getOrThrow<string>("OBJECT_STORAGE_ENDPOINT");
  }

  get objectStorageRegion(): string {
    return this.configService.get<string>("OBJECT_STORAGE_REGION", "us-east-1");
  }

  get objectStorageBucket(): string {
    return this.configService.getOrThrow<string>("OBJECT_STORAGE_BUCKET");
  }

  get objectStorageAccessKey(): string {
    return this.configService.getOrThrow<string>("OBJECT_STORAGE_ACCESS_KEY");
  }

  get objectStorageSecretKey(): string {
    return this.configService.getOrThrow<string>("OBJECT_STORAGE_SECRET_KEY");
  }

  get objectStorageUseSsl(): boolean {
    return this.configService.get<boolean>("OBJECT_STORAGE_USE_SSL", false);
  }

  // ========================================================================
  // Encryption Configuration
  // ========================================================================

  /**
   * This value is the verifier pepper, not just an AES key:
   * `VaultSettingsService` HMACs every `masterKeyHash` stored on a `VaultSetting`
   * row with it, and compares an unlock against that digest. So changing it was
   * never a no-op — the bare verifier is not stored anywhere, which meant the
   * rows sealed under the old value could only be converted on an unlock the old
   * value was precisely what refused.
   *
   * That trap is why rotation is a two-variable operation. Set
   * `ENCRYPTION_KEY_PREVIOUS` to the value being retired *before* changing
   * `ENCRYPTION_KEY`, and the vault keeps both keys in its ring: an old row still
   * opens, and is re-sealed under the new key as it unlocks. Once every vault has
   * unlocked at least once, clear the previous variable again — leaving it set
   * keeps a retired key live in the environment. No migration script is involved,
   * because there is nothing offline to migrate.
   */
  get encryptionKey(): string {
    return this.configService.getOrThrow<string>("ENCRYPTION_KEY");
  }

  /**
   * The name stamped on every row `encryptionKey` seals. Optional: the default is
   * a fingerprint of the key, which is what makes the stamp survive a second
   * rotation.
   */
  get encryptionKeyId(): string {
    return (
      this.configService.get<string>("ENCRYPTION_KEY_ID")?.trim() ||
      secretFingerprint(this.encryptionKey)
    );
  }

  /**
   * The key retired by the current `ENCRYPTION_KEY`, kept only while rows sealed
   * under it may still unlock.
   *
   * Absent is the steady state and not a misconfiguration: a deployment that has
   * never rotated, or whose last rotation has fully drained, has exactly one
   * pepper. While this is set the vault tries two keys, so it is a window and not
   * a permanent second secret.
   */
  get encryptionKeyPrevious(): string | undefined {
    return (
      this.configService.get<string>("ENCRYPTION_KEY_PREVIOUS")?.trim() ||
      undefined
    );
  }

  /**
   * The name rows sealed under `encryptionKeyPrevious` carry. Undefined with the
   * key it names, so nothing in the vault builds a ring entry that holds no
   * secret.
   */
  get encryptionKeyPreviousId(): string | undefined {
    const previous = this.encryptionKeyPrevious;
    if (!previous) {
      return undefined;
    }
    return (
      this.configService.get<string>("ENCRYPTION_KEY_PREVIOUS_ID")?.trim() ||
      secretFingerprint(previous)
    );
  }

  // ========================================================================
  // Admin Access Configuration
  // These three values are the whole of the /admin allow-list. They are
  // deliberately optional and hold NO defaults: unset or blank means that
  // mechanism admits nobody, so admin access has to be opted into by the
  // operator. Never seed a working address here.
  // ========================================================================

  get adminEmails(): string[] {
    return this.commaSeparatedList("ADMIN_EMAILS").map((email) =>
      email.toLowerCase(),
    );
  }

  get adminUserIds(): string[] {
    return this.commaSeparatedList("ADMIN_USER_IDS");
  }

  /**
   * Shared secret behind the `x-admin-secret` header. Undefined — i.e. the
   * header path disabled — unless it is present and at least
   * ADMIN_SECRET_MIN_LENGTH characters long.
   */
  get adminSecret(): string | undefined {
    const raw = this.configService.get<string>("ADMIN_SECRET")?.trim();
    if (!raw || raw.length < ADMIN_SECRET_MIN_LENGTH) {
      return undefined;
    }
    return raw;
  }

  private commaSeparatedList(key: string): string[] {
    const raw = this.configService.get<string>(key);
    if (!raw) {
      return [];
    }
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  // ========================================================================
  // Rate Limiting Configuration
  // ========================================================================

  get rateLimitWindowMs(): number {
    return this.configService.get("RATE_LIMIT_WINDOW_MS", 60000);
  }

  get rateLimitMaxRequests(): number {
    return this.configService.get("RATE_LIMIT_MAX_REQUESTS", 100);
  }

  /**
   * Whether rate-limit counters live in Redis rather than in this process.
   *
   * The library's in-memory storage is per-worker and per-boot: two API replicas
   * each hand out the full allowance, a restart wipes every counter mid-window,
   * and the block a login flood earned is gone with the pod. That is what
   * `RedisThrottlerStorage` is for.
   *
   * Jest is the one place it stays in memory. The e2e suites build this graph with
   * no Redis running, and an `ioredis` client with `lazyConnect` opens its socket
   * on the first command — so a single throttled request in a suite would try to
   * reach a server that is not there and land in the storage's "Redis failed,
   * permit the request" path, which is the wrong answer to assert against.
   * `NODE_ENV=test` is the same signal `CustomThrottlerGuard.disabledByDefault`
   * reads, and both boot schemas admit it from the one list `ACCEPTED_NODE_ENV` —
   * what they refuse is every other spelling, in either process. A container that
   * wanted to land here would have to name the test environment deliberately, while
   * `APP_ENV`, validated to `development`, `staging` and `production` in both
   * schemas, stays the signal a deployment actually sets and never admits `test`.
   *
   * A laptop that named no Redis is the other in-memory case, and it is a
   * convenience rather than a hole: `validateConfiguration()` refuses the same
   * omission in every environment that is not development or a test run, so the
   * only process that can reach this branch and have no counters server is one a
   * person is sitting at.
   */
  get usesRedisThrottlerStorage(): boolean {
    if (this.isTestEnvironment) {
      return false;
    }
    if (this.isLocalDevelopment) {
      return this.declaredRedisUrl !== undefined;
    }
    return true;
  }

  // ========================================================================
  // Logging Configuration
  // ========================================================================

  get logFormat(): "json" | "simple" {
    return this.configService.get("LOG_FORMAT", "json");
  }

  get logLevel(): string {
    return this.configService.get("LOG_LEVEL", "debug");
  }

  get logOutput(): string {
    return this.configService.get("LOG_OUTPUT", "console");
  }

  // ========================================================================
  // Monitoring Configuration
  // ========================================================================

  get metricsEnabled(): boolean {
    return this.configService.get("METRICS_ENABLED", true);
  }

  // ========================================================================
  // OpenTelemetry Configuration
  // ========================================================================

  get otelEnabled(): boolean {
    return this.configService.get("OTEL_ENABLED", false);
  }

  get otelExporterOtlpEndpoint(): string | undefined {
    return this.configService.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  }

  // ========================================================================
  // Backup Configuration
  // ========================================================================

  get backupEnabled(): boolean {
    return this.configService.get("BACKUP_ENABLED", true);
  }

  get backupSchedule(): string {
    return this.configService.get("BACKUP_SCHEDULE", "0 2 * * *");
  }

  get backupRetentionDays(): number {
    return this.configService.get("BACKUP_RETENTION_DAYS", 30);
  }
}
