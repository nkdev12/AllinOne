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
import { DevicesService } from "./devices.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateDeviceDto } from "./dto/create-device.dto";
import { UpdateDeviceDto } from "./dto/update-device.dto";

@ApiTags("Devices")
@Controller("devices")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @Get()
  @ApiOperation({
    summary: "List all registered active devices for the current user",
  })
  @ApiResponse({ status: 200, description: "List of registered devices" })
  async getDevices(@GetUser("id") userId: string) {
    return this.devicesService.getDevicesByUser(userId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get details of a specific device" })
  @ApiResponse({ status: 200, description: "Device details" })
  @ApiResponse({ status: 404, description: "Device not found" })
  async getDeviceById(
    @Param("id") deviceId: string,
    @GetUser("id") userId: string,
  ) {
    return this.devicesService.getDeviceById(deviceId, userId);
  }

  @Post()
  @ApiOperation({ summary: "Register a new device" })
  @ApiResponse({ status: 201, description: "Device successfully registered" })
  async registerDevice(
    @GetUser("id") userId: string,
    @Body() dto: CreateDeviceDto,
  ) {
    return this.devicesService.registerDevice(userId, dto);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Update device details (name, public key, app version)",
  })
  @ApiResponse({ status: 200, description: "Device details updated" })
  @ApiResponse({ status: 404, description: "Device not found" })
  async updateDevice(
    @Param("id") deviceId: string,
    @GetUser("id") userId: string,
    @Body() dto: UpdateDeviceDto,
  ) {
    return this.devicesService.updateDevice(deviceId, userId, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke device access and its associated sessions" })
  @ApiResponse({ status: 200, description: "Device access revoked" })
  @ApiResponse({ status: 404, description: "Device not found" })
  async revokeDevice(
    @Param("id") deviceId: string,
    @GetUser("id") userId: string,
  ) {
    return this.devicesService.revokeDevice(deviceId, userId);
  }
}
