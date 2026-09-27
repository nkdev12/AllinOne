# Allinone Backend — Modules & Subsystems Guide

This document provides a detailed technical breakdown of all 13 modules, cross-cutting services, dependency injection hierarchy, and worker job processors within `Allinone Backend`. For every service, controller, guard, interceptor, and background processor, every function and method is documented with its signature, internal behavior, and invocation site.

---

## 🏛️ Dependency Injection Architecture

```
                                  ┌──────────────────┐
                                  │    AppModule     │
                                  └────────┬─────────┘
                                           │
  ┌───────────────────┬────────────────────┼────────────────────┬───────────────────┐
  │                   │                    │                    │                   │
  ▼                   ▼                    ▼                    ▼                   ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  AuthModule  │    │ UsersModule  │    │DevicesModule │    │ SyncModule   │    │ NotesModule  │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
  │                                                               │
  ▼                                                               ▼
┌──────────────┐                                            ┌──────────────┐
│ AuditModule  │                                            │MetricsModule │
└──────────────┘    ┌──────────────┐    ┌──────────────┐    └──────────────┘    ┌──────────────┐
  │                 │ TasksModule  │    │CalendarModule│    │ VaultModule  │    │QueuesModule  │
  └─────────────────┴──────────────┴────┴──────────────┴────┴──────────────┴────┴──────────────┘
```

---

## 📦 System Subsystems & Function Catalog

### 1. `AuthModule` (`src/auth`)
Handles user registration, credential login, MFA (TOTP), OAuth token exchanges, and token lifecycle management.

#### `AuthService` (`src/auth/auth.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `register(dto: RegisterDto): Promise<AuthResponseDto>` | Hashes password with Argon2id, creates User record in DB, generates access & refresh JWT tokens, and enqueues welcome email. | `AuthController.register` (`POST /auth/register`) |
| `login(dto: LoginDto, ipAddress?: string, userAgent?: string): Promise<AuthResponseDto>` | Validates user credentials via Argon2id, checks MFA status, issues JWT tokens, creates active `Session`, and records audit log. | `AuthController.login` (`POST /auth/login`) |
| `loginWithGoogle(dto: OAuthLoginDto, ipAddress?: string, userAgent?: string): Promise<AuthResponseDto>` | Verifies Google ID token via `google-auth-library`, finds or creates OAuth user account, issues tokens, and logs session. | `AuthController.loginWithGoogle` (`POST /auth/oauth/google`) |
| `loginWithApple(dto: OAuthLoginDto, ipAddress?: string, userAgent?: string): Promise<AuthResponseDto>` | Decodes Apple OAuth JWT payload, creates or links account, issues JWT tokens, and creates session. | `AuthController.loginWithApple` (`POST /auth/oauth/apple`) |
| `loginWithMicrosoft(dto: OAuthLoginDto, ipAddress?: string, userAgent?: string): Promise<AuthResponseDto>` | Decodes Microsoft OAuth JWT token, resolves user profile, generates access/refresh tokens, and records audit event. | `AuthController.loginWithMicrosoft` (`POST /auth/oauth/microsoft`) |
| `refreshTokens(dto: RefreshTokenDto): Promise<AuthResponseDto>` | Validates refresh JWT token and active DB session, revokes previous refresh token, rotates session token, and returns new token pair. | `AuthController.refresh` (`POST /auth/refresh`) |
| `logout(sessionId: string): Promise<{ success: boolean }>` | Soft-deletes/revokes active session in DB (`revokedAt = now()`) and invalidates refresh token. | `AuthController.logout` (`POST /auth/logout`) |
| `generateMfaSecret(userId: string): Promise<MfaSecretResponseDto>` | Generates TOTP secret (`otplib`), generates QR code URL (`qrcode`), and creates 10 single-use recovery codes. | `AuthController.generateMfaSecret` (`POST /auth/mfa/generate`) |
| `enableMfa(userId: string, dto: EnableMfaDto): Promise<MfaEnableResponseDto>` | Verifies provided TOTP code against secret, enables MFA on user account (`isMfaEnabled = true`), and stores hashed recovery codes. | `AuthController.enableMfa` (`POST /auth/mfa/enable`) |
| `verifyMfaLogin(dto: VerifyMfaLoginDto, ipAddress?: string, userAgent?: string): Promise<AuthResponseDto>` | Validates TOTP code or single-use recovery code during 2FA login verification step. | `AuthController.verifyMfaLogin` (`POST /auth/mfa/verify`) |
| `disableMfa(userId: string, dto: DisableMfaDto): Promise<{ success: boolean }>` | Verifies user password/TOTP code and disables 2FA on account (`isMfaEnabled = false`). | `AuthController.disableMfa` (`POST /auth/mfa/disable`) |
| `requestEmailVerification(email: string): Promise<{ success: boolean }>` | Generates email verification token in DB and queues `MailProcessor` job to send verification email. | `AuthController.requestEmailVerification` (`POST /auth/verify-email/request`) |
| `confirmEmailVerification(token: string): Promise<{ success: boolean }>` | Validates token, marks user email as verified (`emailVerified = true`), and deletes verification token. | `AuthController.confirmEmailVerification` (`POST /auth/verify-email/confirm`) |
| `forgotPassword(email: string): Promise<{ success: boolean }>` | Generates password reset token with 1-hour expiration and enqueues password reset email job. | `AuthController.forgotPassword` (`POST /auth/forgot-password`) |
| `resetPassword(token: string, newPassword: string): Promise<{ success: boolean }>` | Verifies reset token, hashes new password with Argon2id, updates user account, and revokes all active sessions. | `AuthController.resetPassword` (`POST /auth/reset-password`) |

