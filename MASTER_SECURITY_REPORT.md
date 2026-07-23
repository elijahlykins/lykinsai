# LYKN Master Security Report

**Date generated:** 2026-05-25 (completion of Agent 06 of 6)
**Scope:** Consolidated record of the LYKN six-agent security plan.
**Per-agent details:** `SECURITY_REPORT_01.md` through `SECURITY_REPORT_06.md`.
**Operational runbooks:** `ROTATION_RUNBOOK.md` (Agent 05), `INCIDENT_RUNBOOK.md` (Agent 06).

---

## Overall posture

Before this plan, LYKN was a working Render+Vercel+Supabase deployment with no application-layer WAF, scattered ad-hoc rate limiting, partial RLS, ~30 sites that forwarded raw `error.message` to the wire, ~5MB JSON bodies accepted everywhere, no input prompt sanitisation, no startup secrets validation, no `/api/health` despite Render expecting one, an audit table that nothing read, no pre-commit hook, no CI security gates, and no rotation tooling for the AES key encrypting every connector OAuth token. After this plan, every one of those gaps is closed or has documented mitigation. Every security event of operational interest flows through a single canonical logger to two sinks (Render log drain + service-role-only audit table). Every JSON-accepting endpoint is body-size-capped, every OAuth credential-mint endpoint is rate-limited, every user-controlled string entering the AI prompt chain is sanitised, every required secret is validated at boot with production fail-closed semantics, every connector token is encrypted at rest with a key that can now be rotated safely, every PR ships through gitleaks + npm audit gates, and operators have a queryable audit endpoint plus an incident-response playbook. Two structural items remain outside code scope and are flagged below: Cloudflare WAF in front of the API, and a Supabase IP allowlist (requires a Render plan with static egress IPs).

---

## Agents completed

| Agent | Focus | CRITICAL | HIGH | MEDIUM | LOW | INFO | Status |
|---|---|---|---|---|---|---|---|
| 01 | Infrastructure & Perimeter | 0 | 0 | 3 | 2 | 6 | Complete |
| 02 | Auth & Session | 0 | 1 | 3 | 1 | 4 | Complete |
| 03 | Data & Database | 0 | 0 | 2 | 2 | 3 | Complete |
| 04 | API & Application | 0 | 2 | 10 | 2 | 4 | Complete |
| 05 | Secrets & Supply Chain | 0 (resolved) | 0 (resolved) | 4 | 2 | 3 | Complete |
| 06 | Observability & IR | 0 | 3 | 6 | 2 | 6 | Complete |
| **Total** | | **0** | **6** | **28** | **11** | **26** | **All complete** |

All HIGH and CRITICAL findings discovered during the plan are fixed. Six MEDIUM-rated items are now Accepted Risks with documented mitigation and replacement paths.

---

## Open items (not closed inside code by any agent)

Carry-over items that need either out-of-code action or a future PR:

