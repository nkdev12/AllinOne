# Allinone Backend — End-to-End API Reference

This document provides a comprehensive specification of all HTTP REST endpoints, WebSocket event handlers, request/response DTOs, authentication requirements, rate limits, error schemas, and cross-cutting headers.
This document provides a comprehensive specification of all HTTP REST endpoints, WebSocket event handlers, request/response DTOs, authentication requirements, rate limits, error schemas, and cross-cutting headers across all backend modules.

---

## 🔐 Authentication & Global Headers

All API endpoints (except `@Public()` routes) require HTTP Bearer Token authentication via the `Authorization` header:
All API endpoints (except routes annotated with `@Public()`) require HTTP Bearer Token authentication via the standard `Authorization` header:

```http
Authorization: Bearer <JWT_ACCESS_TOKEN>
```

### Key Request Headers

| Header Name | Type | Required | Description |
|-------------|------|----------|-------------|
| `Authorization` | String | Yes (Protected routes) | `Bearer <JWT_ACCESS_TOKEN>` |
| `Content-Type` | String | Yes (POST/PUT/PATCH) | `application/json` |
| `Idempotency-Key` | String, any non-empty value | Optional | Replays a cached response for the same `(userId, key)` pair. **Not** "exact-once execution": a hit returns the stored response and the handler never runs, so a retry whose first attempt already landed is silently dropped. Stored in the `IdempotencyKey` collection in MongoDB with a 24-hour `expiresAt` — there is no Redis tier in this path, and no PostgreSQL. The value need not be a UUID, and nothing in the interceptor checks. See `POST /sync/push` for why a caller usually wants to send none. |
| `X-Request-ID` | String | Optional (Client) | A correlation id the client sends. **Only error responses touch it**: `AllExceptionsFilter` reads the header, generates a `uuidv4()` when absent, puts it in the envelope body and echoes it as a response header (`all-exceptions.filter.ts:54,170`). A 2xx response carries no `X-Request-ID` at all, so it is not a server-guaranteed id on the success path and cannot be used to correlate a request that worked. |
| `X-Trace-ID`, `traceparent` | String | Server (all routes) | The two headers a successful response *does* carry: `TracingInterceptor` sets both on every route, which is what to log if you want one id across a whole call. |
| `x-admin-secret` | String | Optional (Admin routes) | Shared secret for automated admin/CLI emergency operations. Validated alongside or in lieu of operator JWT. |

---

## 🛑 Global Error Response Format

All error responses return standard HTTP status codes and a consistent JSON payload:
All error responses return standard HTTP status codes and a consistent JSON payload produced by `AllExceptionsFilter`:

