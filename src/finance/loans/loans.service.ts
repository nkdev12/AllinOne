import { Injectable, NotFoundException, Optional } from "@nestjs/common";
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
    const principalAmountMinor = BigInt(Math.round(dto.principalAmountMinor));
    const remainingAmountMinor = BigInt(
      Math.round(dto.remainingAmountMinor ?? dto.principalAmountMinor),
    );
    const isSettled = remainingAmountMinor <= 0n;
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
          dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
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

    const repaymentMinor = BigInt(Math.round(dto.amountMinor));
    let newRemaining = existing.remainingAmountMinor - repaymentMinor;
    if (newRemaining < 0n) {
      newRemaining = 0n;
    }
    const isSettled = newRemaining === 0n;
    let highestCursor: bigint | undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const loan = await tx.financeLoan.update({
        where: { id },
        data: {
          remainingAmountMinor: newRemaining,
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
          ? BigInt(Math.round(dto.principalAmountMinor))
          : existing.principalAmountMinor;

      const remaining =
        dto.remainingAmountMinor !== undefined
          ? BigInt(Math.round(dto.remainingAmountMinor))
          : existing.remainingAmountMinor;

      const isSettled =
        dto.isSettled !== undefined ? dto.isSettled : remaining <= 0n;

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
            ? { dueDate: dto.dueDate ? new Date(dto.dueDate) : null }
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
