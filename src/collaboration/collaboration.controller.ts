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
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CollaborationService } from "./collaboration.service";
import {
  CreateShareDto,
  UpdateShareDto,
  QuerySharedResourcesDto,
} from "./dto/collaboration.dto";
import { ResourceType } from "./collaboration.interface";

@ApiTags("Collaboration")
@Controller("collaboration")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class CollaborationController {
  constructor(private readonly collaborationService: CollaborationService) {}

  @Post("shares")
  @ApiOperation({
    summary: "Share a resource (note, project, calendar) with another user",
  })
  @ApiResponse({ status: 201, description: "Resource shared successfully" })
  @ApiResponse({
    status: 403,
    description: "Not permitted to share this resource",
  })
  @ApiResponse({ status: 404, description: "Resource not found" })
  @ApiResponse({
    status: 409,
    description: "Resource already shared or invalid recipient",
  })
  async shareResource(
    @GetUser("id") userId: string,
    @Body() dto: CreateShareDto,
  ) {
    return this.collaborationService.shareResource(userId, dto);
  }

  @Get("shares/:resourceType/:resourceId")
  @ApiOperation({ summary: "List active collaborators for a resource" })
  @ApiResponse({ status: 200, description: "List of collaborators" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  @ApiResponse({ status: 404, description: "Resource not found" })
  async getSharesForResource(
    @GetUser("id") userId: string,
    @Param("resourceType") resourceType: ResourceType,
    @Param("resourceId") resourceId: string,
  ) {
    return this.collaborationService.getSharesForResource(
      userId,
      resourceType,
      resourceId,
    );
  }

  @Patch("shares/:shareId")
  @ApiOperation({ summary: "Update collaborator permission role" })
  @ApiResponse({ status: 200, description: "Share updated successfully" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  @ApiResponse({ status: 404, description: "Share not found" })
  async updateShareRole(
    @GetUser("id") userId: string,
    @Param("shareId") shareId: string,
    @Body() dto: UpdateShareDto,
  ) {
    return this.collaborationService.updateShareRole(userId, shareId, dto);
  }

  @Delete("shares/:shareId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Revoke collaborator access to a shared resource" })
  @ApiResponse({ status: 204, description: "Share revoked successfully" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  @ApiResponse({ status: 404, description: "Share not found" })
  async revokeShare(
    @GetUser("id") userId: string,
    @Param("shareId") shareId: string,
  ) {
    return this.collaborationService.revokeShare(userId, shareId);
  }

  @Get("shared-with-me")
  @ApiOperation({
    summary: "List all resources shared with the authenticated user",
  })
  @ApiResponse({
    status: 200,
    description: "Paginated list of shared resources",
  })
  async getResourcesSharedWithUser(
    @GetUser("id") userId: string,
    @GetUser("email") email: string,
    @Query() query: QuerySharedResourcesDto,
  ) {
    return this.collaborationService.getResourcesSharedWithUser(
      userId,
      email,
      query,
    );
  }
}

