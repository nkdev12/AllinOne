import { allocateExpenseShares, validMembers } from "./group-validation";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import {
  normaliseCurrency,
  toMinorUnits,
} from "@/finance/accounts/accounts.service";
import { CreateGroupDto } from "./dto/create-group.dto";
import { UpdateGroupDto } from "./dto/update-group.dto";
import { CreateSharedExpenseDto } from "./dto/create-shared-expense.dto";
import { CreateSettlementDto } from "./dto/create-settlement.dto";
import { UpdateSharedExpenseDto } from "./dto/update-shared-expense.dto";
import { UpdateSettlementDto } from "./dto/update-settlement.dto";
import { appendChange } from "@/sync/change-cursor";
import { ChangeOperation, FinanceSplitType, Prisma } from "@prisma/client";

type WriteClient = Prisma.TransactionClient;

function formatGroupResponse(group: any) {
  return {
    ...group,
  };
}

function formatSharedExpenseResponse(expense: any) {
  return {
    ...expense,
    totalAmountMinor: Number(expense.totalAmountMinor),
    shares: (expense.shares || []).map((s: any) => ({
      ...s,
      owedAmountMinor: Number(s.owedAmountMinor),
    })),
  };
}

function formatSettlementResponse(settlement: any) {
  return {
    ...settlement,
    amountMinor: Number(settlement.amountMinor),
  };
}

function groupChangePayload(group: any): Record<string, any> {
  return {
    name: group.name,
    members: group.members ?? [],
    description: group.description ?? null,
    currency: group.currency ?? "INR",
    iconKey: group.iconKey ?? null,
    isArchived: group.isArchived ?? false,
    createdAt:
      group.createdAt instanceof Date
        ? group.createdAt.toISOString()
        : (group.createdAt ?? null),
    version: group.version ?? 1,
  };
}

function sharedExpenseChangePayload(expense: any): Record<string, any> {
  return {
    shares: (expense.shares ?? []).map((share: any) => ({
      userId: share.userId,
      owedAmountMinor: Number(share.owedAmountMinor),
      shareUnits: share.shareUnits ?? null,
      // The three keys a share needs to travel with its own history. They are
      // the reason the row is no longer rebuilt on every edit: a device that
      // pulls "Alice 3334, settled" has to be able to see that it was settled,
      // or the next replay from that device quietly un-settles it for everyone.
      isSettled: share.isSettled ?? false,
      settledAt:
        share.settledAt instanceof Date
          ? share.settledAt.toISOString()
          : (share.settledAt ?? null),
      version: share.version ?? 1,
    })),
    groupId: expense.groupId ?? null,
    tripId: expense.tripId ?? null,
    paidByUserId: expense.paidByUserId,
    payerAccountId: expense.payerAccountId ?? null,
    title: expense.title,
    totalAmountMinor: Number(expense.totalAmountMinor),
    currency: expense.currency ?? "INR",
    splitType: expense.splitType ?? FinanceSplitType.EQUAL,
    date:
      expense.date instanceof Date
        ? expense.date.toISOString()
        : (expense.date ?? null),
    notes: expense.notes ?? null,
    receiptAttachmentId: expense.receiptAttachmentId ?? null,
    createdAt:
      expense.createdAt instanceof Date
        ? expense.createdAt.toISOString()
        : (expense.createdAt ?? null),
    version: expense.version ?? 1,
  };
}

function settlementChangePayload(settlement: any): Record<string, any> {
  return {
    groupId: settlement.groupId ?? null,
    tripId: settlement.tripId ?? null,
    fromUserId: settlement.fromUserId,
    toUserId: settlement.toUserId,
    amountMinor: Number(settlement.amountMinor),
    currency: settlement.currency ?? "INR",
    date:
      settlement.date instanceof Date
        ? settlement.date.toISOString()
        : (settlement.date ?? null),
    notes: settlement.notes ?? null,
    paymentMethod: settlement.paymentMethod ?? null,
    createdAt:
      settlement.createdAt instanceof Date
        ? settlement.createdAt.toISOString()
        : (settlement.createdAt ?? null),
    version: settlement.version ?? 1,
  };
}

/**
 * The age of a share row, for picking between two rows that describe the same
 * participant. Missing or unreadable `createdAt` sorts oldest rather than
 * throwing: a row written before the column existed is still a row.
 */
