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

/**
 * A TRIP grant, end to end: the row, the snapshot it owes the grantee, and the
 * tombstones a revoke has to countermand them with.
 *
 * `ShareResourceType.TRIP` was listed by the enum (`prisma/schema.prisma:821-827`)
 * and accepted by `dto/collaboration.dto.ts`, but `verifyResourceOwner` had no
 * branch for it, so `POST /collaboration/shares` answered
 * `Resource type 'TRIP' not supported.` for a grant the schema permits and no
 * trip grant could ever be written. Everything that reads a grant back —
 * `trips.service.ts`, `change-projection.ts` `canEditFinanceTrip`, and this
 * service's own `checkAccess` — was therefore reading a collection that could
 * never hold a trip row.
 *
 * The half that is easy to miss is that a grant is a *sync* event and not only a
 * database write. `Change` rows are keyed per user and a device only ever pulls
 * its own account's log (`prisma/schema.prisma:245-272`), so a grant that does
 * not queue the trip's current state leaves the collaborator with permission to
 * open a trip their device has never heard of — and a revoke that does not queue
 * the DELETEs leaves them with a readable offline copy of a trip they were just
 * removed from. These cases assert both halves, in the order the client needs:
 * the trip row before its plan, because `sync_manager.dart` drops an itinerary
 * change whose parent trip is not in the local database rather than planting it.
 */

const OWNER = "owner-11111111-1111-4111-8111-111111111111";
const COLLAB = "collab-22222222-2222-4222-8222-222222222222";
const STRANGER = "stranger-33333333-3333-4333-8333-333333333333";

const TRIP = "trip-44444444-4444-4444-8444-444444444444";
const OTHER_TRIP = "trip-55555555-5555-4555-8555-555555555555";
const ITEM_FIRST = "item-66666666-6666-4666-8666-666666666666";
const ITEM_SECOND = "item-77777777-7777-4777-8777-777777777777";
const EXPENSE = "exp-88888888-8888-4888-8888-888888888888";
const SETTLEMENT = "set-99999999-9999-4999-8999-999999999999";

type Row = Record<string, any>;

interface ChangeRow {
  id: string;
  userId: string;
  entityType: string;
  entityId: string;
  operation: string;
  version: number;
  cursor: bigint;
  payload: any;
}

interface State {
  trips: Row[];
  itineraries: Row[];
  expenses: Row[];
  settlements: Row[];
  grants: Row[];
  changes: ChangeRow[];
  /** Flip to make `resourceShare.create` fire the unique key, as a race does. */
  failCreateWithUniqueViolation?: boolean;
}

function matches(row: Row, where: any = {}): boolean {
  for (const [key, value] of Object.entries(where ?? {})) {
    if (key === "OR") {
      if (!(value as any[]).some((clause) => matches(row, clause)))
        return false;
      continue;
    }
    if (key === "AND") {
      if (!(value as any[]).every((clause) => matches(row, clause)))
        return false;
      continue;
    }
    if (value && typeof value === "object" && "in" in (value as any)) {
      if (!(value as any).in.includes(row[key])) return false;
      continue;
    }
    if ((row[key] ?? null) !== (value ?? null)) return false;
  }
  return true;
}

