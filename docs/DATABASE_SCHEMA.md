# Allinone Backend — Database Schema & Data Dictionary

This document is an entity-relationship dictionary for the models defined in
`prisma/schema.prisma`. It is **not** complete: see *Coverage* near the end for the
models it never describes and the parts of the ERD that are missing. Where this page
and `schema.prisma` disagree, the schema is right and this page is the defect.

---

## 📐 ERD Overview & Core Entities

```
                          ┌──────────────────────────┐
                          │          User            │
                          └─────────────┬────────────┘
                                        │ 1:N
         ┌──────────────────────────────┼──────────────────────────────┐
         │                              │                              │
         ▼                              ▼                              ▼
┌──────────────────┐          ┌──────────────────┐          ┌──────────────────┐
│  Authentication  │          │     Session      │          │      Device      │
└──────────────────┘          └──────────────────┘          └─────────┬────────┘
                                                                      │ 1:1
                                                                      ▼
                                                            ┌──────────────────┐
                                                            │ DeviceSyncState  │
                                                            └──────────────────┘

         ┌──────────────────────────────┬──────────────────────────────┐
         │                              │                              │
         ▼                              ▼                              ▼
┌──────────────────┐          ┌──────────────────┐          ┌──────────────────┐
│      Folder      │          │     Project      │          │     Calendar     │
└────────┬─────────┘          └────────┬─────────┘          └────────┬─────────┘
         │ 1:N                         │ 1:N                         │ 1:N
         ▼                             ▼                             ▼
┌──────────────────┐          ┌──────────────────┐          ┌──────────────────┐
│       Note       │          │       Task       │          │      Event       │
└────────┬─────────┘          └────────┬─────────┘          └──────────────────┘
         │ 1:N                         │ 1:N
         ▼                             ▼
┌──────────────────┐          ┌──────────────────┐
│   NoteHistory    │          │     Reminder     │
└──────────────────┘          └──────────────────┘
```

---

## 🗂️ Data Dictionary (Models & Fields)

### 1. Identity & Auth Models

#### `User`
- **Primary Key**: `id` (`Uuid`, `@default(uuid())`, stored as `_id`)
- **Fields**: `email` (`String`, unique), `displayName`, `avatar`, `locale` (default `"en-US"`), `timezone` (default `"UTC"`), `status` (`ACTIVE`, `PENDING`, `SUSPENDED`, `DELETED`), `emailVerifiedAt`, `lastLoginAt`, `failedLoginAttempts` (Int, default `0`), `lockedUntil` (DateTime?, null if active), `createdAt`, `updatedAt`, `deletedAt`.
- **Indexes**: `@@index([email])`, `@@index([status])`, `@@index([createdAt])`.

> A note on the type names below. This document was written for a PostgreSQL
> deployment and says `VarChar 255`, `Text`, `JsonB` and `gen_random_uuid()` in
> places; `prisma/schema.prisma` is the source of truth, and it is a MongoDB
> schema whose only scalar types are `String`, `Int`, `BigInt`, `Float`, `Boolean`,
> `DateTime`, `Json` and enums, with `@map("_id")` on every `id`. Read a length like
> "VarChar 255" as prose for "a String the service expects to be short", never as a
> constraint the database will enforce — nothing here enforces one.

#### `Authentication`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`, FK -> `User.id` CASCADE), `type` (`EMAIL_PASSWORD`, `GOOGLE`, `APPLE`, `MICROSOFT`, `PASSKEY`), `identifier`, `passwordHash` (Argon2id ciphertext), `emailVerified`.
- **Constraints**: `@@unique([userId, type, identifier])`.

#### `Session`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`, FK -> `User.id` CASCADE), `deviceId` (`Uuid`, FK -> `Device.id` CASCADE), `accessToken` (Text, Unique), `refreshToken` (Text, Unique), `accessExpiresAt`, `refreshExpiresAt`, `revokedAt`, `lastActivityAt`, `ipAddress`, `userAgent`.
- **Design Rationale**: the service mints `id` itself instead of leaving it to `@default(uuid())`, because the access and refresh tokens signed for a session carry that id as their `sessionId` claim. `JwtStrategy` resolves the claim back to this row on every authenticated request, which is what makes `revokedAt` bite immediately rather than when the 15-minute token expires — and it is why `POST /auth/logout`, which reads the id off the caller's own token, has anything to revoke.

