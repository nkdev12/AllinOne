# Disaster Recovery & Continuity Plan

This document outlines the Disaster Recovery (DR) and Business Continuity procedures for `Allinone Backend`.

---

## 🎯 Recovery Objectives

- **Recovery Time Objective (RTO)**: **< 1 hour** (Time to restore full core platform services following a catastrophic infrastructure failure).
- **Recovery Point Objective (RPO)**: **< 24 hours** (Maximum acceptable data loss window), bounded by the daily backup schedule and point-in-time replica set oplog snapshots.

---

## 🏗️ Architecture & Infrastructure Resilience

1. **Database Tier**: MongoDB 7.0 (`mongo:7.0`) running as a replica set (`rs0`) — `command: ["--replSet", "rs0", "--bind_ip_all"]`, container `allinone-mongodb-prod`, data in the `mongo_data_prod` volume, `restart: unless-stopped`. The replica set enables interactive transactions (`prisma.$transaction`) and produces the oplog stream required for point-in-time snapshots.
2. **Object Storage Tier**: MinIO (`minio/minio:latest`) storing encrypted attachments and user export archives in the `allinone-prod` bucket (backed by `minio_data_prod` volume).
3. **Caching & Job Queue Tier**: Redis engine backing BullMQ queues (`mail`, `notification`, `export`, `maintenance`). Re-initializes idempotently upon cluster restart.
4. **Application Tier**: Stateless NestJS API containers running behind Caddy reverse proxy with SSL termination and HSTS enforcement.

---

## 💾 Backup Tooling & Implementation

[backup-database.sh](file:///home/swamykrish/Documents/PersonalProject/AllinOne/scripts/backup-database.sh) and [restore-database.sh](file:///home/swamykrish/Documents/PersonalProject/AllinOne/scripts/restore-database.sh) provide comprehensive, transaction-consistent backups and restores:

- **Transaction Consistency & Point-in-Time Snapshots**:
  `backup-database.sh` runs `mongodump --uri "$MONGO_URI" --oplog --gzip --archive=…`. The `--oplog` flag captures every write that occurs during the dump across all collections. On restore, `restore-database.sh` automatically detects the oplog and applies `--oplogReplay --drop`, restoring the exact point-in-time state. This completely prevents multi-collection desynchronization between `Change` log entries and `SyncCursor` counters.
- **MinIO Object Storage Backup & Recovery**:
  `backup-database.sh` packages MinIO bucket data (attachments and exports) from the container volume (`minio_data_prod`) or data directory into `allinone-minio-YYYYMMDD_HHMMSS.tar.gz`. Integrity is verified with `tar -tzf`. On restore, `restore-database.sh` decrypts, verifies, and restores the MinIO archive into the volume or directory, ensuring attachments and user exports are never lost.
- **Output Location**: `$BACKUP_DIR`, which defaults to `/opt/allinone-backup` and falls back to `.backup/` if that path is not writable.
- **File Names**:
  - Database: `allinone-db-YYYYMMDD_HHMMSS.archive.gz[.enc]`
  - MinIO: `allinone-minio-YYYYMMDD_HHMMSS.tar.gz[.enc]`
  - Manifest: `allinone-manifest-YYYYMMDD_HHMMSS.json`
- **Retention**: `$RETENTION_DAYS` (default `30`), pruning database dumps, MinIO archives, and manifests by modification time.
- **Archive Verification**:
  1. Gzip stream check: `gzip -t`.
  2. Oplog replayability check: `mongorestore --dryRun --oplogReplay`.
  3. MinIO tar integrity check: `tar -tzf`.
  4. Encryption round-trip test: AES-256-CBC PBKDF2 decryption piped into integrity checks.
- **Key Custody**: `BACKUP_ENV_FILE` (default `/etc/allinone/backup.env`) is sourced by both scripts at mode 600 or not at all, so no passphrase appears in a crontab or shell history.
- **Post-Restore Invariant Verification & Reconciliation**:
  After database restoration, `restore-database.sh` verifies collection counts, user counts, and checks that `SyncCursor.seq >= max(Change.cursor)` for every user. Any discrepancy from legacy or corrupted dumps is automatically reconciled to prevent silent sync loss.

---

## 🔄 Disaster Recovery Workflows

### Scenario 1: Database Corruption or Accidental Data Loss

1. **Isolate Database Traffic**: Stop application services:
   ```bash
   docker compose -f docker-compose.prod.yml stop api worker
   ```
2. **Identify The Latest Backup**:
   ```bash
   ls -la /opt/allinone-backup/allinone-db-*.archive.gz* | tail -n 5
   ```
3. **Execute Restoration**:
   ```bash
   DB_NAME=allinone_prod ./scripts/restore-database.sh /opt/allinone-backup/allinone-db-<TIMESTAMP>.archive.gz.enc
   ```
   For encrypted backups, ensure `BACKUP_ENV_FILE=/etc/allinone/backup.env` (mode 600) contains `BACKUP_PASSPHRASE=…`. The restore script automatically identifies and restores the matching `allinone-minio-<TIMESTAMP>.tar.gz.enc` file.
4. **Apply Schema & Indexes**:
   ```bash
   npm run db:push
   ```
5. **Verify Data Integrity & Restart Services**:
   ```bash
   docker compose -f docker-compose.prod.yml up -d api worker
   curl https://$DOMAIN/health/ready
   ```

---

### Scenario 2: Complete Infrastructure / Host Failure

1. **Provision Replacement Host / VM**: Deploy fresh Linux host (Ubuntu 22.04 LTS / Debian 12 / Fedora).
2. **Clone Code Repository & Load Environment Variables**:
   ```bash
   git clone <repository-url> allinone-backend
   cd allinone-backend
   cp .env.example .env.prod
   ```
3. **Restore Database & Storage from Backup**:
   Retrieve the latest backup archive pair (`allinone-db-*.archive.gz.enc` and `allinone-minio-*.tar.gz.enc`) from remote storage, then execute:
   ```bash
   BACKUP_PASSPHRASE="<passphrase>" ./scripts/restore-database.sh /path/to/allinone-db-<TIMESTAMP>.archive.gz.enc
   ```
4. **Launch Infrastructure & Application Containers**:
   ```bash
   docker compose -f docker-compose.prod.yml up -d
   npm run db:push
   ```
5. **Validate Public Endpoint Connectivity**:
   ```bash
   curl -I https://$DOMAIN/health/live
   curl -I https://$DOMAIN/metrics
   ```

---

## 🧪 Disaster Recovery Testing

Automated DR testing is integrated into the test suite and can be executed at any time:

```bash
# Run full automated DR and restore verification script:
npm run test:backup
# or:
npm run test:dr
```

This automated drill:
1. Provisions an isolated test database (`allinone_dr_test_db`) on the local MongoDB replica set.
2. Seeds relational entities, user profiles, zero-knowledge vault settings, change logs, and sync cursors.
3. Seeds MinIO mock storage attachments and export files with known checksums.
4. Executes `scripts/backup-database.sh` with AES-256-CBC encryption and oplog snapshotting.
5. Simulates disaster: writes unwanted post-backup notes, corrupts sync cursors, deletes MinIO attachments.
6. Asserts rejection of corrupted passphrases.
7. Executes `scripts/restore-database.sh` with clean extraction.
8. Asserts that post-backup writes are rolled back, `SyncCursor.seq` matches `Change.cursor` with zero drift, `VaultSetting` wrapped keys and recovery keys remain intact, and MinIO attachments match original SHA256 checksums.
9. Cleans up test databases and temporary directories.
