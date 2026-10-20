#!/bin/bash

# Allinone Backend - Safe database initialisation and upgrade
#
# This project runs Prisma on MongoDB (`provider = "mongodb"` in
# `prisma/schema.prisma`). Prisma Migrate does not support that connector, so
# there is no `prisma/migrations/` folder to replay and `prisma db push` is the
# only supported way to get `schema.prisma` into a database. That leaves two
# questions a migration file would normally answer, and this script answers them:
#
#   1. Does a clean environment end up with the schema it should?
#   2. Does running this against a database that already holds data lose any of
#      that data?
#
# The second is answered by proof rather than by argument. MongoDB is schemaless,
# so `db push` only creates collections and indexes — but "only" is an assumption
# about a Prisma version, so the script snapshots every collection (document count
# plus a content hash, via scripts/db-snapshot.sh) before and after the push and
# fails if a collection that already existed changed at all. New *empty*
# collections are the expected outcome of a schema addition.
#
# `--accept-data-loss` is deliberately never passed. When a push would drop
# something Prisma stops and asks; the prompt text lands in the log and the push
# does not happen.
#
# Two modes:
#   scripts/db-init.sh                    apply the schema to $DATABASE_URL
#   scripts/db-init.sh --rehearse NAME    copy $DATABASE_URL into a scratch
#                                         database on a local mongod, apply it
#                                         there, and report. Only NAME is written.
#
# Rehearsal exists because the honest pre-flight for a populated database is to
# run the real operation against a copy of it. The one way a push can fail on
# existing data is a unique index the data already violates, and a duplicate-key
# scan is a weaker test of that than the push itself.
#
# Requires: npx (prisma), mongosh, mongoexport; mongodump/mongorestore for
# --rehearse. Runbook with worked evidence: docs/DATABASE_INITIALIZATION.md.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

REHEARSE_NAME=""
if [ "${1:-}" = "--rehearse" ]; then
  REHEARSE_NAME="${2:?--rehearse needs a scratch database name, e.g. --rehearse fin_rehearsal_$(date +%Y%m%d)}"
  # The name is the only thing standing between this flag and a live database,
  # since the scratch database is dropped and re-created from the real dump.
  case "$REHEARSE_NAME" in
    scratch* | fin_*) ;;
    *)
      echo "Error: scratch database name must start with 'scratch' or 'fin_' so it cannot be mistaken for a live one (got '$REHEARSE_NAME')." >&2
      exit 1
      ;;
  esac
fi

if [ -n "$REHEARSE_NAME" ] && { ! command -v mongodump >/dev/null 2>&1 || ! command -v mongorestore >/dev/null 2>&1; }; then
  echo "Error: --rehearse needs mongodump and mongorestore on PATH." >&2
  exit 1
fi
if ! command -v mongosh >/dev/null 2>&1 || ! command -v mongoexport >/dev/null 2>&1; then
  echo "Error: mongosh and mongoexport are needed to prove the push is read-safe." >&2
  exit 1
fi

# The URL is read the way the API and the worker read it, and is never printed:
# only the host, port and database name are, which is all an operator needs to
# see to know which database is about to be touched.
if [ -z "${DATABASE_URL:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$REPO_ROOT/.env" | cut -d'=' -f2- | tr -d '"')"
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "Error: DATABASE_URL is not set and $REPO_ROOT/.env does not define one." >&2
  exit 1
fi

describe_url() {
  local rest="${1#*://}"
  local authority="${rest%%/*}"
  local path="${rest#*/}"
  printf '%s (db: %s)\n' "${authority#*@}" "${path%%\?*}"
}

SOURCE_DB="$(mongosh --quiet "$DATABASE_URL" --eval 'db.getName()')"
TARGET="$DATABASE_URL"
TARGET_LABEL="$(describe_url "$DATABASE_URL")"
SNAPSHOT_DB="$SOURCE_DB"
DUMP_DIR=""
BEFORE="$(mktemp)"
AFTER="$(mktemp)"
cleanup() {
  rm -f "$BEFORE" "$AFTER"
  if [ -n "$DUMP_DIR" ]; then
    rm -rf "$DUMP_DIR"
  fi
  return 0
}
trap cleanup EXIT

