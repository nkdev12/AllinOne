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
        where: { key: "new-key" },
        create: expect.objectContaining({
          key: "new-key",
          userId: "user-uuid-123",
          statusCode: 200,
        }),
      }),
    );
  });
});
