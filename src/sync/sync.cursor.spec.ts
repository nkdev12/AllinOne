import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ChangeOperation } from "@prisma/client";
import { SyncService } from "./sync.service";
import { SyncGateway } from "./sync.gateway";
import { SyncNotificationService } from "./sync-notification.service";
import { appendChange } from "./change-cursor";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ErrorCode } from "@/common/errors/error-code";

/**
 * Regression cover for the cursor, so it runs against an in-memory change log
 * rather than per-call mocks: the bug was invisible to mocks because each mock
 * answered one call in isolation, while the failure only shows up when a cursor
 * written by one device has to survive a round trip through another one's pull.
 */

interface FakeChange {
  id: string;
  userId: string;
  deviceId: string | null;
  entityType: string;
  entityId: string;
  operation: string;
  version: number;
  payload: any;
  cursor: bigint;
  createdAt: Date;
}

interface FakeDevice {
  id: string;
  userId: string;
  revokedAt: Date | null;
}

type OrderBy = { [field: string]: "asc" | "desc" };

function vaultPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "LOGIN",
    encryptedData: "base64-blob",
    iv: "base64-iv",
    authTag: "base64-tag",
    isEncrypted: true,
    ...overrides,
  };
}

function compare(
  left: FakeChange,
  right: FakeChange,
  orderBy: OrderBy,
): number {
  for (const [field, direction] of Object.entries(orderBy)) {
    const a = (left as any)[field];
    const b = (right as any)[field];
    if (a === b) continue;
    const worse = direction === "desc" ? -1 : 1;
    return (a < b ? -1 : 1) * worse;
  }
  return 0;
}

function createFakePrisma(devices: FakeDevice[]) {
  const changes: FakeChange[] = [];
  const counters = new Map<string, bigint>();
  const syncStates = new Map<string, any>();
  let nextId = 0;

  const matches = (row: FakeChange, where: any = {}): boolean => {
    for (const key of ["userId", "entityType", "entityId"] as const) {
      if (where[key] !== undefined && row[key] !== where[key]) return false;
    }
    if (where.cursor !== undefined) {
      const filter = where.cursor;
      return typeof filter === "object" && filter !== null && "gt" in filter
        ? row.cursor > filter.gt
        : row.cursor === filter;
    }
    return true;
  };

  const select = (rows: FakeChange[], orderBy: OrderBy) =>
    [...rows].sort((left, right) => compare(left, right, orderBy));

  const fake: any = {
    $transaction: jest.fn((callback: any) => callback(fake)),
    device: {
      findFirst: jest.fn(async ({ where }: any) => {
        const device = devices.find(
          (candidate) =>
            candidate.id === where.id &&
            candidate.userId === where.userId &&
            candidate.revokedAt === where.revokedAt,
        );
        return device ?? null;
      }),
    },
    change: {
      create: jest.fn(async ({ data }: any) => {
        const row: FakeChange = {
          id: `change-${++nextId}`,
          createdAt: new Date(),
          deviceId: data.deviceId ?? null,
          userId: data.userId,
          entityType: data.entityType,
          entityId: data.entityId,
          operation: data.operation,
          version: data.version,
          payload: data.payload,
          cursor: data.cursor,
        };
        changes.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        const rows = select(
          changes.filter((row) => matches(row, where)),
          orderBy ?? { cursor: "asc" },
        );
        return rows[0] ?? null;
      }),
      findMany: jest.fn(async ({ where, orderBy, take }: any) => {
        const rows = select(
          changes.filter((row) => matches(row, where)),
          Array.isArray(orderBy) ? Object.assign({}, ...orderBy) : orderBy,
        );
        return take === undefined ? rows : rows.slice(0, take);
      }),
    },
    // Something for the write-through projection to land on. This spec is about
    // cursors, so the row only has to answer a read and accept a write; the
    // projection's own rules are in `change-projection.spec.ts`.
    note: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({ ...data })),
      update: jest.fn(async ({ data }: any) => ({ ...data })),
    },
    folder: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({ ...data })),
      update: jest.fn(async ({ data }: any) => ({ ...data })),
    },
    syncCursor: {
      upsert: jest.fn(async ({ where, update, create }: any) => {
        const current = counters.get(where.userId) ?? BigInt(0);
        const next =
          update?.seq?.increment !== undefined
            ? current + update.seq.increment
            : (create?.seq ?? current);
        counters.set(where.userId, next);
        return { seq: next };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const seq = counters.get(where.userId);
        return seq === undefined ? null : { seq };
      }),
    },
    deviceSyncState: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const stored = syncStates.get(where.deviceId);
        const increment = update?.lastPushedSequence?.increment;
        const row = stored
          ? {
              ...stored,
              ...update,
              ...(increment === undefined
                ? {}
                : {
                    lastPushedSequence: stored.lastPushedSequence + increment,
                  }),
            }
          : {
              id: `state-${where.deviceId}`,
              deviceId: where.deviceId,
              ...create,
            };

        syncStates.set(where.deviceId, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return syncStates.get(where.deviceId) ?? null;
      }),
    },
  };

  return { fake, changes, counters };
}

