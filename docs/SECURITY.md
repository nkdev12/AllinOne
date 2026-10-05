# Allinone Backend — Security Guidelines

This document outlines security practices and threat models for the Allinone backend.

## Security Principles

1. **Data integrity > Security > Correctness > Reliability > Maintainability > Performance**
2. Never silently lose user data
3. Never expose sensitive data in logs
4. Fail securely — default to denial
5. Defense in depth — multiple layers
6. Zero-knowledge where practical
7. Principle of least privilege

## Authentication Security

### Password Requirements

- Minimum 8 characters
- Should contain uppercase, lowercase, numbers, special characters
- Hashed with Argon2id (not bcrypt or PBKDF2)
- Never stored in plaintext
- Never logged
- Never sent in plain HTTP (always HTTPS in production)

### Session Management (Hybrid Model)

- **Access Tokens**: Short-lived (15 minutes). Issued in the response body payload; retained client-side in memory (or OS Keychain/Keystore on mobile/desktop) and sent via `Authorization: Bearer <token>` on all protected API requests.
- **Refresh Tokens**: Long-lived (7 days). Stored in a hardened, `httpOnly; Secure; SameSite=Strict` cookie scoped strictly to `/auth/refresh` (preventing JavaScript access and XSS theft). Also supplied in the JSON payload for native non-cookie mobile/desktop clients.
- **Token Rotation**: Every call to `/auth/refresh` re-points the session row at a new access/refresh pair, so the refresh token it consumed no longer resolves.
- **Session Tracking**: Sessions live in MongoDB as `Session` rows, bound to a `Device` and a `User`. The id is generated in code and the tokens minted at sign-up, sign-in, OAuth sign-in and MFA completion all carry it as `sessionId` — which is only possible because the id exists before the row is written. (Passkey verification used to mint tokens here too; that endpoint is removed, see `API_REFERENCE.md` §20.)
- **Revocation & Logout**: `POST /auth/logout` sets `revokedAt` on the session the calling token names. `JwtStrategy` then reads that row on **every** authenticated request and rejects with `401 SESSION_REVOKED` when it is missing, revoked, or owned by a different account — so logging out takes effect on the next request rather than whenever the 15-minute access token happens to expire. Tokens that carry no `sessionId` (minted before the claim existed) skip the check.
- **Cost**: that check is one indexed `Session` lookup per authenticated request, with nothing cached in front of it. If it ever shows up in latency numbers, the answer is a short-TTL revocation cache — not dropping the check, which would put the revocation window back to the token lifetime.
- **Idempotency & Rate Limiting**: Refresh endpoints are rate-limited (10 req/min) to prevent token brute-forcing.

### MFA Implementation

- TOTP (Time-based One-Time Password)
- Recovery codes (10 codes, single-use, atomic redemption via database transaction preventing double-spend race conditions)
- Backup MFA method required
- Recovery codes printed and stored safely
- Never logged or exposed
- **Dual-Factor Enforcement on MFA Disable**: Disabling MFA strictly requires the primary factor (account password) **AND** the second factor (valid TOTP code or single-use recovery code). A single factor alone cannot disable 2FA.

### Account Lockout & Credential-Stuffing Defense

- **Lockout Threshold**: 5 consecutive failed password attempts automatically lock the user account.
- **Lockout Duration**: 15 minutes (`lockedUntil = Date.now() + 15 * 60 * 1000`).
- **Response Behavior**: Subsequent login requests while locked are rejected with HTTP 401: `"Account is temporarily locked due to multiple failed login attempts. Please try again in X minute(s)."` (password verification is skipped to conserve server CPU).
- **Audit & SIEM Logging**: Lock triggers an immutable `AuditAction.ACCOUNT_LOCKED` audit log event recording IP address, user agent, and timestamp.
- **Auto-Reset on Success**: Valid authentication resets `failedLoginAttempts = 0` and clears `lockedUntil = null`.
- **Administrative Incident Response**: Support/Security administrators can proactively unlock locked accounts via `POST /admin/users/:userId/unlock`, logging `AuditAction.ACCOUNT_UNLOCKED`.

