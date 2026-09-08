import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { CreateReminderDto } from "../dto/create-reminder.dto";
import { ReminderChannel } from "@prisma/client";

@Injectable()
export class RemindersService {
  constructor(private readonly prisma: PrismaService) {}

  async createReminder(userId: string, taskId: string, dto: CreateReminderDto) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, userId, deletedAt: null },
    });

    if (!task) {
      throw new NotFoundException(`Task with ID '${taskId}' not found.`);
    }

    return this.prisma.reminder.create({
      data: {
        taskId,
        userId,
        remindAt: dto.remindAt,
        channel: dto.channel ?? ReminderChannel.NOTIFICATION,
      },
    });
  }

  async getReminders(userId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, userId, deletedAt: null },
    });

    if (!task) {
      throw new NotFoundException(`Task with ID '${taskId}' not found.`);
    }

    return this.prisma.reminder.findMany({
      where: { taskId, userId },
      orderBy: { remindAt: "asc" },
    });
  }

  async deleteReminder(userId: string, reminderId: string) {
    const reminder = await this.prisma.reminder.findFirst({
      where: { id: reminderId, userId },
    });

    if (!reminder) {
      throw new NotFoundException(
        `Reminder with ID '${reminderId}' not found.`,
      );
    }

    await this.prisma.reminder.delete({
      where: { id: reminderId },
    });

    return { success: true, message: "Reminder deleted successfully." };
  }
}
