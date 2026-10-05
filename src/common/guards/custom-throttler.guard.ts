import { Injectable, ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  /**
   * Whether throttling is off by default for this environment.
   *
   * Kept as a plain function of the environment so the rule can be read — and
   * tested — without building an execution context around it.
   */
  static disabledByDefault(env: NodeJS.ProcessEnv): boolean {
    return (
      env.APP_ENV === "development" ||
      env.NODE_ENV === "test" ||
      env.DISABLE_RATE_LIMITING === "true" ||
      env.RATE_LIMIT_ENABLED === "false"
    );
  }

  protected override async shouldSkip(
    context: ExecutionContext,
  ): Promise<boolean> {
    const env = process.env;

    // An explicit `RATE_LIMIT_ENABLED=true` outranks the environment default.
    // Without that, the limits the controllers declare are inert in exactly the
    // two places anyone ever runs them, and first meet a real workload in
    // production.
    if (!CustomThrottlerGuard.disabledByDefault(env)) {
      return false;
    }
    if (env.RATE_LIMIT_ENABLED === "true") {
      return false;
    }

    // A client must not be able to switch rate limiting off for itself by
    // setting a header, so the bypass is only honoured where an operator opened
    // it — and never in production, where the flag existing is itself the bug.
    if (
      env.RATE_LIMIT_HEADER_BYPASS !== "true" ||
      env.APP_ENV === "production"
    ) {
      return true;
    }

    const req = context.switchToHttp().getRequest();
    return (
      req?.headers?.["x-skip-throttle"] === "true" ||
      req?.headers?.["x-bypass-rate-limit"] === "true"
    );
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