### OAuth 2.0 & OpenID Connect Signature Verification

- **Google**: ID tokens verified cryptographically via `google-auth-library` (`OAuth2Client.verifyIdToken`) with audience and email verification.
- **Apple**: ID tokens verified against Apple's live JWKS (`https://appleid.apple.com/auth/keys`) verifying RS256 signature, `iss: https://appleid.apple.com`, and `aud: APPLE_CLIENT_ID`.
- **Microsoft**: ID tokens verified against Microsoft's live JWKS (`https://login.microsoftonline.com/common/discovery/v2.0/keys`) verifying RS256 signature, Microsoft issuer, and `aud: MICROSOFT_CLIENT_ID`.
- Tokens are never accepted via unverified decoding. All signing keys are fetched via HTTPS with in-memory caching.

### Vault and Sync Trust Models

- **Password vault (`VaultModule` + the `vault_item` oplog)**: entry content is encrypted on the client with AES-256-GCM and reaches the server only as opaque `encryptedData` / `iv` / `authTag`. The master password never crosses the network; the server stores its Argon2id verifier.
- **This is not zero-knowledge.** To make a forgotten master password recoverable, `VaultSetting.recoveryKey` is stored in plaintext next to `wrappedMasterKey`. Anyone with database read access can unwrap that user's master key and open every entry. Treat vault data as server-readable for threat modelling, access reviews and any future export or admin feature; recovery was kept deliberately, as an explicit product trade-off.
- **Argon2id parameters are pinned client-side** at `m=65536 KiB, t=3, p=4, hashLength=32`. The client reports `t` and `m` on vault setup and on recovery, so `VaultSetting.kdfIterations` / `kdfMemory` describe the vault under them, but they are a record only: no server code reads them to configure a KDF, and a request that omits them stores the shipped client's values. Rows written before that report carries `kdfIterations: 100000`, which matched no vault. Each blob seals a `_kdf` marker with its own `format` number and its own parameters; a client that sees a higher format refuses to open it rather than reporting a wrong password.
- **Sync payloads**: transport and at-rest protection only — the server stores plaintext JSON for `note`, `task` and `event`. Conflict handling is version-based rejection, not a merge: an inbound change with `clientVersion < serverVersion` is refused whole, reported in `conflicts` with the stored payload, and the client decides what to keep. No server-side code merges or inspects any field of a `vault_item` blob.
- **How long that plaintext sits in the database**: a `Change` row is pruned by the hourly `cleanup-expired` maintenance job at 30 days (`CHANGE_RETENTION_DAYS`), **and not one row earlier than a live device has read past**. The prune is bounded per user by the oldest `lastPulledCursor` among that user's non-revoked devices, so a laptop that has not synced in 90 days holds the entire log open for 90 days — every title and body in it stays readable to whoever has database access, with no age at which the retention window wins. Revoking the device releases it; the next run deletes those rows. So "plaintext for 30 days" is the floor, never the ceiling, and the number that says which one you are in is `heldBackForIdleDevices` in that job's result (ARCHITECTURE.md §3 has where it is observable).

## Authorization Security

### Ownership Verification

Every resource access must verify ownership:

```typescript
// ❌ WRONG
async getNoteById(noteId: string) {
  return this.prisma.note.findUnique({ where: { id: noteId } });
}

// ✅ CORRECT
async getNoteById(userId: string, noteId: string) {
  const note = await this.prisma.note.findUnique({ where: { id: noteId } });
  if (!note || note.userId !== userId) {
    throw new ForbiddenException('Access denied');
  }
  return note;
}
```

### Authorization Checks

- Every endpoint must authenticate the user
- Every data access must check ownership
- Never trust client-provided userId or accountId
- Use database foreign keys + constraints
- Use row-level security where applicable

### IDOR Prevention

- Test all routes with different users
- No sequential IDs in public API
- Use UUIDs for all public identifiers
- Verify ownership at service layer AND database layer

## Data Protection

### Encryption at Rest

**Sensitive fields:**

