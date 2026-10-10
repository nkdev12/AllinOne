import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";
import { QueryTransactionsDto } from "./dto/query-transaction.dto";
import { appendChange } from "@/sync/change-cursor";
import { accountChangePayload } from "../accounts/accounts.service";
import {
  ChangeOperation,
  FinanceTransactionType,
  Prisma,
} from "@prisma/client";

export function formatTransactionResponse(tx: any) {
  return {
    ...tx,
    amountMinor: Number(tx.amountMinor),
  };
}

export function transactionChangePayload(tx: any): Record<string, any> {
  return {
    accountId: tx.accountId,
    toAccountId: tx.toAccountId ?? null,
    categoryId: tx.categoryId ?? null,
    type: tx.type,
    amountMinor: Number(tx.amountMinor),
    currency: tx.currency,
    title: tx.title,
    notes: tx.notes ?? null,
    tags: tx.tags ?? [],
    transactionDate:
      tx.transactionDate instanceof Date
        ? tx.transactionDate.toISOString()
        : tx.transactionDate,
    receiptAttachmentId: tx.receiptAttachmentId ?? null,
    recurringRuleId: tx.recurringRuleId ?? null,
    sharedExpenseId: tx.sharedExpenseId ?? null,
    isExcludedFromBudget: tx.isExcludedFromBudget ?? false,
    createdAt:
      tx.createdAt instanceof Date
        ? tx.createdAt.toISOString()
        : (tx.createdAt ?? null),
    version: tx.version ?? 1,
  };
}

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly syncNotifications?: SyncNotificationService,
  ) {}

  private async adjustAccount(
    tx: Prisma.TransactionClient,
    userId: string,
    accountId: string,
    deltaMinor: bigint,
  ) {
    const updated = await tx.financeAccount.update({
      where: { id: accountId },
      data: {
        currentBalanceMinor: { increment: deltaMinor },
        version: { increment: 1 },
      },
    });

    await appendChange(tx, {
      userId,
      entityType: "finance_account",
      entityId: updated.id,
      operation: ChangeOperation.UPDATE,
      version: updated.version,
      payload: accountChangePayload(updated),
    });

    return updated;
  }

  async createTransaction(userId: string, dto: CreateTransactionDto) {
    const account = await this.prisma.financeAccount.findFirst({
      where: { id: dto.accountId, userId, deletedAt: null },
    });
    if (!account) {
      throw new NotFoundException(
        `Account with ID '${dto.accountId}' not found.`,
      );
    }

    if (
      (dto.currency ?? account.currency).toUpperCase() !==
      account.currency.toUpperCase()
    ) {
      throw new BadRequestException(
        "Transaction currency must match the account.",
      );
    }
    if (account.isArchived)
      throw new BadRequestException("Account is archived.");

    if (dto.type === FinanceTransactionType.TRANSFER) {
      if (!dto.toAccountId) {
        throw new BadRequestException("Transfer requires toAccountId.");
      }
      if (dto.toAccountId === dto.accountId) {
        throw new BadRequestException("Cannot transfer to the same account.");
      }
      const toAccount = await this.prisma.financeAccount.findFirst({
        where: { id: dto.toAccountId, userId, deletedAt: null },
      });
      if (!toAccount) {
        throw new NotFoundException(
          `Destination account with ID '${dto.toAccountId}' not found.`,
        );
      }
      if (
        toAccount.isArchived ||
        toAccount.currency.toUpperCase() !== account.currency.toUpperCase()
      ) {
        throw new BadRequestException(
          "Transfers require active accounts in the same currency.",
        );
      }
    }

    if (dto.type !== FinanceTransactionType.TRANSFER && dto.toAccountId) {
      throw new BadRequestException(
        "Only transfers can have a destination account.",
      );
    }
    if (!Number.isSafeInteger(dto.amountMinor)) {
      throw new BadRequestException("amountMinor must be a safe integer.");
    }
    const amountMinor = BigInt(Math.round(dto.amountMinor));
    if (amountMinor <= BigInt(0)) {
      throw new BadRequestException("amountMinor must be greater than zero.");
    }

    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const transaction = await tx.financeTransaction.create({
        data: {
          userId,
          accountId: dto.accountId,
          toAccountId: dto.toAccountId,
          categoryId: dto.categoryId,
          type: dto.type,
          amountMinor,
          currency: account.currency,
          title: dto.title,
          notes: dto.notes,
          tags: dto.tags ?? [],
          transactionDate: new Date(dto.transactionDate),
          receiptAttachmentId: dto.receiptAttachmentId,
          recurringRuleId: dto.recurringRuleId,
          sharedExpenseId: dto.sharedExpenseId,
          isExcludedFromBudget: dto.isExcludedFromBudget ?? false,
        },
      });

      // Adjust account balance
      if (dto.type === FinanceTransactionType.INCOME) {
        await this.adjustAccount(tx, userId, dto.accountId, amountMinor);
      } else if (dto.type === FinanceTransactionType.EXPENSE) {
        await this.adjustAccount(tx, userId, dto.accountId, -amountMinor);
      } else if (
        dto.type === FinanceTransactionType.TRANSFER &&
        dto.toAccountId
      ) {
        await this.adjustAccount(tx, userId, dto.accountId, -amountMinor);
        await this.adjustAccount(tx, userId, dto.toAccountId, amountMinor);
      }

      const logged = await appendChange(tx, {
        userId,
        entityType: "finance_transaction",
        entityId: transaction.id,
        operation: ChangeOperation.CREATE,
        version: transaction.version,
        payload: transactionChangePayload(transaction),
      });
      highestCursor = logged.cursor;

      return formatTransactionResponse(transaction);
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });
    return created;
  }

  async getTransactions(userId: string, query: QueryTransactionsDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = { userId, deletedAt: null };

    if (query.type) where.type = query.type;
    if (query.accountId) {
      where.OR = [
        { accountId: query.accountId },
        { toAccountId: query.accountId },
      ];
    }
    if (query.categoryId) where.categoryId = query.categoryId;

    if (query.startDate || query.endDate) {
      where.transactionDate = {};
      if (query.startDate)
        where.transactionDate.gte = new Date(query.startDate);
      if (query.endDate) where.transactionDate.lte = new Date(query.endDate);
    }

    if (query.search) {
      where.title = { contains: query.search, mode: "insensitive" };
    }

    const [total, items] = await Promise.all([
      this.prisma.financeTransaction.count({ where }),
      this.prisma.financeTransaction.findMany({
        where,
        orderBy: [{ transactionDate: "desc" }, { createdAt: "desc" }],
        skip,
        take: limit,
        include: {
          account: true,
          toAccount: true,
          category: true,
        },
      }),
    ]);

    return {
      data: items.map(formatTransactionResponse),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTransactionById(userId: string, id: string) {
    const tx = await this.prisma.financeTransaction.findFirst({
      where: { id, userId, deletedAt: null },
      include: {
        account: true,
        toAccount: true,
        category: true,
      },
    });

    if (!tx) {
      throw new NotFoundException(
        `Finance transaction with ID '${id}' not found.`,
      );
    }

    return formatTransactionResponse(tx);
  }

  async updateTransaction(
    userId: string,
    id: string,
    dto: UpdateTransactionDto,
  ) {
    const oldTx = await this.prisma.financeTransaction.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!oldTx) {
      throw new NotFoundException(
        `Finance transaction with ID '${id}' not found.`,
      );
    }

    if (
      dto.amountMinor !== undefined &&
      !Number.isSafeInteger(dto.amountMinor)
    ) {
      throw new BadRequestException("amountMinor must be a safe integer.");
    }
    const targetAccountId = dto.accountId ?? oldTx.accountId;
    const targetToAccountId =
      dto.toAccountId !== undefined ? dto.toAccountId : oldTx.toAccountId;
    const targetType = dto.type ?? oldTx.type;
    const targetAmountMinor =
      dto.amountMinor !== undefined
        ? BigInt(Math.round(dto.amountMinor))
        : oldTx.amountMinor;

    if (targetAmountMinor <= BigInt(0)) {
      throw new BadRequestException("amountMinor must be greater than zero.");
    }

    if (targetType === FinanceTransactionType.TRANSFER) {
      if (!targetToAccountId) {
        throw new BadRequestException("Transfer requires toAccountId.");
      }
      if (targetToAccountId === targetAccountId) {
        throw new BadRequestException("Cannot transfer to the same account.");
      }
    }

    const account = await this.prisma.financeAccount.findFirst({
      where: {
        id: targetAccountId,
        userId,
        deletedAt: null,
        isArchived: false,
      },
    });
    if (!account) throw new NotFoundException("Source account not found.");
    const currency = (dto.currency ?? oldTx.currency).toUpperCase();
    if (currency !== account.currency.toUpperCase()) {
      throw new BadRequestException(
        "Transaction currency must match the account.",
      );
    }
    if (targetType === FinanceTransactionType.TRANSFER) {
      const destination = await this.prisma.financeAccount.findFirst({
        where: {
          id: targetToAccountId!,
          userId,
          deletedAt: null,
          isArchived: false,
        },
      });
      if (!destination)
        throw new NotFoundException("Destination account not found.");
      if (destination.currency.toUpperCase() !== currency) {
        throw new BadRequestException(
          "Transfers require accounts in the same currency.",
        );
      }
    }

    let highestCursor: bigint | undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      // 1. Revert old balance adjustment
      if (oldTx.type === FinanceTransactionType.INCOME) {
        await this.adjustAccount(
          tx,
          userId,
          oldTx.accountId,
          -oldTx.amountMinor,
        );
      } else if (oldTx.type === FinanceTransactionType.EXPENSE) {
        await this.adjustAccount(
          tx,
          userId,
          oldTx.accountId,
          oldTx.amountMinor,
        );
      } else if (
        oldTx.type === FinanceTransactionType.TRANSFER &&
        oldTx.toAccountId
      ) {
        await this.adjustAccount(
          tx,
          userId,
          oldTx.accountId,
          oldTx.amountMinor,
        );
        await this.adjustAccount(
          tx,
          userId,
          oldTx.toAccountId,
          -oldTx.amountMinor,
        );
      }

      // 2. Apply new balance adjustment
      if (targetType === FinanceTransactionType.INCOME) {
        await this.adjustAccount(
          tx,
          userId,
          targetAccountId,
          targetAmountMinor,
        );
      } else if (targetType === FinanceTransactionType.EXPENSE) {
        await this.adjustAccount(
          tx,
          userId,
          targetAccountId,
          -targetAmountMinor,
        );
      } else if (
        targetType === FinanceTransactionType.TRANSFER &&
        targetToAccountId
      ) {
        await this.adjustAccount(
          tx,
          userId,
          targetAccountId,
          -targetAmountMinor,
        );
        await this.adjustAccount(
          tx,
          userId,
          targetToAccountId,
          targetAmountMinor,
        );
      }

      // 3. Update transaction record
      const transaction = await tx.financeTransaction.update({
        where: { id },
        data: {
          accountId: targetAccountId,
          toAccountId:
            targetType === FinanceTransactionType.TRANSFER
              ? targetToAccountId
              : null,
          categoryId:
            dto.categoryId !== undefined ? dto.categoryId : oldTx.categoryId,
          type: targetType,
          amountMinor: targetAmountMinor,
          currency,
          title: dto.title ?? oldTx.title,
          notes: dto.notes !== undefined ? dto.notes : oldTx.notes,
          tags: dto.tags ?? oldTx.tags,
          transactionDate: dto.transactionDate
            ? new Date(dto.transactionDate)
            : oldTx.transactionDate,
          receiptAttachmentId:
            dto.receiptAttachmentId !== undefined
              ? dto.receiptAttachmentId
              : oldTx.receiptAttachmentId,
          isExcludedFromBudget:
            dto.isExcludedFromBudget !== undefined
              ? dto.isExcludedFromBudget
              : oldTx.isExcludedFromBudget,
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        userId,
        entityType: "finance_transaction",
        entityId: transaction.id,
        operation: ChangeOperation.UPDATE,
        version: transaction.version,
        payload: transactionChangePayload(transaction),
      });
      highestCursor = logged.cursor;

      return formatTransactionResponse(transaction);
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });
    return updated;
  }

  async deleteTransaction(userId: string, id: string) {
    const existing = await this.prisma.financeTransaction.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(
        `Finance transaction with ID '${id}' not found.`,
      );
    }

    let highestCursor: bigint | undefined;

    const deleted = await this.prisma.$transaction(async (tx) => {
      // Revert balance effect
      if (existing.type === FinanceTransactionType.INCOME) {
        await this.adjustAccount(
          tx,
          userId,
          existing.accountId,
          -existing.amountMinor,
        );
      } else if (existing.type === FinanceTransactionType.EXPENSE) {
        await this.adjustAccount(
          tx,
          userId,
          existing.accountId,
          existing.amountMinor,
        );
      } else if (
        existing.type === FinanceTransactionType.TRANSFER &&
        existing.toAccountId
      ) {
        await this.adjustAccount(
          tx,
          userId,
          existing.accountId,
          existing.amountMinor,
        );
        await this.adjustAccount(
          tx,
          userId,
          existing.toAccountId,
          -existing.amountMinor,
        );
      }

      const transaction = await tx.financeTransaction.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        userId,
        entityType: "finance_transaction",
        entityId: transaction.id,
        operation: ChangeOperation.DELETE,
        version: transaction.version,
        payload: {},
      });
      highestCursor = logged.cursor;

      return { success: true };
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });
    return deleted;
  }

  async getCashFlowSummary(
    userId: string,
    startDate?: string,
    endDate?: string,
    currency = "INR",
  ) {
    const where: any = {
      userId,
      deletedAt: null,
      currency: currency.toUpperCase(),
    };
    if (startDate || endDate) {
      where.transactionDate = {};
      if (startDate) where.transactionDate.gte = new Date(startDate);
      if (endDate) where.transactionDate.lte = new Date(endDate);
    }

    const transactions = await this.prisma.financeTransaction.findMany({
      where,
      select: {
        type: true,
        amountMinor: true,
      },
    });

    let incomeMinor = 0;
    let expenseMinor = 0;

    for (const t of transactions) {
      const amt = Number(t.amountMinor);
      if (t.type === FinanceTransactionType.INCOME) {
        incomeMinor += amt;
      } else if (t.type === FinanceTransactionType.EXPENSE) {
        expenseMinor += amt;
      }
    }

    return {
      currency: currency.toUpperCase(),
      incomeMinor,
      expenseMinor,
      netMinor: incomeMinor - expenseMinor,
    };
  }
}
