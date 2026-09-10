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
| `Authorization` | String | Yes (Protected) | `Bearer <JWT_ACCESS_TOKEN>` |
| `Authorization` | String | Yes (Protected routes) | `Bearer <JWT_ACCESS_TOKEN>` |
| `Content-Type` | String | Yes (POST/PUT/PATCH) | `application/json` |
| `Idempotency-Key` | UUID | Optional | Guarantees exact once execution for state-changing POST requests (24h TTL cache) |
| `X-Request-ID` | UUID | Optional (Client) / Guaranteed (Server) | Optional client-supplied correlation ID. If omitted by the client, the server **unconditionally auto-generates a UUIDv4** server-side, echoes it in the `X-Request-ID` response header, and guarantees it is always populated in error response envelopes. |
| `Idempotency-Key` | UUID | Optional | Guarantees exact-once execution for state-changing POST requests (24h TTL cache in Redis + PostgreSQL durability) |
| `X-Request-ID` | UUID | Optional (Client) / Guaranteed (Server) | Correlation ID. If omitted by the client, the server **unconditionally auto-generates a UUIDv4**, echoes it in the `X-Request-ID` response header, and attaches it to error envelopes and audit logs. |
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
  - When MFA is enabled: Returns `{ "mfaRequired": true, "tempToken": "<TICKET_JWT>" }`.

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
- **Response**: `200 OK` — Revokes active session and clears `refresh_token` cookie.
- **Response**: `200 OK` — Revokes active database session and clears `refresh_token` cookie.

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

### 4. Realtime & Delta Synchronization (`/sync`)
### 5. Realtime & Delta Synchronization (`/sync`)

#### `POST /sync/push`
- **Access**: `JwtAuthGuard`
- **Body**: `PushSyncDto` (`deviceId`, `changes: [{ entityType, entityId, operation, version, payload }]`)
- **Headers**: `Idempotency-Key` (recommended)
- **Body**:
  ```json
  {
    "deviceId": "dev-123e4567-e89b-12d3-a456-426614174000",
    "changes": [
      {
        "entityType": "note",
        "entityId": "not-123e4567-e89b-12d3-a456-426614174000",
        "operation": "UPDATE",
        "version": 4,
        "payload": {
          "title": "Meeting Notes Updated",
          "content": "Updated content..."
        }
      }
    ]
  }
  ```
- **Response**: `201 Created`
  ```json
  {
    "success": true,
    "accepted": ["not-123e4567-e89b-12d3-a456-426614174000"],
    "conflicts": [],
    "newCursor": "142857"
  }
  ```

#### `POST /sync/pull`
- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "deviceId": "dev-123e4567-e89b-12d3-a456-426614174000",
    "cursor": "142800",
    "limit": 100
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "accepted": ["change-id-1"],
    "conflicts": [
    "changes": [
      {
        "entityId": "123e4567-e89b-12d3-a456-426614174000",
        "id": "chg-987",
        "entityType": "note",
        "reason": "VERSION_MISMATCH",
        "clientVersion": 5,
        "serverVersion": 7,
        "serverPayload": { "title": "...", "content": "..." }
        "entityId": "not-123",
        "operation": "UPDATE",
        "version": 4,
        "payload": { "title": "Meeting Notes Updated" },
        "cursor": "142857",
        "timestamp": "2026-09-10T16:00:00.000Z"
      }
    ],
    "newCursor": "105"
    "hasMore": false,
    "latestCursor": "142857"
  }
  ```

#### `POST /sync/pull`
#### `GET /sync/status`
- **Access**: `JwtAuthGuard`
- **Body**: `PullSyncDto` (`deviceId`, `cursor?`, `limit?`)
- **Response**: `200 OK` — Array of changes scoped strictly to `userId`.
- **Query**: `?deviceId=<UUID>`
- **Response**: `200 OK`
  ```json
  {
    "latestCursor": "142857",
    "deviceLastCursor": "142800",
    "pendingChanges": 57
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
    "isPinned": true,
    "isEncrypted": false
  }
  ```
- **Response**: `201 Created` — Created note object with version `1`.

#### `GET /notes`
- **Access**: `JwtAuthGuard`
- **Query Parameters**:
  - `folderId` (UUID) — Filter by parent folder
  - `tagIds` (UUID[]) — Filter by tags
  - `isPinned` (Boolean) — Filter pinned notes
  - `isArchived` (Boolean) — Filter archived notes (default: `false`)
  - `search` (String) — Full-text query on title and content
  - `page` (Integer) & `limit` (Integer) — Pagination
- **Response**: `200 OK` — Paginated list of notes.

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
    "isArchived": false,
    "version": 1
  }
  ```
