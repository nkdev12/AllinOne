import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ThrottlerStorage } from "@nestjs/throttler";
import Redis from "ioredis";
import { ConfigurationService } from "@/config/configuration.service";

export interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
}

@Injectable()
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleDestroy
{
  private readonly redis: Redis;
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(
    private readonly configService: ConfigurationService,
    redisClient?: Redis,
  ) {
    if (redisClient) {
      this.redis = redisClient;
    } else {
      this.redis = new Redis(this.configService.redisUrl, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: false,
        lazyConnect: true,
      });

      this.redis.on("error", (err) => {
        this.logger.error(
          `Redis throttler storage connection error: ${err.message}`,
        );
      });
    }
  }

  async increment(key: string, ttl: number): Promise<ThrottlerStorageRecord> {
    const prefixedKey = `throttler:${key}`;
    try {
      const pipeline = this.redis.pipeline();
      pipeline.incr(prefixedKey);
      pipeline.pttl(prefixedKey);
      const results = await pipeline.exec();

      if (!results || results.length < 2) {
        throw new Error("Invalid Redis pipeline execution for rate limiting");
      }

      const totalHits = (results[0][1] as number) || 1;
      let pttl = (results[1][1] as number) || ttl;

      // If key is newly created (pttl === -1) or missing expiry
      if (pttl < 0) {
        await this.redis.pexpire(prefixedKey, ttl);
        pttl = ttl;
      }

      return {
        totalHits,
        timeToExpire: Math.max(0, Math.ceil(pttl / 1000)),
      };
    } catch (err: any) {
      this.logger.warn(
        `Redis throttler increment failed: ${err.message}. Permitting request.`,
      );
      return { totalHits: 1, timeToExpire: Math.ceil(ttl / 1000) };
    }
  }

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