#### `AuthController` (`src/auth/auth.controller.ts`)
- `register(@Body() dto: RegisterDto)` -> Calls `authService.register`
- `login(@Body() dto: LoginDto, @Req() req, @Res() res)` -> Calls `authService.login`, sets `httpOnly` `refresh_token` cookie
- `loginWithGoogle(@Body() dto: OAuthLoginDto, @Req() req, @Res() res)` -> Calls `authService.loginWithGoogle`, sets `refresh_token` cookie
- `loginWithApple(@Body() dto: OAuthLoginDto, @Req() req, @Res() res)` -> Calls `authService.loginWithApple`, sets `refresh_token` cookie
- `loginWithMicrosoft(@Body() dto: OAuthLoginDto, @Req() req, @Res() res)` -> Calls `authService.loginWithMicrosoft`, sets `refresh_token` cookie
- `refresh(@Body() dto: RefreshTokenDto, @Req() req, @Res() res)` -> Extracts token from body or cookie, calls `authService.refreshTokens`, updates cookie
- `logout(@GetUser('sessionId') sessionId: string, @Res() res)` -> Calls `authService.logout`, clears `refresh_token` cookie
- `generateMfaSecret(@GetUser('id') userId: string)` -> Calls `authService.generateMfaSecret`
- `enableMfa(@GetUser('id') userId: string, @Body() dto: EnableMfaDto)` -> Calls `authService.enableMfa`
- `verifyMfaLogin(@Body() dto: VerifyMfaLoginDto, @Req() req, @Res() res)` -> Calls `authService.verifyMfaLogin`, sets `refresh_token` cookie
- `disableMfa(@GetUser('id') userId: string, @Body() dto: DisableMfaDto)` -> Calls `authService.disableMfa`
- `requestEmailVerification(@Body() dto: VerifyEmailRequestDto)` -> Calls `authService.requestEmailVerification`
- `confirmEmailVerification(@Body() dto: ConfirmEmailDto)` -> Calls `authService.confirmEmailVerification`
- `forgotPassword(@Body() dto: ForgotPasswordDto)` -> Calls `authService.forgotPassword`
- `resetPassword(@Body() dto: ResetPasswordDto)` -> Calls `authService.resetPassword`

---

### 2. `UsersModule` (`src/users`)
Manages user profiles, active session listing/revocation, GDPR data exports, and account deletion.

