import { Test, TestingModule } from "@nestjs/testing";
import { TasksService } from "./tasks.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { NotFoundException } from "@nestjs/common";
import { ChangeOperation, TaskPriority, TaskStatus } from "@prisma/client";

describe("TasksService", () => {
  let service: TasksService;
  let prismaService: any;

  const userId = "user-uuid-123";
  const projectId = "project-uuid-456";
  const sectionId = "section-uuid-789";
  const taskId = "task-uuid-101";
  const tagId = "tag-uuid-202";

  const mockProject = {
    id: projectId,
    userId,
    name: "Product Launch",
    deletedAt: null,
  };

  const mockTask = {
    id: taskId,
    userId,
    projectId,
    sectionId,
    parentId: null,
    title: "Design API Specs",
    description: "Create OpenAPI doc",
    priority: TaskPriority.P1_URGENT,
    status: TaskStatus.TODO,
    dueDate: new Date(),
    dueTime: "14:00",
    recurrenceRule: "FREQ=WEEKLY",
    completedAt: null,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    project: mockProject,
    section: null,
    taskLabels: [{ tag: { id: tagId, name: "work", color: "#007ACC" } }],
    subtasks: [],
    reminders: [],
  };

  beforeEach(async () => {
    prismaService = {
      $transaction: jest.fn((cb) => cb(prismaService)),
      project: {
        findFirst: jest.fn().mockResolvedValue(mockProject),
      },
      task: {
        create: jest.fn().mockResolvedValue(mockTask),
        findMany: jest.fn().mockResolvedValue([mockTask]),
        findFirst: jest.fn().mockResolvedValue(mockTask),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockResolvedValue({
          ...mockTask,
          status: TaskStatus.COMPLETED,
          completedAt: new Date(),
        }),
      },
      taskLabel: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      change: {
        create: jest.fn().mockResolvedValue({ id: "change-1" }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    service = module.get<TasksService>(TasksService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("createTask", () => {
    it("should create task and record sync change event", async () => {
      const result = await service.createTask(userId, {
        title: "Design API Specs",
        projectId,
        priority: TaskPriority.P1_URGENT,
        tagIds: [tagId],
      });

      expect(result).toBeDefined();
      expect(result.id).toBe(taskId);
      expect(result.tags).toHaveLength(1);
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "task",
            operation: ChangeOperation.CREATE,
          }),
        }),
      );
    });

    it("should throw NotFoundException if associated project is not found", async () => {
      prismaService.project.findFirst.mockResolvedValue(null);

      await expect(
        service.createTask(userId, {
          title: "Invalid Project Task",
          projectId: "invalid-project",
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getTasks", () => {
    it("should return paginated tasks list filtered by priority", async () => {
      const result = await service.getTasks(userId, {
        page: 1,
        limit: 10,
        priority: TaskPriority.P1_URGENT,
      });

      expect(result).toBeDefined();
      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
      expect(result.data[0].priority).toBe(TaskPriority.P1_URGENT);
    });
  });

  describe("getTaskById", () => {
    it("should return task details if found", async () => {
      const result = await service.getTaskById(userId, taskId);
      expect(result.id).toBe(taskId);
    });

    it("should throw NotFoundException if task not found", async () => {
      prismaService.task.findFirst.mockResolvedValue(null);
      await expect(service.getTaskById(userId, "non-existent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("completeTask", () => {
    it("should mark task completed and generate next recurring task instance", async () => {
      const result = await service.completeTask(userId, taskId);

      expect(result).toBeDefined();
      expect(result.completedTask.isCompleted).toBe(true);
      expect(result.nextRecurringTask).toBeDefined();
      expect(prismaService.task.create).toHaveBeenCalled();
      expect(prismaService.change.create).toHaveBeenCalledTimes(2); // One for completion, one for new instance
    });
  });

  describe("updateTask", () => {
    it("should throw BadRequestException when trying to set parentId to self", async () => {
      await expect(
        service.updateTask(userId, taskId, { parentId: taskId }),
      ).rejects.toThrow("A task cannot be its own subtask.");
    });

    it("should throw BadRequestException when trying to assign an ancestor as parentId causing a cycle", async () => {
      // Mock parent task having taskId as its parent
      prismaService.task.findFirst
        .mockResolvedValueOnce(mockTask) // For initial existing task check
        .mockResolvedValueOnce({ parentId: taskId }); // For ancestor check

      await expect(
        service.updateTask(userId, taskId, { parentId: "parent-uuid" }),
      ).rejects.toThrow("Cyclic parent task assignment is not allowed.");
    });
  });

  describe("deleteTask", () => {
    it("should soft delete task and record sync change event", async () => {
      const result = await service.deleteTask(userId, taskId);

      expect(result.success).toBe(true);
      expect(prismaService.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ operation: ChangeOperation.DELETE }),
        }),
      );
    });
  });
});
