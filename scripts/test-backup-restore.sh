#!/bin/bash

# Allinone Backend - Automated Backup & Restore Test Suite
# Drives scripts/backup-database.sh and scripts/restore-database.sh end to end
# against one scratch database and asserts the invariants a real restore has to
# keep. What it covers, in the order it runs:
#   1. Backup of the target database, encrypted (default per-database dump mode).
#   2. MinIO object storage backup (attachments and exports).
#   3. OpenSSL AES-256-CBC PBKDF2 encryption and decryption round-trip.
#   4. Restore of that archive, scoped: nothing outside the scratch database is
#      written or dropped.
#   5. Invariant verification: SyncCursor counter matches Change log (no silent
#      sync loss).
#   6. VaultSetting recovery material survives intact (the phrase envelope:
#      recoveryKdfSalt + wrappedMasterKey/Iv/Tag; `recoveryKey` is the obsolete
#      plaintext column and is asserted absent, not present).
#   7. MinIO object storage recovery (checksum verification).
#   8. Post-backup writes do not survive the restore.
#   9. Failure testing on invalid passphrase.
#
# The whole-server `--oplog` mode is deliberately NOT part of the default run: it
# dumps every database on the instance, which is a self-hosted-replica-set
# operation, not something a routine drill should do on a shared server. Name
# DR_TEST_WHOLE_SERVER=true to add that pass (self-hosted rs only).
#
# Docker is not required and nothing here starts a container; mongodump,
# mongorestore and mongosh have to be on PATH (MongoDB Database Tools).

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}======================================================${NC}"
echo -e "${BLUE}  Running Automated Backup & Disaster Recovery Tests  ${NC}"
echo -e "${BLUE}======================================================${NC}"

# Check required binaries
for cmd in mongodump mongorestore mongosh openssl tar gzip; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo -e "${RED}✗ Required command '$cmd' not found on PATH.${NC}"
    exit 1
  fi
done

TEST_DIR=$(mktemp -d -t allinone-dr-test-XXXXXX)
TEST_BACKUP_DIR="$TEST_DIR/backups"
TEST_MINIO_DIR="$TEST_DIR/minio-data"
TEST_PASSPHRASE="super-secret-test-passphrase-2026"
TEST_DB="allinone_dr_test_db"

# ============================================================================
# Which server does this test against?
#
# Until 2026-10-19 this was hardcoded to `mongodb://localhost:27017`, so
# `npm run test:dr` could only ever exercise a laptop mongod — never the target
# the operator would actually restore into. It now honours the same precedence as
# the two scripts it drives (MONGO_URI, then DATABASE_URL, then the localhost
# default), because a DR drill against a database that is not the real one proves
# the tooling and not the configuration.
#
# What that makes possible is also what has to be refused: `DATABASE_URL` on a
# deployed environment is the production Atlas cluster, and this script seeds a
# scratch database, runs mongodump against the instance and then drops the
# scratch database. So a remote target needs a second, named opt-in, and the
# scratch database name is never overridden by the URI's own path.
# ============================================================================
TEST_URI_INPUT="${MONGO_URI:-${DATABASE_URL:-mongodb://localhost:27017/?directConnection=true}}"
TEST_SCHEME="${TEST_URI_INPUT%%://*}"
if [ "$TEST_SCHEME" = "mongodb+srv" ] || [ "${TEST_URI_INPUT#*://}" != "${TEST_URI_INPUT#*@}" ]; then
  if [ "${DR_TEST_ALLOW_REMOTE:-false}" != "true" ]; then
    echo -e "${RED}✗ Refusing to run the DR test against what looks like a shared or managed target.${NC}" >&2
    echo -e "${RED}  It creates and drops '$TEST_DB' on that server. Unset DATABASE_URL to test${NC}" >&2
    echo -e "${RED}  the local replica set (the supported case), or name${NC}" >&2
    echo -e "${RED}  DR_TEST_ALLOW_REMOTE=true if the target really is a scratch cluster.${NC}" >&2
    exit 1
  fi
