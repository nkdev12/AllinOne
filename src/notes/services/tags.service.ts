import {
  Injectable,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { CreateTagDto } from "../dto/create-tag.dto";
import { UpdateTagDto } from "../dto/update-tag.dto";

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  async createTag(userId: string, dto: CreateTagDto) {
    const existing = await this.prisma.tag.findUnique({
      where: { userId_name: { userId, name: dto.name } },
    });
    if (existing) {
      throw new ConflictException(
        `Tag with name '${dto.name}' already exists.`,
      );
    }

    return this.prisma.tag.create({
      data: {
        userId,
        name: dto.name,
        color: dto.color,
      },
    });
  }

  async getTags(userId: string) {
    return this.prisma.tag.findMany({
      where: { userId },
      orderBy: { name: "asc" },
    });
  }

  async getTagById(userId: string, tagId: string) {
    const tag = await this.prisma.tag.findFirst({
      where: { id: tagId, userId },
    });
    if (!tag) {
      throw new NotFoundException(`Tag with ID '${tagId}' not found.`);
    }
    return tag;
  }

  async updateTag(userId: string, tagId: string, dto: UpdateTagDto) {
    await this.getTagById(userId, tagId);

    if (dto.name) {
      const existing = await this.prisma.tag.findFirst({
        where: { userId, name: dto.name, NOT: { id: tagId } },
      });
      if (existing) {
        throw new ConflictException(
          `Tag with name '${dto.name}' already exists.`,
        );
      }
    }

    return this.prisma.tag.update({
      where: { id: tagId },
      data: {
        name: dto.name,
        color: dto.color,
      },
    });
  }

  async deleteTag(userId: string, tagId: string) {
    await this.getTagById(userId, tagId);

    await this.prisma.tag.delete({
      where: { id: tagId },
    });

    return { success: true, message: "Tag deleted successfully." };
  }
}
