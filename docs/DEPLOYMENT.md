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

- [ ] Generate new JWT secrets: `openssl rand -hex 32` — two different values, the boot gate below refuses a shared one
- [ ] Generate encryption key: `openssl rand -base64 48` (the command the gate's own error message and `docker-compose.prod.yml:223` recommend)
- [ ] `APP_ENV=production` is written into `.env.prod` — the hardened path is no longer keyed on `NODE_ENV`, so omitting it now takes the strict branch rather than the lenient one
- [ ] MongoDB authentication is on: `mongod` runs `--auth --keyFile`, and the root and app users are created by `deploy/mongo-replica-set-bootstrap.sh` (see Step 3)
- [ ] Set strong Redis password
- [ ] Set strong MinIO credentials
- [ ] Set strong Grafana admin password
- [ ] The `ENCRYPTION_KEY` rotation window is understood before the first rotation: two variables, in order ([SECURITY.md § `ENCRYPTION_KEY`, the vault verifier pepper](SECURITY.md#encryption_key-the-vault-verifier-pepper))
- [ ] SSL/TLS certificates ready
- [ ] All secrets in secrets manager (not .env)

#### What the boot gate refuses

`ConfigurationService.validateProductionSecrets()` (`src/config/configuration.service.ts:343-427`)
runs on every boot **except** an explicit `APP_ENV=development` or a test run
(`:306`, `isLocalDevelopment` `:464-466`, `isTestEnvironment` `:488-490`). It tests
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`, and — only when set —
`ENCRYPTION_KEY_PREVIOUS`, and aborts with an error naming the variable instead of
starting. Each refusal below is a boot error, not a warning, and none of them is
recoverable by restarting with the same file.

It refuses a secret that:

- **is still the shipped template** — the whole value, matched case-insensitively
  against `SHIPPED_TEMPLATE_SECRETS` (`configuration.service.ts:77-81`) or against
  the anchored `REPLACE_WITH__…__DO_NOT_SHIP` sentinel (`:96-97`, matched by
  `isShippedTemplateSecret` `:116-129`). A generated key that merely *contains*
  `REPLACE_WITH__` is not caught.
- **is shorter than 32 characters** (`SECRET_MIN_LENGTH` `:16`) or is built from too
  few distinct symbols to be worth 128 bits (`SECRET_MIN_ENTROPY_BITS` `:32`,
  measured by `estimateSecretEntropyBits` `:111`, reported by `secretDefect`
  `:143-159`).
- **`JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` share** — one signing key for two
  purposes means a token minted for either verifies against the other
  (`:368-374`).
- **`ENCRYPTION_KEY_PREVIOUS` repeats the current key** — that is a rotation that did
  not happen, and the ring would then answer every row on the first entry
  (`:376-383`).
- **`ENCRYPTION_KEY_ID` and `ENCRYPTION_KEY_PREVIOUS_ID` collide** — the stamp is the
  whole lookup, so every row sealed under the retired key would be verified against
  the wrong secret and reject its owner's correct master password (`:385-395`).

In the same gate: a literal `*` in `CORS_ORIGIN`, `CORS_ORIGINS` or
`WS_CORS_ORIGINS` (`:397-413`), `WS_CORS_ALLOW_NULL_ORIGIN` switched on (`:415-426`),
and — new in this pass — a deployed process with no `REDIS_URL`, because that is where
the rate-limit counters live and a process that never named one would count every
window in its own memory instead (`:305-320`).

`APP_ENV` is read exactly as written, with no default, for every decision here
(`declaredAppEnv` `:449-453`). Before this pass the gate was keyed on
`NODE_ENV`/`APP_ENV === "production"` through `appEnv`, which defaulted to
`development` when the variable was unset — so a `NODE_ENV=production` deploy that
forgot to declare `APP_ENV` skipped the whole gate and booted on template secrets.
It now takes the strict branch: an unset `APP_ENV`, `staging`, and a typo like `prod`
are all treated as deployed (`:455-466`).

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
# Used when you run the process outside the stack. Inside it, `docker-compose.prod.yml`
# injects a credentialed URL of its own and this key never reaches the container
# (see the compose bullet below).
DATABASE_URL=mongodb://MONGO_APP_USERNAME:STRONG_PASSWORD@mongodb:27017/allinone_prod?replicaSet=rs0&authSource=admin

# Redis — likewise injected as redis://:<REDIS_PASSWORD>@redis:6379. Required, not
# defaulted, on every deployed boot: `configuration.service.ts:305-320`.
REDIS_URL=redis://:STRONG_PASSWORD@redis:6379

# JWT (generate each: openssl rand -hex 32 — 64 hex characters)
# The placeholders below are shapes, not values: a literal copy fails the boot gate on
# both counts — under 32 characters (`SECRET_MIN_LENGTH`) and identical access/refresh.
JWT_ACCESS_SECRET=<64 hex characters from openssl rand -hex 32>
JWT_REFRESH_SECRET=<a different 64 hex characters>

# Object Storage (MinIO)
# Inside the stack the two credentials are injected from `MINIO_ROOT_USER` and
# `MINIO_ROOT_PASSWORD` (`docker-compose.prod.yml:235-236`), so keep them in step.
OBJECT_STORAGE_ENDPOINT=http://minio:9000
OBJECT_STORAGE_BUCKET=allinone-prod
OBJECT_STORAGE_ACCESS_KEY=minioadmin
OBJECT_STORAGE_SECRET_KEY=STRONG_PASSWORD

# SMTP (Gmail)
# Use a Google App Password — not the normal account password.
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=yourname@gmail.com
SMTP_PASSWORD=<Google App Password>
SMTP_FROM=yourname@gmail.com
SMTP_TLS=true
EMAIL_VERIFY_ENABLED=true

# Encryption (generate: openssl rand -base64 48)
# `ENCRYPTION_KEY` is also the pepper every stored vault verifier is HMACed with, so
# rotating it is a two-variable operation and the order is the whole point:
#   1. set `ENCRYPTION_KEY_PREVIOUS` to the value being retired, deploy, and
#   2. only then change `ENCRYPTION_KEY`, deploy again.
# Rows sealed under the retired key keep opening and re-seal themselves under the new
# one as they unlock — there is nothing offline to migrate. Once every vault has
# unlocked at least once, clear `ENCRYPTION_KEY_PREVIOUS` again; leaving it set keeps a
# retired key live in the environment.
# Rotating `ENCRYPTION_KEY` first and `ENCRYPTION_KEY_PREVIOUS` second is unrecoverable,
# because the bare verifier is never persisted
# (`src/vault/services/vault-settings.service.ts:102-119`).
# The ring covers BOTH users of the variable. The same value also derives the AES key
# that seals each user's TOTP secret (`src/auth/auth.service.ts:1376`), and
# `decryptTotpSecret` (`:1424`) walks the ring in the same order as the vaults do —
# current key first, then `ENCRYPTION_KEY_PREVIOUS` — and re-seals the secret under the
# current key when an older one authenticated it (`resealTotpSecret`, `:1492`, called
# from `:1567`, `:1719`, `:1819`). A rotation done in the order above therefore carries
# MFA users across rather than stranding them, which is what changed on 2026-10-18:
# before it, `decryptTotpSecret` tried the current key only, a failed decrypt returned
# the ciphertext as if it were the secret, and every subsequent code read as "Invalid
# TOTP verification code" while spending the 15-minute MFA lockout attempt by attempt.
# What is still unrecoverable is a secret sealed under a key this process does not
# hold, so the two steps above are the whole procedure — for MFA as much as for vaults.
# Both `*_ID` variables are optional labels and blank is the steady state: an unset
# id falls back to a fingerprint of the key (`configuration.service.ts:704`, `:732`).
ENCRYPTION_KEY=<48 bytes from openssl rand -base64 48>
ENCRYPTION_KEY_ID=
ENCRYPTION_KEY_PREVIOUS=
ENCRYPTION_KEY_PREVIOUS_ID=

# Cross-origin policy — two lists, two handshakes
# CORS_ORIGIN is the HTTP API's; the WS_ keys are the /sync namespace's.
# Unset, the socket falls back to CORS_ORIGINS then CORS_ORIGIN then
# http://localhost:3000, so a configured API list is not silently left wide open.
CORS_ORIGIN=https://your-domain.com
# WS_CORS_ORIGINS=https://app.your-domain.com
# WS_CORS_ALLOW_NULL_ORIGIN=false   # WebView clients only; logs that it was opened
# WS_REDIS_ADAPTER=true             # clustering is attempted when REDIS_URL is set;
                                   # false pins a replica to in-process rooms
# Keep both switches false on an internet-facing deployment. Swagger is not
# mounted unless SWAGGER_ENABLED=true.
ALLOW_LOCALHOST_CORS=false
SWAGGER_ENABLED=false
RATE_LIMIT_ENABLED=true

# Token lifetimes (defaults shown; both are honoured since 2026-09-27)
# JWT_ACCESS_EXPIRATION=15m
# JWT_REFRESH_EXPIRATION=7d
# Accept s/m/h/d or a bare number of seconds — "1h", "2 days", "900". There is no
# "w": a value the parser cannot read aborts the boot rather than surfacing as a
# 500 on someone's first sign-in.

# Admin access — NOTHING in this file's default state admits anyone to /admin
# Since 2026-09-27 there is no default admin email list and no role fallback, so
# set at least one of these three or the admin API has no working caller. Prefer
# ADMIN_USER_IDS is preferred. ADMIN_EMAILS requires a verified mailbox, but
# an immutable user id also avoids risk from a future address reassignment.
# ADMIN_USER_IDS=<the User.id you control>
# ADMIN_EMAILS=<a registered, verified address>
# ADMIN_SECRET= at least 32 characters, sent as the x-admin-secret header. It
#               escalates an already-authenticated request only and cannot stand
#               in for a session; shorter values are treated as unset.

# AI (optional; unset leaves /ai on its deterministic heuristics)
# GEMINI_API_KEY=
# GEMINI_MODEL=gemini-1.5-flash
# GEMINI_TIMEOUT_MS=5000

# Compose-level credentials — `docker-compose.prod.yml` interpolates these and none
# of them appear in `.env.example`. `:?` means the stack refuses to render without
# the value; `:-` means the default shown applies.
MONGO_KEYFILE=/etc/allinone/mongo-keyfile  # :? — host path, mode 600, owned by the uid mongod runs as (999); the steps are the header of deploy/mongo-replica-set-bootstrap.sh
MONGO_ROOT_USERNAME=admin                  # :? — created by the bootstrap, not by the image
MONGO_ROOT_PASSWORD=STRONG_PASSWORD        # :?
MONGO_APP_USERNAME=allinone                # :? — the user Prisma connects as
MONGO_APP_PASSWORD=STRONG_PASSWORD         # :? — only A-Z a-z 0-9 . _ ~ -, the bootstrap refuses anything else (compose:139)
MINIO_ROOT_USER=allinone-admin             # :? — at least 3 characters (compose:185)
MINIO_ROOT_PASSWORD=STRONG_PASSWORD        # :? — at least 8 characters (compose:186)
GRAFANA_ADMIN_PASSWORD=STRONG_PASSWORD     # :? — GF_SECURITY_ADMIN_PASSWORD (compose:359)
DOMAIN=your-domain.com                     # :? — the Caddy site block *is* this value, and Grafana's GF_SERVER_ROOT_URL is built from it (compose:73,362)
DB_NAME=allinone_prod                      # :-allinone_prod
GRAFANA_ADMIN_USER=admin                   # :-admin

```

The web app and the API must share one registrable domain

The browser session depends on the refresh cookie actually arriving, and it is written
`SameSite=Strict` with `Path=/auth/refresh` and `Secure` on every login and refresh
(`src/auth/auth.controller.ts:80-95`). Those attributes only work when the web app and
this API sit under one registrable domain — `app.example.com` and `api.example.com`
qualify, and so do `example.com` and `api.example.com`. The request and response shapes
around that cookie are [API_REFERENCE.md](API_REFERENCE.md)'s contract, not this guide's.

A split across two different registrable domains is not a deployment detail: a
`*.workers.dev` page against a `*.railway.app` API is cross-site, so the browser
never sends the cookie and no refresh is possible. The symptom is a session that ends
on its own about 15 minutes after sign-in — the access-token lifetime
(`JWT_ACCESS_EXPIRATION`, default `15m`) — with nothing loud in front of the user until
they are signed out. Do not relax the cookie to `SameSite=None` to work around it;
move the web app under the API's domain instead.

Two things the compose file makes visible:

- The `api` and `worker` services receive `DATABASE_URL` and `REDIS_URL` built by `docker-compose.prod.yml` itself — `mongodb://${MONGO_APP_USERNAME}:${MONGO_APP_PASSWORD}@mongodb:27017/${DB_NAME:-allinone_prod}?replicaSet=rs0&authSource=admin` and `redis://:${REDIS_PASSWORD}@redis:6379` (`:218-219`, repeated for the worker at `:285-286`). The `DATABASE_URL` and `REDIS_URL` lines in `.env.prod` above therefore only apply when you run the process outside the stack.
- Every name in the compose-level block above is still absent from the committed `.env.example`, so it has to be added to `.env.prod` by hand. What happens when one is missing is no longer a silent empty substitution: the fourteen variables listed there as `:?` — `APP_URL`, `DOMAIN`, `ENCRYPTION_KEY`, `GRAFANA_ADMIN_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MONGO_APP_PASSWORD`, `MONGO_APP_USERNAME`, `MONGO_KEYFILE`, `MONGO_ROOT_PASSWORD`, `MONGO_ROOT_USERNAME`, `REDIS_PASSWORD` — make `docker compose config` fail on the spot with `required option XY is not set` before a single container starts (`docker-compose.prod.yml:39-44`). Only `DB_NAME` and `GRAFANA_ADMIN_USER` substitute a default, and the `ENCRYPTION_KEY_ID` / `ENCRYPTION_KEY_PREVIOUS` / `ENCRYPTION_KEY_PREVIOUS_ID` and `SMTP_*` keys substitute empty on purpose: blank is their steady state.
- The two values that used to be able to start a service open are the ones this protects: an empty `REDIS_PASSWORD` would have handed Redis `--requirepass ""` (`:174`), and an empty `MONGO_APP_PASSWORD` an unauthenticated-looking connection string. Both are `:?` now, so the failure is a deploy error, not a mis-configured stack.

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

### Create Database User

No manual database creation is needed: MongoDB creates `allinone_prod` on first write, and `npm run db:push` creates the collections and the indexes declared as `@@index` in `prisma/schema.prisma`.

As committed, `docker-compose.prod.yml` starts `mongod` with `["--replSet", "rs0", "--bind_ip_all", "--auth", "--keyFile", "/etc/mongo/keyfile"]` (`:91-97`) and gives the service no `ports:` mapping — Caddy's `80`/`443`/`443-udp` (`:54-57`) is the only one in the file. The single-node replica set `rs0` is required because the services that write through `prisma.$transaction` (`auth`, `users`, `devices`, `sync`, `notes`, `tasks`) cannot run against a standalone `mongod`.

`--auth` and `--keyFile` arrive together or not at all: mongod refuses to start a replica set with authorization enabled and no internal authentication mechanism, so `--auth` alone is a crash loop rather than a secured database. The keyFile is a deploy-time prerequisite, not something the stack generates — `openssl rand -base64 756`, mode 600, owned by the uid `mongod` runs as (999), mounted read-only from the host path named by `MONGO_KEYFILE`; the steps are the header of `deploy/mongo-replica-set-bootstrap.sh`.

The users are created for you, by the one-shot `mongodb-bootstrap` service (`:112-137`), which runs that script in the mongod container's own network namespace so the localhost exception can admit the first user. It reads `MONGO_ROOT_USERNAME`/`MONGO_ROOT_PASSWORD` (the replica-set admin) and `MONGO_APP_USERNAME`/`MONGO_APP_PASSWORD` (the user Prisma connects as), and `restart: "no"` is deliberate — it is idempotent, but its exit code is the alarm. The image's own `MONGO_INITDB_ROOT_USERNAME`/`MONGO_INITDB_ROOT_PASSWORD` pair is not used here: it is only honoured on an empty data directory and is effectively ignored once `--replSet` is in the command.

So there is no "currently no database user to create" any more, and connections inside the `allinone-prod` network are authenticated with a credential in the URI — `authSource=admin` and `replicaSet=rs0` are both part of the URL the stack injects into `api` and `worker`.

Remaining open item: MongoDB TLS. No `--tls*` flag appears in the `mongod` command, and no `tls*` connection parameter exists in `.env.example` or the validation schema in `src/app/app.module.ts`. What protects the database is that the port is not published; the credentials still cross the compose network in cleartext.

### Enable SSL (Optional but Recommended)

Nothing to run yet: no MongoDB TLS options appear in `docker-compose.prod.yml`, and no `tls*` connection parameters exist in `.env.example` or the validation schema in `src/app/app.module.ts`. This is the open item named at the end of the section above.

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

Note: no route in the active Caddyfile proxies `/grafana`, but `docker-compose.prod.yml` still sets the container's `GF_SERVER_ROOT_URL=https://${DOMAIN}/grafana` (`:352`). Grafana is no longer reachable on a published port either — the service declares no `ports:` mapping at all, deliberately, so the admin UI is reachable only through a Caddy reverse proxy that gets the same TLS and origin allow-list as the API (`:360-361`), or via `docker compose -f docker-compose.prod.yml exec` on the host. Until such a route exists, that root URL points at a path nothing serves. The same applies to Prometheus: no `ports:`, because `/api/v1/query` is unauthenticated by default and a scrape-target list plus the whole metrics history is a reconnaissance report (`:333-336`).

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

# Verify database connectivity (the service is named mongodb; mongosh ships in the mongo:7.0 image and is also what the service healthcheck calls).
# `ping` is one of the few commands mongod answers without credentials under `--auth`
# (healthcheck comment at docker-compose.prod.yml:106-112, and
# deploy/mongo-replica-set-bootstrap.sh:85); anything past it needs a user, and there is
# none until the one-shot mongodb-bootstrap service has run.
docker compose -f docker-compose.prod.yml exec mongodb mongosh --eval "db.adminCommand('ping')"
```

### Apply the Prisma schema

```bash
# Neither end can do this as shipped, and the gap is structural:
#   * the `prisma` CLI is a devDependency, and `Dockerfile:31` runs
#     `npm prune --omit=dev` before the runtime layer copies `node_modules`, so the
#     api image has no CLI. It also copies only `package.json` (`Dockerfile:47`), not
#     the lockfile, and `/app` itself is root-owned, so there is no way to install
#     the missing tool inside the running container either.
#   * the host has the CLI, but `docker-compose.prod.yml` publishes no database port,
#     so there is no address to point it at.
# `npx prisma db push` inside the container is not a documented path: it would fetch a
# floating tarball over the network as part of a production schema change.
# Two supported ways, both explicit about what they open:
#   1. Forward the database to the host loopback for the length of the push, then
#      remove the mapping — a `ports:` entry of `127.0.0.1:27017:27017` on the
#      `mongodb` service is host-local, not exposed on the network interface, and
#      `--auth` still applies. Then run the push from a dev checkout with the URI
#      below.
#   2. Build a one-off image that keeps dev dependencies and run the push in it on
#      the `allinone-prod` network, where `mongodb:27017` resolves by name.
DATABASE_URL="mongodb://$MONGO_APP_USERNAME:$MONGO_APP_PASSWORD@127.0.0.1:27017/allinone_prod?replicaSet=rs0&authSource=admin" \
  npm run db:push

# Verify the collections exist. Under `--auth` this needs a user, unlike the `ping` above.
docker compose -f docker-compose.prod.yml exec mongodb mongosh \
  -u "$MONGO_ROOT_USERNAME" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
  --eval "db.getSiblingDB('allinone_prod').getCollectionNames()"
```

`prisma/schema.prisma` declares `provider = "mongodb"`, there is no `prisma/migrations/` directory (it is listed in `.gitignore`), and Prisma Migrate does not support the MongoDB connector. The `db:push`, `db:migrate`, and `db:migrate:deploy` scripts are therefore aliases for the supported, guarded `scripts/db-init.sh` path rather than Prisma Migrate.

Because there is no migration file, "will this push lose the data already in there?" is a question the deployer has to answer, not one the toolchain answers. `scripts/db-init.sh` answers it by snapshotting every collection's document count and content hash on either side of the push and exiting non-zero if a pre-existing collection changed, and it has a `--rehearse NAME` mode that runs the whole thing against a copy of the production data on a scratch database first. Both are described in [DATABASE_INITIALIZATION.md](DATABASE_INITIALIZATION.md), including the recorded run of 2026-10-20 against the dev database.

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

Prometheus and Grafana publish no ports (`docker-compose.prod.yml:343-344`, `:370-371`), so there is no `http://your-domain:9090` or `http://your-domain:3001` to open any more. Reach them the way the compose header recommends (`:20-25`): add a Caddy subdomain that reverse-proxies `grafana:3000` or `prometheus:9090` — the Caddyfile carries a commented block for exactly this, see Step 5 — or use `docker compose -f docker-compose.prod.yml exec` on the host.

Grafana's admin login is the `GRAFANA_ADMIN_PASSWORD` you set, for the user named by `GRAFANA_ADMIN_USER` (default `admin`) — `docker-compose.prod.yml:359-360`. An empty password used to leave it on `admin`/`admin`; the variable is `:?` now, so the stack will not render without one.

```bash
# The API's own metrics, through Caddy on the public origin. `/metrics` is NOT an
# open endpoint: @UseGuards(MetricsScrapeGuard)
# (src/common/metrics/metrics.controller.ts:13-18), so an anonymous curl is a 401.
# Either credential answers it: an account named in ADMIN_USER_IDS and its access
# token, or the ADMIN_SECRET value itself as a bearer — the shape the Prometheus
# scrape uses, and the only one that works before any admin account exists.
TOKEN=$(curl -sS -X POST https://your-domain.com/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@your-domain.com","password":"…"}' | jq -r '.tokens.accessToken')
curl -sS -H "Authorization: Bearer $TOKEN" https://your-domain.com/metrics | head

# Two caveats on that login: it is throttled to 5 attempts per minute per IP, and
# if the admin account has MFA on, the response carries `mfaRequired` and no token
# until POST /auth/mfa/verify exchanges the short-lived mfaToken.
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

**There is nothing to set up, because there is no aggregator in this deployment.**
This section used to carry a `loki:` stanza for `grafana/loki:latest` mounting
`./infrastructure/loki/loki-config.yml`. It was removed on 2026-10-18 because no
part of it exists: `infrastructure/` holds `caddy/`, `grafana/` and `prometheus/`
only, `docker-compose.prod.yml` and `docker-compose.dev.yml` define no `loki`
service, and neither Grafana nor Prometheus is configured to read one. Copying
that stanza out of an older copy of this file would have failed in a way that
looks like a Loki bug — a bind mount whose host path does not exist makes Docker
create an empty **directory** at it, so `local-config.yaml` is a directory, and
the container dies before it logs anything useful.

Logs are stdout, collected by the Docker daemon, and read with the `docker compose
logs` commands above. Retention is therefore the daemon's, not this repo's: the
`json-file` driver defaults to unlimited size, so set `--log-opt max-size` on the
services (or a `log-driver` default in `/etc/docker/daemon.json`) before a long
run fills the disk. There is no central store to search across restarts, and no
`docker compose logs` output survives a container recreation.

If aggregation is wanted later, three constraints are already load-bearing here
and a new service has to respect them: **publish no port** — Caddy's `80`/`443`
(`docker-compose.prod.yml:54-57`) is the only mapping in the prod file and
`docs/SECURITY.md`'s checklist asserts that, so an aggregator joins the
`allinone-prod` network and is reached through Caddy like Grafana is; **name an
image tag** — see Step 7's note on the `:latest` pins; and **put its config in
`infrastructure/<service>/`** so the mount points at a tracked file rather than
one an operator invents at deploy time.

### Monitoring Dashboard

Grafana is internal to the `allinone-prod` network (see Step 7's Monitoring note), so
there is no host port to open:

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
sudo ufw allow 443/udp     # HTTPS/QUIC — the Caddy service publishes 443:443/udp too
sudo ufw enable
```

### SSL/TLS Certificates

Caddy automatically renews Let's Encrypt certificates. Verify:

```bash
# Check certificate expiration
openssl s_client -connect your-domain.com:443 2>&1 | grep "Expire"
```

### Database Security

This section used to describe the open deployment. It no longer does:

- **The port is gone.** `docker-compose.prod.yml` publishes no mapping for MongoDB (or for Redis, MinIO, the API, the worker, Prometheus or Grafana); Caddy's `80`/`443`/`443-udp` (`:54-57`) is the only one in the file. `mongod` still runs `--bind_ip_all`, but inside a container that publishes nothing that is the container's own interface, and the database is reachable only on the `allinone-prod` network by service name (header `:2-19`).
- **Authentication is on.** `--auth` with `--keyFile` (`:91-97`), and the `api`/`worker` URIs carry the app user's credentials and `authSource=admin` (`:218`, `:285`). See Step 3 for how the two users are created and why `--auth` and `--keyFile` have to arrive together.
- **What is still open**: MongoDB TLS. No `--tls*` flag is passed and no `tls*` parameter exists in `.env.example` or the schema in `src/app/app.module.ts`, so credentials cross the compose network in cleartext.

Publishing `:3000` was the sharpest case, and it was not just another port: the app sets `trust proxy 1` (`src/main.ts:24`) and `CustomThrottlerGuard` keys its buckets on `req.ip` (`src/common/guards/custom-throttler.guard.ts:52-68`), so a client that could reach the API directly — bypassing Caddy — controlled `X-Forwarded-For` outright and got a fresh rate-limit bucket per forged value. Every throttle in the application (login, OTP, vault unlock) was advisory while that port was open. That is also why the firewall note above is now hygiene rather than the only thing standing between the database and the internet: Docker's published ports were never reliably filtered by UFW, and there are no published ports left to filter.

### Redis Security

`redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy noeviction --requirepass ${REDIS_PASSWORD:?…}` is the committed command (`docker-compose.prod.yml:201-212`); the variable is `:?`, so an empty `--requirepass` — which would have left Redis open — is now a `docker compose config` error rather than a running container. `REDIS_URL` for `api` and `worker` is built with the password inline (`:257`, `:323`), and the `redis` service (`:152-212`) has no `ports:` block at all — see the header comment at `:2` for why nothing below Caddy does. `REDIS_URL` is additionally required by the app itself outside development, for the same reason it is required by Redis: the rate-limit counters live there (`src/config/configuration.service.ts:308-321`).

`--maxmemory-policy noeviction` is the part of that line that is a security decision rather than a sizing one. Redis holds exactly two kinds of application state here, and both are meant to be authoritative: the per-client-IP rate-limit counters, whose cardinality is attacker-controlled, and the refresh-token grace/reuse markers, whose TTL is the refresh-token lifetime. Every other policy relieves memory pressure by deleting keys, and a deleted key is a *successful* Redis operation — the counter vanishing would silently loosen the limiter at the exact moment somebody is hammering login or OTP, and the grace marker vanishing would erase the only evidence a token was ever rotated, which is what lets a replay read as theft rather than as an unknown credential. `noeviction` keeps the pressure and turns it into a write error instead, and both consumers report that shape loudly.

## Step 11: Performance Tuning

### Database Optimization

Indexes live in the schema, not in SQL: `prisma/schema.prisma` declares 52 `@@index` blocks (for example `Note` has `@@index([userId])`, `@@index([folderId])`, `@@index([updatedAt])`) plus `@@unique` composites, and `npm run db:push` creates them on the MongoDB collections. Relational query-tuning tools (`ANALYZE`, `CREATE INDEX`, `pg_stat_user_indexes`) have no counterpart here, and no MongoDB equivalent (profiler, index-usage report) is configured in the repository.

> ⚠️ TODO(verify): how slow database operations will be surfaced — neither compose file passes profiler or slow-query settings to `mongod`, so the only database log today is what `mongod` writes to `docker compose -f docker-compose.prod.yml logs mongodb`.

Request latency is instrumented in the application instead: `src/common/metrics/metrics.service.ts` renders `http_request_duration_seconds` histograms, exposed at `GET /metrics`.

> ✅ **The scrape is authenticated.** `/metrics` sits behind one guard,
> `MetricsScrapeGuard` (`src/common/metrics/metrics.controller.ts:18`;
> `src/common/metrics/metrics-scrape.guard.ts:60-94`), which accepts either a machine
> credential — `ADMIN_SECRET` presented as `Authorization: Bearer <secret>` or as
> `x-admin-secret`, compared with `timingSafeEqual` — or a real admin, by delegating to
> the unchanged `JwtAuthGuard` and `AdminGuard` on the same request context. Nothing
> about `AdminGuard` was weakened for this: its secret branch still requires an
> authenticated user, which is exactly why a scrape needed a guard of its own
> (`src/admin/guards/admin.guard.ts:24-41`). An anonymous request answers `401` with
> `code: "UNAUTHORIZED"`, the same shape as before, so a missing secret still shows up
> as `up 0` rather than as a dashboard full of nothing.
>
> Prometheus reads the secret from a file rather than from its own config, because it
> cannot expand environment variables there:
> `authorization: { type: Bearer, credentials_file: /run/secrets/metrics_scrape_secret }`
> (`infrastructure/prometheus/prometheus.prod.yml:27-29`). The file is bind-mounted from
> `METRICS_SCRAPE_SECRET_FILE` with `:?` (`docker-compose.prod.yml:400`), so a deploy
> that forgot it fails at `docker compose config` instead of starting a Prometheus that
> 401s forever — the failure mode this whole section existed to describe. Write the
> `ADMIN_SECRET` value **verbatim**: no trailing newline, no `Bearer ` prefix
> (Prometheus adds the scheme), mode 600, never committed. It is a path in `.env.prod`,
> not a secret in it, so it stays out of `docker inspect`. `prometheus.dev.yml:32-34`
> carries the same stanza commented out, and dev compose mounts nothing — a dev scrape
> is anonymous, and an anonymous dev scrape is a 401 until an operator supplies a file.
>
> `PROMETHEUS_PORT` is gone (deleted 2026-10-18). It was validated and read and used by
> nothing, and its default, 9090, is Prometheus's own port — it looked like an
> internal-only metrics listener already existed. It did not.

### Memory Configuration

```bash
# MongoDB: docker-compose.prod.yml passes no memory flags to mongodb; mongo:7.0 runs with its
# defaults and keeps data in the mongo_data_prod volume.

# Redis (prod): the committed command is
#   redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy noeviction \
#     --requirepass ${REDIS_PASSWORD}
# (docker-compose.prod.yml:201-212). The bound is the sizing decision — counter keys are
# one per client IP and an attacker spreads them across addresses — and `noeviction` is
# the security one: the alternatives free memory by deleting keys, and here a deleted key
# is a silent loosening of a control rather than an error. With a bound and no eviction, a
# full Redis answers writes with an error instead, and the throttler then counts the hit in
# its own bounded window table (20 000 keys, src/common/throttler/local-throttler.window.ts:26)
# and logs `Rate limiting is degraded to this process only:` once per 30 seconds
# (src/common/throttler/redis-throttler.storage.ts:116-132, :238-272). The limit still holds
# during an outage; what is lost is that it is per process and forgotten at a restart.

# API container: neither api nor worker declares a resources: block; worker does set
# deploy.replicas: 2.
```

### Connection Pooling

```yaml
# In .env.prod — the same URL docker-compose.prod.yml builds for api and worker, and the
# shape a host-side `npm run db:push` has to match to reach the same database:
DATABASE_URL=mongodb://MONGO_APP_USERNAME:STRONG_PASSWORD@mongodb:27017/allinone_prod?replicaSet=rs0&authSource=admin
```

`?schema=public&pool=20` were relational-connector parameters and mean nothing to the MongoDB connector. `src/common/prisma/prisma.service.ts` constructs `PrismaClient` with no options, so connection behaviour is whatever the MongoDB driver defaults to; the repository tunes nothing here.

## Troubleshooting

### API won't start

```bash
# Check logs
docker compose -f docker-compose.prod.yml logs api

# Common issues (in the order the app now fails in):
# - docker compose refuses to render: `required option XY is not set` names one of the
#   14 `:?` variables in Step 2 — this happens before any container starts
# - the container crash-loops on a boot gate error naming JWT_ACCESS_SECRET,
#   JWT_REFRESH_SECRET, ENCRYPTION_KEY or ENCRYPTION_KEY_PREVIOUS: the value is still
#   the `.env.example` template, too short, too low-entropy, shared between two
#   purposes, or a rotation window that repeats the current key. See
#   "What the boot gate refuses" in the checklist.
# - `REDIS_URL is required outside development` — APP_ENV is not `development` and no
#   Redis was named, so every rate-limit window would be counted in one process's
#   memory and forgotten by its restart
#   (src/config/configuration.service.ts:305-320)
# - DATABASE_URL missing, wrong, or missing `?replicaSet=rs0` (the driver needs the set
#   name to use transactions at all — docker-compose.prod.yml:218)
# - Port 3000 already in use (only relevant when you run the process outside the stack:
#   no service in docker-compose.prod.yml publishes it)
# - Insufficient disk space
```

### Database connection fails

```bash
# Test connection
docker compose -f docker-compose.prod.yml exec mongodb mongosh \
  --eval "db.adminCommand('ping')"

# Confirm the replica set the API depends on is initiated. Under `--auth` this needs a
# user, so it only answers once mongodb-bootstrap has created one.
docker compose -f docker-compose.prod.yml exec mongodb mongosh \
  -u "$MONGO_ROOT_USERNAME" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
  --eval "rs.status()"

# mongod's own output
docker compose -f docker-compose.prod.yml logs mongodb

# The bootstrap's own output — it is the thing that initiates rs0 and creates both users
docker compose -f docker-compose.prod.yml logs mongodb-bootstrap
```

`api` and `worker` wait on the mongodb healthcheck *and* on `mongodb-bootstrap` reaching `service_completed_successfully` (`docker-compose.prod.yml:253-257`, `:315-319`), so a bootstrap that exits non-zero holds the whole stack down and its log is the first thing to read. The healthcheck is `ping` and nothing else (`:106-112`): it used to call `rs.initiate()` itself, which means the thing mutating the replica set on a host that had just been secured was a health probe. Initiation now belongs to `deploy/mongo-replica-set-bootstrap.sh`, which publishes the member as `mongodb:27017` rather than `127.0.0.1:27017` (script `:59`, `:108`) — a driver given `?replicaSet=rs0` discovers members from the set configuration, so a member named `127.0.0.1` is unreachable from another container. The script is idempotent: an already-initiated set and an already-existing admin user are skipped (`:41-46`, `:104-106`, `:123-132`), so a stack started with `down -v` re-initializes on the next `up`.

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

# Application-side view of the same symptom — same admin bearer as Monitoring above,
# because GET /metrics is guarded.
curl -sS -H "Authorization: Bearer $TOKEN" https://your-domain.com/metrics | grep http_request_duration_seconds
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
