import {
  Injectable,
  NotFoundException,
  Optional,
  ConflictException,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { CollaborationService } from "@/collaboration/collaboration.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import { CreateNoteDto } from "../dto/create-note.dto";
import { UpdateNoteDto } from "../dto/update-note.dto";
import { QueryNotesDto } from "../dto/query-notes.dto";
import { appendChange } from "@/sync/change-cursor";
import { ChangeOperation, Prisma } from "@prisma/client";

@Injectable()
export class NotesService {
  /**
   * `syncNotifications` is the wake-up for every other device this account has.
   * Each write below logs its change inside its own `$transaction` and notifies
   * only once that transaction has resolved — emitting from inside it would tell
   * devices to go read a row that a rollback can still take away — and the
   * notifier cannot throw, so a socket that is not there costs latency and not
   * the request. `@Optional()` because a unit graph (and any module compiled
   * without the global `SyncModule`) has no gateway to hand it.
   */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly collaborationService?: CollaborationService,
    @Optional() private readonly syncNotifications?: SyncNotificationService,
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

    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const note = await tx.note.create({
        data: {
          userId,
          title: dto.title,
          content: dto.content,
          folderId: dto.folderId,
          isPinned: dto.isPinned ?? false,
          isEncrypted: dto.isEncrypted ?? false,
          // A create has no previous value to preserve, so an absent `tags` means
          // the empty list rather than leaving the column out of the document.
          tags: dto.tags ?? [],
          color: dto.color ?? null,
          // Same for these two, with the opposite default: a note this server
          // creates has no format invented for it. `null` is the value that
          // keeps the two meanings apart downstream — "no table" here, and a
          // table the user cleared is the client's `{"rows":[]}`.
          noteType: dto.noteType ?? null,
          structured: dto.structured ?? null,
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

      const logged = await appendChange(tx, {
        userId,
        entityType: "note",
        entityId: note.id,
        operation: ChangeOperation.CREATE,
        version: note.version,
        payload: noteChangePayload(note),
      });
      highestCursor = logged.cursor;

      return this.formatNoteResponse(note);
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return created;
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

    if (dto.version !== undefined && dto.version !== existing.version) {
      throw new ConflictException(
        "This note has changed. Reload it before saving your edits.",
      );
    }

    if (dto.folderId) {
      const folder = await this.prisma.folder.findFirst({
        where: { id: dto.folderId, userId: existing.userId, deletedAt: null },
      });
      if (!folder) {
        throw new NotFoundException(
          `Folder with ID '${dto.folderId}' not found.`,
        );
      }
    }

    let highestCursor: bigint | undefined;

    const updated = await this.prisma
      .$transaction(async (tx) => {
        // 1. Snapshot current version into history
        await tx.noteHistory.create({
          data: {
            noteId: existing.id,
            version: existing.version,
            title: existing.title,
            content: existing.content,
          },
        });

        // 2. Update the tag relations if specified. The free-text `tags` list is
        //    a separate column and is not touched by `tagIds`.
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
          where: {
            id: existing.id,
            ...(dto.version !== undefined ? { version: dto.version } : {}),
          },
          data: {
            title: dto.title,
            content: dto.content,
            folderId: dto.folderId,
            isPinned: dto.isPinned,
            isArchived: dto.isArchived,
            isEncrypted: dto.isEncrypted,
            // `undefined` on this object is Prisma's "do not write the field",
            // which is exactly the rule the two new columns need: an edit that
            // PATCHes only `content` says nothing about the user's labels, and
            // saying nothing must not read as clearing them. So `dto.tags` is never
            // defaulted to `[]` here the way the create path defaults it — only a
            // list the caller actually sent, or the `null` that means "none",
            // reaches the column. `color` is nullable on the row, so a `null`
            // clears it and an absent key leaves it standing.
            tags: dto.tags === undefined ? undefined : (dto.tags ?? []),
            color: dto.color,
            // The format and its table are `color`'s rule exactly, and for the
            // same reason: an absent key is Prisma's "do not write", so a REST
            // edit of one field cannot rewrite the other, while an explicit
            // `null` is a caller saying this note really has no table — a
            // different statement from the client's `{"rows":[]}`, which is a
            // table it has and has emptied.
            noteType: dto.noteType,
            structured: dto.structured,
            version: { increment: 1 },
          },
          include: {
            folder: true,
            noteTags: { include: { tag: true } },
            attachments: true,
          },
        });

        // 4. Record sync change event
        const logged = await appendChange(tx, {
          userId: existing.userId,
          entityType: "note",
          entityId: updatedNote.id,
          operation: ChangeOperation.UPDATE,
          version: updatedNote.version,
          payload: noteChangePayload(updatedNote, silentAbout(dto)),
        });
        highestCursor = logged.cursor;

        return this.formatNoteResponse(updatedNote);
      })
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === "P2025" || error.code === "P2034")
        ) {
          throw new ConflictException(
            "This note has changed. Reload it before saving your edits.",
          );
        }
        throw error;
      });

    this.syncNotifications?.notifyMutation({
      userId: existing.userId,
      highestCursor,
    });

    return updated;
  }

  async deleteNote(userId: string, noteId: string) {
    const existing = await this.prisma.note.findFirst({
      where: { id: noteId, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Note with ID '${noteId}' not found.`);
    }

    let highestCursor: bigint | undefined;

    const result = await this.prisma.$transaction(async (tx) => {
      const deletedNote = await tx.note.update({
        where: { id: noteId },
        // The version moves with the delete, the way a task's and an event's do.
        // Not cosmetics: the log below names a version, and a version is only
        // worth recording if some row can be read back at it.
        data: { deletedAt: new Date(), version: { increment: 1 } },
      });

      const logged = await appendChange(tx, {
        userId,
        entityType: "note",
        entityId: noteId,
        operation: ChangeOperation.DELETE,
        // Where this used to say `deletedNote.version + 1` while the row above
        // left the version alone — the log asserting a number the entity never
        // reached, and no device able to tell the two apart.
        version: deletedNote.version,
        // Nothing, which is what the oplog path sends for a delete: `entityId`
        // already names the note, and a device writing a tombstone reads no keys
        // out of the payload. `{ id: noteId }` was a third shape under one
        // `entityType`, alongside the client's `{}` and the old REST edit body.
        payload: {},
      });
      highestCursor = logged.cursor;

      return { success: true, message: "Note deleted successfully." };
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return result;
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

    let highestCursor: bigint | undefined;

    const restored = await this.prisma.$transaction(async (tx) => {
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

      const logged = await appendChange(tx, {
        userId,
        entityType: "note",
        entityId: restoredNote.id,
        operation: ChangeOperation.RESTORE,
        version: restoredNote.version,
        // The one payload that carries more than the shape: which snapshot
        // this came from is provenance the log has nowhere else to say it. A
        // device reads the three keys it knows and ignores this one.
        //
        // Both format keys are silent, because `NoteHistory` stores a title and
        // a body and nothing else: a restore cannot bring a table back, and
        // emitting the row's copy would say it had.
        payload: {
          ...noteChangePayload(restoredNote, ["noteType", "structured"]),
          restoredFromVersion: snapshot.version,
        },
      });
      highestCursor = logged.cursor;

      return this.formatNoteResponse(restoredNote);
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return restored;
  }

  private formatNoteResponse(note: any) {
    const { noteTags, ...rest } = note;
    // `rest` carries the new scalar `tags` column, and this mapping overwrites
    // that key with the account's `Tag` records — which is the shape
    // `docs/API_REFERENCE.md` documents for `GET /notes/:id` ("including
    // relations (folder, tags, ...)") and what every REST caller reads today.
    // The bare string list the sync contract uses under the same name is
    // therefore not on this response; `/sync/pull` is, where the key carries it
    // verbatim. Renaming either one would break a different reader, so the
    // collision is left visible here rather than resolved silently.
    return {
      ...rest,
      tags: noteTags ? noteTags.map((nt: any) => nt.tag) : [],
    };
  }
}

/**
 * The `note` payload, written once because it is read back by something that
 * cannot say "this change forgot its body". A device rebuilds a note from
 * `title` and `content`, so a logged change that carries one without the other
 * is a rewrite of that note into something shorter: until now every REST edit
 * arrived on the other devices as a note with its text gone, because REST was
 * the one path that edited `content` and did not log it.
 *
 * `createdAt` belongs here for the reason item 38 of the notes audit gave it:
 * the log's own row is stamped with when this server heard about the change,
 * which is not when the note began, and the client keeps a note's birth from the
 * payload rather than from its own clock.
 *
 * `tags` and `color` are always present because a note payload is a whole
 * document and the version beside it is last-write-wins: a device that missed a
 * change has no other way to learn a newer label set, so leaving the keys off
 * would let the two copies of one note diverge for good. The row's copy is what
 * this endpoint has, so that is what goes on the wire.
 *
 * `noteType` and `structured` are here under the same whole-document rule, with
 * one amendment worth its weight: this row is *not* authoritative for them
 * unless the caller just wrote them. `/sync/push` appends to the log and never
 * touches the `Note` row, so a device's newer table can sit several versions
 * ahead of the copy this row is still holding, and a device reads a present key
 * as the whole new value — which makes restating the stale one the exact way for
 * a rename of a note's title to empty somebody's shopping list. So a change
 * names them when its caller did, and says nothing when it did not. Absence is
 * safe on this side of the wire for precisely these keys: `SyncManager._apply`
 * guards each with `containsKey` (`sync_manager.dart:593`) and leaves a column
 * it was not given alone. The same staleness is latent in `tags` and `color`,
 * whose guards are identical; it is left alone here because that rule is a
 * separate call to make.
 *
 * When a table is named, each key carries its own empty form rather than one
 * invented here — `null` is a note with no format and a note with no table, and
 * the app's *cleared but still a table* is its own `{"rows":[]}`, so the two
 * states stay distinguishable all the way through.
 *
 * What is deliberately absent is what used to be the whole payload —
 * `folderId`, `isPinned`, `isArchived`, `isEncrypted`. Those are a device's
 * arrangement of a note rather than the note: the client never puts them on the
 * wire, has no column left for `isEncrypted`, and reads them back off nothing,
 * so logging them only made two write paths look like they disagreed about what
 * a note *is*. The `Note` row still holds them; the log records what syncs.
 */
type FormatField = "noteType" | "structured";

function noteChangePayload(
  note: {
    title: string;
    content: string | null;
    createdAt: Date;
    tags?: string[] | null;
    color?: string | null;
    noteType?: string | null;
    structured?: string | null;
  },
  /** The format keys this change must not speak for. */
  silent: ReadonlyArray<FormatField> = [],
) {
  return {
    title: note.title,
    content: note.content,
    createdAt: note.createdAt.toISOString(),
    tags: note.tags ?? [],
    color: note.color ?? null,
    ...(silent.includes("noteType") ? {} : { noteType: note.noteType ?? null }),
    ...(silent.includes("structured")
      ? {}
      : { structured: note.structured ?? null }),
  };
}

/**
 * The format keys a PATCH left out, which its logged change has to leave out
 * too: an absent key on the request is the caller saying nothing, and the row's
 * copy of that column is not news about the note.
 */
function silentAbout(dto: { noteType?: string; structured?: string }) {
  const silent: FormatField[] = [];
  if (dto.noteType === undefined) silent.push("noteType");
  if (dto.structured === undefined) silent.push("structured");
  return silent;
}
