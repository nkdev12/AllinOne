# Allinone Backend — Architecture

This document describes the architecture of the Allinone backend system.

## System Overview

Allinone is a **modular monolith** — a single deployable application with clear module boundaries that can be independently scaled or extracted into microservices if needed.

```
┌─────────────────────────────────────────────────┐
│         Client Applications                     │
│  (Web, iOS, Android, macOS, Windows, Linux)     │
└────────────────────┬────────────────────────────┘
                     │
                     │ HTTP/REST
                     │ WebSocket
                     ▼
┌─────────────────────────────────────────────────┐
│     Allinone Backend (NestJS)                   │
│                                                 │
│  ┌────────────────────────────────────────────┐ │
│  │ API Layer                                  │ │
│  │ ├── Controllers (HTTP endpoints)           │ │
│  │ ├── Guards (Authorization)                 │ │
│  │ ├── Filters (Exception handling)           │ │
│  │ └── Middleware (Logging, CORS)             │ │
│  └────────────────────────────────────────────┘ │
│                                                 │
│  ┌────────────────────────────────────────────┐ │
│  │ Feature & Core Modules                     │ │
│  │ ├── Authentication (AuthModule)            │ │
│  │ ├── Passkeys (PasskeysModule)              │ │
│  │ ├── Users (UsersModule)                    │ │
│  │ ├── Devices (DevicesModule)                │ │
│  │ ├── Notes, Folders, Tags (NotesModule)     │ │
│  │ ├── Tasks & Projects (TasksModule)         │ │
│  │ ├── Calendar & Events (CalendarModule)     │ │
│  │ ├── Vault / Password Manager (VaultModule) │ │
│  │ ├── Sync Engine (SyncModule)               │ │
│  │ ├── Admin (AdminModule)                    │ │
│  │ ├── Collaboration (CollaborationModule)    │ │
│  │ ├── AI helpers (AiModule)                  │ │
│  │ └── Health & Probes (HealthModule)         │ │
│  └────────────────────────────────────────────┘ │
│                                                 │
│  ┌────────────────────────────────────────────┐ │
│  │ Cross-cutting Services                     │ │
│  │ ├── Logging, Configuration, Prisma         │ │
│  │ ├── Tracing (W3C TraceContext)             │ │
│  │ ├── Error Handling (exception filter)      │ │
│  │ ├── AuditLog                               │ │
│  │ ├── Metrics (Prometheus)                   │ │
│  │ ├── Rate Limiting (Throttler + Redis)      │ │
│  │ ├── Email (imported by AuthModule only)    │ │
│  │ ├── No storage service (see Why MinIO?)    │ │
│  │ └── No notification delivery service       │ │
│  └────────────────────────────────────────────┘ │
│                                                 │
│  ┌────────────────────────────────────────────┐ │
│  │ Data Layer (Prisma ORM)                    │ │
│  │ ├── PrismaService (one client)             │ │
│  │ ├── Inline query builders                  │ │
│  │ └── $transaction (multi-doc)               │ │
│  └────────────────────────────────────────────┘ │
│                                                 │
│  ┌────────────────────────────────────────────┐ │
│  │ Background Workers (Bull v4)               │ │
│  │ ├── Email delivery      (consumer only)    │ │
│  │ ├── Notifications       (consumer only)    │ │
│  │ ├── Sync jobs           (not a queue)      │ │
│  │ ├── Exports             (consumer only)    │ │
│  │ └── Maintenance         (never runs)       │ │
│  └────────────────────────────────────────────┘ │
│                                                 │
└─────────────────────────────────────────────────┘
         │              │                │
         ▼              ▼                ▼
    ┌─────────┐   ┌──────────┐   ┌────────────┐
    │MongoDB  │   │ Redis    │   │MinIO (S3)  │
    │ (Data)  │   │(throttle)│   │(unused)    │
    └─────────┘   └──────────┘   └────────────┘
```

## Module Structure

This is the layout the feature modules actually use — `src/notes`, `src/tasks`,
`src/calendar` and `src/vault` all follow it, with `src/<domain>/controllers/` and
`src/<domain>/services/` as subdirectories:

```
src/<domain>/
├── <domain>.module.ts  # NestJS module definition
├── controllers/        # HTTP request handlers (*.controller.ts)
├── services/           # Business logic (*.service.ts)
└── dto/                # Data Transfer Objects
```

Two conventions the earlier sketch of this page got wrong, checked against the tree:

- **There is no `entity/` layer.** Prisma owns the data model, in one file —
  `prisma/schema.prisma` — and services talk to `PrismaService` directly. Nothing in
  `src/` declares an entity class, and there is no `mapper.ts` anywhere: response
  shaping is a private method inside the service that needs it (for example
  `formatTaskResponse` in `src/tasks/services/tasks.service.ts`).
- **Tests are colocated, not gathered.** A spec sits beside the file it covers as
  `*.spec.ts`, in `src/` rather than a `tests/` folder, and the jest `testRegex`
  finds them there. End-to-end suites live under `test/e2e/`, load scripts under
  `test/load/`. No module has its own `README.md`.
