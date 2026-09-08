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
| **Database** | PostgreSQL 16+ | ✅ |
| **Cache & Queues** | Redis + BullMQ | ✅ |
| **Object Storage** | MinIO (S3-compatible) | ✅ |
| **Email** | SMTP (Mailpit for dev) | ✅ |
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
DATABASE_URL=postgresql://allinone:allinone@localhost:5432/allinone_dev
REDIS_URL=redis://localhost:6379
```

### 3. Start Services with Docker

```bash
# Development environment with all services
docker compose -f docker-compose.dev.yml up -d
```

Services running:

- **API** → http://localhost:3000
- **API Docs** → http://localhost:3000/api
- **PostgreSQL** → localhost:5432
- **Redis** → localhost:6379
- **MinIO** → http://localhost:9000 (username/password: `minioadmin`)
- **Mailpit** (email testing) → http://localhost:8025
- **Prometheus** → http://localhost:9090
- **Grafana** → http://localhost:3001 (admin/admin)

### 4. Install Dependencies & Run Migrations

```bash
npm install

# Generate Prisma client
npm run db:generate

# Run database migrations
npm run db:migrate
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
│   ├── migrations/          # Database migrations
│   └── seed.ts              # Test data seeding
│
├── infrastructure/
│   ├── prometheus/          # Metrics configuration
│   ├── grafana/             # Dashboard provisioning
│   ├── caddy/               # Reverse proxy configuration
│   └── postgres/            # Backup scripts
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

All variables are documented in [`.env.example`](.env.example):

**Critical variables:**
- `DATABASE_URL` — PostgreSQL connection
- `REDIS_URL` — Redis connection
- `JWT_ACCESS_SECRET` — Access token secret (generate: `openssl rand -hex 32`)
- `JWT_REFRESH_SECRET` — Refresh token secret (generate: `openssl rand -hex 32`)
- `ENCRYPTION_KEY` — Data encryption key (min 32 chars)
- `OBJECT_STORAGE_*` — MinIO configuration
- `SMTP_*` — Email configuration

### Scripts

```bash
# Development
npm run start:dev              # Hot reload development server
npm run start:debug           # Debug mode
npm run typecheck             # TypeScript type checking
npm run lint                  # ESLint + fixes

# Database
npm run db:generate           # Generate Prisma client
npm run db:migrate            # Create new migration
npm run db:migrate:deploy     # Apply migrations
npm run db:push               # Push schema changes
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
        │ PostgreSQL (Primary DB) │
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

# Key variables to set:
# APP_URL=https://your-domain.com
# DATABASE_URL=postgresql://user:password@postgres:5432/allinone_prod
# JWT_ACCESS_SECRET=<generate: openssl rand -hex 32>
# JWT_REFRESH_SECRET=<generate: openssl rand -hex 32>
# ENCRYPTION_KEY=<generate: openssl rand -base64 32>
# MINIO_ROOT_PASSWORD=<strong-password>
# REDIS_PASSWORD=<strong-password>
# GRAFANA_ADMIN_PASSWORD=<strong-password>

# Start production stack
docker compose up -d

# Run migrations
docker compose exec api npm run db:migrate:deploy

# Verify health
curl https://your-domain.com/api/health
```

### Backup & Recovery

```bash
# Backup database
docker compose exec -T postgres pg_dump -U allinone allinone_prod > backup.sql

# Backup MinIO data
docker compose exec minio mc mirror /data ./backups/minio

# Restore database
docker compose exec -T postgres psql -U allinone allinone_prod < backup.sql

# See docs/disaster-recovery.md for complete procedures
```

### Monitoring

- **Prometheus** — Metrics collection (http://localhost:9090)
- **Grafana** — Dashboards & alerts (http://localhost:3001)
- **Logs** — Docker logs: `docker compose logs -f api`

View API metrics at: `http://your-domain:9090/metrics`

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
- [x] Zero-Knowledge password vault, master key unlock, encrypted items

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
