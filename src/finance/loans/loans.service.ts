import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import { CreateLoanDto } from "./dto/create-loan.dto";
import { UpdateLoanDto } from "./dto/update-loan.dto";
import { RecordRepaymentDto } from "./dto/record-repayment.dto";
import { appendChange } from "@/sync/change-cursor";
import { ChangeOperation, FinanceLoanType } from "@prisma/client";

export function formatLoanResponse(loan: any) {
  return {
    ...loan,
    principalAmountMinor: Number(loan.principalAmountMinor),
    remainingAmountMinor: Number(loan.remainingAmountMinor),
  };
}

/**
 * `BigInt()` on a non-integer throws `RangeError` and on `Infinity`/`NaN` the
 * request dies as a 500, so fence the value first and answer 400 (same guard the
 * transaction service uses).
 */
function toMinorUnits(value: number, field: string): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new BadRequestException(`${field} must be a safe integer.`);
  }
  return BigInt(value);
}

function toDateOrThrow(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} must be a valid ISO-8601 date.`);
  }
  return parsed;
}

/**
 * Resolve what a `$inc`/`$set` write actually left in the row.
 *
 * Prisma applies `{ decrement: n }` server-side and returns the post-update
 * document, so `posted` normally *is* the stored BigInt and already contains a
 * repayment that raced in between our read and our commit — which is the reason
 * the delta is written as an operator at all. A delegate that echoes the operator
 * object back instead of resolving it (the naive update mock in the shared service
 * harness; the account mock there does resolve) falls back to read + delta, so a
 * NaN amount never reaches the sync payload for every device to replay.
 */
function minorUnitsAfter(
  posted: unknown,
  before: bigint,
  delta: bigint,
): bigint {
  if (typeof posted === "bigint") return posted;
  if (typeof posted === "number" && Number.isSafeInteger(posted)) {
    return BigInt(posted);
  }
  return before + delta;
}

/** Outstanding above the amount borrowed is a bookkeeping error, not a loan. */
function assertRemainingWithinPrincipal(
  principalAmountMinor: bigint,
  remainingAmountMinor: bigint,
): void {
  if (remainingAmountMinor < 0n) {
    throw new BadRequestException(
      "remainingAmountMinor cannot be negative — record repayments instead.",
    );
  }
  if (remainingAmountMinor > principalAmountMinor) {
    throw new BadRequestException(
      "remainingAmountMinor cannot exceed principalAmountMinor.",
    );
  }
}

export function loanChangePayload(loan: any): Record<string, any> {
  return {
    type: loan.type,
    counterpartyName: loan.counterpartyName,
    counterpartyContact: loan.counterpartyContact ?? null,
    principalAmountMinor: Number(loan.principalAmountMinor),
    remainingAmountMinor: Number(loan.remainingAmountMinor),
    dueDate:
      loan.dueDate instanceof Date
        ? loan.dueDate.toISOString()
        : (loan.dueDate ?? null),
    notes: loan.notes ?? null,
    isSettled: loan.isSettled ?? false,
    createdAt:
      loan.createdAt instanceof Date
        ? loan.createdAt.toISOString()
        : (loan.createdAt ?? null),
    version: loan.version ?? 1,
  };
}

@Injectable()
export class LoansService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly syncNotifications?: SyncNotificationService,
  ) {}

  async createLoan(userId: string, dto: CreateLoanDto) {
    const principalAmountMinor = toMinorUnits(
      dto.principalAmountMinor,
      "principalAmountMinor",
    );
    const remainingAmountMinor =
      dto.remainingAmountMinor === undefined
        ? principalAmountMinor
        : toMinorUnits(dto.remainingAmountMinor, "remainingAmountMinor");
    if (principalAmountMinor <= 0n) {
      throw new BadRequestException("principalAmountMinor must be positive.");
    }
    assertRemainingWithinPrincipal(principalAmountMinor, remainingAmountMinor);
    // A loan booked with nothing outstanding is settled on day one; `remaining`
    // is the single source of truth for the flag here.
    const isSettled = remainingAmountMinor === 0n;
    const dueDate = dto.dueDate
      ? toDateOrThrow(dto.dueDate, "dueDate")
      : undefined;
    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const loan = await tx.financeLoan.create({
        data: {
          userId,
          type: dto.type,
          counterpartyName: dto.counterpartyName,
          counterpartyContact: dto.counterpartyContact,
          principalAmountMinor,
          remainingAmountMinor,
          dueDate,
          notes: dto.notes,
          isSettled,
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_loan",
        entityId: loan.id,
        operation: ChangeOperation.CREATE,
        version: loan.version,
        payload: loanChangePayload(loan),
        userId,
      });
      highestCursor = logged.cursor;

      return loan;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatLoanResponse(created);
  }

  async getLoans(
    userId: string,
    filter?: { type?: FinanceLoanType; isSettled?: boolean },
  ) {
    const loans = await this.prisma.financeLoan.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(filter?.type ? { type: filter.type } : {}),
        ...(filter?.isSettled !== undefined
          ? { isSettled: filter.isSettled }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return loans.map(formatLoanResponse);
  }

  async getLoanById(userId: string, id: string) {
    const loan = await this.prisma.financeLoan.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!loan) {
      throw new NotFoundException(`Loan with ID ${id} not found`);
    }
    return formatLoanResponse(loan);
  }

  async recordRepayment(userId: string, id: string, dto: RecordRepaymentDto) {
    const existing = await this.prisma.financeLoan.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException(`Loan with ID ${id} not found`);
    }

    const repaymentMinor = toMinorUnits(dto.amountMinor, "amountMinor");
    if (repaymentMinor <= 0n) {
      throw new BadRequestException("amountMinor must be greater than zero.");
    }
    if (repaymentMinor > existing.remainingAmountMinor) {
      // Overpayment used to be clamped to zero and the surplus vanished with no
      // record of it. The client already blocks this, so the server now says the
      // same thing instead of quietly eating the difference.
      throw new BadRequestException(
        "Repayment exceeds the outstanding balance of this loan.",
      );
    }
    let highestCursor: bigint | undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      // `$inc`-shaped write, not `existing.remainingAmountMinor - repaymentMinor`
      // written absolutely: two repayments read the same balance and the second
      // used to store the first's arithmetic, handing back a balance that was
      // never real. What Prisma returns is the post-decrement document.
      let loan = await tx.financeLoan.update({
        where: { id },
        data: {
          remainingAmountMinor: { decrement: repaymentMinor },
          version: { increment: 1 },
        },
      });

      const remainingAmountMinor = minorUnitsAfter(
        loan.remainingAmountMinor,
        existing.remainingAmountMinor,
        -repaymentMinor,
      );
      if (remainingAmountMinor < 0n) {
        // A concurrent repayment settled the balance after our read, which the
        // guard above could not see. Aborting keeps `remaining >= 0` true for the
        // row; clamping it to 0 would again throw away someone's money.
        throw new BadRequestException(
          "This repayment was overtaken by another one. Reload the loan.",
        );
      }
      const isSettled = remainingAmountMinor === 0n;
      if (Boolean(loan.isSettled) !== isSettled) {
        // Only the repayment that really clears the balance rewrites the flag.
        loan = await tx.financeLoan.update({
          where: { id },
          data: { isSettled },
        });
      }

      const postImage = { ...loan, remainingAmountMinor, isSettled };

      const logged = await appendChange(tx, {
        entityType: "finance_loan",
        entityId: postImage.id,
        operation: ChangeOperation.UPDATE,
        version: postImage.version,
        payload: loanChangePayload(postImage),
        userId,
      });
      highestCursor = logged.cursor;

      return postImage;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatLoanResponse(updated);
  }

  async updateLoan(userId: string, id: string, dto: UpdateLoanDto) {
    const existing = await this.prisma.financeLoan.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException(`Loan with ID ${id} not found`);
    }

    let highestCursor: bigint | undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const principal =
        dto.principalAmountMinor !== undefined
          ? toMinorUnits(dto.principalAmountMinor, "principalAmountMinor")
          : existing.principalAmountMinor;

      const remaining =
        dto.remainingAmountMinor !== undefined
          ? toMinorUnits(dto.remainingAmountMinor, "remainingAmountMinor")
          : existing.remainingAmountMinor;

      if (principal <= 0n) {
        throw new BadRequestException("principalAmountMinor must be positive.");
      }
      assertRemainingWithinPrincipal(principal, remaining);

      const isSettled =
        dto.isSettled !== undefined ? dto.isSettled : remaining === 0n;

      const loan = await tx.financeLoan.update({
        where: { id },
        data: {
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.counterpartyName !== undefined
            ? { counterpartyName: dto.counterpartyName }
            : {}),
          ...(dto.counterpartyContact !== undefined
            ? { counterpartyContact: dto.counterpartyContact }
            : {}),
          ...(dto.principalAmountMinor !== undefined
            ? { principalAmountMinor: principal }
            : {}),
          ...(dto.remainingAmountMinor !== undefined
            ? { remainingAmountMinor: remaining }
            : {}),
          ...(dto.dueDate !== undefined
            ? {
                dueDate: dto.dueDate
                  ? toDateOrThrow(dto.dueDate, "dueDate")
                  : null,
              }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          isSettled,
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_loan",
        entityId: loan.id,
        operation: ChangeOperation.UPDATE,
        version: loan.version,
        payload: loanChangePayload(loan),
        userId,
      });
      highestCursor = logged.cursor;

      return loan;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatLoanResponse(updated);
  }

  async deleteLoan(userId: string, id: string) {
    const existing = await this.prisma.financeLoan.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException(`Loan with ID ${id} not found`);
    }

    let highestCursor: bigint | undefined;

    await this.prisma.$transaction(async (tx) => {
      const loan = await tx.financeLoan.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_loan",
        entityId: loan.id,
        operation: ChangeOperation.DELETE,
        version: loan.version,
        payload: {},
        userId,
      });
      highestCursor = logged.cursor;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return { success: true };
  }
}
