import { Injectable, ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard, normalizeIp } from "@nestjs/throttler";

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
      env.NODE_ENV === "test" ||
      env.DISABLE_RATE_LIMITING === "true" ||
      env.RATE_LIMIT_ENABLED === "false"
    );
  }

  protected override async shouldSkip(
    context: ExecutionContext,
  ): Promise<boolean> {
    const env = process.env;

    // Limits are active by default. An explicit true is kept so an operator
    // can override a temporary local disable without restarting with a new
    // environment file.
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
    // Compound key: Throttle authenticated users per-user, unauthenticated per-IP
    const userId = req.user?.id || req.user?.userId || req.user?.sub;
    if (userId) {
      return `user:${userId}`;
    }

    // Express resolves the trusted proxy chain into `req.ip`. The raw forwarding
    // headers are client-controlled, and a bucket a client can pick is a bucket a
    // client can refill.
    const ip = req.ip || req.socket?.remoteAddress || "127.0.0.1";

    // One client owns an IPv6 subnet rather than an address, so an unmasked IPv6
    // tracker hands out a fresh allowance for every address in its /64 — a limit
    // that only looks enforced. The prefix stays configurable because a network
    // handing out shorter prefixes than /64 needs to widen it.
    return `ip:${normalizeIp(ip, this.ipv6SubnetPrefix)}`;
  }
}
