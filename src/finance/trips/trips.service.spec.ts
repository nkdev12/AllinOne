import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChangeOperation } from "@prisma/client";
import { TripsService } from "./trips.service";

/**
 * TRIP sharing, from the REST side.
 *
 * `ShareResourceType` has listed `TRIP` and `/collaboration` has accepted it for
 * as long as the enum existed, but every consumer of a grant tested only
 * `"EXPENSE_GROUP"`, so a trip grant was a row that granted nothing: the invitee
 * could not open the trip, could not edit it, and their sync cursor never moved.
 * These cases are the four questions a grant has to answer, each asked of the
 * service the controller actually calls:
 *
 *   - can this caller read the trip?          (`VIEWER` and up: yes)
 *   - can this caller write it?               (`EDITOR`/`ADMIN` only)
 *   - can this caller delete it?              (the owner, alone)
 *   - does the write reach the other side?    (fan-out into every participant's
 *                                              own change log, at their own cursor)
 *
 * Prisma is faked here, and faked in one specific way: `resourceShare` answers
 * like the generated client answers for a collection a database does not have
 * yet — an empty result, not an error (`findFirst` → `null`, `findMany` → `[]`).
 * `allinone_dev` has no `ResourceShare` collection until `npx prisma db push`
 * runs, and the point of the cases built on that shape is that a missing
 * collection degrades every route to owner-only rather than throwing.
 */

const OWNER = "owner-11111111-1111-4111-8111-111111111111";
const EDITOR = "editor-22222222-2222-4222-8222-222222222222";
const VIEWER = "viewer-33333333-3333-4333-8333-333333333333";
const STRANGER = "stranger-44444444-4444-4444-8444-444444444444";

const TRIP = "trip-55555555-5555-4555-8555-555555555555";
const OTHER_TRIP = "trip-66666666-6666-4666-8666-666666666666";
const ITEM = "item-77777777-7777-4777-8777-777777777777";

type Row = Record<string, any>;

interface StoreState {
  trips: Row[];
  itineraries: Row[];
  expenses: Row[];
  settlements: Row[];
  grants: Row[];
  changes: Array<{
    userId: string;
    entityType: string;
    entityId: string;
    operation: string;
    version: number;
    cursor: bigint;
    payload: any;
  }>;
}

/** `$or`, `$in`-style filters, `deletedAt: null` and plain equality. Nothing else. */
function matches(row: Row, where: any = {}): boolean {
  for (const [key, value] of Object.entries(where ?? {})) {
    if (key === "OR") {
      const clauses = value as any[];
      if (!clauses.some((clause) => matches(row, clause))) return false;
      continue;
    }
    if (key === "AND") {
      const clauses = value as any[];
      if (!clauses.every((clause) => matches(row, clause))) return false;
      continue;
    }
    if (value && typeof value === "object" && "in" in (value as any)) {
      const list = (value as any).in as any[];
      if (!list.includes(row[key])) return false;
      continue;
    }
    if ((row[key] ?? null) !== (value ?? null)) return false;
  }
  return true;
}

function liveItineraryItems(state: StoreState, tripId: string) {
  return state.itineraries
    .filter((item) => item.tripId === tripId && !item.deletedAt)
    .map((item) => ({ ...item }));
}

/**
 * The shape the grant row has to have for the code under test to see it: a live
 * grant is `deletedAt: null`, and a revoked one keeps its row.
 */
