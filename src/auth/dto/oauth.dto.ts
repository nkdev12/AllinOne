import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsNotEmpty, IsOptional, IsString } from "class-validator";
import { Platform } from "@prisma/client";

export class OAuthLoginDto {
  @ApiProperty({
    description:
      "OAuth ID Token obtained from Google, Apple, or Microsoft client SDKs",
  })
  @IsString()
  @IsNotEmpty()
  idToken!: string;

  @ApiPropertyOptional({
    example: "My Pixel Phone",
    description: "Device name",
  })
  @IsOptional()
  @IsString()
  deviceName?: string;

  @ApiPropertyOptional({
    enum: Platform,
    example: Platform.ANDROID,
    description: "Device platform",
  })
  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;

  @ApiPropertyOptional({ example: "1.0.0", description: "App version" })
  @IsOptional()
  @IsString()
  appVersion?: string;

  @ApiPropertyOptional({
    example: "pubkey_xyz...",
    description: "Device public key",
  })
  @IsOptional()
  @IsString()
  publicKey?: string;
}
