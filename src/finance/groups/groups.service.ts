import { assertExpenseShares, validMembers } from "./group-validation";
import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import { CreateGroupDto } from "./dto/create-group.dto";
import { UpdateGroupDto } from "./dto/update-group.dto";
import { CreateSharedExpenseDto } from "./dto/create-shared-expense.dto";
import { CreateSettlementDto } from "./dto/create-settlement.dto";
import { appendChange } from "@/sync/change-cursor";
import { ChangeOperation, FinanceSplitType } from "@prisma/client";

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
    shares: (expense.shares ?? []).map((share: any) => ({ userId: share.userId, owedAmountMinor: Number(share.owedAmountMinor), shareUnits: share.shareUnits ?? null })),
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
    if (dto.members && !validMembers(dto.members)) throw new BadRequestException("Friends must have unique names and IDs.");
    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const group = await tx.financeGroup.create({
        data: {
          ownerId: userId,
          name: dto.name.trim(),
          members: (dto.members ?? []).map((member) => ({ ...member, name: member.name.trim(), active: member.active !== false })),
          description: dto.description,
          currency: dto.currency ?? "INR",
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
    const groups = await this.prisma.financeGroup.findMany({
      where: {
        ownerId: userId,
        deletedAt: null,
        ...(includeArchived ? {} : { isArchived: false }),
      },
      orderBy: { createdAt: "desc" },
    });

    return groups.map(formatGroupResponse);
  }

  async getGroupById(userId: string, groupId: string) {
    const group = await this.prisma.financeGroup.findFirst({
      where: {
        id: groupId,
        ownerId: userId,
        deletedAt: null,
      },
    });

    if (!group) {
      throw new NotFoundException("Finance group not found");
    }

    return formatGroupResponse(group);
  }

  async updateGroup(userId: string, groupId: string, dto: UpdateGroupDto) {
    if (dto.members && !validMembers(dto.members)) throw new BadRequestException("Friends must have unique names and IDs.");
    const existing = await this.getGroupById(userId, groupId);
    if (dto.currency && dto.currency !== existing.currency) throw new BadRequestException("Group currency cannot be changed after creation.");
    let highestCursor: bigint | undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const group = await tx.financeGroup.update({
        where: { id: existing.id },
        data: {
          ...(dto.members !== undefined ? { members: dto.members.map((member) => ({ ...member, name: member.name.trim(), active: member.active !== false })) } : {}),
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
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

  async deleteGroup(userId: string, groupId: string) {
    const existing = await this.getGroupById(userId, groupId);
    let highestCursor: bigint | undefined;

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.financeGroup.update({
        where: { id: existing.id },
        data: {
          deletedAt: new Date(),
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
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return { success: true };
  }

  // -------------------------------------------------------------
  // Shared Expenses
  // -------------------------------------------------------------

  async addSharedExpense(
    userId: string,
    groupId: string,
    dto: CreateSharedExpenseDto,
  ) {
    const group = await this.getGroupById(userId, groupId);
    assertExpenseShares(dto.totalAmountMinor, dto.shares);
    if (dto.currency && dto.currency !== group.currency) throw new BadRequestException("Use the group currency.");
    const totalAmountMinor = BigInt(dto.totalAmountMinor);
    let highestCursor: bigint | undefined;

    const expense = await this.prisma.$transaction(async (tx) => {
      const created = await tx.financeSharedExpense.create({
        data: {
          groupId,
          tripId: dto.tripId,
          paidByUserId: dto.paidByUserId,
          payerAccountId: dto.payerAccountId,
          title: dto.title,
          totalAmountMinor,
          currency: group.currency,
          splitType: dto.splitType ?? FinanceSplitType.EQUAL,
          date: new Date(dto.date),
          notes: dto.notes,
          receiptAttachmentId: dto.receiptAttachmentId,
          shares: {
            create: dto.shares.map((share) => ({
              userId: share.userId,
              owedAmountMinor: BigInt(Math.round(share.owedAmountMinor)),
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
    await this.getGroupById(userId, groupId);

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
    const group = await this.getGroupById(userId, groupId);
    if (!Number.isSafeInteger(dto.amountMinor) || dto.amountMinor <= 0 || dto.fromUserId === dto.toUserId) throw new BadRequestException("Choose different friends and a positive payment amount.");
    if (dto.currency && dto.currency !== group.currency) throw new BadRequestException("Use the group currency.");
    const summary = await this.getGroupBalancesAndSimplifiedDebts(userId, groupId);
    if (dto.amountMinor > -(summary.balances[dto.fromUserId] ?? 0) || dto.amountMinor > (summary.balances[dto.toUserId] ?? 0)) throw new BadRequestException("Payment exceeds the outstanding balance.");
    const amountMinor = BigInt(dto.amountMinor);
    let highestCursor: bigint | undefined;

    const settlement = await this.prisma.$transaction(async (tx) => {
      const created = await tx.financeSettlement.create({
        data: {
          groupId,
          tripId: dto.tripId,
          fromUserId: dto.fromUserId,
          toUserId: dto.toUserId,
          amountMinor,
          currency: group.currency,
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
    await this.getGroupById(userId, groupId);

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

  async getGroupBalancesAndSimplifiedDebts(userId: string, groupId: string) {
    await this.getGroupById(userId, groupId);

    const [expenses, settlements] = await Promise.all([
      this.prisma.financeSharedExpense.findMany({
        where: { groupId, deletedAt: null },
        include: { shares: true },
      }),
      this.prisma.financeSettlement.findMany({
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

    debtors.sort((a, b) => b.amount - a.amount);
    creditors.sort((a, b) => b.amount - a.amount);

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
