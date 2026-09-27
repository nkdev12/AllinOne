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
// DTOs with class-validator
export class CreateNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  title: string;

  @IsString()
  @MaxLength(1000000) // Max 1MB
  content: string;

  @IsUUID()
  @IsOptional()
  folderId?: string;
}
```

### Size Limits

- Request body: 50MB
- File upload: 500MB
- API response: unlimited (with pagination)
- Database value: enforce column limits

### Type Safety

- Strict TypeScript (`noImplicitAny: true`)
- No `any` types
- Explicit type annotations
- Runtime validation with class-validator

## Secure Coding Practices

### SQL Injection Prevention

Always use parameterized queries (Prisma does this):

```typescript
// ✅ SAFE
await prisma.note.findMany({
  where: { userId: userId } // Parameterized
});

// ❌ DANGEROUS
await prisma.$queryRawUnsafe(
  `SELECT * FROM notes WHERE userId = '${userId}'` // SQL injection!
);
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
DATABASE_URL=postgresql://user:PASSWORD@localhost/db
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
### Rate Limiting & Distributed Throttling

Protect sensitive endpoints:
Protect sensitive endpoints with distributed Redis-backed throttling (`RedisThrottlerStorage`):

```
POST /auth/login     — 5 attempts per minute
POST /auth/register  — 3 per hour per IP
POST /auth/mfa       — 5 attempts per minute
GET  /api/search     — 100 per minute
GET  /api/export     — 10 per hour
```
- **Cluster-Wide Enforcement**: Rate limiting state is synchronized across all horizontally scaled backend instances using Redis atomic pipelines (`INCR` + `PTTL`), preventing clients from bypassing rate limits by hitting different pods.
- **Fail-Open Resilience**: If Redis experiences transient degradation, the storage layer logs a warning and permits requests rather than failing open to DoS or terminating API operations.
- **Protected Endpoint Budgets**:
  ```
  POST /auth/login     — 5 attempts per minute
  POST /auth/register  — 3 per hour per IP
  POST /auth/mfa       — 5 attempts per minute
  GET  /api/search     — 100 per minute
  GET  /api/export     — 10 per hour
  POST /vault/settings/unlock — 10 per minute, plus a per-vault cooldown
  ```
- **When it is on**: `CustomThrottlerGuard` stands down under `APP_ENV=development`,
  `NODE_ENV=test`, `DISABLE_RATE_LIMITING=true` or `RATE_LIMIT_ENABLED=false`. Set
  `RATE_LIMIT_ENABLED=true` to run the real limits locally instead of meeting
  them first in production. A request can never opt itself out — the
  `x-skip-throttle` / `x-bypass-rate-limit` headers are honoured only when an
  operator sets `RATE_LIMIT_HEADER_BYPASS=true`, and never when `APP_ENV=production`.

### Clustered WebSocket Gateway

- Horizontally distributed realtime events using `@socket.io/redis-adapter`.
- Redis Pub/Sub channels ensure room broadcasts (e.g. `user:<userId>`) correctly cross server boundaries to all client connections regardless of which backend node terminates their WebSocket connection.

### CORS Configuration

```typescript
app.enableCors({
  origin: ['https://app.example.com', 'https://mobile.example.com'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
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

```sql
-- Foreign keys ensure referential integrity
ALTER TABLE notes ADD CONSTRAINT fk_user_id
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- Unique constraints prevent duplicates
ALTER TABLE users ADD CONSTRAINT unique_email UNIQUE(email);

-- Check constraints enforce values
ALTER TABLE users ADD CONSTRAINT check_status
  CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED'));
```

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

| Threat | Likelihood | Impact | Mitigation |
|--------|-----------|--------|-----------|
| Account Takeover | Medium | Critical | MFA, rate limiting, session management |
| Data Breach | Low | Critical | Encryption, backups, access controls |
| SQL Injection | Low | Critical | Parameterized queries, ORM |
| Privilege Escalation | Low | High | Authorization checks, database constraints |
| IDOR | Medium | High | Ownership verification, authorization guards |
| Brute Force | Medium | High | Rate limiting, account lockout, MFA |

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
- [x] Per-IP and per-user rate limiting via `CustomThrottlerGuard`
- [x] Ownership and IDOR authorization guards on all routes (`src/common/testing/idor.spec.ts`)
- [x] Global input validation pipes with whitelisting and non-whitelisted property rejection
- [x] SQL injection prevention via Prisma parameterized queries
- [x] Centralized SIEM audit logging with correlation ID (`src/common/audit/audit-log.service.ts`)
- [x] Client-side AES-256-GCM encryption for vault entries (`vault_item` rows in the sync oplog) — not zero-knowledge, see the recovery-key caveat under "Vault and Sync Trust Models"
- [x] Automated backup and restore scripts with compression verification (`scripts/backup-database.sh`)

### Pre-Deployment Operational Verification Checklist (Pre-Flight Runbook)

Before opening traffic to a production deployment, the systems engineer must verify:

- [ ] Production secrets injected via environment or secret manager (no secrets committed to git)
- [ ] TLS certificate acquisition confirmed via Caddy / Let's Encrypt (HSTS enabled)
- [ ] Production database passwords generated with sufficient entropy (`openssl rand -hex 32`)
- [ ] Dedicated PostgreSQL user permissions verified (least privilege)
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
# Revoke all sessions for a user
UPDATE sessions SET revoked_at = NOW() WHERE user_id = ?

# Revoke specific device
UPDATE devices SET revoked_at = NOW() WHERE id = ?

# Disable MFA for account recovery
UPDATE mfa_settings SET totp_enabled = false WHERE user_id = ?
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
- [PostgreSQL Security](https://www.postgresql.org/docs/current/sql-syntax.html)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)

---

**Report security issues responsibly.** Email: security@allinone.local
