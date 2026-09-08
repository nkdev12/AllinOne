import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateUserProfileDto {
  @ApiPropertyOptional({
    example: "John Doe",
    description: "Display name of the user",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayName?: string;

  @ApiPropertyOptional({
    example: "https://example.com/avatar.png",
    description: "Avatar URL",
  })
  @IsOptional()
  @IsString()
  avatar?: string;

  @ApiPropertyOptional({ example: "en-US", description: "Preferred locale" })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;

  @ApiPropertyOptional({
    example: "America/New_York",
    description: "User timezone",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;
}
