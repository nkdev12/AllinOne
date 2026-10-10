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
import { appendChange } from "@/sync/change-cursor";
import { ChangeOperation, FinanceSplitType, Prisma } from "@prisma/client";

type WriteClient = Prisma.TransactionClient;

export function formatGroupResponse(group: any) {
  return {
    ...group,
  };
}

export function formatSharedExpenseResponse(expense: any) {
  return {
    ...expense,
    totalAmountMinor: Number(expense.totalAmountMinor),
    shares: (expense.shares || []).map((s: any) => ({
      ...s,
      owedAmountMinor: Number(s.owedAmountMinor),
    })),
  };
}

export function formatSettlementResponse(settlement: any) {
  return {
    ...settlement,
    amountMinor: Number(settlement.amountMinor),
  };
}

export function groupChangePayload(group: any): Record<string, any> {
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

export function sharedExpenseChangePayload(expense: any): Record<string, any> {
  return {
    shares: (expense.shares ?? []).map((share: any) => ({
      userId: share.userId,
      owedAmountMinor: Number(share.owedAmountMinor),
      shareUnits: share.shareUnits ?? null,
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

export function settlementChangePayload(settlement: any): Record<string, any> {
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
    let highestCursor: bigint | undefined;

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

      const logged = await appendChange(tx, {
        entityType: "finance_group",
        entityId: group.id,
        operation: ChangeOperation.UPDATE,
        version: group.version,
        payload: groupChangePayload(group),
        userId,
      });
      highestCursor = logged.cursor;

      return group;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

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
    let highestCursor: bigint | undefined;

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.financeGroup.update({
        where: { id: existing.id },
        data: {
          deletedAt,
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_group",
        entityId: existing.id,
        operation: ChangeOperation.DELETE,
        version: updated.version,
        payload: {},
        userId,
      });
      highestCursor = logged.cursor;

      // `onDelete: Cascade` in schema.prisma is decoration only on MongoDB —
      // nothing enforces it at write time. Tombstoning just the group left its
      // expenses and settlements live, so `GET /groups/:id/expenses` 404s on a
      // deleted parent while the rows still carried balances into every other
      // read path, and a device that pulled the group DELETE kept its half of
      // the ledger. Each child gets its own tombstone and its own DELETE change
      // in this transaction, so the log replays the whole subtree.
      //
      // `FinanceExpenseShare` has no `deletedAt`, so shares are not tombstoned;
      // they are only ever read through their (now deleted) expense.
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
        const childLogged = await appendChange(tx, {
          entityType: "finance_shared_expense",
          entityId: expense.id,
          operation: ChangeOperation.DELETE,
          version: child.version,
          payload: {},
          userId,
        });
        highestCursor = childLogged.cursor;
      }

      for (const settlement of settlements) {
        const child = await tx.financeSettlement.update({
          where: { id: settlement.id },
          data: { deletedAt, version: { increment: 1 } },
        });
        const childLogged = await appendChange(tx, {
          entityType: "finance_settlement",
          entityId: settlement.id,
          operation: ChangeOperation.DELETE,
          version: child.version,
          payload: {},
          userId,
        });
        highestCursor = childLogged.cursor;
      }
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

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
    let highestCursor: bigint | undefined;

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
        include: { shares: true },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_shared_expense",
        entityId: created.id,
        operation: ChangeOperation.CREATE,
        version: created.version,
        payload: sharedExpenseChangePayload(created),
        userId,
      });
      highestCursor = logged.cursor;

      return created;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatSharedExpenseResponse(expense);
  }

  async getSharedExpenses(userId: string, groupId: string) {
    await this.getGroupById(userId, groupId);

    const expenses = await this.prisma.financeSharedExpense.findMany({
      where: {
        groupId,
        deletedAt: null,
      },
      include: { shares: true },
      orderBy: { date: "desc" },
    });

    return expenses.map(formatSharedExpenseResponse);
  }

  async deleteSharedExpense(
    userId: string,
    groupId: string,
    expenseId: string,
  ) {
    await this.getGroupById(userId, groupId, true);

    const expense = await this.prisma.financeSharedExpense.findFirst({
      where: { id: expenseId, groupId, deletedAt: null },
    });

    if (!expense) {
      throw new NotFoundException("Shared expense not found");
    }

    let highestCursor: bigint | undefined;

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.financeSharedExpense.update({
        where: { id: expenseId },
        data: {
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_shared_expense",
        entityId: expenseId,
        operation: ChangeOperation.DELETE,
        version: updated.version,
        payload: {},
        userId,
      });
      highestCursor = logged.cursor;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return { success: true };
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
    let highestCursor: bigint | undefined;

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

      const logged = await appendChange(tx, {
        entityType: "finance_settlement",
        entityId: created.id,
        operation: ChangeOperation.CREATE,
        version: created.version,
        payload: settlementChangePayload(created),
        userId,
      });
      highestCursor = logged.cursor;

      return created;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

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
    await this.getGroupById(userId, groupId, true);

    const settlement = await this.prisma.financeSettlement.findFirst({
      where: { id: settlementId, groupId, deletedAt: null },
    });

    if (!settlement) {
      throw new NotFoundException("Settlement not found");
    }

    let highestCursor: bigint | undefined;

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.financeSettlement.update({
        where: { id: settlementId },
        data: {
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_settlement",
        entityId: settlementId,
        operation: ChangeOperation.DELETE,
        version: updated.version,
        payload: {},
        userId,
      });
      highestCursor = logged.cursor;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return { success: true };
  }

  // -------------------------------------------------------------
  // Balances & Debt Simplifier (Min-Cash-Flow Algorithm)
  // -------------------------------------------------------------

  /**
   * Balances for a group, off whatever client is handed to it — the plain
   * service client for a read, the transaction for a settlement that has to be
   * checked against them before it is written.
   */
  private async readBalances(
    client: WriteClient,
    groupId: string,
  ): Promise<Record<string, number>> {
    const [expenses, settlements] = await Promise.all([
      client.financeSharedExpense.findMany({
        where: { groupId, deletedAt: null },
        include: { shares: true },
      }),
      client.financeSettlement.findMany({
        where: { groupId, deletedAt: null },
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