#### `UsersService` (`src/users/users.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `getProfile(userId: string): Promise<UserProfileDto>` | Fetches user profile record by ID, omitting sensitive password hash and MFA secrets. | `UsersController.getProfile` (`GET /users/me`) |
| `updateProfile(userId: string, dto: UpdateProfileDto): Promise<UserProfileDto>` | Updates user display name, avatar URL, locale, and timezone settings. | `UsersController.updateProfile` (`PATCH /users/me`) |
| `getSessions(userId: string): Promise<SessionDto[]>` | Retrieves all active non-revoked session records for a user. | `UsersController.getSessions` (`GET /users/me/sessions`) |
| `revokeSession(userId: string, sessionId: string): Promise<{ success: boolean }>` | Revokes a specified user session by ID (`revokedAt = now()`). | `UsersController.revokeSession` (`DELETE /users/me/sessions/:id`) |
| `revokeAllOtherSessions(userId: string, currentSessionId: string): Promise<{ count: number }>` | Revokes all active sessions for a user except the currently active session ID. | `UsersController.revokeAllOtherSessions` (`DELETE /users/me/sessions`) |
| `requestDataExport(userId: string): Promise<{ jobId: string, message: string }>` | Queues a GDPR export background job in `ExportProcessor` via `@nestjs/bull`. Returns HTTP 202 Accepted. | `UsersController.exportData` (`POST /users/me/export`) |
| `deleteAccount(userId: string): Promise<{ success: boolean }>` | Soft-deletes user account (`status = DELETED`, `deletedAt = now()`), revokes all active sessions and registered devices. | `UsersController.deleteAccount` (`DELETE /users/me`) |

---

### 3. `DevicesModule` (`src/devices`)
Manages multi-device registration, public key binding, and device status lifecycle.

#### `DevicesService` (`src/devices/devices.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `registerDevice(userId: string, dto: RegisterDeviceDto): Promise<DeviceDto>` | Registers device platform (`IOS`, `ANDROID`, `WEB`, etc.), binds public key, creates `DeviceSyncState`, and returns registered device details. | `DevicesController.registerDevice` (`POST /devices`) |
| `getDevices(userId: string): Promise<DeviceDto[]>` | Lists all non-revoked devices registered to the specified user. | `DevicesController.getDevices` (`GET /devices`) |
| `getDeviceById(userId: string, deviceId: string): Promise<DeviceDto>` | Retrieves device details by ID for the requesting user. | `DevicesController.getDeviceById` (`GET /devices/:id`) |
| `updateDevice(userId: string, deviceId: string, dto: UpdateDeviceDto): Promise<DeviceDto>` | Updates device name, push notification token, or client app version. | `DevicesController.updateDevice` (`PATCH /devices/:id`) |
| `revokeDevice(userId: string, deviceId: string): Promise<{ success: boolean }>` | Marks device as revoked (`revokedAt = now()`), preventing future push/pull synchronization operations. | `DevicesController.revokeDevice` (`DELETE /devices/:id`) |

---

### 4. `SyncModule` (`src/sync`)
Engine for delta synchronization, version-based conflict detection, and real-time WebSocket invalidation. It is also the only write path for vault entries.

#### `SyncService` (`src/sync/sync.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `pushChanges(userId: string, dto: PushSyncDto): Promise<PushSyncResponseDto>` | Unconditionally scopes DB queries by `userId`. Validates the whole batch through `assertPushableChanges` before any row is written, detects `VERSION_MISMATCH` conflicts (rejecting stale changes and returning server payload/version), allocates a per-user cursor for each accepted change, updates `DeviceSyncState`, and emits WebSocket invalidations. | `SyncController.pushChanges` (`POST /sync/push`) |
| `pullChanges(userId: string, dto: PullSyncDto): Promise<PullSyncResponseDto>` | Pulls change deltas after the specified cursor, ordered by `cursor` and scoped strictly to `userId`, updates `lastPulledCursor`, and returns `{changes, nextCursor, hasMore}`. | `SyncController.pullChanges` (`POST /sync/pull`) |
| `getSyncStatus(userId: string, deviceId: string): Promise<SyncStatusDto>` | Fetches synchronization state, client cursor position, and highest server cursor for a device. | `SyncController.getSyncStatus` (`GET /sync/status?deviceId=`) |

