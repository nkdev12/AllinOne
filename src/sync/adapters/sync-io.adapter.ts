import { Logger } from "@nestjs/common";
import { Server, ServerOptions } from "socket.io";
import { RedisIoAdapter } from "./redis-io.adapter";

/**
 * The slice of `ConfigService` / `ConfigurationService` this adapter reads, so a
 * test can hand it a plain object and this file owns no dependency on how the
 * app happens to load `.env`.
 */
export interface WebSocketConfigReader {
  get<T = any>(key: string, defaultValue?: T): T | undefined;
}

/** The `/sync` namespace's CORS policy, once resolved from configuration. */
export interface ResolvedWsCors {
  /** Exact origins that may connect, or `["*"]` if the operator asked for that. */
  origins: string[];
  credentials: boolean;
  allowNullOrigin: boolean;
  /** Which env var the list came from, for the boot log. */
  source: string;
}

/**
 * What an operator gets who configures nothing.
 *
 * This is the same value `src/main.ts` hands the HTTP app for `CORS_ORIGIN`, and
 * it is a development default rather than an open door: a browser on any other
 * origin is refused. The wildcard the namespace used to run under came from
 * `cors: { origin: "*" }` in the gateway decorator, which was evaluated at
 * import time and so could never have been anything but a wildcard.
 */
export const DEFAULT_WS_CORS_ORIGINS = "http://localhost:3000";

/**
 * Origin list for the WebSocket namespace.
 *
 * `WS_CORS_ORIGINS` is the dedicated key: the `/sync` handshake is the same
 * credential-bearing surface as the HTTP API, but a deployment can serve the API
 * to one browser origin while its web client is built for another, and folding
 * both into one variable is how they get loosened together. Falling through to
 * `CORS_ORIGINS` and then `CORS_ORIGIN` keeps a deployment that set either for
 * the HTTP app working without a second list to keep in step.
 */
export const WS_CORS_ORIGINS_KEY = "WS_CORS_ORIGINS";
export const SHARED_CORS_ORIGINS_KEY = "CORS_ORIGINS";
export const HTTP_CORS_ORIGIN_KEY = "CORS_ORIGIN";

/**
 * The escape hatch, and explicit about being one.
 *
 * A request that carries no `Origin` header, or the literal `Origin: null`, is
 * what a WebView-hosted client sends: Android/Capacitor and some embedded
 * WebViews present `null` where a browser would name itself, and a Dart `HTTP`
 * upgrade sends no header at all. Refusing those is not a security win — no
 * browser enforces CORS against a non-browser client, so a `null` origin is
 * neither allowed nor blocked by this list in any meaningful sense — but leaving
 * it silently open would also make the list a lie about what it admits.
 *
 * So: `WS_CORS_ALLOW_NULL_ORIGIN=true` admits them and logs that it did. The
 * default is `false`, and the answer to "the web build cannot connect" is to put
 * that build's origin in `WS_CORS_ORIGINS`, not to widen this.
 */
export const WS_CORS_ALLOW_NULL_ORIGIN_KEY = "WS_CORS_ALLOW_NULL_ORIGIN";

/** Whether the Redis pub/sub clustering adapter is attempted at all. */
export const WS_REDIS_ADAPTER_KEY = "WS_REDIS_ADAPTER";

const TRUTHY = ["true", "1", "yes", "on"];

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  return TRUTHY.includes(String(value).trim().toLowerCase());
}

function splitOriginList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Read the namespace's CORS policy out of configuration.
 *
 * The rule this function exists to enforce: a configured list is a list, and it
 * is never quietly widened. The only way a socket accepts any origin is the
 * operator writing `*` into that list themselves.
 */
export function resolveWebSocketCors(
  config: WebSocketConfigReader,
): ResolvedWsCors {
  const fromWs = config.get<string>(WS_CORS_ORIGINS_KEY);
  const fromShared = config.get<string>(SHARED_CORS_ORIGINS_KEY);
  const fromHttp = config.get<string>(HTTP_CORS_ORIGIN_KEY);

  const [raw, source] =
    fromWs && fromWs.trim()
      ? [fromWs, WS_CORS_ORIGINS_KEY]
      : fromShared && fromShared.trim()
        ? [fromShared, SHARED_CORS_ORIGINS_KEY]
        : fromHttp && fromHttp.trim()
          ? [fromHttp, HTTP_CORS_ORIGIN_KEY]
          : [DEFAULT_WS_CORS_ORIGINS, "default"];

  return {
    origins: splitOriginList(raw),
    // The HTTP app sends credentials, and `/sync` authenticates with the same
    // bearer token, so a response without `Access-Control-Allow-Credentials`
    // would break exactly the browsers that got here through the allow-list.
    credentials: true,
    allowNullOrigin: asBoolean(
      config.get<string | boolean>(WS_CORS_ALLOW_NULL_ORIGIN_KEY),
      false,
    ),
    source,
  };
}

/**
 * Whether clustering is worth attempting, and why asking is not a dependency.
 *
 * Redis is optional in this app the same way it is optional for the throttler
 * (`RedisThrottlerStorage` falls back to in-memory counters): `docker-compose`
 * dev boots without it, and the API answers traffic anyway. So clustering is
 * attempted only when `REDIS_URL` names a server and `WS_REDIS_ADAPTER` has not
 * been switched off — and `RedisIoAdapter.connectToRedis()` already swallows a
 * failed connect and leaves the adapter unset, which is what keeps the boot
 * working when the URL is set and the server is not.
 */