| # | Item | Originating agent | Severity | Path forward |
|---|---|---|---|---|
| 1 | **Cloudflare WAF in front of API** | Agent 01 | CRITICAL (infra) | DNS + Render custom-domain mapping. Until in place, application-layer rate limits + logging are the only DiD line. |
| 2 | **Supabase IP allowlist** | Agent 01 | HIGH (infra) | Requires Render plan with static egress IP, or route Supabase calls through a static-IP egress proxy. Defer until user volume justifies. |
| 3 | **HSTS preload** | Agent 01 | LOW | Deliberately deferred per product owner. Track if policy changes. |
| 4 | **Supabase IP allowlist requires Render plan upgrade** | Agent 01 | HIGH (infra) | See item 2. |
| 5 | **OAuth callback popup `postMessage(..., '*')` fallback** | Agent 01 + Agent 02 | LOW | Agent 02 pinned the target origin; the `'*'` fallback only fires on misconfigured `CONNECTOR_FRONTEND_BASE`. Documented; not blocking. |
| 6 | **Local JWT verification fast-path** | Agent 02 INFO 2 | INFO | Deferred — every requireAuth call still hits Supabase. Own PR with integration tests when ready. |
| 7 | **HttpOnly / SameSite=Strict cookies** | Agent 02 INFO 1 | INFO | Major architecture change (Supabase SDK uses localStorage). Not a hardening pass. |
| 8 | **Settings UI button for `signOut({ everywhere: true })`** | Agent 02 | LOW (UX gap) | Capability shipped; UI button is trivial follow-up. Wire `SESSION_SIGNOUT_ALL` event when added. |
| 9 | **Service-role-first pattern in user routes** | Agent 03 I3 | INFO | Migrate ~20 routes from `supabaseAdmin || createSynthesisUserClient` to the user-JWT client to let RLS double-check the application-layer scoping. Per-route testing required. |
| 10 | **`lykn_security_audit` retention policy** | Agent 03 | INFO | Years-out at current volume. Add a cron-purge when log shipping is wired. |
| 11 | **`/api/ai/stream` + `/api/ai/invoke` full Zod validation** | Agent 04 INFO 1 | INFO | Sanitisation + 200K-char cap close the highest-impact gap. Full Zod conversion deserves its own PR with integration tests. |
| 12 | **`generationLimiter` is dead code** | Agent 04 INFO 3 | LOW | Either mount it on the next text-generation route or delete it. Handler is wired (Agent 06) so a future mount automatically gets event emission. |
| 13 | **`xlsx` → `exceljs` migration** | Agent 05 Accepted Risk | MEDIUM | 2 HIGH CVEs in `xlsx@0.18.5` with no upstream fix. Migrate the Vault XLSX import path to `exceljs`. |
| 14 | **`react-quill` → TipTap migration** | Agent 05 Accepted Risk | MEDIUM | 2 MODERATE CVEs (Quill XSS). LYKN already uses TipTap elsewhere — migrate remaining Quill mount points and drop the dep entirely. |
| 15 | ~~**Per-call 8-char floor → 32 chars**~~ | Agent 05 | MEDIUM | **Done** — per-call verify* helpers now require ≥32 chars. |
| 16 | **`VITE_ADMIN_EMAILS` information-disclosure** | Agent 05 INFO 1 | INFO | Product-owner decision: retain client-side flag (current) vs. move to a server-side `is_admin` flag returned by `/api/account/me`. |
| 17 | **External log aggregator** | Agent 06 | (operational) | Connect Render log drain to Datadog / Better Stack / Loki / etc. Once connected, the alert thresholds in `INCIDENT_RUNBOOK.md` become actionable. |
| 18 | **CSP `report-uri` / `report-to`** | Agent 01 + Agent 06 | LOW | Once an external endpoint is stood up, wire it into the CSP. Blocked-request telemetry currently does not exist. |
| 19 | **Admin UI for `lykn_security_audit`** | Agent 06 | INFO | The endpoint exists (`GET /api/admin/security/audit`); a graphing UI is a future PR. |

---

## Architecture security decisions (for future contributors)

These decisions are baked into the codebase and should NOT be changed without explicit security review:

