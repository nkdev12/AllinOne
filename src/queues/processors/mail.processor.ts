import { Processor, Process } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import { MailService } from "@/common/mail/mail.service";

export interface SendVerificationEmailJobData {
  email: string;
  token: string;
  otp?: string;
}

export interface SendPasswordResetEmailJobData {
  email: string;
  token: string;
  otp?: string;
}

@Processor("mail")
export class MailProcessor {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(private readonly mailService: MailService) {}

  @Process("send-verification-email")
  async handleSendVerificationEmail(job: Job<SendVerificationEmailJobData>) {
    this.logger.log(`[MailProcessor] Processing verification email for ${job.data.email}`);
    await this.mailService.sendVerificationEmail(job.data.email, job.data.token, job.data.otp);
    this.logger.log(`[MailProcessor] Verification email sent to ${job.data.email}`);
    return { sentAt: new Date().toISOString() };
  }

  @Process("send-password-reset-email")
  async handleSendPasswordResetEmail(job: Job<SendPasswordResetEmailJobData>) {
    this.logger.log(`[MailProcessor] Processing password reset email for ${job.data.email}`);
    await this.mailService.sendPasswordResetEmail(job.data.email, job.data.token);
    this.logger.log(`[MailProcessor] Password reset email sent to ${job.data.email}`);
    return { sentAt: new Date().toISOString() };
  }
}
