#!/bin/bash

# Allinone Backend - Database Restore Script
# Restores PostgreSQL backup from gzip file

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
DB_USER="${DB_USER:-allinone}"
DB_NAME="${DB_NAME:-allinone_prod}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

# Check arguments
if [ $# -eq 0 ]; then
  echo -e "${RED}Error: Backup file required${NC}"
  echo ""
  echo "Usage: $0 <backup-file.sql.gz>"
  echo ""
  echo "Examples:"
  echo "  $0 .backup/allinone-db-20240115_100000.sql.gz"
  echo ""
  echo "Available backups:"
  find .backup -name "allinone-db-*.sql.gz" 2>/dev/null | sort -r || echo "No backups found"
  exit 1
fi

BACKUP_FILE="$1"

# Validate backup file
if [ ! -f "$BACKUP_FILE" ]; then
  echo -e "${RED}Error: Backup file not found: $BACKUP_FILE${NC}"
  exit 1
fi

# Check if file is valid gzip
if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
  echo -e "${RED}Error: Backup file is corrupted or not a valid gzip file${NC}"
  exit 1
fi

echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          Allinone Database Restore Utility         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Backup file: $BACKUP_FILE"
echo "File size: $(du -h "$BACKUP_FILE" | cut -f1)"
echo "Database: $DB_HOST:$DB_PORT/$DB_NAME"
echo "User: $DB_USER"
echo ""

# Confirmation
echo -e "${YELLOW}WARNING: This will DROP and recreate the database!${NC}"
echo "All existing data will be lost."
echo ""
read -p "Continue? (type 'yes' to confirm): " -r
echo ""

if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
  echo -e "${YELLOW}Restore cancelled${NC}"
  exit 0
fi

echo ""
echo -e "${YELLOW}Starting restore...${NC}"
echo ""

# Terminate existing connections
echo "Terminating existing connections..."
PGPASSWORD="$DB_PASSWORD" psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "postgres" \
  --no-password \
  -c "SELECT pg_terminate_backend(pg_stat_activity.pid) FROM pg_stat_activity WHERE pg_stat_activity.datname = '$DB_NAME' AND pid <> pg_backend_pid();" 2>/dev/null || true

# Drop existing database
echo "Dropping existing database..."
PGPASSWORD="$DB_PASSWORD" psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "postgres" \
  --no-password \
  -c "DROP DATABASE IF EXISTS $DB_NAME;" || true

# Create new database
echo "Creating new database..."
PGPASSWORD="$DB_PASSWORD" psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "postgres" \
  --no-password \
  -c "CREATE DATABASE $DB_NAME;"

# Restore from backup
echo "Restoring from backup..."
if gunzip -c "$BACKUP_FILE" | PGPASSWORD="$DB_PASSWORD" psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --no-password \
  --quiet; then
  
  # Verify restore
  echo ""
  echo -e "${YELLOW}Verifying restore...${NC}"
  
  TABLE_COUNT=$(PGPASSWORD="$DB_PASSWORD" psql \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --no-password \
    -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" \
    -t)
  
  USER_COUNT=$(PGPASSWORD="$DB_PASSWORD" psql \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --no-password \
    -c "SELECT COUNT(*) FROM users;" \
    -t 2>/dev/null || echo "0")
  
  echo ""
  echo -e "${GREEN}✓ Restore completed successfully${NC}"
  echo "Tables: $TABLE_COUNT"
  echo "Users: $USER_COUNT"
  
else
  echo -e "${RED}✗ Restore failed${NC}"
  exit 1
fi

echo ""
echo -e "${YELLOW}Post-restore tasks:${NC}"
echo "1. Verify application connectivity"
echo "2. Check data integrity"
echo "3. Run any pending migrations: npm run db:migrate:deploy"
echo "4. Monitor application logs"
echo ""
echo -e "${GREEN}Database restore complete${NC}"
