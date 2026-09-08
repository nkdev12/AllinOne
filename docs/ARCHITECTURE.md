# Allinone Backend — Architecture

This document describes the architecture of the Allinone backend system.

## System Overview

Allinone is a **modular monolith** — a single deployable application with clear module boundaries that can be independently scaled or extracted into microservices if needed.

```
┌─────────────────────────────────────────────────┐
│         Client Applications                      │
│  (Web, iOS, Android, macOS, Windows, Linux)     │
└────────────────────┬────────────────────────────┘
                     │
                     │ HTTP/REST
                     │ WebSocket
                     ▼
┌─────────────────────────────────────────────────┐
│     Allinone Backend (NestJS)                   │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │ API Layer                                   │ │
│  │ ├── Controllers (HTTP endpoints)            │ │
│  │ ├── Guards (Authorization)                  │ │
│  │ ├── Filters (Exception handling)            │ │
│  │ └── Middleware (Logging, CORS)              │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │ Feature & Core Modules                      │ │
│  │ ├── Authentication (AuthModule)             │ │
│  │ ├── Users (UsersModule)                     │ │
│  │ ├── Devices (DevicesModule)                 │ │
│  │ ├── Notes & Tags (NotesModule)              │ │
│  │ ├── Tasks & Projects (TasksModule)          │ │
│  │ ├── Calendar & Events (CalendarModule)      │ │
│  │ ├── Vault / Password Manager (VaultModule)  │ │
│  │ ├── Sync Engine (SyncModule)                │ │
│  │ └── System Health & Probes (HealthModule)   │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │ Cross-cutting Services                      │ │
│  │ ├── Logging                                 │ │
│  │ ├── Configuration                           │ │
│  │ ├── Error Handling                          │ │
│  │ ├── Email                                   │ │
│  │ ├── Storage (S3/MinIO)                      │ │
│  │ ├── Encryption                              │ │
│  │ ├── Rate Limiting                           │ │
│  │ ├── Audit                                   │ │
│  │ └── Notifications                           │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │ Data Layer (Prisma ORM)                    │ │
│  │ ├── Repositories                            │ │
│  │ ├── Query builders                          │ │
│  │ └── Transactions                            │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │ Background Workers (BullMQ)                │ │
│  │ ├── Email delivery                          │ │
│  │ ├── Notifications                           │ │
│  │ ├── Sync jobs                               │ │
│  │ ├── Exports                                 │ │
│  │ └── Maintenance                             │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
└─────────────────────────────────────────────────┘
         │              │                │
         ▼              ▼                ▼
    ┌─────────┐   ┌──────────┐   ┌────────────┐
    │PostgreSQL│   │ Redis    │   │MinIO (S3)  │
    │ (Data)   │   │(Cache&Q) │   │(Storage)   │
    └─────────┘   └──────────┘   └────────────┘
```

## Module Structure

Each module follows a consistent pattern:

```
module/
├── module.ts           # NestJS module definition
├── controller.ts       # HTTP request handlers
├── service.ts          # Business logic
├── dto/                # Data Transfer Objects
│   ├── create-*.dto.ts
│   ├── update-*.dto.ts
│   └── *.dto.ts
├── entity/             # Database models
├── mapper.ts           # DTOs ↔ Entities conversion
├── policy/             # Authorization policies
├── guards/             # Route guards
├── tests/              # Unit & integration tests
│   ├── *.spec.ts
│   └── *.e2e.ts
└── README.md           # Module documentation
```

## Data Flow

### Read Flow

```
Client Request
     ↓
HTTP Controller
     ↓
Guard (Authorization)
     ↓
Service (Business Logic)
     ↓
Repository/Prisma (Query)
     ↓
PostgreSQL
     ↓
Response Mapper (Entity → DTO)
     ↓
HTTP Response
```

### Write Flow

