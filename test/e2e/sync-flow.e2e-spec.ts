import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { SyncController } from "@/sync/sync.controller";
import { SyncService } from "@/sync/sync.service";
import { DevicesController } from "@/devices/devices.controller";
import { DevicesService } from "@/devices/devices.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { TracingModule } from "@/common/tracing/tracing.module";
import { TracingInterceptor } from "@/common/tracing/tracing.interceptor";
import { ErrorHandlingModule } from "@/common/error-handling/error-handling.module";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { UnauthorizedException } from "@nestjs/common";

describe("Device Management & Delta Synchronization Protocol (E2E)", () => {
  let app: INestApplication;
  let syncServiceMock: any;
  let devicesServiceMock: any;

  const mockUser = {
    id: "user-1234-uuid",
    email: "sync.tester@example.com",
    displayName: "Sync Tester",
    status: "ACTIVE",
  };

  const testDeviceId = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

  const mockDevice = {
    id: testDeviceId,
    userId: mockUser.id,
    name: "MacBook Chrome",
    platform: "WEB",
    appVersion: "1.2.0",
    createdAt: new Date().toISOString(),
  };

  beforeAll(async () => {
    devicesServiceMock = {
      registerDevice: jest.fn().mockImplementation(async (_userId, dto) => ({
        id: testDeviceId,
        userId: mockUser.id,
        ...dto,
        createdAt: new Date().toISOString(),
      })),
      getDevicesByUser: jest.fn().mockResolvedValue([mockDevice]),
      getDeviceById: jest.fn().mockResolvedValue(mockDevice),
    };

    syncServiceMock = {
      pushChanges: jest.fn().mockImplementation(async (_userId, dto) => {
        return {
          appliedChanges: dto.changes.length,
          conflicts: [],
          newCursor: "1005",
          processedAt: new Date().toISOString(),
        };
      }),
      pullChanges: jest.fn().mockImplementation(async (_userId, _dto) => {
        return {
          changes: [
            {
              id: "change-1",
              entityType: "note",
              entityId: "note-uuid-555",
              operation: "CREATE",
              version: 1,
              payload: { title: "Synchronized Note", content: "Hello World" },
              cursor: "1004",
              createdAt: new Date().toISOString(),
            },
          ],
          hasMore: false,
          nextCursor: "1005",
          serverTime: new Date().toISOString(),
        };
      }),
      getSyncStatus: jest
        .fn()
        .mockImplementation(async (_userId, deviceId) => ({
          deviceId,
          lastPulledCursor: "1005",
          lastSuccessfulSyncAt: new Date().toISOString(),
          isHealthy: true,
        })),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TracingModule, ErrorHandlingModule],
      controllers: [SyncController, DevicesController],
      providers: [
        { provide: SyncService, useValue: syncServiceMock },
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

  afterAll(async () => {
    await app.close();
  });

  describe("Device Registration (POST /devices)", () => {
    it("should reject device registration with invalid platform (400)", async () => {
      const response = await request(app.getHttpServer())
        .post("/devices")
        .set("Authorization", "Bearer valid-token")
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
      const response = await request(app.getHttpServer())
        .post("/devices")
        .set("Authorization", "Bearer valid-token")
        .send({
          name: "MacBook Chrome",
          platform: "WEB",
          appVersion: "1.2.0",
        })
        .expect(201);

      expect(response.body.id).toBe(testDeviceId);
      expect(response.body.platform).toBe("WEB");
    });

    it("should list active registered devices (GET /devices)", async () => {
      const response = await request(app.getHttpServer())
        .get("/devices")
        .set("Authorization", "Bearer valid-token")
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(1);
      expect(response.body[0].name).toBe("MacBook Chrome");
    });
  });

  describe("Delta Sync Push (POST /sync/push)", () => {
    it("should reject push without valid changes array (400)", async () => {
      await request(app.getHttpServer())
        .post("/sync/push")
        .set("Authorization", "Bearer valid-token")
        .send({
          deviceId: testDeviceId,
          changes: "invalid-string",
        })
        .expect(400);
    });

    it("should record pushed changes batch and return new cursor (201)", async () => {
      const payload = {
        deviceId: testDeviceId,
        changes: [
          {
            entityType: "note",
            entityId: "123e4567-e89b-12d3-a456-426614174000",
            operation: "CREATE",
            version: 1,
            payload: { title: "New meeting notes", content: "Action items" },
          },
        ],
      };

      const response = await request(app.getHttpServer())
        .post("/sync/push")
        .set("Authorization", "Bearer valid-token")
        .send(payload)
        .expect(201);

      expect(response.body.appliedChanges).toBe(1);
      expect(response.body.newCursor).toBe("1005");
      expect(response.headers["x-trace-id"]).toBeDefined();
    });
  });

  describe("Delta Sync Pull (POST /sync/pull)", () => {
    it("should pull changes stream after specified cursor (200)", async () => {
      const response = await request(app.getHttpServer())
        .post("/sync/pull")
        .set("Authorization", "Bearer valid-token")
        .send({
          deviceId: testDeviceId,
          cursor: "1003",
          limit: 50,
        })
        .expect(200);

      expect(Array.isArray(response.body.changes)).toBe(true);
      expect(response.body.changes.length).toBe(1);
      expect(response.body.changes[0].entityType).toBe("note");
      expect(response.body.nextCursor).toBe("1005");
    });
  });

  describe("Sync Status Probe (GET /sync/status)", () => {
    it("should return device sync state and cursor metrics", async () => {
      const response = await request(app.getHttpServer())
        .get(`/sync/status?deviceId=${testDeviceId}`)
        .set("Authorization", "Bearer valid-token")
        .expect(200);

      expect(response.body.deviceId).toBe(testDeviceId);
      expect(response.body.lastPulledCursor).toBe("1005");
      expect(response.body.isHealthy).toBe(true);
    });
  });
});
