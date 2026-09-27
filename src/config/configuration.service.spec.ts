import {
  ConfigurationService,
  parseTokenLifetime,
} from "./configuration.service";

/** The variable named in a rejection, which is the operator's only clue. */
const VAR = "JWT_ACCESS_EXPIRATION";

/**
 * The one reading of a token lifetime that every consumer now shares: the
 * `exp` stamped into the token, the `expiresIn` a client counts down, the
 * `Session.accessExpiresAt` row and the refresh cookie's `maxAge` are all this
 * number. Before it existed they were four literals, and `JWT_*_EXPIRATION` was
 * a setting that changed none of them.
 *
 * What matters here is not only that the accepted forms come out right, but
 * that nothing else does: a unit this function invents would be a lifetime the
 * session row believes and the token does not.
 */
describe("parseTokenLifetime", () => {
  it("reads what .env.example and the Joi defaults ship", () => {
    expect(parseTokenLifetime("15m", VAR)).toBe(900);
    expect(parseTokenLifetime("7d", VAR)).toBe(7 * 24 * 60 * 60);
  });

  it("reads a bare number as seconds, the way jsonwebtoken does", () => {
    expect(parseTokenLifetime("900", VAR)).toBe(900);
    expect(parseTokenLifetime(900 as unknown as string, VAR)).toBe(900);
  });

  it("reads the long and spaced spellings of each unit", () => {
    expect(parseTokenLifetime("1h", VAR)).toBe(3600);
    expect(parseTokenLifetime("2 hours", VAR)).toBe(7200);
    expect(parseTokenLifetime("45 seconds", VAR)).toBe(45);
    expect(parseTokenLifetime(" 10 MINUTES ", VAR)).toBe(600);
    expect(parseTokenLifetime("2 days", VAR)).toBe(172800);
  });

  it("refuses a unit jsonwebtoken has no meaning for", () => {
    // "1w" is the one an operator reaches for. Accepting it here would put a
    // number in the session row that `sign()` rejects or reads differently.
    expect(() => parseTokenLifetime("1w", VAR)).toThrow(
      /JWT_ACCESS_EXPIRATION/,
    );
    expect(() => parseTokenLifetime("1 week", VAR)).toThrow(/token lifetime/);
    expect(() => parseTokenLifetime("soon", VAR)).toThrow();
    expect(() => parseTokenLifetime("15mm", VAR)).toThrow();
  });

  it("refuses a lifetime that is zero, negative or missing", () => {
    // A zero here is a token born expired and a session row already stale —
    // worse than an aborted boot, and silent on every request after it.
    expect(() => parseTokenLifetime("0", VAR)).toThrow();
    expect(() => parseTokenLifetime("", VAR)).toThrow();
    expect(() =>
      parseTokenLifetime(undefined as unknown as string, VAR),
    ).toThrow(/JWT_ACCESS_EXPIRATION/);
  });
});

/** A `ConfigService` double that answers exactly what a deployment set. */
function config(values: Record<string, unknown>) {
  return {
    get: (key: string, fallback?: unknown) =>
      key in values ? values[key] : fallback,
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`missing ${key}`);
      return values[key];
    },
  } as any;
}

const PRESENT = {
  DATABASE_URL: "mongodb://localhost:27017/x",
  JWT_ACCESS_SECRET: "a".repeat(32),
  JWT_REFRESH_SECRET: "b".repeat(32),
  OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
  OBJECT_STORAGE_ACCESS_KEY: "key",
  OBJECT_STORAGE_SECRET_KEY: "secret",
  OBJECT_STORAGE_BUCKET: "bucket",
  ENCRYPTION_KEY: "c".repeat(32),
};

describe("ConfigurationService token lifetimes", () => {
  it("falls back to 15m and 7d when nothing is set", () => {
    const service = new ConfigurationService(config({ ...PRESENT }));

    expect(service.jwtAccessExpiresInSeconds).toBe(900);
    expect(service.jwtRefreshExpiresInSeconds).toBe(604800);
  });

  it("treats a cleared setting as unset rather than fatal", () => {
    // `JWT_ACCESS_EXPIRATION=` is a plausible thing for an operator to write when
    // they mean "use the default". Reading the ConfigService fallback alone would
    // return the empty string for it, and an empty lifetime is one this file
    // cannot parse — so clearing a variable would have aborted the boot.
    const service = new ConfigurationService(
      config({
        ...PRESENT,
        JWT_ACCESS_EXPIRATION: "  ",
        JWT_REFRESH_EXPIRATION: "",
      }),
    );

    expect(service.jwtAccessExpiresInSeconds).toBe(900);
    expect(service.jwtRefreshExpiresInSeconds).toBe(604800);
  });

  it("aborts the boot on a lifetime it cannot read", () => {
    // The alternative is the first login of the day answering 500, for a value
    // that has been wrong since the container started.
    expect(
      () =>
        new ConfigurationService(
          config({ ...PRESENT, JWT_ACCESS_EXPIRATION: "15 minutes ago" }),
        ),
    ).toThrow(/JWT_ACCESS_EXPIRATION/);

    expect(
      () =>
        new ConfigurationService(
          config({ ...PRESENT, JWT_REFRESH_EXPIRATION: "1w" }),
        ),
    ).toThrow(/JWT_REFRESH_EXPIRATION/);
  });

  it("applies the settings to both the seconds and the string", () => {
    const service = new ConfigurationService(
      config({
        ...PRESENT,
        JWT_ACCESS_EXPIRATION: "1h",
        JWT_REFRESH_EXPIRATION: "30d",
      }),
    );

    expect(service.jwtAccessExpiration).toBe("1h");
    expect(service.jwtAccessExpiresInSeconds).toBe(3600);
    expect(service.jwtRefreshExpiresInSeconds).toBe(30 * 24 * 60 * 60);
  });
});
