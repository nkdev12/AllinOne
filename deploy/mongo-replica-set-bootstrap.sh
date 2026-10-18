#!/bin/sh
# =============================================================================
# MongoDB replica-set bootstrap for docker-compose.prod.yml — run once per new
# deployment, automatically, as the one-shot `mongodb-bootstrap` service.
#
# WHAT IT DOES: initiates `rs0`, creates the cluster admin, then creates (or
# reconciles) the user Prisma connects as. It has to be a separate step because
# `--auth` and a replica set together leave no other way in: with `--keyFile` and
# zero users, MongoDB grants the localhost exception to a *localhost* connection
# and to nothing else, which is why the compose service that runs this shares the
# mongod container's network namespace (`network_mode: "service:mongodb"`) and
# dials 127.0.0.1 rather than `mongodb:27017`.
#
# -----------------------------------------------------------------------------
# MANUAL STEP — do this before the first `docker compose -f
# docker-compose.prod.yml up`. Nothing here can do it for you, and the deploy
# fails closed without it (`${MONGO_KEYFILE:?...}` refuses to render):
#
#   1. Generate the internal-auth key material, outside the repo, and give it to
#      the uid mongod runs as inside the image (999). A keyFile that is group- or
#      world-readable, or that mongod cannot read, is a refused start — the
#      container exits with "CannotReadKeyFile" or "KeyFile has too open access".
#
#        sudo install -m 600 -o 999 -g 999 /dev/null /etc/allinone/mongo-keyfile
#        openssl rand -base64 756 | sudo tee /etc/allinone/mongo-keyfile >/dev/null
#        sudo chmod 600 /etc/allinone/mongo-keyfile
#
#   2. Put these in the env file you pass with `--env-file` (never in the repo):
#
#        MONGO_KEYFILE=/etc/allinone/mongo-keyfile
#        MONGO_ROOT_USERNAME=<admin name>
#        MONGO_ROOT_PASSWORD=<long random>
#        MONGO_APP_USERNAME=allinone_app
#        MONGO_APP_PASSWORD=<long random, percent-encoded if it has URI reserved chars>
#        DB_NAME=allinone_prod
#
#   3. `MONGO_APP_PASSWORD` is both a mongosh string literal and half a connection
#      string, so the script below refuses any character outside `A-Z a-z 0-9 . _ ~
#      -` rather than letting it fail as a parse error somewhere else. `openssl rand
#      -hex 32` satisfies it and needs no percent-encoding anywhere.
#
#   4. Re-running this against an existing cluster is safe: the initiation and the
#      admin user are skipped, and the app user's password and roles are
#      reconciled to what the env file says — so rotating a secret there means the
#      same thing in the database instead of a credential that silently stops
#      working on the next deploy.
#
# It does NOT touch any application data, and it never runs `dropDatabase`.
# =============================================================================
set -eu

MONGO_HOST="${MONGO_HOST:-127.0.0.1}"
MONGO_PORT="${MONGO_PORT:-27017}"
REPLICA_SET="${REPLICA_SET:-rs0}"
# The member is named by the address every *other* container resolves, not by
# 127.0.0.1. A driver given `?replicaSet=rs0` reads the member list from the set
# itself, and a member called 127.0.0.1 tells it to connect to its own loopback —
# which is how a healthy single-node set still looks unreachable from the API.
MONGO_MEMBER_HOST="${MONGO_MEMBER_HOST:-mongodb:27017}"
DB_NAME="${DB_NAME:-allinone_prod}"

DIRECT_URI="mongodb://${MONGO_HOST}:${MONGO_PORT}/admin?directConnection=true"

say() {
  printf 'mongo-bootstrap: %s\n' "$1"
}

for v in MONGO_ROOT_USERNAME MONGO_ROOT_PASSWORD MONGO_APP_USERNAME MONGO_APP_PASSWORD; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { say "FATAL: $v is empty - it is required by docker-compose.prod.yml"; exit 1; }
done

# Refuse up front rather than mid-script. Both passwords are substituted into a
# mongosh statement and into a connection string, so a `"`, `\`, `@` or `/` in one
# is a syntax error here and a mis-parsed credential in the API's URI — and
# `openssl rand -hex 32` needs none of them.
case "${MONGO_ROOT_PASSWORD}${MONGO_APP_PASSWORD}" in
  *[!A-Za-z0-9._~-]*)
    say "FATAL: MONGO_ROOT_PASSWORD and MONGO_APP_PASSWORD must use only A-Z a-z 0-9 . _ ~ - (they are interpolated into a mongosh statement and a connection string)"
    exit 1
    ;;
esac

# --- 1. wait for mongod to answer at all -------------------------------------
# `ping` needs no credentials even under `--auth`, so this works before there is a
# user to authenticate as and after the set is live.
i=0
until mongosh --quiet --eval 'db.adminCommand({ ping: 1 }).ok' "$DIRECT_URI" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 60 ] && { say "FATAL: mongod not answering on ${MONGO_HOST}:${MONGO_PORT}"; exit 1; }
  sleep 2
