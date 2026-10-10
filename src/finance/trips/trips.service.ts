import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import { CreateTripDto } from "./dto/create-trip.dto";
import { UpdateTripDto } from "./dto/update-trip.dto";
import { CreateItineraryItemDto } from "./dto/create-itinerary-item.dto";
import { UpdateItineraryItemDto } from "./dto/update-itinerary-item.dto";
import { appendChange } from "@/sync/change-cursor";
import { ChangeOperation } from "@prisma/client";

export function formatTripResponse(trip: any) {
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

export function formatItineraryItemResponse(item: any) {
  return {
    ...item,
    plannedCostMinor:
      item.plannedCostMinor !== null && item.plannedCostMinor !== undefined
        ? Number(item.plannedCostMinor)
        : null,
  };
}

export function tripChangePayload(trip: any): Record<string, any> {
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

export function itineraryChangePayload(item: any): Record<string, any> {
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
        ? BigInt(Math.round(dto.totalBudgetMinor))
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
          baseCurrency: dto.baseCurrency ?? "INR",
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
            ? { baseCurrency: dto.baseCurrency }
            : {}),
          ...(dto.totalBudgetMinor !== undefined
            ? {
                totalBudgetMinor:
                  dto.totalBudgetMinor !== null
                    ? BigInt(Math.round(dto.totalBudgetMinor))
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
    let highestCursor: bigint | undefined;

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.financeTrip.update({
        where: { id: existing.id },
        data: {
          deletedAt: new Date(),
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
        ? BigInt(Math.round(dto.plannedCostMinor))
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
                    ? BigInt(Math.round(dto.plannedCostMinor))
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

    let totalActualSpentMinor = 0;
    for (const exp of sharedExpenses) {
      totalActualSpentMinor += Number(exp.totalAmountMinor);
    }

    const totalBudgetMinor = trip.totalBudgetMinor ?? 0;
    const remainingBudgetMinor = totalBudgetMinor - totalActualSpentMinor;

    return {
      tripId,
      currency: trip.baseCurrency,
      totalBudgetMinor,
      totalPlannedCostMinor,
      totalActualSpentMinor,
      remainingBudgetMinor,
      itineraryItemCount: itineraryItems.length,
      expenseCount: sharedExpenses.length,
    };
  }
}
