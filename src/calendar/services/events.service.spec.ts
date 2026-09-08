import { Test, TestingModule } from "@nestjs/testing";
import { EventsService } from "./events.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { AttendeeStatus, ChangeOperation, EventStatus } from "@prisma/client";

describe("EventsService", () => {
  let service: EventsService;
  let prismaService: any;

  const userId = "user-uuid-123";
  const calendarId = "calendar-uuid-456";
  const eventId = "event-uuid-789";
  const attendeeEmail = "colleague@example.com";

  const mockCalendar = {
    id: calendarId,
    userId,
    name: "Personal",
    deletedAt: null,
  };

  const startAt = new Date("2026-10-15T14:00:00Z");
  const endAt = new Date("2026-10-15T15:00:00Z");

  const mockEvent = {
    id: eventId,
    userId,
    calendarId,
    title: "Sprint Planning Sync",
    description: "Quarterly roadmap alignment",
    location: "Meeting Room 3",
    startAt,
    endAt,
    isAllDay: false,
    recurrenceRule: "FREQ=MONTHLY",
    status: EventStatus.CONFIRMED,
    color: "#4285F4",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    calendar: mockCalendar,
    attendees: [
      {
        id: "att-1",
        eventId,
        email: attendeeEmail,
        displayName: "Jane Doe",
        status: AttendeeStatus.NEEDS_ACTION,
        isOrganizer: false,
      },
    ],
    reminders: [],
  };

  beforeEach(async () => {
    prismaService = {
      $transaction: jest.fn((cb) => cb(prismaService)),
      calendar: {
        findFirst: jest.fn().mockResolvedValue(mockCalendar),
      },
      event: {
        create: jest.fn().mockResolvedValue(mockEvent),
        findMany: jest.fn().mockResolvedValue([mockEvent]),
        findFirst: jest.fn().mockResolvedValue(mockEvent),
        count: jest.fn().mockResolvedValue(1),
        update: jest
          .fn()
          .mockResolvedValue({ ...mockEvent, title: "Updated Sprint Sync" }),
      },
      eventAttendee: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(mockEvent.attendees[0]),
        update: jest.fn().mockResolvedValue({
          ...mockEvent.attendees[0],
          status: AttendeeStatus.ACCEPTED,
        }),
      },
      change: {
        create: jest.fn().mockResolvedValue({ id: "change-1" }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("createEvent", () => {
    it("should create event with attendees and record sync change event", async () => {
      const result = await service.createEvent(userId, {
        calendarId,
        title: "Sprint Planning Sync",
        startAt,
        endAt,
        attendees: [{ email: attendeeEmail, displayName: "Jane Doe" }],
      });

      expect(result).toBeDefined();
      expect(result.id).toBe(eventId);
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "event",
            operation: ChangeOperation.CREATE,
          }),
        }),
      );
    });

    it("should throw BadRequestException if startAt is on or after endAt", async () => {
      await expect(
        service.createEvent(userId, {
          calendarId,
          title: "Invalid Date Event",
          startAt: endAt,
          endAt: startAt,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw NotFoundException if target calendar is not found", async () => {
      prismaService.calendar.findFirst.mockResolvedValue(null);

      await expect(
        service.createEvent(userId, {
          calendarId: "invalid-cal",
          title: "Test Event",
          startAt,
          endAt,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getEvents", () => {
    it("should return paginated events filtered by date range", async () => {
      const result = await service.getEvents(userId, {
        page: 1,
        limit: 50,
        startFrom: new Date("2026-10-01"),
        startTo: new Date("2026-10-31"),
      });

      expect(result).toBeDefined();
      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
      expect(result.data[0].id).toBe(eventId);
    });
  });

  describe("getEventById", () => {
    it("should return event details if found", async () => {
      const result = await service.getEventById(userId, eventId);
      expect(result.id).toBe(eventId);
    });

    it("should throw NotFoundException if event not found", async () => {
      prismaService.event.findFirst.mockResolvedValue(null);
      await expect(
        service.getEventById(userId, "non-existent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("updateAttendeeRSVP", () => {
    it("should update attendee RSVP status", async () => {
      const result = await service.updateAttendeeRSVP(
        userId,
        eventId,
        attendeeEmail,
        AttendeeStatus.ACCEPTED,
      );

      expect(result).toBeDefined();
      expect(prismaService.eventAttendee.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: AttendeeStatus.ACCEPTED }),
        }),
      );
    });
  });

  describe("deleteEvent", () => {
    it("should soft delete event and record sync change event", async () => {
      const result = await service.deleteEvent(userId, eventId);

      expect(result.success).toBe(true);
      expect(prismaService.event.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ operation: ChangeOperation.DELETE }),
        }),
      );
    });
  });
});
