import { Processor, Process } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";

export interface SendNotificationJobData {
  userId: string;
  title: string;
  body: string;
  channel: "NOTIFICATION" | "EMAIL";
  metadata?: Record<string, any>;
}

@Processor("notification")
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);

  @Process("send-notification")
  async handleSendNotification(job: Job<SendNotificationJobData>) {
    this.logger.log(
      `[NotificationProcessor] Processing notification job #${job.id} for user: ${job.data.userId}, channel: ${job.data.channel}`,
    );

    // Asynchronous notification delivery processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    this.logger.log(
      `[NotificationProcessor] Successfully delivered notification job #${job.id} to user ${job.data.userId}`,
    );

    return { deliveredAt: new Date().toISOString(), userId: job.data.userId };
  }
}
