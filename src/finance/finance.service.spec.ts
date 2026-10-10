import { Test, TestingModule } from "@nestjs/testing";
import { AccountsService } from "./accounts/accounts.service";
import { CategoriesService } from "./categories/categories.service";
import { TransactionsService } from "./transactions/transactions.service";
import { BudgetsService } from "./budgets/budgets.service";
import { GoalsService } from "./goals/goals.service";
import { RecurringService } from "./recurring/recurring.service";
import { GroupsService } from "./groups/groups.service";
import { TripsService } from "./trips/trips.service";
import { LoansService } from "./loans/loans.service";
import { AnalyticsService } from "./analytics/analytics.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import {
  ChangeOperation,
  FinanceAccountType,
  FinanceBudgetPeriod,
  FinanceLoanType,
  FinanceRecurringFrequency,
  FinanceSplitType,
  FinanceTransactionType,
} from "@prisma/client";
import { BadRequestException, NotFoundException } from "@nestjs/common";

describe("Finance Services", () => {
  const userId = "user-123";
  const accountId = "acc-456";
  const toAccountId = "acc-789";
  const categoryId = "cat-001";
  const txId = "tx-999";
  const budgetId = "bgt-111";
  const goalId = "gol-222";
  const ruleId = "rul-333";
  const groupId = "grp-444";
  const expenseId = "exp-555";
  const settlementId = "set-666";
  const tripId = "trp-777";
  const itineraryId = "iti-888";
  const loanId = "loan-101";

  let accountsService: AccountsService;
  let categoriesService: CategoriesService;
  let transactionsService: TransactionsService;
  let budgetsService: BudgetsService;
  let goalsService: GoalsService;
  let recurringService: RecurringService;
  let groupsService: GroupsService;
  let tripsService: TripsService;
  let loansService: LoansService;
  let analyticsService: AnalyticsService;
  let prismaService: any;

  beforeEach(async () => {
    let cursorCounter = BigInt(0);

    const txMock = {
      financeAccount: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: accountId,
            userId,
            ...data,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        ),
        findFirst: jest.fn().mockResolvedValue({
          id: accountId,
          userId,
          name: "Main Bank",
          type: FinanceAccountType.BANK,
          currency: "INR",
          openingBalanceMinor: BigInt(50000),
          currentBalanceMinor: BigInt(50000),
          deletedAt: null,
          version: 1,
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          let delta = BigInt(0);
          if (data.currentBalanceMinor?.increment) {
            delta = data.currentBalanceMinor.increment;
          }
          return Promise.resolve({
            id: where.id,
            userId,
            name: data.name ?? "Updated Account",
            type: data.type ?? FinanceAccountType.BANK,
            currency: "INR",
            openingBalanceMinor: BigInt(50000),
            currentBalanceMinor: BigInt(50000) + delta,
            version: 2,
            deletedAt: data.deletedAt ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }),
      },
      financeTransaction: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: txId,
            userId,
            ...data,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        ),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({
            id: where.id,
            userId,
            ...data,
            version: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
      },
      financeCategory: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: categoryId,
            userId,
            ...data,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        ),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({
            id: where.id,
            userId,
            ...data,
            version: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
      },
      financeBudget: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: budgetId,
            userId,
            ...data,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        ),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({
            id: where.id,
            userId,
            amountMinor: BigInt(1000000),
            period: FinanceBudgetPeriod.MONTHLY,
            ...data,
            version: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
      },
      financeSavingsGoal: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: goalId,
            userId,
            ...data,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        ),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({
            id: where.id,
            userId,
            name: "MacBook",
            targetAmountMinor: BigInt(6000000),
            currentAmountMinor: BigInt(6000000),
            isCompleted: true,
            ...data,
            version: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
      },
      financeRecurringRule: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: ruleId,
            userId,
            ...data,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        ),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({
            id: where.id,
            userId,
            ...data,
            version: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
      },
      financeGroup: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: groupId,
            ...data,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        ),
        findFirst: jest.fn().mockResolvedValue({
          id: groupId,
          ownerId: userId,
          name: "Goa Trip",
          currency: "INR",
          version: 1,
          isArchived: false,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({
            id: where.id,
            ownerId: userId,
            ...data,
            version: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
      },
      financeSharedExpense: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: expenseId,
            ...data,
            version: 1,
            shares: (data.shares?.create || []).map((s: any, idx: number) => ({
              id: `share-${idx}`,
              ...s,
            })),
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        ),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({
            id: where.id,
            ...data,
            version: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
        findFirst: jest.fn().mockResolvedValue({
          id: expenseId,
          groupId,
          paidByUserId: "Alice",
          title: "Dinner",
          totalAmountMinor: BigInt(30000),
          deletedAt: null,
        }),
      },
      financeSettlement: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: settlementId,
            ...data,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        ),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({
            id: where.id,
            ...data,
            version: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
        findFirst: jest.fn().mockResolvedValue({
          id: settlementId,
          groupId,
          fromUserId: "Bob",
          toUserId: "Alice",
          amountMinor: BigInt(10000),
          deletedAt: null,
        }),
      },
      financeTrip: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: tripId,
            ...data,
            version: 1,
            itineraryItems: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        ),
        findFirst: jest.fn().mockResolvedValue({
          id: tripId,
          ownerId: userId,
          title: "Japan 2026",
          destinations: ["Tokyo", "Kyoto"],
          startDate: new Date("2026-11-01"),
          endDate: new Date("2026-11-15"),
          baseCurrency: "JPY",
          totalBudgetMinor: BigInt(25000000),
          isArchived: false,
          deletedAt: null,
          version: 1,
          itineraryItems: [
            {
              id: itineraryId,
              tripId,
              dayIndex: 1,
              title: "Temple Tour",
              plannedCostMinor: BigInt(500000),
              sortOrder: 0,
              deletedAt: null,
            },
          ],
        }),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({
            id: where.id,
            ownerId: userId,
            ...data,
            version: 2,
            itineraryItems: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
      },
      financeTripItinerary: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: itineraryId,
            ...data,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        ),
        findFirst: jest.fn().mockResolvedValue({
          id: itineraryId,
          tripId,
          dayIndex: 1,
          title: "Temple Tour",
          plannedCostMinor: BigInt(500000),
          deletedAt: null,
        }),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({
            id: where.id,
            tripId,
            ...data,
            version: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
      },
      financeLoan: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: loanId,
            userId,
            ...data,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }),
        ),
        findFirst: jest.fn().mockResolvedValue({
          id: loanId,
          userId,
          type: FinanceLoanType.LENT,
          counterpartyName: "Bob",
          counterpartyContact: "+919876543210",
          principalAmountMinor: BigInt(500000),
          remainingAmountMinor: BigInt(500000),
          dueDate: new Date(),
          notes: "Trip share",
          isSettled: false,
          deletedAt: null,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({
            id: where.id,
            userId,
            type: FinanceLoanType.LENT,
            counterpartyName: "Bob",
            counterpartyContact: "+919876543210",
            principalAmountMinor: BigInt(500000),
            remainingAmountMinor: BigInt(300000),
            dueDate: new Date(),
            notes: "Trip share",
            isSettled: false,
            ...data,
            version: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
      },
      change: {
        create: jest.fn().mockImplementation(({ data }) => {
          cursorCounter += BigInt(1);
          return Promise.resolve({
            id: "change-1",
            cursor: cursorCounter,
            ...data,
          });
        }),
      },
      syncCursor: {
        findUnique: jest.fn().mockResolvedValue({ seq: cursorCounter }),
        upsert: jest.fn().mockImplementation(() => {
          cursorCounter += BigInt(1);
          return Promise.resolve({ seq: cursorCounter });
        }),
        update: jest.fn().mockImplementation(() => {
          cursorCounter += BigInt(1);
          return Promise.resolve({ seq: cursorCounter });
        }),
      },
    };

    prismaService = {
      ...txMock,
      $transaction: jest.fn().mockImplementation((fn) => fn(txMock)),
      financeAccount: {
        ...txMock.financeAccount,
        findFirst: jest.fn().mockResolvedValue({
          id: accountId,
          userId,
          name: "Main Bank",
          type: FinanceAccountType.BANK,
          currency: "INR",
          openingBalanceMinor: BigInt(100000),
          currentBalanceMinor: BigInt(100000),
          isArchived: false,
          deletedAt: null,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: accountId,
            userId,
            name: "Main Bank",
            type: FinanceAccountType.BANK,
            currency: "INR",
            openingBalanceMinor: BigInt(100000),
            currentBalanceMinor: BigInt(100000),
            isArchived: false,
            deletedAt: null,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
      },
      financeCategory: {
        ...txMock.financeCategory,
        count: jest.fn().mockResolvedValue(10),
        findMany: jest.fn().mockResolvedValue([
          {
            id: categoryId,
            userId,
            name: "Groceries",
            type: FinanceTransactionType.EXPENSE,
            isSystem: false,
            deletedAt: null,
            version: 1,
          },
        ]),
        findFirst: jest.fn().mockResolvedValue({
          id: categoryId,
          userId,
          name: "Groceries",
          type: FinanceTransactionType.EXPENSE,
          isSystem: false,
          deletedAt: null,
          version: 1,
        }),
      },
      financeTransaction: {
        ...txMock.financeTransaction,
        findFirst: jest.fn().mockResolvedValue({
          id: txId,
          userId,
          accountId,
          toAccountId: null,
          categoryId,
          type: FinanceTransactionType.EXPENSE,
          amountMinor: BigInt(25000),
          currency: "INR",
          title: "Supermarket",
          transactionDate: new Date(),
          deletedAt: null,
          version: 1,
        }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: txId,
            userId,
            accountId,
            toAccountId: null,
            categoryId,
            type: FinanceTransactionType.EXPENSE,
            amountMinor: BigInt(25000),
            currency: "INR",
            title: "Supermarket",
            transactionDate: new Date(),
            deletedAt: null,
            version: 1,
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
      financeBudget: {
        ...txMock.financeBudget,
        findMany: jest.fn().mockResolvedValue([
          {
            id: budgetId,
            userId,
            categoryId: null,
            amountMinor: BigInt(1000000),
            period: FinanceBudgetPeriod.MONTHLY,
            alertAt80: true,
            alertAt100: true,
            deletedAt: null,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
        findFirst: jest.fn().mockResolvedValue({
          id: budgetId,
          userId,
          categoryId: null,
          amountMinor: BigInt(1000000),
          period: FinanceBudgetPeriod.MONTHLY,
          alertAt80: true,
          alertAt100: true,
          deletedAt: null,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      financeSavingsGoal: {
        ...txMock.financeSavingsGoal,
        findMany: jest.fn().mockResolvedValue([
          {
            id: goalId,
            userId,
            name: "MacBook",
            targetAmountMinor: BigInt(6000000),
            currentAmountMinor: BigInt(1000000),
            isCompleted: false,
            deletedAt: null,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
        findFirst: jest.fn().mockResolvedValue({
          id: goalId,
          userId,
          name: "MacBook",
          targetAmountMinor: BigInt(6000000),
          currentAmountMinor: BigInt(1000000),
          isCompleted: false,
          deletedAt: null,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      financeRecurringRule: {
        ...txMock.financeRecurringRule,
        findMany: jest.fn().mockResolvedValue([
          {
            id: ruleId,
            userId,
            accountId,
            categoryId: null,
            type: FinanceTransactionType.EXPENSE,
            amountMinor: BigInt(64900),
            title: "Netflix",
            frequency: FinanceRecurringFrequency.MONTHLY,
            interval: 1,
            startDate: new Date(),
            nextDueDate: new Date(),
            autoGenerate: true,
            deletedAt: null,
            version: 1,
          },
        ]),
        findFirst: jest.fn().mockResolvedValue({
          id: ruleId,
          userId,
          accountId,
          categoryId: null,
          type: FinanceTransactionType.EXPENSE,
          amountMinor: BigInt(64900),
          title: "Netflix",
          frequency: FinanceRecurringFrequency.MONTHLY,
          interval: 1,
          startDate: new Date(),
          nextDueDate: new Date(),
          autoGenerate: true,
          deletedAt: null,
          version: 1,
        }),
      },
      financeGroup: {
        ...txMock.financeGroup,
        findMany: jest.fn().mockResolvedValue([
          {
            id: groupId,
            ownerId: userId,
            name: "Goa Trip",
            currency: "INR",
            version: 1,
            isArchived: false,
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
        findFirst: txMock.financeGroup.findFirst,
      },
      financeSharedExpense: {
        ...txMock.financeSharedExpense,
        findMany: jest.fn().mockResolvedValue([
          {
            id: expenseId,
            groupId,
            paidByUserId: "Alice",
            title: "Dinner",
            totalAmountMinor: BigInt(30000),
            currency: "INR",
            splitType: FinanceSplitType.EQUAL,
            date: new Date(),
            shares: [
              { userId: "Alice", owedAmountMinor: BigInt(10000) },
              { userId: "Bob", owedAmountMinor: BigInt(10000) },
              { userId: "Charlie", owedAmountMinor: BigInt(10000) },
            ],
            deletedAt: null,
          },
        ]),
        findFirst: txMock.financeSharedExpense.findFirst,
      },
      financeSettlement: {
        ...txMock.financeSettlement,
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: txMock.financeSettlement.findFirst,
      },
      financeTrip: {
        ...txMock.financeTrip,
        findMany: jest.fn().mockResolvedValue([
          {
            id: tripId,
            ownerId: userId,
            title: "Japan 2026",
            destinations: ["Tokyo", "Kyoto"],
            startDate: new Date("2026-11-01"),
            endDate: new Date("2026-11-15"),
            baseCurrency: "JPY",
            totalBudgetMinor: BigInt(25000000),
            isArchived: false,
            deletedAt: null,
            version: 1,
            itineraryItems: [],
          },
        ]),
        findFirst: txMock.financeTrip.findFirst,
      },
      financeTripItinerary: {
        ...txMock.financeTripItinerary,
        findMany: jest.fn().mockResolvedValue([
          {
            id: itineraryId,
            tripId,
            dayIndex: 1,
            title: "Temple Tour",
            plannedCostMinor: BigInt(500000),
            sortOrder: 0,
            deletedAt: null,
          },
        ]),
        findFirst: txMock.financeTripItinerary.findFirst,
      },
      financeLoan: {
        ...txMock.financeLoan,
        findMany: jest.fn().mockResolvedValue([
          {
            id: loanId,
            userId,
            type: FinanceLoanType.LENT,
            counterpartyName: "Bob",
            counterpartyContact: "+919876543210",
            principalAmountMinor: BigInt(500000),
            remainingAmountMinor: BigInt(500000),
            dueDate: new Date(),
            notes: "Trip share",
            isSettled: false,
            deletedAt: null,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
        findFirst: txMock.financeLoan.findFirst,
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountsService,
        CategoriesService,
        TransactionsService,
        BudgetsService,
        GoalsService,
        RecurringService,
        GroupsService,
        TripsService,
        LoansService,
        AnalyticsService,
        { provide: PrismaService, useValue: prismaService },
        {
          provide: SyncNotificationService,
          useValue: { notifyMutation: jest.fn() },
        },
      ],
    }).compile();

    accountsService = module.get<AccountsService>(AccountsService);
    categoriesService = module.get<CategoriesService>(CategoriesService);
    transactionsService = module.get<TransactionsService>(TransactionsService);
    budgetsService = module.get<BudgetsService>(BudgetsService);
    goalsService = module.get<GoalsService>(GoalsService);
    recurringService = module.get<RecurringService>(RecurringService);
    groupsService = module.get<GroupsService>(GroupsService);
    tripsService = module.get<TripsService>(TripsService);
    loansService = module.get<LoansService>(LoansService);
    analyticsService = module.get<AnalyticsService>(AnalyticsService);
  });

  describe("AccountsService", () => {
    it("creates an account and logs a CREATE change", async () => {
      const result = await accountsService.createAccount(userId, {
        name: "HDFC Savings",
        type: FinanceAccountType.SAVINGS,
        currency: "INR",
        openingBalanceMinor: 50000,
      });

      expect(result.id).toBe(accountId);
      expect(result.openingBalanceMinor).toBe(50000);
      expect(result.currentBalanceMinor).toBe(50000);
      expect(typeof result.openingBalanceMinor).toBe("number");
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_account",
            operation: ChangeOperation.CREATE,
          }),
        }),
      );
    });

    it("lists accounts for user formatting BigInt to Number", async () => {
      const list = await accountsService.getAccounts(userId);
      expect(list.length).toBe(1);
      expect(list[0].openingBalanceMinor).toBe(100000);
      expect(typeof list[0].currentBalanceMinor).toBe("number");
    });
  });

  describe("TransactionsService", () => {
    it("creates an expense transaction and decrements account balance", async () => {
      const result = await transactionsService.createTransaction(userId, {
        accountId,
        type: FinanceTransactionType.EXPENSE,
        amountMinor: 25000,
        currency: "INR",
        title: "Grocery run",
        transactionDate: "2026-10-10T12:00:00.000Z",
      });

      expect(result.id).toBe(txId);
      expect(result.amountMinor).toBe(25000);

      // Verifies account balance decrement
      expect(prismaService.financeAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            currentBalanceMinor: { increment: BigInt(-25000) },
          }),
        }),
      );

      // Verifies both transaction CREATE and account UPDATE were logged
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_transaction",
            operation: ChangeOperation.CREATE,
          }),
        }),
      );
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_account",
            operation: ChangeOperation.UPDATE,
          }),
        }),
      );
    });

    it("creates an income transaction and increments account balance", async () => {
      await transactionsService.createTransaction(userId, {
        accountId,
        type: FinanceTransactionType.INCOME,
        amountMinor: 50000,
        currency: "INR",
        title: "Bonus",
        transactionDate: "2026-10-10T12:00:00.000Z",
      });

      expect(prismaService.financeAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            currentBalanceMinor: { increment: BigInt(50000) },
          }),
        }),
      );
    });

    it("creates a transfer transaction updating both accounts", async () => {
      prismaService.financeAccount.findFirst
        .mockResolvedValueOnce({
          id: accountId,
          userId,
          currency: "INR",
        })
        .mockResolvedValueOnce({
          id: toAccountId,
          userId,
          currency: "INR",
        });

      await transactionsService.createTransaction(userId, {
        accountId,
        toAccountId,
        type: FinanceTransactionType.TRANSFER,
        amountMinor: 10000,
        currency: "INR",
        title: "Bank Transfer",
        transactionDate: "2026-10-10T12:00:00.000Z",
      });

      expect(prismaService.financeAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            currentBalanceMinor: { increment: BigInt(-10000) },
          }),
        }),
      );
      expect(prismaService.financeAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: toAccountId },
          data: expect.objectContaining({
            currentBalanceMinor: { increment: BigInt(10000) },
          }),
        }),
      );
    });

    it("throws NotFoundException when account does not exist", async () => {
      prismaService.financeAccount.findFirst.mockResolvedValueOnce(null);

      await expect(
        transactionsService.createTransaction(userId, {
          accountId: "nonexistent",
          type: FinanceTransactionType.EXPENSE,
          amountMinor: 1000,
          currency: "INR",
          title: "Test",
          transactionDate: "2026-10-10T12:00:00.000Z",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("reverses balance when deleting a transaction", async () => {
      await transactionsService.deleteTransaction(userId, txId);

      // For an EXPENSE, deleting it should increment the account by amountMinor
      expect(prismaService.financeAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            currentBalanceMinor: { increment: BigInt(25000) },
          }),
        }),
      );

      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_transaction",
            operation: ChangeOperation.DELETE,
          }),
        }),
      );
    });
  });

  describe("CategoriesService", () => {
    it("returns categories and prevents deleting system category", async () => {
      prismaService.financeCategory.findFirst.mockResolvedValueOnce({
        id: categoryId,
        userId,
        name: "Salary",
        isSystem: true,
      });

      await expect(
        categoriesService.deleteCategory(userId, categoryId),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("BudgetsService", () => {
    it("creates a budget and formats BigInt to Number", async () => {
      const budget = await budgetsService.createBudget(userId, {
        amountMinor: 1000000,
        period: FinanceBudgetPeriod.MONTHLY,
      });

      expect(budget.id).toBe(budgetId);
      expect(budget.amountMinor).toBe(1000000);
      expect(typeof budget.amountMinor).toBe("number");
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_budget",
            operation: ChangeOperation.CREATE,
          }),
        }),
      );
    });

    it("calculates spending and percentUsed in getBudgetsWithSpending", async () => {
      // Mock expense transaction within month: 250 INR (25,000 paise)
      prismaService.financeTransaction.findMany.mockResolvedValueOnce([
        {
          id: txId,
          accountId,
          categoryId: null,
          type: FinanceTransactionType.EXPENSE,
          amountMinor: BigInt(250000),
          isExcludedFromBudget: false,
          transactionDate: new Date(),
        },
      ]);

      const results = await budgetsService.getBudgetsWithSpending(userId);
      expect(results.length).toBe(1);
      expect(results[0].amountMinor).toBe(1000000);
      expect(results[0].spentMinor).toBe(250000);
      expect(results[0].remainingMinor).toBe(750000);
      expect(results[0].percentUsed).toBe(25.0);
    });

    it("soft deletes a budget and records DELETE oplog", async () => {
      await budgetsService.deleteBudget(userId, budgetId);

      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_budget",
            operation: ChangeOperation.DELETE,
          }),
        }),
      );
    });
  });

  describe("GoalsService", () => {
    it("creates a goal and deposits funds towards completion", async () => {
      const goal = await goalsService.createGoal(userId, {
        name: "MacBook Air",
        targetAmountMinor: 6000000,
        currentAmountMinor: 1000000,
      });

      expect(goal.id).toBe(goalId);
      expect(goal.targetAmountMinor).toBe(6000000);
      expect(goal.currentAmountMinor).toBe(1000000);
      expect(goal.isCompleted).toBe(false);

      // Deposit 5,000,000 paise to hit 6,000,000 paise target
      const updated = await goalsService.depositToGoal(userId, goalId, {
        amountMinor: 5000000,
      });

      expect(updated.currentAmountMinor).toBe(6000000);
      expect(updated.isCompleted).toBe(true);
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_savings_goal",
            operation: ChangeOperation.UPDATE,
          }),
        }),
      );
    });
  });

  describe("RecurringService", () => {
    it("creates recurring rule and logs CREATE change", async () => {
      const rule = await recurringService.createRecurringRule(userId, {
        accountId,
        type: FinanceTransactionType.EXPENSE,
        amountMinor: 64900,
        title: "Netflix",
        frequency: FinanceRecurringFrequency.MONTHLY,
        interval: 1,
        startDate: "2026-10-01T00:00:00.000Z",
      });

      expect(rule.id).toBe(ruleId);
      expect(rule.amountMinor).toBe(64900);
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_recurring_rule",
            operation: ChangeOperation.CREATE,
          }),
        }),
      );
    });

    it("processes due recurring rules and generates transactions", async () => {
      const result = await recurringService.processDueRules(userId);
      expect(result.processed).toBe(1);

      // Transaction created
      expect(prismaService.financeTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId,
            accountId,
            amountMinor: BigInt(64900),
            title: "Netflix",
          }),
        }),
      );

      // Account balance deducted
      expect(prismaService.financeAccount.update).toHaveBeenCalled();

      // Rule nextDueDate updated
      expect(prismaService.financeRecurringRule.update).toHaveBeenCalled();
    });
  });

  describe("GroupsService", () => {
    it("creates a group and logs a CREATE change", async () => {
      const group = await groupsService.createGroup(userId, {
        name: "Goa Trip 2026",
        currency: "INR",
        description: "Fun trip",
      });

      expect(group.id).toBe(groupId);
      expect(group.name).toBe("Goa Trip 2026");
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_group",
            operation: ChangeOperation.CREATE,
          }),
        }),
      );
    });

    it("adds shared expense with shares and formats BigInt to Number", async () => {
      const expense = await groupsService.addSharedExpense(userId, groupId, {
        title: "Dinner",
        totalAmountMinor: 30000,
        currency: "INR",
        paidByUserId: "Alice",
        date: "2026-10-10T20:00:00.000Z",
        splitType: FinanceSplitType.EQUAL,
        shares: [
          { userId: "Alice", owedAmountMinor: 10000 },
          { userId: "Bob", owedAmountMinor: 10000 },
          { userId: "Charlie", owedAmountMinor: 10000 },
        ],
      });

      expect(expense.id).toBe(expenseId);
      expect(expense.totalAmountMinor).toBe(30000);
      expect(expense.shares).toHaveLength(3);
      expect(expense.shares[0].owedAmountMinor).toBe(10000);
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_shared_expense",
            operation: ChangeOperation.CREATE,
          }),
        }),
      );
    });

    it("calculates group balances and simplifies debts using Min-Cash-Flow algorithm", async () => {
      const result = await groupsService.getGroupBalancesAndSimplifiedDebts(
        userId,
        groupId,
      );

      // Alice paid 30000, owes 10000 -> net +20000
      // Bob paid 0, owes 10000 -> net -10000
      // Charlie paid 0, owes 10000 -> net -10000
      expect(result.balances["Alice"]).toBe(20000);
      expect(result.balances["Bob"]).toBe(-10000);
      expect(result.balances["Charlie"]).toBe(-10000);

      // Min-cash-flow should settle Bob -> Alice (10000) and Charlie -> Alice (10000)
      expect(result.simplifiedDebts).toHaveLength(2);
      const bobSettlement = result.simplifiedDebts.find(
        (d) => d.fromUserId === "Bob",
      );
      const charlieSettlement = result.simplifiedDebts.find(
        (d) => d.fromUserId === "Charlie",
      );

      expect(bobSettlement).toBeDefined();
      expect(bobSettlement?.toUserId).toBe("Alice");
      expect(bobSettlement?.amountMinor).toBe(10000);

      expect(charlieSettlement).toBeDefined();
      expect(charlieSettlement?.toUserId).toBe("Alice");
      expect(charlieSettlement?.amountMinor).toBe(10000);
    });
  });

  describe("TripsService", () => {
    it("creates a trip and logs a CREATE change", async () => {
      const trip = await tripsService.createTrip(userId, {
        title: "Japan 2026",
        destinations: ["Tokyo", "Kyoto"],
        startDate: "2026-11-01T00:00:00.000Z",
        endDate: "2026-11-15T00:00:00.000Z",
        baseCurrency: "JPY",
        totalBudgetMinor: 25000000,
      });

      expect(trip.id).toBe(tripId);
      expect(trip.title).toBe("Japan 2026");
      expect(trip.totalBudgetMinor).toBe(25000000);
      expect(typeof trip.totalBudgetMinor).toBe("number");
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_trip",
            operation: ChangeOperation.CREATE,
          }),
        }),
      );
    });

    it("adds itinerary item and calculates trip budget stats", async () => {
      const item = await tripsService.addItineraryItem(userId, tripId, {
        dayIndex: 1,
        title: "Temple Tour",
        plannedCostMinor: 500000,
      });

      expect(item.id).toBe(itineraryId);
      expect(item.plannedCostMinor).toBe(500000);

      const stats = await tripsService.getTripStats(userId, tripId);
      expect(stats.tripId).toBe(tripId);
      expect(stats.totalBudgetMinor).toBe(25000000);
      expect(stats.currency).toBe("JPY");
    });
  });

  describe("AnalyticsService", () => {
    it("computes spending breakdown by category and percentages", async () => {
      const breakdown = await analyticsService.getSpendingByCategory(userId);
      expect(breakdown).toHaveProperty("totalSpendingMinor");
      expect(breakdown).toHaveProperty("categories");
      expect(Array.isArray(breakdown.categories)).toBe(true);
    });

    it("computes cash flow and net worth", async () => {
      const cashFlow = await analyticsService.getCashFlow(userId, 2026);
      expect(cashFlow.months).toHaveLength(12);
      expect(cashFlow.months[0]).toHaveProperty("incomeMinor");
      expect(cashFlow.months[0]).toHaveProperty("expenseMinor");

      const netWorth = await analyticsService.getNetWorth(userId);
      expect(netWorth).toHaveProperty("totalAssetsMinor");
      expect(netWorth).toHaveProperty("totalLiabilitiesMinor");
      expect(netWorth).toHaveProperty("netWorthMinor");
    });

    it("exports transactions in CSV and JSON formats", async () => {
      const jsonExport = await analyticsService.exportTransactions(
        userId,
        "json",
      );
      expect(jsonExport.format).toBe("json");
      expect(Array.isArray(jsonExport.transactions)).toBe(true);

      const csvExport = await analyticsService.exportTransactions(
        userId,
        "csv",
      );
      expect(csvExport.format).toBe("csv");
      expect(csvExport.contentType).toBe("text/csv");
      expect(typeof csvExport.content).toBe("string");
      expect(csvExport.content).toContain("Date,Type,Title,Amount");
    });
  });

  describe("LoansService", () => {
    it("creates a lent loan and appends CREATE change", async () => {
      const result = await loansService.createLoan(userId, {
        type: FinanceLoanType.LENT,
        counterpartyName: "Bob",
        principalAmountMinor: 500000,
        notes: "Trip split",
      });

      expect(result.id).toBe(loanId);
      expect(result.principalAmountMinor).toBe(500000);
      expect(result.remainingAmountMinor).toBe(500000);
      expect(result.isSettled).toBe(false);
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_loan",
            operation: ChangeOperation.CREATE,
          }),
        }),
      );
    });

    it("lists all loans and filters by type or settled status", async () => {
      const loans = await loansService.getLoans(userId, {
        type: FinanceLoanType.LENT,
        isSettled: false,
      });

      expect(loans).toHaveLength(1);
      expect(loans[0].counterpartyName).toBe("Bob");
      expect(loans[0].principalAmountMinor).toBe(500000);
    });

    it("records a partial repayment and updates remaining balance", async () => {
      const result = await loansService.recordRepayment(userId, loanId, {
        amountMinor: 200000,
      });

      expect(result.id).toBe(loanId);
      expect(result.remainingAmountMinor).toBe(300000);
      expect(result.isSettled).toBe(false);
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_loan",
            operation: ChangeOperation.UPDATE,
          }),
        }),
      );
    });

    it("soft deletes a loan and logs DELETE change", async () => {
      const result = await loansService.deleteLoan(userId, loanId);
      expect(result).toEqual({ success: true });
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "finance_loan",
            operation: ChangeOperation.DELETE,
          }),
        }),
      );
    });
  });
});