function grant(
  userId: string,
  role: "VIEWER" | "EDITOR" | "ADMIN",
  overrides: Row = {},
): Row {
  return {
    id: `share-${userId}`,
    resourceType: "TRIP",
    resourceId: TRIP,
    ownerId: OWNER,
    sharedWithUserId: userId,
    sharedWithEmail: `${userId}@example.com`,
    role,
    deletedAt: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

function trip(overrides: Row = {}): Row {
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
    version: 1,
    createdAt: new Date("2026-10-01"),
    updatedAt: new Date("2026-10-01"),
    ...overrides,
  };
}

interface StoreOptions {
  grants?: Row[];
  trips?: Row[];
  /** Model the `ResourceShare` collection being absent from the client entirely. */
  withoutResourceShare?: boolean;
}

function createStore(options: StoreOptions = {}) {
  const state: StoreState = {
    trips: options.trips ?? [trip()],
    itineraries: [],
    expenses: [],
    settlements: [],
    grants: options.grants ?? [],
    changes: [],
  };
  // One counter per user, because `SyncCursor` is keyed by `userId`
  // (`prisma/schema.prisma:266-272`): a collaborator's cursor advancing is a
  // property of *their* stream, not of a global number.
  const cursors = new Map<string, bigint>();
  const nextCursor = (userId: string) => {
    const next = (cursors.get(userId) ?? BigInt(0)) + BigInt(1);
    cursors.set(userId, next);
    return next;
  };

  const attach = (row: Row): Row => ({
    ...row,
    itineraryItems: liveItineraryItems(state, row.id),
  });

  const client: any = {
    __state: state,
    __cursors: cursors,
    $transaction: jest.fn(async (fn: any) => fn(client)),
    financeTrip: {
      findFirst: jest.fn(async ({ where }: any = {}) => {
        const hit = state.trips.find((row) => matches(row, where));
        return hit ? attach(hit) : null;
      }),
      findMany: jest.fn(async ({ where }: any = {}) =>
        state.trips
          .filter((row) => matches(row, where))
          .map(attach)
          .sort((a, b) => b.startDate.getTime() - a.startDate.getTime()),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `trip-new-${state.trips.length}`,
          version: 1,
          deletedAt: null,
          ...data,
        };
        state.trips.push(row);
        return attach(row);
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.trips.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("no such trip");
        if (data.version?.increment) row.version += data.version.increment;
        Object.assign(row, data, { version: row.version });
        return attach(row);
      }),
    },
    financeTripItinerary: {
      findFirst: jest.fn(async ({ where }: any = {}) => {
        const hit = state.itineraries.find((row) => matches(row, where));
        return hit ? { ...hit } : null;
      }),
      findMany: jest.fn(async ({ where }: any = {}) =>
        state.itineraries
          .filter((row) => matches(row, where))
          .map((row) => ({ ...row })),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: ITEM,
          version: 1,
          deletedAt: null,
          createdAt: new Date("2026-10-02"),
          ...data,
        };
        state.itineraries.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.itineraries.find(
          (candidate) => candidate.id === where.id,
        );
        if (!row) throw new Error("no such itinerary item");
        const bumped = data.version?.increment
          ? (row.version += data.version.increment)
          : row.version;
        Object.assign(row, data, { version: bumped });
        return { ...row };
      }),
    },
    financeSharedExpense: {
      findMany: jest.fn(async ({ where }: any = {}) =>
        state.expenses.filter((row) => matches(row, where)),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.expenses.find(
          (candidate) => candidate.id === where.id,
        );
        Object.assign(row ?? {}, data);
        return { ...row };
      }),
    },
    financeSettlement: {
      findMany: jest.fn(async ({ where }: any = {}) =>
        state.settlements.filter((row) => matches(row, where)),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.settlements.find(
          (candidate) => candidate.id === where.id,
        );
        Object.assign(row ?? {}, data);
        return { ...row };
      }),
    },
    change: {
      // `appendChange` allocates the cursor through `syncCursor.upsert` and then
      // stores the row with it (`src/sync/change-cursor.ts:88-99`), so the fake
      // takes the cursor off the data rather than handing out a second one.
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `change-${state.changes.length + 1}`, ...data };
        state.changes.push(row);
        return { id: row.id, cursor: data.cursor };
      }),
    },
    syncCursor: {
      upsert: jest.fn(async ({ where }: any) => ({
        seq: nextCursor(where.userId),
      })),
    },
  };

  // The empty-result answer a missing Mongo collection gets back from the
  // generated client, which is what the "no grants anywhere" cases model.
  if (!options.withoutResourceShare) {
    client.resourceShare = {
      findFirst: jest.fn(async ({ where }: any = {}) => {
        const hit = state.grants.find((row) => matches(row, where));
        return hit ? { ...hit } : null;
      }),
      findMany: jest.fn(async ({ where }: any = {}) =>
        state.grants
          .filter((row) => matches(row, where))
          .map((row) => ({ ...row })),
      ),
    };
  }

  return { client, state };
}

