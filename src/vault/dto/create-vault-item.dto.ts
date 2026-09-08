import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { VaultItemType } from "@prisma/client";
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from "class-validator";

export class CreateVaultItemDto {
  @ApiProperty({
    enum: VaultItemType,
    example: VaultItemType.LOGIN,
    description: "Type of vault item",
  })
  @IsEnum(VaultItemType)
  type!: VaultItemType;

  @ApiProperty({
    example: "GitHub Account",
    description: "Unencrypted display label",
  })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    example: "Developer Tools",
    description: "Category/Folder label",
  })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({
    example:
      "eyHVzZXJuYW1lIjogInN3YW15a3Jpc2giLCAicGFzc3dvcmQiOiAic2VjcmV0In0=",
    description: "AES-256-GCM encrypted Base64 payload",
  })
  @IsString()
  @IsNotEmpty()
  encryptedData!: string;

  @ApiProperty({
    example: "ZEZtWjlKVE5hY3ZzT2FnYg==",
    description: "Base64 Initialization Vector (IV)",
  })
  @IsString()
  @IsNotEmpty()
  iv!: string;

  @ApiProperty({
    example: "b0RVMU56ZzBOVFEwTlRBMg==",
    description: "Base64 Authentication Tag",
  })
  @IsString()
  @IsNotEmpty()
  authTag!: string;

  @ApiPropertyOptional({ example: false, description: "Favorite flag" })
  @IsOptional()
  @IsBoolean()
  isFavorite?: boolean;
}
