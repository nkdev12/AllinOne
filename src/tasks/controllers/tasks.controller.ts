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
import { TasksService } from "../services/tasks.service";
import { RemindersService } from "../services/reminders.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateTaskDto } from "../dto/create-task.dto";
import { UpdateTaskDto } from "../dto/update-task.dto";
import { QueryTasksDto } from "../dto/query-tasks.dto";
import { CreateReminderDto } from "../dto/create-reminder.dto";

@ApiTags("Tasks")
@Controller("tasks")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly remindersService: RemindersService,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a new task or subtask" })
  @ApiResponse({ status: 201, description: "Task created successfully" })
  async createTask(@GetUser("id") userId: string, @Body() dto: CreateTaskDto) {
    return this.tasksService.createTask(userId, dto);
  }

  @Get()
  @ApiOperation({
    summary: "List and search user tasks with filters & pagination",
  })
  @ApiResponse({ status: 200, description: "Paginated tasks list returned" })
  async getTasks(@GetUser("id") userId: string, @Query() query: QueryTasksDto) {
    return this.tasksService.getTasks(userId, query);
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get task details by ID with subtasks, labels, and reminders",
  })
  @ApiResponse({ status: 200, description: "Task details returned" })
  @ApiResponse({ status: 404, description: "Task not found" })
  async getTaskById(
    @Param("id") taskId: string,
    @GetUser("id") userId: string,
  ) {
    return this.tasksService.getTaskById(userId, taskId);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update task attributes" })
  @ApiResponse({ status: 200, description: "Task updated successfully" })
  @ApiResponse({ status: 404, description: "Task not found" })
  async updateTask(
    @Param("id") taskId: string,
    @GetUser("id") userId: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.tasksService.updateTask(userId, taskId, dto);
  }

  @Post(":id/complete")
  @ApiOperation({
    summary: "Complete a task (triggers recurring task engine if RRULE set)",
  })
  @ApiResponse({
    status: 200,
    description:
      "Task completed and optional next recurring instance generated",
  })
  @ApiResponse({ status: 404, description: "Task not found" })
  async completeTask(
    @Param("id") taskId: string,
    @GetUser("id") userId: string,
  ) {
    return this.tasksService.completeTask(userId, taskId);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft delete task" })
  @ApiResponse({ status: 200, description: "Task deleted" })
  @ApiResponse({ status: 404, description: "Task not found" })
  async deleteTask(@Param("id") taskId: string, @GetUser("id") userId: string) {
    return this.tasksService.deleteTask(userId, taskId);
  }

  // Reminders Endpoints
  @Post(":id/reminders")
  @ApiOperation({ summary: "Schedule a reminder notification for a task" })
  @ApiResponse({ status: 201, description: "Reminder scheduled" })
  async createReminder(
    @Param("id") taskId: string,
    @GetUser("id") userId: string,
    @Body() dto: CreateReminderDto,
  ) {
    return this.remindersService.createReminder(userId, taskId, dto);
  }

  @Get(":id/reminders")
  @ApiOperation({ summary: "Get all scheduled reminders for a task" })
  @ApiResponse({ status: 200, description: "Reminders list returned" })
  async getReminders(
    @Param("id") taskId: string,
    @GetUser("id") userId: string,
  ) {
    return this.remindersService.getReminders(userId, taskId);
  }

  @Delete("reminders/:reminderId")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Cancel/Delete scheduled reminder" })
  @ApiResponse({ status: 200, description: "Reminder deleted" })
  async deleteReminder(
    @Param("reminderId") reminderId: string,
    @GetUser("id") userId: string,
  ) {
    return this.remindersService.deleteReminder(userId, reminderId);
  }
}
