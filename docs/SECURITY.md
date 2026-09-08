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
- **Token Rotation**: Every call to `/auth/refresh` revokes the previous refresh token and issues a new access/refresh pair.
- **Session Tracking**: Active sessions are persisted in PostgreSQL (`Session` model), bound to a specific `Device` and `User`.
- **Revocation & Logout**: Immediate session invalidation via `POST /auth/logout` or `DELETE /users/me/sessions/:id` (`revokedAt = NOW()`).
- **Idempotency & Rate Limiting**: Refresh endpoints are rate-limited (10 req/min) to prevent token brute-forcing.

### MFA Implementation

- TOTP (Time-based One-Time Password)
- Recovery codes (10 codes, single-use)
- Backup MFA method required
- Recovery codes printed and stored safely
- Never logged or exposed

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

Protect sensitive endpoints:

```
POST /auth/login     — 5 attempts per minute
POST /auth/register  — 3 per hour per IP
POST /auth/mfa       — 5 attempts per minute
GET  /api/search     — 100 per minute
GET  /api/export     — 10 per hour
```

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
- [x] Zero-knowledge client-side encryption for vault items (`VaultItem`)
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
