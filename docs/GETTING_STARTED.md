# Allinone Backend — Getting Started Guide

This guide will help you get the Allinone backend running locally for development and testing.

## Prerequisites

Before you start, ensure you have:

- **Docker** & **Docker Compose** (latest version)
- **Git**
- **Node.js 20+** (for local development)
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

Open `.env` in your editor. For **local development**, the defaults work fine:

```env
APP_ENV=development
APP_PORT=3000
DATABASE_URL=postgresql://allinone:allinone@localhost:5432/allinone_dev
REDIS_URL=redis://localhost:6379
SMTP_HOST=mailpit
SMTP_PORT=1025
```

**⚠️ Important**: These defaults are only for development. For production, change:
- `JWT_ACCESS_SECRET` — Generate: `openssl rand -hex 32`
- `JWT_REFRESH_SECRET` — Generate: `openssl rand -hex 32`
- `ENCRYPTION_KEY` — Generate: `openssl rand -base64 32`
- Database password
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
allinone-postgres-dev         healthy
allinone-redis-dev            healthy
allinone-minio-dev            healthy
allinone-mailpit-dev          healthy
allinone-prometheus-dev       healthy
allinone-grafana-dev          healthy
```

### Common Services

| Service | URL | Purpose |
|---------|-----|---------|
| PostgreSQL | localhost:5432 | Main database |
| Redis | localhost:6379 | Cache & queues |
| MinIO | http://localhost:9000 | File storage |
| Mailpit | http://localhost:8025 | Email testing |
| Prometheus | http://localhost:9090 | Metrics |
| Grafana | http://localhost:3001 | Dashboards |

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

### Run Migrations

```bash
npm run db:migrate
```

This creates all database tables based on `prisma/schema.prisma`.

**Output should show:**
```
✓ Your database has been successfully migrated
```

### (Optional) Seed Test Data

```bash
npm run db:seed
```

Creates sample users, notes, tasks, and calendar events for testing.

## Step 6: Start Development Server

```bash
npm run start:dev
```

**Output should show:**
```
[Nest] 12345  - 01/15/2024, 10:30:00 AM     LOG [NestFactory] Starting Nest application...
🚀 Allinone Backend started on http://0.0.0.0:3000
📚 API Documentation: http://0.0.0.0:3000/api
Environment: development
```

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
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z",
  "services": [
    {
      "name": "database",
      "status": "healthy",
  "status": "ok",
  "info": {
    "database": {
      "status": "up",
      "latency": 5
    },
    "redis": {
      "status": "up"
    }
  ]
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

# Watch mode (re-run on file changes)
npm run test:watch

# Coverage report
npm run test:cov
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

1. Open **http://localhost:9000**
2. Login with:
   - Username: `minioadmin`
   - Password: `minioadmin`
3. Create buckets for:
   - `attachments` — User file uploads
   - `exports` — Exported data
   - `backups` — Database backups
4. Manage files and monitor storage

## Monitoring with Prometheus & Grafana

### Prometheus

- URL: **http://localhost:9090**
- See collected metrics
- Query time-series data
- View scrape status

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

# View logs
docker compose -f docker-compose.dev.yml logs -f api

# Stop all services
docker compose -f docker-compose.dev.yml down

# Remove volumes (reset database)
docker compose -f docker-compose.dev.yml down -v

# Rebuild images
docker compose -f docker-compose.dev.yml build
```

### Database Management

```bash
# Open Prisma Studio (visual database editor)
npm run db:studio

# View migrations
npm run db:migrate -- --help

# Reset database
npm run db:migrate reset

# Check database connection
psql postgresql://allinone:allinone@localhost:5432/allinone_dev
```

### Code Generation

```bash
# Generate API types from OpenAPI
npm run generate

# Regenerate Prisma client
npm run db:generate
```

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
# Check if PostgreSQL is running
docker compose -f docker-compose.dev.yml ps postgres

# Restart database
docker compose -f docker-compose.dev.yml restart postgres

# Check logs
docker compose -f docker-compose.dev.yml logs postgres
```

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

1. **Read the documentation**: Check out [docs/](docs/) folder
2. **Explore the codebase**: Start with `src/` folder structure
3. **Review the schema**: Open `prisma/schema.prisma`
4. **Try the API**: Use Swagger at http://localhost:3000/api
5. **Run tests**: `npm run test:watch`

## Need Help?

- 📖 [Architecture Guide](docs/ARCHITECTURE.md)
- 🔐 [Security Guidelines](docs/SECURITY.md)
- 🚀 [Production Deployment](docs/DEPLOYMENT.md)
- 📚 [API Documentation](http://localhost:3000/api)
- 🐛 Check existing issues: [GitHub Issues](https://github.com/yourusername/allinone-backend/issues)

## Common Questions

**Q: Can I use the backend without Docker?**

A: Yes, but you'll need to manually install and run PostgreSQL, Redis, MinIO, and Mailpit. Docker Compose is recommended for simplicity.

**Q: How do I reset my local database?**

```bash
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d postgres
npm run db:migrate
```

**Q: Can I deploy to production now?**

A: Not yet. The backend is still under development. Wait for Stage 1 to complete, then Stage 2 (Authentication) and Stage 3 (Sync) before considering production deployment.
A: Yes, all core application stages (Stages 1–7: Architecture & Foundations, Authentication & Admin RBAC, Real-time Delta Sync, Notes, Tasks, Calendar, and Zero-Knowledge Vault) are fully implemented and verified with test suites. Follow the production runbook in [docs/DEPLOYMENT.md](DEPLOYMENT.md) for pre-flight checks, infrastructure provisioning, secrets management, and automated backups.

**Q: How do I set up for mobile development?**

See [docs/MOBILE_DEVELOPMENT.md](docs/MOBILE_DEVELOPMENT.md) for instructions on connecting mobile clients.

---

**Happy developing! 🚀**
