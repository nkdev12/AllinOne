import { Injectable, Logger } from "@nestjs/common";
import nodemailer from "nodemailer";
import { ConfigurationService } from "@/config/configuration.service";

interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface MailTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<unknown>;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport?: MailTransport;

  constructor(private readonly configService: ConfigurationService) {
    if (!this.isConfigured) {
      this.logger.warn(
        "SMTP is not configured. OTP and verification emails will not be delivered.",
      );
    } else {
      const isImplicitTls =
        configService.smtpTls && configService.smtpPort === 465;
      this.transport = nodemailer.createTransport({
        host: configService.smtpHost,
        port: configService.smtpPort,
        // Gmail's recommended port 587 starts unencrypted and upgrades with
        // STARTTLS; port 465 is the implicit-TLS variant.
        secure: isImplicitTls,
        requireTLS: configService.smtpTls,
        auth: {
          user: configService.smtpUser,
          pass: configService.smtpPassword,
        },
      });
      this.logger.log(
        `SMTP email delivery ready (from: ${configService.emailFrom})`,
      );
    }
  }

  get isConfigured(): boolean {
    return Boolean(
      this.configService.smtpHost &&
      this.configService.smtpUser &&
      this.configService.smtpPassword &&
      this.configService.emailFrom,
    );
  }

  private async sendMail(mail: OutgoingMail): Promise<void> {
    if (!this.transport) {
      throw new Error(
        "SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM are required",
      );
    }

    await this.transport.sendMail(mail);
  }

  /**
   * Send a 6-digit OTP code to the candidate. Used for email verification.
   * Returns true when the SMTP server accepts the message.
   * Never throws — callers must not fail registration just because mail is down.
   */
  async sendOtpEmail(email: string, otp: string): Promise<boolean> {
    const mailOptions = {
      from: this.configService.emailFrom,
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
      await this.sendMail(mailOptions);
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
      from: this.configService.emailFrom,
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
      await this.sendMail(mailOptions);
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

  /**
   * 6-digit code for a password reset. Kept separate from sendOtpEmail so the
   * wording cannot tell a user their account email is being verified.
   */
  async sendPasswordResetOtpEmail(
    email: string,
    otp: string,
  ): Promise<boolean> {
    const mailOptions = {
      from: this.configService.emailFrom,
      to: email,
      subject: "Your Allinone password reset code",
      text: `You requested a password reset for your Allinone account. Your reset code is: ${otp}\n\nThis code expires in 15 minutes. If you did not request it, your password is unchanged — please ignore this email.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #333333;">Password Reset Request</h2>
          <p>Enter this code to choose a new password for your Allinone account:</p>
          <div style="margin: 30px 0; text-align: center;">
            <h1 style="letter-spacing: 5px; color: #d9534f;">${otp}</h1>
          </div>
          <p style="color: #666666; font-size: 14px;">This code expires in 15 minutes and can be used once.</p>
          <p style="color: #999999; font-size: 12px; margin-top: 30px;">If you did not request a password reset, your password is unchanged. Please ignore this email.</p>
        </div>
      `,
    };

    try {
      await this.sendMail(mailOptions);
      this.logger.log(`Password reset OTP email sent to ${email}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send password reset OTP email to ${email}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Lets the account owner prove they control the email address before the
   * server hands back the wrapped vault master key.
   */
  async sendVaultRecoveryOtpEmail(
    email: string,
    otp: string,
  ): Promise<boolean> {
    const mailOptions = {
      from: this.configService.emailFrom,
      to: email,
      subject: "Your Allinone vault recovery code",
      text: `A password vault recovery was requested for your Allinone account. Your recovery code is: ${otp}\n\nThis code expires in 15 minutes and can be used once. If you did not request it, your vault is unchanged — please ignore this email.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #333333;">Password Vault Recovery</h2>
          <p>Enter this code to recover access to your Allinone password vault:</p>
          <div style="margin: 30px 0; text-align: center;">
            <h1 style="letter-spacing: 5px; color: #0066cc;">${otp}</h1>
          </div>
          <p style="color: #666666; font-size: 14px;">This code expires in 15 minutes and can be used once.</p>
          <p style="color: #999999; font-size: 12px; margin-top: 30px;">If you did not request a vault recovery, your vault is unchanged. Please ignore this email.</p>
        </div>
      `,
    };

    try {
      await this.sendMail(mailOptions);
      this.logger.log(`Vault recovery OTP email sent to ${email}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send vault recovery OTP email to ${email}:`,
        error,
      );
      return false;
    }
  }
}