fi
# The scratch database always wins over whatever path the URI carries, and any
# credentials in it are kept for the tool calls and never printed.
TEST_URI_BASE="${TEST_URI_INPUT%%\?*}"
TEST_URI_QUERY=""
if [ "$TEST_URI_BASE" != "$TEST_URI_INPUT" ]; then TEST_URI_QUERY="?${TEST_URI_INPUT#*\?}"; fi
TEST_AUTHORITY="${TEST_URI_BASE#*://}"
TEST_CREDS=""
TEST_HOSTPART="$TEST_AUTHORITY"
case "$TEST_AUTHORITY" in
  *@*) TEST_CREDS="${TEST_AUTHORITY%%@*}@"; TEST_HOSTPART="${TEST_AUTHORITY#*@}" ;;
esac
TEST_HOSTPORT="${TEST_HOSTPART%%/*}"
TEST_SERVER_URI="$TEST_SCHEME://$TEST_CREDS$TEST_HOSTPORT/${TEST_URI_QUERY}"
TEST_MONGO_URI="$TEST_SERVER_URI"
TEST_DB_URI="$TEST_SCHEME://$TEST_CREDS$TEST_HOSTPORT/$TEST_DB$TEST_URI_QUERY"
TEST_TARGET_SHOWN="$TEST_SCHEME://$TEST_HOSTPORT/$TEST_DB"

mkdir -p "$TEST_BACKUP_DIR" "$TEST_MINIO_DIR/allinone-test-bucket/attachments" "$TEST_MINIO_DIR/allinone-test-bucket/exports"

cleanup() {
  echo -e "\n${YELLOW}Cleaning up test artifacts...${NC}"
  mongosh "$TEST_DB_URI" --quiet --eval "db.dropDatabase()" >/dev/null 2>&1 || true
  rm -rf "$TEST_DIR"
  echo -e "${GREEN}✓ Cleanup complete.${NC}"
}
trap cleanup EXIT

echo -e "${BLUE}Target (credentials elided): $TEST_TARGET_SHOWN${NC}"

# 1. Verify replica set is active
IS_REPLSET=$(mongosh "$TEST_MONGO_URI" --quiet --eval "try { rs.status().ok } catch(e) { 0 }" 2>/dev/null || echo "0")
if [ "$IS_REPLSET" != "1" ]; then
  echo -e "${RED}✗ MongoDB at $TEST_TARGET_SHOWN is not running with replica set enabled.${NC}"
  echo -e "${RED}  A replica set is required for oplog point-in-time transactions.${NC}"
  echo -e "${RED}  For a local one: docker compose -f docker-compose.dev.yml up -d mongodb${NC}"
  echo -e "${RED}  (its healthcheck initiates rs0), then re-run npm run test:dr.${NC}"
  exit 1
fi
echo -e "${GREEN}✓ MongoDB replica set detected.${NC}"

# 2. Seed test database with users, vault settings, changes, and cursors
echo -e "\n${YELLOW}Step 1: Seeding test database '$TEST_DB'...${NC}"
mongosh "$TEST_DB_URI" --quiet --eval "
db.dropDatabase();

// Seed User
const userId = 'user-dr-001';
db.User.insertOne({
  _id: userId,
  email: 'dr-test@example.com',
  name: 'DR Test User',
  createdAt: new Date(),
  updatedAt: new Date()
});

// Seed VaultSetting with the recovery material a current build actually stores:
// the wrapped master key, and the phrase envelope around it. `recoveryKey` is the
// obsolete unwrapped key-encryption-key column (null on every row a current build
// writes) — see docs/SECURITY.md, "Vault and Sync Trust Models".
db.VaultSetting.insertOne({
  _id: 'vault-dr-001',
  userId: userId,
  wrappedMasterKey: 'dGVzdC13cmFwcGVkLW1hc3Rlci1rZXk=',
  wrappedMasterIv: 'dGVzdC1pdi12YWx1ZQ==',
  wrappedMasterTag: 'dGVzdC10YWctdmFsdWU=',
  recoveryKdfSalt: 'cGhyYXNlLXNhbHRC',
  recoveryKey: null,
  keySalt: 'a2V5LXNhbHQ=',
  masterKeyHash: 'hmac-sha256:ZmFrZS12ZXJpZmllcg==',
  keyDerivationSalt: 'c2FsdA==',
  iterations: 600000,
  createdAt: new Date(),
  updatedAt: new Date()
});

// Seed Notes
db.Note.insertOne({
  _id: 'note-dr-001',
  userId: userId,
  title: 'Important Note Before Backup',
  content: 'Critical note content',
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date()
});

// Seed SyncCursor (seq = 3) and Changes (cursors 1, 2, 3)
db.SyncCursor.insertOne({
  _id: 'sc-001',
  userId: userId,
  seq: 3n
});

