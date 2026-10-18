import {
  ArgumentsHost,
  ExecutionContext,
  ForbiddenException,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ConfigurationService } from "@/config/configuration.service";
import { AllExceptionsFilter } from "@/common/error-handling/filters/all-exceptions.filter";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { AdminGuard } from "@/admin/guards/admin.guard";
import { MetricsScrapeGuard } from "./metrics-scrape.guard";

// ConfigurationService's constructor refuses to build without its required
// variables, and ADMIN_SECRET is all this guard reads out of it. Same list as
// admin.guard.spec.ts, kept local on purpose rather than shared: a fixture both
// specs import would let either one widen it without the other noticing.
const REQUIRED_BASE: Record<string, string> = {
  DATABASE_URL: "mongodb://localhost:27017/allinone_test",
  JWT_ACCESS_SECRET: "test-access-secret-value",
  JWT_REFRESH_SECRET: "test-refresh-secret-value",
  OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
  OBJECT_STORAGE_ACCESS_KEY: "minioadmin",
  OBJECT_STORAGE_SECRET_KEY: "minioadmin",
  OBJECT_STORAGE_BUCKET: "allinone-test",
  ENCRYPTION_KEY: "encryption-key-placeholder-0123456789ab",
};

const VALID_SECRET = "operator-break-glass-secret-0123456789abcdef";
// Same byte length, one character off: the candidate that reaches
// timingSafeEqual and still has to be refused.
const SAME_LENGTH_WRONG_SECRET = `${VALID_SECRET.slice(0, -1)}z`;
const LONGER_SECRET = `${VALID_SECRET}extra-characters`;
const SHORTER_SECRET = VALID_SECRET.slice(0, -4);
// The policy floor is enforced inside ConfigurationService, so this value never
// becomes `adminSecret` and the machine path stays disabled for it.
const BELOW_POLICY_FLOOR_SECRET = "hunter2";

// Not a real token — the guard never parses it. It only has to not be the
// secret, which is what sends it down the human path.
const ACCESS_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEifQ.signature";

function serviceFor(
  env: Record<string, string | undefined>,
): ConfigurationService {
  const merged: Record<string, string | undefined> = {
    ...REQUIRED_BASE,
    ...env,
  };
  const nestConfig = {
    get: (key: string) => merged[key],
    getOrThrow: (key: string) => {
      const value = merged[key];
      if (!value) {
        throw new Error(`Missing required configuration: ${key}`);
      }
      return value;
    },
  };
  return new ConfigurationService(nestConfig as unknown as ConfigService);
}

/**
 * The delegate guards as doubles, because a spec has to be able to tell "the
 * machine path matched" apart from "the human path was delegated". The real
 * JwtAuthGuard can answer neither question without passport and a registered
 * `jwt` strategy, and the real AdminGuard would then need the user the strategy
 * resolved. Defaults stand in for a signed-in admin — the outcome the machine
 * path is meant to be indistinguishable from.
 */
function delegates(
  options: {
    jwt?: "grants" | "denies" | "rejects-unauthorized" | "rejects-error";
    admin?: "grants" | "denies" | "throws-forbidden";
  } = {},
) {
  const jwt = { canActivate: jest.fn() };
  const admin = { canActivate: jest.fn() };

  switch (options.jwt) {
    case "denies":
      jwt.canActivate.mockResolvedValue(false);
      break;
    case "rejects-unauthorized":
      jwt.canActivate.mockRejectedValue(
        new UnauthorizedException("Authentication token missing or invalid"),
      );
      break;
    case "rejects-error":
      jwt.canActivate.mockRejectedValue(new Error("strategy exploded"));
      break;
    default:
      jwt.canActivate.mockResolvedValue(true);
  }

  switch (options.admin) {
    case "denies":
      admin.canActivate.mockReturnValue(false);
      break;
    case "throws-forbidden":
      admin.canActivate.mockImplementation(() => {
        throw new ForbiddenException(
          "Access denied: administrative privileges required",
        );
      });
      break;
    default:
      admin.canActivate.mockReturnValue(true);
  }

  return { jwt, admin };
}

