# LYKN Incident Response Runbook

**Companion to:** `ROTATION_RUNBOOK.md` (Agent 05), `SECURITY_REPORT_01.md` through `SECURITY_REPORT_06.md`, and the observability surface created by Agent 06 (`security-logger.js`, `/api/admin/security/audit`, `/api/health`).

This runbook covers the **first 15 minutes** of a security incident. The rotation runbook covers what to do once you've decided to rotate a secret. This document covers detection, triage, and the immediate response.

---

## Severity ladder

| Level | Meaning | Response window |
|---|---|---|
| **P0** | Active data breach or confirmed credential compromise. Drop everything. | Immediate |
| **P1** | Active abuse in flight (DDoS, credential stuffing, token replay across multiple users). | < 15 min |
| **P2** | Anomalous pattern detected (elevated auth failures from a single IP, validation spikes, repeated tool-block events from one user). | < 1 hr |
| **P3** | Informational finding. Log and review at next security review. | Next review cycle |

---

## Detection surfaces (Agent 06)

LYKN emits security events into **two** sinks for every notable security event. Use both depending on the question:

1. **Render log stream** — every event lands on `console.error` as a JSON line shaped like:
   ```json
   {"level":"security","event":"<event_type>","userId":"<uuid>","ip":"<ip>","path":"<route>","ts":"<iso>","..."}
   ```
   Grep / aggregator filter: `"level":"security"`.

2. **`lykn_security_audit` table** — service-role-only Postgres table populated by DB triggers (OAuth + MCP token mutations) AND by the application via `security-logger.js`. Query via the admin endpoint:
   ```
   GET /api/admin/security/audit?event_type=<event>&since=<ISO>&limit=<n>
   ```
   Requires `requireAuth + requireAdmin` (admin email allowlist).

3. **`/api/health`** — Render polls this every interval. Returns `503` when degraded. The response includes `replay_events_5m` as an informational counter (does not flip the health gate).

4. **GitHub production-health workflow** — `.github/workflows/production-health.yml` checks the web app, API health payload, database and secret health flags, and artifact-host isolation every five minutes.
   Configure GitHub Actions failure notifications for the on-call owner.
   This is a baseline availability alarm, not a replacement for a Render log drain or Stripe webhook alerts.

---

## Event catalog → which alert / where to look

| Event type | Tier | Primary source | What it means |
|---|---|---|---|
| `oauth.replay_detected` | **P1** | `lykn_security_audit` | RFC 6749 §10.4 — a refresh token was used twice outside the grace window. Token family auto-revoked. Stolen-credential signal. |
| `auth.config_missing` | **P0** | Render logs (grep `auth.config_missing`) | The fail-closed branch in `requireAuth` fired. Production env vars missing or hot-mutated. |
| `secrets.validation_failure` | **P0** | Render logs (boot only) | `validateSecrets()` rejected a required secret. Deploy aborted. |
| `ratelimit.auth_endpoint` | **P1** if sustained | `lykn_security_audit` | `/oauth/token`, `/oauth/register`, `/oauth/authorize`, `/oauth/revoke`, `/oauth/introspect`, `/oauth/userinfo` rate limit hit. Credential brute-force candidate. |
| `auth.failure` | **P2** if clustered | `lykn_security_audit` | Supabase rejected a JWT. Spike from one IP = credential stuffing. |
| `injection.stripped` | **P2** if sustained | `lykn_security_audit` | Prompt-injection fragments stripped from AI input. Single user with a high count = systematic attempt. |
| `tool.blocked` (chat) | **P2** | Render logs | Model attempted to call a non-whitelisted MCP tool from the in-app chat. Usually a model bug; rare and worth investigating. |
| `tool.handler_failed` | **P3** | `lykn_security_audit` | MCP tool handler threw. Clustered failures on one tool = handler bug, not abuse. |
| `validation.failure` | **P3** | `lykn_security_audit` | Zod validate() rejected a request. Field-name-only payload (never values). Spikes on one route = probe. |
| `ratelimit.hit` (non-auth) | **P3** | `lykn_security_audit` | Generic rate limit hit (AI, synthesis, MCP, etc.). |
| `error.unhandled` | **P2** | Render logs (also audit) | Global error handler caught an uncaught throw. Status code in payload. |

---

## Recommended alert rules (for future log aggregator)

