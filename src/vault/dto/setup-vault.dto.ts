import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  Length,
} from "class-validator";

export class SetupVaultDto {
  @ApiProperty({
    example: "q7L1Z3mYxk1hZ8jH0lYXn0K8pQe1o2uW3r5t7y9b0cA=",
    description:
      "base64(SHA-256(argon2id(master password, keySalt))) — the verifier, not " +
      "the key. Stored as an HMAC of itself under the server's ENCRYPTION_KEY.",
  })
  @IsString()
  @IsNotEmpty()
  masterKeyHash!: string;

  @ApiProperty({
    example: "c2FsdF9iYXNlNjRfc3RyaW5n",
    description: "Base64 encoded client salt for PBKDF2/Argon2",
  })
  @IsString()
  @IsNotEmpty()
  keySalt!: string;

  @ApiPropertyOptional({
    example: 3,
    description:
      "Argon2id time cost (`t`) the client derived with. Recorded only — the " +
      "server never reads it back to configure a KDF, and the copy a future " +
      "build can trust is the `_kdf` marker sealed inside each blob. Omit it " +
      "and the row stores what the shipped client uses (3).",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  kdfIterations?: number;

  @ApiPropertyOptional({
    example: 65536,
    description:
      "Argon2id memory cost in KiB (`m`), recorded only. The shipped client " +
      "uses 65536, i.e. 64 MiB.",
  })
  @IsOptional()
  @IsInt()
  @Min(1024)
  kdfMemory?: number;

  // Recovery blob: the master key wrapped so an OTP-verified reset can
  // re-encrypt the vault instead of discarding it.
  @ApiPropertyOptional({ description: "Key that wraps the master key" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  recoveryKey?: string;

  @ApiPropertyOptional({ description: "AES-GCM ciphertext of the master key" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  wrappedMasterKey?: string;

  @ApiPropertyOptional({ description: "IV used for the wrapped master key" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  wrappedMasterIv?: string;

  @ApiPropertyOptional({ description: "GCM tag for the wrapped master key" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  wrappedMasterTag?: string;
}

export class VerifyVaultRecoveryDto {
  @ApiProperty({ description: "6-digit code emailed for vault recovery" })
  @IsString()
  @Length(6, 6)
  otp!: string;
}
