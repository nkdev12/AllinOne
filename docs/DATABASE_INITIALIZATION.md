# Database initialisation and upgrade runbook

Last executed against the real dev database on **2026-10-20**. Every number below is
from that run, not a template — the commands and their recorded results are the
artefact, because a runbook nobody re-runs is a rumour.

Read this before running `prisma db push` against a database that holds data.
For the shape of the data itself see [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md);
for where the push fits into a deployment see
[DEPLOYMENT.md](DEPLOYMENT.md#apply-the-prisma-schema); for backup and restore
of a database that went wrong anyway see
[DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).

## Why there is no migration file

`prisma/schema.prisma` declares `provider = "mongodb"`. Prisma Migrate does not
support the MongoDB connector, so this repository has no `prisma/migrations/`
directory (it is also in `.gitignore`). Prisma Migrate cannot create a replayable
file for this connector, so the `db:push`, `db:migrate`, and `db:migrate:deploy`
package commands all use this guarded `prisma db push` path instead.

That is a real gap, not a cosmetic one, and this runbook exists to fill it. A
migration folder would answer two questions about any environment:

1. Does a clean environment end up with the schema it should?
2. Does upgrading a database that already holds data lose any of that data?

`scripts/db-init.sh` answers both by proof. It snapshots every collection —
document count plus a SHA-256 over the sorted `mongoexport` lines, via
`scripts/db-snapshot.sh` — before and after the push, and fails if a collection
that already existed changed at all. New *empty* collections are the expected
outcome of a schema addition; a new collection that arrives holding data, an
altered hash, or a vanished collection is a hard failure with a non-zero exit.

The snapshot is order-independent on purpose: a restore or a compaction can change
which document the collection scanner reaches first without changing any document,
and a hash over unsorted lines would report that as data loss.

MongoDB is schemaless, so `db push` only creates collections and indexes and never
rewrites documents. Saying "only" is an assumption about a Prisma version
(`package.json` floats `prisma` at `^5.0`), which is exactly why the script checks
the claim on every run instead of trusting it.

## The one failure mode on a populated database

The push cannot fail because of a missing column — there are none. It fails when
the schema declares a **unique** index that the existing data already violates: two
documents with the same `(userId, email)`, and index creation aborts with a
duplicate key error. The honest pre-flight is therefore not a duplicate-key scan
(it would have to re-derive `@@unique`, `@@index` and every field-level `@unique`
from the schema, and drift the moment someone edits one) but the push itself, run
against a copy:

```bash
scripts/db-init.sh --rehearse fin_rehearsal_$(date +%Y%m%d)
```

`--rehearse` dumps `$DATABASE_URL`, restores it into a scratch database on a local
mongod, and pushes there. Nothing outside the scratch database is written. The
scratch name must start with `scratch` or `fin_` so a typo cannot name a live
database, because the scratch database is dropped and rebuilt from the dump.

## Commands

```bash
# Which database am I about to touch? Prints host/port + db name, never the URL.
# DATABASE_URL is read from the environment, else from .env, exactly as the API
# and the worker read it.
DATABASE_URL="mongodb://..." npx prisma db push --dry-run

# Rehearse against a copy of the real data (needs mongodump/mongorestore/mongosh).
scripts/db-init.sh --rehearse fin_rehearsal_20261020

# Clean environment: point DATABASE_URL at a database that does not exist yet.
DATABASE_URL="mongodb://localhost:27017/scratch_fresh_20261020" scripts/db-init.sh

# The real thing, with the before/after proof around it.
scripts/db-init.sh
```

`--skip-generate` is passed because `prisma generate` runs on `postinstall` and
only writes a client; it never touches the database, and re-running it mid-runbook
hides the schema output under 400 lines of client generation.

**Never add `--accept-data-loss`.** When a push would drop something, Prisma stops
and asks; the script runs non-interactively, so the prompt text lands in the log
and the push does not happen. That refusal is the safety property, and passing the
flag to make an inconvenient message go away is how a schema cleanup turns into a
restored backup.

## What happened on 2026-10-20

The dev database on Atlas (`allinone_dev`) had been created by hand, collection by
collection, by whichever code path wrote the first document to each one. Twenty-two
collections existed and held 563 documents. **Every one of them had exactly one
index: `_id`.** The schema declares 88 — 73 non-unique `@@index`/`@@unique` entries
plus 15 unique ones (7 block-level `@@unique` and 8 field-level `@unique`) — so
every query the API makes through Prisma was, and would remain, a collection scan.
That is also why `ResourceShare` and the seven Finance collections
(`finance_loans`, `finance_recurring_rules`, `finance_savings_goals`,
`finance_shared_expenses`, `finance_expense_shares`, `finance_settlements`,
`finance_trip_itineraries`) did not exist at all: nothing had ever written a row to
them, and on a schemaless database a collection appears on its first insert, not
from the schema.

Pre-flight duplicate scan, read-only, over every constrained key that had data
behind it: 0 duplicates. Unique-index creation could not fail on this data.

| Run | Command | Result |
| --- | --- | --- |
| Clean init | `DATABASE_URL="mongodb://localhost:27017/scratch_fresh_20261020" scripts/db-init.sh` | exit 0 — 0 → 42 collections, 0 documents, 130 index entries (88 declared + 42 `_id`), push took 4.20 s |
| Upgrade with data | `scripts/db-init.sh --rehearse fin_rehearsal_b2` | exit 0 — 22 collections / 563 documents → 42 / 563, 20 new collections all empty, 88 indexes created in 8.19 s, every pre-existing collection's content hash byte-identical |
| Idempotency | second `npx prisma db push --skip-generate` on the same database | exit 0 — "The database is already in sync with the Prisma schema.", 0 changes |
| Applied to dev | `scripts/db-init.sh` against the Atlas `allinone_dev` in `.env` | exit 0 — 20 collections + 88 indexes created in 10.14 s; 42 collections, 563 documents and 130 index entries after; the before/after diff is only the 20 new empty collections |

Two things worth reading twice, because they are the whole argument:

- The upgrade case was proven against **a copy of the real data** before it was run
  against the real database, and then proven again **on the real database** by the
  same snapshot diff. 563 documents before, 563 after, same 22 hashes.
- 42 collections is 22 + 20, and 13 of the 42 are the `finance_*` models. A fresh
  environment and an upgraded one converge on the identical set of 130 index
  entries — verified by comparing `getIndexes()` output between the two databases,
  which reported no difference in either direction. Reproducibility is the claim,
  and that comparison is what makes it one.

## When the output is not the above

- **`P3006` / a prompt about data loss** — the schema wants to drop or change
  something. Stop. Do not pass `--accept-data-loss`. Either revert the schema edit
  or make it additive and push again; if real data has to be reshaped, it needs a
  written plan and a backup taken first
  ([DISASTER_RECOVERY.md](DISASTER_RECOVERY.md)), not a flag.
- **`E11000` during index creation** — existing data violates a unique key. Read
  the message for the collection and the key, decide which document is wrong, and
  fix the data deliberately. Rehearse the fix with `--rehearse` before touching the
  real database.
- **`P1001` can't reach database** — the URL points at a replica set that is asleep
  (Atlas free tier pauses). Nothing has been written; retry.
- **The script reports `altered` or `created-with-data`** — the push wrote documents.
  It should not have been able to. Treat the target database as suspect, restore from
  the last verified backup, and investigate before anything else runs against it.
- **A local mongod that is not a replica set** — `db push` will succeed (it uses no
  transactions) but `nest start` will fail on the first `$transaction`, since Prisma
  requires a replica set for MongoDB transactions. Check with
  `mongosh --eval 'rs.status()'`; the development instance on this machine is a
  single-member set.

## Housekeeping

The scratch databases from a rehearsal are yours to delete afterwards, and they are
named so you can tell which they are:

```bash
mongosh --eval 'db.getSiblingDB("fin_rehearsal_20261020").dropDatabase()'
```

`scripts/db-init.sh` prints that exact line at the end of a rehearsal run.
