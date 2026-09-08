import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { NotesService } from "@/notes/services/notes.service";
import { TasksService } from "@/tasks/services/tasks.service";
import { EventsService } from "@/calendar/services/events.service";
import { VaultItemsService } from "@/vault/services/vault-items.service";
import { DevicesService } from "@/devices/devices.service";
import { SyncService } from "@/sync/sync.service";
import { ConflictResolverService } from "@/sync/conflict-resolver.service";
import { PrismaService } from "@/common/prisma/prisma.service";

describe("IDOR Security Tests (Cross-Tenant Access Prevention)", () => {
  const userA = "user-A-uuid";
  const userB = "user-B-uuid";

  let prismaService: any;
  let notesService: NotesService;
  let tasksService: TasksService;
  let eventsService: EventsService;
  let vaultItemsService: VaultItemsService;
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
      vaultItem: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.userId === userB) return Promise.resolve(null);
          return Promise.resolve({
            id: "vault-1",
            userId: userA,
            name: "Secret Vault Item A",
          });
        }),
      },
      device: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.userId === userB) return Promise.resolve(null);
          return Promise.resolve({
            id: "device-1",
            userId: userA,
            name: "Phone A",
          });
        }),
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
        VaultItemsService,
        DevicesService,
        SyncService,
        ConflictResolverService,
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    notesService = module.get<NotesService>(NotesService);
    tasksService = module.get<TasksService>(TasksService);
    eventsService = module.get<EventsService>(EventsService);
    vaultItemsService = module.get<VaultItemsService>(VaultItemsService);
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

  describe("Vault Module IDOR Prevention", () => {
    it("should prevent User B from reading User A's vault item", async () => {
      await expect(
        vaultItemsService.getItemById(userB, "vault-1"),
      ).rejects.toThrow(NotFoundException);
      expect(prismaService.vaultItem.findFirst).toHaveBeenCalledWith({
        where: { id: "vault-1", userId: userB, deletedAt: null },
      });
    });

    it("should prevent User B from deleting User A's vault item", async () => {
      await expect(
        vaultItemsService.deleteItem(userB, "vault-1"),
      ).rejects.toThrow(NotFoundException);
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
