import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import {
  normaliseCurrency,
  toMinorUnits,
} from "@/finance/accounts/accounts.service";
import { CreateTripDto } from "./dto/create-trip.dto";
import { UpdateTripDto } from "./dto/update-trip.dto";
import { CreateItineraryItemDto } from "./dto/create-itinerary-item.dto";
import { UpdateItineraryItemDto } from "./dto/update-itinerary-item.dto";
import { appendChange } from "@/sync/change-cursor";
import {
  ChangeOperation,
  Prisma,
  ShareRole as ShareRoleEnum,
} from "@prisma/client";

type WriteClient = Prisma.TransactionClient;

/**
 * The grant roles that may write a trip, and nothing else decides it.
 *
 * `VIEWER` is a read grant: it is admitted by `getTripById(userId, tripId)` and
 * refused by `getTripById(userId, tripId, true)`, which is exactly how
 * `groups.service.ts` `getGroupById(userId, groupId, canEdit)` treats a group,
 * and the same split the sync projection makes in
 * `change-projection.ts` `canEditFinanceTrip`. Keeping the two resources on one
 * rule is the point — a reviewer must not find a path that honours VIEWER on a
 * group and ignores it on a trip.
 */
const TRIP_WRITE_ROLES: ShareRoleEnum[] = ["EDITOR", "ADMIN"];

/**
 * `ShareResourceType.TRIP` (`prisma/schema.prisma:821-827`) is a row in
 * `ResourceShare` like any other grant: read by `sharedWithUserId` — never by
 * `sharedWithEmail`, which is the invite address and not an identity this server
 * re-verifies — with `deletedAt: null` so a revoked grant stops answering the
 * instant it is revoked, and with the role filter applied by the caller.
 */
function tripGrantWhere(
  userId: string,
  tripId: string,
  canEdit: boolean,
): Prisma.ResourceShareWhereInput {
  return {
    resourceType: "TRIP",
    resourceId: tripId,
    sharedWithUserId: userId,
    deletedAt: null,
    ...(canEdit ? { role: { in: TRIP_WRITE_ROLES } } : {}),
  };
}

function formatTripResponse(trip: any) {
  return {
    ...trip,
    totalBudgetMinor:
      trip.totalBudgetMinor !== null && trip.totalBudgetMinor !== undefined
        ? Number(trip.totalBudgetMinor)
        : null,
    itineraryItems: (trip.itineraryItems || []).map(
      formatItineraryItemResponse,
    ),
  };
}

function formatItineraryItemResponse(item: any) {
  return {
    ...item,
    plannedCostMinor:
      item.plannedCostMinor !== null && item.plannedCostMinor !== undefined
        ? Number(item.plannedCostMinor)
        : null,
  };
}

function tripChangePayload(trip: any): Record<string, any> {
  return {
    title: trip.title,
    destinations: trip.destinations ?? [],
    startDate:
      trip.startDate instanceof Date
        ? trip.startDate.toISOString()
        : (trip.startDate ?? null),
    endDate:
      trip.endDate instanceof Date
        ? trip.endDate.toISOString()
        : (trip.endDate ?? null),
    baseCurrency: trip.baseCurrency ?? "INR",
    totalBudgetMinor:
      trip.totalBudgetMinor !== null && trip.totalBudgetMinor !== undefined
        ? Number(trip.totalBudgetMinor)
        : null,
    notes: trip.notes ?? null,
    isArchived: trip.isArchived ?? false,
    createdAt:
      trip.createdAt instanceof Date
        ? trip.createdAt.toISOString()
        : (trip.createdAt ?? null),
    version: trip.version ?? 1,
  };
}

function itineraryChangePayload(item: any): Record<string, any> {
  return {
    tripId: item.tripId,
    dayIndex: item.dayIndex,
    date:
      item.date instanceof Date ? item.date.toISOString() : (item.date ?? null),
    title: item.title,
    plannedCostMinor:
      item.plannedCostMinor !== null && item.plannedCostMinor !== undefined
        ? Number(item.plannedCostMinor)
        : null,
    notes: item.notes ?? null,
    sortOrder: item.sortOrder ?? 0,
    createdAt:
      item.createdAt instanceof Date
        ? item.createdAt.toISOString()
        : (item.createdAt ?? null),
    version: item.version ?? 1,
  };
}