#### Change cursors (`src/sync/change-cursor.ts`)
Mongo has no sequence primitive, so `SyncCursor` holds one `{userId, seq}` document per user and `allocateNextChangeCursor` `$inc`s it inside the transaction that writes the `Change` row. That is what makes pull replay changes in the order they were accepted, and why a rolled-back push cannot burn a number. `getHighestChangeCursor` takes the larger of the counter and the newest stored row, so pruning the log can never move the reported end backwards. Rows written before this existed all carry `cursor: 0`; `npm run sync:backfill:cursor` (`scripts/backfill-change-cursor.ts`) seeds them.

#### Payload validation (`src/sync/change-payload.validator.ts`)
`entityType` must be one of `SYNC_ENTITY_TYPES` (`note`, `task`, `event`, `vault_item`). A `vault_item` content change (`CREATE` / `UPDATE` / `RESTORE`) must carry non-empty string `type`, `encryptedData`, `iv`, `authTag` and boolean `isEncrypted`; `type`, `iv` and `authTag` are additionally capped at 128 characters (`MAX_VAULT_FIXED_FIELD_CHARS`), since a 96-bit nonce base64s to 16 and a GCM tag to 24 — anything longer is not a bigger secret. `encryptedData` is exempt: it scales with the entry and the limit that bounds it is the request body cap, not a per-field number. A `DELETE` is not judged on its payload at all, because a tombstone legitimately carries nothing. A batch holding a change no device could replay is refused whole with `SYNC_PUSH_REJECTED` and a per-field report, and `changes` itself is capped at `MAX_CHANGES_PER_PUSH` (500) by `@ArrayMaxSize` on `PushSyncDto`, because the whole batch is one `$transaction`.

#### Conflict Resolution Model
The synchronization engine uses a **version-based rejection model** (optimistic concurrency control):
- The server does not silently or unpredictably merge conflicting payload fields.
- When an inbound change has `clientVersion < serverVersion`, the mutation is omitted from `accepted` and a conflict entry is appended to the response (`reason: "VERSION_MISMATCH"`, `clientVersion`, `serverVersion`, `serverPayload`). That is the only conflict this path produces, and the only reason string that exists.
- `clientVersion == serverVersion` is **accepted**. The comparison is deliberately strict-less-than: a push whose response was lost is re-sent at the number it already got, and refusing that would report a conflict over a change the log already holds. Nothing on the request distinguishes such a retry from two devices that edited from the same version, so a concurrent pair both lands and resolves by cursor order — the later row wins, and the author whose write was overwritten gets no error. They discover it on the next pull, when the winner arrives and rewrites their local copy.
- The client application is responsible for what it does with a refusal. The shipped Flutter client keeps the queued change, says which note lost, and reloads the open editor over the winner so the discarded text cannot be typed over and re-pushed. **There is no merge on either side:** nothing in either repository performs a 3-way merge or per-field resolution, and every payload on the log is one device's whole document. (An earlier version of this section listed merging as an option; no code has ever done it, and the `ConflictResolverService` that would have was deleted rather than wired.)
- For `vault_item` the blob is opaque, so there is nothing to merge: the losing write is reported as a conflict and the client applies remote blobs by version order.

#### `SyncGateway` (`src/sync/sync.gateway.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `handleConnection(client: Socket)` | Validates JWT token from handshake auth header and joins socket to `user:<userId>` room. | Socket.io WebSocket Gateway |
| `handleDisconnect(client: Socket)` | Cleans up socket connection on disconnect. | Socket.io WebSocket Gateway |
| `notifySyncInvalidation(userId: string, deviceId: string, highestCursor: string)` | Emits `sync:invalidation` payload to room `user:<userId>` excluding originating device ID. | `SyncService.pushChanges` |

---

### 5. `NotesModule` (`src/notes`)
Manages rich-text notes, automated version history snapshots, folders with cycle prevention, and custom tags.

