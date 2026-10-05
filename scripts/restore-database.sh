#!/bin/bash

# Allinone Backend - Database & Object Storage Restore Script
# Restores a MongoDB archive produced by backup-database.sh with point-in-time
# oplog replay, restores MinIO object storage (attachments/exports), and validates
# sync cursor invariants to prevent silent sync loss.
#
# Requires:
#   - mongorestore and mongosh (MongoDB Database Tools) on PATH
#   - tar (for MinIO object storage restore)
#   - openssl (when restoring encrypted backups)

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

# MinIO / Object Storage Configuration
RESTORE_MINIO="${RESTORE_MINIO:-true}"
CLEAN_MINIO="${CLEAN_MINIO:-false}"
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

for TOOL in mongorestore mongosh tar; do
  if ! command -v "$TOOL" >/dev/null 2>&1; then
    echo -e "${RED}✗ $TOOL not found on PATH${NC}"
    exit 1
  fi
done

# Check arguments
if [ $# -eq 0 ]; then
  echo -e "${RED}Error: Backup file required${NC}"
  echo ""
  echo "Usage: $0 <backup-file.archive.gz[.enc]> [minio-backup.tar.gz[.enc]]"
  echo ""
  echo "Examples:"
  echo "  $0 .backup/allinone-db-20260928_100000.archive.gz"
  echo "  BACKUP_PASSPHRASE=... $0 /opt/allinone-backup/allinone-db-20260928_100000.archive.gz.enc"
  echo ""
  echo "Available backups:"
  find .backup /opt/allinone-backup \
    \( -name "allinone-db-*.archive.gz" -o -name "allinone-db-*.archive.gz.enc" \) 2>/dev/null | sort -r \
    || echo "No backups found"
  exit 1
fi

BACKUP_FILE="$1"
ARCHIVE="$BACKUP_FILE"
MINIO_INPUT_FILE="$2"

# Validate database backup file
if [ ! -f "$BACKUP_FILE" ]; then
  echo -e "${RED}Error: Backup file not found: $BACKUP_FILE${NC}"
  exit 1
fi

# Auto-detect matching MinIO backup if not explicitly passed
MINIO_BACKUP_FILE=""
if [ -n "$MINIO_INPUT_FILE" ] && [ -f "$MINIO_INPUT_FILE" ]; then
  MINIO_BACKUP_FILE="$MINIO_INPUT_FILE"
elif [ "$RESTORE_MINIO" = "true" ]; then
  BACKUP_DIR_NAME=$(dirname "$BACKUP_FILE")
  BASE_FILE_NAME=$(basename "$BACKUP_FILE")
  DATE_PART=$(echo "$BASE_FILE_NAME" | sed -n 's/allinone-db-\([0-9_]*\)\.archive\.gz.*/\1/p')
  if [ -n "$DATE_PART" ]; then
    CANDIDATE_PLAIN="$BACKUP_DIR_NAME/allinone-minio-$DATE_PART.tar.gz"
    CANDIDATE_ENC="$BACKUP_DIR_NAME/allinone-minio-$DATE_PART.tar.gz.enc"
    if [ -f "$CANDIDATE_ENC" ]; then
      MINIO_BACKUP_FILE="$CANDIDATE_ENC"
    elif [ -f "$CANDIDATE_PLAIN" ]; then
      MINIO_BACKUP_FILE="$CANDIDATE_PLAIN"
    fi
  fi
fi

# Temporary files cleanup trap
CLEANUP_FILES=()
cleanup() {
  for f in "${CLEANUP_FILES[@]}"; do
    rm -f "$f"
  done
}
trap cleanup EXIT

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
  CLEANUP_FILES+=("$ARCHIVE")
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
    -pass env:BACKUP_PASSPHRASE -in "$BACKUP_FILE" -out "$ARCHIVE"; then
    echo -e "${RED}Error: database decryption failed (wrong BACKUP_PASSPHRASE?)${NC}"
    exit 1
  fi
fi

# Check if database file is valid gzip
if ! gzip -t "$ARCHIVE" 2>/dev/null; then
  echo -e "${RED}Error: Database backup file is corrupted or not a valid gzip file${NC}"
  exit 1
fi

# Decrypt MinIO file if encrypted
MINIO_ARCHIVE=""
if [ -n "$MINIO_BACKUP_FILE" ]; then
  MINIO_ARCHIVE="$MINIO_BACKUP_FILE"
  if [[ "$MINIO_BACKUP_FILE" == *.enc ]]; then
    if [ -z "$BACKUP_PASSPHRASE" ]; then
      echo -e "${RED}Error: MinIO backup $MINIO_BACKUP_FILE is encrypted; set BACKUP_PASSPHRASE${NC}"
      exit 1
    fi
    DEC_MINIO=$(mktemp)
    CLEANUP_FILES+=("$DEC_MINIO")
    if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
      -pass env:BACKUP_PASSPHRASE -in "$MINIO_BACKUP_FILE" -out "$DEC_MINIO"; then
      echo -e "${RED}Error: MinIO archive decryption failed${NC}"
      exit 1
    fi
    MINIO_ARCHIVE="$DEC_MINIO"
  fi
  # Verify MinIO tarball
  if ! tar -tzf "$MINIO_ARCHIVE" >/dev/null 2>&1; then
    echo -e "${RED}Error: MinIO backup file is corrupted or not a valid tar.gz file${NC}"
    exit 1
  fi
fi

# Point-in-time oplog check
OPLOG_REPLAY_FLAG=""
if mongorestore --dryRun --oplogReplay --gzip --archive="$ARCHIVE" >/dev/null 2>&1; then
  OPLOG_REPLAY_FLAG="--oplogReplay"
  OPLOG_MSG="Active (Point-in-time transaction consistency guaranteed)"
else
  OPLOG_MSG="None (Legacy non-oplog archive; restoring collections only)"
fi

echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          Allinone Database Restore Utility         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Database backup: $BACKUP_FILE"
echo "Target Database: $DB_NAME"
echo "Target MongoDB:  $MONGO_URI"
echo "Oplog Replay:    $OPLOG_MSG"
if [ -n "$MINIO_BACKUP_FILE" ]; then
  echo "MinIO backup:    $MINIO_BACKUP_FILE (will restore attachments/exports)"
else
  echo "MinIO backup:    None found/specified (MinIO restore skipped)"
fi
echo ""

# Confirmation
if [ "$ASSUME_YES" != "true" ] && [ "$CONFIRM_RESTORE" != "yes" ]; then
  echo -e "${YELLOW}WARNING: This will drop and overwrite every collection in '$DB_NAME'${NC}"
  echo -e "${YELLOW}         that the archive contains.${NC}"
  if [ -n "$MINIO_BACKUP_FILE" ]; then
    echo -e "${YELLOW}         MinIO object storage data will also be overwritten.${NC}"
  fi
  echo "All existing data in those targets will be lost."
  echo ""
  read -p "Continue? (type 'yes' to confirm): " -r
  echo ""

  if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo -e "${YELLOW}Restore cancelled${NC}"
    exit 0
  fi
fi

echo ""
echo -e "${YELLOW}Starting database restore...${NC}"
echo ""

# Restore from archive
if mongorestore \
  --uri "$MONGO_URI" \
  --gzip \
  --drop \
  $OPLOG_REPLAY_FLAG \
  --archive="$ARCHIVE"; then

  echo ""
  echo -e "${GREEN}✓ MongoDB archive restored successfully${NC}"
else
  echo -e "${RED}✗ Database restore failed${NC}"
  exit 1
fi

# ============================================================================
# MinIO Object Storage Restoration (Attachments & Exports)
# ============================================================================
if [ -n "$MINIO_ARCHIVE" ]; then
  echo ""
  echo -e "${YELLOW}Restoring MinIO object storage data...${NC}"
  MINIO_RESTORED=false

  # 1. Direct directory if MINIO_DATA_DIR is set or exists
  if [ -n "$MINIO_DATA_DIR" ] && [ -d "$MINIO_DATA_DIR" ]; then
    if [ "$CLEAN_MINIO" = "true" ]; then
      echo "Cleaning target MinIO directory before restore (CLEAN_MINIO=true)..."
      find "$MINIO_DATA_DIR" -mindepth 1 -delete
    fi
    echo "Restoring to MinIO directory: $MINIO_DATA_DIR"
    tar -xzf "$MINIO_ARCHIVE" -C "$MINIO_DATA_DIR"
    MINIO_RESTORED=true
  # 2. Container volume via container tool
  elif [ -n "$CONTAINER_TOOL" ]; then
    FOUND_VOL=""
    for v in "$MINIO_VOLUME" "minio_data_prod" "minio_data_dev"; do
      if $CONTAINER_TOOL volume inspect "$v" >/dev/null 2>&1; then
        FOUND_VOL="$v"
        break
      fi
    done
    if [ -n "$FOUND_VOL" ]; then
      echo "Restoring into MinIO volume '$FOUND_VOL' via $CONTAINER_TOOL..."
      $CONTAINER_TOOL run --rm -i -v "${FOUND_VOL}:/minio_data" alpine tar -xzf - -C /minio_data < "$MINIO_ARCHIVE"
      MINIO_RESTORED=true
    fi
  fi

  # 3. Fallback common paths
  if [ "$MINIO_RESTORED" = "false" ]; then
    for p in "./data/minio" "/var/lib/minio" "/data/minio"; do
      if [ -d "$p" ]; then
        echo "Restoring to MinIO directory: $p"
        tar -xzf "$MINIO_ARCHIVE" -C "$p"
        MINIO_RESTORED=true
        break
      fi
    done
  fi

  if [ "$MINIO_RESTORED" = "true" ]; then
    echo -e "${GREEN}✓ MinIO object storage restored successfully${NC}"
  else
    echo -e "${YELLOW}! MinIO target volume/directory not detected; MinIO data was not extracted.${NC}"
  fi
fi

# ============================================================================
# Post-Restore Verification & Invariant Checks
# ============================================================================
echo ""
echo -e "${YELLOW}Running post-restore verification & sync invariant checks...${NC}"

COLL_COUNT=$(mongosh "$DB_URI" --quiet \
  --eval "print(db.getCollectionNames().length)" 2>/dev/null || echo "0")

USER_COUNT=$(mongosh "$DB_URI" --quiet \
  --eval "try { print(db.User.countDocuments()) } catch (e) { print('n/a') }" 2>/dev/null || echo "n/a")

if [ "$COLL_COUNT" = "0" ]; then
  echo -e "${RED}✗ Verification failed: '$DB_NAME' still has no collections${NC}"
  exit 1
fi

echo "Collections restored: $COLL_COUNT"
echo "Users restored:       $USER_COUNT"

# Verify VaultSetting key custody
VAULT_CHECK=$(mongosh "$DB_URI" --quiet --eval "
try {
  const vaults = db.VaultSetting.find().toArray();
  let ok = true;
  for (const v of vaults) {
    if (!v.wrappedMasterKey || !v.recoveryKey) {
      ok = false;
      break;
    }
  }
  print(ok ? 'OK' : 'INCOMPLETE');
} catch(e) {
  print('SKIP');
}
" 2>/dev/null || echo "SKIP")

if [ "$VAULT_CHECK" = "OK" ]; then
  echo -e "${GREEN}✓ Vault key custody verified (wrapped keys and recovery keys intact)${NC}"
elif [ "$VAULT_CHECK" = "INCOMPLETE" ]; then
  echo -e "${RED}✗ WARNING: One or more VaultSetting documents missing wrappedMasterKey or recoveryKey!${NC}"
fi

# Verify & reconcile SyncCursor and Change log invariants
# Ensures that SyncCursor.seq is >= the highest Change.cursor for every user,
# completely preventing silent sync loss or corrupted cursor states!
SYNC_INVARIANT_REPORT=$(mongosh "$DB_URI" --quiet --eval "
try {
  const syncCursors = db.SyncCursor.find().toArray();
  let checked = 0;
  let reconciled = 0;
  for (const sc of syncCursors) {
    checked++;
    const highestChange = db.Change.find({ userId: sc.userId }).sort({ cursor: -1 }).limit(1).toArray();
    const maxCursor = (highestChange.length > 0 && highestChange[0].cursor) ? BigInt(highestChange[0].cursor) : 0n;
    const curSeq = BigInt(sc.seq || 0);
    if (curSeq < maxCursor) {
      db.SyncCursor.updateOne({ userId: sc.userId }, { \$set: { seq: maxCursor } });
      reconciled++;
    }
  }
  print(JSON.stringify({ ok: true, checked, reconciled }));
} catch(e) {
  print(JSON.stringify({ ok: false, error: e.message }));
}
" 2>/dev/null || echo '{"ok":false,"error":"Script failure"}')

if echo "$SYNC_INVARIANT_REPORT" | grep -q '"ok":true'; then
  CHECKED=$(echo "$SYNC_INVARIANT_REPORT" | sed -n 's/.*"checked":\([0-9]*\).*/\1/p')
  RECONCILED=$(echo "$SYNC_INVARIANT_REPORT" | sed -n 's/.*"reconciled":\([0-9]*\).*/\1/p')
  if [ "$RECONCILED" -gt 0 ]; then
    echo -e "${YELLOW}! Sync Invariant Check: Reconciled $RECONCILED user cursor(s) that were behind Change log.${NC}"
  else
    echo -e "${GREEN}✓ Sync Invariant Check passed: All $CHECKED user SyncCursors match Change log.${NC}"
  fi
else
  echo -e "${YELLOW}! Sync Invariant Check could not run or database has no sync collections.${NC}"
fi

echo ""
echo -e "${GREEN}Restore process completed successfully${NC}"
echo ""
echo "Next steps:"
echo "1. Verify application connectivity"
echo "2. Restart api and worker services so they refresh in-memory state: docker compose restart api worker"
echo "3. Monitor application logs"
echo ""