function contextOf(headers: Record<string, unknown> = {}): ExecutionContext {
  const request: Record<string, unknown> = { headers };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

function guardFor(
  env: Record<string, string | undefined>,
  { jwt, admin } = delegates(),
): MetricsScrapeGuard {
  return new MetricsScrapeGuard(
    serviceFor(env),
    jwt as unknown as JwtAuthGuard,
    admin as unknown as AdminGuard,
  );
}

/**
 * The wire shape is the contract, not the exception class: `docs/API_REFERENCE.md`
 * publishes 401/`UNAUTHORIZED` for a credential-less `/metrics`, and
 * `AllExceptionsFilter` reaches that code from the status only because the
 * exception carries no `code` of its own. Pushing the rejection through the real
 * filter asserts both halves — 401 and the code — without a live HTTP test, and
 * fails the moment anyone swaps in a 403 or an exception with its own code.
 */
async function rejectionBodyOf(
  guard: MetricsScrapeGuard,
  context: ExecutionContext,
): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {};
  const response = {
    status() {
      return response;
    },
    header() {
      return response;
    },
    json(body: Record<string, unknown>) {
      sent = body;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ headers: {}, path: "/metrics", method: "GET" }),
    }),
  } as unknown as ArgumentsHost;

  let caught: unknown;
  await guard.canActivate(context).catch((error: unknown) => {
    caught = error;
  });
  new AllExceptionsFilter().catch(caught, host);
  return sent;
}

