import { BadRequestException, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { FinanceTransactionType } from "@prisma/client";
import {
  AccountsService,
  normaliseCurrency,
} from "./accounts/accounts.service";
import { CreateAccountDto } from "./accounts/dto/create-account.dto";
import {
  escapeRegex,
  TransactionsService,
} from "./transactions/transactions.service";
import { CreateTransactionDto } from "./transactions/dto/create-transaction.dto";
import { QueryTransactionsDto } from "./transactions/dto/query-transaction.dto";

const userId = "user-1";
const otherUserId = "user-2";
const uuid = "2f8e8c96-4a5b-4c11-9d3e-77f0a1c2b3d4";

/**
 * Supports the subset of Prisma `where` operators the finance services use, so
 * the assertions below describe what a row would really do on Mongo rather than
 * what a hand-written mock was told to return.
 */
function matchesWhere(row: any, where: any): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") {
      return (condition as any[]).some((alt) => matchesWhere(row, alt));
    }
    const value = row[key];
    if (
      condition &&
      typeof condition === "object" &&
      !(condition instanceof Date)
    ) {
      return Object.entries(condition as any).every(
        ([operator, rawOperand]: [string, any]) => {
          switch (operator) {
            case "in":
              return (rawOperand as any[]).includes(value);
            case "gte":
              return value >= rawOperand;
            case "lte":
              return value <= rawOperand;
            default:
              throw new Error(`unsupported operator ${operator}`);
          }
        },
      );
    }
    return value === condition;
  });
}

