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
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { TripsService } from "./trips.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateTripDto } from "./dto/create-trip.dto";
import { UpdateTripDto } from "./dto/update-trip.dto";
import { CreateItineraryItemDto } from "./dto/create-itinerary-item.dto";
import { UpdateItineraryItemDto } from "./dto/update-itinerary-item.dto";

@ApiTags("Finance Trips & Travel Mode")
@Controller("finance/trips")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Post()
  @ApiOperation({ summary: "Create a new travel trip" })
  @ApiResponse({ status: 201, description: "Trip created successfully" })
  async createTrip(
    @GetUser("id") userId: string,
    @Body() dto: CreateTripDto,
  ) {
    return this.tripsService.createTrip(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List all travel trips for user" })
  @ApiQuery({ name: "includeArchived", required: false, type: Boolean })
  @ApiResponse({ status: 200, description: "List of trips" })
  async getTrips(
    @GetUser("id") userId: string,
    @Query("includeArchived") includeArchived?: string,
  ) {
    return this.tripsService.getTrips(userId, includeArchived === "true");
  }

  @Get(":id")
  @ApiOperation({ summary: "Get travel trip details with itinerary" })
  @ApiResponse({ status: 200, description: "Trip details" })
  @ApiResponse({ status: 404, description: "Trip not found" })
  async getTripById(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.tripsService.getTripById(userId, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update travel trip details" })
  @ApiResponse({ status: 200, description: "Trip updated successfully" })
  @ApiResponse({ status: 404, description: "Trip not found" })
  async updateTrip(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateTripDto,
  ) {
    return this.tripsService.updateTrip(userId, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a travel trip (soft delete)" })
  @ApiResponse({ status: 204, description: "Trip deleted successfully" })
  @ApiResponse({ status: 404, description: "Trip not found" })
  async deleteTrip(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.tripsService.deleteTrip(userId, id);
  }

  @Get(":id/stats")
  @ApiOperation({ summary: "Get trip budget vs actual spent stats" })
  @ApiResponse({ status: 200, description: "Trip stats" })
  async getTripStats(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.tripsService.getTripStats(userId, id);
  }

  // -------------------------------------------------------------
  // Itinerary Items
  // -------------------------------------------------------------

  @Post(":id/itinerary")
  @ApiOperation({ summary: "Add an itinerary item to trip" })
  @ApiResponse({ status: 201, description: "Itinerary item created" })
  async addItineraryItem(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) tripId: string,
    @Body() dto: CreateItineraryItemDto,
  ) {
    return this.tripsService.addItineraryItem(userId, tripId, dto);
  }

  @Get(":id/itinerary")
  @ApiOperation({ summary: "List itinerary items for a trip" })
  @ApiResponse({ status: 200, description: "List of itinerary items" })
  async getTripItinerary(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) tripId: string,
  ) {
    return this.tripsService.getTripItinerary(userId, tripId);
  }

  @Patch(":id/itinerary/:itemId")
  @ApiOperation({ summary: "Update an itinerary item" })
  @ApiResponse({ status: 200, description: "Itinerary item updated" })
  async updateItineraryItem(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) tripId: string,
    @Param("itemId", ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateItineraryItemDto,
  ) {
    return this.tripsService.updateItineraryItem(userId, tripId, itemId, dto);
  }

  @Delete(":id/itinerary/:itemId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete an itinerary item" })
  @ApiResponse({ status: 204, description: "Itinerary item deleted" })
  async deleteItineraryItem(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) tripId: string,
    @Param("itemId", ParseUUIDPipe) itemId: string,
  ) {
    return this.tripsService.deleteItineraryItem(userId, tripId, itemId);
  }
}