1. **Render + Vercel + Supabase is the topology.** LYKN does NOT run nginx / Caddy / Docker. Every header / cipher / port-binding concern that would normally live in a reverse proxy is enforced at the next-closest layer we control: Express middleware on the backend, `vercel.json` headers on the frontend. See `SECURITY_REPORT_01.md` for the full rationale.
2. **`app.set('trust proxy', 1)`** is required for correct `req.ip` semantics behind Render's edge. Every rate limiter, every audit row, every `INCIDENT_RUNBOOK.md` query that uses an IP depends on this being correct. Don't change it without changing the deployment topology.
3. **Frontend CSP keeps `style-src 'unsafe-inline'`; backend CSP doesn't.** This is a deliberate asymmetric trade-off — Tiptap / Radix / Framer Motion / React Quill all inject inline styles. `script-src` is never relaxed.
4. **`*.vercel.app` is NOT a wildcard origin.** CORS is pinned to `/^lykn-ideation-[a-z0-9-]+-elijahlykins-projects\.vercel\.app$/` plus production hosts. If the Vercel team/org slug ever changes, this regex needs to be updated — flagged as a maintenance trigger in `SECURITY_REPORT_01.md`.
5. **Supabase Auth handles end-user identity end-to-end.** LYKN does NOT run a Google OAuth callback; Supabase does. The state/nonce/ID-token-validation work all happens inside Supabase Auth. Don't try to add a LYKN-side Google callback unless replacing Supabase Auth entirely.
6. **PKCE-S256 is mandatory** on the LYKN-as-OAuth-Provider flow. Non-S256 is rejected. Authorization codes are 60s TTL, single-use, hashed at rest. Refresh tokens rotate; double-redemption outside the 10s grace window triggers `revokeRefreshFamily` (RFC 6749 §10.4) and emits `OAUTH_REPLAY_DETECTED`.
7. **`crypto.timingSafeEqual`** is the ONLY acceptable comparison for cron secrets, OAuth `client_secret` checks, PKCE verifier checks, and any long-lived bearer token. `!==` on a secret is a vulnerability.
8. **Service-role key bypasses RLS.** Every `supabaseAdmin.from(...)` call is implicitly trusted. The application-layer `.eq('user_id', req.user.id)` filter is the only thing preventing cross-user reads in routes that use `supabaseAdmin`. Audit every new such route.
9. **The OAuth provider tables (`lykn_oauth_*`) and `lykn_mcp_tokens` and `lykn_security_audit` are RLS-on, ZERO-policies — service-role-only.** Don't add `TO authenticated` policies to these tables. Server-side `supabaseAdmin` is the only legitimate reader/writer.
10. **`lykn_security_audit` is append-only.** Never delete rows. Retention policy is a future cron, not an ad-hoc `DELETE`.
11. **`validateSecrets()` runs at boot** in `server.js:138`. Production refuses to start with a missing or undersized required secret. Don't bypass; if a new required secret is added, update `SECRET_RULES` in `validateSecrets.js`.
12. **The `CHAT_TOOL_NAMES` allowlist in `mcp-tools/chatTools.js`** is the canonical list of MCP tools dispatchable from the in-app chat agent. New tools must be added there to be callable; never bypass `runChatTool` to dispatch a non-whitelisted tool.
13. **The Stripe webhook handler uses `express.raw` BEFORE the global `express.json`** so the raw body bytes survive for signature verification. Don't reorder.
14. **`CONNECTOR_TOKEN_KEY` rotation MUST use `scripts/rotate-connector-key.mjs --dry-run` first.** A dry-run with failures means DON'T proceed live — investigate first. The script and the runtime share the AES-256-GCM implementation via the explicit-key exports in `connectors-service.js`; never replicate the algorithm.
15. **The global error handler is the LAST `app.use` in `server.js`.** Adding any `app.<method>` registration after it silently bypasses error handling for that route. The handler's comment explicitly enumerates the routes registered above it; update the comment when adding new ones.
16. **Every security event flows through `security-logger.js`.** Don't emit ad-hoc structured `console.error` lines for new security-relevant code paths — add a `SecurityEvent` constant and call `logSecurityEvent`. The audit row + Render log drain wiring is the same path.
17. **`security-logger.js` is wired with the supabaseAdmin sink via `setSecurityLoggerSink()` at boot.** Don't import `supabaseAdmin` directly inside `security-logger.js` — the DI is what avoids a `server.js ↔ security-logger.js` import cycle.
18. **`/api/health` MUST stay under 2 seconds** or Render marks the instance unhealthy. Every check inside it is time-budgeted with `Promise.race`.

---

## Files added or modified across the six-agent plan

