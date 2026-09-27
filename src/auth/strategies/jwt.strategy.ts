import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigurationService } from "@/config/configuration.service";
import { UsersService } from "@/users/users.service";
import { ErrorCode } from "@/common/errors/error-code";
import { unauthorized } from "@/common/errors/http-errors";

export interface JwtPayload {
  sub: string;
  email: string;
  sessionId?: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(
    configService: ConfigurationService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: any) => {
          const auth = req?.headers?.authorization;
          if (auth && typeof auth === "string") {
            const match = auth.match(
              /(?:Bearer\s+)+([A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*)/i,
            );
            if (match) {
              return match[1];
            }
          }
          return null;
        },
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.jwtAccessSecret,
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.usersService.getUserById(payload.sub);
    if (!user || user.status !== "ACTIVE" || user.deletedAt) {
      throw unauthorized(
        ErrorCode.ACCOUNT_DISABLED,
        "User account is inactive or invalid",
      );
    }

    // The token proves who you were when it was signed; the row proves you are
    // still allowed to be. Without this, "log out everywhere" leaves every
    // signed-in device reading the vault until its access token expires.
    // Tokens with no `sessionId` are the ones minted before sessions were
    // stamped, and the paths that use them, so they keep passing.
    if (
      payload.sessionId &&
      !(await this.usersService.isSessionLive(payload.sub, payload.sessionId))
    ) {
      throw unauthorized(
        ErrorCode.SESSION_REVOKED,
        "Session has been revoked or no longer exists.",
      );
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      sessionId: payload.sessionId,
    };
  }
}