function createStore() {
  const state = {
    accounts: [] as any[],
    transactions: [] as any[],
    rules: [] as any[],
    changes: [] as any[],
    cursor: BigInt(0),
  };

  const bump = (row: any, data: any) => {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (key === "version" && (value as any)?.increment) {
        row.version += (value as any).increment;
      } else if (
        key.endsWith("BalanceMinor") &&
        (value as any)?.increment !== undefined
      ) {
        row[key] = row[key] + (value as any).increment;
      } else {
        row[key] = value;
      }
    }
  };

  const client: any = {
    $transaction: async (fn: any) => fn(client),
    financeAccount: {
      create: async ({ data }: any) => {
        const row = {
          id: `acc-${state.accounts.length + 1}`,
          isArchived: false,
          sortOrder: 0,
          version: 1,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.accounts.push(row);
        return row;
      },
      findFirst: async ({ where }: any) =>
        state.accounts.find((row) => matchesWhere(row, where)) ?? null,
      findMany: async ({ where }: any) =>
        state.accounts.filter((row) => matchesWhere(row, where ?? {})),
      update: async ({ where, data }: any) => {
        const row = state.accounts.find((account) => account.id === where.id);
        if (!row) throw new Error(`account ${where.id} is missing`);
        bump(row, data);
        return { ...row };
      },
    },
    financeTransaction: {
      create: async ({ data }: any) => {
        const row = {
          id: `tx-${state.transactions.length + 1}`,
          tags: [],
          version: 1,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.transactions.push(row);
        return row;
      },
      findFirst: async ({ where }: any) =>
        state.transactions.find((row) => matchesWhere(row, where)) ?? null,
      findMany: async ({ where }: any) =>
        state.transactions.filter((row) => matchesWhere(row, where ?? {})),
      update: async ({ where, data }: any) => {
        const row = state.transactions.find((tx) => tx.id === where.id);
        if (!row) throw new Error(`transaction ${where.id} is missing`);
        bump(row, data);
        return { ...row };
      },
      count: async ({ where }: any) =>
        state.transactions.filter((row) => matchesWhere(row, where)).length,
    },
    financeRecurringRule: {
      count: async ({ where }: any) =>
        state.rules.filter((row) => matchesWhere(row, where)).length,
    },
    syncCursor: {
      upsert: async () => {
        state.cursor += BigInt(1);
        return { seq: state.cursor };
      },
    },
    change: {
      create: async ({ data }: any) => {
        const row = { id: `chg-${state.changes.length + 1}`, ...data };
        state.changes.push(row);
        return row;
      },
    },
  };

  return { client, state };
}

function seedAccount(
  store: ReturnType<typeof createStore>,
  overrides: any = {},
) {
  const row = {
    id: "acc-1",
    userId,
    name: "Salary Bank",
    type: "BANK",
    currency: "INR",
    openingBalanceMinor: BigInt(0),
    currentBalanceMinor: BigInt(0),
    isArchived: false,
    sortOrder: 0,
    version: 1,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  store.state.accounts.push(row);
  return row;
}

function seedTransaction(
  store: ReturnType<typeof createStore>,
  overrides: any,
) {
  const row = {
    id: "tx-1",
    userId,
    accountId: "acc-1",
    toAccountId: null,
    categoryId: null,
    type: FinanceTransactionType.EXPENSE,
    amountMinor: BigInt(1000),
    currency: "INR",
    title: "Groceries",
    tags: [],
    transactionDate: new Date("2026-10-01T00:00:00Z"),
    version: 1,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  store.state.transactions.push(row);
  return row;
}

async function invalidProperties(dto: any, payload: any) {
  const instance = plainToInstance(dto, payload);
  const errors = await validate(instance, { skipMissingProperties: false });
  return errors.map((error) => error.property);
}

describe("Accounts and transactions integrity", () => {
  describe("currency normalisation at the write boundary", () => {
    it("upper-cases a lowercase currency so the money reads can find the row", async () => {
      const store = createStore();
      const account = await new AccountsService(store.client).createAccount(
        userId,
        {
          name: "Salary Bank",
          currency: " inr ",
          openingBalanceMinor: 0,
        },
      );

      expect(account.currency).toBe("INR");
      expect(store.state.accounts[0].currency).toBe("INR");
    });

    it("reports a lowercase-currency account's income in the cash-flow summary", async () => {
      const store = createStore();
      const accounts = new AccountsService(store.client);
      const transactions = new TransactionsService(store.client);

      const account = await accounts.createAccount(userId, {
        name: "Salary Bank",
        currency: "inr",
        openingBalanceMinor: 0,
      });
      await transactions.createTransaction(userId, {
        accountId: account.id,
        type: FinanceTransactionType.INCOME,
        amountMinor: 100000,
        currency: "INR",
        title: "October salary",
        transactionDate: "2026-10-01T09:00:00.000Z",
      });

      expect(store.state.transactions[0].currency).toBe("INR");
      const summary = await transactions.getCashFlowSummary(
        userId,
        undefined,
        undefined,
        "inr",
      );
      expect(summary.incomeMinor).toBe(100000);
      expect(summary.netMinor).toBe(100000);
    });

    it("stores the same code on an edited row as on an untouched one", async () => {
      const store = createStore();
      const account = seedAccount(store, { currency: "inr" });
      const transactions = new TransactionsService(store.client);

      const created = await transactions.createTransaction(userId, {
        accountId: account.id,
        type: FinanceTransactionType.EXPENSE,
        amountMinor: 1000,
        title: "Groceries",
        transactionDate: "2026-10-01T09:00:00.000Z",
      });
      const storedBeforeEdit = store.state.transactions[0].currency;

      await transactions.updateTransaction(userId, created.id, {
        title: "Renamed",
      });

      expect(storedBeforeEdit).toBe("INR");
      expect(store.state.transactions[0].currency).toBe(storedBeforeEdit);
    });

    it("still rejects a transaction currency that differs from the account", async () => {
      const store = createStore();
      const account = seedAccount(store, { currency: "eur" });

      await expect(
        new TransactionsService(store.client).createTransaction(userId, {
          accountId: account.id,
          type: FinanceTransactionType.EXPENSE,
          amountMinor: 100,
          currency: "usd",
          title: "Wrong currency",
          transactionDate: "2026-10-01T09:00:00.000Z",
        }),
      ).rejects.toThrow(BadRequestException);
      expect(store.state.transactions).toHaveLength(0);
    });

    it("normaliseCurrency keeps the INR default for a missing code", () => {
      expect(normaliseCurrency(undefined)).toBe("INR");
      expect(normaliseCurrency("inr")).toBe("INR");
      expect(normaliseCurrency(" Usd ")).toBe("USD");
    });
  });

  describe("re-denomination guard on PATCH /accounts/:id", () => {
    it("refuses to switch the currency of an account with live transactions", async () => {
      const store = createStore();
      seedAccount(store, {
        openingBalanceMinor: BigInt(100000),
        currentBalanceMinor: BigInt(100000),
      });
      seedTransaction(store, { amountMinor: BigInt(100) });

      await expect(
        new AccountsService(store.client).updateAccount(userId, "acc-1", {
          currency: "USD",
        }),
      ).rejects.toThrow(BadRequestException);

      expect(store.state.accounts[0].currency).toBe("INR");
      const loggedUpdate = store.state.changes.some(
        (change) =>
          change.entityType === "finance_account" &&
          change.operation === "UPDATE",
      );
      expect(loggedUpdate).toBe(false);
    });

    it("refuses a currency change on an empty account whose balance has moved", async () => {
      const store = createStore();
      seedAccount(store, {
        openingBalanceMinor: BigInt(100000),
        currentBalanceMinor: BigInt(99999),
      });

      await expect(
        new AccountsService(store.client).updateAccount(userId, "acc-1", {
          currency: "USD",
        }),
      ).rejects.toThrow(BadRequestException);
      expect(store.state.accounts[0].currency).toBe("INR");
    });

    it("refuses a currency change while a recurring rule still targets the account", async () => {
      const store = createStore();
      seedAccount(store);
      store.state.rules.push({
        id: "rule-1",
        userId,
        accountId: "acc-1",
        deletedAt: null,
      });

      await expect(
        new AccountsService(store.client).updateAccount(userId, "acc-1", {
          currency: "usd",
        }),
      ).rejects.toThrow(BadRequestException);
      expect(store.state.accounts[0].currency).toBe("INR");
    });

    it("still allows the switch on a brand-new untouched account, stored upper-case", async () => {
      const store = createStore();
      seedAccount(store, { currency: "INR" });

      const updated = await new AccountsService(store.client).updateAccount(
        userId,
        "acc-1",
        { currency: "usd" },
      );

      expect(updated.currency).toBe("USD");
      expect(store.state.accounts[0].currency).toBe("USD");
    });

    it("treats a lowercase spelling of the current currency as no change", async () => {
      const store = createStore();
      seedAccount(store, {
        openingBalanceMinor: BigInt(100000),
        currentBalanceMinor: BigInt(70000),
      });
      seedTransaction(store, { amountMinor: BigInt(30000) });

      const updated = await new AccountsService(store.client).updateAccount(
        userId,
        "acc-1",
        { currency: "inr", name: "Renamed" },
      );

      expect(updated.currency).toBe("INR");
      expect(updated.name).toBe("Renamed");
    });

    it("does not cost a currency-free patch an extra existence count", async () => {
      const store = createStore();
      seedAccount(store);
      seedTransaction(store, {});
      const spy = jest.spyOn(store.client.financeTransaction, "count");

      await new AccountsService(store.client).updateAccount(userId, "acc-1", {
        name: "Renamed again",
      });

      expect(spy).not.toHaveBeenCalled();
      expect(store.state.accounts[0].name).toBe("Renamed again");
    });
  });

  describe("currency + opening-balance pair on PATCH /accounts/:id", () => {
    function accountUpdatePayload(store: ReturnType<typeof createStore>) {
      const logged = store.state.changes
        .filter(
          (change) =>
            change.entityType === "finance_account" &&
            change.operation === "UPDATE",
        )
        .pop();
      return logged;
    }

    it("persists both halves of a re-denomination and mirrors the opening across", async () => {
      const store = createStore();
      seedAccount(store, {
        currency: "INR",
        openingBalanceMinor: BigInt(100000),
        currentBalanceMinor: BigInt(100000),
      });

      const updated = await new AccountsService(store.client).updateAccount(
        userId,
        "acc-1",
        { currency: "usd", openingBalanceMinor: 250000 },
      );

      // Pre-fix the `data` map had no `openingBalanceMinor` key, so the balance
      // the client re-entered for the new currency simply vanished: the row stayed
      // at 100000 hundredths and every device that pulled the change got an
      // account whose two balances disagreed.
      expect(store.state.accounts[0].currency).toBe("USD");
      expect(store.state.accounts[0].openingBalanceMinor).toBe(BigInt(250000));
      expect(store.state.accounts[0].currentBalanceMinor).toBe(BigInt(250000));
      expect(updated.currency).toBe("USD");
      expect(updated.openingBalanceMinor).toBe(250000);
      expect(updated.currentBalanceMinor).toBe(250000);

      // Hundredths copied verbatim — no 83x scaling — and the version bump plus
      // the oplog entry are the same write.
      const logged = accountUpdatePayload(store);
      expect(logged).toBeDefined();
      expect(logged.payload).toMatchObject({
        currency: "USD",
        openingBalanceMinor: 250000,
        currentBalanceMinor: 250000,
      });
      expect(logged.version).toBe(2);
      expect(logged.version).toBe(store.state.accounts[0].version);
    });

    it("leaves the running balance to the ledger when only the opening moves", async () => {
      const store = createStore();
      seedAccount(store, {
        openingBalanceMinor: BigInt(100000),
        currentBalanceMinor: BigInt(100000),
      });

      await new AccountsService(store.client).updateAccount(userId, "acc-1", {
        openingBalanceMinor: 120000,
      });

      // No currency switch, so nothing re-denominates: `currentBalanceMinor` is
      // owned by the transactions booked against the account, not by this patch.
      expect(store.state.accounts[0].openingBalanceMinor).toBe(BigInt(120000));
      expect(store.state.accounts[0].currentBalanceMinor).toBe(BigInt(100000));

      // And the guard now reads the diverged pair as "the balance has moved", so
      // a later currency switch is refused — which is the point of the guard.
      await expect(
        new AccountsService(store.client).updateAccount(userId, "acc-1", {
          currency: "USD",
        }),
      ).rejects.toThrow(BadRequestException);
      expect(store.state.accounts[0].currency).toBe("INR");
    });

    it("400s a re-denomination the account has outgrown and writes neither field", async () => {
      const store = createStore();
      seedAccount(store, {
        openingBalanceMinor: BigInt(100000),
        currentBalanceMinor: BigInt(100000),
      });
      seedTransaction(store, { amountMinor: BigInt(500) });

      await expect(
        new AccountsService(store.client).updateAccount(userId, "acc-1", {
          currency: "USD",
          openingBalanceMinor: 250000,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(store.state.accounts[0].currency).toBe("INR");
      expect(store.state.accounts[0].openingBalanceMinor).toBe(BigInt(100000));
      expect(store.state.accounts[0].currentBalanceMinor).toBe(BigInt(100000));
      expect(accountUpdatePayload(store)).toBeUndefined();
    });

    it("keeps a re-denominated account re-denominable, because the pair stayed equal", async () => {
      const store = createStore();
      seedAccount(store);
      const accounts = new AccountsService(store.client);

      await accounts.updateAccount(userId, "acc-1", {
        currency: "USD",
        openingBalanceMinor: 250000,
      });
      await accounts.updateAccount(userId, "acc-1", {
        currency: "eur",
        openingBalanceMinor: 300000,
      });

      expect(store.state.accounts[0].currency).toBe("EUR");
      expect(store.state.accounts[0].openingBalanceMinor).toBe(BigInt(300000));
      expect(store.state.accounts[0].currentBalanceMinor).toBe(BigInt(300000));
      expect(store.state.accounts[0].version).toBe(3);
    });

    it("treats a JSON null opening balance as silence, not as zero", async () => {
      const store = createStore();
      seedAccount(store, {
        openingBalanceMinor: BigInt(100000),
        currentBalanceMinor: BigInt(100000),
      });

      await new AccountsService(store.client).updateAccount(userId, "acc-1", {
        openingBalanceMinor: null,
      } as any);

      // A PATCH that carried the key as `null` must not be read as "move the
      // balance to 0", because the class-validator rule around it is optional.
      expect(store.state.accounts[0].openingBalanceMinor).toBe(BigInt(100000));
      expect(store.state.accounts[0].currentBalanceMinor).toBe(BigInt(100000));
    });

    it("still fences a fractional opening balance before it reaches BigInt", async () => {
      const store = createStore();
      seedAccount(store);

      await expect(
        new AccountsService(store.client).updateAccount(userId, "acc-1", {
          openingBalanceMinor: 1.5,
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        new AccountsService(store.client).updateAccount(userId, "acc-1", {
          openingBalanceMinor: Number.MAX_SAFE_INTEGER + 1,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(store.state.accounts[0].openingBalanceMinor).toBe(BigInt(0));
      expect(store.state.accounts[0].version).toBe(1);
      expect(accountUpdatePayload(store)).toBeUndefined();
    });
  });

  describe("adjustAccount only moves the caller's own balances", () => {
    function balanceOf(
      store: ReturnType<typeof createStore>,
      accountId: string,
    ) {
      return (
        store.state.accounts.find((account) => account.id === accountId) ?? {}
      ).currentBalanceMinor;
    }

    it("refuses to reverse a projected row that names someone else's account", async () => {
      const store = createStore();
      seedAccount(store, {
        id: "acc-victim",
        userId: otherUserId,
        currentBalanceMinor: BigInt(5000),
      });
      seedTransaction(store, {
        id: "tx-1",
        accountId: "acc-victim",
        type: FinanceTransactionType.INCOME,
        amountMinor: BigInt(1000),
      });

      await expect(
        new TransactionsService(store.client).deleteTransaction(userId, "tx-1"),
      ).rejects.toThrow(NotFoundException);

      expect(balanceOf(store, "acc-victim")).toBe(BigInt(5000));
      expect(store.state.transactions[0].deletedAt).toBeNull();
    });

    it("refuses to revert a transfer whose destination is not the caller's", async () => {
      const store = createStore();
      seedAccount(store, { id: "acc-src" });
      seedAccount(store, {
        id: "acc-victim",
        userId: otherUserId,
        currentBalanceMinor: BigInt(5000),
      });
      seedTransaction(store, {
        id: "tx-1",
        accountId: "acc-src",
        toAccountId: "acc-victim",
        type: FinanceTransactionType.TRANSFER,
        amountMinor: BigInt(1000),
      });

      await expect(
        new TransactionsService(store.client).updateTransaction(
          userId,
          "tx-1",
          { type: FinanceTransactionType.EXPENSE },
        ),
      ).rejects.toThrow(NotFoundException);

      expect(balanceOf(store, "acc-victim")).toBe(BigInt(5000));
      expect(store.state.transactions[0].type).toBe(
        FinanceTransactionType.TRANSFER,
      );
    });

    it("moves the balance of an owned account as before", async () => {
      const store = createStore();
      const account = seedAccount(store, { currentBalanceMinor: BigInt(1000) });

      await new TransactionsService(store.client).createTransaction(userId, {
        accountId: account.id,
        type: FinanceTransactionType.EXPENSE,
        amountMinor: 400,
        title: "Coffee",
        transactionDate: "2026-10-02T09:00:00.000Z",
      });

      expect(account.currentBalanceMinor).toBe(BigInt(600));
    });
  });

  describe("transaction search is a literal match with bounded paging", () => {
    function mockPrisma(): any {
      return {
        financeTransaction: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
        },
      };
    }

    it.each([
      ["(a+)+$", "\\(a\\+\\)\\+\\$"],
      ["a.b", "a\\.b"],
      [".*", "\\.\\*"],
      ["Groceries", "Groceries"],
    ])(
      "escapes %p before it reaches the $regex filter",
      async (search, expected) => {
        const prisma = mockPrisma();
        await new TransactionsService(prisma).getTransactions(userId, {
          search,
        } as QueryTransactionsDto);

        const where = prisma.financeTransaction.findMany.mock.calls[0][0].where;
        expect(where.title).toEqual({
          contains: expected,
          mode: "insensitive",
        });
        expect(
          prisma.financeTransaction.count.mock.calls[0][0].where.title.contains,
        ).toBe(expected);
      },
    );

    it("drops a blank search instead of matching every row", async () => {
      const prisma = mockPrisma();
      await new TransactionsService(prisma).getTransactions(userId, {
        search: "   ",
      } as QueryTransactionsDto);

      expect(
        prisma.financeTransaction.findMany.mock.calls[0][0].where.title,
      ).toBeUndefined();
    });

    it("caps an unvalidated page size and keeps skip inside Int", async () => {
      const prisma = mockPrisma();
      await new TransactionsService(prisma).getTransactions(userId, {
        page: 1e15,
        limit: 100000,
      } as unknown as QueryTransactionsDto);

      const args = prisma.financeTransaction.findMany.mock.calls[0][0];
      expect(args.take).toBe(200);
      expect(Number.isSafeInteger(args.skip)).toBe(true);
      expect(args.skip).toBe(9999 * 200);
    });

    it("rejects a search longer than the bound and an oversized limit", async () => {
      expect(
        await invalidProperties(QueryTransactionsDto, {
          search: "x".repeat(81),
        }),
      ).toContain("search");
      expect(
        await invalidProperties(QueryTransactionsDto, { limit: 5000 }),
      ).toContain("limit");
      expect(
        await invalidProperties(QueryTransactionsDto, { limit: 200 }),
      ).toEqual([]);
    });

    it("escapeRegex is the mirror of the connector behaviour proven against Mongo", () => {
      expect(escapeRegex("a.b")).toBe("a\\.b");
      expect(escapeRegex("^end$")).toBe("\\^end\\$");
    });
  });

  describe("minor-unit and text invariants", () => {
    it.each([Infinity, -Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
      "rejects opening balance %s with a 400 rather than a BigInt RangeError",
      async (openingBalanceMinor) => {
        const store = createStore();

        await expect(
          new AccountsService(store.client).createAccount(userId, {
            name: "Salary Bank",
            openingBalanceMinor,
          }),
        ).rejects.toThrow(BadRequestException);
        expect(store.state.accounts).toHaveLength(0);
      },
    );

    it("accepts a negative opening balance, which credit accounts need", async () => {
      const store = createStore();
      const account = await new AccountsService(store.client).createAccount(
        userId,
        { name: "Credit", openingBalanceMinor: -25000 },
      );

      expect(account.currentBalanceMinor).toBe(-25000);
    });

    it("rejects non-integer or non-finite minor units at the DTO edge", async () => {
      expect(
        await invalidProperties(CreateAccountDto, {
          name: "Salary Bank",
          openingBalanceMinor: 1.5,
        }),
      ).toContain("openingBalanceMinor");
      expect(
        await invalidProperties(CreateAccountDto, {
          name: "Salary Bank",
          openingBalanceMinor: Infinity,
        }),
      ).toContain("openingBalanceMinor");
      expect(
        await invalidProperties(CreateTransactionDto, {
          accountId: uuid,
          type: FinanceTransactionType.EXPENSE,
          amountMinor: Infinity,
          title: "Coffee",
          transactionDate: "2026-10-02T09:00:00.000Z",
        }),
      ).toContain("amountMinor");
    });

    it("rejects a currency that is not a 3-letter code", async () => {
      expect(
        await invalidProperties(CreateAccountDto, {
          name: "Salary Bank",
          currency: "rupee",
        }),
      ).toContain("currency");
      expect(
        await invalidProperties(CreateAccountDto, {
          name: "Salary Bank",
          currency: "in",
        }),
      ).toContain("currency");
      expect(
        await invalidProperties(CreateTransactionDto, {
          accountId: uuid,
          type: FinanceTransactionType.EXPENSE,
          amountMinor: 100,
          currency: "INR ",
          title: "Coffee",
          transactionDate: "2026-10-02T09:00:00.000Z",
        }),
      ).toContain("currency");
      expect(
        await invalidProperties(CreateAccountDto, {
          name: "Salary Bank",
          currency: "inr",
        }),
      ).toEqual([]);
    });

    it("bounds the free-text account fields", async () => {
      expect(
        await invalidProperties(CreateAccountDto, {
          name: "n".repeat(101),
          color: "c".repeat(33),
          iconKey: "i".repeat(65),
          sortOrder: 1e9,
        }),
      ).toEqual(
        expect.arrayContaining(["name", "color", "iconKey", "sortOrder"]),
      );
    });
  });
});