```
Client Request
     ↓
DTO Validation
     ↓
Guard (Authorization)
     ↓
Service (Business Logic)
     ↓
Transaction Start
     ↓
Repository Mutations
     ↓
Transaction Commit
     ↓
Event Publishing (if applicable)
     ↓
Background Job Queuing (if applicable)
     ↓
Response
```

## Deployment Architecture

### Development

```
Docker Host
├── PostgreSQL (container)
├── Redis (container)
├── MinIO (container)
├── Mailpit (container)
├── Prometheus (container)
├── Grafana (container)
└── NestJS API (host process or container)
```

### Production

```
Load Balancer (external)
        ↓
Reverse Proxy (Caddy/Nginx)
        ↓
    ┌───┴───┐
    ▼       ▼
  API-1   API-2  (multiple instances)
    │       │
    └───┬───┘
        ▼
    PostgreSQL (primary)
    PostgreSQL (replica)
        ▼
    Redis (cluster)
        ▼
    MinIO (cluster/replication)
        ▼
    Backup Storage
```

## Database Schema Layers

### 1. Authentication & Users

```sql
User
├── id (UUID)
├── email (unique)
├── status (enum)
├── emailVerifiedAt
└── timestamps

Authentication (one per auth method)
├── userId (FK)
├── type (enum: EMAIL_PASSWORD, OAUTH, etc.)
├── identifier
└── passwordHash (if applicable)

Session
├── userId (FK)
├── deviceId (FK)
├── tokens (access & refresh)
├── expiration
└── revocation tracking

Device
├── userId (FK)
├── platform
├── lastSeen
└── publicKey

MFASetting
├── userId (FK)
├── totpSecret (encrypted)
└── recoveryCodes (encrypted)
```

### 2. Core Features (Notes, Tasks, Calendar)

```sql
Note
├── userId (FK)
├── folderId (FK)
├── content
├── version
├── deletedAt (soft delete)
└── timestamps

Task
├── userId (FK)
├── projectId (FK, nullable)
├── sectionId (FK, nullable)
├── parentId (FK, nullable subtask self-relation)
├── title
├── description
├── priority (enum: P1_URGENT, P2_HIGH, P3_MEDIUM, P4_LOW)
├── status (enum: TODO, IN_PROGRESS, COMPLETED, CANCELLED)
├── dueDate
├── dueTime
├── recurrenceRule
├── completedAt
└── timestamps
*Note: Task completion is derived strictly from `status === COMPLETED` (no redundant `isCompleted` column).*

Event
├── userId (FK)
├── calendarId (FK)
├── timeRange
├── timezone
└── timestamps
```

### 3. Synchronization

```sql
Change (event log)
├── userId (FK)
├── deviceId (FK)
├── entityType
├── entityId
├── operation (CREATE, UPDATE, DELETE, RESTORE)
├── version
├── cursor (auto-increment)
└── timestamp

DeviceSyncState
├── deviceId (FK)
├── lastPulledCursor
├── lastPushedSequence
└── lastSuccessfulSync

IdempotencyKey
├── key (unique)
├── userId (FK)
├── response (cached)
└── expiresAt
```

### 4. Observability & Auditing

```sql
AuditLog
├── id (UUID)
├── userId (FK, nullable for unauthenticated events)
├── action (enum: LOGIN_SUCCESS, LOGOUT, MFA_ENABLED, etc.)
├── resourceType (VARCHAR 50, optional)
├── resourceId (UUID, optional)
├── requestId (UUID, correlation ID)
├── changes (JSONB diff of mutated fields)
├── ipAddress (VARCHAR 45)
├── userAgent (TEXT)
├── metadata (JSONB request context & telemetry)
└── createdAt (timestamp)
```

