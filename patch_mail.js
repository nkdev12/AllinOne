const fs = require('fs');
const path = './src/common/mail/mail.service.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  /async sendVerificationEmail\(email: string, token: string\): Promise<boolean> \{([\s\S]*?)try \{/,
  `async sendVerificationEmail(email: string, token: string, otp?: string): Promise<boolean> {
    const verifyUrl = \`\${this.configService.appUrl}/auth/verify-email?token=\${token}\`;
    const displayCode = otp || token;
    const mailOptions = {
      from: this.configService.smtpFrom,
      to: email,
      subject: "Verify your Allinone email address",
      text: \`Welcome to Allinone! Your verification code is: \${displayCode}\n\nOr click here: \${verifyUrl}\n\nThis will expire in 24 hours.\`,
      html: \`
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #333333;">Welcome to Allinone!</h2>
          <p>Please verify your email address to complete your account setup.</p>
          <div style="margin: 30px 0; text-align: center;">
            <h1 style="letter-spacing: 5px; color: #0066cc;">\${displayCode}</h1>
          </div>
          <p>Or click the button below:</p>
          <div style="margin: 30px 0;">
            <a href="\${verifyUrl}" style="background-color: #0066cc; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Verify Email Address</a>
          </div>
          <p style="color: #666666; font-size: 14px;">Or copy and paste this link into your browser:<br/><a href="\${verifyUrl}">\${verifyUrl}</a></p>
          <p style="color: #999999; font-size: 12px; margin-top: 30px;">If you did not request this email, please ignore it.</p>
        </div>
      \`,
    };

    try {`
);

fs.writeFileSync(path, code);
