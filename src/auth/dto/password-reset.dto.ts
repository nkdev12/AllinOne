import { ApiProperty } from "@nestjs/swagger";
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

export class ForgotPasswordDto {
  @ApiProperty({
    example: "user@example.com",
    description: "User email address",
  })
  @IsEmail({}, { message: "Invalid email address" })
  @IsNotEmpty()
  @MaxLength(254)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({
    example: "user@example.com",
    description: "Account the reset code was sent to",
  })
  @IsEmail({}, { message: "Invalid email address" })
  @IsNotEmpty()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    example: "123456",
    description: "6-digit reset code received by email",
  })
  @IsString()
  @Length(6, 6, { message: "Reset code must be 6 digits" })
  @Matches(/^\d{6}$/, { message: "Reset code must be 6 digits" })
  otp!: string;

  @ApiProperty({
    example: "NewSecureP@ssw0rd!",
    description: "New password (minimum 8 characters)",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: "Password must be at least 8 characters long" })
  @MaxLength(256, { message: "Password must be at most 256 characters long" })
  newPassword!: string;
}
