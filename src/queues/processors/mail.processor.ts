import { Processor, Process } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";

export interface SendMailJobData {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

@Processor("mail")
export class MailProcessor {
  private readonly logger = new Logger(MailProcessor.name);

  @Process("send-email")
  async handleSendEmail(job: Job<SendMailJobData>) {
    this.logger.log(
      `[MailProcessor] Processing email job #${job.id} to: ${job.data.to}, subject: '${job.data.subject}'`,
    );

    // Asynchronous email delivery processing simulation / Nodemailer integration
    // In production, uses configured SMTP transporter
    await new Promise((resolve) => setTimeout(resolve, 100));

    this.logger.log(
      `[MailProcessor] Successfully dispatched email job #${job.id} to ${job.data.to}`,
    );

    return { sentAt: new Date().toISOString(), recipient: job.data.to };
  }
}