```json
{
  "statusCode": 400,
  "code": "VALIDATION_ERROR",
  "message": ["email must be an email", "password must be at least 8 characters"],
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
| HTTP Status | Error Code | Description |
|-------------|------------|-------------|
| `400 Bad Request` | `VALIDATION_ERROR` | Request validation failed (schema, types, constraints) |
| `401 Unauthorized` | `UNAUTHORIZED` | Missing, expired, or invalid authentication credentials |
| `403 Forbidden` | `FORBIDDEN` | Authenticated user lacks permission for the resource |
| `404 Not Found` | `NOT_FOUND` | Target entity does not exist or has been soft-deleted |
| `409 Conflict` | `CONFLICT` | Resource collision (e.g. duplicate email, unique constraint) |
| `429 Too Many Requests` | `RATE_LIMITED` | Throttler quota exceeded for the client or user |
| `500 Internal Server Error` | `INTERNAL_ERROR` | Unhandled server or database exception |
| `503 Service Unavailable` | `SERVICE_UNAVAILABLE` | Health check dependency failure or maintenance mode |

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

### 1. Health & Operations
---

### 1. Health, Operations & Metrics

#### `GET /`
- **Access**: `@Public()`
- **Purpose**: Root service status check.
- **Response**: `200 OK`
  ```json
  { "status": "ok", "message": "Allinone Backend API is running" }
  ```

#### `GET /health`
- **Access**: `@Public()`
- **Purpose**: Overall application health check.
- **Response**: `200 OK` (Terminus shape)
- **Purpose**: Full application health check verifying database and cache subsystems.
- **Response**: `200 OK` (or `503 Service Unavailable`) — Terminus JSON format:
  ```json
  {
    "status": "ok",
    "info": { "database": { "status": "up" }, "redis": { "status": "up" } },
    "info": {
      "database": { "status": "up", "latency": 4 },
      "redis": { "status": "up" }
    },
    "error": {},
    "details": { "database": { "status": "up" }, "redis": { "status": "up" } }
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
- **Purpose**: Readiness probe (verifies database & services ready).
- **Purpose**: Kubernetes readiness probe (verifies database readiness before routing traffic).
- **Response**: `200 OK` (Terminus shape)

#### `GET /metrics`
- **Access**: `@Public()`
- **Purpose**: Prometheus scrape endpoint (`text/plain; version=0.0.4`).
- **Purpose**: Prometheus scrape endpoint exposing real-time operational metrics.
- **Response**: `200 OK` (`text/plain; version=0.0.4`)

#### `GET /info`
- **Access**: `@Public()`
- **Purpose**: Build & environment metadata.
- **Purpose**: Application build and version metadata.
- **Response**: `200 OK`
  ```json
  {
    "name": "allinone-backend",
    "version": "0.1.0",
    "environment": "development",
    "environment": "production",
    "commit": "HEAD"
  }
  ```

---

### 2. Authentication & Session Management (`/auth`)

#### `POST /auth/register`
- **Access**: `@Public()`
- **Rate Limit**: 3 per hour per IP (`limit: 3, ttl: 3600000`)
- **Body**: `CreateUserDto` (`email`, `password`, `displayName`, `locale?`, `timezone?`)
- **Response**: `201 Created` — User profile object + email verification token sent.
- **Rate Limit**: 3 per hour per IP
- **Body**:
  ```json
  {
    "email": "user@example.com",
    "password": "SecurePassword123!",
    "displayName": "Alex Mercer",
    "locale": "en",
    "timezone": "UTC"
  }
  ```
- **Response**: `201 Created`
  ```json
  {
    "user": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "email": "user@example.com",
      "displayName": "Alex Mercer",
      "isEmailVerified": false,
      "mfaEnabled": false
    },
    "tokens": {
      "accessToken": "eyJhbG...",
      "refreshToken": "eyJhbG...",
      "expiresIn": 900
    }
  }
  ```

#### `POST /auth/login`
- **Access**: `@Public()`
- **Rate Limit**: 5 per minute
- **Body**: `LoginDto` (`email`, `password`, `deviceId?`, `deviceName?`, `platform?`)
- **Response**: `200 OK` — Returns access/refresh tokens in body AND sets `httpOnly; Secure; SameSite=Strict` cookie `refresh_token` scoped to `/auth/refresh`.
- **Rate Limit**: 5 per minute per IP
- **Body**:
  ```json
  {
    "email": "user@example.com",
    "password": "SecurePassword123!",
    "deviceId": "device-uuid-optional",
    "deviceName": "MacBook Pro",
    "platform": "MACOS"
  }
  ```
- **Response**: `200 OK`
  - When MFA is disabled: Returns `user` and `tokens` object; sets `httpOnly; Secure; SameSite=Strict` cookie `refresh_token` scoped to `/auth/refresh`.
  - When MFA is disabled: Returns `user` and `tokens` object; sets `httpOnly; Secure; SameSite=Strict` cookie `refresh_token` scoped to `/auth/refresh`. Resets failed login attempts counter.
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
- **Input**: Token passed via body `refreshToken` OR `refresh_token` httpOnly cookie.
- **Response**: `200 OK` — Rotates access and refresh tokens.
- **Rate Limit**: 10 per minute per IP
- **Body**: `{ "refreshToken": "<TOKEN>" }` *(Optional if `refresh_token` cookie is present)*
- **Response**: `200 OK` — Returns rotated access and refresh tokens; rotates `refresh_token` cookie.

#### `POST /auth/logout`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` `{"success": true}` — sets `revokedAt` on the session the calling token names and clears the `refresh_token` cookie. From the next request on, that token fails with `401 SESSION_REVOKED`.

#### `POST /auth/verify-email/request`
- **Access**: `@Public()`
- **Rate Limit**: 3 per minute
- **Body**: `{ "email": "user@example.com" }`
- **Response**: `200 OK` `{"message": "Verification email sent if account exists"}`

#### `POST /auth/verify-email/confirm`
- **Access**: `@Public()`
- **Rate Limit**: 5 per minute
- **Body**: `{ "token": "<HEX_TOKEN>" }`
- **Response**: `200 OK` `{"message": "Email address verified successfully"}`

#### `POST /auth/forgot-password`
- **Access**: `@Public()`
- **Rate Limit**: 3 per minute
- **Body**: `{ "email": "user@example.com" }`
- **Response**: `200 OK` `{"message": "Password reset instructions dispatched"}`

#### `POST /auth/reset-password`
- **Access**: `@Public()`
- **Rate Limit**: 5 per minute
- **Body**: `{ "token": "<RESET_TOKEN>", "newPassword": "NewSecurePassword123!" }`
- **Response**: `200 OK` `{"message": "Password reset successfully"}`

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
    "recoveryCodes": [
      "A1B2-C3D4",
      "E5F6-G7H8"
    ]
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
  *(Supply either `totpCode` or single-use `recoveryCode`)*
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

### 3. Users & Devices (`/users`, `/devices`)
### 3. Users & Sessions (`/users`)

#### `GET /users/me`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — User profile, active MFA flags, and session meta.
- **Response**: `200 OK`
  ```json
  {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "email": "user@example.com",
    "displayName": "Alex Mercer",
    "avatarUrl": "https://...",
    "locale": "en",
    "timezone": "UTC",
    "isEmailVerified": true,
    "mfaEnabled": true,
    "role": "USER",
    "createdAt": "2026-09-01T10:00:00.000Z"
  }
  ```

#### `PATCH /users/me`
- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "displayName": "Alex Mercer",
    "avatarUrl": "https://cdn.example.com/avatar.png",
    "locale": "en",
    "timezone": "America/New_York"
  }
  ```
- **Response**: `200 OK` — Sanitized updated user profile.

#### `POST /users/me/export`
- **Access**: `JwtAuthGuard`
- **Response**: `202 Accepted` — Queues GDPR data export job.
- **Purpose**: Enqueues asynchronous GDPR/CCPA data export worker job.
- **Response**: `202 Accepted` `{"message": "Data export initiated"}`

#### `DELETE /users/me`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Soft deletes user account (`status = DELETED`), revokes sessions & devices.
- **Purpose**: Soft deletes account (`status = DELETED`), revokes all active sessions, and unlinks devices.
- **Response**: `200 OK` `{"message": "Account successfully scheduled for deletion"}`

#### `GET /users/me/sessions`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — List of active sessions with IP, user agent, and last active timestamps.

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
(`Note`, `Task`, `Event`) *and* appends a `Change` — while `/sync/push` appends a
`Change` and **never touches the entity table**. Nothing anywhere replays `Change`
rows back into `Note`, so the two stores are disjoint: a note pushed through sync
has no `Note` row, and a note created by `POST /notes` reaches a device only
because the same request logged it. What *is* true of both: `appendChange`
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
  cached response is looked up by `(userId, key)` and returned *before* the handler
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
  - `tagId` (UUID, singular) — Filter by one tag. `tagIds` is the *create/update*
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
    "nextRecurringTask": { "id": "tsk-2", "dueDate": "2026-09-22T18:00:00.000Z" }
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
  *(Status: `ACCEPTED`, `DECLINED`, `TENTATIVE`, `NEEDS_ACTION`)* — there is no
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
- **Notes**: `masterKeyHash` is `base64(SHA-256(argon2id(password, salt)))` — the verifier, not the key. What the row *stores* is `hmac-sha256:<base64>` of that value, keyed with the server-only `ENCRYPTION_KEY`, so a read of the collection does not hand over the unlock credential; rows written before that conversion keep the raw value and are rewritten on their next successful unlock. `kdfIterations` / `kdfMemory` are what the client derived with — the shipped build uses Argon2id `t=3, m=65536 KiB, p=4` and reports the first two; a request that omits them stores those same values. **Nothing reads them back**: the copy a build can trust is the `_kdf` marker sealed inside every entry blob, so sending different numbers here changes a record, not a behaviour (see `SECURITY.md`). A time cost below `t=1` is rejected as a validation error — the floor used to be `1000`, which would have refused the only honest value. Setup against an already-configured vault returns `409 VAULT_ALREADY_CONFIGURED`; rotate the master password through the recovery flow instead.

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
> **Admin Authorization Requirements**:
> All routes under `/admin` are guarded by `JwtAuthGuard` AND `AdminGuard`. An operator must satisfy at least one of the following criteria:
> 1. Possess a valid Bearer token for an account with `role: "ADMIN"` or an email listed in `ADMIN_EMAILS`.
> 2. Supply the authorized master secret in the `x-admin-secret` HTTP header.
>
> All operations unconditionally record immutable entries to the `AuditLog` table for compliance and SIEM auditing.

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
  *(Status options: `ACTIVE`, `SUSPENDED`, `DELETED`)*
- **Response**: `200 OK` — Updated user record.

#### `GET /admin/users/:userId/overview`
- **Access**: `JwtAuthGuard` + `AdminGuard`
- **Purpose**: Consolidated security posture view for support and SecOps.
- **Response**: `200 OK`
  ```json
  {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "email": "user@example.com",
    "displayName": "Alex Mercer",
    "status": "ACTIVE",
    "isEmailVerified": true,
    "user": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "email": "user@example.com",
      "displayName": "Alex Mercer",
      "status": "ACTIVE",
      "failedLoginAttempts": 5,
      "lockedUntil": "2026-09-10T22:45:00.000Z",
      "isLocked": true,
      "createdAt": "2026-09-01T10:00:00.000Z"
    },
    "mfaEnabled": true,
    "activeSessionsCount": 2,
    "registeredDevicesCount": 3,
    "vaultConfigured": true,
    "createdAt": "2026-09-01T10:00:00.000Z"
    "activeDevicesCount": 3,
    "activeSessions": [...],
    "activeDevices": [...],
    "recentAuditLogs": [...]
  }
  ```

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

### 18. Multi-User Collaboration & Resource Sharing (`/collaboration`)

Role-based access control (`VIEWER`, `EDITOR`, `ADMIN`) enabling granular sharing of Notes, Projects, and Calendars between authenticated users.

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
  *(Roles: `VIEWER`, `EDITOR`, `ADMIN`. Resource types: `NOTE`, `PROJECT`, `CALENDAR`)*
- **Response**: `201 Created`
  ```json
  {
    "id": "share-7e3f8901-abcd",
    "resourceType": "NOTE",
    "resourceId": "c7b3d8e0-5e8a-4b9c-8a1d-2e3f4a5b6c7d",
    "ownerId": "123e4567-e89b-12d3-a456-426614174000",
    "granteeEmail": "collaborator@example.com",
    "granteeId": "user-uuid-999",
    "role": "EDITOR",
    "createdAt": "2026-09-11T00:00:00.000Z",
    "updatedAt": "2026-09-11T00:00:00.000Z"
  }
  ```

#### `GET /collaboration/shares/:resourceType/:resourceId`
- **Access**: `JwtAuthGuard`
- **Purpose**: List all active collaborators and their assigned roles for a given resource. Only the owner or an admin collaborator can view shares.
- **Response**: `200 OK` — Array of `ResourceShare` objects.

#### `PATCH /collaboration/shares/:shareId`
- **Access**: `JwtAuthGuard`
- **Purpose**: Update an existing collaborator's access role (e.g. promote from `VIEWER` to `EDITOR`).
- **Body**:
  ```json
  {
    "role": "VIEWER"
  }
  ```
- **Response**: `200 OK` — Updated `ResourceShare` object.

#### `DELETE /collaboration/shares/:shareId`
- **Access**: `JwtAuthGuard`
- **Purpose**: Revoke a collaborator's access to a shared resource.
- **Response**: `204 No Content`

#### `GET /collaboration/shared-with-me`
- **Access**: `JwtAuthGuard`
- **Purpose**: List all resources shared with the authenticated user, filterable by resource type with cursor pagination.
- **Query Parameters**:
  - `resourceType` *(optional)*: `NOTE`, `PROJECT`, `CALENDAR`
  - `limit` *(optional, default 50, max 100)*: integer
  - `offset` *(optional, default 0)*: integer
- **Response**: `200 OK`
  ```json
  {
    "data": [
      {
        "id": "share-7e3f8901-abcd",
        "resourceType": "NOTE",
        "resourceId": "c7b3d8e0-5e8a-4b9c-8a1d-2e3f4a5b6c7d",
        "ownerId": "owner-user-uuid",
        "granteeEmail": "collaborator@example.com",
        "role": "VIEWER",
        "createdAt": "2026-09-11T00:00:00.000Z"
      }
    ],
    "total": 1,
    "limit": 50,
    "offset": 0
  }
  ```

---

### 19. AI & Semantic Capabilities (`/ai`)

Natural language document intelligence powered by Google Gemini with deterministic heuristic NLP fallback for air-gapped or offline operation.

#### `POST /ai/summarize`
- **Access**: `JwtAuthGuard`
- **Purpose**: Generate an intelligent summary of raw text or an existing note.
- **Body**:
  ```json
  {
    "noteId": "c7b3d8e0-5e8a-4b9c-8a1d-2e3f4a5b6c7d",
    "text": "Optional raw text if noteId is not provided",
    "length": "brief",
    "format": "paragraph"
  }
  ```
  *(Lengths: `brief`, `standard`, `detailed`. Formats: `paragraph`, `bullet_points`)*
- **Response**: `200 OK`
  ```json
  {
    "summary": "This document outlines the distributed sync protocol and database replication architecture.",
    "originalLength": 4500,
    "summaryLength": 102,
    "compressionRatio": 0.02,
    "format": "paragraph",
    "provider": "gemini"
  }
  ```

#### `POST /ai/extract-tasks`
- **Access**: `JwtAuthGuard`
- **Purpose**: Parse meeting notes or raw text into actionable tasks with automated priority scoring (`HIGH`, `MEDIUM`, `LOW`).
- **Body**:
  ```json
  {
    "text": "TODO: Deploy Redis cluster ASAP\n- [ ] Write integration documentation"
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "tasks": [
      {
        "title": "Deploy Redis cluster ASAP",
        "priority": "HIGH"
      },
      {
        "title": "Write integration documentation",
        "priority": "MEDIUM"
      }
    ],
    "totalFound": 2,
    "provider": "heuristic"
  }
  ```

#### `POST /ai/suggest-tags`
- **Access**: `JwtAuthGuard`
- **Purpose**: Recommend semantic tags and topical categories (Security, Infrastructure, Productivity, General) based on word frequency and lexical analysis.
- **Body**:
  ```json
  {
    "text": "OAuth2 PKCE flow with Redis token blacklist cache"
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "tags": ["oauth2", "pkce", "redis", "token", "blacklist"],
    "suggestedCategories": ["Security", "Infrastructure"],
    "provider": "heuristic"
  }
  ```

#### `POST /ai/notes/:noteId/convert-tasks`
- **Access**: `JwtAuthGuard`
- **Purpose**: Converts a list of extracted action items into persistent `Task` database entities with audit `Change` sync entries within an atomic transaction.
- **Body**:
  ```json
  {
    "tasks": [
      {
        "title": "Deploy Redis cluster ASAP",
        "description": "Extracted from note Sprint Planning",
        "priority": "HIGH"
      }
    ]
  }
  ```
- **Response**: `201 Created`
  ```json
  {
    "createdCount": 1,
    "tasks": [
      {
        "id": "task-uuid-8888",
        "userId": "123e4567-e89b-12d3-a456-426614174000",
        "title": "Deploy Redis cluster ASAP",
        "priority": "P1_URGENT"
      }
    ]
  }
  ```

---

### 20. FIDO2 / WebAuthn Passkeys (`/auth/passkeys`)

Passkey *registration* only. Passwordless login is not offered.

> [!WARNING]
> **`POST /auth/passkeys/login-options` and `POST /auth/passkeys/login-verify` are removed and return `404`.** They were not a weak second factor, they were a working authentication bypass: `verifyLogin` decoded `clientDataJSON`, required `type === "webauthn.get"`, required the `challenge` to be one it had issued, looked the credential up by the `id` in the request, and then minted an access/refresh pair and a `Session`. `dto.signature` was declared in `LoginVerifyDto` and read by nothing, so any request shaped like an assertion signed in as any account holding a `PASSKEY` row — no authenticator involved.
>
> Being public was never the bug: an endpoint that *establishes* a session cannot be gated on one, and both routes stay public in the replacement. Two things are required before passkey login comes back, and neither is a reason to leave the broken pair up:
>
> 1. **Real verification**, from a relying-party library (`@simplewebauthn/server` is the usual choice here — none is installed): assertion signature, origin/rpId, and challenge lifecycle. The existing single-use challenge map and its expiry sweep were already correct and can be reused as they are. One open decision at that point: `login-options` answering a posted email with that account's `allowCredentials` is standard WebAuthn shape, but it also confirms the address has a passkey, so choose between that and a constant-shape answer.
> 2. **Re-enrolment, not upgrade in place.** `verifyRegistration` stores the raw `attestationObject` as `publicKey` without parsing the CBOR, so no registered row holds a usable credential key — the data needed was never captured. Treat every existing `AuthType.PASSKEY` row as invalid when the library lands (wipe them and prompt re-registration, or version the rows and reject pre-migration ones at verify time). Do not attempt to parse them retroactively.
>
> **The Flutter client does not drive these endpoints and never did.** `PasskeyService` fabricated the assertion a hardware authenticator is supposed to produce, so every press of its "SIGN IN WITH PASSKEY" button was a refusal wearing the clothes of a sign-in method; the button and the service are removed. A passkey sign-in needs a client that performs the real ceremony *and* a server that verifies it.

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
- **Purpose**: Check that the client's credential-creation response carries the challenge this service issued for this user, and persist the credential under `Authentication` (`AuthType.PASSKEY`). It is *not* an attestation verification: the `attestationObject` is stored verbatim as `passwordHash`'s `publicKey` field, with no CBOR parse — which is why the login half cannot be fixed without re-enrolling (see the warning above). No `Device` row is created here.
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

- **Connection URL**: `wss://<DOMAIN>/sync`
- **Handshake Authentication**: `auth: { token: "<JWT_ACCESS_TOKEN>" }`
- **Server Room Join**: Subscribes socket client to `user:<userId>` room.
- **Transports Supported**: `websocket`, `polling` (fallback)
- **Handshake Authentication**:
  Tokens can be provided via any of the following mechanisms during handshake:
  1. `client.handshake.auth.token`
  2. `client.handshake.headers.authorization` (`Bearer <TOKEN>`)
  3. `client.handshake.query.token`

