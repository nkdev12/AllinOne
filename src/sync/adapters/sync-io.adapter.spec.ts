import http from "node:http";
import { Logger } from "@nestjs/common";
import {
  DEFAULT_WS_CORS_ORIGINS,
  SyncIoAdapter,
  WebSocketConfigReader,
  resolveWebSocketCors,
  shouldAttemptRedisClustering,
} from "./sync-io.adapter";
import Redis from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";

jest.mock("ioredis");
jest.mock("@socket.io/redis-adapter", () => ({
  createAdapter: jest.fn().mockReturnValue(function MockAdapterConstructor() {
    return { init: () => Promise.resolve() };
  }),
}));

function config(values: Record<string, unknown>): WebSocketConfigReader {
  return {
    get: jest.fn(<T>(key: string, fallback?: T): T | undefined => {
      const raw = values[key];
      return raw === undefined ? fallback : (raw as T);
    }),
  };
}

/** The `origin` callback the `cors` package is handed, when we pass one. */
function originMatcher(
  adapter: SyncIoAdapter,
): (origin: string | undefined) => boolean {
  const cors = (adapter as any).buildCors();
  if (typeof cors.origin !== "function") {
    throw new Error("Expected the resolved policy to be a matcher function");
  }
  return (origin) => {
    let allowed: boolean | string | undefined;
    cors.origin(origin, (_error: Error | null, allow?: boolean | string) => {
      allowed = allow;
    });
    return allowed === true;
  };
}

describe("resolveWebSocketCors", () => {
  it("reads the namespace's own list when it is configured", () => {
    const resolved = resolveWebSocketCors(
      config({ WS_CORS_ORIGINS: "https://app.test , https://admin.test" }),
    );

    expect(resolved.origins).toEqual([
      "https://app.test",
      "https://admin.test",
    ]);
    expect(resolved.source).toBe("WS_CORS_ORIGINS");
    expect(resolved.credentials).toBe(true);
  });

  it("falls through to the shared and then the HTTP list", () => {
    expect(
      resolveWebSocketCors(config({ CORS_ORIGINS: "https://a.test" })).origins,
    ).toEqual(["https://a.test"]);
    expect(
      resolveWebSocketCors(config({ CORS_ORIGIN: "https://b.test" })).origins,
    ).toEqual(["https://b.test"]);
    // Both set: the narrower key wins, which is why it exists.
    expect(
      resolveWebSocketCors(
        config({
          WS_CORS_ORIGINS: "https://ws.test",
          CORS_ORIGIN: "https://b.test",
        }),
      ).origins,
    ).toEqual(["https://ws.test"]);
  });

  it("defaults to the development origin rather than to a wildcard", () => {
    const resolved = resolveWebSocketCors(config({}));

    // The defect this replaces was `cors: { origin: "*" }` on the gateway
    // decorator: with no configuration, an open namespace and a configured
    // namespace behaved identically.
    expect(resolved.origins).toEqual([DEFAULT_WS_CORS_ORIGINS]);
    expect(resolved.origins).not.toContain("*");
    expect(resolved.source).toBe("default");
  });

  it("keeps the null-origin escape hatch off unless it is asked for", () => {
    expect(resolveWebSocketCors(config({})).allowNullOrigin).toBe(false);
    expect(
      resolveWebSocketCors(config({ WS_CORS_ALLOW_NULL_ORIGIN: "true" }))
        .allowNullOrigin,
    ).toBe(true);
    // The string "false" is truthy in JS, and env values are always strings.
    expect(
      resolveWebSocketCors(config({ WS_CORS_ALLOW_NULL_ORIGIN: "false" }))
        .allowNullOrigin,
    ).toBe(false);
  });
});

describe("shouldAttemptRedisClustering", () => {
  it("stays in-memory with no Redis to talk to", () => {
    expect(shouldAttemptRedisClustering(config({}))).toEqual({
      enabled: false,
    });
  });

  it("tries Redis when a URL is configured, and can be switched off", () => {
    expect(
      shouldAttemptRedisClustering(config({ REDIS_URL: "redis://redis:6379" })),
    ).toEqual({ enabled: true, redisUrl: "redis://redis:6379" });
    expect(
      shouldAttemptRedisClustering(
        config({ REDIS_URL: "redis://redis:6379", WS_REDIS_ADAPTER: "false" }),
      ),
    ).toEqual({ enabled: false });
  });
});