#### `NotesService` (`src/notes/services/notes.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `createNote(userId: string, dto: CreateNoteDto): Promise<NoteDto>` | Creates note, associates tags, creates initial `NoteHistory` version snapshot, and records sync `Change` delta. | `NotesController.createNote` (`POST /notes`) |
| `getNotes(userId: string, query: QueryNotesDto): Promise<PaginatedNotesDto>` | Queries notes with pagination, search filter (`contains` insensitive), folder ID, tag ID, pinned, and archived filters. | `NotesController.getNotes` (`GET /notes`) |
| `getNoteById(userId: string, noteId: string): Promise<NoteDto>` | Fetches single note by ID with attached tags and history count. | `NotesController.getNoteById` (`GET /notes/:id`) |
| `updateNote(userId: string, noteId: string, dto: UpdateNoteDto): Promise<NoteDto>` | Updates note content/title, creates automatic `NoteHistory` version snapshot when content changes, and records `Change` delta. | `NotesController.updateNote` (`PUT /notes/:id`) |
| `deleteNote(userId: string, noteId: string): Promise<{ success: boolean }>` | Soft-deletes note (`deletedAt = now()`) and records sync `DELETE` change event. | `NotesController.deleteNote` (`DELETE /notes/:id`) |
| `restoreNoteVersion(userId: string, noteId: string, historyId: string): Promise<NoteDto>` | Restores note content to a historical snapshot and creates `RESTORE` sync change delta. | `NotesController.restoreNoteVersion` (`POST /notes/:id/versions/:historyId/restore`) |
| `getNoteHistory(userId: string, noteId: string): Promise<NoteHistoryDto[]>` | Lists all historical version snapshots recorded for a specific note. | `NotesController.getNoteHistory` (`GET /notes/:id/versions`) |

#### `FoldersService` (`src/notes/services/folders.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `createFolder(userId: string, dto: CreateFolderDto): Promise<FolderDto>` | Creates folder record after validating parent folder existence. | `FoldersController.createFolder` (`POST /folders`) |
| `getFolders(userId: string): Promise<FolderTreeDto[]>` | Retrieves user folders and formats nested tree structure. | `FoldersController.getFolders` (`GET /folders`) |
| `getFolderById(userId: string, folderId: string): Promise<FolderDto>` | Retrieves single folder details by ID. | `FoldersController.getFolderById` (`GET /folders/:id`) |
| `updateFolder(userId: string, folderId: string, dto: UpdateFolderDto): Promise<FolderDto>` | Updates folder title/color and executes ancestor chain traversal to prevent cyclic parent assignment. | `FoldersController.updateFolder` (`PUT /folders/:id`) |
| `deleteFolder(userId: string, folderId: string): Promise<{ success: boolean }>` | Soft-deletes folder (`deletedAt = now()`). Foreign key constraint prevents deletion if active subfolders exist (`Restrict`). | `FoldersController.deleteFolder` (`DELETE /folders/:id`) |

#### `TagsService` (`src/notes/services/tags.service.ts`)
- `createTag(userId: string, dto: CreateTagDto)` -> Creates custom tag record in DB.
- `getTags(userId: string)` -> Lists user tags.
- `updateTag(userId: string, tagId: string, dto: UpdateTagDto)` -> Updates tag name/color.
- `deleteTag(userId: string, tagId: string)` -> Deletes tag record.

---

### 6. `TasksModule` (`src/tasks`)
Manages task projects, section columns, subtasks with cycle prevention, recurrence engine (RRULE), and reminders.

