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

- **Password vault (`VaultModule` + the `vault_item` oplog)**: entry content is encrypted on the client with AES-256-GCM and reaches the server only as opaque `encryptedData` / `iv` / `authTag`. The master password never crosses the network, and neither does the Argon2id digest of it: the row holds `masterKeyHash` as `hmac-sha256:<base64>` — that digest keyed with the server-only `ENCRYPTION_KEY` (`src/vault/services/vault-settings.service.ts:38`, `:94-99`). A read of the collection therefore does not hand over something to crack offline; it hands over something that also needs the pepper, which lives in the environment and is stamped per row by `masterKeyHashPepper` so a rotation re-seals rather than stranding anyone (`prisma/schema.prisma:752-763`).
- **Zero-knowledge for the entry plaintext, with one legacy exception.** Forgotten-password recovery used to defeat that outright: `VaultSetting.recoveryKey` held an **unwrapped** key-encryption-key, uploaded verbatim, so database read access was vault read access. Builds since 2026-10-17 upload a phrase envelope instead — `recoveryKdfSalt` + `wrappedMasterKey` / `wrappedMasterIv` / `wrappedMasterTag`, with the master key wrapped under a key derived from the user's 12-word recovery phrase, which is never sent (`src/vault/dto/setup-vault.dto.ts:70-92`; a body still carrying `recoveryKey` is refused by `forbidNonWhitelisted`). Both setup branches write `recoveryKey: null` (`src/vault/services/vault-settings.service.ts:241`, `:253`) and a recovery that supplies the phrase envelope replaces it in the same write (`:649-659`), so the plaintext key is gone the moment the client provably holds the master key. A row that has not been through either since still carries it, and `recovery/verify` echoes the stored value for exactly those rows (`:573`) so their owner is not stranded by the change — for them the caveat stands. Sweep them first in any incident review; the remedy per row is to re-run recovery or setup with the four envelope fields. What the server can do either way, pepper included, is decide whether a candidate verifier matches a row, and hand a modern envelope back to a client that spent an emailed recovery code — `docs/API_REFERENCE.md` §9 has the full boundary.
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
- Vault recovery material — a phrase-derived envelope (`recoveryKdfSalt` + `wrappedMasterKey` / `wrappedMasterIv` / `wrappedMasterTag`) the server cannot unwrap, because the wrapping key comes from the user's recovery phrase and is never sent. The obsolete unwrapped `VaultSetting.recoveryKey` is no longer accepted on any write path and is nulled by the next setup or recovery; rows that predate that still hold it (see "Vault and Sync Trust Models")
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
the global pipe rejects unknown properties (`src/common/errors/validation.pipe.ts:77-93`). Length caps are the exception rather than the rule — the only
`@MaxLength` decorators in `src/` are on `UpdateUserProfileDto` (255 for
`displayName`, 10 for `locale`, 50 for `timezone`;
`src/users/dto/update-user-profile.dto.ts:11,25,34`), so note titles and content,
task subjects and event titles are bounded only by the request-body parser.

### Size Limits

- Request body: no `limit` is configured — `NestFactory.create` is called with a
  logger option only and `src/main.ts` registers no `json`/`urlencoded` handler of
  its own (`src/main.ts:15-17`), so body-parser's default applies (100 kB) and an
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

#### `ENCRYPTION_KEY`, the vault verifier pepper

`ENCRYPTION_KEY` is not only the AES key: it is the pepper `VaultSettingsService`
HMACs every `VaultSetting.masterKeyHash` with, and the row holds only that digest —
the verifier a client unlocks with is never stored, so nothing can be recomputed
offline. A rotation therefore has to leave the old key reachable, and since
`validateProductionSecrets()` refuses the shipped template value anywhere that is
not `APP_ENV=development` or a test run, an operator **must** rotate at some point.
That is why the pepper is versioned.

Each row records which key sealed it in `masterKeyHashPepper`. A null stamp means
"sealed under the key that was configured before identifiers existed", so rows that
already exist stay readable with no backfill, and the pre-pepper rows (recognised by
the missing `hmac-sha256:` prefix) are untouched.

The runbook, in this order:

