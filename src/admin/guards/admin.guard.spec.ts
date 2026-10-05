import { ForbiddenException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ADMIN_SECRET_MIN_LENGTH,
  ConfigurationService,
} from "@/config/configuration.service";
import { AdminGuard } from "./admin.guard";

// ConfigurationService's constructor refuses to build without its required
// variables; the ADMIN_* keys below are all the guard actually reads. If
// validateConfiguration() gains another required variable, add it here too.
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

// Deliberately well-known: these are the two addresses the guard used to
// default to, and they must admit nobody unless an operator configures them.
const LEGACY_DEFAULT_EMAILS = ["admin@example.com", "admin@allinone.app"];

const VALID_SECRET = "operator-break-glass-secret-0123456789abcdef";
// Same byte length, differs in the last character — the case a naive `===`
// and a constant-time comparison must both reject.
const SAME_LENGTH_WRONG_SECRET = `${VALID_SECRET.slice(0, -1)}z`;
const TOO_SHORT_SECRET = "hunter2";

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

function guardFor(env: Record<string, string | undefined>): AdminGuard {
  return new AdminGuard(serviceFor(env));
}

function contextOf(
  user?: Record<string, unknown>,
  headers: Record<string, unknown> = {},
) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user, headers }) }),
  } as any;
}