- Passwords (hashed with Argon2id)
- MFA secrets (encrypted)
- Recovery codes (encrypted)
- Vault contents (encrypted)
- Vault recovery material (`VaultSetting.recoveryKey` + `wrappedMasterKey`) — **stored in plaintext** so recovery works; it decrypts the vault (see "Vault and Sync Trust Models")
- OAuth tokens (encrypted)

**Storage:**

- Database column encryption
- Backup encryption
- Object storage encryption

### Encryption in Transit

- HTTPS only (TLS 1.2+) in production
- HTTP only for local development
- Certificate validation
- HSTS header enabled

### Encryption Keys Management

- Keys stored in environment variables
- Never hardcoded
- Never logged
- Regular rotation (plan for key rotation)
- Per-entity keys where possible (envelope encryption)

## Input Validation

### Data Validation

```typescript
// src/notes/dto/create-note.dto.ts — verbatim except the @ApiProperty blocks
export class CreateNoteDto {
  @IsString()
  @IsNotEmpty()
  title!: string; // no length cap

  @IsOptional()
  @IsString()
  content?: string; // no length cap

  @IsOptional()
  @IsUUID()
  folderId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  tagIds?: string[];
}
```

Every route DTO follows that pattern: type, optionality and format checks, then
the global pipe rejects unknown properties (`src/common/errors/validation.pipe.ts:44-51`). Length caps are the exception rather than the rule — the only
`@MaxLength` decorators in `src/` are on `UpdateUserProfileDto` (255 for
`displayName`, 10 for `locale`, 50 for `timezone`;
`src/users/dto/update-user-profile.dto.ts:11,25,34`), so note titles and content,
task subjects and event titles are bounded only by the request-body parser.

### Size Limits

- Request body: no `limit` is configured — `NestFactory.create` is called with a
  logger option only and `src/main.ts` registers no `json`/`urlencoded` handler of
  its own (`src/main.ts:10-12`), so body-parser's default applies (100 kB) and an
  oversized body is rejected before any DTO runs
- Field length: `@MaxLength` on `UpdateUserProfileDto` only, as above
- File upload: not implemented — no `FileInterceptor`, `multer` or object-storage
  client exists anywhere in `src/`, so there is no 500 MB path to protect
- API response: unlimited (with pagination)

### Type Safety

- Strict TypeScript (`noImplicitAny: true`)
- No `any` types
- Explicit type annotations
- Runtime validation with class-validator

## Secure Coding Practices

### Injection Prevention (Query Documents)

Always let the driver assemble the command — Prisma's model methods do:

```typescript
// ✅ SAFE
await prisma.note.findMany({
  where: { userId: userId }, // Parameterized
});

// ❌ DANGEROUS — same class of bug on this datasource: a filter document
// assembled from request input. `$queryRaw`/`$queryRawUnsafe` are not generated
// for the MongoDB connector; `$runCommandRaw` is, and it takes the injection
// wherever the string goes.
await prisma.$runCommandRaw({
  find: "Note",
  filter: JSON.parse(`{ "userId": "${userId}" }`), // operator injection
});
```

### XSS Prevention

- Content never directly rendered
- Sanitize user input
- Use frameworks with XSS protection
- Content Security Policy headers

### CSRF Prevention

- State parameter in OAuth flows
- SameSite cookies
- CSRF tokens for state-changing operations
- Origin/Referer validation

### XXE Prevention

- Disable external entity processing
- Parse XML safely (if used)
- Use libraries with XXE protections

## Secret Management

### Never Commit Secrets

```bash
# ❌ WRONG
DATABASE_PASSWORD=supersecret123

# ✅ RIGHT
DATABASE_PASSWORD=${DB_PASSWORD}  # Injected from environment
```

### Secret Rotation

- OAuth credentials: every 90 days
- JWT secrets: plan for rotation
- Database passwords: on-demand
- Encryption keys: plan for rotation

### .env.example Pattern

```bash
# ✅ Safe - committed to repo
DATABASE_URL=mongodb://user:PASSWORD@localhost:27017/allinone_dev
JWT_ACCESS_SECRET=CHANGE_ME_IN_PRODUCTION
```