- **Response**: `200 OK` — Increments version and creates version snapshot.

#### `DELETE /notes/:id`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` `{"message": "Note deleted successfully"}`

#### `GET /notes/:id/history`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Array of version snapshots (`version`, `title`, `contentSnapshot`, `createdAt`).

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
    "priority": "P1_URGENT",
    "dueDate": "2026-09-15T18:00:00.000Z",
    "rrule": "FREQ=WEEKLY;BYDAY=MO",
    "projectId": "prj-123e4567-e89b-12d3-a456-426614174000",
    "sectionId": "sec-123e4567-e89b-12d3-a456-426614174001",
    "parentId": null,
    "tagIds": ["tag-123e4567-e89b-12d3-a456-426614174002"]
  }
  ```
- **Response**: `201 Created`

#### `GET /tasks`
- **Access**: `JwtAuthGuard`
- **Query Parameters**:
  - `status` (`TODO`, `IN_PROGRESS`, `DONE`, `CANCELLED`)
  - `priority` (`P0_CRITICAL`, `P1_URGENT`, `P2_NORMAL`, `P3_LOW`)
  - `projectId`, `sectionId`, `parentId` (UUID)
  - `dueBefore`, `dueAfter` (ISO Timestamp)
  - `search` (String)
  - `page`, `limit` (Integer)
- **Response**: `200 OK` — Paginated tasks list.

#### `GET /tasks/:id`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Task details with subtasks, labels, and scheduled reminders.

#### `PATCH /tasks/:id`
- **Access**: `JwtAuthGuard`
- **Body**: `{ "status": "IN_PROGRESS", "priority": "P0_CRITICAL" }`
- **Response**: `200 OK` — Updated task.

#### `POST /tasks/:id/complete`
- **Access**: `JwtAuthGuard`
- **Purpose**: Marks task `status = DONE`. If an `rrule` recurrence string is configured, automatically calculates the next occurrence and creates the next task instance.
- **Response**: `200 OK`
  ```json
  {
    "completedTask": { "id": "tsk-1", "status": "DONE" },
    "nextRecurringTask": { "id": "tsk-2", "dueDate": "2026-09-22T18:00:00.000Z" }
  }
  ```

#### `DELETE /tasks/:id`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` `{"message": "Task deleted"}`

#### `POST /tasks/:id/reminders`
- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "remindAt": "2026-09-15T17:30:00.000Z",
    "type": "PUSH_NOTIFICATION"
  }
  ```
- **Response**: `201 Created`

#### `GET /tasks/:id/reminders`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — List of scheduled reminders for the task.

#### `DELETE /tasks/reminders/:reminderId`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` `{"message": "Reminder deleted"}`

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
    "timezone": "America/New_York"
  }
  ```
- **Response**: `201 Created`

#### `GET /calendars`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — List of calendars.

#### `GET /calendars/:id`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK`

#### `PATCH /calendars/:id`
- **Access**: `JwtAuthGuard`
- **Body**: `{ "name": "Family & Personal", "color": "#7C3AED" }`
- **Response**: `200 OK`