> [!NOTE]
> **AuditLog Column Rationale**: `changes` and `metadata` are intentionally retained as separate columns. `changes` stores entity attribute mutations (before/after diffs), whereas `metadata` isolates request and actor context (IP location, client platform, authentication method, failure reason). This separation preserves clean SIEM audit queries without bloating entity mutation records.
>
> **Dynamic Health Probes**: Health monitoring does not use a persistent database table. Probes (`/health`, `/health/live`, `/health/ready`) are served dynamically in-memory by `HealthModule` via Terminus to verify live connectivity to PostgreSQL and Redis.
```

## Technology Decisions

### Why NestJS?

- ✅ TypeScript first-class support
- ✅ Dependency injection pattern
- ✅ Module system (clean architecture)
- ✅ Guards, Pipes, Interceptors (middleware)
- ✅ OpenAPI/Swagger integration
- ✅ Testing utilities (Jest integration)
- ✅ Production-ready defaults

### Why Prisma?

- ✅ Type-safe query builder
- ✅ Auto-generated TypeScript types
- ✅ Migrations management
- ✅ Visual database browser
- ✅ Good relationship handling
- ✅ Database-agnostic (PostgreSQL, MySQL, SQLite)

### Why PostgreSQL?

- ✅ ACID transactions
- ✅ JSON/JSONB support
- ✅ Full-text search
- ✅ Window functions
- ✅ Mature & stable
- ✅ Free & open-source
- ✅ Good replication/HA options

### Why Redis?

- ✅ Fast in-memory operations
- ✅ Pub/sub for real-time features
- ✅ Data structures (lists, sets, sorted sets)
- ✅ Atomic operations
- ✅ Persistence options
- ✅ Good cluster support

### Why BullMQ?

- ✅ Redis-backed job queue
- ✅ Retries & exponential backoff
- ✅ Scheduled jobs
- ✅ Worker processes
- ✅ Job lifecycle events
- ✅ Dead-letter queues

### Why MinIO?

- ✅ S3-compatible API
- ✅ Self-hostable
- ✅ No vendor lock-in
- ✅ Replication & high-availability
- ✅ Access control
- ✅ Versioning support

## Security Architecture

### Hybrid Authentication Flow

```
1. Client submits credentials (email + password or OAuth token)
           ↓
2. Server validates Argon2id hash or OAuth provider signature
           ↓
3. Generate JWT token pair:
   - Access Token (short-lived, 15 minutes)
   - Refresh Token (long-lived, 7 days, tracked in DB Session)
           ↓
4. Hybrid Token Delivery:
   - Body Payload: Returns Access Token in JSON response body (and Refresh Token for native clients)
   - HTTP Cookie: Sets secure `httpOnly; Secure; SameSite=Strict` cookie `refresh_token` scoped to `/auth/refresh`
           ↓
5. Client Token Management:
   - Web Clients: Store Access Token in memory; browser automatically manages `httpOnly` refresh cookie
   - Native Clients (Mobile/Desktop): Store tokens in secure platform storage (iOS Keychain / Android Keystore)
           ↓
6. Subsequent API Requests:
   - Client supplies Access Token via `Authorization: Bearer <JWT_ACCESS_TOKEN>` header
   - Server validates token signature, claims, and active session status
           ↓
7. Token Rotation (`POST /auth/refresh`):
   - Client sends cookie or body `refreshToken`
   - Server revokes prior refresh token, updates DB session, and issues fresh token pair
```

### Authorization Flow

```
1. Request with Bearer token arrives
           ↓
2. JWT Guard extracts & verifies token
           ↓
3. Extract userId & scopes from claims
           ↓
4. Verify token hasn't been revoked
           ↓
5. Inject user context into request
           ↓
6. Route handler accesses req.user
           ↓
7. Service performs ownership checks
           ↓
8. Database constraints enforce rules
```

### Encryption Strategy

```
Sensitive data (passwords, vault contents)
           ↓
Application-level encryption
           ↓
Envelope encryption (application key + per-data key)
           ↓
Database storage (encrypted blobs)
           ↓
Backup (encrypted snapshots)
```

### Rate Limiting

```
Incoming request
           ↓
Extract identifier (IP + user + endpoint)
           ↓
Check Redis counter
           ↓
If exceeded: return 429 Too Many Requests
           ↓
