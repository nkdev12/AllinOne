import {
  IsEmail,
  IsNotEmpty,
  IsString,
  IsOptional,
  Matches,
  MaxLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class VerifyEmailRequestDto {
  @ApiProperty({
    example: "user@example.com",
    description: "User email address",
  })
  @IsEmail({}, { message: "Invalid email address" })
  @IsNotEmpty()
  @MaxLength(254)
  email!: string;
}

export class ConfirmEmailDto {
  @ApiPropertyOptional({
    description: "Email verification token received via email (if using link)",
  })
  @IsString()
  @IsOptional()
  @MaxLength(2048)
  token?: string;

  @ApiPropertyOptional({ description: "User email (if using OTP)" })
  @IsEmail()
  @IsOptional()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ description: "6-digit OTP code received via email" })
  @IsString()
  @IsOptional()
  @Matches(/^\d{6}$/, { message: "OTP must be 6 digits" })
  otp?: string;
}
