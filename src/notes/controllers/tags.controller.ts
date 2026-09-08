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
import { TagsService } from "../services/tags.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateTagDto } from "../dto/create-tag.dto";
import { UpdateTagDto } from "../dto/update-tag.dto";

@ApiTags("Tags")
@Controller("tags")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Post()
  @ApiOperation({ summary: "Create a new tag" })
  @ApiResponse({ status: 201, description: "Tag created successfully" })
  @ApiResponse({ status: 409, description: "Tag name already exists" })
  async createTag(@GetUser("id") userId: string, @Body() dto: CreateTagDto) {
    return this.tagsService.createTag(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List all tags for current user" })
  @ApiResponse({ status: 200, description: "Tags list returned" })
  async getTags(@GetUser("id") userId: string) {
    return this.tagsService.getTags(userId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get tag details by ID" })
  @ApiResponse({ status: 200, description: "Tag details returned" })
  @ApiResponse({ status: 404, description: "Tag not found" })
  async getTagById(@Param("id") tagId: string, @GetUser("id") userId: string) {
    return this.tagsService.getTagById(userId, tagId);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update tag name or color" })
  @ApiResponse({ status: 200, description: "Tag updated successfully" })
  @ApiResponse({ status: 404, description: "Tag not found" })
  async updateTag(
    @Param("id") tagId: string,
    @GetUser("id") userId: string,
    @Body() dto: UpdateTagDto,
  ) {
    return this.tagsService.updateTag(userId, tagId, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete tag" })
  @ApiResponse({ status: 200, description: "Tag deleted" })
  @ApiResponse({ status: 404, description: "Tag not found" })
  async deleteTag(@Param("id") tagId: string, @GetUser("id") userId: string) {
    return this.tagsService.deleteTag(userId, tagId);
  }
}