### Production Secrets

Use one of:

- Environment variables (cloud provider)
- Secrets manager (AWS Secrets Manager, Azure Key Vault)
- HashiCorp Vault
- SOPS + Git encryption

## API Security

### Rate Limiting

Rate limits are declared per route with `@Throttle` and enforced by `CustomThrottlerGuard`, registered as the app-wide `APP_GUARD` (`src/app/app.module.ts:159-162`). Underneath it sits one `default` throttler that covers every route declaring nothing of its own: `RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS`, i.e. 100 requests per 60 seconds unless the environment overrides it (`src/app/app.module.ts:126-137`, `src/config/configuration.service.ts:183-189`).

- **Declared budgets** — every `@Throttle` in `src/`:

  ```
  POST /auth/register                     — 3 per hour (limit: 3, ttl: 3600000)
  POST /auth/login                        — 5 per minute
  POST /auth/oauth/google                 — 10 per minute
  POST /auth/oauth/apple                  — 10 per minute
  POST /auth/oauth/microsoft              — 10 per minute
  POST /auth/refresh                      — 10 per minute
  POST /auth/verify-email/request         — 3 per minute
  POST /auth/verify-email/confirm         — 5 per minute
  POST /auth/forgot-password              — 3 per minute
  POST /auth/reset-password               — 5 per minute
  POST /auth/mfa/verify                   — 5 per minute
  POST /vault/settings/unlock             — 10 per minute, plus a per-vault cooldown
  POST /vault/settings/recovery/request   — 3 per minute
  POST /vault/settings/recovery/verify    — 5 per minute
  POST /vault/settings/recovery/complete  — 3 per minute
  ```

  (`src/auth/auth.controller.ts:65-274`, `src/vault/controllers/vault-settings.controller.ts:59-115`.) The unlock cooldown is a second, independent budget: five consecutive wrong verifiers lock that vault out for 60 seconds, doubling up to an hour, and the counter lives on `VaultSetting` rather than `User` (`src/vault/services/vault-settings.service.ts:30-32,261-269`).

- **Who is counted**: `getTracker` builds the key as `user:<id>` when `req.user` is already populated and `ip:<first x-forwarded-for hop>` otherwise (`src/common/guards/custom-throttler.guard.ts:54-71`). Note the ordering caveat: as an `APP_GUARD` the throttler runs before a route's `JwtAuthGuard`, so `req.user` is still empty on HTTP requests and every bucket is keyed by IP today — the per-account branch is written but unreachable, and a shared NAT still divides one user's budget across hops. Fixing it means reading the bearer token in the guard or keying off the session id.

- **State lives in each process**: `ThrottlerModule.forRootAsync` passes no `storage` option (`src/app/app.module.ts:126-137`), so `@nestjs/throttler` falls back to its in-memory `ThrottlerStorageService`. Quotas are therefore per replica — three pods answer three times the declared budget. `RedisThrottlerStorage` (`src/common/throttler/redis-throttler.storage.ts`) is the distributed replacement: it keeps the counter at `throttler:<key>` via an `INCR` + `PTTL` pipeline, holds the ban at `throttler:<key>:block`, and returns the 6.x record shape `{ totalHits, timeToExpire, isBlocked, timeToBlockExpire }`; its `increment` takes four of the 6.x contract's five arguments and ignores `throttlerName`. It is unit-tested and **not registered anywhere in `src/`**, so cluster-wide enforcement is a to-do rather than a property of the deployment.

- **Blocking is on**: no `@Throttle` in `src/` sets `blockDuration`, and `@nestjs/throttler` 6.x resolves it to the route's `ttl` when absent. The first request past the limit therefore comes back `429` with a `Retry-After`, and the bucket stays shut for the rest of that window instead of reopening as individual hits expire.

- **Fail-open**: when Redis is unreachable the storage logs `Redis throttler increment failed: … Permitting request.` and returns a non-blocking record (`src/common/throttler/redis-throttler.storage.ts:95-105`) — a Redis outage costs enforcement, not availability. That matters only once the class is wired; the in-memory storage has no equivalent failure mode.

