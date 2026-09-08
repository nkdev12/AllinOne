import { Test, TestingModule } from "@nestjs/testing";
import { NotesService } from "./notes.service";
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
    prismaService = {
      $transaction: jest.fn((cb) => cb(prismaService)),
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
});
