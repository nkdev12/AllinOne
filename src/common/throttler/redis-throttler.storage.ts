import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ThrottlerStorage } from "@nestjs/throttler";
import Redis from "ioredis";
import { ConfigurationService } from "@/config/configuration.service";
import {
  LocalThrottlerWindow,
  type ThrottlerStorageRecord,
} from "./local-throttler.window";

/** How `MULTI`/`EXEC` reports one command: a failed one is a pair, not a throw. */
type CommandResult = [error: Error | null, result: unknown];

/**
 * How often the outage signal repeats. Long enough that a sustained outage stays
 * worth reading, short enough that nobody has to rediscover it per shift.
 */
const OUTAGE_REPORT_INTERVAL_MS = 30_000;

/**
 * Rate-limit counters that outlive the worker that counted them.
 *
 * The library's own storage keeps them in a `Map` on the process, so with two API
 * replicas each one hands out the full allowance, and a deploy or a crash resets
 * every window and every block mid-flight. Registered as `ThrottlerModule`'s
 * storage in `src/app/app.module.ts`, where `ConfigurationService
 * .usesRedisThrottlerStorage` decides whether it is used at all.
 *
 * The connection is its own, not Bull's: `QueuesModule` — the only place with a
 * shared Redis — is imported by `WorkerModule` alone, and pulling it into the API
 * graph would drag every queue processor with it.
 */