#### `MFASetting`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`, Unique, FK -> `User.id` CASCADE), `totpEnabled`, `totpSecret` (Application AES-encrypted), `recoveryCodes` (JSON string array), `backupCodesUsed` (JSON index array).

#### `AuditLog`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`?, nullable for failed logins/system events), `action` (`AuditAction`, including `LOGIN_FAILURE`, `ACCOUNT_LOCKED`, `ACCOUNT_UNLOCKED`, `MFA_DISABLED`, `DEVICE_REVOKED`), `resourceType` (`String`, optional), `resourceId` (`Uuid`, optional), `requestId` (`Uuid`, optional correlation ID), `changes` (`Json` diff), `ipAddress`, `userAgent`, `metadata` (`Json`), `createdAt`.
- **Indexes**: `@@index([userId])`, `@@index([action])`, `@@index([createdAt])`, `@@index([requestId])`.
- **Design Rationale**: `changes` stores attribute-level mutation diffs of altered entities, while `metadata` stores request telemetry, authentication context, and security event details, keeping mutation diffs separate from request metadata for optimal querying.

---

### 2. Devices & Realtime Synchronization Models

#### `Device`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`, FK -> `User.id` CASCADE), `name`, `platform` (`IOS`, `ANDROID`, `MACOS`, `WINDOWS`, `LINUX`, `WEB`), `appVersion`, `osVersion`, `publicKey`, `lastSeenAt`, `revokedAt`.

#### `DeviceSyncState`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `deviceId` (`Uuid`, Unique, FK -> `Device.id` CASCADE), `lastPulledCursor`, `lastPushedSequence`, `lastSuccessfulSyncAt`.

#### `Change`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`), `deviceId` (`Uuid`?, NULL for server-side changes), `entityType` (String), `entityId` (String), `operation` (`CREATE`, `UPDATE`, `DELETE`, `RESTORE`), `version` (Int), `payload` (`Json`), `cursor` (`BigInt`, default `0`), `createdAt`, `clientTimestamp` (`DateTime`?, nullable).
- **Indexes**: `@@index([userId])`, `@@index([deviceId])`, `@@index([userId, cursor])`, `@@index([createdAt])`.
- **Design Rationale**: The single write path for synced content, including vault entries (`entityType: "vault_item"`, whose payload is an opaque client-side ciphertext). `payload` is not metadata-only — treat it as user content. It is the *only* path for vault entries and one of *two* for notes, tasks and events: the REST modules write their own entity row **and** append a `Change` here, and nothing replays this table into those rows.
- **Cursor allocation**: Mongo has no autoincrement, so `cursor` defaults to `0` and only `SyncCursor` makes it monotonic. `allocateNextChangeCursor` `$inc`s the per-user row inside the transaction that writes the `Change`. Rows written before that mechanism exist with `cursor: 0`; `npm run sync:backfill:cursor` seeds them once. A `0` is not a harmless placeholder on the read path: `pullChanges` filters `cursor > <device checkpoint>`, so a zeroed row sits behind every checkpoint including the starting one and reaches no device ever.
- **Two timestamps**: `createdAt` is when this server heard about the change; `clientTimestamp` is when the authoring device made it, stamped on that device's clock and stored as sent. A device offline for a week writes both a week apart, and clients sort their lists on the edit — hence the second column. Nothing compares either of them: refusal is by `version` alone, so a device running ahead of real time cannot push past a newer write.
- **Retention**: pruned by the hourly `cleanup-expired` job in `src/queues/processors/maintenance.processor.ts`, scheduled from `src/worker.ts` — 30 days (`CHANGE_RETENTION_DAYS`) and no further, bounded per user by the oldest `lastPulledCursor` among non-revoked devices. ARCHITECTURE.md §3 has the reasoning and the observable the job reports.

#### `SyncCursor`
- **Primary Key**: `id` (`Uuid`), `userId` Unique
- **Fields**: `seq` (`BigInt`, default `0`), `createdAt`, `updatedAt`.
- **Design Rationale**: One counter document per user. Its `seq` is also the reported end of the log, so pruning `Change` rows cannot move `serverHighestCursor` backwards and strand a device.

