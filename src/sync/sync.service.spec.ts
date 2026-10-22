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
      // The row a projected change lands on. Defaulted to "no such note", so a
      // push in these tests mirrors itself into a create and every case that
      // cares about the other branch says so.
      note: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "note-uuid-10" }),
        update: jest.fn().mockResolvedValue({ id: "note-uuid-10" }),
      },
      folder: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "folder-uuid-11" }),
        update: jest.fn().mockResolvedValue({ id: "folder-uuid-11" }),
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

    it("carries an accepted change through to the note row", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      prismaService.change.findFirst.mockResolvedValue(null);
      prismaService.note.findUnique.mockResolvedValue({
        userId,
        version: 3,
        deletedAt: null,
      });

      await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "note",
            entityId: "note-uuid-10",
            operation: ChangeOperation.UPDATE,
            version: 4,
            payload: {
              title: "Edited offline",
              content: "Three devices, one text",
              tags: ["errand"],
              color: "#22AA88",
              noteType: "shopping",
              structured: '{"rows":[{"id":"r1","item":"Bread"}]}',
              version: 4,
            },
          },
        ],
      });

      // Without this write the `Note` table kept whatever the note was when REST
      // last touched it, so `GET /notes`, the search filter and the AI routes
      // answered from a stale copy — and a REST edit then logged a payload built
      // from that copy, which every device replayed over the newer one.
      expect(prismaService.note.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "note-uuid-10" },
          data: expect.objectContaining({
            title: "Edited offline",
            content: "Three devices, one text",
            tags: ["errand"],
            color: "#22AA88",
            noteType: "shopping",
            structured: '{"rows":[{"id":"r1","item":"Bread"}]}',
            version: 4,
          }),
        }),
      );
    });

    it("projects nothing for a change the log refused", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      prismaService.change.findFirst.mockResolvedValue({
        ...mockChange,
        version: 9,
        payload: { title: "Newer on the server", content: "" },
      });

      const result = await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "note",
            entityId: "note-uuid-10",
            operation: ChangeOperation.UPDATE,
            version: 3,
            payload: {
              title: "Written before the server moved on",
              content: "",
            },
          },
        ],
      });

      expect(result.conflicts).toHaveLength(1);
      // The mirror agrees with the log and not with what the device tried to
      // say, so a refused change writes no row — and the version already stored
      // is the one the next pull hands back.
      expect(prismaService.note.update).not.toHaveBeenCalled();
      expect(prismaService.note.create).not.toHaveBeenCalled();
    });

    it("leaves an entity it has no columns for alone", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      prismaService.change.findFirst.mockResolvedValue(null);

      await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "task",
            entityId: "22222222-2222-4222-8222-222222222222",
            operation: ChangeOperation.UPDATE,
            version: 2,
            payload: { title: "Post the letter" },
          },
        ],
      });

      // A task still has no projection: its payload is judged by nothing, so
      // guessing at its columns would refuse pushes that sync correctly today.
      expect(prismaService.note.findUnique).not.toHaveBeenCalled();
      expect(prismaService.folder.findUnique).not.toHaveBeenCalled();
      expect(prismaService.change.create).toHaveBeenCalled();
    });

    it("projects a folder rename onto the folder row", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      prismaService.change.findFirst.mockResolvedValue(null);
      prismaService.folder.findUnique.mockResolvedValue({
        userId,
        version: 1,
        deletedAt: null,
      });

      await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "folder",
            entityId: "folder-uuid-11",
            operation: ChangeOperation.UPDATE,
            version: 2,
            payload: { name: "Groceries", type: "shopping", icon: "cart" },
          },
        ],
      });

      // The folder tree reaches a device through this log, so a `Folder` row is
      // written for the same reason a `Note` row now is: nothing else replays a
      // change back into a table, and `GET /folders` would otherwise keep
      // answering from whatever the folder was called when it was created.
      expect(prismaService.folder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "folder-uuid-11" },
          data: expect.objectContaining({
            name: "Groceries",
            type: "shopping",
            icon: "cart",
            version: 2,
          }),
        }),
      );
    });

    it("handles multiple changes for the same entity in the same batch correctly", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      prismaService.change.findFirst.mockResolvedValue(null);

      const result = await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "note",
            entityId: "note-uuid-multi",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: { title: "Draft", content: "Initial draft" },
          },
          {
            entityType: "note",
            entityId: "note-uuid-multi",
            operation: ChangeOperation.UPDATE,
            version: 2,
            payload: { title: "Draft edited", content: "Refined draft" },
          },
        ],
      });

      expect(result.conflicts).toHaveLength(0);
      expect(result.accepted).toHaveLength(2);
      expect(prismaService.change.create).toHaveBeenCalledTimes(2);
    });

    it("accepts the history-preserving habit workflow used by the app", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      prismaService.change.findFirst.mockResolvedValue(null);

      const oldHabitId = "11111111-1111-4111-8111-111111111111";
      const newHabitId = "22222222-2222-4222-8222-222222222222";
      const habitPayload = {
        name: "Read",
        emoji: "📚",
        color: "#42A5F5",
        category: "Learning",
        frequency: "daily",
        weekdays: null,
        targetPerPeriod: null,
        targetAmount: 10,
        unitLabel: "pages",
        reminderTime: "20:00",
        streakFreeze: true,
        startDate: "2026-10-01",
        sortOrder: 0,
        archivedAt: null,
      };

      const result = await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "habit",
            entityId: oldHabitId,
            operation: ChangeOperation.UPDATE,
            version: 8,
            payload: {
              ...habitPayload,
              archivedAt: "2026-10-16T08:00:00.000Z",
            },
          },
          {
            entityType: "habit",
            entityId: newHabitId,
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: {
              ...habitPayload,
              targetAmount: 20,
              startDate: "2026-10-16",
            },
          },
          {
            entityType: "habit_log",
            entityId: "33333333-3333-4333-8333-333333333333",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: {
              habitId: newHabitId,
              day: "2026-10-16",
              amount: 20,
              note: "Finished before bed",
              completedAt: "2026-10-16T14:30:00.000Z",
            },
          },
        ],
      });

      expect(result.conflicts).toEqual([]);
      expect(result.accepted).toHaveLength(3);
      expect(prismaService.change.create).toHaveBeenCalledTimes(3);
      expect(prismaService.change.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "habit",
            entityId: oldHabitId,
            operation: ChangeOperation.UPDATE,
            payload: expect.objectContaining({
              archivedAt: "2026-10-16T08:00:00.000Z",
            }),
          }),
        }),
      );
      expect(prismaService.change.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "habit",
            entityId: newHabitId,
            operation: ChangeOperation.CREATE,
            payload: expect.objectContaining({
              targetAmount: 20,
              startDate: "2026-10-16",
            }),
          }),
        }),
      );
      expect(prismaService.change.create).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "habit_log",
            payload: expect.objectContaining({
              habitId: newHabitId,
              amount: 20,
            }),
          }),
        }),
      );
    });

    it("detects intra-batch version conflict when subsequent change regresses version", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      prismaService.change.findFirst.mockResolvedValue(null);

      const result = await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "note",
            entityId: "note-uuid-stale-batch",
            operation: ChangeOperation.UPDATE,
            version: 3,
            payload: { title: "Updated v3", content: "Third version" },
          },
          {
            entityType: "note",
            entityId: "note-uuid-stale-batch",
            operation: ChangeOperation.UPDATE,
            version: 2,
            payload: { title: "Stale v2", content: "Regressed version" },
          },
        ],
      });

      expect(result.accepted).toHaveLength(1);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toEqual(
        expect.objectContaining({
          entityId: "note-uuid-stale-batch",
          reason: "VERSION_MISMATCH",
          clientVersion: 2,
          serverVersion: 3,
        }),
      );
    });

    /**
     * The wedge this replaced: one unstorable change threw before any write, so a
     * client whose answer to a refused batch is to keep the queue retried the
     * broken row forever behind every healthy change beside it. A failure now
     * costs the one change that caused it.
     */
    it("applies the sound half of a batch and names the sick half", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);

      const result = await service.pushChanges(userId, {
        deviceId,
        changes: [
          // No `content` key: a device applying it would blank the body.
          {
            entityType: "note",
            entityId: "note-uuid-invalid",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: { title: "Half a note" },
          },
          {
            entityType: "note",
            entityId: "note-uuid-valid",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: { title: "Whole note", content: "and its body" },
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.accepted).toHaveLength(1);
      expect(result.rejected).toEqual([
        {
          id: "note-uuid-invalid",
          errorCode: ErrorCode.SYNC_PUSH_REJECTED,
          message: expect.stringContaining("payload.content"),
        },
      ]);

      // Only the sound change reached the log, and only its own row.
      expect(prismaService.change.create).toHaveBeenCalledTimes(1);
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ entityId: "note-uuid-valid" }),
        }),
      );
    });

    /**
     * A batch that is entirely invalid is still a request the server completed:
     * 200, every change named, nothing written. A 400 here would put the client
     * back to retrying all of them.
     */
    it("answers 200 with every id in `rejected` when nothing in the batch is storable", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);

      const result = await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "note",
            entityId: "note-uuid-a",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: { title: "no body" },
          },
          {
            entityType: "vault_item",
            entityId: "vault-uuid-b",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: { type: "LOGIN", encryptedData: "blob" },
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.accepted).toEqual([]);
      expect(result.conflicts).toEqual([]);
      expect(result.rejected?.map((entry) => entry.id)).toEqual([
        "note-uuid-a",
        "vault-uuid-b",
      ]);
      expect(prismaService.change.create).not.toHaveBeenCalled();
    });

    /**
     * A batch that landed whole answers exactly as this endpoint always answered —
     * the new key is absent rather than an empty array, so a client that has not
     * heard of it parses the same body it parsed before.
     */
    it("omits `rejected` entirely for a batch that landed whole", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);

      const result = await service.pushChanges(userId, {
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
      });

      expect(result).not.toHaveProperty("rejected");
    });

    /**
     * A push may carry `MAX_CHANGES_PER_PUSH` changes, so an all-invalid batch
     * would otherwise answer with 500 prose entries to a device that is already
     * misbehaving. Entries past the cap stay on the queue and are named by the
     * smaller retry.
     */
    it("caps how many rejections one response names", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);

      const result = await service.pushChanges(userId, {
        deviceId,
        changes: Array.from({ length: 150 }, (_unused, index) => ({
          entityType: "note",
          entityId: `note-uuid-${index}`,
          operation: ChangeOperation.CREATE,
          version: 1,
          payload: { title: `no body ${index}` },
        })),
      });

      expect(result.rejected).toHaveLength(100);
      expect(result.accepted).toEqual([]);

      // The array is a bounded report, not a receipt. Without this a client that
      // cleared its queue by the ids it was handed would delete the 50 changes it
      // was never told about, which is the data loss the wedge was only annoying
      // about.
      expect(result.truncated).toBe(true);
    });

    it("says nothing about truncation when every rejection is listed", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);

      // Two bad rows in a batch of four: both are named, so the list is the whole
      // truth and the flag has nothing to admit.
      const result = await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "note",
            entityId: "note-uuid-under-cap-a",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: { title: "no body" },
          },
          {
            entityType: "note",
            entityId: "note-uuid-under-cap-b",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: { title: "no body either" },
          },
          {
            entityType: "note",
            entityId: "note-uuid-under-cap-c",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: { title: "fine", content: "body" },
          },
        ],
      });

      expect(result.rejected).toHaveLength(2);
      expect(result).not.toHaveProperty("truncated");
    });

    /**
     * An unknown `entityType` is refused by the DTO before this method runs, so
     * the question here is whether the service would ever store one if a caller
     * reached it directly. It must not: a row nothing replays is copied to every
     * device for the life of the log.
     */
    it("refuses a change whose entity type nothing replays", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);

      const result = await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "not_a_synced_type",
            entityId: "note-uuid-10",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: { title: "x", content: "y" },
          } as any,
        ],
      });

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected?.[0].errorCode).toBe(ErrorCode.SYNC_PUSH_REJECTED);
      expect(prismaService.change.create).not.toHaveBeenCalled();
    });

    /**
     * Finding 1 and Finding 2 have to land together: the authority guard lives in
     * the projection, inside the transaction, and a push that could only answer it
     * by throwing would put the device right back to retrying a change this server
     * will never accept. So a forged attribution costs that one change its write,
     * carries the code a client can tell "I am no longer in this group" from "my
     * builder is broken" by, and the healthy neighbour still commits.
     */
    it("refuses a forged group expense on its own and still lands the note beside it", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);

      const strangerId = "user-stranger-99999999-9999-4999-8999-999999999999";
      prismaService.financeSharedExpense = {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "expense-1" }),
        update: jest.fn().mockResolvedValue({ id: "expense-1" }),
      };
      prismaService.financeGroup = {
        findUnique: jest.fn().mockResolvedValue({
          ownerId: userId,
          deletedAt: null,
          currency: "INR",
          members: [{ id: userId, name: "You" }],
        }),
      };
      prismaService.resourceShare = {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      };

      const result = await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "finance_shared_expense",
            entityId: "expense-uuid-1",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: {
              groupId: "group-uuid-1",
              // Somebody who is in neither the member list nor the grant list.
              paidByUserId: strangerId,
              title: "Dinner nobody agreed to",
              totalAmountMinor: 9000,
              currency: "INR",
              splitType: "EXACT",
              date: "2026-10-05T19:00:00.000Z",
              shares: [{ userId, owedAmountMinor: 9000 }],
            },
          },
          {
            entityType: "note",
            entityId: "note-uuid-forged-neighbour",
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: { title: "Unrelated note", content: "and its body" },
          },
        ],
      });

      expect(result.rejected).toHaveLength(1);
      expect(result.rejected?.[0]).toEqual({
        id: "expense-uuid-1",
        errorCode: "SYNC_PUSH_UNAUTHORIZED",
        message: expect.stringContaining("payer"),
      });

      // What the mocks can prove: the domain row is never written, so
      // `replicateGroupChange` has no group to read and nothing is copied into the
      // named stranger's oplog, while the co-batched note still lands. (That the
      // refused change's own `Change` row and cursor go back with the transaction is
      // a property of the real client — `$transaction` is mocked as a direct call
      // here and in `sync.cursor.spec.ts`, so neither can observe a rollback.)
      expect(result.accepted).toHaveLength(1);
      expect(prismaService.financeSharedExpense.create).not.toHaveBeenCalled();
      expect(prismaService.note.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            id: "note-uuid-forged-neighbour",
          }),
        }),
      );
    });

    /**
     * Two writers, one deterministic `_id`, one instant.
     *
     * A recurring bill is minted from UUIDv5 over `recurring:<ruleId>:<UTC day>`
     * (`recurringTransactionId` in `src/finance/recurring/recurring.service.ts`),
     * so the worker, the phone's own generator and a second device that was
     * offline across the due date can all aim at the same id. The projection
     * reads the row, finds nothing, and creates — and MongoDB answers with a
     * duplicate-key violation for a row that appeared between those two calls.
     *
     * That is not an outage, and `rejectionFromProjection` cannot tell it apart
     * from one: only an `HttpException` becomes a per-change refusal, so a raw
     * Prisma `P2002` would unwind the whole `$transaction` and every healthy
     * change queued behind it in the same push. A collision degrades into a
     * normal upsert instead.
     */
    it("degrades a duplicate-key create into an update instead of failing the push", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);

      // A version-5 id, the shape the app is about to push for its own bills.
      const billId = "3f2504e0-4f89-51d3-9a0e-26ba0180ed70";
      const accountId = "a1111111-1111-4111-8111-111111111111";

      prismaService.financeTransaction = {
        findUnique: jest
          .fn()
          // Nothing there when the projection looked, so it takes the create
          // path — and the winner lands in the gap before the write.
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ userId, deletedAt: null, version: 1 }),
        create: jest.fn().mockRejectedValueOnce(
          Object.assign(
            new Error("Unique constraint failed on the fields: (`_id`)"),
            { code: "P2002", meta: { target: "_id" } },
          ),
        ),
        update: jest.fn().mockResolvedValue({ id: billId }),
      };

      const result = await service.pushChanges(userId, {
        deviceId,
        changes: [
          {
            entityType: "finance_transaction",
            entityId: billId,
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: {
              accountId,
              type: "EXPENSE",
              amountMinor: 49900,
              currency: "INR",
              title: "Streaming subscription",
              transactionDate: "2026-10-31T00:00:00.000Z",
              recurringRuleId: "rule-1",
              isExcludedFromBudget: true,
              transactionKind: "BALANCE_ADJUSTMENT",
              reversalOfTransactionId:
                "txn-33333333-3333-4333-8333-333333333333",
            },
          },
        ],
      });

      // The push completes rather than throwing, so the log row and the cursor
      // this change earned are kept and the rest of the batch is untouched.
      expect(result.success).toBe(true);
      expect(result.rejected).toBeUndefined();
      expect(result.accepted).toHaveLength(1);
      expect(prismaService.change.create).toHaveBeenCalledTimes(1);
      expect(prismaService.financeTransaction.create).toHaveBeenCalledTimes(1);
      expect(prismaService.financeTransaction.update).toHaveBeenCalledWith({
        where: { id: billId },
        data: expect.objectContaining({
          version: 1,
          // The flag a reconcile correction sets, and the reason the degraded
          // path has to be the full update rather than a bare no-op: the row
          // that won the race was written by a different writer, and this push
          // still owns the edit it was asked to make.
          isExcludedFromBudget: true,
          title: "Streaming subscription",
          amountMinor: BigInt(49900),
        }),
      });

      // The two keys the update path says nothing about. `recurringRuleId` and
      // `sharedExpenseId` ride the log verbatim, so a peer reads them off the
      // payload on the next pull; the domain row keeps whatever the winner
      // stored. Asserted so the gap is a known one rather than a surprise.
      expect(
        prismaService.financeTransaction.update.mock.calls[0][0].data,
      ).not.toHaveProperty("recurringRuleId");
    });

    /**
     * The other half: tolerating a collision must not become tolerating a
     * broken write. A `create` that fails for any reason the id cannot explain
     * is still a database fault, and swallowing it would report success for a
     * change whose row never landed.
     */
    it("still fails the push on a write error that is not a collision", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);

      const billId = "3f2504e0-4f89-51d3-9a0e-26ba0180ed70";

      prismaService.financeTransaction = {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValueOnce(
          new Error("PrismaClientInitializationError: connection lost"),
        ),
        update: jest.fn().mockResolvedValue({ id: billId }),
      };

      await expect(
        service.pushChanges(userId, {
          deviceId,
          changes: [
            {
              entityType: "finance_transaction",
              entityId: billId,
              operation: ChangeOperation.CREATE,
              version: 1,
              payload: {
                accountId: "a1111111-1111-4111-8111-111111111111",
                type: "EXPENSE",
                amountMinor: 49900,
                currency: "INR",
                title: "Streaming subscription",
                transactionDate: "2026-10-31T00:00:00.000Z",
              },
            },
          ],
        }),
      ).rejects.toThrow("connection lost");

      expect(prismaService.financeTransaction.update).not.toHaveBeenCalled();
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

    /**
     * The foreign row used to be refused by reading it and comparing `userId`
     * afterwards, which put another account's device row in memory on the path
     * whose job is deciding what to tell the caller about it. The lookup now
     * carries `userId` in its `where`, so the answer is structural: a scoped query
     * cannot return that row in the first place, and both reads are issued with
     * the same filter, so "not yours" and "not there" share one answer.
     */
    it("does not say whether another account's device exists", async () => {
      // Both scoped reads return nothing, which is exactly what a real database
      // answers for a row whose `userId` does not match.
      prismaService.device.findFirst.mockResolvedValue(null);

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

      const scopes = prismaService.device.findFirst.mock.calls.map(
        ([args]: any[]) => args.where,
      );
      expect(scopes).toHaveLength(2);
      for (const where of scopes) {
        expect(where).toMatchObject({ id: deviceId, userId });
      }
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

    it("re-synchronizes from 0 when a device cursor exceeds the server highest cursor (e.g. after a restore)", async () => {
      prismaService.device.findFirst.mockResolvedValue(mockDevice);
      // Server highest cursor is 100, but client sends cursor "150" (e.g. server restored to an earlier backup)
      prismaService.syncCursor.findUnique.mockResolvedValue({
        seq: BigInt(100),
      });
      prismaService.change.findFirst.mockResolvedValue({ cursor: BigInt(100) });

      // Mock returns changes starting from 0 to catch up
      prismaService.change.findMany.mockResolvedValue([
        { ...mockChange, cursor: BigInt(100) },
      ]);

      const result = await service.pullChanges(userId, {
        deviceId,
        cursor: "150",
      });

      // Query should NOT filter with cursor > 150 (effectiveCursor should be undefined)
      expect(prismaService.change.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId },
        }),
      );
      expect(result.nextCursor).toBe("100");
      expect(prismaService.deviceSyncState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ lastPulledCursor: "100" }),
        }),
      );
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