### Room Model & Multi-Instance Clustering

Upon successful authentication, the WebSocket server extracts `userId` and `deviceId` from the token and joins the client to the room:

```
user:<userId>
```

> [!IMPORTANT]
> **Cross-Instance Invalidation**:
> With horizontal scaling enabled behind a load balancer, instances use the Redis Socket.IO adapter (`@socket.io/redis-adapter`). Invalidation events emitted to `user:<userId>` automatically propagate across the Redis Pub/Sub backplane to all API instances in the cluster.

### Server-to-Client Events

#### Event: `sync:invalidation`
Emitted immediately whenever a data mutation occurs (e.g. after a successful `/sync/push` or direct entity update). Notifies other active devices of the user to trigger an incremental delta pull.

```json
{
  "userId": "123e4567-e89b-12d3-a456-426614174000",
  "originDeviceId": "dev-123e4567-e89b-12d3-a456-426614174000",
  "highestCursor": "142857",
  "timestamp": "2026-09-10T16:00:00.000Z"
}
```

- **Client Action on Receipt**: The receiving client inspects `highestCursor`. If greater than its local sync cursor, it issues an asynchronous `POST /sync/pull` with its current cursor to fetch new changes.
- **Origin Device Suppression**: The origin device that executed the push already possesses the local changes, so it ignores the notification.

---

## 🧪 Documentation Verification & Parity

All endpoints, DTO contracts, authentication guards, and event schemas defined in this document directly match:
- NestJS Controllers in `src/**/*.controller.ts`
- WebSocket Gateway in `src/sync/sync.gateway.ts`
- Prisma Schema in `prisma/schema.prisma`
- Class-Validator DTOs in `src/**/dto/*.dto.ts`
- Security and Error Filters in `src/common/`
