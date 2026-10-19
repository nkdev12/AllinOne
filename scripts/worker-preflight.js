#!/usr/bin/env node
/**
 * Worker boot preflight — the guard in front of `npm run start:worker`.
 *
 * Why this exists as a script and not as code inside `src/worker.ts`: the worker
 * is a headless Bull consumer, and the one failure mode that costs real data is
 * silent. `WorkerModule` validates its environment through a Joi schema that
 * declares `REDIS_URL` as `.optional()` with no default
 * (`src/worker.module.ts:28-56`), and `ConfigurationService.redisUrl` hands back
 * `redis://localhost:6379` when nothing was declared — so a Railway service
 * started with no `REDIS_URL` variable boots, binds nothing, consumes nothing,
 * and never runs the hourly `cleanup-expired` job that is the only thing pruning
 * the `Change` collection (`src/worker.ts:44-72`), whose `payload` is plaintext
 * user content. A process that is "up" and doing nothing is the worst possible
 * health signal, and the queue layer cannot tell the difference: `worker.ts:74-81`
 * deliberately degrades a Redis failure to a logged error because the process is
 * still meant to drain jobs already on the queue.
 *
 * So the check happens one level above the code that is polite about it.
 *
 * Contract:
 *   - exits 0 (and stays silent about credentials) when Redis is declared and
 *     reachable, so `node dist/worker.js` may run
 *   - exits 1 with an actionable message when it is not, before Nest starts
 *   - prints the REDACTED target only: scheme + host + port, never userinfo.
 *     A managed Redis URI (Upstash and friends) carries its password inside the
 *     authority, so echoing `$REDIS_URL` would put a live credential into the
 *     platform log stream, which is retained, searchable and readable by more
 *     people than the service is.
 *
 * Escape hatch, deliberately awkward to use by accident:
 *   WORKER_ALLOW_UNDECLARED_REDIS=true
 * keeps the `ConfigurationService.redisUrl` localhost fallback alive for a laptop
 * running `docker compose -f docker-compose.dev.yml up -d redis`. It has no
 * business in a deployed service, and the message says so.
 *
 * Used as `npm run preflight:worker` on its own, this is also the documented way
 * to check a candidate environment file before promoting it.
 */

"use strict";

const fs = require("fs");
const net = require("net");
const tls = require("tls");
const path = require("path");

const PROBE_TIMEOUT_MS = Number(process.env.WORKER_PREFLIGHT_TIMEOUT_MS || 3000);

// ---------------------------------------------------------------------------
// .env loading, matching what the process itself will see.
//
// `WorkerModule` passes `envFilePath: ".env"` to ConfigModule, so a developer
// running the worker from a checkout and an operator running it inside a
// container with variables injected by the platform must get the same answer
// here as Nest does later. Same rule as dotenv: a variable the real environment
// already sets wins, and inside the file the last assignment is the one that
// counts.
// ---------------------------------------------------------------------------
function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  let text;
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch {
    return; // no file: the environment is whatever the platform injected
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** `redis://user:pass@host:6379/0?tls=true` -> `rediss://host:6379` — nothing else. */
function redactTarget(parsed) {
  const port = parsed.port || (parsed.tls ? 6379 : 6379);
  return `${parsed.tls ? "rediss" : "redis"}://${parsed.host}:${port}`;
}

function parseRedisUrl(rawValue) {
  const value = (rawValue || "").trim();
  if (value.length === 0) return { error: "empty or unset" };

  let url;
  try {
    url = new URL(value);
  } catch {
    // A bare `host:port` is the usual mistake; the client would read it as a
    // scheme-less specifier and fail somewhere much less legible.
    return { error: "not a valid URL (expected redis:// or rediss://)" };
  }

  const tlsFlag =
    url.protocol === "rediss:" ||
    (url.protocol === "redis:" && url.searchParams.get("tls") === "true");
  if (url.protocol !== "redis:" && !tlsFlag) {
    return { error: `unsupported scheme "${url.protocol}" (want redis: or rediss:)` };
  }
  if (!url.hostname) return { error: "no hostname in the URI" };

  let port = url.port ? Number(url.port) : 6379;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { error: "port is not a valid number" };
  }
  if (url.username.length > 0 && url.password.length === 0 && !tlsFlag) {
    // `redis://default@host` — a user with no password is almost always an
    // operator who meant to paste one. Report the shape, never the value.
    return { error: "a username is present but no password" };
  }
  return { host: url.hostname, port, tls: tlsFlag };
}

// ---------------------------------------------------------------------------
// Reachability probe
// ---------------------------------------------------------------------------

/**
 * A TCP (or TLS) handshake only — no PING, so no credential is ever put on the
 * wire by this script, and a password-protected Redis that answers
 * `NOAUTH` still counts as "this target exists and is listening". Anything
 * beyond reachability is the worker's problem to report properly.
 */
