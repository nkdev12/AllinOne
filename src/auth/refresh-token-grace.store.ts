import { Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import Redis from "ioredis";
import * as crypto from "crypto";
import { ConfigurationService } from "@/config/configuration.service";
import type { AuthTokenDataDto } from "./dto/auth-response.dto";

export interface RotatedRefreshGraceRecord {
  tokens: AuthTokenDataDto;
  deviceId: string;
  sessionId: string;
  userId: string;
}

/**
 * Proof that a presented token was once rotated: written when rotation succeeds
 * and read when the same credential comes back after the grace window has closed.
 */
export interface RefreshRotationMarker {
  sessionId: string;
  userId: string;
}

const KEY_PREFIX = "auth:refresh-grace:";

/**
 * The rotated-refresh-token grace window, shared by every worker.
 *
 * `AuthService.refreshTokens` replaces the credential on each call, so a client
 * with a second request still carrying the old token would be locked out by its
 * own retry. The grace record answers that retry with the pair that was already
 * minted instead of a 401 — and it is also the only signal that separates a
 * laggy client from somebody who copied the token out of a database. Held in a
 * process-local `Map`, that signal was per-worker: a replay routed to the other
 * replica found no record there, so the window either protected nobody or, when
 * the second worker minted its own pair, quietly invalidated the first client's
 * session.
 *
 * Redis is the same place `RedisThrottlerStorage` puts counters that have to
 * outlive the worker that counted them, and it is the same decision whether to
 * reach for it at all: `usesRedisThrottlerStorage` is false under `APP_ENV=test`
 * and on a laptop that named no `REDIS_URL`, which keeps this suite from opening
 * a socket to a server that is not listening.
 *
 * When Redis is unreachable every read answers "no record", which is the side
 * that denies: the presented token matches no row and the caller must
 * authenticate again. A write that fails leaves the same shape — the next
 * concurrent retry is refused rather than honoured from a copy of this process's
 * memory. Degradation costs an extra login, never the reuse detection.
 *
 * The second namespace here, `rotation:`, is not a shorter version of the grace
 * window but a different fact with a different lifetime. A grace record says
 * "this token was rotated seconds ago; the retry is probably the same client"
 * and is worth 30 seconds. A rotation marker says "this credential was valid
 * enough to be rotated", keeps the answer for the whole refresh-token lifetime,
 * and is what lets a token that returns after the window be read as theft rather
 * than as garbage. Because the marker exists to outlive the session it describes,
 * `deleteForSession` deliberately clears only grace records: a replay that
 * arrives after a logout still has to be classifiable as a replay.
 */
@Injectable()
export class RefreshTokenGraceStore implements OnModuleDestroy {
  private readonly logger = new Logger(RefreshTokenGraceStore.name);
  private readonly redis?: Redis;
  // An injected client belongs to whoever handed it over; this class closes only
  // the socket it opened itself.
  private readonly ownsConnection: boolean;
  private readonly memory = new Map<
    string,
    { record: RotatedRefreshGraceRecord; expiresAt: number }
  >();
  private readonly rotations = new Map<
    string,
    { marker: RefreshRotationMarker; expiresAt: number }
  >();

  constructor(
    configService: ConfigurationService,
    @Optional() redisClient?: Redis,
  ) {
    this.ownsConnection = !redisClient;
    if (!configService.usesRedisThrottlerStorage) {
      return;
    }

    this.redis =
      redisClient ??
      new Redis(configService.redisUrl, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: false,
        lazyConnect: true,
      });

    if (!redisClient) {
      this.redis.on("error", (err) => {
        this.logger.error(
          `Redis refresh-token grace store connection error: ${err.message}`,
        );
      });
    }
  }

  /**
   * Redis is not a credential store. The key is a digest of the token, so an RDB
   * dump, a `MONITOR` on a shared managed instance, or a careless `KEYS` listing
   * does not hand out sessions that work against every service in the fleet.
   */
  private digest(refreshToken: string): string {
    return crypto.createHash("sha256").update(refreshToken).digest("hex");
  }

  private keyFor(refreshToken: string): string {
    return `${KEY_PREFIX}token:${this.digest(refreshToken)}`;
  }

  /**
   * A separate namespace, because a marker answers a different question than a
   * grace record and has to survive the 30 seconds a grace record lives for.
   * Sharing one key would mean the reuse check either could not see the rotation
   * until after the window closed, or the window had to be widened to days —
   * which would hand a stolen token's holder days of free replays.
   */
  private rotationKeyFor(refreshToken: string): string {
    return `${KEY_PREFIX}rotation:${this.digest(refreshToken)}`;
  }

  private sessionKeyFor(sessionId: string): string {
    return `${KEY_PREFIX}session:${sessionId}`;
  }

  async get(refreshToken: string): Promise<RotatedRefreshGraceRecord | null> {
    const key = this.keyFor(refreshToken);

    if (!this.redis) {
      const entry = this.memory.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        this.memory.delete(key);
        return null;
      }
      return entry.record;
    }

    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as RotatedRefreshGraceRecord;
      // A record written by another build, or a truncated value, is not a
      // reason to hand a caller a half-populated session.
      if (!parsed?.tokens?.accessToken || !parsed?.sessionId) {
        return null;
      }
      return parsed;
    } catch (err: any) {
      this.logger.warn(
        `Refresh-token grace lookup failed (${err.message}). Treating the token as rotated with no grace record, so the replay is refused instead of trusted.`,
      );
      return null;
    }
  }

  async set(
    refreshToken: string,
    record: RotatedRefreshGraceRecord,
    ttlMs: number,
  ): Promise<void> {
    const key = this.keyFor(refreshToken);

    if (!this.redis) {
      const now = Date.now();
      for (const [stale, entry] of this.memory.entries()) {
        if (entry.expiresAt <= now) this.memory.delete(stale);
      }
      this.memory.set(key, { record, expiresAt: now + ttlMs });
      return;
    }

    try {
      const pipeline = this.redis.pipeline();
      pipeline.set(key, JSON.stringify(record), "PX", ttlMs);
      // The session index is what lets `logout` clear this session's records
      // without scanning keyspace; it expires with its newest member, so a
      // record that times out on its own cannot leave a dangling list behind.
      pipeline.sadd(this.sessionKeyFor(record.sessionId), key);
      pipeline.pexpire(this.sessionKeyFor(record.sessionId), ttlMs);
      await pipeline.exec();
    } catch (err: any) {
      this.logger.warn(
        `Refresh-token grace record could not be stored (${err.message}). The next concurrent retry with this token will be refused and re-authenticate.`,
      );
    }
  }

  /**
   * Record that `refreshToken` was successfully rotated, for as long as the
   * credential it replaced would itself have been honoured.
   *
   * Only the digests and the two ids go out; the token never does, and no grace
   * pair is stored alongside it, so a marker cannot hand an attacker anything —
   * it is a fact about a credential, not a credential.
   */
  async markRotated(
    refreshToken: string,
    marker: RefreshRotationMarker,
    ttlMs: number,
  ): Promise<void> {
    const key = this.rotationKeyFor(refreshToken);

    if (!this.redis) {
      const now = Date.now();
      for (const [stale, entry] of this.rotations.entries()) {
        if (entry.expiresAt <= now) this.rotations.delete(stale);
      }
      this.rotations.set(key, { marker, expiresAt: now + ttlMs });
      return;
    }

    try {
      await this.redis.set(key, JSON.stringify(marker), "PX", ttlMs);
    } catch (err: any) {
      // Losing the marker costs the intrusion signal, not the session: the next
      // replay of this token is refused as an unknown credential instead of
      // being read as theft.
      this.logger.warn(
        `Refresh-token rotation marker could not be stored (${err.message}). A later replay of this token will be refused without being reported as reuse.`,
      );
    }
  }

  /**
   * Answers "was this credential ever rotated?", and answers it in the only safe
   * direction: a store that cannot be read, or a value that cannot be parsed,
   * reports no marker, which leaves a legitimate refresh working and forgoes the
   * revocation rather than failing the request or shutting an honest session down.
   */
  async getRotationMarker(
    refreshToken: string,
  ): Promise<RefreshRotationMarker | null> {
    const key = this.rotationKeyFor(refreshToken);

    if (!this.redis) {
      const entry = this.rotations.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        this.rotations.delete(key);
        return null;
      }
      return entry.marker;
    }

    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as RefreshRotationMarker;
      if (!parsed?.sessionId || !parsed?.userId) return null;
      return parsed;
    } catch (err: any) {
      this.logger.warn(
        `Refresh-token rotation marker lookup failed (${err.message}). The presented token is treated as unknown, so nothing is revoked on the strength of a read that did not happen.`,
      );
      return null;
    }
  }

  async deleteForSession(sessionId: string): Promise<void> {
    if (!this.redis) {
      for (const [key, entry] of this.memory.entries()) {
        if (entry.record.sessionId === sessionId) {
          this.memory.delete(key);
        }
      }
      return;
    }

    const indexKey = this.sessionKeyFor(sessionId);
    try {
      const keys = await this.redis.smembers(indexKey);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      await this.redis.del(indexKey);
    } catch (err: any) {
      // Cleanup is best-effort. `refreshTokens` re-reads the session row before
      // honouring a grace record, and logout has just revoked that row, so a
      // record that survives here cannot resurrect the session.
      this.logger.warn(
        `Refresh-token grace records for session ${sessionId} could not be cleared (${err.message}); they expire with the grace TTL.`,
      );
    }
  }

  async close(): Promise<void> {
    if (!this.redis || !this.ownsConnection) return;
    // `lazyConnect` means the socket is opened by the first command, so a
    // process that never rotated a token has nothing to quit — and `quit()`
    // would connect just to say goodbye.
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

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
