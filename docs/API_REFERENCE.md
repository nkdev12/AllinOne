# Allinone Backend — End-to-End API Reference

This document provides a comprehensive specification of all HTTP REST endpoints, WebSocket event handlers, request/response DTOs, authentication requirements, rate limits, error schemas, and cross-cutting headers across all backend modules.

---

## 🔐 Authentication & Global Headers

There is no global authentication guard — the only app-wide `APP_GUARD` is `CustomThrottlerGuard` (`src/app/app.module.ts:159-162`) — so a route is protected exactly where `@UseGuards(JwtAuthGuard)` is applied, and the routes labelled `@Public()` below are simply the ones with no guard. No `@Public()` decorator exists in `src/`. Protected routes take the access token in the standard `Authorization` header; `JwtStrategy` extracts it from that header only, never from a cookie (`src/auth/strategies/jwt.strategy.ts:24-38`):

```http
Authorization: Bearer <JWT_ACCESS_TOKEN>
```

### Key Request Headers

| Header Name                 | Type                        | Required                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | --------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Authorization`             | String                      | Yes (Protected routes)  | `Bearer <JWT_ACCESS_TOKEN>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Content-Type`              | String                      | Yes (POST/PUT/PATCH)    | `application/json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Idempotency-Key`           | String, any non-empty value | Optional                | Replays a cached response for the same `(userId, key)` pair. **Not** "exact-once execution": a hit returns the stored response and the handler never runs, so a retry whose first attempt already landed is silently dropped. Stored in the `IdempotencyKey` collection in MongoDB with a 24-hour `expiresAt` — there is no Redis tier in this path, and no PostgreSQL. The value need not be a UUID, and nothing in the interceptor checks. See `POST /sync/push` for why a caller usually wants to send none.                                                                      |
| `X-Request-ID`              | String                      | Optional (Client)       | A correlation id the client sends. **Only error responses touch it**: `AllExceptionsFilter` reads the header, generates a `uuidv4()` when absent, puts it in the envelope body and echoes it as a response header (`all-exceptions.filter.ts:54,170`). A 2xx response carries no `X-Request-ID` at all, so it is not a server-guaranteed id on the success path and cannot be used to correlate a request that worked.                                                                                                                                                               |
| `X-Trace-ID`, `traceparent` | String                      | Server (all routes)     | The two headers a successful response _does_ carry: `TracingInterceptor` sets both on every route, which is what to log if you want one id across a whole call.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `x-admin-secret`            | String                      | Optional (Admin routes) | Shared secret for automated admin tooling. **Not a standalone credential:** `JwtAuthGuard` runs before `AdminGuard`, so a request carrying only this header gets `401` (verified against a running instance on 2026-09-27). It must accompany a valid Bearer token for _any_ active user, and it is compared against the `ADMIN_SECRET` env var — which is in no `.env.example`, in neither Joi schema and not on `ConfigurationService`, so it is unset in practice and the branch at `src/admin/guards/admin.guard.ts:18-22` never fires. See the warning in the `/admin` section. |

---

## 🛑 Global Error Response Format

All error responses return standard HTTP status codes and a consistent JSON payload produced by `AllExceptionsFilter` (`src/common/error-handling/filters/all-exceptions.filter.ts:12-23`; `details` and `traceId` are optional and absent when nothing populates them):

```json
{
  "statusCode": 400,
  "code": "VALIDATION_ERROR",
  "message": [
    "email must be an email",
    "password must be at least 8 characters"
  ],
  "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-09-07T14:00:00.000Z",
  "path": "/auth/register"
}
```

> [!NOTE]
> **Error Message Shape (`string | string[]`)**:
> The `message` field is polymorphic:
>
> - For DTO validation failures (HTTP 400 `VALIDATION_ERROR` emitted by NestJS `ValidationPipe`), `message` is an array of strings detailing each violated constraint.
> - For standard operational exceptions (401, 403, 404, 409, 429, 500), `message` is a single descriptive string.

### Standard Error Codes

- `VALIDATION_ERROR` (400)
- `UNAUTHORIZED` (401)
- `FORBIDDEN` (403)
- `NOT_FOUND` (404)
- `CONFLICT` (409)
- `RATE_LIMITED` (429)
- `INTERNAL_ERROR` (500)
  | HTTP Status                 | Error Code         | Description                                                                                                                                                                                                                                                                                                            |
  | --------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `400 Bad Request`           | `VALIDATION_ERROR` | Request validation failed (schema, types, constraints)                                                                                                                                                                                                                                                                 |
  | `401 Unauthorized`          | `UNAUTHORIZED`     | Missing, expired, or invalid authentication credentials                                                                                                                                                                                                                                                                |
  | `403 Forbidden`             | `FORBIDDEN`        | Authenticated user lacks permission for the resource                                                                                                                                                                                                                                                                   |
  | `404 Not Found`             | `NOT_FOUND`        | Target entity does not exist or has been soft-deleted                                                                                                                                                                                                                                                                  |
  | `409 Conflict`              | `CONFLICT`         | Resource collision (e.g. duplicate email, unique constraint)                                                                                                                                                                                                                                                           |
  | `429 Too Many Requests`     | `RATE_LIMITED`     | Throttler quota exceeded for the client or user                                                                                                                                                                                                                                                                        |
  | `500 Internal Server Error` | `INTERNAL_ERROR`   | Unhandled server or database exception                                                                                                                                                                                                                                                                                 |
  | `503 Service Unavailable`   | `INTERNAL_ERROR`   | The filter has no 503 branch — anything `>= 500` is reported as `INTERNAL_ERROR` (`all-exceptions.filter.ts:30-46`). The `503` you see from `/health` and `/health/ready` is a different answer: those handlers write the Terminus-shaped body directly (`health.controller.ts:18-26`), so it carries no `code` at all |

Beyond these coarse keys, a route can return a specific code in the same `code`
field. `SESSION_REVOKED` (401) is one: every authenticated request looks the
`sessionId` claim in the bearer token up against its `Session` row, and a row
that is missing, carries a `revokedAt`, or belongs to a different account fails
here. Treat it as signed out — the refresh token behind it is dead as well.
Tokens that carry no `sessionId` predate the claim and are not checked.

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
> 1. **Throttling is off by default outside production.** `CustomThrottlerGuard.shouldSkip()`
>    stands the limits down when `APP_ENV=development`, `NODE_ENV=test`,
>    `DISABLE_RATE_LIMITING=true` or `RATE_LIMIT_ENABLED=false` — and `development` is the
>    default for `APP_ENV`. So on a local server every limit in this document reads as
>    unlimited unless you set `RATE_LIMIT_ENABLED=true`, which is also how you get to test
>    them before production. The `x-skip-throttle` / `x-bypass-rate-limit` headers do nothing
>    unless an operator sets `RATE_LIMIT_HEADER_BYPASS=true`, and never under `APP_ENV=production`.
> 2. **The bucket is an IP, not a user.** `getTracker()` prefers `user:<req.user.id>` and
>    falls back to `ip:<first x-forwarded-for value>` — but this guard is registered as the
>    app-wide `APP_GUARD` (`src/app/app.module.ts`), and global guards run _before_ a route's
>    `JwtAuthGuard`, so `req.user` is always unset when the key is built. Every limit is
>    therefore per-IP for authenticated traffic too, which is why one office NAT divides one
>    account's login budget. See `MODULES_GUIDE.md`.
> 3. **Counters live in Redis, and Redis is not in the schema.** The store is
>    `RedisThrottlerStorage` over `configurationService.redisUrl`, whose `REDIS_URL` is read
>    with a `redis://localhost:6379` fallback and is declared in neither Joi schema
>    (`src/app/app.module.ts:42-105`, `src/worker.module.ts`) nor `.env.example`. It also
>    falls back to the in-memory store when Redis is unreachable, so limits restart with the
>    process instead of failing closed.
>
> Routes with **no** `@Throttle()` decorator — `POST /auth/logout`, `POST /auth/mfa/generate`,
> `POST /auth/mfa/enable`, `POST /auth/mfa/disable`, and everything under `/users`, `/devices`,
> `/notes`, `/tasks`, `/calendar`, `/sync`, `/vault` except the four vault routes below — take
> the global default: `RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS`, i.e. **100 requests
> per 60 s** unless the deployment overrides them.
>
> **Token lifetimes are configuration, and one number backs every claim about them.**
> `JWT_ACCESS_EXPIRATION` (default `15m`) and `JWT_REFRESH_EXPIRATION` (default `7d`) are read
> through `ConfigurationService` (`src/config/configuration.service.ts:206`, `:214`) and parsed to
> seconds once by `parseTokenLifetime()` (`:51`). That seconds value is what every consumer uses:
> both `sign()` calls (`src/auth/auth.service.ts:1351`, `:1356`), the `expiresIn` a client counts
> down (`:1362`), the `Session.accessExpiresAt` / `refreshExpiresAt` columns written at login
> (`:1386`, `:1389`) and again at rotation (`:772`, `:775`), the refresh cookie's `maxAge`
> (`src/auth/auth.controller.ts:68`) and the `JwtModule` default (`src/auth/auth.module.ts:34`).
> Until 2026-09-27 all of those were separate literals and the two variables reached none of them;
> if you are reading an older copy of this document, that is why it said setting them changed
> nothing. Defaults are unchanged, so the 15-minute / 7-day figures below are still the behaviour
> of an unconfigured deployment. A value this parser cannot read — `1w` is the likely one, since
> `jsonwebtoken` has no week — aborts the boot (`:109`) rather than surfacing as a 500 on someone's
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