#### `IdempotencyKey`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `key` (`String`), `userId` (`String`), `endpoint` (`String`), `method` (`String`), `statusCode` (`Int`), `response` (`Json`), `expiresAt` (`DateTime`), `createdAt` (`DateTime`).
- **Constraints**: `@@unique([userId, key])`.
- **Indexes**: `@@index([userId])`, `@@index([expiresAt])`.
- **Design Rationale**: Database-backed storage for replayed responses, so a retry
  after a restart or a Redis eviction still gets the first answer. The uniqueness is
  per account and that is the whole point of the `userId` in it: as a global
  `@unique` on `key` alone, any caller who could guess or observe another account's
  key string could address its cached response, and the write path that stores an
  unknown key overwrote the row it collided with — `userId` included. A UUID is not
  secret from the side that generated it, and clients are free to derive keys from
  request content rather than from a RNG.
  What the interceptor guarantees is *at-most-once for the response*, not exactly-once
  for the side effects: a second request on a live key never reaches the handler, so
  a batch whose first attempt was processed but whose response was lost is silently
  dropped rather than replayed. See API_REFERENCE.md §1 for what a caller should send.

---

### 3. Notes Subsystem Models

#### `Folder`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`), `parentId` (`Uuid`?, self-relation, `onDelete: NoAction`), `name`, `color`, `icon`, `sortOrder` (Int, default `0`), `createdAt`, `updatedAt`, `deletedAt`.
- **Indexes**: `@@index([userId])`, `@@index([parentId])`.

#### `Note`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`), `folderId` (`Uuid`?, FK -> `Folder.id`, `onDelete: NoAction`), `title`, `content` (`String?`, plain text the client renders as rich content), `isPinned` (Boolean, default `false`), `isArchived` (Boolean, default `false`), `isEncrypted` (Boolean, default `false`), `version` (Int, default `1`), `createdAt`, `updatedAt`, `deletedAt`.
- **Indexes**: `@@index([userId])`, `@@index([folderId])`, `@@index([updatedAt])`.
- **`isEncrypted`** exists in the schema and is written by `POST /notes`, and it is
  dead: no read path in this repo branches on it, it is not in the `note` change
  payload, and the Flutter client's Isar column for it was dropped. It is the last
  column of a design where the server knew whether a note was encrypted — under the
  current scheme the server cannot tell, because note content travels to it in
  plaintext (SECURITY.md).

#### `NoteTag`
- **Primary Key**: `id` (`Uuid`) — a surrogate key, **not** a composite.
- **Constraints**: `@@unique([noteId, tagId])`, which is what stops the same tag
  being attached twice. `TaskLabel` is the same shape for the same reason.
- **Fields**: `noteId` (`Uuid`, FK -> `Note.id` `onDelete: Cascade`), `tagId` (`Uuid`, FK -> `Tag.id` `onDelete: Cascade`), `createdAt`.
- **Indexes**: `@@index([noteId])`, `@@index([tagId])`.
- A `Tag` is the one entity in this subsystem that is hard-deleted
  (`tags.service.ts:76`), so those two `Cascade`s are the only referential actions
  here that can actually fire; `Note` and `Folder` deletes are soft and never reach
  the FK layer.

---

### 4. Tasks Subsystem Models

#### `Project`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`), `name`, `description`, `color`, `icon`, `sortOrder` (Int, default `0`), `isArchived` (Boolean, default `false`), `createdAt`, `updatedAt`, `deletedAt`.
- **Indexes**: `@@index([userId])`.

#### `Section`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `projectId` (`Uuid`, FK -> `Project.id` `onDelete: Cascade`), `name`, `sortOrder` (Int, default `0`), `createdAt`, `updatedAt`.
- **Indexes**: `@@index([projectId])`.
- No `deletedAt`, unlike every other entity in this subsystem — and
  `deleteSection` is the only place in the task API that hard-deletes
  (`projects.service.ts:149`). It checks nothing beside ownership, so a section
  still named by live tasks is deleted out from under them.

