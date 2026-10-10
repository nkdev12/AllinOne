import { Reflector } from "@nestjs/core";
import { CustomThrottlerGuard } from "./custom-throttler.guard";

const MANAGED = [
  "APP_ENV",
  "NODE_ENV",
  "RATE_LIMIT_ENABLED",
  "DISABLE_RATE_LIMITING",
  "RATE_LIMIT_HEADER_BYPASS",
] as const;

function context(headers: Record<string, string> = {}) {
  return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as any;
}

describe("CustomThrottlerGuard", () => {
  const guard = new CustomThrottlerGuard(
    { throttlers: [] },
    { increment: jest.fn(), get: jest.fn() } as any,
    new Reflector(),
  );
  const shouldSkip = (ctx: any) =>
    (guard as any).shouldSkip(ctx) as Promise<boolean>;
  const getTracker = (req: any) =>
    (guard as any).getTracker(req) as Promise<string>;

  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of MANAGED) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MANAGED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe("shouldSkip", () => {
    it("throttles in production", async () => {
      process.env.APP_ENV = "production";
      await expect(shouldSkip(context())).resolves.toBe(false);
    });

    it("stands down in development and under test", async () => {
      process.env.APP_ENV = "development";
      await expect(shouldSkip(context())).resolves.toBe(true);

      process.env.APP_ENV = "production";
      process.env.NODE_ENV = "test";
      await expect(shouldSkip(context())).resolves.toBe(true);
    });

    it("stands down for either of the explicit kill switches", async () => {
      process.env.APP_ENV = "production";
      process.env.DISABLE_RATE_LIMITING = "true";
      await expect(shouldSkip(context())).resolves.toBe(true);

      process.env.DISABLE_RATE_LIMITING = undefined;
      process.env.RATE_LIMIT_ENABLED = "false";
      await expect(shouldSkip(context())).resolves.toBe(true);
    });

    it("lets an explicit opt-in outrank the development default", async () => {
      // Without this the limits the controllers declare are inert in exactly
      // the two environments anyone runs them in.
      process.env.APP_ENV = "development";
      process.env.RATE_LIMIT_ENABLED = "true";
      await expect(shouldSkip(context())).resolves.toBe(false);
    });

    it("cannot be switched off by the client", async () => {
      process.env.APP_ENV = "production";
      await expect(
        shouldSkip(context({ "x-skip-throttle": "true" })),
      ).resolves.toBe(false);
      await expect(
        shouldSkip(context({ "x-bypass-rate-limit": "true" })),
      ).resolves.toBe(false);
    });

    it("honours the header bypass only where an operator opened it", async () => {
      process.env.APP_ENV = "development";
      process.env.RATE_LIMIT_HEADER_BYPASS = "true";
      await expect(
        shouldSkip(context({ "x-skip-throttle": "true" })),
      ).resolves.toBe(true);
      await expect(shouldSkip(context())).resolves.toBe(false);
    });

    it("refuses the bypass in production even with the flag set", async () => {
      process.env.APP_ENV = "production";
      process.env.RATE_LIMIT_HEADER_BYPASS = "true";
      await expect(
        shouldSkip(context({ "x-skip-throttle": "true" })),
      ).resolves.toBe(false);
    });
  });

  describe("getTracker", () => {
    it("counts an authenticated caller per user, not per socket", async () => {
      expect(await getTracker({ headers: {}, user: { id: "user-1" } })).toBe(
        "user:user-1",
      );
    });

    it("ignores spoofed forwarding headers and uses the resolved address", async () => {
      expect(
        await getTracker({
          headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
          ip: "10.0.0.1",
        }),
      ).toBe("ip:10.0.0.1");
    });
  });
});
