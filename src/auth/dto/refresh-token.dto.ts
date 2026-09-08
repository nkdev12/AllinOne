import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class RefreshTokenDto {
  @ApiPropertyOptional({
    description:
      "Refresh token provided during authentication (optional if passed via httpOnly cookie)",
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