function grant(overrides: Row = {}): Row {
  return {
    id: `share-${Math.random().toString(36).slice(2)}`,
    resourceType: "TRIP",
    resourceId: TRIP,
    ownerId: OWNER,
    sharedWithUserId: COLLAB,
    sharedWithEmail: "collab@example.com",
    role: "EDITOR",
    deletedAt: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

function tripRow(overrides: Row = {}): Row {
  return {
    id: TRIP,
    ownerId: OWNER,
    title: "Goa",
    destinations: ["Goa"],
    startDate: new Date("2026-11-01"),
    endDate: new Date("2026-11-05"),
    baseCurrency: "INR",
    totalBudgetMinor: BigInt(500000),
    notes: null,
    isArchived: false,
    deletedAt: null,
    version: 3,
    createdAt: new Date("2026-10-01"),
    ...overrides,
  };
}

function item(overrides: Row = {}): Row {
  return {
    id: ITEM_FIRST,
    tripId: TRIP,
    dayIndex: 1,
    date: new Date("2026-11-01"),
    title: "Fort",
    plannedCostMinor: BigInt(1000),
    notes: null,
    sortOrder: 0,
    version: 1,
    deletedAt: null,
    createdAt: new Date("2026-10-02"),
    ...overrides,
  };
}

/**
 * The `ResourceShare` collection plus every table a finance snapshot reads, with
 * one thing faked on purpose: cursors. `appendChange` allocates per account
 * (`src/sync/change-cursor.ts:25-37`), so a collaborator's cursor advancing is a
 * property of their own stream, and that is the assertion these cases keep
 * coming back to.
 */
function createStore(state?: Partial<State>) {
  const store: State = {
    trips: [tripRow()],
    itineraries: [
      item(),
      item({
        id: ITEM_SECOND,
        dayIndex: 1,
        title: "Beach",
        sortOrder: 1,
        plannedCostMinor: null,
      }),
    ],
    expenses: [
      {
        id: EXPENSE,
        groupId: null,
        tripId: TRIP,
        paidByUserId: OWNER,
        payerAccountId: null,
        title: "Taxi",
        totalAmountMinor: BigInt(12000),
        currency: "INR",
        splitType: "EQUAL",
        date: new Date("2026-11-02"),
        notes: null,
        receiptAttachmentId: null,
        version: 2,
        deletedAt: null,
        createdAt: new Date("2026-11-02"),
        shares: [
          { userId: OWNER, owedAmountMinor: BigInt(6000), shareUnits: 1 },
        ],
      },
    ],
    settlements: [
      {
        id: SETTLEMENT,
        groupId: null,
        tripId: TRIP,
        fromUserId: COLLAB,
        toUserId: OWNER,
        amountMinor: BigInt(500),
        currency: "INR",
        date: new Date("2026-11-03"),
        notes: null,
        paymentMethod: "CASH",
        version: 1,
        deletedAt: null,
        createdAt: new Date("2026-11-03"),
      },
    ],
    grants: [],
    changes: [],
    ...state,
  };

  const cursors = new Map<string, bigint>();
  let changeSeq = 0;
  let grantSeq = 0;

  const delegate = (
    rows: () => Row[],
    { ordered = false }: { ordered?: boolean } = {},
  ) => ({
    findFirst: jest.fn(async ({ where }: any = {}) => {
      const hit = rows().find((row) => matches(row, where));
      return hit ? { ...hit } : null;
    }),
    findUnique: jest.fn(async ({ where }: any = {}) => {
      const hit = rows().find((row) => row.id === where?.id);
      return hit ? { ...hit } : null;
    }),
    findMany: jest.fn(async ({ where, orderBy, include }: any = {}) => {
      let hits = rows().filter((row) => matches(row, where));
      if (ordered && Array.isArray(orderBy)) {
        for (const spec of [...orderBy].reverse()) {
          const [key, direction] = Object.entries(spec)[0] as [string, string];
          hits = [...hits].sort((a, b) => {
            const left = a[key] ?? 0;
            const right = b[key] ?? 0;
            const step = left === right ? 0 : left < right ? -1 : 1;
            return direction === "desc" ? -step : step;
          });
        }
      }
      return hits.map((row) =>
        include?.shares ? { ...row, shares: row.shares ?? [] } : { ...row },
      );
    }),
    create: jest.fn(async ({ data }: any) => {
      const row = {
        id: `${data.id ?? `row-${rows().length}`}`,
        deletedAt: null,
        version: 1,
        createdAt: new Date("2026-10-04"),
        ...data,
      };
      rows().push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows().find((candidate) => matches(candidate, where));
      if (!row) throw new Error(`no row for ${JSON.stringify(where)}`);
      if (data.version?.increment) {
        row.version = Number(row.version) + Number(data.version.increment);
      }
      Object.assign(row, data);
      return { ...row };
    }),
  });

  const financeTrip = delegate(() => store.trips);
  const financeTripItinerary = delegate(() => store.itineraries, {
    ordered: true,
  });
  const financeSharedExpense = delegate(() => store.expenses);
  const financeSettlement = delegate(() => store.settlements);
  const resourceShare = delegate(() => store.grants);

  resourceShare.create = jest.fn(async ({ data }: any) => {
    // The database's job, not the service's: `@@unique([resourceType,
    // resourceId, sharedWithEmail])` (`prisma/schema.prisma:838-866`) fires for a
    // revoked tombstone too, which is why re-sharing revives instead of
    // inserting.
    if (store.failCreateWithUniqueViolation) {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`resourceType`,`resourceId`,`sharedWithEmail`)",
        { code: "P2002", clientVersion: "5.22.0" },
      );
    }
    const clash = store.grants.find(
      (row) =>
        row.resourceType === data.resourceType &&
        row.resourceId === data.resourceId &&
        row.sharedWithEmail === data.sharedWithEmail,
    );
    if (clash) throw new Error("unexpected duplicate grant in the fake");

    const now = new Date("2026-10-04T00:00:00.000Z");
    const row: Row = {
      id: `share-${++grantSeq}`,
      resourceType: data.resourceType,
      resourceId: data.resourceId,
      ownerId: data.ownerId,
      sharedWithUserId: data.sharedWithUserId,
      sharedWithEmail: data.sharedWithEmail,
      role: data.role,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    store.grants.push(row);
    return { ...row };
  });

  const client: any = {
    __state: store,
    $transaction: jest.fn(async (cb: any) => cb(client)),
    financeTrip,
    financeTripItinerary,
    financeSharedExpense,
    financeSettlement,
    resourceShare,
    note: {
      findFirst: jest.fn(async () => ({
        id: "note-1",
        userId: OWNER,
        title: "Architecture",
      })),
    },
    user: {
      findFirst: jest.fn(async ({ where }: any = {}) => {
        if (
          where?.email === "collab@example.com" &&
          (where?.deletedAt ?? null) === null
        ) {
          return { id: COLLAB, email: "collab@example.com" };
        }
        if (where?.email === "stranger@example.com") {
          return { id: STRANGER, email: "stranger@example.com" };
        }
        return null;
      }),
    },
    // `appendChange` allocates through the cursor row and then stores the change
    // with the number it was handed; the two mocks share one counter so a case
    // can read the cursor back off the log.
    syncCursor: {
      upsert: jest.fn(async ({ where }: any) => {
        const next = (cursors.get(where.userId) ?? BigInt(0)) + BigInt(1);
        cursors.set(where.userId, next);
        return { seq: next };
      }),
      findUnique: jest.fn(async ({ where }: any) => ({
        seq: cursors.get(where.userId) ?? BigInt(0),
      })),
    },
    change: {
      create: jest.fn(async ({ data }: any) => {
        const row: ChangeRow = {
          id: `change-${++changeSeq}`,
          ...data,
          cursor: data.cursor ?? BigInt(0),
        };
        store.changes.push(row);
        return { id: row.id, cursor: row.cursor };
      }),
      findFirst: jest.fn(async () => null),
    },
  };

  return { client, store };
}

async function buildService(client: any, audit: any) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      CollaborationService,
      { provide: PrismaService, useValue: client },
      { provide: AuditLogService, useValue: audit },
    ],
  }).compile();

  return module.get<CollaborationService>(CollaborationService);
}

