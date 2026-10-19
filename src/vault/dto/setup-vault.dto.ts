import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  Max,
  Length,
  Matches,
  MaxLength,
  IsBase64,
  Equals,
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
  @IsBase64()
  @Length(44, 44)
  masterKeyHash!: string;

  @ApiProperty({
    example: "c2FsdF9iYXNlNjRfc3RyaW5n",
    description: "Base64 encoded client salt for PBKDF2/Argon2",
  })
  @IsString()
  @IsNotEmpty()
  // The same rule `CompleteVaultRecoveryDto` applies, and for the same field:
  // `recovery/verify` hands this exact string back to the client, which sends it
  // to `recovery/complete`. A salt that does not satisfy that DTO strands the
  // rotation in a 400 the client has no way to construct its way out of — the
  // check belongs on the write, not on the recovery attempt months later.
  // 16 random bytes base64-encoded is 24 characters, which is what the shipped
  // client derives with.
  @IsBase64()
  @Length(24, 24)
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
  @Max(10)
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
  @Max(262144)
  kdfMemory?: number;

  // Recovery envelope: the master key wrapped under a key the client derives
  // from the user's 12-word phrase and this salt. The wrapping key itself is
  // never uploaded — a build that sends one is refused here, because a stored
  // key-encryption-key makes every vault on the server recoverable by anyone
  // with database access.
  @ApiPropertyOptional({ description: "Base64 salt for the recovery KDF" })
  @IsOptional()
  @IsBase64()
  @Length(24, 24)
  recoveryKdfSalt?: string;

  @ApiPropertyOptional({ description: "AES-GCM ciphertext of the master key" })
  @IsOptional()
  @IsBase64()
  @MaxLength(4096)
  wrappedMasterKey?: string;

  @ApiPropertyOptional({ description: "IV used for the wrapped master key" })
  @IsOptional()
  @IsBase64()
  @MaxLength(128)
  wrappedMasterIv?: string;

  @ApiPropertyOptional({ description: "GCM tag for the wrapped master key" })
  @IsOptional()
  @IsBase64()
  @MaxLength(128)
  wrappedMasterTag?: string;
}

export class VerifyVaultRecoveryDto {
  @ApiProperty({ description: "6-digit code emailed for vault recovery" })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: "OTP must be 6 digits" })
  otp!: string;
}

/** Recovery changes the password wrapper, never the entry encryption key. */
export class CompleteVaultRecoveryDto {
  @IsString()
  @IsNotEmpty()
  @IsBase64()
  @Length(44, 44)
  masterKeyHash!: string;

  @IsBase64()
  @Length(24, 24)
  keySalt!: string;

  @IsBase64()
  @Length(44, 44)
  passwordWrappedKey!: string;

  @IsBase64()
  @Length(16, 16)
  passwordWrappedIv!: string;

  @IsBase64()
  @Length(24, 24)
  passwordWrappedTag!: string;

  @Equals(3)
  kdfIterations!: number;

  @Equals(65536)
  kdfMemory!: number;

  // Optional envelope upgrade. A client that recovers a vault whose row still
  // holds a legacy unwrapped `recoveryKey` supplies a phrase-derived wrap here,
  // and the service replaces the plaintext key with it in the same write.
  @ApiPropertyOptional({ description: "Base64 salt for the recovery KDF" })
  @IsOptional()
  @IsBase64()
  @Length(24, 24)
  recoveryKdfSalt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBase64()
  @Length(44, 44)
  wrappedMasterKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBase64()
  @Length(16, 16)
  wrappedMasterIv?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBase64()
  @Length(24, 24)
  wrappedMasterTag?: string;
}
