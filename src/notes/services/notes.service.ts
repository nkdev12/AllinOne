import { Injectable, NotFoundException } from "@nestjs/common";
import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { CollaborationService } from "@/collaboration/collaboration.service";
import { CreateNoteDto } from "../dto/create-note.dto";
import { UpdateNoteDto } from "../dto/update-note.dto";
import { QueryNotesDto } from "../dto/query-notes.dto";
import { ChangeOperation } from "@prisma/client";

@Injectable()
export class NotesService {
  constructor(private readonly prisma: PrismaService) {}
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly collaborationService?: CollaborationService,
  ) {}

  async createNote(userId: string, dto: CreateNoteDto) {
    if (dto.folderId) {
      const folder = await this.prisma.folder.findFirst({
        where: { id: dto.folderId, userId, deletedAt: null },
      });
      if (!folder) {
        throw new NotFoundException(
          `Folder with ID '${dto.folderId}' not found.`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const note = await tx.note.create({
        data: {
          userId,
          title: dto.title,
          content: dto.content,
          folderId: dto.folderId,
          isPinned: dto.isPinned ?? false,
          isEncrypted: dto.isEncrypted ?? false,
          version: 1,
          noteTags:
            dto.tagIds && dto.tagIds.length > 0
              ? {
                  createMany: {
                    data: dto.tagIds.map((tagId) => ({ tagId })),
                  },
                }
              : undefined,
        },
        include: {
          folder: true,
          noteTags: { include: { tag: true } },
        },
      });

      await tx.change.create({
        data: {
          userId,
          entityType: "note",
          entityId: note.id,
          operation: ChangeOperation.CREATE,
          version: note.version,
          payload: {
            title: note.title,
            folderId: note.folderId,
            isPinned: note.isPinned,
            isEncrypted: note.isEncrypted,
          },
        },
      });

      return this.formatNoteResponse(note);
    });
  }

  async getNotes(userId: string, query: QueryNotesDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {
      userId,
      deletedAt: null,
    };

    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: "insensitive" } },
        { content: { contains: query.search, mode: "insensitive" } },
      ];
    }

    if (query.folderId) {
      where.folderId = query.folderId;
    }

    if (query.isPinned !== undefined) {
      where.isPinned = query.isPinned;
    }

    if (query.isArchived !== undefined) {
      where.isArchived = query.isArchived;
    }

    if (query.tagId) {
      where.noteTags = {
        some: { tagId: query.tagId },
      };
    }

    const [total, items] = await Promise.all([
      this.prisma.note.count({ where }),
      this.prisma.note.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }],
        include: {
          folder: true,
          noteTags: { include: { tag: true } },
          attachments: true,
        },
      }),
    ]);

    return {
      data: items.map(this.formatNoteResponse),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getNoteById(userId: string, noteId: string) {
    const note = await this.prisma.note.findFirst({
    let note = await this.prisma.note.findFirst({
      where: { id: noteId, userId, deletedAt: null },
      include: {
        folder: true,
        noteTags: { include: { tag: true } },
        history: { orderBy: { version: "desc" } },
        attachments: true,
      },
    });

    if (!note && this.collaborationService) {
      const access = await this.collaborationService.checkAccess(
        userId,
        undefined,
        "NOTE",
        noteId,
        "VIEWER",
      );
      if (access.hasAccess) {
        note = await this.prisma.note.findFirst({
          where: { id: noteId, deletedAt: null },
          include: {
            folder: true,
            noteTags: { include: { tag: true } },
            history: { orderBy: { version: "desc" } },
            attachments: true,
          },
        });
      }
    }

    if (!note) {
      throw new NotFoundException(`Note with ID '${noteId}' not found.`);
    }

    return this.formatNoteResponse(note);
  }

  async updateNote(userId: string, noteId: string, dto: UpdateNoteDto) {
    const existing = await this.prisma.note.findFirst({
    let existing = await this.prisma.note.findFirst({
      where: { id: noteId, userId, deletedAt: null },
    });

    if (!existing && this.collaborationService) {
      const access = await this.collaborationService.checkAccess(
        userId,
        undefined,
        "NOTE",
        noteId,
        "EDITOR",
      );
      if (access.hasAccess) {
        existing = await this.prisma.note.findFirst({
          where: { id: noteId, deletedAt: null },
        });
      }
    }

    if (!existing) {
      throw new NotFoundException(`Note with ID '${noteId}' not found.`);
    }

    if (dto.folderId) {
      const folder = await this.prisma.folder.findFirst({
        where: { id: dto.folderId, userId, deletedAt: null },
      });
      if (!folder) {
        throw new NotFoundException(
          `Folder with ID '${dto.folderId}' not found.`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Snapshot current version into history
      await tx.noteHistory.create({
        data: {
          noteId: existing.id,
          version: existing.version,
          title: existing.title,
          content: existing.content,
        },
      });

      // 2. Update tags if specified
      if (dto.tagIds !== undefined) {
        await tx.noteTag.deleteMany({ where: { noteId: existing.id } });
        if (dto.tagIds.length > 0) {
          await tx.noteTag.createMany({
            data: dto.tagIds.map((tagId) => ({ noteId: existing.id, tagId })),
          });
        }
      }

      // 3. Update note entity
      const updatedNote = await tx.note.update({
        where: { id: existing.id },
        data: {
          title: dto.title,
          content: dto.content,
          folderId: dto.folderId,
          isPinned: dto.isPinned,
          isArchived: dto.isArchived,
          isEncrypted: dto.isEncrypted,
          version: { increment: 1 },
        },
        include: {
          folder: true,
          noteTags: { include: { tag: true } },
          attachments: true,
        },
      });

      // 4. Record sync change event
      await tx.change.create({
        data: {
          userId,
          entityType: "note",
          entityId: updatedNote.id,
          operation: ChangeOperation.UPDATE,
          version: updatedNote.version,
          payload: {
            title: updatedNote.title,
            folderId: updatedNote.folderId,
            isPinned: updatedNote.isPinned,
            isArchived: updatedNote.isArchived,
            isEncrypted: updatedNote.isEncrypted,
          },
        },
      });

      return this.formatNoteResponse(updatedNote);
    });
  }

  async deleteNote(userId: string, noteId: string) {
    const existing = await this.prisma.note.findFirst({
      where: { id: noteId, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Note with ID '${noteId}' not found.`);
    }

    return this.prisma.$transaction(async (tx) => {
      const deletedNote = await tx.note.update({
        where: { id: noteId },
        data: { deletedAt: new Date() },
      });

      await tx.change.create({
        data: {
          userId,
          entityType: "note",
          entityId: noteId,
          operation: ChangeOperation.DELETE,
          version: deletedNote.version + 1,
          payload: { id: noteId },
        },
      });

      return { success: true, message: "Note deleted successfully." };
    });
  }

  async getNoteHistory(userId: string, noteId: string) {
    await this.getNoteById(userId, noteId);

    return this.prisma.noteHistory.findMany({
      where: { noteId },
      orderBy: { version: "desc" },
    });
  }

  async restoreNoteHistory(userId: string, noteId: string, historyId: string) {
    const note = await this.prisma.note.findFirst({
      where: { id: noteId, userId, deletedAt: null },
    });

    if (!note) {
      throw new NotFoundException(`Note with ID '${noteId}' not found.`);
    }

    const snapshot = await this.prisma.noteHistory.findFirst({
      where: { id: historyId, noteId },
    });

    if (!snapshot) {
      throw new NotFoundException(
        `History snapshot with ID '${historyId}' not found for note.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.noteHistory.create({
        data: {
          noteId: note.id,
          version: note.version,
          title: note.title,
          content: note.content,
        },
      });

      const restoredNote = await tx.note.update({
        where: { id: note.id },
        data: {
          title: snapshot.title,
          content: snapshot.content,
          version: { increment: 1 },
        },
        include: {
          folder: true,
          noteTags: { include: { tag: true } },
          attachments: true,
        },
      });

      await tx.change.create({
        data: {
          userId,
          entityType: "note",
          entityId: restoredNote.id,
          operation: ChangeOperation.RESTORE,
          version: restoredNote.version,
          payload: {
            title: restoredNote.title,
            restoredFromVersion: snapshot.version,
          },
        },
      });

      return this.formatNoteResponse(restoredNote);
    });
  }

  private formatNoteResponse(note: any) {
    const { noteTags, ...rest } = note;
    return {
      ...rest,
      tags: noteTags ? noteTags.map((nt: any) => nt.tag) : [],
    };
  }
}
