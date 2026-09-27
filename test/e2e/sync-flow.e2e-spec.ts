import { Test, TestingModule } from "@nestjs/testing";
import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from "@nestjs/common";
import request from "supertest";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ChangeOperation } from "@prisma/client";
import { SyncController } from "@/sync/sync.controller";
import { SyncService } from "@/sync/sync.service";
import { DevicesController } from "@/devices/devices.controller";
import { DevicesService } from "@/devices/devices.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { PrismaService } from "@/common/prisma/prisma.service";
import { TracingModule } from "@/common/tracing/tracing.module";
import { TracingInterceptor } from "@/common/tracing/tracing.interceptor";
import { ErrorHandlingModule } from "@/common/error-handling/error-handling.module";

/**
 * The HTTP surface of the sync protocol: the guard, the DTO whitelist, the error
 * envelope, the trace header, and the response shapes a client parses.
 *
 * This file used to mock `SyncService` whole and then read the mock's own
 * fixture back, which made its shape assertions unfailable: `appliedChanges`,
 * `processedAt`, `serverTime` and `isHealthy` appear nowhere in what the real
 * service returns. `DEPLOYMENT.md:15` ticks "end-to-end tests passing" before a
 * release, so a suite that invented a wire contract was load-bearing on purpose.
 *
 * The service is real here and only the database is not. Every request runs
 * through the same controller, pipes and service the deployed server runs,
 * against an in-memory change log, so the keys asserted below are the keys the
 * Flutter client reads in `SyncManager._apply`.
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
  clientTimestamp: Date | null;
  cursor: bigint;
  createdAt: Date;
}

interface FakeDevice {
  id: string;
  userId: string;
  revokedAt: Date | null;
}

/** Ordering rules Prisma accepts for these three queries and no more. */
type OrderSpec =
  { [field: string]: "asc" | "desc" } | Array<{ [f: string]: "asc" | "desc" }>;

function orderPairs(order: OrderSpec): Array<[string, "asc" | "desc"]> {
  const source = Array.isArray(order) ? Object.assign({}, ...order) : order;
  return Object.entries(source);
}

function createChangeLog(devices: FakeDevice[]) {
  let rows: FakeChange[] = [];
  let states = new Map<string, any>();
  let counters = new Map<string, bigint>();
  let nextId = 0;

  const alive = () => {
    rows = [];
    states = new Map();
    counters = new Map();
    nextId = 0;
  };

  const matches = (row: FakeChange, where: any): boolean => {
    for (const key of ["userId", "entityType", "entityId"] as const) {
      if (where?.[key] !== undefined && row[key] !== where[key]) return false;
    }
    if (where?.cursor !== undefined) {
      const filter = where.cursor;
      return typeof filter === "object" && filter !== null && "gt" in filter
        ? row.cursor > filter.gt
        : row.cursor === filter;
    }
    return true;
  };

  const sorted = (list: FakeChange[], order?: OrderSpec) =>
    [...list].sort((left, right) => {
      for (const [field, direction] of orderPairs(order ?? { cursor: "asc" })) {
        const a = (left as any)[field];
        const b = (right as any)[field];
        if (a === b) continue;
        const less = a < b ? -1 : 1;
        return direction === "desc" ? -less : less;
      }
      return 0;
    });

  const project = (row: FakeChange, select?: any) =>
    select === undefined
      ? row
      : Object.fromEntries(
          Object.keys(select)
            .filter((field) => select[field])
            .map((field) => [field, (row as any)[field]]),
        );

  const fake: any = {
    $transaction: jest.fn((callback: any) => callback(fake)),
    device: {
      findFirst: jest.fn(async ({ where }: any) => {
        const wanted = devices.find(
          (device) =>
            (where.id === undefined || device.id === where.id) &&
            (where.userId === undefined || device.userId === where.userId) &&
            (where.revokedAt === undefined ||
              device.revokedAt === where.revokedAt),
        );
        return wanted ?? null;
      }),
    },
    change: {
      create: jest.fn(async ({ data }: any) => {
        const row: FakeChange = {
          id: `change-${++nextId}`,
          createdAt: new Date(),
          clientTimestamp: data.clientTimestamp ?? null,
          deviceId: data.deviceId ?? null,
          userId: data.userId,
          entityType: data.entityType,
          entityId: data.entityId,
          operation: data.operation,
          version: data.version,
          payload: data.payload,
          cursor: data.cursor,
        };
        rows.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where, orderBy, select }: any) => {
        const found = sorted(
          rows.filter((row) => matches(row, where)),
          orderBy,
        )[0];
        return found === undefined ? null : project(found, select);
      }),
      findMany: jest.fn(async ({ where, orderBy, take }: any) => {
        const found = sorted(
          rows.filter((row) => matches(row, where)),
          orderBy ?? { cursor: "asc" },
        );
        return take === undefined ? found : found.slice(0, take);
      }),
    },
    syncCursor: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const current = counters.get(where.userId) ?? BigInt(0);
        const increment = update?.seq?.increment;
        const next =
          increment !== undefined
            ? current + increment
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
        const stored = states.get(where.deviceId);
        const increment = update?.lastPushedSequence?.increment;
        const merged = stored
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
        states.set(where.deviceId, merged);
        return merged;
      }),
      findUnique: jest.fn(
        async ({ where }: any) => states.get(where.deviceId) ?? null,
      ),
    },
  };

  return { fake, alive, rows: () => rows };
}

