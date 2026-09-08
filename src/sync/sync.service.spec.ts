import { Test, TestingModule } from "@nestjs/testing";
import { SyncService } from "./sync.service";
import { ConflictResolverService } from "./conflict-resolver.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { NotFoundException } from "@nestjs/common";
import { ChangeOperation } from "@prisma/client";

describe("SyncService", () => {
  let service: SyncService;
  let prismaService: any;

  const userId = "user-uuid-123";
  const deviceId = "device-uuid-456";

  const mockDevice = {
    id: deviceId,
    userId,
    name: "Test Device",
    platform: "WEB",
    appVersion: "1.0.0",
    revokedAt: null,
  };

  const mockChange = {
    id: "change-uuid-1",
    userId,
    deviceId,
    entityType: "note",
    entityId: "note-uuid-10",
    operation: ChangeOperation.CREATE,
    version: 1,
    payload: { title: "Test Note" },
    cursor: BigInt(101),
    createdAt: new Date(),
  };

  const mockSyncState = {
    id: "sync-state-1",
    deviceId,
    lastPulledCursor: "100",
    lastPushedSequence: 1,
    lastSuccessfulSyncAt: new Date(),
  };

  beforeEach(async () => {
    prismaService = {
      $transaction: jest.fn((cb) => cb(prismaService)),
      device: {
        findFirst: jest.fn(),
      },
      change: {
        create: jest.fn().mockResolvedValue(mockChange),
        findMany: jest.fn().mockResolvedValue([mockChange]),
        findFirst: jest.fn().mockResolvedValue(mockChange),
      },
      deviceSyncState: {
        upsert: jest.fn().mockResolvedValue(mockSyncState),
        findUnique: jest.fn().mockResolvedValue(mockSyncState),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        ConflictResolverService,
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    service = module.get<SyncService>(SyncService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("pushChanges", () => {
    it("should throw NotFoundException if active device is not found", async () => {
      prismaService.device.findFirst.mockResolvedValue(null);

      await expect(
        service.pushChanges(userId, {
          deviceId,
          changes: [],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("should record changes and update device sync state", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);

      const dto = {
        deviceId,
        changes: [
          {
            entityType: "note",
            entityId: "note-uuid-10",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: { title: "Test Note" },
          },
        ],
      };

      const result = await service.pushChanges(userId, dto);

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.processedCount).toBe(1);
      expect(result.highestCursor).toBe("101");
      expect(prismaService.change.create).toHaveBeenCalled();
      expect(prismaService.deviceSyncState.upsert).toHaveBeenCalled();
    });

    it("should generate VERSION_MISMATCH conflict if client version is lower than server version", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      prismaService.change.findFirst.mockResolvedValue({
        ...mockChange,
        version: 2,
        payload: { title: "Server Newer Version" },
      });

      const dto = {
        deviceId,
        changes: [
          {
            entityType: "note",
            entityId: "note-uuid-10",
            operation: ChangeOperation.UPDATE,
            version: 1, // lower than server version 2
            payload: { title: "Stale Client Version" },
          },
        ],
      };

      const result = await service.pushChanges(userId, dto);

      expect(result).toBeDefined();
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toEqual({
        entityId: "note-uuid-10",
        entityType: "note",
        reason: "VERSION_MISMATCH",
        clientVersion: 1,
        serverVersion: 2,
        serverPayload: { title: "Server Newer Version" },
      });
      expect(result.accepted).toHaveLength(0);
    });

    it("should unconditionally scope query by userId", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      prismaService.change.findFirst.mockResolvedValue(null);

      const dto = {
        deviceId,
        changes: [
          {
            entityType: "note",
            entityId: "note-uuid-10",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: { title: "Test Note" },
          },
        ],
      };

      await service.pushChanges(userId, dto);

      expect(prismaService.device.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId }),
        }),
      );
      expect(prismaService.change.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId }),
        }),
      );
    });
  });

  describe("pullChanges", () => {
    it("should throw NotFoundException if device is not found", async () => {
      prismaService.device.findFirst.mockResolvedValue(null);

      await expect(service.pullChanges(userId, { deviceId })).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should pull changes and return nextCursor as string", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);

      const result = await service.pullChanges(userId, {
        deviceId,
        cursor: "100",
        limit: 10,
      });

      expect(result).toBeDefined();
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].cursor).toBe("101");
      expect(result.nextCursor).toBe("101");
      expect(result.hasMore).toBe(false);
      expect(prismaService.deviceSyncState.upsert).toHaveBeenCalled();
    });
  });

  describe("getSyncStatus", () => {
    it("should return sync status metadata for a device", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);

      const result = await service.getSyncStatus(userId, deviceId);

      expect(result).toBeDefined();
      expect(result.deviceId).toBe(deviceId);
      expect(result.lastPulledCursor).toBe("100");
      expect(result.serverHighestCursor).toBe("101");
    });
  });
});
