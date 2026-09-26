import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { CreateVaultItemDto } from "../dto/create-vault-item.dto";
import { UpdateVaultItemDto } from "../dto/update-vault-item.dto";
import { QueryVaultItemsDto } from "../dto/query-vault-items.dto";
import { ChangeOperation } from "@prisma/client";
import { ErrorCode } from "@/common/errors/error-code";
import { notFound } from "@/common/errors/http-errors";

@Injectable()
export class VaultItemsService {
  constructor(private readonly prisma: PrismaService) {}

  async createItem(userId: string, dto: CreateVaultItemDto) {
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.vaultItem.create({
        data: {
          userId,
          type: dto.type,
          name: dto.name,
          category: dto.category,
          encryptedData: dto.encryptedData,
          iv: dto.iv,
          authTag: dto.authTag,
          isFavorite: dto.isFavorite ?? false,
          version: 1,
        },
      });

      await tx.change.create({
        data: {
          userId,
          entityType: "vault_item",
          entityId: item.id,
          operation: ChangeOperation.CREATE,
          version: 1,
          payload: {
            name: item.name,
            type: item.type,
            category: item.category,
            isFavorite: item.isFavorite,
          },
        },
      });

      return item;
    });
  }

  async getItems(userId: string, query: QueryVaultItemsDto) {
    const page = query.page || 1;
    const limit = query.limit || 50;
    const skip = (page - 1) * limit;

    const where: any = {
      userId,
      deletedAt: null,
    };

    if (query.type) where.type = query.type;
    if (query.category) where.category = query.category;
    if (query.isFavorite !== undefined) where.isFavorite = query.isFavorite;

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: "insensitive" } },
        { category: { contains: query.search, mode: "insensitive" } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.vaultItem.count({ where }),
      this.prisma.vaultItem.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ isFavorite: "desc" }, { updatedAt: "desc" }],
      }),
    ]);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getItemById(userId: string, itemId: string) {
    const item = await this.prisma.vaultItem.findFirst({
      where: { id: itemId, userId, deletedAt: null },
    });

    if (!item) {
      throw notFound(
        ErrorCode.NOT_FOUND,
        `Vault item with ID '${itemId}' not found.`,
        {
          itemId,
        },
      );
    }

    return item;
  }

  async updateItem(userId: string, itemId: string, dto: UpdateVaultItemDto) {
    const existing = await this.prisma.vaultItem.findFirst({
      where: { id: itemId, userId, deletedAt: null },
    });

    if (!existing) {
      throw notFound(
        ErrorCode.NOT_FOUND,
        `Vault item with ID '${itemId}' not found.`,
        {
          itemId,
        },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedItem = await tx.vaultItem.update({
        where: { id: existing.id },
        data: {
          type: dto.type,
          name: dto.name,
          category: dto.category,
          encryptedData: dto.encryptedData,
          iv: dto.iv,
          authTag: dto.authTag,
          isFavorite: dto.isFavorite,
          version: { increment: 1 },
        },
      });

      await tx.change.create({
        data: {
          userId,
          entityType: "vault_item",
          entityId: updatedItem.id,
          operation: ChangeOperation.UPDATE,
          version: updatedItem.version,
          payload: {
            name: updatedItem.name,
            type: updatedItem.type,
            category: updatedItem.category,
            isFavorite: updatedItem.isFavorite,
          },
        },
      });

      return updatedItem;
    });
  }

  async deleteItem(userId: string, itemId: string) {
    const existing = await this.prisma.vaultItem.findFirst({
      where: { id: itemId, userId, deletedAt: null },
    });

    if (!existing) {
      throw notFound(
        ErrorCode.NOT_FOUND,
        `Vault item with ID '${itemId}' not found.`,
        {
          itemId,
        },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.vaultItem.update({
        where: { id: itemId },
        data: { deletedAt: new Date() },
      });

      await tx.change.create({
        data: {
          userId,
          entityType: "vault_item",
          entityId: itemId,
          operation: ChangeOperation.DELETE,
          version: existing.version + 1,
          payload: { id: itemId },
        },
      });

      return { success: true, message: "Vault item deleted successfully." };
    });
  }
}
