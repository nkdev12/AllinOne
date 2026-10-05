import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { SyncController } from "@/sync/sync.controller";
import { SyncService } from "@/sync/sync.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { PrismaService } from "@/common/prisma/prisma.service";
import { TracingModule } from "@/common/tracing/tracing.module";
import { TracingInterceptor } from "@/common/tracing/tracing.interceptor";
import { ErrorHandlingModule } from "@/common/error-handling/error-handling.module";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ChangeOperation } from "@prisma/client";

/**
 * End-to-End tests verifying disaster recovery and restore consistency:
 * - A device whose checkpoint was stranded ahead of the server after a database
 *   restore is safely recovered without silent sync loss.
 * - Sync cursor sequence numbers and change log ordering remain consistent.
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

describe("Disaster Recovery & Restore Consistency (E2E)", () => {
  let app: INestApplication;
  const userId = "11111111-1111-4111-8111-111111111111";
  const deviceId = "22222222-2222-4222-8222-222222222222";

  let changes: FakeChange[] = [];
  let devices: FakeDevice[] = [];
  let nextSeq = BigInt(0);

  beforeAll(async () => {
    const fakePrisma: any = {
      $transaction: jest.fn(async (cb: (tx: any) => Promise<any>): Promise<any> =>
        cb(fakePrisma),
      ),
      device: {
        findFirst: jest.fn(async ({ where }: any) => {
          return (
            devices.find(
              (d) =>
                d.id === where.id &&
                (!where.userId || d.userId === where.userId) &&
                (!where.revokedAt || d.revokedAt === null),
            ) ?? null
          );
        }),
      },
      syncCursor: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.userId === userId) {
            return { userId, seq: nextSeq };
          }
          return null;
        }),
        upsert: jest.fn(async ({ where }: any) => {
          nextSeq = nextSeq + BigInt(1);
          return { userId: where.userId, seq: nextSeq };
        }),
      },
      change: {
        findFirst: jest.fn(async ({ where }: any) => {
          const userChanges = changes.filter((c) => c.userId === where.userId);
          if (userChanges.length === 0) return null;
          return userChanges[userChanges.length - 1];
        }),
        findMany: jest.fn(async ({ where, take }: any) => {
          let filtered = changes.filter((c) => c.userId === where.userId);
          if (where.cursor && where.cursor.gt !== undefined) {
            filtered = filtered.filter((c) => c.cursor > where.cursor.gt);
          }
          if (take) {
            return filtered.slice(0, take);
          }
          return filtered;
        }),
        create: jest.fn(async ({ data }: any) => {
          const row: FakeChange = {
            id: `ch-${changes.length + 1}`,
            userId: data.userId,
            deviceId: data.deviceId ?? null,
            entityType: data.entityType,
            entityId: data.entityId,
            operation: data.operation,
            version: data.version,
            payload: data.payload,
            clientTimestamp: data.clientTimestamp ?? null,
            cursor: data.cursor,
            createdAt: new Date(),
          };
          changes.push(row);
          return row;
        }),
      },
      deviceSyncState: {
        upsert: jest.fn(async () => ({})),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TracingModule, ErrorHandlingModule],
      controllers: [SyncController],
      providers: [
        SyncService,
        { provide: PrismaService, useValue: fakePrisma },
        { provide: APP_INTERCEPTOR, useClass: TracingInterceptor },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          req.user = { id: userId, email: "dr@example.com" };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    devices = [{ id: deviceId, userId, revokedAt: null }];
    changes = [];
    nextSeq = BigInt(0);
  });

  it("safely heals a device whose checkpoint is ahead of server highest cursor after a restore", async () => {
    // 1. Simulate server having 3 changes (cursors 1, 2, 3) restored from backup
    nextSeq = BigInt(3);
    for (let i = 1; i <= 3; i++) {
      changes.push({
        id: `ch-${i}`,
        userId,
        deviceId,
        entityType: "note",
        entityId: `note-${i}`,
        operation: ChangeOperation.CREATE,
        version: 1,
        payload: { title: `Note ${i}` },
        clientTimestamp: new Date(),
        cursor: BigInt(i),
        createdAt: new Date(),
      });
    }

    // 2. Client calls pull with cursor 10 (stranded ahead of restored server)
    const res = await request(app.getHttpServer())
      .post("/sync/pull")
      .send({
        deviceId,
        cursor: "10",
        limit: 100,
      })
      .expect(200);

    // 3. Server should detect cursor > serverHighestCursor, reset query to 0,
    // and deliver the restored changes while advancing the checkpoint to 3
    expect(res.body.changes).toHaveLength(3);
    expect(res.body.changes[0].cursor).toBe("1");
    expect(res.body.changes[2].cursor).toBe("3");
    expect(res.body.nextCursor).toBe("3");
  });

  it("subsequent pulls and pushes work normally after cursor healing", async () => {
    // 1. Setup server state at cursor 2
    nextSeq = BigInt(2);
    changes.push({
      id: "ch-1",
      userId,
      deviceId,
      entityType: "note",
      entityId: "note-1",
      operation: ChangeOperation.CREATE,
      version: 1,
      payload: { title: "Note 1" },
      clientTimestamp: new Date(),
      cursor: BigInt(1),
      createdAt: new Date(),
    });
    changes.push({
      id: "ch-2",
      userId,
      deviceId,
      entityType: "note",
      entityId: "note-2",
      operation: ChangeOperation.CREATE,
      version: 1,
      payload: { title: "Note 2" },
      clientTimestamp: new Date(),
      cursor: BigInt(2),
      createdAt: new Date(),
    });

    // 2. Client heals its stranded cursor
    const healRes = await request(app.getHttpServer())
      .post("/sync/pull")
      .send({ deviceId, cursor: "99", limit: 100 })
      .expect(200);

    expect(healRes.body.nextCursor).toBe("2");

    // 3. Client pushes a new change
    const note3Id = "33333333-3333-4333-8333-333333333333";
    const pushRes = await request(app.getHttpServer())
      .post("/sync/push")
      .send({
        deviceId,
        changes: [
          {
            entityType: "note",
            entityId: note3Id,
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: {
              title: "Note 3 After Healing",
              content: "Body 3 content",
            },
          },
        ],
      })
      .expect(201);

    expect(pushRes.body.accepted).toEqual(["ch-3"]);

    // 4. Normal pull with healed checkpoint "2" retrieves the newly pushed change
    const pullRes = await request(app.getHttpServer())
      .post("/sync/pull")
      .send({ deviceId, cursor: "2", limit: 100 })
      .expect(200);

    expect(pullRes.body.changes).toHaveLength(1);
    expect(pullRes.body.changes[0].entityId).toBe(note3Id);
    expect(pullRes.body.nextCursor).toBe("3");
  });
});