- **Cross-cutting code is not in the feature modules.** Guards, filters, the
  interceptors, mail, metrics, OTP, auditing, tracing and the throttler storage all
  live under `src/common/`; queues and processors under `src/queues/`; the second
  composition root (`src/worker.module.ts`) under `src/` itself. The only guards
  outside `src/common/` are `src/auth/guards/jwt-auth.guard.ts` and
  `src/admin/guards/admin.guard.ts`, and there is no policy/authorization layer
  beyond the per-service ownership checks.

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
MongoDB
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
├── MongoDB (container)          # mongo:7.0, started with --replSet rs0
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
    MongoDB (mongo:7.0, single node started with --replSet rs0)
        ▼
    Redis (cluster)
        ▼
    MinIO (cluster/replication)
        ▼
    Backup Storage
```

> [!NOTE]
> **What `docker-compose.prod.yml` actually defines, verified 2026-09-27:** a single `api` container (`allinone-api-prod`, no `replicas` key) and **two `worker` replicas** (`deploy.replicas: 2`), one `mongodb` (`mongo:7.0`, `--replSet rs0 --bind_ip_all`), one `redis` (`redis:7-alpine`, `--appendonly yes --requirepass ${REDIS_PASSWORD}`), one `minio`, plus `caddy`, `prometheus` and `grafana`. So the API-1/API-2 pair, "Redis (cluster)" and "MinIO (cluster/replication)" above are the intended shape, not the delivered one: the diagram puts the horizontal scaling on the API, while the file puts it on the worker. What the API does get is `REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379`, and because `src/main.ts` installs `SyncIoAdapter` at boot that means a second `api` replica would now attempt Redis-backed room broadcast rather than silently running per-process — the Socket.IO half of horizontal scaling is no longer the blocker it was. `depends_on` already gates the API on redis being healthy, so the usual "Redis is configured but down at boot" case is covered here too. The remaining reasons not to raise `api` above one replica are the rate limiter (in-process storage — see Horizontal Scaling) and the fact that no one has run two. See "Horizontal Scaling" under Scaling Considerations.

## Database Schema Layers

### 1. Authentication & Users

```
User
├── id (UUID)
├── email (unique)
├── status (enum: ACTIVE, PENDING, SUSPENDED, DELETED)
├── failedLoginAttempts / lockedUntil  (the account-lockout pair)
├── emailVerifiedAt
└── timestamps

Authentication (one per auth method)
├── userId (FK)
├── type (enum AuthType: EMAIL_PASSWORD, GOOGLE, APPLE, MICROSOFT, PASSKEY —
│        there is no OAUTH member. PASSKEY is live on the write side and dead on
│        the read side: `POST /auth/passkeys/register-options` and
│        `register-verify` are mounted and store a credential, while the
│        authentication routes were taken offline, so a passkey can be registered,
│        never used, and has no route that lists or removes it.)
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

```
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

```
Change (the event log; entityType is note | task | event | vault_item)
├── id (UUID, @map("_id"))
├── userId
├── deviceId (nullable — NULL for a change the server itself appended)
├── entityType, entityId
├── operation (CREATE, UPDATE, DELETE, RESTORE)
├── version            the entity's own version number, and the only thing
│                      compared: a push is refused when it is lower than the
│                      newest stored version for that (userId, entityType, entityId)
├── payload (JSON)     user content, treated as such everywhere. Plaintext for
│                      note/task/event; opaque AES-GCM blob fields for vault_item
├── cursor (BigInt)    NOT auto-increment: see SyncCursor
├── createdAt          when this server heard about the change
└── clientTimestamp    when the authoring device made it, on that device's clock.
                       Stored and echoed on pull, never compared — an
                       ahead-of-clock device cannot push past a newer write

SyncCursor (one row per user; the reason cursors exist at all)
├── userId (unique)
└── seq (BigInt)       $inc'd inside the same transaction that writes the Change

DeviceSyncState (one row per device)
├── deviceId (unique, FK → Device, Cascade)
├── lastPulledCursor (String — a BigInt rendered as text, which is why the prune
│                    parses it and treats anything non-numeric as 0)
├── lastPushedSequence (Int)
└── lastSuccessfulSyncAt

