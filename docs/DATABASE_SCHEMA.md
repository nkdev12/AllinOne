# Allinone Backend — Database Schema & Data Dictionary

This document is an entity-relationship dictionary for the models defined in
`prisma/schema.prisma`. It describes all **28** of them; see _Coverage_ near the end
for the parts of the ERD that are still missing. Where this page and
`schema.prisma` disagree, the schema is right and this page is the defect.

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
- **Indexes**: `email` carries `@unique` (its own unique index, not an `@@index`), plus `@@index([status])` and `@@index([createdAt])`. There is no `@@index([email])` — an earlier revision of this page listed one, and `prisma/schema.prisma:19,51-52` (as of 2026-09-27) does not declare it.

> A note on the type names on this page. `prisma/schema.prisma` is the source of
> truth, and `datasource db` in it is `provider = "mongodb"`: the only scalar types
> available are `String`, `Int`, `BigInt`, `Float`, `Boolean`, `DateTime`, `Json` and
> enums, every `id` is a `String` holding a client-side `uuid()` under
> `@map("_id")`, and no column carries a `@db.` annotation at all — so nothing here
> states a length, a precision or a native binary type, and the database enforces no
> such thing. It also means a `_id` this page calls `Uuid` is never Mongo's own
> `ObjectId`: Prisma writes the UUID string into `_id` itself, and a document whose
> `_id` is an `ObjectId` cannot be read back through these models. This page still
> writes `Uuid` for an id column and `Text` for a `String` that may be long, because
> those words name what the service treats the value as. Read them as prose for "a
> `String` this code expects to be an id", never as a constraint.

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

#### `EmailVerificationOtp`

- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`, Unique, FK -> `User.id` CASCADE), `codeHash` (`String`), `expiresAt` (`DateTime`, no default), `createdAt` (`DateTime`, default `now()`).
- **Indexes**: `@@index([expiresAt])`.
- **Design Rationale**: one live email-verification code per account, kept as a hash so a read of the collection does not hand out codes.
- **Consumer**: **no code uses this model.** There is no `prisma.emailVerificationOtp`
  call anywhere under `src/`, and the flow that looks like it is not this model:
  `auth.service.ts:818` upserts a code and `auth.service.ts:871` spends one with a
  `findAndModify` carrying `remove: true`, both through `$runCommandRaw` against the
  collection named `email_verification_otps`. The model declares no `@@map`, so the
  collection Prisma maps it to is `EmailVerificationOtp` — a different one, which is
  why `db push` builds the `userId` unique and the `expiresAt` index on an empty
  collection while the raw documents sit in another with no unique index behind them
  and an `ObjectId` for `_id`, which is not the `String` this model declares and so
  could not be read through it even if the names matched. The flow works because both
  ends of it use the same raw collection. Two consequences of that split are real:
  nothing prunes `email_verification_otps` — `cleanup-expired` covers sessions,
  idempotency keys and `Change` rows and never mentions OTPs — and the raw
  `q: { userId }` upsert has no unique index to fall back on, so two concurrent
  requests for one account can leave two live documents where a caller can only
  spend one.

#### `OtpToken`

- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`, FK -> `User.id` CASCADE), `purpose` (`PASSWORD_RESET`, `VAULT_RECOVERY`), `codeHash` (`String`), `expiresAt` (`DateTime`, no default), `createdAt` (`DateTime`, default `now()`).
- **Constraints**: `@@unique([userId, purpose])`.
- **Indexes**: `@@index([expiresAt])`.
- **Design Rationale**: out-of-band 6-digit identity codes, keyed by purpose so a code issued for one flow can never be spent on the other — which is the only reason `PASSWORD_RESET` and `VAULT_RECOVERY` share a collection instead of one table each. `codeHash` is an unsalted `sha256` of the code (`otp.service.ts:51-52`), so it stops a stolen row being replayed verbatim and does not resist anyone willing to walk a 10^6 space; it is not the treatment `Authentication.passwordHash` gets.
- **Consumer**: `src/common/otp/otp.service.ts` is the only reader and writer — `issue` `upsert`s on `userId_purpose` (`:24`) and `consume` spends a code in one `deleteMany` matched on `userId`, `purpose`, `codeHash` and a future `expiresAt` (`:39`), which is what makes a code good for exactly one call. Two flows use it: `auth.service.ts:928` and `:976` for `PASSWORD_RESET`, `vault-settings.service.ts:296` and `:336` for `VAULT_RECOVERY`, both at a 15-minute TTL (`auth.service.ts:49`, `vault-settings.service.ts:20`). Expired rows are never swept — the `expiresAt` index only serves a spend, and `cleanup-expired` does not cover this collection — so an account that requests codes and never uses them keeps its single row, overwritten each time.

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
- **Design Rationale**: The single write path for synced content, including vault entries (`entityType: "vault_item"`, whose payload is an opaque client-side ciphertext). `payload` is not metadata-only — treat it as user content. It is the _only_ path for vault entries and one of _two_ for notes, tasks and events: the REST modules write their own entity row **and** append a `Change` here, and nothing replays this table into those rows.
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
  What the interceptor guarantees is _at-most-once for the response_, not exactly-once
  for the side effects: a second request on a live key never reaches the handler, so
  a batch whose first attempt was processed but whose response was lost is silently
  dropped rather than replayed. See API_REFERENCE.md §1 for what a caller should send.

