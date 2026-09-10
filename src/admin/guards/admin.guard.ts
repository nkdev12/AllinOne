import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // Check optional admin API key header for operator tooling/scripted incident response
    const adminSecret = this.configService.get<string>("ADMIN_SECRET");
    const headerSecret = request.headers["x-admin-secret"];
    if (adminSecret && headerSecret && headerSecret === adminSecret) {
      return true;
    }

    if (!user) {
      throw new ForbiddenException("Authentication required for admin access");
    }

    // Role check if available
    if (user.role === "ADMIN" || user.isAdmin === true) {
      return true;
    }

    // Configured admin emails check
    const adminEmailsRaw = this.configService.get<string>(
      "ADMIN_EMAILS",
      "admin@allinone.app,admin@example.com",
    );
    const adminEmails = adminEmailsRaw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    if (user.email && adminEmails.includes(user.email.toLowerCase())) {
      return true;
    }

    // Configured admin user IDs check
    const adminIdsRaw = this.configService.get<string>("ADMIN_USER_IDS", "");
    const adminIds = adminIdsRaw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (user.id && adminIds.includes(user.id)) {
      return true;
    }

    throw new ForbiddenException(
      "Access denied: administrative privileges required",
    );
  }
}