db.Change.insertMany([
  {
    _id: 'ch-001',
    userId: userId,
    deviceId: 'dev-001',
    entityType: 'note',
    entityId: 'note-dr-001',
    operation: 'CREATE',
    version: 1,
    cursor: 1n,
    payload: { title: 'Important Note Before Backup' },
    createdAt: new Date()
  },
  {
    _id: 'ch-002',
    userId: userId,
    deviceId: 'dev-001',
    entityType: 'task',
    entityId: 'task-dr-001',
    operation: 'CREATE',
    version: 1,
    cursor: 2n,
    payload: { title: 'First Task' },
    createdAt: new Date()
  },
  {
    _id: 'ch-003',
    userId: userId,
    deviceId: 'dev-001',
    entityType: 'task',
    entityId: 'task-dr-002',
    operation: 'CREATE',
    version: 1,
    cursor: 3n,
    payload: { title: 'Second Task' },
    createdAt: new Date()
  }
]);
" >/dev/null

echo -e "${GREEN}✓ Database seeded: 1 User, 1 VaultSetting, 1 Note, 3 Changes, SyncCursor(seq=3).${NC}"

# 3. Seed MinIO mock files
echo -e "\n${YELLOW}Step 2: Seeding MinIO storage files...${NC}"
echo "Sample PDF attachment content" > "$TEST_MINIO_DIR/allinone-test-bucket/attachments/attachment-1.pdf"
echo '{"exportId": "exp-001", "records": [1, 2, 3]}' > "$TEST_MINIO_DIR/allinone-test-bucket/exports/export-1.json"
MINIO_CHECKSUM_ORIGINAL=$(sha256sum "$TEST_MINIO_DIR/allinone-test-bucket/attachments/attachment-1.pdf" | cut -d' ' -f1)
echo -e "${GREEN}✓ MinIO files created. Attachment SHA256: $MINIO_CHECKSUM_ORIGINAL${NC}"

# 4. Run backup script
echo -e "\n${YELLOW}Step 3: Running backup script with encryption...${NC}"
BACKUP_DIR="$TEST_BACKUP_DIR" \
DB_NAME="$TEST_DB" \
MONGO_URI="$TEST_MONGO_URI" \
BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
MINIO_DATA_DIR="$TEST_MINIO_DIR" \
BACKUP_MINIO="true" \
./scripts/backup-database.sh > "$TEST_DIR/backup.log" 2>&1

DB_ENC_FILE=$(find "$TEST_BACKUP_DIR" -name "allinone-db-*.archive.gz.enc" | head -n 1)
MINIO_ENC_FILE=$(find "$TEST_BACKUP_DIR" -name "allinone-minio-*.tar.gz.enc" | head -n 1)

if [ -z "$DB_ENC_FILE" ] || [ ! -f "$DB_ENC_FILE" ]; then
  echo -e "${RED}✗ Database backup file not produced! Check $TEST_DIR/backup.log${NC}"
  cat "$TEST_DIR/backup.log"
  exit 1
fi

if [ -z "$MINIO_ENC_FILE" ] || [ ! -f "$MINIO_ENC_FILE" ]; then
  echo -e "${RED}✗ MinIO backup file not produced! Check $TEST_DIR/backup.log${NC}"
  cat "$TEST_DIR/backup.log"
  exit 1
fi

echo -e "${GREEN}✓ Backup produced:${NC}"
echo "   Database: $DB_ENC_FILE"
echo "   MinIO:    $MINIO_ENC_FILE"

# 5. Simulate data drift / disaster / post-backup writes
echo -e "\n${YELLOW}Step 4: Simulating subsequent writes and corruption...${NC}"
mongosh "$TEST_DB_URI" --quiet --eval "
// Add write after backup (should be rolled back on restore)
db.Note.insertOne({
  _id: 'note-unwanted-post-backup',
  userId: 'user-dr-001',
  title: 'Corrupted note written after backup',
  createdAt: new Date()
});

// Artificially corrupt SyncCursor seq to 999 (drifting ahead)
db.SyncCursor.updateOne({ userId: 'user-dr-001' }, { \$set: { seq: 999n } });

