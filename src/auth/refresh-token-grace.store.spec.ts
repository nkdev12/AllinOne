import { RefreshTokenGraceStore } from "./refresh-token-grace.store";
import type {
  RefreshRotationMarker,
  RotatedRefreshGraceRecord,
} from "./refresh-token-grace.store";

const GRACE_MS = 30 * 1000;

function graceRecord(
  sessionId = "session-uuid-789",
): RotatedRefreshGraceRecord {
  return {
    tokens: {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresIn: 3600,
    },
    deviceId: "device-uuid-456",
    sessionId,
    userId: "user-uuid-123",
  };
}

function rotationMarker(sessionId = "session-uuid-789"): RefreshRotationMarker {
  return { sessionId, userId: "user-uuid-123" };
}

/**
 * A Redis double that keeps keys, set members and pipeline ordering honest
 * enough to assert on: `exec` applies what `set`/`sadd`/`pexpire` queued, the
 * way the real pipeline does, so a record is only readable after the write has
 * gone through.
 */
function buildRedis() {
  const kv = new Map<string, string>();
  const members = new Map<string, Set<string>>();
  const queue: Array<() => void> = [];

  const pipe: any = {
    set: jest.fn((key: string, value: string) => {
      queue.push(() => kv.set(key, value));
      return pipe;
    }),
    sadd: jest.fn((key: string, member: string) => {
      queue.push(() => {
        const current = members.get(key) ?? new Set<string>();
        current.add(member);
        members.set(key, current);
      });
      return pipe;
    }),
    pexpire: jest.fn(() => pipe),
    exec: jest.fn(() => {
      for (const op of queue.splice(0, queue.length)) op();
      return Promise.resolve([]);
    }),
  };

  return {
    kv,
    members,
    pipe,
    redis: {
      status: "ready",
      pipeline: jest.fn(() => pipe),
      get: jest.fn((key: string) => Promise.resolve(kv.get(key) ?? null)),
      set: jest.fn((key: string, value: string) => {
        kv.set(key, value);
        return Promise.resolve("OK");
      }),
      smembers: jest.fn((key: string) =>
        Promise.resolve([...(members.get(key) ?? [])]),
      ),
      del: jest.fn((...keys: string[]) => {
        for (const key of keys) {
          kv.delete(key);
          members.delete(key);
        }
        return Promise.resolve(keys.length);
      }),
      quit: jest.fn(() => Promise.resolve("OK")),
      disconnect: jest.fn(),
      on: jest.fn(),
    } as any,
  };
}

