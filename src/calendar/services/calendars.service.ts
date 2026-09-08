import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { CreateCalendarDto } from "../dto/create-calendar.dto";
import { UpdateCalendarDto } from "../dto/update-calendar.dto";
import { CalendarProvider } from "@prisma/client";

@Injectable()
export class CalendarsService {
  constructor(private readonly prisma: PrismaService) {}

  async createCalendar(userId: string, dto: CreateCalendarDto) {
    if (dto.isPrimary) {
      await this.prisma.calendar.updateMany({
        where: { userId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    return this.prisma.calendar.create({
      data: {
        userId,
        name: dto.name,
        description: dto.description,
        color: dto.color,
        timeZone: dto.timeZone ?? "UTC",
        isPrimary: dto.isPrimary ?? false,
        externalProvider: dto.externalProvider ?? CalendarProvider.LOCAL,
      },
    });
  }

  async getCalendars(userId: string) {
    const calendars = await this.prisma.calendar.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
    });

    if (calendars.length === 0) {
      const defaultCalendar = await this.prisma.calendar.create({
        data: {
          userId,
          name: "Personal",
          description: "Primary Personal Calendar",
          color: "#4285F4",
          timeZone: "UTC",
          isPrimary: true,
          externalProvider: CalendarProvider.LOCAL,
        },
      });
      return [defaultCalendar];
    }

    return calendars;
  }

  async getCalendarById(userId: string, calendarId: string) {
    const calendar = await this.prisma.calendar.findFirst({
      where: { id: calendarId, userId, deletedAt: null },
      include: {
        _count: { select: { events: { where: { deletedAt: null } } } },
      },
    });

    if (!calendar) {
      throw new NotFoundException(
        `Calendar with ID '${calendarId}' not found.`,
      );
    }

    return calendar;
  }

  async updateCalendar(
    userId: string,
    calendarId: string,
    dto: UpdateCalendarDto,
  ) {
    await this.getCalendarById(userId, calendarId);

    if (dto.isPrimary) {
      await this.prisma.calendar.updateMany({
        where: { userId, isPrimary: true, NOT: { id: calendarId } },
        data: { isPrimary: false },
      });
    }

    return this.prisma.calendar.update({
      where: { id: calendarId },
      data: {
        name: dto.name,
        description: dto.description,
        color: dto.color,
        timeZone: dto.timeZone,
        isPrimary: dto.isPrimary,
        externalProvider: dto.externalProvider,
      },
    });
  }

  async deleteCalendar(userId: string, calendarId: string) {
    await this.getCalendarById(userId, calendarId);

    return this.prisma.calendar.update({
      where: { id: calendarId },
      data: { deletedAt: new Date() },
    });
  }
}
