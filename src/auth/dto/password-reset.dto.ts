import { ApiProperty } from "@nestjs/swagger";
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Length,
  MinLength,
} from "class-validator";

export class ForgotPasswordDto {
  @ApiProperty({
    example: "user@example.com",
    description: "User email address",
  })
  @IsEmail({}, { message: "Invalid email address" })
  @IsNotEmpty()
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({
    example: "user@example.com",
    description: "Account the reset code was sent to",
  })
  @IsEmail({}, { message: "Invalid email address" })
  @IsNotEmpty()
  email!: string;

  @ApiProperty({
    example: "123456",
    description: "6-digit reset code received by email",
  })
  @IsString()
  @Length(6, 6, { message: "Reset code must be 6 digits" })
  otp!: string;

  @ApiProperty({
    example: "NewSecureP@ssw0rd!",
    description: "New password (minimum 8 characters)",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: "Password must be at least 8 characters long" })
  newPassword!: string;
}
