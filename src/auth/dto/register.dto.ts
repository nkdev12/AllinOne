import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class RegisterDto {
  @ApiProperty({
    example: "user@example.com",
    description: "User email address",
  })
  @IsEmail({}, { message: "Invalid email address" })
  @IsNotEmpty()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    example: "SecureP@ssw0rd!",
    description: "Password (minimum 8 characters)",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: "Password must be at least 8 characters long" })
  @MaxLength(256, { message: "Password must be at most 256 characters long" })
  password!: string;

  @ApiPropertyOptional({
    example: "John Doe",
    description: "Display name of the user",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({ example: "en-US", description: "Preferred locale" })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;

  @ApiPropertyOptional({ example: "UTC", description: "User timezone" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;
}
