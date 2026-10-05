import { Logger } from "@nestjs/common";
import { ChangeOperation } from "@prisma/client";
import {
  projectAcceptedChange,
  type ProjectableChange,
} from "./change-projection";

const userId = "user-uuid-123";
const noteId = "11111111-1111-4111-8111-111111111111";
const folderId = "33333333-3333-4333-8333-333333333333";

const delegates = (id: string, overrides: Record<string, jest.Mock>) => ({
  findUnique: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({ id }),
  update: jest.fn().mockResolvedValue({ id }),
  ...overrides,
});

function fakeTx(overrides: Record<string, jest.Mock> = {}) {
  return {
    note: delegates(noteId, overrides),
    folder: delegates(folderId, {}),
  };
}

function fakeFolderTx(overrides: Record<string, jest.Mock> = {}) {
  return {
    note: delegates(noteId, {}),
    folder: delegates(folderId, overrides),
  };
}

function change(over: Partial<ProjectableChange> = {}): ProjectableChange {
  return {
    entityType: "note",
    entityId: noteId,
    operation: ChangeOperation.CREATE,
    version: 1,
    payload: { title: "Bread", content: "Two loaves" },
    ...over,
  };
}

describe("projectAcceptedChange", () => {
  it("writes a note the row has never held", async () => {
    const tx = fakeTx();

    await projectAcceptedChange(
      tx,
      userId,
      change({
        payload: {
          title: "Shopping",
          content: null,
          tags: ["errand"],
          color: "#FF8800",
          noteType: "shopping",
          structured: '{"rows":[{"id":"r1","item":"Bread"}]}',
          createdAt: "2026-09-21T09:15:00.000Z",
          version: 1,
        },
      }),
    );

    expect(tx.note.create).toHaveBeenCalledWith({
      data: {
        id: noteId,
        userId,
        title: "Shopping",
        content: null,
        tags: ["errand"],
        color: "#FF8800",
        noteType: "shopping",
        structured: '{"rows":[{"id":"r1","item":"Bread"}]}',
        createdAt: new Date("2026-09-21T09:15:00.000Z"),
        version: 1,
      },
    });
  });

  it("speaks for no entity but a note", async () => {
    // task / event / calendar / habit / vault_item are listed in the module
    // header; a projection that guessed at their columns would refuse pushes
    // that sync correctly today.
    for (const entityType of [
      "task",
      "event",
      "calendar",
      "habit",
      "habit_log",
      "vault_item",
    ]) {
      const tx = fakeTx();
      await projectAcceptedChange(tx, userId, change({ entityType }));
      expect(tx.note.findUnique).not.toHaveBeenCalled();
      expect(tx.note.create).not.toHaveBeenCalled();
      expect(tx.note.update).not.toHaveBeenCalled();
    }
  });

  it("leaves a column a change never mentioned out of the write", async () => {
    const tx = fakeTx({
      findUnique: jest.fn().mockResolvedValue({ userId, version: 1 }),
    });

    // A phone on the build before tags and colours pushes `{title, content}` and
    // nothing else. Clearing the user's labels on the strength of a key that was
    // never sent is the erasure the pull path already refuses.
    await projectAcceptedChange(
      tx,
      userId,
      change({ operation: ChangeOperation.UPDATE, version: 2 }),
    );

    const data = tx.note.update.mock.calls[0][0].data;
    expect(data).toEqual({
      title: "Bread",
      content: "Two loaves",
      version: 2,
      deletedAt: null,
    });
    for (const key of ["tags", "color", "noteType", "structured"]) {
      expect(data).not.toHaveProperty(key);
    }
  });

  it("takes the version from the change, not from the body", async () => {
    const tx = fakeTx({
      findUnique: jest.fn().mockResolvedValue({ userId, version: 2 }),
    });

    // The row's version is what REST compares against when it increments, so it
    // has to be the number the log accepted — which is the envelope's, and the
    // only one a device cannot disagree with the log about.
    await projectAcceptedChange(
      tx,
      userId,
      change({
        operation: ChangeOperation.UPDATE,
        version: 7,
        payload: { title: "Bread", content: null, version: 3 },
      }),
    );

    expect(tx.note.update.mock.calls[0][0].data.version).toBe(7);
  });

  it("refuses to edit a note another account owns", async () => {
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const tx = fakeTx({
      // Deliberately read unfiltered: `entityId` is the one field in a push that
      // can name something the caller does not own.
      findUnique: jest
        .fn()
        .mockResolvedValue({ userId: "someone-else", version: 4 }),
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({ operation: ChangeOperation.UPDATE, version: 5 }),
    );

    expect(tx.note.update).not.toHaveBeenCalled();
    expect(tx.note.create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("marks a note deleted, and leaves one the server never saw alone", async () => {
    const tx = fakeTx({
      findUnique: jest.fn().mockResolvedValue({ userId, version: 3 }),
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        operation: ChangeOperation.DELETE,
        version: 4,
        payload: { version: 4 },
      }),
    );

    const data = tx.note.update.mock.calls[0][0].data;
    expect(data.version).toBe(4);
    expect(data.deletedAt).toBeInstanceOf(Date);
    // A delete announces an end, not a body — the text stays where it was.
    expect(data).not.toHaveProperty("title");
    expect(data).not.toHaveProperty("content");

    const absent = fakeTx();
    await projectAcceptedChange(absent, userId, change({ version: 1 }));
    await projectAcceptedChange(
      absent,
      userId,
      change({
        operation: ChangeOperation.DELETE,
        version: 2,
        payload: { version: 2 },
      }),
    );
    expect(absent.note.update).not.toHaveBeenCalled();
  });

  describe("against a row that already exists", () => {
    it("lets a newer change through and an older one nowhere", async () => {
      const held = fakeTx({
        findUnique: jest.fn().mockResolvedValue({ userId, version: 5 }),
      });
      await projectAcceptedChange(
        held,
        userId,
        change({ operation: ChangeOperation.UPDATE, version: 4 }),
      );
      expect(held.note.update).not.toHaveBeenCalled();

      // An equal version is the retry case, and the concurrent-edit case the log
      // also accepts; the mirror follows whatever the log settled on.
      const same = fakeTx({
        findUnique: jest.fn().mockResolvedValue({ userId, version: 5 }),
      });
      await projectAcceptedChange(
        same,
        userId,
        change({ operation: ChangeOperation.UPDATE, version: 5 }),
      );
      expect(same.note.update).toHaveBeenCalled();
    });

    it("loses a tie against a delete, and a newer change revives the row", async () => {
      const deleted = { userId, version: 6, deletedAt: new Date() };

      // A delete and the in-flight edit that raced it carry the same number, and
      // the client's own `_apply` gives the tie to the delete. The table has to
      // answer the same way or the two copies disagree about whether the note
      // exists.
      const tie = fakeTx({
        findUnique: jest.fn().mockResolvedValue(deleted),
      });
      await projectAcceptedChange(
        tie,
        userId,
        change({ operation: ChangeOperation.UPDATE, version: 6 }),
      );
      expect(tie.note.update).not.toHaveBeenCalled();

      const revive = fakeTx({
        findUnique: jest.fn().mockResolvedValue(deleted),
      });
      await projectAcceptedChange(
        revive,
        userId,
        change({ operation: ChangeOperation.UPDATE, version: 7 }),
      );
      expect(revive.note.update.mock.calls[0][0].data.deletedAt).toBeNull();
    });

    it("treats a restore as the one change that always comes back", async () => {
      const tx = fakeTx({
        findUnique: jest
          .fn()
          .mockResolvedValue({ userId, version: 6, deletedAt: new Date() }),
      });

      await projectAcceptedChange(
        tx,
        userId,
        change({ operation: ChangeOperation.RESTORE, version: 6 }),
      );

      expect(tx.note.update.mock.calls[0][0].data.deletedAt).toBeNull();
    });
  });

  it("keeps a note's birth to the change that announces it", async () => {
    const tx = fakeTx({
      findUnique: jest
        .fn()
        .mockResolvedValue({ userId, version: 1, deletedAt: null }),
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        operation: ChangeOperation.UPDATE,
        version: 2,
        payload: {
          title: "Bread",
          content: null,
          createdAt: "2020-01-01T00:00:00.000Z",
        },
      }),
    );

    expect(tx.note.update.mock.calls[0][0].data).not.toHaveProperty(
      "createdAt",
    );

    const fresh = fakeTx();
    await projectAcceptedChange(
      fresh,
      userId,
      change({
        payload: { title: "Bread", content: null, createdAt: "nonsense" },
      }),
    );
    // `new Date("nonsense")` is an Invalid Date and Prisma rejects the document
    // for it, which would take the whole batch down. Absent means the schema's
    // own `now()`, which is a wrong-by-seconds answer rather than a broken one.
    expect(fresh.note.create.mock.calls[0][0].data).not.toHaveProperty(
      "createdAt",
    );
  });

  it("drops a value a column cannot hold instead of writing a mess", async () => {
    const tx = fakeTx({
      findUnique: jest.fn().mockResolvedValue({ userId, version: 1 }),
    });

    await projectAcceptedChange(
      tx,
      userId,
      change({
        operation: ChangeOperation.UPDATE,
        version: 2,
        payload: {
          title: 42,
          content: { op: "insert" },
          tags: ["keep", { not: "this" }],
          color: 7,
          noteType: "",
          structured: { rows: [] },
        },
      }),
    );

    const data = tx.note.update.mock.calls[0][0].data;
    // An object in `structured` is the one that costs the user their rows: the
    // client will not store a non-text table, so it applies null and every
    // device that pulls the change empties its copy.
    expect(data).not.toHaveProperty("title");
    expect(data).not.toHaveProperty("content");
    expect(data).not.toHaveProperty("color");
    expect(data).not.toHaveProperty("structured");
    expect(data.tags).toEqual(["keep"]);
    // An empty `noteType` is a string the column accepts, and the app reads an
    // unknown key as a normal note rather than failing on it.
    expect(data.noteType).toBe("");
  });

  it("creates a note whose first change carried no title", async () => {
    const tx = fakeTx();

    await projectAcceptedChange(
      tx,
      userId,
      change({ payload: { title: "", content: null } }),
    );

    // `title` is a required column, so "nothing" still has to be a value.
    expect(tx.note.create.mock.calls[0][0].data.title).toBe("");
  });

  describe("a folder", () => {
    const folderChange = (over: Partial<ProjectableChange> = {}) =>
      change({
        entityType: "folder",
        entityId: folderId,
        payload: { name: "Shopping" },
        ...over,
      });

    it("creates one with the format and glyph that make it what it is", async () => {
      const tx = fakeFolderTx();

      await projectAcceptedChange(
        tx,
        userId,
        folderChange({
          payload: {
            name: "Shopping",
            type: "shopping",
            icon: "cart",
            createdAt: "2026-09-21T09:15:00.000Z",
            version: 1,
          },
        }),
      );

      expect(tx.folder.create).toHaveBeenCalledWith({
        data: {
          id: folderId,
          userId,
          name: "Shopping",
          type: "shopping",
          icon: "cart",
          version: 1,
          createdAt: new Date("2026-09-21T09:15:00.000Z"),
        },
      });
      // The tree is not on the wire, so nothing here can place the folder under
      // another one — and `isCollapsed` is a device's own view of its rail.
      expect(tx.folder.create.mock.calls[0][0].data).not.toHaveProperty(
        "parentId",
      );
    });

    it("renames without saying anything about the format", async () => {
      const tx = fakeFolderTx({
        findUnique: jest.fn().mockResolvedValue({ userId, version: 1 }),
      });

      await projectAcceptedChange(
        tx,
        userId,
        folderChange({
          operation: ChangeOperation.UPDATE,
          version: 2,
          payload: { name: "Errands" },
        }),
      );

      const data = tx.folder.update.mock.calls[0][0].data;
      expect(data.name).toBe("Errands");
      expect(data).not.toHaveProperty("type");
      expect(data).not.toHaveProperty("icon");
    });

    it("marks one deleted, and takes the delete back when a newer edit arrives", async () => {
      // `version: 5` is the number the delete itself left on the row: the row's
      // version mirrors the change that ended it.
      const gone = { userId, version: 5, deletedAt: new Date() };
      const tx = fakeFolderTx({
        findUnique: jest.fn().mockResolvedValue(gone),
      });

      await projectAcceptedChange(
        tx,
        userId,
        folderChange({
          operation: ChangeOperation.DELETE,
          version: 6,
          payload: { version: 6 },
        }),
      );
      expect(tx.folder.update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(
        Date,
      );

      const revived = fakeFolderTx({
        findUnique: jest.fn().mockResolvedValue(gone),
      });
      await projectAcceptedChange(
        revived,
        userId,
        folderChange({ operation: ChangeOperation.UPDATE, version: 7 }),
      );
      expect(revived.folder.update.mock.calls[0][0].data.deletedAt).toBeNull();

      const raced = fakeFolderTx({
        findUnique: jest.fn().mockResolvedValue(gone),
      });
      await projectAcceptedChange(
        raced,
        userId,
        folderChange({ operation: ChangeOperation.UPDATE, version: 5 }),
      );
      expect(raced.folder.update).not.toHaveBeenCalled();
    });

    it("refuses to rename another account's folder", async () => {
      const warn = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);
      const tx = fakeFolderTx({
        findUnique: jest
          .fn()
          .mockResolvedValue({ userId: "someone-else", version: 1 }),
      });

      await projectAcceptedChange(
        tx,
        userId,
        folderChange({ operation: ChangeOperation.UPDATE, version: 2 }),
      );

      expect(tx.folder.update).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
