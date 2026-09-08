import { Injectable, BadRequestException } from "@nestjs/common";
import * as crypto from "crypto";

export interface EncryptedPayloadWrapper {
  isEncrypted: true;
  ciphertext: string;
  iv: string;
  authTag: string;
  algorithm: "aes-256-gcm";
  keyId?: string;
}

@Injectable()
export class E2eEncryptionService {
  private readonly ALGORITHM = "aes-256-gcm";
  private readonly IV_LENGTH = 12; // Standard 96-bit IV for AES-GCM
  private readonly AUTH_TAG_LENGTH = 16; // Standard 128-bit auth tag

  /**
   * Encrypts a JSON payload object using AES-256-GCM symmetric key encryption.
   *
   * @param payload The plain JSON payload object to encrypt
   * @param keyHexOrBuffer 32-byte (256-bit) secret key in hex string or Buffer
   * @param keyId Optional key identifier (e.g. device key ID or master key fingerprint)
   * @returns EncryptedPayloadWrapper object
   */
  encryptPayload(
    payload: Record<string, any>,
    keyHexOrBuffer: string | Buffer,
    keyId?: string,
  ): EncryptedPayloadWrapper {
    const key = this.normalizeKey(keyHexOrBuffer);
    const iv = crypto.randomBytes(this.IV_LENGTH);

    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv, {
      authTagLength: this.AUTH_TAG_LENGTH,
    });

    const jsonString = JSON.stringify(payload ?? {});
    let encrypted = cipher.update(jsonString, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag().toString("hex");

    return {
      isEncrypted: true,
      ciphertext: encrypted,
      iv: iv.toString("hex"),
      authTag,
      algorithm: this.ALGORITHM,
      ...(keyId ? { keyId } : {}),
    };
  }

  /**
   * Decrypts an EncryptedPayloadWrapper back into the original plain JSON payload object.
   *
   * @param wrapper Encrypted payload wrapper containing ciphertext, iv, authTag
   * @param keyHexOrBuffer 32-byte (256-bit) secret key in hex string or Buffer
   * @returns Decrypted plain JSON payload object
   */
  decryptPayload(
    wrapper: EncryptedPayloadWrapper,
    keyHexOrBuffer: string | Buffer,
  ): Record<string, any> {
    if (!this.isEncryptedPayload(wrapper)) {
      throw new BadRequestException(
        "Invalid encrypted payload wrapper format.",
      );
    }

    const key = this.normalizeKey(keyHexOrBuffer);
    const iv = Buffer.from(wrapper.iv, "hex");
    const authTag = Buffer.from(wrapper.authTag, "hex");

    try {
      const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv, {
        authTagLength: this.AUTH_TAG_LENGTH,
      });
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(wrapper.ciphertext, "hex", "utf8");
      decrypted += decipher.final("utf8");

      return JSON.parse(decrypted);
    } catch (err: any) {
      throw new BadRequestException(
        `Failed to decrypt E2EE payload: ${err.message || "Invalid key or authentication tag mismatch"}`,
      );
    }
  }

  /**
   * Checks whether a given object is a valid EncryptedPayloadWrapper structure.
   */
  isEncryptedPayload(payload: any): payload is EncryptedPayloadWrapper {
    return (
      typeof payload === "object" &&
      payload !== null &&
      payload.isEncrypted === true &&
      typeof payload.ciphertext === "string" &&
      typeof payload.iv === "string" &&
      typeof payload.authTag === "string" &&
      payload.algorithm === "aes-256-gcm"
    );
  }

  private normalizeKey(keyHexOrBuffer: string | Buffer): Buffer {
    let keyBuffer: Buffer;
    if (typeof keyHexOrBuffer === "string") {
      keyBuffer = Buffer.from(keyHexOrBuffer, "hex");
    } else {
      keyBuffer = keyHexOrBuffer;
    }

    if (keyBuffer.length !== 32) {
      throw new BadRequestException(
        `Encryption key must be exactly 32 bytes (256-bit). Provided length: ${keyBuffer.length} bytes.`,
      );
    }

    return keyBuffer;
  }
}