---

### 3. Notes Subsystem Models

#### `Folder`

- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`), `parentId` (`Uuid`?, self-relation, `onDelete: NoAction`), `name`, `color`, `icon`, `sortOrder` (Int, default `0`), `createdAt`, `updatedAt`, `deletedAt`.
- **Indexes**: `@@index([userId])`, `@@index([parentId])`.

#### `Tag`

- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`, FK -> `User.id` CASCADE), `name`, `color`, `createdAt`, `updatedAt`.
- **Constraints**: `@@unique([userId, name])`.
- **Indexes**: `@@index([userId])`.
- **Relations out**: `noteTags NoteTag[]` and `taskLabels TaskLabel[]`. One `Tag`
  collection labels both subsystems, which is why there are two join tables over one
  set of names, namespaced by nothing but the account.
- **Consumer**: `src/notes/services/tags.service.ts` owns it end to end and
  `tags.controller.ts:32-72` exposes it as `POST/GET/PATCH/DELETE /tags`. `createTag`
  checks `(userId, name)` itself and answers `409` before the unique index is ever
  asked (`tags.service.ts:15-22`), and `deleteTag` at `:76` is the hard `delete` the
  two cascades in the matrix depend on. Notes and tasks never create tags; they only
  name ids.
- No `deletedAt`, so there is no soft-delete filter here to forget. A rename
  propagates for free, because a label is read through this row rather than copied
  into the join — and so does a delete, which is the same fact with the sign flipped.
- **`tagIds` are not checked by anything.** `createNote` / `updateNote`
  (`notes.service.ts:39-46`, `:215-220`) and `createTask` / `updateTask`
  (`tasks.service.ts:55-61`, `:217-221`) `createMany` whatever ids the body names:
  validated as UUID strings by `@IsUUID("4")` on the DTOs and never looked up by
  `userId`, unlike `folderId` and `projectId`, which are. On MongoDB nothing enforces
  the relation either, so a note can be labelled with another account's tag name or
  with an id that is in no collection at all, and `GET /notes?tagId=` will then filter
  on a join its owner cannot list.

#### `Note`

- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`), `folderId` (`Uuid`?, FK -> `Folder.id`, `onDelete: NoAction`), `title`, `content` (`String?`, plain text the client renders as rich content), `isPinned` (Boolean, default `false`), `isArchived` (Boolean, default `false`), `isEncrypted` (Boolean, default `false`), `tags` (`String[]`, default `[]`), `color` (`String?`), `noteType` (`String?`), `structured` (`String?`), `version` (Int, default `1`), `createdAt`, `updatedAt`, `deletedAt`.
- **Indexes**: `@@index([userId])`, `@@index([folderId])`, `@@index([updatedAt])`.
- **`isEncrypted`** exists in the schema and is written by `POST /notes`, and it is
  dead: no read path in this repo branches on it, it is not in the `note` change
  payload, and the Flutter client's Isar column for it was dropped. It is the last
  column of a design where the server knew whether a note was encrypted — under the
  current scheme the server cannot tell, because note content travels to it in
  plaintext (SECURITY.md).
- **`tags` and `color`** are the desktop client's own label list and highlight
  colour, stored under the two key names its Isar schema and `toMap()` use.
  `tags` is a list of bare strings rather than the normalised `NoteTag` join this
  row also carries, because a device typing a label has no `Tag` UUID to point
  at; the two are different state and neither is derived from the other. Note the
  consequence on REST reads: `formatNoteResponse` (`notes.service.ts`) already
  publishes a `tags` key holding the join's `Tag` records, and that mapping
  overwrites the new column rather than returning it, so the string list reaches
  a device through `/sync/pull` (where the payload carries it verbatim) and not
  through `GET /notes`.
- **`noteType` and `structured`** are the same client's note format and the table
  a formatted note holds instead of a body. `noteType` is the format's stable key
  (`normal`, `diary`, `shopping`, `bucket`, `quotes`) rather than the label shown
  for it, and it is deliberately not closed to those five on the server: a format
  is only a name the client looks up, and it renders an unrecognised one as a
  normal note. `structured` is the JSON text the client serialises, stored opaque
  for the reason the vault stores its blob opaque — the row shape is the app's to
  evolve. Both are nullable rather than defaulted, because `null` ("this note has
  no table") and the client's `{"rows":[]}` ("a table it emptied") are different
  state.
- Why a REST-authored change names `noteType`/`structured` only when its caller
  did: `POST /sync/push` now projects an accepted note change onto this row
  (`projectAcceptedChange`, `src/sync/change-projection.ts`), so the copy tracks
  the log for anything that has synced — but a device editing offline still holds
  a table this server has never heard of, and a `PATCH` that restated the row's
  copy would replay that newer table backwards onto every other device, since a
  device reads a present key as the whole new value. Silence is the only safe
  answer for a key the caller did not name. `tags` and `color` are restated
  always, because a REST caller that omits them is saying "no labels" and the
  client has no way to tell that from a build that never learned the key.
- Two things the projection deliberately does **not** do: it writes no
  `NoteHistory` snapshot, so a device's edit is not a version
  `GET /notes/:id/history` can offer back, and it performs no `noteTags`
  normalisation, so the scalar `tags` column and the `NoteTag` join can now
  disagree by more than which build wrote what.

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

#### `NoteHistory`

- **Primary Key**: `id` (`Uuid`)
- **Fields**: `noteId` (`Uuid`, FK -> `Note.id` CASCADE), `version` (`Int`, no default — it is copied, never minted), `title`, `content` (`String?`), `createdAt` (`DateTime`, default `now()`).
- **Indexes**: `@@index([noteId])`.
- **Design Rationale**: one pre-edit snapshot per edit. `updateNote` writes the row it
  is about to replace before it replaces it (`notes.service.ts:204-211`), so a history
  row holds the `version` the note had and the note then increments past it — which is
  why `version` needs no default and why `GET /notes/:id/history` can order by it
  alone (`:297-300`). `POST /notes/:id/history/:historyId/restore` snapshots the
  current state the same way before overwriting it (`:312-330`), so a restore is
  itself undoable, and logs the change as `RESTORE` with `restoredFromVersion` beside
  the payload — the one `note` change that names its source.
- **Rows belong to the note, not to a caller.** There is no `userId` here, so the only
  ownership a snapshot has is its note's: `getNoteHistory` authorises by reading the
  note first (`:295`), and the collaboration path inside that read
  (`:139-158`) therefore lets a permitted viewer list the whole history of a note it
  cannot edit. Nothing prunes this collection — `DELETE /notes/:id` is a soft delete
  that leaves the note and its history in place, and `cleanup-expired` covers
  sessions, idempotency keys and `Change` rows only — so it grows by exactly one row
  per edit, forever.

#### `Attachment`

- **Primary Key**: `id` (`Uuid`)
- **Fields**: `noteId` (`Uuid`, FK -> `Note.id` CASCADE), `userId` (`String`), `filename`, `mimeType`, `size` (`Int`), `storagePath`, `checksum` (`String?`), `createdAt` (`DateTime`, default `now()`).
- **Indexes**: `@@index([noteId])`, `@@index([userId])`.
- **`userId` is not a relation.** `Folder`, `Tag` and `Note` each declare
  `user User @relation`; this model declares none for `userId`, only the column and
  its index. No `onDelete` can fire through it, and the matrix's blanket "every
  `→ User.id`" row says nothing about it. `size` is an `Int` — Prisma's 32-bit signed
  range, which is the range `Change.cursor` stepped outside deliberately with
  `BigInt` — and MongoDB has no column width in the schema stating either one.
- **Consumer: no code writes this model.** There is no `prisma.attachment` call and no
  upload route anywhere under `src/`. The only touch is on the read side —
  `notes.service.ts` passes `include: { attachments: true }` at `:112`, `:135`, `:154`,
  `:238` and `:342` — so every note response carries an `attachments` array that is
  empty for every account, and `notes.controller.ts:53` still advertises attachments in
  the summary for `GET /notes/:id`. It is not a sync type either:
  `SYNC_ENTITY_TYPES` (`sync/change-payload.validator.ts:11-24`) admits `note`, `task`,
  `event`, `calendar`, `habit`, `habit_log` and `vault_item`, and a push naming `attachment` is
  refused by the entity-type check. `schema.prisma` is the only description this model
  has, and the storage path, checksum and mime type in it are a design no endpoint
  implements.

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

#### `TaskLabel`

- **Primary Key**: `id` (`Uuid`) — a surrogate key, **not** a composite, the same shape `NoteTag` is.
- **Fields**: `taskId` (`Uuid`, FK -> `Task.id` CASCADE), `tagId` (`Uuid`, FK -> `Tag.id` CASCADE), `createdAt` (`DateTime`, default `now()`).
- **Constraints**: `@@unique([taskId, tagId])`, which is what stops the same label being attached twice.
- **Indexes**: `@@index([taskId])`, `@@index([tagId])`.
- **Consumer**: `src/tasks/services/tasks.service.ts`, and nothing outside it. Written as a nested `taskLabels: { createMany }` on `createTask` (`:55-61`) and on the follow-up task `completeTask` spawns for the next occurrence, which copies the labels forward from the row it cloned (`:344-348`). Replaced whole by a `deleteMany` and a `createMany` inside `updateTask` whenever the body carries `tagIds` (`:217-221`). Read back through `include: { taskLabels: { include: { tag: true } } }` and flattened into a `tags` array by `formatTaskResponse` (`:429-433`), and used as a filter as `where.taskLabels = { some: { tagId } }` for `GET /tasks?tagId=` (`:125`).
- No route names a `TaskLabel` by its own id — `tasks.controller.ts` has no label
  endpoint — so a row exists or stops existing only as part of a task's edit, and the
  `tagId`s in it are the unchecked ones described under `Tag`.

#### `Reminder`

- **Primary Key**: `id` (`Uuid`)
- **Fields**: `taskId` (`Uuid`, FK -> `Task.id` CASCADE), `userId` (`Uuid`, FK -> `User.id` CASCADE), `remindAt` (`DateTime`, no default), `isSent` (`Boolean`, default `false`), `channel` (`NOTIFICATION`, `EMAIL`; the row default is `NOTIFICATION`), `createdAt` (`DateTime`, default `now()`).
- **Indexes**: `@@index([taskId])`, `@@index([userId])`, `@@index([remindAt])`.
- **Consumer**: `src/tasks/services/reminders.service.ts`, behind `POST/GET /tasks/:id/reminders` and `DELETE /tasks/reminders/:reminderId` (`tasks.controller.ts:107-134`). `createReminder` confirms the task is the caller's and not soft-deleted, then writes the row (`:11-26`); `getReminders` lists one task's own ordered by `remindAt` (`:38-41`); `deleteReminder` is a hard `delete` (`:55`), one of the few in this service — and, as the matrix's `Reminder.taskId → Task.id` row has it, nothing references a reminder, so deleting one cascades nowhere and its task's `Cascade` never fires either way.
- **Nothing fires these rows.** `remindAt` and `channel` are written and then read back
  only to be listed: no processor, cron or worker under `src/` selects a due reminder,
  and the `notification` queue's only processor (`src/queues/processors/notification.processor.ts:17-31`)
  sleeps 50 ms and logs a delivery without querying anything first. `isSent` is
  consequently `false` on every row forever — `createReminder` does not set it and this
  model has no update verb at all. Nothing prunes it either: `cleanup-expired` covers
  sessions, idempotency keys and `Change` rows and never mentions reminders, and a
  soft-deleted task keeps its schedule beside the tombstone.

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

### 6. Calendar Subsystem Models

#### `Calendar`

- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`, FK -> `User.id` CASCADE), `name`, `description`, `color`, `timeZone` (`String`, default `"UTC"`), `isPrimary` (`Boolean`, default `false`), `isPublic` (`Boolean`, default `false`), `externalProvider` (`LOCAL`, `GOOGLE`, `MICROSOFT`, `ICAL`; the row default is `LOCAL`), `externalId`, `createdAt`, `updatedAt`, `deletedAt`.
- **Indexes**: `@@index([userId])`.
- **Relations out**: `events Event[]`.
- **Consumer**: `src/calendar/services/calendars.service.ts` behind
  `calendars.controller.ts:32-79`, plus `collaboration.service.ts:75`, which reads a
  row here to resolve the owner of a `CALENDAR` share. `createCalendar` demotes any
  other primary first with a separate `updateMany` (`:13-16`) — so "one primary per
  account" is an application rule with no unique index behind it and no transaction
  around the pair of writes, and `updateCalendar` repeats the same two-step at `:81-85`.
  `getCalendars` creates the "Personal" primary on the spot when a user with no live
  calendar asks for the list (`:38-51`), and since the check that decides it filters
  `deletedAt: null`, `deleteCalendar` (`:103-106`, soft) followed by the next
  `GET /calendars` mints a second one.