@Injectable()
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleDestroy
{
  private readonly redis: Redis;
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly local = new LocalThrottlerWindow();
  private lastOutageReportAt = Number.NEGATIVE_INFINITY;
  private countedLocally = 0;
  private permittedBlindly = 0;

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
    }

    // An `error` event with no listener is an uncaught exception, and ioredis
    // emits one per reconnect attempt — so the listener is needed for an injected
    // client too, not only for the one built here.
    this.redis.on("error", (err) => {
      this.announceOutage(`Redis throttler connection error: ${err.message}`);
    });
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
      // Any round trip that completed ends the degraded streak, block included:
      // the tally answers "how many requests did we have to count ourselves since
      // Redis last spoke to us", and a blocked caller read real counters.
      this.countedLocally = 0;
      this.permittedBlindly = 0;
      if (blockedFor > 0) {
        const [totalHits, remainingWindow] = await this.readCounter(
          prefixedKey,
          limit,
        );
        return {
          totalHits,
          timeToExpire: this.toSeconds(remainingWindow, ttl),
          isBlocked: true,
          timeToBlockExpire: this.toSeconds(blockedFor, blockDuration),
        };
      }

      const [totalHits, windowRemaining] = await this.countHit(
        prefixedKey,
        ttl,
      );

      const isBlocked = blockDuration > 0 && totalHits > limit;
      if (isBlocked) {
        // The block is decided from the count the transaction just returned, so it
        // cannot ride along in it. It is a plain `SET` rather than one refreshed on
        // every request: a caller that arrives during the block takes the early
        // return above, so hammering cannot stretch the penalty past the duration
        // the first over-quota hit earned.
        await this.redis.set(blockKey, "1", "PX", blockDuration);
      }

      return {
        totalHits,
        timeToExpire: this.toSeconds(windowRemaining, ttl),
        isBlocked,
        timeToBlockExpire: isBlocked
          ? this.toSeconds(blockDuration, blockDuration)
          : 0,
      };
    } catch (err) {
      // Redis did not answer, so the hit is counted here instead. Returning
      // `totalHits: 1, isBlocked: false` for it — the old behaviour — made an
      // outage mean "no login, OTP or vault-unlock limit anywhere", which is
      // exactly the window a brute-force run aims for.
      const fromLocal = this.local.record(key, ttl, limit, blockDuration);
      this.reportDegradedRequest(err, fromLocal !== null);

      return (
        fromLocal ?? {
          totalHits: 1,
          timeToExpire: this.toSeconds(ttl, ttl),
          isBlocked: false,
          timeToBlockExpire: 0,
        }
      );
    }
  }

  /**
   * One hit and the window it belongs to, in one transaction.
   *
   * A `pipeline` is only a batch: Redis is free to run another client's command
   * between ours, so `INCR` and a later `PEXPIRE` leave the window armed by
   * whichever concurrent hit got there last, and a worker killed in that gap leaves
   * a counter with no expiry at all — one that never resets, and so blocks the key
   * permanently once it passes the limit. `PEXPIRE ... NX` writes the expiry only
   * where the key has none, which is what lets every concurrent hit attempt the
   * arming without moving the window. The `NX` flag is Redis 6.2 and later; both
   * compose files pin `redis:7`, and an older server fails the transaction into the
   * outage path rather than counting without a window.
   */
  private async countHit(
    prefixedKey: string,
    ttl: number,
  ): Promise<[number, number]> {
    const results = await this.redis
      .multi()
      .incr(prefixedKey)
      .pexpire(prefixedKey, ttl, "NX")
      .pttl(prefixedKey)
      .exec();

    // The hit comes from `INCR`'s own reply, never from reading the key back: a
    // read after the write would report another client's count as this request's.
    return [
      this.numberResult(results, 0, "INCR"),
      this.numberResult(results, 2, "PTTL"),
    ];
  }

  /**
   * A blocked caller is not counted, and still has to be told how long it waits,
   * so both numbers come from one transaction. Read separately, the count can
   * belong to the window that has just rolled over while the expiry describes the
   * next one, and `Retry-After` becomes a guess about a window nobody counted in.
   */
  private async readCounter(
    prefixedKey: string,
    limit: number,
  ): Promise<[number, number]> {
    const results = await this.redis
      .multi()
      .get(prefixedKey)
      .pttl(prefixedKey)
      .exec();

    const hits = this.result(results, 0, "GET");
    const window = this.numberResult(results, 1, "PTTL");

    // A block outliving the window it came from is still a block. Reporting zero
    // hits for it would hand the allowance back to a client the guard is refusing.
    return [Number(hits) || limit + 1, window];
  }

  /**
   * `EXEC` reports a failed command as an `[error, null]` pair instead of
   * rejecting, so a pair nobody inspects is a `null` that quietly reads as a
   * number — the shape of "the limiter counted nothing and logged nothing". A
   * command that failed has to reach the outage path instead.
   */
  private result(
    results: CommandResult[] | null,
    index: number,
    command: string,
  ): unknown {
    const pair = results?.[index];
    if (!pair) {
      throw new Error(`Redis EXEC returned no result for ${command}`);
    }
    const [error, value] = pair;
    if (error) {
      throw error;
    }
    return value;
  }

  private numberResult(
    results: CommandResult[] | null,
    index: number,
    command: string,
  ): number {
    const value = this.result(results, index, command);
    const numeric = Number(value);
    if (value === null || !Number.isFinite(numeric)) {
      throw new Error(
        `Redis ${command} returned ${String(value)} instead of a number`,
      );
    }
    return numeric;
  }

  /**
   * Counting a hit in memory instead of in Redis is the right answer about an
   * outage and a partial one about a fleet: the allowance is no longer shared, so
   * the ceiling becomes limit × replicas until Redis answers again. The old
   * behaviour was to permit the request outright, which made every health check
   * pass while no limit applied anywhere — and a per-request `warn` buried even
   * that in the same traffic the outage was producing, so a limiter that counted
   * nothing was also a limiter that logged nothing. Hence: error level, once per
   * interval, with what was counted where.
   */
  private reportDegradedRequest(err: unknown, counted: boolean): void {
    if (counted) {
      this.countedLocally += 1;
    } else {
      this.permittedBlindly += 1;
    }

    const reason =
      err instanceof Error ? err.message : `Redis error ${String(err)}`;
    this.announceOutage(
      `Redis throttler increment failed, so hits are counted in this process: ${reason}.`,
    );
  }

  private announceOutage(reason: string): void {
    const now = Date.now();
    if (now - this.lastOutageReportAt < OUTAGE_REPORT_INTERVAL_MS) {
      return;
    }
    this.lastOutageReportAt = now;

    const tally = [
      this.countedLocally > 0
        ? `${this.countedLocally} request(s) counted in memory`
        : "",
      this.permittedBlindly > 0
        ? `${this.permittedBlindly} permitted with no counter at all`
        : "",
    ].filter(Boolean);

    this.logger.error(
      `Rate limiting is degraded to this process only: ${reason}` +
        (tally.length > 0
          ? ` (${tally.join(", ")} since Redis last answered; the ceiling while ` +
            "it is down is the configured limit per replica)."
          : ""),
    );
  }

  private toSeconds(remainingMs: number, fallbackMs: number): number {
    return Math.max(
      0,
      Math.ceil((remainingMs > 0 ? remainingMs : fallbackMs) / 1000),
    );
  }

  async onModuleDestroy() {
    // `lazyConnect` means the socket is opened by the first command, so a process
    // that never took a throttled request has nothing to close — and `quit()`
    // would connect just to say goodbye. Drop the pending client instead.
    if (this.redis.status === "wait") {
      this.redis.disconnect();
      return;
    }
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
