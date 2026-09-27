import { Test, TestingModule } from "@nestjs/testing";
import { SyncService } from "./sync.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ChangeOperation } from "@prisma/client";
import { ErrorCode } from "@/common/errors/error-code";

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
    payload: { title: "Test Note", content: "Body of the test note" },
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
    // The cursor counter is stateful on purpose: a push has to see the number
    // the previous one left behind, which is the whole defect this fixes.
    let allocated = BigInt(100);

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
      syncCursor: {
        upsert: jest.fn().mockImplementation(async () => {
          allocated += BigInt(1);
          return { seq: allocated };
        }),
        findUnique: jest.fn().mockResolvedValue({ seq: BigInt(100) }),
      },
      deviceSyncState: {
        upsert: jest.fn().mockResolvedValue(mockSyncState),
        findUnique: jest.fn().mockResolvedValue(mockSyncState),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
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
            payload: { title: "Test Note", content: "Body of the test note" },
          },
        ],
      };

      const result = await service.pushChanges(userId, dto);

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.processedCount).toBe(1);
      expect(result.highestCursor).toBe("101");
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cursor: BigInt(101) }),
        }),
      );
      // A change that arrives with no device stamp keeps none: `createdAt` is
      // then the only answer to "when did this happen", and it is honest.
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ clientTimestamp: null }),
        }),
      );
      expect(prismaService.change.create).toHaveBeenCalled();
      expect(prismaService.deviceSyncState.upsert).toHaveBeenCalled();
    });

    it("stores the edit stamp the device carried beside the arrival stamp", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      const editedAt = new Date("2026-09-20T08:00:00.000Z");

      await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "note",
            entityId: "note-uuid-10",
            operation: ChangeOperation.UPDATE,
            version: 2,
            payload: {
              title: "Written while offline",
              content: "Two lines typed on the phone",
            },
            clientTimestamp: editedAt,
          },
        ],
      });

      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ clientTimestamp: editedAt }),
        }),
      );
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
            payload: {
              title: "Stale Client Version",
              content: "Written before the server moved on",
            },
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

    it("accepts the version already stored, because a retry arrives at it", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      prismaService.change.findFirst.mockResolvedValue({
        ...mockChange,
        version: 2,
        payload: { title: "Newer version on the server" },
      });

      const result = await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "note",
            entityId: "note-uuid-10",
            operation: ChangeOperation.UPDATE,
            version: 2,
            payload: {
              title: "Sent again after a lost response",
              content: "The same body the first attempt carried",
            },
          },
        ],
      });

      // A push whose response never came back is re-sent at the number it
      // already got. Refusing `==` would report a conflict over a change the log
      // holds and drop the client's own queue entry for it. The other thing that
      // arrives at an equal version is a genuine concurrent edit, and this rule
      // accepts that too — see the comment at the comparison for how it resolves.
      expect(result.conflicts).toEqual([]);
      expect(result.accepted).toHaveLength(1);
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
            payload: { title: "Test Note", content: "Body of the test note" },
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

  describe("the reason a device cannot sync", () => {
    it("names a revoked device as itself, not as one that never existed", async () => {
      prismaService.device.findFirst
        // The scoped lookup finds nothing this device may use; the second read,
        // only on the failure path, asks why.
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          ...mockDevice,
          revokedAt: new Date("2026-09-01T00:00:00.000Z"),
        });

      const rejection: any = await service
        .pullChanges(userId, { deviceId })
        .catch((error) => error);

      // The two answers ask opposite things of a client: one it can fix by
      // registering itself, one it must not fix by doing precisely that.
      expect(rejection.getStatus()).toBe(403);
      expect(rejection.getResponse().code).toBe(ErrorCode.DEVICE_REVOKED);
    });

    it("asks the same question at all three entry points", async () => {
      prismaService.device.findFirst.mockResolvedValue(null);
      const asked = (call: Promise<unknown>) =>
        call.catch((error: any) => error.getResponse().code);

      // One answer for one question, wherever it is asked. A client that learned
      // what to do about it on the push path should not have to learn it again
      // on pull — and a `/sync/status` that answered differently would let a
      // broken device be read as a healthy one.
      expect(
        await Promise.all([
          asked(service.pushChanges(userId, { deviceId, changes: [] })),
          asked(service.pullChanges(userId, { deviceId })),
          asked(service.getSyncStatus(userId, deviceId)),
        ]),
      ).toEqual([
        ErrorCode.DEVICE_NOT_REGISTERED,
        ErrorCode.DEVICE_NOT_REGISTERED,
        ErrorCode.DEVICE_NOT_REGISTERED,
      ]);
    });

    it("does not say whether another account's device exists", async () => {
      prismaService.device.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...mockDevice, userId: "someone-else" });

      const rejection: any = await service
        .pushChanges(userId, { deviceId, changes: [] })
        .catch((error) => error);

      // "Is this UUID real, and whose?" is answered exactly like a row that is
      // missing. Only the revoked case is split out, and only because the
      // account asking about it already knows that device exists.
      expect(rejection.getStatus()).toBe(404);
      expect(rejection.getResponse().code).toBe(
        ErrorCode.DEVICE_NOT_REGISTERED,
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

    it("stops a page at the requested limit and keeps the extra row server-side", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      prismaService.change.findMany.mockResolvedValue([
        { ...mockChange, cursor: BigInt(101) },
        { ...mockChange, cursor: BigInt(102) },
        { ...mockChange, cursor: BigInt(103) },
      ]);

      const result = await service.pullChanges(userId, {
        deviceId,
        cursor: "100",
        limit: 2,
      });

      expect(prismaService.change.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 3 }),
      );
      expect(result.changes.map((change) => change.cursor)).toEqual([
        "101",
        "102",
      ]);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe("102");
    });

    it("echoes the caller's cursor when the log has nothing newer", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      prismaService.change.findMany.mockResolvedValue([]);

      const result = await service.pullChanges(userId, {
        deviceId,
        cursor: "101",
      });

      expect(result.changes).toEqual([]);
      expect(result.nextCursor).toBe("101");
      expect(prismaService.deviceSyncState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ lastPulledCursor: "101" }),
        }),
      );
    });

    it("echoes the edit stamp, and null where the server was the author", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      const editedAt = new Date("2026-09-20T08:00:00.000Z");
      prismaService.change.findMany.mockResolvedValue([
        { ...mockChange, cursor: BigInt(101), clientTimestamp: editedAt },
        { ...mockChange, cursor: BigInt(102), clientTimestamp: null },
      ]);

      const result = await service.pullChanges(userId, {
        deviceId,
        cursor: "100",
      });

      // `createdAt` on the same row is when this server heard about the change,
      // which for a device that was offline a week is a week after `editedAt`.
      expect(result.changes[0].clientTimestamp).toEqual(editedAt);
      expect(result.changes[1].clientTimestamp).toBeNull();
    });

    it("refuses a cursor a previous pull never handed out", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);

      const rejection: any = await service
        .pullChanges(userId, { deviceId, cursor: "1758-09-26" })
        .catch((error) => error);

      expect(rejection).toBeInstanceOf(BadRequestException);
      expect(rejection.getResponse()).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
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
