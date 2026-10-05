#!/bin/bash

# Allinone Backend - Database & Object Storage Backup Script
# Creates compressed, transaction-consistent MongoDB backups with oplog
# point-in-time snapshots and MinIO object storage backups.
#
# Requires:
#   - mongodump, mongosh (MongoDB Database Tools) on PATH
#   - openssl when BACKUP_PASSPHRASE is set
#   - tar (for MinIO object storage backup)

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
MINIO_BACKUP_FILE="$BACKUP_DIR/allinone-minio-$BACKUP_DATE.tar.gz"
MANIFEST_FILE="$BACKUP_DIR/allinone-manifest-$BACKUP_DATE.json"

DB_NAME="${DB_NAME:-allinone_prod}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-27017}"

# MinIO / Object Storage Configuration
BACKUP_MINIO="${BACKUP_MINIO:-true}"
MINIO_DATA_DIR="${MINIO_DATA_DIR:-}"
MINIO_VOLUME="${MINIO_VOLUME:-minio_data_prod}"
CONTAINER_TOOL="${CONTAINER_TOOL:-}"
if [ -z "$CONTAINER_TOOL" ]; then
  if command -v podman >/dev/null 2>&1; then
    CONTAINER_TOOL="podman"
  elif command -v docker >/dev/null 2>&1; then
    CONTAINER_TOOL="docker"
  fi
fi

# directConnection is required because both compose stacks run a single-member
# replica set initiated as 127.0.0.1:27017; without it a client in another
# container discovers that address and talks to itself.
# MONGO_URI names the server only — leave the database out of its path.
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
BLUE='\033[0;34m'
NC='\033[0m' # No Color

for TOOL in mongodump mongosh tar; do
  if ! command -v "$TOOL" >/dev/null 2>&1; then
    echo -e "${RED}✗ $TOOL not found on PATH${NC}"
    exit 1
  fi
done

echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          Allinone Point-in-Time Backup Utility     ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
echo "Database: $DB_NAME"
echo "Target: $MONGO_URI"
echo "Backup destination: $BACKUP_DIR"
echo "Database backup file: $BACKUP_FILE"
echo ""

# Pre-flight: verify target database connectivity and collections
COLLECTION_COUNT=$(mongosh "$DB_URI" --quiet --eval "db.getCollectionNames().length" 2>/dev/null || echo "0")
if [ "$COLLECTION_COUNT" = "0" ]; then
  echo -e "${RED}✗ Database '$DB_NAME' has no collections - check DB_NAME / MONGO_URI${NC}"
  exit 1
fi
echo "Database collections in '$DB_NAME': $COLLECTION_COUNT"

# Point-in-time snapshot check:
# mongodump --oplog takes a transaction-consistent snapshot across all collections.
# In MongoDB, --oplog requires a replica set (which both compose stacks and production run)
# and only works on a full instance dump (omitting --db).
IS_REPLSET=$(mongosh "$MONGO_URI" --quiet --eval "try { rs.status().ok } catch(e) { 0 }" 2>/dev/null || echo "0")
USE_OPLOG=false

if [ "$IS_REPLSET" = "1" ]; then
  USE_OPLOG=true
  echo -e "${GREEN}✓ Replica set active: point-in-time transaction consistency (--oplog) enabled${NC}"
else
  if [ "$ALLOW_NON_TRANSACTIONAL_BACKUP" = "true" ]; then
    echo -e "${YELLOW}! WARNING: MongoDB is not running as a replica set.${NC}"
    echo -e "${YELLOW}  Taking multi-collection backup without --oplog (NOT point-in-time consistent!)${NC}"
    USE_OPLOG=false
  else
    echo -e "${RED}✗ Error: MongoDB instance is not a replica set (rs.status().ok != 1).${NC}"
    echo -e "${RED}  Point-in-time transaction consistency between Change log and SyncCursor${NC}"
    echo -e "${RED}  strictly requires an oplog. To override in non-production, set ALLOW_NON_TRANSACTIONAL_BACKUP=true.${NC}"
    exit 1
  fi
fi
echo ""

# Execute mongodump
echo -e "${YELLOW}Creating MongoDB point-in-time backup...${NC}"
if [ "$USE_OPLOG" = "true" ]; then
  # Full dump with oplog to guarantee point-in-time transaction consistency
  mongodump \
    --uri "$MONGO_URI" \
    --oplog \
    --gzip \
    --archive="$BACKUP_FILE"
else
  # Non-oplog fallback (standalone only if explicitly allowed)
  mongodump \
    --uri "$MONGO_URI" \
    --db "$DB_NAME" \
    --gzip \
    --archive="$BACKUP_FILE"
fi

FILE_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo -e "${GREEN}✓ MongoDB backup created successfully ($FILE_SIZE)${NC}"

# Verify archive integrity
echo "Verifying database archive integrity..."
if gzip -t "$BACKUP_FILE"; then
  echo -e "${GREEN}✓ Gzip integrity check passed${NC}"
