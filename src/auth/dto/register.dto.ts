import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from "class-validator";

export class RegisterDto {
  @ApiProperty({
    example: "user@example.com",
    description: "User email address",
  })
  @IsEmail({}, { message: "Invalid email address" })
  @IsNotEmpty()
  email!: string;

  @ApiProperty({
    example: "SecureP@ssw0rd!",
    description: "Password (minimum 8 characters)",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: "Password must be at least 8 characters long" })
  password!: string;

  @ApiPropertyOptional({
    example: "John Doe",
    description: "Display name of the user",
  })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiPropertyOptional({ example: "en-US", description: "Preferred locale" })
  @IsOptional()
  @IsString()
  locale?: string;

  @ApiPropertyOptional({ example: "UTC", description: "User timezone" })
  @IsOptional()
  @IsString()
  timezone?: string;
}
