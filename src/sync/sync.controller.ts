import { Controller, Post, Get, Body, Query, UseGuards } from "@nestjs/common";
import {
  Controller,
  Post,
  Get,
  Body,
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
import { SyncService } from "./sync.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { PushSyncDto } from "./dto/push-sync.dto";
import { PullSyncDto } from "./dto/pull-sync.dto";

@ApiTags("Sync")
@Controller("sync")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post("push")
  @ApiOperation({ summary: "Push local device changes to the server database" })
  @ApiResponse({ status: 201, description: "Changes recorded successfully" })
  @ApiResponse({ status: 404, description: "Device not found" })
  async pushChanges(@GetUser("id") userId: string, @Body() dto: PushSyncDto) {
    return this.syncService.pushChanges(userId, dto);
  }

  @Post("pull")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Pull change stream from server starting after cursor",
  })
  @ApiResponse({ status: 200, description: "Changes retrieved successfully" })
  @ApiResponse({ status: 404, description: "Device not found" })
  async pullChanges(@GetUser("id") userId: string, @Body() dto: PullSyncDto) {
    return this.syncService.pullChanges(userId, dto);
  }

  @Get("status")
  @ApiOperation({ summary: "Get current synchronization status for a device" })
  @ApiResponse({ status: 200, description: "Sync status returned" })
  @ApiResponse({ status: 404, description: "Device not found" })
  async getSyncStatus(
    @GetUser("id") userId: string,
    @Query("deviceId") deviceId: string,
  ) {
    return this.syncService.getSyncStatus(userId, deviceId);
  }
}
