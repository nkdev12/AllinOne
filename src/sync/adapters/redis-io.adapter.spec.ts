import { RedisIoAdapter } from "./redis-io.adapter";
import Redis from "ioredis";

jest.mock("ioredis");
jest.mock("@socket.io/redis-adapter", () => ({
  createAdapter: jest.fn().mockReturnValue("mock-adapter-constructor"),
}));

describe("RedisIoAdapter", () => {
  let adapter: RedisIoAdapter;
  let mockApp: any;
  let mockRedisClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = {
      get: jest.fn(),
    };

    mockRedisClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      duplicate: jest.fn().mockReturnThis(),
      on: jest.fn(),
      disconnect: jest.fn(),
    };

    (Redis as unknown as jest.Mock).mockImplementation(() => mockRedisClient);
    adapter = new RedisIoAdapter(mockApp, "redis://localhost:6379");
  });

  it("should connect to Redis and initialize the cluster adapter", async () => {
    await adapter.connectToRedis();

    expect(mockRedisClient.connect).toHaveBeenCalledTimes(2); // pub + sub
    expect(mockRedisClient.on).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
  });

  it("should handle Redis connection failure and gracefully fall back to in-memory adapter", async () => {
    mockRedisClient.connect.mockRejectedValueOnce(
      new Error("ECONNREFUSED 127.0.0.1:6379"),
    );

    await adapter.connectToRedis();

    expect(mockRedisClient.disconnect).toHaveBeenCalled();
  });

  it("should create IO server with adapter when connected", async () => {
    const mockServer = {
      adapter: jest.fn(),
    };
    jest.spyOn(adapter as any, "createIOServer").mockImplementation(() => {
      if ((adapter as any).adapterConstructor) {
        mockServer.adapter((adapter as any).adapterConstructor);
      }
      return mockServer;
    });

    await adapter.connectToRedis();
    const server = adapter.createIOServer(3000);

    expect(server).toBe(mockServer);
    expect(mockServer.adapter).toHaveBeenCalledWith("mock-adapter-constructor");
  });

  it("should create IO server without adapter when Redis connection failed", async () => {
    mockRedisClient.connect.mockRejectedValueOnce(
      new Error("Connection refused"),
    );
    await adapter.connectToRedis();

    const mockServer = {
      adapter: jest.fn(),
    };
    jest.spyOn(adapter as any, "createIOServer").mockImplementation(() => {
      if ((adapter as any).adapterConstructor) {
        mockServer.adapter((adapter as any).adapterConstructor);
      }
      return mockServer;
    });

    const server = adapter.createIOServer(3000);

    expect(server).toBe(mockServer);
    expect(mockServer.adapter).not.toHaveBeenCalled();
  });
});

