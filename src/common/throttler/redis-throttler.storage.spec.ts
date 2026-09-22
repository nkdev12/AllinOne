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
    const result = await storage.increment("user:123", 60000);

    expect(mockRedis.pipeline).toHaveBeenCalled();
    expect(mockPipeline.incr).toHaveBeenCalledWith("throttler:user:123");
    expect(mockPipeline.pttl).toHaveBeenCalledWith("throttler:user:123");
    expect(result).toEqual({
      totalHits: 3,
      timeToExpire: 45,
    });
  });

  it("should set pexpire if key is newly created (pttl < 0)", async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 1],
      [null, -1],
    ]);

    const result = await storage.increment("user:new", 60000);

    expect(mockRedis.pexpire).toHaveBeenCalledWith("throttler:user:new", 60000);
    expect(result).toEqual({
      totalHits: 1,
      timeToExpire: 60,
    });
  });

  it("should handle redis errors gracefully and permit request", async () => {
    mockPipeline.exec.mockRejectedValue(new Error("Redis connection lost"));

    const result = await storage.increment("user:err", 60000);

    expect(result).toEqual({
      totalHits: 1,
      timeToExpire: 60,
    });
  });
});
