# Allinone Backend — Database Schema & Data Dictionary

This document provides a comprehensive entity-relationship dictionary for all MongoDB collections and models defined in `prisma/schema.prisma`.

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
- **Primary Key**: `id` (`Uuid`, `gen_random_uuid()`)
- **Fields**: `email` (VarChar 255, Unique), `displayName`, `avatar`, `locale` (default `"en-US"`), `timezone` (default `"UTC"`), `status` (`ACTIVE`, `PENDING`, `SUSPENDED`, `DELETED`), `emailVerifiedAt`, `lastLoginAt`, `createdAt`, `updatedAt`, `deletedAt`.
- **Indexes**: `@@index([email])`, `@@index([status])`, `@@index([createdAt])`.

#### `Authentication`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`, FK -> `User.id` CASCADE), `type` (`EMAIL_PASSWORD`, `GOOGLE`, `APPLE`, `MICROSOFT`, `PASSKEY`), `identifier`, `passwordHash` (Argon2id ciphertext), `emailVerified`.
- **Constraints**: `@@unique([userId, type, identifier])`.

#### `Session`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`, FK -> `User.id` CASCADE), `deviceId` (`Uuid`, FK -> `Device.id` CASCADE), `accessToken` (Text, Unique), `refreshToken` (Text, Unique), `accessExpiresAt`, `refreshExpiresAt`, `revokedAt`, `lastActivityAt`, `ipAddress`, `userAgent`.

#### `MFASetting`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`, Unique, FK -> `User.id` CASCADE), `totpEnabled`, `totpSecret` (Application AES-encrypted), `recoveryCodes` (JSON string array), `backupCodesUsed` (JSON index array).

#### `AuditLog`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`?, nullable for failed logins/system events), `action` (`AuditAction`), `resourceType` (VarChar 50, optional), `resourceId` (`Uuid`, optional), `requestId` (`Uuid`, optional correlation ID), `changes` (`JsonB` diff), `ipAddress`, `userAgent`, `metadata` (`JsonB`), `createdAt`.
- **Indexes**: `@@index([userId])`, `@@index([action])`, `@@index([createdAt])`, `@@index([requestId])`.
- **Design Rationale**: `changes` (`JsonB`) stores attribute-level mutation diffs of altered entities, while `metadata` (`JsonB`) stores request telemetry, authentication context, and security event details, keeping mutation diffs separate from request metadata for optimal querying.

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
- **Fields**: `userId` (`Uuid`), `deviceId` (`Uuid`?), `entityType` (VarChar 50), `entityId` (`Uuid`), `operation` (`CREATE`, `UPDATE`, `DELETE`, `RESTORE`), `version` (Int), `payload` (`JsonB`), `cursor` (`BigInt`, autoincrement()), `createdAt`.
- **Indexes**: `@@index([userId])`, `@@index([deviceId])`, `@@index([cursor])`, `@@index([entityType, entityId])`.

#### `IdempotencyKey`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `key` (VarChar 255, Unique), `userId` (`Uuid`), `endpoint` (VarChar 255), `method` (VarChar 10), `statusCode` (Int), `response` (`JsonB`), `expiresAt` (DateTime), `createdAt` (DateTime).
- **Indexes**: `@@index([userId])`, `@@index([expiresAt])`.
- **Design Rationale**: Provides persistent database-backed storage for mutated idempotent requests, ensuring reliable exactly-once semantics across server restarts and Redis cache evictions.

---

### 3. Notes Subsystem Models

#### `Folder`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`), `parentId` (`Uuid`?, Self-relation FK, `onDelete: RESTRICT`), `name`, `color`, `icon`, `sortOrder` (Int), `createdAt`, `updatedAt`, `deletedAt`.

#### `Note`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`), `folderId` (`Uuid`?, FK -> `Folder.id`, `onDelete: SET NULL`), `title`, `content` (Text stored as plain Markdown text), `isPinned` (Boolean), `isArchived` (Boolean), `isEncrypted` (Boolean), `version` (Int), `createdAt`, `updatedAt`, `deletedAt`.

#### `NoteTag`
- **Primary Key**: Composite `@@id([noteId, tagId])`
- **Fields**: `noteId` (`Uuid`, FK -> `Note.id` CASCADE), `tagId` (`Uuid`, FK -> `Tag.id` CASCADE), `createdAt`.

---

### 4. Tasks Subsystem Models

#### `Project`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`), `name`, `description`, `color`, `icon`, `sortOrder`, `isArchived`.

#### `Task`
- **Primary Key**: `id` (`Uuid`)
- **Fields**: `userId` (`Uuid`), `projectId` (`Uuid`?, FK -> `Project.id`, `onDelete: CASCADE`), `sectionId` (`Uuid`?, FK -> `Section.id`, `onDelete: SET NULL`), `parentId` (`Uuid`?, FK -> `Task.id`, `onDelete: CASCADE`), `title`, `description`, `priority` (`P1_URGENT` to `P4_LOW`), `status` (`TODO`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`), `dueDate`, `dueTime`, `recurrenceRule`, `completedAt`. Completion is derived strictly from `status === COMPLETED`.

---

## 🔗 Foreign Key Cascade Behaviors Matrix

| Relation | `onDelete` | Rationale |
|---|---|---|
| `Note.folderId → Folder.id` | `SET NULL` | Deleting a folder un-files notes instead of deleting them. |
| `Folder.parentId → Folder.id` | `RESTRICT` | Blocks deleting non-empty parent folders; application layer requires moving/deleting children first. |
| `Task.projectId → Project.id` | `CASCADE` | Deleting a project cascades deletion to its child tasks. |
| `Task.sectionId → Section.id` | `SET NULL` | Tasks fall back to unassigned section within project. |
| `Task.parentId → Task.id` | `CASCADE` | Deleting a parent task cascades deletion to subtasks. |
| `Event.calendarId → Calendar.id` | `CASCADE` | Deleting a non-primary calendar removes contained events. |
