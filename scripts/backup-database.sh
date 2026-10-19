#!/bin/bash

# Allinone Backend - Database & Object Storage Backup Script
# Archives one application database by default (the shape that works against a
# managed cluster), with an explicitly named whole-server `--oplog` mode for a
# self-hosted replica set. Also archives MinIO object storage.
#
# The target comes from DATABASE_URL when one is set — that is the variable the
# API and the worker actually use, and the only one a Railway deployment has.
# It is never printed: only scheme, host, port and database are.
#
# Requires:
#   - mongodump, mongosh (MongoDB Database Tools) on PATH
#   - openssl when BACKUP_PASSPHRASE is set
#   - tar (for MinIO object storage backup)
#
# Run it from a checkout or a fetched copy of these scripts, not from inside the
# deployed image: `.dockerignore` keeps `scripts/` out of the build context
# (apart from worker-preflight.js), precisely so operational tools that can reach
# a production database do not ship with the process that serves traffic.

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

DB_NAME="${DB_NAME:-}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-27017}"

# A production backup contains account, session and vault metadata. Refuse to
# create a recoverable plaintext archive when production mode is declared.
if [ "${APP_ENV:-}" = "production" ] && [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "Error: BACKUP_PASSPHRASE is required for production backups" >&2
  exit 1
fi

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

# ============================================================================
# Target resolution.
#
# `DATABASE_URL` is the deployment's only answer to "which database?", so it is
# this script's first one. Until 2026-10-19 it was not consulted at all: the
# default was `mongodb://$DB_HOST:$DB_PORT/?directConnection=true`, a shape the
# deleted docker-compose.prod.yml needed, and nothing in the Railway deployment
# sets DB_HOST or DB_PORT. Against Atlas (the real target) the connectivity probe
# below therefore failed and the backup exited 1 while looking configured.
#
# Precedence, first hit wins:
#   MONGO_URI      an operator naming a server explicitly (scratch targets, DR test)
#   DATABASE_URL   what the API and the worker actually connect with — Atlas in prod
#   DB_HOST:DB_PORT + directConnection
#                  the self-hosted single-node replica set on a laptop, unchanged
#
# `DATABASE_URL` carries the database in its path and the credentials in its
# authority, so it is decomposed rather than handed around whole:
#   SERVER_URI   host + query, no authority, no database. Kept for the derivation
#               and for reading the shape of the target; not what the tools connect
#               with, because mongodump/mongorestore must authenticate as the
#               application account on a managed cluster.
#   DB_URI       authority + host + database + query — every tool call gets this.
#               mongosh ignores --db and would otherwise probe `test`.
#   TARGET_SHOWN host, port and database with the authority removed — the only form
#               this script prints. A production `DATABASE_URL` puts the Atlas
#               password in the authority, and cron output is read by more people
#               than the service is.
# ============================================================================
URI_INPUT="${MONGO_URI:-${DATABASE_URL:-mongodb://$DB_HOST:$DB_PORT/?directConnection=true}}"

URI_BASE="${URI_INPUT%%\?*}"
URI_QUERY=""
if [ "$URI_BASE" != "$URI_INPUT" ]; then
  URI_QUERY="?${URI_INPUT#*\?}"
fi
URI_SCHEME="${URI_BASE%%://*}"
URI_AUTHORITY="${URI_BASE#*://}"

URI_CREDENTIALS=""
URI_HOSTPART="$URI_AUTHORITY"
case "$URI_AUTHORITY" in
  *@*)
    URI_CREDENTIALS="${URI_AUTHORITY%%@*}@"
    URI_HOSTPART="${URI_AUTHORITY#*@}"
    ;;
esac

URI_HOSTPORT="${URI_HOSTPART%%/*}"
URI_DB_FROM_URL=""
if [ "$URI_HOSTPORT" != "$URI_HOSTPART" ]; then
  URI_DB_FROM_URL="${URI_HOSTPART#*/}"
fi

SERVER_URI="$URI_SCHEME://$URI_HOSTPORT/"
if [ -n "$URI_QUERY" ]; then
  SERVER_URI="$URI_SCHEME://$URI_HOSTPORT$URI_QUERY"
fi

# An explicit DB_NAME wins; otherwise take the database the URI names; otherwise
# the pre-Atlas default, which is only a sensible guess next to a localhost mongod.
if [ -z "$DB_NAME" ] && [ -n "$URI_DB_FROM_URL" ]; then
  DB_NAME="$URI_DB_FROM_URL"
fi
if [ -z "$DB_NAME" ]; then
  DB_NAME="allinone_prod"
