#!/bin/bash

# Allinone Backend - Database Backup Script
# Creates compressed MongoDB backups with timestamp
#
# Requires mongodump (MongoDB Database Tools) on PATH, and openssl when
# BACKUP_PASSPHRASE is set.

set -e

# Key custody. Everything below reads the ordinary environment, so a cron entry
# can point at one root-owned file instead of carrying the passphrase inline,
# where `crontab -l` would print it to anyone who can read the crontab.
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/allinone/backup.env}"
if [ -f "$BACKUP_ENV_FILE" ]; then
  if [ -n "$(find "$BACKUP_ENV_FILE" -perm /077 2>/dev/null)" ]; then
    echo "Error: $BACKUP_ENV_FILE must not be readable or writable by group/other (chmod 600)" >&2
    exit 1
  fi
  # set -a so the values reach the environment: openssl reads the passphrase
  # with `-pass env:`, and a plain source would only define shell variables.
  set -a
  # shellcheck disable=SC1090
  . "$BACKUP_ENV_FILE"
  set +a
fi

# Configuration
PRIMARY_BACKUP_DIR="/opt/allinone-backup"
BACKUP_DIR="${BACKUP_DIR:-$PRIMARY_BACKUP_DIR}"

if ! mkdir -p "$BACKUP_DIR" 2>/dev/null; then
  BACKUP_DIR=".backup"
  mkdir -p "$BACKUP_DIR"
fi

RETENTION_DAYS="${RETENTION_DAYS:-30}"
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/allinone-db-$BACKUP_DATE.archive.gz"
DB_NAME="${DB_NAME:-allinone_prod}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-27017}"

# directConnection is required because both compose stacks run a single-member
# replica set initiated as 127.0.0.1:27017; without it a client in another
# container discovers that address and talks to itself.
# MONGO_URI names the server only — leave the database out of its path, since
# mongodump selects it with --db.
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

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

for TOOL in mongodump mongosh; do
  if ! command -v "$TOOL" >/dev/null 2>&1; then
    echo -e "${RED}✗ $TOOL not found on PATH${NC}"
    exit 1
  fi
done

echo -e "${YELLOW}Starting Allinone database backup...${NC}"
echo "Database: $DB_NAME"
echo "Target: $MONGO_URI"
echo "Backup file: $BACKUP_FILE"

# Pre-flight: mongodump writes a valid, empty archive without complaining when
# the database does not exist, so a mistyped DB_NAME passes every later check.
COLLECTION_COUNT=$(mongosh "$DB_URI" --quiet --eval "db.getCollectionNames().length" 2>/dev/null || echo "0")
if [ "$COLLECTION_COUNT" = "0" ]; then
  echo -e "${RED}✗ Database '$DB_NAME' has no collections - check DB_NAME / MONGO_URI${NC}"
  exit 1
fi
echo "Collections: $COLLECTION_COUNT"
echo ""

# Create backup
if mongodump \
  --uri "$MONGO_URI" \
  --db "$DB_NAME" \
  --gzip \
  --archive="$BACKUP_FILE"; then

  FILE_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo -e "${GREEN}✓ Backup created successfully${NC}"
  echo "File size: $FILE_SIZE"

  # Verify archive integrity
  echo "Verifying archive integrity..."
  if gzip -t "$BACKUP_FILE"; then
    echo -e "${GREEN}✓ Integrity check passed${NC}"
  else
    echo -e "${RED}✗ Backup archive corrupted!${NC}"
    exit 1
  fi

  # Optional encryption. A mongodump of VaultSetting carries every vault's
  # wrapped keys alongside its ciphertext, so the dump is the soft target.
  if [ -n "$BACKUP_PASSPHRASE" ]; then
    if ! command -v openssl >/dev/null 2>&1; then
      rm -f "$BACKUP_FILE"
      echo -e "${RED}✗ openssl not found on PATH; plaintext dump deleted${NC}"
      exit 1
    fi
    echo "Encrypting archive..."
    # Every failure path here deletes the plaintext archive: exiting on a
    # "backup failed" message while leaving the unencrypted dump on disk would
    # be the worse outcome. This is rm, not secure erasure.
    if ! openssl enc -aes-256-cbc -pbkdf2 -iter 100000 \
      -pass env:BACKUP_PASSPHRASE \
      -in "$BACKUP_FILE" -out "$BACKUP_FILE.enc"; then
      rm -f "$BACKUP_FILE" "$BACKUP_FILE.enc"
      echo -e "${RED}✗ Encryption failed; plaintext dump deleted${NC}"
      exit 1
    fi
    rm -f "$BACKUP_FILE"
    BACKUP_FILE="$BACKUP_FILE.enc"
    # Decrypting back through gzip -t proves both the passphrase and the payload.
    if openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
      -pass env:BACKUP_PASSPHRASE -in "$BACKUP_FILE" | gzip -t; then
      echo -e "${GREEN}✓ Encryption round-trip passed${NC}"
      echo "File size: $(du -h "$BACKUP_FILE" | cut -f1)"
    else
      echo -e "${RED}✗ Encrypted archive does not decrypt${NC}"
      exit 1
    fi
  else
    echo -e "${YELLOW}! BACKUP_PASSPHRASE is unset: the archive is plaintext and"
    echo -e "  includes the VaultSetting collection if any user has configured vault.${NC}"
  fi

  # Second copy. The retention sweep prunes $BACKUP_DIR only, so unless
  # BACKUP_COPY_DIR points at another disk or a mounted share this host still
  # holds every copy.
  if [ -n "$BACKUP_COPY_DIR" ]; then
    mkdir -p "$BACKUP_COPY_DIR"
    if cp "$BACKUP_FILE" "$BACKUP_COPY_DIR/" &&
       cmp -s "$BACKUP_FILE" "$BACKUP_COPY_DIR/$(basename "$BACKUP_FILE")"; then
      echo -e "${GREEN}✓ Verified copy in $BACKUP_COPY_DIR${NC}"
    else
      echo -e "${RED}✗ Copy in $BACKUP_COPY_DIR is missing or differs from the original${NC}"
      exit 1
    fi
  else
    echo -e "${YELLOW}! BACKUP_COPY_DIR is unset: this archive is the only copy.${NC}"
  fi

else
  echo -e "${RED}✗ Backup failed${NC}"
  exit 1
fi

# Delete old backups
echo ""
echo "Cleaning up old backups (retention: $RETENTION_DAYS days)..."
DELETED_COUNT=0

PRUNE_DIRS=("$BACKUP_DIR")
if [ -n "$BACKUP_COPY_DIR" ]; then
  PRUNE_DIRS+=("$BACKUP_COPY_DIR")
fi

for old_backup in $(find "${PRUNE_DIRS[@]}" \( -name "allinone-db-*.archive.gz" -o -name "allinone-db-*.archive.gz.enc" \) -mtime +$RETENTION_DAYS 2>/dev/null); do
  rm -f "$old_backup"
  echo "Deleted: $old_backup"
  DELETED_COUNT=$((DELETED_COUNT + 1))
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
if [[ "$BACKUP_FILE" == *.enc ]]; then
  echo "1. Verify backup integrity: BACKUP_PASSPHRASE=... openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass env:BACKUP_PASSPHRASE -in $BACKUP_FILE | gzip -t"
else
  echo "1. Verify backup integrity: gzip -t $BACKUP_FILE"
fi
echo "2. Copy to remote storage for safekeeping"
echo "3. Test restore procedure periodically"