else
  echo -e "${RED}✗ Backup archive corrupted!${NC}"
  rm -f "$BACKUP_FILE"
  exit 1
fi

if [ "$USE_OPLOG" = "true" ]; then
  echo "Verifying oplog replay capability in archive..."
  if mongorestore --dryRun --oplogReplay --gzip --archive="$BACKUP_FILE" >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Point-in-time oplog verification passed${NC}"
  else
    echo -e "${RED}✗ Backup archive missing valid oplog entries!${NC}"
    rm -f "$BACKUP_FILE"
    exit 1
  fi
fi

# Optional encryption of database archive
if [ -n "$BACKUP_PASSPHRASE" ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    rm -f "$BACKUP_FILE"
    echo -e "${RED}✗ openssl not found on PATH; plaintext dump deleted${NC}"
    exit 1
  fi
  echo "Encrypting database archive..."
  if ! openssl enc -aes-256-cbc -pbkdf2 -iter 100000 \
    -pass env:BACKUP_PASSPHRASE \
    -in "$BACKUP_FILE" -out "$BACKUP_FILE.enc"; then
    rm -f "$BACKUP_FILE" "$BACKUP_FILE.enc"
    echo -e "${RED}✗ Encryption failed; plaintext dump deleted${NC}"
    exit 1
  fi
  rm -f "$BACKUP_FILE"
  BACKUP_FILE="$BACKUP_FILE.enc"

  # Decrypting back through gzip -t proves both the passphrase and the payload
  if openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
    -pass env:BACKUP_PASSPHRASE -in "$BACKUP_FILE" | gzip -t; then
    echo -e "${GREEN}✓ Database encryption round-trip passed${NC}"
    echo "Encrypted file size: $(du -h "$BACKUP_FILE" | cut -f1)"
  else
    echo -e "${RED}✗ Encrypted archive does not decrypt${NC}"
    rm -f "$BACKUP_FILE"
    exit 1
  fi
else
  echo -e "${YELLOW}! BACKUP_PASSPHRASE is unset: the database archive is plaintext.${NC}"
fi

# Secondary copy for database backup
if [ -n "$BACKUP_COPY_DIR" ]; then
  mkdir -p "$BACKUP_COPY_DIR"
  if cp "$BACKUP_FILE" "$BACKUP_COPY_DIR/" &&
     cmp -s "$BACKUP_FILE" "$BACKUP_COPY_DIR/$(basename "$BACKUP_FILE")"; then
    echo -e "${GREEN}✓ Verified database copy in $BACKUP_COPY_DIR${NC}"
  else
    echo -e "${RED}✗ Database copy in $BACKUP_COPY_DIR is missing or differs from original${NC}"
    exit 1
  fi
fi

# ============================================================================
# MinIO Object Storage Backup (Attachments & Exports)
# ============================================================================
MINIO_STATUS="skipped"
if [ "$BACKUP_MINIO" = "true" ]; then
  echo ""
  echo -e "${YELLOW}Starting MinIO object storage backup (attachments/exports)...${NC}"
  MINIO_BACKED_UP=false

  # 1. Direct directory if MINIO_DATA_DIR is set and exists
  if [ -n "$MINIO_DATA_DIR" ] && [ -d "$MINIO_DATA_DIR" ]; then
    echo "Backing up MinIO directory: $MINIO_DATA_DIR"
    if tar -czf "$MINIO_BACKUP_FILE" -C "$MINIO_DATA_DIR" .; then
      MINIO_BACKED_UP=true
    fi
  # 2. Container volume via podman or docker
  elif [ -n "$CONTAINER_TOOL" ]; then
    FOUND_VOL=""
    for v in "$MINIO_VOLUME" "minio_data_prod" "minio_data_dev"; do
      if $CONTAINER_TOOL volume inspect "$v" >/dev/null 2>&1; then
        FOUND_VOL="$v"
        break
      fi
    done
    if [ -n "$FOUND_VOL" ]; then
      echo "Backing up MinIO volume '$FOUND_VOL' using $CONTAINER_TOOL..."
      if $CONTAINER_TOOL run --rm -v "${FOUND_VOL}:/minio_data:ro" alpine tar -czf - -C /minio_data . > "$MINIO_BACKUP_FILE"; then
        MINIO_BACKED_UP=true
      fi
    fi
  fi

  # 3. Fallback check common local paths
  if [ "$MINIO_BACKED_UP" = "false" ]; then
    for p in "./data/minio" "/var/lib/minio" "/data/minio"; do
      if [ -d "$p" ]; then
        echo "Backing up MinIO directory: $p"
        if tar -czf "$MINIO_BACKUP_FILE" -C "$p" .; then
          MINIO_BACKED_UP=true
          break
        fi
      fi
    done
  fi

  if [ "$MINIO_BACKED_UP" = "true" ]; then
    echo -e "${GREEN}✓ MinIO archive created ($(du -h "$MINIO_BACKUP_FILE" | cut -f1))${NC}"

    # Verify MinIO tarball integrity
    echo "Verifying MinIO archive integrity..."
    if tar -tzf "$MINIO_BACKUP_FILE" >/dev/null 2>&1; then
      echo -e "${GREEN}✓ MinIO archive integrity check passed${NC}"
    else
      echo -e "${RED}✗ MinIO archive corrupted!${NC}"
      rm -f "$MINIO_BACKUP_FILE"
      exit 1
    fi

    # Encrypt MinIO archive if passphrase set
    if [ -n "$BACKUP_PASSPHRASE" ]; then
      echo "Encrypting MinIO archive..."
      if ! openssl enc -aes-256-cbc -pbkdf2 -iter 100000 \
        -pass env:BACKUP_PASSPHRASE \
        -in "$MINIO_BACKUP_FILE" -out "$MINIO_BACKUP_FILE.enc"; then
        rm -f "$MINIO_BACKUP_FILE" "$MINIO_BACKUP_FILE.enc"
        echo -e "${RED}✗ MinIO encryption failed; plaintext archive deleted${NC}"
        exit 1
      fi
      rm -f "$MINIO_BACKUP_FILE"
      MINIO_BACKUP_FILE="$MINIO_BACKUP_FILE.enc"

      if openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
        -pass env:BACKUP_PASSPHRASE -in "$MINIO_BACKUP_FILE" | tar -tzf - >/dev/null 2>&1; then
        echo -e "${GREEN}✓ MinIO encryption round-trip passed${NC}"
        echo "Encrypted MinIO file size: $(du -h "$MINIO_BACKUP_FILE" | cut -f1)"
      else
        echo -e "${RED}✗ Encrypted MinIO archive does not decrypt${NC}"
        rm -f "$MINIO_BACKUP_FILE"
        exit 1
      fi
    fi

    # Secondary copy for MinIO backup
    if [ -n "$BACKUP_COPY_DIR" ]; then
      mkdir -p "$BACKUP_COPY_DIR"
      if cp "$MINIO_BACKUP_FILE" "$BACKUP_COPY_DIR/" &&
         cmp -s "$MINIO_BACKUP_FILE" "$BACKUP_COPY_DIR/$(basename "$MINIO_BACKUP_FILE")"; then
        echo -e "${GREEN}✓ Verified MinIO copy in $BACKUP_COPY_DIR${NC}"
      else
        echo -e "${RED}✗ MinIO copy failed${NC}"
        exit 1
      fi
    fi
    MINIO_STATUS="completed"
  else
    if [ "$REQUIRE_MINIO" = "true" ]; then
      echo -e "${RED}✗ MinIO data storage not found and REQUIRE_MINIO=true${NC}"
      exit 1
    else
      echo -e "${YELLOW}! MinIO data volume not found or empty; skipped MinIO backup.${NC}"
      MINIO_BACKUP_FILE=""
      MINIO_STATUS="not_found"
    fi
  fi
fi

# Write Manifest
cat <<EOF > "$MANIFEST_FILE"
{
  "timestamp": "$BACKUP_DATE",
  "database": {
    "name": "$DB_NAME",
    "file": "$(basename "$BACKUP_FILE")",
    "oplogConsistent": $USE_OPLOG,
    "encrypted": $([ -n "$BACKUP_PASSPHRASE" ] && echo "true" || echo "false")
  },
  "minio": {
    "status": "$MINIO_STATUS",
    "file": "$([ -n "$MINIO_BACKUP_FILE" ] && basename "$MINIO_BACKUP_FILE" || echo "")",
    "encrypted": $([ -n "$BACKUP_PASSPHRASE" ] && [ -n "$MINIO_BACKUP_FILE" ] && echo "true" || echo "false")
  }
}
EOF

# Prune old backups
echo ""
echo "Cleaning up old backups (retention: $RETENTION_DAYS days)..."
DELETED_COUNT=0
PRUNE_DIRS=("$BACKUP_DIR")
if [ -n "$BACKUP_COPY_DIR" ]; then
  PRUNE_DIRS+=("$BACKUP_COPY_DIR")
fi

for old_file in $(find "${PRUNE_DIRS[@]}" \( -name "allinone-db-*.archive.gz*" -o -name "allinone-minio-*.tar.gz*" -o -name "allinone-manifest-*.json" \) -mtime +$RETENTION_DAYS 2>/dev/null); do
  rm -f "$old_file"
  echo "Deleted: $old_file"
  DELETED_COUNT=$((DELETED_COUNT + 1))
done

if [ $DELETED_COUNT -gt 0 ]; then
  echo "Deleted $DELETED_COUNT old backup file(s)"
else
  echo "No old backups to delete"
fi

echo ""
echo -e "${GREEN}✓ Backup process completed successfully${NC}"
echo "Database backup: $BACKUP_FILE"
if [ -n "$MINIO_BACKUP_FILE" ]; then
  echo "MinIO backup:    $MINIO_BACKUP_FILE"
fi
echo "Manifest:        $MANIFEST_FILE"
echo ""
