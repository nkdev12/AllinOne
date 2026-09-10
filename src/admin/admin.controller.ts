import {
  Controller,
  Get,
  Post,
  Patch,
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
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { AdminGuard } from "./guards/admin.guard";
import { AdminService } from "./admin.service";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import {
  QueryAdminAuditLogsDto,
  AdminRevokeSessionsDto,
  AdminDisableMfaDto,
  UpdateUserStatusDto,
  AdminUnlockUserDto,
} from "./dto/admin.dto";

@ApiTags("Admin")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller("admin")
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get("audit-logs")
  @ApiOperation({ summary: "Query SIEM security audit logs" })
  @ApiResponse({ status: 200, description: "Paginated audit logs" })
  async getAuditLogs(@Query() query: QueryAdminAuditLogsDto) {
    return this.adminService.queryAuditLogs(query);
  }

  @Post("users/:userId/revoke-sessions")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Force revoke all active sessions for a user (Incident Response)",
  })
  @ApiResponse({ status: 200, description: "Sessions revoked successfully" })
  async revokeSessions(
    @Param("userId") userId: string,
    @GetUser("id") operatorId: string,
    @Body() dto: AdminRevokeSessionsDto,
  ) {
    return this.adminService.revokeUserSessions(
      userId,
      operatorId || "00000000-0000-0000-0000-000000000000",
      dto,
    );
  }

  @Post("users/:userId/disable-mfa")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Administratively reset/disable MFA for a locked-out user",
  })
  @ApiResponse({ status: 200, description: "MFA disabled successfully" })
  async disableMfa(
    @Param("userId") userId: string,
    @GetUser("id") operatorId: string,
    @Body() dto: AdminDisableMfaDto,
  ) {
    return this.adminService.disableUserMfa(
      userId,
      operatorId || "00000000-0000-0000-0000-000000000000",
      dto,
    );
  }

  @Patch("users/:userId/status")
  @ApiOperation({
    summary: "Update user account status (ACTIVE, SUSPENDED, DELETED)",
  })
  @ApiResponse({ status: 200, description: "User status updated successfully" })
  async updateUserStatus(
    @Param("userId") userId: string,
    @GetUser("id") operatorId: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.adminService.updateUserStatus(
      userId,
      operatorId || "00000000-0000-0000-0000-000000000000",
      dto,
    );
  }

  @Get("users/:userId/overview")
  @ApiOperation({ summary: "Get complete security overview for a user" })
  @ApiResponse({ status: 200, description: "User security posture overview" })
  async getUserOverview(@Param("userId") userId: string) {
    return this.adminService.getUserOverview(userId);
  }

  @Post("users/:userId/unlock")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Administratively unlock a locked user account" })
  @ApiResponse({
    status: 200,
    description: "User account unlocked successfully",
  })
  async unlockUser(
    @Param("userId") userId: string,
    @GetUser("id") operatorId: string,
    @Body() dto: AdminUnlockUserDto,
  ) {
    return this.adminService.unlockUserAccount(
      userId,
      operatorId || "00000000-0000-0000-0000-000000000000",
      dto?.reason,
    );
  }
}