#### `TasksService` (`src/tasks/services/tasks.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `createTask(userId: string, dto: CreateTaskDto): Promise<TaskDto>` | Validates project/parent, creates task with priority and due date, records `CREATE` sync delta. | `TasksController.createTask` (`POST /tasks`) |
| `getTasks(userId: string, query: QueryTasksDto): Promise<PaginatedTasksDto>` | Retrieves paginated tasks filtered by project, section, priority, status, completion status, due before/after dates. | `TasksController.getTasks` (`GET /tasks`) |
| `getTaskById(userId: string, taskId: string): Promise<TaskDto>` | Retrieves task by ID with subtasks, tags, and reminders. | `TasksController.getTaskById` (`GET /tasks/:id`) |
| `updateTask(userId: string, taskId: string, dto: UpdateTaskDto): Promise<TaskDto>` | Updates task properties, executes ancestor traversal preventing parentId cycles, records `UPDATE` sync delta. | `TasksController.updateTask` (`PUT /tasks/:id`) |
| `completeTask(userId: string, taskId: string): Promise<{ completedTask: TaskDto, nextRecurringTask: TaskDto \| null }>` | Marks task completed (setting `status = COMPLETED` and `completedAt = now()`), calculates next due date via RRULE string parsing, automatically provisions next recurring task instance if applicable. | `TasksController.completeTask` (`POST /tasks/:id/complete`) |
| `deleteTask(userId: string, taskId: string): Promise<{ success: boolean }>` | Soft-deletes task (`deletedAt = now()`) and records `DELETE` sync delta. | `TasksController.deleteTask` (`DELETE /tasks/:id`) |

#### `ProjectsService` (`src/tasks/services/projects.service.ts`)
- `createProject(userId, dto)` -> Creates project and default section columns.
- `getProjects(userId)` -> Lists active user projects.
- `getProjectById(userId, projectId)` -> Fetches project by ID.
- `updateProject(userId, projectId, dto)` -> Updates project details.
- `deleteProject(userId, projectId)` -> Soft-deletes project and cascades tasks.

#### `RemindersService` (`src/tasks/services/reminders.service.ts`)
- `createReminder(userId, dto)` -> Provisions notification reminder for a task.
- `getReminders(userId)` -> Lists upcoming reminders.
- `deleteReminder(userId, reminderId)` -> Deletes task reminder.

---

### 7. `CalendarModule` (`src/calendar`)
Manages calendars, timed/all-day events, date-range window queries, and attendee RSVP tracking.

#### `CalendarsService` (`src/calendar/services/calendars.service.ts`)
- `createCalendar(userId, dto)` -> Creates a new custom calendar.
- `getCalendars(userId)` -> Lists user calendars (auto-creating primary calendar if missing).
- `updateCalendar(userId, calendarId, dto)` -> Updates calendar title, color, or timezone.
- `deleteCalendar(userId, calendarId)` -> Deletes non-primary calendar.

#### `EventsService` (`src/calendar/services/events.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `createEvent(userId: string, dto: CreateEventDto): Promise<EventDto>` | Creates event on primary/specified calendar, handles all-day flags, RRULE, and provisions attendees. | `EventsController.createEvent` (`POST /events`) |
| `getEvents(userId: string, query: QueryEventsDto): Promise<EventDto[]>` | Queries events matching overlapping date-range window (`startFrom` <= event.end AND `startTo` >= event.start). | `EventsController.getEvents` (`GET /events`) |
| `getEventById(userId: string, eventId: string): Promise<EventDto>` | Retrieves single event details with attendees. | `EventsController.getEventById` (`GET /events/:id`) |
| `updateEvent(userId: string, eventId: string, dto: UpdateEventDto): Promise<EventDto>` | Updates event time/title/location and notifies attendees. | `EventsController.updateEvent` (`PUT /events/:id`) |
| `deleteEvent(userId: string, eventId: string): Promise<{ success: boolean }>` | Soft-deletes calendar event (`deletedAt = now()`). | `EventsController.deleteEvent` (`DELETE /events/:id`) |
| `respondToEvent(userId: string, eventId: string, response: RsvpStatus): Promise<EventAttendeeDto>` | Updates attendee RSVP status (`ACCEPTED`, `DECLINED`, `TENTATIVE`). | `EventsController.respondToEvent` (`POST /events/:id/rsvp`) |

---

### 8. `VaultModule` (`src/vault`)
Master-key *management* only. The module owns the salt, the Argon2id verifier, and the recovery material; it never sees plaintext entry content and never stores an entry.

> [!IMPORTANT]
> Not zero-knowledge. `VaultSetting.recoveryKey` is stored in plaintext beside `wrappedMasterKey` so a forgotten master password can be recovered instead of destroying the vault. Database read access therefore equals vault read access.

