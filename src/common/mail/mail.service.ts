import { Injectable, Logger } from "@nestjs/common";
import * as nodemailer from "nodemailer";
import { ConfigurationService } from "@/config/configuration.service";

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly configService: ConfigurationService) {
    const smtpUser = configService.smtpUser;
    const smtpPassword = configService.smtpPassword;
    const port = configService.smtpPort;

    // Port 465 = implicit TLS (secure:true). Port 587 = STARTTLS
    // (secure:false + requireTLS). SMTP_TLS env flag forces STARTTLS.
    const isImplicitTls = port === 465;
    const useStartTls = !isImplicitTls && configService.smtpTls;

    this.transporter = nodemailer.createTransport({
      host: configService.smtpHost,
      port,
      secure: isImplicitTls,
      requireTLS: useStartTls,
      auth:
        smtpUser && smtpPassword
          ? { user: smtpUser, pass: smtpPassword }
          : undefined,
    });

    // Non-blocking startup check so misconfiguration is visible in logs.
    this.transporter.verify((error) => {
      if (error) {
        this.logger.error(
          `SMTP connection failed (${configService.smtpHost}:${port}). OTP emails will NOT be delivered.`,
          error.message,
        );
      } else {
        this.logger.log(
          `SMTP ready (${configService.smtpHost}:${port}, from: ${configService.smtpFrom})`,
        );
      }
    });
  }

  get isConfigured(): boolean {
    return Boolean(
      this.configService.smtpHost &&
        this.configService.smtpUser &&
        this.configService.smtpPassword,
    );
  }

  /**
   * Send a 6-digit OTP code to the candidate. Used for email verification.
   * Returns true when the mail was accepted by the SMTP server.
   * Never throws — callers must not fail registration just because mail is down.
   */
  async sendOtpEmail(email: string, otp: string): Promise<boolean> {
    const mailOptions = {
      from: this.configService.smtpFrom,
      to: email,
      subject: "Your Allinone verification code",
      text: `Welcome to Allinone! Your verification code is: ${otp}\n\nThis code expires in 60 minutes. If you did not request this, please ignore this email.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #333333;">Welcome to Allinone!</h2>
          <p>Use the verification code below to verify your email address:</p>
          <div style="margin: 30px 0; text-align: center;">
            <h1 style="letter-spacing: 5px; color: #0066cc;">${otp}</h1>
          </div>
          <p style="color: #666666; font-size: 14px;">This code expires in 60 minutes.</p>
          <p style="color: #999999; font-size: 12px; margin-top: 30px;">If you did not request this email, please ignore it.</p>
        </div>
      `,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      this.logger.log(`OTP email sent to ${email}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send OTP email to ${email}:`, error);
      return false;
    }
  }

  async sendVerificationEmail(
    email: string,
    token: string,
    otp?: string,
  ): Promise<boolean> {
    const verifyUrl = `${this.configService.appUrl}/auth/verify-email?token=${token}`;
    const displayCode = otp || token;
    const mailOptions = {
      from: this.configService.smtpFrom,
      to: email,
      subject: "Verify your Allinone email address",
      text: `Welcome to Allinone! Your verification code is: ${displayCode}

Or click here: ${verifyUrl}

This will expire in 24 hours.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #333333;">Welcome to Allinone!</h2>
          <p>Please verify your email address to complete your account setup.</p>
          <div style="margin: 30px 0; text-align: center;">
            <h1 style="letter-spacing: 5px; color: #0066cc;">${displayCode}</h1>
          </div>
          <p>Or click the button below:</p>
          <div style="margin: 30px 0;">
            <a href="${verifyUrl}" style="background-color: #0066cc; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Verify Email Address</a>
          </div>
          <p style="color: #666666; font-size: 14px;">Or copy and paste this link into your browser:<br/><a href="${verifyUrl}">${verifyUrl}</a></p>
          <p style="color: #999999; font-size: 12px; margin-top: 30px;">If you did not request this email, please ignore it.</p>
        </div>
      `,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      this.logger.log(`Verification email sent to ${email}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send verification email to ${email}:`,
        error,
      );
      return false;
    }
  }

  async sendPasswordResetEmail(email: string, token: string): Promise<boolean> {
    const resetUrl = `${this.configService.appUrl}/auth/reset-password?token=${token}`;
    const mailOptions = {
      from: this.configService.smtpFrom,
      to: email,
      subject: "Reset your Allinone password",
      text: `You requested a password reset for your Allinone account. Click the link below to set a new password:\n\n${resetUrl}\n\nThis link will expire in 1 hour.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #333333;">Password Reset Request</h2>
          <p>You requested a password reset for your Allinone account. Click the button below to choose a new password.</p>
          <div style="margin: 30px 0;">
            <a href="${resetUrl}" style="background-color: #d9534f; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Reset Password</a>
          </div>
          <p style="color: #666666; font-size: 14px;">Or copy and paste this link into your browser:<br/><a href="${resetUrl}">${resetUrl}</a></p>
          <p style="color: #999999; font-size: 12px; margin-top: 30px;">This link will expire in 1 hour. If you did not request a password reset, please ignore this email.</p>
        </div>
      `,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      this.logger.log(`Password reset email sent to ${email}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send password reset email to ${email}:`,
        error,
      );
      return false;
    }
  }
}
