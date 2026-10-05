# Allinone Backend — Documentation Portal

Welcome to the official documentation portal for **Allinone Backend** — a production-grade, cross-platform personal information management and synchronization platform.

---

## 📚 Technical Documentation Index

| Documentation Guide                                       | Primary Topic & Content Description                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🚀 [**Getting Started Guide**](GETTING_STARTED.md)        | Local development setup, Docker Compose initialization, `prisma db push` (this project has no `prisma/migrations/` directory), running tests, and environment configuration.                                                                                                                                                                                                                                                                        |
| 🏛️ [**System Architecture**](ARCHITECTURE.md)             | High-level system overview, module boundaries, data flow diagrams, the Bull v4 queue layer (and why no processor runs today), Prometheus metrics, and performance targets.                                                                                                                                                                                                                                                                          |
| 📦 [**Modules & Subsystems Guide**](MODULES_GUIDE.md)     | Deep-dive guide covering 13 of the 25 `@Module` classes in `src/` — `Auth`, `Users`, `Devices`, `Sync`, `Notes`, `Tasks`, `Calendar`, `Vault`, `Queues`, `AuditLog`, `Metrics`, `Health`, `Prisma` — plus cross-cutting guards, interceptors and filters. `Admin`, `Collaboration`, `Ai`, `Passkeys`, `App`, `Worker` and the infrastructure modules (`Configuration`, `Logging`, `Mail`, `Otp`, `Tracing`, `ErrorHandling`) are not covered there. |
| ⚡ [**API Reference**](API_REFERENCE.md)                  | Complete REST endpoint specification, WebSocket `/sync` event handlers, request/response DTO schemas, rate limits, headers, and error formats.                                                                                                                                                                                                                                                                                                      |
| 🗂️ [**Database Schema & Dictionary**](DATABASE_SCHEMA.md) | Complete Prisma reference for all 28 models in `prisma/schema.prisma`, their indexes and enums, plus a cascade matrix that says what each `onDelete` declares and whether any route can actually reach it.                                                                                                                                                                                                                                          |
| 🔒 [**Security Policy & Guidelines**](SECURITY.md)        | Argon2id hashing, JWT token rotation, TOTP MFA, AES-256-GCM encryption, SIEM audit logging, IDOR security tests, and pre-production checklist.                                                                                                                                                                                                                                                                                                      |
| 🚢 [**Production Deployment Guide**](DEPLOYMENT.md)       | Step-by-step production deployment instructions via Docker Compose, Caddy reverse proxy, Let's Encrypt SSL/TLS, and environment hardening.                                                                                                                                                                                                                                                                                                          |
| 💾 [**Disaster Recovery Plan**](DISASTER_RECOVERY.md)     | RTO (< 1h) and RPO (< 24h) objectives. `backup-database.sh` and `restore-database.sh` dump and restore MongoDB via `mongodump`/`mongorestore`, but nothing schedules them — read its "what exists today" notes before trusting a restore.                                                                                                                                                                                                           |
| 🚨 [**Incident Response Plan**](INCIDENT_RESPONSE.md)     | Incident severity matrix (P1 Critical to P4 Low), 5-phase IR lifecycle, the admin endpoints used for access revocation, and post-mortem templates.                                                                                                                                                                                                                                                                                                  |

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

# Backup Database — mongodump archive in /opt/allinone-backup (falls back to .backup/)
./scripts/backup-database.sh

# Restore Database — asks for 'yes', rewrites the archive's collections, verifies counts
./scripts/restore-database.sh /opt/allinone-backup/allinone-db-<YYYYMMDD_HHMMSS>.archive.gz
```
