# Incident Response Plan & Security Playbook

This document defines the Incident Response (IR) protocol for handling security events, potential data breaches, unauthorized access attempts, or critical system compromises.

---

## 🚨 Incident Severity Levels

| Severity | Impact Description | Example Scenarios | Response Time SLA |
|----------|-------------------|-------------------|-------------------|
| **P1 - Critical** | Severe breach, active compromise, or data exposure | Exposed database credentials, unauthorized access to user payloads, active RCE | **< 15 minutes** |
| **P2 - High** | Targeted compromise of single account or elevated risk | Account takeover of high-privilege account, MFA bypass attempt | **< 1 hour** |
| **P3 - Medium** | Anomalous behavior without confirmed breach | High rate-limit trigger volume, brute-force attempts from specific subnet | **< 4 hours** |
| **P4 - Low** | Low-risk security policy non-compliance | Outdated client library version, missing non-critical header | **< 24 hours** |

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
1. Security alerts triggered via Prometheus metrics (`/metrics`), SIEM Audit Logs (`AuditLog` table), or external reporting (`security@allinone.local`).
2. Identify incident scope: Affected User IDs, Device IDs, IP Addresses, and API endpoints.

### Phase 2: Containment & Emergency Controls
1. **Revoke User Sessions**: Immediately invalidate session tokens for compromised account.
   ```sql
   UPDATE "Session" SET "revokedAt" = NOW() WHERE "userId" = 'COMPROMISED_USER_ID';
   ```
2. **Revoke Compromised Devices**:
   ```sql
   UPDATE "Device" SET "revokedAt" = NOW() WHERE "id" = 'COMPROMISED_DEVICE_ID';
   ```
3. **Block Attacker IP at Gateway (Caddy / Firewall)**:
   Add drop rule for malicious IP in iptables / Cloud Firewall.
4. **Trigger Emergency Maintenance Mode** (if system-wide P1 incident occurs):
   Block ingress traffic at Caddy reverse proxy.

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

## 🔒 Emergency Access Revocation Command Cheat Sheet

```bash
# Force logout all active user sessions
npx prisma db execute --stdin <<EOF
UPDATE "Session" SET "revokedAt" = NOW() WHERE "revokedAt" IS NULL;
EOF

# Reset TOTP MFA for locked out account (requires identity verification)
npx prisma db execute --stdin <<EOF
UPDATE "MFASetting" SET "totpEnabled" = false WHERE "userId" = 'TARGET_USER_ID';
EOF
```