function probeRedis(target) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(result);
    };

    const options = { host: target.host, port: target.port, timeout: PROBE_TIMEOUT_MS };
    const socket = target.tls
      ? tls.connect({ ...options, servername: target.host }, () => finish({ ok: true }))
      : net.connect(options);

    socket.once("connect", () => {
      if (!target.tls) finish({ ok: true });
    });
    socket.once("secureConnect", () => finish({ ok: true }));
    socket.once("timeout", () =>
      finish({ ok: false, reason: `no handshake within ${PROBE_TIMEOUT_MS}ms` }),
    );
    socket.once("error", (err) => finish({ ok: false, reason: err.code || err.message }));
  });
}

function fail(lines) {
  for (const line of lines) console.error(`worker-preflight: ${line}`);
  process.exit(1);
}

async function main() {
  loadDotEnv();

  // 1. Build output. `npm run start:worker` runs `node dist/worker.js`; Nixpacks
  //    does that in one image, but a hand-rolled `npm ci && npm run start:worker`
  //    reads as a Redis failure otherwise.
  const workerEntry = path.resolve(process.cwd(), "dist", "worker.js");
  if (!fs.existsSync(workerEntry)) {
    fail([
      `${path.relative(process.cwd(), workerEntry)} is missing.`,
      "Build it first: `npm run build` (Nixpacks runs that as its build command).",
    ]);
  }

  // 2. Redis declared.
  const declared = process.env.REDIS_URL;
  if (declared === undefined || declared.trim().length === 0) {
    if (
      process.env.WORKER_ALLOW_UNDECLARED_REDIS === "true" &&
      (process.env.APP_ENV || "").trim().toLowerCase() === "development"
    ) {
      console.log(
        "worker-preflight: REDIS_URL is not declared; continuing because " +
          "WORKER_ALLOW_UNDECLARED_REDIS=true with APP_ENV=development. The process " +
          "will use the redis://localhost:6379 fallback in ConfigurationService. " +
          "Do not set this on a deployed service.",
      );
      return;
    }
    fail([
      "REDIS_URL is not declared, and this process is a Redis consumer for a reason.",
      "",
      "Without it there is no crash to notice: WorkerModule's schema keeps the key",
      "optional, ConfigurationService.redisUrl substitutes redis://localhost:6379,",
      "and inside a Railway container that address is the container itself. The",
      "service would report itself running while the mail, notification, export and",
      "maintenance queues drain nothing — including the hourly cleanup-expired job",
      "that prunes the Change collection, whose payload holds plaintext user content.",
      "",
      "Set REDIS_URL for this service, e.g.:",
      '  railway variables set REDIS_URL="<the managed Redis URI>"   # on the worker service',
      '  REDIS_URL=redis://localhost:6379                            # in a local .env',
      "",
      "A laptop that wants the localhost fallback opts in with",
      "WORKER_ALLOW_UNDECLARED_REDIS=true and APP_ENV=development.",
    ]);
  }

  // 3. Redis well-formed, then reachable.
  const target = parseRedisUrl(declared);
  if (target.error) {
    fail([
      `REDIS_URL is unusable: ${target.error}.`,
      "Expected redis://[[user]:password@]host:port or rediss://[user:password@]host:port",
      "(The value itself is not echoed — a managed Redis URI carries its password.)",
    ]);
  }

  const shown = redactTarget(target);

  // 4. A production-shaped boot that forgot APP_ENV is the same class of mistake
  //    as a forgotten Redis, and the same silent-data failure: the strict secret
  //    gate in ConfigurationService is selected by the written value, not by
  //    NODE_ENV. Warn rather than fail, because the gate itself does the failing.
  const appEnv = (process.env.APP_ENV || "").trim().toLowerCase();
  if (appEnv === "" || appEnv === "development") {
    console.log(
      `worker-preflight: APP_ENV=${appEnv === "" ? "<unset>" : appEnv}; ` +
        "Redis target " +
        shown,
    );
  } else {
    console.log(`worker-preflight: APP_ENV=${appEnv}, Redis target ${shown}`);
  }

  const result = await probeRedis(target);
  if (!result.ok) {
    fail([
      `Redis at ${shown} is not reachable (${result.reason}).`,
      "Check the URI host/port, the managed instance's IP/branch allow-list, and",
      "whether this service is on the same private network as the Redis.",
      "The target is reported without credentials; nothing here echoes REDIS_URL.",
    ]);
  }

  console.log(`worker-preflight: Redis reachable at ${shown} — starting worker.`);
}

main().catch((error) => {
  // Never print the error object verbatim: a failed connect can serialise the
  // whole URI, password included, into `error.message`/`error.address`.
  fail([
    `preflight failed with an unexpected error (${
      (error && error.name) || "Error"
    }). Nothing about the target's credentials is printed here.`,
  ]);
});
