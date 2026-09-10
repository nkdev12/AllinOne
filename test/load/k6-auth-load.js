import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

// Custom Performance Metrics
const authLoginDuration = new Trend("auth_login_duration");
const authRefreshDuration = new Trend("auth_refresh_duration");
const authMeDuration = new Trend("auth_me_duration");
const authErrors = new Rate("auth_errors");

export const options = {
  stages: [
    { duration: "20s", target: 20 },
    { duration: "1m", target: 50 },
    { duration: "20s", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<300", "p(99)<600"],
    http_req_failed: ["rate<0.02"],
    auth_login_duration: ["p(95)<250"],
    auth_refresh_duration: ["p(95)<200"],
    auth_errors: ["rate<0.02"],
  },
};

const BASE_URL = __ENV.TARGET_URL || "http://localhost:3000";

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

export default function () {
  const vuId = __VU;
  const iterId = __ITER;
  const uniqueEmail = `k6-user-${vuId}-${iterId}-${Date.now()}@example.com`;
  const password = "SecurePassword123!";

  const baseHeaders = {
    "Content-Type": "application/json",
    ...generateTraceHeaders(),
  };

  // 1. User Registration
  const regPayload = JSON.stringify({
    email: uniqueEmail,
    password: password,
    displayName: `K6 User ${vuId}`,
  });

  const regRes = http.post(`${BASE_URL}/auth/register`, regPayload, {
    headers: baseHeaders,
  });

  let accessToken = null;
  let refreshToken = null;

  if (regRes.status === 201) {
    try {
      const regBody = JSON.parse(regRes.body);
      accessToken = regBody.accessToken;
      refreshToken = regBody.refreshToken;
    } catch {
      authErrors.add(1);
    }
  }

  // Fallback to Login if registration failed (or existing user)
  if (!accessToken) {
    const loginPayload = JSON.stringify({
      email: uniqueEmail,
      password: password,
    });

    const loginRes = http.post(`${BASE_URL}/auth/login`, loginPayload, {
      headers: {
        ...baseHeaders,
        ...generateTraceHeaders(),
      },
    });

    authLoginDuration.add(loginRes.timings.duration);
    const loginOk = check(loginRes, {
      "login status is 200 or 201": (r) => r.status === 200 || r.status === 201,
      "login returned token": (r) => {
        try {
          const body = JSON.parse(r.body);
          return !!body.accessToken;
        } catch {
          return false;
        }
      },
    });

    if (loginOk) {
      const body = JSON.parse(loginRes.body);
      accessToken = body.accessToken;
      refreshToken = body.refreshToken;
    } else {
      authErrors.add(1);
      return;
    }
  }

  sleep(0.2);

  // 2. Authenticated Profile Probe (GET /users/me)
  const profileRes = http.get(`${BASE_URL}/users/me`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...generateTraceHeaders(),
    },
  });

  authMeDuration.add(profileRes.timings.duration);
  const meOk = check(profileRes, {
    "profile status is 200": (r) => r.status === 200,
    "profile returns user info": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.email === uniqueEmail;
      } catch {
        return false;
      }
    },
  });
  if (!meOk) {
    authErrors.add(1);
  }

  sleep(0.2);

  // 3. Token Rotation (POST /auth/refresh)
  if (refreshToken) {
    const refreshRes = http.post(
      `${BASE_URL}/auth/refresh`,
      JSON.stringify({ refreshToken }),
      {
        headers: {
          "Content-Type": "application/json",
          ...generateTraceHeaders(),
        },
      },
    );

    authRefreshDuration.add(refreshRes.timings.duration);
    const refreshOk = check(refreshRes, {
      "refresh status is 200 or 201": (r) =>
        r.status === 200 || r.status === 201,
      "refresh returns new tokens": (r) => {
        try {
          const body = JSON.parse(r.body);
          return !!body.accessToken;
        } catch {
          return false;
        }
      },
    });
    if (!refreshOk) {
      authErrors.add(1);
    }
  }

  sleep(0.5);
}

