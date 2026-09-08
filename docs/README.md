# Allinone Backend — Documentation Portal

Welcome to the official documentation portal for **Allinone Backend** — a production-grade, cross-platform personal information management and synchronization platform.

---

## 📚 Technical Documentation Index

| Documentation Guide | Primary Topic & Content Description |
|---------------------|------------------------------------|
| 🚀 [**Getting Started Guide**](GETTING_STARTED.md) | Local development setup, Docker Compose initialization, database migrations, running tests, and environment configurations. |
| 🏛️ [**System Architecture**](ARCHITECTURE.md) | High-level system overview, module boundaries, data flow diagrams, Redis BullMQ queues, Prometheus metrics, and performance targets. |
| 📦 [**Modules & Subsystems Guide**](MODULES_GUIDE.md) | Deep-dive guide covering all 13 NestJS modules (`Auth`, `Users`, `Devices`, `Sync`, `Notes`, `Tasks`, `Calendar`, `Vault`, `Queues`, `AuditLog`, `Metrics`, `Health`, `Prisma`). |
| ⚡ [**API Reference**](API_REFERENCE.md) | Complete REST endpoint specification, WebSocket `/sync` event handlers, request/response DTO schemas, rate limits, headers, and error formats. |
| 🗂️ [**Database Schema & Dictionary**](DATABASE_SCHEMA.md) | Complete Prisma database entity-relationship reference for all 23 models, indexes, cascading deletes, foreign keys, and enums. |
| 🔒 [**Security Policy & Guidelines**](SECURITY.md) | Argon2id hashing, JWT token rotation, TOTP MFA, AES-256-GCM encryption, SIEM audit logging, IDOR security tests, and pre-production checklist. |
| 🚢 [**Production Deployment Guide**](DEPLOYMENT.md) | Step-by-step production deployment instructions via Docker Compose, Caddy reverse proxy, Let's Encrypt SSL/TLS, and environment hardening. |
| 💾 [**Disaster Recovery Plan**](DISASTER_RECOVERY.md) | RTO (< 1h) and RPO (< 24h) objectives, automated PostgreSQL daily backups (`backup-database.sh`), restore steps (`restore-database.sh`), and VM rebuilding. |
| 🚨 [**Incident Response Plan**](INCIDENT_RESPONSE.md) | Incident severity matrix (P1 Critical to P4 Low), 5-phase IR lifecycle, emergency access revocation scripts, and post-mortem templates. |

---

## 🛠️ Quick Command Reference

```bash
# Typecheck TypeScript
npm run typecheck

# Run Linter
npm run lint

# Execute Unit & Security Tests
npm run test

# Compile Production Build
npm run build

# Start Infrastructure Services (Dev)
docker compose -f docker-compose.dev.yml up -d

# Backup Database
./scripts/backup-database.sh

# Restore Database
./scripts/restore-database.sh <backup-file.sql.gz>
```

