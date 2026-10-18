import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { ConfigurationService } from "@/config/configuration.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { AdminGuard } from "@/admin/guards/admin.guard";

/**
 * Message a credential-less request to `GET /metrics` has always produced:
 * `JwtAuthGuard.handleRequest` throws it for any request passport cannot
 * resolve a user for, and `AllExceptionsFilter` maps an `UnauthorizedException`
 * that carries no `code` of its own onto `UNAUTHORIZED`. The literal is
 * duplicated instead of delegated to because the whole point of this guard is
 * to answer that request without running passport; the cost is that a rewording
 * in `jwt-auth.guard.ts` must be brought here too.
 */
const TOKENLESS_MESSAGE = "Authentication token missing or invalid";

/**
 * The one guard on `GET /metrics`, and the only one that knows a Prometheus
 * scrape has no JWT to present.
 *
 * `@UseGuards(JwtAuthGuard, AdminGuard)` — the pair every other admin surface
 * uses — can never authorise a scrape: guards run in the order they are
 * declared, so `JwtAuthGuard` rejected the request with a 401 before
 * `AdminGuard`'s `x-admin-secret` branch was reached, and that branch is itself
 * behind a `!request.user` refusal. `ADMIN_SECRET` was therefore dead
 * configuration and every scrape interval logged a 401 while monitoring looked
 * configured and silently reported nothing. This guard reorders the two
 * presentations rather than reimplementing either of them, so the human path
 * keeps borrowing the real guards.
 *
 * Decision order, every branch failing closed:
 *   1. machine: `ConfigurationService.adminSecret` is configured (it returns
 *      `undefined` for a missing, blank or under-`ADMIN_SECRET_MIN_LENGTH`
 *      value, which disables this branch outright) and the complete secret is
 *      presented either as `Authorization: Bearer <secret>` — the shape
 *      Prometheus's `authorization: { type: Bearer, credentials_file }` emits —
 *      or as `x-admin-secret: <secret>`
 *   2. human: any `Authorization` header at all is delegated to the real
 *      `JwtAuthGuard` and then the real `AdminGuard` on the same context, so a
 *      signed-in admin behaves exactly as before, including the session
 *      revocation checks `JwtStrategy.validate()` runs inside `JwtAuthGuard`
 *   3. anonymous: the same 401/`UNAUTHORIZED` the endpoint has always returned
 *      to a browser with no credentials — not a 403, because nothing about the
 *      caller was established enough to be refused
 */
@Injectable()
export class MetricsScrapeGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigurationService,
    private readonly jwtAuthGuard: JwtAuthGuard,
    private readonly adminGuard: AdminGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const headers = this.headersOf(context);
    const authorization = headers["authorization"];

    const adminSecret = this.configService.adminSecret;
    if (adminSecret && this.presentsSecret(adminSecret, headers)) {
      return true;
    }

    // A bearer value that is not the secret is a candidate JWT, and it has to be
    // read as exactly one or the other: step 1 already compared it in full, so
    // falling through here means "this is a person, ask the real guards".
    if (typeof authorization === "string" && authorization.length > 0) {
      // The same context object, not a rebuilt one — `JwtAuthGuard` writes the
      // resolved user onto the request and `AdminGuard` reads it back off that
      // request through `context.switchToHttp()`.
      const authenticated = await this.jwtAuthGuard.canActivate(context);
      if (!authenticated) {
        // Unreachable with the real passport guard, which throws rather than
        // returning false. Kept as a refusal so a guard that reports "no user"
        // quietly can never fall through to the metrics handler.
        throw new UnauthorizedException(TOKENLESS_MESSAGE);
      }
      return this.adminGuard.canActivate(context);
    }

    throw new UnauthorizedException(TOKENLESS_MESSAGE);
  }

  /**
   * The two credential shapes, each compared against the whole secret on its
   * own. Neither branch reads the other's header and neither trims, splits or
   * concatenates, so a request cannot assemble a match out of half of a bearer
   * value and half of an `x-admin-secret`, and a bearer value that merely
   * starts with the secret does not match.
   */
  private presentsSecret(
    expected: string,
    headers: Record<string, unknown>,
  ): boolean {
    return (
      this.secretsMatch(expected, this.bearerValue(headers["authorization"])) ||
      this.secretsMatch(expected, headers["x-admin-secret"])
    );
  }

  private bearerValue(authorization: unknown): string | undefined {
    if (typeof authorization !== "string") {
      // Node joins duplicate `Authorization` headers with ", ", which is not a
      // Bearer presentation of anything and must not be read as one.
      return undefined;
    }
    const separator = authorization.indexOf(" ");
    if (separator <= 0) {
      return undefined;
    }
    if (authorization.slice(0, separator).toLowerCase() !== "bearer") {
      return undefined;
    }
    const value = authorization.slice(separator + 1);
    return value.length > 0 ? value : undefined;
  }

  /**
   * Same shape as `AdminGuard.secretsMatch`, which it exists to mirror: a
   * constant-time compare over the only two presentations this branch accepts.
   * `provided` stays `unknown` because a repeated header arrives as an array,
   * and that has to be a refusal rather than a type error.
   */
  private secretsMatch(expected: string, provided: unknown): boolean {
    if (typeof provided !== "string" || provided.length === 0) {
      return false;
    }

    const expectedBuf = Buffer.from(expected, "utf8");
    const providedBuf = Buffer.from(provided, "utf8");
    if (expectedBuf.length !== providedBuf.length) {
      // `timingSafeEqual` throws on unequal lengths, and a scrape whose
      // credentials file picked up a trailing character would otherwise reach
      // the exception filter as a 500 rather than a refusal. Length is not the
      // secret, so returning early leaks nothing while keeping the comparison of
      // real candidates constant time.
      return false;
    }

    return timingSafeEqual(expectedBuf, providedBuf);
  }

  private headersOf(context: ExecutionContext): Record<string, unknown> {
    const request = context.switchToHttp().getRequest();
    return (request?.headers ?? {}) as Record<string, unknown>;
  }
}