done
say "mongod is listening"

# --- 2. initiate the replica set ---------------------------------------------
# Checked through the set's own config document because `rs.status()` on a node
# that has not been initiated answers with an `{ok: 0, codeName:
# 'NotYetInitialized'}` document rather than throwing, and a `try/catch` around it
# therefore reads "already initiated" and moves on — leaving a set nobody ever
# started and an API that can never open a transaction.
mongosh --quiet --eval '
  var admin = db.getSiblingDB("admin");
  var existing = null;
  try { existing = admin.system.replset.findOne(); } catch (e) { existing = null; }
  if (existing && existing._id === "'"$REPLICA_SET"'") {
    print("replset already initiated");
  } else {
    rs.initiate({ _id: "'"$REPLICA_SET"'", members: [{ _id: 0, host: "'"$MONGO_MEMBER_HOST"'" }] });
    print("replset initiated with member '"$MONGO_MEMBER_HOST"'");
  }
' "$DIRECT_URI"

# --- 3. wait for a writable primary ------------------------------------------
# After `rs.initiate` the node reconfigures itself and drops the connection it
# came in on; every later step has to land on the primary.
i=0
until [ "$(mongosh --quiet --eval 'db.hello().isWritablePrimary ? "yes" : "no"' "$DIRECT_URI" 2>/dev/null || echo no)" = "yes" ]; do
  i=$((i + 1))
  [ "$i" -ge 60 ] && { say "FATAL: no writable primary after 120s"; exit 1; }
  sleep 2
done
say "'$REPLICA_SET' has a primary"

# --- 4. create the cluster admin, under the localhost exception ---------------
# Skipped quietly once any user exists: at that point the exception is closed and
# this unauthenticated connection can no longer write to `admin.system.users`, so
# a refusal here means "already provisioned", not "broken".
mongosh --quiet --eval '
  var admin = db.getSiblingDB("admin");
  var hasUsers = false;
  try { hasUsers = admin.system.users.find().limit(1).toArray().length > 0; } catch (e) { hasUsers = true; }
  if (hasUsers) { print("users already exist, skipping admin creation"); }
  else {
    try {
      admin.createUser({
        user: '"$MONGO_ROOT_USERNAME"',
        pwd: '"$MONGO_ROOT_PASSWORD"',
        roles: [{ role: "root", db: "admin" }]
      });
      print("cluster admin created");
    } catch (e) {
      if (e.code === 51) { print("cluster admin already exists"); } else { throw e; }
    }
  }
' "$DIRECT_URI"

# --- 5. as the admin, ensure the application user -----------------------------
# Credentialed from here on: `--auth` means an anonymous connection can do nothing
# once the first user exists.
#
# The user lives in `admin`, with roles scoped to `$DB_NAME`, because that is what
# the API's `DATABASE_URL` says (`authSource=admin`). Where the user is defined and
# where the driver looks for it are two different things, and getting them to
# disagree is an `Authentication failed` that outlives every other clue.
APP_URI="mongodb://${MONGO_ROOT_USERNAME}:${MONGO_ROOT_PASSWORD}@${MONGO_HOST}:${MONGO_PORT}/admin?authSource=admin&directConnection=true"

mongosh --quiet --eval '
  var admin = db.getSiblingDB("admin");
  var roles = [
    // readWrite is what `prisma db push` and every query need; dbAdmin covers the
    // createIndex / listCollections / collMod the same command runs, and a user
    // without it fails on the first index build with "not authorized".
    { role: "readWrite", db: "'"$DB_NAME"'" },
    { role: "dbAdmin", db: "'"$DB_NAME"'" }
  ];
  try {
    admin.createUser({
      user: "'"$MONGO_APP_USERNAME"'",
      pwd: "'"$MONGO_APP_PASSWORD"'",
      roles: roles
    });
    print("application user created");
  } catch (e) {
    if (e.code === 51) {
      admin.updateUser("'"$MONGO_APP_USERNAME"'", { pwd: "'"$MONGO_APP_PASSWORD"'", roles: roles });
      print("application user reconciled");
    } else { throw e; }
  }
' "$APP_URI"

# --- 6. prove the credential the app will use actually works ------------------
# Read-only on purpose: this is a deploy step, and writing a probe document into
# the production database to test a password would be its own bug.
APP_USER_URI="mongodb://${MONGO_APP_USERNAME}:${MONGO_APP_PASSWORD}@${MONGO_HOST}:${MONGO_PORT}/${DB_NAME}?authSource=admin&directConnection=true"

mongosh --quiet --eval '
  var out = db.runCommand({ listCollections: 1, nameOnly: true });
  if (!out.ok) { throw new Error("listCollections refused: " + JSON.stringify(out)); }
  print("application user authenticated against " + db.getName());
' "$APP_USER_URI"


say "done"
