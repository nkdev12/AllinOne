# Allinone Backend — Getting Started Guide

This guide will help you get the Allinone backend running locally for development and testing.

## Prerequisites

Before you start, ensure you have:

- **Docker** & **Docker Compose** (latest version)
- **Git**
- **Node.js 20+** (for local development; `@nestjs/core@11` declares `"node": ">= 20"` in its engines and `Dockerfile` builds on `node:20-alpine`)
- **Code editor** (VS Code recommended)
- **Terminal/Shell** (bash, zsh, or PowerShell)

### Install Docker

- **macOS**: [Docker Desktop for Mac](https://docs.docker.com/desktop/install/mac-install/)
- **Windows**: [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/)
- **Linux**: Follow [official guide](https://docs.docker.com/engine/install/)

Verify installation:

```bash
docker --version
docker compose version
```

## Step 1: Clone the Repository

```bash
git clone https://github.com/yourusername/allinone-backend.git
cd allinone-backend
```

## Step 2: Set Up Environment

### Copy Example Configuration

```bash
cp .env.example .env
```

### Review Default Values

Open `.env` in your editor. For **local development**, these are the values the backend needs (they match the git-ignored `.env` a working run uses):

```env
APP_ENV=development
APP_PORT=3000
DATABASE_URL=mongodb://localhost:27017/allinone_dev
REDIS_URL=redis://localhost:6379
SMTP_HOST=mailpit
SMTP_PORT=1025
```

Two caveats about the files as committed:

- `.env.example` ships `DATABASE_URL="mongodb://localhost:27017/allinone_dev"` and a note that the server must be a replica set member. Check it anyway: the line was a `postgresql://…:5432/…` URL as recently as commit `538cc50`, and the datasource is `provider = "mongodb"`, so a Postgres URL cannot work no matter what is in the file.
- `SMTP_HOST=mailpit` only resolves inside the Compose network. When the API runs on your own machine with `npm run start:dev`, use `localhost`, because `docker-compose.dev.yml` publishes Mailpit's SMTP port as `1025:1025`.

**⚠️ Important**: These defaults are only for development. For production, change:

- `JWT_ACCESS_SECRET` — Generate: `openssl rand -hex 32`
- `JWT_REFRESH_SECRET` — Generate: `openssl rand -hex 32`
- `ENCRYPTION_KEY` — Generate: `openssl rand -base64 32`
- Database access — `docker-compose.prod.yml` starts MongoDB with no credentials at all (see [DEPLOYMENT.md](DEPLOYMENT.md), Step 3 and Step 10)
- MinIO credentials

## Step 3: Start Docker Services

```bash
# Start all services in the background
docker compose -f docker-compose.dev.yml up -d
```

Wait for services to initialize (~10-30 seconds):

```bash
# Check status
docker compose -f docker-compose.dev.yml ps
```

**Expected output:**

```
NAME                          STATUS
allinone-mongodb-dev          healthy
allinone-redis-dev            healthy
allinone-minio-dev            healthy
allinone-mailpit-dev          healthy
allinone-prometheus-dev       healthy
allinone-grafana-dev          healthy
```

The stack has no API container in development: `docker-compose.dev.yml` defines only the six services above, and the backend itself runs on the host (Step 6). The `mongodb` service starts as `mongo:7.0` with `--replSet rs0 --bind_ip_all`, and its healthcheck runs `rs.initiate(...)` so the multi-document transactions used by the sync, notes, tasks, auth, users and devices services work; a standalone `mongod` would make those requests fail.

### Common Services

| Service    | URL                   | Purpose        |
| ---------- | --------------------- | -------------- |
| MongoDB    | localhost:27017       | Main database  |
| Redis      | localhost:6379        | Cache & queues |
| MinIO      | http://localhost:9000 | File storage   |
| Mailpit    | http://localhost:8025 | Email testing  |
| Prometheus | http://localhost:9090 | Metrics        |
| Grafana    | http://localhost:3001 | Dashboards     |

## Step 4: Install Node Dependencies

```bash
npm install
```

This installs:

- NestJS framework
- TypeScript compiler
- Prisma ORM client
- Testing frameworks
- Linting tools

## Step 5: Set Up Database

### Generate Prisma Client

```bash
npm run db:generate
```

### Apply the Schema

```bash
npm run db:push
```

`prisma db push` creates the MongoDB collections and the indexes declared in `prisma/schema.prisma`. There is no `prisma/migrations/` directory in this repository (it is also listed in `.gitignore`), and Prisma Migrate does not support the `mongodb` provider, so `npm run db:migrate` and `npm run db:migrate:deploy` exist in `package.json` but are dead ends here.

### (Optional) Seed Test Data

```bash
npm run db:seed
```

Nothing is seeded yet: `prisma/seed.ts` logs a message and returns, with the sample users, notes, tasks and calendar events still sitting in a `TODO` comment.

## Step 6: Start Development Server

```bash
npm run start:dev
```

**Output should show:**

```
LOG [NestFactory] Starting Nest application...
LOG [Bootstrap] 🚀 Allinone Backend started on http://localhost:3000
LOG [Bootstrap] 📚 API Documentation: http://localhost:3000/api
LOG [Bootstrap] Environment: development
LOG [Bootstrap] Database: mongodb://localhost:27017/allinone_dev
```

`src/main.ts` listens on `0.0.0.0` at `APP_PORT` (default `3000`) but logs the `localhost` form. It registers no global route prefix: `/api` is only the Swagger UI path set by `SwaggerModule.setup("api", app, document)`, so every controller lives at the root (`/health`, `/auth/...`, `/notes/...`).

The API is now running! 🎉

## Step 7: Test the API

### Open Documentation

Visit: **http://localhost:3000/api**

You'll see the interactive Swagger documentation where you can test endpoints.

### Test Health Check

```bash
curl http://localhost:3000/health
```

**Expected response:**

```json
{
  "status": "ok",
  "info": {
    "database": {
      "status": "up",
      "latency": 5
    },
    "redis": {
      "status": "up"
    }
  },
  "error": {},
  "details": {
    "database": {
      "status": "up",
      "latency": 5
    },
    "redis": {
      "status": "up"
    }
  }
}
```

There is no `timestamp` or `services` array in the payload. Note also that `src/health/health.service.ts` hard-codes `redis: { status: "up" }` instead of probing it, so only the `database` entry reflects a real check (`PrismaService.checkHealth()` runs a MongoDB `ping` and reports `latency` in ms), and a failing database flips `status` to `error` with HTTP `503`.

### View API Info

```bash
curl http://localhost:3000/info
```

## Development Workflow

### Hot Reload

Changes to source files automatically restart the server:

```bash
npm run start:dev
```

Edit a file, save, and the server recompiles.

### Run Tests

```bash
# Unit tests
npm run test

# End-to-end (E2E) tests
npm run test:e2e

# Watch mode (re-run on file changes)
npm run test:watch

# Coverage report
npm run test:cov

# Performance / Load tests (requires k6)
npm run test:load:sync
npm run test:load:auth
```

### Code Quality

```bash
# Type checking
npm run typecheck

# Linting & fix issues
npm run lint

# Format code
npm run format
```

Before committing, always run:

```bash
npm run lint && npm run typecheck && npm run test
```

## Using Mailpit for Email Testing

When the backend sends emails, they appear in Mailpit instead of being sent to the internet.

1. Open **http://localhost:8025**
2. Send an email via the API
3. See it appear in Mailpit UI
4. Inspect email content, headers, and attachments

Perfect for testing email features without a real SMTP server!

## Using MinIO for File Storage

MinIO provides S3-compatible object storage locally.

1. Open the console at **http://localhost:9001** — `docker-compose.dev.yml` starts `minio server /data --console-address ":9001"`, so `9000` is the S3 API endpoint and `9001` is the UI
2. Login with the credentials that same file sets:
   - Username: `minioadmin`
   - Password: `minioadmin`
3. The only bucket the configuration knows about is `OBJECT_STORAGE_BUCKET` (`allinone-dev` in `.env.example`)

Nothing in `src/` talks to MinIO yet: no S3 client is constructed anywhere in the codebase, `src/common/aws/` is empty, and the `OBJECT_STORAGE_*` keys are only validated in `src/app/app.module.ts` and read back by `src/config/configuration.service.ts`. The `Attachment` model stores a `storagePath` string and no upload code uses it.

> ⚠️ TODO(verify): which buckets the attachment/export features will need once an object-storage client exists — `attachments`, `exports` and `backups` were never created by anything in this repository.

## Monitoring with Prometheus & Grafana

### Prometheus

- URL: **http://localhost:9090**
- See collected metrics
- Query time-series data
- View scrape status

`infrastructure/prometheus/prometheus.dev.yml` scrapes the `allinone-api` target at `localhost:3000` from inside the Prometheus container, while development runs the backend on the host (Step 6), so that target shows as DOWN until something answers port 3000 inside the container.

### Grafana

- URL: **http://localhost:3001**
- Login: `admin` / `admin`
- Pre-configured Prometheus datasource
- Create dashboards
- Set up alerts

## Useful Commands

### Docker Management

```bash
# View running services
docker compose -f docker-compose.dev.yml ps

# View logs (this stack has no api service — the backend runs on the host)
docker compose -f docker-compose.dev.yml logs -f mongodb redis

# Stop all services
docker compose -f docker-compose.dev.yml down

# Remove volumes (resets mongo_data_dev, redis_data_dev and the other four named volumes)
docker compose -f docker-compose.dev.yml down -v

# The dev stack names prebuilt images only (no build: sections), so updates arrive via pull
docker compose -f docker-compose.dev.yml pull
```

### Database Management

```bash
# Open Prisma Studio (visual database editor)
npm run db:studio

# Sync prisma/schema.prisma to the database (no migration files exist to list or apply)
npm run db:push

# Inspect the running database with the mongosh that ships in the mongo:7.0 container
docker compose -f docker-compose.dev.yml exec mongodb mongosh \
  --eval "db.getSiblingDB('allinone_dev').getCollectionNames()"

# Confirm the rs0 replica set the transaction endpoints need
docker compose -f docker-compose.dev.yml exec mongodb mongosh --eval "rs.status()"
```

### Code Generation

```bash
# Regenerate the Prisma client after editing prisma/schema.prisma
npm run db:generate

# Backfill sync cursors (scripts/backfill-change-cursor.ts)
npm run sync:backfill:cursor
```

There is no `npm run generate` script in `package.json`. The OpenAPI document a type generator would consume is produced at runtime by the `SwaggerModule.setup("api", app, document)` call in `src/main.ts`.

## Troubleshooting

### Port Already in Use

If you get "Port 3000 already in use":

```bash
# macOS/Linux: Find process on port 3000
lsof -i :3000

# Kill process
kill -9 <PID>

# Or use different port
APP_PORT=3001 npm run start:dev
```

### Database Connection Failed

```bash
# Check if MongoDB is running
docker compose -f docker-compose.dev.yml ps mongodb

# Restart database
docker compose -f docker-compose.dev.yml restart mongodb

# Check logs
docker compose -f docker-compose.dev.yml logs mongodb
```

Make sure `DATABASE_URL` uses the `mongodb://` scheme (`.env.example` does now; it did not until 2026-09-27). If the container is up but writes through `sync`, `notes`, `tasks`, `auth`, `users` or `devices` fail, check that the replica set is initiated (`rs.status()` inside `allinone-mongodb-dev`) — it is the service healthcheck that runs `rs.initiate`.

### Redis Connection Failed

```bash
# Restart Redis
docker compose -f docker-compose.dev.yml restart redis

# Test connection
redis-cli ping
```

### TypeScript Errors

```bash
# Regenerate Prisma client
npm run db:generate

# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

## Next Steps

1. **Read the documentation**: Check out the rest of this `docs/` folder
2. **Explore the codebase**: Start with `src/` folder structure
3. **Review the schema**: Open `prisma/schema.prisma`
4. **Try the API**: Use Swagger at http://localhost:3000/api
5. **Run tests**: `npm run test:watch`

## Need Help?

- 📖 [Architecture Guide](ARCHITECTURE.md)
- 🔐 [Security Guidelines](SECURITY.md)
- 🚀 [Production Deployment](DEPLOYMENT.md)
- 📚 [API Documentation](http://localhost:3000/api)
- 🐛 Check existing issues: [GitHub Issues](https://github.com/yourusername/allinone-backend/issues)

## Common Questions

**Q: Can I use the backend without Docker?**

A: Yes, but you'll need to manually install and run MongoDB (as a replica set, because the transaction endpoints reject a standalone `mongod`), Redis, MinIO, and Mailpit. Docker Compose is recommended for simplicity.

**Q: How do I reset my local database?**

```bash
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d mongodb
npm run db:push
```

`down -v` deletes every named volume in the dev stack, not just `mongo_data_dev`. The `mongodb` healthcheck re-runs `rs.initiate` for `rs0` on the fresh volume.

**Q: Can I deploy to production now?**

A: Yes, all core application stages (Stages 1–7: Architecture & Foundations, Authentication & Admin RBAC, Real-time Delta Sync, Notes, Tasks, Calendar, and Zero-Knowledge Vault) are fully implemented and verified with test suites. Follow the production runbook in [DEPLOYMENT.md](DEPLOYMENT.md) for pre-flight checks, infrastructure provisioning, secrets management, and the current state of database backups — Step 8 there records that no working MongoDB backup automation exists yet.

**Q: How do I set up for mobile development?**

There is no `MOBILE_DEVELOPMENT.md` in this repository. Mobile clients use the same HTTP API and the Socket.IO `/sync` gateway (`namespace: "/sync"` in `src/sync/sync.gateway.ts`); both are specified in [API_REFERENCE.md](API_REFERENCE.md).

---

**Happy developing! 🚀**
