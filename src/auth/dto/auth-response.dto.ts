import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class UserProfileDto {
  @ApiProperty({ example: "123e4567-e89b-12d3-a456-426614174000" })
  id!: string;

  @ApiProperty({ example: "user@example.com" })
  email!: string;

  @ApiProperty({ example: "John Doe", nullable: true })
  displayName!: string | null;

  @ApiProperty({ example: "en-US" })
  locale!: string;

  @ApiProperty({ example: "UTC" })
  timezone!: string;

  @ApiProperty({ example: "ACTIVE" })
  status!: string;

  @ApiProperty({ example: "2026-09-07T12:00:00.000Z" })
  createdAt!: Date;
}

export class AuthTokenDataDto {
  @ApiProperty({ example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." })
  accessToken!: string;

  @ApiProperty({ example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." })
  refreshToken!: string;

  @ApiProperty({
    example: 900,
    description: "Access token expiration in seconds",
  })
  expiresIn!: number;
}

export class AuthResponseDto {
  @ApiPropertyOptional({ type: UserProfileDto })
  user?: UserProfileDto;

  @ApiPropertyOptional({ type: AuthTokenDataDto })
  tokens?: AuthTokenDataDto;

  @ApiPropertyOptional({ example: "123e4567-e89b-12d3-a456-426614174000" })
  sessionId?: string;

  @ApiPropertyOptional({
    example: true,
    description: "Indicates if 2FA authentication code is required",
  })
  mfaRequired?: boolean;

  @ApiPropertyOptional({ description: "Temporary 2FA completion token" })
  mfaToken?: string;
}
