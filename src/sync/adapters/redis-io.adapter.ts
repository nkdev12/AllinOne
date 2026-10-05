import { IoAdapter } from "@nestjs/platform-socket.io";
import { ServerOptions } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { Logger } from "@nestjs/common";

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private readonly logger = new Logger(RedisIoAdapter.name);
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(
    app: any,
    private readonly redisUrl?: string,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const url =
      this.redisUrl || process.env.REDIS_URL || "redis://localhost:6379";

    try {
      this.pubClient = new Redis(url, {
        lazyConnect: true,
        connectTimeout: 3000,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          if (times > 3) {
            return null;
          }
          return Math.min(times * 200, 1000);
        },
      });

      this.pubClient.on("error", (err) => {
        if (this.adapterConstructor) {
          this.logger.warn(`Redis PubClient error: ${err?.message || err}`);
        }
      });

      await this.pubClient.connect();

      this.subClient = this.pubClient.duplicate({
        lazyConnect: true,
      });

      this.subClient.on("error", (err) => {
        if (this.adapterConstructor) {
          this.logger.warn(`Redis SubClient error: ${err?.message || err}`);
        }
      });

      await this.subClient.connect();

      this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
      this.logger.log(
        "Redis WebSocket adapter successfully connected and configured for cluster broadcast.",
      );
    } catch (err: any) {
      if (this.pubClient) {
        try {
          this.pubClient.disconnect();
        } catch (_) {}
      }
      if (this.subClient) {
        try {
          this.subClient.disconnect();
        } catch (_) {}
      }
      this.adapterConstructor = undefined;
      this.logger.warn(
        `Redis is unavailable at ${url} (${err?.message || "Connection refused"}). Real-time sync will use the default in-memory WebSocket adapter.`,
      );
    }
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }

  /**
   * Release the two Pub/Sub handles on shutdown.
   *
   * `connectToRedis()` opens them and Socket.IO's `close()` on the server does
   * not quit them, so an ioredis client with a live connection keeps the event
   * loop owned — the exact shape of problem `enableShutdownHooks()` in
   * `src/main.ts` exists to avoid. Nest calls this from the socket module's own
   * teardown, after every namespace has been closed.
   */
  async dispose(): Promise<void> {
    for (const client of [this.pubClient, this.subClient]) {
      if (!client) continue;
      try {
        await client.quit();
      } catch (_) {
        try {
          client.disconnect();
        } catch (_) {}
      }
    }
    this.pubClient = undefined;
    this.subClient = undefined;
    this.adapterConstructor = undefined;
  }
}