describe("SyncIoAdapter policy applied to the Socket.IO server", () => {
  const adapterLogger = {
    log: jest.fn(),
    warn: jest.fn(),
  } as unknown as Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    (Redis as unknown as jest.Mock).mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      duplicate: jest.fn().mockReturnThis(),
      on: jest.fn(),
      disconnect: jest.fn(),
      quit: jest.fn().mockResolvedValue("OK"),
    }));
  });

  it("refuses an origin outside the list and admits one inside it", async () => {
    const adapter = await SyncIoAdapter.fromConfig(
      { get: jest.fn() },
      config({ WS_CORS_ORIGINS: "https://app.test" }),
      adapterLogger,
    );

    const admits = originMatcher(adapter);
    expect(admits("https://app.test")).toBe(true);
    expect(admits("https://evil.test")).toBe(false);
    expect(admits(undefined)).toBe(false);
    expect(admits("null")).toBe(false);
  });

  it("admits an unnamed origin only through the documented hatch", async () => {
    const adapter = await SyncIoAdapter.fromConfig(
      { get: jest.fn() },
      config({
        WS_CORS_ORIGINS: "https://app.test",
        WS_CORS_ALLOW_NULL_ORIGIN: "true",
      }),
      adapterLogger,
    );

    const admits = originMatcher(adapter);
    // What the hatch is for: an Android WebView posting `Origin: null`, and a
    // native socket upgrade posting no `Origin` at all.
    expect(admits("null")).toBe(true);
    expect(admits(undefined)).toBe(true);
    // Still not a licence for a named origin that is not on the list.
    expect(admits("https://evil.test")).toBe(false);
  });

  it("honours an explicit wildcard, without credentials", async () => {
    const adapter = await SyncIoAdapter.fromConfig(
      { get: jest.fn() },
      config({ WS_CORS_ORIGINS: "*" }),
      adapterLogger,
    );

    const cors = (adapter as any).buildCors();
    // A browser rejects `Access-Control-Allow-Origin: *` beside
    // `Access-Control-Allow-Credentials: true`, so passing both would turn an
    // operator's deliberate wildcard into a handshake that fails for a reason
    // nobody asked for.
    expect(cors).toEqual({ origin: "*", credentials: false });
  });

  it("replaces whatever CORS the gateway decorator passed", async () => {
    const adapter = await SyncIoAdapter.fromConfig(
      { get: jest.fn() },
      config({ WS_CORS_ORIGINS: "https://app.test" }),
      adapterLogger,
    );

    const created: any[] = [];
    jest
      .spyOn(adapter as any, "createIOServer")
      .mockImplementation((...args: any[]) => {
        created.push(args[1]);
        return { opts: args[1] };
      });

    // The call that builds the Socket.IO server: this is where a browser's
    // handshake is answered, and the decorator's wildcard arrives here still.
    adapter.create(0, { cors: { origin: "*" }, path: "/socket.io" } as never);

    expect(created).toHaveLength(1);
    expect(created[0].cors).not.toEqual({ origin: "*" });
    expect(typeof created[0].cors.origin).toBe("function");
    // Everything else the decorator carried still reaches the server.
    expect(created[0].path).toBe("/socket.io");

    // The second call Nest makes resolves the namespace out of the server it
    // already built, so it must not create one with stale options.
    const of = jest.fn().mockReturnValue({ name: "/sync" });
    expect(
      adapter.create(0, { namespace: "/sync", server: { of } } as never),
    ).toEqual({ name: "/sync" });
    expect(created).toHaveLength(1);
    expect(of).toHaveBeenCalledWith("/sync");
  });

  it("does not touch Redis at all when none is configured", async () => {
    const httpServer = http.createServer();
    const adapter = await SyncIoAdapter.fromConfig(
      httpServer,
      config({ WS_CORS_ORIGINS: "https://app.test" }),
      adapterLogger,
    );

    // The app boots without Redis today, and `RedisThrottlerStorage` falls back
    // to memory: a hard Redis dependency here would be the regression.
    expect(Redis).not.toHaveBeenCalled();
    expect((adapter as any).adapterConstructor).toBeUndefined();

    // A real Socket.IO server, so the claim is about the transport it ended up
    // with and not about a stub of the method that builds it.
    const server = adapter.create(0);
    expect((server as any)._adapter.name).toBe("Adapter");
    server.close();
    httpServer.close();
  });

  it("installs the cluster adapter when Redis is configured", async () => {
    const httpServer = http.createServer();
    const adapter = await SyncIoAdapter.fromConfig(
      httpServer,
      config({
        WS_CORS_ORIGINS: "https://app.test",
        REDIS_URL: "redis://redis:6379",
      }),
      adapterLogger,
    );

    expect(Redis).toHaveBeenCalledWith(
      "redis://redis:6379",
      expect.objectContaining({ lazyConnect: true }),
    );
    expect(createAdapter).toHaveBeenCalled();

    const server = adapter.create(0);
    // Rooms are per-process until a Socket.IO adapter says otherwise: this is the
    // wiring tracker P0-4 was about, and `create()` is the only place it can
    // happen.
    expect((server as any)._adapter).toBe(
      (createAdapter as unknown as jest.Mock)(),
    );
    server.close();
    httpServer.close();
  });

  it("still boots, on memory, when the configured Redis refuses", async () => {
    (Redis as unknown as jest.Mock).mockImplementation(() => ({
      connect: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      duplicate: jest.fn().mockReturnThis(),
      on: jest.fn(),
      disconnect: jest.fn(),
      quit: jest.fn().mockResolvedValue("OK"),
    }));

    const httpServer = http.createServer();
    const adapter = await SyncIoAdapter.fromConfig(
      httpServer,
      config({ REDIS_URL: "redis://redis:6379" }),
      adapterLogger,
    );

    expect((adapter as any).adapterConstructor).toBeUndefined();
    expect(() => adapter.create(0)).not.toThrow();

    const server = adapter.create(0);
    expect((server as any)._adapter.name).toBe("Adapter");
    server.close();
    httpServer.close();
  });

  it("releases the pub/sub handles on dispose", async () => {
    const quit = jest.fn().mockResolvedValue("OK");
    (Redis as unknown as jest.Mock).mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      duplicate: jest.fn().mockReturnThis(),
      on: jest.fn(),
      disconnect: jest.fn(),
      quit,
    }));

    const adapter = await SyncIoAdapter.fromConfig(
      { get: jest.fn() },
      config({ REDIS_URL: "redis://redis:6379" }),
      adapterLogger,
    );

    // A live ioredis client keeps the event loop owned, so leaving both open past
    // `app.close()` is a container that never exits on SIGTERM.
    await adapter.dispose();
    expect(quit).toHaveBeenCalledTimes(2);
  });
});