describe("RefreshTokenGraceStore", () => {
  const redisConfig = {
    usesRedisThrottlerStorage: true,
    redisUrl: "redis://localhost:6379",
  };

  describe("with Redis", () => {
    let double: ReturnType<typeof buildRedis>;
    let store: RefreshTokenGraceStore;

    beforeEach(() => {
      double = buildRedis();
      store = new RefreshTokenGraceStore(redisConfig as any, double.redis);
    });

    it("keeps the rotated pair under a keyed TTL and reads it back", async () => {
      await store.set("old-refresh-token", graceRecord(), GRACE_MS);

      const key = [...double.kv.keys()][0];
      expect(key).toMatch(/^auth:refresh-grace:token:[0-9a-f]{64}$/);
      expect(double.pipe.set).toHaveBeenCalledWith(
        key,
        JSON.stringify(graceRecord()),
        "PX",
        GRACE_MS,
      );
      await expect(store.get("old-refresh-token")).resolves.toEqual(
        graceRecord(),
      );
    });

    /**
     * The stored value is a bearer credential that works against every service
     * this Redis is shared with, so neither the key list nor a value dump may
     * name it.
     */
    it("never puts the refresh token itself into Redis", async () => {
      await store.set("super-secret-refresh-token", graceRecord(), GRACE_MS);

      const dumped = JSON.stringify([
        [...double.kv.keys()],
        [...double.kv.values()],
        [...double.members.keys()],
        [...double.members.values()].map((set) => [...set]),
      ]);
      expect(dumped).not.toContain("super-secret-refresh-token");
    });

    it("expires the session index with the record it points at", async () => {
      await store.set("old-refresh-token", graceRecord(), GRACE_MS);

      expect(double.pipe.pexpire).toHaveBeenCalledWith(
        "auth:refresh-grace:session:session-uuid-789",
        GRACE_MS,
      );
    });

    it("lets one worker's record answer another worker's replay", async () => {
      // Two processes, one Redis: the second store is the replica that used to
      // keep its own map and therefore knew nothing about the rotation the first
      // one had just performed — the exact hole a grace window is meant to close.
      const otherWorker = new RefreshTokenGraceStore(
        redisConfig as any,
        double.redis,
      );

      await store.set("race-refresh-token", graceRecord(), GRACE_MS);

      await expect(otherWorker.get("race-refresh-token")).resolves.toEqual(
        graceRecord(),
      );
    });

    it("clears only the logged-out session's records", async () => {
      await store.set("first-token", graceRecord(), GRACE_MS);
      await store.set(
        "second-token",
        graceRecord("session-uuid-000"),
        GRACE_MS,
      );

      await store.deleteForSession("session-uuid-789");

      await expect(store.get("first-token")).resolves.toBeNull();
      await expect(store.get("second-token")).resolves.toEqual(
        graceRecord("session-uuid-000"),
      );
    });

    /**
     * The direction a Redis outage has to go in. Answering from this process's
     * own memory would honour a replay the shared store knows nothing about,
     * which is the failure this file exists to remove; answering "no record"
     * costs the honest client a re-login and still refuses the copied one.
     */
    it("fails closed when Redis cannot be read", async () => {
      await store.set("old-refresh-token", graceRecord(), GRACE_MS);
      double.redis.get.mockRejectedValueOnce(new Error("ECONNRESET"));

      await expect(store.get("old-refresh-token")).resolves.toBeNull();
    });

    it("does not throw when the record cannot be stored", async () => {
      double.redis.pipeline.mockImplementationOnce(() => {
        throw new Error("Redis is offline");
      });

      await expect(
        store.set("old-refresh-token", graceRecord(), GRACE_MS),
      ).resolves.toBeUndefined();
    });

    it("does not throw when logout's cleanup cannot run", async () => {
      double.redis.smembers.mockRejectedValueOnce(
        new Error("Redis is offline"),
      );

      await expect(
        store.deleteForSession("session-uuid-789"),
      ).resolves.toBeUndefined();
    });

    it("ignores a value it cannot read back as a record", async () => {
      await store.set("old-refresh-token", graceRecord(), GRACE_MS);
      double.redis.get.mockResolvedValueOnce("{not json");

      await expect(store.get("old-refresh-token")).resolves.toBeNull();
    });

    it("leaves a connection it was handed to its owner", async () => {
      double.redis.status = "wait";

      await store.close();

      expect(double.redis.quit).not.toHaveBeenCalled();
      expect(double.redis.disconnect).not.toHaveBeenCalled();
    });

    /**
     * The marker is a different fact from the grace record: it says "this
     * credential was rotated", it has to outlive the 30 seconds the record lives
     * for, and it is the only thing that lets a token returning after the window
     * be read as theft instead of as garbage.
     */
    describe("rotation markers", () => {
      const ROTATION_TTL_MS = 86400 * 1000;

      it("keeps the marker under its own namespace for the credential lifetime", async () => {
        await store.markRotated(
          "rotated-refresh-token",
          rotationMarker(),
          ROTATION_TTL_MS,
        );

        const key = [...double.kv.keys()][0];
        expect(key).toMatch(/^auth:refresh-grace:rotation:[0-9a-f]{64}$/);
        expect(double.redis.set).toHaveBeenCalledWith(
          key,
          JSON.stringify(rotationMarker()),
          "PX",
          ROTATION_TTL_MS,
        );
      });

      it("answers a replay after the window closed, when the grace record cannot", async () => {
        await store.set("rotated-refresh-token", graceRecord(), GRACE_MS);
        await store.markRotated(
          "rotated-refresh-token",
          rotationMarker(),
          ROTATION_TTL_MS,
        );

        // Two keys, one namespace each: sharing a key would either hide the
        // rotation until the window expired or stretch the window to days.
        expect([...double.kv.keys()]).toHaveLength(2);
        await expect(store.get("rotated-refresh-token")).resolves.toEqual(
          graceRecord(),
        );
        await expect(
          store.getRotationMarker("rotated-refresh-token"),
        ).resolves.toEqual(rotationMarker());
      });

      it("lets one worker's marker answer another worker's replay", async () => {
        const otherWorker = new RefreshTokenGraceStore(
          redisConfig as any,
          double.redis,
        );

        await store.markRotated(
          "rotated-refresh-token",
          rotationMarker(),
          ROTATION_TTL_MS,
        );

        await expect(
          otherWorker.getRotationMarker("rotated-refresh-token"),
        ).resolves.toEqual(rotationMarker());
      });

      it("never puts the refresh token itself into a marker", async () => {
        await store.markRotated(
          "super-secret-refresh-token",
          rotationMarker(),
          ROTATION_TTL_MS,
        );

        const dumped = JSON.stringify([
          [...double.kv.keys()],
          [...double.kv.values()],
        ]);
        expect(dumped).not.toContain("super-secret-refresh-token");
      });

      /**
       * A logout closes the family, but the replay that arrives afterwards still
       * has to be classifiable as a replay. Sweeping markers with the grace
       * records would erase the intrusion signal on exactly the path an attacker
       * who forced a logout would take.
       */
      it("keeps the marker after logout clears the session's grace records", async () => {
        await store.set("rotated-refresh-token", graceRecord(), GRACE_MS);
        await store.markRotated(
          "rotated-refresh-token",
          rotationMarker(),
          ROTATION_TTL_MS,
        );

        await store.deleteForSession("session-uuid-789");

        await expect(store.get("rotated-refresh-token")).resolves.toBeNull();
        await expect(
          store.getRotationMarker("rotated-refresh-token"),
        ).resolves.toEqual(rotationMarker());
      });

      it("reports no marker when Redis cannot be read", async () => {
        double.redis.get.mockRejectedValueOnce(new Error("ECONNRESET"));

        await expect(
          store.getRotationMarker("rotated-refresh-token"),
        ).resolves.toBeNull();
      });

      it("does not throw when the marker cannot be written", async () => {
        double.redis.set.mockRejectedValueOnce(new Error("Redis is offline"));

        await expect(
          store.markRotated(
            "rotated-refresh-token",
            rotationMarker(),
            ROTATION_TTL_MS,
          ),
        ).resolves.toBeUndefined();
      });

      it("ignores a marker it cannot read back as a record", async () => {
        await store.markRotated(
          "rotated-refresh-token",
          rotationMarker(),
          ROTATION_TTL_MS,
        );
        double.redis.get.mockResolvedValueOnce('{"sessionId":"only-half"}');

        await expect(
          store.getRotationMarker("rotated-refresh-token"),
        ).resolves.toBeNull();
      });
    });
  });

  describe("without Redis", () => {
    const memoryConfig = {
      usesRedisThrottlerStorage: false,
      redisUrl: "redis://localhost:6379",
    };

    it("keeps the window in process and opens no connection", async () => {
      // `APP_ENV=test` arrives through the same flag that decides whether
      // `RedisThrottlerStorage` is registered at all, so the Jest suites are
      // never asked to reach a server that is not listening.
      const store = new RefreshTokenGraceStore(memoryConfig as any);

      await store.set("old-refresh-token", graceRecord(), GRACE_MS);
      await expect(store.get("old-refresh-token")).resolves.toEqual(
        graceRecord(),
      );
      await expect(store.get("unknown-token")).resolves.toBeNull();

      await store.close();
    });

    it("forgets a record once its window has passed", async () => {
      jest.useFakeTimers();
      try {
        const store = new RefreshTokenGraceStore(memoryConfig as any);
        await store.set("old-refresh-token", graceRecord(), GRACE_MS);

        jest.advanceTimersByTime(GRACE_MS + 1);

        await expect(store.get("old-refresh-token")).resolves.toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it("forgets a session's records on logout", async () => {
      const store = new RefreshTokenGraceStore(memoryConfig as any);
      await store.set("old-refresh-token", graceRecord(), GRACE_MS);

      await store.deleteForSession("session-uuid-789");

      await expect(store.get("old-refresh-token")).resolves.toBeNull();
    });

    describe("rotation markers", () => {
      const ROTATION_TTL_MS = 86400 * 1000;

      it("keeps the marker in process and opens no connection", async () => {
        const store = new RefreshTokenGraceStore(memoryConfig as any);

        await store.markRotated(
          "rotated-refresh-token",
          rotationMarker(),
          ROTATION_TTL_MS,
        );

        await expect(
          store.getRotationMarker("rotated-refresh-token"),
        ).resolves.toEqual(rotationMarker());
        await expect(
          store.getRotationMarker("never-rotated-token"),
        ).resolves.toBeNull();

        await store.close();
      });

      it("keeps the marker past the window the grace record lives for", async () => {
        jest.useFakeTimers();
        try {
          const store = new RefreshTokenGraceStore(memoryConfig as any);
          await store.set("rotated-refresh-token", graceRecord(), GRACE_MS);
          await store.markRotated(
            "rotated-refresh-token",
            rotationMarker(),
            ROTATION_TTL_MS,
          );

          jest.advanceTimersByTime(GRACE_MS + 1);

          await expect(store.get("rotated-refresh-token")).resolves.toBeNull();
          await expect(
            store.getRotationMarker("rotated-refresh-token"),
          ).resolves.toEqual(rotationMarker());

          jest.advanceTimersByTime(ROTATION_TTL_MS);

          await expect(
            store.getRotationMarker("rotated-refresh-token"),
          ).resolves.toBeNull();
        } finally {
          jest.useRealTimers();
        }
      });
    });
  });
});
