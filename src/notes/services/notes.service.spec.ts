import { Test, TestingModule } from "@nestjs/testing";
import { NotesService } from "./notes.service";
import { CollaborationService } from "@/collaboration/collaboration.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { NotFoundException } from "@nestjs/common";
import { ChangeOperation } from "@prisma/client";

describe("NotesService", () => {
  let service: NotesService;
  let prismaService: any;

  const userId = "user-uuid-123";
  const folderId = "folder-uuid-456";
  const noteId = "note-uuid-789";
  const tagId = "tag-uuid-111";

  const mockFolder = {
    id: folderId,
    userId,
    name: "Work",
  };

  const mockNote = {
    id: noteId,
    userId,
    folderId,
    title: "Initial Title",
    content: "Initial Content",
    isPinned: false,
    isArchived: false,
    isEncrypted: false,
    // The scalar label list and highlight colour, as the row holds them. Kept
    // distinct from `noteTags` below on purpose: one is the client's strings, the
    // other the account's `Tag` records, and the sync payload carries the first.
    tags: ["reading", "someday"],
    color: "#FFD54F",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    folder: mockFolder,
    noteTags: [{ tag: { id: tagId, name: "urgent", color: "#FF0000" } }],
    attachments: [],
  };

  const mockHistory = {
    id: "history-uuid-1",
    noteId,
    version: 1,
    title: "Initial Title",
    content: "Initial Content",
    createdAt: new Date(),
  };

  beforeEach(async () => {
    // Stateful on purpose: `appendChange` asks the counter for a cursor before
    // it writes, and the number only means anything if the write after it gets
    // a different one.
    let seq = BigInt(0);
    prismaService = {
      $transaction: jest.fn((cb) => cb(prismaService)),
      syncCursor: {
        upsert: jest.fn(async () => ({ seq: ++seq })),
      },
      folder: {
        findFirst: jest.fn().mockResolvedValue(mockFolder),
      },
      note: {
        create: jest.fn().mockResolvedValue(mockNote),
        findMany: jest.fn().mockResolvedValue([mockNote]),
        findFirst: jest.fn().mockResolvedValue(mockNote),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockResolvedValue({
          ...mockNote,
          version: 2,
          title: "Updated Title",
        }),
      },
      noteTag: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      noteHistory: {
        create: jest.fn().mockResolvedValue(mockHistory),
        findMany: jest.fn().mockResolvedValue([mockHistory]),
        findFirst: jest.fn().mockResolvedValue(mockHistory),
      },
      change: {
        create: jest.fn().mockResolvedValue({ id: "change-1" }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotesService,
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    service = module.get<NotesService>(NotesService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("createNote", () => {
    it("should create note and record sync change event", async () => {
      const result = await service.createNote(userId, {
        title: "New Note",
        content: "Content",
        folderId,
        tagIds: [tagId],
      });

      expect(result).toBeDefined();
      expect(result.id).toBe(noteId);
      expect(result.tags).toHaveLength(1);
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "note",
            operation: ChangeOperation.CREATE,
          }),
        }),
      );
    });

    it("should throw NotFoundException if specified folder does not exist", async () => {
      prismaService.folder.findFirst.mockResolvedValue(null);

      await expect(
        service.createNote(userId, {
          title: "Invalid Folder Note",
          folderId: "non-existent",
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getNotes", () => {
    it("should return paginated notes with tags", async () => {
      const result = await service.getNotes(userId, {
        page: 1,
        limit: 10,
        search: "Initial",
      });

      expect(result).toBeDefined();
      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
      expect(result.data[0].tags).toHaveLength(1);
    });
  });

  describe("getNoteById", () => {
    it("should return note details if found", async () => {
      const result = await service.getNoteById(userId, noteId);
      expect(result.id).toBe(noteId);
    });

    it("should throw NotFoundException if note not found", async () => {
      prismaService.note.findFirst.mockResolvedValue(null);
      await expect(service.getNoteById(userId, "non-existent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("updateNote", () => {
    it("should snapshot history, update note, and record change", async () => {
      const result = await service.updateNote(userId, noteId, {
        title: "Updated Title",
      });

      expect(result).toBeDefined();
      expect(prismaService.noteHistory.create).toHaveBeenCalled();
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            operation: ChangeOperation.UPDATE,
          }),
        }),
      );
    });
  });

  describe("deleteNote", () => {
    it("should soft delete note and record change event", async () => {
      const result = await service.deleteNote(userId, noteId);

      expect(result.success).toBe(true);
      expect(prismaService.note.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ operation: ChangeOperation.DELETE }),
        }),
      );
    });
  });

  describe("what a deleted note leaves in the log", () => {
    const loggedRow = () =>
      prismaService.change.create.mock.calls.at(-1)[0].data;

    it("moves the note's own version, not only the number written beside it", async () => {
      // The delete used to set `deletedAt` and leave `version` where it was,
      // then log `version + 1` — so the log asserted a state no row could ever
      // be read back at, and nothing on the read side could tell.
      await service.deleteNote(userId, noteId);

      expect(prismaService.note.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ version: { increment: 1 } }),
        }),
      );
    });

    it("logs the version the row answered with", async () => {
      // A distinctive number on purpose: the shared mock returns version 2 for a
      // note that was at 1, which is the very coincidence that kept the old
      // arithmetic green. What has to be pinned is that the log quotes the
      // entity rather than computing beside it.
      prismaService.note.update.mockResolvedValue({
        ...mockNote,
        deletedAt: new Date(),
        version: 9,
      });

      await service.deleteNote(userId, noteId);

      expect(loggedRow().version).toBe(9);
    });

    it("says nothing in the payload that the row already says", async () => {
      await service.deleteNote(userId, noteId);

      // `{ id: noteId }` was a third shape under one `entityType`, next to the
      // oplog path's `{}`. `entityId` is on the Change itself, and a device
      // writing a tombstone reads no key out of a delete's payload.
      expect(loggedRow().payload).toEqual({});
    });
  });

  describe("restoreNoteHistory", () => {
    it("should restore note content from snapshot history", async () => {
      const result = await service.restoreNoteHistory(
        userId,
        noteId,
        "history-uuid-1",
      );

      expect(result).toBeDefined();
      expect(prismaService.noteHistory.create).toHaveBeenCalled();
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ operation: ChangeOperation.RESTORE }),
        }),
      );
    });
  });

  describe("the note payload a device reads back", () => {
    /**
     * The payload is the whole of what a `/sync/pull` hands a device for a
     * `note`, and the device rebuilds its row from these keys — so asserting
     * `operation` alone, as the four tests above do, is what let a payload with
     * no `content` in it stay green while every other device blanked the note.
     */
    const logged = () =>
      prismaService.change.create.mock.calls.at(-1)[0].data.payload;

    it("carries the body, not only the title it was edited alongside", async () => {
      await service.updateNote(userId, noteId, {
        title: "Updated Title",
        content: "The text the user actually typed",
      });

      expect(logged()).toEqual({
        title: "Updated Title",
        // `note.update` is mocked to the row Prisma would hand back, so this is
        // the stored body rather than whatever the request happened to carry.
        content: "Initial Content",
        createdAt: mockNote.createdAt.toISOString(),
        tags: ["reading", "someday"],
        color: "#FFD54F",
      });
    });

    it("says the same five things at create as the oplog path does", async () => {
      await service.createNote(userId, {
        title: "New Note",
        content: "Content",
        folderId,
      });

      expect(Object.keys(logged()).sort()).toEqual([
        "color",
        "content",
        "createdAt",
        "tags",
        "title",
      ]);
    });

    it("leaves the device's own arrangement of the note out of the log", async () => {
      await service.updateNote(userId, noteId, {
        title: "Updated Title",
        isPinned: true,
        isArchived: true,
        folderId,
      });

      // Pin, archive and folder are this device's business: the Flutter client
      // never puts them on the wire, has no column left for `isEncrypted`, and
      // reading them off a payload that had no such key used to clear a user's
      // pin on every remote edit. Logging them here would say the server knows
      // something a device cannot be told.
      expect(logged()).not.toHaveProperty("isPinned");
      expect(logged()).not.toHaveProperty("isArchived");
      expect(logged()).not.toHaveProperty("isEncrypted");
      expect(logged()).not.toHaveProperty("folderId");
      // The entity still keeps them — this is about the log, not the row.
      expect(prismaService.note.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isPinned: true, isArchived: true }),
        }),
      );
    });

    it("keeps a restore's provenance beside the shape, not instead of it", async () => {
      await service.restoreNoteHistory(userId, noteId, "history-uuid-1");

      expect(logged()).toEqual({
        // The mocked `note.update` hands back its own row, and that row is
        // what the log records — the same rule the create and edit paths
        // follow.
        title: "Updated Title",
        content: "Initial Content",
        createdAt: mockNote.createdAt.toISOString(),
        tags: ["reading", "someday"],
        color: "#FFD54F",
        restoredFromVersion: 1,
      });
    });
  });

  describe("the label list and colour on the row", () => {
    /** The `data` object the last `note.update` was handed. */
    const written = () => prismaService.note.update.mock.calls.at(-1)[0].data;

    it("says nothing about either column on an edit that named neither", async () => {
      await service.updateNote(userId, noteId, {
        title: "Renamed",
        content: "Only the body changed",
      });

      // `undefined` is what Prisma reads as "leave this column as it is", which
      // is the whole rule here: a client that edits `content` knows nothing about
      // the note's labels, and defaulting the field to `[]` would erase them.
      expect(written().tags).toBeUndefined();
      expect(written().color).toBeUndefined();
    });

    it("writes both when the caller names them, and clears on the empty list", async () => {
      await service.updateNote(userId, noteId, {
        content: "body",
        tags: [],
        color: "#FFD54F",
      });

      // An empty list is a value the user arrived at, not silence, so it does
      // reach the column.
      expect(written().tags).toEqual([]);
      expect(written().color).toBe("#FFD54F");
    });
  });

  describe("the cursor a logged note change carries", () => {
    const cursorOf = (call: number) =>
      prismaService.change.create.mock.calls[call][0].data.cursor;

    it("numbers each write above the one before it", async () => {
      await service.createNote(userId, { title: "New Note" });
      await service.updateNote(userId, noteId, { title: "Updated Title" });

      // Not tidiness: the schema default is 0 and a pull asks for
      // `cursor > <this device's checkpoint>`, so a change written without a
      // number is invisible to every device that has synced once — permanently,
      // and indistinguishably from one it has already been given.
      expect(cursorOf(0)).toEqual(BigInt(1));
      expect(cursorOf(1)).toEqual(BigInt(2));
    });

    it("numbers the delete as carefully as the edit", async () => {
      // A delete behind a checkpoint is not a missed event, it is a note that
      // comes back on the device that never heard about it.
      await service.deleteNote(userId, noteId);

      expect(cursorOf(0)).toEqual(BigInt(1));
    });
  });

  /**
   * The sharing fallbacks in `NotesService` are injected `@Optional()`, and a
   * unit module has no global scope to inherit — so the collaborator is
   * provided here by hand. In the running app it is never absent:
   * `CollaborationModule` is `@Global()` and `AppModule` imports it, which makes
   * its export visible to every module without one importing it. What these
   * tests are for is that the branch had never been exercised at all, which is
   * exactly how it came to be read as dead code.
   */
  describe("a note somebody else shared", () => {
    let shared: NotesService;
    let collaboration: { checkAccess: jest.Mock };

    beforeEach(async () => {
      collaboration = {
        checkAccess: jest.fn().mockResolvedValue({ hasAccess: true }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          NotesService,
          { provide: PrismaService, useValue: prismaService },
          { provide: CollaborationService, useValue: collaboration },
        ],
      }).compile();

      shared = module.get<NotesService>(NotesService);
    });

    it("is read as the owner's row, once the share says yes", async () => {
      // The first read is the ordinary one and misses; the second is the
      // fallback, and it names no owner by design — the note belongs to
      // somebody else. Pinned both ways because an unscoped read is the one
      // thing here that must never be reachable without the answer above it.
      prismaService.note.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockNote);

      const result = await shared.getNoteById(userId, noteId);

      expect(result.id).toBe(noteId);
      expect(collaboration.checkAccess).toHaveBeenCalledWith(
        userId,
        undefined,
        "NOTE",
        noteId,
        "VIEWER",
      );
      expect(prismaService.note.findFirst.mock.calls[0][0].where.userId).toBe(
        userId,
      );
      expect(
        prismaService.note.findFirst.mock.calls.at(-1)[0].where,
      ).not.toHaveProperty("userId");
    });

    it("asks for the EDITOR role before a write goes through the share", async () => {
      prismaService.note.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockNote);

      await shared.updateNote(userId, noteId, {
        title: "Renamed by the editor",
      });

      // A reader's permission must not be what an edit is checked against.
      // Which roles outrank which is `CollaborationService`'s business; that
      // this path asks the stronger question is this one's.
      expect(collaboration.checkAccess).toHaveBeenCalledWith(
        userId,
        undefined,
        "NOTE",
        noteId,
        "EDITOR",
      );
      expect(prismaService.note.update).toHaveBeenCalled();
    });

    it("is still not found when the share says no", async () => {
      collaboration.checkAccess.mockResolvedValue({ hasAccess: false });
      prismaService.note.findFirst.mockResolvedValue(null);

      await expect(shared.getNoteById(userId, noteId)).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        shared.updateNote(userId, noteId, { title: "Not yours" }),
      ).rejects.toThrow(NotFoundException);
      // The 404 is the same answer a note that does not exist gives, which is
      // the point: probing for somebody else's ids learns nothing.
      expect(prismaService.note.update).not.toHaveBeenCalled();
      expect(prismaService.change.create).not.toHaveBeenCalled();
    });
  });
});
