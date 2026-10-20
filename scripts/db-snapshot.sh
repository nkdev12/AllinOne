#!/bin/bash

# Allinone Backend - Per-collection database snapshot
# Prints `<collection> <docCount> <contentSha256>` for every collection in one
# database, so a schema operation can be proven not to have lost or rewritten a
# record: snapshot before, snapshot after, diff. The hash is taken over sorted
# mongoexport lines, which makes it independent of natural order — a restore or a
# compaction that changes which document the collection scanner reaches first
# still hashes the same, and only a genuine content change shows up.
#
# Read-only. It never writes to the database, so it is safe against a production
# URL; it is the check that runs *around* the operations that are not.
#
# Requires mongosh and mongoexport (MongoDB Database Tools) on PATH.
#
# Usage: scripts/db-snapshot.sh <database> [connection-string]
#   DATABASE_URL-style strings work; the default is the local mongod.

set -e

DB_NAME="${1:?usage: db-snapshot.sh <database> [connection-string]}"
CONN="${2:-mongodb://localhost:27017}"

mongosh --quiet "$CONN" --eval "db.getSiblingDB('$DB_NAME').getCollectionNames().forEach(c => print(c))" \
  | sort | while read -r collection; do
    count=$(mongosh --quiet "$CONN" --eval "db.getSiblingDB('$DB_NAME').getCollection('$collection').countDocuments({})")
    hash=$(mongoexport --quiet --uri="$CONN" --db "$DB_NAME" --collection "$collection" 2>/dev/null | sort | sha256sum | cut -d' ' -f1)
    printf '%s %s %s\n' "$collection" "$count" "$hash"
  done