fi

TARGET_SHOWN="$URI_SCHEME://$URI_HOSTPORT/$DB_NAME"

# Refuse a target that is not an application database. `--db admin` on a shared
# server is how a backup job turns into an incident, and an empty path means the
# URI was written without one.
case "$DB_NAME" in
  ""|admin|local|config|test)
    echo "Error: refusing to back up database '$DB_NAME' at $TARGET_SHOWN" >&2
    echo "  The target must be a real application database. Set DB_NAME, or use a" >&2
    echo "  DATABASE_URL whose path names one." >&2
    exit 1
    ;;
esac

DB_URI="$URI_SCHEME://$URI_CREDENTIALS$URI_HOSTPORT/$DB_NAME$URI_QUERY"

# The authenticated URI with no database in its path, for the one job that must
# not have one: the MongoDB tools take a URI's path component as a default --db,
# and `mongodump --oplog` refuses to run with --db at all. Without this form the
# whole-server snapshot mode would fail on its own flag.
AUTH_SERVER_URI="$URI_SCHEME://$URI_CREDENTIALS$URI_HOSTPORT/${URI_QUERY}"

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
echo -e "${BLUE}║           Allinone Database Backup Utility          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
echo "Database: $DB_NAME"
# Redacted on purpose: the authority of a production URI holds the Atlas password.
echo "Target:   $TARGET_SHOWN"
echo "Backup destination: $BACKUP_DIR"
echo "Database backup file: $BACKUP_FILE"
echo ""

# Pre-flight: verify target database connectivity and collections
COLLECTION_COUNT=$(mongosh "$DB_URI" --quiet --eval "db.getCollectionNames().length" 2>/dev/null || echo "0")
if [ "$COLLECTION_COUNT" = "0" ]; then
  echo -e "${RED}✗ Database '$DB_NAME' has no collections at $TARGET_SHOWN${NC}" >&2
  echo -e "${RED}  Check DB_NAME, or the database in the path of DATABASE_URL.${NC}" >&2
  exit 1
fi
echo "Database collections in '$DB_NAME': $COLLECTION_COUNT"

# ============================================================================
# Dump mode.
#
# Two shapes, and mongodump will not blend them: `--oplog` requires a replica set
# and forbids `--db`, so an oplog snapshot is by construction a dump of every
# database the server holds. The pre-2026-10-19 version of this script took that
# path unconditionally whenever `rs.status()` answered 1 — which on a shared
# server, or on an Atlas cluster whose account can read other databases, means the
# archive quietly contains more than the application.
#
#   default                       one database, no oplog, restore needs no --drop
#                                 of anything outside it. This is what Atlas wants:
#                                 cross-collection point-in-time consistency there
#                                 is the managed cluster's own recovery feature,
#                                 not something an archive can carry.
#   OPLOG_WHOLE_SERVER_BACKUP=true
#                                 the old whole-server snapshot, self-hosted
#                                 replica sets only, and the operator has to name
#                                 it because the archive is server-scoped.
#
# `mongodb+srv` is read as "managed cluster": Atlas always runs a replica set, and
# an application-scoped account is not allowed to call rs.status(), so the old
# probe answered 0 on exactly the target this script now runs against.
# ============================================================================
IS_ATLAS=false
[ "$URI_SCHEME" = "mongodb+srv" ] && IS_ATLAS=true
# A seedlist (two or more hosts) or an explicit replicaSet= parameter says
# "replica set" even when the connecting account is not allowed to ask: Atlas
# allows a non-admin SRV-form URI too, and rs.status() is an admin command.
IS_REPLICA_SEEDLIST=false
case "$URI_HOSTPORT" in
  *,*) IS_REPLICA_SEEDLIST=true ;;
esac
case "$URI_QUERY" in
  *replicaSet=*) IS_REPLICA_SEEDLIST=true ;;
esac
IS_REPLSET=$(mongosh "$AUTH_SERVER_URI" --quiet --eval "try { rs.status().ok } catch(e) { 0 }" 2>/dev/null || echo "0")

DUMP_MODE="database"
if [ "${OPLOG_WHOLE_SERVER_BACKUP:-false}" = "true" ]; then
  DUMP_MODE="oplog-whole-server"
fi

