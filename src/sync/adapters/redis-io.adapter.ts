import { IoAdapter } from "@nestjs/platform-socket.io";
import { ServerOptions } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { Logger } from "@nestjs/common";

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private readonly logger = new Logger(RedisIoAdapter.name);

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
      const pubClient = new Redis(url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      const subClient = pubClient.duplicate();

      pubClient.on("error", (err) => {
        this.logger.error(`Redis PubClient error: ${err.message}`);
      });
      subClient.on("error", (err) => {
        this.logger.error(`Redis SubClient error: ${err.message}`);
      });

      this.adapterConstructor = createAdapter(pubClient, subClient);
      this.logger.log(
        "Redis WebSocket adapter successfully connected and configured for cluster broadcast.",
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to initialize RedisIoAdapter: ${err?.message}. Falling back to default in-memory adapter.`,
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
}
