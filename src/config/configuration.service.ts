import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

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
    return this.configService.get<string>("REDIS_URL", "redis://localhost:6379");
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
    return this.configService.get<string>(
      "EMAIL_VERIFY_TOKEN_EXPIRY",
      "24h",
    );
  }

  // ========================================================================
  // JWT Configuration
  // ========================================================================

  get jwtAccessSecret(): string {
    return this.configService.getOrThrow<string>("JWT_ACCESS_SECRET");
  }

  get jwtAccessExpiration(): string {
    return this.configService.get<string>("JWT_ACCESS_EXPIRATION", "15m");
  }

  get jwtRefreshSecret(): string {
    return this.configService.getOrThrow<string>("JWT_REFRESH_SECRET");
  }

  get jwtRefreshExpiration(): string {
    return this.configService.get<string>("JWT_REFRESH_EXPIRATION", "7d");
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
    return this.configService.get("GOOGLE_CLIENT_ID");
  }

  get appleClientId(): string | undefined {
    return this.configService.get("APPLE_CLIENT_ID");
  }

  get microsoftClientId(): string | undefined {
    return this.configService.get("MICROSOFT_CLIENT_ID");
  }
}