if [ "$DUMP_MODE" = "oplog-whole-server" ]; then
  if [ "$IS_ATLAS" = "true" ]; then
    echo -e "${RED}✗ OPLOG_WHOLE_SERVER_BACKUP is set against a managed (mongodb+srv) cluster.${NC}" >&2
    echo -e "${RED}  Point-in-time recovery there is the Atlas cluster feature, not this flag:${NC}" >&2
    echo -e "${RED}  an archive cannot carry the oplog of a cluster whose membership you do not${NC}" >&2
    echo -e "${RED}  control, and dumping every database in it is not what a scheduled job should${NC}" >&2
    echo -e "${RED}  do. Unset the flag and let the per-database dump be the portable copy.${NC}" >&2
    exit 1
  fi
  if [ "$IS_REPLSET" != "1" ] && [ "$IS_REPLICA_SEEDLIST" != "true" ]; then
    echo -e "${RED}✗ mongodump --oplog needs a replica set; $TARGET_SHOWN did not answer rs.status() and its URI names no replica set.${NC}" >&2
    exit 1
  fi
  echo -e "${YELLOW}! Whole-server oplog snapshot: the archive will contain EVERY database on this${NC}"
  echo -e "${YELLOW}  server, not just '$DB_NAME'. Restore stays scoped to one database unless the${NC}"
  echo -e "${YELLOW}  operator names that flag too (see scripts/restore-database.sh).${NC}"
elif [ "$IS_REPLSET" != "1" ] && [ "$IS_ATLAS" != "true" ] && [ "$IS_REPLICA_SEEDLIST" != "true" ]; then
  if [ "$ALLOW_NON_TRANSACTIONAL_BACKUP" = "true" ]; then
    echo -e "${YELLOW}! WARNING: MongoDB is not running as a replica set and the operator accepted it.${NC}"
    echo -e "${YELLOW}  Per-collection dump without --oplog: NOT point-in-time consistent across collections.${NC}"
  else
    echo -e "${RED}✗ Error: MongoDB instance is not a replica set (rs.status().ok != 1).${NC}" >&2
    echo -e "${RED}  Point-in-time transaction consistency between the Change log and SyncCursor${NC}" >&2
    echo -e "${RED}  requires either a managed cluster (which has its own point-in-time recovery)${NC}" >&2
    echo -e "${RED}  or a whole-server oplog snapshot: OPLOG_WHOLE_SERVER_BACKUP=true.${NC}" >&2
    echo -e "${RED}  To override in non-production, set ALLOW_NON_TRANSACTIONAL_BACKUP=true.${NC}" >&2
    exit 1
  fi
else
  echo -e "${GREEN}✓ Per-database snapshot of '$DB_NAME'.${NC}"
  echo -e "${GREEN}  Cross-collection point-in-time recovery is the managed cluster's feature${NC}"
  echo -e "${GREEN}  (Atlas: Backup → point-in-time), not this archive's. On a self-hosted${NC}"
  echo -e "${GREEN}  replica set, OPLOG_WHOLE_SERVER_BACKUP=true takes the server-scoped dump.${NC}"
fi
echo ""

# Execute mongodump
if [ "$DUMP_MODE" = "oplog-whole-server" ]; then
  echo -e "${YELLOW}Creating whole-server point-in-time backup (--oplog, no --db)...${NC}"
  mongodump \
    --uri "$AUTH_SERVER_URI" \
    --oplog \
    --gzip \
    --archive="$BACKUP_FILE"
else
  echo -e "${YELLOW}Creating single-database backup ('$DB_NAME', no oplog)...${NC}"
  mongodump \
    --uri "$DB_URI" \
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

if [ "$DUMP_MODE" = "oplog-whole-server" ]; then
  echo "Verifying oplog replay capability in archive..."
  # --uri is not decoration: mongorestore defaults to localhost:27017, and this
  # dry run has to be answered by the server the dump came from. A dry run writes
  # nothing, so pointing it back at the dump's own target is safe.
  if mongorestore \
    --uri "$AUTH_SERVER_URI" \
    --dryRun \
    --oplogReplay \
    --nsInclude="$DB_NAME.*" \
    --gzip \
    --archive="$BACKUP_FILE" >/dev/null 2>&1; then
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
# `target` is the redacted form for the same reason the console output is: a
# manifest is the file somebody emails to a colleague when a restore goes wrong.
cat <<EOF > "$MANIFEST_FILE"
{
  "timestamp": "$BACKUP_DATE",
  "database": {
    "name": "$DB_NAME",
    "file": "$(basename "$BACKUP_FILE")",
    "target": "$TARGET_SHOWN",
    "mode": "$DUMP_MODE",
    "oplogConsistent": $([ "$DUMP_MODE" = "oplog-whole-server" ] && echo "true" || echo "false"),
    "wholeServerArchive": $([ "$DUMP_MODE" = "oplog-whole-server" ] && echo "true" || echo "false"),
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