#### `Task`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`), `projectId` (`Uuid`?, FK -> `Project.id`, `onDelete: Cascade`), `sectionId` (`Uuid`?, FK -> `Section.id`, `onDelete: NoAction`), `parentId` (`Uuid`?, FK -> `Task.id`, `onDelete: NoAction`), `title`, `description`, `priority` (`P1_URGENT`, `P2_HIGH`, `P3_MEDIUM`, `P4_LOW`; the row default is `P4_LOW`), `status` (`TODO`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`), `dueDate`, `dueTime`, `recurrenceRule`, `completedAt`, `sortOrder`, `version`, `createdAt`, `updatedAt`, `deletedAt`. Completion is derived strictly from `status === COMPLETED`, and `completedAt` follows it in both directions.
- **`recurrenceRule`** is a string the service pattern-matches for `FREQ=DAILY`,
  `FREQ=WEEKLY` or `FREQ=MONTHLY` — not a parsed RRULE, and `BYDAY`, `INTERVAL`,
  `COUNT` and `UNTIL` change nothing.

---

### 5. Vault Subsystem Models

#### `VaultSetting`
- **Primary Key**: `id` (`Uuid`), `userId` Unique
- **Fields**: `masterKeyHash`, `keySalt`, `kdfIterations` (Int, default `3`), `kdfMemory` (Int?, default `65536`), `isVaultConfigured` (Boolean), `recoveryKey` (String?), `wrappedMasterKey` (String?), `wrappedMasterIv` (String?), `wrappedMasterTag` (String?), `recoveryGrantedAt` (DateTime?), `unlockFailedAttempts` (Int, default `0`), `unlockLockedUntil` (DateTime?), `createdAt`, `updatedAt`.
- **Relations**: `userId` FK -> `User.id`, `onDelete: Cascade`.
- **Design Rationale**: Holds the master-password verifier and the recovery material, nothing about entries. `masterKeyHash` is `hmac-sha256:<base64>` of the verifier the client sent, keyed with the server-only `ENCRYPTION_KEY`, so reading this collection is not reading the unlock credential; rows written before that carry the raw value and are converted on their next successful unlock. `recoveryKey` is stored in plaintext beside `wrappedMasterKey`, which is what makes recovery possible and the vault server-readable; `recoveryGrantedAt` bounds how long a spent OTP lets `completeRecovery` rewrite the vault. `unlockFailedAttempts` / `unlockLockedUntil` rate-GATE the unlock endpoint per vault, deliberately duplicated from `User.failedLoginAttempts` so a wrong master password never locks the account itself. `kdfIterations` / `kdfMemory` are a record of what the client derived with (Argon2id `t=3`, `m=65536 KiB`, `p=4` — parallelism has no column), sent by the client and stored without being read: nothing in the server configures a KDF from this row, and the copy a future build can trust is the `_kdf` marker sealed inside every entry blob. Rows written before the client started reporting them carry `kdfIterations: 100000`, a placeholder from a PBKDF2-shaped schema that described no vault that ever existed; a recovery rewrites them.

#### Vault entries
There is no `VaultItem` model. Entries are `Change` rows with `entityType: "vault_item"` (section 2); the old `VaultItem` collection is dead data and its removal is a `prisma db push` concern, not a code change.

---

## Coverage — what this dictionary does not describe

`prisma/schema.prisma` declares **28** models. This page documents 17 of them. The
other eleven have no entry here and `schema.prisma` is the only description they
have: `EmailVerificationOtp`, `OtpToken`, `Tag`, `NoteHistory`, `Attachment`,
`TaskLabel`, `Reminder`, `Calendar`, `Event`, `EventAttendee`, `EventReminder`.

The ERD at the top of this file is short in the same direction: it has no `Change`,
no `SyncCursor`, no `Tag` or either join table, and no calendar subtree at all —
which matters more than a missing paragraph, because the change log *is* the sync
subsystem and the shape of a `Change` row is what a client has to get right. The
synchronisation diagram in ARCHITECTURE.md §3 carries that part.

---

## 🔗 Foreign Key Cascade Behaviors Matrix