if [ -n "$REHEARSE_NAME" ]; then
  LOCAL="${REHEARSAL_MONGOD:-mongodb://localhost:27017}"
  DUMP_DIR="$(mktemp -d -t allinone-db-rehearsal-XXXXXX)"
  echo "==> Source:  $(describe_url "$DATABASE_URL")"
  echo "==> Scratch: $LOCAL (db: $REHEARSE_NAME)"
  echo "--> Copying the real data into the scratch database"
  mongodump "$DATABASE_URL" --db "$SOURCE_DB" --out "$DUMP_DIR" >/dev/null
  mongorestore "$LOCAL" --nsFrom="$SOURCE_DB.*" --nsTo="$REHEARSE_NAME.*" --dir="$DUMP_DIR" --drop >/dev/null
  TARGET="$LOCAL/$REHEARSE_NAME"
  TARGET_LABEL="$LOCAL (db: $REHEARSE_NAME)"
  SNAPSHOT_DB="$REHEARSE_NAME"
fi

echo "==> Target: $TARGET_LABEL"

echo "--> Snapshot before"
"$SCRIPT_DIR/db-snapshot.sh" "$SNAPSHOT_DB" "$TARGET" > "$BEFORE"
echo "    $(wc -l < "$BEFORE") collections, $(awk '{ s += $2 } END { print s + 0 }' "$BEFORE") documents"

echo "--> Applying prisma/schema.prisma (never with --accept-data-loss)"
(
  cd "$REPO_ROOT"
  DATABASE_URL="$TARGET" npx prisma db push --skip-generate
)

echo "--> Snapshot after"
"$SCRIPT_DIR/db-snapshot.sh" "$SNAPSHOT_DB" "$TARGET" > "$AFTER"
echo "    $(wc -l < "$AFTER") collections, $(awk '{ s += $2 } END { print s + 0 }' "$AFTER") documents"

# Every pre-push line has to reappear unchanged. Collections only in AFTER are the
# ones the schema just added; if any of those arrived with documents in it, the
# push wrote data, which is precisely what this script exists to catch.
#
# The files are matched by FILENAME rather than NR == FNR because BEFORE is empty
# on a clean environment — with the NR form awk would read AFTER as the first
# file and report zero additions, which is the one case worth getting right.
SUMMARY="$(
  awk -v beforeFile="$BEFORE" -v afterFile="$AFTER" '
    FILENAME == beforeFile { bCount[$1] = $2; bHash[$1] = $3; next }
    FILENAME == afterFile  { aCount[$1] = $2; aHash[$1] = $3; next }
    END {
      added = 0
      for (c in aCount) {
        if (c in bCount) {
          if (bCount[c] != aCount[c] || bHash[c] != aHash[c]) printf "altered %s (%s -> %s documents)\n", c, bCount[c], aCount[c]
        } else {
          added++
          if (aCount[c] != 0) printf "created-with-data %s (%s documents)\n", c, aCount[c]
        }
      }
      for (c in bCount) if (!(c in aCount)) printf "removed %s\n", c
      printf "added %d\n", added
    }
  ' "$BEFORE" "$AFTER"
)"

PROBLEMS="$(printf '%s\n' "$SUMMARY" | grep -E '^(altered|created-with-data|removed) ' || true)"
NEW_COUNT="$(printf '%s\n' "$SUMMARY" | awk '$1 == "added" { print $2 }')"

if [ -n "$PROBLEMS" ]; then
  echo "!! The push did not only add empty collections:" >&2
  printf '%s\n' "$PROBLEMS" >&2
  echo "==> FAILED: compare $SNAPSHOT_DB before/after snapshots above." >&2
  exit 1
fi

echo "==> OK: the only difference is $NEW_COUNT new collection(s), each empty."

if [ -n "$REHEARSE_NAME" ]; then
  echo "==> Scratch $TARGET_LABEL left for inspection. Drop it when done:"
  echo "    mongosh --eval 'db.getSiblingDB(\"$REHEARSE_NAME\").dropDatabase()'"
fi

exit 0
