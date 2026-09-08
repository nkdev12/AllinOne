import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { CreateEventDto } from "../dto/create-event.dto";
import { UpdateEventDto } from "../dto/update-event.dto";
import { QueryEventsDto } from "../dto/query-events.dto";
import { CreateEventReminderDto } from "../dto/create-event-reminder.dto";
import {
  AttendeeStatus,
  ChangeOperation,
  EventStatus,
  ReminderChannel,
} from "@prisma/client";

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  async createEvent(userId: string, dto: CreateEventDto) {
    const calendar = await this.prisma.calendar.findFirst({
      where: { id: dto.calendarId, userId, deletedAt: null },
    });

    if (!calendar) {
      throw new NotFoundException(
        `Calendar with ID '${dto.calendarId}' not found.`,
      );
    }

    if (dto.startAt >= dto.endAt) {
      throw new BadRequestException(
        "Event endAt timestamp must be strictly after startAt timestamp.",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const event = await tx.event.create({
        data: {
          userId,
          calendarId: dto.calendarId,
          title: dto.title,
          description: dto.description,
          location: dto.location,
          startAt: dto.startAt,
          endAt: dto.endAt,
          isAllDay: dto.isAllDay ?? false,
          recurrenceRule: dto.recurrenceRule,
          status: dto.status ?? EventStatus.CONFIRMED,
          color: dto.color,
          attendees:
            dto.attendees && dto.attendees.length > 0
              ? {
                  createMany: {
                    data: dto.attendees.map((att) => ({
                      email: att.email,
                      displayName: att.displayName,
                      status: att.status ?? AttendeeStatus.NEEDS_ACTION,
                      isOrganizer: att.isOrganizer ?? false,
                    })),
                  },
                }
              : undefined,
        },
        include: {
          calendar: true,
          attendees: true,
          reminders: true,
        },
      });

      await tx.change.create({
        data: {
          userId,
          entityType: "event",
          entityId: event.id,
          operation: ChangeOperation.CREATE,
          version: 1,
          payload: {
            title: event.title,
            calendarId: event.calendarId,
            startAt: event.startAt,
            endAt: event.endAt,
            isAllDay: event.isAllDay,
          },
        },
      });

      return event;
    });
  }

  async getEvents(userId: string, query: QueryEventsDto) {
    const page = query.page || 1;
    const limit = query.limit || 50;
    const skip = (page - 1) * limit;

    const where: any = {
      userId,
      deletedAt: null,
    };

    if (query.calendarId) {
      where.calendarId = query.calendarId;
    }

    if (query.startFrom || query.startTo) {
      where.AND = [];
      if (query.startFrom) {
        where.AND.push({ endAt: { gte: query.startFrom } });
      }
      if (query.startTo) {
        where.AND.push({ startAt: { lte: query.startTo } });
      }
    }

    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: "insensitive" } },
        { description: { contains: query.search, mode: "insensitive" } },
        { location: { contains: query.search, mode: "insensitive" } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.event.count({ where }),
      this.prisma.event.findMany({
        where,
        skip,
        take: limit,
        orderBy: { startAt: "asc" },
        include: {
          calendar: true,
          attendees: true,
          reminders: true,
        },
      }),
    ]);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getEventById(userId: string, eventId: string) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, userId, deletedAt: null },
      include: {
        calendar: true,
        attendees: true,
        reminders: true,
      },
    });

    if (!event) {
      throw new NotFoundException(`Event with ID '${eventId}' not found.`);
    }

    return event;
  }

  async updateEvent(userId: string, eventId: string, dto: UpdateEventDto) {
    const existing = await this.prisma.event.findFirst({
      where: { id: eventId, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Event with ID '${eventId}' not found.`);
    }

    const startAt = dto.startAt ?? existing.startAt;
    const endAt = dto.endAt ?? existing.endAt;

    if (startAt >= endAt) {
      throw new BadRequestException(
        "Event endAt timestamp must be strictly after startAt timestamp.",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.attendees !== undefined) {
        await tx.eventAttendee.deleteMany({ where: { eventId: existing.id } });
        if (dto.attendees.length > 0) {
          await tx.eventAttendee.createMany({
            data: dto.attendees.map((att) => ({
              eventId: existing.id,
              email: att.email,
              displayName: att.displayName,
              status: att.status ?? AttendeeStatus.NEEDS_ACTION,
              isOrganizer: att.isOrganizer ?? false,
            })),
          });
        }
      }

      const updatedEvent = await tx.event.update({
        where: { id: existing.id },
        data: {
          calendarId: dto.calendarId,
          title: dto.title,
          description: dto.description,
          location: dto.location,
          startAt: dto.startAt,
          endAt: dto.endAt,
          isAllDay: dto.isAllDay,
          recurrenceRule: dto.recurrenceRule,
          status: dto.status,
          color: dto.color,
        },
        include: {
          calendar: true,
          attendees: true,
          reminders: true,
        },
      });

      await tx.change.create({
        data: {
          userId,
          entityType: "event",
          entityId: updatedEvent.id,
          operation: ChangeOperation.UPDATE,
          version: 1,
          payload: {
            title: updatedEvent.title,
            startAt: updatedEvent.startAt,
            endAt: updatedEvent.endAt,
            status: updatedEvent.status,
          },
        },
      });

      return updatedEvent;
    });
  }

  async updateAttendeeRSVP(
    userId: string,
    eventId: string,
    attendeeEmail: string,
    status: AttendeeStatus,
  ) {
    const event = await this.getEventById(userId, eventId);

    const attendee = await this.prisma.eventAttendee.findFirst({
      where: { eventId: event.id, email: attendeeEmail },
    });

    if (!attendee) {
      throw new NotFoundException(
        `Attendee with email '${attendeeEmail}' not found for event.`,
      );
    }

    return this.prisma.eventAttendee.update({
      where: { id: attendee.id },
      data: { status },
    });
  }

  async addEventReminder(
    userId: string,
    eventId: string,
    dto: CreateEventReminderDto,
  ) {
    const event = await this.getEventById(userId, eventId);

    return this.prisma.eventReminder.create({
      data: {
        eventId: event.id,
        userId,
        minutesBefore: dto.minutesBefore ?? 15,
        channel: dto.channel ?? ReminderChannel.NOTIFICATION,
      },
    });
  }

  async deleteEvent(userId: string, eventId: string) {
    const existing = await this.prisma.event.findFirst({
      where: { id: eventId, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Event with ID '${eventId}' not found.`);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.event.update({
        where: { id: eventId },
        data: { deletedAt: new Date() },
      });

      await tx.change.create({
        data: {
          userId,
          entityType: "event",
          entityId: eventId,
          operation: ChangeOperation.DELETE,
          version: 1,
          payload: { id: eventId },
        },
      });

      return { success: true, message: "Event deleted successfully." };
    });
  }
}