These are not wired in code (LYKN doesn't currently have a dedicated alerting platform). Configure them in your aggregator of choice (Datadog, Better Stack, Grafana Loki, etc.) once Render log drain is connected.

| Event pattern | Threshold | Severity | Action |
|---|---|---|---|
| `event: "oauth.replay_detected"` | any | **CRITICAL** | Page on-call immediately |
| `event: "auth.config_missing"` | any | **CRITICAL** | Page on-call immediately |
| `event: "secrets.validation_failure"` | any | **CRITICAL** | Page on-call immediately |
| `status: "degraded"` from `/api/health` | any | **HIGH** | Page on-call |
| `event: "ratelimit.auth_endpoint"` | > 50 in 5 min | **HIGH** | Alert |
| `event: "auth.failure"` from same IP | > 100 in 5 min | **HIGH** | Alert |
| `event: "injection.stripped"` from same userId | > 20 in 1 min | **MEDIUM** | Alert |
| `event: "tool.blocked"` | any | **MEDIUM** | Alert (low volume normal: 0 expected) |
| `event: "tool.handler_failed"` for same tool | > 5 in 1 min | **MEDIUM** | Alert (likely handler bug) |
| `event: "validation.failure"` on same route | > 200 in 5 min | **LOW** | Alert |

---

## First 15 minutes — P0 / P1 playbook

### Step 1: Assess
Confirm the signal. Query the audit table for the window of interest:

```bash
# Last hour of replay attempts
curl -s -H "Authorization: Bearer <admin-jwt>" \
  "https://api.lykn.io/api/admin/security/audit?event_type=oauth.replay_detected&since=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)"

# Recent rate-limit hits on the OAuth endpoints
curl -s -H "Authorization: Bearer <admin-jwt>" \
  "https://api.lykn.io/api/admin/security/audit?event_type=ratelimit.auth_endpoint&limit=500"
```

Health check (no auth required):
```bash
curl -s https://api.lykn.io/api/health | jq
```

### Step 2: Contain
- **Active abuse from a single IP** → already self-limiting via Agent 04's rate limiters. If insufficient and Cloudflare is in front (Agent 01 open item), enable Bot Fight Mode + add a temporary IP block rule.
- **Compromised user credential** → revoke their MCP tokens immediately:
  ```sql
  -- Service-role only.
  UPDATE lykn_mcp_tokens
     SET status='revoked', revoked_at=now()
   WHERE user_id='<uuid>' AND status='active';
  ```
  Then the user's SPA session: `signOut({ everywhere: true })` (capability exists, requires the Settings UI follow-up to be wired — for now: have the user trigger it from another logged-in session, or invalidate via Supabase Auth dashboard).
- **Suspected secret leak** → start `ROTATION_RUNBOOK.md` for that specific secret IMMEDIATELY. Do not wait to confirm; rotation is cheap.
- **Suspected data breach** → before any DB cleanup, export the relevant `lykn_security_audit` rows for the incident window (preservation of evidence).

### Step 3: Preserve
Before any remediation that touches the DB:
```sql
-- Export the incident window for the incident record.
COPY (
  SELECT * FROM lykn_security_audit
  WHERE occurred_at BETWEEN '<start>' AND '<end>'
  ORDER BY occurred_at ASC
) TO '/tmp/incident_<ticket>.csv' WITH CSV HEADER;
```
Or via the admin endpoint and store the JSON.

### Step 4: Notify
- **P0 with confirmed user data exposure** → notify affected users per applicable privacy obligations. Consult counsel before sending.
- **P1** → internal status update; user-facing notice only if degraded service was observable.

### Step 5: Document
Create an incident report covering:
1. Timeline (detection → triage → contain → resolve)
2. Affected users / scope
3. Root cause (or hypothesis if not yet known)
4. Remediation steps taken
5. Follow-up actions and owners

---

## Specific scenarios

### Scenario: `oauth.replay_detected`

**Signal:** one or more rows with `event_type='oauth.replay_detected'`.

**What already happened automatically** (Agent 02 + Agent 03 + Agent 06):
- The refresh-token family for the affected consent was revoked (`revokeRefreshFamily` in `oauth-server.js`).
- All access tokens chained off that consent were marked `status='revoked'`.
- An audit row was written with `targetTable='lykn_oauth_refresh_tokens'`, `targetId=<refresh_row_id>`, `tokenPrefix='<first 8 chars>...'`, the `client_id`, and the `user_id`.
- The client received a `400 invalid_grant` and will surface a re-auth flow to the user.

**Your job:**
1. Identify the affected user(s): `SELECT DISTINCT user_id FROM lykn_security_audit WHERE event_type='oauth.replay_detected' AND occurred_at > now() - interval '24 hours';`
2. Notify them their session was terminated due to suspicious activity.
3. Check whether the same user has multiple replay events in the window — repeated occurrence on the same user = treat the account as compromised; force password reset (Supabase Auth dashboard or have them sign back in via Google OAuth).
4. Inspect the involved `client_id` — high-rate replays across many users from one client_id = consider revoking that DCR client registration.

### Scenario: rate-limit spike on auth endpoints

**Signal:** `event='ratelimit.auth_endpoint'` count > 50 in 5 minutes.

```bash
curl -s -H "Authorization: Bearer <admin-jwt>" \
  "https://api.lykn.io/api/admin/security/audit?event_type=ratelimit.auth_endpoint&since=$(date -u -v-15M +%Y-%m-%dT%H:%M:%SZ)" \
  | jq '.events[] | {ip: .metadata.ip, endpoint: .metadata.endpoint, ts: .occurred_at}'
```

**Triage:**
- All from one IP → self-limiting via `authLimiter` (20 / 15min / IP). Likely benign; monitor.
- Distributed (many IPs, same `endpoint='/oauth/register'`) → DCR registration flood. The in-memory cap `MAX_REGISTRATIONS_PER_IP_PER_HOUR=30` in `oauth-server.js` still applies. If the cap is overwhelmed: enable Cloudflare temporarily (Agent 01 open item).
- Distributed against `/oauth/token` → credential brute-force. Cross-reference with `auth.failure` events.

### Scenario: prompt injection attempts detected

**Signal:** `event='injection.stripped'` cluster from a single `userId`.

```bash
curl -s -H "Authorization: Bearer <admin-jwt>" \
  "https://api.lykn.io/api/admin/security/audit?event_type=injection.stripped&user_id=<uuid>&since=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" \
  | jq '.events[] | {ts: .occurred_at, route: .metadata.route, matchCount: .metadata.matchCount, fieldsScanned: .metadata.fieldsScanned}'
```

**Triage:**
- The `matchCount` is the only payload field that ever sees attempted-injection content — the matched text itself is NEVER logged.
- High `matchCount` across many requests = systematic probing. Review the user's recent activity (vault notes, recent AI conversations) via the admin usage endpoints.
- If genuinely abusive: consider temporary account suspension while investigating. Suspension is currently a manual DB operation (no admin UI button yet — INFO follow-up).

### Scenario: secret suspected leaked

**The 30-second-decision rule:** rotate first, investigate second. Rotation is cheap; a delayed rotation while you "verify" is a confirmed loss.

1. Identify the leaked secret (or assume the worst across the category).
2. Open `ROTATION_RUNBOOK.md` and follow the rotation procedure for that specific secret.
3. **For `CONNECTOR_TOKEN_KEY`:** the rotation now has a tooling-supported safe path (Agent 06):
   ```bash
   # ALWAYS dry-run first.
   OLD_CONNECTOR_TOKEN_KEY=<current> CONNECTOR_TOKEN_KEY=<new> \
     node scripts/rotate-connector-key.mjs --dry-run
   # If dry-run is clean:
   OLD_CONNECTOR_TOKEN_KEY=<current> CONNECTOR_TOKEN_KEY=<new> \
     node scripts/rotate-connector-key.mjs
   # Then swap CONNECTOR_TOKEN_KEY in Render and redeploy.
   ```
4. Check git history for the suspected value:
   ```bash
   git log -p --all -S "<suspected-value>" | head -50
   ```
   If present: BFG Repo Cleaner procedure documented in `ROTATION_RUNBOOK.md`.

### Scenario: `/api/health` is reporting degraded

**Signal:** Render's healthcheck flags the instance as unhealthy; or:
```bash
curl -s https://api.lykn.io/api/health | jq
# → { "status": "degraded", "checks": { ... } }
```

**Read the `checks` object** — it tells you exactly what's degraded:
- `database: 'unreachable' | 'degraded'` → Supabase issue. Check Supabase status page; rotate to a healthy region if needed (Render env var change).
- `secrets: 'missing'` → `SUPABASE_SERVICE_ROLE_KEY` env var lost in production. CRITICAL — paired with `auth.config_missing` event. Restore the env var via Render dashboard and redeploy.
- `replay_events_5m` > 0 → informational only; does not flip the gate, but correlates with active abuse if also seeing other signals.

Render will route traffic away from a degraded instance automatically. Don't manually restart unless the degradation persists across an auto-restart cycle.

---

## Post-incident

Within 48 hours of any P0 / P1:
1. **Postmortem** — root cause, contributing factors, timeline, what worked, what didn't, action items with owners.
2. **Add a regression test** for the failure mode if one is possible at the unit / integration layer.
3. **Update this runbook** — add a new scenario or refine an existing one if the response surfaced gaps.
4. **Update the alert rules** — if a real incident sat undetected for too long, tighten the threshold.

---

## What this runbook is NOT

- Not a rotation runbook — see `ROTATION_RUNBOOK.md` for per-secret rotation procedures.
- Not a deployment runbook — Render dashboard is the deployment surface; `render.yaml` is the blueprint.
- Not a legal / compliance reference — for any incident with potential user-data exposure, consult legal counsel before public communication.

---

*LYKN Security Plan — Agent 06 of 6 — Observability & Incident Response*
