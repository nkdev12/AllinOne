#!/bin/bash

# Allinone Backend - Database Backup Script
# Creates compressed PostgreSQL backups with timestamp

set -e

# Configuration
PRIMARY_BACKUP_DIR="/opt/allinone-backup"
BACKUP_DIR="${BACKUP_DIR:-$PRIMARY_BACKUP_DIR}"

if ! mkdir -p "$BACKUP_DIR" 2>/dev/null; then
  BACKUP_DIR=".backup"
  mkdir -p "$BACKUP_DIR"
fi

RETENTION_DAYS="${RETENTION_DAYS:-30}"
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/allinone-db-$BACKUP_DATE.sql.gz"
DB_USER="${DB_USER:-allinone}"
DB_NAME="${DB_NAME:-allinone_prod}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Starting Allinone database backup...${NC}"
echo "Database: $DB_HOST:$DB_PORT/$DB_NAME"
echo "User: $DB_USER"
echo "Backup file: $BACKUP_FILE"
echo ""

# Create backup
if PGPASSWORD="$DB_PASSWORD" pg_dump \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --no-password \
  --verbose | gzip > "$BACKUP_FILE"; then
  
  FILE_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo -e "${GREEN}✓ Backup completed successfully${NC}"
  echo "File size: $FILE_SIZE"
  
else
  echo -e "${RED}✗ Backup failed${NC}"
  exit 1
fi

# Delete old backups
echo ""
echo "Cleaning up old backups (retention: $RETENTION_DAYS days)..."
DELETED_COUNT=0

for old_backup in $(find "$BACKUP_DIR" -name "allinone-db-*.sql.gz" -mtime +$RETENTION_DAYS 2>/dev/null); do
  rm -f "$old_backup"
  echo "Deleted: $old_backup"
  ((DELETED_COUNT++))
done

if [ $DELETED_COUNT -gt 0 ]; then
  echo "Deleted $DELETED_COUNT old backup(s)"
else
  echo "No old backups to delete"
fi

echo ""
echo -e "${GREEN}Backup process completed${NC}"
echo "Backup location: $BACKUP_FILE"
echo ""
echo "Next steps:"
echo "1. Verify backup integrity: gzip -t $BACKUP_FILE"
echo "2. Copy to remote storage for safekeeping"
echo "3. Test restore procedure periodically"
