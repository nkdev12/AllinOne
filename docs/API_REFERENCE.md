# Allinone Backend — End-to-End API Reference

This document provides a comprehensive specification of all HTTP REST endpoints, WebSocket event handlers, request/response DTOs, authentication requirements, rate limits, error schemas, and cross-cutting headers across all backend modules.

---

## 🔐 Authentication & Global Headers

There is no global authentication guard — the only app-wide `APP_GUARD` is `CustomThrottlerGuard` (`src/app/app.module.ts:262-265`) — so a route is protected exactly where `@UseGuards(JwtAuthGuard)` is applied, and the routes labelled `@Public()` below are simply the ones with no guard. No `@Public()` decorator exists in `src/`. Protected routes take the access token in the standard `Authorization` header; `JwtStrategy` extracts it from that header only, never from a cookie — the extractor list holds the bearer header and nothing else (`src/auth/strategies/jwt.strategy.ts:26-40`). The `refresh_token` cookie is read only by `POST /auth/refresh` (`src/auth/auth.controller.ts:236-239`), and a refresh that rides on that cookie must also carry the `x-client-version` barrier header the same handler checks (`src/auth/dto/refresh-token.dto.ts:12`, enforced at `src/auth/auth.controller.ts:248-253`):

```http
Authorization: Bearer <JWT_ACCESS_TOKEN>
```

### Key Request Headers

| Header Name                 | Type                        | Required                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | --------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization`             | String                      | Yes (Protected routes)  | `Bearer <JWT_ACCESS_TOKEN>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Content-Type`              | String                      | Yes (POST/PUT/PATCH)    | `application/json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `x-client-version`          | String, any non-empty value | Conditional             | The CSRF barrier for `POST /auth/refresh`. **Required** when the refresh comes from the ambient `refresh_token` cookie with no body token: `hasRefreshBarrier()` (`src/auth/auth.controller.ts:264-271`) wants a non-empty string and `:248-253` answers its absence with `403 TOKEN_INVALID`. Not required for a body-token refresh — the native path, which wins the precedence at `:240` — or on any other route. It is already in the CORS `allowedHeaders` (`src/main.ts:112`), the constant behind it is `REFRESH_REQUEST_HEADER` (`src/auth/dto/refresh-token.dto.ts:12`), and the lookup is on the lower-cased name Express hands the handler (`auth.controller.ts:264-271`), so a client that spells it `X-Client-Version` is fine.                                                                                                                                                                                |
| `Idempotency-Key`           | String, any non-empty value | Optional                | Replays a cached response for the same `(userId, key)` pair. **Not** "exact-once execution": a hit returns the stored response and the handler never runs, so a retry whose first attempt already landed is silently dropped. Stored in the `IdempotencyKey` collection in MongoDB with a 24-hour `expiresAt` — there is no Redis tier in this path, and no PostgreSQL. The value need not be a UUID, and nothing in the interceptor checks. See `POST /sync/push` for why a caller usually wants to send none.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `X-Request-ID`              | String                      | Optional (Client)       | A correlation id the client sends. **Only error responses touch it**: `AllExceptionsFilter` reads the header, generates a `uuidv4()` when absent, puts it in the envelope body and echoes it as a response header (`all-exceptions.filter.ts:54,170`). A 2xx response carries no `X-Request-ID` at all, so it is not a server-guaranteed id on the success path and cannot be used to correlate a request that worked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `X-Trace-ID`, `traceparent` | String                      | Server (all routes)     | The two headers a successful response _does_ carry: `TracingInterceptor` sets both on every route, which is what to log if you want one id across a whole call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `x-admin-secret`            | String                      | Optional (Admin routes) | Shared secret for automated admin tooling. **Not a standalone credential:** `JwtAuthGuard` runs before `AdminGuard`, so a request carrying only this header gets `401` (verified against a running instance on 2026-09-27); with no authenticated user `AdminGuard` itself answers `403` (`src/admin/guards/admin.guard.ts:31-33`). It must accompany a valid Bearer token for _any_ active user. It is compared against `ADMIN_SECRET`, which is declared in the Joi schema (`src/app/app.module.ts:126`) and exposed as `ConfigurationService.adminSecret` (`src/config/configuration.service.ts:724-730`): unset, blank, or shorter than `ADMIN_SECRET_MIN_LENGTH` (32, `:9`) it is `undefined` and the header branch at `src/admin/guards/admin.guard.ts:38-41` is closed. `.env.example:99-103` documents it commented out, so the default deployment admits nobody this way. See the warning in the `/admin` section. |

---

## 🛑 Global Error Response Format

All error responses return standard HTTP status codes and a consistent JSON payload produced by `AllExceptionsFilter` (`src/common/error-handling/filters/all-exceptions.filter.ts:14-24`; `details` and `traceId` are optional and absent when nothing populates them):

```json
{
  "statusCode": 400,
  "code": "VALIDATION_ERROR",
  "message": "Please correct the highlighted fields.",
  "details": {
    "fields": [
      { "field": "email", "messages": ["Enter a valid email address."] },
      {
        "field": "password",
        "messages": ["Password must be at least 8 characters long."]
      }
    ]
  },
  "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-09-07T14:00:00.000Z",
  "path": "/auth/register"
}
```

> [!NOTE]
> **`message` is `string | string[]`, and what a client should branch on is `code`**:
>
> - DTO validation failures come out of the one pipe the app installs
>   (`src/common/errors/validation.pipe.ts:77-93`) as a single string —
>   `"Please correct the highlighted fields."` — with the per-field detail in
>   `details.fields`, each entry `{ field, messages[] }` where `field` is the property
>   path (`user.address.city` for a nested DTO). The messages are UI-safe rewrites of
>   class-validator's text, not the raw constraint strings they used to be
>   (`validation.pipe.ts:37-57`). Unknown extra input keys are rejected the same way
>   (`forbidNonWhitelisted: true`, `validation.pipe.ts:80`), surfacing as
>   `"This field is not allowed."`.
> - Every other failure carries the message the raising code wrote, usually a single
>   string; `details` holds whatever structured context that call site passed
>   (`src/common/errors/http-errors.ts:10-27`).
>
> The `message` type in the interface is `string | string[]`
> (`src/common/errors/http-errors.ts:17`, `all-exceptions.filter.ts:17`) because the
> filter forwards an array when every entry in it is a string
> (`all-exceptions.filter.ts:93-101`). Nothing in `src/` sends one as of 2026-10-18.
> The last producer was `assertPushableChanges()`, which turned a refused sync batch
> into an array of `"<field>: <constraint>"` strings _while also_ filling
> `details.fields`, so a client got the same list twice in two shapes. It now builds
> the pipe's envelope by hand — one summary sentence naming the problem count, and
> `details.fields` whose messages are passed through the pipe's own `toSentence()`
> (`src/common/errors/validation.pipe.ts:22-34`,
> `src/sync/change-payload.validator.ts:1669-1701`) — because a push body has already
> cleared the pipe by the time it runs, and rendering a `400` should not depend on
> which of the two producers wrote it. The union stays: it is the filter's contract,
> not a survey of call sites.

### Standard Error Codes

- `VALIDATION_ERROR` (400)
- `UNAUTHORIZED` (401)
- `FORBIDDEN` (403)
- `NOT_FOUND` (404)
- `CONFLICT` (409)
- `RATE_LIMITED` (429)
- `INTERNAL_ERROR` (500)
  | HTTP Status                 | Error Code                                                                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
  | --------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `400 Bad Request`           | `VALIDATION_ERROR`                                                        | Request validation failed (schema, types, constraints)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
  | `401 Unauthorized`          | `UNAUTHORIZED`                                                            | Missing, expired, or invalid authentication credentials                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
  | `403 Forbidden`             | `FORBIDDEN`                                                               | Authenticated user lacks permission for the resource                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
  | `404 Not Found`             | `NOT_FOUND`                                                               | Target entity does not exist or has been soft-deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
  | `409 Conflict`              | `CONFLICT`                                                                | Resource collision (e.g. duplicate email, unique constraint)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
  | `429 Too Many Requests`     | `RATE_LIMITED`                                                            | Throttler quota exceeded for the client or user                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
  | `500 Internal Server Error` | `INTERNAL_ERROR`                                                          | Unhandled server or database exception                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
  | `503 Service Unavailable`   | `TRANSACTION_TIMEOUT`, `VAULT_PEPPER_KEY_UNAVAILABLE` or `INTERNAL_ERROR` | Two paths set a 503 and a code together: Prisma `P2028` becomes `TRANSACTION_TIMEOUT` with `details.retryable: true` (`all-exceptions.filter.ts:142-148`), and a vault sealed under a pepper key this process does not hold becomes `VAULT_PEPPER_KEY_UNAVAILABLE` (`src/vault/services/vault-settings.service.ts:774-783`). Everything else `>= 500` is `INTERNAL_ERROR` (`:59-61`). The `503` you see from `/health` and `/health/ready` is a different answer again: those handlers write their body directly (`src/health/health.controller.ts:18-32,48-54`), so it carries no `code` at all |

Status and code are independent facts: when the raised exception carries a `code`
of its own, the filter forwards that instead of the status-derived one
(`src/common/error-handling/filters/all-exceptions.filter.ts:89-92`). A `401` can
arrive as `RATE_LIMITED` and a `503` can arrive with a name of its own, so a
client branches on `code`. Every member of `src/common/errors/error-code.ts`
(the enum is the authority; it declares them in five groups), with the status it
actually reaches a client and a representative raise site:

