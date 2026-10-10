import {
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import { CreateAccountDto } from "./dto/create-account.dto";
import { UpdateAccountDto } from "./dto/update-account.dto";
import { appendChange } from "@/sync/change-cursor";
import { ChangeOperation, FinanceAccountType } from "@prisma/client";

export function formatAccountResponse(account: any) {
  return {
    ...account,
    openingBalanceMinor: Number(account.openingBalanceMinor),
    currentBalanceMinor: Number(account.currentBalanceMinor),
  };
}

export function accountChangePayload(account: any): Record<string, any> {
  return {
    name: account.name,
    type: account.type,
    currency: account.currency,
    openingBalanceMinor: Number(account.openingBalanceMinor),
    currentBalanceMinor: Number(account.currentBalanceMinor),
    color: account.color ?? null,
    iconKey: account.iconKey ?? null,
    isArchived: account.isArchived ?? false,
    sortOrder: account.sortOrder ?? 0,
    createdAt:
      account.createdAt instanceof Date
        ? account.createdAt.toISOString()
        : (account.createdAt ?? null),
    version: account.version ?? 1,
  };
}

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly syncNotifications?: SyncNotificationService,
  ) {}

  async createAccount(userId: string, dto: CreateAccountDto) {
    const openingMinor = BigInt(Math.round(dto.openingBalanceMinor ?? 0));
    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const account = await tx.financeAccount.create({
        data: {
          userId,
          name: dto.name,
          type: dto.type ?? FinanceAccountType.BANK,
          currency: dto.currency ?? "INR",
          openingBalanceMinor: openingMinor,
          currentBalanceMinor: openingMinor,
          color: dto.color,
          iconKey: dto.iconKey,
          sortOrder: dto.sortOrder ?? 0,
        },
      });

      const logged = await appendChange(tx, {
        userId,
        entityType: "finance_account",
        entityId: account.id,
        operation: ChangeOperation.CREATE,
        version: account.version,
        payload: accountChangePayload(account),
      });
      highestCursor = logged.cursor;

      return formatAccountResponse(account);
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });
    return created;
  }

  async getAccounts(userId: string, includeArchived = false) {
    const where: any = { userId, deletedAt: null };
    if (!includeArchived) {
      where.isArchived = false;
    }

    const accounts = await this.prisma.financeAccount.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    return accounts.map(formatAccountResponse);
  }

  async getAccountById(userId: string, id: string) {
    const account = await this.prisma.financeAccount.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!account) {
      throw new NotFoundException(`Finance account with ID '${id}' not found.`);
    }

    return formatAccountResponse(account);
  }

  async updateAccount(userId: string, id: string, dto: UpdateAccountDto) {
    const existing = await this.prisma.financeAccount.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Finance account with ID '${id}' not found.`);
    }

    let highestCursor: bigint | undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const account = await tx.financeAccount.update({
        where: { id },
        data: {
          name: dto.name,
          type: dto.type,
          currency: dto.currency,
          color: dto.color,
          iconKey: dto.iconKey,
          isArchived: dto.isArchived,
          sortOrder: dto.sortOrder,
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        userId,
        entityType: "finance_account",
        entityId: account.id,
        operation: ChangeOperation.UPDATE,
        version: account.version,
        payload: accountChangePayload(account),
      });
      highestCursor = logged.cursor;

      return formatAccountResponse(account);
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });
    return updated;
  }

  async deleteAccount(userId: string, id: string) {
    const existing = await this.prisma.financeAccount.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Finance account with ID '${id}' not found.`);
    }

    let highestCursor: bigint | undefined;

    const deleted = await this.prisma.$transaction(async (tx) => {
      const account = await tx.financeAccount.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        userId,
        entityType: "finance_account",
        entityId: account.id,
        operation: ChangeOperation.DELETE,
        version: account.version,
        payload: {},
      });
      highestCursor = logged.cursor;

      return { success: true };
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });
    return deleted;
  }
}
