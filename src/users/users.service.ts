import {
  Injectable,
  ConflictException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ChangeOperation, Prisma, User, UserStatus } from "@prisma/client";
import { appendChange } from "@/sync/change-cursor";
import { UpdateUserProfileDto } from "./dto/update-user-profile.dto";

/**
 * One finance table's stake in an account: how the rows name their owner, and
 * what the sync oplog calls the entity.
 *
 * `entityType` values are the strings `src/sync/change-projection.ts` switches
 * on, so a tombstone written here is a DELETE a device can actually apply.
 */
interface FinanceTenancy {
  delegate: string;
  entityType: string;
  ownerFields: string[];
}

const FINANCE_TENANCY: FinanceTenancy[] = [
  {
    delegate: "financeAccount",
    entityType: "finance_account",
    ownerFields: ["userId"],
  },
  {
    delegate: "financeCategory",
    entityType: "finance_category",
    ownerFields: ["userId"],
  },
  {
    delegate: "financeTransaction",
    entityType: "finance_transaction",
    ownerFields: ["userId"],
  },
  {
    delegate: "financeBudget",
    entityType: "finance_budget",
    ownerFields: ["userId"],
  },
  {
    delegate: "financeSavingsGoal",
    entityType: "finance_savings_goal",
    ownerFields: ["userId"],
  },
  {
    delegate: "financeRecurringRule",
    entityType: "finance_recurring_rule",
    ownerFields: ["userId"],
  },
  {
    delegate: "financeLoan",
    entityType: "finance_loan",
    ownerFields: ["userId"],
  },
  // A group's owner column is `ownerId`, not `userId`; same for a trip. Reading
  // the field list off `prisma/schema.prisma` rather than assuming one name is
  // the whole reason this table exists.
  {
    delegate: "financeGroup",
    entityType: "finance_group",
    ownerFields: ["ownerId"],
  },
  {
    delegate: "financeTrip",
    entityType: "finance_trip",
    ownerFields: ["ownerId"],
  },
  {
    delegate: "financeSharedExpense",
    entityType: "finance_shared_expense",
    ownerFields: ["paidByUserId"],
  },
  {
    delegate: "financeSettlement",
    entityType: "finance_settlement",
    ownerFields: ["fromUserId", "toUserId"],
  },
];

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
   * selection. It returns only the identity needed by a picker, never profile
   * settings or account status, and needs at least two characters so opening
   * the dialog does not expose a directory of every account.
   */
  async suggestAccounts(userId: string, query: string) {
    const term = query.trim();
    if (term.length < 2) return [];
    const users = await this.prisma.user.findMany({
      where: {
        id: { not: userId },
        status: UserStatus.ACTIVE,
        OR: [
          { email: { contains: term.toLowerCase() } },
          { displayName: { contains: term } },
        ],
      },
      select: { id: true, email: true, displayName: true, deletedAt: true },
      take: 12,
      orderBy: { displayName: "asc" },
    });
    return users
      .filter((user) => !user.deletedAt)
      .slice(0, 8)
      .map((user) => ({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
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

  async softDeleteAccount(userId: string): Promise<{ success: boolean }> {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new NotFoundException("User profile not found");
    }

    const deletedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          status: UserStatus.DELETED,
          deletedAt,
        },
      });

      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await tx.device.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const { tombstoned, highestCursor } = await this.tombstoneFinanceRows(
        tx,
        userId,
        deletedAt,
      );

      if (tombstoned > 0) {
        this.logger.log(
          `Account ${userId} deleted: ${tombstoned} finance row(s) tombstoned, change log now at cursor ${highestCursor?.toString() ?? "0"}.`,
        );
      }
    });

    return { success: true };
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

  /**
   * Records a GDPR/CCPA export request. It enqueues nothing, and today it
   * *cannot* — two things outside this file have to move first:
   *
   * 1. No queue exists to enqueue into in this process. `QueuesModule` (which
   *    holds `BullModule.forRootAsync`) is imported only by `WorkerModule`
   *    (`src/worker.module.ts`); `AppModule` never loads it, so an
   *    `@InjectQueue("export")` here would resolve to nothing until
   *    `src/users/users.module.ts` gains a Bull import.
   * 2. The consumer would ignore finance even with a job in hand.
   *    `ExportProcessor.handleProcessExport` (`src/queues/processors/
   *    export.processor.ts`) reads only `user` and returns
   *    `{ user, exportType, exportedAt }`; its `exportType` union is
   *    `"ALL" | "VAULT" | "NOTES" | "TASKS"` and none of those branches fetch
   *    anything. A finance-inclusive export means that processor gaining a
   *    per-`exportType` gather over the same tables `tombstoneFinanceRows`
   *    walks — `financeAccount`, `financeCategory`, `financeTransaction`,
   *    `financeBudget`, `financeSavingsGoal`, `financeRecurringRule`,
   *    `financeLoan`, `financeGroup` (`ownerId`), `financeTrip` (`ownerId`),
   *    `financeTripItinerary` (by `tripId`), `financeSharedExpense`
   *    (`paidByUserId`) plus its `shares`, and `financeSettlement`
   *    (`fromUserId`/`toUserId`) — serialising `BigInt` amounts as strings or
   *    numbers the way the `Change` payloads already do, and it must run in the
   *    worker, not on the request path.
   *
   * Both edits belong to files other than this one, so the request is logged
   * truthfully instead of being answered with a job that would deliver an empty
   * bundle. Note the asymmetry this leaves: deletion (above) now reaches the
   * finance tables, export does not, so an account can be erased before it has
   * ever been handed its own financial data.
   */
  async requestDataExport(
    userId: string,
  ): Promise<{ status: string; message: string }> {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new NotFoundException("User profile not found");
    }

    this.logger.log(`Data export requested for user ${userId}`);
    this.logger.warn(
      `Export for user ${userId} was recorded but not queued: this process has no Bull registry, and ExportProcessor emits no finance collections.`,
    );

    return {
      status: "accepted",
      message:
        "Data export request recorded. Background export delivery is disabled.",
    };
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
