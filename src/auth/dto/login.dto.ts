import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
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
    example: "123e4567-e89b-12d3-a456-426614174000",
    description:
      "Device row an earlier sign-in handed this client. Ignored unless it " +
      "belongs to this user and has not been revoked.",
  })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

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
