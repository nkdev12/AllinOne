import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

// Custom Performance Metrics
const syncPushDuration = new Trend("sync_push_duration");
const syncPullDuration = new Trend("sync_pull_duration");
const syncStatusDuration = new Trend("sync_status_duration");
const syncErrors = new Rate("sync_errors");

export const options = {
  stages: [
    { duration: "30s", target: 25 },
    { duration: "1m", target: 50 },
    { duration: "1m", target: 100 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<250", "p(99)<500"],
    http_req_failed: ["rate<0.01"],
    sync_push_duration: ["p(95)<200"],
    sync_pull_duration: ["p(95)<150"],
    sync_errors: ["rate<0.01"],
  },
};

const BASE_URL = __ENV.TARGET_URL || "http://localhost:3000";

// UUID v4 generator for device and entity identifiers
function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Generates W3C TraceContext headers
function generateTraceHeaders() {
  const chars = "0123456789abcdef";
  let traceId = "";
  for (let i = 0; i < 32; i++) {
    traceId += chars[Math.floor(Math.random() * 16)];
  }
  let spanId = "";
  for (let i = 0; i < 16; i++) {
    spanId += chars[Math.floor(Math.random() * 16)];
  }

  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    "X-Trace-ID": traceId,
  };
}

// Setup: authenticate or register a test user if AUTH_TOKEN is not provided
export function setup() {
  if (__ENV.AUTH_TOKEN) {
    return { token: __ENV.AUTH_TOKEN };
  }

  const testUser = {
    email: `loadtest-${Date.now()}@example.com`,
    password: "Password123!",
    displayName: "Load Tester",
  };

  const regHeaders = {
    "Content-Type": "application/json",
    ...generateTraceHeaders(),
  };

  const regRes = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify(testUser),
    {
      headers: regHeaders,
    },
  );

  if (regRes.status === 201) {
    const data = JSON.parse(regRes.body);
    return { token: data.accessToken || data.token };
  }

  // Fallback: attempt login
  const loginRes = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({
      email: testUser.email,
      password: testUser.password,
    }),
    { headers: regHeaders },
  );

  if (loginRes.status === 200 || loginRes.status === 201) {
    const data = JSON.parse(loginRes.body);
    return { token: data.accessToken || data.token };
  }

  return { token: "dummy-fallback-token" };
}

export default function (data) {
  const deviceId = generateUUID();
  const traceHeaders = generateTraceHeaders();

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${data.token}`,
    ...traceHeaders,
  };

  // 1. Delta Sync Push
  const pushPayload = JSON.stringify({
    deviceId: deviceId,
    changes: [
      {
        entityType: "note",
        entityId: generateUUID(),
        operation: "CREATE",
        version: 1,
        payload: {
          title: `Encrypted Note ${Date.now()}`,
          ciphertext: "U2FsdGVkX1+vupppZdmMmZe...mock-ciphertext",
          iv: "1234567890abcdef",
        },
      },
      {
        entityType: "task",
        entityId: generateUUID(),
        operation: "UPDATE",
        version: 2,
        payload: {
          completed: true,
          completedAt: new Date().toISOString(),
        },
      },
    ],
  });

  const pushRes = http.post(`${BASE_URL}/sync/push`, pushPayload, {
    headers: authHeaders,
  });

  syncPushDuration.add(pushRes.timings.duration);
  const pushOk = check(pushRes, {
    "push status is 200 or 201": (r) => r.status === 200 || r.status === 201,
    "push returns trace header": (r) =>
      r.headers["X-Trace-Id"] !== undefined ||
      r.headers["x-trace-id"] !== undefined,
  });
  if (!pushOk) {
    syncErrors.add(1);
  }

  sleep(0.2);

  // 2. Delta Sync Pull
  const pullPayload = JSON.stringify({
    deviceId: deviceId,
    cursor: "0",
    limit: 50,
  });

  const pullRes = http.post(`${BASE_URL}/sync/pull`, pullPayload, {
    headers: {
      ...authHeaders,
      ...generateTraceHeaders(),
    },
  });

  syncPullDuration.add(pullRes.timings.duration);
  const pullOk = check(pullRes, {
    "pull status is 200": (r) => r.status === 200,
    "pull response contains changes": (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.changes);
      } catch {
        return false;
      }
    },
  });
  if (!pullOk) {
    syncErrors.add(1);
  }

  sleep(0.2);

  // 3. Sync Status Probe
  const statusRes = http.get(`${BASE_URL}/sync/status?deviceId=${deviceId}`, {
    headers: {
      ...authHeaders,
      ...generateTraceHeaders(),
    },
  });

  syncStatusDuration.add(statusRes.timings.duration);
  const statusOk = check(statusRes, {
    "sync status is 200": (r) => r.status === 200,
  });
  if (!statusOk) {
    syncErrors.add(1);
  }

  sleep(0.5);
}