/**
 * Who may do what to a trip, and where each answer is enforced.
 *
 * | caller          | `GET /finance/trips` | read `/:id`, `/:id/stats`, `/:id/itinerary` | write `PATCH /:id`, itinerary POST/PATCH/DELETE | `DELETE /:id` |
 * | --------------- | -------------------- | ------------------------------------------- | ----------------------------------------------- | ------------- |
 * | owner           | listed               | yes                                         | yes                                            | yes           |
 * | `ADMIN` grantee | listed               | yes                                         | yes                                            | 403           |
 * | `EDITOR` grantee| listed               | yes                                         | yes                                            | 403           |
 * | `VIEWER` grantee| listed               | yes                                         | 404                                            | 403           |
 * | stranger        | not listed           | 404                                         | 404                                            | 404           |
 *
 * Three decisions in that table are deliberate, and all three are the group's
 * answers rather than new ones:
 *
 * 1. **A missing trip and an ungranted trip are the same 404.** `getGroupById`
 *    already refuses both with `NotFoundException("Finance group not found")`
 *    rather than 403, and the reason holds here too: `PATCH /finance/trips/:id`
 *    runs behind a UUID the caller produced out of nowhere, and a 403 would
 *    confirm the id exists while a 404 does not. `DELETE /:id` is the one place
 *    a 403 is answered, and only *after* the caller has proved they can read the
 *    trip — the same order `deleteGroup` uses.
 * 2. **`VIEWER` reads, `EDITOR`/`ADMIN` write, and a read grant is never quietly
 *    enough for a write.** The `canEdit` flag is passed by every write route and
 *    by none of the read routes, mirroring `getGroupById(userId, groupId,
 *    canEdit)` (`groups.service.ts:246-268`) and `canEditFinanceTrip` on the sync
 *    side.
 * 3. **Delete stays owner-only.** `groups.service.ts:370` refuses a non-owner who
 *    holds even an `ADMIN` grant, and a trip's delete cascades tombstones over
 *    its plan, expenses and settlements — collaborators' rows. Widening that to a
 *    grantee would be a difference the two resources must not have.
 *
 * The list route includes granted-on trips because `getGroups` includes
 * granted-on groups today (`groups.service.ts:222-242`: one `resourceShare` read
 * plus an `OR`). Consistency chose this, not a new policy — same role-agnostic
 * grant filter, same rows, so a grantee's trip list behaves like their group list
 * and a stranger's trips stay unlisted either way.
 */