- **Access**: `@Public()`
- **Purpose**: Prometheus scrape endpoint exposing real-time operational metrics as `text/plain; version=0.0.4`.
- **Response**: `200 OK` (`text/plain; version=0.0.4`)

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
- **Rate Limit**: 3 per hour (`@Throttle({ default: { limit: 3, ttl: 3600000 } })`, `src/auth/auth.controller.ts:65`)
- **Body**: `RegisterDto` — `email` (required), `password` (required), `displayName?`, `locale?` (default `en-US`), `timezone?` (default `UTC`). The DTO is `RegisterDto`, not a `CreateUserDto`.
- **What it does** (`AuthService.register`, `src/auth/auth.service.ts:62-150`): rejects a duplicate email with `409 EMAIL_ALREADY_REGISTERED` (and maps Prisma's `P2002` to the same answer, so the unique index — not the pre-check — is the real guard), then in one `$transaction` creates the `User` (`status: "ACTIVE"`, `displayName` or `null`), an `Authentication` row of type `EMAIL_PASSWORD` with the **Argon2** hash and `emailVerified: false`, and a `Device` row named `"Primary Web/Client Device"` on platform `WEB` with an empty `publicKey`. It then issues a full session, fires `requestEmailVerification()` without awaiting it (a mail failure only logs), and records `ACCOUNT_CREATED`.
- **Response**: `201 Created` — `AuthResponseDto`. Registration **logs you in**: a live access/refresh pair comes back in the body.
  ```json
  {
    "user": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "email": "user@example.com",
      "displayName": "Alex Mercer",
      "locale": "en-US",
      "timezone": "UTC",
      "status": "ACTIVE",
      "createdAt": "2026-09-27T10:00:00.000Z"
    },
    "tokens": {
      "accessToken": "eyJhbG...",
      "refreshToken": "eyJhbG...",
      "expiresIn": 900
    },
    "sessionId": "123e4567-e89b-12d3-a456-426614174000",
    "deviceId": "123e4567-e89b-12d3-a456-426614174000"
  }
  ```
  There is no `isEmailVerified` and no `mfaEnabled` in this response — verification state lives on the `Authentication` row, which this payload never touches. No `refresh_token` cookie is set here (the handler takes no `@Res`), so the refresh token exists only in the body.
- **`status: "ACTIVE"` with `emailVerified: false`** is the property that makes P0-10 in the improvement tracker reachable: nothing in the registration path requires the address to be verified before the account can authenticate, and the address is chosen by the caller.

#### `POST /auth/login`

- **Access**: `@Public()`
- **Rate Limit**: 5 per minute (`limit: 5, ttl: 60000`)
- **Body**: `LoginDto` — `email`, `password`, and optionally `deviceId`, `deviceName`, `platform` (a `Platform` enum value such as `MACOS`, `LINUX`, `ANDROID`, `WEB`), `appVersion`, `publicKey`.
- **Response**: `200 OK`
  - **MFA not enabled**: full `AuthResponseDto` (`user`, `tokens`, `sessionId`, `deviceId`), and `setRefreshTokenCookie()` mirrors the refresh token into a cookie. The failed-attempt counter is reset here.
  - **MFA enabled**: `200` with `{ mfaRequired: true, mfaToken }` and **no** `user`/`tokens` — `tokens` is absent, so `setRefreshTokenCookie()` returns early (`auth.controller.ts:53-54`) and no cookie is set. The `mfaToken` is a separate JWT signed with the **access** secret, `purpose: "MFA_CHALLENGE"`, `expiresIn: "5m"` (`auth.service.ts:337-344`); exchange it at `POST /auth/mfa/verify`.
  - **Wrong credentials**: `401 INVALID_CREDENTIALS`, after incrementing `failedLoginAttempts` and writing a `LOGIN_FAILURE` audit row with the caller's IP and user-agent. A nonexistent email and a wrong password answer identically, but a `409` for a locked or suspended account is distinguishable, which leaks account state.
- **Cookie attributes** (`src/auth/auth.controller.ts:53-62`) — `name=refresh_token`, `httpOnly: true`, `sameSite: "strict"`, `path: "/auth/refresh"`, `maxAge: 7 days`, and `secure: process.env.APP_ENV === "production"`. Two consequences worth stating plainly: under `APP_ENV=staging` the cookie is **not** `Secure`, and reading `process.env` directly here bypasses `ConfigurationService`, so it is the one place `APP_ENV` is consulted as a raw variable.
  - When MFA is enabled: Returns `{ "mfaRequired": true, "tempToken": "<TICKET_JWT>" }`.
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
- **Rate Limit**: 10 per minute
- **Input**: `refreshToken` in the body **or** the `refresh_token` httpOnly cookie (the cookie wins; the body exists for non-browser clients). `RefreshTokenDto.refreshToken` is optional, so `{}` reaches the handler and is answered from there.
- **Response**: `200 OK` — a rotated access/refresh pair, and `refresh_token` re-set as a cookie.
- **What actually decides acceptance** (`AuthService.refreshTokens`, `src/auth/auth.service.ts:734-783`): the presented string is verified against `JWT_REFRESH_SECRET` — so an **access** token is rejected here, since it is signed with a different secret; the two secrets must stay different, and `.env.example` ships distinct placeholders for exactly this reason. Then a `Session` row must exist whose stored `refreshToken` equals the presented token verbatim, with `revokedAt` unset, `refreshExpiresAt` in the future and `userId === payload.sub`. Anything else is the same `401 TOKEN_INVALID "Invalid or expired refresh token"`.
- **Rotation**: a brand-new pair is minted and written over the row's `accessToken` / `refreshToken`, with `accessExpiresAt` and `refreshExpiresAt` recomputed from the same parsed `JWT_ACCESS_EXPIRATION` / `JWT_REFRESH_EXPIRATION` values the new tokens were signed with (`src/auth/auth.service.ts:772`, `:775`) — so the row and the credentials cannot drift, and the `15 min` / `7 days` figures hold only because those are the defaults.
- **Two properties worth knowing before you rely on this route**: the session document keeps the **raw** JWTs, so any read of the `Session` collection yields live credentials (backups, `mongosh`, a leaked read replica) until the row is overwritten; and old-token reuse is _prevented_ by the lookup but not _detected_ — a stolen-and-replayed refresh token that arrives after the legitimate rotation simply gets `401`, with no alert, no session-family revocation and nothing in the audit log.

#### `POST /auth/logout`

- **Access**: `JwtAuthGuard`
- **Rate Limit**: none on the route — the global default (100 per 60 s) applies.
- **Response**: `200 OK` `{"success": true}` — sets `revokedAt` on the session the calling token names and clears the `refresh_token` cookie. From the next request on, that token fails with `401 SESSION_REVOKED`, because `JwtStrategy.validate()` re-reads the session row. **This does not affect an open `/sync` WebSocket** — the gateway authenticates only at handshake and never re-checks the session.

#### `POST /auth/verify-email/request`

- **Access**: `@Public()`
- **Rate Limit**: 3 per minute
- **Body**: `{ "email": "user@example.com" }`
- **Response**: `200 OK` `{"message": "Verification email sent if account exists"}` — the same answer whether or not the address is registered, which is the point: the endpoint is an existence oracle otherwise. The OTP is generated and mailed only when `ConfigurationService.emailVerifyEnabled` is on; **`EMAIL_VERIFY_ENABLED` defaults to `false`** in both the Joi schema (`src/app/app.module.ts:64`) and the getter (`src/config/configuration.service.ts:113-117`), so out of the box this route returns the sent-message and sends nothing.

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
- **Response**: `200 OK`
  ```json
  {
    "secret": "JBSWY3DPEHPK3PXP",
    "qrCodeUrl": "data:image/png;base64,..."
  }
  ```

#### `POST /auth/mfa/enable`

- **Access**: `JwtAuthGuard`
- **Body**: `{ "token": "123456" }`
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "recoveryCodes": ["A1B2-C3D4", "E5F6-G7H8"]
  }
  ```

#### `POST /auth/mfa/verify`

- **Access**: `@Public()`
- **Rate Limit**: 5 per minute
- **Body**:
  ```json
  {
    "tempToken": "<TICKET_JWT>",
    "totpCode": "123456",
    "recoveryCode": "A1B2-C3D4"
  }
  ```
  _(Supply either `totpCode` or single-use `recoveryCode`)_
- **Response**: `200 OK` — Full `AuthResponseDto` with session tokens.

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
- **Response**: `200 OK` `{"success": true, "message": "MFA disabled"}`

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
  The shape is `prisma/schema.prisma:17-53`. The account's password verifier is not in this answer — it lives on the separate `Authentication` model (`prisma/schema.prisma:95-110`), which this query never loads.

#### `PATCH /users/me`

- **Access**: `JwtAuthGuard`
- **Body**: `UpdateUserProfileDto` — every field optional; the avatar column is called `avatar`, not `avatarUrl` (`src/users/dto/update-user-profile.dto.ts:3-31`)
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
- **Purpose**: Records a GDPR/CCPA export request. **It enqueues nothing** — `UsersService.requestDataExport` reads the user, writes a log line and returns; no job reaches the `export` queue (`src/users/users.service.ts:110-125`).
- **Response**: `202 Accepted` `{"status": "accepted", "message": "Data export request recorded. Background export delivery is disabled."}`

#### `DELETE /users/me`

- **Access**: `JwtAuthGuard`
- **Purpose**: Soft deletes account (`status = DELETED`, `deletedAt = now()`) and revokes all active sessions and devices in one transaction (`src/users/users.service.ts:81-109`).
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

**Two write paths, and they are not the same store.** For `vault_item`, the
oplog below is the only way in: `VaultModule` exposes settings and recovery only,
and there is no REST route that creates, edits or deletes an entry. For `note`,
`task` and `event` there is a full REST CRUD surface, and it writes the entity row
(`Note`, `Task`, `Event`) _and_ appends a `Change` — while `/sync/push` appends a
`Change` and **never touches the entity table**. Nothing anywhere replays `Change`
rows back into `Note`, so the two stores are disjoint: a note pushed through sync
has no `Note` row, and a note created by `POST /notes` reaches a device only
because the same request logged it. What _is_ true of both: `appendChange`
(`src/sync/change-cursor.ts`) is the only way to write a `Change`, and it allocates
the cursor, so a logged change cannot be numbered 0 and become unreadable.
`entityType` must be one of `note`, `task`, `event`, `vault_item`
(`SYNC_ENTITY_TYPES` in `src/sync/change-payload.validator.ts`); anything else
fails the whole batch with `SYNC_PUSH_REJECTED` before a single row is written.

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
  enforced by `@ArrayMaxSize`): the batch is read, version-checked and written
  inside one `$transaction`, so its length is that transaction's size. The
  request body itself is bounded by body-parser's 100 kB default, and the
  shipped client stops a batch at 64 KiB of JSON to stay under it.
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
    "newCursor": "142857",
    "processedCount": 2,
    "conflictsResolved": 0,
    "highestCursor": "142857",
    "lastPushedSequence": 2
  }
  ```
  `accepted` lists the ids of the `Change` rows that were written, **not** the
  `entityId`s that were queued — a client cannot infer what was stored from it.
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
> This is **not** zero-knowledge: `VaultSetting.recoveryKey` is stored in plaintext next to `wrappedMasterKey` so that a user who loses their master password can recover the vault without losing it. Anyone with database read access can therefore unwrap that user's master key and open every entry. Recovery is an intentional product trade-off, not an oversight.

