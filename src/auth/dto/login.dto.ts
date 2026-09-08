import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from "class-validator";
import { Platform } from "@prisma/client";

export class LoginDto {
  @ApiProperty({
    example: "user@example.com",
    description: "User email address",
  })
  @IsEmail({}, { message: "Invalid email address" })
  @IsNotEmpty()
  email!: string;

  @ApiProperty({ example: "SecureP@ssw0rd!", description: "Password" })
  @IsString()
  @IsNotEmpty()
  password!: string;

  @ApiPropertyOptional({
    example: "My Laptop",
    description: "Name of the device logging in",
  })
  @IsOptional()
  @IsString()
  deviceName?: string;

  @ApiPropertyOptional({
    enum: Platform,
    example: Platform.LINUX,
    description: "Device platform",
  })
  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;

  @ApiPropertyOptional({
    example: "1.0.0",
    description: "App version running on the device",
  })
  @IsOptional()
  @IsString()
  appVersion?: string;

  @ApiPropertyOptional({
    example: "pubkey_xyz...",
    description: "Device public key for end-to-end encryption setup",
  })
  @IsOptional()
  @IsString()
  publicKey?: string;
}