1. **Open the window before changing the key.** Set
   `ENCRYPTION_KEY_PREVIOUS=<the value ENCRYPTION_KEY holds today>` and deploy. Nothing
   is re-sealed yet; old rows simply still open. Leave both `*_ID` variables alone here:
   they are optional labels, blank is the steady state, and an id that is not written
   down is derived from the key it names (`configuration.service.ts:704-709`, `:732-741`).
   A rotation performed with nothing but the default fingerprints works, and it survives
   a second rotation — which is the reason the default is a fingerprint of the key
   (`configuration.service.ts:699-709`).
2. **Change the key.** Set `ENCRYPTION_KEY` to the new
   `openssl rand -base64 48` output — and only here, in the same deploy as the key it
   names, introduce a new `ENCRYPTION_KEY_ID` if you want operator-readable labels at
   all. Deploy. Every vault keeps its correct master password: a row that matches under
   `ENCRYPTION_KEY_PREVIOUS` is accepted and re-sealed under the current key in one
   conditional write, stamped with the current id. Stamping a label *before* the key
   changes is the unrecoverable order: the stamp is the whole lookup
   (`vault-settings.service.ts:128-136`, `:168`), so rows sealed in that window would be
   read under the wrong secret and refuse their owner's correct master password, and the
   bare verifier is never persisted, so there is nothing to recompute
   (`vault-settings.service.ts:156-179`).
3. **Close the window.** Once every vault has unlocked at least once — the re-seal is
   what drains the queue, so the measure is "no row still names the retired key's stamp",
   whether that stamp is `ENCRYPTION_KEY_PREVIOUS_ID` or, with the label left blank, that
   key's fingerprint
   — delete `ENCRYPTION_KEY_PREVIOUS` and its id and deploy again. A retired key left
   in the environment is a key that still works and cannot be revoked.

Two failures the process refuses to paper over:

- A row whose stamp names a key the process does not hold answers
  `503 VAULT_PEPPER_KEY_UNAVAILABLE`, never a 401. That is a deployment that dropped
  a ring entry while rows depended on it; a 401 would blame the vault's owner and
  count five of their correct passwords into the unlock cooldown. Fix: restore
  `ENCRYPTION_KEY_PREVIOUS`. The recovery flow stays open to such a vault either way.
- A wrong master password on an unstamped row is still a wrong master password. If
  the previous key is unset, exactly one pepper is tried, so the rotation window
  costs nothing when no rotation is in progress.

`ENCRYPTION_KEY_PREVIOUS` is optional, and absent is the steady state. When it is set
it is held to the same rules as the key it replaced — same length and entropy floor,
never the shipped template, never the same value as `ENCRYPTION_KEY`, never an id
shared with it — because a half-configured window is worse than none: it looks like a
rotation that was completed.

**The ring is not vault-only.** The same key derives the AES-256-GCM secret every
`MFASetting.totpSecret` is sealed under (`src/auth/auth.service.ts:1376-1387`), so
step 2 drains TOTP rows as it drains vault rows: `decryptTotpSecret` walks the same
current-then-previous order (`:1424-1478`, ring built at `:1403-1410`), and a secret
that opened under the retired key is re-encrypted under the current one by
`resealTotpSecret` on the way out of the three paths that read it (`:1492-1507`,
called from `enableMfa` `:1567`, `disableMfa` `:1719`, `verifyMfaLogin` `:1819`). Two
differences from the vault are deliberate rather than unfinished. A blob nothing in
the ring opens is returned as the stored ciphertext and the caller answers a wrong
code (`:1466-1472`) — no stamp distinguishes a row sealed under a lost key from a
corrupt one, and the sign-in path must not 500 over that. And a missing
`ENCRYPTION_KEY` there is the 500 it has always been (`:1378-1384`), because that is
a deployment with no key at all rather than a window that closed early; the ring is
resolved before the `try` (`:1437-1441`) so it cannot degrade into "the code you
typed is wrong".

### .env.example Pattern

`.env.example` is committed and is what the runbooks tell you to copy, so what it ships
decides whether a first boot is safe or a template that walks into production.