export function shouldAttemptRedisClustering(config: WebSocketConfigReader): {
  enabled: boolean;
  redisUrl?: string;
} {
  const redisUrl = config.get<string>("REDIS_URL")?.trim();
  const rawSwitch = config.get<string | boolean>(WS_REDIS_ADAPTER_KEY);

  if (rawSwitch !== undefined && !asBoolean(rawSwitch, true)) {
    return { enabled: false };
  }
  if (!redisUrl) {
    return { enabled: false };
  }
  return { enabled: true, redisUrl };
}

/**
 * One adapter for both jobs the `/sync` namespace needed and had neither of.
 *
 * 1. CORS: `@WebSocketGateway({ cors: { origin: "*" } })` decided the policy at
 *    decorator-evaluation time, before any configuration object existed, so the
 *    configured origins never reached it. Decorator options still arrive in
 *    `create()`; they just no longer win, because Nest builds the Socket.IO
 *    server through this adapter and the server's `cors` is what a browser's
 *    handshake is answered with.
 * 2. Clustering: rooms are per-process without a Socket.IO adapter, so a device
 *    connected to container B never heard the invalidation emitted by container
 *    A. `RedisIoAdapter` existed, was correct and had no caller. It now has one,
 *    through this class, and only when Redis is configured.
 */
export class SyncIoAdapter extends RedisIoAdapter {
  private static readonly adapterLogger = new Logger(SyncIoAdapter.name);

  private constructor(
    app: any,
    private readonly cors: ResolvedWsCors,
    redisUrl?: string,
  ) {
    super(app, redisUrl);
  }

  /**
   * Build the adapter and, when Redis is configured, connect it — before
   * `listen()`, because Nest binds every gateway to the adapter installed at
   * that point and an adapter arriving later is logged and ignored.
   */
  static async fromConfig(
    app: any,
    config: WebSocketConfigReader,
    logger: Logger = SyncIoAdapter.adapterLogger,
  ): Promise<SyncIoAdapter> {
    const cors = resolveWebSocketCors(config);
    const clustering = shouldAttemptRedisClustering(config);

    const adapter = new SyncIoAdapter(app, cors, clustering.redisUrl);
    if (clustering.enabled) {
      // Safe to await: `connectToRedis()` swallows a failed connect, drops the
      // clients it made and leaves the adapter unset, which is the in-memory
      // path. A Redis that is configured but down costs one connect timeout at
      // boot and no requests.
      await adapter.connectToRedis();
    }

    logger.log(
      `[sync-ws] /sync handshake CORS from ${cors.source}: ${describeOrigins(cors)}` +
        `${cors.allowNullOrigin ? " (+ requests with no origin)" : ""}. ` +
        `Clustering: ${clustering.enabled ? "Redis when reachable" : "in-process (no Redis configured)"}.`,
    );

    return adapter;
  }

  /**
   * The single place the namespace's transport options are decided.
   *
   * Nest calls this twice per port: once to build the Socket.IO server (options
   * carry the decorator's `cors`), once to resolve the namespace out of it. Only
   * the first reaches `createIOServer`, so overriding here rather than there is
   * what stops a decorator's stale options from being the answer.
   */
  create(
    port: number,
    options?: ServerOptions & { namespace?: string; server?: any },
  ): Server {
    // The cast is the spread's doing, not the runtime's: rebuilding the options
    // object makes every required key on `ServerOptions` look optional.
    return super.create(port, {
      ...options,
      cors: this.buildCors(),
    } as ServerOptions & { namespace?: string; server?: any });
  }

  /**
   * Socket.IO's `cors` option, shaped from the resolved policy.
   *
   * A wildcard, if asked for, is passed as the literal `*` with credentials off:
   * browsers reject `Access-Control-Allow-Origin: *` beside
   * `Access-Control-Allow-Credentials: true`, so the combination the list would
   * otherwise produce is a handshake that fails for the reason the operator did
   * not intend. Anything else is matched exactly.
   */
  private buildCors(): NonNullable<ServerOptions["cors"]> {
    const { origins, credentials, allowNullOrigin } = this.cors;

    if (origins.includes("*")) {
      return { origin: "*", credentials: false };
    }

    const allowed = new Set(origins);

    return {
      origin: (
        origin: string | undefined,
        callback: (error: Error | null, allow?: boolean | string) => void,
      ) => {
        if (
          typeof origin === "string" &&
          (allowed.has(origin) ||
            /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
        ) {
          return callback(null, true);
        }
        if (
          allowNullOrigin &&
          (origin === undefined || origin === null || origin === "null")
        ) {
          return callback(null, true);
        }
        // `false` rather than an error: the handshake is still a request the
        // client may make, and the browser is the one that decides what a
        // response without `Access-Control-Allow-Origin` means for a page.
        return callback(null, false);
      },
      credentials,
    };
  }
}

function describeOrigins(cors: ResolvedWsCors): string {
  return cors.origins.length > 0
    ? cors.origins.join(", ")
    : "empty list — every cross-origin handshake is refused";
}