@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly syncNotifications?: SyncNotificationService,
  ) {}

  // -------------------------------------------------------------
  // Sync fan-out
  // -------------------------------------------------------------

  /**
   * A trip has one shared plan and one shared budget, so every mutation belongs
   * on every collaborator's own change log: the REST response reaches one caller,
   * while the Flutter finance UI reads its local projection
   * (`allmynote_frontend/lib/services/sync_manager.dart`), which only advances on
   * a pull past the author's cursor.
   *
   * The trip's own `ownerId` is always a recipient even when the actor is a
   * grantee — an `EDITOR`'s edit has to reach the owner's devices — and the
   * author is folded in by the `actorId` half of the set, which is what keeps
   * `createTrip`'s single-owner append correct without this call at all.
   *
   * `resourceShare` is read through a presence guard rather than asserted: the
   * collection is not in every environment yet (`prisma/schema.prisma:838-866`
   * maps it, but `allinone_dev` has no such collection until `npx prisma db push`
   * runs), and a grant list nothing can answer is read as "no collaborators",
   * which fans the change out to the owner alone instead of failing a write the
   * owner made.
   */
  private async appendTripChange(
    tx: WriteClient,
    tripId: string,
    ownerId: string,
    actorId: string,
    change: Omit<Prisma.ChangeUncheckedCreateInput, "cursor" | "userId">,
  ): Promise<Map<string, bigint>> {
    const recipients = new Set([ownerId, actorId]);
    const resourceShare = (tx as any).resourceShare;
    if (resourceShare?.findMany) {
      const shares = await resourceShare.findMany({
        where: {
          resourceType: "TRIP",
          resourceId: tripId,
          deletedAt: null,
        },
        select: { sharedWithUserId: true },
      });
      for (const share of shares) {
        if (share.sharedWithUserId) recipients.add(share.sharedWithUserId);
      }
    }

    const cursors = new Map<string, bigint>();
    for (const userId of recipients) {
      const logged = await appendChange(tx, { ...change, userId });
      cursors.set(userId, logged.cursor);
    }
    return cursors;
  }

  private mergeChangeCursors(
    target: Map<string, bigint>,
    added: Map<string, bigint>,
  ) {
    for (const [userId, cursor] of added) target.set(userId, cursor);
  }

  private notifyChangeCursors(cursors: Map<string, bigint>) {
    for (const [userId, highestCursor] of cursors) {
      this.syncNotifications?.notifyMutation({ userId, highestCursor });
    }
  }

  // -------------------------------------------------------------
  // Trip CRUD
  // -------------------------------------------------------------

  async createTrip(userId: string, dto: CreateTripDto) {
    const totalBudgetMinor =
      dto.totalBudgetMinor !== undefined && dto.totalBudgetMinor !== null
        ? toMinorUnits(dto.totalBudgetMinor, "totalBudgetMinor")
        : null;

    let highestCursor: bigint | undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const trip = await tx.financeTrip.create({
        data: {
          ownerId: userId,
          title: dto.title,
          destinations: dto.destinations ?? [],
          startDate: new Date(dto.startDate),
          endDate: new Date(dto.endDate),
          baseCurrency: normaliseCurrency(dto.baseCurrency),
          totalBudgetMinor,
          notes: dto.notes,
          isArchived: false,
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_trip",
        entityId: trip.id,
        operation: ChangeOperation.CREATE,
        version: trip.version,
        payload: tripChangePayload(trip),
        userId,
      });
      highestCursor = logged.cursor;

      return trip;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatTripResponse(created);
  }

  async getTrips(userId: string, includeArchived = false) {
    // Grant-on trips join the list the way `getGroups` lets grant-on groups join
    // (`groups.service.ts:222`): one `resourceShare` read, then an `OR` of
    // "mine" and "somebody shared with me". No role filter here — a `VIEWER` is
    // still a collaborator and their trip list would otherwise be the one place
    // their grant does not show up.
    const shared = await this.prisma.resourceShare.findMany({
      where: {
        resourceType: "TRIP",
        sharedWithUserId: userId,
        deletedAt: null,
      },
      select: { resourceId: true },
    });

    const trips = await this.prisma.financeTrip.findMany({
      where: {
        OR: [
          { ownerId: userId },
          { id: { in: shared.map((share) => share.resourceId) } },
        ],
        deletedAt: null,
        ...(includeArchived ? {} : { isArchived: false }),
      },
      include: {
        itineraryItems: {
          where: { deletedAt: null },
          orderBy: [{ dayIndex: "asc" }, { sortOrder: "asc" }],
        },
      },
      orderBy: { startDate: "desc" },
    });

    return trips.map(formatTripResponse);
  }

  /**
   * The trip, or nothing.
   *
   * `canEdit` is the whole read/write line, and it is `getGroupById`'s line: the
   * row is looked up unowned, and a non-owner is admitted only by a live grant —
   * any role to read, `EDITOR`/`ADMIN` to write. Both refusals answer
   * `NotFoundException`, so a caller probing random UUIDs cannot tell a trip that
   * exists from one that does not.
   */
  async getTripById(userId: string, tripId: string, canEdit = false) {
    const trip = await this.prisma.financeTrip.findFirst({
      where: {
        id: tripId,
        deletedAt: null,
      },
      include: {
        itineraryItems: {
          where: { deletedAt: null },
          orderBy: [{ dayIndex: "asc" }, { sortOrder: "asc" }],
        },
      },
    });

    if (!trip) {
      throw new NotFoundException("Finance trip not found");
    }

    if (trip.ownerId !== userId) {
      const share = await this.prisma.resourceShare.findFirst({
        where: tripGrantWhere(userId, tripId, canEdit),
      });
      if (!share) throw new NotFoundException("Finance trip not found");
    }

    return formatTripResponse(trip);
  }

  async updateTrip(userId: string, tripId: string, dto: UpdateTripDto) {
    // A write route: `canEdit`, so a `VIEWER`'s grant does not reach here.
    const existing = await this.getTripById(userId, tripId, true);
    const notificationCursors = new Map<string, bigint>();

    const updated = await this.prisma.$transaction(async (tx) => {
      const trip = await tx.financeTrip.update({
        where: { id: existing.id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.destinations !== undefined
            ? { destinations: dto.destinations }
            : {}),
          ...(dto.startDate !== undefined
            ? { startDate: new Date(dto.startDate) }
            : {}),
          ...(dto.endDate !== undefined
            ? { endDate: new Date(dto.endDate) }
            : {}),
          ...(dto.baseCurrency !== undefined
            ? { baseCurrency: normaliseCurrency(dto.baseCurrency) }
            : {}),
          ...(dto.totalBudgetMinor !== undefined
            ? {
                totalBudgetMinor:
                  dto.totalBudgetMinor !== null
                    ? toMinorUnits(dto.totalBudgetMinor, "totalBudgetMinor")
                    : null,
              }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.isArchived !== undefined
            ? { isArchived: dto.isArchived }
            : {}),
          version: { increment: 1 },
        },
        include: {
          itineraryItems: {
            where: { deletedAt: null },
            orderBy: [{ dayIndex: "asc" }, { sortOrder: "asc" }],
          },
        },
      });

      const cursors = await this.appendTripChange(
        tx,
        existing.id,
        existing.ownerId,
        userId,
        {
          entityType: "finance_trip",
          entityId: trip.id,
          operation: ChangeOperation.UPDATE,
          version: trip.version,
          payload: tripChangePayload(trip),
        },
      );
      this.mergeChangeCursors(notificationCursors, cursors);

      return trip;
    });

    this.notifyChangeCursors(notificationCursors);

    return formatTripResponse(updated);
  }

  /**
   * Tombstoning a trip is the owner's call and nobody else's, even an `ADMIN`
   * grantee's — the same refusal `deleteGroup` makes
   * (`groups.service.ts:369-375`), for the same reason: this one write cascades
   * over a plan, an expense list and a settlement ledger that other people
   * authored, and a grant that lets you edit your own rows in a shared trip is
   * not a licence to delete the trip they are in.
   *
   * The read happens first, so a stranger gets the same 404 they get everywhere
   * else here and only a caller who *can* see the trip is told they cannot remove
   * it. `groups.service.ts` orders it the same way.
   */
  async deleteTrip(userId: string, tripId: string) {
    const existing = await this.getTripById(userId, tripId);
    if (existing.ownerId !== userId) {
      throw new ForbiddenException("Only the trip owner can remove this trip.");
    }
    const deletedAt = new Date();
    const notificationCursors = new Map<string, bigint>();

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.financeTrip.update({
        where: { id: existing.id },
        data: {
          deletedAt,
          version: { increment: 1 },
        },
      });

      const cursors = await this.appendTripChange(
        tx,
        existing.id,
        existing.ownerId,
        userId,
        {
          entityType: "finance_trip",
          entityId: existing.id,
          operation: ChangeOperation.DELETE,
          version: updated.version,
          payload: {},
        },
      );
      this.mergeChangeCursors(notificationCursors, cursors);

      // `onDelete: Cascade` in schema.prisma is decoration only on MongoDB, so
      // tombstoning the trip left its plan, its expenses and its settlements
      // live: they kept feeding `getTripStats`-shaped reads on the child rows
      // and a device that pulled the trip DELETE still showed the whole trip in
      // its expense list. Every child gets a tombstone and a DELETE change of
      // its own, inside the same transaction, so the replay converges.
      const [itineraryItems, sharedExpenses, settlements] = await Promise.all([
        tx.financeTripItinerary.findMany({
          where: { tripId, deletedAt: null },
        }),
        tx.financeSharedExpense.findMany({
          where: { tripId, deletedAt: null },
        }),
        tx.financeSettlement.findMany({ where: { tripId, deletedAt: null } }),
      ]);

      // The cascade goes to the accounts the trip row's own append just resolved
      // — read once, above — because a collaborator who is being told the trip is
      // dead must also be told its plan and ledger are dead, or their device keeps
      // a trip-scoped expense list with no trip under it.
      const recipients = [...cursors.keys()];
      const appendToRecipients = async (
        entityType: string,
        entityId: string,
        version: number,
      ) => {
        for (const recipientId of recipients) {
          const logged = await appendChange(tx, {
            userId: recipientId,
            entityType,
            entityId,
            operation: ChangeOperation.DELETE,
            version,
            payload: {},
          });
          notificationCursors.set(recipientId, logged.cursor);
        }
      };

      for (const item of itineraryItems) {
        const child = await tx.financeTripItinerary.update({
          where: { id: item.id },
          data: { deletedAt, version: { increment: 1 } },
        });
        await appendToRecipients(
          "finance_trip_itinerary",
          item.id,
          child.version,
        );
      }

      for (const expense of sharedExpenses) {
        const child = await tx.financeSharedExpense.update({
          where: { id: expense.id },
          data: { deletedAt, version: { increment: 1 } },
        });
        await appendToRecipients(
          "finance_shared_expense",
          expense.id,
          child.version,
        );
      }

      for (const settlement of settlements) {
        const child = await tx.financeSettlement.update({
          where: { id: settlement.id },
          data: { deletedAt, version: { increment: 1 } },
        });
        await appendToRecipients(
          "finance_settlement",
          settlement.id,
          child.version,
        );
      }
    });

    this.notifyChangeCursors(notificationCursors);

    return { success: true };
  }

  // -------------------------------------------------------------
  // Itinerary Item CRUD
  // -------------------------------------------------------------

  /**
   * Every route below starts by resolving the **parent trip** under the caller,
   * because `FinanceTripItinerary` has no `ownerId` or `userId` of its own
   * (`prisma/schema.prisma:1208-1226`): the trip is the only thing in the schema
   * that can say whose this row is. Sharing a trip therefore shares its plan
   * through the trip and never around it — there is no item-level grant to consult
   * and no item query that skips the parent. A grantee's `canEdit` is the parent's
   * grant (`EDITOR`/`ADMIN`), and an item is only ever read or written through a
   * trip the caller can read, which is the same parent-derived rule the client
   * holds locally (`finance_trip_repository.dart` `_ownsTrip`, and
   * `sync_manager.dart` refusing to apply an item whose parent trip is absent).
   */
  async addItineraryItem(
    userId: string,
    tripId: string,
    dto: CreateItineraryItemDto,
  ) {
    const trip = await this.getTripById(userId, tripId, true);
    const plannedCostMinor =
      dto.plannedCostMinor !== undefined && dto.plannedCostMinor !== null
        ? toMinorUnits(dto.plannedCostMinor, "plannedCostMinor")
        : null;

    const notificationCursors = new Map<string, bigint>();

    const item = await this.prisma.$transaction(async (tx) => {
      const created = await tx.financeTripItinerary.create({
        data: {
          tripId,
          dayIndex: dto.dayIndex,
          date: dto.date ? new Date(dto.date) : null,
          title: dto.title,
          plannedCostMinor,
          notes: dto.notes,
          sortOrder: dto.sortOrder ?? 0,
        },
      });

      const cursors = await this.appendTripChange(
        tx,
        trip.id,
        trip.ownerId,
        userId,
        {
          entityType: "finance_trip_itinerary",
          entityId: created.id,
          operation: ChangeOperation.CREATE,
          version: created.version,
          payload: itineraryChangePayload(created),
        },
      );
      this.mergeChangeCursors(notificationCursors, cursors);

      return created;
    });

    this.notifyChangeCursors(notificationCursors);

    return formatItineraryItemResponse(item);
  }

  /**
   * A read route, so no `canEdit`: the plan is what a `VIEWER` came to look at.
   * The parent trip is still resolved first, and an item that is not under it is
   * not in the result set (`where: { tripId }`).
   */
  async getTripItinerary(userId: string, tripId: string) {
    await this.getTripById(userId, tripId);

    const items = await this.prisma.financeTripItinerary.findMany({
      where: { tripId, deletedAt: null },
      orderBy: [{ dayIndex: "asc" }, { sortOrder: "asc" }],
    });

    return items.map(formatItineraryItemResponse);
  }

  async updateItineraryItem(
    userId: string,
    tripId: string,
    itemId: string,
    dto: UpdateItineraryItemDto,
  ) {
    const trip = await this.getTripById(userId, tripId, true);

    const existing = await this.prisma.financeTripItinerary.findFirst({
      where: { id: itemId, tripId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException("Itinerary item not found");
    }

    const notificationCursors = new Map<string, bigint>();

    const updated = await this.prisma.$transaction(async (tx) => {
      const item = await tx.financeTripItinerary.update({
        where: { id: itemId },
        data: {
          ...(dto.dayIndex !== undefined ? { dayIndex: dto.dayIndex } : {}),
          ...(dto.date !== undefined
            ? { date: dto.date ? new Date(dto.date) : null }
            : {}),
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.plannedCostMinor !== undefined
            ? {
                plannedCostMinor:
                  dto.plannedCostMinor !== null
                    ? toMinorUnits(dto.plannedCostMinor, "plannedCostMinor")
                    : null,
              }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          version: { increment: 1 },
        },
      });

      const cursors = await this.appendTripChange(
        tx,
        trip.id,
        trip.ownerId,
        userId,
        {
          entityType: "finance_trip_itinerary",
          entityId: item.id,
          operation: ChangeOperation.UPDATE,
          version: item.version,
          payload: itineraryChangePayload(item),
        },
      );
      this.mergeChangeCursors(notificationCursors, cursors);

      return item;
    });

    this.notifyChangeCursors(notificationCursors);

    return formatItineraryItemResponse(updated);
  }

  async deleteItineraryItem(userId: string, tripId: string, itemId: string) {
    // `DELETE /:id` on the trip itself is owner-only; deleting one row of a plan
    // is an ordinary edit, and an `EDITOR` is exactly the person the owner asked to
    // rearrange the itinerary. `tripId` is in the item's own `where`, so an id from
    // another trip cannot be reached through this route at all.
    const trip = await this.getTripById(userId, tripId, true);

    const existing = await this.prisma.financeTripItinerary.findFirst({
      where: { id: itemId, tripId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException("Itinerary item not found");
    }

    const notificationCursors = new Map<string, bigint>();

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.financeTripItinerary.update({
        where: { id: itemId },
        data: {
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });

      const cursors = await this.appendTripChange(
        tx,
        trip.id,
        trip.ownerId,
        userId,
        {
          entityType: "finance_trip_itinerary",
          entityId: itemId,
          operation: ChangeOperation.DELETE,
          version: updated.version,
          payload: {},
        },
      );
      this.mergeChangeCursors(notificationCursors, cursors);
    });

    this.notifyChangeCursors(notificationCursors);

    return { success: true };
  }

  // -------------------------------------------------------------
  // Trip Stats & Actual vs Planned Budget
  // -------------------------------------------------------------

  /**
   * There is no exchange-rate concept anywhere in the schema — no column, no
   * table, nothing in `src/finance/` that converts — so a trip's minor units
   * only add up when they are all the same currency. Summing a USD 10000 and an
   * INR 200000 into "210000 INR" was not a rounding problem but an invented
   * number, so the spend comes back bucketed by currency and the budget
   * arithmetic uses only the trip's own base-currency rows.
   */
  async getTripStats(userId: string, tripId: string) {
    const trip = await this.getTripById(userId, tripId);

    const [itineraryItems, sharedExpenses] = await Promise.all([
      this.prisma.financeTripItinerary.findMany({
        where: { tripId, deletedAt: null },
      }),
      this.prisma.financeSharedExpense.findMany({
        where: { tripId, deletedAt: null },
      }),
    ]);

    let totalPlannedCostMinor = 0;
    for (const item of itineraryItems) {
      if (item.plannedCostMinor) {
        totalPlannedCostMinor += Number(item.plannedCostMinor);
      }
    }

    const baseCurrency = normaliseCurrency(trip.baseCurrency);
    const buckets = new Map<string, { total: number; count: number }>();
    for (const exp of sharedExpenses) {
      const currency = normaliseCurrency(exp.currency);
      const bucket = buckets.get(currency) ?? { total: 0, count: 0 };
      bucket.total += Number(exp.totalAmountMinor);
      bucket.count += 1;
      buckets.set(currency, bucket);
    }

    const subtotalsByCurrency = [...buckets.entries()]
      .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
      .map(([currency, bucket]) => ({
        currency,
        totalAmountMinor: bucket.total,
        expenseCount: bucket.count,
      }));

    const totalActualSpentMinor = buckets.get(baseCurrency)?.total ?? 0;
    const totalBudgetMinor = trip.totalBudgetMinor ?? 0;
    const remainingBudgetMinor = totalBudgetMinor - totalActualSpentMinor;

    return {
      tripId,
      currency: baseCurrency,
      totalBudgetMinor,
      totalPlannedCostMinor,
      totalActualSpentMinor,
      remainingBudgetMinor,
      subtotalsByCurrency,
      itineraryItemCount: itineraryItems.length,
      expenseCount: sharedExpenses.length,
    };
  }
}
