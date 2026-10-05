import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { ConfigurationService } from "@/config/configuration.service";

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigurationService) {}

  /**
   * Decision order, every branch failing closed:
   *   0. no authenticated user -> denied (the secret below is not an identity)
   *   1. ADMIN_SECRET configured (>= ADMIN_SECRET_MIN_LENGTH) and a matching
   *      `x-admin-secret` header on the authenticated request
   *   2. the caller's email in ADMIN_EMAILS
   *   3. the caller's user id in ADMIN_USER_IDS
   * An unset or blank list admits nobody — see ConfigurationService, which
   * normalises these values and holds no default addresses.
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // AdminController stacks this guard behind JwtAuthGuard, so `user` is
    // always set in practice. Checked first anyway so that the header below
    // can never be a standalone bypass if the guard is reused elsewhere.
    if (!user) {
      throw new ForbiddenException("Authentication required for admin access");
    }

    // Operator escalation for scripted incident response: an already
    // authenticated caller that also holds the shared secret. ConfigurationService
    // returns undefined for a missing, blank or too-short ADMIN_SECRET.
    const adminSecret = this.configService.adminSecret;
    if (adminSecret && this.secretsMatch(adminSecret, request.headers)) {
      return true;
    }

    // There is no role check here on purpose: JwtStrategy.validate() returns
    // { id, email, displayName, status, sessionId } and the User model in
    // prisma/schema.prisma has no role/isAdmin column, so a `user.role` branch
    // could never fire. Role-based access needs both of those first.
    const email =
      typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
    if (email && this.configService.adminEmails.includes(email)) {
      return true;
    }

    const userId = typeof user.id === "string" ? user.id.trim() : "";
    if (userId && this.configService.adminUserIds.includes(userId)) {
      return true;
    }

    throw new ForbiddenException(
      "Access denied: administrative privileges required",
    );
  }

  private secretsMatch(
    expected: string,
    headers: Record<string, unknown> | undefined,
  ): boolean {
    const provided = headers?.["x-admin-secret"];
    if (typeof provided !== "string" || provided.length === 0) {
      return false;
    }

    const expectedBuf = Buffer.from(expected, "utf8");
    const providedBuf = Buffer.from(provided, "utf8");
    if (expectedBuf.length !== providedBuf.length) {
      // timingSafeEqual throws on unequal lengths. Length is not the secret, so
      // returning early here keeps the comparison constant time for real
      // candidates without leaking anything useful.
      return false;
    }

    return timingSafeEqual(expectedBuf, providedBuf);
  }
}
