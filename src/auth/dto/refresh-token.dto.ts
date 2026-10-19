import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Proves a refresh request came from this app rather than from somebody else's
 * form. A browser attaches the ambient cookie to a cross-site POST without
 * asking, and no page outside ours can add a custom header to it. The Flutter
 * client sets this on every request it makes (`_getBaseHeaders` in
 * `lib/services/api_service.dart`), and it is already in the CORS
 * `allowedHeaders`, so the barrier needs no new preflight allowance.
 */
export const REFRESH_REQUEST_HEADER = "x-client-version";

export class RefreshTokenDto {
  @ApiPropertyOptional({
    description:
      "Refresh token provided during authentication. Omit it in the browser and the httpOnly cookie is used instead — such requests must carry the `" +
      REFRESH_REQUEST_HEADER +
      "` header. The body form exists for native clients, which prove possession of the token itself.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  refreshToken?: string;
}
