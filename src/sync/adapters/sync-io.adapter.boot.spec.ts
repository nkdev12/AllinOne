import { Logger, Module } from "@nestjs/common";
import { INestApplication } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { NestFactory } from "@nestjs/core";
import Redis from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";
import { SyncGateway } from "../sync.gateway";
import { ConfigurationModule } from "@/config/configuration.module";
import { UsersService } from "@/users/users.service";
import { SyncIoAdapter } from "./sync-io.adapter";

jest.mock("ioredis");
jest.mock("@socket.io/redis-adapter", () => ({
  createAdapter: jest.fn(),
}));

/**
 * Boot-level cover for the WebSocket transport.
 *
 * The repo's history includes a unit test that stayed green while the thing it
 * described was never wired: `RedisIoAdapter` was constructed nowhere, and the
 * gateway's `cors: { origin: "*" }` was asserted by nobody because decorator
 * metadata is invisible to a unit test either way. So this file boots a real
 * Nest application (real HTTP server, real Socket.IO server, real gateway
 * binding) and reads the transport back off the server the namespace actually
 * answers handshakes with. Delete the `useWebSocketAdapter` call from
 * `src/main.ts` and the CORS half of this fails: without the adapter the
 * namespace is built by the stock `IoAdapter`, which puts no CORS options on
 * the engine at all.
 *
 * It deliberately does not boot `AppModule`: that needs MongoDB and object
 * storage, and none of what is pinned here depends on them.
 */

/** Instances the mocked cluster adapter produced, oldest first. */
const clusterAdapters: Array<{ init: jest.Mock }> = [];

/** `ConfigurationService`'s required set — without it the module won't load. */
const BOOT_ENV: Record<string, string> = {
  APP_ENV: "test",
  DATABASE_URL: "mongodb://localhost:27017/ws_boot",
  JWT_ACCESS_SECRET: "test-access-secret",
  JWT_REFRESH_SECRET: "test-refresh-secret",
  OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
  OBJECT_STORAGE_ACCESS_KEY: "key",
  OBJECT_STORAGE_SECRET_KEY: "secret",
  OBJECT_STORAGE_BUCKET: "bucket",
  ENCRYPTION_KEY: "x".repeat(32),
};

/** Everything read or cleared here, so a host environment cannot leak in. */
const ENV_KEYS = [
  ...Object.keys(BOOT_ENV),
  "WS_CORS_ORIGINS",
  "CORS_ORIGINS",
  "CORS_ORIGIN",
  "WS_CORS_ALLOW_NULL_ORIGIN",
  "REDIS_URL",
  "WS_REDIS_ADAPTER",
];

function withEnv(values: Record<string, string>) {
  const previous = new Map<string, string | undefined>();
  ENV_KEYS.forEach((key) => previous.set(key, process.env[key]));
  ENV_KEYS.forEach((key) => delete process.env[key]);
  Object.entries({ ...BOOT_ENV, ...values }).forEach(([key, value]) => {
    process.env[key] = value;
  });
  return () => {
    ENV_KEYS.forEach((key) => {
      const restored = previous.get(key);
      if (restored === undefined) delete process.env[key];
      else process.env[key] = restored;
    });
  };
}

@Module({
  imports: [
    // `ConfigurationService` validates through `ConfigService`, which reads
    // `process.env` here exactly as `AppModule`'s schema'd config does.
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
    ConfigurationModule,
    JwtModule.register({}),
  ],
  providers: [
    SyncGateway,
    {
      provide: UsersService,
      useValue: {
        getUserById: jest.fn().mockResolvedValue({
          id: "user-1",
          status: "ACTIVE",
          deletedAt: null,
        }),
        isSessionLive: jest.fn().mockResolvedValue(true),
      },
    },
  ],
})
class WsBootTestModule {}

/** The `cors` policy the live Socket.IO server was built with. */
function handshakeCors(server: any) {
  return server.engine.opts.cors;
}

/** Whether a live server's policy admits `origin`. */
function admits(cors: any, origin: string | undefined): boolean {
  if (typeof cors?.origin !== "function") {
    return cors?.origin === origin;
  }
  let allowed: boolean | string | undefined;
  cors.origin(origin, (_error: Error | null, allow?: boolean | string) => {
    allowed = allow;
  });
  return allowed === true;
}

/** ioredis double: `connect` succeeds, or fails like an unreachable server. */
function mockRedis(reachable: boolean) {
  (Redis as unknown as jest.Mock).mockImplementation(() => ({
    connect: reachable
      ? jest.fn().mockResolvedValue(undefined)
      : jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    duplicate: jest.fn().mockReturnThis(),
    on: jest.fn(),
    disconnect: jest.fn(),
    quit: jest.fn().mockResolvedValue("OK"),
  }));
}