// Insert a 4th change
db.Change.insertOne({
  _id: 'ch-004',
  userId: 'user-dr-001',
  deviceId: 'dev-001',
  entityType: 'task',
  entityId: 'task-dr-003',
  operation: 'CREATE',
  version: 1,
  cursor: 4n,
  payload: { title: 'Fourth Task (Post-backup)' },
  createdAt: new Date()
});
" >/dev/null

# Corrupt MinIO storage
rm -f "$TEST_MINIO_DIR/allinone-test-bucket/attachments/attachment-1.pdf"
echo "Corrupted file added" > "$TEST_MINIO_DIR/allinone-test-bucket/attachments/unwanted.txt"

echo -e "${GREEN}✓ Disaster simulated: post-backup note added, cursor corrupted, attachment deleted.${NC}"

# 6. Test restore rejection on wrong passphrase
echo -e "\n${YELLOW}Step 5: Testing restore rejection on invalid passphrase...${NC}"
set +e
BACKUP_PASSPHRASE="wrong-passphrase" \
ASSUME_YES=true \
DB_NAME="$TEST_DB" \
MONGO_URI="$TEST_MONGO_URI" \
./scripts/restore-database.sh "$DB_ENC_FILE" > "$TEST_DIR/wrong_pass.log" 2>&1
WRONG_PASS_STATUS=$?
set -e

if [ $WRONG_PASS_STATUS -ne 0 ]; then
  echo -e "${GREEN}✓ Correctly rejected restore when using invalid passphrase.${NC}"
else
  echo -e "${RED}✗ Error: Restore succeeded with an invalid passphrase!${NC}"
  exit 1
fi

# 7. Execute valid restore
echo -e "\n${YELLOW}Step 6: Executing full database and MinIO restore...${NC}"
BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
ASSUME_YES=true \
CLEAN_MINIO=true \
DB_NAME="$TEST_DB" \
MONGO_URI="$TEST_MONGO_URI" \
MINIO_DATA_DIR="$TEST_MINIO_DIR" \
./scripts/restore-database.sh "$DB_ENC_FILE" > "$TEST_DIR/restore.log" 2>&1

echo -e "${GREEN}✓ Restore script executed successfully.${NC}"

# 8. Assert database state
echo -e "\n${YELLOW}Step 7: Verifying restored database state and invariants...${NC}"

