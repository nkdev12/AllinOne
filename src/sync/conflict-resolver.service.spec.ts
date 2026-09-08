import { Test, TestingModule } from "@nestjs/testing";
import { ConflictResolverService } from "./conflict-resolver.service";

describe("ConflictResolverService", () => {
  let service: ConflictResolverService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConflictResolverService],
    }).compile();

    service = module.get<ConflictResolverService>(ConflictResolverService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("resolveLwwFieldMerge", () => {
    it("should merge non-overlapping fields from incoming payload into existing payload", () => {
      const existingPayload = { title: "Original Title", color: "blue" };
      const incomingPayload = { content: "New Content", tags: ["work"] };

      const result = service.resolveLwwFieldMerge(
        existingPayload,
        incomingPayload,
      );

      expect(result.hadCollision).toBe(false);
      expect(result.mergedPayload).toEqual({
        title: "Original Title",
        color: "blue",
        content: "New Content",
        tags: ["work"],
      });
      expect(result.resolvedFields).toContain("content");
      expect(result.resolvedFields).toContain("tags");
    });

    it("should overwrite existing field when incoming timestamp is newer", () => {
      const existingPayload = { title: "Old Title" };
      const incomingPayload = { title: "Newer Title" };
      const existingTimestamp = new Date("2026-09-01T10:00:00Z");
      const incomingTimestamp = new Date("2026-09-01T10:05:00Z");

      const result = service.resolveLwwFieldMerge(
        existingPayload,
        incomingPayload,
        existingTimestamp,
        incomingTimestamp,
      );

      expect(result.hadCollision).toBe(true);
      expect(result.mergedPayload.title).toBe("Newer Title");
      expect(result.resolvedFields).toEqual(["title"]);
    });

    it("should retain existing field when existing timestamp is newer", () => {
      const existingPayload = { title: "Newer Server Title" };
      const incomingPayload = { title: "Older Client Title" };
      const existingTimestamp = new Date("2026-09-01T10:10:00Z");
      const incomingTimestamp = new Date("2026-09-01T10:05:00Z");

      const result = service.resolveLwwFieldMerge(
        existingPayload,
        incomingPayload,
        existingTimestamp,
        incomingTimestamp,
      );

      expect(result.hadCollision).toBe(true);
      expect(result.mergedPayload.title).toBe("Newer Server Title");
      expect(result.resolvedFields).toEqual([]);
    });

    it("should fall back to version counter when timestamps are missing or equal", () => {
      const existingPayload = { status: "TODO" };
      const incomingPayload = { status: "DONE" };

      // Version counter incoming 2 >= existing 1
      const resultHigherVersion = service.resolveLwwFieldMerge(
        existingPayload,
        incomingPayload,
        undefined,
        undefined,
        1,
        2,
      );

      expect(resultHigherVersion.hadCollision).toBe(true);
      expect(resultHigherVersion.mergedPayload.status).toBe("DONE");

      // Version counter incoming 1 < existing 2
      const resultLowerVersion = service.resolveLwwFieldMerge(
        existingPayload,
        incomingPayload,
        undefined,
        undefined,
        2,
        1,
      );

      expect(resultLowerVersion.hadCollision).toBe(true);
      expect(resultLowerVersion.mergedPayload.status).toBe("TODO");
    });

    it("should not mark collision if values are identical", () => {
      const existingPayload = { title: "Same Title" };
      const incomingPayload = { title: "Same Title" };

      const result = service.resolveLwwFieldMerge(
        existingPayload,
        incomingPayload,
      );

      expect(result.hadCollision).toBe(false);
      expect(result.mergedPayload).toEqual({ title: "Same Title" });
    });

    it("should perform full blob LWW replacement for encrypted payload wrappers", () => {
      const existingEncrypted = {
        isEncrypted: true,
        ciphertext: "cipher1",
        iv: "iv1",
        authTag: "tag1",
        algorithm: "aes-256-gcm",
      };
      const incomingEncrypted = {
        isEncrypted: true,
        ciphertext: "cipher2",
        iv: "iv2",
        authTag: "tag2",
        algorithm: "aes-256-gcm",
      };

      const resultNewerIncoming = service.resolveLwwFieldMerge(
        existingEncrypted,
        incomingEncrypted,
        new Date("2026-09-01T10:00:00Z"),
        new Date("2026-09-01T10:05:00Z"),
      );

      expect(resultNewerIncoming.hadCollision).toBe(true);
      expect(resultNewerIncoming.mergedPayload).toEqual(incomingEncrypted);

      const resultNewerExisting = service.resolveLwwFieldMerge(
        existingEncrypted,
        incomingEncrypted,
        new Date("2026-09-01T10:10:00Z"),
        new Date("2026-09-01T10:05:00Z"),
      );

      expect(resultNewerExisting.hadCollision).toBe(true);
      expect(resultNewerExisting.mergedPayload).toEqual(existingEncrypted);
    });
  });
});
