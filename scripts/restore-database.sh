#!/bin/bash

# Allinone Backend - Database Restore Script
# Restores a MongoDB archive produced by backup-database.sh
#
# Requires mongorestore and mongosh (MongoDB Database Tools) on PATH.

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Key custody: the same 0600 file backup-database.sh uses, so a restore does not
# need the passphrase typed into a shell that keeps history or shows it in `ps`.
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/allinone/backup.env}"
if [ -f "$BACKUP_ENV_FILE" ]; then
  if [ -n "$(find "$BACKUP_ENV_FILE" -perm /077 2>/dev/null)" ]; then
    echo -e "${RED}Error: $BACKUP_ENV_FILE must not be readable or writable by group/other (chmod 600)${NC}" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$BACKUP_ENV_FILE"
  set +a
fi

# Configuration
DB_NAME="${DB_NAME:-allinone_prod}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-27017}"

# directConnection is required because both compose stacks run a single-member
# replica set initiated as 127.0.0.1:27017; without it a client in another
# container discovers that address and talks to itself.
# MONGO_URI names the server only — leave the database out of its path, since
# mongorestore restores the namespaces the archive carries.
MONGO_URI="${MONGO_URI:-mongodb://$DB_HOST:$DB_PORT/?directConnection=true}"

# mongosh ignores --db and falls back to `test`, so probes need the database in
# the URI path.
URI_BASE="${MONGO_URI%%\?*}"
URI_QUERY=""
[ "$URI_BASE" != "$MONGO_URI" ] && URI_QUERY="?${MONGO_URI#*\?}"
URI_SCHEME="${URI_BASE%%://*}"
URI_AUTH="${URI_BASE#*://}"
URI_AUTH="${URI_AUTH%%/*}"
DB_URI="$URI_SCHEME://$URI_AUTH/$DB_NAME$URI_QUERY"

for TOOL in mongorestore mongosh; do
  if ! command -v "$TOOL" >/dev/null 2>&1; then
    echo -e "${RED}✗ $TOOL not found on PATH${NC}"
    exit 1
  fi
done

# Check arguments
if [ $# -eq 0 ]; then
  echo -e "${RED}Error: Backup file required${NC}"
  echo ""
  echo "Usage: $0 <backup-file.archive.gz[.enc]>"
  echo ""
  echo "Examples:"
  echo "  $0 .backup/allinone-db-20240115_100000.archive.gz"
  echo "  BACKUP_PASSPHRASE=... $0 /opt/allinone-backup/allinone-db-20240115_100000.archive.gz.enc"
  echo ""
  echo "Available backups:"
  find .backup /opt/allinone-backup \
    \( -name "allinone-db-*.archive.gz" -o -name "allinone-db-*.archive.gz.enc" \) 2>/dev/null | sort -r \
    || echo "No backups found"
  exit 1
fi

BACKUP_FILE="$1"
ARCHIVE="$BACKUP_FILE"

# Validate backup file
if [ ! -f "$BACKUP_FILE" ]; then
  echo -e "${RED}Error: Backup file not found: $BACKUP_FILE${NC}"
  exit 1
fi

# An .enc dump from backup-database.sh decrypts to a temp file that the EXIT trap
# removes, so plaintext never outlives the run.
if [[ "$BACKUP_FILE" == *.enc ]]; then
  if [ -z "$BACKUP_PASSPHRASE" ]; then
    echo -e "${RED}Error: $BACKUP_FILE is encrypted; set BACKUP_PASSPHRASE${NC}"
    exit 1
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo -e "${RED}Error: openssl not found on PATH${NC}"
    exit 1
  fi
  ARCHIVE=$(mktemp)
  trap 'rm -f "$ARCHIVE"' EXIT
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
    -pass env:BACKUP_PASSPHRASE -in "$BACKUP_FILE" -out "$ARCHIVE"; then
    echo -e "${RED}Error: decryption failed (wrong BACKUP_PASSPHRASE?)${NC}"
    exit 1
  fi
fi

# Check if file is valid gzip
if ! gzip -t "$ARCHIVE" 2>/dev/null; then
  echo -e "${RED}Error: Backup file is corrupted or not a valid gzip file${NC}"
  exit 1
fi

echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          Allinone Database Restore Utility         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Backup file: $BACKUP_FILE"
echo "File size: $(du -h "$BACKUP_FILE" | cut -f1)"
echo "Database: $DB_NAME"
echo "Target: $MONGO_URI"
echo ""

# Confirmation
echo -e "${YELLOW}WARNING: This will drop and overwrite every collection in '$DB_NAME'${NC}"
echo -e "${YELLOW}         that the archive contains.${NC}"
echo "All existing data in those collections will be lost."
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

# Restore from archive. The archive carries its own database name, so the
# collections land back in the database they were dumped from.
if mongorestore \
  --uri "$MONGO_URI" \
  --gzip \
  --drop \
  --archive="$ARCHIVE"; then

  # Verify restore
  echo ""
  echo -e "${YELLOW}Verifying restore...${NC}"

  COLL_COUNT=$(mongosh "$DB_URI" --quiet \
    --eval "print(db.getCollectionNames().length)" 2>/dev/null || echo "0")

  USER_COUNT=$(mongosh "$DB_URI" --quiet \
    --eval "try { print(db.User.countDocuments()) } catch (e) { print('n/a') }" 2>/dev/null || echo "n/a")

  # mongorestore exits 0 after restoring an empty archive, so the count is the
  # only thing that separates a real restore from a no-op.
  if [ "$COLL_COUNT" = "0" ]; then
    echo -e "${RED}✗ Verification failed: '$DB_NAME' still has no collections${NC}"
    exit 1
  fi

  echo ""
  echo -e "${GREEN}✓ Restore completed successfully${NC}"
  echo "Collections: $COLL_COUNT"
  echo "Users: $USER_COUNT"

else
  echo -e "${RED}✗ Restore failed${NC}"
  exit 1
fi

echo ""
echo -e "${YELLOW}Post-restore tasks:${NC}"
echo "1. Verify application connectivity"
echo "2. Check data integrity"
echo "3. Restart the api and worker services so they re-read the restored data"
echo "4. Monitor application logs"
echo ""
echo -e "${GREEN}Database restore complete${NC}"
