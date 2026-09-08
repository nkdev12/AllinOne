import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
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
import { CalendarsService } from "../services/calendars.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateCalendarDto } from "../dto/create-calendar.dto";
import { UpdateCalendarDto } from "../dto/update-calendar.dto";

@ApiTags("Calendars")
@Controller("calendars")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class CalendarsController {
  constructor(private readonly calendarsService: CalendarsService) {}

  @Post()
  @ApiOperation({ summary: "Create a new user calendar" })
  @ApiResponse({ status: 201, description: "Calendar created successfully" })
  async createCalendar(
    @GetUser("id") userId: string,
    @Body() dto: CreateCalendarDto,
  ) {
    return this.calendarsService.createCalendar(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List all active calendars for current user" })
  @ApiResponse({ status: 200, description: "Calendars list returned" })
  async getCalendars(@GetUser("id") userId: string) {
    return this.calendarsService.getCalendars(userId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get calendar details by ID" })
  @ApiResponse({ status: 200, description: "Calendar details returned" })
  @ApiResponse({ status: 404, description: "Calendar not found" })
  async getCalendarById(
    @Param("id") calendarId: string,
    @GetUser("id") userId: string,
  ) {
    return this.calendarsService.getCalendarById(userId, calendarId);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update calendar attributes" })
  @ApiResponse({ status: 200, description: "Calendar updated successfully" })
  @ApiResponse({ status: 404, description: "Calendar not found" })
  async updateCalendar(
    @Param("id") calendarId: string,
    @GetUser("id") userId: string,
    @Body() dto: UpdateCalendarDto,
  ) {
    return this.calendarsService.updateCalendar(userId, calendarId, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft delete calendar" })
  @ApiResponse({ status: 200, description: "Calendar deleted" })
  @ApiResponse({ status: 404, description: "Calendar not found" })
  async deleteCalendar(
    @Param("id") calendarId: string,
    @GetUser("id") userId: string,
  ) {
    return this.calendarsService.deleteCalendar(userId, calendarId);
  }
}