- **When it is on**: `CustomThrottlerGuard` stands down under `APP_ENV=development`,
  `NODE_ENV=test`, `DISABLE_RATE_LIMITING=true` or `RATE_LIMIT_ENABLED=false`. Set
  `RATE_LIMIT_ENABLED=true` to run the real limits locally instead of meeting
  them first in production. A request can never opt itself out — the
  `x-skip-throttle` / `x-bypass-rate-limit` headers are honoured only when an
  operator sets `RATE_LIMIT_HEADER_BYPASS=true`, and never when `APP_ENV=production`.

### WebSocket Gateway (`/sync`)

- **Clustering is wired, and gated on Redis.** `src/main.ts:97` installs `SyncIoAdapter` (`src/sync/adapters/sync-io.adapter.ts`), which extends `RedisIoAdapter` and calls `connectToRedis()` before `listen()`. It is attempted only when `REDIS_URL` names a server and `WS_REDIS_ADAPTER` has not been set to `false`; when both hold, `user:<userId>` rooms are shared across API replicas and an invalidation emitted on one reaches a client connected to another. Until 2026-09-27 nothing constructed the adapter at all and rooms were per-process unconditionally.
- **The residual risk is that the fallback is quiet.** A Redis that is configured but unreachable is caught, logged as a warning, and the process continues on Socket.IO's default in-memory adapter — rooms per-process again, second replicas silently missing invalidations. Nothing in `/health`, `/health/live` or `/health/ready` reports which mode the gateway came up in, so an operator cannot tell from any external signal. Confirm the `[sync-ws] … Clustering:` line in the boot log. `docker-compose.prod.yml` runs one `api` container today, so this is latent rather than live.
- **Invalidation is a wake-up hint, not data.** The failure mode above is staleness, never disclosure: the payload carries a cursor and the pull that follows is REST-authenticated against the device's own checkpoint. Nothing is cross-delivered because two replicas share a room.
- **The handshake revalidates the account and the session, the way REST does.** `handleConnection()` verifies the signature and then calls `revalidate()` (`src/sync/sync.gateway.ts:81`, defined `:121-162`), which requires the user to exist, `status === "ACTIVE"`, `deletedAt` null, and — when the token names a session — `UsersService.isSessionLive()`. It fails closed: with no `UsersService` in the graph it refuses the connection instead of falling back to trusting the signature, and it logs the rejection reason and never the token.
- **What it still does not do: drop a live socket.** Revalidation happens at handshake, so a session revoked mid-connection keeps its socket until it reconnects or the access token expires (15 minutes by default). "Disconnect on revocation" remains unimplemented; the practical exposure is that a revoked device is told there is new data, and then refused when it asks.
- **CORS is configuration, not a wildcard.** The decorator carries only `namespace` now; the old `cors: { origin: "*" }` was evaluated at import time, which is exactly why it could never have consulted `.env`. `SyncIoAdapter` resolves the `/sync` allow-list at boot from `WS_CORS_ORIGINS`, falling back to `CORS_ORIGINS`, then the HTTP app's `CORS_ORIGIN`, then `http://localhost:3000` — so tightening the HTTP list does tighten the socket by default, and a dedicated key exists for a web client served from a different origin. A configured list is never widened automatically: the only wildcard is the `*` an operator writes into it, and that is answered with `credentials: false`. `WS_CORS_ALLOW_NULL_ORIGIN` (default `false`) is the explicit, logged escape hatch for WebView clients that send no `Origin`.

### CORS Configuration

```typescript
app.enableCors({
  origin: ["https://app.example.com", "https://mobile.example.com"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
});
```

