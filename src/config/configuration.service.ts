import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "node:crypto";

/**
 * Shorter ADMIN_SECRET values are treated as unset. 32 matches the
 * ENCRYPTION_KEY floor in the Joi schemas.
 */
export const ADMIN_SECRET_MIN_LENGTH = 32;

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

    // Both lifetimes are parsed here even though nothing reads the seconds until
    // a login happens. `JWT_*_EXPIRATION` had to become a setting that works
    // when someone changed it, and a value `jsonwebtoken` would reject is a far
    // worse surprise at boot than it is on the first sign-in attempt — where it
    // would land as a 500 for a user who did nothing wrong.
    parseTokenLifetime(this.jwtAccessExpiration, "JWT_ACCESS_EXPIRATION");
    parseTokenLifetime(this.jwtRefreshExpiration, "JWT_REFRESH_EXPIRATION");

    this.logger.log("✓ All required configuration variables are present");
  }

  // ========================================================================
  // Application Configuration
  // ========================================================================

  get appEnv(): string {
    return this.configService.get("APP_ENV", "development");
  }

  get appPort(): number {
    return this.configService.get("APP_PORT", 3000);
  }

  get appUrl(): string {
    return this.configService.get<string>("APP_URL", "http://localhost:3000");
  }

  get isProduction(): boolean {
    return this.appEnv === "production";
  }

  get isDevelopment(): boolean {
    return this.appEnv === "development";
  }

  // ========================================================================
  // Database Configuration
  // ========================================================================

  get databaseUrl(): string {
    return this.configService.getOrThrow<string>("DATABASE_URL");
  }

  // ========================================================================
  // Legacy optional infrastructure configuration
  // These accessors remain for inactive mail/Redis helper modules. The API
  // itself no longer initializes either service.
  // ========================================================================

  get redisUrl(): string {
    return this.configService.get<string>(
      "REDIS_URL",
      "redis://localhost:6379",
    );
  }

  get smtpHost(): string {
    return this.configService.get<string>("SMTP_HOST", "localhost");
  }

  get smtpPort(): number {
    // Env vars are always strings — coerce so nodemailer gets a real number.
    return Number(this.configService.get("SMTP_PORT", 1025));
  }

  get smtpUser(): string | undefined {
    return this.configService.get<string>("SMTP_USER");
  }

  get smtpPassword(): string | undefined {
    return this.configService.get<string>("SMTP_PASSWORD");
  }

  get smtpFrom(): string {
    return this.configService.get<string>("SMTP_FROM", "no-reply@localhost");
  }

  get smtpTls(): boolean {
    // Env vars are always strings — the string "false" is truthy, so compare.
    const raw = this.configService.get("SMTP_TLS", false);
    if (typeof raw === "boolean") return raw;
    return String(raw).toLowerCase() === "true";
  }

  get emailVerifyEnabled(): boolean {
    const raw = this.configService.get("EMAIL_VERIFY_ENABLED", false);
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

  get encryptionKey(): string {
    return this.configService.getOrThrow<string>("ENCRYPTION_KEY");
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

  get prometheusPort(): number {
    return this.configService.get("PROMETHEUS_PORT", 9090);
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

  // ========================================================================
  // OAuth Configuration
  // ========================================================================

  get googleClientId(): string | undefined {
    return (
      this.configService.get<string>("GOOGLE_CLIENT_ID")?.trim() ||
      this.configService.get<string>("OAUTH_GOOGLE_CLIENT_ID")?.trim() ||
      undefined
    );
  }

  get appleClientId(): string | undefined {
    return (
      this.configService.get<string>("APPLE_CLIENT_ID")?.trim() ||
      this.configService.get<string>("OAUTH_APPLE_CLIENT_ID")?.trim() ||
      undefined
    );
  }

  get microsoftClientId(): string | undefined {
    return (
      this.configService.get<string>("MICROSOFT_CLIENT_ID")?.trim() ||
      this.configService.get<string>("OAUTH_MICROSOFT_CLIENT_ID")?.trim() ||
      undefined
    );
  }

  // ========================================================================
  // AI Summarization (Google Gemini) Configuration
  // All three are optional. Each mirrors how GeminiClient reads the same key
  // (src/ai/gemini.client.ts), which still applies its own fallbacks: a missing
  // or blank key means "not configured" — AiService then answers from its local
  // heuristics and no request is sent. Note that GeminiClient injects
  // ConfigService directly today, so nothing in src/ai consumes these getters.
  // ========================================================================

  get geminiApiKey(): string | undefined {
    const raw = this.configService.get<string>("GEMINI_API_KEY")?.trim();
    if (!raw) {
      return undefined;
    }
    return raw;
  }

  get geminiModel(): string {
    return this.configService.get<string>("GEMINI_MODEL", "gemini-1.5-flash");
  }

  get geminiTimeoutMs(): number {
    // Env vars are always strings — coerce so the deadline is a real number.
    return Number(this.configService.get("GEMINI_TIMEOUT_MS", 5000));
  }
}
