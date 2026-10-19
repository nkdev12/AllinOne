import {
  BadRequestException,
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

/**
 * Every money read path — `getCashFlowSummary`, `AnalyticsService.getNetWorth`,
 * `BudgetsService` — matches the currency exactly, so a row stored as "inr" is
 * invisible to all of them and the dashboard reports zero for real money.
 * Normalising at the single write boundary keeps the readers as cheap exact
 * upper-case matches instead of making every one of them case-proof.
 */
import { normaliseCurrency } from "../finance.helpers";
export { normaliseCurrency };

/**
 * Minor units arrive as JSON numbers, and `BigInt()` throws a `RangeError` on
 * anything fractional or non-finite — which would surface as a 500 instead of a
 * 400. Reject those before the conversion, the same way transactions do.
 */
export function toMinorUnits(
  value: number | undefined | null,
  field: string,
): bigint {
  if (value === undefined || value === null) {
    return BigInt(0);
  }
  if (!Number.isSafeInteger(value)) {
    throw new BadRequestException(
      `${field} must be a whole number of minor units within the safe integer range.`,
    );
  }
  return BigInt(value);
}

function formatAccountResponse(account: any) {
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
    const openingMinor = toMinorUnits(
      dto.openingBalanceMinor,
      "openingBalanceMinor",
    );
    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const account = await tx.financeAccount.create({
        data: {
          userId,
          name: dto.name,
          type: dto.type ?? FinanceAccountType.BANK,
          currency: normaliseCurrency(dto.currency),
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

  /**
   * Re-labelling the currency of an account that already holds money silently
   * re-denominates it: 100000 minor units of INR stamped "USD" reads back as
   * $1000 for what was Rs 1000 (an 83x overstatement) and orphans every
   * transaction already filed in the old code. Same intent as the rule that
   * forbids the edit on groups in `groups.service.ts`.
   */
  private async assertCurrencyChangeAllowed(
    userId: string,
    accountId: string,
    existing: {
      currentBalanceMinor: bigint;
      openingBalanceMinor: bigint;
    },
    currentCurrency: string,
    nextCurrency: string,
  ) {
    const [transactionCount, recurringRuleCount] = await Promise.all([
      this.prisma.financeTransaction.count({
        where: { accountId, userId, deletedAt: null },
      }),
      this.prisma.financeRecurringRule.count({
        where: { accountId, userId, deletedAt: null },
      }),
    ]);

    const reDenominatesBalance =
      existing.currentBalanceMinor !== existing.openingBalanceMinor;

    if (
      transactionCount > 0 ||
      recurringRuleCount > 0 ||
      reDenominatesBalance
    ) {
      throw new BadRequestException(
        `Cannot switch an account from ${currentCurrency} to ${nextCurrency} once it has transactions, recurring rules or a moved balance. Create a new ${nextCurrency} account and transfer the funds instead.`,
      );
    }
  }

  async updateAccount(userId: string, id: string, dto: UpdateAccountDto) {
    const existing = await this.prisma.financeAccount.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Finance account with ID '${id}' not found.`);
    }

    const storedCurrency = normaliseCurrency(existing.currency);
    const currency =
      dto.currency === undefined ? undefined : normaliseCurrency(dto.currency);

    if (currency !== undefined && currency !== storedCurrency) {
      await this.assertCurrencyChangeAllowed(
        userId,
        id,
        existing,
        storedCurrency,
        currency,
      );
    }

    let highestCursor: bigint | undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const account = await tx.financeAccount.update({
        where: { id },
        data: {
          name: dto.name,
          type: dto.type,
          currency,
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
