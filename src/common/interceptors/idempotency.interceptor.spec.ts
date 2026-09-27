import { ExecutionContext, CallHandler } from "@nestjs/common";
import { of } from "rxjs";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import { PrismaService } from "@/common/prisma/prisma.service";

describe("IdempotencyInterceptor", () => {
  let interceptor: IdempotencyInterceptor;
  let prismaService: any;
  let executionContext: ExecutionContext;
  let callHandler: CallHandler;
  let reqMock: any;
  let resMock: any;

  beforeEach(() => {
    prismaService = {
      idempotencyKey: {
        findUnique: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };

    interceptor = new IdempotencyInterceptor(prismaService as PrismaService);

    reqMock = {
      method: "POST",
      url: "/test-endpoint",
      headers: {},
      user: { id: "user-uuid-123" },
    };

    resMock = {
      statusCode: 200,
      status: jest.fn().mockReturnThis(),
    };

    executionContext = {
      switchToHttp: () => ({
        getRequest: () => reqMock,
        getResponse: () => resMock,
      }),
    } as any;

    callHandler = {
      handle: jest.fn().mockReturnValue(of({ result: "success" })),
    };
  });

  it("should be defined", () => {
    expect(interceptor).toBeDefined();
  });

  it("should ignore non-state-changing methods (e.g. GET)", async () => {
    reqMock.method = "GET";
    reqMock.headers["idempotency-key"] = "test-key-1";

    const result$ = await interceptor.intercept(executionContext, callHandler);
    let emittedData: any;
    result$.subscribe((data) => (emittedData = data));

    expect(callHandler.handle).toHaveBeenCalled();
    expect(prismaService.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(emittedData).toEqual({ result: "success" });
  });

  it("should ignore requests without idempotency header", async () => {
    const result$ = await interceptor.intercept(executionContext, callHandler);
    let emittedData: any;
    result$.subscribe((data) => (emittedData = data));

    expect(callHandler.handle).toHaveBeenCalled();
    expect(prismaService.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(emittedData).toEqual({ result: "success" });
  });

  it("should return cached response on cache hit", async () => {
    reqMock.headers["idempotency-key"] = "existing-key";
    const cachedResponse = { id: 1, name: "cached" };

    prismaService.idempotencyKey.findUnique.mockResolvedValue({
      key: "existing-key",
      statusCode: 201,
      response: cachedResponse,
      expiresAt: new Date(Date.now() + 100000),
    });

    const result$ = await interceptor.intercept(executionContext, callHandler);
    let emittedData: any;
    result$.subscribe((data) => (emittedData = data));

    expect(callHandler.handle).not.toHaveBeenCalled();
    expect(resMock.status).toHaveBeenCalledWith(201);
    expect(emittedData).toEqual(cachedResponse);
  });

  it("should never cache or replay a vault route response", async () => {
    // recovery/verify answers with the wrapped master key; a cached copy would
    // sit in IdempotencyKey.response outside every vault access rule.
    reqMock.url = "/vault/settings/recovery/verify";
    reqMock.headers["idempotency-key"] = "vault-key";
    prismaService.idempotencyKey.findUnique.mockResolvedValue({
      key: "vault-key",
      statusCode: 200,
      response: { recoveryKey: "cached-key-material" },
      expiresAt: new Date(Date.now() + 100000),
    });

    const result$ = await interceptor.intercept(executionContext, callHandler);
    let emittedData: any;
    result$.subscribe((data) => (emittedData = data));

    expect(callHandler.handle).toHaveBeenCalled();
    expect(emittedData).toEqual({ result: "success" });
    expect(prismaService.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(prismaService.idempotencyKey.upsert).not.toHaveBeenCalled();
  });

  it("should execute route handler and save response on cache miss", async () => {
    reqMock.headers["idempotency-key"] = "new-key";
    prismaService.idempotencyKey.findUnique.mockResolvedValue(null);

    const result$ = await interceptor.intercept(executionContext, callHandler);
    let emittedData: any;
    result$.subscribe((data) => (emittedData = data));

    expect(callHandler.handle).toHaveBeenCalled();
    expect(emittedData).toEqual({ result: "success" });
    expect(prismaService.idempotencyKey.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_key: { userId: "user-uuid-123", key: "new-key" } },
        create: expect.objectContaining({
          key: "new-key",
          userId: "user-uuid-123",
          statusCode: 200,
        }),
      }),
    );
  });

  // A store rather than a bare mock, because what was wrong was *which row the
  // header addressed*. `findUnique` mocked to answer one way cannot tell a
  // scoped lookup from an unscoped one: both return the same object.
  describe("whose cached response a key addresses", () => {
    let store: Map<string, any>;
    const address = (userId: string, key: string) => `${userId}\u0000${key}`;

    const run = async () => {
      const result$ = await interceptor.intercept(
        executionContext,
        callHandler,
      );
      let emitted: any;
      result$.subscribe((data) => (emitted = data));
      // The save happens in a `tap` callback the interceptor does not await.
      await new Promise((resolve) => setImmediate(resolve));
      return emitted;
    };

    beforeEach(() => {
      store = new Map();
      prismaService.idempotencyKey.findUnique = jest.fn(
        async ({ where }: any) =>
          store.get(address(where.userId_key.userId, where.userId_key.key)) ??
          null,
      );
      prismaService.idempotencyKey.upsert = jest.fn(
        async ({ where, create, update }: any) => {
          const id = address(where.userId_key.userId, where.userId_key.key);
          const row = store.get(id) ?? { ...create };
          Object.assign(row, update);
          store.set(id, row);
          return row;
        },
      );
    });

    it("asks for the row by the account and the key together", async () => {
      reqMock.headers["idempotency-key"] = "any-key";
      await run();

      expect(prismaService.idempotencyKey.findUnique).toHaveBeenCalledWith({
        where: {
          userId_key: { userId: "user-uuid-123", key: "any-key" },
        },
      });
    });

    it("replays a cached create to its own account and to nobody else", async () => {
      // The retried create this whole mechanism exists for: same header, same
      // route, second response replayed instead of the insert running twice.
      reqMock.headers["idempotency-key"] = "shared-key";
      callHandler.handle = jest
        .fn()
        .mockReturnValue(of({ id: "note-1", title: "First account" }));
      expect(await run()).toEqual({ id: "note-1", title: "First account" });

      // Same key, another account — it must not receive the first one's note, and
      // must not take over the row it collides with.
      reqMock.user = { id: "user-2" };
      callHandler.handle = jest
        .fn()
        .mockReturnValue(of({ id: "note-2", title: "Second account" }));
      const replayed = await run();

      expect(callHandler.handle).toHaveBeenCalled();
      expect(replayed).toEqual({ id: "note-2", title: "Second account" });
      expect(
        store.get(address("user-uuid-123", "shared-key")).response,
      ).toEqual({ id: "note-1", title: "First account" });
      expect(store.get(address("user-2", "shared-key")).userId).toBe("user-2");
    });

    it("answers a second, different batch under the same key from the cache", async () => {
      // The constraint `/sync/push` sits under, executable rather than only
      // commented. Nothing here can tell a retry from a new batch wearing an old
      // key: the lookup is the caller's string, and the two rows the client gets
      // back look identical — one appended changes, one did not.
      reqMock.url = "/sync/push";
      reqMock.headers["idempotency-key"] = "batch-key";
      callHandler.handle = jest
        .fn()
        .mockReturnValue(of({ accepted: ["change-1"], newCursor: "1" }));
      expect(await run()).toEqual({ accepted: ["change-1"], newCursor: "1" });

      // Same key, different batch. The handler is the only thing that appends to
      // the change log, so this is the case where the log silently does not move.
      callHandler.handle = jest
        .fn()
        .mockReturnValue(of({ accepted: ["change-2"], newCursor: "2" }));
      const replayed = await run();

      expect(callHandler.handle).not.toHaveBeenCalled();
      expect(replayed).toEqual({ accepted: ["change-1"], newCursor: "1" });
    });
  });
});