#### `DELETE /calendars/:id`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` `{"message": "Calendar deleted"}`

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
    "rrule": "FREQ=WEEKLY;BYDAY=TH",
    "attendees": [
      { "email": "colleague@example.com", "displayName": "Dana Scully" }
    ]
  }
  ```
- **Response**: `201 Created`

#### `GET /events`
- **Access**: `JwtAuthGuard`
- **Query Parameters**:
  - `startAt` (ISO Date, required) — Range start
  - `endAt` (ISO Date, required) — Range end
  - `calendarId` (UUID, optional)
- **Response**: `200 OK` — Events falling within the designated window.

#### `GET /events/:id`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Event details including attendees and reminders.

#### `PATCH /events/:id`
- **Access**: `JwtAuthGuard`
- **Body**: `{ "location": "Room 402", "startAt": "...", "endAt": "..." }`
- **Response**: `200 OK`

#### `PATCH /events/:id/rsvp`
- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "email": "user@example.com",
    "status": "ACCEPTED"
  }
  ```
  *(Status: `ACCEPTED`, `DECLINED`, `TENTATIVE`, `PENDING`)*
- **Response**: `200 OK` `{"message": "RSVP updated"}`

#### `POST /events/:id/reminders`
- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "minutesBefore": 15,
    "method": "POPUP"
  }
  ```
- **Response**: `201 Created`

#### `DELETE /events/:id`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` `{"message": "Event deleted"}`

---

### 9. Zero-Knowledge Vault (`/vault/settings`, `/vault/items`)

> [!IMPORTANT]
> **Zero-Knowledge Security Architecture**:
> Vault items are encrypted entirely on the client before network transmission using AES-256-GCM. The server stores only the opaque Base64 `encryptedData`, `iv`, and `authTag`. The server **never** receives the master password or raw decryption keys.

#### `POST /vault/settings/setup`
- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "salt": "a8fbc712e...",
    "kdfIterations": 600000,
    "kdfAlgorithm": "PBKDF2-SHA256",
    "authHash": "argon2id$v=19$m=65536,t=3,p=4$..."
  }
  ```
- **Response**: `201 Created` — Saved zero-knowledge master configuration parameters.

#### `GET /vault/settings`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK`
  ```json
  {
    "salt": "a8fbc712e...",
    "kdfIterations": 600000,
    "kdfAlgorithm": "PBKDF2-SHA256",
    "isConfigured": true
  }
  ```

#### `POST /vault/settings/unlock`
- **Access**: `JwtAuthGuard`
- **Body**: `{ "authHash": "..." }`
- **Purpose**: Verifies client authentication hash against server record prior to local client-side decryption.
- **Response**: `200 OK` `{"unlocked": true}`

#### `POST /vault/items`
- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "type": "LOGIN",
    "name": "AWS Production Console",
    "category": "Cloud Infrastructure",
    "encryptedData": "eyHVzZXJuYW1lIjogImFkbWluIiwgInBhc3N3b3JkIjogInNlY3JldCJ9...",
    "iv": "ZEZtWjlKVE5hY3ZzT2FnYg==",
    "authTag": "b0RVMU56ZzBOVFEwTlRBMg==",
    "isFavorite": true
  }
  ```
  *(Item types: `LOGIN`, `SECURE_NOTE`, `CREDIT_CARD`, `IDENTITY`, `API_KEY`)*
- **Response**: `201 Created`

#### `GET /vault/items`
- **Access**: `JwtAuthGuard`
- **Query Parameters**:
  - `type` (`LOGIN`, `SECURE_NOTE`, etc.)
  - `category` (String)
  - `isFavorite` (Boolean)
  - `search` (String — searches plaintext `name` and `category`)
  - `page`, `limit` (Integer)
- **Response**: `200 OK` — Paginated list of encrypted vault records.

#### `GET /vault/items/:id`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Complete encrypted item payload with `iv` and `authTag`.

#### `PATCH /vault/items/:id`
- **Access**: `JwtAuthGuard`
- **Body**:
  ```json
  {
    "name": "AWS Production Console (Root)",
    "encryptedData": "newEncryptedBase64...",
    "iv": "newIV...",
    "authTag": "newAuthTag...",
    "isFavorite": true
  }
  ```
- **Response**: `200 OK`

#### `DELETE /vault/items/:id`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` `{"message": "Vault item deleted"}`

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
  - `resource` (String, e.g. `User`, `Session`, `VaultItem`)
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
    "mfaEnabled": true,
    "activeSessionsCount": 2,
    "registeredDevicesCount": 3,
    "vaultConfigured": true,
    "createdAt": "2026-09-01T10:00:00.000Z"
  }
  ```

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