describe("Device Management & Delta Synchronization Protocol (E2E)", () => {
  let app: INestApplication;
  let log: ReturnType<typeof createChangeLog>;

  const mockUser = {
    id: "user-1234-uuid",
    email: "sync.tester@example.com",
    displayName: "Sync Tester",
    status: "ACTIVE",
  };

  const phoneId = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
  const laptopId = "5cb8d4a1-7f2e-4c1a-9b3d-2a6e1c4f8b07";
  const oldPhoneId = "2f6c9a04-8b1d-4e7f-9c2a-5d0b8e4f1a63";
  const noteId = "123e4567-e89b-12d3-a456-426614174000";

  const mockDevice = {
    id: phoneId,
    userId: mockUser.id,
    name: "MacBook Chrome",
    platform: "WEB",
    appVersion: "1.2.0",
    createdAt: new Date().toISOString(),
  };

  const noteChange = (
    version: number,
    title = "New meeting notes",
    body = `Body at version ${version}`,
    extra: Record<string, unknown> = {},
  ) => ({
    entityType: "note",
    entityId: noteId,
    operation: ChangeOperation.UPDATE,
    version,
    payload: { title, content: body },
    ...extra,
  });

  beforeAll(async () => {
    log = createChangeLog([
      { id: phoneId, userId: mockUser.id, revokedAt: null },
      { id: laptopId, userId: mockUser.id, revokedAt: null },
      { id: oldPhoneId, userId: mockUser.id, revokedAt: new Date() },
    ]);

    const devicesServiceMock = {
      registerDevice: jest.fn().mockImplementation(async (_userId, dto) => ({
        id: phoneId,
        userId: mockUser.id,
        ...dto,
        createdAt: new Date().toISOString(),
      })),
      getDevicesByUser: jest.fn().mockResolvedValue([mockDevice]),
      getDeviceById: jest.fn().mockResolvedValue(mockDevice),
    };

    // The service is real. If it is ever mocked again, every shape assertion in
    // this file becomes a read-back of a fixture and the suite stops being able
    // to fail — which is the state this rewrite was asked for.
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TracingModule, ErrorHandlingModule],
      controllers: [SyncController, DevicesController],
      providers: [
        SyncService,
        { provide: PrismaService, useValue: log.fake },
        { provide: DevicesService, useValue: devicesServiceMock },
        { provide: APP_INTERCEPTOR, useClass: TracingInterceptor },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          const auth = req.headers.authorization;
          if (!auth || !auth.startsWith("Bearer valid-token")) {
            throw new UnauthorizedException("Unauthorized access");
          }
          req.user = mockUser;
          return true;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  beforeEach(() => log.alive());

  afterAll(async () => {
    await app.close();
  });

  const authed = (builder: any) =>
    builder.set("Authorization", "Bearer valid-token");

  describe("Device Registration (POST /devices)", () => {
    // These three stay on a mocked `DevicesService`: what they check is the
    // controller half — the status code, the `@CurrentUser()` wiring, and the
    // envelope the error handler puts on a rejected DTO. The service's own
    // behavior has its unit spec.
    it("should reject device registration with invalid platform (400)", async () => {
      const response = await authed(
        request(app.getHttpServer()).post("/devices"),
      )
        .send({
          name: "Invalid Device",
          platform: "PLAYSTATION",
          appVersion: "1.0.0",
        })
        .expect(400);

      expect(response.body.code).toBe("VALIDATION_ERROR");
      expect(response.headers["x-trace-id"]).toBeDefined();
    });

    it("should register a valid device with 201 status", async () => {
      const response = await authed(
        request(app.getHttpServer()).post("/devices"),
      )
        .send({
          name: "MacBook Chrome",
          platform: "WEB",
          appVersion: "1.2.0",
        })
        .expect(201);

      expect(response.body.id).toBe(phoneId);
      expect(response.body.platform).toBe("WEB");
    });

    it("should list active registered devices (GET /devices)", async () => {
      const response = await authed(
        request(app.getHttpServer()).get("/devices"),
      ).expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(1);
      expect(response.body[0].name).toBe("MacBook Chrome");
    });
  });

  describe("Delta Sync Push (POST /sync/push)", () => {
    it("refuses a request that carries no token (401)", async () => {
      await request(app.getHttpServer())
        .post("/sync/push")
        .send({ deviceId: phoneId, changes: [] })
        .expect(401);
    });

    it("should reject push without valid changes array (400)", async () => {
      const response = await authed(
        request(app.getHttpServer()).post("/sync/push"),
      )
        .send({
          deviceId: phoneId,
          changes: "invalid-string",
        })
        .expect(400);

      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("refuses a key the push DTO does not declare (400)", async () => {
      // `folderId` is the client's local-only column: it has no place on the
      // wire, and `forbidNonWhitelisted` is what turns "silently dropped" into a
      // visible mistake. A push that accepted it would leave a device believing
      // its folder had synced.
      const response = await authed(
        request(app.getHttpServer()).post("/sync/push"),
      )
        .send({
          deviceId: phoneId,
          changes: [{ ...noteChange(1), folderId: "folder-1" }],
        })
        .expect(400);

      expect(response.body.code).toBe("VALIDATION_ERROR");
      expect(log.rows()).toHaveLength(0);
    });

    it("answers with the response the service really returns", async () => {
      const response = await authed(
        request(app.getHttpServer()).post("/sync/push"),
      )
        .send({ deviceId: phoneId, changes: [noteChange(1)] })
        .expect(201);

      // The whole key set, because that is the assertion the old fixture could
      // not make: `appliedChanges`, `processedAt`, `serverTime` and `isHealthy`
      // were invented here and read back from here, while `accepted`,
      // `processedCount`, `conflictsResolved`, `highestCursor` and
      // `lastPushedSequence` — the ones the client's push path consumes — went
      // unmentioned.
      expect(Object.keys(response.body).sort()).toEqual([
        "accepted",
        "conflicts",
        "conflictsResolved",
        "highestCursor",
        "lastPushedSequence",
        "newCursor",
        "processedCount",
        "success",
      ]);
      expect(response.body.success).toBe(true);
      expect(response.body.processedCount).toBe(1);
      expect(response.body.accepted).toHaveLength(1);
      expect(response.body.conflicts).toEqual([]);
      expect(response.body.newCursor).toBe("1");
      expect(response.body.highestCursor).toBe("1");

      // A cursor is a string on the wire: BigInt has no JSON representation, and
      // a client that compared it as a number would silently never advance.
      expect(typeof response.body.newCursor).toBe("string");
      expect(log.rows()[0].cursor).toBe(BigInt(1));
    });

    it("hands the client back the body it lost, over HTTP", async () => {
      await authed(request(app.getHttpServer()).post("/sync/push")).send({
        deviceId: phoneId,
        changes: [
          noteChange(2, "Renamed on the other device", "The body kept"),
        ],
      });

      const response = await authed(
        request(app.getHttpServer()).post("/sync/push"),
      )
        .send({ deviceId: phoneId, changes: [noteChange(1, "Stale edit")] })
        .expect(201);

      // 201 with an empty `accepted` rather than a 4xx: the batch was processed,
      // and the refusal is per change. A client that read this as transport
      // failure would retry forever, and one that dropped the entry without
      // reading `serverPayload` would delete a note it was never told about.
      expect(response.body.accepted).toEqual([]);
      expect(response.body.conflicts).toEqual([
        {
          entityId: noteId,
          entityType: "note",
          reason: "VERSION_MISMATCH",
          clientVersion: 1,
          serverVersion: 2,
          serverPayload: {
            title: "Renamed on the other device",
            content: "The body kept",
          },
        },
      ]);
      expect(log.rows()).toHaveLength(1);
    });

    it("names the reason a device cannot sync instead of a stored batch (404)", async () => {
      const response = await authed(
        request(app.getHttpServer()).post("/sync/push"),
      )
        .send({ deviceId: "00000000-0000-4000-8000-000000000000", changes: [] })
        .expect(404);

      // One answer for "no such row" and "not yours": anything finer would let a
      // caller probe which device UUIDs exist by trying to sync as them.
      expect(response.body.code).toBe("DEVICE_NOT_REGISTERED");
      expect(log.rows()).toHaveLength(0);

      const revoked = await authed(
        request(app.getHttpServer()).post("/sync/pull"),
      )
        .send({ deviceId: oldPhoneId })
        .expect(403);
      expect(revoked.body.code).toBe("DEVICE_REVOKED");
    });
  });

  describe("Delta Sync Pull (POST /sync/pull)", () => {
    it("replays the log with the field names the client reads", async () => {
      await authed(request(app.getHttpServer()).post("/sync/push")).send({
        deviceId: phoneId,
        changes: [
          noteChange(1, "New meeting notes", "Action items", {
            clientTimestamp: "2026-09-20T08:00:00.000Z",
          }),
        ],
      });

      const response = await authed(
        request(app.getHttpServer()).post("/sync/pull"),
      )
        .send({ deviceId: laptopId, cursor: "0", limit: 50 })
        .expect(200);

      expect(Object.keys(response.body).sort()).toEqual([
        "changes",
        "hasMore",
        "nextCursor",
      ]);
      expect(response.body.changes).toHaveLength(1);
      expect(Object.keys(response.body.changes[0]).sort()).toEqual([
        "clientTimestamp",
        "createdAt",
        "cursor",
        "deviceId",
        "entityId",
        "entityType",
        "id",
        "operation",
        "payload",
        "userId",
        "version",
      ]);
      expect(response.body.changes[0].entityType).toBe("note");
      expect(response.body.changes[0].payload).toEqual({
        title: "New meeting notes",
        content: "Action items",
      });
      expect(response.body.changes[0].cursor).toBe("1");
      expect(response.body.nextCursor).toBe("1");
      expect(response.body.hasMore).toBe(false);
      // A change the device authored carries its own stamp back; a REST write
      // has no device clock to borrow and answers null, which is what makes the
      // client fall back on `createdAt`.
      expect(
        new Date(response.body.changes[0].clientTimestamp).toISOString(),
      ).toBe("2026-09-20T08:00:00.000Z");
    });

    it("echoes the caller's checkpoint when the log has nothing newer", async () => {
      await authed(request(app.getHttpServer()).post("/sync/push")).send({
        deviceId: phoneId,
        changes: [noteChange(1)],
      });
      const first = await authed(
        request(app.getHttpServer()).post("/sync/pull"),
      ).send({ deviceId: laptopId });

      const repeat = await authed(
        request(app.getHttpServer()).post("/sync/pull"),
      )
        .send({ deviceId: laptopId, cursor: first.body.nextCursor })
        .expect(200);

      expect(repeat.body.changes).toEqual([]);
      expect(repeat.body.hasMore).toBe(false);
      // "0" here would send the device back to the start of its own log and
      // replay every change it already applied.
      expect(repeat.body.nextCursor).toBe(first.body.nextCursor);
    });
  });

  describe("Sync Status Probe (GET /sync/status)", () => {
    it("reports both ends of the checkpoint as strings", async () => {
      await authed(request(app.getHttpServer()).post("/sync/push")).send({
        deviceId: phoneId,
        changes: [noteChange(1)],
      });
      await authed(request(app.getHttpServer()).post("/sync/pull")).send({
        deviceId: laptopId,
      });

      const response = await authed(
        request(app.getHttpServer()).get(`/sync/status?deviceId=${laptopId}`),
      ).expect(200);

      expect(Object.keys(response.body).sort()).toEqual([
        "deviceId",
        "lastPulledCursor",
        "lastPushedSequence",
        "lastSuccessfulSyncAt",
        "serverHighestCursor",
      ]);
      expect(response.body.deviceId).toBe(laptopId);
      expect(response.body.lastPulledCursor).toBe("1");
      expect(response.body.serverHighestCursor).toBe("1");
      // This device has never pushed, and the answer has to say so rather than
      // omit the field.
      expect(response.body.lastPushedSequence).toBe(0);
    });
  });
});
