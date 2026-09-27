# Disaster Recovery & Continuity Plan

This document outlines the Disaster Recovery (DR) and Business Continuity procedures for `Allinone Backend`.

---

## 🎯 Recovery Objectives

- **Recovery Time Objective (RTO)**: **< 1 hour** (Time to restore full core platform services following a catastrophic infrastructure failure).
- **Recovery Point Objective (RPO)**: **< 24 hours** (Maximum acceptable data loss window). Nothing in this repository currently bounds it: there is no working MongoDB backup path and nothing that schedules one, so 24h is a target rather than a delivered property.

---

## 🏗️ Architecture & Infrastructure Resilience

1. **Database Tier**: MongoDB 7.0 (`mongo:7.0`) started as a single-node replica set — `command: ["--replSet", "rs0", "--bind_ip_all"]`, container `allinone-mongodb-prod`, data in the `mongo_data_prod` volume, `restart: unless-stopped`. The replica set exists because the application writes through `prisma.$transaction`; the repository has no second member, no failover or arbiter configuration, and no point-in-time recovery tooling (no oplog archive, no second region, no managed Atlas/RDS/Cloud SQL setup).
2. **Caching & Job Queue Tier**: Redis engine backing BullMQ queues (`mail`, `notification`, `export`, `maintenance`). Re-initializes idempotently upon cluster restart.
3. **Application Tier**: Stateless NestJS API containers running behind Caddy reverse proxy with SSL termination and HSTS enforcement.

---

## 💾 Backup Tooling That Actually Exists

