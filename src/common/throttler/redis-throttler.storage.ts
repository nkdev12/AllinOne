import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ThrottlerStorage } from "@nestjs/throttler";
import Redis from "ioredis";
import { ConfigurationService } from "@/config/configuration.service";

export interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
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

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): Promise<ThrottlerStorageRecord> {
    const prefixedKey = `throttler:${key}`;
    const blockKey = `${prefixedKey}:block`;
    try {
      const blockedFor = await this.redis.pttl(blockKey);
      if (blockedFor > 0) {
        const [hits, remainingWindow] = await Promise.all([
          this.redis.get(prefixedKey),
          this.redis.pttl(prefixedKey),
        ]);
        return {
          totalHits: Number(hits) || limit + 1,
          timeToExpire: this.toSeconds(remainingWindow, ttl),
          isBlocked: true,
          timeToBlockExpire: this.toSeconds(blockedFor, blockDuration),
        };
      }

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

      const blockedUntil = blockDuration > 0 && totalHits > limit;
      if (blockedUntil) {
        await this.redis.set(blockKey, "1", "PX", blockDuration);
      }

      return {
        totalHits,
        timeToExpire: this.toSeconds(pttl, ttl),
        isBlocked: blockedUntil,
        timeToBlockExpire: blockedUntil
          ? this.toSeconds(blockDuration, blockDuration)
          : 0,
      };
    } catch (err: any) {
      this.logger.warn(
        `Redis throttler increment failed: ${err.message}. Permitting request.`,
      );
      return {
        totalHits: 1,
        timeToExpire: this.toSeconds(ttl, ttl),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  private toSeconds(remainingMs: number, fallbackMs: number): number {
    return Math.max(
      0,
      Math.ceil((remainingMs > 0 ? remainingMs : fallbackMs) / 1000),
    );
  }

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
