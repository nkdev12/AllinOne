/**
 * What the throttler library asks a storage to report. Declared here rather than
 * imported: `@nestjs/throttler` exposes `ThrottlerStorage` from its index but not
 * this record type, which is why `redis-throttler.storage.ts` declares its own.
 */
export interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

interface LocalWindow {
  hits: number;
  /** Armed by the first hit and never refreshed — the in-process `PEXPIRE NX`. */
  windowExpiresAt: number;
  /** Set once, when a hit crosses the limit; not stretched by later hits. */
  blockedUntil: number;
}

/**
 * Roughly 2 MB of entries. Sized for a NAT'd office or a busy egress during an
 * outage, not for a whole internet: this table only has to survive a Redis
 * failure, and every key in it dies with the process anyway.
 */
const DEFAULT_MAX_TRACKED_KEYS = 20_000;

/**
 * Counts throttled hits in this process's memory.
 *
 * This is the shape the library's own default storage uses, and it is not the
 * primary store: `RedisThrottlerStorage` keeps Redis as the source of truth and
 * calls here only while Redis is not answering. The point is that a Redis outage
 * stops meaning "no limit anywhere" and starts meaning "the limit is per
 * process" — see the class comment there for why the old fail-open was refused
 * rather than accepted.
 *
 * Two properties a reader should not mistake for bugs. The ceiling is
 * `limit × replicas`, because processes do not talk to each other here; and
 * every window and every block is forgotten when the process restarts *and* when
 * Redis comes back, since the next hit is counted there again.
 */
export class LocalThrottlerWindow {
  private readonly windows = new Map<string, LocalWindow>();

  constructor(private readonly maxTrackedKeys = DEFAULT_MAX_TRACKED_KEYS) {}

  /**
   * `null` means the table is full of live blocks and nothing could be
   * reclaimed. The caller then permits the request — the thing this class exists
   * to avoid — because the alternative is refusing a stranger for a table it
   * never touched, and a limiter that invents blocks is worse than one that
   * admits it ran out of room.
   */
  record(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    now = Date.now(),
  ): ThrottlerStorageRecord | null {
    const tracked = this.windows.get(key);

    // Checked before the window's own expiry: a block that outlives the window it
    // came from is still a block, and such a caller is not counted — the same
    // early return `RedisThrottlerStorage.readCounter()` makes.
    if (tracked && tracked.blockedUntil > now) {
      return {
        totalHits: tracked.hits > limit ? tracked.hits : limit + 1,
        timeToExpire: this.remaining(tracked.windowExpiresAt, now, ttl),
        isBlocked: true,
        timeToBlockExpire: this.remaining(
          tracked.blockedUntil,
          now,
          blockDuration,
        ),
      };
    }

    const window =
      tracked && tracked.windowExpiresAt > now
        ? tracked
        : this.openWindow(key, ttl, now);
    if (!window) return null;

    window.hits += 1;

    const isBlocked = blockDuration > 0 && window.hits > limit;
    if (isBlocked) {
      window.blockedUntil = now + blockDuration;
    }

    return {
      totalHits: window.hits,
      timeToExpire: this.remaining(window.windowExpiresAt, now, ttl),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil(blockDuration / 1000) : 0,
    };
  }

  /** Keys held in memory right now; a test hook and an outage diagnostic. */
  get trackedKeys(): number {
    return this.windows.size;
  }

  /** Redis answered again, so windows counted here are no longer authoritative. */
  clear(): void {
    this.windows.clear();
  }

  private openWindow(
    key: string,
    ttl: number,
    now: number,
  ): LocalWindow | null {
    // Deleting first is what moves the key to the back of the Map's insertion
    // order, which is the order `reclaim()` evicts in.
    this.windows.delete(key);

    if (this.windows.size >= this.maxTrackedKeys && !this.reclaim(now)) {
      return null;
    }

    const fresh: LocalWindow = {
      hits: 0,
      windowExpiresAt: now + ttl,
      blockedUntil: 0,
    };
    this.windows.set(key, fresh);
    return fresh;
  }

  /**
   * Free one slot without deleting a live block if any other candidate exists:
   * an expired window first, then a window whose block has run out, and nothing
   * at all if every entry is still refusing somebody.
   */
  private reclaim(now: number): boolean {
    let firstUnblocked: string | undefined;

    for (const [key, window] of this.windows) {
      const liveUntil = Math.max(window.windowExpiresAt, window.blockedUntil);
      if (liveUntil <= now) {
        this.windows.delete(key);
        return true;
      }
      if (window.blockedUntil <= now && firstUnblocked === undefined) {
        firstUnblocked = key;
      }
    }

    if (firstUnblocked !== undefined) {
      this.windows.delete(firstUnblocked);
      return true;
    }
    return false;
  }

  /** Mirrors `RedisThrottlerStorage.toSeconds()`, including its fallback. */
  private remaining(
    expiresAt: number,
    now: number,
    fallbackMs: number,
  ): number {
    const left = expiresAt - now;
    return Math.max(0, Math.ceil((left > 0 ? left : fallbackMs) / 1000));
  }
}