IdempotencyKey
├── (userId, key) unique   ← per account, not a global unique on key alone
├── endpoint, method, statusCode, response (cached), expiresAt
```

Writes reach the log from two directions, and only one of them is the sync API:
`POST /sync/push` appends `Change` rows and nothing else, while the REST modules
(`notes`, `tasks`, `calendar`, `ai`) write their own entity row **and** append a
`Change` through `appendChange`. Nothing replays the log into those tables, so the
row and the log can disagree and a device only ever sees the log. `vault_item` has
no entity row and no REST route — for the vault the log genuinely is the store.

#### Retention: how far back the log stays readable

`Change` rows are pruned by the `cleanup-expired` job in
`src/queues/processors/maintenance.processor.ts`. `src/worker.ts:36-56` asks for it
once at startup and then every hour (`repeat: { every: 60 * 60 * 1000 }`,
`attempts: 3`, exponential backoff) — but see the queue-wiring warning under
"Technology Decisions": that enqueue cannot resolve today, so in the current build
this job only runs if something else puts it on the queue, and nothing does. The rule
below is what the processor does when it _is_ invoked, which the
`processors.spec.ts` cases cover directly against mocks.

The rule is **30 days** (`CHANGE_RETENTION_DAYS`, default `30`) **unless a live
device has not read that far back** — and the second half is the load-bearing one:

1. Rows older than the cutoff are grouped per user (`groupBy` on `userId`).
2. For each of those users, the floor is the **oldest** `lastPulledCursor` held by
   any of its **non-revoked** devices. A device that has never pulled counts as `0`,
   which correctly holds the whole log open; a revoked device is excluded, because
   nothing can pull with it again.
3. The delete is then `userId + createdAt < cutoff + cursor < floor`, one
   `deleteMany` per user rather than the single global delete this job used to run.

A change log is a queue, and a queue is only safe to compact behind its slowest
reader. The version this file described before was the global `createdAt < cutoff`
delete, and against a per-user cursor it is not a compaction but a hole: a phone
that has not synced in 60 days gets a checkpoint inside the rows the job removed,
its next pull matches nothing, and it goes on syncing from there while permanently
missing every edit and delete in between — with no error anywhere to say so.

Retention is therefore a floor, not a deadline. An idle device keeps its owner's
plaintext note bodies in the database for as long as it stays registered and
unread, with no age at which the 30 days wins; revoking the device is what releases
those rows, and the next hourly run deletes them.

**What the job reports.** Its return value carries `purgedSessions`,
`purgedIdempotencyKeys`, `purgedChanges`, `heldBackForIdleDevices` (the rows the
floor withheld — not a failure, but the difference between "compacted" and "someone
is 40 days behind") and `executedAt`, and the log line names the same numbers. Two
things limit how much of that you can actually see:

- `removeOnComplete: true` on both `add()` calls discards the job's return value as
  soon as it succeeds, so the only trace left of a completed run is the worker's log
  line. Anything watching for growth has to read logs, not job state.
- `sync_changes_compacted_total` is incremented only with `purgedChanges`, never
  with `heldBackForIdleDevices`, and `MetricsService` holds those counters in
  instance fields. The process that runs the job is the only one that ever adds to
  it, and `/metrics` is served by whichever process answers the scrape — so a
  multi-process deployment reports a number that is not the total. The rows held
  back are not in the metric at all.

### 4. Observability & Auditing

```
AuditLog
├── id (UUID, @map("_id"))
├── userId (nullable for unauthenticated events)
├── action (enum AuditAction: LOGIN_SUCCESS, LOGIN_FAILURE, LOGOUT, PASSWORD_CHANGED,
│          EMAIL_CHANGED, MFA_ENABLED, MFA_DISABLED, DEVICE_ADDED, DEVICE_REVOKED,
│          SESSION_REVOKED, ACCOUNT_CREATED, ACCOUNT_DELETED, ACCOUNT_EXPORTED,
│          ACCOUNT_LOCKED, ACCOUNT_UNLOCKED, OAUTH_CONNECTED, OAUTH_REVOKED)
├── resourceType (String, optional)
├── resourceId (String, optional)
├── requestId (String, optional correlation ID)
├── changes (Json diff of mutated fields)
├── ipAddress (String)
├── userAgent (String)
├── metadata (Json request context & telemetry)
└── createdAt (DateTime)
```

> [!NOTE]
> **AuditLog Column Rationale**: `changes` and `metadata` are intentionally retained as separate columns. `changes` stores entity attribute mutations (before/after diffs), whereas `metadata` isolates request and actor context (IP location, client platform, authentication method, failure reason). This separation preserves clean SIEM audit queries without bloating entity mutation records.
>
> **Which of those actions are ever written**: not all of them. `ACCOUNT_DELETED` and `ACCOUNT_EXPORTED` have no writer anywhere in `src/` — `softDeleteAccount` and `requestDataExport` return without logging, so an account deletion leaves no audit row. Treat a missing entry as "not recorded", not as "did not happen".
>
> **Dynamic Health Probes**: Health monitoring does not use a persistent database table. `GET /health` is served in-memory by `HealthService.checkTerminusHealth()`, and it checks exactly one dependency: `prisma.checkHealth()` against **MongoDB**, whose `latency` it reports. The `redis` entry in the same response is a literal `{ status: "up" }` assigned on `health.service.ts:33` and no Redis command runs before it — so `/health` cannot go red over a dead queue, and `/health/ready` is not a readiness gate for Bull. There is no Terminus `HealthIndicator` here despite the naming, and no PostgreSQL in this deployment.

## Technology Decisions

### Why NestJS?

- ✅ TypeScript first-class support
- ✅ Dependency injection pattern
- ✅ Module system (clean architecture)
- ✅ Guards, Pipes, Interceptors (middleware)
- ✅ OpenAPI/Swagger integration
- ✅ Testing utilities (Jest integration)
- ✅ Production-ready defaults

### Dependency baseline (2026-09-27)

The `@nestjs/*` family is aligned on the **Nest 11** line: `common`, `core`, `platform-express`, `platform-socket.io`, `websockets` and `testing` at `^11.2.6`, with `config` 4.0.4, `swagger` 11.4.7, `bull` 11.0.5, `passport` 11.0.5, `throttler` ^6.4.0, `cli` 11.0.24 and `schematics` 11.1.0. `@nestjs/core@11` requires **Node ≥ 20**. TypeScript stays on 5.x, `uuid` is `^11.1.1` (v11 is the last line that still ships a CommonJS build; the app compiles to CommonJS) and `@types/uuid` is gone because uuid ships its own types. `npm audit` reports 0 vulnerabilities.

Two boundaries worth remembering before touching these numbers. **Nest 10 is a dead end**: 10.4.22 was the final 10.x release and it pins `file-type@20.4.1` exactly, so the `file-type` advisories could not be cleared without a major. **Nest 12 was declined deliberately**: `@nestjs/config@12` types `validationSchema` as `StandardSchemaV1`, which rejects the joi schemas in `src/app/app.module.ts` and `src/worker.module.ts` and drops `validationOptions.abortEarly`/`allowUnknown`, and `@nestjs/schematics@12` requires TypeScript ≥6. `package.json` carries `overrides` for `minimatch` (the `@typescript-eslint` 6 chain) and `uuid`; `npm audit fix --force` is unsafe here — it half-migrates core/config/swagger to 12 while leaving `common` on 10 and reintroduces six compile errors.

### Why Prisma?

- ✅ Type-safe query builder
- ✅ Auto-generated TypeScript types
- ✅ Migrations management — **not used by this project**: there is no `prisma/migrations/` directory, so `schema.prisma` reaches the database through `npm run db:push` (`prisma db push`), which mutates collections without a recorded, replayable migration
- ✅ Visual database browser
- ✅ Good relationship handling
- ✅ Database-agnostic (this deployment uses its **MongoDB** connector — `provider = "mongodb"` in `prisma/schema.prisma`. `npm run typecheck` covers the generated client, and no migration in this repo targets SQL.)

### Why PostgreSQL?

**It isn't, and this heading is the oldest artefact in the file.** The datasource is
MongoDB, and the consequences are not cosmetic: there are no foreign keys, so
referential integrity lives in each service's `deletedAt` filters (DATABASE_SCHEMA.md
has the matrix); there is no autoincrement, so `Change.cursor` needs the `SyncCursor`
counter document to be monotonic at all; and `$transaction` is a multi-document
transaction whose size is bounded by what a push batch can put in it. The bullets
below describe a store this service does not run against. JSON/JSONB is the one that
survives in a different form (`Json` columns), and "full-text search" does not:
`search` is a `contains` + `mode: "insensitive"` substring match on title and body,
which is why it is honest about being slow rather than indexed.

- ✅ ACID transactions
- ✅ JSON/JSONB support
- ✅ Full-text search
- ✅ Window functions
- ✅ Mature & stable
- ✅ Free & open-source
- ✅ Good replication/HA options

### Why Redis?

- ✅ Redis-backed job queue — _provisioned, not wired: see the queue warning under
  "Why queues — and which one"_
- ✅ Rate limiting with a shared counter store — **the one live use**:
  `RedisThrottlerStorage` (`src/common/throttler/redis-throttler.storage.ts`), which
  fails **open** and permits the request when Redis errors
- ✅ Session / cache tier — _not used: there is no application cache, and sessions live
  in MongoDB_
- ✅ Socket.IO pub/sub backplane for a multi-instance API — _installed at boot by
  `SyncIoAdapter` (`src/main.ts:97`) when `REDIS_URL` is set; falls back to per-process
  rooms, unreported, when Redis is unreachable_
- ✅ Good cluster/HA options — what is actually deployed is a single `redis:7-alpine`
  with `--appendonly yes --requirepass ${REDIS_PASSWORD}`, not a cluster

None of the above is observable from the health endpoint: `GET /health` reports
`redis: { status: "up" }` without issuing a Redis command
(`src/health/health.service.ts:33`).

### Why queues — and which one

**This project uses Bull v4 (`bull@4.16.5`, through `@nestjs/bull@11.0.5`), not
BullMQ.** `bullmq` and `@nestjs/bullmq` are not dependencies of this repository, and
the two libraries are not interchangeable: the module registers queues with
`BullModule.forRootAsync`/`registerQueue` (`src/queues/queues.module.ts:17-31`),
processors use `@Processor`/`@Process` from `@nestjs/bull`, and `src/worker.ts:4-5`
imports `getQueueToken` and the `Queue` type from Bull. Docs and log lines that say
"BullMQ" are naming drift, not a second stack — including this file's earlier
"### Why BullMQ?" heading. What Bull v4 does give here: Redis-backed queues, `attempts`
with exponential backoff, and `repeat`-based scheduling. What it does not give, and
was previously claimed here: dead-letter queues (nothing moves a failed job anywhere)
and `@nestjs/schedule` crons (that package is not installed; the only schedule is the
`repeat: { every: 60 * 60 * 1000 }` added in `src/worker.ts:47-56`).

> [!WARNING]
> **The queue layer is not wired into any process that runs, verified 2026-09-27.**
> `QueuesModule` — which owns `BullModule.forRootAsync`, the four queue registrations
> and all four `@Processor` classes — is imported by exactly one module:
> `WorkerModule` (`src/worker.module.ts:54`). And `WorkerModule` is imported by
> nothing: `grep -rn "WorkerModule" src` returns its own declaration, its own spec,
> and a doc comment. Nothing in the test suite can see the gap either — the only spec
> that names it (`src/worker.module.spec.ts`) never compiles the module; it asserts
> `WorkerModule` is defined and that `getQueueToken("mail") === "BullQueue_mail"`.
> `src/worker.ts:22` bootstraps **`AppModule`**, not
> `WorkerModule`, so the process the `worker` container runs has no Bull registration
> in its DI graph. Consequences, in the order they bite:
>
> - No processor is ever instantiated, so nothing consumes `mail`, `notification`,
>   `export` or `maintenance`.
> - `src/worker.ts:33` then asks for `getQueueToken("maintenance")`, which cannot
>   resolve. The surrounding `try` (`:32`) / `catch` (`:61-66`) turns it into a
>   `logger.warn("Worker queue scheduling warning (Redis connection may be
mock/offline)")` and the process stays up, idle. Both `worker` replicas spend
>   their life in that state.
> - The "startup cleanup job" and the "hourly repeatable cleanup job" the same file
>   announces in its logs never reach Redis, so `cleanup-expired` — the only code that
>   prunes expired sessions, idempotency keys and `Change` rows — never runs on its
>   own. See the retention-floor note in §3 for what that means for the change log.
> - The worker also has no reason to bind a port, and does not (it calls `app.init()`,
>   never `app.listen()`), but it does construct the entire HTTP app: controllers,
>   guards, `SyncModule`, and a Socket.IO server bound to a nonexistent HTTP server.
>
> Mail still goes out — just not through a queue. `AuthModule` imports `MailModule`
> (`src/auth/auth.module.ts:22`) and calls `MailService` directly and
> `@Optional()`-ly (`src/auth/auth.service.ts:58`, and the same in
> `src/vault/services/vault-settings.service.ts:56`), so verification and
> password-reset mail is sent inline on the request path, and a `MailService`
> resolution failure is silently swallowed rather than failing the request.
> `mail.processor.ts` and `notification.processor.ts` have no producer anywhere:
> no `@InjectQueue`, no `getQueueToken`, no `.add(` outside `src/worker.ts`. The
> export queue is the same story, and more explicitly: `requestDataExport`
> (`src/users/users.service.ts:110-125`) loads the user, logs, and returns
> `"Data export request recorded. Background export delivery is disabled."` — it
> enqueues nothing, while its own `@ApiResponse` still advertises `202` "Export
> request accepted and queued".
>
> The one-line repair is to bootstrap `WorkerModule` in `src/worker.ts:22` instead of
> `AppModule` — but `WorkerModule` is a narrower DI tree than the processors assume
> (it has `PrismaModule`, `MailModule`, `MetricsModule` and `QueuesModule`, and not
> `ConfigModule`'s `ConfigurationService` consumers that `CustomThrottlerGuard` and
> the sync gateway pull in), so it needs a boot test before it is trusted. Tracked in
> the improvement tracker; deliberately not changed as part of this docs pass.

### Why MinIO?

**It is in the infrastructure and not in the application.** Everything below is
verified 2026-09-27, and the earlier version of this section listed S3-compatible
capabilities as if a client existed:

- A `minio` service runs in **both** compose files (`minio/minio:latest`, ports
  `9000`/`9001`, healthcheck on `/minio/health/live`), and `.env.example` ships
  `OBJECT_STORAGE_*` credentials for it.
- **No object-storage client is a dependency of this project.** `package.json` has no
  `@aws-sdk/*`, no `aws-sdk`, no `minio`, and `grep -rn "S3Client|PutObject|getObject"
src` returns nothing. `src/common/aws/` is an **empty directory**.
- The settings are nevertheless mandatory: `ConfigurationService` exposes six
  `objectStorage*` getters (`src/config/configuration.service.ts:147-168`) that
  **nothing calls**, and both composition roots `Joi.required()` four of them
  (`src/app/app.module.ts:76-81`, `src/worker.module.ts:32-35`). So the process will
  not boot without credentials for a service it never contacts — which is why a
  missing MinIO container looks like a config error rather than an unused feature.
- The observable consequence is `Attachment`: the model is real and read by
  `notes.service.ts`, and **nothing in the backend ever writes one** (see the
  `Attachment` entry in DATABASE_SCHEMA.md §3). There is no upload route, no
  presigned-URL route, and no download route. Encrypted vault payloads are not stored
  here either — they are `Change` rows in MongoDB.
- Related ops claim to treat with suspicion: the "back up the MinIO volume" step in
  DEPLOYMENT.md protects a volume this application never writes to.

The honest summary: object storage is provisioned, configured, and unimplemented.
Either the credentials stop being required at boot, or `Attachment` gets a writer and
a route.

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

Only two of the four layers this list used to claim exist in today's build:

1. **HTTP Client Cache** — browser cache headers. Real, but nothing in `src/` sets a
   `Cache-Control` or `ETag` on any response, so it is the browser's default behaviour
   rather than a designed layer.
2. ~~**Redis Application Cache** — Frequently accessed data~~ **does not exist.**
   There is no cache-aside, no TTL wrapper, no `get`/`set` helper anywhere in `src/`.
   Redis is used for exactly one thing in the running system: the counters behind
   `RedisThrottlerStorage`. Every read in every service goes to MongoDB.
3. **Database Engine Cache** — MongoDB's WiredTiger cache. Real, and the only
   server-side cache actually in play; sized by the container, not by this repo.
4. **CDN Cache** — Static assets (if using CDN). There is no static asset route; Caddy
   proxies the API and the Swagger UI only.

### Cache Invalidation

The sequence below describes the system that was planned, not the one in the tree:
there is no Redis key to invalidate and no cache-invalidation event on any bus. What
actually happens when data changes is the sync path — write the row, append a `Change`,
emit `sync:invalidation` to the user's Socket.IO room so connected clients pull:

```
When data changes (REST write on notes/tasks/events, AI task conversion, or /sync/push):
  1. Update MongoDB, appending the Change row inside the same $transaction
  2. After the transaction resolves, SyncNotificationService.notifyMutation()
     # never inside it: a rolled-back write must not be announced
     # and a socket that threw cannot turn a committed write into a 500
  3. Emit sync:invalidation to room user:<userId>   # cross-instance only while Redis is up; see Horizontal Scaling
  4. Clients re-pull with GET /sync/pull from their last cursor
```

## Monitoring & Observability

### Logs

- Structured JSON format
- Request correlation IDs
- No sensitive data (passwords, tokens, vault contents)
- Different log levels for development/production
- Structured JSON format via custom `LoggerService`
- Trace and span correlation (`traceId`, `spanId`) automatically injected from active `AsyncLocalStorage` context
- Request correlation IDs (`requestId`)
- Zero sensitive data logged (passwords, tokens, vault contents, encryption keys excluded)
- Environment-aware log levels (debug/verbose in development, info/warn/error in production)

### Metrics

`MetricsService` hand-builds the `/metrics` payload; these are the only series it exports (verified 2026-09-27 against `src/common/metrics/metrics.service.ts`):

- `http_request_duration_seconds` — histogram, so request count and p50/p95/p99 latency are both derivable from it
- `process_uptime_seconds`, `process_resident_memory_bytes` — process-level gauges
- `database_connections_active` — **not** a pool statistic: it is `1` or `0` from a single `prisma.checkHealth()` ping, i.e. a health flag exported as a gauge. The ping's measured `latency` is discarded here, and there are no Prisma telemetry/`$extends` hooks anywhere in the codebase
- `sync_throughput_pushes_total`, `sync_throughput_changes_total`, `sync_throughput_pulls_total`, `sync_changes_compacted_total` — sync counters; read the P2-5 annotation in the improvement tracker before treating the last one as backlog depth

Not exported, despite earlier versions of this list claiming them: error rates by endpoint or type (the exception filter does not increment a counter), Redis latency or memory, Bull queue depth or job processing time, and any business metric such as notes created or tasks completed. Prometheus and Grafana run as containers (`docker-compose.dev.yml`, `docker-compose.prod.yml`), but what they can show is limited to the eight series above.

### Distributed Tracing & W3C TraceContext (Implemented)

- Distributed tracing via OpenTelemetry (`@opentelemetry/api`, `@opentelemetry/sdk-node`) — _Planned / Roadmap_; neither package is a dependency of this project today, so nothing exports spans anywhere yet
- Database query tracing and slow query instrumentation — _Planned / Roadmap_
- External API call tracing (OAuth providers, webhook endpoints) — _Planned / Roadmap_
- _Current active capability_: Request correlation across services, controllers, and security `AuditLog` records is fully active via `X-Request-ID` and auto-generated UUIDv4 request IDs.
  The backend implements end-to-end distributed tracing following the **W3C TraceContext** standard (`traceparent: 00-{traceId}-{spanId}-{traceFlags}`):

- **`TracingService` (`src/common/tracing/tracing.service.ts`)**: Manages active spans, child span creation, span tags/attributes, execution timing, and asynchronous context propagation via Node.js `AsyncLocalStorage<TraceContext>`.
- **`TracingInterceptor` (`src/common/tracing/tracing.interceptor.ts`)**: Global HTTP interceptor that:
  1. Extracts incoming W3C `traceparent` headers, creating child spans for upstream traces, or automatically initializes a 128-bit `traceId` if none is provided.
  2. Injects `X-Trace-ID` and `traceparent` response headers for downstream client and microservice correlation.
  3. Records HTTP status codes, routing metadata, and latency on span completion.
- **Log Enrichment**: `LoggerService` queries `TracingService.getTraceId()` and `TracingService.getSpanId()` to automatically tag every log event with active trace coordinates.
- **OpenTelemetry Compatibility**: The in-memory span registry (`Span`, `SpanStatus`) is structured to export directly to OpenTelemetry collectors (OTLP gRPC/HTTP to Jaeger, Tempo, or Datadog).

### Health Checks

- Liveness probe — is the application process alive? (`GET /health/live`)
- Readiness probe — can the application accept traffic? (`GET /health/ready`, 503 when the probe reports `error`)
- Aggregate probe (`GET /health`) and a service-information probe (`GET /info`)

Both `GET /health` and `GET /health/ready` call the same `HealthService.checkTerminusHealth()`, which probes **exactly one dependency**: `prisma.checkHealth()`, a `$runCommandRaw({ ping: 1 })` against MongoDB whose round-trip it reports as `latency`. The `redis` entry in that response is a literal `{ status: "up" }` (`src/health/health.service.ts:33`) — no Redis command runs — so neither route can go red over a dead queue or a dead Bull worker, and `ready` is not a readiness gate for them despite the `@ApiOperation` summary saying "DB & services ready". There is no `@nestjs/terminus` `HealthIndicator` in the build either; the method is named after it, but nothing imports Terminus. `GET /info` returns `name`, `version`, `environment` and a hard-coded `commit: "HEAD"` — no uptime or system status. See the "Dynamic Health Probes" note under the AuditLog section for the same finding in context.

## Scaling Considerations

### Horizontal Scaling

```
Multiple API instances
        ↓
Shared MongoDB
        ↓
Shared Redis (rate-limit counters only — see the warning below)
        ↓
Sticky sessions / shared state
```

The pieces this needs are not all in place, verified 2026-09-27:

- **JWTs are stateless, so auth itself scales.** A second API instance can verify
  tokens issued by the first without shared state.
- **Rate limits do NOT scale, and this bullet claimed the opposite until 2026-09-27.**
  `RedisThrottlerStorage` (`src/common/throttler/redis-throttler.storage.ts`) is written,
  unit-tested and never used: `ThrottlerModule.forRootAsync` (`src/app/app.module.ts:160-169`)
  passes `ttl` and `limit` and no `storage` option, and no `storage:` assignment exists
  anywhere in `src/`. `@nestjs/throttler` therefore keeps its counters in its own in-memory
  `ThrottlerStorageService`, so every replica holds an independent budget and N instances
  answer N times the declared limit. `SECURITY.md`'s rate-limiting section states this
  correctly; the contradiction between the two files was the bug.
- **Real-time invalidation now scales when Redis is configured, and silently does not
  otherwise.** `SyncGateway` emits `sync:invalidation` to the `user:<userId>` room
  (`src/sync/sync.gateway.ts`), and rooms are per-process unless the server's adapter is
  replaced. It is replaced: `src/main.ts:97` installs `SyncIoAdapter`
  (`src/sync/adapters/sync-io.adapter.ts`), which extends `RedisIoAdapter`
  (`src/sync/adapters/redis-io.adapter.ts`) and connects it before `listen()` — but only when
  `REDIS_URL` is set and `WS_REDIS_ADAPTER` is not `false`. When Redis is configured and
  unreachable the connect error is swallowed, a warning is logged, and the process comes up on
  the default in-memory `@socket.io/socket.io-adapter` with per-process rooms again. That
  fallback is not reported by `/health` or any other external signal, so a second replica is
  only as good as the `[sync-ws] … Clustering:` line in its boot log. Tracked as P0-4.
- **Nothing starts a second instance anyway.** `docker-compose.prod.yml` runs one
  `api` container; its two `worker` replicas do not serve HTTP (see the queue warning
  above). "Multiple API instances" is the shape the diagrams draw — and after the 2026-09-27
  fixes it is closer to supported than it was, with rate limiting the remaining reason it is
  still not safe to start one.

### Vertical Scaling

- Increase container CPU/memory limits
- MongoDB connection concurrency — Prisma's MongoDB connector does not expose a
  Postgres-style `pool=` knob, and `DATABASE_URL` in both compose files carries no pool
  parameter
- Increase Redis memory — it holds Socket.IO pub/sub traffic once `/sync` clustering is
  active, and nothing at all today: `RedisThrottlerStorage` is not registered (see
  Horizontal Scaling), so no throttle counters live there

### Database Optimization

- Index strategy — `@@index`/`@unique` declarations in `prisma/schema.prisma`, catalogued in DATABASE_SCHEMA.md
- Connection pooling — the Prisma MongoDB driver pools connections; there is no `connection_limit`/pool knob set in this repo
- Archival of old data — partial: `MaintenanceProcessor` (`@Processor("maintenance")`, scheduled from `src/worker.ts`) expires old rows; see §3 and the P1-5 annotation in the improvement tracker for the retention floor it must respect
- Read replicas — _not implemented_. No replica/secondary routing exists anywhere in `src/`, and `docker-compose.prod.yml` starts MongoDB as a single-member set (`--replSet rs0`) with no `rs.add` anywhere in the repo, so there is no second member to read from. The earlier `@prisma/extension-read-replicas` line here was aspirational — _Planned / Roadmap_
- Sharding — _not implemented_, and unrelated to the single-node replica set above; no shard/key-file configuration exists in the compose files or `scripts/`

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

> [!NOTE]
> **Error Message Shape (`string | string[]`)**:
> The `message` property is typed as `string | string[]`. For validation failures (HTTP 400 `VALIDATION_ERROR` triggered by `ValidationPipe`), `message` is an array of individual validation error messages (e.g. `["email must be an email", "password must be at least 8 characters"]`). For all other operational and HTTP exceptions (401, 403, 404, 409, 429, 500), `message` is a single human-readable string describing the error.

> [!IMPORTANT]
> **Request Correlation (`X-Request-ID`)**:
> While `X-Request-ID` is optional on inbound client requests, the server **unconditionally auto-generates a UUIDv4 `requestId` server-side** if the client omits it. The server guarantees that:
>
> 1. `requestId` is **always populated** in every error response payload.
> 2. `X-Request-ID` is echoed back in the response headers.
> 3. The `requestId` is attached to structured log entries and security `AuditLog` records for end-to-end tracing.

## Testing Architecture & Quality Assurance

The codebase employs a multi-tiered testing strategy spanning unit, end-to-end (E2E), and load testing harnesses:

### 1. Unit Testing Suite (`npm test`)

- Built with **Jest** testing framework (`jest.config.ts`).
- **32 suites / 286 tests** as of 2026-09-26, covering services, controllers, guards, interceptors, DTOs and utilities.
- Strict isolation using mock implementations for external dependencies (Prisma, Redis, Config, Bull).
- Scope note that matters when reading section 2: this config has `rootDir: "src"`
  and `testRegex: ".*\\.spec\\.ts$"`, so it **cannot see anything under `test/`**.
  `npm test` is not "the whole suite" — it is the unit half of it.

### 2. End-to-End (E2E) Test Suite (`npm run test:e2e`)

- Built using **Supertest** and NestJS `Test.createTestingModule` (`test/jest-e2e.json`, `rootDir: "."`, `testRegex: ".e2e-spec.ts$"`) — **5 suites / 53 tests**.
- Path mapping `@/*` resolves cleanly to `src/*`.
- > [!WARNING]
  > **Nothing runs this suite automatically.** There is no CI workflow in the
  > repository (`.github/workflows` does not exist), `npm test` cannot reach these
  > files, and `npm run typecheck` (`tsc -p tsconfig.json`) is scoped to `src/**/*`
  > so it does not even compile them. The separate
  > `npx tsc --noEmit -p test/tsconfig.e2e.json` gate is a manual command listed in
  > no script. A red e2e spec is therefore invisible until somebody runs it by hand
  > — which is why `DEPLOYMENT.md`'s "end-to-end tests passing" checkbox is a person,
  > not a pipeline.
- Every one of these specs runs the real controller, pipes, filters and service and
  fakes only the database. That is deliberate and it is the difference between an
  assertion on a wire contract and a read-back of a mock's own fixture: the sync spec
  in this file once asserted a response shape (`appliedChanges`, `processedAt`,
  `isHealthy`) that appears nowhere in what the service returns, and could not fail.
  - **Health & Telemetry (`test/e2e/health.e2e-spec.ts`)**: Ingress root, liveness probe, dynamic readiness, system info probe, and upstream W3C `traceparent` ingestion.
  - **Authentication & Lockout Lifecycle (`test/e2e/auth-flow.e2e-spec.ts`)**: Registration validation, user onboarding, password verification, 5-attempt brute-force lockout envelope, token refresh rotation, and logout session revocation.
  - **Device & Delta Sync Flow (`test/e2e/sync-flow.e2e-spec.ts`)**: The exact key set of each `/sync` response, the 401 without a token, the whitelist rejecting a `folderId` key on a change, conflict round-trips, `DEVICE_NOT_REGISTERED` / `DEVICE_REVOKED`, a revoked device's checkpoint echoed back, and `clientTimestamp` surviving the JSON round trip.
  - **Vault Settings Lifecycle (`test/e2e/vault-settings.e2e-spec.ts`)**: The not-configured `GET` shape, setup's 201 and its 409 on a configured vault, the `kdfIterations` validation floor, that the stored verifier is the peppered HMAC rather than the value sent, unlock's 200 / 401 `VAULT_MASTER_KEY_MISMATCH` / 401 `RATE_LIMITED` cooldown / 404 `VAULT_NOT_CONFIGURED`, and recovery's 401 `VAULT_RECOVERY_NOT_PENDING` plus the material `recovery/verify` hands back. Runs the real `VaultSettingsService` behind the guard, the app's own validation pipe and the error handler, over one in-memory row — so it asserts the status a device branches on, which a service unit test cannot see.
  - **`test/e2e/phase3.e2e-spec.ts`** exists and runs, and is not described here. It is the fifth suite the count above includes; read the file for what it covers.

### 3. Load & Performance Testing (`npm run test:load:*`)

- Executed via **k6** load testing engine (`test/load/`):
  - `test/load/k6-sync-load.js`: Simulates 50–100 concurrent virtual users (VUs) executing delta push/pull cycles with performance thresholds (p95 < 250ms, error rate < 1%).
  - `test/load/k6-auth-load.js`: Evaluates authentication throughput, token refresh rotation, and rate-limiting guard performance under sustained traffic.

## Performance Targets

| Operation    | Target   | Notes                   |
| ------------ | -------- | ----------------------- |
| Create note  | < 100ms  | p95 latency             |
| List notes   | < 200ms  | 1000 items              |
| Search notes | < 500ms  | Full-text search        |
| Sync pull    | < 1000ms | 10 devices, 100 changes |
| File upload  | < 5s     | 10MB file               |
| Backup       | < 1h     | Full database backup    |

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
