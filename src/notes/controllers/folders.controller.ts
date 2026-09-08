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
import { FoldersService } from "../services/folders.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateFolderDto } from "../dto/create-folder.dto";
import { UpdateFolderDto } from "../dto/update-folder.dto";

@ApiTags("Folders")
@Controller("folders")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class FoldersController {
  constructor(private readonly foldersService: FoldersService) {}

  @Post()
  @ApiOperation({ summary: "Create a new note folder" })
  @ApiResponse({ status: 201, description: "Folder created successfully" })
  async createFolder(
    @GetUser("id") userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.foldersService.createFolder(userId, dto);
  }

  @Get()
  @ApiOperation({
    summary: "List all folders for the user (nested tree structure)",
  })
  @ApiResponse({ status: 200, description: "Folder tree returned" })
  async getFolders(@GetUser("id") userId: string) {
    return this.foldersService.getFolders(userId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get folder details by ID" })
  @ApiResponse({ status: 200, description: "Folder details returned" })
  @ApiResponse({ status: 404, description: "Folder not found" })
  async getFolderById(
    @Param("id") folderId: string,
    @GetUser("id") userId: string,
  ) {
    return this.foldersService.getFolderById(userId, folderId);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update folder name, color, icon, or parent" })
  @ApiResponse({ status: 200, description: "Folder updated successfully" })
  @ApiResponse({ status: 404, description: "Folder not found" })
  async updateFolder(
    @Param("id") folderId: string,
    @GetUser("id") userId: string,
    @Body() dto: UpdateFolderDto,
  ) {
    return this.foldersService.updateFolder(userId, folderId, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft delete folder" })
  @ApiResponse({ status: 200, description: "Folder deleted" })
  @ApiResponse({ status: 404, description: "Folder not found" })
  async deleteFolder(
    @Param("id") folderId: string,
    @GetUser("id") userId: string,
  ) {
    return this.foldersService.deleteFolder(userId, folderId);
  }
}
