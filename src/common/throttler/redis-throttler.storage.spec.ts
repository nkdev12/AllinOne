import { RedisThrottlerStorage } from "./redis-throttler.storage";

describe("RedisThrottlerStorage", () => {
  let storage: RedisThrottlerStorage;
  let mockPipeline: any;
  let mockRedis: any;

  beforeEach(() => {
    mockPipeline = {
      incr: jest.fn().mockReturnThis(),
      pttl: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([
        [null, 3],
        [null, 45000],
      ]),
    };

    mockRedis = {
      pipeline: jest.fn().mockReturnValue(mockPipeline),
      pexpire: jest.fn().mockResolvedValue(1),
      pttl: jest.fn().mockResolvedValue(-2),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue("OK"),
      on: jest.fn(),
      quit: jest.fn().mockResolvedValue("OK"),
      disconnect: jest.fn(),
    };

    const configServiceMock = {
      redisUrl: "redis://localhost:6379",
    } as any;

    storage = new RedisThrottlerStorage(configServiceMock, mockRedis);
  });

  it("should be defined", () => {
    expect(storage).toBeDefined();
  });

  it("should increment counter and return hits and expiry time in seconds", async () => {
    const result = await storage.increment("user:123", 60000, 10, 0);

    expect(mockRedis.pipeline).toHaveBeenCalled();
    expect(mockPipeline.incr).toHaveBeenCalledWith("throttler:user:123");
    expect(mockPipeline.pttl).toHaveBeenCalledWith("throttler:user:123");
    expect(result).toEqual({
      totalHits: 3,
      timeToExpire: 45,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it("should set pexpire if key is newly created (pttl < 0)", async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 1],
      [null, -1],
    ]);

    const result = await storage.increment("user:new", 60000, 10, 0);

    expect(mockRedis.pexpire).toHaveBeenCalledWith("throttler:user:new", 60000);
    expect(result).toEqual({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it("should handle redis errors gracefully and permit request", async () => {
    mockPipeline.exec.mockRejectedValue(new Error("Redis connection lost"));

    const result = await storage.increment("user:err", 60000, 10, 0);

    expect(result).toEqual({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it("should never block while blockDuration is disabled", async () => {
    await storage.increment("user:over", 60000, 2, 0);

    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it("should block once the limit is exceeded and a blockDuration is set", async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 3],
      [null, 45000],
    ]);

    const result = await storage.increment("user:over", 60000, 2, 30000);

    expect(mockRedis.set).toHaveBeenCalledWith(
      "throttler:user:over:block",
      "1",
      "PX",
      30000,
    );
    expect(result).toEqual({
      totalHits: 3,
      timeToExpire: 45,
      isBlocked: true,
      timeToBlockExpire: 30,
    });
  });

  it("should not count further hits while the key is blocked", async () => {
    mockRedis.pttl.mockImplementation((key: string) =>
      Promise.resolve(key.endsWith(":block") ? 20000 : 40000),
    );
    mockRedis.get.mockResolvedValue("5");

    const result = await storage.increment("user:blocked", 60000, 2, 30000);

    expect(mockRedis.pipeline).not.toHaveBeenCalled();
    expect(result).toEqual({
      totalHits: 5,
      timeToExpire: 40,
      isBlocked: true,
      timeToBlockExpire: 20,
    });
  });

  it("should report a hit above the limit when the stored counter is gone", async () => {
    mockRedis.pttl.mockImplementation((key: string) =>
      Promise.resolve(key.endsWith(":block") ? 20000 : -2),
    );
    mockRedis.get.mockResolvedValue(null);

    const result = await storage.increment("user:stale", 60000, 2, 30000);

    expect(result.totalHits).toBe(3);
    expect(result.timeToExpire).toBe(60);
  });
});