#### `POST /vault/settings/setup`

- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "masterKeyHash": "q7L1Z3mYxk1hZ8jH0lYXn0K8pQe1o2uW3r5t7y9b0cA=",
    "keySalt": "c2FsdF9iYXNlNjRfc3RyaW5n",
    "kdfIterations": 3,
    "kdfMemory": 65536,
    "recoveryKey": "base64-256bit-wrap-key",
    "wrappedMasterKey": "base64-ciphertext",
    "wrappedMasterIv": "base64-96bit-nonce",
    "wrappedMasterTag": "base64-gcm-tag"
  }
  ```
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
- **Notes**: `masterKeyHash` is `base64(SHA-256(argon2id(password, salt)))` — the verifier, not the key. What the row _stores_ is `hmac-sha256:<base64>` of that value, keyed with the server-only `ENCRYPTION_KEY`, so a read of the collection does not hand over the unlock credential; rows written before that conversion keep the raw value and are rewritten on their next successful unlock. `kdfIterations` / `kdfMemory` are what the client derived with — the shipped build uses Argon2id `t=3, m=65536 KiB, p=4` and reports the first two; a request that omits them stores those same values. **Nothing reads them back**: the copy a build can trust is the `_kdf` marker sealed inside every entry blob, so sending different numbers here changes a record, not a behaviour (see `SECURITY.md`). A time cost below `t=1` is rejected as a validation error — the floor used to be `1000`, which would have refused the only honest value. Setup against an already-configured vault returns `409 VAULT_ALREADY_CONFIGURED`; rotate the master password through the recovery flow instead.

#### `GET /vault/settings`

- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — same shape as the `setup` response. An account that never set a vault up gets `{ "isVaultConfigured": false, "keySalt": null, "kdfIterations": null, "kdfMemory": null }`. The stored verifier is never returned.

#### `POST /vault/settings/unlock`

- **Access**: `JwtAuthGuard`
- **Body**: `{ "masterKeyHash": "..." }`
- **Purpose**: Compares the verifier the client derived against the stored one. It proves the master password without transmitting it.
- **Response**: `200 OK` `{ "success": true, "unlockedAt": "..." }` · `401 VAULT_MASTER_KEY_MISMATCH` · `401 RATE_LIMITED` `{ retryInSeconds }` · `404 VAULT_NOT_CONFIGURED`
- **Notes**: Five consecutive failures start a one-minute cooldown on the vault, doubling to an hour, and while it runs the endpoint refuses even the correct verifier. The counter lives on `VaultSetting`, not `User`: a mistyped master password must not lock the account out of its notes, tasks and calendar. The endpoint is separately throttled to 10 requests/minute per user.

#### `POST /vault/settings/recovery/request`

- **Access**: `JwtAuthGuard` · rate-limited to 3 per minute
- **Purpose**: Emails a single-use 6-digit code that unlocks the recovery blob. Outside production the code is also logged.
- **Response**: `200 OK` `{ "message": "If the vault can be recovered, a code has been sent to the account email address." }` · `400 VAULT_RECOVERY_UNAVAILABLE` when no wrapped key is stored.

#### `POST /vault/settings/recovery/verify`

- **Access**: `JwtAuthGuard` · rate-limited to 5 per minute
- **Body**: `{ "otp": "123456" }`
- **Response**: `200 OK` — `{ keySalt, recoveryKey, wrappedMasterKey, wrappedMasterIv, wrappedMasterTag }`, the material the client needs to unwrap the old master key and re-encrypt its entries. The stored verifier is not part of this answer: the unwrap is authenticated by its own GCM tag, and echoing a bearer secret back would only give the client a second way to be wrong. Spending the code opens a 15-minute grant window (`recoveryGrantedAt`).

#### `POST /vault/settings/recovery/complete`

- **Access**: `JwtAuthGuard`
- **Body**: same shape as `setup`, with the new salt, verifier and recovery blob.
- **Purpose**: Stores the parameters for the rotated master password. The client re-encrypts its entries locally and uploads them through `POST /sync/push` before the recovery grant expires.
- **Response**: `200 OK` — same shape as `setup` · `401 VAULT_RECOVERY_NOT_PENDING` once the grant has expired.

#### Vault entries: the sync oplog

Vault entries are `Change` rows with `entityType: "vault_item"` — see section 5 (`/sync`). The payload contract enforced by `src/sync/change-payload.validator.ts` is:

- `CREATE` / `UPDATE` / `RESTORE`: non-empty strings `type`, `encryptedData`, `iv`, `authTag`, plus boolean `isEncrypted`. `type`, `iv` and `authTag` may not exceed 128 characters — a 96-bit nonce base64s to 16 and a GCM tag to 24, so a longer value is a wrong value rather than a bigger one. `encryptedData` carries no per-field cap: it grows with the entry and the bound that matters is the request body limit.
- `DELETE`: not judged. A tombstone legitimately has no content, and today's client sends `{}`.
  A batch containing a rejected payload is refused whole, before any row is written, and reports the offending fields. The server never decrypts, merges or inspects an entry blob; version comparison decides what is stored, and the client decides what is displayed.

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
- **Query Parameters** (`src/collaboration/dto/collaboration.dto.ts:70-97`):
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

Only two code paths consult `CollaborationService` outside this module — `NotesService.getNoteById()` (requires `VIEWER`) and `NotesService.updateNote()` (requires `EDITOR`), both `@Optional()` injected (`src/notes/services/notes.service.ts:14`). Concretely:

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
- **CORS is decided at boot, not in the decorator.** `@WebSocketGateway` carries only `namespace` today; the `cors: { origin: "*" }` it used to hold is gone. `SyncIoAdapter` (`src/sync/adapters/sync-io.adapter.ts`) is installed by `src/main.ts:97` and answers the handshake from configuration, because decorator metadata is evaluated when the file is imported — long before any config object exists — so a policy written there could only ever have been a literal. The origin list, in order: `WS_CORS_ORIGINS`, then `CORS_ORIGINS`, then the HTTP app's `CORS_ORIGIN`, then `http://localhost:3000`. A configured list is never quietly widened: the only wildcard is the `*` an operator writes into it, and that is answered with `credentials: false` (a browser rejects `*` beside `Access-Control-Allow-Credentials: true`). Everything else is matched exactly, with credentials on. `WS_CORS_ALLOW_NULL_ORIGIN` (default `false`) is the documented escape hatch for WebView clients that send no `Origin` at all.
- **Transport list** is Socket.IO's default (`polling` then upgrade to `websocket`); the gateway sets no `transports`, so any doc claim that the server is websocket-only is wrong.

