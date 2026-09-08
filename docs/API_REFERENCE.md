# Allinone Backend — End-to-End API Reference

This document provides a comprehensive specification of all HTTP REST endpoints, WebSocket event handlers, request/response DTOs, authentication requirements, rate limits, error schemas, and cross-cutting headers.

---

## 🔐 Authentication & Global Headers

All API endpoints (except `@Public()` routes) require HTTP Bearer Token authentication via the `Authorization` header:

```http
Authorization: Bearer <JWT_ACCESS_TOKEN>
```

### Key Request Headers

| Header Name | Type | Required | Description |
|-------------|------|----------|-------------|
| `Authorization` | String | Yes (Protected) | `Bearer <JWT_ACCESS_TOKEN>` |
| `Content-Type` | String | Yes (POST/PUT/PATCH) | `application/json` |
| `Idempotency-Key` | UUID | Optional | Guarantees exact once execution for state-changing POST requests (24h TTL cache) |
| `X-Request-ID` | UUID | Optional (Client) / Guaranteed (Server) | Optional client-supplied correlation ID. If omitted by the client, the server **unconditionally auto-generates a UUIDv4** server-side, echoes it in the `X-Request-ID` response header, and guarantees it is always populated in error response envelopes. |

---

## 🛑 Global Error Response Format

All error responses return standard HTTP status codes and a consistent JSON payload:

```json
{
  "statusCode": 400,
  "code": "VALIDATION_ERROR",
  "message": ["email must be an email", "password must be at least 8 characters"],
  "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-09-07T14:00:00.000Z",
  "path": "/auth/register"
}
```

### Standard Error Codes

- `VALIDATION_ERROR` (400)
- `UNAUTHORIZED` (401)
- `FORBIDDEN` (403)
- `NOT_FOUND` (404)
- `CONFLICT` (409)
- `RATE_LIMITED` (429)
- `INTERNAL_ERROR` (500)

---

## ⚡ REST Endpoints Specification

### 1. Health & Operations

#### `GET /health`
- **Access**: `@Public()`
- **Purpose**: Overall application health check.
- **Response**: `200 OK` (Terminus shape)
  ```json
  {
    "status": "ok",
    "info": { "database": { "status": "up" }, "redis": { "status": "up" } },
    "error": {},
    "details": { "database": { "status": "up" }, "redis": { "status": "up" } }
  }
  ```

#### `GET /health/live`
- **Access**: `@Public()`
- **Purpose**: Liveness probe (process status check without DB queries).
- **Response**: `200 OK` `{"status":"ok"}`

#### `GET /health/ready`
- **Access**: `@Public()`
- **Purpose**: Readiness probe (verifies database & services ready).
- **Response**: `200 OK` (Terminus shape)

#### `GET /metrics`
- **Access**: `@Public()`
- **Purpose**: Prometheus scrape endpoint (`text/plain; version=0.0.4`).

#### `GET /info`
- **Access**: `@Public()`
- **Purpose**: Build & environment metadata.
- **Response**: `200 OK`
  ```json
  {
    "name": "allinone-backend",
    "version": "0.1.0",
    "environment": "development",
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

#### `POST /auth/login`
- **Access**: `@Public()`
- **Rate Limit**: 5 per minute
- **Body**: `LoginDto` (`email`, `password`, `deviceId?`, `deviceName?`, `platform?`)
- **Response**: `200 OK` — Returns access/refresh tokens in body AND sets `httpOnly; Secure; SameSite=Strict` cookie `refresh_token` scoped to `/auth/refresh`.

#### `POST /auth/refresh`
- **Access**: `@Public()`
- **Rate Limit**: 10 per minute
- **Input**: Token passed via body `refreshToken` OR `refresh_token` httpOnly cookie.
- **Response**: `200 OK` — Rotates access and refresh tokens.

#### `POST /auth/logout`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Revokes active session and clears `refresh_token` cookie.

---

### 3. Users & Devices (`/users`, `/devices`)

#### `GET /users/me`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — User profile, active MFA flags, and session meta.

#### `POST /users/me/export`
- **Access**: `JwtAuthGuard`
- **Response**: `202 Accepted` — Queues GDPR data export job.

#### `DELETE /users/me`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — Soft deletes user account (`status = DELETED`), revokes sessions & devices.

#### `GET /devices`
- **Access**: `JwtAuthGuard`
- **Response**: `200 OK` — List of registered user devices.

---

### 4. Realtime & Delta Synchronization (`/sync`)

#### `POST /sync/push`
- **Access**: `JwtAuthGuard`
- **Body**: `PushSyncDto` (`deviceId`, `changes: [{ entityType, entityId, operation, version, payload }]`)
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "accepted": ["change-id-1"],
    "conflicts": [
      {
        "entityId": "123e4567-e89b-12d3-a456-426614174000",
        "entityType": "note",
        "reason": "VERSION_MISMATCH",
        "clientVersion": 5,
        "serverVersion": 7,
        "serverPayload": { "title": "...", "content": "..." }
      }
    ],
    "newCursor": "105"
  }
  ```

#### `POST /sync/pull`
- **Access**: `JwtAuthGuard`
- **Body**: `PullSyncDto` (`deviceId`, `cursor?`, `limit?`)
- **Response**: `200 OK` — Array of changes scoped strictly to `userId`.

---

## 📡 WebSockets Specification (`/sync` Namespace)

- **Connection URL**: `wss://<DOMAIN>/sync`
- **Handshake Authentication**: `auth: { token: "<JWT_ACCESS_TOKEN>" }`
- **Server Room Join**: Subscribes socket client to `user:<userId>` room.