- **`externalProvider` is a label with nothing behind it.** The DTO accepts `GOOGLE`,
  `MICROSOFT` and `ICAL` and `updateCalendar` will store them (`:95`), but no code
  under `src/` contacts a calendar provider: there is no sync, import or export, and
  `externalId` — the field that would name the remote copy — is written by nothing and
  read by nothing. `isPublic` is the same shape of dead: no route sets it, no read
  filters on it.

#### `Event`

- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`, FK -> `User.id` CASCADE), `calendarId` (`Uuid`, FK -> `Calendar.id` CASCADE), `title`, `description`, `location`, `startAt` (`DateTime`, no default), `endAt` (`DateTime`, no default), `isAllDay` (`Boolean`, default `false`), `recurrenceRule`, `status` (`CONFIRMED`, `TENTATIVE`, `CANCELLED`; the row default is `CONFIRMED`), `color`, `version` (`Int`, default `1`), `createdAt`, `updatedAt`, `deletedAt`.
- **Indexes**: `@@index([userId])`, `@@index([calendarId])`, `@@index([startAt, endAt])`.
- **Relations out**: `attendees EventAttendee[]`, `reminders EventReminder[]`.
- **Consumer**: `src/calendar/services/events.service.ts` behind
  `events.controller.ts:36-116`, and one of the entity rows that also writes the sync
  log: `appendChange` with `entityType: "event"` on create (`:75`), update (`:225`) and
  delete (`:299`), each with its own partial payload. `createEvent` verifies the target
  calendar is the caller's and live (`:24-32`) and that `endAt` is strictly after
  `startAt` (`:34-38`); `getEvents` pages over `deletedAt: null` and builds its window as
  `endAt >= startFrom` and `startAt <= startTo` (`:108-116`), which is the read the
  `[startAt, endAt]` index exists for. `deleteEvent` soft-deletes and bumps `version`
  in the same write (`:296`), so the `existing.version + 1` it logs at `:304` does name
  a version the row reaches.
- **`PATCH /events/:id` does not re-check the calendar.** `updateEvent` puts
  `dto.calendarId` straight into the row (`:206`) after verifying only that the _event_
  is the caller's, so an edit can move an event onto a calendar its owner does not have
  — the check `createEvent` makes and `updateEvent` skips. `recurrenceRule` is stored
  and echoed the way a task's is, and expands to nothing here: no reader ever repeats
  an event.

#### `EventAttendee`

- **Primary Key**: `id` (`Uuid`)
- **Fields**: `eventId` (`Uuid`, FK -> `Event.id` CASCADE), `email` (`String`), `displayName`, `status` (`NEEDS_ACTION`, `ACCEPTED`, `DECLINED`, `TENTATIVE`; the row default is `NEEDS_ACTION`), `isOrganizer` (`Boolean`, default `false`), `createdAt` (`DateTime`, default `now()`).
- **Indexes**: `@@index([eventId])`, `@@index([email])`.
- **Consumer**: created as a nested `createMany` inside `tx.event.create`
  (`events.service.ts:54-66`) and replaced whole — `deleteMany` then `createMany` —
  whenever a `PATCH /events/:id` carries the `attendees` key (`:189-200`).
  `PATCH /events/:id/rsvp` is the only verb that names one row directly:
  `updateAttendeeRSVP` finds it by `(eventId, email)` and updates `status` and nothing
  else (`:251-264`).
- **There is no `@@unique([eventId, email])`,** and that pair is what RSVP is keyed by.
  A create or a replacement that lists one address twice leaves two rows, and the
  lookup above updates the first one it finds. An attendee is an email string, not a
  `User` — no relation, no account resolution — so `isOrganizer` is a claim the caller
  makes about itself and `NEEDS_ACTION` is where every attendee begins whatever the
  other side said.

#### `EventReminder`

- **Primary Key**: `id` (`Uuid`)
- **Fields**: `eventId` (`Uuid`, FK -> `Event.id` CASCADE), `userId` (`String`), `minutesBefore` (`Int`, default `15`), `channel` (`NOTIFICATION`, `EMAIL`; the row default is `NOTIFICATION`), `createdAt` (`DateTime`, default `now()`).
- **Indexes**: `@@index([eventId])`, `@@index([userId])`.
- **`userId` is a bare indexed column, not a relation**: this model declares no
  `user User @relation` for it, the same shape as `Attachment.userId`, so no
  referential action can fire through it and the matrix's blanket "every `→ User.id`"
  row does not speak for it.
- **Consumer**: `POST /events/:id/reminders` → `events.service.ts:274-281`, which
  confirms the event is the caller's live row and writes one document. The service
  re-states `minutesBefore ?? 15` and `channel ?? NOTIFICATION` in code even though the
  schema defaults both, so the column default is only reached by a row written outside
  this endpoint.
- **Written once, never acted on.** The `include: { reminders: true }` on the four event
  reads (`:71`, `:136`, `:158`, `:221`) echoes these rows into an event response, and
  that is the only place they surface: like a task's `Reminder`, nothing schedules or
  delivers them, no processor selects them, there is no update or delete verb for them
  and no route to remove one, and `cleanup-expired` does not reach this collection. A
  reminder set in error leaves with its event, and that leaves only a tombstone.

---

## 7. Collaboration Model

### `ResourceShare` — who may open whose note, project or calendar

Added 2026-09-27 with the rest of the collaboration work, and the reason
`CollaborationService` stopped keeping shares in a process-local `Map`.

```prisma
model ResourceShare {
  id               String            @id @default(uuid()) @map("_id")
  resourceType     ShareResourceType         // NOTE | PROJECT | CALENDAR
  resourceId       String
  ownerId          String
  sharedWithUserId String                    // required — not optional
  sharedWithEmail  String
  role             ShareRole         @default(VIEWER)   // VIEWER | EDITOR | ADMIN
  createdAt        DateTime          @default(now())
  updatedAt        DateTime          @updatedAt
  deletedAt        DateTime?

  owner            User  @relation("ResourceShareOwner",  fields: [ownerId],          references: [id], onDelete: Cascade)
  sharedWith       User  @relation("ResourceShareGrantee", fields: [sharedWithUserId], references: [id], onDelete: Cascade)

  @@unique([resourceType, resourceId, sharedWithEmail])
  @@index([resourceType, resourceId])
  @@index([sharedWithUserId])
  @@index([sharedWithEmail])
  @@index([ownerId])
}
```

- **`resourceType` / `resourceId` are not a foreign key.** There is no relation to `Note`,
  `Project` or `Calendar`; the service resolves the resource by hand in
  `verifyResourceOwner()` and takes the owner's id from whatever it finds. A grant against a
  row that is later hard-deleted is therefore not cascaded — the two `User` relations above
  cascade, the resource side does not.
- **`sharedWithUserId` is required, and that is the whole point of the model change.** The
  previous in-memory version let a grant be written with no resolvable grantee, and since the
  notes read/write path calls `checkAccess(userId, undefined, …)` an email-only share matched
  nothing while still listing a collaborator. The column being non-optional pushes the check
  to the boundary: `shareResource` looks the address up first and answers `409 No registered
