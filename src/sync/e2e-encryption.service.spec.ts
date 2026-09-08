import { Test, TestingModule } from "@nestjs/testing";
import { E2eEncryptionService } from "./e2e-encryption.service";
import { BadRequestException } from "@nestjs/common";
import * as crypto from "crypto";

describe("E2eEncryptionService", () => {
  let service: E2eEncryptionService;
  const sampleKeyHex = crypto.randomBytes(32).toString("hex");
  const sampleKeyBuffer = Buffer.from(sampleKeyHex, "hex");

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [E2eEncryptionService],
    }).compile();

    service = module.get<E2eEncryptionService>(E2eEncryptionService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("encryptPayload and decryptPayload", () => {
    it("should successfully encrypt and decrypt a plain JSON object payload with hex key", () => {
      const originalPayload = {
        title: "Secret Note",
        content: "Top secret content for sync",
        tags: ["private", "e2ee"],
      };

      const encrypted = service.encryptPayload(
        originalPayload,
        sampleKeyHex,
        "key-1",
      );

      expect(encrypted.isEncrypted).toBe(true);
      expect(encrypted.algorithm).toBe("aes-256-gcm");
      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.authTag).toBeDefined();
      expect(encrypted.keyId).toBe("key-1");

      const decrypted = service.decryptPayload(encrypted, sampleKeyHex);
      expect(decrypted).toEqual(originalPayload);
    });

    it("should successfully encrypt and decrypt with Buffer key", () => {
      const originalPayload = { amount: 100, currency: "USD" };

      const encrypted = service.encryptPayload(
        originalPayload,
        sampleKeyBuffer,
      );
      const decrypted = service.decryptPayload(encrypted, sampleKeyBuffer);

      expect(decrypted).toEqual(originalPayload);
    });

    it("should throw BadRequestException when decrypting with wrong key", () => {
      const originalPayload = { data: "sensitive" };
      const wrongKeyHex = crypto.randomBytes(32).toString("hex");

      const encrypted = service.encryptPayload(originalPayload, sampleKeyHex);

      expect(() => service.decryptPayload(encrypted, wrongKeyHex)).toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when authentication tag is tampered with", () => {
      const originalPayload = { data: "tampered payload" };
      const encrypted = service.encryptPayload(originalPayload, sampleKeyHex);

      // Alter last char of authTag
      const tamperedAuthTag =
        encrypted.authTag.slice(0, -1) +
        (encrypted.authTag.slice(-1) === "a" ? "b" : "a");

      const tamperedWrapper = {
        ...encrypted,
        authTag: tamperedAuthTag,
      };

      expect(() =>
        service.decryptPayload(tamperedWrapper, sampleKeyHex),
      ).toThrow(BadRequestException);
    });

    it("should throw BadRequestException if key is not 32 bytes", () => {
      const invalidKey = "short-key";

      expect(() => service.encryptPayload({ test: 1 }, invalidKey)).toThrow(
        BadRequestException,
      );
    });
  });

  describe("isEncryptedPayload", () => {
    it("should return true for valid EncryptedPayloadWrapper", () => {
      const validWrapper = service.encryptPayload({ a: 1 }, sampleKeyHex);
      expect(service.isEncryptedPayload(validWrapper)).toBe(true);
    });

    it("should return false for plain object payloads", () => {
      expect(service.isEncryptedPayload({ title: "Plain Note" })).toBe(false);
      expect(service.isEncryptedPayload(null)).toBe(false);
      expect(service.isEncryptedPayload("string")).toBe(false);
    });
  });
});