- `APP_ENV=development` (`.env.example:10`) alongside a working local `DATABASE_URL`
  and `REDIS_URL` (`:22`, `:44`). That single word is what lets
  `cp .env.example .env && npm run start:dev` boot at all: `development` is the only
  spelling that puts `validateProductionSecrets()` on the skip path
  (`src/config/configuration.service.ts:305-306`, `isLocalDevelopment` `:464-466`).
- The anchored sentinel for the three values that matter — `JWT_ACCESS_SECRET`
  (`.env.example:90`), `JWT_REFRESH_SECRET` (`:92`) and `ENCRYPTION_KEY` (`:154`), each
  written `REPLACE_WITH__<how to generate it>__DO_NOT_SHIP`. That is the form the gate is
  built for: `isShippedTemplateSecret` refuses it whole, by prefix and suffix
  (`configuration.service.ts:96-97`, `:116-129`). The older sentence spellings are refused
  too, from `SHIPPED_TEMPLATE_SECRETS` (`:77-81`), because an operator may copy a template
  from before the change and a value already deployed once is exactly the value that comes
  back. Either way, a file copied from this template cannot boot anywhere outside
  development, and the error names the variable rather than the value.
- Blanks where blank is correct: `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEY_PREVIOUS` and
  `ENCRYPTION_KEY_PREVIOUS_ID` (`:177-179`). Empty is the steady state, not a
  misconfiguration — an unset id falls back to a fingerprint of the key
  (`configuration.service.ts:704-709`, `:732-741`) and an unset previous means exactly
  one pepper (`:720-725`).

**Closed 2026-10-18.** This section used to report an inconsistency: the gate refused the
anchored `REPLACE_WITH__…__DO_NOT_SHIP` sentinel and the code's own comments described that
sentinel as what `.env.example` ships, while the file itself still carried sentence-shaped
secrets — and an earlier revision of this document showed a third spelling,
`JWT_ACCESS_SECRET=CHANGE_ME_IN_PRODUCTION`, which matches neither denylist and is caught
only by the 32-character floor (`SECRET_MIN_LENGTH` `:16`, applied by `secretDefect`
`:168-184`). `.env.example` now ships the sentinel for all three, so the template, the gate
and these runbooks agree on one spelling and no operator has to guess which form is safe.
What is still accepted, deliberately, is a generated key that merely *contains*
`REPLACE_WITH__`: the rule is anchored at both ends, because a coincidence in the middle of
a random value must not cost an operator a boot.

### Production Secrets

Use one of:

- Environment variables (cloud provider)
- Secrets manager (AWS Secrets Manager, Azure Key Vault)
- HashiCorp Vault
- SOPS + Git encryption

## API Security

### Rate Limiting

Rate limits are declared per route with `@Throttle` and enforced by `CustomThrottlerGuard`, registered as the app-wide `APP_GUARD` (`src/app/app.module.ts:272-275`). Underneath it sits one `default` throttler that covers every route declaring nothing of its own: `RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS`, i.e. 100 requests per 60 seconds unless the environment overrides it (`src/app/app.module.ts:235-240`, defaults validated at `src/app/app.module.ts:190-191`, read by `src/config/configuration.service.ts:789-795`).

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

  (`src/auth/auth.controller.ts:98-351`, `src/vault/controllers/vault-settings.controller.ts:67-123`.) The unlock cooldown is a second, independent budget: five consecutive wrong verifiers lock that vault out for 60 seconds, doubling up to an hour, and the counter lives on `VaultSetting` rather than `User` — an atomic `$inc` on the row, then the lockout write (`src/vault/services/vault-settings.service.ts:41-43,338-364,437-444`).

- **Who is counted**: `getTracker` builds the key as `user:<id>` when `req.user` is already populated and `ip:<address>` otherwise (`src/common/guards/custom-throttler.guard.ts:52-69`). The address is `req.ip`, never a forwarding header read straight off the request: Express resolves the trusted proxy chain into it, and a bucket a client can pick is a bucket a client can refill (`:59-62`). IPv6 is masked to its subnet by `normalizeIp(ip, this.ipv6SubnetPrefix)` — /64 by default, configurable via the throttler's `ipv6SubnetPrefix` option — because one client owns a range of addresses and an unmasked tracker hands a fresh allowance to every address in that /64, which is a limit that only looks enforced (`:64-68`). Note the ordering caveat that still stands: as an `APP_GUARD` the throttler runs before a route's `JwtAuthGuard`, so `req.user` is still empty on HTTP requests and every bucket is keyed by IP today — the per-account branch is written but unreachable. Fixing it means reading the bearer token in the guard or keying off the session id. Keying honestly also depends on the deployment: while `docker-compose.prod.yml` published the API's `3000`, a client reaching it directly bypassed Caddy and controlled `X-Forwarded-For` outright (`docker-compose.prod.yml:12-18`); that port is no longer published, and the `api` service carries the comment saying so (`:288-290`).