account found for '<email>'` instead of storing an inert row.
- **The duplicate rule is the unique index, not the read before it.** `getSharesForResource`
  and `shareResource` both `findFirst` first, but that is an optimisation: two racing requests
  can both miss it, and the loser fails with `P2002`, which the service maps to the same `409`
  wording. Read-then-write alone would have let a second grant through.
- **`deletedAt` is a tombstone that still occupies the unique key.** Revoke soft-deletes the
  row, and because the index does not include `deletedAt`, re-sharing with that address
  collides — so the service revives the existing row (`deletedAt: null`, new `role`) instead
  of inserting. `createdAt` therefore stays on the original grant: a re-shared collaborator can
  show a `createdAt` months older than the grant that is currently active.
- **`sharedWithEmail` is stored lower-cased** and matched case-insensitively on read, so the
  address in this row and the `User.email` it came from can differ in case but not in value.
- **Nothing syncs this collection.** A share is never written as a `Change` row, so a device
  learns who else can see a resource only by calling `/collaboration`; two replicas share it
  because it is in MongoDB, which is the part the `Map` could not do.
- **⚠️ Requires `prisma db push` before any of it works.** This repository has no
  `prisma/migrations/` directory — the workflow is `prisma db push` against a replica-set
  MongoDB (`mongod --replSet rs0`, because the service writes inside `$transaction`). As of
  2026-09-27 the push has **not** been run against any environment, so `ResourceShare` exists
  in `prisma/schema.prisma` and in no database, and every `/collaboration` route fails on the
  missing collection until it is pushed.

`AuditAction` gained two members with the model — `RESOURCE_SHARED` (on grant) and
`RESOURCE_SHARE_REVOKED` (on revoke) — replacing the earlier reuse of `DEVICE_ADDED` /
`DEVICE_REVOKED`, so an audit or SIEM query for device events no longer returns
collaboration events.

---

## Coverage — what this dictionary still does not draw

`prisma/schema.prisma` declares **29** models and every one of them now has an entry
above: §1 identity and auth (`User`, `Authentication`, `Session`, `MFASetting`,
`EmailVerificationOtp`, `OtpToken`, `AuditLog`), §2 devices and sync (`Device`,
`DeviceSyncState`, `Change`, `SyncCursor`, `IdempotencyKey`), §3 notes (`Folder`,
`Tag`, `Note`, `NoteTag`, `NoteHistory`, `Attachment`), §4 tasks (`Project`,
`Section`, `Task`, `TaskLabel`, `Reminder`), §5 the vault (`VaultSetting`, plus the
note that there is no `VaultItem` model), §6 calendar (`Calendar`, `Event`,
`EventAttendee`, `EventReminder`), and §7 collaboration (`ResourceShare`). Two of those
entries are the page saying a model has no code behind it: `Attachment` is read and never
written, and `EmailVerificationOtp` is neither — its flow runs on another collection.
A third kind of entry exists now too: `ResourceShare` has code behind it and no database
behind that, until the schema is pushed.

The ERD at the top of this file is still a sketch of the spines it always sketched. It
has no `Change`, no `SyncCursor`, no `IdempotencyKey`, no `Tag` or either join table,
no `EmailVerificationOtp` or `OtpToken`, no `Attachment`, and nothing below `Event` —
which matters more than a missing paragraph, because the change log _is_ the sync
subsystem and the shape of a `Change` row is what a client has to get right. The
synchronisation diagram in ARCHITECTURE.md §3 carries that part.

---

## 🔗 Foreign Key Cascade Behaviors Matrix

What each relation _declares_, and whether any code path can actually reach it. The
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

| Relation                                                               | Declared `onDelete` | Reachable?                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Note.folderId → Folder.id`                                            | `NoAction`          | Not by any route: folders are soft-deleted. A "deleted" folder's notes keep their `folderId` and disappear from folder-scoped reads, which filter `deletedAt: null` — un-filed by the read filter, not by `SET NULL`.                                                                                                                                                                                                                      |
| `Folder.parentId → Folder.id`                                          | `NoAction`          | No. The "cannot delete a folder that still has children" rule is real, but it lives in application code (`folders.service.ts:111-119`, a `400`), which is what this row once mistook for `RESTRICT`.                                                                                                                                                                                                                                       |
| `NoteTag.noteId → Note.id`, `NoteHistory.noteId`, `Attachment.noteId`  | `Cascade`           | Not through the notes API — `Note` is soft-deleted. Join rows are replaced instead: `updateNote` `deleteMany`s and re-inserts a note's tags.                                                                                                                                                                                                                                                                                               |
| `NoteTag.tagId → Tag.id`, `TaskLabel.tagId → Tag.id`                   | `Cascade`           | **Yes** — `DELETE /tags/:id` hard-deletes, and these are the only two cascades in the table that a caller can trigger.                                                                                                                                                                                                                                                                                                                     |
| `Task.projectId → Project.id`, `Section.projectId → Project.id`        | `Cascade`           | No: `deleteProject` sets `deletedAt`. A deleted project's tasks and sections stay fully live and keep resolving through their own reads.                                                                                                                                                                                                                                                                                                   |
| `Task.sectionId → Section.id`                                          | `NoAction`          | **Yes, and it bites** — `deleteSection` hard-deletes with no check for tasks still assigned to it, so this is the one place the declared action is what stands between a caller and orphaned rows.                                                                                                                                                                                                                                         |
| `Task.parentId → Task.id`                                              | `NoAction`          | No: tasks are soft-deleted, and subtasks of a deleted parent keep pointing at it. (The row once said `CASCADE`, which would have destroyed a subtask tree with its parent.)                                                                                                                                                                                                                                                                |
| `TaskLabel.taskId → Task.id`, `Reminder.taskId → Task.id`              | `Cascade`           | No through `/tasks`. A `Reminder` is hard-deleted, but nothing references it.                                                                                                                                                                                                                                                                                                                                                              |
| `Event.calendarId → Calendar.id`                                       | `Cascade`           | No: `deleteCalendar` sets `deletedAt` and looks at no event. Its events stay live and keep appearing in `/events`, which is not what this row once claimed.                                                                                                                                                                                                                                                                                |
| `EventAttendee.eventId → Event.id`, `EventReminder.eventId → Event.id` | `Cascade`           | No: events are soft-deleted. Attendees are replaced wholesale when a PATCH carries the key.                                                                                                                                                                                                                                                                                                                                                |
| `Session.deviceId → Device.id`, `DeviceSyncState.deviceId → Device.id` | `Cascade`           | No: devices are revoked (`revokedAt`), never deleted. Expired sessions are hard-deleted by the maintenance job, and nothing references a session.                                                                                                                                                                                                                                                                                          |
| Every `→ User.id`                                                      | `Cascade`           | **Never.** `DELETE /users/me` is a soft delete (`users.service.ts:81`): it sets `status: DELETED` + `deletedAt` and revokes the account's live sessions and devices in the same transaction, and touches no content row. So the user's notes, tasks, events, vault `Change` rows and `SyncCursor` all stay exactly where they were, recoverable by whoever clears the flag — and the vault entries outlive it only until the change prune. |

The pattern is worth stating plainly, because it is the opposite of what the
original table implied: referential integrity in this subsystem is enforced by
`deletedAt` filters in each service's `where` clause, not by the schema. Adding a
read that forgets `deletedAt: null` therefore surfaces soft-deleted rows, and no
database constraint will notice.
