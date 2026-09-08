import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsNotEmpty, IsString } from "class-validator";

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
  @ApiProperty({ description: "Email verification token received via email" })
  @IsString()
  @IsNotEmpty()
  token!: string;
}