- **State lives in Redis, not in each process**: `ThrottlerModule.forRootAsync` passes a `storage` option whenever `ConfigurationService.usesRedisThrottlerStorage` is true (`src/app/app.module.ts:228-249`), and that storage comes from `ThrottlerStorageModule`, which hands back `undefined` — and so the library default — for exactly one case per branch: a test run, or a development process that named no `REDIS_URL` (`src/app/app.module.ts:58-72`, `src/config/configuration.service.ts:823-831`). So the in-memory `ThrottlerStorageService`, which is per worker and per boot and lets every replica hand out the full allowance, is now the Jest-and-laptop default rather than the production behaviour. `RedisThrottlerStorage` (`src/common/throttler/redis-throttler.storage.ts`) keeps the counter at `throttler:<key>` in one `MULTI` of `INCR` + `PEXPIRE … NX` + `PTTL` (`:148-157`), holds the ban at `throttler:<key>:block` as a plain `SET … PX` that hammering cannot stretch (`:99-105`), and returns the 6.x record shape `{ totalHits, timeToExpire, isBlocked, timeToBlockExpire }`; its `increment` takes four of the 6.x contract's five arguments and ignores `throttlerName` (`:65-70`). Because the class is now wired, a deployed process with no `REDIS_URL` would keep every window and every block in its own memory — one allowance per replica, all of it forgotten by a restart — which is why that omission is a boot error (`src/config/configuration.service.ts:305-320`).

- **Blocking is on**: no `@Throttle` in `src/` sets `blockDuration`, and `@nestjs/throttler` 6.x resolves it to the route's `ttl` when absent. The first request past the limit therefore comes back `429` with a `Retry-After`, and the bucket stays shut for the rest of that window instead of reopening as individual hits expire.

- **Degraded to one process, not failed open, and announced once per 30 seconds**: when Redis does not answer, the hit is counted here instead. `increment`'s catch calls `LocalThrottlerWindow.record` (`src/common/throttler/redis-throttler.storage.ts:116-132`, `src/common/throttler/local-throttler.window.ts:55-99`), which returns the same record shape and enforces the same limit and the same block against an in-memory fixed window armed like the Redis one (`windowExpiresAt` set by the first hit and never refreshed, `blockedUntil` set once and not stretched). What an outage costs is therefore scope, not the control: the ceiling becomes the configured limit *per API replica* — `api` declares no `deploy.replicas` (`docker-compose.prod.yml:242-310`), so today that is one process, but scaling it horizontally silently multiplies the allowance, and a restart mid-window starts every count again, and every window and block is forgotten at a restart and again the moment Redis answers, because the next hit is counted there. The table is bounded at `DEFAULT_MAX_TRACKED_KEYS` = 20 000 entries (`:26`); `openWindow` reclaims an expired entry first, then a window whose block has already run out, and never a live block (`:111-131`, `:138-157`), and only when nothing could be reclaimed does `record` return `null` and the request fall back to the old permit-with-no-counter answer — refusing a stranger for a table full of somebody else's penalties would be the limiter inventing blocks. Both outcomes are reported through `reportDegradedRequest` → `announceOutage` (`src/common/throttler/redis-throttler.storage.ts:238-275`) at error level, at most once per `OUTAGE_REPORT_INTERVAL_MS` = 30 s (`:17`), counting since Redis last answered and separating "counted in memory" from "permitted with no counter at all"; the connection `error` listener routes through the same gate (`:60-62`), and any completed round trip resets both tallies (`:74-79`). The line to page on is `Rate limiting is degraded to this process only:`. Per-request `warn` logging was the wrong shape for this: one line per affected request is a second way for the outage to finish the job.

