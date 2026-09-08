import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { CreateFolderDto } from "../dto/create-folder.dto";
import { UpdateFolderDto } from "../dto/update-folder.dto";

@Injectable()
export class FoldersService {
  constructor(private readonly prisma: PrismaService) {}

  async createFolder(userId: string, dto: CreateFolderDto) {
    if (dto.parentId) {
      const parent = await this.prisma.folder.findFirst({
        where: { id: dto.parentId, userId, deletedAt: null },
      });
      if (!parent) {
        throw new NotFoundException(
          `Parent folder with ID '${dto.parentId}' not found.`,
        );
      }
    }

    return this.prisma.folder.create({
      data: {
        userId,
        name: dto.name,
        parentId: dto.parentId,
        color: dto.color,
        icon: dto.icon,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async getFolders(userId: string) {
    const allFolders = await this.prisma.folder.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });

    const folderMap = new Map<string, any>();
    allFolders.forEach((f) => folderMap.set(f.id, { ...f, children: [] }));

    const rootFolders: any[] = [];
    allFolders.forEach((f) => {
      if (f.parentId && folderMap.has(f.parentId)) {
        folderMap.get(f.parentId).children.push(folderMap.get(f.id));
      } else {
        rootFolders.push(folderMap.get(f.id));
      }
    });

    return rootFolders;
  }

  async getFolderById(userId: string, folderId: string) {
    const folder = await this.prisma.folder.findFirst({
      where: { id: folderId, userId, deletedAt: null },
      include: {
        children: { where: { deletedAt: null } },
      },
    });
    if (!folder) {
      throw new NotFoundException(`Folder with ID '${folderId}' not found.`);
    }
    return folder;
  }

  async updateFolder(userId: string, folderId: string, dto: UpdateFolderDto) {
    await this.getFolderById(userId, folderId);

    if (dto.parentId) {
      if (dto.parentId === folderId) {
        throw new BadRequestException("A folder cannot be its own parent.");
      }

      let currentParentId: string | null = dto.parentId;
      while (currentParentId) {
        if (currentParentId === folderId) {
          throw new BadRequestException(
            "Cyclic parent assignment is not allowed.",
          );
        }
        const ancestor: { parentId: string | null } | null =
          await this.prisma.folder.findFirst({
            where: { id: currentParentId, userId, deletedAt: null },
            select: { parentId: true },
          });
        currentParentId = ancestor?.parentId || null;
      }
    }

    return this.prisma.folder.update({
      where: { id: folderId },
      data: {
        name: dto.name,
        parentId: dto.parentId,
        color: dto.color,
        icon: dto.icon,
        sortOrder: dto.sortOrder,
      },
    });
  }

  async deleteFolder(userId: string, folderId: string) {
    await this.getFolderById(userId, folderId);

    const childCount = await this.prisma.folder.count({
      where: { parentId: folderId, userId, deletedAt: null },
    });

    if (childCount > 0) {
      throw new BadRequestException(
        "Cannot delete folder containing subfolders.",
      );
    }

    return this.prisma.folder.update({
      where: { id: folderId },
      data: { deletedAt: new Date() },
    });
  }
}
