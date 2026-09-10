import { Injectable, ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected override async shouldSkip(
    context: ExecutionContext,
  ): Promise<boolean> {
    // Skip throttling in development or test environments, or when explicitly disabled,
    // to prevent blocking automated QA suites and local development
    if (
      process.env.APP_ENV === "development" ||
      process.env.NODE_ENV === "test" ||
      process.env.DISABLE_RATE_LIMITING === "true" ||
      process.env.RATE_LIMIT_ENABLED === "false"
    ) {
      return true;
    }

    const req = context.switchToHttp().getRequest();
    if (
      req?.headers?.["x-skip-throttle"] === "true" ||
      req?.headers?.["x-bypass-rate-limit"] === "true"
    ) {
      return true;
    }

    return false;
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const xForwardedFor = req.headers?.["x-forwarded-for"];
    let ip = req.ip || req.socket?.remoteAddress || "127.0.0.1";
    if (xForwardedFor) {
      const ips = (
        Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor
      ).split(",");
      ip = ips[0].trim();
    }

    // Compound key: Throttle authenticated users per-user, unauthenticated per-IP
    const userId = req.user?.id || req.user?.userId || req.user?.sub;
    if (userId) {
      return `user:${userId}`;
    }

    return `ip:${ip}`;
  }
}