### Security Headers

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Content-Security-Policy: default-src 'self'
```

### Request Validation

- Validate all inputs
- Whitelist expected fields
- Reject unknown fields
- Type-check all data

## File Upload Security

### Safe Upload Flow

```
1. Client requests upload permission
2. Server generates signed URL with expiry
3. Client uploads to MinIO with signature
4. Server confirms upload
5. Server scans file (if needed)
6. File associated with owner
```

### File Security

- Store outside webroot
- Use signed URLs for downloads
- Scan for malware (optional)
- Validate MIME types
- Check file extensions
- Limit file sizes
- Quarantine + scan before serving

## Database Security

### Connection Security

- Use connection pooling
- Limit concurrent connections
- Timeout idle connections
- Require SSL/TLS connection
- Use read replicas for queries

### Constraints & Triggers

The `mongodb` datasource exposes no DDL surface: `ALTER TABLE`, foreign-key
constraints and `CHECK` expressions are unavailable, and the Prisma MongoDB
connector enforces no relations between collections. Integrity is code-side:

- Structure comes from `prisma/schema.prisma`; unique and index declarations are
  created on the MongoDB collections by `npm run db:push` (`package.json:28`)
  rather than by a SQL migration.
- The state transitions a `CHECK` constraint would cover — `status` moving to
  `DELETED`, `deletedAt` / `revokedAt` being stamped — are performed by the
  services that own the rows (`src/users/users.service.ts:81-109` soft-deletes an
  account and revokes its sessions and devices in one transaction).
- The only write-time hook anywhere in `src/` is a Prisma `$use` middleware that
  materialises absent nullable columns as explicit `null` on `create`/`upsert`
  (`src/common/prisma/prisma.service.ts:47-63`).
- Cross-row access is guarded per request by the ownership checks described under
  "Ownership Verification", not by a foreign key.

### Backups

- Encrypted backups
- Tested restore procedures
- Off-site backup storage
- Regular testing
- 30-90 day retention

## Audit Logging

### What to Log

```
✅ DO LOG
- Login attempts (success & failure)
- Account changes (email, password)
- Permission changes
- Security events (MFA enabled/disabled)
- Device additions/removals
- Data exports
- Account deletions

❌ DON'T LOG
- Passwords or password hashes
- Tokens or session IDs
- Vault contents
- Private notes/tasks
- Recovery codes
- OTP codes
```

### Audit Log Format

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "userId": "user-id",
  "action": "LOGIN_SUCCESS",
  "ipAddress": "192.168.1.1",
  "userAgent": "Mozilla/5.0...",
  "metadata": {
    "deviceId": "device-id",
    "location": "New York, US"
  }
}
```

## Threat Model

### High-Priority Threats

| Threat               | Likelihood | Impact   | Mitigation                                   |
| -------------------- | ---------- | -------- | -------------------------------------------- |
| Account Takeover     | Medium     | Critical | MFA, rate limiting, session management       |
| Data Breach          | Low        | Critical | Encryption, backups, access controls         |
| SQL Injection        | Low        | Critical | Parameterized queries, ORM                   |
| Privilege Escalation | Low        | High     | Authorization checks, database constraints   |
| IDOR                 | Medium     | High     | Ownership verification, authorization guards |
| Brute Force          | Medium     | High     | Rate limiting, account lockout, MFA          |

### Medium-Priority Threats

- XSS attacks (input sanitization)
- CSRF attacks (CSRF tokens, SameSite cookies)
- Session hijacking (secure cookies, token rotation)
- Malicious file upload (scanning, storage security)
- Denial of Service (rate limiting, resource limits)

### Low-Priority Threats

- Information disclosure (error handling, logging)
- Man-in-the-middle (HTTPS, certificate pinning)
- Timing attacks (constant-time comparisons)

## Security Checklist

### Implemented Security Architecture Controls (Codebase Verified)

- [x] All passwords hashed with Argon2id (`src/auth/auth.service.ts`)
- [x] Short-lived JWT access tokens (15m) and rotated refresh tokens (7d)
- [x] Hybrid authentication model (`httpOnly` refresh cookie + `Authorization: Bearer` access header)
- [x] TOTP MFA support with hashed recovery codes (`MFASetting`)
- [x] Rate limiting via `CustomThrottlerGuard`, keyed per client IP today — the
      per-account key it also implements is unreachable behind the global guard
      (see "Rate Limiting")