describe("SyncService change cursor", () => {
  const userA = "user-a";
  const phoneA = "device-phone-a";
  const laptopA = "device-laptop-a";

  let fake: any;
  let changes: FakeChange[];
  let gateway: { notifySyncInvalidation: jest.Mock };
  let service: SyncService;

  beforeEach(async () => {
    ({ fake, changes } = createFakePrisma([
      { id: phoneA, userId: userA, revokedAt: null },
      { id: laptopA, userId: userA, revokedAt: null },
    ]));
    gateway = { notifySyncInvalidation: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: PrismaService, useValue: fake },
        { provide: SyncGateway, useValue: gateway },
        // The real notifier around the gateway double: `SyncService` now sends
        // its wake-up through the same choke point the REST write paths use, and
        // the assertion below is about what reached the socket either way.
        SyncNotificationService,
      ],
    }).compile();

    service = module.get<SyncService>(SyncService);
  });

  async function pushNote(entityId: string, version: number) {
    return service.pushChanges(userA, {
      deviceId: phoneA,
      changes: [
        {
          entityType: "note",
          entityId,
          operation: ChangeOperation.CREATE,
          version,
          payload: {
            title: `Note ${entityId} v${version}`,
            content: `Body of ${entityId} at version ${version}`,
          },
        },
      ],
    });
  }

  it("replays a pushed change to another device using the returned cursor", async () => {
    const pushed = await pushNote("note-1", 1);

    expect(pushed.newCursor).toBe("1");
    expect(pushed.highestCursor).toBe("1");

    const firstPull = await service.pullChanges(userA, { deviceId: laptopA });
    expect(firstPull.changes).toHaveLength(1);
    expect(firstPull.changes[0].entityId).toBe("note-1");
    expect(firstPull.nextCursor).toBe("1");

    const laptopCheckpoint = firstPull.nextCursor;
    const later = await pushNote("note-2", 1);
    expect(later.newCursor).toBe("2");

    const secondPull = await service.pullChanges(userA, {
      deviceId: laptopA,
      cursor: laptopCheckpoint,
    });
    expect(secondPull.changes.map((change) => change.entityId)).toEqual([
      "note-2",
    ]);
    expect(secondPull.nextCursor).toBe("2");
  });

  it("returns nothing on a second pull from the same cursor", async () => {
    await pushNote("note-1", 1);
    const firstPull = await service.pullChanges(userA, { deviceId: laptopA });

    const repeat = await service.pullChanges(userA, {
      deviceId: laptopA,
      cursor: firstPull.nextCursor,
    });

    expect(repeat.changes).toEqual([]);
    expect(repeat.hasMore).toBe(false);
    // Echoing "0" here would send the device back to the start of its own log.
    expect(repeat.nextCursor).toBe(firstPull.nextCursor);
  });

  it("keeps cursors strictly increasing across successive pushes", async () => {
    const batchOne = await service.pushChanges(userA, {
      deviceId: phoneA,
      changes: [
        {
          entityType: "note",
          entityId: "note-1",
          operation: ChangeOperation.CREATE,
          version: 1,
          payload: { title: "One", content: "First body" },
        },
        {
          entityType: "task",
          entityId: "task-1",
          operation: ChangeOperation.CREATE,
          version: 1,
          payload: { title: "Two" },
        },
      ],
    });

    const batchTwo = await pushNote("note-3", 1);

    expect(batchOne.newCursor).toBe("2");
    expect(batchTwo.newCursor).toBe("3");
    expect(BigInt(batchTwo.newCursor) > BigInt(batchOne.newCursor)).toBe(true);
    expect(changes.map((change) => change.cursor.toString())).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("pages the log and only claims more rows while they exist", async () => {
    await pushNote("note-1", 1);
    await pushNote("note-2", 1);
    await pushNote("note-3", 1);

    const page = await service.pullChanges(userA, {
      deviceId: laptopA,
      limit: 2,
    });
    expect(page.changes.map((change) => change.entityId)).toEqual([
      "note-1",
      "note-2",
    ]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("2");

    const tail = await service.pullChanges(userA, {
      deviceId: laptopA,
      cursor: page.nextCursor,
      limit: 2,
    });
    expect(tail.changes.map((change) => change.entityId)).toEqual(["note-3"]);
    expect(tail.hasMore).toBe(false);
    expect(tail.nextCursor).toBe("3");
  });

  it("files a superseded change under conflicts without writing or numbering it", async () => {
    await pushNote("note-1", 2);

    const stale = await service.pushChanges(userA, {
      deviceId: phoneA,
      changes: [
        {
          entityType: "note",
          entityId: "note-1",
          operation: ChangeOperation.UPDATE,
          version: 1,
          payload: { title: "Stale", content: "An older body" },
        },
      ],
    });

    expect(stale.conflicts).toEqual([
      {
        entityId: "note-1",
        entityType: "note",
        reason: "VERSION_MISMATCH",
        clientVersion: 1,
        serverVersion: 2,
        // The whole row, body included: a client told it lost a version
        // comparison has to be given the text to keep, not just its title.
        serverPayload: {
          title: "Note note-1 v2",
          content: "Body of note-1 at version 2",
        },
      },
    ]);
    expect(stale.accepted).toEqual([]);
    expect(changes).toHaveLength(1);
    // Nothing was allocated, so the response still names the real end of log.
    expect(stale.newCursor).toBe("1");
    expect(stale.highestCursor).toBe("1");
  });

  it("broadcasts and reports the cursor it actually stored", async () => {
    const pushed = await pushNote("note-1", 1);

    expect(gateway.notifySyncInvalidation).toHaveBeenCalledWith(
      userA,
      phoneA,
      pushed.highestCursor,
    );
    expect(pushed.highestCursor).toBe("1");

    await service.pullChanges(userA, { deviceId: laptopA });

    const status = await service.getSyncStatus(userA, laptopA);
    expect(status.serverHighestCursor).toBe("1");
    expect(status.lastPulledCursor).toBe("1");
  });

  it("refuses a vault change another device could not decrypt, writing nothing", async () => {
    const broken = { ...vaultPayload() };
    delete (broken as any).authTag;

    const rejection: any = await service
      .pushChanges(userA, {
        deviceId: phoneA,
        changes: [
          {
            entityType: "vault_item",
            entityId: "vault-1",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: broken as any,
          },
        ],
      })
      .catch((error) => error);

    expect(rejection).toBeInstanceOf(BadRequestException);
    expect(rejection.getResponse()).toMatchObject({
      code: ErrorCode.SYNC_PUSH_REJECTED,
    });
    expect(changes).toEqual([]);

    const accepted = await service.pushChanges(userA, {
      deviceId: phoneA,
      changes: [
        {
          entityType: "vault_item",
          entityId: "vault-1",
          operation: ChangeOperation.CREATE,
          version: 1,
          payload: vaultPayload() as any,
        },
        {
          entityType: "vault_item",
          entityId: "vault-1",
          operation: ChangeOperation.DELETE,
          version: 2,
          payload: {} as any,
        },
      ],
    });

    expect(accepted.accepted).toHaveLength(2);
    expect(changes.map((change) => change.cursor.toString())).toEqual([
      "1",
      "2",
    ]);
  });

  /**
   * The vault case above sends its delete one version up, so the refusing branch
   * had never run for a DELETE at all — and a delete is the one operation whose
   * stale send is destructive rather than merely redundant, because a tombstone
   * on the log is replayed to every device. The Flutter client used to hardcode
   * `version: 1` in `deleteNote` whatever the row held, which is the shape this
   * pushes.
   */
  it("refuses a note delete that arrives behind the version it buries", async () => {
    await pushNote("note-1", 1);
    await service.pushChanges(userA, {
      deviceId: phoneA,
      changes: [
        {
          entityType: "note",
          entityId: "note-1",
          operation: ChangeOperation.UPDATE,
          version: 3,
          payload: {
            title: "Renamed on another device",
            content: "The body that has to survive",
          },
        },
      ],
    });

    const refused = await service.pushChanges(userA, {
      deviceId: phoneA,
      changes: [
        {
          entityType: "note",
          entityId: "note-1",
          operation: ChangeOperation.DELETE,
          version: 1,
          payload: {},
        },
      ],
    });

    expect(refused.conflicts).toEqual([
      {
        entityId: "note-1",
        entityType: "note",
        reason: "VERSION_MISMATCH",
        clientVersion: 1,
        serverVersion: 3,
        // The body travels with the title: the device whose delete was refused
        // has to be given the note back, not just told it lost.
        serverPayload: {
          title: "Renamed on another device",
          content: "The body that has to survive",
        },
      },
    ]);
    expect(refused.accepted).toEqual([]);
    expect(changes.map((change) => change.operation)).toEqual([
      "CREATE",
      "UPDATE",
    ]);

    // And the tombstone reaches nobody. This is the half the per-call mocks could
    // not show: an appended DELETE is replayed from its cursor to every device,
    // so a note the log still holds would disappear from screens that never saw
    // the delete coming.
    const otherDevice = await service.pullChanges(userA, { deviceId: laptopA });
    expect(otherDevice.changes.map((change) => change.operation)).toEqual([
      "CREATE",
      "UPDATE",
    ]);
    expect(otherDevice.changes[1].payload).toEqual({
      title: "Renamed on another device",
      content: "The body that has to survive",
    });
  });

  /**
   * The four REST modules (`notes`, `tasks`, `calendar`, `ai`) log changes
   * themselves rather than through `/sync/push`, so they used to write rows
   * straight onto the schema's default cursor of 0. Against the real read path
   * that is not a mis-numbering but a disappearance: the filter is
   * `cursor > <checkpoint>`, and `0` is behind every checkpoint including the
   * starting one — so the row reaches no device, ever, and nothing on the read
   * path can distinguish it from a change somebody already received.
   * `appendChange` is now the only way to log one, and these are the reads it
   * has to survive.
   */
  describe("a change the REST API logged", () => {
    it("reaches a device that has already synced once", async () => {
      await pushNote("note-1", 1);
      const first = await service.pullChanges(userA, { deviceId: laptopA });
      expect(first.nextCursor).toBe("1");

      const written = await appendChange(fake, {
        userId: userA,
        entityType: "note",
        entityId: "note-2",
        operation: ChangeOperation.UPDATE,
        version: 2,
        payload: { title: "Edited in the web app", content: "The new body" },
      });
      expect(written.cursor).toEqual(BigInt(2));

      // The cursor a desktop sends is the one its last pull gave it, which is
      // precisely the value that used to leave a REST row behind.
      const second = await service.pullChanges(userA, {
        deviceId: laptopA,
        cursor: first.nextCursor,
      });
      expect(second.changes.map((change) => change.entityId)).toEqual([
        "note-2",
      ]);
    });

    it("takes its number from the same counter a push uses", async () => {
      // Interleaving is the point. A log path that restarted its own numbering
      // would land a REST row on a cursor a push had already handed out, and two
      // rows sharing a cursor are pulled as one — the other is skipped by every
      // device, forever, in silence.
      await appendChange(fake, {
        userId: userA,
        entityType: "note",
        entityId: "note-rest",
        operation: ChangeOperation.CREATE,
        version: 1,
        payload: { title: "Made in the web app", content: "" },
      });
      const pushed = await pushNote("note-sync", 1);

      expect(pushed.newCursor).toBe("2");
      const all = await service.pullChanges(userA, { deviceId: laptopA });
      expect(all.changes.map((change) => change.entityId)).toEqual([
        "note-rest",
        "note-sync",
      ]);
    });

    it("is missed by a device that has never synced when it carries no cursor", async () => {
      // The bug, kept as a test so the hole stays legible beside the helper that
      // closes it: this is what a hand-written `change.create` used to produce.
      // Pulling from position 0 — a device that has never synced at all — still
      // does not show it, which is why no client ever reported a problem: there
      // is no state a device can be in where the row is visible.
      await pushNote("note-1", 1);
      await fake.change.create({
        data: {
          userId: userA,
          deviceId: null,
          entityType: "note",
          entityId: "note-unnumbered",
          operation: ChangeOperation.UPDATE,
          version: 2,
          payload: { title: "Edited in the web app" },
          cursor: BigInt(0),
        },
      });

      const fresh = await service.pullChanges(userA, {
        deviceId: laptopA,
        cursor: "0",
      });
      expect(fresh.changes.map((change) => change.entityId)).toEqual([
        "note-1",
      ]);
    });
  });
});
