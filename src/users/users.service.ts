import {
  Injectable,
  ConflictException,
  NotFoundException,
  Optional,
  Logger,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import { Queue } from "bull";
import { PrismaService } from "@/common/prisma/prisma.service";
import { User, UserStatus } from "@prisma/client";
import { UpdateUserProfileDto } from "./dto/update-user-profile.dto";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @InjectQueue("export") private readonly exportQueue?: Queue,
  ) {}

  async getUserById(userId: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: {
        id: userId,
        deletedAt: null,
      },
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: {
        email: email.toLowerCase(),
        deletedAt: null,
      },
    });
  }

  async createUser(data: {
    email: string;
    displayName?: string;
    locale?: string;
    timezone?: string;
  }): Promise<User> {
    const existing = await this.findByEmail(data.email);
    if (existing) {
      throw new ConflictException("User with this email already exists");
    }

    return this.prisma.user.create({
      data: {
        email: data.email.toLowerCase(),
        displayName: data.displayName,
        locale: data.locale || "en-US",
        timezone: data.timezone || "UTC",
      },
    });
  }

  async updateProfile(
    userId: string,
    dto: UpdateUserProfileDto,
  ): Promise<User> {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new NotFoundException("User profile not found");
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.displayName !== undefined
          ? { displayName: dto.displayName }
          : {}),
        ...(dto.avatar !== undefined ? { avatar: dto.avatar } : {}),
        ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
      },
    });
  }

  async softDeleteAccount(userId: string): Promise<{ success: boolean }> {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new NotFoundException("User profile not found");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          status: UserStatus.DELETED,
          deletedAt: new Date(),
        },
      });

      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await tx.device.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    return { success: true };
  }

  async requestDataExport(
    userId: string,
  ): Promise<{ status: string; message: string }> {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new NotFoundException("User profile not found");
    }

    if (this.exportQueue) {
      await this.exportQueue.add("process-export", {
        userId,
        email: user.email,
        requestedAt: new Date().toISOString(),
      });
    } else {
      this.logger.log(`Data export requested for user ${userId}`);
    }

    return {
      status: "accepted",
      message:
        "Data export request queued. An email with your download link will be dispatched shortly.",
    };
  }

  async getUserSessions(userId: string) {
    return this.prisma.session.findMany({
      where: {
        userId,
        revokedAt: null,
        refreshExpiresAt: {
          gt: new Date(),
        },
      },
      include: {
        device: {
          select: {
            id: true,
            name: true,
            platform: true,
            appVersion: true,
          },
        },
      },
      orderBy: {
        lastActivityAt: "desc",
      },
    });
  }

  async revokeUserSession(
    userId: string,
    sessionId: string,
  ): Promise<{ success: boolean }> {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
      },
    });

    if (!session) {
      throw new NotFoundException("Active session not found");
    }

    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });

    return { success: true };
  }

  sanitizeUser(user: User) {
    const { ...sanitized } = user;
    return sanitized;
  }
}