describe("AdminGuard", () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeAll(() => {
    // ConfigurationService logs on every construction.
    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
  });

  afterAll(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("configuration fixtures", () => {
    it("keep the long secret above the policy floor and the short one below it", () => {
      expect(VALID_SECRET.length).toBeGreaterThanOrEqual(
        ADMIN_SECRET_MIN_LENGTH,
      );
      expect(TOO_SHORT_SECRET.length).toBeLessThan(ADMIN_SECRET_MIN_LENGTH);
    });
  });

  describe("with nothing configured (fail closed)", () => {
    it.each(LEGACY_DEFAULT_EMAILS)(
      "rejects an authenticated %s user, the address the removed hard-coded default used to admit",
      (email) => {
        const guard = guardFor({});
        expect(() =>
          guard.canActivate(contextOf({ id: "user-1", email })),
        ).toThrow(ForbiddenException);
      },
    );

    it("rejects an ordinary authenticated user", () => {
      const guard = guardFor({});
      expect(() =>
        guard.canActivate(
          contextOf({ id: "user-2", email: "someone@example.com" }),
        ),
      ).toThrow(ForbiddenException);
    });

    it("rejects a request with no authenticated user", () => {
      const guard = guardFor({});
      expect(() => guard.canActivate(contextOf())).toThrow(ForbiddenException);
    });

    it("ignores an x-admin-secret header while ADMIN_SECRET is unset", () => {
      const guard = guardFor({});
      expect(() =>
        guard.canActivate(
          contextOf(
            { id: "user-1", email: "admin@example.com" },
            { "x-admin-secret": VALID_SECRET },
          ),
        ),
      ).toThrow(ForbiddenException);
    });

    it("grants nothing to a user carrying role/isAdmin claims the JWT cannot issue", () => {
      // JwtStrategy.validate() returns { id, email, displayName, status,
      // sessionId } and the User model has no role column, so these fields can
      // only ever be forged into the object by a bug elsewhere — never by a
      // legitimate token. The guard no longer reads them at all.
      const guard = guardFor({});
      expect(() =>
        guard.canActivate(
          contextOf({
            id: "user-1",
            email: "admin@example.com",
            role: "ADMIN",
            isAdmin: true,
          }),
        ),
      ).toThrow(ForbiddenException);
    });

    it("treats blank ADMIN_EMAILS / ADMIN_USER_IDS entries as no admins", () => {
      const guard = guardFor({ ADMIN_EMAILS: "  , ,", ADMIN_USER_IDS: "," });
      expect(() =>
        guard.canActivate(
          contextOf({ id: "user-1", email: "ops@allinone.app" }),
        ),
      ).toThrow(ForbiddenException);
    });
  });

  describe("ADMIN_EMAILS allow-list", () => {
    it("admits the owner of a configured address", () => {
      const guard = guardFor({ ADMIN_EMAILS: "ops@allinone.app" });
      expect(
        guard.canActivate(
          contextOf({ id: "user-1", email: "ops@allinone.app" }),
        ),
      ).toBe(true);
    });

    it("matches case-insensitively and tolerates spacing and empty entries", () => {
      const guard = guardFor({
        ADMIN_EMAILS: " Ops@Allinone.App ,, oncall@x ",
      });
      expect(
        guard.canActivate(contextOf({ id: "u", email: "ops@ALLINONE.APP" })),
      ).toBe(true);
    });

    it("rejects an address that is not configured", () => {
      const guard = guardFor({ ADMIN_EMAILS: "ops@allinone.app" });
      expect(() =>
        guard.canActivate(
          contextOf({ id: "user-1", email: "admin@example.com" }),
        ),
      ).toThrow(ForbiddenException);
    });

    it("rejects a caller with no email on the request user", () => {
      const guard = guardFor({ ADMIN_EMAILS: "ops@allinone.app" });
      expect(() => guard.canActivate(contextOf({ id: "user-1" }))).toThrow(
        ForbiddenException,
      );
    });
  });

  describe("ADMIN_USER_IDS allow-list", () => {
    it("admits a configured user id", () => {
      const guard = guardFor({ ADMIN_USER_IDS: "user-9, user-10" });
      expect(
        guard.canActivate(contextOf({ id: " user-10 ", email: "who@ever" })),
      ).toBe(true);
    });

    it("rejects an id that is not configured", () => {
      const guard = guardFor({ ADMIN_USER_IDS: "user-9" });
      expect(() =>
        guard.canActivate(contextOf({ id: "user-11", email: "user-9" })),
      ).toThrow(ForbiddenException);
    });

    it("admits nobody when the list is unset, whatever the caller's id", () => {
      const guard = guardFor({});
      expect(() =>
        guard.canActivate(
          contextOf({ id: "user-9", email: "ops@allinone.app" }),
        ),
      ).toThrow(ForbiddenException);
    });
  });

  describe("x-admin-secret escalation", () => {
    const caller = { id: "user-1", email: "someone@example.com" };

    it("admits an authenticated caller that presents the configured secret", () => {
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET });
      expect(
        guard.canActivate(
          contextOf(caller, { "x-admin-secret": VALID_SECRET }),
        ),
      ).toBe(true);
    });

    it("rejects a mismatched secret", () => {
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET });
      expect(() =>
        guard.canActivate(
          contextOf(caller, { "x-admin-secret": "definitely-not-the-secret" }),
        ),
      ).toThrow(ForbiddenException);
    });

    it("rejects a wrong secret of the same length as the configured one", () => {
      // Equal lengths, so the comparison reaches timingSafeEqual and still has
      // to say no.
      expect(SAME_LENGTH_WRONG_SECRET).toHaveLength(VALID_SECRET.length);
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET });
      expect(() =>
        guard.canActivate(
          contextOf(caller, { "x-admin-secret": SAME_LENGTH_WRONG_SECRET }),
        ),
      ).toThrow(ForbiddenException);
    });

    it("rejects a secret shorter than the policy floor, header included", () => {
      const guard = guardFor({ ADMIN_SECRET: TOO_SHORT_SECRET });
      expect(() =>
        guard.canActivate(
          contextOf(caller, { "x-admin-secret": TOO_SHORT_SECRET }),
        ),
      ).toThrow(ForbiddenException);
    });

    it("disables the header path for a blank or whitespace-only ADMIN_SECRET", () => {
      for (const configured of ["", "   "]) {
        const guard = guardFor({ ADMIN_SECRET: configured });
        expect(() =>
          guard.canActivate(
            contextOf(caller, { "x-admin-secret": configured }),
          ),
        ).toThrow(ForbiddenException);
      }
    });

    it("rejects a non-string header value", () => {
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET });
      expect(() =>
        guard.canActivate(
          contextOf(caller, { "x-admin-secret": [VALID_SECRET] }),
        ),
      ).toThrow(ForbiddenException);
    });

    it("is not an identity: the header alone, with no authenticated user, is rejected", () => {
      const guard = guardFor({ ADMIN_SECRET: VALID_SECRET });
      expect(() =>
        guard.canActivate(
          contextOf(undefined, { "x-admin-secret": VALID_SECRET }),
        ),
      ).toThrow(ForbiddenException);
    });
  });

  describe("ConfigurationService admin getters", () => {
    it("exposes no default addresses when the variables are absent", () => {
      const config = serviceFor({});
      expect(config.adminEmails).toEqual([]);
      expect(config.adminUserIds).toEqual([]);
      expect(config.adminSecret).toBeUndefined();
    });

    it("normalises the lists and lowercases emails", () => {
      const config = serviceFor({
        ADMIN_EMAILS: " Ops@Allinone.App , ",
        ADMIN_USER_IDS: "user-1,user-2",
      });
      expect(config.adminEmails).toEqual(["ops@allinone.app"]);
      expect(config.adminUserIds).toEqual(["user-1", "user-2"]);
    });

    it("returns ADMIN_SECRET only when it clears the length floor", () => {
      expect(serviceFor({ ADMIN_SECRET: VALID_SECRET }).adminSecret).toBe(
        VALID_SECRET,
      );
      expect(
        serviceFor({ ADMIN_SECRET: TOO_SHORT_SECRET }).adminSecret,
      ).toBeUndefined();
    });
  });
});
