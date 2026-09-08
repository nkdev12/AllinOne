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
import { ProjectsService } from "../services/projects.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateProjectDto } from "../dto/create-project.dto";
import { UpdateProjectDto } from "../dto/update-project.dto";
import { CreateSectionDto } from "../dto/create-section.dto";
import { UpdateSectionDto } from "../dto/update-section.dto";

@ApiTags("Projects")
@Controller("projects")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @ApiOperation({ summary: "Create a new project" })
  @ApiResponse({ status: 201, description: "Project created successfully" })
  async createProject(
    @GetUser("id") userId: string,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projectsService.createProject(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List all active projects for current user" })
  @ApiResponse({ status: 200, description: "Projects list returned" })
  async getProjects(@GetUser("id") userId: string) {
    return this.projectsService.getProjects(userId);
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get project details by ID with sections and root tasks",
  })
  @ApiResponse({ status: 200, description: "Project details returned" })
  @ApiResponse({ status: 404, description: "Project not found" })
  async getProjectById(
    @Param("id") projectId: string,
    @GetUser("id") userId: string,
  ) {
    return this.projectsService.getProjectById(userId, projectId);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update project details" })
  @ApiResponse({ status: 200, description: "Project updated successfully" })
  @ApiResponse({ status: 404, description: "Project not found" })
  async updateProject(
    @Param("id") projectId: string,
    @GetUser("id") userId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectsService.updateProject(userId, projectId, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft delete project" })
  @ApiResponse({ status: 200, description: "Project deleted" })
  @ApiResponse({ status: 404, description: "Project not found" })
  async deleteProject(
    @Param("id") projectId: string,
    @GetUser("id") userId: string,
  ) {
    return this.projectsService.deleteProject(userId, projectId);
  }

  // Section Endpoints
  @Post("sections")
  @ApiOperation({ summary: "Create a new section inside a project" })
  @ApiResponse({ status: 201, description: "Section created successfully" })
  async createSection(
    @GetUser("id") userId: string,
    @Body() dto: CreateSectionDto,
  ) {
    return this.projectsService.createSection(userId, dto);
  }

  @Patch("sections/:sectionId")
  @ApiOperation({ summary: "Update section name or sort order" })
  @ApiResponse({ status: 200, description: "Section updated" })
  async updateSection(
    @Param("sectionId") sectionId: string,
    @GetUser("id") userId: string,
    @Body() dto: UpdateSectionDto,
  ) {
    return this.projectsService.updateSection(userId, sectionId, dto);
  }

  @Delete("sections/:sectionId")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete section" })
  @ApiResponse({ status: 200, description: "Section deleted" })
  async deleteSection(
    @Param("sectionId") sectionId: string,
    @GetUser("id") userId: string,
  ) {
    return this.projectsService.deleteSection(userId, sectionId);
  }
}
