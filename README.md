# Allinone Backend

> Production-grade backend for Allinone — a cross-platform personal information management system with zero mandatory paid dependencies.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
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

| Component | Technology | Self-Hosted |
|-----------|-----------|------------|
| **Backend** | Node.js + NestJS + TypeScript | ✅ |
| **Database** | MongoDB 7.0 | ✅ |
| **Cache & Queues** | Redis + BullMQ | ✅ |
| **Object Storage** | MinIO (S3-compatible) | ✅ |
| **Email** | SMTP (Gmail supported) | ✅ |
| **Reverse Proxy** | Caddy with auto HTTPS | ✅ |
| **Monitoring** | Prometheus + Grafana | ✅ |
| **Logging** | Structured JSON logs | ✅ |

**No required paid services** — Everything runs locally with Docker.

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Git
- Node.js 20+ (for local development)
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

### 3. Start Services with Docker

```bash
# Development environment with all services
docker compose -f docker-compose.dev.yml up -d
```

Services running:

- **API** → http://localhost:3000
- **API Docs** → http://localhost:3000/api
- **MongoDB** → localhost:27017
- **Redis** → localhost:6379
- **MinIO** → http://localhost:9000 (username/password: `minioadmin`)
- **Prometheus** → http://localhost:9090
- **Grafana** → http://localhost:3001 (admin/admin)

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
│   ├── prometheus/          # Metrics configuration
│   ├── grafana/             # Dashboard provisioning
│   └── caddy/               # Reverse proxy configuration
│
├── test/                    # Integration & E2E tests
├── scripts/                 # Utility scripts
├── docs/                    # Documentation
├── docker-compose.dev.yml   # Development environment ✅
├── docker-compose.prod.yml  # Production environment ✅
├── Dockerfile               # API container ✅
├── Dockerfile.worker        # Worker container ✅
└── README.md               # This file
```

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

Conversely, the names `docker-compose.prod.yml` interpolates (`MONGO_KEYFILE`,
`MONGO_ROOT_*`, `MONGO_APP_*`, `MINIO_ROOT_*`, `REDIS_PASSWORD`, `GRAFANA_ADMIN_*`,
`DOMAIN`, `DB_NAME`, `APP_URL`, the JWT/encryption secrets) are deploy inputs, not
`ConfigurationService` getters; they are absent from `.env.example` and step through the
compose `:?` gate instead. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) Step 2 lists them.

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
npm run db:push               # Apply schema changes — the only one of these that works
npm run db:migrate            # Fails: Prisma Migrate rejects the mongodb provider
npm run db:migrate:deploy     # Same error, same reason
npm run db:seed               # Seed test data
npm run db:studio             # Prisma Studio UI

# Testing
npm run test                  # Run unit tests
npm run test:watch           # Watch mode
npm run test:cov             # Coverage report
npm run test:e2e             # End-to-end tests

# Docker
docker compose -f docker-compose.dev.yml up -d       # Start dev stack
docker compose -f docker-compose.dev.yml down        # Stop dev stack
docker compose -f docker-compose.dev.yml logs -f api # View API logs

# Build & Deploy
npm run build                 # Production build
docker build -t allinone-api:latest .    # Build API image
```

## Production Deployment

### Architecture

```
                    Internet
                       │
                       ▼
                 Caddy/Nginx (HTTPS)
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      API Instances  Workers   Monitoring
          │            │            │
          └──────────┬──┴────────────┘
                     ▼
        ┌─────────────────────────┐
        │ MongoDB (Primary DB)    │
        └─────────────────────────┘
                     │
        ┌─────────────┴──────────────┐
        ▼                           ▼
      Redis               MinIO (S3 Storage)
      Queues              Attachments/Exports
```

### Deploy with Docker Compose

```bash
# Copy production compose file
cp docker-compose.prod.yml docker-compose.yml

# Create .env.prod with your configuration
cp .env.example .env.prod

# Edit with your values
nano .env.prod

# Compose interpolates only from its own environment and from a file named `.env`
# next to the compose file — `.env.prod` is nothing special to it, so either name the
# file `.env`, use `--env-file`, or export the values first.
# See docs/DEPLOYMENT.md Step 6 for the exact commands.

# Variables this stack will not render without (`${VAR:?…}` in
# docker-compose.prod.yml — the deploy fails at `docker compose config` rather than
# starting a service with an empty credential):
# APP_URL=<the public origin the app issues cookies and CORS for>
# DOMAIN=<the hostname Caddy terminates TLS for>
# JWT_ACCESS_SECRET=<generate: openssl rand -base64 48>
# JWT_REFRESH_SECRET=<generate separately; must differ from the access secret>
# ENCRYPTION_KEY=<generate: openssl rand -base64 48 — also the vault verifier pepper>
# MONGO_KEYFILE=<host path to the replica-set keyFile>
# MONGO_ROOT_USERNAME / MONGO_ROOT_PASSWORD
# MONGO_APP_USERNAME / MONGO_APP_PASSWORD
# REDIS_PASSWORD=<strong-password>
# MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
# GRAFANA_ADMIN_PASSWORD=<strong-password>
# Optional, with defaults: DB_NAME (=allinone_prod), GRAFANA_ADMIN_USER (=admin),
# and ENCRYPTION_KEY_ID / ENCRYPTION_KEY_PREVIOUS / ENCRYPTION_KEY_PREVIOUS_ID, which
# are blank in the steady state and only filled during a rotation window.
# DATABASE_URL and REDIS_URL are built for `api` and `worker` by the compose file from
# the credentials above — including `?replicaSet=rs0&authSource=admin`, which the driver
# needs for transactions — so setting them here changes nothing inside the stack.

# The web app must live under the same registrable domain as this API, or the
# `SameSite=strict` refresh cookie never arrives (docs/DEPLOYMENT.md, Step 2).

# Start production stack
docker compose up -d

# Apply the schema — docs/DEPLOYMENT.md Step 6: no database port is published any more,
# so a host-side `npm run db:push` no longer has a path to the replica set.

# Verify health (there is no global API prefix: `/api` is Swagger, the health route is
# `/health` — src/main.ts:164, src/health/health.controller.ts:11)
curl https://your-domain.com/health
```

### Backup & Recovery

```bash
# Backup database (mongodump archive, timestamped)
./scripts/backup-database.sh

# Backup MinIO data
docker compose exec minio mc mirror /data ./backups/minio

# Restore database (asks for confirmation, then verifies collection counts)
./scripts/restore-database.sh /opt/allinone-backup/allinone-db-<YYYYMMDD_HHMMSS>.archive.gz

# See docs/disaster-recovery.md for complete procedures
```

### Monitoring

- **Prometheus** — scrapes `api:3000/metrics` on the compose network with the
  `ADMIN_SECRET` bearer in `/run/secrets/metrics_scrape_secret`. The service publishes no
  port (`docker-compose.prod.yml:382-412`), so read it through a Caddy reverse proxy or
  `docker exec` — not `http://localhost:9090`.
- **Grafana** — production serves it under `https://$DOMAIN/grafana`
  (`docker-compose.prod.yml:436`) with the `GRAFANA_ADMIN_PASSWORD` you set, development
  publishes `http://localhost:3001` with `admin`/`admin`.
- **The API's own series** — `GET /metrics` on the API origin, behind `MetricsScrapeGuard`,
  so an anonymous curl is a `401` (docs/DEPLOYMENT.md Step 10 has both credentials).
- **Logs** — stdout only: `docker compose -f docker-compose.prod.yml logs -f api`

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
- [x] Docker & Docker Compose setup

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