describe("MetricsScrapeGuard", () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeAll(() => {
    // ConfigurationService logs on every construction, and the exception filter
    // logs the rejections this spec deliberately produces.
    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
  });

  afterAll(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("machine path: a scrape presents ADMIN_SECRET", () => {
    it("accepts the secret as a Bearer credential without touching the JWT guards", async () => {
      const { jwt, admin } = delegates();
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(
        guard.canActivate(
          contextOf({ authorization: `Bearer ${VALID_SECRET}` }),
        ),
      ).resolves.toBe(true);
      expect(jwt.canActivate).not.toHaveBeenCalled();
      expect(admin.canActivate).not.toHaveBeenCalled();
    });

    it("accepts the Bearer scheme spelled in any case, which is what Node hands over", async () => {
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET });
      await expect(
        guard.canActivate(
          contextOf({ authorization: `bearer ${VALID_SECRET}` }),
        ),
      ).resolves.toBe(true);
    });

    it("accepts the secret as x-admin-secret, the header break-glass scripts use", async () => {
      const { jwt, admin } = delegates();
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(
        guard.canActivate(contextOf({ "x-admin-secret": VALID_SECRET })),
      ).resolves.toBe(true);
      expect(jwt.canActivate).not.toHaveBeenCalled();
      expect(admin.canActivate).not.toHaveBeenCalled();
    });

    it("keeps the header path alive when Authorization is present but is not a secret", async () => {
      // The two presentations are independent, so an unrelated credential in one
      // must not blind the other. Node hands a repeated header back as an array,
      // which is why the bearer candidate is only read out of a string.
      const { jwt, admin } = delegates();
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(
        guard.canActivate(
          contextOf({
            authorization: [`Bearer ${ACCESS_TOKEN}`, `Bearer ${ACCESS_TOKEN}`],
            "x-admin-secret": VALID_SECRET,
          }),
        ),
      ).resolves.toBe(true);
      expect(jwt.canActivate).not.toHaveBeenCalled();
    });
  });

  describe("machine path: refusals fall through to the human path, never forward", () => {
    it.each([
      ["a wrong secret", `Bearer ${SAME_LENGTH_WRONG_SECRET}`],
      [
        "a secret-shaped prefix",
        `Bearer ${VALID_SECRET.slice(0, 12)}-not-really`,
      ],
      ["a shorter secret", `Bearer ${SHORTER_SECRET}`],
      ["the empty credential", "Bearer "],
      ["another scheme", "Basic dXNlcjpwYXNz"],
      ["a bare value with no scheme", VALID_SECRET],
    ])(
      "%s is not a scrape: it goes to JwtAuthGuard as a candidate token",
      async (_label, authorization) => {
        const { jwt, admin } = delegates();
        const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

        await expect(
          guard.canActivate(contextOf({ authorization })),
        ).resolves.toBe(true);
        expect(jwt.canActivate).toHaveBeenCalledTimes(1);
        expect(admin.canActivate).toHaveBeenCalledTimes(1);
      },
    );

    it("refuses a bearer value longer than the secret without throwing", async () => {
      // The regression this pins: timingSafeEqual rejects unequal lengths by
      // raising, and a raise here is a 500 on the scrape endpoint instead of a
      // decision. A credentials file that kept its trailing newline is the
      // ordinary way a real deployment produces exactly this value.
      const { jwt, admin } = delegates();
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(
        guard.canActivate(
          contextOf({
            authorization: `Bearer ${LONGER_SECRET}`,
            "x-admin-secret": LONGER_SECRET,
          }),
        ),
      ).resolves.toBe(true);
      expect(jwt.canActivate).toHaveBeenCalledTimes(1);
    });

    it("answers the documented 401 for a longer x-admin-secret with nothing else to go on", async () => {
      // Same length mismatch, but no human credential to delegate to: the
      // refusal has to be the endpoint's own, not the crypto error.
      const { jwt, admin } = delegates();
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      const thrown = await guard
        .canActivate(contextOf({ "x-admin-secret": LONGER_SECRET }))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as Error & { code?: string }).code).not.toBe(
        "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH",
      );
      expect(jwt.canActivate).not.toHaveBeenCalled();
      expect(admin.canActivate).not.toHaveBeenCalled();
    });

    it("does not let the two presentations add up to the secret", async () => {
      // Half the secret as a bearer value and the other half in the header. Each
      // candidate is compared whole or not at all, so this cannot match — and
      // the half that looks like a token still gets treated as one.
      const half = VALID_SECRET.length / 2;
      const { jwt, admin } = delegates({ jwt: "rejects-unauthorized" });
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(
        guard.canActivate(
          contextOf({
            authorization: `Bearer ${VALID_SECRET.slice(0, half)}`,
            "x-admin-secret": VALID_SECRET.slice(half),
          }),
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("refuses a same-length wrong secret in the header", async () => {
      expect(SAME_LENGTH_WRONG_SECRET).toHaveLength(VALID_SECRET.length);
      const { jwt, admin } = delegates({ jwt: "rejects-unauthorized" });
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(
        guard.canActivate(
          contextOf({
            authorization: `Bearer ${ACCESS_TOKEN}`,
            "x-admin-secret": SAME_LENGTH_WRONG_SECRET,
          }),
        ),
      ).rejects.toThrow(UnauthorizedException);
      expect(jwt.canActivate).toHaveBeenCalledTimes(1);
    });

    it("refuses a repeated x-admin-secret header", async () => {
      // Node hands a repeated header back as an array, which is not a string a
      // secret can be compared against — and two copies of the right value must
      // not be read as one candidate either.
      const { jwt, admin } = delegates({ jwt: "rejects-unauthorized" });
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(
        guard.canActivate(
          contextOf({
            authorization: `Bearer ${ACCESS_TOKEN}`,
            "x-admin-secret": [VALID_SECRET, VALID_SECRET],
          }),
        ),
      ).rejects.toThrow(UnauthorizedException);
      expect(jwt.canActivate).toHaveBeenCalledTimes(1);
    });
  });

  describe("ADMIN_SECRET unset: the machine path can never fire", () => {
    // ConfigurationService returns undefined for a missing, blank or
    // sub-32-character value and this guard reads only that getter, so every one
    // of those states has to behave like "no secret exists" even when a caller
    // presents a header value that would otherwise match.
    it.each([
      ["unset", undefined],
      ["blank", ""],
      ["whitespace only", "   "],
      ["below the policy floor", BELOW_POLICY_FLOOR_SECRET],
    ])(
      "with ADMIN_SECRET %s, presenting that value is not a credential",
      async (_label, configured) => {
        const { jwt, admin } = delegates({ jwt: "rejects-unauthorized" });
        const guard = guardFor(
          configured === undefined ? {} : { ADMIN_SECRET: configured },
          { jwt, admin },
        );

        await expect(
          guard.canActivate(
            contextOf({
              authorization: `Bearer ${VALID_SECRET}`,
              "x-admin-secret": VALID_SECRET,
            }),
          ),
        ).rejects.toThrow(UnauthorizedException);
        expect(jwt.canActivate).toHaveBeenCalledTimes(1);
        expect(admin.canActivate).not.toHaveBeenCalled();
      },
    );
  });

  describe("human path: a signed-in admin keeps yesterday's behaviour", () => {
    it("accepts a bearer value that is a valid access token for an admin", async () => {
      const { jwt, admin } = delegates();
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(
        guard.canActivate(
          contextOf({ authorization: `Bearer ${ACCESS_TOKEN}` }),
        ),
      ).resolves.toBe(true);
      expect(jwt.canActivate).toHaveBeenCalledTimes(1);
      expect(admin.canActivate).toHaveBeenCalledTimes(1);
    });

    it("runs the real guards in order on one and the same context", async () => {
      // AdminGuard reads `request.user`, which passport writes onto that request
      // inside JwtAuthGuard — a rebuilt context would deny every admin, and a
      // reordered one would ask who the caller is before authenticating them.
      const jwt = {
        canActivate: jest.fn((context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = { id: "user-1" };
          return Promise.resolve(true);
        }),
      };
      const admin = {
        canActivate: jest.fn((_context: ExecutionContext) => true),
      };
      const guard = new MetricsScrapeGuard(
        serviceFor({ ADMIN_SECRET: VALID_SECRET }),
        jwt as unknown as JwtAuthGuard,
        admin as unknown as AdminGuard,
      );
      const context = contextOf({ authorization: `Bearer ${ACCESS_TOKEN}` });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(jwt.canActivate.mock.calls[0][0]).toBe(context);
      expect(admin.canActivate.mock.calls[0]?.[0]).toBe(context);
      expect(
        admin.canActivate.mock.calls[0]?.[0].switchToHttp().getRequest().user,
      ).toEqual({ id: "user-1" });
      expect(jwt.canActivate.mock.invocationCallOrder[0]).toBeLessThan(
        admin.canActivate.mock.invocationCallOrder[0],
      );
    });

    it("lets a non-admin's 403 through unchanged", async () => {
      const { jwt, admin } = delegates({ admin: "throws-forbidden" });
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(
        guard.canActivate(
          contextOf({ authorization: `Bearer ${ACCESS_TOKEN}` }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("propagates whatever JwtAuthGuard rejects with, including its own 401", async () => {
      // Session revocation lives in JwtStrategy.validate(), which runs inside
      // the delegated guard, so a revoked admin is refused here too rather than
      // being allowed to keep reading metrics until the token expires.
      const { jwt, admin } = delegates({ jwt: "rejects-unauthorized" });
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(
        guard.canActivate(contextOf({ authorization: "Bearer not-a-token" })),
      ).rejects.toThrow(
        new UnauthorizedException("Authentication token missing or invalid"),
      );
      expect(jwt.canActivate).toHaveBeenCalledTimes(1);
      expect(admin.canActivate).not.toHaveBeenCalled();
    });

    it("treats a falsy JwtAuthGuard result as a refusal, never as a pass", async () => {
      const { jwt, admin } = delegates({ jwt: "denies" });
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(
        guard.canActivate(
          contextOf({ authorization: `Bearer ${ACCESS_TOKEN}` }),
        ),
      ).rejects.toThrow(UnauthorizedException);
      // Never reaches AdminGuard: there is no established caller to ask about.
      expect(admin.canActivate).not.toHaveBeenCalled();
    });

    it("keeps a non-admin denied when the same request also carries a wrong secret", async () => {
      // A near miss on the secret must not convert a 403 into a 200.
      const { jwt, admin } = delegates({ admin: "throws-forbidden" });
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(
        guard.canActivate(
          contextOf({
            authorization: `Bearer ${SAME_LENGTH_WRONG_SECRET}`,
            "x-admin-secret": "guess",
          }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("anonymous: the documented 401 shape", () => {
    it("rejects a request with no credential of any kind", async () => {
      const { jwt, admin } = delegates();
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(guard.canActivate(contextOf())).rejects.toThrow(
        UnauthorizedException,
      );
      expect(jwt.canActivate).not.toHaveBeenCalled();
      expect(admin.canActivate).not.toHaveBeenCalled();
    });

    it("rejects an empty Authorization header as anonymous", async () => {
      const { jwt, admin } = delegates();
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      await expect(
        guard.canActivate(contextOf({ authorization: "" })),
      ).rejects.toThrow(UnauthorizedException);
      expect(jwt.canActivate).not.toHaveBeenCalled();
    });

    it("answers 401 UNAUTHORIZED on the wire, not 403 FORBIDDEN", async () => {
      const { jwt, admin } = delegates();
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      const body = await rejectionBodyOf(guard, contextOf());
      expect(body).toMatchObject({
        statusCode: 401,
        code: "UNAUTHORIZED",
        message: "Authentication token missing or invalid",
        path: "/metrics",
      });
    });

    it("answers 401 UNAUTHORIZED for a wrong bearer secret the real guards also reject", async () => {
      // The scrape misconfigured case: nothing about the caller was ever
      // established, so the browser-visible shape stays the one the docs give.
      const { jwt, admin } = delegates({ jwt: "rejects-unauthorized" });
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET }, { jwt, admin });

      const body = await rejectionBodyOf(
        guard,
        contextOf({ authorization: `Bearer ${SHORTER_SECRET}` }),
      );
      expect(body).toMatchObject({
        statusCode: 401,
        code: "UNAUTHORIZED",
      });
    });
  });
});
