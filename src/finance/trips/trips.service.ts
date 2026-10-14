import { Injectable, NotFoundException, Optional } from "@nestjs/common";
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
import { ChangeOperation } from "@prisma/client";

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

@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly syncNotifications?: SyncNotificationService,
  ) {}

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
    const trips = await this.prisma.financeTrip.findMany({
      where: {
        ownerId: userId,
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

  async getTripById(userId: string, tripId: string) {
    const trip = await this.prisma.financeTrip.findFirst({
      where: {
        id: tripId,
        ownerId: userId,
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

    return formatTripResponse(trip);
  }

  async updateTrip(userId: string, tripId: string, dto: UpdateTripDto) {
    const existing = await this.getTripById(userId, tripId);
    let highestCursor: bigint | undefined;

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

      const logged = await appendChange(tx, {
        entityType: "finance_trip",
        entityId: trip.id,
        operation: ChangeOperation.UPDATE,
        version: trip.version,
        payload: tripChangePayload(trip),
        userId,
      });
      highestCursor = logged.cursor;

      return trip;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatTripResponse(updated);
  }

  async deleteTrip(userId: string, tripId: string) {
    const existing = await this.getTripById(userId, tripId);
    const deletedAt = new Date();
    let highestCursor: bigint | undefined;

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.financeTrip.update({
        where: { id: existing.id },
        data: {
          deletedAt,
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_trip",
        entityId: existing.id,
        operation: ChangeOperation.DELETE,
        version: updated.version,
        payload: {},
        userId,
      });
      highestCursor = logged.cursor;

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

      for (const item of itineraryItems) {
        const child = await tx.financeTripItinerary.update({
          where: { id: item.id },
          data: { deletedAt, version: { increment: 1 } },
        });
        const childLogged = await appendChange(tx, {
          entityType: "finance_trip_itinerary",
          entityId: item.id,
          operation: ChangeOperation.DELETE,
          version: child.version,
          payload: {},
          userId,
        });
        highestCursor = childLogged.cursor;
      }

      for (const expense of sharedExpenses) {
        const child = await tx.financeSharedExpense.update({
          where: { id: expense.id },
          data: { deletedAt, version: { increment: 1 } },
        });
        const childLogged = await appendChange(tx, {
          entityType: "finance_shared_expense",
          entityId: expense.id,
          operation: ChangeOperation.DELETE,
          version: child.version,
          payload: {},
          userId,
        });
        highestCursor = childLogged.cursor;
      }

      for (const settlement of settlements) {
        const child = await tx.financeSettlement.update({
          where: { id: settlement.id },
          data: { deletedAt, version: { increment: 1 } },
        });
        const childLogged = await appendChange(tx, {
          entityType: "finance_settlement",
          entityId: settlement.id,
          operation: ChangeOperation.DELETE,
          version: child.version,
          payload: {},
          userId,
        });
        highestCursor = childLogged.cursor;
      }
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return { success: true };
  }

  // -------------------------------------------------------------
  // Itinerary Item CRUD
  // -------------------------------------------------------------

  async addItineraryItem(
    userId: string,
    tripId: string,
    dto: CreateItineraryItemDto,
  ) {
    await this.getTripById(userId, tripId);
    const plannedCostMinor =
      dto.plannedCostMinor !== undefined && dto.plannedCostMinor !== null
        ? toMinorUnits(dto.plannedCostMinor, "plannedCostMinor")
        : null;

    let highestCursor: bigint | undefined;

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

      const logged = await appendChange(tx, {
        entityType: "finance_trip_itinerary",
        entityId: created.id,
        operation: ChangeOperation.CREATE,
        version: created.version,
        payload: itineraryChangePayload(created),
        userId,
      });
      highestCursor = logged.cursor;

      return created;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatItineraryItemResponse(item);
  }

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
    await this.getTripById(userId, tripId);

    const existing = await this.prisma.financeTripItinerary.findFirst({
      where: { id: itemId, tripId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException("Itinerary item not found");
    }

    let highestCursor: bigint | undefined;

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

      const logged = await appendChange(tx, {
        entityType: "finance_trip_itinerary",
        entityId: item.id,
        operation: ChangeOperation.UPDATE,
        version: item.version,
        payload: itineraryChangePayload(item),
        userId,
      });
      highestCursor = logged.cursor;

      return item;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

    return formatItineraryItemResponse(updated);
  }

  async deleteItineraryItem(userId: string, tripId: string, itemId: string) {
    await this.getTripById(userId, tripId);

    const existing = await this.prisma.financeTripItinerary.findFirst({
      where: { id: itemId, tripId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException("Itinerary item not found");
    }

    let highestCursor: bigint | undefined;

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.financeTripItinerary.update({
        where: { id: itemId },
        data: {
          deletedAt: new Date(),
          version: { increment: 1 },
        },
      });

      const logged = await appendChange(tx, {
        entityType: "finance_trip_itinerary",
        entityId: itemId,
        operation: ChangeOperation.DELETE,
        version: updated.version,
        payload: {},
        userId,
      });
      highestCursor = logged.cursor;
    });

    this.syncNotifications?.notifyMutation({ userId, highestCursor });

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