- [x] Ownership and IDOR authorization guards on all routes (`src/common/testing/idor.spec.ts`)
- [x] Global input validation pipes with whitelisting and non-whitelisted property rejection (`src/main.ts:52`, `src/common/errors/validation.pipe.ts:44-51`)
- [x] No SQL surface: the MongoDB connector generates no `$queryRaw`, and the
      three `$runCommandRaw` call sites build command documents as objects rather
      than interpolated strings (`src/common/prisma/prisma.service.ts:82`,
      `src/auth/auth.service.ts:818,871`)
- [x] Centralized SIEM audit logging with correlation ID (`src/common/audit/audit-log.service.ts`)
- [x] Client-side AES-256-GCM encryption for vault entries (`vault_item` rows in the sync oplog) — not zero-knowledge, see the recovery-key caveat under "Vault and Sync Trust Models"
- [x] Backup and restore scripts with archive integrity checking (`scripts/backup-database.sh:72-89` runs `mongodump --gzip --archive` and verifies it with `gzip -t`) — no scheduler runs them in this repo; see the pre-flight checklist below and `docs/DISASTER_RECOVERY.md`

### Pre-Deployment Operational Verification Checklist (Pre-Flight Runbook)

Before opening traffic to a production deployment, the systems engineer must verify:

- [ ] Production secrets injected via environment or secret manager (no secrets committed to git)
- [ ] TLS certificate acquisition confirmed via Caddy / Let's Encrypt (HSTS enabled)
- [ ] Production database passwords generated with sufficient entropy (`openssl rand -hex 32`)
- [ ] Dedicated MongoDB user permissions verified (least privilege, `readWrite` on the app database only)
- [ ] Production CORS origins restricted to verified frontend domains (`CORS_ORIGIN`)
- [ ] Daily backup cron job scheduled and verified on external storage (`backup-allinone.sh`)
- [ ] Disaster recovery restore drill tested against isolated staging instance (`restore-database.sh`)
- [ ] Prometheus scrape endpoint and Grafana alerting thresholds validated
- [ ] Penetration test / security audit executed and signed off

## Incident Response

### If Data Breach Suspected

1. Isolate affected systems
2. Determine scope (what data, which users)
3. Preserve evidence (logs, backups)
4. Notify affected users
5. Review security logs
6. Close vulnerability
7. Implement additional controls
8. Document lessons learned

### Emergency Access Revocation

```bash
# Preferred: the audited admin endpoints (JwtAuthGuard + AdminGuard, both write
# an AuditLog row) — src/admin/admin.controller.ts:45,63
curl -X POST "$APP_URL/admin/users/<userId>/revoke-sessions" -H "Authorization: Bearer <admin token>"
curl -X POST "$APP_URL/admin/users/<userId>/disable-mfa"     -H "Authorization: Bearer <admin token>"
```

Direct against the database when the API itself is the thing that is broken. The
datasource is MongoDB (`prisma/schema.prisma:9`) and no model declares `@@map`,
so the collections carry the Prisma model names and the fields are camelCase:

```javascript
// Revoke all sessions for a user
db.Session.updateMany(
  { userId: "<userId>", revokedAt: null },
  { $set: { revokedAt: new Date() } },
);

// Revoke a specific device
db.Device.updateMany(
  { userId: "<userId>", _id: "<deviceId>", revokedAt: null },
  { $set: { revokedAt: new Date() } },
);

// Disable MFA for account recovery
db.MFASetting.updateOne(
  { userId: "<userId>" },
  { $set: { totpEnabled: false } },
);
```

## Compliance Considerations

### Data Retention

- User data: until account deletion
- Audit logs: 2-7 years (per policy)
- Backups: 30-90 days
- Session logs: 90 days

### User Privacy Rights

- Data export (GDPR, CCPA)
- Data deletion (right to be forgotten)
- Data portability
- Privacy policy
- Cookie policy
- Terms of service

## Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP API Security](https://owasp.org/www-project-api-security/)
- [NestJS Security](https://docs.nestjs.com/security/)
- [MongoDB Security](https://www.mongodb.com/docs/manual/security/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)

---

**Report security issues responsibly.** Email: security@allinone.local
