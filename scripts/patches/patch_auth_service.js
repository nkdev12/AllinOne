const fs = require('fs');
const path = './src/auth/auth.service.ts';
let code = fs.readFileSync(path, 'utf8');

// Add ioredis import if not present
if (!code.includes('import Redis from "ioredis";')) {
  code = 'import Redis from "ioredis";\n' + code;
}

// Add redis client
code = code.replace(
  /private readonly googleClient = new OAuth2Client\(\);/,
  `private readonly googleClient = new OAuth2Client();\n  private redisClient: Redis;`
);

code = code.replace(
  /this\.JWKS_CACHE_TTL = 24 \* 60 \* 60 \* 1000;.*?constructor\([^)]*\)\s*\{/s,
  (match) => {
    return match + `\n    this.redisClient = new Redis(this.configService.redisUrl);`;
  }
);

// Update requestEmailVerification
code = code.replace(
  /async requestEmailVerification\(email: string\): Promise<\{ message: string \}> \{[\s\S]*?return \{[\s\S]*?message: "If the account exists, a verification link has been sent\.",[\s\S]*?\};\n  \}/,
  `async requestEmailVerification(email: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);
    if (user && !user.emailVerifiedAt) {
      const token = this.jwtService.sign(
        { sub: user.id, email: user.email, purpose: "EMAIL_VERIFICATION" },
        { secret: this.configService.jwtAccessSecret, expiresIn: "24h" },
      );
      
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      await this.redisClient.set(\`email_otp:\${user.email}\`, otp, "EX", 3600); // 1 hr expiration

      await this.mailQueue.add("send-verification-email", {
        email: user.email,
        token,
        otp
      });
    }

    return {
      message: "If the account exists, a verification link and OTP have been sent.",
    };
  }`
);

// Update confirmEmailVerification
code = code.replace(
  /async confirmEmailVerification\(token: string\): Promise<\{ message: string \}> \{([\s\S]*?)catch \(error\) \{/s,
  `async confirmEmailVerification(token: string | undefined, email?: string, otp?: string): Promise<{ message: string }> {
    try {
      let userId: string;

      if (email && otp) {
        // OTP verification
        const storedOtp = await this.redisClient.get(\`email_otp:\${email}\`);
        if (!storedOtp || storedOtp !== otp) {
          throw new BadRequestException("Invalid or expired OTP");
        }
        const user = await this.usersService.findByEmail(email);
        if (!user) throw new BadRequestException("User not found");
        userId = user.id;
        await this.redisClient.del(\`email_otp:\${email}\`);
      } else if (token) {
        // Token verification
        const payload = this.jwtService.verify(token, {
          secret: this.configService.jwtAccessSecret,
        });

        if (payload.purpose !== "EMAIL_VERIFICATION") {
          throw new BadRequestException("Invalid verification token type");
        }
        userId = payload.sub;
      } else {
        throw new BadRequestException("Must provide either a token or email and OTP");
      }

      await this.prisma.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: new Date() },
      });

      await this.prisma.authentication.updateMany({
        where: { userId: userId, type: "EMAIL_PASSWORD" },
        data: { emailVerified: true },
      });

      return { message: "Email address successfully verified" };
    } catch (error) {`
);

fs.writeFileSync(path, code);
