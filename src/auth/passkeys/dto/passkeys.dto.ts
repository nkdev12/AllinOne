import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsArray,
  IsEmail,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class RegisterOptionsDto {
  @ApiPropertyOptional({
    example: "MacBook Pro TouchID",
    description: "User-friendly device label",
  })
  @IsOptional()
  @IsString()
  deviceName?: string;
}

export class RegisterVerifyDto {
  @ApiProperty({
    example: "base64url-credential-id",
    description: "Base64URL encoded credential ID",
  })
  @IsString()
  @IsNotEmpty()
  id!: string;

  @ApiProperty({
    example: "base64url-clientDataJSON",
    description: "Base64URL clientDataJSON",
  })
  @IsString()
  @IsNotEmpty()
  clientDataJSON!: string;

  @ApiProperty({
    example: "base64url-attestationObject",
    description: "Base64URL attestationObject",
  })
  @IsString()
  @IsNotEmpty()
  attestationObject!: string;

  @ApiPropertyOptional({ example: ["internal", "hybrid"] })
  @IsOptional()
  @IsArray()
  transports?: string[];

  @ApiPropertyOptional({ example: "MacBook Pro TouchID" })
  @IsOptional()
  @IsString()
  deviceName?: string;
}

export class LoginOptionsDto {
  @ApiPropertyOptional({
    example: "user@example.com",
    description: "User email for non-discoverable passkeys",
  })
  @IsOptional()
  @IsEmail()
  email?: string;
}

export class LoginVerifyDto {
  @ApiProperty({
    example: "base64url-credential-id",
    description: "Base64URL encoded credential ID",
  })
  @IsString()
  @IsNotEmpty()
  id!: string;

  @ApiProperty({
    example: "base64url-clientDataJSON",
    description: "Base64URL clientDataJSON",
  })
  @IsString()
  @IsNotEmpty()
  clientDataJSON!: string;

  @ApiProperty({
    example: "base64url-authenticatorData",
    description: "Base64URL authenticatorData",
  })
  @IsString()
  @IsNotEmpty()
  authenticatorData!: string;

  @ApiProperty({
    example: "base64url-signature",
    description: "Base64URL signature",
  })
  @IsString()
  @IsNotEmpty()
  signature!: string;

  @ApiPropertyOptional({ example: "base64url-userHandle" })
  @IsOptional()
  @IsString()
  userHandle?: string;
}