#### `VaultSettingsService` (`src/vault/services/vault-settings.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `setupVault(userId: string, dto: SetupVaultDto)` | Stores salt + verifier and, optionally, the recovery wrap. Refuses with `409` when a vault is already configured. | `VaultSettingsController.setupVault` (`POST /vault/settings/setup`) |
| `getVaultSettings(userId: string)` | Returns salt and KDF fields; never the stored verifier. | `GET /vault/settings` |
| `unlockVault(userId: string, dto: UnlockVaultDto)` | Compares the client-derived verifier against the stored one. | `POST /vault/settings/unlock` |
| `requestRecoveryOtp(userId: string)` | Issues and emails a 6-digit `VAULT_RECOVERY` code; fails when no wrapped key exists. | `POST /vault/settings/recovery/request` |
| `verifyRecoveryOtp(userId: string, otp: string)` | Spends the code, opens the 15-minute grant window, returns the recovery material. | `POST /vault/settings/recovery/verify` |
| `completeRecovery(userId: string, dto: SetupVaultDto)` | Rotates salt, verifier and recovery wrap, clears the grant, audits `PASSWORD_CHANGED`. | `POST /vault/settings/recovery/complete` |

#### Where the entries live
Vault entries have no service, table, DTO or route in this module. They are `Change` rows with `entityType: "vault_item"` written by `SyncService.pushChanges` and read by `SyncService.pullChanges`; the payload contract is enforced in `src/sync/change-payload.validator.ts`. See `SyncModule` (section 5) and `docs/API_REFERENCE.md` §5 and §9.

---

### 9. `QueuesModule` (`src/queues`)
Background job processing powered by `@nestjs/bull` and Redis queues.

#### Queue Processors (`src/queues/processors/`)

| Processor Class | Method Signature | Job Data Payload | Purpose & Behavior |
|----------------|------------------|------------------|-------------------|
| `MailProcessor` | `handleSendEmail(job: Job<SendMailJobData>)` | `{ to, subject, template, context }` | Dispatches asynchronous emails via `Nodemailer`. |
| `NotificationProcessor` | `handleSendNotification(job: Job<NotificationJobData>)` | `{ userId, channel, title, body }` | Dispatches push notifications / webhooks. |
| `ExportProcessor` | `handleProcessExport(job: Job<ProcessExportJobData>)` | `{ userId, exportType }` | **Stub.** Reads the user row and returns `{ user, exportType, exportedAt }`; it does not gather notes, tasks, events or vault entries, does not upload a bundle and does not email a link. |
| `MaintenanceProcessor` | `handleCleanup(job: Job)` | `{}` | Periodically purges expired sessions and idempotency keys from DB. |

---

### 10. `AuditModule` (`src/common/audit`)
Centralized security SIEM event logging.

#### `AuditLogService` (`src/common/audit/audit-log.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `recordAuditLog(params: RecordAuditLogParams)` | Asynchronously writes security event to DB enriched with IP address, user agent, action type, resource IDs, and `requestId`. | Called across `AuthService`, `UsersService`, `DevicesService`, `VaultSettingsService` |
| `queryLogs(dto: QueryAuditLogsDto): Promise<PaginatedAuditLogsDto>` | Queries security audit logs for administrative SIEM monitoring. | Admin security controllers |

---

### 11. `MetricsModule` (`src/common/metrics`)
Prometheus metrics collection and monitoring.

#### `MetricsService` (`src/common/metrics/metrics.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `getPrometheusMetrics(): Promise<string>` | Formats and returns all registered Prometheus counters, gauges, and latency histograms as text. | `MetricsController.getMetrics` (`GET /metrics`) |
| `recordHttpRequestDuration(method: string, route: string, statusCode: number, durationSeconds: number)` | Observes HTTP request latency distribution histogram (`http_request_duration_seconds`). | `MetricsInterceptor` |
| `incrementSyncPush(count: number)` | Increments push throughput counter (`sync_throughput_pushes_total`). | `SyncService.pushChanges` |
| `incrementSyncPull()` | Increments pull throughput counter (`sync_throughput_pulls_total`). | `SyncService.pullChanges` |
| `updateActiveDbConnections(count: number)` | Updates database active connection count gauge (`database_connections_active`). | `PrismaService` connection listener |

