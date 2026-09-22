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
- [ ] Set strong database password
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

# Database
DATABASE_URL=postgresql://allinone:STRONG_PASSWORD@postgres:5432/allinone_prod

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

# Monitoring
GRAFANA_ADMIN_PASSWORD=STRONG_PASSWORD

# Domain for Caddy
DOMAIN=your-domain.com
```

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

```bash
# Create PostgreSQL superuser (or use managed database)
createuser -P allinone
createdb -O allinone allinone_prod
```

### Enable SSL (Optional but Recommended)

```bash
# Generate self-signed cert for DB connection
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /path/to/server.key -out /path/to/server.crt
```

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

Create `infrastructure/caddy/Caddyfile`:

```
your-domain.com {
  reverse_proxy /api/* api:3000
  reverse_proxy / api:3000

  # Security headers
  header / Strict-Transport-Security "max-age=31536000; includeSubDomains"
  header / X-Content-Type-Options "nosniff"
  header / X-Frame-Options "DENY"
  header / Referrer-Policy "strict-origin-when-cross-origin"

  # Compression
  encode gzip

  # Logging
  log {
    output stdout
    format json
  }
}

# Monitoring dashboard (optional)
dashboard.your-domain.com {
  reverse_proxy grafana:3000
  encode gzip
}
```

Caddy automatically obtains SSL certificates from Let's Encrypt!

### Using Nginx (Alternative)

See `infrastructure/nginx/` for nginx configuration examples.

## Step 6: Start Production Stack

```bash
# Load environment from .env.prod
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

# Verify database connectivity
docker compose -f docker-compose.prod.yml exec postgres pg_isready -U allinone -d allinone_prod
```

### Run Database Migrations

```bash
# Apply migrations
docker compose -f docker-compose.prod.yml exec api npm run db:migrate:deploy

# Verify database
docker compose -f docker-compose.prod.yml exec postgres psql \
  -U allinone -d allinone_prod -c "\dt"
```

### Seed Initial Data (Optional)

```bash
docker compose -f docker-compose.prod.yml exec api npm run db:seed
```

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

### Database & Storage Backups

```bash
# Automated daily backup script
cat > /usr/local/bin/backup-allinone.sh << 'EOF'
#!/bin/bash
set -eo pipefail

BACKUP_DIR="/opt/allinone-backup"
RETENTION_DAYS=30
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

# Backup PostgreSQL (pipefail ensures script aborts if pg_dump fails)
cd /opt/allinone-backend
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U allinone allinone_prod | \
  gzip > "$BACKUP_DIR/allinone-db-$TIMESTAMP.sql.gz"

# Backup MinIO persistent storage volume via dedicated container mount
docker run --rm \
  -v allinone-backend_minio_data_prod:/data:ro \
  -v "$BACKUP_DIR:/backup" \
  alpine tar -czf "/backup/allinone-minio-$TIMESTAMP.tar.gz" -C /data .

# Verify backup integrity
gzip -t "$BACKUP_DIR/allinone-db-$TIMESTAMP.sql.gz"
tar -tzf "$BACKUP_DIR/allinone-minio-$TIMESTAMP.tar.gz" > /dev/null

# Delete old backups
find "$BACKUP_DIR" -name "allinone-db-*.sql.gz" -mtime +$RETENTION_DAYS -delete
find "$BACKUP_DIR" -name "allinone-minio-*.tar.gz" -mtime +$RETENTION_DAYS -delete

echo "Backup completed and verified: $TIMESTAMP"
EOF

chmod +x /usr/local/bin/backup-allinone.sh

# Test backup
/usr/local/bin/backup-allinone.sh
```

### Automated Backup Schedule

```bash
# Add to crontab (runs daily at 2 AM)
(crontab -l 2>/dev/null; echo "0 2 * * * /usr/local/bin/backup-allinone.sh") | crontab -
```

### Backup Storage

Store backups:
- On external drive (daily rotation)
- On remote server (rsync/sftp)
- On cloud storage (S3-compatible)

## Step 9: Monitoring & Logging

### View Logs

```bash
# Recent logs
docker compose -f docker-compose.prod.yml logs --tail=100 api

# Follow logs
docker compose -f docker-compose.prod.yml logs -f api

# Filter by service
docker compose -f docker-compose.prod.yml logs postgres
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

```bash
# Restrict PostgreSQL to localhost
# In docker-compose.prod.yml:
postgres:
  ports:
    - "127.0.0.1:5432:5432"  # Only local access

# Enable SSL for PostgreSQL connections
environment:
  POSTGRES_INITDB_ARGS: "-c ssl=on -c ssl_cert_file=/etc/ssl/certs/server.crt"
```

### Redis Security

```bash
# Require password
redis:
  command: redis-server --requirepass $REDIS_PASSWORD
```

## Step 11: Performance Tuning

### Database Optimization

```sql
-- Analyze query performance
ANALYZE;

-- Create missing indexes
CREATE INDEX idx_notes_user_created ON notes(user_id, created_at DESC);
CREATE INDEX idx_tasks_user_status ON tasks(user_id, status);

-- Check index usage
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes
ORDER BY idx_scan DESC;
```

### Memory Configuration

```bash
# PostgreSQL (in docker-compose.prod.yml)
environment:
  - "POSTGRES_INITDB_ARGS=-c shared_buffers=256MB -c effective_cache_size=1GB"

# Redis
redis:
  command: redis-server --maxmemory 2gb --maxmemory-policy allkeys-lru

# API container
resources:
  limits:
    memory: 2G
  reservations:
    memory: 1G
```

### Connection Pooling

```yaml
# In .env.prod
DATABASE_URL=postgresql://user:pass@postgres:5432/db?schema=public&pool=20
```

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
docker compose -f docker-compose.prod.yml exec postgres psql \
  -U allinone -d allinone_prod -c "SELECT 1"

# Check PostgreSQL status
docker compose -f docker-compose.prod.yml exec postgres pg_isready
```

### Out of memory

```bash
# Check memory usage
docker stats

# Increase container memory in docker-compose.prod.yml
# or reboot and clear caches
```

### Slow queries

```bash
# Enable query logging
docker compose -f docker-compose.prod.yml exec postgres psql \
  -U allinone -d allinone_prod -c \
  "ALTER SYSTEM SET log_min_duration_statement = 1000;"

# Restart PostgreSQL
docker compose -f docker-compose.prod.yml restart postgres

# Check slow query log
docker compose -f docker-compose.prod.yml exec postgres \
  tail -f /var/log/postgresql/postgresql.log
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

```bash
# Restore to test database
PGPASSWORD=$DB_PASSWORD psql -U allinone -d allinone_test < backup.sql

# Verify data integrity
psql -U allinone -d allinone_test -c "SELECT COUNT(*) FROM users;"
```

### Recovery Procedure

See [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) for complete recovery steps.

## Support

- 📖 Documentation: See `/docs` folder
- 🐛 Issues: GitHub Issues
- 📧 Email: support@allinone.local
- 💬 Discussions: GitHub Discussions

---

**Congratulations! Your Allinone backend is now in production! 🚀**