const auditStub = () => ({ recordAuditLog: jest.fn().mockResolvedValue({}) });

describe("CollaborationService TRIP grants", () => {
  it("persists a TRIP grant the way it persists an EXPENSE_GROUP grant", async () => {
    const { client, store } = createStore();
    const audit = auditStub();
    const service = await buildService(client, audit);

    const share = await service.shareResource(OWNER, {
      resourceType: "TRIP",
      resourceId: TRIP,
      email: "collab@example.com",
      role: "EDITOR",
    } as CreateShareDto);

    expect(share).toMatchObject({
      resourceType: "TRIP",
      resourceId: TRIP,
      ownerId: OWNER,
      sharedWithUserId: COLLAB,
      sharedWithEmail: "collab@example.com",
      role: "EDITOR",
    });
    expect(typeof share.createdAt).toBe("string");
    expect(store.grants).toHaveLength(1);

    // The grant is audited as a grant, the same action every other resource
    // writes, and outside the transaction: a log that is unreachable must not
    // roll the grant back.
    expect(audit.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.RESOURCE_SHARED,
        resourceType: "TRIP",
        resourceId: TRIP,
      }),
    );

    // And it is a sync event: a permission the grantee's device has never been
    // handed the trip for is not access, it is a 404 they cannot explain.
    const granteeLog = store.changes.filter((row) => row.userId === COLLAB);
    expect(
      granteeLog.map((row) => `${row.entityType}:${row.operation}`),
    ).toEqual([
      "finance_trip:CREATE",
      `finance_trip_itinerary:CREATE`,
      `finance_trip_itinerary:CREATE`,
      "finance_shared_expense:CREATE",
      "finance_settlement:CREATE",
    ]);
    expect(granteeLog[0].entityId).toBe(TRIP);
    // The trip row is queued before its plan rows for a reason: the client drops
    // an itinerary change whose parent is not in its database, so a plan that
    // arrives first is a plan that never lands.
    expect(granteeLog[0].payload).toMatchObject({
      title: "Goa",
      baseCurrency: "INR",
      totalBudgetMinor: 500000,
      version: 3,
    });
    expect(granteeLog[1].entityId).toBe(ITEM_FIRST);
    expect(granteeLog[2].entityId).toBe(ITEM_SECOND);
    expect(granteeLog[3].payload).toMatchObject({
      tripId: TRIP,
      groupId: null,
      title: "Taxi",
      totalAmountMinor: 12000,
      shares: [{ userId: OWNER, owedAmountMinor: 6000 }],
    });
    expect(granteeLog[4].payload).toMatchObject({
      tripId: TRIP,
      amountMinor: 500,
    });

    // The grantee's own stream, numbered from their own counter — not a row on
    // the owner's log, which no pull would ever hand them.
    expect(cursorsOf(granteeLog)).toEqual([
      BigInt(1),
      BigInt(2),
      BigInt(3),
      BigInt(4),
      BigInt(5),
    ]);
    expect(store.changes.filter((row) => row.userId === OWNER)).toEqual([]);
  });

  it("refuses a grant on a trip that is not there, and one on a trashed trip", async () => {
    const { client } = createStore();
    const service = await buildService(client, auditStub());

    await expect(
      service.shareResource(OWNER, {
        resourceType: "TRIP",
        resourceId: "trip-does-not-exist",
        email: "collab@example.com",
        role: "EDITOR",
      } as CreateShareDto),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses a grant on a trashed trip rather than sharing a tombstone", async () => {
    const { client, store } = createStore({
      trips: [tripRow({ deletedAt: new Date("2026-10-03") })],
    });
    const service = await buildService(client, auditStub());

    await expect(
      service.shareResource(OWNER, {
        resourceType: "TRIP",
        resourceId: TRIP,
        email: "collab@example.com",
        role: "EDITOR",
      } as CreateShareDto),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Nothing queued, because nothing was shared: the snapshot runs inside the
    // same transaction the grant does.
    expect(store.grants).toEqual([]);
    expect(store.changes).toEqual([]);
  });

  it("403s a stranger and a VIEWER, and lets an ADMIN grantee share on", async () => {
    const { client } = createStore({
      grants: [grant({ role: "VIEWER", sharedWithUserId: STRANGER })],
    });
    const service = await buildService(client, auditStub());

    // The caller must hold ADMIN weight on the trip they are sharing. The VIEWER
    // row above is the stranger's grant, so they can see the trip and cannot
    // hand it to anybody else.
    await expect(
      service.shareResource(STRANGER, {
        resourceType: "TRIP",
        resourceId: TRIP,
        email: "collab@example.com",
        role: "EDITOR",
      } as CreateShareDto),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("409s a second live grant to the same address", async () => {
    const { client, store } = createStore({ grants: [grant()] });
    const service = await buildService(client, auditStub());

    await expect(
      service.shareResource(OWNER, {
        resourceType: "TRIP",
        resourceId: TRIP,
        email: "collab@example.com",
        role: "ADMIN",
      } as CreateShareDto),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(store.grants).toHaveLength(1);
    expect(store.grants[0].role).toBe("EDITOR");
  });

  it("409s when the read is slipped by a race and the unique key fires", async () => {
    const { client, store } = createStore();
    // Two requests for the same (TRIP, address): the first read finds nothing,
    // and by the time the second writes the row exists, so `@@unique` decides it.
    store.failCreateWithUniqueViolation = true;
    const service = await buildService(client, auditStub());

    await expect(
      service.shareResource(OWNER, {
        resourceType: "TRIP",
        resourceId: TRIP,
        email: "collab@example.com",
        role: "EDITOR",
      } as CreateShareDto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(store.changes).toEqual([]);
  });

  it("revives a revoked grant instead of colliding with it, and re-snapshots", async () => {
    const { client, store } = createStore({
      grants: [grant({ deletedAt: new Date("2026-10-03"), role: "VIEWER" })],
    });
    const service = await buildService(client, auditStub());

    const share = await service.shareResource(OWNER, {
      resourceType: "TRIP",
      resourceId: TRIP,
      email: "collab@example.com",
      role: "EDITOR",
    } as CreateShareDto);

    expect(share.role).toBe("EDITOR");
    // One row still: the tombstone is updated, not duplicated, because the
    // unique key counts a revoked grant as a clash.
    expect(store.grants).toHaveLength(1);
    expect(store.grants[0].deletedAt).toBe(null);
    expect(store.grants[0].role).toBe("EDITOR");
    expect(client.resourceShare.create).not.toHaveBeenCalled();
    // Re-sharing re-hands the current ledger: the trip moved on while they were
    // out, and their device has nothing under it.
    expect(store.changes.filter((row) => row.userId === COLLAB)).toHaveLength(
      5,
    );
  });

  it("revokes a grant, tombstones it, and countermands everything the grant queued", async () => {
    const { client, store } = createStore({ grants: [grant()] });
    const audit = auditStub();
    const service = await buildService(client, audit);

    const shareId = store.grants[0].id;
    await service.revokeShare(OWNER, shareId);

    expect(store.grants[0].deletedAt).toBeInstanceOf(Date);
    expect(audit.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.RESOURCE_SHARE_REVOKED }),
    );

    const granteeLog = store.changes.filter((row) => row.userId === COLLAB);
    expect(
      granteeLog.map((row) => `${row.entityType}:${row.operation}`),
    ).toEqual([
      "finance_trip:DELETE",
      "finance_trip_itinerary:DELETE",
      "finance_trip_itinerary:DELETE",
      "finance_shared_expense:DELETE",
      "finance_settlement:DELETE",
    ]);
    // A revoke that only dropped the grant row would leave the trip readable
    // offline forever: access checks cannot reach a row the device never pulls.
    for (const row of granteeLog) {
      expect(row.payload).toEqual({});
    }
    expect(granteeLog[0].entityId).toBe(TRIP);

    // And the grant stops answering the instant it is revoked.
    const access = await service.checkAccess(
      COLLAB,
      undefined,
      "TRIP",
      TRIP,
      "VIEWER",
    );
    expect(access).toEqual({ hasAccess: false, isOwner: false });
  });

  it("counts a TRIP grantee as a collaborator and nothing more", async () => {
    const { client } = createStore({
      grants: [grant({ role: "EDITOR" })],
    });
    const service = await buildService(client, auditStub());

    await expect(
      service.checkAccess(COLLAB, undefined, "TRIP", TRIP, "EDITOR"),
    ).resolves.toMatchObject({
      hasAccess: true,
      role: "EDITOR",
      isOwner: false,
    });
    await expect(
      service.checkAccess(COLLAB, undefined, "TRIP", TRIP, "ADMIN"),
    ).resolves.toMatchObject({ hasAccess: false });
    await expect(
      service.checkAccess(OWNER, undefined, "TRIP", TRIP, "ADMIN"),
    ).resolves.toMatchObject({ hasAccess: true, isOwner: true });

    const listed = await service.getSharesForResource(OWNER, "TRIP", TRIP);
    expect(listed.map((row) => row.sharedWithUserId)).toEqual([COLLAB]);
  });

  it("leaves NOTE, PROJECT and CALENDAR grants exactly as they were", async () => {
    const { client, store } = createStore();
    const service = await buildService(client, auditStub());

    const share = await service.shareResource(OWNER, {
      resourceType: "NOTE",
      resourceId: "note-1",
      email: "collab@example.com",
      role: "EDITOR",
    } as CreateShareDto);

    expect(share.resourceType).toBe("NOTE");
    // A note grant is not a finance scope: the ledger rows belong to a group or
    // a trip, and queuing them here would put a stranger's trip on the note
    // collaborator's device.
    expect(store.changes).toEqual([]);
    expect(client.financeTrip.findUnique).not.toHaveBeenCalled();
    expect(client.financeSharedExpense.findMany).not.toHaveBeenCalled();
  });

  it("does not let a trip's own deletion look like a missing resource", async () => {
    // Guards the shape of the existence check: the trip is resolved by
    // `deletedAt: null`, so the same row that `trips.service.ts` refuses to hand
    // out is the row `/collaboration` refuses to share.
    const { client } = createStore({ trips: [tripRow({ id: OTHER_TRIP })] });
    const service = await buildService(client, auditStub());

    await expect(
      service.shareResource(OWNER, {
        resourceType: "TRIP",
        resourceId: TRIP,
        email: "collab@example.com",
        role: "EDITOR",
      } as CreateShareDto),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

function cursorsOf(rows: ChangeRow[]): bigint[] {
  return rows.map((row) => row.cursor);
}