function build(store: any, notifications?: any) {
  return new TripsService(store as any, notifications);
}

const changeRowsFor = (state: StoreState, userId: string) =>
  state.changes.filter((row) => row.userId === userId);

describe("TripsService grant authority", () => {
  describe("EDITOR grantee", () => {
    it("reads the owner's trip instead of getting a 404", async () => {
      const store = createStore({ grants: [grant(EDITOR, "EDITOR")] });

      const result = await build(store.client).getTripById(EDITOR, TRIP);

      expect(result.id).toBe(TRIP);
      // The read is answered by the grant, and the grant is looked up on the
      // trip — not on the caller's ownership, which is what used to 404 here.
      expect(store.client.resourceShare.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          resourceType: "TRIP",
          resourceId: TRIP,
          sharedWithUserId: EDITOR,
          deletedAt: null,
        }),
      });
    });

    it("writes it, and the write goes to the owner's log as well as their own", async () => {
      const store = createStore({ grants: [grant(EDITOR, "EDITOR")] });

      const updated = await build(store.client).updateTrip(EDITOR, TRIP, {
        title: "Goa, with a stop in Hampi",
      } as any);

      expect(updated.title).toBe("Goa, with a stop in Hampi");
      expect(store.client.financeTrip.update).toHaveBeenCalled();

      // The fan-out is the point: `Change` rows are keyed by user and a pull only
      // ever hands a device its own account's log, so an edit that lands on the
      // editor's log alone is a trip the owner never hears about.
      expect(changeRowsFor(store.state, OWNER)).toEqual([
        expect.objectContaining({
          entityType: "finance_trip",
          entityId: TRIP,
          operation: ChangeOperation.UPDATE,
        }),
      ]);
      expect(changeRowsFor(store.state, EDITOR)).toEqual([
        expect.objectContaining({
          entityType: "finance_trip",
          entityId: TRIP,
          operation: ChangeOperation.UPDATE,
        }),
      ]);
    });

    it("advances the grantee's own cursor so their next pull is not empty", async () => {
      const store = createStore({ grants: [grant(EDITOR, "EDITOR")] });

      await build(store.client).updateTrip(EDITOR, TRIP, {
        notes: "ferry at 09:15",
      } as any);

      const granteeCursor = store.state.changes.find(
        (row) => row.userId === EDITOR,
      )!.cursor;
      expect(granteeCursor > BigInt(0)).toBe(true);
      // Per account, not shared: the owner's stream keeps its own high-water mark
      // so neither participant's cursor can skip the other's changes.
      expect(store.client.syncCursor.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: EDITOR } }),
      );
      expect(store.client.syncCursor.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: OWNER } }),
      );
    });

    it("adds a plan item under the trip, and the parent's grant is what allowed it", async () => {
      const store = createStore({ grants: [grant(EDITOR, "EDITOR")] });

      const item = await build(store.client).addItineraryItem(EDITOR, TRIP, {
        dayIndex: 2,
        title: "Beach",
      } as any);

      expect(item.tripId).toBe(TRIP);
      // No item-level grant exists in the schema and none is consulted: the only
      // `resourceShare` read is keyed by the parent trip's id.
      for (const call of store.client.resourceShare.findMany.mock.calls) {
        expect(call[0].where.resourceId).toBe(TRIP);
      }
      expect(changeRowsFor(store.state, OWNER)).toEqual([
        expect.objectContaining({
          entityType: "finance_trip_itinerary",
          entityId: ITEM,
          operation: ChangeOperation.CREATE,
        }),
      ]);
    });

    it("edits and tombstones somebody else's plan item, on the parent's authority", async () => {
      const store = createStore({ grants: [grant(EDITOR, "EDITOR")] });
      store.state.itineraries.push({
        id: ITEM,
        tripId: TRIP,
        dayIndex: 1,
        title: "Fort",
        plannedCostMinor: null,
        notes: null,
        sortOrder: 0,
        version: 1,
        deletedAt: null,
        createdAt: new Date("2026-10-02"),
      });
      const service = build(store.client);

      await service.updateItineraryItem(EDITOR, TRIP, ITEM, {
        title: "Fort, 17:00",
      } as any);
      expect(store.state.itineraries[0].title).toBe("Fort, 17:00");

      await service.deleteItineraryItem(EDITOR, TRIP, ITEM);
      expect(store.state.itineraries[0].deletedAt).toBeInstanceOf(Date);
    });

    it("is still refused the trip delete", async () => {
      const store = createStore({ grants: [grant(EDITOR, "ADMIN")] });

      await expect(
        build(store.client).deleteTrip(EDITOR, TRIP),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(store.client.financeTrip.update).not.toHaveBeenCalled();
    });
  });

  describe("VIEWER grantee", () => {
    it("reads the trip, its plan and its stats", async () => {
      const store = createStore({ grants: [grant(VIEWER, "VIEWER")] });
      store.state.itineraries.push({
        id: ITEM,
        tripId: TRIP,
        dayIndex: 1,
        title: "Fort",
        plannedCostMinor: BigInt(1000),
        notes: null,
        sortOrder: 0,
        version: 1,
        deletedAt: null,
      });
      const service = build(store.client);

      await expect(service.getTripById(VIEWER, TRIP)).resolves.toMatchObject({
        id: TRIP,
      });
      await expect(
        service.getTripItinerary(VIEWER, TRIP),
      ).resolves.toHaveLength(1);
      const stats = await service.getTripStats(VIEWER, TRIP);
      expect(stats.tripId).toBe(TRIP);
      expect(stats.totalPlannedCostMinor).toBe(1000);
    });

    it("is refused every write, with the same 404 a stranger gets", async () => {
      const store = createStore({ grants: [grant(VIEWER, "VIEWER")] });
      store.state.itineraries.push({
        id: ITEM,
        tripId: TRIP,
        dayIndex: 1,
        title: "Fort",
        plannedCostMinor: null,
        notes: null,
        sortOrder: 0,
        version: 1,
        deletedAt: null,
      });
      const service = build(store.client);

      await expect(
        service.updateTrip(VIEWER, TRIP, { title: "Rewritten" } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.addItineraryItem(VIEWER, TRIP, {
          dayIndex: 1,
          title: "Nope",
        } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      // The plan rows are writes too, and their authority is the parent trip's,
      // so a read grant must stop them exactly as it stops the trip PATCH.
      await expect(
        service.updateItineraryItem(VIEWER, TRIP, ITEM, {
          title: "Nope",
        } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.deleteItineraryItem(VIEWER, TRIP, ITEM),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Nothing was written, and nothing was logged.
      expect(store.client.financeTrip.update).not.toHaveBeenCalled();
      expect(store.client.financeTripItinerary.create).not.toHaveBeenCalled();
      expect(store.client.financeTripItinerary.update).not.toHaveBeenCalled();
      expect(store.state.itineraries[0].title).toBe("Fort");
      expect(store.state.itineraries[0].deletedAt).toBe(null);
      expect(store.state.changes).toEqual([]);
    });

    it("is refused a write whose grant lookup asked for a role with weight", async () => {
      const store = createStore({ grants: [grant(VIEWER, "VIEWER")] });

      await build(store.client)
        .updateTrip(VIEWER, TRIP, { title: "x" } as any)
        .catch(() => undefined);

      expect(store.client.resourceShare.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          resourceType: "TRIP",
          role: { in: ["EDITOR", "ADMIN"] },
        }),
      });
    });

    it("may not remove the trip either — a read grant reaches the owner check, and stops there", async () => {
      const store = createStore({ grants: [grant(VIEWER, "VIEWER")] });

      // 403, not the 404 a stranger gets, and that is `deleteGroup`'s answer
      // (`groups.service.ts:370-375`): the route reads the trip first, so a
      // `VIEWER` has already proved they can see it and is then told the removal
      // is not theirs. Disclosing an existence the caller already has is not a
      // leak; the 404 for a caller who cannot read it is what keeps a random id
      // from being probed.
      await expect(
        build(store.client).deleteTrip(VIEWER, TRIP),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(store.client.financeTrip.update).not.toHaveBeenCalled();
      expect(store.state.changes).toEqual([]);
    });
  });

  describe("a caller with no grant", () => {
    it("gets 404 on read, write and delete alike", async () => {
      const store = createStore();
      const service = build(store.client);

      await expect(service.getTripById(STRANGER, TRIP)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        service.updateTrip(STRANGER, TRIP, { title: "x" } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Deliberate: `deleteTrip` is the one route that can answer 403, and it only
      // gets there behind a read. A stranger is told "no such trip" rather than
      // "this trip exists and is not yours", the same non-disclosure
      // `getGroupById`/`deleteGroup` already choose.
      await expect(service.deleteTrip(STRANGER, TRIP)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        service.addItineraryItem(STRANGER, TRIP, {
          dayIndex: 1,
          title: "x",
        } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(store.state.changes).toEqual([]);
    });

    it("stops being able to read the moment the grant is revoked", async () => {
      const store = createStore({
        grants: [
          grant(EDITOR, "EDITOR", { deletedAt: new Date("2026-10-05") }),
        ],
      });

      await expect(
        build(store.client).getTripById(EDITOR, TRIP),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(build(store.client).getTrips(EDITOR)).resolves.toEqual([]);
    });

    it("cannot reach another trip's plan through the trip it is granted", async () => {
      const store = createStore({
        trips: [trip(), trip({ id: OTHER_TRIP, title: "Kerala" })],
        grants: [grant(EDITOR, "EDITOR")],
      });
      store.state.itineraries.push({
        id: ITEM,
        tripId: OTHER_TRIP,
        dayIndex: 1,
        title: "Backwaters",
        plannedCostMinor: null,
        notes: null,
        sortOrder: 0,
        version: 1,
        deletedAt: null,
      });

      // The route names a trip the caller has no grant for.
      await expect(
        build(store.client).updateItineraryItem(EDITOR, OTHER_TRIP, ITEM, {
          title: "Rewritten",
        } as any),
      ).rejects.toBeInstanceOf(NotFoundException);

      // And the reverse: a trip the caller *is* granted, with somebody else's
      // plan row named under it. Tenancy is derived from the parent in the query,
      // not from the row's id alone, so the item is out of reach either way.
      await expect(
        build(store.client).updateItineraryItem(EDITOR, TRIP, ITEM, {
          title: "Rewritten",
        } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        build(store.client).deleteItineraryItem(EDITOR, TRIP, ITEM),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(store.state.itineraries[0].title).toBe("Backwaters");
      expect(store.state.itineraries[0].deletedAt).toBe(null);
      expect(store.state.changes).toEqual([]);
    });

    it("does not see a trip that is in the bin, even with a grant", async () => {
      const store = createStore({
        trips: [trip({ deletedAt: new Date("2026-10-09") })],
        grants: [grant(EDITOR, "ADMIN")],
      });

      await expect(
        build(store.client).getTripById(EDITOR, TRIP),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("the list route", () => {
    it("includes a granted trip for any role, the way the group list does", async () => {
      const store = createStore({
        trips: [trip(), trip({ id: OTHER_TRIP, title: "Kerala" })],
        grants: [
          grant(EDITOR, "EDITOR"),
          grant(VIEWER, "VIEWER", { resourceId: OTHER_TRIP }),
        ],
      });

      await expect(build(store.client).getTrips(EDITOR)).resolves.toEqual([
        expect.objectContaining({ id: TRIP }),
      ]);
      await expect(build(store.client).getTrips(VIEWER)).resolves.toEqual([
        expect.objectContaining({ id: OTHER_TRIP }),
      ]);
      await expect(build(store.client).getTrips(STRANGER)).resolves.toEqual([]);
    });

    it("still filters archived for a grantee, on the same query as the owner's rows", async () => {
      const store = createStore({
        trips: [trip(), trip({ id: OTHER_TRIP, isArchived: true })],
        grants: [
          grant(EDITOR, "EDITOR"),
          grant(EDITOR, "ADMIN", { resourceId: OTHER_TRIP }),
        ],
      });
      const service = build(store.client);

      await expect(service.getTrips(EDITOR)).resolves.toHaveLength(1);
      await expect(service.getTrips(EDITOR, true)).resolves.toHaveLength(2);
    });
  });

  describe("the owner's own routes are unchanged", () => {
    it("reads, writes and deletes without a grant row anywhere", async () => {
      const store = createStore();
      const service = build(store.client);

      await expect(service.getTripById(OWNER, TRIP)).resolves.toMatchObject({
        id: TRIP,
      });
      // The owner is never asked for a grant.
      expect(store.client.resourceShare.findFirst).not.toHaveBeenCalled();

      await service.updateTrip(OWNER, TRIP, { title: "Goa again" } as any);
      expect(store.state.trips[0].title).toBe("Goa again");

      await service.deleteTrip(OWNER, TRIP);
      expect(store.state.trips[0].deletedAt).toBeInstanceOf(Date);
    });

    it("appends the owner's delete cascade to every collaborator's log", async () => {
      const store = createStore({ grants: [grant(EDITOR, "EDITOR")] });
      store.state.itineraries.push({
        id: ITEM,
        tripId: TRIP,
        dayIndex: 1,
        title: "Fort",
        plannedCostMinor: null,
        notes: null,
        sortOrder: 0,
        version: 1,
        deletedAt: null,
      });

      await build(store.client).deleteTrip(OWNER, TRIP);

      // A collaborator who is not told the plan rows died keeps an itinerary with
      // no trip under it, which is the orphan the client cannot re-parent.
      for (const userId of [OWNER, EDITOR]) {
        expect(
          changeRowsFor(store.state, userId).map((row) => row.entityType),
        ).toEqual(["finance_trip", "finance_trip_itinerary"]);
        expect(
          changeRowsFor(store.state, userId).every(
            (r) => r.operation === "DELETE",
          ),
        ).toBe(true);
      }
      expect(store.state.itineraries[0].deletedAt).toBeInstanceOf(Date);
    });

    it("notifies each participant once per stream, not once for the actor", async () => {
      const store = createStore({ grants: [grant(EDITOR, "EDITOR")] });
      const notify = jest.fn();

      await build(store.client, { notifyMutation: notify }).updateTrip(
        OWNER,
        TRIP,
        { title: "Renamed" } as any,
      );

      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ userId: EDITOR, highestCursor: BigInt(1) }),
      );
    });
  });

  describe("with no grants to find", () => {
    it("keeps every owner route working and logs to the owner alone", async () => {
      const store = createStore();
      const service = build(store.client);

      // What a missing `ResourceShare` collection actually looks like from the
      // generated client: the delegate exists and answers empty, because MongoDB
      // creates a collection on first write and a read of one that is not there
      // returns nothing rather than failing. `allinone_dev` has no such collection
      // yet, so this is the only shape trip sharing can be exercised in until
      // `npx prisma db push` runs — and the shape that must not break anything.
      await expect(service.getTripById(OWNER, TRIP)).resolves.toMatchObject({
        id: TRIP,
      });
      await expect(service.getTrips(OWNER)).resolves.toHaveLength(1);
      await service.updateTrip(OWNER, TRIP, { title: "Renamed" } as any);
      expect(store.state.trips[0].title).toBe("Renamed");
      expect(store.state.changes.map((row) => row.userId)).toEqual([OWNER]);
    });

    it("refuses a collaborator who has no row to be found", async () => {
      const store = createStore();

      await expect(
        build(store.client).getTripById(EDITOR, TRIP),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(build(store.client).getTrips(EDITOR)).resolves.toEqual([]);
    });

    it("does not depend on the grant delegate to write a trip", async () => {
      // The fan-out reads grants through `(tx as any).resourceShare` the way
      // `groups.service.ts` `appendGroupChange` does, so a client that cannot
      // answer for grants costs the owner their collaborators, not their edit.
      const store = createStore({ withoutResourceShare: true });
      const service = build(store.client);

      await service.updateTrip(OWNER, TRIP, { title: "Renamed" } as any);
      await service.addItineraryItem(OWNER, TRIP, {
        dayIndex: 1,
        title: "Fort",
      } as any);

      expect(store.state.trips[0].title).toBe("Renamed");
      expect(store.state.changes.map((row) => row.userId)).toEqual([
        OWNER,
        OWNER,
      ]);
    });
  });
});
