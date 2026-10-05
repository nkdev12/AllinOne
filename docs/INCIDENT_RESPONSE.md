# Incident Response Plan & Security Playbook

This document defines the Incident Response (IR) protocol for handling security events, potential data breaches, unauthorized access attempts, or critical system compromises.

---

## 🚨 Incident Severity Levels

| Severity          | Impact Description                                     | Example Scenarios                                                              | Response Time SLA |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------- |
| **P1 - Critical** | Severe breach, active compromise, or data exposure     | Exposed database credentials, unauthorized access to user payloads, active RCE | **< 15 minutes**  |
| **P2 - High**     | Targeted compromise of single account or elevated risk | Account takeover of high-privilege account, MFA bypass attempt                 | **< 1 hour**      |
| **P3 - Medium**   | Anomalous behavior without confirmed breach            | High rate-limit trigger volume, brute-force attempts from specific subnet      | **< 4 hours**     |
| **P4 - Low**      | Low-risk security policy non-compliance                | Outdated client library version, missing non-critical header                   | **< 24 hours**    |

---

## 🔄 Incident Response Lifecycle

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ 1. Detection     │───>│ 2. Containment   │───>│ 3. Eradication   │
└──────────────────┘    └──────────────────┘    └──────────────────┘
                                                          │
┌──────────────────┐    ┌──────────────────┐              │
│ 5. Post-Mortem   │<───│ 4. Recovery      │<─────────────┘
└──────────────────┘    └──────────────────┘
```

### Phase 1: Detection & Triage

1. Security alerts triggered via Prometheus metrics (`/metrics`), SIEM Audit Logs (`AuditLog` collection), or external reporting (`security@allinone.local`).
2. Identify incident scope: Affected User IDs, Device IDs, IP Addresses, and API endpoints.

### Phase 2: Containment & Emergency Controls

1. **Revoke User Sessions**: Immediately invalidate session tokens for the compromised account with `POST /admin/users/:userId/revoke-sessions` (body takes an optional `reason`). `AdminService.revokeUserSessions` sets `revokedAt` on every `Session` document of that user that still has `revokedAt: null` and records an `AuditLog` entry for the operator.
2. **Revoke Compromised Devices**: `DELETE /devices/:id` sets `Device.revokedAt` and, inside one `prisma.$transaction`, revokes every active `Session` bound to that device (`DevicesService.revokeDevice`). To take the account itself out of service, `PATCH /admin/users/:userId/status` with `status: "SUSPENDED"`.
3. **Block Attacker IP at Gateway (Caddy / Firewall)**:
   Add drop rule for malicious IP in iptables / Cloud Firewall.
4. **Trigger Emergency Maintenance Mode** (if system-wide P1 incident occurs):
   Block ingress traffic at Caddy reverse proxy.

Neither revocation above has a SQL path: `prisma/schema.prisma` declares `provider = "mongodb"`, so Prisma accepts no `UPDATE ...` statement against this database, and `Session` / `Device` are collections rather than tables. Both admin routes sit behind `JwtAuthGuard` and `AdminGuard`, and `src/main.ts` registers no global prefix, so the paths are at the root of the host.

### Phase 3: Eradication

1. Remove unauthorized keys or invalid refresh tokens.
2. Rotate JWT secret keys (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`) in environment variables if JWT signing keys are suspected of exposure.
3. Patch exploited vulnerability and deploy fix via container deployment pipeline.

### Phase 4: Recovery

1. Re-enable application traffic through Caddy.
2. Verify integrity of database records and end-to-end encrypted payload states.
3. Require affected users to re-authenticate and update passwords/MFA recovery keys.

### Phase 5: Post-Mortem & Reporting

1. Produce incident timeline report within 72 hours.
2. Document root cause analysis (RCA), preventive measures, and security guardrail enhancements.

---

## 🔒 Emergency Access Revocation Cheat Sheet

There is no SQL route to any of this: `prisma/schema.prisma` declares `provider = "mongodb"`, so `npx prisma db execute` has no interface to run `UPDATE "Session" ...` style statements against, and `Session` / `MFASetting` are collections rather than tables. The revocation mechanisms the repository does ship are these endpoints, all at the root of the host (`src/main.ts` registers no global prefix) and all behind `JwtAuthGuard` + `AdminGuard` except `DELETE /devices/:id`, which is the user's own device route:

| Action                                 | Endpoint                                    | What it changes                                                                                                 |
| -------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Revoke a user's live sessions          | `POST /admin/users/:userId/revoke-sessions` | `Session.revokedAt` on that user's sessions where it is `null` (`reason` optional)                              |
| Disable TOTP for a locked-out account  | `POST /admin/users/:userId/disable-mfa`     | `MFASetting.totpEnabled=false`, and clears `totpSecret`, `recoveryCodes`, `backupCodesUsed` (`reason` required) |
| Suspend the account                    | `PATCH /admin/users/:userId/status`         | `User.status` (`ACTIVE` / `SUSPENDED` / `DELETED`)                                                              |
| Release a brute-force lockout          | `POST /admin/users/:userId/unlock`          | `User.failedLoginAttempts` / `User.lockedUntil`                                                                 |
| Revoke one device and its sessions     | `DELETE /devices/:id`                       | `Device.revokedAt` plus its active sessions, in one `$transaction`                                              |
| Revoke every session in the deployment | not provided                                | nothing revokes globally; both admin and self-service paths are per user                                        |

`AdminGuard` also accepts an `x-admin-secret` request header, which is the scripted operator path. It is **not provisioned out of the box**: `ADMIN_SECRET`, `ADMIN_EMAILS` and `ADMIN_USER_IDS` are declared in both Joi validation schemas and documented (commented out, deliberately) in `.env.example`, but `docker-compose.prod.yml` passes none of them to the `api` container. Since 2026-09-27 the guard has no default admin email list and no `role` fallback — an unset value means that admit path is closed — so **as shipped there is no way to call any `/admin` route at all**, which is fail-closed rather than fail-open but is still not something to discover during a P1.

To have an admin path when you need one, set at least one of these on the `api` service before the deployment takes traffic: `ADMIN_USER_IDS` with the id of an account you control (the strongest option — it is not addressclaimable), `ADMIN_EMAILS` with a registered-and-verified address, or `ADMIN_SECRET` of ≥32 characters for scripted tooling, which escalates an already-authenticated request only and never substitutes for a session.

> ⚠️ TODO(verify): how an operator authenticates these admin calls during a P1 — whether `ADMIN_USER_IDS`/`ADMIN_SECRET` are injected through the deployment's secret store or have to be added to `docker-compose.prod.yml` and the stack restarted, and whether a direct-database path outside the API is allowed at all, since `docker-compose.prod.yml` configures no MongoDB credentials (a database-level session revoke today means `mongosh` against an unauthenticated replica set, not a controlled procedure).