| Code                           | Status            | Where it comes from                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`             | 400               | the one `ValidationPipe` the app installs (`src/common/errors/validation.pipe.ts:85-92`), plus direct `badRequest()` calls such as `AuthService.confirmEmailVerification()` and `SyncService`                                                                                                                                                                                                                                                                                                           |
| `INVALID_DATE`                 | —                 | **declared, never raised** in `src/`. A bad date is refused as `VALIDATION_ERROR` by the DTO's own `@IsDateString()` constraint (`error-code.ts:12`)                                                                                                                                                                                                                                                                                                                                                    |
| `INVALID_CREDENTIALS`          | 401               | `AuthService.login()` — no auth record for the identifier, and a failed `argon2.verify`. Also OAuth's unknown-provider case                                                                                                                                                                                                                                                                                                                                                                             |
| `EMAIL_NOT_VERIFIED`           | 401               | `AuthService.login()` when `EMAIL_VERIFY_ENABLED` is on and the row has no `emailVerifiedAt`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `EMAIL_ALREADY_REGISTERED`     | 409               | `AuthService.register()` (pre-check and `P2002` catch) and `AuthService.loginWithOAuth()` when the email is taken by another provider                                                                                                                                                                                                                                                                                                                                                                   |
| `ACCOUNT_DISABLED`             | 401               | `AuthService.login()`, `AuthService.loginWithOAuth()`, and every authenticated request via `JwtStrategy.validate()` (`src/auth/strategies/jwt.strategy.ts:54-60`)                                                                                                                                                                                                                                                                                                                                       |
| `TOKEN_INVALID`                | 401, and 403 once | 401 from `JwtStrategy.validate()` (`src/auth/strategies/jwt.strategy.ts:46-52`, a non-access token) and from `AuthService.refreshTokens()` / the OTP paths. The single 403 is `src/auth/auth.controller.ts:249-253`: a refresh that rode on the ambient cookie without the barrier header                                                                                                                                                                                                               |
| `TOKEN_EXPIRED`                | —                 | **never raised in an HTTP body** (`error-code.ts:20`). The sync WebSocket emits the same string as a `subCode` on an error frame (`src/sync/sync.gateway.ts:180`), which is not this envelope                                                                                                                                                                                                                                                                                                           |
| `SESSION_REVOKED`              | 401               | `JwtStrategy.validate()` (`src/auth/strategies/jwt.strategy.ts:62-75`)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `OTP_INVALID`                  | 400 and 401       | 400 for `/auth/verify-email/confirm` and `/auth/reset-password` (`AuthService`); 401 for `/vault/recovery/verify` (`src/vault/services/vault-settings.service.ts:534-539`)                                                                                                                                                                                                                                                                                                                              |
| `RATE_LIMITED`                 | 429 and 401       | 429 is only ever the throttler (`all-exceptions.filter.ts:57-58`). The 401s are the attempt counters the services keep themselves: five bad passwords open a 15-minute account lock (`AuthService.login()`, and the same shape in `verifyMfaLogin()`), and the vault unlock cooldown (`src/vault/services/vault-settings.service.ts:322-327`, which adds `details.retryInSeconds`). Read the `code`, not the status: a 401 here means "stop trying for a while", not "wrong password"                   |
| `MFA_CHALLENGE_INVALID`        | 401               | `AuthService.verifyMfaToken()` — expired, mis-signed, or wrong-purpose challenge token                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MFA_CODE_INVALID`             | 401               | `AuthService.completeMfaLogin()` — bad TOTP, or the row has no secret                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PASSKEY_NOT_REGISTERED`       | —                 | **declared, never raised** (`error-code.ts:30`). `/auth/passkeys/*` answers `PASSKEY_CHALLENGE_INVALID` or `NOT_FOUND` instead                                                                                                                                                                                                                                                                                                                                                                          |
| `PASSKEY_CHALLENGE_INVALID`    | 400               | `PasskeysService.verifyRegistration()` — `src/auth/passkeys/passkeys.service.ts:94-97,109-112,116-119,123-126`                                                                                                                                                                                                                                                                                                                                                                                          |
| `VAULT_NOT_CONFIGURED`         | 404               | `vaultNotConfigured()` (`src/vault/services/vault-settings.service.ts:737-743`), used by every vault method when no row exists                                                                                                                                                                                                                                                                                                                                                                          |
| `VAULT_ALREADY_CONFIGURED`     | 409               | `VaultSettingsService.setupVault()` (`src/vault/services/vault-settings.service.ts:206-210`)                                                                                                                                                                                                                                                                                                                                                                                                            |
| `VAULT_MASTER_KEY_MISMATCH`    | 401               | `VaultSettingsService.unlockVault()` (`src/vault/services/vault-settings.service.ts:372-376`) — the verifier digest did not match. **This** is the wrong-password answer                                                                                                                                                                                                                                                                                                                                |
| `VAULT_RECOVERY_NOT_PENDING`   | 401 and 409       | 401 when no recovery window is open (`src/vault/services/vault-settings.service.ts:599-603,619-623`); 409 when `completeRecovery()` matched zero rows because another request moved the window (`:662-667`)                                                                                                                                                                                                                                                                                             |
| `VAULT_RECOVERY_UNAVAILABLE`   | 400               | `VaultSettingsService.requestRecovery()` / `verifyRecoveryOtp()` and `noRecoveryMaterialStored()` (`src/vault/services/vault-settings.service.ts:456-459,491-495,509-513,551-555,745-750`)                                                                                                                                                                                                                                                                                                              |
| `VAULT_PEPPER_KEY_UNAVAILABLE` | **503**           | `pepperKeyUnavailable()` (`src/vault/services/vault-settings.service.ts:774-783`), raised from `findSealingKey()` when the row's pepper stamp names a key this process does not hold. It is a 503 and not a 401 on purpose: nothing the person typed is wrong and the vault is intact, so a client that retried the master password against it would walk them into the cooldown above and lock a healthy vault out of itself. `details.pepperKeyId` names the stamp, which is a label and not a secret |
| `DEVICE_NOT_REGISTERED`        | 404               | `DevicesService` (`src/devices/devices.service.ts:39-43`) and `SyncService` (`src/sync/sync.service.ts:475-479`)                                                                                                                                                                                                                                                                                                                                                                                        |
| `DEVICE_REVOKED`               | 403               | `src/sync/sync.service.ts:465-469`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SYNC_PUSH_REJECTED`           | 400               | `assertPushableChanges()` (`src/sync/change-payload.validator.ts:1689-1701`) — a refused batch: `message` is one summary sentence naming the problem count, every problem is in `details.fields`                                                                                                                                                                                                                                                                                                        |
| `NOT_FOUND`                    | 404               | any `notFound()` call, e.g. `src/auth/passkeys/passkeys.service.ts:57`, and Prisma `P2025` (`all-exceptions.filter.ts:137-141`)                                                                                                                                                                                                                                                                                                                                                                         |
| `ALREADY_EXISTS`               | 409               | `src/auth/passkeys/passkeys.service.ts:138-141` and Prisma `P2002` (`all-exceptions.filter.ts:125-129`)                                                                                                                                                                                                                                                                                                                                                                                                 |
| `INTERNAL_ERROR`               | 500               | the default for anything unhandled (`all-exceptions.filter.ts:79-80`)                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Three members are declared and reached by no code path: `INVALID_DATE`,
`TOKEN_EXPIRED` (over HTTP) and `PASSKEY_NOT_REGISTERED`
(`src/common/errors/error-code.ts:12,20,30`). Keeping a branch for each costs
nothing and the names are stable, but nothing in this build will send one.

Three more come from Prisma rather than from the enum, because the filter writes
them as literals: `TRANSACTION_TIMEOUT` (503, `details.retryable: true`,
`all-exceptions.filter.ts:142-148`), `TRANSACTION_CONFLICT` (409, same details,
`:149-154`) and `CONFLICT` for a failed foreign key (`:131-136`). And any status
below 500 that matches none of the coarse cases above is reported as the literal
`ERROR` (`:59-61`) — no route in this build produces one today.

`SESSION_REVOKED` deserves the longer explanation: every authenticated request
looks the `sessionId` claim in the bearer token up against its `Session` row, and
a row that is missing, carries a `revokedAt`, or belongs to a different account
fails here. Treat it as signed out — the refresh token behind it is dead as well.
A token that carries **no** `sessionId` claim fails the same way rather than being
skipped (`src/auth/strategies/jwt.strategy.ts:67-70`): the strategy would otherwise
be a logout bypass for every token minted before the claim existed.

`/sync` answers two more, and they are the reason a device stops syncing rather
than the reason it fails to sign in:

- `DEVICE_NOT_REGISTERED` (404) — no live `Device` row with that id for **this**
  account. Deliberately the same answer for "no such row" and "not yours": a
  finer one would let a caller probe which device UUIDs exist by trying to sync as
  them. The shipped client registers a device and retries, so this is self-healing.
- `DEVICE_REVOKED` (403) — the row is this account's and carries a `revokedAt`.
  Syncing stops until the device is registered again; a client must not retry in a
  loop, because nothing it can send will clear it.

Both are raised before any change is read, so a refused sync writes nothing.

---

## ⚡ REST Endpoints Specification

> [!IMPORTANT]
> **How the `Rate Limit` lines below actually apply.** Three things qualify every one of
> them, and they are stated once here rather than repeated on 40 endpoints:
>
> 1. **Throttling is on by default.** `CustomThrottlerGuard.shouldSkip()` stands the limits
>    down only when `NODE_ENV=test`, `DISABLE_RATE_LIMITING=true` or
>    `RATE_LIMIT_ENABLED=false`. The `x-skip-throttle` / `x-bypass-rate-limit` headers do nothing
>    unless an operator sets `RATE_LIMIT_HEADER_BYPASS=true`, and never under `APP_ENV=production`.
> 2. **The bucket is an IP, not a user.** `getTracker()` prefers `user:<req.user.id>` and
>    falls back to `ip:<first x-forwarded-for value>` — but this guard is registered as the
>    app-wide `APP_GUARD` (`src/app/app.module.ts`), and global guards run _before_ a route's
>    `JwtAuthGuard`, so `req.user` is always unset when the key is built. Every limit is
>    therefore per-IP for authenticated traffic too, which is why one office NAT divides one
>    account's login budget. See `MODULES_GUIDE.md`.
> 3. **Counters live in Redis, and an outage narrows them to one process.** The store is
>    `RedisThrottlerStorage` over `configurationService.redisUrl`. `REDIS_URL` is in
>    `.env.example:44` and in the worker schema (`src/worker.module.ts:40-46` — optional, and
>    with **no `.default()`**, because `@nestjs/config` writes every schema default back into
>    `process.env` and a default there would answer the "was it actually declared?" test with
>    the default and switch the gate off forever) but not the API's, and the `redisUrl` getter
>    itself substitutes `redis://localhost:6379` when nobody set it
>    (`src/config/configuration.service.ts:533-541`) — which is why the boot gate requires a
>    _declared_ value everywhere except development and a test run (`:305-320`), rather than
>    trusting the fallback. When a Redis command throws, `increment()` counts the hit in
>    `LocalThrottlerWindow` instead (`src/common/throttler/redis-throttler.storage.ts:116-132`,
>    `src/common/throttler/local-throttler.window.ts:55-99`), so the limit and its block still
>    hold — per process, forgotten at a restart, and given up only when that bounded table can
>    reclaim nothing (`:48-54`, `:111-131`). The degradation is reported at error level,
>    coalesced to one line per 30 seconds with the tallies separated into "counted in memory"
>    and "permitted with no counter at all" (`redis-throttler.storage.ts:238-272`), never as a
>    per-request warn.
> 4. **What a refusal actually looks like.** `CustomThrottlerGuard` extends the library
>    `ThrottlerGuard` (`src/common/guards/custom-throttler.guard.ts:5`) and overrides only
>    `shouldSkip()` and `getTracker()`, so the refusal path is the library's: the body is the
>    standard envelope with `statusCode: 429`, `code: "RATE_LIMITED"` — the status-derived
>    literal, since a throttler rejection carries no `code` of its own
>    (`src/common/error-handling/filters/all-exceptions.filter.ts:57-58`) — and one message
>    string, `"ThrottlerException: Too Many Requests"`. There is no `details` object and no
>    `retryAfter` field in the body: the wait is a header. `Retry-After` holds the whole-number
>    seconds the block lasts, and it is the only response header set on the refusal (asserted
>    against the guard in `src/common/guards/custom-throttler.guard.spec.ts:409`); the
>    `X-RateLimit-Limit` / `-Remaining` / `-Reset` trio is written on requests that were
>    **allowed**, so it is a remaining-budget readout, not a way to detect a limit. A client
>    that sleeps on the body alone retries immediately and burns the window again.
>
> Routes with **no** `@Throttle()` decorator — `POST /auth/logout`, `POST /auth/mfa/generate`,
> `POST /auth/mfa/enable`, `POST /auth/mfa/disable`, and everything under `/users`, `/devices`,
> `/notes`, `/tasks`, `/calendar`, `/sync`, `/vault` except the four vault routes below — take
> the global default: `RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS`, i.e. **100 requests
> per 60 s** unless the deployment overrides them.
>
> **Token lifetimes are configuration, and one number backs every claim about them.**
> `JWT_ACCESS_EXPIRATION` (default `15m`) and `JWT_REFRESH_EXPIRATION` (default `7d`) are read
> through `ConfigurationService` (`src/config/configuration.service.ts:567-568`, `:575-576`) and
> turned into seconds by `parseTokenLifetime()` (`:219`) — once at boot, so an unparseable value
> stops the process instead of surfacing as a 500 on the first sign-in (`:302-303`), and again on
> every read of `jwtAccessExpiresInSeconds` / `jwtRefreshExpiresInSeconds` (`:591-603`), which is
> why changing either variable needs a restart and nothing more. That seconds value is what every consumer uses:
> both `sign()` calls (`src/auth/auth.service.ts:1876`, `:1884`), the `expiresIn` a client counts
> down (`:1895`), the `Session.accessExpiresAt` / `refreshExpiresAt` columns written at login
> (`:1918`, `:1921`) and again at rotation (`src/auth/auth.service.ts:998`, `:1001`), the refresh cookie's `maxAge`
> (`src/auth/auth.controller.ts:93`) and the `JwtModule` default (`src/auth/auth.module.ts:35`).
> Until 2026-09-27 all of those were separate literals and the two variables reached none of them;
> if you are reading an older copy of this document, that is why it said setting them changed
> nothing. Defaults are unchanged, so the 15-minute / 7-day figures below are still the behaviour
> of an unconfigured deployment. A value this parser cannot read — `1w` is the likely one, since
> `jsonwebtoken` has no week — aborts the boot (`:302-303`) rather than surfacing as a 500 on someone's
> first sign-in. The MFA challenge token stays a literal `"5m"` and the passkey challenge TTL is
> likewise not configurable; neither has an environment variable.

### 1. Health, Operations & Metrics

#### `GET /`

- **Access**: `@Public()`
- **Purpose**: Root service status check, served by `AppController.getRoot` (`src/app/app.controller.ts:12-16`).
- **Response**: `200 OK`, verified against a running instance on 2026-09-27 — it is **not** the `{ "status": "ok", "message": "… is running" }` shape this section used to show:
  ```json
  {
    "message": "Allinone Backend API",
    "status": "running",
    "version": "1.0.0",
    "environment": "development",
    "documentation": "/api"
  }
  ```

#### `GET /health`

- **Access**: `@Public()`
- **Purpose**: Overall application health check. The only probe it runs is the database (`PrismaService.checkHealth()`, a raw `ping` command); the `redis` entry is written as `up` unconditionally, so a dead Redis does not change this answer (`src/health/health.service.ts:23,33-34`).
- **Response**: `200 OK` (or `503 Service Unavailable` when the database probe throws) — Terminus-shaped JSON:
  ```json
  {
    "status": "ok",
    "info": {
      "database": { "status": "up", "latency": 4 },
      "redis": { "status": "up" }
    },
    "error": {},
    "details": {
      "database": { "status": "up", "latency": 4 },
      "redis": { "status": "up" }
    }
  }
  ```

#### `GET /health/live`

- **Access**: `@Public()`
- **Purpose**: Liveness probe (process status check without DB queries).
- **Response**: `200 OK` `{"status":"ok"}`
- **Purpose**: Kubernetes liveness probe (checks process execution without hitting dependencies).
- **Response**: `200 OK` `{"status": "ok"}`

#### `GET /health/ready`

- **Access**: `@Public()`
- **Purpose**: Kubernetes readiness probe. It calls the same `healthService.checkTerminusHealth()` as `GET /health` (`src/health/health.controller.ts:41-42`), so it verifies database readiness only — no separate dependency set, no cache check.
- **Response**: `200 OK` (or `503 Service Unavailable`) — Terminus shape, as `GET /health`

#### `GET /metrics`

- **Access**: `MetricsScrapeGuard` alone (`src/common/metrics/metrics.controller.ts:13-18`) — deliberately _not_ the `JwtAuthGuard, AdminGuard` pair every other admin surface stacks, because guards run in declaration order and that pair answers `401` on the missing bearer session before `AdminGuard`'s `x-admin-secret` branch is reached, which is itself behind a `!request.user` refusal (`src/common/metrics/metrics-scrape.guard.ts:23-51`). The guard takes both presentations itself and fails closed in this order (`:60-87`): the configured `ADMIN_SECRET` presented complete as `Authorization: Bearer <secret>` (the shape Prometheus's `authorization: { type: Bearer, credentials_file }` emits) or as `x-admin-secret`, compared with `crypto.timingSafeEqual` over the whole value (`:129-146`); otherwise any non-empty `Authorization` is delegated to the real `JwtAuthGuard` then the real `AdminGuard` on the same context, so a signed-in admin still goes through `JwtStrategy.validate()`'s session-revocation checks; otherwise `401`.
- **Purpose**: Prometheus scrape endpoint exposing real-time operational metrics as `text/plain; version=0.0.4`.
- **Responses**: `200 OK` (`text/plain; version=0.0.4`). `401 Unauthorized` — `{"code": "UNAUTHORIZED", "message": "Authentication token missing or invalid"}`, the code the filter derives from the status because the exception carries none (`src/common/metrics/metrics-scrape.guard.ts:12-21`, asserted at `:522-547` of its spec) — when the caller presents neither an admin session nor the shared secret, when the bearer value is only a prefix of the secret, or when `ADMIN_SECRET` is unset/blank/under 32 characters (`ConfigurationService.adminSecret` returns `undefined`, which disables that branch outright) and no admin session is offered. It is a 401 and not a 403 on purpose: nothing about an anonymous caller was established enough to be _refused_. `403 FORBIDDEN` appears only on the delegated human path — authenticated, not an admin.

#### `GET /info`

`GET /info` is registered **twice** — `AppController.getInfo` (`src/app/app.controller.ts:18-22`, no prefix) and `HealthController.info` (`src/health/health.controller.ts:50-55`). The response a client actually gets is the `AppController` one; the `HealthService.getInfo()` payload (`{ name: "allinone-backend", version: "0.1.0", environment, commit: "HEAD" }`, `src/health/health.service.ts:44-53`) is unreachable through any route. Both are documented below because the second is what earlier revisions of this page described, and the two even disagree on the version string (`1.0.0` vs the `0.1.0` in `package.json`).

- **Access**: `@Public()`
- **Purpose**: Application metadata, served by `AppService.getInfo` (`src/app/app.service.ts`).
- **Response**: `200 OK`, verified against a running instance on 2026-09-27:
  ```json
  {
    "name": "Allinone Backend",
    "version": "1.0.0",
    "description": "Production-grade backend for cross-platform personal information management",
    "environment": "development",
    "timestamp": "2026-09-27T08:39:59.248Z",
    "features": [
      "Authentication",
      "User Management",
      "Device Management",
      "Offline-first Synchronization",
      "Notes Management",
      "Task Management",
      "Calendar Management",
      "Encrypted Password Manager",
      "Global Search",
      "Audit Logging",
      "File Attachments",
      "Notifications"
    ]
  }
  ```
  `version` is a literal, `environment` is `APP_ENV`, `timestamp` is the request time, and `features` is a hard-coded list. Two of its twelve entries describe things the backend does not do: there is no attachment write path at all (`Attachment` is read and never written, and no object-storage client exists — ARCHITECTURE.md "Why MinIO?"), and there is no notification delivery service (the `notification` queue has a processor and no producer, and nothing consumes it — ARCHITECTURE.md's queue warning). Treat this endpoint as a banner, not a capability report.

---

### 2. Authentication & Session Management (`/auth`)

#### `POST /auth/register`

- **Access**: `@Public()`
- **Rate Limit**: 3 per hour (`@Throttle({ default: { limit: 3, ttl: 3600000 } })`, `src/auth/auth.controller.ts:98`)
- **Body**: `RegisterDto` — `email` (required), `password` (required), `displayName?`, `locale?` (default `en-US`), `timezone?` (default `UTC`). The DTO is `RegisterDto`, not a `CreateUserDto`.
- **What it does** (`AuthService.register`): rejects a duplicate email with `409 EMAIL_ALREADY_REGISTERED`, then creates the user, Argon2 password authentication row marked unverified, and device row in one transaction. It requests an email-verification OTP and records `ACCOUNT_CREATED`.
- **Response**: `201 Created` — `AuthResponseDto` containing the `user` only while `EMAIL_VERIFY_ENABLED=true` (the default). The caller must verify the mailbox and then sign in. `EMAIL_VERIFY_ENABLED=false` is an isolated local/test opt-out which retains the legacy immediate-session response.
  There is no `isEmailVerified` or `mfaEnabled` in this response. The cookie follows the
  **session**, not the route: `register()` calls `setRefreshTokenCookie(res, result.tokens?.refreshToken)`
  (`src/auth/auth.controller.ts:108-120`), and while email verification is required
  `AuthService.register()` issues no session at all (`src/auth/auth.service.ts:171-175`), so
  `tokens` is absent and the helper returns at `:81` without setting anything — that is the
  only case in which registration sets no cookie. With `EMAIL_VERIFY_ENABLED=false` the same
  call does write the `refresh_token` cookie, because that response really did open a session.
  In that case the body still carries `tokens.refreshToken`, but a browser cannot read it
  back from script: the copy the web session refreshes with is the `httpOnly` cookie, so a
  web client may ignore `tokens.refreshToken` entirely. `tokens.accessToken` is the opposite
  — it is the bearer value the client must keep in memory and send itself.
- An unverified account cannot authenticate while email verification is enabled. `ADMIN_EMAILS` additionally requires this verified state; prefer `ADMIN_USER_IDS` for administrator provisioning.

#### `POST /auth/login`

- **Access**: `@Public()`
- **Rate Limit**: 5 per minute (`limit: 5, ttl: 60000`)
- **Body**: `LoginDto` — `email`, `password`, and optionally `deviceId`, `deviceName`, `platform` (a `Platform` enum value such as `MACOS`, `LINUX`, `ANDROID`, `WEB`), `appVersion`, `publicKey`.
- **Response**: `200 OK`
  - **MFA not enabled**: full `AuthResponseDto` (`user`, `tokens`, `sessionId`, `deviceId`), and `setRefreshTokenCookie()` mirrors the refresh token into a cookie. The failed-attempt counter is reset here.
  - **MFA enabled**: `200` with `{ mfaRequired: true, mfaToken }` and **no** `user`/`tokens` — `tokens` is absent, so `setRefreshTokenCookie()` returns at its first line (`src/auth/auth.controller.ts:81`) and no cookie is set. The `mfaToken` is a separate JWT: `purpose: "MFA_CHALLENGE"`, `type: "mfa_challenge"`, `expiresIn: "5m"`, and signed with `ConfigurationService.jwtMfaSecret` — **not** the access secret (`src/auth/auth.service.ts:411-420`, and the same shape in `loginWithOAuth()` at `:820-828`; the secret is `JWT_MFA_SECRET`, or a domain-separated HMAC of `JWT_ACCESS_SECRET` when that is unset, `src/config/configuration.service.ts:545-552`). Exchange it at `POST /auth/mfa/verify`.
  - **Wrong credentials**: `401 INVALID_CREDENTIALS`, after incrementing `failedLoginAttempts` and writing a `LOGIN_FAILURE` audit row with the caller's IP and user-agent. A nonexistent email and a wrong password answer identically, but a `409` for a locked or suspended account is distinguishable, which leaks account state.
- **Cookie attributes** — set by `setRefreshTokenCookie()` (`src/auth/auth.controller.ts:80-95`): `name=refresh_token`, `httpOnly: true`, `secure: true` (pinned, not environment-derived), `sameSite: "strict"`, `path: "/auth/refresh"`, and a `maxAge` matching the configured refresh lifetime. The `strict` value is a deployment constraint, not a preference — see the SameSite note under `POST /auth/refresh` for what breaks when the web app and this API are not on one registrable domain.
  - When MFA is enabled the answer is `{ "mfaRequired": true, "mfaToken": "<CHALLENGE_JWT>" }` — the field is `mfaToken`, on both `AuthResponseDto` (`src/auth/dto/auth-response.dto.ts:61-64`) and the `VerifyMfaLoginDto` that spends it (`src/auth/dto/mfa.dto.ts:15-19`). There is no `tempToken` in this build; a client sending that name gets `400 VALIDATION_ERROR` on both counts (missing `mfaToken`, unknown extra key).
- **Lockout Defense**:
  - 5 consecutive invalid password attempts automatically locks the account for 15 minutes.
  - Subsequent requests during lockout fail with `401 Unauthorized`: `"Account is temporarily locked due to multiple failed login attempts. Please try again in X minute(s)."`.
  - Emits `ACCOUNT_LOCKED` audit log event. Account can be unlocked by admin via `POST /admin/users/:userId/unlock`.

#### `POST /auth/oauth/google`

- **Access**: `@Public()`
- **Rate Limit**: 10 per minute per IP
- **Body**: `{ "idToken": "<GOOGLE_ID_TOKEN>", "deviceId": "...", "platform": "..." }`
- **Verification**: Cryptographically validated via `google-auth-library` (`OAuth2Client.verifyIdToken`).
- **Response**: `200 OK` — Standard `AuthResponseDto` + sets `refresh_token` cookie.

#### `POST /auth/oauth/apple`

- **Access**: `@Public()`
- **Rate Limit**: 10 per minute per IP
- **Body**: `{ "idToken": "<APPLE_ID_TOKEN>", "deviceId": "...", "platform": "..." }`
- **Verification**: Cryptographically validated via live RS256 JWKS signature verification from `https://appleid.apple.com/auth/keys` with 24-hour key caching, issuer (`https://appleid.apple.com`), and client ID audience validation.
- **Response**: `200 OK` — Standard `AuthResponseDto` + sets `refresh_token` cookie.

#### `POST /auth/oauth/microsoft`

- **Access**: `@Public()`
- **Rate Limit**: 10 per minute per IP
- **Body**: `{ "idToken": "<MS_ID_TOKEN>", "deviceId": "...", "platform": "..." }`
- **Verification**: Cryptographically validated via live RS256 JWKS signature verification from `https://login.microsoftonline.com/common/discovery/v2.0/keys` with 24-hour key caching, issuer, and client ID audience validation.
- **Response**: `200 OK` — Standard `AuthResponseDto` + sets `refresh_token` cookie.

#### `POST /auth/refresh`

- **Access**: `@Public()`
- **Rate Limit**: 10 per minute (`@Throttle({ default: { limit: 10, ttl: 60000 } })`, `src/auth/auth.controller.ts:215`)
- **Input**: `refreshToken` in the body **or** the `refresh_token` httpOnly cookie. `RefreshTokenDto.refreshToken` is optional, so `{}` reaches the handler and is answered from there. **The body wins**: `const refreshToken = dto.refreshToken || cookieToken` (`src/auth/auth.controller.ts:240`), so a client that sends both is served from the body and the ambient cookie is not consulted. The body form is the native path; the cookie is the browser path.
- **CSRF barrier — the one thing a browser integrator must send**: a **cookie-only** refresh has to carry `x-client-version` with a non-empty value. `REFRESH_REQUEST_HEADER = "x-client-version"` (`src/auth/dto/refresh-token.dto.ts:12`), checked by `hasRefreshBarrier()` (`src/auth/auth.controller.ts:264-271`) and enforced at `:248-253`, which throws `forbidden(ErrorCode.TOKEN_INVALID, "Refresh with the ambient cookie requires the x-client-version header")` — a `403`. A body token needs nothing else. The reasoning is the comment at `:242-247`: a cookie proves nothing, because the browser attaches it to a cross-site form post on its own, and only `SameSite=strict` — a deployment property an operator can change by accident — stands between that post and a minted access token. A foreign page cannot add a custom header, so the header is the proof that survived.
- **Responses**, and the two bodies a reference needs:
  - `200 OK` — a rotated access/refresh pair, and `refresh_token` re-set as a cookie for the new refresh token (`:260`).
  - `401` `{"code":"TOKEN_INVALID","message":"Refresh token is required"}` when neither a body token nor a usable cookie is present (`:255-257`).
  - `403` `{"code":"TOKEN_INVALID","message":"Refresh with the ambient cookie requires the x-client-version header"}` (`:248-253`).
  - `401` `{"code":"TOKEN_INVALID","message":"Invalid or expired refresh token"}` for every credential failure below (`src/auth/auth.service.ts:899-904`, `:960-990`).

  `unauthorized()` and `forbidden()` are the same helper shape with a different Nest exception (`src/common/errors/http-errors.ts:45-59`), so the `code` is identical and only the status separates "no credential here" from "credential here but the barrier is missing". The filter forwards that in-body `code` instead of the status-derived one (`src/common/error-handling/filters/all-exceptions.filter.ts:89-92`): branch on the status first here.

- **A malformed cookie is a 401, not a 500.** The `Cookie` header is attacker-controlled bytes on an unauthenticated route, and `extractCookie()` (`src/auth/auth.controller.ts:66-78`) wraps its `decodeURIComponent` in a `try`: a value that cannot be percent-decoded — `refresh_token=%` is enough — is treated as **absent**, so the request falls through to the plain `"Refresh token is required"` 401 rather than leaving the handler as a 500 or as a barrier failure with raw bytes handed to `refreshTokens`. `req.cookies` is consulted first only for a deployment that adds `cookie-parser`; nothing in this app registers it, so the header parse is the path a browser's cookie actually travels (`:229-239`).
- **Deployment consequence the operator has to know before the first deploy**: `setRefreshTokenCookie()` (`src/auth/auth.controller.ts:80-95`) pins `httpOnly`, `secure: true` unconditionally, `sameSite: "strict"`, `path: "/auth/refresh"` and a `maxAge` of `JWT_REFRESH_EXPIRATION`. `SameSite=strict` means **the web app and this API must share one registrable domain** (`app.example.com` beside `api.example.com`). Under two different registrable domains (`app.example.com` against a `.railway.app` / `.onrender.com` API host) the browser never attaches the cookie, and the failure is not loud: sign-in works, the access token works for its first 15 minutes, and the first refresh is a `401 "Refresh token is required"` that reads as an expired password. CORS has to carry credentials for the same origin pair (`src/main.ts:102`, `credentials: !allowsWildcard` — a wildcard `CORS_ORIGIN`/`CORS_ORIGINS` deliberately never does).
- **What actually decides acceptance** (`AuthService.refreshTokens`, `src/auth/auth.service.ts:895-1056`): the presented string is verified against `JWT_REFRESH_SECRET` — so an **access** token is rejected here, since it is signed with a different secret; the two secrets must stay different, and `.env.example` ships distinct placeholders for exactly this reason. Then a `Session` row must exist whose stored `refreshToken` equals `hmac-sha256(JWT_REFRESH_SECRET, presented)` (`hashRefreshToken()` `:91-96`, looked up at `:944-948`), with one deliberate compatibility read of the raw value so rows written before the digest landed still rotate and get rewritten (`:950-957`). Then `revokedAt` unset, `refreshExpiresAt` in the future and `userId === payload.sub` (`:970-978`), and the account must not be blocked or soft-deleted (`:985-990`) — a suspended account gets the same opaque 401 rather than the word "suspended", because this route is unauthenticated.
- **Rotation**: a brand-new pair is minted and written over the row's `accessToken` / `refreshToken`, with `accessExpiresAt` and `refreshExpiresAt` recomputed from the same parsed `JWT_ACCESS_EXPIRATION` / `JWT_REFRESH_EXPIRATION` values the new tokens were signed with (`src/auth/auth.service.ts:998`, `:1001`, written at `:1005-1013`) — so the row and the credentials cannot drift, and the `15 min` / `7 days` figures hold only because those are the defaults.
- **Storage safety and reuse**: newly created and rotated sessions store only the HMAC digest above; the legacy required `accessToken` column holds the non-secret session id (`src/auth/auth.service.ts:1006-1012`). Reuse is then answered in two stages, not one: a token presented again within the 30-second rotation grace window replays the pair that was already minted for it — concurrent refreshes and a lost response are normal traffic, and the grace record is shared rather than per-process (`REFRESH_ROTATION_GRACE_MS` `:60`, read at `:913-940`, written at `:1020-1028`) — while the same credential turning up **outside** that window matches no row, and `reportConfirmedRefreshTokenReuse()` (`:1068-1114`) logs a confirmed-reuse warning and revokes every unrevoked `Session` for that account (`:1110-1114`) before the caller gets the opaque 401. There is no family/lineage column: rotation rewrites the same row, so the revocation is scoped per account (`:1104-1109`).

#### `POST /auth/logout`

- **Access**: `JwtAuthGuard`
- **Rate Limit**: none on the route — the global default (100 per 60 s) applies.
- **Response**: `200 OK` `{"success": true}` — sets `revokedAt` on the session named by the calling token's `sessionId` claim (`AuthService.logout()`, `src/auth/auth.service.ts:1116-1129`, an `updateMany` on `id: sessionId, revokedAt: null` at `:1121-1124`) and clears the `refresh_token` cookie with the **same** `path` it was written with: `res.clearCookie(REFRESH_COOKIE_NAME, { path: "/auth/refresh" })` (`src/auth/auth.controller.ts:283`, matching `:88`). A clear that did not repeat the `Path` would leave the live cookie in place, so an operator reading a stale session in the browser after a logout is looking at the attribute, not at a server that kept the credential. From the next request on, that token fails with `401 SESSION_REVOKED`, because `JwtStrategy.validate()` re-reads the session row. **This does not affect an open `/sync` WebSocket** — the gateway authenticates only at handshake and never re-checks the session.

#### `POST /auth/verify-email/request`

- **Access**: `@Public()`
- **Rate Limit**: 3 per minute
- **Body**: `{ "email": "user@example.com" }`
- **Response**: `200 OK` `{"message": "Verification email sent if account exists"}` — the same answer whether or not the address is registered, preventing enumeration. The OTP is generated and mailed while `EMAIL_VERIFY_ENABLED` is on; it defaults to `true`.

#### `POST /auth/verify-email/confirm`

- **Access**: `@Public()`
- **Rate Limit**: 5 per minute
- **Body**: **two accepted shapes**, and every field in `ConfirmEmailDto` is optional:
  - `{ "email": "user@example.com", "otp": "123456" }` — the OTP path: the code is SHA-256 hashed and matched against the stored row with a raw `findAndModify` on the OTP collection (`src/auth/auth.service.ts:858-885`).
  - `{ "token": "<64-hex-token>" }` — the legacy link path.
  - `{}` passes DTO validation and is rejected in the service, not by the pipe.
- **Response**: `200 OK` `{"message": "Email address verified successfully"}`

#### `POST /auth/forgot-password`

- **Access**: `@Public()`
- **Rate Limit**: 3 per minute
- **Body**: `{ "email": "user@example.com" }`
- **Response**: `200 OK` `{"message": "Password reset instructions dispatched"}` — again constant regardless of whether the account exists. Delivery goes through `MailService`, which is `@Optional()` in `AuthModule`; if SMTP is not configured the OTP is created but the mail is skipped, and the caller still sees this message.

#### `POST /auth/reset-password`

- **Access**: `@Public()`
- **Rate Limit**: 5 per minute
- **Body**: `{ "email": "user@example.com", "otp": "123456", "newPassword": "NewSecureP@ssw0rd!" }` — all three **required**. Note the shape changed with the OTP flow: there is no `token` field here, so a client still posting `{ token, newPassword }` gets a `400` on `email`/`otp`, and `newPassword` must be ≥ 8 characters.
- **Response**: `200 OK` `{"message": "Password reset successfully"}`
- **Side effects**: the password hash is replaced with Argon2 and existing sessions/refresh tokens for the account are revoked, so a reset does log the user out everywhere.

#### `POST /auth/mfa/generate`

- **Access**: `JwtAuthGuard`
- **Purpose**: Generates TOTP secret and QR code for authenticator apps.
- **Response**: `200 OK` — `MfaSecretResponseDto` (`src/auth/dto/mfa.dto.ts:56-71`), returned verbatim by `AuthService.generateMfaSecret()` (`src/auth/auth.service.ts:1469-1473`). Three fields, and neither of the two older names this section used to show exists:
  ```json
  {
    "secret": "JBSWY3DPEHPK3PXP",
    "otpauthUrl": "otpauth://totp/Allinone:user@example.com?secret=…&issuer=Allinone",
    "qrCodeDataUrl": "data:image/png;base64,…"
  }
  ```

#### `POST /auth/mfa/enable`

- **Access**: `JwtAuthGuard`
- **Body**: `{ "totpCode": "123456" }` — the field is `totpCode` and it is a required 6-digit string (`EnableMfaDto`, `src/auth/dto/mfa.dto.ts:4-13`). There is no `token` field; a client posting `{ "token": "123456" }` gets a `400` naming both problems.
- **Response**: `200 OK` — `MfaEnableResponseDto` carries `recoveryCodes` and nothing else (`src/auth/dto/mfa.dto.ts:73-79`, returned at `src/auth/auth.service.ts:1531-1533`). There is no `success` flag to read.
  ```json
  {
    "recoveryCodes": ["A1B2-C3D4", "E5F6-G7H8"]
  }
  ```

#### `POST /auth/mfa/verify`

- **Access**: `@Public()`
- **Rate Limit**: 5 per minute (`limit: 5, ttl: 60000`, `src/auth/auth.controller.ts:351`)
- **Body**:
  ```json
  {
    "mfaToken": "<MFA_CHALLENGE_JWT>",
    "totpCode": "123456",
    "recoveryCode": "A1B2-C3D4"
  }
  ```
  _(`mfaToken` is required and is the value login returned as `mfaToken`; supply either `totpCode` or the single-use `recoveryCode`. `VerifyMfaLoginDto`, `src/auth/dto/mfa.dto.ts:15-33`.)_
- **Response**: `200 OK` — Full `AuthResponseDto` with session tokens, and `setRefreshTokenCookie()` mirrors the refresh token into the `refresh_token` cookie like login does (`src/auth/auth.controller.ts:356-369`). A browser client that completes MFA and then refreshes needs that cookie; it is set whether or not the client reads `tokens.refreshToken` out of the body.

#### `POST /auth/mfa/disable`

- **Access**: `JwtAuthGuard`
- **Security Constraint**: **Dual-factor required**. Must supply valid account password AND either current TOTP code or single-use recovery code.
- **Body**:
  ```json
  {
    "password": "SecurePassword123!",
    "totpCode": "123456",
    "recoveryCode": "A1B2-C3D4"
  }
  ```
- **Response**: `200 OK` `{"success": true}` — the handler's declared return type is `{ success: boolean }` (`src/auth/auth.service.ts:1606`, `:1678`); there is no `message` field.

---

### 3. Users & Sessions (`/users`)

#### `GET /users/me`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — the stored `User` row, verbatim. `UsersService.getUserById` passes no `select` and `sanitizeUser` returns a shallow copy that drops no field (`src/users/users.service.ts:24-28,193-196`), so this answer carries no MFA flags and no session meta; `status`, `failedLoginAttempts`, `lockedUntil` and `deletedAt` are in it.
  ```json
  {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "email": "user@example.com",
    "displayName": "Alex Mercer",
    "avatar": null,
    "locale": "en-US",
    "timezone": "UTC",
    "status": "ACTIVE",
    "emailVerifiedAt": null,
    "lastLoginAt": "2026-09-26T09:58:00.000Z",
    "failedLoginAttempts": 0,
    "lockedUntil": null,
    "createdAt": "2026-09-01T10:00:00.000Z",
    "updatedAt": "2026-09-26T09:58:00.000Z",
    "deletedAt": null
  }
  ```
  The shape is `prisma/schema.prisma:18-69`. The account's password verifier is not in this answer — it lives on the separate `Authentication` model (`prisma/schema.prisma:95-110`), which this query never loads.

#### `PATCH /users/me`

- **Access**: `JwtAuthGuard`
- **Body**: `UpdateUserProfileDto` — every field optional; the avatar column is called `avatar`, not `avatarUrl` (`src/users/dto/update-user-profile.dto.ts:4-36`)
  ```json
  {
    "displayName": "Alex Mercer",
    "avatar": "https://cdn.example.com/avatar.png",
    "locale": "en",
    "timezone": "America/New_York"
  }
  ```
- **Response**: `200 OK` — Sanitized updated user profile.

#### `POST /users/me/export`

- **Access**: `JwtAuthGuard`
- **Purpose**: Records a GDPR/CCPA export request. **It enqueues nothing** — `UsersService.requestDataExport` reads the user, writes a log line and returns; no job reaches the `export` queue (`src/users/users.service.ts:388-406`).
- **Response**: `202 Accepted` `{"status": "accepted", "message": "Data export request recorded. Background export delivery is disabled."}`

#### `DELETE /users/me`

- **Access**: `JwtAuthGuard`
- **Purpose**: Soft deletes account (`status = DELETED`, `deletedAt = now()`) and revokes all active sessions and devices in one transaction (`src/users/users.service.ts:207-248`).
- **Response**: `200 OK` `{"success": true}`

#### `GET /users/me/sessions`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — full live `Session` rows ordered by `lastActivityAt`, so `ipAddress`, `userAgent`, `accessExpiresAt` — and `accessToken` / `refreshToken` — are all in the body; the only projection is on the nested `device` (`{ id, name, platform, appVersion }`), and rows past `refreshExpiresAt` or carrying `revokedAt` are excluded (`src/users/users.service.ts:127-151`).

#### `DELETE /users/me/sessions/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` `{"message": "Session revoked"}`

---

### 4. Devices Management (`/devices`)

#### `GET /devices`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — List of registered user devices.
- **Response**: `200 OK`
  ```json
  [
    {
      "id": "dev-123e4567-e89b-12d3-a456-426614174000",
      "deviceName": "Alex's iPhone 16",
      "platform": "IOS",
      "appVersion": "1.4.0",
      "publicKey": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...",
      "lastSyncAt": "2026-09-10T15:30:00.000Z",
      "createdAt": "2026-09-01T08:00:00.000Z"
    }
  ]
  ```

#### `GET /devices/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Device metadata.

#### `POST /devices`

- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "deviceName": "Alex's Pixel 9",
    "platform": "ANDROID",
    "appVersion": "1.4.0",
    "publicKey": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A..."
  }
  ```
- **Response**: `201 Created` — Registered device details.

#### `PATCH /devices/:id`

- **Access**: `JwtAuthGuard`
- **Body**: `{ "deviceName": "Alex's Work Phone", "appVersion": "1.4.1" }`
- **Response**: `200 OK` — Updated device record.

#### `DELETE /devices/:id`

- **Access**: `JwtAuthGuard`
- **Purpose**: Revokes device authorization and revokes all active sessions bound to this device ID.
- **Response**: `200 OK` `{"message": "Device access revoked"}`

---

### 5. Realtime & Delta Synchronization (`/sync`)

**Two write paths, and they do not carry the same weight.** For `vault_item`, the
oplog below is the only way in: `VaultModule` exposes settings and recovery only,
and there is no REST route that creates, edits or deletes an entry. For `note`,
`task` and `event` there is a full REST CRUD surface, and it writes the entity row
(`Note`, `Task`, `Event`) _and_ appends a `Change`. A `/sync/push` always appends
the `Change`, and for a **note** it now also projects the accepted change onto the
`Note` row (`projectAcceptedChange`, `src/sync/change-projection.ts`) — see
[What a push writes to the `Note` table](#what-a-push-writes-to-the-note-table).
`task`, `event`, `calendar` and `habit` still append to the log and touch nothing
else, so a task pushed from a device has no `Task` row and `GET /tasks` will not
answer for it. What _is_ true of both paths: `appendChange`
(`src/sync/change-cursor.ts`) is the only way to write a `Change`, and it allocates
the cursor, so a logged change cannot be numbered 0 and become unreadable.
`entityType` must be one of `note`, `task`, `event`, `calendar`, `habit`,
`habit_log`, `vault_item` (`SYNC_ENTITY_TYPES` in
`src/sync/change-payload.validator.ts`); anything else is refused as that one
change with `SYNC_PUSH_REJECTED` and nothing is written for it — see
`rejected` below.

#### `POST /sync/push`

- **Access**: `JwtAuthGuard`
- **Headers**: `Idempotency-Key` (optional — and only safe when derived from the
  batch). `IdempotencyInterceptor` is bound globally and this route is **not** in
  its exempt list (only `…/vault…` paths are), so a header here is honoured: the
  cached response is looked up by `(userId, key)` and returned _before_ the handler
  runs. The endpoint and method are recorded on the row but no lookup uses them, so
  one key reused across batches answers the second batch with the first batch's
  `accepted` and the second batch's changes are never appended — a 201 naming
  changes the device never made, indistinguishable from a queue that landed. The
  shipped client sends no such header on any route, which is a habit rather than a
  guarantee. Derive the key from the batch, or send none: the version guard is what
  makes a retry safe here, and it works without the header.
- **Body**:
  ```json
  {
    "deviceId": "123e4567-e89b-12d3-a456-426614174000",
    "changes": [
      {
        "entityType": "note",
        "entityId": "123e4567-e89b-12d3-a456-426614174000",
        "operation": "UPDATE",
        "version": 4,
        "payload": { "title": "Meeting Notes Updated", "content": "..." }
      },
      {
        "entityType": "vault_item",
        "entityId": "123e4567-e89b-12d3-a456-426614174001",
        "operation": "UPDATE",
        "version": 2,
        "payload": {
          "type": "LOGIN",
          "encryptedData": "base64 AES-GCM ciphertext",
          "iv": "base64 96-bit nonce",
          "authTag": "base64 GCM tag",
          "isEncrypted": true
        }
      }
    ]
  }
  ```
  `operation` is `CREATE | UPDATE | DELETE | RESTORE`. A `vault_item` content change must
  carry all five payload keys above with those exact names; a `vault_item`
  `DELETE` is stored with whatever it sends, because the validator only judges
  operations that are supposed to rebuild an entry, and today's client sends
  `{}`. `changes` is capped at 500 items per request (`MAX_CHANGES_PER_PUSH`,
  enforced by `@ArrayMaxSize`): the cap is the size of one request, and each change
  inside it is read, version-checked, projected and written in a `$transaction` of
  its own. The request body itself is bounded by body-parser's 100 kB default, and
  the shipped client stops a batch at 64 KiB of JSON to stay under it.
- **Response**: `201 Created`
  ```json
  {
    "success": true,
    "accepted": ["change-row-id-1", "change-row-id-2"],
    "conflicts": [
      {
        "entityId": "123e4567-e89b-12d3-a456-426614174003",
        "entityType": "vault_item",
        "reason": "VERSION_MISMATCH",
        "clientVersion": 5,
        "serverVersion": 7,
        "serverPayload": { "type": "LOGIN", "encryptedData": "..." }
      }
    ],
    "rejected": [
      {
        "id": "123e4567-e89b-12d3-a456-426614174004",
        "errorCode": "SYNC_PUSH_REJECTED",
        "message": "changes[2].payload.authTag: must be a present, non-empty string."
      }
    ],
    "newCursor": "142857",
    "processedCount": 4,
    "conflictsResolved": 0,
    "highestCursor": "142857",
    "lastPushedSequence": 4
  }
  ```
  `rejected` is shown for the case it exists, and `truncated` is shown nowhere
  because it is only ever `true` — see below.
  `accepted` lists the ids of the `Change` rows that were written, **not** the
  `entityId`s that were queued — a client cannot infer what was stored from it.
  `processedCount` and `lastPushedSequence` count the changes the request
  **carried** (`dto.changes.length`), refused ones included, so neither is a
  receipt that the batch landed: a device settling its queue has to read
  `accepted`, `conflicts` and `rejected` together.
  `conflicts[].reason` is `VERSION_MISMATCH`: the only value any code path
  emits, despite what this page once claimed about `CLIENT_BEHIND` and
  `CONCURRENT_EDIT` also being possible. A change is refused only when its
  `version` is **strictly lower** than the newest one stored for that entity;
  equal and higher are both accepted. Equal is a decision, not an oversight — a
  push whose response was lost is re-sent at the number it already got, and
  refusing `==` would report a conflict over work already in the log and make the
  client drop its own queue entry for it. Nothing on the request distinguishes
  that retry from two devices that edited from the same version, so both land and
  the later row wins by cursor order, with no signal to the author whose write
  was overwritten. The client notices one layer up, when the winner arrives on
  its next pull and rewrites the note under it.
  A refused change is not stored: the client keeps it and must reconcile against
  `serverPayload`.

##### Decisions are per change: `rejected` and `truncated`

Every change in a push is decided on its own. It used to be the **batch** that was
judged: `assertPushableChanges()` threw for the whole request before a single write,
and a projection could throw inside the transaction, so one invalid item rolled back
every co-batched item. The client's answer to a refused request is to keep the queue
(`lib/services/sync_manager.dart` treats it as "skip this round"), so a change the
server will never accept was retried forever and blocked its neighbours — a
permanently stuck sync queue, which is data loss and not an annoyance.

Now the sound half of a batch is applied and committed, and the sick half comes back
inside the same `201`:

- `rejected` — optional, **absent entirely** when nothing was refused. One entry per
  change this server did not store:
  `{ "id": string, "errorCode": string, "message": string }`.
  `id` is the **`entityId` the device sent**, not a `Change` row id — the row was
  never written, and a queue entry can only be settled by the id the device
  recognises. `conflicts[]` identifies a refused change the same way, for the same
  reason.
- `truncated` — optional, present as `true` only when the response had to stop
  listing rejections. `rejected` is capped at 100 entries
  (`MAX_REJECTED_ENTRIES`, `src/sync/sync.service.ts`) while a push may carry 500
  changes, so the array is a bounded report and not a receipt. A client that clears
  queue entries by `rejected[].id` **must check this flag first**: on `truncated`
  it should drop only the named ids and re-send the rest as a smaller batch, where
  they fit under the cap and get named. Absent means the list is complete.

`errorCode` is the part a client branches on, and there are two:

| `errorCode`              | Asked by                                                                              | Means to the device                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYNC_PUSH_REJECTED`     | `changePayloadRejection()` (`src/sync/change-payload.validator.ts`), before any write | The payload is one no device could replay — a missing `content` key, a `vault_item` blob with no `authTag`, an unknown `entityType`. Retrying it identically fails identically; the builder is broken.                                                                  |
| `SYNC_PUSH_UNAUTHORIZED` | the projection, inside the change's transaction                                       | The shape is fine and the **authority** is not: a `finance_shared_expense` crediting a payer outside the group, naming a stranger in `shares[]`, or pointing `payerAccountId` at somebody else's account. Drop the row and re-read the group; do not retry it as a bug. |

`message` is developer-facing prose: for `SYNC_PUSH_REJECTED` it is the field paths
and constraints the same `toSentence()` humaniser produced for the pipe-shaped 400
this replaced (`changes[2].payload.authTag: …`), and for
`SYNC_PUSH_UNAUTHORIZED` it is the domain guard's own sentence. It is trimmed to 240
characters, so it is for a log line and never for a UI string.

Nothing about the keys that were already in the response changed: `accepted`,
`conflicts`, `newCursor`, `processedCount`, `conflictsResolved`, `highestCursor`
and `lastPushedSequence` carry the same names and meanings, and a batch that lands
whole answers exactly as it did before. A refusal is **not** a 4xx: a 400 would put
the client back to retrying everything it was just shown. A database outage still
is a 500 and unwinds the request, because a device that dropped its queue over an
outage would lose edits the server never refused.

##### What a push writes to the `Note` table

Until now `/sync/push` appended a `Change` and stopped, which quietly made the
`Note` row a stale echo: a note edited on a laptop had its new text on the log and
not in the table, so `GET /notes`, the `search` filter, the AI routes and anything
reading `prisma.note` answered from the body the note was created with — and a REST
edit afterwards logged a payload built from that stale row, which every device then
replayed over the newer one. An accepted note change now also writes the row, in
the same `$transaction` as its log append, through
`projectAcceptedChange` (`src/sync/change-projection.ts`).

What that write does, and does not, say:

| Rule                                 | Behaviour                                                                                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only accepted changes                | A `VERSION_MISMATCH` refusal writes no row. The mirror agrees with the log.                                                                                                                                                      |
| Only the keys the payload spoke      | `tags`, `color`, `noteType` and `structured` are optional on the wire. A phone on the build before them pushes `{title, content}` and must not clear the user's labels in the table.                                             |
| `version` comes from the envelope    | Not from the payload, and not by incrementing: the row's version has to be the number the log accepted, or REST's `increment: 1` starts from a copy behind the log.                                                              |
| The tie rule a device applies        | `version < row.version` does nothing; against a tombstone an equal version loses to the delete, because a delete and the in-flight edit that raced it carry the same number. `RESTORE` is the one operation that always revives. |
| `DELETE` marks, and never invents    | `deletedAt` is set and the version mirrored. A delete for an id this server never saw writes nothing.                                                                                                                            |
| Another account's note               | Read unfiltered by owner and compared: a mismatch logs a warning and writes nothing. `entityId` is the one field in a push that can name something the caller does not own.                                                      |
| A value the column cannot hold       | Dropped, not coerced. `changePayloadRejection` has already refused such a change; this is the second line, because a throw here now costs that one change its write.                                                             |
| `updatedAt`                          | Not written. Prisma stamps it, and the projection would be overriding when this server last changed the row.                                                                                                                     |
| `folderId`, `isPinned`, `isArchived` | Untouched. A device's arrangement of a note, never on the wire.                                                                                                                                                                  |

Two consequences a caller should know before relying on the row: the projection
does not snapshot into `NoteHistory`, so a device's edit is not a version a
`GET /notes/:id/history` can offer back, and it does not run the `noteTags`
normalisation the REST path performs, so the scalar `tags` column and the
`NoteTag` join can now disagree by more than a build order. And a change that
fails to project rolls back **its own** transaction and comes home in `rejected` —
the client keeps that one queue entry while the rest of the batch is committed,
which is visible, rather than a log entry whose mirror silently lied.

##### Who a pushed `finance_shared_expense` may name

A shared expense carries three references to people, and a push used to copy all
three out of the payload verbatim while `POST /finance/groups/:id/expenses` resolved
them under the caller. Because `replicateGroupChange` (`src/sync/sync.service.ts`)
copies the accepted change into the oplog of every account the group answers to, a
forged id did not stay on the forger's device — it landed in the named person's own
change stream and rendered on their devices as something they authored, while
`readBalances` (`src/finance/services/groups.service.ts:841`) settles who is owed
from `paidByUserId` and who owes from the shares. The projection now checks all
three (`src/sync/change-projection.ts`), and each refusal is a
`SYNC_PUSH_UNAUTHORIZED` entry in `rejected`, not a 403:

| Reference         | Rule                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paidByUserId`    | The pusher, or a current member of the group the row belongs to. "Member" is the group's own `members` column **plus** its owner **plus** every user holding a live `EXPENSE_GROUP` grant — the same set this row is replicated to. Absent credits the pusher, as it always did, and the client's local `"You"` is read as the pusher. A trip-only expense has no member list, so only the pusher may be named. |
| `shares[].userId` | Every participant, same set, same `"You"`/pusher coercions. Uniqueness alone was never enough: an id outside the group invents a debt on somebody who is not in it.                                                                                                                                                                                                                                             |
| `payerAccountId`  | An account the pusher owns (`FinanceAccount.userId === pusher`, not soft-deleted), resolved through the same `resolveReferenceOwner`/`referenceIsUnusable` pair the `finance_transaction` branch uses. `FinanceAccount` has no group column, so "an account of this group" is only expressible as "an account of this group member" — which is what the REST boundary checks too (`assertAccountScope`).        |

An EDITOR who is not the owner keeps writing honest splits: their grant is what
`assertSharedScope` checks, and it is in the member set above, so naming themselves,
the owner, or another grantee still lands.

#### `POST /sync/pull`

- **Access**: `JwtAuthGuard`
- **Body**: `PullSyncDto` (`deviceId`, `cursor?`, `limit?` — default 100)
- **Response**: `200 OK`
  ```json
  {
    "changes": [
      {
        "id": "chg-987",
        "userId": "usr-1",
        "deviceId": "dev-1",
        "entityType": "note",
        "entityId": "not-123",
        "operation": "UPDATE",
        "version": 4,
        "payload": { "title": "Meeting Notes Updated" },
        "cursor": "142857",
        "createdAt": "2026-09-10T16:00:00.000Z",
        "clientTimestamp": "2026-09-04T09:15:00.000Z"
      }
    ],
    "nextCursor": "142857",
    "hasMore": false
  }
  ```
- **Notes**: rows are filtered by the authenticated `userId` unconditionally and
  ordered by `cursor` (per-user monotonic, allocated by `SyncCursor`), so a
  replay never goes backwards and an edit always precedes the delete that
  followed it. An empty page echoes the caller's `cursor` back as `nextCursor`
  rather than returning `"0"`, which would restart a device from the beginning
  of its log. `cursor` must be digits only.
  `createdAt` is when **this server** stored the change; `clientTimestamp` is the
  pushing device's own stamp for when the edit was made, or `null` for a change
  the server authored (a REST write has no device clock to borrow). A client
  that lists notes by recency sorts on `clientTimestamp ?? createdAt`, otherwise
  a device that was offline for a week returns to find six days of its own notes
  re-dated to the moment it came back.

#### `GET /sync/status`

- **Access**: `JwtAuthGuard`
- **Query**: `?deviceId=<UUID>`
- **Response**: `200 OK`
  ```json
  {
    "deviceId": "123e4567-e89b-12d3-a456-426614174000",
    "lastPulledCursor": "142800",
    "lastPushedSequence": 57,
    "lastSuccessfulSyncAt": "2026-09-10T16:00:00.000Z",
    "serverHighestCursor": "142857"
  }
  ```

---

### 6. Notes, Folders & Tags (`/notes`, `/folders`, `/tags`)

#### `POST /notes`

- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "title": "Architecture Design Review",
    "content": "Markdown content here...",
    "folderId": "fol-123e4567-e89b-12d3-a456-426614174000",
    "tagIds": ["tag-123e4567-e89b-12d3-a456-426614174001"],
    "isPinned": true
  }
  ```
  `isEncrypted` is a whitelisted optional key here and on `PATCH` (inherited through
  `PartialType(CreateNoteDto)`), and the service does write it to the row
  (`notes.service.ts:37`, defaulted to `false`; `:232` passes it through untouched
  when a PATCH omits it). Nothing uses it: `noteChangePayload` omits it from the
  logged change, the Flutter client has no Isar column left for it and never sends
  it, so the only way to set it is to call `POST /notes` by hand. `GET` echoes it
  because the response is the row spread, which makes it state a REST caller can
  write and read but no device can receive through sync.
  `noteType` and `structured` are two more optional keys on both bodies, under the
  same names the sync payload uses: the note's format key (`normal`, `diary`,
  `shopping`, `bucket`, `quotes`, and an unrecognised one is accepted because the
  client renders it as a normal note) and the table a formatted note holds in
  place of a body, as the JSON text its author serialises. Neither is parsed
  server-side. An omitted key means the caller is saying nothing about it, and on
  `PATCH` that is also what reaches the change log — the row's own copy is not
  news. `/sync/push` now projects accepted note changes onto this row, so the copy
  tracks the log for a note that has synced, but it is one writer among several and
  the gap that matters is still open: a device editing offline holds a newer table
  than this server has ever heard of, and a REST edit that restated the row's copy
  would replay it backwards onto every other device, since a device reads a present
  key as the whole new value. `GET` returns both from the row.
- **Response**: `201 Created` — Created note object with version `1`.

#### `GET /notes`

- **Access**: `JwtAuthGuard`
- **Query Parameters**:
  - `folderId` (UUID) — Filter by parent folder
  - `tagId` (UUID, singular) — Filter by one tag. `tagIds` is the _create/update_
    body's array field and is not a query parameter; sending it here is a 400.
  - `isPinned` (Boolean) — Filter pinned notes
  - `isArchived` (Boolean) — Filter archived notes (default: `false`)
  - `search` (String) — Case-insensitive substring on title and content
    (`contains`, not a text index)
  - `page` (Integer) & `limit` (Integer) — Pagination (default 20, max 100)
- **Response**: `200 OK` — `{ "data": [...], "meta": { "total", "page", "limit",
"totalPages" } }`, ordered pinned-first then `updatedAt` descending.

#### `GET /notes/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Note object including relations (`folder`, `tags`, `attachments`, `history`).

#### `PATCH /notes/:id`

- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "title": "Updated Title",
    "content": "New content...",
    "folderId": "fol-uuid",
    "tagIds": ["tag-uuid"],
    "isPinned": false,
    "isArchived": false
  }
  ```
  `version` is not a body field: the server increments it, and a client that sends
  one is refused by the whitelist rather than having it ignored. What a caller who
  means "fail if somebody else edited this" has is `/sync/push`, where `version` is
  compared against the log.
- **Response**: `200 OK` — Increments version and creates version snapshot.

#### `DELETE /notes/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK`
  ```json
  { "success": true, "message": "Note deleted successfully." }
  ```
  A soft delete: `deletedAt` is set **and the version increments**, and the same
  transaction appends a `note` `DELETE` change at that new version with an empty
  payload. Both halves matter — a log entry naming a version the row never reached
  is what made every device's version guard useless here, and `entityId` already
  names the note, so a tombstone reader wants no keys out of the payload.
- **404** if the note is missing, belongs to another account, or is already
  deleted.

#### `GET /notes/:id/history`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Array of `NoteHistory` rows newest version first
  (`id`, `noteId`, `version`, `title`, `content`, `createdAt`). The body column is
  `content`, the same name the note itself uses; `contentSnapshot` never existed in
  the schema.

#### `POST /notes/:id/history/:historyId/restore`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Reverts note content to the selected historical snapshot.

#### `POST /folders`

- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "name": "Work",
    "color": "#3B82F6",
    "icon": "briefcase",
    "parentId": null
  }
  ```
- **Response**: `201 Created` — Created folder.

#### `GET /folders`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Hierarchical folder tree with subfolders and note counts.

#### `GET /folders/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Folder details.

#### `PATCH /folders/:id`

- **Access**: `JwtAuthGuard`
- **Body**: `{ "name": "Work & Projects", "color": "#2563EB" }`
- **Response**: `200 OK` — Updated folder.

#### `DELETE /folders/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` `{"message": "Folder deleted"}`

#### `POST /tags`

- **Access**: `JwtAuthGuard`
- **Body**: `{ "name": "urgent", "color": "#EF4444" }`
- **Response**: `201 Created`

#### `GET /tags`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — List of user tags.

#### `GET /tags/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK`

#### `PATCH /tags/:id`

- **Access**: `JwtAuthGuard`
- **Body**: `{ "name": "high-priority", "color": "#DC2626" }`
- **Response**: `200 OK`

#### `DELETE /tags/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` `{"message": "Tag deleted"}`

---

### 7. Tasks, Projects, Sections & Reminders (`/tasks`, `/projects`)

#### `POST /tasks`

- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "title": "Ship v1.0 Production Release",
    "description": "Complete all improvement tracker items and run tests",
    "status": "TODO",
    "priority": "P1_URGENT",
    "dueDate": "2026-09-15T18:00:00.000Z",
    "dueTime": "18:00",
    "recurrenceRule": "FREQ=WEEKLY;BYDAY=MO",
    "projectId": "prj-123e4567-e89b-12d3-a456-426614174000",
    "sectionId": "sec-123e4567-e89b-12d3-a456-426614174001",
    "parentId": null,
    "tagIds": ["tag-123e4567-e89b-12d3-a456-426614174002"],
    "sortOrder": 0
  }
  ```
  The recurrence key is `recurrenceRule`. There is no `rrule` field on the DTO or
  the row — that name exists only as a parameter inside
  `TasksService.calculateNextRecurrenceDate`, and a body carrying it is refused by
  the whitelist. `dueTime` is a `HH:mm` string checked by `@Matches`, separate from
  the `dueDate` timestamp. `parentId: null` is accepted (`@IsOptional` ignores
  `null`); `projectId` and `parentId` are resolved against the caller's own rows
  first and a miss is a `404`, not a dangling FK.
- **Response**: `201 Created` — the task, with `isCompleted` derived from
  `status === "COMPLETED"` and `taskLabels` flattened to `tags`. `status` defaults
  to `TODO` and `sortOrder` to `0`. The same transaction appends a `task` `CREATE`
  change carrying `{title, projectId, priority, status, dueDate}`.

#### `GET /tasks`

- **Access**: `JwtAuthGuard`
- **Query Parameters** — the whitelist is `QueryTasksDto`, and `parentId` is not on
  it: filtering subtasks is not a list-query feature, and sending it is a 400.
  - `search` (String) — case-insensitive `contains` on title and description
  - `projectId`, `sectionId`, `tagId` (UUID) — `tagId` is singular, like the notes
    query; `tagIds` is the create/update body's array
  - `priority` (`P1_URGENT`, `P2_HIGH`, `P3_MEDIUM`, `P4_LOW`)
  - `status` (`TODO`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`)
  - `isCompleted` (Boolean) — rewritten into a `status` filter, so it and an
    explicit `status` fight: the later assignment wins
  - `dueBefore`, `dueAfter` (ISO timestamp) — `lte` / `gte` on `dueDate`
  - `page` (default 1) & `limit` (default 20, max 100)
- **Response**: `200 OK` — `{ "data": [...], "meta": { "total", "page", "limit",
"totalPages" } }`, ordered `priority` asc, then `dueDate` asc, then `sortOrder`
  asc. `priority` is a string column and MongoDB orders it lexicographically; for
  these four member names that happens to coincide with severity, and an unscheduled
  task (`dueDate: null`) leads its priority band.

#### `GET /tasks/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Task details with `parent`, non-deleted `subtasks`,
  flattened `tags`, and `reminders`. `404` if it is missing, deleted, or belongs to
  another account.

#### `PATCH /tasks/:id`

- **Access**: `JwtAuthGuard`
- **Body**: `{ "status": "IN_PROGRESS", "priority": "P2_HIGH" }`
  Every create key plus `isCompleted` (a boolean that `TasksService` translates into
  `status`, and that a supplied `status` overrides). No `version`: the server
  increments it, and `/sync/push` is where a caller who means "fail if somebody
  else edited this" gets a comparison. `completedAt` follows the status in both
  directions — moving to `COMPLETED` stamps it, moving away nulls it. `tagIds` is
  a replacement, not an addition: the key being present at all deletes every
  existing label row first, so `[]` clears the task's tags. Unlike `POST`, a
  `projectId` or `sectionId` here is not resolved against the caller's rows, and a
  `parentId` is checked only for self-parent and ancestor cycles (both `400`).
- **Response**: `200 OK` — Updated task, plus a `task` `UPDATE` change at the new
  version carrying `{title, priority, status, isCompleted}`.

#### `POST /tasks/:id/complete`

- **Access**: `JwtAuthGuard`
- **Purpose**: Sets `status = "COMPLETED"` (the enum member is `COMPLETED`; there is
  no `DONE`), stamps `completedAt`, and increments `version`. When the task carries
  a `recurrenceRule`, the same transaction creates the next instance and returns it
  — but the rule is not parsed as an RRULE: the string is matched for `FREQ=DAILY`,
  `FREQ=WEEKLY` or `FREQ=MONTHLY` and advances `dueDate || now` by one day, seven
  days or one month. `BYDAY`, `INTERVAL`, `COUNT` and `UNTIL` are ignored, and any
  rule that does not contain one of those three `FREQ=` substrings falls through to
  +1 day. The new instance copies title, description, project, section, parent,
  priority, due time, rule and labels, and starts at `TODO`.
- **Response**: `200 OK`
  ```json
  {
    "completedTask": { "id": "tsk-1", "status": "COMPLETED" },
    "nextRecurringTask": {
      "id": "tsk-2",
      "dueDate": "2026-09-22T18:00:00.000Z"
    }
  }
  ```
  `nextRecurringTask` is `null` when the task has no rule, so a client must not
  assume the key holds an object. Both writes log their own change.

#### `DELETE /tasks/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` `{ "success": true, "message": "Task deleted successfully." }`
  — a soft delete that increments `version` and appends a `task` `DELETE` change at
  `version + 1` with `{ id }` as its payload. `404` if the task is missing, already
  deleted, or not the caller's.

#### `POST /tasks/:id/reminders`

- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "remindAt": "2026-09-15T17:30:00.000Z",
    "channel": "NOTIFICATION"
  }
  ```
  The key is `channel`, not `type`, and its values are `NOTIFICATION | EMAIL`
  (`ReminderChannel`) — `PUSH_NOTIFICATION` is in neither the enum nor the DTO, so
  it is a `400`. `remindAt` is required and must parse as a date.
- **Response**: `201 Created` — the raw `Reminder` row (`id`, `taskId`, `userId`,
  `remindAt`, `channel`, `sent`, `createdAt`). `404` if the task is not the
  caller's.

#### `GET /tasks/:id/reminders`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Array of the task's reminders ordered `remindAt`
  ascending; `404` when the task is missing or not the caller's.

#### `DELETE /tasks/reminders/:reminderId`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK`
  `{ "success": true, "message": "Reminder deleted successfully." }` — a hard
  delete, unlike the task itself. `404` if the reminder is not the caller's.
  Route order matters here: `reminders/:reminderId` is declared after `:id`, so it
  is matched by the literal segment, not swallowed as a task id.

#### `POST /projects`

- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "name": "Mobile Redesign",
    "color": "#10B981",
    "icon": "smartphone",
    "description": "Cross-platform mobile application"
  }
  ```
- **Response**: `201 Created`

#### `GET /projects`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — List of active user projects.

#### `GET /projects/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Project details with nested sections and root tasks.

#### `PATCH /projects/:id`

- **Access**: `JwtAuthGuard`
- **Body**: `{ "name": "Mobile Redesign v2", "isArchived": false }`
- **Response**: `200 OK`

#### `DELETE /projects/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` `{"message": "Project deleted"}`

#### `POST /projects/sections`

- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "projectId": "prj-123e4567-e89b-12d3-a456-426614174000",
    "name": "Backlog",
    "sortOrder": 0
  }
  ```
- **Response**: `201 Created`

#### `PATCH /projects/sections/:sectionId`

- **Access**: `JwtAuthGuard`
- **Body**: `{ "name": "In Progress", "sortOrder": 1 }`
- **Response**: `200 OK`

#### `DELETE /projects/sections/:sectionId`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` `{"message": "Section deleted"}`

---

### 8. Calendars & Events (`/calendars`, `/events`)

#### `POST /calendars`

- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "name": "Personal",
    "color": "#8B5CF6",
    "isPrimary": true,
    "timeZone": "America/New_York",
    "externalProvider": "LOCAL"
  }
  ```
  `timeZone` is capital-Z, matching the column; `timezone` is not a whitelisted key
  and is a 400. `externalProvider` is `LOCAL | GOOGLE | OUTLOOK`.
- **Response**: `201 Created` — the row. `timeZone` defaults to `"UTC"`, `isPrimary`
  to `false`, `externalProvider` to `LOCAL`. Sending `isPrimary: true` clears the
  flag on the caller's other calendars first, so "primary" stays single-valued.
  **No `Change` is logged on this endpoint**, nor on `PATCH` or `DELETE /calendars`
  — a calendar is not a synced entity; only its `event` rows are.

#### `GET /calendars`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Array of `Calendar` rows, `isPrimary` first then by name.
  A side effect worth knowing: an account with no calendars gets one created here
  (`Personal`, `#4285F4`, primary), so the first read is a write.

#### `GET /calendars/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — the calendar plus `_count.events` (non-deleted). `404` if
  it is not the caller's or is deleted.

#### `PATCH /calendars/:id`

- **Access**: `JwtAuthGuard`
- **Body**: `{ "name": "Family & Personal", "color": "#7C3AED" }`
- **Response**: `200 OK` — Updated row. `isPrimary: true` again demotes the others.

#### `DELETE /calendars/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — the updated `Calendar` row (with `deletedAt` set), not a
  message. A soft delete only: the events under it are untouched and stay readable
  through `/events`, because nothing in this path looks at them.

#### `POST /events`

- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "calendarId": "cal-123e4567-e89b-12d3-a456-426614174000",
    "title": "Sprint Demo",
    "description": "Showcase deliverables to stakeholders",
    "location": "Meet link: https://meet.google.com/xyz-abcd-efg",
    "startAt": "2026-10-01T15:00:00.000Z",
    "endAt": "2026-10-01T16:00:00.000Z",
    "isAllDay": false,
    "recurrenceRule": "FREQ=WEEKLY;BYDAY=TH",
    "status": "CONFIRMED",
    "color": "#EA4335",
    "attendees": [
      { "email": "colleague@example.com", "displayName": "Dana Scully" }
    ]
  }
  ```
  Required: `calendarId`, `title`, `startAt`, `endAt`. As with tasks the key is
  `recurrenceRule`; `rrule` is not on the DTO. `status` is `CONFIRMED | TENTATIVE |
CANCELLED`, defaulting to `CONFIRMED`, and an attendee's own `status` is
  `NEEDS_ACTION | ACCEPTED | DECLINED | TENTATIVE`, defaulting to `NEEDS_ACTION`.
  Two things are checked before anything is written: the calendar must be the
  caller's and not deleted (`404`), and `endAt` must be strictly after `startAt`
  (`400`) — an all-day event still needs a real range.
- **Response**: `201 Created` — the event with `calendar`, `attendees`, `reminders`,
  plus an `event` `CREATE` change carrying `{title, calendarId, startAt, endAt,
isAllDay}`.

#### `GET /events`

- **Access**: `JwtAuthGuard`
- **Query Parameters**:
  - `startFrom`, `startTo` (ISO timestamp, both optional) — an **overlap** window,
    not a start-time filter: `endAt >= startFrom` and `startAt <= startTo`, so an
    event that began before the window and ends inside it is returned. The names
    `startAt` / `endAt` here would be the create-body keys, and they are not query
    keys.
  - `calendarId` (UUID)
  - `search` (String) — case-insensitive `contains` on title, description, location
  - `page` (default 1) & `limit` (default 50, max 200)
- **Response**: `200 OK` — `{ "data": [...], "meta": { total, page, limit,
totalPages } }` ordered by `startAt` ascending.

#### `GET /events/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Event details including attendees and reminders; `404`
  when it is missing, deleted, or not the caller's.

#### `PATCH /events/:id`

- **Access**: `JwtAuthGuard`
- **Body**: `{ "location": "Room 402", "startAt": "...", "endAt": "..." }`
  Same keys as create. `attendees` present replaces every attendee row. The
  `endAt > startAt` rule is re-checked against the merged pair, so shortening only
  one of the two can still be a `400`.
- **Response**: `200 OK` — Increments `version` and logs an `event` `UPDATE` change
  with `{title, startAt, endAt, status}`.

#### `PATCH /events/:id/rsvp`

- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "email": "user@example.com",
    "status": "ACCEPTED"
  }
  ```
  _(Status: `ACCEPTED`, `DECLINED`, `TENTATIVE`, `NEEDS_ACTION`)_ — there is no
  `PENDING` member. This is the one write endpoint in the API with no DTO class: the
  handler pulls `email` and `status` off the body as primitives, so the whitelist
  never runs here and the `AttendeeStatus` annotation is erased at runtime. A status
  the enum does not define is not rejected at the boundary; it reaches Prisma and
  comes back as a server error.
- **Response**: `200 OK` — the updated `EventAttendee` row. `404` if the event is
  not the caller's, or if nobody with that email is invited.

#### `POST /events/:id/reminders`

- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "minutesBefore": 15,
    "channel": "NOTIFICATION"
  }
  ```
  Both keys are optional and default to `15` and `NOTIFICATION` (`ReminderChannel`,
  so `EMAIL` is the other value). `method` is not a key on this DTO.
- **Response**: `201 Created` — the `EventReminder` row. No `Change` is logged for
  reminders, on either side of the `/tasks` or `/events` pair.

#### `DELETE /events/:id`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK`
  `{ "success": true, "message": "Event deleted successfully." }` — a soft delete
  that increments `version` and appends an `event` `DELETE` change at
  `version + 1` with `{ id }`. `404` when it is already gone or not the caller's.

---

### 9. Vault (`/vault/settings`)

> [!IMPORTANT]
> **What the server holds**:
> Entry content is encrypted on the client with AES-256-GCM and reaches the server only as opaque Base64 `encryptedData` / `iv` / `authTag` through the sync oplog (`POST /sync/push`); there is no vault-entry REST API. The master password itself never crosses the network.
>
> This is **not** a blanket "zero-knowledge" claim, and the honest version is narrower. What a modern client uploads is the recovery envelope `recoveryKdfSalt` + `wrappedMasterKey` / `wrappedMasterIv` / `wrappedMasterTag`, where the master key inside it is wrapped under a key the client derives from the user's 12-word recovery phrase with that salt — the wrapping key itself is never uploaded, and a build that sends one is refused by the DTO (`src/vault/dto/setup-vault.dto.ts:13-93`, the four envelope fields at `:70-92`). **What the server cannot read**: the master key, and so the entry plaintext — for a phrase-envelope vault its database holds a ciphertext, a salt and a digest, and the phrase is nowhere in it (`prisma/schema.prisma:775-779`). **What it can do**: decide whether a presented verifier matches the row (that is the whole of `POST /vault/settings/unlock`), and hand the envelope back to a client that spent an emailed recovery code (`src/vault/services/vault-settings.service.ts:570-577`).
>
> Two facts qualify that, and both belong in a runbook. (1) The server is not blind to guesses: `VaultSetting.masterKeyHash` is an HMAC-verifier digest of the client's derived verifier, keyed with the server-only `ENCRYPTION_KEY` (`prisma/schema.prisma:752-755`) — whoever holds that key can test candidate master passwords against every row offline instead of through the API — which is why a rotation of `ENCRYPTION_KEY` is a re-seal tracked by `masterKeyHashPepper` rather than a wipe (`prisma/schema.prisma:756-763`), and why an unlock of a row sealed under a key this process does not hold answers `503 VAULT_PEPPER_KEY_UNAVAILABLE` rather than the wrong-password code. (2) The obsolete `recoveryKey` column is an **unwrapped** key-encryption-key uploaded verbatim by app builds before 2026-10-17 (`prisma/schema.prisma:780-784`); for rows that still carry it, database read access really is vault access, because `recovery/verify` echoes the stored key so its owner is not stranded by the fix (`src/vault/services/vault-settings.service.ts:573`). No new row gets one: `setup` writes `recoveryKey: null` on both branches (`:241`, `:253`) and a recovery that supplies the phrase-derived wrap replaces it in the same write (`:649-659`). Those legacy rows are what incident response should sweep first, and the answer for one is to re-run recovery or setup with the four envelope fields.

#### `POST /vault/settings/setup`

- **Access**: `JwtAuthGuard` (the controller applies it to the whole `/vault/settings` tree, `src/vault/controllers/vault-settings.controller.ts:29`) — no `@Throttle()` on this route, so the global default applies.
- **Body**: `SetupVaultDto` (`src/vault/dto/setup-vault.dto.ts`). Only `masterKeyHash` and `keySalt` are required. The four recovery-envelope fields are each optional, but they are one envelope: sending them means sending all four, and a setup that re-writes a row already holding a wrap must send them (`:216-222`, `:682-701`). There is no field for an unwrapped wrapping key any more:
  ```json
  {
    "masterKeyHash": "q7L1Z3mYxk1hZ8jH0lYXn0K8pQe1o2uW3r5t7y9b0cA=",
    "keySalt": "c2FsdF9iYXNlNjRfc3RyaW5n",
    "kdfIterations": 3,
    "kdfMemory": 65536,
    "recoveryKdfSalt": "base64-24-byte-phrase-salt",
    "wrappedMasterKey": "base64-ciphertext",
    "wrappedMasterIv": "base64-96bit-nonce",
    "wrappedMasterTag": "base64-gcm-tag"
  }
  ```
  `recoveryKdfSalt` is `@IsBase64() @Length(24, 24)` and the three wrap fields are optional non-empty strings (`:70-92`); `kdfIterations` is `@Min(1)` and `kdfMemory` `@Min(1024)` (`:49-63`). **A body carrying `recoveryKey` is refused**: the field is not on the DTO, and with `forbidNonWhitelisted` on it answers `400 VALIDATION_ERROR` `"This field is not allowed."` — that is deliberate, because a stored key-encryption-key makes every vault on the server openable by whoever reads the database (`:65-69`).
- **Response**: `201 Created`
  ```json
  {
    "isVaultConfigured": true,
    "keySalt": "c2FsdF9iYXNlNjRfc3RyaW5n",
    "kdfIterations": 3,
    "kdfMemory": 65536,
    "updatedAt": "2026-09-26T10:00:00.000Z"
  }
  ```
  Exactly these five fields (`src/vault/services/vault-settings.service.ts:260-266`) — the envelope and the stored verifier are not echoed back.
- **Notes**: `masterKeyHash` is `base64(SHA-256(argon2id(password, salt)))` — the verifier, not the key. What the row _stores_ is `hmac-sha256:<base64>` of that value, keyed with the server-only `ENCRYPTION_KEY`, so a read of the collection does not hand over the unlock credential; rows written before that conversion keep the raw value and are rewritten on their next successful unlock. `kdfIterations` / `kdfMemory` are what the client derived with — the shipped build uses Argon2id `t=3, m=65536 KiB, p=4` and reports the first two; a request that omits them stores those same values (`:234`, `:249` against `DEFAULT_KDF_ITERATIONS` / `DEFAULT_KDF_MEMORY_KIB` at `:68-69`). **Nothing reads them back**: the copy a build can trust is the `_kdf` marker sealed inside every entry blob, so sending different numbers here changes a record, not a behaviour (see `SECURITY.md`). A time cost below `t=1` is rejected as a validation error — the floor used to be `1000`, which would have refused the only honest value. Setup against an already-configured vault returns `409 VAULT_ALREADY_CONFIGURED` (`:206-210`); rotate the master password through the recovery flow instead. The one case that is _not_ a clean re-setup: a row that already holds `wrappedMasterKey` must be re-supplied with the whole new envelope, because the upsert's update branch would otherwise null the only stored copy of the wrap (`:216-222`, asserted by `assertRecoveryMaterialComplete()` at `:682-701`, which answers `400 VALIDATION_ERROR` with the missing names in `details.fields`). Both write branches set `recoveryKey: null` (`:241`, `:253`), so a vault that still had a plaintext wrapping key loses it at the moment the client provably holds the master key.

#### `GET /vault/settings`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — the `setup` response **plus** the three password-wrapper columns, so it is not the same object: `{ isVaultConfigured, keySalt, kdfIterations, kdfMemory, passwordWrappedKey, passwordWrappedIv, passwordWrappedTag, updatedAt }` (`src/vault/services/vault-settings.service.ts:283-291`). The `passwordWrapped*` fields are `null` until a master-password recovery has run, and this is the same shape `recovery/complete` returns. An account that never set a vault up gets `{ "isVaultConfigured": false, "keySalt": null, "kdfIterations": null, "kdfMemory": null }` — four fields, no wrapper keys (`:274-280`). The stored verifier is never returned.

#### `POST /vault/settings/unlock`

- **Access**: `JwtAuthGuard`
- **Rate Limit**: 10 per minute (`@Throttle({ default: { limit: 10, ttl: 60000 } })`, `src/vault/controllers/vault-settings.controller.ts:67`). Per **IP**, not per user: the throttler is the app-wide `APP_GUARD` and runs before `JwtAuthGuard`, so `req.user` is unset when the bucket key is built (see the rate-limit note at the top of this document, and `src/common/guards/custom-throttler.guard.ts:52-68`).
- **Body**: `{ "masterKeyHash": "..." }`, and optionally `"keyEnvelopeVersion": 1` (`UnlockVaultDto`, `src/vault/dto/unlock-vault.dto.ts:4-17`). The optional field is not decoration: once a recovery has written a `passwordWrappedKey`, an unlock that omits `keyEnvelopeVersion: 1` is refused with `400 VALIDATION_ERROR` "Update this app to unlock the recovered vault safely." (`src/vault/services/vault-settings.service.ts:304-309`) — an old build must not be handed a vault whose key wrapper it cannot re-encrypt.
- **Purpose**: Compares the verifier the client derived against the stored one. It proves the master password without transmitting it.
- **Response**: `200 OK` `{ "success": true, "unlockedAt": "..." }` (`src/vault/services/vault-settings.service.ts:419-422`) · `401 VAULT_MASTER_KEY_MISMATCH` · `401 RATE_LIMITED` with `details.retryInSeconds` · `404 VAULT_NOT_CONFIGURED` · `400 VALIDATION_ERROR` (the envelope case above) · `503 VAULT_PEPPER_KEY_UNAVAILABLE`.
- **Notes**: Five consecutive failures start a one-minute cooldown on the vault, doubling to an hour (`UNLOCK_MAX_FAILED_ATTEMPTS` / `UNLOCK_COOLDOWN_BASE_MS` / `UNLOCK_COOLDOWN_MAX_MS` at `src/vault/services/vault-settings.service.ts:41-43`, curve at `:437-444`), and while it runs the endpoint refuses even the correct verifier. The counter lives on `VaultSetting`, not `User`: a mistyped master password must not lock the account out of its notes, tasks and calendar. The `503` is the one answer a client must not retry against this endpoint: it means the row is sealed under an `ENCRYPTION_KEY` generation this process does not hold (`findSealingKey()` throws at `:169-174`, body built at `:774-783`, `details.pepperKeyId` names the stamp), so nothing the person typed is wrong and the digest did not even get compared. Answering `401` there would count five _correct_ passwords into the cooldown above and lock a healthy vault out of itself for an hour. Surface it as "service owner: set `ENCRYPTION_KEY_PREVIOUS` / `ENCRYPTION_KEY_PREVIOUS_ID`", not as a wrong password.

#### `POST /vault/settings/recovery/request`

- **Access**: `JwtAuthGuard` · rate-limited to 3 per minute (`src/vault/controllers/vault-settings.controller.ts:96`)
- **Purpose**: Emails a single-use 6-digit code that unlocks the recovery blob, valid for 15 minutes (`RECOVERY_OTP_TTL_MINUTES` at `src/vault/services/vault-settings.service.ts:31`, passed to the issuer at `:468-472`).
- **Response**: `200 OK` `{ "message": "If the vault can be recovered, a code has been sent to the account email address." }` (`:518-520`) — it names no address state, and in a non-production deployment a failed send is only logged and this message is still returned (`:486-497`). · `404 VAULT_NOT_CONFIGURED` when the account has no row (`:451-454`) · `400 VAULT_RECOVERY_UNAVAILABLE` when no `wrappedMasterKey` is stored (`:456-460`), and — only under `APP_ENV=production` — when the mail could not be sent (`:490-496`, `:508-514`).
- **Note for operators**: the code is logged **only** when `APP_ENV=development`, not merely when the deployment is not production (`if (this.configService.isDevelopment)` at `:478-479`). An unset or mistyped `APP_ENV` therefore logs nothing; a build that used to print it in staging does not any more, because the code plus the 12-word phrase hands over the wrapped master key.

#### `POST /vault/settings/recovery/verify`

- **Access**: `JwtAuthGuard` · rate-limited to 5 per minute (`src/vault/controllers/vault-settings.controller.ts:107`)
- **Body**: `{ "otp": "123456" }` — 6 characters exactly (`VerifyVaultRecoveryDto`, `src/vault/dto/setup-vault.dto.ts:95-100`).
- **Response**: `200 OK` — `{ keySalt, recoveryKdfSalt, recoveryKey, wrappedMasterKey, wrappedMasterIv, wrappedMasterTag }` (`src/vault/services/vault-settings.service.ts:570-577`), the material the client needs to re-derive the wrapping key from the phrase and unwrap the old master key, then re-encrypt its entries. `recoveryKdfSalt` is the modern envelope and `recoveryKey` is `null` whenever it is present: the service returns `setting.recoveryKdfSalt ? null : setting.recoveryKey` (`:573`), so the plaintext key leaves the building only for rows that still have one and no phrase salt. A row with neither is answered `400 VAULT_RECOVERY_UNAVAILABLE` "This vault's recovery material is incomplete." (`:551-555`), and a row with no wrap at all `noRecoveryMaterialStored()` (`:545`). A bad or spent code is `401 OTP_INVALID` (`:534-538`). Spending a code opens a 15-minute grant window (`recoveryGrantedAt`, written at `:563-567`). The stored verifier is deliberately **not** part of this answer: the unwrap is authenticated by its own GCM tag, and echoing a bearer secret back would only give the client a second way to be wrong (`:577-581`).

#### `POST /vault/settings/recovery/complete`

- **Access**: `JwtAuthGuard` · rate-limited to 3 per minute (`src/vault/controllers/vault-settings.controller.ts:123`)
- **Body**: **not** the `setup` shape. `CompleteVaultRecoveryDto` (`src/vault/dto/setup-vault.dto.ts:103-156`) requires the new verifier **and** a complete password-derived wrapper around the stable data key:
  ```json
  {
    "masterKeyHash": "q7L1Z3mYxk1hZ8jH0lYXn0K8pQe1o2uW3r5t7y9b0cA=",
    "keySalt": "base64-24-bytes",
    "passwordWrappedKey": "base64-44-chars",
    "passwordWrappedIv": "base64-16-chars",
    "passwordWrappedTag": "base64-24-chars",
    "kdfIterations": 3,
    "kdfMemory": 65536,
    "recoveryKdfSalt": "base64-24-bytes",
    "wrappedMasterKey": "base64-ciphertext",
    "wrappedMasterIv": "base64-16-chars",
    "wrappedMasterTag": "base64-24-chars"
  }
  ```
  `keySalt` and the three `passwordWrapped*` fields are required here (`@IsBase64()` with fixed `@Length`), and `kdfIterations` / `kdfMemory` are `@Equals(3)` / `@Equals(65536)` — not optional, and not free to differ from the shipped client's numbers (`:99-119`). The four phrase-envelope fields at the end stay optional and exist so a legacy row can be upgraded in the same write; send all four or none, because the service only applies them as a set and nulls `recoveryKey` alongside (`src/vault/services/vault-settings.service.ts:649-659`).
- **Purpose**: Stores the parameters for the rotated master password. The client re-encrypts its entries locally and uploads them through `POST /sync/push` before the recovery grant expires.
- **Response**: `200 OK` — `getVaultSettings()` for the account, i.e. the `GET /vault/settings` shape including `passwordWrapped*` (`src/vault/services/vault-settings.service.ts:673`). · `400 VALIDATION_ERROR` when the wrapper triple is incomplete (`:586-594`) · `401 VAULT_RECOVERY_NOT_PENDING` when no grant was ever opened (`:596-603`) or the 15-minute window has passed (`:616-623`) · `409 VAULT_RECOVERY_NOT_PENDING` "Vault recovery changed. Verify a new recovery code." when the guarded write matched no row because another request moved the window (`:662-667`). Re-sending the _identical_ wrapper after a lost response is treated as the same completed recovery and returns the settings without needing a fresh code (`:606-614`).

#### Vault entries: the sync oplog

Vault entries are `Change` rows with `entityType: "vault_item"` — see section 5 (`/sync`). The payload contract enforced by `src/sync/change-payload.validator.ts` is:

- `CREATE` / `UPDATE` / `RESTORE`: non-empty strings `type`, `encryptedData`, `iv`, `authTag`, plus boolean `isEncrypted`. `type`, `iv` and `authTag` may not exceed 128 characters — a 96-bit nonce base64s to 16 and a GCM tag to 24, so a longer value is a wrong value rather than a bigger one. `encryptedData` carries no per-field cap: it grows with the entry and the bound that matters is the request body limit.
- `DELETE`: not judged. A tombstone legitimately has no content, and today's client sends `{}`.
  A rejected payload refuses only that change: no `Change` row is written for it and
  the `201` response reports it in `rejected[]` (with `truncated: true` if that
  bounded list is incomplete). Other valid changes in the same request are still
  committed. The server never decrypts, merges or inspects an entry blob; version
  comparison decides what is stored, and the client decides what is displayed.

---

### 10. Admin & Incident Response (`/admin`)

> [!CAUTION]
> **Admin Authorization Requirements** — read 2026-09-27 against `src/admin/guards/admin.guard.ts`:
> All routes under `/admin` are guarded by `JwtAuthGuard` AND `AdminGuard`. `JwtAuthGuard` must pass first, so an admin call always needs a valid, live session for an `ACTIVE` user. `AdminGuard` then decides, in this order, and has exactly three ways to say yes:
>
> 1. A request with no authenticated user is refused before anything else — `403 "Authentication required for admin access"` (`:32`). The secret below cannot bootstrap an identity.
> 2. `ADMIN_SECRET` set **and** a matching `x-admin-secret` header on that authenticated request (`:38-39`). Values shorter than 32 characters are treated as unset (`ConfigurationService.adminSecret`, `src/config/configuration.service.ts`), and the comparison is `crypto.timingSafeEqual` (`:75-81`) rather than `===`, so this path is not a length-leaking string compare.
> 3. `user.email` found in `ADMIN_EMAILS` (compared lower-cased, `:49`), or `user.id` found in `ADMIN_USER_IDS` (`:54`). Anything else is `403` (`:58`).
>
> **What changed on 2026-09-27, and what to configure.** The guard used to fall through to `user.role === "ADMIN"` / `user.isAdmin === true`, which was unreachable — `JwtStrategy.validate` returns `{ id, email, displayName, status, sessionId }` and the schema declares no `role` or `isAdmin` field — and that branch has been deleted, so **there is no role in this system and no documentation should imply one**. `ADMIN_EMAILS` also used to default to the literal `"admin@allinone.app,admin@example.com"`. That default is gone: an unset or empty `ADMIN_EMAILS` is an empty list, which admits nobody. This closes **P0-10** — the address an operator must now deliberately not publish, because `POST /auth/register` creates an `ACTIVE` user without proving the address, so any address named in a committed template or a public runbook is an identity a stranger can claim first. `.env.example` therefore lists all three keys commented out. The residual requirement is yours: provision `ADMIN_EMAILS`, `ADMIN_USER_IDS` or a ≥32-character `ADMIN_SECRET` or the `/admin` surface has no working caller at all, which is the intended fail-closed default rather than a bug.
>
> The four mutating routes in this section each write an `AuditLog` document first (`src/admin/admin.service.ts:63`, `:116`, `:170`, `:285`); the two reads (`GET /admin/audit-logs`, `GET /admin/users/:userId/overview`) do not, so an operator browsing the audit trail leaves no trace. `AuditLog` is a MongoDB collection, not a table, and nothing in `src/` exports it to a SIEM.

#### `GET /admin/audit-logs`

- **Access**: `JwtAuthGuard` + `AdminGuard`
- **Query Parameters**:
  - `userId` (UUID, optional)
  - `action` (String, e.g. `LOGIN_FAILED`, `MFA_DISABLED`, `SESSIONS_REVOKED`)
  - `resource` (String, e.g. `User`, `Session`, `vault_item`)
  - `startDate`, `endDate` (ISO Date strings)
  - `page`, `limit` (Integer)
- **Response**: `200 OK` — Paginated SIEM audit logs.

#### `POST /admin/users/:userId/revoke-sessions`

- **Access**: `JwtAuthGuard` + `AdminGuard`
- **Purpose**: Immediately terminates all active sessions for a target user during an active security incident.
- **Body**:
  ```json
  {
    "reason": "Suspected credential compromise via credential stuffing"
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "revokedCount": 3,
    "userId": "123e4567-e89b-12d3-a456-426614174000"
  }
  ```

#### `POST /admin/users/:userId/disable-mfa`

- **Access**: `JwtAuthGuard` + `AdminGuard`
- **Purpose**: Administratively resets MFA for a verified, locked-out customer.
- **Body**:
  ```json
  {
    "reason": "Identity verified via telephone and government ID (Ticket #SEC-8491)"
  }
  ```
- **Response**: `200 OK` `{"success": true, "message": "MFA disabled administratively"}`

#### `PATCH /admin/users/:userId/status`

- **Access**: `JwtAuthGuard` + `AdminGuard`
- **Body**:
  ```json
  {
    "status": "SUSPENDED",
    "reason": "Violation of acceptable use policy"
  }
  ```
  _(Status options: `ACTIVE`, `SUSPENDED`, `DELETED`)_
- **Response**: `200 OK` — Updated user record.

#### `GET /admin/users/:userId/overview`

- **Access**: `JwtAuthGuard` + `AdminGuard`
- **Purpose**: Consolidated security posture view for support and SecOps.
- **Response**: `200 OK` (`src/admin/admin.service.ts:236-259`; there is no flat `id` / `email` / `isEmailVerified` layer — every user field is nested under `user`, and `isEmailVerified` is not returned at all)
  ```json
  {
    "user": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "email": "user@example.com",
      "displayName": "Alex Mercer",
      "status": "ACTIVE",
      "createdAt": "2026-09-01T10:00:00.000Z",
      "lastLoginAt": "2026-09-25T08:12:00.000Z",
      "failedLoginAttempts": 5,
      "lockedUntil": "2026-09-27T22:45:00.000Z",
      "isLocked": true
    },
    "mfaEnabled": true,
    "activeSessionsCount": 2,
    "activeDevicesCount": 3,
    "activeSessions": [
      {
        "id": "...",
        "deviceId": "...",
        "lastActivityAt": "2026-09-27T09:00:00.000Z",
        "ipAddress": "203.0.113.10",
        "userAgent": "Mozilla/5.0",
        "createdAt": "2026-09-20T11:00:00.000Z"
      }
    ],
    "activeDevices": [
      {
        "id": "...",
        "name": "Pixel 8",
        "platform": "android",
        "appVersion": "1.4.2",
        "lastSeenAt": "2026-09-27T09:00:00.000Z"
      }
    ],
    "recentAuditLogs": [
      {
        "id": "...",
        "action": "LOGIN_FAILED",
        "ipAddress": "203.0.113.10",
        "userAgent": "Mozilla/5.0",
        "createdAt": "2026-09-27T08:55:00.000Z"
      }
    ]
  }
  ```
  `activeSessions` / `activeDevices` only include rows with `revokedAt: null`; `recentAuditLogs` is the latest 10 for that user ordered by `createdAt desc`. `mfaEnabled` is `Boolean(user.mfaSettings?.totpEnabled)`, so a `MfaSettings` row that exists but has `totpEnabled: false` reports `false`. Unknown `userId` → `404 Not Found`.

#### `POST /admin/users/:userId/unlock`

- **Access**: `JwtAuthGuard` + `AdminGuard`
- **Purpose**: Administratively unlock an account locked by brute-force lockout, resetting failed attempt counter.
- **Body**:
  ```json
  {
    "reason": "Customer identity verified via out-of-band video verification"
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "targetUserId": "123e4567-e89b-12d3-a456-426614174000",
    "message": "User account unlocked successfully"
  }
  ```
- **Audit Action**: Emits `ACCOUNT_UNLOCKED` audit log event.

---

### 11. Multi-User Collaboration & Resource Sharing (`/collaboration`)

Role-based access control (`VIEWER`, `EDITOR`, `ADMIN`) for Notes, Projects and Calendars, exposed through `CollaborationController` (`src/collaboration/collaboration.controller.ts:31-32`, `@UseGuards(JwtAuthGuard)` on the whole controller).

> [!CAUTION]
> **Shares are persistent data now — but the collection has to be pushed first.** `CollaborationService` reads and writes a real `ResourceShare` model (`src/collaboration/collaboration.service.ts`), replacing the process-local `Map` this section documented until 2026-09-27. Shares survive a restart, are visible to every replica, and are guarded at the database by `@@unique([resourceType, resourceId, sharedWithEmail])`, so a duplicate grant is a `P2002` → `409` rather than a second entry.
>
> Two limits remain, and one of them is operational rather than structural. A share is still never written as a `Change` row, so no client syncs the share list itself — a device learns who else can see a note by asking `/collaboration`, not by pulling. And **`prisma db push` has not been run against any database**, so `ResourceShare` exists in `prisma/schema.prisma` and nowhere else: every route in this section currently fails on the missing collection until the schema is pushed. Treat that as a prerequisite to deploying these endpoints, not as a defect in them.

**Share object shape** (`src/collaboration/collaboration.interface.ts:6-16`) — the keys are `sharedWithUserId` (optional) and `sharedWithEmail`; there is no `granteeId` / `granteeEmail`:

```json
{
  "id": "b2f1c4d8-9a6e-4f7b-9d2c-5e8a1b3f6d90",
  "resourceType": "NOTE",
  "resourceId": "c7b3d8e0-5e8a-4b9c-8a1d-2e3f4a5b6c7d",
  "ownerId": "123e4567-e89b-12d3-a456-426614174000",
  "sharedWithUserId": "9d2c5e8a-1b3f-4d90-8a6e-b2f1c4d89a6e",
  "sharedWithEmail": "collaborator@example.com",
  "role": "EDITOR",
  "createdAt": "2026-09-11T00:00:00.000Z",
  "updatedAt": "2026-09-11T00:00:00.000Z"
}
```

`createdAt` / `updatedAt` are ISO strings, not `Date` objects: `toResourceShare()` (`src/collaboration/collaboration.service.ts:61-73`) maps a `ResourceShare` row field by field and calls `.toISOString()` on the two timestamps, so the response shape never had to change when the store stopped being a `Map`.

#### `POST /collaboration/shares`

- **Access**: `JwtAuthGuard`
- **Purpose**: Share a workspace resource with a target user via their email.
- **Body**:
  ```json
  {
    "resourceType": "NOTE",
    "resourceId": "c7b3d8e0-5e8a-4b9c-8a1d-2e3f4a5b6c7d",
    "email": "collaborator@example.com",
    "role": "EDITOR"
  }
  ```
  _(Roles: `VIEWER`, `EDITOR`, `ADMIN`. Resource types: `NOTE`, `PROJECT`, `CALENDAR` — both validated by `@IsEnum` in `src/collaboration/dto/collaboration.dto.ts`)_
- **Order of checks** (`src/collaboration/collaboration.service.ts:135-235`): resolve the resource (`404` if missing or `deletedAt` set) → require caller to hold `ADMIN` on it, owner implicitly (`403`) → **require the recipient to be a registered account** (`409`) → reject sharing with the resource owner (`409`) → reject a duplicate grant (`409`). The duplicate guard is enforced by the database, not by the read that precedes it: `@@unique([resourceType, resourceId, sharedWithEmail])` makes a concurrent second grant fail with `P2002`, which is mapped to the same `409` wording, so the read is only an optimisation.
- **Re-sharing after a revoke revives the row.** `revokeShare` tombstones it (`deletedAt`) rather than deleting it, and the unique key does not include `deletedAt`, so a fresh grant to that address updates the existing row back to `deletedAt: null` with the new role (`:208-223`). One client-visible consequence: `createdAt` stays on the original grant — it is the same collaborator record — so a re-shared collaborator can show a `createdAt` months older than the share that is currently active.
- **Response**: `201 Created` — the share object above.
- **Audit Action**: `AuditAction.RESOURCE_SHARED` (`collaboration.service.ts:252`); revoke records `AuditAction.RESOURCE_SHARE_REVOKED` (`:359`). Both members were added to the schema with the model — until 2026-09-27 this endpoint reused `DEVICE_ADDED` / `DEVICE_REVOKED`, so a SIEM query for those returned collaboration events. They no longer do.
- **Note on unknown emails**: refused. An invite to an address with no `User` row is a `409` — `No registered account found for '<email>'. The person you are sharing with must have an account before access can be granted.` This replaced a silently inert grant: the address used to be stored with `sharedWithUserId: undefined`, nothing ever filled it in, and the notes read/write path calls `checkAccess(userId, undefined, …)` so email never reached the comparison — the share listed a collaborator who could see nothing. `sharedWithUserId` is required in the schema now, so the lie is refused at the boundary instead and the invite can be re-sent once the account exists.

#### `GET /collaboration/shares/:resourceType/:resourceId`

- **Access**: `JwtAuthGuard`
- **Purpose**: List the shares for one resource. The gate is `VIEWER` weight (`src/collaboration/collaboration.service.ts:279-290`), so **any** collaborator with any role can enumerate who else has access — not only the owner or an `ADMIN` collaborator. `verifyResourceOwner()` (`:82`) is called first but only proves the resource exists; it returns the owner's id and the caller is not compared against it.
- **Errors**: `404` when the resource does not exist (checked first), `403` when the caller has no share and is not the owner.
- **Response**: `200 OK` — array of share objects (`[]` if none). The owner is not included in the array; they hold implicit `ADMIN` but have no row.

#### `PATCH /collaboration/shares/:shareId`

- **Access**: `JwtAuthGuard`
- **Purpose**: Update an existing collaborator's role (e.g. promote `VIEWER` → `EDITOR`).
- **Body**: `{"role": "VIEWER"}` — `VIEWER`, `EDITOR` or `ADMIN`.
- **Response**: `200 OK` — the mutated share object.
- **Errors**: `404` for an unknown `shareId`, `403` unless the caller is the owner or an `ADMIN` collaborator.

#### `DELETE /collaboration/shares/:shareId`

- **Access**: `JwtAuthGuard`
- **Purpose**: Revoke a collaborator's access. A collaborator may also remove **their own** share, which is checked as `share.sharedWithUserId === userId` after the `ADMIN` gate (`collaboration.service.ts:234-248`) — so an `EDITOR` can silently drop themselves.
- **Response**: `204 No Content`
- **Audit Action**: `AuditAction.DEVICE_REVOKED` with `metadata.actionType: "RESOURCE_SHARE_REVOKED"`.

#### `GET /collaboration/shared-with-me`

- **Access**: `JwtAuthGuard`
- **Purpose**: List shares whose `sharedWithUserId` equals the caller's id, or whose `sharedWithEmail` equals the caller's JWT email (`@GetUser("email")` is populated by `JwtStrategy.validate()` — `src/auth/strategies/jwt.strategy.ts:68-74`).
- **Query Parameters** (`src/collaboration/dto/collaboration.dto.ts:62-85`):
  - `resourceType` _(optional)_: `NOTE`, `PROJECT`, `CALENDAR`
  - `page` _(optional, default `1`, min `1)_: 1-based page number
  - `limit` _(optional, default `20`, `1`–`100)_
- **Response**: `200 OK`
  ```json
  {
    "data": ["…share objects…"],
    "total": 1,
    "page": 1,
    "limit": 20
  }
  ```
  There is no `offset` parameter and no `totalPages` field. Paging is real database paging — `findMany({ skip: (page-1)*limit, take: limit })` beside a `count()` on the same `where`, ordered by `createdAt: "asc"` (`src/collaboration/collaboration.service.ts:371-411`). The listing matches `sharedWithUserId` **or** a lower-cased `sharedWithEmail` (`:386-389`). Only the id arm can match a grant created through this API today, since sharing now requires a registered recipient; the email arm is what a row without a grantee id still resolves through.

#### Who actually honours a share

Only two code paths consult `CollaborationService` outside this module — `NotesService.getNoteById()` (requires `VIEWER`) and `NotesService.updateNote()` (requires `EDITOR`), both `@Optional()` injected (`src/notes/services/notes.service.ts:30`). Concretely:

- `GET /notes` (the list) filters on `userId`, so a shared note never appears in the collaborator's inbox-style listing; they must already know the `noteId`.
- `DELETE /notes/:id`, `GET /notes/:id/history`, version restore and tag/folder mutation stay owner-scoped.
- `PROJECT` and `CALENDAR` shares are accepted, stored and listed by these endpoints, but **no** task, project, section, calendar or event service imports `CollaborationService` — sharing them grants visibility into nothing.
- A collaborator's `PATCH /notes/:id` writes through the owner's row and appends a `Change` under the owner's stream, so the owner's devices receive the edit with no attribution to who made it.

---

### 12. AI & Semantic Capabilities (`/ai`)

Four `POST` routes on `AiController` (`src/ai/ai.controller.ts:27-28`, `@UseGuards(JwtAuthGuard)` on the controller). **All four answer from the deterministic heuristics in `AiService` unless an operator has put a Google API key in the environment.** Only `summarize` has a Gemini code path at all — it is the one method that asks (`if (this.gemini.isConfigured)`, `src/ai/ai.service.ts:280`), while `extractTasks()` and `suggestTags()` hard-code `provider: "heuristic"` in their return values (`src/ai/ai.service.ts:490`, `:549`) and have no remote branch to fall out of.

> [!NOTE]
> Gemini lives in its own client now: `src/ai/gemini.client.ts`, injected into `AiService`. `GEMINI_API_KEY` is read there (`:70`, blank or whitespace-only counts as unset and `isConfigured` is then false at `:81`), travels in the **`x-goog-api-key` request header** (`:122`) and never appears in the URL — `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` (`:116`) carries no query string, so a proxy access log cannot capture the credential. Requests are bounded by `AbortSignal.timeout` (`:127`), so a stalled upstream releases the worker instead of holding an authenticated request open. Errors surface as the HTTP status only, never the response body and never the key.
>
> The three settings are declared in `.env.example` and in the Joi `validationSchema` in `src/app/app.module.ts`, and read through `ConfigurationService`: `GEMINI_API_KEY` (optional, no default — unset is the working configuration), `GEMINI_MODEL` (default `gemini-1.5-flash`) and `GEMINI_TIMEOUT_MS` (default `5000`). What has **not** changed is that nothing in the repository supplies a key: `GEMINI_API_KEY=` is blank in the template and absent from both compose files, so `provider` is `"heuristic"` in development, staging and production alike until an operator fills it in.

**Input resolution shared by all four routes** (`resolveText()` — `src/ai/ai.service.ts:234`): a non-blank `text` wins and the note is never loaded; otherwise `noteId` is looked up as `findFirst({ where: { id: noteId, userId, deletedAt: null } })`, so a note you do not own is a `404` even if it was shared with you through `/collaboration`; neither field (or blank `text` with no `noteId`) is a `400 "Either 'text' or 'noteId' must be provided."`. For a note, the analysed content is `` `${note.title}\n\n${note.content || ""}`.trim() ``.

#### `POST /ai/summarize`

- **Access**: `JwtAuthGuard`
- **Purpose**: Summarize raw text or one of the caller's own notes. `200 OK` via `@HttpCode(HttpStatus.OK)`.
- **Body** (all fields optional, defaults in brackets):
  ```json
  {
    "noteId": "c7b3d8e0-5e8a-4b9c-8a1d-2e3f4a5b6c7d",
    "text": "Optional raw text; wins over noteId when non-blank",
    "length": "brief",
    "format": "paragraph"
  }
  ```
  _(Valid `length`: `brief`, `detailed`, `bullet_points` — default `brief`. There is **no** `standard`. Valid `format`: `paragraph`, `bullet_points` — default `paragraph`. Any other value is a `400` from `@IsEnum` in `src/ai/dto/ai.dto.ts:33-47`.)_
- **Heuristic behaviour** (`summarizeHeuristic` — `src/ai/ai.service.ts:333`): splits on sentence enders and newlines and drops fragments under 16 characters, scores each surviving sentence by summed non-stop-word frequency with a position multiplier (`1.5` for the first sentence, `1.2` for the next two, `1.0` after), keeps the top 2 (`brief`), 5 (`detailed`) or 3 (anything else, i.e. `bullet_points`), then re-sorts them back into document order. Joined with spaces for `paragraph`, or one `• ` line each for `bullet_points`.
- **Response**: `200 OK`
  ```json
  {
    "summary": "This document outlines the distributed sync protocol.",
    "originalLength": 4500,
    "summaryLength": 52,
    "compressionRatio": 0.01,
    "format": "paragraph",
    "provider": "heuristic"
  }
  ```
  `originalLength` / `summaryLength` are character counts, and `compressionRatio` is `summary.length / content.length` rounded to 2 decimals — so the sample above is `0.01`, not `0.02`, and a single-sentence input short-circuits to the whole text with `compressionRatio: 1.0` (`:334-343`). `format` echoes the request value. Only a Gemini answer that parsed to a non-empty string reports `provider: "gemini"`; a non-2xx from Google throws and is caught, logged at `warn`, and falls through to the heuristic (`:260-283`), so **the endpoint never fails because Gemini is down** — it just quietly answers less well.

#### `POST /ai/extract-tasks`

- **Access**: `JwtAuthGuard`
- **Purpose**: Pull action items out of text or a note. `200 OK`.
- **Body**:
  ```json
  {
    "text": "TODO: Deploy Redis cluster ASAP\n- [ ] Write integration documentation"
  }
  ```
  `text` or `noteId`; `noteId` also works here (`ExtractTasksDto` accepts it even though the sample above does not show it).
- **Line rules** (`src/ai/ai.service.ts:410`): the content is split on `\n`, trimmed and blank lines dropped. A line becomes a task when it is a markdown checkbox (`- [ ] …` or `* [ ] …`, prefix stripped), or starts with `todo` / `action item` (prefix stripped), or **starts with** one of these keywords and does not end with `:` — `must`, `need to`, `implement`, `deploy`, `review`, `verify`, `prepare`, `update`, `check`, `fix`, `schedule`, `follow up`, `audit`. Keywords are matched with `startsWith`, so a sentence that merely mentions "review" mid-line is not captured, and cleaned titles under 6 characters are dropped.
- **Priority** is a substring test on the cleaned line: `urgent|critical|asap|p0|high` → `HIGH`, else `low|optional|later|consider` → `LOW`, else `MEDIUM`. It is substring, not word, matching — "highlight the risk" scores `HIGH`.
- **Response**: `200 OK`
  ```json
  {
    "tasks": [
      { "title": "Deploy Redis cluster ASAP", "priority": "HIGH" },
      { "title": "Write integration documentation", "priority": "MEDIUM" }
    ],
    "totalFound": 2,
    "provider": "heuristic"
  }
  ```
  `title` is the cleaned line with only its first character upper-cased; `provider` is the literal `"heuristic"` on every call. Nothing is written — extraction is read-only until `convert-tasks` is called.

#### `POST /ai/suggest-tags`

- **Access**: `JwtAuthGuard`
- **Purpose**: Frequency-ranked tag suggestions plus keyword-derived categories. `200 OK`.
- **Body**:
  ```json
  {
    "text": "OAuth2 PKCE flow with Redis token blacklist cache"
  }
  ```
- **Rules** (`src/ai/ai.service.ts:498`): tokens come from `content.toLowerCase().match(/\b[a-z]{3,}\b/g)`, stop-words removed, counted, sorted by count and cut to 5. Categories are substring tests on the lowercased content: `auth|security|jwt` → `Security`, `database|prisma|redis` → `Infrastructure`, `meeting|roadmap|team` → `Productivity`, and `General` only when nothing else matched.
- **Response**: `200 OK`
  ```json
  {
    "tags": ["oauth2", "pkce", "redis", "token", "blacklist"],
    "suggestedCategories": ["Security", "Infrastructure"],
    "provider": "heuristic"
  }
  ```
  `provider` is again the literal `"heuristic"`. Because the token pattern is ASCII-only, text that is accented, Cyrillic or CJK yields `tags: []` while still possibly earning a category — the endpoint never reports "no signal", so the client cannot tell an empty result from unsupported input.

#### `POST /ai/notes/:noteId/convert-tasks`

- **Access**: `JwtAuthGuard`
- **Purpose**: Turn a list of extracted action items into real `Task` rows plus `Change` sync entries, inside one `prisma.$transaction` (`src/ai/ai.service.ts:553`). `201 Created` (this route has no `@HttpCode`, unlike the other three). One `sync:invalidation` covers the whole batch after the commit, carrying the highest cursor the loop wrote — see `Server-to-Client Events`. A `tasks: []` body is valid input, creates nothing, logs nothing and sends no wake-up.
- **Gate**: the note must exist, be undeleted and belong to the caller — `404` otherwise. This is the only `/ai` route that requires a `noteId`.
- **Body** (`ConvertTasksDto`, validated per item):
  ```json
  {
    "tasks": [
      {
        "title": "Deploy Redis cluster ASAP",
        "description": "Extracted from note Sprint Planning",
        "priority": "HIGH",
        "dueDate": "2026-10-01T00:00:00.000Z"
      }
    ]
  }
  ```
  `title` is required and non-empty; `description`, `priority` (`LOW` | `MEDIUM` | `HIGH`, default `MEDIUM`) and `dueDate` are optional. `dueDate` is only checked as a string and then handed to `new Date(...)`, so an unparseable value is not rejected with a `400` here.
- **Behaviour details**:
  - `description` defaults to `` `Extracted from note: "<note title>"` `` when omitted.
  - Priority is widened onto the Prisma enum: `HIGH` → `P1_URGENT`, `LOW` → `P4_LOW`, and `MEDIUM` **or any unrecognised value** → `P3_MEDIUM`. `P2_HIGH` is therefore unreachable from this route, and the schema's own column default (`priority TaskPriority @default(P4_LOW)`) never applies because the service always sends a value.
  - Each created task appends a `Change` with `entityType: "task"`, `operation: CREATE`, `version: 1` and a payload of `{ title, priority, extractedFromNoteId }`, so the other devices pull them on their next `/sync/pull`.
  - Because the loop is inside one `$transaction` (which on MongoDB is a multi-document transaction and so needs the replica set), one bad item rolls the whole batch back.
- **Response**: `201 Created`
  ```json
  {
    "createdCount": 1,
    "tasks": [
      {
        "id": "…",
        "userId": "123e4567-e89b-12d3-a456-426614174000",
        "title": "Deploy Redis cluster ASAP",
        "priority": "P1_URGENT",
        "status": "TODO",
        "…": "the full Task row, all 18 scalar columns"
      }
    ]
  }
  ```

---

### 13. FIDO2 / WebAuthn Passkeys (`/auth/passkeys`)

Passkey _registration_ only. Passwordless login is not offered.

> [!WARNING]
> **`POST /auth/passkeys/login-options` and `POST /auth/passkeys/login-verify` are removed and return `404`.** They were not a weak second factor, they were a working authentication bypass: `verifyLogin` decoded `clientDataJSON`, required `type === "webauthn.get"`, required the `challenge` to be one it had issued, looked the credential up by the `id` in the request, and then minted an access/refresh pair and a `Session`. `dto.signature` was declared in `LoginVerifyDto` and read by nothing, so any request shaped like an assertion signed in as any account holding a `PASSKEY` row — no authenticator involved.
>
> Being public was never the bug: an endpoint that _establishes_ a session cannot be gated on one, and both routes stay public in the replacement. Two things are required before passkey login comes back, and neither is a reason to leave the broken pair up:
>
> 1. **Real verification**, from a relying-party library (`@simplewebauthn/server` is the usual choice here — none is installed): assertion signature, origin/rpId, and challenge lifecycle. The existing single-use challenge map and its expiry sweep were already correct and can be reused as they are. One open decision at that point: `login-options` answering a posted email with that account's `allowCredentials` is standard WebAuthn shape, but it also confirms the address has a passkey, so choose between that and a constant-shape answer.
> 2. **Re-enrolment, not upgrade in place.** `verifyRegistration` stores the raw `attestationObject` as `publicKey` without parsing the CBOR, so no registered row holds a usable credential key — the data needed was never captured. Treat every existing `AuthType.PASSKEY` row as invalid when the library lands (wipe them and prompt re-registration, or version the rows and reject pre-migration ones at verify time). Do not attempt to parse them retroactively.
>
> **The Flutter client does not drive these endpoints and never did.** `PasskeyService` fabricated the assertion a hardware authenticator is supposed to produce, so every press of its "SIGN IN WITH PASSKEY" button was a refusal wearing the clothes of a sign-in method; the button and the service are removed. A passkey sign-in needs a client that performs the real ceremony _and_ a server that verifies it.

#### `POST /auth/passkeys/register-options`

- **Access**: `JwtAuthGuard`
- **Purpose**: Generate a cryptographically secure registration challenge and WebAuthn relying party options for an authenticated user.
- **Body**:
  ```json
  {
    "deviceName": "MacBook Pro TouchID"
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "challenge": "dGhpcy1pcy1hLWNyZWRlbnRpYWwtY2hhbGxlbmdl",
    "rp": {
      "name": "Allinone",
      "id": "localhost"
    },
    "user": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "name": "user@example.com",
      "displayName": "Alex Mercer"
    },
    "pubKeyCredParams": [
      { "alg": -7, "type": "public-key" },
      { "alg": -257, "type": "public-key" }
    ],
    "timeout": 60000,
    "attestation": "none"
  }
  ```

#### `POST /auth/passkeys/register-verify`

- **Access**: `JwtAuthGuard`
- **Purpose**: Check that the client's credential-creation response carries the challenge this service issued for this user, and persist the credential under `Authentication` (`AuthType.PASSKEY`). It is _not_ an attestation verification: the `attestationObject` is stored verbatim as `passwordHash`'s `publicKey` field, with no CBOR parse — which is why the login half cannot be fixed without re-enrolling (see the warning above). No `Device` row is created here.
- **Body**:
  ```json
  {
    "id": "base64url-credential-id",
    "clientDataJSON": "base64url-clientDataJSON",
    "attestationObject": "base64url-attestationObject",
    "transports": ["internal", "hybrid"],
    "deviceName": "MacBook Pro TouchID"
  }
  ```
- **Response**: `201 Created`
  ```json
  {
    "success": true,
    "credentialId": "base64url-credential-id"
  }
  ```

#### `POST /auth/passkeys/login-options`, `POST /auth/passkeys/login-verify` — removed

Both return `404` (`Cannot POST /auth/passkeys/login-verify`) through the normal
error envelope. They are recorded at the top of this section rather than
documented as live endpoints, because the request/response shape below used to
read as a working passwordless login:

- `login-options` took `{ "email": "user@example.com" }` and answered with a
  challenge plus that account's `allowCredentials`.
- `login-verify` took `{ id, clientDataJSON, authenticatorData, signature,
userHandle }` and answered with `{ user, tokens: { accessToken, refreshToken,
expiresIn }, sessionId }`.

`authenticatorData` and `signature` were accepted and ignored. Do not restore
these routes by re-adding the handlers; the replacement is the library-backed
verification described above, with existing credentials re-enrolled.

---

## 📡 WebSockets Specification (`/sync` Namespace)

`SyncGateway` (`src/sync/sync.gateway.ts`) is the only WebSocket server in the project. It declares **no** `@SubscribeMessage` handlers: the socket is one-directional by design, a wake-up channel clients listen on. Everything a client sends goes over REST.

- **Namespace / URL**: `wss://<DOMAIN>/sync` (`@WebSocketGateway({ namespace: "/sync" })`, `src/sync/sync.gateway.ts:32`).
- **Handshake authentication** — the first of these that yields a value wins (`src/sync/sync.gateway.ts:54-57`):
  1. `auth: { token: "<JWT_ACCESS_TOKEN>" }` (socket.io handshake auth payload)
  2. `headers.authorization`, with `"Bearer "` stripped
  3. `query.token` (also read: `query.deviceId`, used only when the token carries no `deviceId`)
- **No token, or a token that fails `jwtService.verifyAsync` against `JWT_ACCESS_SECRET`** → the gateway logs a `warn` and `client.disconnect(true)`. There is no error frame and no `401`; from the client side a bad token looks like an immediate close.
- **CORS is decided at boot, not in the decorator.** `@WebSocketGateway` carries only `namespace` today; the `cors: { origin: "*" }` it used to hold is gone. `SyncIoAdapter` (`src/sync/adapters/sync-io.adapter.ts`) is installed by `src/main.ts:181` and answers the handshake from configuration, because decorator metadata is evaluated when the file is imported — long before any config object exists — so a policy written there could only ever have been a literal. The origin list, in order: `WS_CORS_ORIGINS`, then `CORS_ORIGINS`, then the HTTP app's `CORS_ORIGIN`, then `http://localhost:3000`. A configured list is never quietly widened: the only wildcard is the `*` an operator writes into it, and that is answered with `credentials: false` (a browser rejects `*` beside `Access-Control-Allow-Credentials: true`). Everything else is matched exactly, with credentials on. `WS_CORS_ALLOW_NULL_ORIGIN` (default `false`) is the documented escape hatch for WebView clients that send no `Origin` at all.
- **Transport list** is Socket.IO's default (`polling` then upgrade to `websocket`); the gateway sets no `transports`, so any doc claim that the server is websocket-only is wrong.

### Room Model

After the token verifies **and the account is revalidated below**, the socket joins exactly one room, built from the JWT's `sub` claim:

```
user:<userId>
```

The `userId` that names the room is still the token's `sub`, not a value read back from the database, and `deviceId` comes from `payload.deviceId` or `query.deviceId`. What changed is that the subject is no longer taken on trust: `handleConnection` calls `revalidate()` (`src/sync/sync.gateway.ts:143`) before the join.

> [!IMPORTANT]
> **Cross-instance invalidation is wired, and fails quiet when it is not working.** This section used to say the Redis Socket.IO adapter was never installed. That was true and is no longer: `src/main.ts:181` installs `SyncIoAdapter`, which extends `RedisIoAdapter` (`src/sync/adapters/redis-io.adapter.ts`) and calls `connectToRedis()` before `listen()`. Two conditions gate it — `REDIS_URL` must name a server, and `WS_REDIS_ADAPTER` must not be set to `false` — and when both hold, `user:<userId>` rooms are shared across replicas.
>
> The residual risk is the shape of the failure, not the wiring: a Redis that is configured but unreachable is caught, logged as a warning, and the process carries on with the default in-memory adapter. Rooms go per-process again, a client on instance B stops hearing invalidations from instance A, and nothing a load balancer or `/health` reports distinguishes that from a healthy cluster. `docker-compose.prod.yml` runs a single `api` container, so this is latent rather than live. Confirm the adapter line in the boot log (`[sync-ws] … Clustering: Redis when reachable` vs `in-process (no Redis configured)`) before assuming a second replica is safe to start. Tracked as P0-4.

> [!NOTE]
> **The handshake revalidates the account and the session, the way REST does.** `JwtStrategy.validate()` — the REST path — loads the user (`401` on `status !== "ACTIVE"` or `deletedAt`) and calls `isSessionLive()` (`src/auth/strategies/jwt.strategy.ts:54-75`). `handleConnection()` now asks the same two questions through the same `UsersService` before it joins the room, and refuses the socket when either fails: no user, `status !== "ACTIVE"`, `deletedAt` set, or a session id the account no longer has live. It reads the session claim from `sessionId`, `sid` or `session`, because `src/auth` owns that contract and the name has moved. A token with no session claim at all still connects, exactly as on REST.
>
> Two things this does **not** do, both worth knowing. It is a handshake check, so a socket already open when you revoke a session or disable an account is not dropped — it drains at its next reconnect or when the 15-minute access token expires. And it fails closed: `SyncGateway` injects `UsersService` as `@Optional()` for unit graphs and the worker, and when no users service is present `revalidate()` answers "Account revalidation is unavailable" and disconnects rather than falling back to trusting the signature.

### Server-to-Client Events

#### Event: `sync:invalidation`

**Produced by every write path, through one choke point.** Each service that appends a `Change` row now also announces it: `SyncService.pushChanges()` for `/sync/push` (`src/sync/sync.service.ts:155`), four sites in `NotesService` (`src/notes/services/notes.service.ts:80,276,321,399`), four in `TasksService` (`src/tasks/services/tasks.service.ts:107,308,417,455`), three in the calendar events service (`src/calendar/services/events.service.ts:109,265,341`) and one in `AiService.convertTasksForNote()` (`src/ai/ai.service.ts:608`). None of them touches `SyncGateway`; they all call `SyncNotificationService.notifyMutation()` (`src/sync/sync-notification.service.ts`), which wraps it.

This replaced a single producer, and the asymmetry it removed was the point: a REST mutation used to commit its `Change` row and emit nothing, so every other device learned of it only at its next `/sync/pull`. Two properties of the notifier are load-bearing and easy to lose in a later refactor:

- It runs **after** the caller's `prisma.$transaction` resolves, never inside it. A wake-up fired inside the transaction would announce rows that a rollback then removes — the pull that follows finds nothing, and the signal was a lie.
- It **cannot make the request fail.** The write is already committed by the time it is called, so a gateway that throws is caught and logged as a warning. A user whose note saved must not be shown a 500 because the broadcast behind it broke. `SyncGateway` is injected `@Optional()` for the same reason: the queue worker compiles no `SyncModule`, and losing the wake-up there costs a slower catch-up and nothing else.

Each call passes the `highestCursor` that its own `appendChange()` returned, so the payload names the end of the log rather than a number read back later.

```json
{
  "userId": "123e4567-e89b-12d3-a456-426614174000",
  "originDeviceId": "dev-123e4567-e89b-12d3-a456-426614174000",
  "highestCursor": "142857",
  "timestamp": "2026-09-10T16:00:00.000Z"
}
```

- `userId` and `highestCursor` are always present; `highestCursor` is `String(Change.cursor)` from the caller's just-committed `appendChange()`, or `"0"` when the caller passed nothing (`src/sync/sync.gateway.ts:194-199`).
- `originDeviceId` is present only for `/sync/push`, which is the one write path that names a device — no REST controller, DTO or header carries a device id anywhere in this API, so the REST-originated notices omit it and the gateway's log line reads `Origin Device: Server`. The value comes from the request body: the server trusts the client's own claim about who sent the change.
- `timestamp` is the emit time, not the mutation time.
- **Client Action on Receipt**: compare `highestCursor` with the local cursor and issue an incremental `POST /sync/pull` when it is ahead.
- **Origin device is NOT filtered server-side.** The emit goes to the whole room — `this.server.to(userRoom).emit(...)` — so the device that just pushed receives its own invalidation too. `originDeviceId` is in the payload so a client _can_ discard it, and the gateway's own comment (`src/sync/sync.gateway.ts:252-262`) explains why the server does not: dropping sockets would be a guess about what each device has already read, while the pull is self-correcting because it starts from the device's own checkpoint and the per-row version guard decides what applies. A client that ignores `originDeviceId` therefore does one extra pull per own-write — correct, just chatty.

---

## 🧪 Documentation Verification & Parity

This document describes the code that is in the tree today, not the design the document
was written from. Every route line, guard line and status code was re-derived on
2026-09-27 against:

- NestJS controllers in `src/**/*.controller.ts` and `src/**/controllers/*.controller.ts`
  — 19 controllers, each read for its decorator prefix and per-route decorators
- the WebSocket gateway in `src/sync/sync.gateway.ts`
- the Prisma schema in `prisma/schema.prisma` (29 models) and the call sites in each service
- class-validator DTOs in `src/**/dto/*.dto.ts`
- guards, interceptors and the exception filter in `src/common/`, `src/auth/guards/`, `src/admin/guards/`

Three things this document deliberately does **not** claim:

1. **The JSON samples are shapes, not captures.** Field names, nesting and enum values
   were taken from the `return` statements (or, for Prisma rows, the model's columns), but
   the values are invented. Where a payload was actually observed from a running instance
   the section says so — `GET /` and `GET /info` are the two that are verbatim.
2. **Passing tests are not proof of behaviour.** `npm run test` compiles and unit-tests
   services with collaborators stubbed, so a class can be constructed, exercised and green
   while nothing in the running application ever asks for it. Two examples that hold today,
   both cited in their own sections: `RedisThrottlerStorage` is unit-tested and is still not
   the storage `ThrottlerModule` is configured with, so rate limits remain per-process; and
   the `BACKUP_ENABLED` / `BACKUP_SCHEDULE` getters have no caller anywhere in `src/` and
   there is no cron, timer or systemd unit in the repository, so the backup settings
   describe an operator-run `scripts/backup-database.sh`, not a job the app starts. Claims
   about what happens at runtime cite a file and line, or a probe against a live instance,
   and where neither was possible the text says "not wired".
3. **Route existence and route usefulness differ.** Several endpoints listed here are
   reachable and validated but do not yet do what they appear to: the `/collaboration`
   routes now read and write a real `ResourceShare` collection, which exists in
   `prisma/schema.prisma` and in no database until `prisma db push` is run against it; the
   `/ai` routes answer from heuristics because no Gemini key is configured anywhere in the
   repository, so `provider` is `"heuristic"` in every environment; and the object-storage
   columns behind attachments are never written because no S3 client is constructed. Each
   such case is called out in its own section rather than being averaged into a summary here.

Open verification questions are marked `⚠️ TODO(verify)` in `DEPLOYMENT.md`,
`DISASTER_RECOVERY.md`, `GETTING_STARTED.md` and `INCIDENT_RESPONSE.md`. Anything
contradicted elsewhere in `docs/` loses to this file for routes and payloads, and loses to
the source for everything else — `docs/` is not evidence about the code, the code is.
