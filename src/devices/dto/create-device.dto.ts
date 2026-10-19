import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { Platform } from "@prisma/client";

export class CreateDeviceDto {
  @ApiProperty({
    example: "My Laptop",
    description: "Name of the client device",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    enum: Platform,
    example: Platform.LINUX,
    description: "Device platform",
  })
  @IsEnum(Platform)
  platform!: Platform;

  @ApiProperty({
    example: "1.0.0",
    description: "App version running on device",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  appVersion!: string;

  @ApiPropertyOptional({ example: "Fedora 39", description: "OS version" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  osVersion?: string;

  @ApiPropertyOptional({
    example: "pubkey_xyz...",
    description: "Device public key for end-to-end encryption",
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  publicKey?: string;
}