What each relation *declares*, and whether any code path can actually reach it. The
two columns disagree more often than not, because eight of these entities are
soft-deleted: `deleteFolder`, `deleteNote`, `deleteTask`, `deleteProject`,
`deleteCalendar`, `deleteEvent` all set `deletedAt` and never issue a `delete`, so
the referential action beside their FK is a rule for a deletion that does not
happen. The only hard deletes in the whole service are `tag`, `section`,
`reminder`, expired `session` and expired `idempotencyKey` rows, the join-table
`deleteMany`s that replace a note's/task's/event's labels or attendees, and the
`change` prune in `maintenance.processor.ts`.

One more caveat before the table is worth reading: MongoDB has no foreign keys, so
nothing here is enforced by the database. Prisma's MongoDB connector emulates
relations in the client, and no suite in this repo exercises a cascade — every
backend test, unit and e2e, fakes Prisma and has no live database behind it. The
`onDelete` column is therefore "what the schema declares", not "what was observed".

| Relation | Declared `onDelete` | Reachable? |
|---|---|---|
| `Note.folderId → Folder.id` | `NoAction` | Not by any route: folders are soft-deleted. A "deleted" folder's notes keep their `folderId` and disappear from folder-scoped reads, which filter `deletedAt: null` — un-filed by the read filter, not by `SET NULL`. |
| `Folder.parentId → Folder.id` | `NoAction` | No. The "cannot delete a folder that still has children" rule is real, but it lives in application code (`folders.service.ts:111-119`, a `400`), which is what this row once mistook for `RESTRICT`. |
| `NoteTag.noteId → Note.id`, `NoteHistory.noteId`, `Attachment.noteId` | `Cascade` | Not through the notes API — `Note` is soft-deleted. Join rows are replaced instead: `updateNote` `deleteMany`s and re-inserts a note's tags. |
| `NoteTag.tagId → Tag.id`, `TaskLabel.tagId → Tag.id` | `Cascade` | **Yes** — `DELETE /tags/:id` hard-deletes, and these are the only two cascades in the table that a caller can trigger. |
| `Task.projectId → Project.id`, `Section.projectId → Project.id` | `Cascade` | No: `deleteProject` sets `deletedAt`. A deleted project's tasks and sections stay fully live and keep resolving through their own reads. |
| `Task.sectionId → Section.id` | `NoAction` | **Yes, and it bites** — `deleteSection` hard-deletes with no check for tasks still assigned to it, so this is the one place the declared action is what stands between a caller and orphaned rows. |
| `Task.parentId → Task.id` | `NoAction` | No: tasks are soft-deleted, and subtasks of a deleted parent keep pointing at it. (The row once said `CASCADE`, which would have destroyed a subtask tree with its parent.) |
| `TaskLabel.taskId → Task.id`, `Reminder.taskId → Task.id` | `Cascade` | No through `/tasks`. A `Reminder` is hard-deleted, but nothing references it. |
| `Event.calendarId → Calendar.id` | `Cascade` | No: `deleteCalendar` sets `deletedAt` and looks at no event. Its events stay live and keep appearing in `/events`, which is not what this row once claimed. |
| `EventAttendee.eventId → Event.id`, `EventReminder.eventId → Event.id` | `Cascade` | No: events are soft-deleted. Attendees are replaced wholesale when a PATCH carries the key. |
| `Session.deviceId → Device.id`, `DeviceSyncState.deviceId → Device.id` | `Cascade` | No: devices are revoked (`revokedAt`), never deleted. Expired sessions are hard-deleted by the maintenance job, and nothing references a session. |
| Every `→ User.id` | `Cascade` | **Never.** `DELETE /users/me` is a soft delete (`users.service.ts:81`): it sets `status: DELETED` + `deletedAt` and revokes the account's live sessions and devices in the same transaction, and touches no content row. So the user's notes, tasks, events, vault `Change` rows and `SyncCursor` all stay exactly where they were, recoverable by whoever clears the flag — and the vault entries outlive it only until the change prune. |

The pattern is worth stating plainly, because it is the opposite of what the
original table implied: referential integrity in this subsystem is enforced by
`deletedAt` filters in each service's `where` clause, not by the schema. Adding a
read that forgets `deletedAt: null` therefore surfaces soft-deleted rows, and no
database constraint will notice.
