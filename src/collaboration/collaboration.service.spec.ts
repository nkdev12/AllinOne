import { Test, TestingModule } from "@nestjs/testing";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { AuditAction, Prisma } from "@prisma/client";
import { CollaborationService } from "./collaboration.service";
import { CreateShareDto } from "./dto/collaboration.dto";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AuditLogService } from "@/common/audit/audit-log.service";

const OWNER = "owner-1";
const COLLAB = "collab-1";
const STRANGER = "stranger-1";

interface StoredShare {
  id: string;
  resourceType: string;
  resourceId: string;
  ownerId: string;
  sharedWithUserId: string;
  sharedWithEmail: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Where the rows live for the whole test run: outside any service instance, so
 * "a share survives a restart" is a claim about this store and not about
 * whatever the object graph happens to remember.
 */
interface ShareStore {
  rows: StoredShare[];
  note: { findFirst: jest.Mock };
  project: { findFirst: jest.Mock };
  calendar: { findFirst: jest.Mock };
  user: { findFirst: jest.Mock };
  resourceShare: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  $transaction: jest.Mock;
  [key: string]: unknown;
}

function matches(row: StoredShare, where: any = {}): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "OR") {
      const clauses = value as any[];
      if (!clauses.some((clause) => matches(row, clause))) return false;
    } else if (key === "deletedAt") {
      if ((row.deletedAt ?? null) !== (value ?? null)) return false;
    } else if (row[key as keyof StoredShare] !== value) {
      return false;
    }
  }
  return true;
}

function orderBy(rows: StoredShare[], spec?: any): StoredShare[] {
  if (!spec) return rows;
  const key = Object.keys(spec)[0] as keyof StoredShare;
  const direction = spec[key] === "desc" ? -1 : 1;
  return [...rows].sort(
    (a, b) =>
      ((a[key] as Date).getTime() - (b[key] as Date).getTime()) * direction,
  );
}

/** A copy, the way Prisma hands back a document rather than a live reference. */
function clone(row: StoredShare): StoredShare {
  return { ...row };
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`resourceType`,`resourceId`,`sharedWithEmail`)",
    {
      code: "P2002",
      clientVersion: "5.22.0",
      meta: {
        target: ["resourceType", "resourceId", "sharedWithEmail"],
      },
    },
  );
}

/**
 * A fake of the `ResourceShare` collection, not of the whole service: the
 * behaviours it has to reproduce are the ones the service now depends on — the
 * unique key refusing a second grant to the same address (tombstones included,
 * which is what makes revive necessary), `deletedAt: null` filtering, `skip` /
 * `take`, and `@updatedAt` moving with every write.
 */