#### `MetricsInterceptor` (`src/common/metrics/metrics.interceptor.ts`)
- `intercept(context: ExecutionContext, next: CallHandler)` -> Measures HTTP request start/finish duration and invokes `metricsService.recordHttpRequestDuration`.

---

### 12. `HealthModule` (`src/health`)
Health check probes and build metadata.

#### `HealthService` (`src/health/health.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `checkHealth(): Promise<HealthCheckResult>` | Executes Terminus health checks against PostgreSQL database and Redis server. | `HealthController.getHealth` (`GET /health`) |
| `checkReadiness(): Promise<HealthCheckResult>` | Verifies system readiness before routing load balancer traffic. | `HealthController.getReadiness` (`GET /health/ready`) |
| `checkLiveness(): { status: string }` | Returns process status `{"status":"ok"}` without executing DB queries. | `HealthController.getLiveness` (`GET /health/live`) |
| `getBuildInfo(): BuildInfoDto` | Returns static build metadata (`name`, `version`, `environment`, `commit`). | `HealthController.getInfo` (`GET /info`) |

#### `HealthController` (`src/health/health.controller.ts`)
- `getHealth()` -> Calls `healthService.checkHealth()`
- `getReadiness()` -> Calls `healthService.checkReadiness()`
- `getLiveness()` -> Calls `healthService.checkLiveness()`
- `getInfo()` -> Calls `healthService.getBuildInfo()`

---

### 13. `PrismaModule` (`src/common/prisma`)
Global database connection lifecycle manager.

#### `PrismaService` (`src/common/prisma/prisma.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `onModuleInit(): Promise<void>` | Establishes PostgreSQL connection pool on startup and configures soft delete middleware. | NestJS lifecycle hook |
| `onModuleDestroy(): Promise<void>` | Gracefully disconnects database connection pool on shutdown. | NestJS lifecycle hook |
| `cleanDatabase(): Promise<void>` | Cleans database tables during integration testing. | Test helper suites |

---

### 14. Cross-Cutting Guards & Interceptors

#### `AllExceptionsFilter` (`src/common/error-handling/filters/all-exceptions.filter.ts`)
- `catch(exception: unknown, host: ArgumentsHost)` -> Catches unhandled exceptions, extracts `X-Request-ID` header, formats flat canonical error envelope `{ statusCode, code, message, requestId, timestamp, path }`, and returns standardized HTTP response.

#### `IdempotencyInterceptor` (`src/common/interceptors/idempotency.interceptor.ts`)
- `intercept(context: ExecutionContext, next: CallHandler)` -> Reads `Idempotency-Key` request header for POST requests. Returns cached response if key exists in Redis (24h TTL), otherwise executes request and caches response.

#### `CustomThrottlerGuard` (`src/common/guards/custom-throttler.guard.ts`)
- `static disabledByDefault(env): boolean` -> True when the environment means throttling should stand down: `APP_ENV=development`, `NODE_ENV=test`, `DISABLE_RATE_LIMITING=true` or `RATE_LIMIT_ENABLED=false`. Exposed as a plain function of the env so the rule is testable without an HTTP request.
- `shouldSkip(context: ExecutionContext)` -> Returns `false` (throttle) whenever the limits are active; an explicit `RATE_LIMIT_ENABLED=true` outranks the environment default. When throttling is off, the `x-skip-throttle` / `x-bypass-rate-limit` headers are honoured only if an operator set `RATE_LIMIT_HEADER_BYPASS=true`, and never under `APP_ENV=production` — a request cannot opt itself out.
- `getTracker(req)` -> Throttling bucket key: `user:<id>` once a JWT has been verified, otherwise `ip:<first x-forwarded-for value>`. Authenticated traffic is therefore limited per account, not per shared NAT/proxy address.

#### `JwtAuthGuard` (`src/auth/guards/jwt-auth.guard.ts`)
- `canActivate(context: ExecutionContext)` -> Validates JWT access token in `Authorization: Bearer <token>` header or `refresh_token` cookie.
