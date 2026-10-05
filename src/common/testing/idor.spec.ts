import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { NotesService } from "@/notes/services/notes.service";
import { TasksService } from "@/tasks/services/tasks.service";
import { EventsService } from "@/calendar/services/events.service";
import { DevicesService } from "@/devices/devices.service";
import { SyncService } from "@/sync/sync.service";
import { PrismaService } from "@/common/prisma/prisma.service";

describe("IDOR Security Tests (Cross-Tenant Access Prevention)", () => {
  const userA = "user-A-uuid";
  const userB = "user-B-uuid";

  let prismaService: any;
  let notesService: NotesService;
  let tasksService: TasksService;
  let eventsService: EventsService;
  let devicesService: DevicesService;
  let syncService: SyncService;

  beforeEach(async () => {
    prismaService = {
      $transaction: jest.fn((cb) => cb(prismaService)),
      note: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.userId === userB) return Promise.resolve(null);
          return Promise.resolve({
            id: "note-1",
            userId: userA,
            title: "Secret Note A",
          });
        }),
        update: jest.fn(),
        delete: jest.fn(),
      },
      task: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.userId === userB) return Promise.resolve(null);
          return Promise.resolve({
            id: "task-1",
            userId: userA,
            title: "Secret Task A",
          });
        }),
      },
      event: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.userId === userB) return Promise.resolve(null);
          return Promise.resolve({
            id: "event-1",
            userId: userA,
            title: "Secret Event A",
          });
        }),
      },
      device: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.userId === userB) {
            // User B's own devices are reachable; user A's device stays invisible.
            return Promise.resolve(
              where.id === "device-1"
                ? null
                : { id: where.id, userId: userB, name: "Browser B" },
            );
          }
          return Promise.resolve({
            id: "device-1",
            userId: userA,
            name: "Phone A",
          });
        }),
      },
      change: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
      syncCursor: {
        upsert: jest.fn().mockResolvedValue({ seq: BigInt(1) }),
        findUnique: jest.fn().mockResolvedValue({ seq: BigInt(1) }),
      },
      deviceSyncState: {
        upsert: jest.fn().mockResolvedValue({ lastPushedSequence: 1 }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      folder: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.userId === userB) return Promise.resolve(null);
          return Promise.resolve({
            id: "folder-1",
            userId: userA,
            name: "Folder A",
          });
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotesService,
        TasksService,
        EventsService,
        DevicesService,
        SyncService,
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    notesService = module.get<NotesService>(NotesService);
    tasksService = module.get<TasksService>(TasksService);
    eventsService = module.get<EventsService>(EventsService);
    devicesService = module.get<DevicesService>(DevicesService);
    syncService = module.get<SyncService>(SyncService);
  });

  describe("Notes Module IDOR Prevention", () => {
    it("should prevent User B from reading User A's note", async () => {
      await expect(notesService.getNoteById(userB, "note-1")).rejects.toThrow(
        NotFoundException,
      );
      expect(prismaService.note.findFirst).toHaveBeenCalledWith({
        where: { id: "note-1", userId: userB, deletedAt: null },
        include: expect.any(Object),
      });
    });

    it("should prevent User B from updating User A's note", async () => {
      await expect(
        notesService.updateNote(userB, "note-1", { title: "Hacked" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("should prevent User B from deleting User A's note", async () => {
      await expect(notesService.deleteNote(userB, "note-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("Tasks Module IDOR Prevention", () => {
    it("should prevent User B from reading User A's task", async () => {
      await expect(tasksService.getTaskById(userB, "task-1")).rejects.toThrow(
        NotFoundException,
      );
      expect(prismaService.task.findFirst).toHaveBeenCalledWith({
        where: { id: "task-1", userId: userB, deletedAt: null },
        include: expect.any(Object),
      });
    });

    it("should prevent User B from updating User A's task", async () => {
      await expect(
        tasksService.updateTask(userB, "task-1", { title: "Hacked Task" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("should prevent User B from deleting User A's task", async () => {
      await expect(tasksService.deleteTask(userB, "task-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("Calendar Module IDOR Prevention", () => {
    it("should prevent User B from reading User A's calendar event", async () => {
      await expect(
        eventsService.getEventById(userB, "event-1"),
      ).rejects.toThrow(NotFoundException);
      expect(prismaService.event.findFirst).toHaveBeenCalledWith({
        where: { id: "event-1", userId: userB, deletedAt: null },
        include: expect.any(Object),
      });
    });

    it("should prevent User B from deleting User A's calendar event", async () => {
      await expect(eventsService.deleteEvent(userB, "event-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("Vault entries IDOR prevention (oplog path)", () => {
    it("never replays another user's vault blobs", async () => {
      // Vault entries exist only as Change rows now, so the per-user filter on
      // the sync log is what keeps user A's ciphertext away from user B.
      await syncService.pullChanges(userB, { deviceId: "device-B" });

      expect(prismaService.change.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: userB }),
        }),
      );
    });

    it("refuses a push that tries to write into another user's log", async () => {
      await expect(
        syncService.pushChanges(userB, {
          deviceId: "device-1",
          changes: [
            {
              entityType: "vault_item",
              entityId: "vault-1",
              operation: "UPDATE",
              version: 2,
              payload: {
                type: "LOGIN",
                encryptedData: "x",
                iv: "y",
                authTag: "z",
                isEncrypted: true,
              },
            },
          ],
        }),
      ).rejects.toThrow(NotFoundException);
      expect(prismaService.change.create).not.toHaveBeenCalled();
    });
  });

  describe("Devices & Sync IDOR Prevention", () => {
    it("should prevent User B from accessing User A's device", async () => {
      await expect(
        devicesService.getDeviceById("device-1", userB),
      ).rejects.toThrow(NotFoundException);
    });

    it("should prevent User B from triggering sync pull using User A's device", async () => {
      await expect(
        syncService.pullChanges(userB, { deviceId: "device-1" }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