function createShareStore(): ShareStore {
  const rows: StoredShare[] = [];
  const resources: Record<string, { userId: string; title: string }> = {
    "note-1": { userId: OWNER, title: "Architecture" },
    "note-foreign": { userId: STRANGER, title: "Somebody else's note" },
    "project-1": { userId: OWNER, title: "Launch" },
    "calendar-1": { userId: OWNER, title: "Team" },
  };
  const users = [
    { id: OWNER, email: "owner@example.com" },
    { id: COLLAB, email: "collab@example.com" },
    { id: STRANGER, email: "stranger@example.com" },
  ];
  let seq = 0;

  const findFirst = jest.fn(async ({ where }: any = {}) => {
    const hit = rows.find((row) => matches(row, where));
    return hit ? clone(hit) : null;
  });

  const findMany = jest.fn(
    async ({ where, orderBy: order, skip, take }: any = {}) => {
      const hits = orderBy(
        rows.filter((row) => matches(row, where)),
        order,
      ).map(clone);
      if (skip === undefined && take === undefined) return hits;
      return hits.slice(skip ?? 0, (skip ?? 0) + (take ?? hits.length));
    },
  );

  const store: ShareStore = {
    rows,
    note: {
      findFirst: jest.fn(async ({ where }: any) => {
        const found = where?.id ? resources[where.id] : undefined;
        if (!found) return null;
        return { id: where.id, userId: found.userId, title: found.title };
      }),
    },
    project: {
      findFirst: jest.fn(async ({ where }: any) => {
        const found = where?.id ? resources[where.id] : undefined;
        if (!found) return null;
        return { id: where.id, userId: found.userId, name: found.title };
      }),
    },
    calendar: {
      findFirst: jest.fn(async ({ where }: any) => {
        const found = where?.id ? resources[where.id] : undefined;
        if (!found) return null;
        return { id: where.id, userId: found.userId, name: found.title };
      }),
    },
    user: {
      findFirst: jest.fn(async ({ where }: any) => {
        const hit = users.find(
          (candidate) =>
            candidate.email === where?.email &&
            (where?.deletedAt ?? null) === null,
        );
        return hit ? { ...hit } : null;
      }),
    },
    resourceShare: {
      create: jest.fn(async ({ data }: any) => {
        // The database's job, not the service's: one row per
        // (resourceType, resourceId, sharedWithEmail), active or revoked.
        const clash = rows.find(
          (row) =>
            row.resourceType === data.resourceType &&
            row.resourceId === data.resourceId &&
            row.sharedWithEmail === data.sharedWithEmail,
        );
        if (clash) throw uniqueViolation();

        const now = new Date(Date.now() + ++seq);
        const row: StoredShare = {
          id: `share-${seq}`,
          resourceType: data.resourceType,
          resourceId: data.resourceId,
          ownerId: data.ownerId,
          sharedWithUserId: data.sharedWithUserId,
          sharedWithEmail: data.sharedWithEmail,
          role: data.role,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        rows.push(row);
        return clone(row);
      }),
      findFirst,
      findMany,
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((candidate) => matches(candidate, where));
        if (!row) {
          throw new Prisma.PrismaClientKnownRequestError("Record not found", {
            code: "P2025",
            clientVersion: "5.22.0",
          });
        }
        Object.assign(row, data, { updatedAt: new Date(Date.now() + ++seq) });
        return clone(row);
      }),
      count: jest.fn(
        async ({ where }: any = {}) =>
          rows.filter((row) => matches(row, where)).length,
      ),
    },
    // Sibling services fake the interactive transaction the same way: run the
    // callback against the same delegates.
    $transaction: jest.fn(async (cb: any) => cb(store)),
  };

  return store;
}

async function buildService(
  store: ShareStore,
  audit: any,
): Promise<CollaborationService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      CollaborationService,
      { provide: PrismaService, useValue: store },
      { provide: AuditLogService, useValue: audit },
    ],
  }).compile();

  return module.get<CollaborationService>(CollaborationService);
}

