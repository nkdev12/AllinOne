import { Injectable, NotFoundException } from "@nestjs/common";
import { TaskStatus } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { CreateProjectDto } from "../dto/create-project.dto";
import { UpdateProjectDto } from "../dto/update-project.dto";
import { CreateSectionDto } from "../dto/create-section.dto";
import { UpdateSectionDto } from "../dto/update-section.dto";

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async createProject(userId: string, dto: CreateProjectDto) {
    return this.prisma.project.create({
      data: {
        userId,
        name: dto.name,
        description: dto.description,
        color: dto.color,
        icon: dto.icon,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async getProjects(userId: string) {
    return this.prisma.project.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: {
        sections: { orderBy: { sortOrder: "asc" } },
        _count: {
          select: {
            tasks: {
              where: { deletedAt: null, status: { not: TaskStatus.COMPLETED } },
            },
          },
        },
      },
    });
  }

  async getProjectById(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId, deletedAt: null },
      include: {
        sections: { orderBy: { sortOrder: "asc" } },
        tasks: {
          where: { deletedAt: null, parentId: null },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
          include: {
            subtasks: { where: { deletedAt: null } },
            taskLabels: { include: { tag: true } },
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID '${projectId}' not found.`);
    }

    return project;
  }

  async updateProject(
    userId: string,
    projectId: string,
    dto: UpdateProjectDto,
  ) {
    await this.getProjectById(userId, projectId);

    return this.prisma.project.update({
      where: { id: projectId },
      data: {
        name: dto.name,
        description: dto.description,
        color: dto.color,
        icon: dto.icon,
        sortOrder: dto.sortOrder,
        isArchived: dto.isArchived,
      },
    });
  }

  async deleteProject(userId: string, projectId: string) {
    await this.getProjectById(userId, projectId);

    return this.prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: new Date() },
    });
  }

  // Section Management
  async createSection(userId: string, dto: CreateSectionDto) {
    await this.getProjectById(userId, dto.projectId);

    return this.prisma.section.create({
      data: {
        projectId: dto.projectId,
        name: dto.name,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async updateSection(
    userId: string,
    sectionId: string,
    dto: UpdateSectionDto,
  ) {
    const section = await this.prisma.section.findUnique({
      where: { id: sectionId },
      include: { project: true },
    });

    if (
      !section ||
      section.project.userId !== userId ||
      section.project.deletedAt !== null
    ) {
      throw new NotFoundException(`Section with ID '${sectionId}' not found.`);
    }

    return this.prisma.section.update({
      where: { id: sectionId },
      data: {
        name: dto.name,
        sortOrder: dto.sortOrder,
      },
    });
  }

  async deleteSection(userId: string, sectionId: string) {
    const section = await this.prisma.section.findUnique({
      where: { id: sectionId },
      include: { project: true },
    });

    if (
      !section ||
      section.project.userId !== userId ||
      section.project.deletedAt !== null
    ) {
      throw new NotFoundException(`Section with ID '${sectionId}' not found.`);
    }

    await this.prisma.section.delete({
      where: { id: sectionId },
    });

    return { success: true, message: "Section deleted successfully." };
  }
}