- **When it is on**: `CustomThrottlerGuard` is on by default and stands down only
  under `NODE_ENV=test`, `DISABLE_RATE_LIMITING=true` or `RATE_LIMIT_ENABLED=false`.
  A request can never opt itself out — the
  `x-skip-throttle` / `x-bypass-rate-limit` headers are honoured only when an
  operator sets `RATE_LIMIT_HEADER_BYPASS=true`, and never when `APP_ENV=production`.

### `GET /metrics`

- **One guard, and not the admin pair.** `MetricsScrapeGuard` is the only guard on the route (`src/common/metrics/metrics.controller.ts:13-18`). It replaces `JwtAuthGuard, AdminGuard`, the stack every other admin surface uses, because guards run in declaration order and `AdminGuard` fails closed on `!user` before it reads a header (`src/admin/guards/admin.guard.ts:28-33`, its secret branch at `:36-41`): a Prometheus scrape has no JWT to present, so the pair 401s the request before the shared-secret branch is ever reached, and `ADMIN_SECRET` can never be a machine credential on that route. What that bought was every scrape interval logging a refusal while monitoring looked configured and reported nothing.
- **Both presentations, reordered rather than reimplemented.** An admin's access token is delegated to the real `JwtAuthGuard` and then the real `AdminGuard` on the same context, so a signed-in admin still passes `JwtStrategy`'s session-revocation check (`src/common/metrics/metrics-scrape.guard.ts:69-84`). `ADMIN_SECRET` itself is accepted as `Authorization: Bearer …` — the shape Prometheus's `authorization` block emits — or as `x-admin-secret`, each compared against the whole value in constant time, with the unequal-length case answered before `timingSafeEqual` could throw (`:60-67`, `:96-104`, `:129-146`). Anything else gets the same 401/`UNAUTHORIZED` the endpoint has always returned rather than a 403, because nothing about the caller was established enough to be refused (`:86`, message literal `:21`).
- **The secret branch is opt-in, and currently unconfigured in compose.** `ConfigurationService.adminSecret` returns `undefined` for a missing, blank or under-`ADMIN_SECRET_MIN_LENGTH` value, so the branch closes rather than comparing against an empty string (`src/config/configuration.service.ts:761-772`). `docker-compose.prod.yml` requires `METRICS_SCRAPE_SECRET_FILE` and mounts the host file holding that value into Prometheus read-only (`docker-compose.prod.yml:388-401`); the scrape config reads it as a bearer credential from that file, so a rotation needs no config edit and no committed value (`infrastructure/prometheus/prometheus.prod.yml:27-29`). What that file does not do is put `ADMIN_SECRET` into the `api` environment — no service there declares it, and no service has an `env_file:` — so on a stock compose deployment the machine branch is closed on the server side and every scrape answers 401 against a credential nothing validates. Inject it into `api` as part of the pre-flight checklist below, or `/metrics` and every other `ADMIN_SECRET` path stays dark.

### WebSocket Gateway (`/sync`)

- **Clustering is wired, and gated on Redis.** `src/main.ts:181` installs `SyncIoAdapter` (`src/sync/adapters/sync-io.adapter.ts`), which extends `RedisIoAdapter` and calls `connectToRedis()` before `listen()`. It is attempted only when `REDIS_URL` names a server and `WS_REDIS_ADAPTER` has not been set to `false`; when both hold, `user:<userId>` rooms are shared across API replicas and an invalidation emitted on one reaches a client connected to another. Until 2026-09-27 nothing constructed the adapter at all and rooms were per-process unconditionally.
- **The residual risk is that the fallback is quiet.** A Redis that is configured but unreachable is caught, logged as a warning, and the process continues on Socket.IO's default in-memory adapter — rooms per-process again, second replicas silently missing invalidations. Nothing in `/health`, `/health/live` or `/health/ready` reports which mode the gateway came up in, so an operator cannot tell from any external signal. Confirm the `[sync-ws] … Clustering:` line in the boot log. `docker-compose.prod.yml` runs one `api` container today, so this is latent rather than live.
- **Invalidation is a wake-up hint, not data.** The failure mode above is staleness, never disclosure: the payload carries a cursor and the pull that follows is REST-authenticated against the device's own checkpoint. Nothing is cross-delivered because two replicas share a room.
- **The handshake revalidates the account and the session, the way REST does.** `handleConnection()` verifies the signature and then calls `revalidate()` (`src/sync/sync.gateway.ts:143`, defined `:198-243`), which requires the user to exist, `status === "ACTIVE"`, `deletedAt` null, and — when the token names a session — `UsersService.isSessionLive()`. It fails closed: with no `UsersService` in the graph it refuses the connection instead of falling back to trusting the signature, and it logs the rejection reason and never the token.
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
  created on the MongoDB collections by `npm run db:push` (`package.json:30`)
  rather than by a SQL migration.
