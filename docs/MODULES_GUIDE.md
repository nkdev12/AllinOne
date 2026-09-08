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
Engine for delta synchronization, version-based concurrency conflict detection, payload encryption, and real-time WebSocket invalidation.

#### `SyncService` (`src/sync/sync.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `pushChanges(userId: string, dto: PushSyncDto): Promise<PushSyncResponseDto>` | Unconditionally scopes DB queries by `userId`. Detects `VERSION_MISMATCH` concurrency conflicts (rejecting stale changes and returning server payload/version for client resolution), accepts valid changes, creates `Change` records, updates `DeviceSyncState`, and emits WebSocket invalidations. | `SyncController.pushChanges` (`POST /sync/push`) |
| `pullChanges(userId: string, dto: PullSyncDto): Promise<PullSyncResponseDto>` | Pulls change deltas after specified cursor position scoped strictly to `userId`, updates `lastPulledCursor`, and returns paginated result. | `SyncController.pullChanges` (`POST /sync/pull`) |
| `getSyncStatus(userId: string, deviceId: string): Promise<SyncStatusDto>` | Fetches synchronization state, client cursor position, and highest server cursor for a device. | `SyncController.getSyncStatus` (`GET /sync/status/:deviceId`) |

#### Conflict Resolution Model
The synchronization engine uses a **version-based rejection model** (optimistic concurrency control):
- The server does not silently or unpredictably merge conflicting payload fields.
- When an inbound change has `clientVersion < serverVersion`, the mutation is omitted from `accepted` and a conflict entry is appended to the response (`reason: "VERSION_MISMATCH"`, `clientVersion`, `serverVersion`, `serverPayload`).
- The client application is responsible for resolving the conflict (prompting user, performing a 3-way merge, or applying domain-specific heuristics), and then re-submitting with an incremented version.

#### `E2eEncryptionService` (`src/sync/e2e-encryption.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `encryptPayload(payload: any, recipientPublicKey: string): Promise<EncryptedPayload>` | Encrypts entity payload using AES-GCM and wraps symmetric key with RSA public key for client E2EE. | `SyncService` & SDK clients |
| `decryptPayload(encryptedData: EncryptedPayload, recipientPrivateKey: string): Promise<any>` | Decrypts symmetric key using recipient private key and decrypts AES-GCM payload. | `SyncService` & SDK clients |

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
Zero-Knowledge client-side encrypted password manager. Sever stores zero plaintext keys.

#### `VaultSettingsService` (`src/vault/services/vault-settings.service.ts`)
- `getSettings(userId: string): Promise<VaultSettingDto>` -> Fetches master key salt & KDF iteration configuration.
- `upsertSettings(userId: string, dto: UpsertVaultSettingsDto): Promise<VaultSettingDto>` -> Configures salt & KDF iterations.

#### `VaultItemsService` (`src/vault/services/vault-items.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `createItem(userId: string, dto: CreateVaultItemDto): Promise<VaultItemDto>` | Stores client-side encrypted item (`ciphertext`, `iv`, `authTag`) for logins, cards, notes, or identities. | `VaultItemsController.createItem` (`POST /vault/items`) |
| `getItems(userId: string, query: QueryVaultItemsDto): Promise<VaultItemDto[]>` | Lists encrypted vault items filtered by item type (`LOGIN`, `CARD`, `SECURE_NOTE`, `IDENTITY`). | `VaultItemsController.getItems` (`GET /vault/items`) |
| `getItemById(userId: string, itemId: string): Promise<VaultItemDto>` | Retrieves encrypted vault item by ID. | `VaultItemsController.getItemById` (`GET /vault/items/:id`) |
| `updateItem(userId: string, itemId: string, dto: UpdateVaultItemDto): Promise<VaultItemDto>` | Updates encrypted ciphertext and authTag payload. | `VaultItemsController.updateItem` (`PUT /vault/items/:id`) |
| `deleteItem(userId: string, itemId: string): Promise<{ success: boolean }>` | Soft-deletes vault item (`deletedAt = now()`). | `VaultItemsController.deleteItem` (`DELETE /vault/items/:id`) |

---

### 9. `QueuesModule` (`src/queues`)
Background job processing powered by `@nestjs/bull` and Redis queues.

#### Queue Processors (`src/queues/processors/`)

| Processor Class | Method Signature | Job Data Payload | Purpose & Behavior |
|----------------|------------------|------------------|-------------------|
| `MailProcessor` | `handleSendEmail(job: Job<SendMailJobData>)` | `{ to, subject, template, context }` | Dispatches asynchronous emails via `Nodemailer`. |
| `NotificationProcessor` | `handleSendNotification(job: Job<NotificationJobData>)` | `{ userId, channel, title, body }` | Dispatches push notifications / webhooks. |
| `ExportProcessor` | `handleProcessExport(job: Job<ProcessExportJobData>)` | `{ userId, exportType }` | Generates full GDPR JSON data archive, uploads bundle, and emails download link. |
| `MaintenanceProcessor` | `handleCleanup(job: Job)` | `{}` | Periodically purges expired sessions and idempotency keys from DB. |

---

### 10. `AuditModule` (`src/common/audit`)
Centralized security SIEM event logging.

#### `AuditLogService` (`src/common/audit/audit-log.service.ts`)

| Function Signature | Description & Behavior | Invocation Site |
|-------------------|------------------------|-----------------|
| `recordEvent(userId: string \| null, action: AuditAction, req: Request, metadata?: any, resourceType?: string, resourceId?: string): Promise<AuditLog>` | Asynchronously writes security event to DB enriched with IP address, user agent, action type, resource IDs, and `requestId`. | Called across `AuthService`, `UsersService`, `DevicesService`, `VaultItemsService` |
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
- `handleRequest(context: ExecutionContext, limit: number, ttl: number)` -> Enforces rate limits per client IP address.

#### `JwtAuthGuard` (`src/auth/guards/jwt-auth.guard.ts`)
- `canActivate(context: ExecutionContext)` -> Validates JWT access token in `Authorization: Bearer <token>` header or `refresh_token` cookie.