describe("CollaborationService", () => {
  let store: ShareStore;
  let auditLogServiceMock: { recordAuditLog: jest.Mock };
  let service: CollaborationService;

  const shareDto = {
    resourceType: "NOTE",
    resourceId: "note-1",
    email: "collab@example.com",
    role: "EDITOR",
  };

  const createShare = async (overrides: Partial<typeof shareDto> = {}) =>
    service.shareResource(OWNER, {
      ...shareDto,
      ...overrides,
    } as CreateShareDto);

  beforeEach(async () => {
    store = createShareStore();
    auditLogServiceMock = {
      recordAuditLog: jest.fn().mockResolvedValue({}),
    };
    service = await buildService(store, auditLogServiceMock);
  });

  describe("persistence", () => {
    it("keeps no shares in process memory", () => {
      expect((service as any).shares).toBeUndefined();
    });

    it("hands a brand new service instance the same share, roles and all", async () => {
      const share = await createShare();

      // What a restart is, from the service's point of view: nothing carried
      // over but the store.
      const rebuilt = await buildService(store, auditLogServiceMock);

      const listed = await rebuilt.getSharesForResource(
        OWNER,
        "NOTE",
        "note-1",
      );
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(share);

      const access = await rebuilt.checkAccess(
        COLLAB,
        undefined,
        "NOTE",
        "note-1",
        "EDITOR",
      );
      expect(access).toEqual({
        hasAccess: true,
        role: "EDITOR",
        isOwner: false,
      });

      // The duplicate rule travels with the row, not with the instance that
      // wrote it.
      await expect(
        rebuilt.shareResource(OWNER, shareDto as any),
      ).rejects.toThrow(ConflictException);
    });

    it("writes through to the store rather than only returning an object", async () => {
      await createShare();

      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]).toMatchObject({
        resourceType: "NOTE",
        resourceId: "note-1",
        ownerId: OWNER,
        sharedWithUserId: COLLAB,
        sharedWithEmail: "collab@example.com",
        role: "EDITOR",
        deletedAt: null,
      });
    });
  });

  describe("response shape", () => {
    it("exposes exactly the documented keys, with ISO timestamps", async () => {
      const share = await createShare();

      expect(Object.keys(share).sort()).toEqual(
        [
          "id",
          "resourceType",
          "resourceId",
          "ownerId",
          "sharedWithUserId",
          "sharedWithEmail",
          "role",
          "createdAt",
          "updatedAt",
        ].sort(),
      );
      expect(typeof share.id).toBe("string");
      expect(new Date(share.createdAt).toISOString()).toBe(share.createdAt);
      expect(new Date(share.updatedAt).toISOString()).toBe(share.updatedAt);
    });
  });

  describe("shareResource check order", () => {
    it("resolves the resource first: a missing resource is a 404 before any recipient lookup", async () => {
      await expect(
        service.shareResource(OWNER, {
          ...shareDto,
          resourceId: "no-such-note",
        } as any),
      ).rejects.toThrow(NotFoundException);
      expect(store.user.findFirst).not.toHaveBeenCalled();
      expect(store.resourceShare.create).not.toHaveBeenCalled();
    });

    it("gates the caller before resolving the recipient: a non-admin gets 403", async () => {
      await expect(
        service.shareResource(STRANGER, {
          ...shareDto,
          email: "stranger@example.com",
        } as any),
      ).rejects.toThrow(ForbiddenException);
      // Order matters: the ADMIN gate runs ahead of the recipient lookup, so a
      // caller with no standing cannot probe who is registered.
      expect(store.user.findFirst).not.toHaveBeenCalled();
    });

    it("rejects sharing with the resource owner after the gate passes", async () => {
      await expect(createShare({ email: "owner@example.com" })).rejects.toThrow(
        ConflictException,
      );
      expect(store.resourceShare.create).not.toHaveBeenCalled();
    });

    it("refuses an unregistered recipient instead of storing a grant that matches nothing", async () => {
      await expect(
        createShare({ email: "nobody@example.com" }),
      ).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringContaining("No registered account found"),
        }),
      );
      expect(store.rows).toHaveLength(0);
    });

    it("refuses a deleted recipient's address", async () => {
      store.user.findFirst.mockResolvedValueOnce(null);

      await expect(createShare()).rejects.toThrow(ConflictException);
      expect(store.rows).toHaveLength(0);
    });

    it("lets an ADMIN collaborator share on, and only they can", async () => {
      await createShare({ role: "ADMIN" });

      await service.shareResource(COLLAB, {
        ...shareDto,
        email: "stranger@example.com",
      } as any);
      expect(store.rows).toHaveLength(2);

      await expect(
        service.shareResource(COLLAB, {
          resourceType: "NOTE",
          resourceId: "note-foreign",
          email: "stranger@example.com",
          role: "VIEWER",
        } as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it("records a dedicated audit action, not the borrowed device one", async () => {
      const share = await createShare();

      expect(auditLogServiceMock.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: OWNER,
          action: AuditAction.RESOURCE_SHARED,
          resourceId: "note-1",
        }),
      );
      await service.revokeShare(OWNER, share.id);
      expect(auditLogServiceMock.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.RESOURCE_SHARE_REVOKED }),
      );
      expect(auditLogServiceMock.recordAuditLog).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.DEVICE_ADDED }),
      );
    });
  });

  describe("duplicate grant", () => {
    it("409s on a second active grant to the same address", async () => {
      await createShare();

      await expect(createShare({ role: "VIEWER" })).rejects.toThrow(
        ConflictException,
      );
      expect(store.resourceShare.create).toHaveBeenCalledTimes(1);
      expect(store.rows).toHaveLength(1);
    });

    it("409s with the same wording when the race slips past the read and the unique key fires", async () => {
      await createShare();

      // Two concurrent requests: both read "no clash", the loser's write hits
      // the index. The read is only an optimisation; the constraint decides.
      (store.resourceShare.findFirst as jest.Mock).mockImplementationOnce(
        async () => null,
      );

      let error: unknown;
      try {
        await createShare({ role: "VIEWER" });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(ConflictException);
      expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as ConflictException).message).toBe(
        "Resource is already shared with 'collab@example.com'. Update their role instead.",
      );
      expect(store.resourceShare.create).toHaveBeenCalledTimes(2);
    });

    it("treats a revoked grant to the same address as a re-share, not a collision", async () => {
      const first = await createShare();
      await service.revokeShare(OWNER, first.id);

      const revived = await createShare({ role: "ADMIN" });

      expect(revived.id).toBe(first.id);
      expect(revived.role).toBe("ADMIN");
      expect(revived.sharedWithUserId).toBe(COLLAB);
      expect(store.resourceShare.create).toHaveBeenCalledTimes(1);
      expect(
        await service.getSharesForResource(OWNER, "NOTE", "note-1"),
      ).toHaveLength(1);
    });
  });

  describe("create / read / update / delete round trip", () => {
    it("lists, re-roles and revokes one grant", async () => {
      const share = await createShare({ role: "VIEWER" });

      const listed = await service.getSharesForResource(
        OWNER,
        "NOTE",
        "note-1",
      );
      expect(listed).toEqual([share]);

      const updated = await service.updateShareRole(OWNER, share.id, {
        role: "ADMIN",
      });
      expect(updated.role).toBe("ADMIN");
      expect(updated.createdAt).toBe(share.createdAt);
      expect(updated.id).toBe(share.id);
      expect(store.rows[0].role).toBe("ADMIN");

      await service.revokeShare(OWNER, share.id);

      expect(
        await service.getSharesForResource(OWNER, "NOTE", "note-1"),
      ).toEqual([]);
      // The grant stops answering queries; the tombstone stays for the trail.
      expect(store.rows[0].deletedAt).toBeInstanceOf(Date);

      await expect(
        service.updateShareRole(OWNER, share.id, { role: "VIEWER" }),
      ).rejects.toThrow(NotFoundException);
      await expect(service.revokeShare(OWNER, share.id)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("404s an unknown share id", async () => {
      await expect(
        service.updateShareRole(OWNER, "share-nope", { role: "VIEWER" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("supports PROJECT and CALENDAR resources", async () => {
      const projectShare = await service.shareResource(OWNER, {
        resourceType: "PROJECT",
        resourceId: "project-1",
        email: "collab@example.com",
        role: "EDITOR",
      } as any);
      await service.shareResource(OWNER, {
        resourceType: "CALENDAR",
        resourceId: "calendar-1",
        email: "collab@example.com",
        role: "VIEWER",
      } as any);

      const mine = await service.getResourcesSharedWithUser(
        COLLAB,
        "collab@example.com",
        { resourceType: "PROJECT" } as any,
      );
      expect(mine.total).toBe(1);
      expect(mine.data[0].id).toBe(projectShare.id);
    });
  });

  describe("role weights", () => {
    it("ranks VIEWER < EDITOR < ADMIN", async () => {
      await createShare({ role: "VIEWER" });

      expect(
        (
          await service.checkAccess(
            COLLAB,
            undefined,
            "NOTE",
            "note-1",
            "VIEWER",
          )
        ).hasAccess,
      ).toBe(true);
      expect(
        (
          await service.checkAccess(
            COLLAB,
            undefined,
            "NOTE",
            "note-1",
            "EDITOR",
          )
        ).hasAccess,
      ).toBe(false);
      expect(
        (
          await service.checkAccess(
            COLLAB,
            undefined,
            "NOTE",
            "note-1",
            "ADMIN",
          )
        ).hasAccess,
      ).toBe(false);

      await service.updateShareRole(OWNER, store.rows[0].id, {
        role: "EDITOR",
      });
      expect(
        (
          await service.checkAccess(
            COLLAB,
            undefined,
            "NOTE",
            "note-1",
            "EDITOR",
          )
        ).hasAccess,
      ).toBe(true);
      expect(
        (
          await service.checkAccess(
            COLLAB,
            undefined,
            "NOTE",
            "note-1",
            "ADMIN",
          )
        ).hasAccess,
      ).toBe(false);

      await service.updateShareRole(OWNER, store.rows[0].id, { role: "ADMIN" });
      expect(
        (
          await service.checkAccess(
            COLLAB,
            undefined,
            "NOTE",
            "note-1",
            "ADMIN",
          )
        ).hasAccess,
      ).toBe(true);
    });

    it("grants the owner implicit ADMIN without writing a row", async () => {
      const access = await service.checkAccess(
        OWNER,
        "owner@example.com",
        "NOTE",
        "note-1",
        "ADMIN",
      );

      expect(access).toEqual({ hasAccess: true, role: "ADMIN", isOwner: true });
      expect(store.rows).toHaveLength(0);
    });

    it("matches a collaborator by id even when no email is passed, the way NotesService calls it", async () => {
      await createShare();

      const access = await service.checkAccess(
        COLLAB,
        undefined,
        "NOTE",
        "note-1",
        "EDITOR",
      );

      expect(access.hasAccess).toBe(true);
    });

    it("refuses a stranger who holds no grant", async () => {
      await createShare();

      const access = await service.checkAccess(
        STRANGER,
        "stranger@example.com",
        "NOTE",
        "note-1",
        "VIEWER",
      );

      expect(access).toEqual({ hasAccess: false, isOwner: false });
    });

    it("stops honouring a revoked grant", async () => {
      const share = await createShare({ role: "ADMIN" });
      await service.revokeShare(OWNER, share.id);

      const access = await service.checkAccess(
        COLLAB,
        "collab@example.com",
        "NOTE",
        "note-1",
        "VIEWER",
      );

      expect(access.hasAccess).toBe(false);
    });
  });

  describe("updateShareRole authorization", () => {
    it("403s a collaborator below ADMIN who tries to re-role themselves", async () => {
      const share = await createShare({ role: "EDITOR" });

      await expect(
        service.updateShareRole(COLLAB, share.id, { role: "ADMIN" }),
      ).rejects.toThrow(ForbiddenException);
      expect(store.rows[0].role).toBe("EDITOR");
    });
  });

  describe("revokeShare", () => {
    it("lets a collaborator revoke their own grant without ADMIN weight", async () => {
      const share = await createShare({ role: "VIEWER" });

      await service.revokeShare(COLLAB, share.id);

      expect(store.rows[0].deletedAt).toBeInstanceOf(Date);
      expect(auditLogServiceMock.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: COLLAB,
          action: AuditAction.RESOURCE_SHARE_REVOKED,
          metadata: expect.objectContaining({
            revokedShareId: share.id,
            selfRevocation: true,
          }),
        }),
      );
    });

    it("403s a stranger who is neither owner nor the grantee", async () => {
      const share = await createShare();

      await expect(service.revokeShare(STRANGER, share.id)).rejects.toThrow(
        ForbiddenException,
      );
      expect(store.rows[0].deletedAt).toBeNull();
    });

    it("lets the owner revoke somebody else", async () => {
      const share = await createShare();

      await service.revokeShare(OWNER, share.id);

      expect(store.rows[0].deletedAt).toBeInstanceOf(Date);
    });
  });

  describe("getSharesForResource", () => {
    it("lists only that resource's active grants to any collaborator", async () => {
      const share = await createShare({ role: "VIEWER" });
      await service.shareResource(OWNER, {
        resourceType: "PROJECT",
        resourceId: "project-1",
        email: "collab@example.com",
        role: "VIEWER",
      } as any);

      const listed = await service.getSharesForResource(
        COLLAB,
        "NOTE",
        "note-1",
      );
      expect(listed).toEqual([share]);
    });

    it("403s a caller with no grant at all", async () => {
      await createShare();

      await expect(
        service.getSharesForResource(STRANGER, "NOTE", "note-1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("404s a resource that does not exist before checking access", async () => {
      await expect(
        service.getSharesForResource(OWNER, "NOTE", "gone"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getResourcesSharedWithUser", () => {
    it("finds grants by user id and by email, and pages them", async () => {
      await createShare({ role: "VIEWER" });
      await service.shareResource(OWNER, {
        resourceType: "PROJECT",
        resourceId: "project-1",
        email: "collab@example.com",
        role: "EDITOR",
      } as any);

      const byId = await service.getResourcesSharedWithUser(COLLAB, undefined, {
        page: 1,
        limit: 1,
      } as any);
      expect(byId.total).toBe(2);
      expect(byId.data).toHaveLength(1);
      expect(byId.data[0].resourceId).toBe("note-1");

      const byEmail = await service.getResourcesSharedWithUser(
        "some-other-id",
        "COLLAB@example.com",
        { resourceType: "PROJECT" } as any,
      );
      expect(byEmail.total).toBe(1);
      expect(byEmail.data[0].role).toBe("EDITOR");
      expect(byEmail).toMatchObject({ page: 1, limit: 20 });
    });

    it("hides revoked grants", async () => {
      const share = await createShare();
      await service.revokeShare(OWNER, share.id);

      const mine = await service.getResourcesSharedWithUser(
        COLLAB,
        "collab@example.com",
      );

      expect(mine).toEqual({ data: [], total: 0, page: 1, limit: 20 });
    });
  });
});
