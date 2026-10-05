import { IsEmail, IsNotEmpty, IsString, IsOptional } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class VerifyEmailRequestDto {
  @ApiProperty({
    example: "user@example.com",
    description: "User email address",
  })
  @IsEmail({}, { message: "Invalid email address" })
  @IsNotEmpty()
  email!: string;
}

export class ConfirmEmailDto {
  @ApiPropertyOptional({
    description: "Email verification token received via email (if using link)",
  })
  @IsString()
  @IsOptional()
  token?: string;

  @ApiPropertyOptional({ description: "User email (if using OTP)" })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ description: "6-digit OTP code received via email" })
  @IsString()
  @IsOptional()
  otp?: string;
}