function shareRowAge(row: any): number {
  const time = row?.createdAt ? new Date(row.createdAt).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

/**
 * Which of two `FinanceExpenseShare` rows for one participant the diff writes.
 *
 * A live row always beats a tombstone — the rejoin this diff replaced left
 * exactly that pair behind, an inserted row next to the tombstone it never read
 * — and within one state the newest row wins, so the row the other devices saw
 * most recently is the one an edit moves or a rejoin revives.
 */
function isPreferredShareRow(candidate: any, held: any): boolean {
  // `== null`, not `!== null`: a share written before `deletedAt` existed has no
  // such key at all, and that is a live row.
  const candidateLive = candidate.deletedAt == null;
  const heldLive = held.deletedAt == null;
  if (candidateLive !== heldLive) return candidateLive;
  return shareRowAge(candidate) >= shareRowAge(held);
}

export interface SimplifiedDebt {
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
}

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly syncNotifications?: SyncNotificationService,
  ) {}

  /**
   * A finance group has one shared ledger, so every mutation must be appended
   * to every active participant's personal sync stream. The REST response is
   * not enough: the Flutter finance UI reads its local projection.
   */
  private async appendGroupChange(
    tx: WriteClient,
    groupId: string,
    ownerId: string,
    actorId: string,
    change: Omit<Prisma.ChangeUncheckedCreateInput, "cursor" | "userId">,
  ): Promise<Map<string, bigint>> {
    const recipients = new Set([ownerId, actorId]);
    const resourceShare = (tx as any).resourceShare;
    if (resourceShare?.findMany) {
      const shares = await resourceShare.findMany({
        where: {
          resourceType: "EXPENSE_GROUP",
          resourceId: groupId,
          deletedAt: null,
        },
        select: { sharedWithUserId: true },
      });
      for (const share of shares) {
        if (share.sharedWithUserId) recipients.add(share.sharedWithUserId);
      }
    }

    const cursors = new Map<string, bigint>();
    for (const userId of recipients) {
      const logged = await appendChange(tx, { ...change, userId });
      cursors.set(userId, logged.cursor);
    }
    return cursors;
  }

  private mergeChangeCursors(
    target: Map<string, bigint>,
    added: Map<string, bigint>,
  ) {
    for (const [userId, cursor] of added) target.set(userId, cursor);
  }

  private notifyGroupChanges(cursors: Map<string, bigint>) {
    for (const [userId, highestCursor] of cursors) {
      this.syncNotifications?.notifyMutation({ userId, highestCursor });
    }
  }

  // -------------------------------------------------------------
  // Group CRUD
  // -------------------------------------------------------------

  async createGroup(userId: string, dto: CreateGroupDto) {
    if (dto.members && !validMembers(dto.members))
      throw new BadRequestException("Friends must have unique names and IDs.");
    await this.assertMemberAccounts(userId, dto.members);
    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const group = await tx.financeGroup.create({
        data: {
          ownerId: userId,
          name: dto.name.trim(),
          members: (dto.members ?? []).map((member) => ({
            ...member,
            name: member.name.trim(),
            active: member.active !== false,
          })),
          description: dto.description,
          currency: normaliseCurrency(dto.currency),
          iconKey: dto.iconKey,
          isArchived: false,
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_group",
        entityId: group.id,
        operation: ChangeOperation.CREATE,
        version: group.version,
        payload: groupChangePayload(group),
        userId,
      });
      highestCursor = logged.cursor;

      return group;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatGroupResponse(created);
  }

  async getGroups(userId: string, includeArchived = false) {
    const shared = await this.prisma.resourceShare.findMany({
      where: {
        resourceType: "EXPENSE_GROUP",
        sharedWithUserId: userId,
        deletedAt: null,
      },
      select: { resourceId: true },
    });
    const groups = await this.prisma.financeGroup.findMany({
      where: {
        OR: [
          { ownerId: userId },
          { id: { in: shared.map((share) => share.resourceId) } },
        ],
        deletedAt: null,
        ...(includeArchived ? {} : { isArchived: false }),
      },
      orderBy: { createdAt: "desc" },
    });

    return groups.map(formatGroupResponse);
  }

  async getGroupById(userId: string, groupId: string, canEdit = false) {
    const group = await this.prisma.financeGroup.findFirst({
      where: {
        id: groupId,
        deletedAt: null,
      },
    });

    if (!group) {
      throw new NotFoundException("Finance group not found");
    }

    if (group.ownerId !== userId) {
      const share = await this.prisma.resourceShare.findFirst({
        where: {
          resourceType: "EXPENSE_GROUP",
          resourceId: groupId,
          sharedWithUserId: userId,
          deletedAt: null,
          ...(canEdit ? { role: { in: ["EDITOR", "ADMIN"] } } : {}),
        },
      });
      if (!share) throw new NotFoundException("Finance group not found");
    }

    return formatGroupResponse(group);
  }

  async updateGroup(userId: string, groupId: string, dto: UpdateGroupDto) {
    if (dto.members && !validMembers(dto.members))
      throw new BadRequestException("Friends must have unique names and IDs.");
    await this.assertMemberAccounts(userId, dto.members);
    const existing = await this.getGroupById(userId, groupId, true);
    const incomingCurrency =
      dto.currency === undefined ? undefined : normaliseCurrency(dto.currency);
    if (
      incomingCurrency !== undefined &&
      incomingCurrency !== normaliseCurrency(existing.currency)
    )
      throw new BadRequestException(
        "Group currency cannot be changed after creation.",
      );
    const notificationCursors = new Map<string, bigint>();

    const updated = await this.prisma.$transaction(async (tx) => {
      const group = await tx.financeGroup.update({
        where: { id: existing.id },
        data: {
          ...(dto.members !== undefined
            ? {
                members: dto.members.map((member) => ({
                  ...member,
                  name: member.name.trim(),
                  active: member.active !== false,
                })),
              }
            : {}),
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(incomingCurrency !== undefined
            ? { currency: incomingCurrency }
            : {}),
          ...(dto.iconKey !== undefined ? { iconKey: dto.iconKey } : {}),
          ...(dto.isArchived !== undefined
            ? { isArchived: dto.isArchived }
            : {}),
          version: { increment: 1 },
        },
      });

      const cursors = await this.appendGroupChange(
        tx,
        group.id,
        existing.ownerId,
        userId,
        {
          entityType: "finance_group",
          entityId: group.id,
          operation: ChangeOperation.UPDATE,
          version: group.version,
          payload: groupChangePayload(group),
        },
      );
      this.mergeChangeCursors(notificationCursors, cursors);

      return group;
    });

    this.notifyGroupChanges(notificationCursors);

    return formatGroupResponse(updated);
  }

  /** `You` is the local self marker; every other participant is an account. */
  private async assertMemberAccounts(
    userId: string,
    members?: Array<{ id: string }>,
  ) {
    if (!members) return;
    const ids = [...new Set(members.map((member) => member.id))].filter(
      (id) => id !== "You" && id !== userId,
    );
    if (!ids.length) return;
    const found = await this.prisma.user.findMany({
      where: { id: { in: ids }, status: "ACTIVE" },
      select: { id: true, deletedAt: true },
    });
    const active = new Set(
      found
        .filter((account) => !account.deletedAt)
        .map((account) => account.id),
    );
    if (ids.some((id) => !active.has(id))) {
      throw new BadRequestException(
        "Each friend must be a registered active account.",
      );
    }
  }

  async deleteGroup(userId: string, groupId: string) {
    const existing = await this.getGroupById(userId, groupId);
    if (existing.ownerId !== userId) {
      throw new ForbiddenException(
        "Only the group owner can remove this group.",
      );
    }
    const deletedAt = new Date();
    const notificationCursors = new Map<string, bigint>();

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.financeGroup.update({
        where: { id: existing.id },
        data: {
          deletedAt,
          version: { increment: 1 },
        },
      });

      const cursors = await this.appendGroupChange(
        tx,
        existing.id,
        existing.ownerId,
        userId,
        {
          entityType: "finance_group",
          entityId: existing.id,
          operation: ChangeOperation.DELETE,
          version: updated.version,
          payload: {},
        },
      );
      this.mergeChangeCursors(notificationCursors, cursors);

      // `onDelete: Cascade` in schema.prisma is decoration only on MongoDB —
      // nothing enforces it at write time. Tombstoning just the group left its
      // expenses and settlements live, so `GET /groups/:id/expenses` 404s on a
      // deleted parent while the rows still carried balances into every other
      // read path, and a device that pulled the group DELETE kept its half of
      // the ledger. Each child gets its own tombstone and its own DELETE change
      // in this transaction, so the log replays the whole subtree.
      //
      // `FinanceExpenseShare` has `deletedAt` and `version` now, but a share is
      // still not tombstoned *here*: shares are only ever read through their
      // parent expense (every `include` in this file filters the relation on
      // `deletedAt: null`), the parent just got its own tombstone, and a share is
      // not a `Change` entity type — so a per-share DELETE row would be a change
      // no device can replay. The tombstone this table gained is for the diff in
      // `updateSharedExpense`, which keeps a dropped participant's row — and with
      // it its `isSettled` — instead of deleting it.
      const [expenses, settlements] = await Promise.all([
        tx.financeSharedExpense.findMany({
          where: { groupId, deletedAt: null },
        }),
        tx.financeSettlement.findMany({ where: { groupId, deletedAt: null } }),
      ]);

      for (const expense of expenses) {
        const child = await tx.financeSharedExpense.update({
          where: { id: expense.id },
          data: { deletedAt, version: { increment: 1 } },
        });
        const childCursors = await this.appendGroupChange(
          tx,
          existing.id,
          existing.ownerId,
          userId,
          {
            entityType: "finance_shared_expense",
            entityId: expense.id,
            operation: ChangeOperation.DELETE,
            version: child.version,
            payload: {},
          },
        );
        this.mergeChangeCursors(notificationCursors, childCursors);
      }

      for (const settlement of settlements) {
        const child = await tx.financeSettlement.update({
          where: { id: settlement.id },
          data: { deletedAt, version: { increment: 1 } },
        });
        const childCursors = await this.appendGroupChange(
          tx,
          existing.id,
          existing.ownerId,
          userId,
          {
            entityType: "finance_settlement",
            entityId: settlement.id,
            operation: ChangeOperation.DELETE,
            version: child.version,
            payload: {},
          },
        );
        this.mergeChangeCursors(notificationCursors, childCursors);
      }
    });

    this.notifyGroupChanges(notificationCursors);

    return { success: true };
  }

  // -------------------------------------------------------------
  // Tenant checks for the id-shaped references a write carries
  // -------------------------------------------------------------

  /**
   * A `tripId` was stored verbatim, so attaching an expense to somebody else's
   * trip both succeeded on REST and then fed their `getTripStats`, even though
   * the sync projection already refused the same row with `assertSharedScope`.
   * The two write paths must answer the same question the same way.
   */
  private async assertTripScope(userId: string, tripId?: string | null) {
    if (!tripId) return null;
    const trip = await this.prisma.financeTrip.findFirst({
      where: { id: tripId, ownerId: userId, deletedAt: null },
    });
    if (!trip) {
      throw new ForbiddenException("This trip is not available to you.");
    }
    return trip;
  }

  private async assertAccountScope(userId: string, accountId?: string | null) {
    if (!accountId) return null;
    const account = await this.prisma.financeAccount.findFirst({
      where: { id: accountId, userId, deletedAt: null },
    });
    if (!account) {
      throw new BadRequestException("Payer account does not belong to you.");
    }
    return account;
  }

  private async assertReceiptScope(
    userId: string,
    attachmentId?: string | null,
  ) {
    if (!attachmentId) return;
    const receipt = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, userId },
    });
    if (!receipt) {
      throw new BadRequestException(
        "Receipt attachment does not belong to you.",
      );
    }
  }

  /**
   * Write authority for a group's children: the owner, or a grantee whose
   * `ResourceShare` says `EDITOR`/`ADMIN`.
   *
   * This is the same rule `getGroupById(userId, groupId, true)` applies to the
   * CREATE routes, spelled out in two steps so the answer is honest: somebody
   * the owner shared the group with can see it, so telling them it does not exist
   * is wrong — what they lack is the write grant (`403`). A caller with no grant
   * at all still gets the `404` the create path gives them, because the group is
   * not theirs to know about.
   */
  private async assertGroupWriteAuthority(userId: string, groupId: string) {
    const group = await this.getGroupById(userId, groupId);
    if (group.ownerId === userId) return group;

    const grant = await this.prisma.resourceShare.findFirst({
      where: {
        resourceType: "EXPENSE_GROUP",
        resourceId: groupId,
        sharedWithUserId: userId,
        deletedAt: null,
        role: { in: ["EDITOR", "ADMIN"] },
      },
    });
    if (!grant) {
      throw new ForbiddenException(
        "Only the group owner or an editor can change this.",
      );
    }
    return group;
  }

  // -------------------------------------------------------------
  // Shared Expenses
  // -------------------------------------------------------------

  async addSharedExpense(
    userId: string,
    groupId: string,
    dto: CreateSharedExpenseDto,
  ) {
    const group = await this.getGroupById(userId, groupId, true);
    const splitType = dto.splitType ?? FinanceSplitType.EQUAL;
    const groupCurrency = normaliseCurrency(group.currency);
    const incomingCurrency =
      dto.currency === undefined ? undefined : normaliseCurrency(dto.currency);
    if (incomingCurrency !== undefined && incomingCurrency !== groupCurrency)
      throw new BadRequestException("Use the group currency.");

    const totalAmountMinor = toMinorUnits(
      dto.totalAmountMinor,
      "totalAmountMinor",
    );

    // The amounts are derived here rather than taken from the request: a split
    // of minor units is not always exact, and making the client guess the
    // leftover turned an honest three-way split into a 400.
    const shares = allocateExpenseShares(
      dto.totalAmountMinor,
      dto.shares,
      splitType,
    );

    const trip = await this.assertTripScope(userId, dto.tripId);
    if (trip && normaliseCurrency(trip.baseCurrency) !== groupCurrency)
      throw new BadRequestException(
        "This trip uses a different currency than the group.",
      );
    const payerAccount = await this.assertAccountScope(
      userId,
      dto.payerAccountId,
    );
    await this.assertReceiptScope(userId, dto.receiptAttachmentId);
    const notificationCursors = new Map<string, bigint>();

    const expense = await this.prisma.$transaction(async (tx) => {
      const created = await tx.financeSharedExpense.create({
        data: {
          groupId,
          tripId: dto.tripId,
          paidByUserId: dto.paidByUserId,
          payerAccountId: payerAccount?.id ?? null,
          title: dto.title,
          totalAmountMinor,
          currency: groupCurrency,
          splitType,
          date: new Date(dto.date),
          notes: dto.notes,
          receiptAttachmentId: dto.receiptAttachmentId,
          shares: {
            create: shares.map((share) => ({
              userId: share.userId,
              owedAmountMinor: BigInt(share.owedAmountMinor),
              shareUnits: share.shareUnits,
            })),
          },
        },
        include: { shares: { where: { deletedAt: null } } },
      });

      const cursors = await this.appendGroupChange(
        tx,
        groupId,
        group.ownerId,
        userId,
        {
          entityType: "finance_shared_expense",
          entityId: created.id,
          operation: ChangeOperation.CREATE,
          version: created.version,
          payload: sharedExpenseChangePayload(created),
        },
      );
      this.mergeChangeCursors(notificationCursors, cursors);

      return created;
    });

    this.notifyGroupChanges(notificationCursors);

    return formatSharedExpenseResponse(expense);
  }

  async getSharedExpenses(userId: string, groupId: string) {
    await this.getGroupById(userId, groupId);

    const expenses = await this.prisma.financeSharedExpense.findMany({
      where: {
        groupId,
        deletedAt: null,
      },
      include: { shares: { where: { deletedAt: null } } },
      orderBy: { date: "desc" },
    });

    return expenses.map(formatSharedExpenseResponse);
  }

  async deleteSharedExpense(
    userId: string,
    groupId: string,
    expenseId: string,
  ) {
    const group = await this.getGroupById(userId, groupId, true);

    const expense = await this.prisma.financeSharedExpense.findFirst({
      where: { id: expenseId, groupId, deletedAt: null },
    });

    if (!expense) {
      throw new NotFoundException("Shared expense not found");
    }

    const notificationCursors = new Map<string, bigint>();

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.financeSharedExpense.update({
        where: { id: expenseId },
        data: {
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });

      const cursors = await this.appendGroupChange(
        tx,
        groupId,
        group.ownerId,
        userId,
        {
          entityType: "finance_shared_expense",
          entityId: expenseId,
          operation: ChangeOperation.DELETE,
          version: updated.version,
          payload: {},
        },
      );
      this.mergeChangeCursors(notificationCursors, cursors);
    });

    this.notifyGroupChanges(notificationCursors);

    return { success: true };
  }

  /**
   * Rewrite the split in place, keyed on `userId`.
   *
   * The alternative this replaces was one statement — `shares: { deleteMany: {},
   * create: [...] }` — and it cost three things: every row id changed under any
   * device that had already stored the split, `createdAt` reset to the edit time,
   * and a share somebody had marked settled came back unsettled, because the
   * table had neither a tombstone nor a version so there was nowhere to keep
   * either fact. Keyed on `userId` instead: a participant the request keeps is
   * updated where they lie, a participant it names that has no row at all gets a
   * row, a participant it names that left earlier gets their own row back, and a
   * participant it drops keeps the row with `deletedAt` set.
   *
   * The read is deliberately not narrowed to live rows, because it feeds a
   * decision about *which row to write* rather than an output: a participant who
   * left the split and comes back has to land on the row the other devices
   * already hold, revived under its own id, instead of a fresh id that orphans
   * the tombstone. That is what `prisma/schema.prisma` documents the non-unique
   * `@@index([sharedExpenseId, userId])` for, what the `/sync/push` projection
   * diff does, and what the client's `_syncShares` does by matching on `userId`.
   * Reads that answer "who is in this split today" — the list, the change
   * payload, the balances — stay on `deletedAt: null`.
   *
   * The rows are read *inside* the transaction for the same reason
   * `createSettlement` reads the balances there: diffing against a copy taken
   * before the critical section is how a concurrent edit from a second device
   * gets clobbered.
   *
   * Order is deterministic — `requested` arrives sorted by `userId` from
   * `allocateExpenseShares` and the read asks for the same order — so two devices
   * that describe the same split write the same rows in the same sequence.
   */
  private async applyShareDiff(
    tx: WriteClient,
    expenseId: string,
    requested: ReturnType<typeof allocateExpenseShares>,
  ): Promise<any[]> {
    const rows = await tx.financeExpenseShare.findMany({
      where: { sharedExpenseId: expenseId },
      orderBy: { userId: "asc" },
    });
    // Tombstones aside, `live` is the set the departure loop below tombstones:
    // exactly what a participant-less request finds in the split right now.
    const live = rows.filter((row: any) => row.deletedAt == null);
    const byUser = new Map<string, any>();
    for (const row of rows) {
      const held = byUser.get(row.userId);
      if (!held || isPreferredShareRow(row, held)) byUser.set(row.userId, row);
    }
    const wanted = new Set(requested.map((share) => share.userId));
    const written: any[] = [];
    const deletedAt = new Date();

    for (const share of requested) {
      const row = byUser.get(share.userId);
      if (!row) {
        written.push(
          await tx.financeExpenseShare.create({
            data: {
              sharedExpenseId: expenseId,
              userId: share.userId,
              owedAmountMinor: BigInt(share.owedAmountMinor),
              shareUnits: share.shareUnits ?? null,
            },
          }),
        );
        continue;
      }

      // Coming back from a tombstone is a change in itself, so a revive writes
      // even when the amounts happen to be the ones the participant left behind;
      // a live row only moves when the request actually moves it.
      const reviving = row.deletedAt != null;
      const amountChanged =
        Number(row.owedAmountMinor) !== share.owedAmountMinor;
      const unitsChanged =
        (row.shareUnits ?? null) !== (share.shareUnits ?? null);
      if (!reviving && !amountChanged && !unitsChanged) {
        // Nothing to write, so nothing is bumped: a share that already says what
        // the request says keeps its version, and a replay of it cannot look
        // like an edit another device has to win against.
        written.push(row);
        continue;
      }

      // `isSettled` and `settledAt` are deliberately not in this write, and the
      // revive shares the rule rather than getting its own: an expense-edit
      // payload carries no settlement state at all (`ExpenseShareItemDto`), so
      // the only way to keep a rejoin from inventing a settle nobody recorded —
      // or from erasing one the settlement flow did record — is to write neither
      // key. Only the participant who owes the money settles it, and an edit
      // from somebody else's device must not reach that either way.
      const posted = await tx.financeExpenseShare.update({
        where: { id: row.id },
        data: {
          owedAmountMinor: BigInt(share.owedAmountMinor),
          shareUnits: share.shareUnits ?? null,
          ...(reviving ? { deletedAt: null } : {}),
          version: { increment: 1 },
        },
      });
      written.push({
        ...row,
        owedAmountMinor: BigInt(share.owedAmountMinor),
        shareUnits: share.shareUnits ?? null,
        ...(reviving ? { deletedAt: null } : {}),
        version: Number.isSafeInteger(Number(posted?.version))
          ? Number(posted.version)
          : Number(row.version ?? 1) + 1,
      });
    }

    for (const row of live) {
      if (wanted.has(row.userId)) continue;
      await tx.financeExpenseShare.update({
        where: { id: row.id },
        data: { deletedAt, version: { increment: 1 } },
      });
    }

    return written;
  }

  /**
   * Edit a shared expense — including its split — without delete-and-recreate.
   *
   * Deleting to edit was the only option this route set offered, and it is the
   * documented payload-erasure hazard class: the row's `createdAt` and its place
   * in the change log were lost, every device that held the old shares had to
   * guess what happened to them, and a settlement recorded against the deleted id
   * was orphaned. Every rule the CREATE applies is applied here to whatever the
   * request actually changes, and the mutation still ends in one `$transaction`
   * that appends the group's `Change` rows.
   */
  async updateSharedExpense(
    userId: string,
    groupId: string,
    expenseId: string,
    dto: UpdateSharedExpenseDto,
  ) {
    const group = await this.assertGroupWriteAuthority(userId, groupId);

    const existing = await this.prisma.financeSharedExpense.findFirst({
      where: { id: expenseId, groupId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException("Shared expense not found");
    }

    const groupCurrency = normaliseCurrency(group.currency);
    const incomingCurrency =
      dto.currency === undefined ? undefined : normaliseCurrency(dto.currency);
    if (incomingCurrency !== undefined && incomingCurrency !== groupCurrency)
      throw new BadRequestException("Use the group currency.");

    const totalAmountMinor =
      dto.totalAmountMinor === undefined
        ? existing.totalAmountMinor
        : toMinorUnits(dto.totalAmountMinor, "totalAmountMinor");
    if (
      !Number.isSafeInteger(Number(totalAmountMinor)) ||
      Number(totalAmountMinor) <= 0
    )
      throw new BadRequestException(
        "An expense needs a positive whole amount in minor units.",
      );

    const splitType = dto.splitType ?? existing.splitType;
    // The same allocator with the same rules the create path uses — 1..100
    // participants, unique `userId`s, non-negative safe-integer amounts, finite
    // weights, and the exact-sum contract for `EXACT`/`ITEMIZED` — now measured
    // against the total this request leaves in force, which may be the stored one.
    const shares =
      dto.shares === undefined
        ? undefined
        : allocateExpenseShares(
            Number(totalAmountMinor),
            dto.shares,
            splitType,
          );

    const trip = await this.assertTripScope(userId, dto.tripId);
    if (trip && normaliseCurrency(trip.baseCurrency) !== groupCurrency)
      throw new BadRequestException(
        "This trip uses a different currency than the group.",
      );
    const payerAccount = await this.assertAccountScope(
      userId,
      dto.payerAccountId,
    );
    await this.assertReceiptScope(userId, dto.receiptAttachmentId);

    const notificationCursors = new Map<string, bigint>();

    const expense = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.financeSharedExpense.update({
        where: { id: expenseId },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.totalAmountMinor !== undefined ? { totalAmountMinor } : {}),
          ...(incomingCurrency !== undefined
            ? { currency: incomingCurrency }
            : {}),
          ...(dto.paidByUserId !== undefined
            ? { paidByUserId: dto.paidByUserId }
            : {}),
          ...(dto.payerAccountId !== undefined
            ? { payerAccountId: payerAccount?.id ?? null }
            : {}),
          ...(dto.splitType !== undefined ? { splitType } : {}),
          ...(dto.date !== undefined ? { date: new Date(dto.date) } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.receiptAttachmentId !== undefined
            ? { receiptAttachmentId: dto.receiptAttachmentId }
            : {}),
          ...(dto.tripId !== undefined ? { tripId: dto.tripId } : {}),
          version: { increment: 1 },
        },
      });

      // An edit that says nothing about the split leaves every row exactly where
      // it is — no rebuild, no version churn, no lost `isSettled`.
      const sharesAfter = shares
        ? await this.applyShareDiff(tx, expenseId, shares)
        : await tx.financeExpenseShare.findMany({
            where: { sharedExpenseId: expenseId, deletedAt: null },
            orderBy: { userId: "asc" },
          });

      const cursors = await this.appendGroupChange(
        tx,
        groupId,
        group.ownerId,
        userId,
        {
          entityType: "finance_shared_expense",
          entityId: expenseId,
          operation: ChangeOperation.UPDATE,
          version: updated.version,
          payload: sharedExpenseChangePayload({
            ...updated,
            shares: sharesAfter,
          }),
        },
      );
      this.mergeChangeCursors(notificationCursors, cursors);

      return { ...updated, shares: sharesAfter };
    });

    this.notifyGroupChanges(notificationCursors);

    return formatSharedExpenseResponse(expense);
  }

  // -------------------------------------------------------------
  // Settlements
  // -------------------------------------------------------------

  async createSettlement(
    userId: string,
    groupId: string,
    dto: CreateSettlementDto,
  ) {
    const group = await this.getGroupById(userId, groupId, true);
    if (
      !Number.isSafeInteger(dto.amountMinor) ||
      dto.amountMinor <= 0 ||
      dto.fromUserId === dto.toUserId
    )
      throw new BadRequestException(
        "Choose different friends and a positive payment amount.",
      );
    const groupCurrency = normaliseCurrency(group.currency);
    if (
      dto.currency !== undefined &&
      normaliseCurrency(dto.currency) !== groupCurrency
    )
      throw new BadRequestException("Use the group currency.");
    const amountMinor = toMinorUnits(dto.amountMinor, "amountMinor");
    const trip = await this.assertTripScope(userId, dto.tripId);
    if (trip && normaliseCurrency(trip.baseCurrency) !== groupCurrency)
      throw new BadRequestException(
        "This trip uses a different currency than the group.",
      );
    const notificationCursors = new Map<string, bigint>();

    const settlement = await this.prisma.$transaction(async (tx) => {
      // Read inside the transaction. Balances read before it let two devices
      // settle "the full outstanding amount" at the same time: both saw Alice
      // owing 10000, both were accepted, and the group ended up with Alice
      // owing Bob nothing-of-her-making because the second payment overdrew her
      // debt. The check and the write are one critical section now.
      const balances = await this.readBalances(tx, groupId);
      if (
        dto.amountMinor > -(balances[dto.fromUserId] ?? 0) ||
        dto.amountMinor > (balances[dto.toUserId] ?? 0)
      )
        throw new BadRequestException(
          "Payment exceeds the outstanding balance.",
        );

      const created = await tx.financeSettlement.create({
        data: {
          groupId,
          tripId: dto.tripId,
          fromUserId: dto.fromUserId,
          toUserId: dto.toUserId,
          amountMinor,
          currency: groupCurrency,
          date: new Date(dto.date),
          notes: dto.notes,
          paymentMethod: dto.paymentMethod,
        },
      });

      const cursors = await this.appendGroupChange(
        tx,
        groupId,
        group.ownerId,
        userId,
        {
          entityType: "finance_settlement",
          entityId: created.id,
          operation: ChangeOperation.CREATE,
          version: created.version,
          payload: settlementChangePayload(created),
        },
      );
      this.mergeChangeCursors(notificationCursors, cursors);

      return created;
    });

    this.notifyGroupChanges(notificationCursors);

    return formatSettlementResponse(settlement);
  }

  async getSettlements(userId: string, groupId: string) {
    await this.getGroupById(userId, groupId);

    const settlements = await this.prisma.financeSettlement.findMany({
      where: {
        groupId,
        deletedAt: null,
      },
      orderBy: { date: "desc" },
    });

    return settlements.map(formatSettlementResponse);
  }

  async deleteSettlement(
    userId: string,
    groupId: string,
    settlementId: string,
  ) {
    const group = await this.getGroupById(userId, groupId, true);

    const settlement = await this.prisma.financeSettlement.findFirst({
      where: { id: settlementId, groupId, deletedAt: null },
    });

    if (!settlement) {
      throw new NotFoundException("Settlement not found");
    }

    const notificationCursors = new Map<string, bigint>();

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.financeSettlement.update({
        where: { id: settlementId },
        data: {
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });

      const cursors = await this.appendGroupChange(
        tx,
        groupId,
        group.ownerId,
        userId,
        {
          entityType: "finance_settlement",
          entityId: settlementId,
          operation: ChangeOperation.DELETE,
          version: updated.version,
          payload: {},
        },
      );
      this.mergeChangeCursors(notificationCursors, cursors);
    });

    this.notifyGroupChanges(notificationCursors);

    return { success: true };
  }

  /**
   * Correct a settlement without deleting it.
   *
   * A payment that was miscoded (wrong day, wrong method, a rupee off) used to be
   * fixable only by deleting the row and creating a new one, which moved the
   * amount twice through the balances and left the deleted id in every device's
   * history. The overdraft rule that stops a second full-balance CREATE is applied
   * here too, against the balances with *this* row left out — otherwise editing a
   * 4000 payment into 40000 would be the one way to draw a debt below zero.
   */
  async updateSettlement(
    userId: string,
    groupId: string,
    settlementId: string,
    dto: UpdateSettlementDto,
  ) {
    const group = await this.assertGroupWriteAuthority(userId, groupId);

    const existing = await this.prisma.financeSettlement.findFirst({
      where: { id: settlementId, groupId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException("Settlement not found");
    }

    const fromUserId = dto.fromUserId ?? existing.fromUserId;
    const toUserId = dto.toUserId ?? existing.toUserId;
    const amountMinor =
      dto.amountMinor === undefined
        ? existing.amountMinor
        : toMinorUnits(dto.amountMinor, "amountMinor");
    if (
      !Number.isSafeInteger(Number(amountMinor)) ||
      Number(amountMinor) <= 0 ||
      fromUserId === toUserId
    )
      throw new BadRequestException(
        "Choose different friends and a positive payment amount.",
      );

    const groupCurrency = normaliseCurrency(group.currency);
    if (
      dto.currency !== undefined &&
      normaliseCurrency(dto.currency) !== groupCurrency
    )
      throw new BadRequestException("Use the group currency.");

    const trip = await this.assertTripScope(userId, dto.tripId);
    if (trip && normaliseCurrency(trip.baseCurrency) !== groupCurrency)
      throw new BadRequestException(
        "This trip uses a different currency than the group.",
      );

    const notificationCursors = new Map<string, bigint>();

    const settlement = await this.prisma.$transaction(async (tx) => {
      const balances = await this.readBalances(tx, groupId, {
        excludeSettlementId: settlementId,
      });
      if (
        Number(amountMinor) > -(balances[fromUserId] ?? 0) ||
        Number(amountMinor) > (balances[toUserId] ?? 0)
      )
        throw new BadRequestException(
          "Payment exceeds the outstanding balance.",
        );

      const updated = await tx.financeSettlement.update({
        where: { id: settlementId },
        data: {
          ...(dto.fromUserId !== undefined
            ? { fromUserId: dto.fromUserId }
            : {}),
          ...(dto.toUserId !== undefined ? { toUserId: dto.toUserId } : {}),
          ...(dto.amountMinor !== undefined ? { amountMinor } : {}),
          ...(dto.currency !== undefined ? { currency: groupCurrency } : {}),
          ...(dto.date !== undefined ? { date: new Date(dto.date) } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.paymentMethod !== undefined
            ? { paymentMethod: dto.paymentMethod }
            : {}),
          ...(dto.tripId !== undefined ? { tripId: dto.tripId } : {}),
          version: { increment: 1 },
        },
      });

      const cursors = await this.appendGroupChange(
        tx,
        groupId,
        group.ownerId,
        userId,
        {
          entityType: "finance_settlement",
          entityId: settlementId,
          operation: ChangeOperation.UPDATE,
          version: updated.version,
          payload: settlementChangePayload(updated),
        },
      );
      this.mergeChangeCursors(notificationCursors, cursors);

      return updated;
    });

    this.notifyGroupChanges(notificationCursors);

    return formatSettlementResponse(settlement);
  }

  // -------------------------------------------------------------
  // Balances & Debt Simplifier (Min-Cash-Flow Algorithm)
  // -------------------------------------------------------------

  /**
   * Balances for a group, off whatever client is handed to it — the plain
   * service client for a read, the transaction for a settlement that has to be
   * checked against them before it is written.
   *
   * `excludeSettlementId` is for `updateSettlement`, which has to answer "would
   * this payment still be an overdraft?" about a row that is already in the very
   * balances it reads.
   *
   * Shares are read through `deletedAt: null` because they are tombstoned now:
   * a participant dropped from a split keeps their row, and counting it would
   * bill them for a debt the group agreed they no longer carry.
   */
  private async readBalances(
    client: WriteClient,
    groupId: string,
    options: { excludeSettlementId?: string } = {},
  ): Promise<Record<string, number>> {
    const [expenses, settlements] = await Promise.all([
      client.financeSharedExpense.findMany({
        where: { groupId, deletedAt: null },
        include: { shares: { where: { deletedAt: null } } },
      }),
      client.financeSettlement.findMany({
        where: {
          groupId,
          deletedAt: null,
          ...(options.excludeSettlementId
            ? { id: { not: options.excludeSettlementId } }
            : {}),
        },
      }),
    ]);

    const balances = new Map<string, number>();
    const addBal = (user: string, delta: number) => {
      balances.set(user, (balances.get(user) ?? 0) + delta);
    };

    // Shared expenses: payer gets credit, participants get debited
    for (const exp of expenses) {
      addBal(exp.paidByUserId, Number(exp.totalAmountMinor));
      for (const share of exp.shares) {
        addBal(share.userId, -Number(share.owedAmountMinor));
      }
    }

    // Settlements: fromUser paid -> gets credit; toUser received -> gets debit
    for (const st of settlements) {
      addBal(st.fromUserId, Number(st.amountMinor));
      addBal(st.toUserId, -Number(st.amountMinor));
    }

    // Build raw balances map
    const balancesObj: Record<string, number> = {};
    for (const [u, b] of balances.entries()) {
      balancesObj[u] = b;
    }

    return balancesObj;
  }

  async getGroupBalancesAndSimplifiedDebts(userId: string, groupId: string) {
    await this.getGroupById(userId, groupId);

    const balancesObj = await this.readBalances(this.prisma, groupId);
    const balances = new Map(Object.entries(balancesObj));

    // Min-Cash-Flow Bipartite Matching
    const debtors: { userId: string; amount: number }[] = [];
    const creditors: { userId: string; amount: number }[] = [];

    for (const [u, bal] of balances.entries()) {
      if (bal < 0) {
        debtors.push({ userId: u, amount: -bal });
      } else if (bal > 0) {
        creditors.push({ userId: u, amount: bal });
      }
    }

    // `userId` breaks an equal-amount tie so the suggested plan is the same on
    // every device; without one it inherits Map insertion order, which is
    // whatever order Mongo happened to return the rows in.
    const byAmountThenId = (
      a: { userId: string; amount: number },
      b: { userId: string; amount: number },
    ) =>
      b.amount - a.amount ||
      (a.userId === b.userId ? 0 : a.userId < b.userId ? -1 : 1);
    debtors.sort(byAmountThenId);
    creditors.sort(byAmountThenId);

    const simplifiedDebts: SimplifiedDebt[] = [];
    let d = 0;
    let c = 0;

    while (d < debtors.length && c < creditors.length) {
      const debtor = debtors[d];
      const creditor = creditors[c];
      const settleAmount = Math.min(debtor.amount, creditor.amount);

      if (settleAmount > 0) {
        simplifiedDebts.push({
          fromUserId: debtor.userId,
          toUserId: creditor.userId,
          amountMinor: settleAmount,
        });
      }

      debtor.amount -= settleAmount;
      creditor.amount -= settleAmount;

      if (debtor.amount === 0) d++;
      if (creditor.amount === 0) c++;
    }

    return {
      balances: balancesObj,
      simplifiedDebts,
    };
  }
}
