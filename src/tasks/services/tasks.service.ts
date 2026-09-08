import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { CreateTaskDto } from "../dto/create-task.dto";
import { UpdateTaskDto } from "../dto/update-task.dto";
import { QueryTasksDto } from "../dto/query-tasks.dto";
import { ChangeOperation, TaskStatus } from "@prisma/client";

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  async createTask(userId: string, dto: CreateTaskDto) {
    if (dto.projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: dto.projectId, userId, deletedAt: null },
      });
      if (!project) {
        throw new NotFoundException(
          `Project with ID '${dto.projectId}' not found.`,
        );
      }
    }

    if (dto.parentId) {
      const parentTask = await this.prisma.task.findFirst({
        where: { id: dto.parentId, userId, deletedAt: null },
      });
      if (!parentTask) {
        throw new NotFoundException(
          `Parent task with ID '${dto.parentId}' not found.`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          userId,
          title: dto.title,
          description: dto.description,
          projectId: dto.projectId,
          sectionId: dto.sectionId,
          parentId: dto.parentId,
          priority: dto.priority,
          status: dto.status ?? TaskStatus.TODO,
          dueDate: dto.dueDate,
          dueTime: dto.dueTime,
          recurrenceRule: dto.recurrenceRule,
          sortOrder: dto.sortOrder ?? 0,
          taskLabels:
            dto.tagIds && dto.tagIds.length > 0
              ? {
                  createMany: {
                    data: dto.tagIds.map((tagId) => ({ tagId })),
                  },
                }
              : undefined,
        },
        include: {
          project: true,
          section: true,
          taskLabels: { include: { tag: true } },
          subtasks: { where: { deletedAt: null } },
        },
      });

      await tx.change.create({
        data: {
          userId,
          entityType: "task",
          entityId: task.id,
          operation: ChangeOperation.CREATE,
          version: 1,
          payload: {
            title: task.title,
            projectId: task.projectId,
            priority: task.priority,
            status: task.status,
            dueDate: task.dueDate,
          },
        },
      });

      return this.formatTaskResponse(task);
    });
  }

  async getTasks(userId: string, query: QueryTasksDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {
      userId,
      deletedAt: null,
    };

    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: "insensitive" } },
        { description: { contains: query.search, mode: "insensitive" } },
      ];
    }

    if (query.projectId) where.projectId = query.projectId;
    if (query.sectionId) where.sectionId = query.sectionId;
    if (query.priority) where.priority = query.priority;
    if (query.status) where.status = query.status;
    if (query.isCompleted !== undefined) {
      where.status = query.isCompleted
        ? TaskStatus.COMPLETED
        : { not: TaskStatus.COMPLETED };
    }

    if (query.dueBefore || query.dueAfter) {
      where.dueDate = {};
      if (query.dueBefore) where.dueDate.lte = query.dueBefore;
      if (query.dueAfter) where.dueDate.gte = query.dueAfter;
    }

    if (query.tagId) {
      where.taskLabels = {
        some: { tagId: query.tagId },
      };
    }

    const [total, items] = await Promise.all([
      this.prisma.task.count({ where }),
      this.prisma.task.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          { priority: "asc" },
          { dueDate: "asc" },
          { sortOrder: "asc" },
        ],
        include: {
          project: true,
          section: true,
          taskLabels: { include: { tag: true } },
          subtasks: { where: { deletedAt: null } },
          reminders: true,
        },
      }),
    ]);

    return {
      data: items.map(this.formatTaskResponse),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTaskById(userId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, userId, deletedAt: null },
      include: {
        project: true,
        section: true,
        parent: true,
        subtasks: {
          where: { deletedAt: null },
          include: { taskLabels: { include: { tag: true } } },
        },
        taskLabels: { include: { tag: true } },
        reminders: true,
      },
    });

    if (!task) {
      throw new NotFoundException(`Task with ID '${taskId}' not found.`);
    }

    return this.formatTaskResponse(task);
  }

  async updateTask(userId: string, taskId: string, dto: UpdateTaskDto) {
    const existing = await this.prisma.task.findFirst({
      where: { id: taskId, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Task with ID '${taskId}' not found.`);
    }

    if (dto.parentId) {
      if (dto.parentId === taskId) {
        throw new BadRequestException("A task cannot be its own subtask.");
      }

      let currentParentId: string | null = dto.parentId;
      while (currentParentId) {
        if (currentParentId === taskId) {
          throw new BadRequestException(
            "Cyclic parent task assignment is not allowed.",
          );
        }
        const ancestor: { parentId: string | null } | null =
          await this.prisma.task.findFirst({
            where: { id: currentParentId, userId, deletedAt: null },
            select: { parentId: true },
          });
        currentParentId = ancestor?.parentId || null;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.tagIds !== undefined) {
        await tx.taskLabel.deleteMany({ where: { taskId: existing.id } });
        if (dto.tagIds.length > 0) {
          await tx.taskLabel.createMany({
            data: dto.tagIds.map((tagId) => ({ taskId: existing.id, tagId })),
          });
        }
      }

      const status =
        dto.status !== undefined
          ? dto.status
          : dto.isCompleted !== undefined
            ? dto.isCompleted
              ? TaskStatus.COMPLETED
              : TaskStatus.TODO
            : undefined;

      const isCompleted =
        status !== undefined ? status === TaskStatus.COMPLETED : undefined;

      const updatedTask = await tx.task.update({
        where: { id: existing.id },
        data: {
          title: dto.title,
          description: dto.description,
          projectId: dto.projectId,
          sectionId: dto.sectionId,
          parentId: dto.parentId,
          priority: dto.priority,
          status,
          dueDate: dto.dueDate,
          dueTime: dto.dueTime,
          recurrenceRule: dto.recurrenceRule,
          completedAt:
            isCompleted === true
              ? new Date()
              : isCompleted === false
                ? null
                : undefined,
          sortOrder: dto.sortOrder,
        },
        include: {
          project: true,
          section: true,
          taskLabels: { include: { tag: true } },
          subtasks: { where: { deletedAt: null } },
        },
      });

      await tx.change.create({
        data: {
          userId,
          entityType: "task",
          entityId: updatedTask.id,
          operation: ChangeOperation.UPDATE,
          version: 1,
          payload: {
            title: updatedTask.title,
            priority: updatedTask.priority,
            status: updatedTask.status,
            isCompleted: updatedTask.status === TaskStatus.COMPLETED,
          },
        },
      });

      return this.formatTaskResponse(updatedTask);
    });
  }

  async completeTask(userId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, userId, deletedAt: null },
      include: { taskLabels: true },
    });

    if (!task) {
      throw new NotFoundException(`Task with ID '${taskId}' not found.`);
    }

    return this.prisma.$transaction(async (tx) => {
      const completedTask = await tx.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.COMPLETED,
          completedAt: new Date(),
        },
        include: {
          project: true,
          section: true,
          taskLabels: { include: { tag: true } },
        },
      });

      await tx.change.create({
        data: {
          userId,
          entityType: "task",
          entityId: completedTask.id,
          operation: ChangeOperation.UPDATE,
          version: 1,
          payload: {
            id: completedTask.id,
            isCompleted: true,
            status: TaskStatus.COMPLETED,
          },
        },
      });

      let nextRecurringTask = null;
      if (task.recurrenceRule) {
        const nextDueDate = this.calculateNextRecurrenceDate(
          task.dueDate || new Date(),
          task.recurrenceRule,
        );

        nextRecurringTask = await tx.task.create({
          data: {
            userId,
            title: task.title,
            description: task.description,
            projectId: task.projectId,
            sectionId: task.sectionId,
            parentId: task.parentId,
            priority: task.priority,
            status: TaskStatus.TODO,
            dueDate: nextDueDate,
            dueTime: task.dueTime,
            recurrenceRule: task.recurrenceRule,
            sortOrder: task.sortOrder,
            taskLabels:
              task.taskLabels.length > 0
                ? {
                    createMany: {
                      data: task.taskLabels.map((tl) => ({ tagId: tl.tagId })),
                    },
                  }
                : undefined,
          },
          include: {
            project: true,
            section: true,
            taskLabels: { include: { tag: true } },
          },
        });

        await tx.change.create({
          data: {
            userId,
            entityType: "task",
            entityId: nextRecurringTask.id,
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: {
              title: nextRecurringTask.title,
              dueDate: nextRecurringTask.dueDate,
              isRecurringInstance: true,
            },
          },
        });
      }

      return {
        completedTask: this.formatTaskResponse(completedTask),
        nextRecurringTask: nextRecurringTask
          ? this.formatTaskResponse(nextRecurringTask)
          : null,
      };
    });
  }

  async deleteTask(userId: string, taskId: string) {
    const existing = await this.prisma.task.findFirst({
      where: { id: taskId, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException(`Task with ID '${taskId}' not found.`);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: taskId },
        data: { deletedAt: new Date() },
      });

      await tx.change.create({
        data: {
          userId,
          entityType: "task",
          entityId: taskId,
          operation: ChangeOperation.DELETE,
          version: 1,
          payload: { id: taskId },
        },
      });

      return { success: true, message: "Task deleted successfully." };
    });
  }

  private calculateNextRecurrenceDate(baseDate: Date, rrule: string): Date {
    const nextDate = new Date(baseDate);
    const upperRule = rrule.toUpperCase();

    if (upperRule.includes("FREQ=DAILY")) {
      nextDate.setDate(nextDate.getDate() + 1);
    } else if (upperRule.includes("FREQ=WEEKLY")) {
      nextDate.setDate(nextDate.getDate() + 7);
    } else if (upperRule.includes("FREQ=MONTHLY")) {
      nextDate.setMonth(nextDate.getMonth() + 1);
    } else {
      nextDate.setDate(nextDate.getDate() + 1);
    }

    return nextDate;
  }

  private formatTaskResponse(task: any) {
    const { taskLabels, ...rest } = task;
    return {
      ...rest,
      isCompleted: task.status === TaskStatus.COMPLETED,
      tags: taskLabels ? taskLabels.map((tl: any) => tl.tag) : [],
    };
  }
}
