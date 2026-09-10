import { Test, TestingModule } from "@nestjs/testing";
import { CollaborationService } from "./collaboration.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
import { NotFoundException, ConflictException } from "@nestjs/common";

describe("CollaborationService", () => {
  let service: CollaborationService;
  let prismaMock: any;
  let auditLogServiceMock: any;

  beforeEach(async () => {
    prismaMock = {
      note: {
        findFirst: jest.fn(),
      },
      project: {
        findFirst: jest.fn(),
      },
      calendar: {
        findFirst: jest.fn(),
      },
      user: {
        findFirst: jest.fn(),
      },
    };

    auditLogServiceMock = {
      recordAuditLog: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollaborationService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLogService, useValue: auditLogServiceMock },
      ],
    }).compile();

    service = module.get<CollaborationService>(CollaborationService);
  });

  describe("shareResource", () => {
    it("should allow an owner to share a note with a collaborator", async () => {
      prismaMock.note.findFirst.mockResolvedValue({
        id: "note-1",
        userId: "owner-1",
        title: "Team Meeting",
      });
      prismaMock.user.findFirst.mockResolvedValue({
        id: "collab-1",
        email: "collab@example.com",
      });

      const share = await service.shareResource("owner-1", {
        resourceType: "NOTE",
        resourceId: "note-1",
        email: "collab@example.com",
        role: "EDITOR",
      });

      expect(share).toBeDefined();
      expect(share.resourceId).toBe("note-1");
      expect(share.role).toBe("EDITOR");
      expect(share.sharedWithEmail).toBe("collab@example.com");
      expect(auditLogServiceMock.recordAuditLog).toHaveBeenCalled();
    });

    it("should throw NotFoundException if resource does not exist", async () => {
      prismaMock.note.findFirst.mockResolvedValue(null);

      await expect(
        service.shareResource("owner-1", {
          resourceType: "NOTE",
          resourceId: "missing-note",
          email: "collab@example.com",
          role: "VIEWER",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw ConflictException if owner tries to share with themselves", async () => {
      prismaMock.note.findFirst.mockResolvedValue({
        id: "note-1",
        userId: "owner-1",
        title: "Personal",
      });
      prismaMock.user.findFirst.mockResolvedValue({
        id: "owner-1",
        email: "owner@example.com",
      });

      await expect(
        service.shareResource("owner-1", {
          resourceType: "NOTE",
          resourceId: "note-1",
          email: "owner@example.com",
          role: "ADMIN",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("should throw ConflictException on duplicate share", async () => {
      prismaMock.note.findFirst.mockResolvedValue({
        id: "note-1",
        userId: "owner-1",
        title: "Architecture",
      });
      prismaMock.user.findFirst.mockResolvedValue({
        id: "collab-2",
        email: "collab2@example.com",
      });

      await service.shareResource("owner-1", {
        resourceType: "NOTE",
        resourceId: "note-1",
        email: "collab2@example.com",
        role: "VIEWER",
      });

      await expect(
        service.shareResource("owner-1", {
          resourceType: "NOTE",
          resourceId: "note-1",
          email: "collab2@example.com",
          role: "EDITOR",
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("checkAccess & role evaluation", () => {
    it("should grant full access to the owner", async () => {
      prismaMock.note.findFirst.mockResolvedValue({
        id: "note-10",
        userId: "owner-10",
        title: "Docs",
      });

      const access = await service.checkAccess(
        "owner-10",
        undefined,
        "NOTE",
        "note-10",
        "ADMIN",
      );

      expect(access.hasAccess).toBe(true);
      expect(access.isOwner).toBe(true);
    });

    it("should evaluate role weight correctly for VIEWER and EDITOR", async () => {
      prismaMock.note.findFirst.mockResolvedValue({
        id: "note-20",
        userId: "owner-20",
        title: "Sprint Notes",
      });
      prismaMock.user.findFirst.mockResolvedValue({
        id: "editor-user",
        email: "editor@example.com",
      });

      await service.shareResource("owner-20", {
        resourceType: "NOTE",
        resourceId: "note-20",
        email: "editor@example.com",
        role: "EDITOR",
      });

      const viewerCheck = await service.checkAccess(
        "editor-user",
        "editor@example.com",
        "NOTE",
        "note-20",
        "VIEWER",
      );
      expect(viewerCheck.hasAccess).toBe(true);

      const editorCheck = await service.checkAccess(
        "editor-user",
        "editor@example.com",
        "NOTE",
        "note-20",
        "EDITOR",
      );
      expect(editorCheck.hasAccess).toBe(true);

      const adminCheck = await service.checkAccess(
        "editor-user",
        "editor@example.com",
        "NOTE",
        "note-20",
        "ADMIN",
      );
      expect(adminCheck.hasAccess).toBe(false);
    });
  });

  describe("updateShareRole and revokeShare", () => {
    it("should allow updating role and revoking", async () => {
      prismaMock.note.findFirst.mockResolvedValue({
        id: "note-30",
        userId: "owner-30",
        title: "Design Doc",
      });
      prismaMock.user.findFirst.mockResolvedValue({
        id: "user-30",
        email: "user30@example.com",
      });

      const share = await service.shareResource("owner-30", {
        resourceType: "NOTE",
        resourceId: "note-30",
        email: "user30@example.com",
        role: "VIEWER",
      });

      const updated = await service.updateShareRole("owner-30", share.id, {
        role: "ADMIN",
      });
      expect(updated.role).toBe("ADMIN");

      await service.revokeShare("owner-30", share.id);

      const shares = await service.getSharesForResource(
        "owner-30",
        "NOTE",
        "note-30",
      );
      expect(shares.length).toBe(0);
    });
  });
});