[backup-database.sh](file:///home/swamykrish/Documents/PersonalProject/AllinOne/scripts/backup-database.sh) and [restore-database.sh](file:///home/swamykrish/Documents/PersonalProject/AllinOne/scripts/restore-database.sh) are the only backup artifacts in the repository, and both drive the MongoDB tools. `backup-database.sh` runs `mongodump --db "$DB_NAME" --gzip --archive=…`; `restore-database.sh` runs `mongorestore --gzip --drop --archive=…`. They read `DB_NAME` / `DB_HOST` / `DB_PORT` (defaults `allinone_prod`, `localhost`, `27017`), or `MONGO_URI` when the target is another server — `MONGO_URI` must name the server only, since `--db` is what selects the database. `prisma/schema.prisma` declares `provider = "mongodb"`, and the running database is the `allinone-mongodb-prod` container.

What the backup script does implement, for reference:

- **Output Location**: `$BACKUP_DIR`, which defaults to `/opt/allinone-backup` and falls back to `.backup/` if that path is not writable.
- **File Name**: `allinone-db-YYYYMMDD_HHMMSS.archive.gz`, or `.archive.gz.enc` when `BACKUP_PASSPHRASE` is set.
- **Retention**: `$RETENTION_DAYS` (default `30`), pruning both patterns by modification time.
- **Verification**: a pre-flight collection count that aborts a backup of a database with no collections, `gzip -t` on the produced archive, a decrypt round-trip when encryption is on, and a matching collection count on the restore path.
- **Key custody**: `BACKUP_ENV_FILE` (default `/etc/allinone/backup.env`) is sourced by both scripts at mode 600 or not at all, so no passphrase appears in a crontab or shell history.
- **Secondary copy**: `BACKUP_COPY_DIR` receives a `cmp`-verified copy and is pruned on the same retention clock. It is a location, not a transport — nothing uploads off-host.
- **Scheduling**: none. `BACKUP_ENABLED`, `BACKUP_SCHEDULE=0 2 * * *` and `BACKUP_RETENTION_DAYS=30` are declared in `.env.example`, validated in `src/app/app.module.ts` and exposed by `src/config/configuration.service.ts`, but no code, no compose service and no CI job acts on them (`.github/workflows/ci.yml` is empty). The worker's only repeatable job is the hourly `maintenance` queue in `src/worker.ts`, which is cleanup.

The pre-flight count matters because an empty archive is not otherwise detectable: `mongodump` writes a valid gzipped archive for a database that does not exist, `gzip -t` accepts it, and `mongorestore` exits 0 having restored nothing. The scripts fail on that case instead of reporting success.

> ⚠️ TODO(verify): the scripts are rewritten and can encrypt, and the key no longer has to live in a crontab — but dump schedule, retention window and off-host destination are still the operator's. Note that until a destination exists the ciphertext and `BACKUP_ENV_FILE` sit on the same machine, which defeats the encryption against anyone with disk read access. Also unanswered: a `mongodump` of the `VaultSetting` collection copies every vault's wrapped keys and encrypted payloads, and nothing here says who may run a restore.

---

## 🔄 Disaster Recovery Workflows

### Scenario 1: Database Corruption or Accidental Data Loss

1. **Isolate Database Traffic**: stop the application side of the stack with `docker compose -f docker-compose.prod.yml stop api worker`; `mongodb` stays up so the damage can still be inspected.
2. **Identify The Latest Backup**: `ls -la /opt/allinone-backup/allinone-db-*.archive.gz | tail -n 5`, or `.backup/` if that directory was not writable when the dump ran. `gzip -t` proves only that an archive is readable — the collection count the backup script printed is what shows it holds data this application can use.
3. **Execute Restoration**: `DB_NAME=allinone_prod ./scripts/restore-database.sh <archive>` asks for a literal `yes`, drops and rewrites the collections the archive carries, then fails if `$DB_NAME` still has none. For an `.enc` archive supply the key through `BACKUP_ENV_FILE=/etc/allinone/backup.env` (mode 600) rather than `BACKUP_PASSPHRASE=…` inline; the script refuses an encrypted archive with neither. Keep `api` and `worker` stopped (step 1) until it finishes.
4. **Apply The Schema**: `npm run db:push`. The previous instruction, `npx prisma migrate deploy`, cannot work — the datasource is MongoDB, Prisma Migrate does not support that provider, and the repository has no `prisma/migrations/` directory.
5. **Verify Data Integrity & Restart Services**: `docker compose -f docker-compose.prod.yml up -d api worker`, then `npm run test` and `GET /health`; its `database` entry is a real MongoDB `ping` issued by `PrismaService.checkHealth()`.

---

### Scenario 2: Complete Infrastructure / Host Failure

1. **Provision Replacement Host / VM**: Deploy fresh Linux host (Ubuntu 22.04 LTS / Debian 12).
2. **Clone Code Repository & Load Environment Variables**:
   ```bash
   git clone <repository-url> allinone-backend
   cd allinone-backend
   cp .env.example .env
   ```
   The repository ships no `.env.production.example`, and the copied file's `DATABASE_URL` is the development `mongodb://localhost:27017/allinone_dev` — right scheme, wrong host and database for a production restore: inside the stack, `docker-compose.prod.yml` injects `mongodb://mongodb:27017/${DB_NAME:-allinone_prod}` into `api` and `worker` regardless. `DB_NAME`, `REDIS_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD` and `DOMAIN` are interpolated by that file but absent from `.env.example`.
3. **Restore Database from Off-Site Backup**: no off-site MongoDB backup exists to download — see the TODO in the backup section above — and this repository names no bucket, path or retrieval command for one.
4. **Launch Infrastructure & Application Containers**:
   ```bash
   docker compose -f docker-compose.prod.yml up -d
   ```
   A fresh `mongo_data_prod` volume holds no collections and none of the indexes declared in `prisma/schema.prisma`, so `npm run db:push` has to run before the restored data is usable. It must run from a checkout with dev dependencies installed: the `prisma` CLI is a devDependency and the `api` image is built with `npm ci --omit=dev`.
5. **Validate Public Endpoint Connectivity**:
   ```bash
   curl -I https://$DOMAIN/health
   curl -I https://$DOMAIN/metrics
   ```

---

## 🧪 Disaster Recovery Testing

Disaster recovery drills must be executed semi-annually:

1. Restore the database backup into an isolated environment. There is nowhere to do this today: the repository has no staging compose file, no CI job (`.github/workflows/ci.yml` is empty) and no `allinone_test_dr` database name anywhere outside this document.
2. Run database integrity validation query counts.
3. Validate user authentication, note and task retrieval through `POST /sync/pull`, and a vault unlock: derive the master-key verifier from a known master password and confirm `POST /vault/settings/unlock` accepts it, then open at least one `vault_item` entry client-side.
4. Confirm the restored `VaultSetting` rows still carry `recoveryKey` and `wrappedMasterKey`. They are backed up in plaintext, so a restore that lost them leaves those vaults unrecoverable, and a backup copy is itself a copy of every vault's contents.