- The state transitions a `CHECK` constraint would cover — `status` moving to
  `DELETED`, `deletedAt` / `revokedAt` being stamped — are performed by the
  services that own the rows (`src/users/users.service.ts:207-232` soft-deletes an
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
- [x] Global input validation pipes with whitelisting and non-whitelisted property rejection (`src/main.ts:135`, `src/common/errors/validation.pipe.ts:77-80`)
- [x] No SQL surface: the MongoDB connector generates no `$queryRaw`, and the
      three `$runCommandRaw` call sites build command documents as objects rather
      than interpolated strings (`src/common/prisma/prisma.service.ts:82`,
      `src/auth/auth.service.ts:1139`, `:1205`)
- [x] Centralized SIEM audit logging with correlation ID (`src/common/audit/audit-log.service.ts`)
- [x] Client-side AES-256-GCM encryption for vault entries (`vault_item` rows in the sync oplog) — zero-knowledge for the plaintext; the unwrapped `recoveryKey` that used to break that is refused on write and nulled by the next setup or recovery, and the legacy rows still carrying it are called out under "Vault and Sync Trust Models"
- [x] Backup and restore scripts with archive integrity checking (`scripts/backup-database.sh:145-164` runs `mongodump --gzip --archive` and verifies it with `gzip -t`) — no scheduler runs them in this repo; see the pre-flight checklist below and `docs/DISASTER_RECOVERY.md`

### Pre-Deployment Operational Verification Checklist (Pre-Flight Runbook)

Before opening traffic to a production deployment, the systems engineer must verify:

- [ ] Production secrets injected via environment or secret manager (no secrets committed to git)
- [ ] `APP_ENV=production` declared explicitly — every hardened path here keys on the
      written value, not on `NODE_ENV`, and an unset `APP_ENV` now takes the strict
      branch (`src/config/configuration.service.ts:449-453`, `:455-466`)
- [ ] The boot gate's own refusals read as deploy errors, not warnings: shipped template
      secrets, sub-32-character or low-entropy values, a shared access/refresh secret, a
      rotation window that repeats the current key, colliding pepper ids, a wildcard CORS
      origin, and a missing `REDIS_URL` (`src/config/configuration.service.ts:343-427`,
      `:305-320`)
- [ ] Compose posture verified: only Caddy publishes a port, and the 15 `:?` variables in
      `docker-compose.prod.yml` make an unset secret fail `docker compose config`
      instead of starting an open service (`docker-compose.prod.yml:39-44`)
- [ ] TLS certificate acquisition confirmed via Caddy / Let's Encrypt (HSTS enabled)
- [ ] Production database passwords generated with sufficient entropy (`openssl rand -hex 32`)
- [ ] Dedicated MongoDB user permissions verified (least privilege, `readWrite` on the app database only)
- [ ] Production CORS origins restricted to verified frontend domains (`CORS_ORIGIN`)
- [ ] Daily backup cron job scheduled and verified on external storage (`scripts/backup-database.sh`)
- [ ] Disaster recovery restore drill tested against isolated staging instance (`restore-database.sh`)
- [ ] `ADMIN_SECRET` present in the `api` environment at 32+ characters, since it is what
      the `/metrics` machine branch compares against and compose does not set it
- [ ] Prometheus scrape endpoint and Grafana alerting thresholds validated — verified by
      reading a scrape, not by the target existing: an unauthenticated one is `up 0`
      beside a Prometheus that looks healthy (see "`GET /metrics`")
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
