import { Test, TestingModule } from "@nestjs/testing";
import { FoldersService } from "./folders.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { BadRequestException } from "@nestjs/common";

describe("FoldersService Cycle Prevention & Management", () => {
  let service: FoldersService;
  let prismaService: any;

  const userId = "user-123";
  const folderA = "folder-A";
  const folderB = "folder-B";

  beforeEach(async () => {
    prismaService = {
      folder: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.id === folderA) {
            return Promise.resolve({
              id: folderA,
              userId,
              name: "Folder A",
              parentId: null,
            });
          }
          if (where.id === folderB) {
            return Promise.resolve({
              id: folderB,
              userId,
              name: "Folder B",
              parentId: folderA,
            });
          }
          return Promise.resolve(null);
        }),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FoldersService,
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    service = module.get<FoldersService>(FoldersService);
  });

  it("should prevent a folder from setting parentId to itself", async () => {
    await expect(
      service.updateFolder(userId, folderA, { parentId: folderA }),
    ).rejects.toThrow(BadRequestException);
  });

  it("should prevent a folder from setting parentId to a descendant folder (cycle creation)", async () => {
    await expect(
      service.updateFolder(userId, folderA, { parentId: folderB }),
    ).rejects.toThrow(BadRequestException);
  });
});