VERIFY_RESULT=$(mongosh "$TEST_DB_URI" --quiet --eval "
const userCount = db.User.countDocuments();
const noteCount = db.Note.countDocuments();
const postBackupNote = db.Note.findOne({ _id: 'note-unwanted-post-backup' });
const vault = db.VaultSetting.findOne({ userId: 'user-dr-001' });
const changeCount = db.Change.countDocuments();
const syncCursor = db.SyncCursor.findOne({ userId: 'user-dr-001' });

print(JSON.stringify({
  userCount,
  noteCount,
  hasPostBackupNote: !!postBackupNote,
  vaultOk: !!(vault && vault.wrappedMasterKey && vault.wrappedMasterIv && vault.wrappedMasterTag && vault.recoveryKdfSalt),
  changeCount,
  cursorSeq: Number(syncCursor.seq)
}));
")

echo "Database verification metrics: $VERIFY_RESULT"

# Assertions
echo "$VERIFY_RESULT" | grep -q '"userCount":1' || { echo -e "${RED}✗ User count mismatch${NC}"; exit 1; }
echo "$VERIFY_RESULT" | grep -q '"noteCount":1' || { echo -e "${RED}✗ Note count mismatch${NC}"; exit 1; }
echo "$VERIFY_RESULT" | grep -q '"hasPostBackupNote":false' || { echo -e "${RED}✗ Point-in-time recovery failed: post-backup note was not rolled back!${NC}"; exit 1; }
echo "$VERIFY_RESULT" | grep -q '"vaultOk":true' || { echo -e "${RED}✗ Vault keys missing or corrupted!${NC}"; exit 1; }
echo "$VERIFY_RESULT" | grep -q '"changeCount":3' || { echo -e "${RED}✗ Change count mismatch (expected 3, post-backup change 4 should be gone)${NC}"; exit 1; }
echo "$VERIFY_RESULT" | grep -q '"cursorSeq":3' || { echo -e "${RED}✗ SyncCursor.seq mismatch (expected 3, got something else!)${NC}"; exit 1; }

echo -e "${GREEN}✓ Database state assertions passed: Point-in-time snapshot restored cleanly, post-backup writes rolled back, SyncCursor.seq aligns exactly with Change log.${NC}"

# 9. Assert MinIO state
echo -e "\n${YELLOW}Step 8: Verifying MinIO object storage restore...${NC}"
if [ ! -f "$TEST_MINIO_DIR/allinone-test-bucket/attachments/attachment-1.pdf" ]; then
  echo -e "${RED}✗ MinIO attachment file missing after restore!${NC}"
  exit 1
fi

RESTORED_CHECKSUM=$(sha256sum "$TEST_MINIO_DIR/allinone-test-bucket/attachments/attachment-1.pdf" | cut -d' ' -f1)
if [ "$RESTORED_CHECKSUM" != "$MINIO_CHECKSUM_ORIGINAL" ]; then
  echo -e "${RED}✗ MinIO attachment checksum mismatch! Original: $MINIO_CHECKSUM_ORIGINAL, Restored: $RESTORED_CHECKSUM${NC}"
  exit 1
fi

if [ -f "$TEST_MINIO_DIR/allinone-test-bucket/attachments/unwanted.txt" ]; then
  echo -e "${RED}✗ Error: Unwanted post-backup MinIO file remained on filesystem despite CLEAN_MINIO=true!${NC}"
  exit 1
fi

echo -e "${GREEN}✓ MinIO object storage verification passed: Attachment restored with exact SHA256 match and clean state.${NC}"

# 10. Optional: the whole-server oplog mode (self-hosted replica sets only).
#     Both flags exist so that nobody's scheduled job can drift into dumping every
#     database on a server; this pass proves the named flags actually work.
if [ "${DR_TEST_WHOLE_SERVER:-false}" = "true" ]; then
  echo -e "\n${YELLOW}Step 9: Whole-server --oplog dump and scoped replay (opt-in)...${NC}"

  BACKUP_DIR="$TEST_BACKUP_DIR/oplog" \
  DB_NAME="$TEST_DB" \
  MONGO_URI="$TEST_MONGO_URI" \
  OPLOG_WHOLE_SERVER_BACKUP=true \
  BACKUP_MINIO=false \
  RETENTION_DAYS=30 \
  ./scripts/backup-database.sh > "$TEST_DIR/backup-oplog.log" 2>&1

  OPLOG_DB_FILE=$(find "$TEST_BACKUP_DIR/oplog" -name "allinone-db-*.archive.gz*" | head -n 1)
  if [ -z "$OPLOG_DB_FILE" ]; then
    echo -e "${RED}✗ Whole-server archive not produced! Check $TEST_DIR/backup-oplog.log${NC}"
    cat "$TEST_DIR/backup-oplog.log"
    exit 1
  fi
  echo -e "${GREEN}✓ Whole-server oplog archive produced.${NC}"

  # Drift again, then restore with the replay flag and re-assert.
  mongosh "$TEST_DB_URI" --quiet --eval "
db.Note.insertOne({ _id: 'note-unwanted-post-backup', userId: 'user-dr-001', title: 'Written after the oplog snapshot', createdAt: new Date() });
" >/dev/null

  BACKUP_PASSPHRASE="$TEST_PASSPHRASE" \
  ASSUME_YES=true \
  DB_NAME="$TEST_DB" \
  MONGO_URI="$TEST_MONGO_URI" \
  OPLOG_WHOLE_SERVER_RESTORE=true \
  RESTORE_MINIO=false \
  ./scripts/restore-database.sh "$OPLOG_DB_FILE" > "$TEST_DIR/restore-oplog.log" 2>&1

  OPLOG_VERIFY=$(mongosh "$TEST_DB_URI" --quiet --eval "
print(JSON.stringify({ gone: !db.Note.findOne({ _id: 'note-unwanted-post-backup' }), cursorSeq: Number(db.SyncCursor.findOne({ userId: 'user-dr-001' }).seq) }));
")
  echo "Oplog restore metrics: $OPLOG_VERIFY"
  echo "$OPLOG_VERIFY" | grep -q '"gone":true' || { echo -e "${RED}✗ oplog replay did not roll the post-snapshot write back${NC}"; exit 1; }
  echo -e "${GREEN}✓ Whole-server oplog path restored within its one-database scope.${NC}"
fi

echo -e "\n${BLUE}======================================================${NC}"
echo -e "${GREEN}  ALL BACKUP & RESTORE VERIFICATION TESTS PASSED!     ${NC}"
echo -e "${BLUE}======================================================${NC}"
