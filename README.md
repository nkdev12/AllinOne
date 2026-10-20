# Allinone Backend

> Production-grade backend for Allinone — a cross-platform personal information management system with zero mandatory paid dependencies.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-22.x-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-%3E%3D5.3.0-blue.svg)](https://www.typescriptlang.org)

## Overview

Allinone is a **100% free, self-hosted** backend that combines:

- 📝 **Notes** — Obsidian-like personal knowledge management
- ✅ **To-do** — Todoist-like task management
- 🔐 **Password Manager** — Bitwarden-like secure credential vault
- 📅 **Calendar** — Google Calendar-like event management
- 🔍 **Global Search** — Unified search across all modules
- 🔗 **Cross-module linking** — Connect notes, tasks, and events
- 📱 **Offline-first sync** — Work offline, sync when reconnected
- 💻 **Multi-device support** — Seamless synchronization across devices
- 🔔 **Notifications & reminders** — Task and event notifications
- 👥 **User & account management** — Complete authentication & authorization

## Features

### Architecture

- **Modular monolith** — Clean separation of concerns, ready to scale
- **Production-grade** — Not a prototype or tutorial
- **Type-safe** — Strict TypeScript throughout
- **Zero paid dependencies** — Uses only free and open-source software
- **Self-hostable** — Run entirely on your own infrastructure

### Technology Stack

| Component | Technology | Where it runs |
|-----------|-----------|------------|
| **Backend** | Node.js 22 + NestJS 11 + TypeScript | Railway service #1 (`npm run start:prod`) |
| **Queue worker** | Same image, `npm run start:worker` | Railway service #2 (`railway.worker.json`) |
| **Database** | MongoDB (Prisma 5 `mongodb` connector) | MongoDB Atlas (managed replica set) |
| **Cache & Queues** | Redis + Bull (via `@nestjs/bull`) | Managed Redis (Upstash/Railway) |
| **Object Storage** | MinIO (S3-compatible) | Self-hosted only; unset in the deployed stack |
| **Email** | SMTP via nodemailer 10 | Any provider; sent from the worker |
| **Reverse Proxy / TLS** | Railway edge (managed, auto HTTPS) | Replaces the deleted Caddy config |
| **Monitoring** | `GET /metrics` (Prometheus format) | Exposed, **not scraped** — see docs/DEPLOYMENT.md Step 10 |
| **Logging** | Structured JSON to stdout | Railway log drains / `railway logs` |
| **Web client** | Flutter web build | Cloudflare Workers |

**No required paid services** — the free tiers of Atlas, Redis and Railway are enough for a
personal deployment. "Self-hosted" still works: `docker-compose.dev.yml` gives you local
MongoDB + Redis (+ optionally MinIO, Prometheus, Grafana) and you point `DATABASE_URL` /
`REDIS_URL` at it.

## Quick Start

### Prerequisites

- Node.js 22 (`.nvmrc` and `engines.node` both pin it; the Railway build reads the same pins —
  Nixpacks' own default is Node **18**, so the pin is load-bearing, not decorative)
- npm 10+
- Git
- A reachable MongoDB **replica set** (Atlas, or local `docker-compose.dev.yml`) and Redis
- Docker is optional: only needed for the local stack in step 3
- ~4GB RAM, 10GB disk space

### 1. Clone and Setup

```bash
git clone <repository>
cd allinone-backend
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` if needed (defaults work for local development):

```env
APP_ENV=development
DATABASE_URL=mongodb://localhost:27017/allinone_dev
REDIS_URL=redis://localhost:6379
```

That copy-then-run really does boot, and one line is the reason: `.env.example` ships
`APP_ENV=development` (`.env.example:10`), and `development` is the only spelling that puts
the secret gate on the skip path (`src/config/configuration.service.ts:280`, `:439-441`).
The file's `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `ENCRYPTION_KEY` are template
strings the gate knows by name (`:55-59`, `:82`, `:84`, `:142`).

The trap is in what you edit afterwards, not in the copy:

- Leave `APP_ENV=development` and a fresh clone needs no key ceremony — that is the
  promise this quick start makes.
- Clear `APP_ENV`, typo it, or set `staging`/`production`, and the same `.env` aborts the
  boot: `JWT_ACCESS_SECRET is still the value .env.example ships as a template`. Anything
  that is not an explicit `development` or a test run is treated as deployed
  (`src/config/configuration.service.ts:455-466`), so a host that injects
  `NODE_ENV=production` and never names `APP_ENV` gets the strict branch too.
- To exercise the hardened path locally, generate secrets first: `openssl rand -base64 48`
  three times, with the access and refresh secrets different from each other, and set
  `ENCRYPTION_KEY_PREVIOUS` before you ever change `ENCRYPTION_KEY` again
  ([docs/SECURITY.md](docs/SECURITY.md#encryption_key-the-vault-verifier-pepper)).
- `REDIS_URL` is not only a cache address here: with it set, even a development process
  keeps its rate-limit counters in Redis (`src/config/configuration.service.ts:823-831`).
  If Redis is not listening, throttling degrades instead of stopping: the hit is counted in
  this process's own bounded window table (`src/common/throttler/local-throttler.window.ts`),
  so the limit still holds per replica rather than being lifted, and one line per 30 seconds
  says so — `Rate limiting is degraded to this process only:`
  (`src/common/throttler/redis-throttler.storage.ts:116-132`). Start the services in step 3
  before you expect a limit that survives a restart or a second replica.

### 3. Start the Dev Dependencies with Docker

```bash
# MongoDB + Redis (the two the API refuses to boot without)
docker compose -f docker-compose.dev.yml up -d mongodb redis

# optional metrics backends, dev only
docker compose -f docker-compose.dev.yml up -d prometheus grafana
```

This file starts **dependencies only**. The API and the worker are `npm` processes on your
host, started in steps 4-5 — compose builds neither of them any more.

What ends up listening:

- **MongoDB** → localhost:27017 (single-node replica set `rs0`, so transactions work)
- **Redis** → localhost:6379
- **MinIO** → http://localhost:9000 (username/password: `minioadmin`) — start it explicitly
  with `docker compose -f docker-compose.dev.yml up -d minio`
- **Mailpit** → http://localhost:8025 (catch-all SMTP on 1025) — `up -d mailpit`
- **Prometheus** → http://localhost:9090 (dev only; scrapes the host API through
  `host.docker.internal:3000`)
- **Grafana** → http://localhost:3001 (admin/admin)

Docker is not installed on every dev machine, and it is not required: point `DATABASE_URL`
at an Atlas free cluster and `REDIS_URL` at a managed Redis and skip this step entirely.

### 4. Install Dependencies & Run Migrations

```bash
npm install

# Generate Prisma client
npm run db:generate

# Apply the schema (Prisma Migrate does not support the mongodb provider)
npm run db:push
```

### 5. Start Development Server

```bash
npm run start:dev
```

The API will be running at `http://localhost:3000`

API documentation available at: **http://localhost:3000/api**

## Development

### Project Structure

```
allinone-backend/
├── src/
│   ├── app/                 # Application bootstrap
│   ├── auth/                # Authentication (Stage 2)
│   ├── users/               # User management (Stage 2)
│   ├── devices/             # Device management (Stage 2)
│   ├── sync/                # Synchronization (Stage 3)
│   ├── notes/               # Notes module (Stage 4)
│   ├── tasks/               # Tasks module (Stage 5)
│   ├── calendar/            # Calendar module (Stage 6)
│   ├── vault/               # Password manager (Stage 7)
│   ├── search/              # Global search (Stage 7)
│   ├── notifications/       # Notifications (Stage 8)
│   ├── attachments/         # File management (Stage 4+)
│   ├── audit/               # Audit logging (Stage 8)
│   ├── health/              # Health checks ✅
│   ├── config/              # Configuration ✅
│   └── common/              # Shared utilities ✅
│
├── prisma/
│   ├── schema.prisma        # Database schema ✅
│   └── seed.ts              # Test data seeding
│
├── infrastructure/
│   ├── prometheus/          # DEV-ONLY scrape config (prometheus.dev.yml)
│   └── grafana/             # Dashboard provisioning, mounted by the dev stack only
│
├── test/                    # Integration & E2E tests
├── scripts/                 # Backup/restore + worker preflight (see below)
├── docs/                    # Documentation
├── docker-compose.dev.yml   # Local dependencies ✅ (never the deployment)
├── .dockerignore            # Scope of `railway up` / any container build
├── .nvmrc                   # Node 22 — read by Nixpacks and by CI
├── railway.json             # Service #1: the API
├── railway.worker.json      # Service #2: the queue worker (template; Railway does
│                            #   not auto-read this second filename)
├── Procfile                 # web:/worker: record of the same two commands
└── README.md               # This file
```

There is **no** `Dockerfile`, `Dockerfile.worker`, `docker-compose.prod.yml`,
`infrastructure/caddy/Caddyfile` or `prometheus.prod.yml` — commit `1c1cc7d` deleted them when
the deploy moved to Railway. `docs/DEPLOYMENT.md` describes what replaced each of them.

✅ = Implemented in Stage 1

### Environment Variables

[`.env.example`](.env.example) is the reference and it is nearly, but not quite, the
whole list. Six variables are read by `ConfigurationService` and validated in the Joi
schema in `src/app/app.module.ts` without ever appearing in `.env.example`, commented or
otherwise:

| Variable | Read at | Declared only in |
| --- | --- | --- |
| `CORS_ORIGINS` | `src/config/configuration.service.ts:397-401` — inside the wildcard-origin refusal only; there is no `corsOrigins` getter — plus `src/main.ts:44` and `src/sync/adapters/sync-io.adapter.ts:94-105`, which read the variable themselves | `src/app/app.module.ts:152` |
| `JWT_MFA_SECRET` | `src/config/configuration.service.ts:588` | `src/app/app.module.ts:121` |
| `LOG_OUTPUT` | `src/config/configuration.service.ts:846` | `src/app/app.module.ts:195` |
| `GOOGLE_CLIENT_ID` | `src/config/configuration.service.ts:891` | `src/app/app.module.ts:127` |
| `APPLE_CLIENT_ID` | `src/config/configuration.service.ts:899` | `src/app/app.module.ts:128` |
| `MICROSOFT_CLIENT_ID` | `src/config/configuration.service.ts:907` | `src/app/app.module.ts:129` |

`DISABLE_RATE_LIMITING` is a seventh, outside that schema entirely: the guard reads it
straight from `process.env` (`src/common/guards/custom-throttler.guard.ts:12-18`), so
nothing validates it and `.env.example` does not mention it — the documented switch is
`RATE_LIMIT_ENABLED=false` (`.env.example:188`).

Conversely, the names `scripts/backup-database.sh` and `scripts/restore-database.sh` read
(`DATABASE_URL`/`MONGO_URI`, `DB_NAME`, `BACKUP_DIR`, `BACKUP_ENV_FILE`, `BACKUP_PASSPHRASE`,
`RETENTION_DAYS`, and the opt-in flags `OPLOG_WHOLE_SERVER_BACKUP` /
`OPLOG_WHOLE_SERVER_RESTORE`) are **operator inputs**, not `ConfigurationService` getters, so
most of them are absent from `.env.example`. The documented ones are `DB_NAME` and
`BACKUP_ENV_FILE`. `docker-compose.prod.yml`, which used to interpolate a dozen `${VAR:?…}`
deploy secrets, no longer exists: that gate is now Railway's service variables plus the
boot-time refusals in `src/config/configuration.service.ts`.
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) Step 2 lists what a deployed service must set.

**Critical variables:**
- `DATABASE_URL` — MongoDB connection; a deployed boot needs `?replicaSet=rs0`, because the driver will not use transactions without the set name
- `REDIS_URL` — Redis connection, and where the rate-limit counters live; required on every boot that is not `APP_ENV=development` or a test run (`src/config/configuration.service.ts:308-321`)
- `APP_ENV` — `development`, `staging` or `production` (`src/app/app.module.ts:84-86`); only an explicit `development` keeps the secret gate off
- `JWT_ACCESS_SECRET` — Access token secret (generate: `openssl rand -hex 32`)
- `JWT_REFRESH_SECRET` — Refresh token secret (generate separately; the boot refuses one key used for both)
- `ENCRYPTION_KEY` — Data encryption key **and** the vault verifier pepper, min 32 characters and never the shipped template; rotating it is a two-variable operation (`docs/SECURITY.md`)
- `OBJECT_STORAGE_*` — MinIO configuration
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM` — Email configuration

### Scripts

```bash
# Development
npm run start:dev              # Hot reload development server
npm run start:debug           # Debug mode
npm run typecheck             # TypeScript type checking
npm run lint                  # ESLint + fixes

# Database
npm run db:generate           # Generate Prisma client
npm run db:push               # Safe schema apply: snapshot, then Prisma db push
npm run db:migrate            # Alias for the same MongoDB-safe schema apply
npm run db:migrate:deploy     # Deployment alias for the same safe schema apply
npm run db:seed               # Seed test data
npm run db:studio             # Prisma Studio UI

# Testing
npm run test                  # Run unit tests
npm run test:watch           # Watch mode
npm run test:cov             # Coverage report
npm run test:e2e             # End-to-end tests

# The two deployed processes, run locally
npm run build                 # tsc -> dist/main.js + dist/worker.js
npm run start:prod            # API
npm run preflight:worker      # the Redis/dist gate start:worker runs first
npm run start:worker          # preflight && worker

# Docker (local dependencies only — never the deployment)
docker compose -f docker-compose.dev.yml up -d mongodb redis
docker compose -f docker-compose.dev.yml down
docker compose -f docker-compose.dev.yml logs -f mongodb

# Audits
npm run audit                 # everything, high and above
npm run audit:prod            # --omit=dev: what actually ships. CI blocks on this.
```

`docker build` is gone with the Dockerfiles; Railway/Nixpacks builds from the repository and
`.dockerignore` scopes what a `railway up` CLI upload includes.

## Production Deployment

### Architecture

```
                        Internet
                           |
        +------------------+------------------+
        v                                     v
 Cloudflare Workers                     Railway edge
 Flutter web client                     TLS + the ONE
                                        public domain
                                            |
                                            v
                            Railway service #1  API
                            npm run start:prod
                            /health  /metrics  /api
                                  |          |
              +-------------------+          |
              v                              |
   Railway service #2   worker ---------------+
   npm run start:worker
   Bull: mail, notification, export,
   maintenance (hourly cleanup-expired
   prunes plaintext Change.payload)
              |
              +--------------> Managed Redis
                               (Bull queues, rate-limit counters)
                                            |
                                            v
                                   MongoDB Atlas
                                   managed replica set
```

Both services build this same repository with the **same** `DATABASE_URL` and `REDIS_URL`, and
**only the API is given a domain** — the worker binds no port, so attaching a public domain to
it would 503 and, worse, publish a second entry point to the same database. There is no Caddy,
no Nginx and no in-container supervisor: Railway starts exactly one process per service and
restarts it on non-zero exit (`restartPolicyType: ON_FAILURE` in `railway.json` and
`railway.worker.json`).


### Deploy to Railway

There is no `docker-compose.prod.yml`, no `Dockerfile` and no image registry step. Railway
builds from the repository with Nixpacks and reads exactly one config file, `railway.json`,
which starts the API:

```bash
npm i -g @railway/cli && railway login
railway init                     # or railway link an existing project
railway up                       # builds + deploys service #1 (the API)

railway variables set DATABASE_URL=... REDIS_URL=...        # never printed back here
railway variables set JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=... ENCRYPTION_KEY=...
railway variables set APP_ENV=production APP_URL=https://<api-domain>

railway domain                   # ONE service only: the API
railway redeploy
```

Then create service #2 (the worker) from `railway.worker.json` — Railway does not auto-read a
second JSON file, so this is a manual one-time step documented in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Without it nothing consumes the Bull queues and the
hourly `cleanup-expired` job never prunes `Change.payload`, which holds plaintext user content.

Two things a deployed boot refuses (from `src/config/configuration.service.ts`, not from
compose): template-valued `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `ENCRYPTION_KEY` outside
`APP_ENV=development`, and a missing `REDIS_URL`. Generate secrets with
`openssl rand -base64 48`, access and refresh different from each other. `ENCRYPTION_KEY` is
also the vault verifier pepper — rotating it is a two-variable operation with
`ENCRYPTION_KEY_PREVIOUS` (`docs/SECURITY.md`).

**The web client must share one registrable domain with the API.** The refresh cookie is
`SameSite=Strict`; while the client is on `*.workers.dev` and the API on
`*.up.railway.app`, the browser never sends it, so **a web session ends at the 15-minute
access-token expiry**. `docs/DEPLOYMENT.md` Step 3 has the cutover (custom Cloudflare domain +
a Railway domain under the same registrable domain, then delete the two `railway.app`
`connect-src` entries from the Flutter repo's `web/_headers`).

### Schema population is a manual gate

`prisma generate` runs on install (`postinstall`) and only writes a client. **Nothing in the
build or the deploy pushes `prisma/schema.prisma` to Atlas** — no `db:push`, no
`migrate deploy`, and Prisma Migrate cannot use the `mongodb` provider anyway. A new stack
boots against an unpopulated database and fails on the first query. Run it by hand before
serving traffic:

```bash
npm run db:push          # uses DATABASE_URL from your shell, not from Railway
```

Railway's `deploy.preDeployCommand` (a key `railway.json` already supports) is the honest place
to automate this, but it is **not** configured here: it would need `DATABASE_URL` at build time
and would run on every replica. See docs/DEPLOYMENT.md Step 6.

### Backup & Recovery

```bash
# mongodump of ONE database, target taken from DATABASE_URL, credentials never echoed
./scripts/backup-database.sh

# restore that archive into that same database (confirms, then verifies counts)
./scripts/restore-database.sh /opt/allinone-backup/allinone-db-<YYYYMMDD_HHMMSS>.archive.gz

# the whole drill, against a scratch database on a local replica set
npm run test:dr
```

Both scripts print `Target: mongodb://host:27017/allinone_prod` — **no credentials** — and
refuse empty/`admin`/`local`/`config` database names. On Atlas the archive is a per-database
dump; point-in-time recovery is an Atlas cluster feature, not something an archive can
reproduce, so `--oplog`/`--oplogReplay` are reserved behind
`OPLOG_WHOLE_SERVER_BACKUP=true` / `OPLOG_WHOLE_SERVER_RESTORE=true` on a self-hosted replica
set. Full plan: [docs/DISASTER_RECOVERY.md](docs/DISASTER_RECOVERY.md).

### Monitoring

- **There is no production Prometheus.** `prometheus.prod.yml` and the compose scraper were
  deleted with the stack; `infrastructure/prometheus/prometheus.dev.yml` and
  `infrastructure/grafana/**` are dev-only and are started by `docker-compose.dev.yml`.
- **The API's own series** — `GET /metrics` on the Railway origin, behind `MetricsScrapeGuard`.
  It accepts the secret as `Authorization: Bearer <ADMIN_SECRET>` or `x-admin-secret`. Since
  the Railway origin is public, `/metrics` is **internet-reachable and currently scraped by
  nobody**; Railway path restriction cannot be expressed from repo config. Decision and
  options: docs/DEPLOYMENT.md Step 10.
- **Logs** — stdout only: `railway logs --service <api>` and `--service <worker>`;
  `railway.json`'s `restartPolicyType: ON_FAILURE` is what brings a crashed worker back, and
  the worker's own `npm run start:worker` preflight is what stops it silently spinning against
  a missing Redis.

## API Documentation

### Base URL
```
http://localhost:3000/api
```

### Interactive Documentation
Swagger UI available at: `/api`

### Key Endpoints (Implementation Plan)

**Stage 1 — Foundation (✅ In Progress)**
- `GET /health` — Application health
- `GET /health/live` — Liveness probe
- `GET /health/ready` — Readiness probe

**Stage 2 — Identity**
- `POST /auth/register` — User registration
- `POST /auth/login` — User login
- `POST /auth/logout` — User logout
- `GET /users/me` — Current user profile
- `GET /devices` — User devices

**Stage 3 — Sync**
- `POST /sync/push` — Push local changes
- `POST /sync/pull` — Pull remote changes
- `GET /sync/status` — Sync status

**Stage 4+ — Features**
- Notes, Tasks, Calendar, Vault APIs follow similar patterns

### Authentication

Uses JWT bearer tokens:

```bash
curl -H "Authorization: Bearer <access-token>" \
     http://localhost:3000/api/users/me
```

## Testing

```bash
# Unit tests
npm run test

# Integration tests (requires Docker services)
npm run test:integration

# E2E tests (full flow)
npm run test:e2e

# Coverage report
npm run test:cov
```

Run before committing:
```bash
npm run lint && npm run typecheck && npm run test
```

## Security Considerations

- ✅ Strict TypeScript with no `any`
- ✅ JWT tokens with expiration
- ✅ Refresh token rotation
- ✅ Password hashing with Argon2id (Stage 2)
- ✅ Rate limiting on sensitive endpoints
- ✅ Request validation with class-validator
- ✅ Authorization checks on every resource
- ✅ Audit logging of security events
- ✅ Encrypted sensitive fields
- ✅ No secrets in logs
- ✅ CORS configured
- ✅ Security headers (Helmet)
- ✅ SQL injection prevention (Prisma)

**⚠️ Never commit `.env` files with real secrets**

Generate secrets:
```bash
# JWT secrets (run twice for access & refresh)
openssl rand -hex 32

# Encryption key
openssl rand -base64 32
```

## License

MIT — Free for personal and commercial use

## Contributing

Contributions welcome! See [CONTRIBUTING.md](docs/CONTRIBUTING.md)

## Support

- 📚 Documentation → `/docs`
- 🐛 Issues → GitHub Issues
- 💬 Discussions → GitHub Discussions
- 📧 Email → support@allinone.local

## Roadmap

### Stage 1 — Foundation ✅
- [x] Project structure & TypeScript configuration
- [x] NestJS modular architecture
- [x] Database schema & Prisma ORM setup
- [x] Open-API / Swagger documentation
- [x] Docker & Docker Compose setup — dev stack only; the production stack moved to Railway
      (`1c1cc7d`), see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

### Stage 2 — Authentication & Devices (Completed)
- [x] Email/password authentication with Argon2id
- [x] Email verification & password reset flows
- [x] Sessions & JWT token rotation
- [x] Multi-Factor Authentication (TOTP + 10 recovery codes)
- [x] Device management & public key binding
- [x] OAuth 2.0 integrations (Google, Apple, Microsoft)

### Stage 3 — Synchronization & WebSockets (Completed)
- [x] Delta change recording with autoincrement BigInt cursors
- [x] Field-Level Last-Write-Wins (LWW) CRDT Conflict Resolution
- [x] Real-Time WebSocket invalidation broadcasting over Socket.io (`/sync`)
- [x] Client-Side Payload Encryption (E2EE) AES-256-GCM wrappers
- [x] Idempotency interceptor (24h TTL)

### Stage 4-7 — Core Features (Completed)
- [x] Notes & hierarchical folders, version history (`NoteHistory`), tags
- [x] Tasks & projects, Kanban sections, RRULE recurrence, task reminders
- [x] Calendar & events, attendees, RSVP management, date range queries
- [x] Password vault: client-side AES-256-GCM entries synced as `vault_item` oplog changes, master-key unlock, OTP-verified master-password recovery through a phrase-derived envelope the server cannot unwrap (zero-knowledge for the plaintext, with a legacy-row exception — see `docs/SECURITY.md`)

### Stage 8 — Infrastructure & Security Hardening (Completed)
- [x] Redis & BullMQ distributed job processing (`mail`, `notification`, `export`, `maintenance`)
- [x] Prometheus Metrics & Health Dashboards (`GET /metrics` latency histograms & DB connection pool gauges)
- [x] SIEM Structured Audit Logging (`AuditLogService` security event tracking)
- [x] IDOR Security Test Suite (`src/common/testing/idor.spec.ts` 100% passing)

### Stage 9 — Operations & Recovery (Completed)
- [x] Automated database backups & restore scripts (`backup-database.sh`, `restore-database.sh`)
- [x] Disaster Recovery Plan (`docs/DISASTER_RECOVERY.md`)
- [x] Incident Response Playbook (`docs/INCIDENT_RESPONSE.md`)
- [x] Full security checklist audit (`docs/SECURITY.md` 20/20 checked)

---

## 📖 End-to-End Documentation Index

Detailed documentation is available in the [`docs/`](docs/) directory:

- 📚 [**Master Documentation Portal**](docs/README.md)
- 🚀 [**Getting Started Guide**](docs/GETTING_STARTED.md)
- 🏛️ [**System Architecture**](docs/ARCHITECTURE.md)
- 📦 [**Modules & Subsystems Guide**](docs/MODULES_GUIDE.md)
- ⚡ [**API Reference**](docs/API_REFERENCE.md)
- 🗂️ [**Database Schema & Dictionary**](docs/DATABASE_SCHEMA.md)
- 🔒 [**Security Guidelines & Policy**](docs/SECURITY.md)
- 🚢 [**Production Deployment Guide**](docs/DEPLOYMENT.md)
- 💾 [**Disaster Recovery Plan**](docs/DISASTER_RECOVERY.md)
- 🚨 [**Incident Response Plan**](docs/INCIDENT_RESPONSE.md)

---

**Made with ❤️ for privacy-conscious developers**
# AllinOne
# AllinOne
