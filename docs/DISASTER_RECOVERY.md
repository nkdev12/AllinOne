# Disaster Recovery & Continuity Plan

This document outlines the Disaster Recovery (DR) and Business Continuity procedures for `Allinone Backend`.

---

## 🎯 Recovery Objectives

- **Recovery Time Objective (RTO)**: **< 1 hour** (Time to restore full core platform services following a catastrophic infrastructure failure).
- **Recovery Point Objective (RPO)**: **< 24 hours** (Maximum acceptable data loss window, bounded by automated daily PostgreSQL backups and WAL archives).

---

## 🏗️ Architecture & Infrastructure Resilience

1. **Database Tier**: PostgreSQL instance managed via Docker container/managed cloud database (RDS/Cloud SQL) with automated daily full backups and point-in-time recovery capabilities.
2. **Caching & Job Queue Tier**: Redis engine backing BullMQ queues (`mail`, `notification`, `export`, `maintenance`). Re-initializes idempotently upon cluster restart.
3. **Application Tier**: Stateless NestJS API containers running behind Caddy reverse proxy with SSL termination and HSTS enforcement.

---

## 💾 Backup Automation & Procedures

### Automated Backups
Database backups are generated daily using [backup-database.sh](file:///home/swamykrish/Documents/PersonalProject/AllinOne/scripts/backup-database.sh).

```bash
# Execute manual or cron database backup
./scripts/backup-database.sh
```

- **Output Location**: `.backup/allinone-db-YYYYMMDD_HHMMSS.sql.gz`
- **Retention Policy**: 30 days (older backups automatically pruned by the script).
- **Verification**: Integrity validated via `gzip -t <backup-file>`.

---

## 🔄 Disaster Recovery Workflows

### Scenario 1: Database Corruption or Accidental Data Loss

1. **Isolate Database Traffic**: Stop web application containers or set reverse proxy to maintenance mode.
2. **Identify Latest Valid Backup**:
   ```bash
   ls -la .backup/allinone-db-*.sql.gz | tail -n 5
   ```
3. **Validate Backup Integrity**:
   ```bash
   gzip -t .backup/allinone-db-YYYYMMDD_HHMMSS.sql.gz
   ```
4. **Execute Restoration Script**:
   ```bash
   ./scripts/restore-database.sh .backup/allinone-db-YYYYMMDD_HHMMSS.sql.gz
   ```
5. **Run Pending Migrations**:
   ```bash
   npx prisma migrate deploy
   ```
6. **Verify Data Integrity & Restart Services**: Run `npm run test` or query endpoint health `/health`.

---

### Scenario 2: Complete Infrastructure / Host Failure

1. **Provision Replacement Host / VM**: Deploy fresh Linux host (Ubuntu 22.04 LTS / Debian 12).
2. **Clone Code Repository & Load Environment Variables**:
   ```bash
   git clone <repository-url> allinone-backend
   cd allinone-backend
   cp .env.production.example .env
   ```
3. **Restore Database from Off-Site Backup**:
   Download latest compressed dump from secure backup storage into `.backup/` and run `./scripts/restore-database.sh`.
4. **Launch Infrastructure & Application Containers**:
   ```bash
   docker compose -f docker-compose.prod.yml up -d
   ```
5. **Validate Public Endpoint Connectivity**:
   ```bash
   curl -I https://$DOMAIN/health
   curl -I https://$DOMAIN/metrics
   ```

---

## 🧪 Disaster Recovery Testing

Disaster recovery drills must be executed semi-annually:
1. Restore database backup into isolated staging environment (`allinone_test_dr`).
2. Run database integrity validation query counts.
3. Validate user authentication, note decryption, task retrieval, and zero-knowledge vault unlock.