describe("/sync transport at boot", () => {
  let restoreEnv: (() => void) | undefined;
  let app: INestApplication;

  beforeAll(() => {
    (createAdapter as unknown as jest.Mock).mockImplementation(
      () =>
        function MockClusterAdapter() {
          const adapter = { init: jest.fn().mockResolvedValue(undefined) };
          clusterAdapters.push(adapter);
          return adapter;
        },
    );
  });

  afterAll(() => {
    (createAdapter as unknown as jest.Mock).mockReset();
  });

  async function boot(
    values: Record<string, string> = {},
    redisReachable = true,
  ) {
    restoreEnv = withEnv(values);
    jest.clearAllMocks();
    mockRedis(redisReachable);

    app = await NestFactory.create(WsBootTestModule, { logger: false });
    app.useWebSocketAdapter(
      await SyncIoAdapter.fromConfig(app, app.get(ConfigService), new Logger()),
    );
    // `init()` is what binds the gateways — `NestFactory.create()` defers it to
    // `listen()`, which is why the adapter has to be installed first here too.
    await app.init();

    // Nest injects the *namespace* as the gateway's `server`; the root Socket.IO
    // server behind it is the one holding the handshake policy and the adapter.
    const namespace = app.get(SyncGateway).server as any;
    expect(namespace).toBeDefined();
    expect(namespace.name).toBe("/sync");
    return { namespace, server: namespace.server as any };
  }

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    restoreEnv?.();
  });

  it("installs the adapter and serves the namespace on the configured origins", async () => {
    const { server, namespace } = await boot({
      WS_CORS_ORIGINS: "https://app.test,https://admin.test",
    });

    const cors = handshakeCors(server);
    expect(cors).toBeDefined();
    expect(admits(cors, "https://app.test")).toBe(true);
    expect(admits(cors, "https://admin.test")).toBe(true);
    expect(admits(cors, "https://not-configured.test")).toBe(false);
    expect(admits(cors, "null")).toBe(false);
    expect(cors.credentials).toBe(true);

    // No Redis configured, so none was even attempted: this is the boot that
    // happens on a developer machine without a Redis container.
    expect(Redis).not.toHaveBeenCalled();
    expect(server.adapter().name).toBe("Adapter");
    expect(namespace.adapter).toBeInstanceOf(server.adapter());
  });

  it("falls through to the HTTP app's origin list when WS_CORS_ORIGINS is unset", async () => {
    const { server } = await boot({
      CORS_ORIGIN: "https://app.test",
      WS_CORS_ALLOW_NULL_ORIGIN: "true",
    });

    const cors = handshakeCors(server);
    expect(admits(cors, "https://app.test")).toBe(true);
    expect(admits(cors, "https://elsewhere.test")).toBe(false);
    // The documented escape hatch, taken.
    expect(admits(cors, "null")).toBe(true);
  });

  it("takes the Redis cluster adapter when one is configured and reachable", async () => {
    const { server, namespace } = await boot({
      WS_CORS_ORIGINS: "https://app.test",
      REDIS_URL: "redis://redis:6379",
    });

    expect(Redis).toHaveBeenCalledWith(
      "redis://redis:6379",
      expect.objectContaining({ lazyConnect: true }),
    );
    expect(createAdapter).toHaveBeenCalledTimes(1);

    // Not just configured: the namespace rooms a broadcast goes through are the
    // cluster adapter's own instance, so a device on a second process hears an
    // invalidation emitted here. That is tracker P0-4.
    expect(server.adapter()).toBe(
      (createAdapter as unknown as jest.Mock).mock.results[0].value,
    );
    expect(namespace.adapter).toBe(clusterAdapters[clusterAdapters.length - 1]);
    expect(namespace.adapter.init).toHaveBeenCalledTimes(1);

    // And the same boot still answers on the configured origin list.
    expect(admits(handshakeCors(server), "https://app.test")).toBe(true);
  });

  it("boots on the in-memory adapter when the configured Redis is down", async () => {
    // That `boot()` resolves at all is half the assertion: a hard Redis
    // dependency would throw during adapter construction and the API would not
    // start, which is exactly what the tracker's Redis-optional stance forbids.
    const { server, namespace } = await boot(
      {
        WS_CORS_ORIGINS: "https://app.test",
        REDIS_URL: "redis://redis:6379",
      },
      false,
    );

    expect(Redis).toHaveBeenCalled();
    expect(createAdapter).not.toHaveBeenCalled();
    expect(server.adapter().name).toBe("Adapter");
    expect(namespace.adapter).toBeInstanceOf(server.adapter());
    expect(admits(handshakeCors(server), "https://app.test")).toBe(true);
  });
});
