import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class RegisterOptionsDto {
  @ApiPropertyOptional({
    example: "MacBook Pro TouchID",
    description: "User-friendly device label",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;
}

export class RegisterVerifyDto {
  @ApiProperty({
    example: "base64url-credential-id",
    description: "Base64URL encoded credential ID",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  id!: string;

  @ApiProperty({
    example: "base64url-clientDataJSON",
    description: "Base64URL clientDataJSON",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50000)
  clientDataJSON!: string;

  @ApiProperty({
    example: "base64url-attestationObject",
    description: "Base64URL attestationObject",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100000)
  attestationObject!: string;

  @ApiPropertyOptional({ example: ["internal", "hybrid"] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  transports?: string[];

  @ApiPropertyOptional({ example: "MacBook Pro TouchID" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;
}