If OK: increment counter, set expiry
           ↓
Process request
```

## Caching Strategy

### Cache Layers

1. **HTTP Client Cache** — Browser cache headers
2. **Redis Application Cache** — Frequently accessed data
3. **Database Query Cache** — PostgreSQL internal cache
4. **CDN Cache** — Static assets (if using CDN)

### Cache Invalidation

```
When data changes:
  1. Update database
  2. Invalidate Redis key
  3. Publish cache invalidation event
  4. Notify clients (WebSocket if applicable)
  5. Clients refresh local cache
```

## Monitoring & Observability

### Logs

- Structured JSON format
- Request correlation IDs
- No sensitive data (passwords, tokens, vault contents)
- Different log levels for development/production

### Metrics

- Request count & latency (p50, p95, p99)
- Error rates (by endpoint, by error type)
- Database latency & connection pool
- Redis latency & memory
- Queue depth & processing time
- Business metrics (notes created, tasks completed, etc.)

### Tracing

- Distributed tracing (OpenTelemetry)
- Request flow across services
- Database query tracing
- External API call tracing

### Health Checks

- Liveness probe — is application running?
- Readiness probe — can it accept traffic?
- Service-specific checks (DB, Redis, storage)

## Scaling Considerations

### Horizontal Scaling

```
Multiple API instances
        ↓
Shared PostgreSQL
        ↓
Shared Redis
        ↓
Shared MinIO
        ↓
Distributed session management
        ↓
Sticky sessions or token-based auth
```

### Vertical Scaling

- Increase container CPU/memory limits
- Increase database connection pool
- Increase Redis memory

### Database Optimization

- Query indexing strategy
- Connection pooling
- Read replicas for queries
- Archival of old data
- Partitioning for large tables

### Caching Strategy

- Redis cache for hot data
- Query result caching
- Computed field caching
- Cache warming on startup

## Error Handling

### Error Categories

```
Client Errors (4xx)
├── Validation Error (400)
├── Unauthorized (401)
├── Forbidden (403)
└── Not Found (404)

Server Errors (5xx)
├── Internal Server Error (500)
├── Service Unavailable (503)
└── Timeout (504)
```

### Canonical Flat Error Response Format

All error responses return a standardized flat JSON envelope conforming to `AllExceptionsFilter`:

```json
{
  "statusCode": 404,
  "code": "NOT_FOUND",
  "message": "User not found",
  "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-09-07T14:00:00.000Z",
  "path": "/users/me"
}
```

> [!IMPORTANT]
> **Request Correlation (`X-Request-ID`)**:
> While `X-Request-ID` is optional on inbound client requests, the server **unconditionally auto-generates a UUIDv4 `requestId` server-side** if the client omits it. The server guarantees that:
> 1. `requestId` is **always populated** in every error response payload.
> 2. `X-Request-ID` is echoed back in the response headers.
> 3. The `requestId` is attached to structured log entries and security `AuditLog` records for end-to-end tracing.

## Performance Targets

| Operation | Target | Notes |
|-----------|--------|-------|
| Create note | < 100ms | p95 latency |
| List notes | < 200ms | 1000 items |
| Search notes | < 500ms | Full-text search |
| Sync pull | < 1000ms | 10 devices, 100 changes |
| File upload | < 5s | 10MB file |
| Backup | < 1h | Full database backup |

---

## Documentation Index & References

- [Master Documentation Portal](README.md)
- [API Reference](API_REFERENCE.md)
- [Modules & Subsystems Guide](MODULES_GUIDE.md)
- [Database Schema & ERD Dictionary](DATABASE_SCHEMA.md)
- [Security Guidelines & Audit Checklist](SECURITY.md)
- [Disaster Recovery & Continuity Plan](DISASTER_RECOVERY.md)
- [Incident Response Plan & Playbook](INCIDENT_RESPONSE.md)
- [Getting Started Guide](GETTING_STARTED.md)
- [Production Deployment Guide](DEPLOYMENT.md)

