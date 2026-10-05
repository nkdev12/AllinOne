const fs = require('fs');
const path = './src/auth/auth.service.ts';
let code = fs.readFileSync(path, 'utf8');

// The original signature until the end of the generateTokens line
const newRegister = `  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    const existingUser = await this.usersService.findByEmail(dto.email);
    if (existingUser) {
      throw new ConflictException("User with this email already exists");
    }

    const hashedPassword = await argon2.hash(dto.password);

    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: dto.email.toLowerCase(),
            displayName: dto.displayName || null,
            locale: dto.locale || "en-US",
            timezone: dto.timezone || "UTC",
            status: "ACTIVE",
          },
        });

        await tx.authentication.create({
          data: {
            userId: user.id,
            type: "EMAIL_PASSWORD",
            identifier: dto.email.toLowerCase(),
            passwordHash: hashedPassword,
            emailVerified: false,
          },
        });

        const device = await tx.device.create({
          data: {
            userId: user.id,
            name: "Primary Web/Client Device",
            platform: Platform.WEB,
            appVersion: "1.0.0",
            publicKey: "",
          },
        });

        return { user, device };
      });
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new ConflictException("User with this email already exists");
      }
      throw error;
    }

    const tokens = await this.generateTokens(result.user.id, result.user.email);`;

code = code.replace(/  async register\(dto: RegisterDto\): Promise<AuthResponseDto> \{([\s\S]*?)const tokens = await this\.generateTokens\(result\.user\.id, result\.user\.email\);/, newRegister);

fs.writeFileSync(path, code);
