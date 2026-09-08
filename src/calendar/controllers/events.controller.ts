import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { EventsService } from "../services/events.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateEventDto } from "../dto/create-event.dto";
import { UpdateEventDto } from "../dto/update-event.dto";
import { QueryEventsDto } from "../dto/query-events.dto";
import { CreateEventReminderDto } from "../dto/create-event-reminder.dto";
import { AttendeeStatus } from "@prisma/client";

@ApiTags("Events")
@Controller("events")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @ApiOperation({ summary: "Create a new calendar event" })
  @ApiResponse({ status: 201, description: "Event created successfully" })
  async createEvent(
    @GetUser("id") userId: string,
    @Body() dto: CreateEventDto,
  ) {
    return this.eventsService.createEvent(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List and search user events within a date range" })
  @ApiResponse({ status: 200, description: "Paginated events list returned" })
  async getEvents(
    @GetUser("id") userId: string,
    @Query() query: QueryEventsDto,
  ) {
    return this.eventsService.getEvents(userId, query);
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get event details by ID with attendees and reminders",
  })
  @ApiResponse({ status: 200, description: "Event details returned" })
  @ApiResponse({ status: 404, description: "Event not found" })
  async getEventById(
    @Param("id") eventId: string,
    @GetUser("id") userId: string,
  ) {
    return this.eventsService.getEventById(userId, eventId);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update event details" })
  @ApiResponse({ status: 200, description: "Event updated successfully" })
  @ApiResponse({ status: 404, description: "Event not found" })
  async updateEvent(
    @Param("id") eventId: string,
    @GetUser("id") userId: string,
    @Body() dto: UpdateEventDto,
  ) {
    return this.eventsService.updateEvent(userId, eventId, dto);
  }

  @Patch(":id/rsvp")
  @ApiOperation({ summary: "Update attendee RSVP status" })
  @ApiResponse({ status: 200, description: "RSVP updated" })
  async updateRSVP(
    @Param("id") eventId: string,
    @GetUser("id") userId: string,
    @Body("email") email: string,
    @Body("status") status: AttendeeStatus,
  ) {
    return this.eventsService.updateAttendeeRSVP(
      userId,
      eventId,
      email,
      status,
    );
  }

  @Post(":id/reminders")
  @ApiOperation({ summary: "Add a reminder notification to an event" })
  @ApiResponse({ status: 201, description: "Event reminder added" })
  async addReminder(
    @Param("id") eventId: string,
    @GetUser("id") userId: string,
    @Body() dto: CreateEventReminderDto,
  ) {
    return this.eventsService.addEventReminder(userId, eventId, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft delete event" })
  @ApiResponse({ status: 200, description: "Event deleted" })
  @ApiResponse({ status: 404, description: "Event not found" })
  async deleteEvent(
    @Param("id") eventId: string,
    @GetUser("id") userId: string,
  ) {
    return this.eventsService.deleteEvent(userId, eventId);
  }
}
