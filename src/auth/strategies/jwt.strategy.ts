import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigurationService } from "@/config/configuration.service";
import { UsersService } from "@/users/users.service";

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
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.jwtAccessSecret,
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.usersService.getUserById(payload.sub);
    if (!user || user.status !== "ACTIVE" || user.deletedAt) {
      throw new UnauthorizedException("User account is inactive or invalid");
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
