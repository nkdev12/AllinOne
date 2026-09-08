import { Test, TestingModule } from "@nestjs/testing";
import { VaultItemsService } from "./vault-items.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { NotFoundException } from "@nestjs/common";
import { ChangeOperation, VaultItemType } from "@prisma/client";

describe("VaultItemsService", () => {
  let service: VaultItemsService;
  let prismaService: any;

  const userId = "user-uuid-123";
  const itemId = "item-uuid-456";

  const mockItem = {
    id: itemId,
    userId,
    type: VaultItemType.LOGIN,
    name: "GitHub Account",
    category: "Developer Tools",
    encryptedData:
      "eyHVzZXJuYW1lIjogInN3YW15a3Jpc2giLCAicGFzc3dvcmQiOiAic2VjcmV0In0=",
    iv: "ZEZtWjlKVE5hY3ZzT2FnYg==",
    authTag: "b0RVMU56ZzBOVFEwTlRBMg==",
    isFavorite: true,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  beforeEach(async () => {
    prismaService = {
      $transaction: jest.fn((cb) => cb(prismaService)),
      vaultItem: {
        create: jest.fn().mockResolvedValue(mockItem),
        findMany: jest.fn().mockResolvedValue([mockItem]),
        findFirst: jest.fn().mockResolvedValue(mockItem),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockResolvedValue({
          ...mockItem,
          version: 2,
          name: "GitHub Enterprise",
        }),
      },
      change: {
        create: jest.fn().mockResolvedValue({ id: "change-1" }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VaultItemsService,
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    service = module.get<VaultItemsService>(VaultItemsService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("createItem", () => {
    it("should create encrypted vault item and record sync change event", async () => {
      const result = await service.createItem(userId, {
        type: VaultItemType.LOGIN,
        name: "GitHub Account",
        category: "Developer Tools",
        encryptedData:
          "eyHVzZXJuYW1lIjogInN3YW15a3Jpc2giLCAicGFzc3dvcmQiOiAic2VjcmV0In0=",
        iv: "ZEZtWjlKVE5hY3ZzT2FnYg==",
        authTag: "b0RVMU56ZzBOVFEwTlRBMg==",
        isFavorite: true,
      });

      expect(result).toBeDefined();
      expect(result.id).toBe(itemId);
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: "vault_item",
            operation: ChangeOperation.CREATE,
          }),
        }),
      );
    });
  });

  describe("getItems", () => {
    it("should return paginated encrypted items filtered by type", async () => {
      const result = await service.getItems(userId, {
        page: 1,
        limit: 50,
        type: VaultItemType.LOGIN,
        search: "GitHub",
      });

      expect(result).toBeDefined();
      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
      expect(result.data[0].type).toBe(VaultItemType.LOGIN);
    });
  });

  describe("getItemById", () => {
    it("should return item details if found", async () => {
      const result = await service.getItemById(userId, itemId);
      expect(result.id).toBe(itemId);
    });

    it("should throw NotFoundException if item not found", async () => {
      prismaService.vaultItem.findFirst.mockResolvedValue(null);
      await expect(service.getItemById(userId, "non-existent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("updateItem", () => {
    it("should update encrypted data, increment version, and record sync change event", async () => {
      const result = await service.updateItem(userId, itemId, {
        name: "GitHub Enterprise",
      });

      expect(result).toBeDefined();
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            operation: ChangeOperation.UPDATE,
          }),
        }),
      );
    });
  });

  describe("deleteItem", () => {
    it("should soft delete vault item and record sync change event", async () => {
      const result = await service.deleteItem(userId, itemId);

      expect(result.success).toBe(true);
      expect(prismaService.vaultItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(prismaService.change.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ operation: ChangeOperation.DELETE }),
        }),
      );
    });
  });
});
