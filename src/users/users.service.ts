import {
  Injectable,
  ConflictException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { escapeRegex } from "@/common/utils/regex";
import { badRequest } from "@/common/errors/http-errors";
import { ErrorCode } from "@/common/errors/error-code";
import { deleteAccountData } from "@/export/account-erasure";
import { FINANCE_TENANCY } from "@/export/user-data.collections";
import {
  EXPORT_FORMAT,
  writeDataExport,
  type DataExportSummary,
} from "@/export/data-export.builder";
import {
  AuditAction,
  ChangeOperation,
  Prisma,
  User,
  UserStatus,
} from "@prisma/client";
import { appendChange } from "@/sync/change-cursor";
import { UpdateUserProfileDto } from "./dto/update-user-profile.dto";
import { DeleteAccountDto } from "./dto/delete-account.dto";

// Friend-picker bounds. A two-character prefix left directory enumeration just
// a handful of requests away; see `suggestAccounts` for why the cap is here too.
const SUGGESTION_MIN_TERM = 3;
const SUGGESTION_LIMIT = 8;

/**
 * How long a completed export counts as "the copy this account was handed" for
 * the purposes of the deletion guard.
 *
 * The guard exists so an erasure cannot be followed by "wait, I wanted my data",
 * and a proof from last year answers that question no better than no proof at
 * all: everything written since the bundle was made would be erased with no copy
 * anywhere. A day is long enough to finish the two-call flow a real client makes
 * — download the bundle, confirm, delete — on a phone that dropped its connection
 * in between, and short enough that an old bundle is not mistaken for a current
 * one.
 */
const EXPORT_PROOF_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Why a `$transaction` can fail here in a way that is not anybody's mistake.
 *
 * The MongoDB connector only supports transactions against a replica set, and the
 * URI this repo shipped in `.env.example` pointed at a standalone `mongod`, so a
 * cascade that needs one cannot be *relied on* to run in one. Rather than
 * pretending the delete succeeded or demanding the deployment change, the erasure
 * tries the transaction and degrades to the same steps in sequence. That is safe
 * because each step is idempotent — `updateMany` writing a `revokedAt`, a
 * tombstone, a `deleteMany` — so a retry finishes what a half-applied pass left
 * instead of compounding it. Everything else rethrows: a genuine query error is
 * not a topology problem, and running the cascade twice would not fix it.
 *
 * The wider flag stands: this file is one of 14 `$transaction` sites in `src/`,
 * and none of them work on a standalone mongod either.
 */
function isUnusableTransaction(error: any): boolean {
  if (error?.code === "P2004") return true;
  const message = String(error?.message ?? "");
  return /replica set|multi-document transaction|transactions are (not|never) enabled|cannot start a transaction|current mongod (operation|mode)/i.test(
    message,
  );
}

/**
 * What the socket sweep in `src/sync/sync.gateway.ts` needs to know about one
 * account, in the shape a batch can answer it.
 */
export interface SocketAccessState {
  /** Still a row, still `ACTIVE`, still not deleted — as `JwtStrategy` asks it. */
  readonly accountReadable: boolean;
  /** Session ids that exist and carry no `revokedAt`. */
  readonly liveSessionIds: readonly string[];
  /** Device ids that were revoked, so a socket named for one is not admitted. */
  readonly revokedDeviceIds: readonly string[];
}

/** What one pass of the erasure removed, before it is reported to the caller. */
interface ErasureOutcome {
  tombstoned: number;
  highestCursor?: bigint;
  erased: Record<string, number>;
}

/**
 * `DELETE /users/me`'s answer.
 *
 * The counts travel back because an erasure that reports only `{ success: true }`
 * asks the caller to take a cascade of fifteen deletes on faith, and the number of
 * `change` rows removed is the one figure an operator is going to want when somebody
 * asks how their notes vanished.
 */
export interface AccountDeletionResult {
  success: boolean;
  /** Whether the cascade ran as one transaction or as the sequential degrade. */
  mode: "transaction" | "sequential";
  /** Rows removed per collection, from the same list the export streams. */
  erased: Record<string, number>;
  financeTombstoned: number;
  /** A completed export inside `EXPORT_PROOF_WINDOW_MS` authorised this. */
  exportProof: boolean;
  /** The caller's own acknowledgement that it is deleting without a copy. */
  exportSkipped: boolean;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Prisma on MongoDB does not match documents whose field is absent, so a
  // `deletedAt: null` filter would hide every user created before the field
  // existed. Filter in code instead.
  private notDeleted(user: User | null): User | null {
    return user && !user.deletedAt ? user : null;
  }

  async getUserById(userId: string): Promise<User | null> {
    return this.notDeleted(
      await this.prisma.user.findFirst({ where: { id: userId } }),
    );
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.notDeleted(
      await this.prisma.user.findFirst({
        where: { email: email.toLowerCase() },
      }),
    );
  }

  /**
   * A deliberately small, authenticated directory for finance-group friend
   * selection: an id to put in the group's `members` and the label to render
   * beside it. Nothing else.
   *
   * It used to return `email` as well, which let any authenticated account page
   * through the whole user directory alphabet by alphabet — display names are
   * still enumerable that way, so the projection is now the smaller one and
   * email is not even matched on: a `where` on email would stay an existence
   * oracle for addresses even when the address is not echoed back.
   *
   * Narrowing results to accounts the caller already shares money with is not
   * cheap here: a group's members are an unindexed `Json` array on
   * `FinanceGroup` (`prisma/schema.prisma`), not a join table, so the scope
   * would be a scan of every group — and it would defeat the endpoint's purpose,
   * which is to find someone you have not shared a group with yet. So the
   * mitigation stays blunt: `SUGGESTION_MIN_TERM` characters minimum and
   * `SUGGESTION_LIMIT` rows maximum per request.
   */
  async suggestAccounts(userId: string, query: string) {
    const term = query.trim();
    if (term.length < SUGGESTION_MIN_TERM) return [];
    const users = await this.prisma.user.findMany({
      where: {
        id: { not: userId },
        status: UserStatus.ACTIVE,
        displayName: { contains: escapeRegex(term), mode: "insensitive" },
      },
      // Over-fetch, then trim in code: a tombstoned account must not be able to
      // occupy a slot in someone else's friend list (see `notDeleted`).
      select: { id: true, displayName: true, deletedAt: true },
      take: SUGGESTION_LIMIT * 2,
      orderBy: { displayName: "asc" },
    });
    return users
      .filter((user) => !user.deletedAt)
      .slice(0, SUGGESTION_LIMIT)
      .map((user) => ({
        id: user.id,
        // `displayName` is nullable, and a picker row with no label is unusable;
        // the id is the only other thing this endpoint already hands out.
        displayName: user.displayName ?? user.id,
      }));
  }

  async createUser(data: {
    email: string;
    displayName?: string;
    locale?: string;
    timezone?: string;
  }): Promise<User> {
    const existing = await this.findByEmail(data.email);
    if (existing) {
      throw new ConflictException("User with this email already exists");
    }

    return this.prisma.user.create({
      data: {
        email: data.email.toLowerCase(),
        displayName: data.displayName,
        locale: data.locale || "en-US",
        timezone: data.timezone || "UTC",
      },
    });
  }

  async updateProfile(
    userId: string,
    dto: UpdateUserProfileDto,
  ): Promise<User> {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new NotFoundException("User profile not found");
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.displayName !== undefined
          ? { displayName: dto.displayName }
          : {}),
        ...(dto.avatar !== undefined ? { avatar: dto.avatar } : {}),
        ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
      },
    });
  }

  /**
   * Erases an account: its content, its grants, its vault row, its change log and
   * its sync state, after the caller has either been handed a copy of it or has
   * said in as many words that they do not want one.
   *
   * This used to be `softDeleteAccount`, and it used to tombstone the user row,
   * the sessions, the devices and the finance tables and stop there. Everything
   * else outlived the account with no `deleteMany` anywhere — `Note`, `Task`,
   * `Event`, `Folder`, `Tag`, `VaultSetting`, the shares, and `Change`, whose
   * `payload` column is plaintext note, task and event content and, for
   * `vault_item` rows, the sealed blobs that are the vault's only server-side copy.
   * A deleted account was therefore a name removal, not an erasure, which is the
   * opposite of what a GDPR erasure request means. `prisma/schema.prisma` declares
   * no `@relation` on `Change.userId`, so nothing in the database cascaded it: that
   * is why the plaintext survived, and deleting it here in code is the fix.
   *
   * The order is deliberate — export, then delete. `deleteAccountData` walks the
   * same `USER_DATA_COLLECTIONS` list `writeDataExport` streams, so a row cannot be
   * removed without having been offered, and `src/users/account-erasure.spec.ts`
   * proves that operationally instead of by inspection.
   */
  async deleteAccount(
    userId: string,
    dto: DeleteAccountDto,
  ): Promise<AccountDeletionResult> {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new NotFoundException("User profile not found");
    }

    const proof = dto.skipExport ? null : await this.findExportProof(userId);
    if (!dto.skipExport && !proof) {
      // A policy refusal, not a shape error, but the client's fix is one of two
      // boring next steps and both belong in the message: ask for the bundle, or
      // say out loud that skipping it is what this account wants.
      throw badRequest(
        ErrorCode.VALIDATION_ERROR,
        "Deletion needs a copy first: request the export (POST /users/me/export) and delete again, or send skipExport: true to erase this account without one.",
        { field: "skipExport" },
      );
    }

    const deletedAt = new Date();
    const started = Date.now();

    const steps = async (
      client: Prisma.TransactionClient,
    ): Promise<ErasureOutcome> => {
      await client.user.update({
        where: { id: userId },
        data: { status: UserStatus.DELETED, deletedAt },
      });

      await client.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await client.device.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const { tombstoned, highestCursor } = await this.tombstoneFinanceRows(
        client,
        userId,
        deletedAt,
      );

      // Last, so the oplog outlives every row it describes for the whole pass and
      // the finance tombstones appended just above are erased along with the log
      // they were written to — which is correct here: the account they belonged to
      // has no device left to be told.
      const erased = await deleteAccountData(client, userId);

      return { tombstoned, highestCursor, erased };
    };

    let outcome: ErasureOutcome;
    let mode: AccountDeletionResult["mode"];

    try {
      outcome = await this.prisma.$transaction((tx) => steps(tx));
      mode = "transaction";
    } catch (error: any) {
      if (!isUnusableTransaction(error)) throw error;

      this.logger.warn(
        `Account ${userId}: this deployment cannot run a multi-collection transaction (a standalone mongod), so the erasure is running as sequential idempotent deletes. A failure halfway leaves rows still to remove; re-issuing the delete finishes them.`,
      );
      outcome = await steps(this.prisma);
      mode = "sequential";
    }

    if (outcome.tombstoned > 0) {
      this.logger.log(
        `Account ${userId} deleted: ${outcome.tombstoned} finance row(s) tombstoned, change log now at cursor ${outcome.highestCursor?.toString() ?? "0"}.`,
      );
    }

    const erasedRows = Object.values(outcome.erased).reduce(
      (total, count) => total + count,
      0,
    );
    this.logger.log(
      `Account ${userId} erased: ${erasedRows} content row(s) removed, ${outcome.tombstoned} finance row(s) tombstoned (mode ${mode}, ${Date.now() - started}ms, export proof ${proof ? "yes" : "skipped by caller"}).`,
    );

    await this.recordAudit(userId, AuditAction.ACCOUNT_DELETED, {
      mode,
      erased: outcome.erased,
      erasedRows,
      financeTombstoned: outcome.tombstoned,
      exportProof: Boolean(proof),
      exportSkipped: dto.skipExport,
    });

    return {
      success: true,
      mode,
      erased: outcome.erased,
      financeTombstoned: outcome.tombstoned,
      exportProof: Boolean(proof),
      exportSkipped: dto.skipExport,
    };
  }

  /**
   * The newest completed export of this account, if one is recent enough to stand
   * as "this account was handed its copy".
   *
   * An `AuditLog` row is what the export writes (`recordExportProof`), so the
   * evidence lives in the same store as the data being erased and survives into the
   * deletion's own audit row. There is no `Export` model in
   * `prisma/schema.prisma`, and inventing one is the schema owner's decision, not a
   * question this route should answer by keeping state in process memory.
   */
  private async findExportProof(
    userId: string,
  ): Promise<{ id: string } | null> {
    const row = await this.prisma.auditLog.findFirst({
      where: {
        userId,
        action: AuditAction.ACCOUNT_EXPORTED,
        createdAt: { gte: new Date(Date.now() - EXPORT_PROOF_WINDOW_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    return row ? { id: row.id } : null;
  }

  private async recordAudit(
    userId: string,
    action: AuditAction,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId,
          action,
          resourceType: "account",
          metadata: metadata as Prisma.InputJsonValue,
        },
      });
    } catch (error: any) {
      // Never fail the erasure over its receipt: the rows are already gone, and a
      // retry that found nothing to delete would look like a success either way.
      this.logger.error(
        `Account ${userId}: audit row '${action}' could not be written: ${error?.message ?? error}`,
      );
    }
  }

  /**
   * Streams this account's own data as an NDJSON bundle and records that it was
   * handed over.
   *
   * `POST /users/me/export` used to log that a request had been made and deliver
   * nothing: no job reached the `export` queue (`QueuesModule`, which owns
   * `BullModule.forRoot`, is imported only by `WorkerModule`, so this process has
   * no registry to enqueue into), and the consumer that would have read it,
   * `ExportProcessor`, returned `{ user, exportType, exportedAt }` — a bundle with
   * no content in it under any of its four `exportType` values. The asymmetry that
   * left was the one a data-portability request exists to close: deletion gave no
   * copy while retention kept no limit.
   *
   * So the copy is assembled and written here, through `writeDataExport`, which
   * pages every collection the erasure can remove — plus the finance tables, which
   * the request path used not to reach at all. Paging is what makes answering on the
   * request path honest rather than hopeful: no query reads a whole library, and the
   * response is streamed line by line instead of buffered as one object.
   *
   * Delivery to the caller is the HTTP response itself (`UsersController` pipes
   * these lines into it), which needs no artifact store; this repo has no object
   * storage client, only the `OBJECT_STORAGE_BUCKET` name a config getter reads.
   */
  async exportAccount(
    userId: string,
    writeLine: (line: string) => void,
  ): Promise<DataExportSummary> {
    // Read the row directly rather than through `getUserById`: an account that has
    // already been tombstoned mid-erasure is still entitled to its own copy, and a
    // request for it must not be answered with a 404 that hides the data behind a
    // status column.
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException("User profile not found");
    }

    const summary = await writeDataExport(this.prisma, userId, writeLine);

    await this.recordAudit(userId, AuditAction.ACCOUNT_EXPORTED, {
      format: EXPORT_FORMAT,
      records: summary.records,
      collections: summary.collections,
      redacted: summary.redacted.map((entry) => ({
        collection: entry.collection,
        fields: entry.fields,
      })),
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
    });

    this.logger.log(
      `Data export delivered for user ${userId}: ${summary.records} record(s) across ${Object.keys(summary.collections).length} collection(s).`,
    );

    return summary;
  }

  /**
   * Tombstones every finance row the account owns and logs a DELETE for each.
   *
   * Deletion used to touch `user`, `session` and `device` only, which left the
   * whole `Finance*` half of the document store behind: accounts, transactions
   * with their titles and notes, budgets, goals, recurring rules, loans, groups,
   * shared expenses, settlements and trips all kept a deleted account's
   * financial history readable by `userId`, and the `Change` oplog kept the
   * plaintext payloads that history is made of. That is exactly the data a
   * GDPR erasure request is about.
   *
   * The rows are tombstoned rather than removed, following the convention every
   * finance service already uses (`deletedAt` plus a `version` bump): a row that
   * simply vanished would leave the devices still holding a checkpoint for this
   * account with a copy nobody can tell them to drop. The `Change` rows are what
   * tells them, so they are appended in the same transaction — a tombstone the
   * log never mentions is a delete that never propagates.
   *
   * Not touched, on purpose:
   * - `FinanceExpenseShare` — the row has no `deletedAt` and no `version`, so
   *   tombstoning it would mean inventing a column, and a hard delete would take
   *   a settlement fact from the group that is still alive.
   * - `FinanceTripItinerary` — keyed only by `tripId`; it goes with its trip,
   *   which is handled here by resolving the account's trips first.
   * - Rows another account owns that merely *name* this one (a shared expense in
   *   somebody else's group where this user paid). Erasing those silently would
   *   rewrite another user's split, so they stay and are reported.
   */
  private async tombstoneFinanceRows(
    tx: Prisma.TransactionClient,
    userId: string,
    deletedAt: Date,
  ): Promise<{ tombstoned: number; highestCursor?: bigint }> {
    let tombstoned = 0;
    let highestCursor: bigint | undefined;

    for (const table of FINANCE_TENANCY) {
      const delegate = (tx as any)[table.delegate];
      if (!delegate) continue;

      const where =
        table.ownerFields.length === 1
          ? { [table.ownerFields[0]]: userId }
          : { OR: table.ownerFields.map((field) => ({ [field]: userId })) };

      const rows: any[] = await delegate.findMany({ where });

      for (const row of rows) {
        // Filtered in code, not in the query: MongoDB need not match a
        // `deletedAt: null` predicate against a document written before the
        // field existed, which is most of them.
        if (row.deletedAt) continue;

        const updated = await delegate.update({
          where: { id: row.id },
          data: { deletedAt, version: { increment: 1 } },
        });

        const logged = await appendChange(tx, {
          userId,
          entityType: table.entityType,
          entityId: row.id,
          operation: ChangeOperation.DELETE,
          version: updated.version,
          payload: {},
        });
        highestCursor = logged.cursor;
        tombstoned += 1;
      }
    }

    const tripIds: string[] = (
      await (tx as any).financeTrip.findMany({
        where: { ownerId: userId },
        select: { id: true },
      })
    ).map((trip: any) => trip.id);

    if (tripIds.length > 0) {
      const itineraryDelegate = (tx as any).financeTripItinerary;
      const itineraries: any[] = await itineraryDelegate.findMany({
        where: { tripId: { in: tripIds } },
      });

      for (const item of itineraries) {
        if (item.deletedAt) continue;
        const updated = await (tx as any).financeTripItinerary.update({
          where: { id: item.id },
          data: { deletedAt, version: { increment: 1 } },
        });

        const logged = await appendChange(tx, {
          userId,
          entityType: "finance_trip_itinerary",
          entityId: item.id,
          operation: ChangeOperation.DELETE,
          version: updated.version,
          payload: {},
        });
        highestCursor = logged.cursor;
        tombstoned += 1;
      }
    }

    return { tombstoned, highestCursor };
  }

  async getUserSessions(userId: string) {
    return this.prisma.session.findMany({
      where: {
        userId,
        revokedAt: null,
        refreshExpiresAt: {
          gt: new Date(),
        },
      },
      include: {
        device: {
          select: {
            id: true,
            name: true,
            platform: true,
            appVersion: true,
          },
        },
      },
      orderBy: {
        lastActivityAt: "desc",
      },
    });
  }

  /**
   * Whether the session a token names is still live.
   *
   * Read without a `revokedAt: null` filter on purpose: this runs on every
   * authenticated request, and a filter that fails to match a document (which
   * MongoDB makes possible when the field was never written) would log people
   * out of a session that was never revoked. Absent, null and unset are all
   * "not revoked" here; only a real timestamp means stop.
   */
  async isSessionLive(userId: string, sessionId: string): Promise<boolean> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId },
    });

    return Boolean(session && !session.revokedAt);
  }

  /**
   * The same three questions `isSessionLive` and `JwtStrategy.validate()` ask,
   * answered for a whole set of accounts in three queries instead of three per
   * account.
   *
   * `SyncGateway` re-asks liveness on a timer for every socket it holds
   * (`src/sync/sync.gateway.ts`), because a handshake check alone means a revoked
   * session keeps its room subscription — and so keeps receiving this account's
   * `sync:invalidation` payloads, whose cursor tells a device when to come pull —
   * until the token happens to expire. One round-trip per socket per sweep is how
   * a liveness check turns into a denial of service the deployment inflict on
   * itself; grouping by distinct `userId` is what makes the cost a function of the
   * number of accounts connected rather than the number of devices.
   *
   * Sessions and devices are read with no `revokedAt` predicate for the reason
   * `isSessionLive` gives: absent, null and unset are all "not revoked" here, and a
   * filter that can miss a document would evict a healthy socket. Revocation is
   * decided in code, from the field's value.
   *
   * Every id asked for is present in the result; an account whose row could not be
   * found comes back `accountReadable: false`, which is the answer a sweep wants
   * rather than a gap it has to interpret.
   */
  async getSocketAccessStates(
    userIds: readonly string[],
  ): Promise<Map<string, SocketAccessState>> {
    const states = new Map<string, SocketAccessState>();
    if (userIds.length === 0) return states;

    for (const userId of userIds) {
      states.set(userId, {
        accountReadable: false,
        liveSessionIds: [],
        revokedDeviceIds: [],
      });
    }

    const [users, sessions, devices] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: [...userIds] } },
        select: { id: true, status: true, deletedAt: true },
      }),
      this.prisma.session.findMany({
        where: { userId: { in: [...userIds] } },
        select: { id: true, userId: true, revokedAt: true },
      }),
      this.prisma.device.findMany({
        where: { userId: { in: [...userIds] } },
        select: { id: true, userId: true, revokedAt: true },
      }),
    ]);

    for (const user of users) {
      states.set(user.id, {
        accountReadable: user.status === UserStatus.ACTIVE && !user.deletedAt,
        liveSessionIds: [],
        revokedDeviceIds: [],
      });
    }

    const live = new Map<string, string[]>();
    for (const session of sessions) {
      if (session.revokedAt) continue;
      const ids = live.get(session.userId) ?? [];
      ids.push(session.id);
      live.set(session.userId, ids);
    }

    const revokedDevices = new Map<string, string[]>();
    for (const device of devices) {
      if (!device.revokedAt) continue;
      const ids = revokedDevices.get(device.userId) ?? [];
      ids.push(device.id);
      revokedDevices.set(device.userId, ids);
    }

    for (const [userId, state] of states) {
      states.set(userId, {
        ...state,
        liveSessionIds: live.get(userId) ?? [],
        revokedDeviceIds: revokedDevices.get(userId) ?? [],
      });
    }

    return states;
  }

  async revokeUserSession(
    userId: string,
    sessionId: string,
  ): Promise<{ success: boolean }> {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
      },
    });

    if (!session) {
      throw new NotFoundException("Active session not found");
    }

    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });

    return { success: true };
  }

  sanitizeUser(user: User) {
    const { ...sanitized } = user;
    return sanitized;
  }
}
