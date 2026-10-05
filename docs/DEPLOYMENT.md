# Allinone Backend — Production Deployment Guide

This guide walks through deploying Allinone to production.

> [!NOTE]
> **Implementation & Maturity Status**:
> Stages 1 through 7 (Core Architecture, Authentication & Admin RBAC, Real-time Delta Sync, Notes, Tasks, Calendar, and Zero-Knowledge Vault) are fully implemented and verified with automated test suites. This document serves as the operational guide for staging and production deployments.

## Pre-Deployment Checklist

### Application

- [ ] All tests passing (`npm run test`)
- [ ] Unit tests passing (`npm test`)
- [ ] End-to-end tests passing (`npm run test:e2e`)
- [ ] Type checking passes (`npm run typecheck`)
- [ ] Linting passes (`npm run lint`)
- [ ] Security audit done (`npm audit`)
- [ ] Security audit passed (`npm run audit` or `npm audit --audit-level=high`)
- [ ] Load & performance tests verified (`npm run test:load:sync`, `npm run test:load:auth`)
- [ ] Dependencies updated (`npm update`)
- [ ] Build succeeds (`npm run build`)
- [ ] Docker images build (`docker build`)

### Infrastructure

- [ ] Domain name configured
- [ ] SSL certificate ready (or using Let's Encrypt)
- [ ] Database backup solution planned
- [ ] Monitoring setup (Prometheus/Grafana)
- [ ] Log aggregation setup (optional)
- [ ] Disaster recovery plan documented
- [ ] Incident response plan ready

### Secrets & Security

- [ ] Generate new JWT secrets: `openssl rand -hex 32`
- [ ] Generate encryption key: `openssl rand -base64 32`
- [ ] Set strong database password (note: MongoDB authentication is not enabled in `docker-compose.prod.yml` today — see Step 3)
- [ ] Set strong Redis password
- [ ] Set strong MinIO credentials
- [ ] Set strong Grafana admin password
- [ ] SSL/TLS certificates ready
- [ ] All secrets in secrets manager (not .env)

## Infrastructure Requirements

### Minimum Specifications

- **CPU**: 2 cores
- **RAM**: 4GB
- **Storage**: 20GB
- **Network**: 100 Mbps

### Recommended Specifications

- **CPU**: 4 cores
- **RAM**: 8GB
- **Storage**: 100GB (SSD preferred)
- **Network**: 1 Gbps

### Supported Platforms

- **VPS** — DigitalOcean, Linode, Vultr, AWS EC2, etc.
- **Dedicated Server** — Any Linux with Docker support
- **Cloud** — AWS, Azure, GCP (using self-hosted stack)
- **Home Lab** — NAS, Raspberry Pi (Pi 4+ recommended)

## Step 1: Prepare Server

### Install Docker

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Add user to docker group
sudo usermod -aG docker $USER
newgrp docker
```

### Install Docker Compose

```bash
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" \
  -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose
```

### Clone Repository

```bash
cd /opt
git clone https://github.com/yourusername/allinone-backend.git
cd allinone-backend
```

## Step 2: Configure Environment

### Create Production Environment File

```bash
cp .env.example .env.prod
nano .env.prod
```

### Required Configuration

```env
# Application
APP_ENV=production
APP_URL=https://your-domain.com
APP_PORT=3000

# Database (MongoDB - the datasource provider in prisma/schema.prisma is "mongodb")
DATABASE_URL=mongodb://mongodb:27017/allinone_prod

# Redis
REDIS_URL=redis://:STRONG_PASSWORD@redis:6379

# JWT (generate: openssl rand -hex 32)
JWT_ACCESS_SECRET=your-hex-32-char-secret
JWT_REFRESH_SECRET=your-hex-32-char-secret

# Object Storage (MinIO)
OBJECT_STORAGE_ENDPOINT=http://minio:9000
OBJECT_STORAGE_BUCKET=allinone-prod
OBJECT_STORAGE_ACCESS_KEY=minioadmin
OBJECT_STORAGE_SECRET_KEY=STRONG_PASSWORD

# SMTP (your mail server)
SMTP_HOST=mail.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASSWORD=STRONG_PASSWORD
SMTP_FROM=noreply@example.com
SMTP_TLS=true

# Encryption (generate: openssl rand -base64 32)
ENCRYPTION_KEY=your-base64-encryption-key

# Cross-origin policy — two lists, two handshakes
# CORS_ORIGIN is the HTTP API's; the WS_ keys are the /sync namespace's.
# Unset, the socket falls back to CORS_ORIGINS then CORS_ORIGIN then
# http://localhost:3000, so a configured API list is not silently left wide open.
CORS_ORIGIN=https://your-domain.com
# WS_CORS_ORIGINS=https://app.your-domain.com
# WS_CORS_ALLOW_NULL_ORIGIN=false   # WebView clients only; logs that it was opened
# WS_REDIS_ADAPTER=true             # clustering is attempted when REDIS_URL is set;
                                   # false pins a replica to in-process rooms

# Token lifetimes (defaults shown; both are honoured since 2026-09-27)
# JWT_ACCESS_EXPIRATION=15m
# JWT_REFRESH_EXPIRATION=7d
# Accept s/m/h/d or a bare number of seconds — "1h", "2 days", "900". There is no
# "w": a value the parser cannot read aborts the boot rather than surfacing as a
# 500 on someone's first sign-in.

# Admin access — NOTHING in this file's default state admits anyone to /admin
# Since 2026-09-27 there is no default admin email list and no role fallback, so
# set at least one of these three or the admin API has no working caller. Prefer
# ADMIN_USER_IDS: an email is claimable by whoever registers it first, because
# registration does not verify the address.
# ADMIN_USER_IDS=<the User.id you control>
# ADMIN_EMAILS=<a registered, verified address>
# ADMIN_SECRET= at least 32 characters, sent as the x-admin-secret header. It
#               escalates an already-authenticated request only and cannot stand
#               in for a session; shorter values are treated as unset.

# AI (optional; unset leaves /ai on its deterministic heuristics)
# GEMINI_API_KEY=
# GEMINI_MODEL=gemini-1.5-flash
# GEMINI_TIMEOUT_MS=5000

# Monitoring
GRAFANA_ADMIN_PASSWORD=STRONG_PASSWORD

# Domain for Caddy
DOMAIN=your-domain.com
```

Two things the compose file makes visible:

- The `api` and `worker` services receive `DATABASE_URL` and `REDIS_URL` from `docker-compose.prod.yml` itself (`mongodb://mongodb:27017/${DB_NAME:-allinone_prod}` and `redis://:${REDIS_PASSWORD}@redis:6379`), so those two keys in `.env.prod` only apply when you run the process outside the stack.
- `docker-compose.prod.yml` interpolates `DB_NAME`, `REDIS_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD` and `DOMAIN`, none of which appear in the committed `.env.example`. Add them to `.env.prod` or Compose silently substitutes empty values (Redis starts with `--requirepass` and the API cannot authenticate).

### Store .env.prod Securely

Never commit to version control:

```bash
# Add to .gitignore
echo ".env.prod" >> .gitignore

# Restrict permissions
chmod 600 .env.prod

# Consider using a secrets manager:
# - HashiCorp Vault
# - AWS Secrets Manager
# - Azure Key Vault
# - Environment variables from CI/CD
```

## Step 3: Prepare Database

### Create Database User (Optional)

No manual database creation is needed: MongoDB creates `allinone_prod` on first write, and `npm run db:push` creates the collections and the indexes declared as `@@index` in `prisma/schema.prisma`.

As committed, `docker-compose.prod.yml` starts `mongod` with `["--replSet", "rs0", "--bind_ip_all"]` and publishes `27017:27017`. The single-node replica set `rs0` (initiated by the service's healthcheck) is required because the services that write through `prisma.$transaction` (`auth`, `users`, `devices`, `sync`, `notes`, `tasks`) cannot run against a standalone `mongod`.

There is no `MONGO_INITDB_ROOT_USERNAME`/`MONGO_INITDB_ROOT_PASSWORD` in either compose file, so there is currently no database user to create: connections inside the `allinone-prod` network are unauthenticated.

> ⚠️ TODO(verify): whether this deployment enables MongoDB authentication, TLS and host binding for `27017`, and where those credentials live — the repository configures none of them.

### Enable SSL (Optional but Recommended)

Nothing to run yet: no MongoDB TLS options appear in `docker-compose.prod.yml`, and no `tls*` connection parameters exist in `.env.example` or the validation schema in `src/app/app.module.ts`. This is covered by the TODO above.

## Step 4: Build Docker Images

```bash
# Build API image
docker build -t allinone-api:latest .

# Build Worker image
docker build -f Dockerfile.worker -t allinone-worker:latest .

# Optional: Push to registry
docker tag allinone-api:latest your-registry/allinone-api:latest
docker push your-registry/allinone-api:latest
```

## Step 5: Configure Reverse Proxy

### Using Caddy (Recommended)

The committed `infrastructure/caddy/Caddyfile`, mounted read-only into the `allinone-caddy-prod` container:

```
{$DOMAIN} {
  reverse_proxy /api/* api:3000
  reverse_proxy / api:3000

  # Security headers
  header / Strict-Transport-Security "max-age=31536000; includeSubDomains"
  header / X-Content-Type-Options "nosniff"
  header / X-Frame-Options "DENY"
  header / X-XSS-Protection "1; mode=block"
  header / Referrer-Policy "strict-origin-when-cross-origin"

  # Compression
  encode gzip

  # Logging
  log {
    output stdout
    format json
  }
}

# Optional: Grafana access (if you want to expose it)
# {$DOMAIN}:3001 {
#   reverse_proxy grafana:3000
#   encode gzip
# }
```

`DOMAIN` comes from the environment, and Caddy automatically obtains SSL certificates from Let's Encrypt!

Note: no route in the active Caddyfile proxies `/grafana`, but `docker-compose.prod.yml` still sets the container's `GF_SERVER_ROOT_URL=https://${DOMAIN}/grafana`; until the commented block above is enabled (or the variable changed), Grafana is only reachable on the published port `3001`.

### Using Nginx (Alternative)

The repository ships no nginx configuration: `infrastructure/` contains only `caddy/`, `grafana/` and `prometheus/`.

## Step 6: Start Production Stack

```bash
# Load environment from .env.prod
# (docker compose interpolates only from its own environment and from ./.env, so the
#  ${...} values in docker-compose.prod.yml are empty until these are exported)
export $(cat .env.prod | xargs)

# Start services (attached to see logs)
docker compose -f docker-compose.prod.yml up

# Or run in background
docker compose -f docker-compose.prod.yml up -d
```

### Wait for Services to Start

```bash
# Check status
docker compose -f docker-compose.prod.yml ps

# Watch logs
docker compose -f docker-compose.prod.yml logs -f

# Verify database connectivity (the service is named mongodb; mongosh ships in the mongo:7.0 image and is also what the service healthcheck calls)
docker compose -f docker-compose.prod.yml exec mongodb mongosh --eval "db.adminCommand('ping')"
```

### Apply the Prisma schema

```bash
# Run from a checkout with dev dependencies installed. The prisma CLI is a devDependency
# and the api image is built with `npm ci --omit=dev`, so it is not present in the container;
# docker-compose.prod.yml publishes 27017, so a host-side push reaches the same database.
npm run db:push

# Verify the collections exist
docker compose -f docker-compose.prod.yml exec mongodb mongosh \
  --eval "db.getSiblingDB('allinone_prod').getCollectionNames()"
```

`prisma/schema.prisma` declares `provider = "mongodb"`, there is no `prisma/migrations/` directory (it is listed in `.gitignore`), and Prisma Migrate does not support the MongoDB connector. The `db:migrate` and `db:migrate:deploy` scripts in `package.json` therefore have no role in this flow; `db:push` is the supported path.

### Seed Initial Data (Optional)

```bash
# From a dev checkout: npm run db:seed shells out to ts-node, which is also a devDependency
npm run db:seed
```

`prisma/seed.ts` is currently a stub that logs and returns without inserting anything, so this step is a no-op until sample data is written.

## Step 7: Verify Deployment

### Health Checks

```bash
# Overall application health
curl https://your-domain.com/health

# Expected response (Terminus shape):
# {
#   "status": "ok",
#   "info": {
#     "database": { "status": "up", "latency": 5 },
#     "redis": { "status": "up" }
#   },
#   "error": {},
#   "details": {
#     "database": { "status": "up", "latency": 5 },
#     "redis": { "status": "up" }
#   }
# }

# Readiness probe
curl https://your-domain.com/health/ready

# Liveness probe
curl https://your-domain.com/health/live

# Distributed tracing & W3C TraceContext verification
curl -i https://your-domain.com/health/live
# Expected response headers:
# x-trace-id: <32-hex-trace-id>
# traceparent: 00-<32-hex-trace-id>-<16-hex-span-id>-01
```

### API Access

```bash
# Test API / Swagger UI
curl https://your-domain.com/api

# Open Swagger documentation in browser
# Visit: https://your-domain.com/api
```

### Monitoring

```bash
# Access Prometheus
# Visit: http://your-domain:9090

# Access Grafana
# Visit: http://your-domain:3001
# Default credentials: admin / your-password

# View metrics
curl https://your-domain.com/metrics
```

## Step 8: Set Up Backups

### What the repository actually provides

`scripts/backup-database.sh` and `scripts/restore-database.sh` provide transaction-consistent database backups and MinIO object storage backups. `backup-database.sh` runs `mongodump --oplog --gzip --archive=…` across the replica set, capturing in-flight transactions so that `Change` rows and `SyncCursor` counters remain strictly synchronized with zero cursor drift. It simultaneously archives MinIO object storage (`allinone-minio-<timestamp>.tar.gz`) from the data volume or directory, verifying integrity with `tar -tzf`.

`restore-database.sh` automatically replays the oplog (`mongorestore --oplogReplay --drop`), restores MinIO attachments and exports, and executes an automated post-restore sync invariant check that aligns `SyncCursor.seq` with the highest `Change.cursor` to prevent silent sync loss.

With `BACKUP_PASSPHRASE` set, both archives are AES-256-CBC encrypted (openssl, PBKDF2 with 100k iterations) to `.archive.gz.enc` and `.tar.gz.enc`, and the plaintext dumps are securely removed.

Automated disaster recovery drills can be executed anytime via:
```bash
npm run test:backup
```

Neither script invents a destination. `BACKUP_COPY_DIR` is an optional second location: the finished archives are copied there and verified with `cmp`, and the retention sweep prunes that directory on the same clock. A second directory on the same volume is not off-host storage.

### Scheduling It

Nothing installs a schedule. Both scripts read `BACKUP_ENV_FILE` (default `/etc/allinone/backup.env`) before anything else and refuse the file unless it carries no group or other bits, so the cron line names no secret:

```cron
# crontab -e on the Docker host
0 2 * * * cd /opt/allinone-backend && DB_NAME=allinone_prod ./scripts/backup-database.sh >> /var/log/allinone-backup.log 2>&1
```

with `/etc/allinone/backup.env` holding `BACKUP_PASSPHRASE=…` at mode 600. The file is sourced with `set -a` because openssl reads the passphrase from the _environment_ — a plain source would define a shell variable and the encryption step would fail.

What is still unwritten is transport: there is no S3, `rclone` or `mc` upload step, so an off-host copy means a mount that `BACKUP_COPY_DIR` points at, or a transfer job you schedule yourself. A volume snapshot is a different layer, not a substitute: tarring `mongo_data_prod` while `mongod` is writing gives a copy that is not crash-consistent, which is why the logical dump is the documented path. Snapshot the whole filesystem from the host or hypervisor if you want point-in-time recovery, and treat a restored volume as needing the same verification as a restore from the dump.

There is also no automation: `BACKUP_ENABLED`, `BACKUP_SCHEDULE=0 2 * * *` and `BACKUP_RETENTION_DAYS=30` are declared in `.env.example`, validated in `src/app/app.module.ts` and exposed by `src/config/configuration.service.ts`, but nothing in `src/` reads them. The only recurring job the worker registers is the hourly `maintenance` queue job in `src/worker.ts`, which performs cleanup, not backup. `scripts/` contains no cron entry, `docker-compose.prod.yml` has no backup sidecar, and `.github/workflows/ci.yml` is empty.

> ⚠️ TODO(verify): the scripts dump, encrypt and restore MongoDB and keep the passphrase out of the crontab, but two choices remain — whether `mongo_data_prod` and `minio_data_prod` are snapshotted as a second layer, and which off-host location receives the dumps. Until that second location exists, ciphertext and key share one host: `BACKUP_ENV_FILE` guards against `crontab -l` and shell history, not against a reader of the whole disk.

## Step 9: Monitoring & Logging

### View Logs

```bash
# Recent logs
docker compose -f docker-compose.prod.yml logs --tail=100 api

# Follow logs
docker compose -f docker-compose.prod.yml logs -f api

# Filter by service
docker compose -f docker-compose.prod.yml logs mongodb
docker compose -f docker-compose.prod.yml logs redis
```

### Set Up Log Aggregation (Optional)

Use Loki + Grafana for centralized logging:

```yaml
# docker-compose.prod.yml addition
loki:
  image: grafana/loki:latest
  ports:
    - "3100:3100"
  volumes:
    - ./infrastructure/loki/loki-config.yml:/etc/loki/local-config.yaml
```

### Monitoring Dashboard

Access Grafana at `http://your-domain:3001`:

1. Add Prometheus as datasource
2. Import pre-built dashboards
3. Set up alerts

## Step 10: Security Hardening

### Firewall Rules

```bash
# UFW on Ubuntu
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 80/tcp      # HTTP
sudo ufw allow 443/tcp     # HTTPS
sudo ufw enable
```

### SSL/TLS Certificates

Caddy automatically renews Let's Encrypt certificates. Verify:

```bash
# Check certificate expiration
openssl s_client -connect your-domain.com:443 2>&1 | grep "Expire"
```

### Database Security

`docker-compose.prod.yml` publishes MongoDB as `"27017:27017"` on every host interface and starts `mongod` with `--bind_ip_all` and no authentication (see Step 3). Nothing in the repository restricts that port or enables TLS for it; the UFW example above allows only `22`, `80` and `443`, but the firewall is not part of this stack and Docker's published ports are not guaranteed to be filtered by it.

> ⚠️ TODO(verify): whether to drop the `ports:` mapping so MongoDB stays reachable only on the `allinone-prod` network, or bind it to `127.0.0.1` — the compose file does neither today.

### Redis Security

```bash
# Require password
redis:
  command: redis-server --requirepass $REDIS_PASSWORD
```

## Step 11: Performance Tuning

### Database Optimization

Indexes live in the schema, not in SQL: `prisma/schema.prisma` declares 52 `@@index` blocks (for example `Note` has `@@index([userId])`, `@@index([folderId])`, `@@index([updatedAt])`) plus `@@unique` composites, and `npm run db:push` creates them on the MongoDB collections. Relational query-tuning tools (`ANALYZE`, `CREATE INDEX`, `pg_stat_user_indexes`) have no counterpart here, and no MongoDB equivalent (profiler, index-usage report) is configured in the repository.

> ⚠️ TODO(verify): how slow database operations will be surfaced — neither compose file passes profiler or slow-query settings to `mongod`, so the only database log today is what `mongod` writes to `docker compose -f docker-compose.prod.yml logs mongodb`.

Request latency is instrumented in the application instead: `src/common/metrics/metrics.service.ts` renders `http_request_duration_seconds` histograms, scraped from `GET /metrics` by the `allinone-api` job in `infrastructure/prometheus/prometheus.prod.yml`.

### Memory Configuration

```bash
# MongoDB: docker-compose.prod.yml passes no memory flags to mongodb; mongo:7.0 runs with its
# defaults and keeps data in the mongo_data_prod volume.

# Redis (prod): the committed command is
#   redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}
# and sets no maxmemory or eviction policy.

# API container: neither api nor worker declares a resources: block; worker does set
# deploy.replicas: 2.
```

### Connection Pooling

```yaml
# In .env.prod — the same URL docker-compose.prod.yml injects into api and worker:
DATABASE_URL=mongodb://mongodb:27017/allinone_prod
```

`?schema=public&pool=20` were relational-connector parameters and mean nothing to the MongoDB connector. `src/common/prisma/prisma.service.ts` constructs `PrismaClient` with no options, so connection behaviour is whatever the MongoDB driver defaults to; the repository tunes nothing here.

## Troubleshooting

### API won't start

```bash
# Check logs
docker compose -f docker-compose.prod.yml logs api

# Common issues:
# - DATABASE_URL missing or wrong
# - JWT_ACCESS_SECRET not set
# - Port 3000 already in use
# - Insufficient disk space
```

### Database connection fails

```bash
# Test connection
docker compose -f docker-compose.prod.yml exec mongodb mongosh \
  --eval "db.adminCommand('ping')"

# Confirm the replica set the API depends on is initiated
docker compose -f docker-compose.prod.yml exec mongodb mongosh --eval "rs.status()"

# mongod's own output
docker compose -f docker-compose.prod.yml logs mongodb
```

`api` and `worker` wait on the mongodb healthcheck, and that same healthcheck runs `rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})` when the set does not exist yet, so a stack started with `down -v` re-initializes it on the next `up`.

### Out of memory

```bash
# Check memory usage
docker stats

# Increase container memory in docker-compose.prod.yml
# or reboot and clear caches
```

### Slow queries

There is no slow-query setting to toggle in this repository: `mongod` is started with the flags in `docker-compose.prod.yml` only, and its output goes to the container log.

```bash
docker compose -f docker-compose.prod.yml logs -f mongodb

# Application-side view of the same symptom
curl https://your-domain.com/metrics
```

## Maintenance

### Daily Tasks

- [ ] Monitor disk space
- [ ] Check logs for errors
- [ ] Verify backup completion
- [ ] Monitor CPU/Memory usage

### Weekly Tasks

- [ ] Review security logs
- [ ] Check certificate expiration
- [ ] Update container images if needed
- [ ] Verify backups can be restored

### Monthly Tasks

- [ ] Review database performance
- [ ] Optimize slow queries
- [ ] Update dependencies
- [ ] Security audit

### Quarterly Tasks

- [ ] Full disaster recovery test
- [ ] Security audit
- [ ] Capacity planning
- [ ] Performance optimization

## Disaster Recovery

### Backup Verification

`scripts/restore-database.sh` checks its own work: after `mongorestore` it counts the collections in `$DB_NAME` and exits non-zero if the database is still empty, which is exactly what a restore from an empty archive leaves behind. It cannot verify into a throwaway database, though — the archive carries the database name it was dumped from, so a rehearsal against `allinone_test` needs `--nsFrom`/`--nsTo`, which the script does not expose. That remains an open decision in [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).

### Recovery Procedure

See [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) for the recovery steps that this repository does support, and for the parts that are still unverified.

## Support

- 📖 Documentation: See `/docs` folder
- 🐛 Issues: GitHub Issues
- 📧 Email: support@allinone.local
- 💬 Discussions: GitHub Discussions

---

**Congratulations! Your Allinone backend is now in production! 🚀**