### Room Model

After the token verifies **and the account is revalidated below**, the socket joins exactly one room, built from the JWT's `sub` claim:

```
user:<userId>
```

The `userId` that names the room is still the token's `sub`, not a value read back from the database, and `deviceId` comes from `payload.deviceId` or `query.deviceId`. What changed is that the subject is no longer taken on trust: `handleConnection` calls `revalidate()` (`src/sync/sync.gateway.ts:81`) before the join.

> [!IMPORTANT]
> **Cross-instance invalidation is wired, and fails quiet when it is not working.** This section used to say the Redis Socket.IO adapter was never installed. That was true and is no longer: `src/main.ts:97` installs `SyncIoAdapter`, which extends `RedisIoAdapter` (`src/sync/adapters/redis-io.adapter.ts`) and calls `connectToRedis()` before `listen()`. Two conditions gate it — `REDIS_URL` must name a server, and `WS_REDIS_ADAPTER` must not be set to `false` — and when both hold, `user:<userId>` rooms are shared across replicas.
>
> The residual risk is the shape of the failure, not the wiring: a Redis that is configured but unreachable is caught, logged as a warning, and the process carries on with the default in-memory adapter. Rooms go per-process again, a client on instance B stops hearing invalidations from instance A, and nothing a load balancer or `/health` reports distinguishes that from a healthy cluster. `docker-compose.prod.yml` runs a single `api` container, so this is latent rather than live. Confirm the adapter line in the boot log (`[sync-ws] … Clustering: Redis when reachable` vs `in-process (no Redis configured)`) before assuming a second replica is safe to start. Tracked as P0-4.

> [!NOTE]
> **The handshake revalidates the account and the session, the way REST does.** `JwtStrategy.validate()` — the REST path — loads the user (`401` on `status !== "ACTIVE"` or `deletedAt`) and calls `isSessionLive()` (`src/auth/strategies/jwt.strategy.ts:44-66`). `handleConnection()` now asks the same two questions through the same `UsersService` before it joins the room, and refuses the socket when either fails: no user, `status !== "ACTIVE"`, `deletedAt` set, or a session id the account no longer has live. It reads the session claim from `sessionId`, `sid` or `session`, because `src/auth` owns that contract and the name has moved. A token with no session claim at all still connects, exactly as on REST.
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
- **Origin device is NOT filtered server-side.** The emit goes to the whole room — `this.server.to(userRoom).emit(...)` — so the device that just pushed receives its own invalidation too. `originDeviceId` is in the payload so a client _can_ discard it, and the gateway's own comment (`src/sync/sync.gateway.ts:171-181`) explains why the server does not: dropping sockets would be a guess about what each device has already read, while the pull is self-correcting because it starts from the device's own checkpoint and the per-row version guard decides what applies. A client that ignores `originDeviceId` therefore does one extra pull per own-write — correct, just chatty.

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
