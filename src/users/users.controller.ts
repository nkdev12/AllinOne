import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  NotFoundException,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { UpdateUserProfileDto } from "./dto/update-user-profile.dto";

@ApiTags("Users")
@Controller("users")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get("me")
  @ApiOperation({ summary: "Get profile of current authenticated user" })
  @ApiResponse({ status: 200, description: "Current user profile details" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getProfile(@GetUser("id") userId: string) {
    const user = await this.usersService.getUserById(userId);
    if (!user) {
      throw new NotFoundException("User profile not found");
    }
    return this.usersService.sanitizeUser(user);
  }

  @Patch("me")
  @ApiOperation({
    summary: "Update profile details (displayName, avatar, locale, timezone)",
  })
  @ApiResponse({ status: 200, description: "Updated user profile" })
  async updateProfile(
    @GetUser("id") userId: string,
    @Body() dto: UpdateUserProfileDto,
  ) {
    const updated = await this.usersService.updateProfile(userId, dto);
    return this.usersService.sanitizeUser(updated);
  }

  @Post("me/export")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: "Request GDPR/CCPA data export package" })
  @ApiResponse({
    status: 202,
    description: "Export request accepted and queued",
  })
  async requestDataExport(@GetUser("id") userId: string) {
    return this.usersService.requestDataExport(userId);
  }

  @Delete("me")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft delete account and revoke all sessions" })
  @ApiResponse({ status: 200, description: "Account successfully deleted" })
  async softDeleteAccount(@GetUser("id") userId: string) {
    return this.usersService.softDeleteAccount(userId);
  }

  @Get("me/sessions")
  @ApiOperation({ summary: "Get all active sessions for current user" })
  @ApiResponse({ status: 200, description: "List of active user sessions" })
  async getUserSessions(@GetUser("id") userId: string) {
    return this.usersService.getUserSessions(userId);
  }

  @Delete("me/sessions/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke a specific active session" })
  @ApiResponse({ status: 200, description: "Session revoked" })
  @ApiResponse({ status: 404, description: "Session not found" })
  async revokeSession(
    @GetUser("id") userId: string,
    @Param("id") sessionId: string,
  ) {
    return this.usersService.revokeUserSession(userId, sessionId);
  }
}