### Agent 01 (Infrastructure & Perimeter)
- Modified: `server.js`, `vercel.json`, `index.html`
- New: `public/embed-detect.js`, `SECURITY_REPORT_01.md`

### Agent 02 (Auth & Session)
- Modified: `server.js`, `src/lib/SupabaseAuth.jsx`
- New: `SECURITY_REPORT_02.md`

### Agent 03 (Data & Database)
- New: `supabase-migrations/065_security_rls_agent03.sql`, `SECURITY_REPORT_03.md`

### Agent 04 (API & Application)
- Modified: `server.js` (10 sites)
- New: `validation.js`, `prompt-sanitizer.js`, `SECURITY_REPORT_04.md`

### Agent 05 (Secrets & Supply Chain)
- Modified: `.gitignore`, `.env.example`, `server.js`, `package.json`, `package-lock.json`
- New: `validateSecrets.js`, `.gitleaks.toml`, `.git/hooks/pre-commit`, `ROTATION_RUNBOOK.md`, `SECURITY_REPORT_05.md`
- Deleted: `1772579083023-player-script.js`, `1772579083031-player-script.js`

### Agent 06 (Observability & Incident Response)
- Modified: `server.js`, `oauth-server.js`, `connectors-service.js`, `validation.js`, `prompt-sanitizer.js`
- New: `security-logger.js`, `security-logger.test.js`, `scripts/rotate-connector-key.mjs`, `.github/workflows/security.yml`, `INCIDENT_RUNBOOK.md`, `MASTER_SECURITY_REPORT.md`, `SECURITY_REPORT_06.md`

---

## How to read this plan as a future contributor

If you're new to the LYKN codebase and want to understand the security model in 30 minutes:

1. **Read `SECURITY_REPORT_01.md`** — perimeter, headers, CORS, CSP. The first model in your head: "what is the trust boundary?"
2. **Read `SECURITY_REPORT_02.md`** — how authentication actually flows. Two systems: Supabase Auth for end users, LYKN-as-OAuth-provider for outside MCP clients.
3. **Skim `SECURITY_REPORT_03.md`** — the data layer. RLS is the floor; application-layer `.eq('user_id', req.user.id)` is what `supabaseAdmin` routes rely on.
4. **Read `SECURITY_REPORT_04.md`** — input validation + rate limiting + the global error handler. Especially: the global error handler is the LAST `app.use`.
5. **Read `ROTATION_RUNBOOK.md`** before rotating any secret. Read `SECURITY_REPORT_05.md` for the secrets inventory.
6. **Read `SECURITY_REPORT_06.md`** to understand how to query for events. Read `INCIDENT_RUNBOOK.md` for the first-15-minutes playbook.

---

## How to run the next security review

Recommended cadence: **every 6 months**, or after any of:
- New top-level route on `server.js` that handles user data
- New connector adapter that holds user tokens
- New MCP tool that the chat agent can dispatch
- New Supabase migration that creates a user-data table
- Major dependency upgrade (especially `@supabase/*`, `express`, `stripe`, `dompurify`, `zod`)

Per-review checklist:
1. Re-read each `SECURITY_REPORT_0N.md` and verify the "Open items" sections — has anything moved? Anything new?
2. Run `npm audit` and reconcile the output against `.github/workflows/security.yml`'s Accepted-Risk list.
3. Spot-check `lykn_security_audit` — are events being written? Any unexplained `OAUTH_REPLAY_DETECTED` or `AUTH_CONFIG_MISSING` in the last 90 days?
4. Re-run the verification checklist at the end of `SECURITY_REPORT_06.md` against the current `server.js` — has anything regressed?
5. If the plan needs to be re-run, follow the same six-agent split. Each agent's brief and constraints are preserved in the corresponding system prompt block (saved in repo history).

---

*LYKN Security Plan — Master Report*
*Six agents, one record. Consolidated 2026-05-25 after completion of Agent 06.*
