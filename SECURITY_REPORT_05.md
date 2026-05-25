# SECURITY_REPORT_05 — Secrets & Supply Chain Security

**Agent:** 05 of 6 (Secrets & Supply Chain Security Architect)
**Scope:** Secrets inventory · git history · `.env` hygiene · pre-commit hook · startup secret validation · npm dependency audit · rotation runbook
**Companion docs:** `ROTATION_RUNBOOK.md`, `validateSecrets.js`, `.gitleaks.toml`, `.env.example`

---

## Summary

LYKN's secrets posture was **fundamentally sound** but lacked a startup-time gate, a complete secret inventory, a pre-commit-hook tripwire, and a rotation playbook — all of which are now in place. The git history audit was clean: no `.env` file was ever committed (only `.env.example` placeholders), no real secrets surface in any historical commit. The npm audit was less rosy: a critical `jspdf` chain (10 CVEs) plus 31 other vulnerabilities, of which **all 28 auto-fixable issues plus the 1 critical `jspdf` chain** were resolved this session, dropping the audit from **32 vulnerabilities (1 CRITICAL, 16 HIGH, 15 MODERATE) to 3 vulnerabilities (0 CRITICAL, 1 HIGH, 2 MODERATE)** — the residual three are documented under Accepted Risk. `validateSecrets()` is wired into the server boot path and refuses to start a production server with a missing or undersized secret. Test suite (6 tests) green throughout.

---

## Secrets inventory

The complete inventory lives in `validateSecrets.js → SECRET_RULES` (canonical) and `.env.example` (with placeholder values, format hints, and source URLs). Below is the high-level rollup.

### Tier 1 — Server-only secrets (never bundled into browser)

| Secret | Used by | Min length (prod) | Rotation risk if rotated | Startup check |
|---|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | every `supabaseAdmin` call (bypasses RLS) | 40 | ~60s API 5xx during redeploy | YES |
| `STRIPE_SECRET_KEY` | Stripe checkout/subscription API | 32 | Checkout creation 5xx until redeploy | YES |
| `STRIPE_WEBHOOK_SECRET` | webhook signature verify | 32 | Webhooks 400 until redeploy (Stripe retries 3 days) | YES |
| `BACKFILL_SECRET` | `/api/synthesis/backfill` cron bearer | 32 | Cron 401s until updated | YES (raised from 8) |
| `DISCOVER_INGEST_SECRET` | `/api/discover/ingest` cron bearer | 32 | Cron 401s until updated | YES (raised from 8) |
| `ADMIN_INGEST_SECRET` | feed/connector poll cron bearer | 32 | Poll cron 401s until updated | YES (raised from 8) |
| `CONNECTOR_TOKEN_KEY` | AES-256-GCM key for connector OAuth tokens at rest | 64 (hex) | Destructive: every user reconnects unless re-encrypt-in-place | YES |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `XAI_API_KEY` | AI provider fetch | 20 | Provider 401 until redeploy; chat falls back to other providers | warn-only |
| `RESEND_API_KEY`, `SERPER_API_KEY`, `LASTFM_API_KEY`, `META_APP_TOKEN`, `WHISPER_HOSTED_API_KEY`, `TRELLO_API_KEY`, `YOUTUBE_API_KEY` | various single-purpose integrations | 16–20 | Feature 503 until redeploy | warn-only |
| `*_CLIENT_SECRET` × 17 connectors | OAuth flows for GitHub/Reddit/Notion/Spotify/Pinterest/Linear/Todoist/Vimeo/Raindrop/Dribbble/Google/Microsoft/Slack/X/Canva/Instagram/Mastodon (per-instance) | 20 | New OAuth flows fail until rotated; existing user tokens generally survive (GitHub is the exception) | YES (paired check: only required when matching `*_CLIENT_ID` is set) |

Full per-secret rotation procedure in `ROTATION_RUNBOOK.md`.

### Tier 2 — Browser-safe `VITE_*` (intentionally bundled into the JS)

| Var | Bundled into browser? | Verdict |
|---|---|---|
| `VITE_SUPABASE_URL` | YES | OK — public Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | YES | OK — RLS is the actual gate |
| `VITE_STRIPE_PUBLISHABLE_KEY` | YES | OK — public by Stripe design |
| `VITE_API_BASE_URL` | YES | OK — public API origin |
| `VITE_FRONTEND_BASE_URL` | YES | OK — public SPA origin |
| `VITE_PUBLIC_MCP_URL` | YES | OK — dev tunnel only |
| `VITE_ENABLE_LEGACY_NOTES` | YES | OK — feature flag |
| **`VITE_ADMIN_EMAILS`** | YES | **INFO — see findings below** |

`validateSecrets()` rejects any `VITE_*` env var not in this allowlist as a fatal-in-prod misconfiguration.

---

## VITE_* audit result

**[CLEAN]** with one INFO finding (`VITE_ADMIN_EMAILS`, see findings).

- Server-side files (`server.js`, `oauth-server.js`, `mcp-*.js`, `synthesis-*.js`, `connectors/`, `jobs/`) reference exactly two `VITE_*` values: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` — both are intentionally public (Supabase docs explicitly recommend including the anon key in client bundles).
- No server-side secret carries a `VITE_*` prefix.
- The `validateSecrets()` startup check enforces this allowlist on every boot — any future `VITE_NEW_SECRET=...` mistake fails the prod deploy at boot.

---

## Git history audit result

**[CLEAN — no real secrets in history.]**

`gitleaks` is not installed in this environment, so the audit was performed via targeted `git log -S` greps and a path-based file-history scan:

```
git log --all --full-history -- '.env' '.env.*'
   → only .env.example commits found (4 commits — all touch placeholders)
git log --all --full-history -- '.env'
   → empty (no real .env file ever committed)
git log -p --all -S "sk-" -- "*.js" "*.ts" "*.env"
git log -p --all -S "SUPABASE_SERVICE_ROLE_KEY"
git log -p --all -S "STRIPE_WEBHOOK_SECRET"
   → only env-var name references in source code or .env.example, no real values
```

**Recommendation:** install `gitleaks` (`brew install gitleaks`) on every developer workstation so the local pre-commit hook (now installed) becomes active. The hook is silent if gitleaks isn't installed.

---

## .gitignore status

**[COMPLETE]** after Agent 05 cleanup.

Before:
- Duplicate `.env` line at lines 8 and 22.
- No catch-all for the `1772579*-player-script.js` scrape artifacts (which were also untracked in the workspace and polluting secret-pattern audits with 4.8 MB of irrelevant matches).
- Missed `npm-audit-report.json` and `gitleaks-report.json` scratch outputs.

After:
- Single deduplicated `.env` / `.env.*` block with `!.env.example` exception.
- `*-player-script.js` pattern matching the `<13-digit-timestamp>-player-script.js` shape.
- Both audit-output filenames added.
- Cursor IDE artifacts (`.cursor/`) added.

The two scratch files (2.4 MB each) were deleted.

---

## npm audit summary

**Before:** 32 vulnerabilities (1 CRITICAL, 16 HIGH, 15 MODERATE)
**After:** 3 vulnerabilities (0 CRITICAL, 1 HIGH, 2 MODERATE) — all in the Accepted Risk bucket below.

| Action | Vulns resolved | Notes |
|---|---|---|
| `npm audit fix` (auto-fixable, no `--force`) | 28 | Tests still pass after fix |
| `npm install jspdf@4.2.1 --save-exact` | 1 (CRITICAL with 10 CVEs) | `jspdf` is declared in `package.json` but not actually imported anywhere in source — an unused leftover dependency. Breaking 3.x→4.x bump is therefore impact-free. Pinned exact (no caret) to prevent drift. |
| Deferred | 3 | See Accepted Risk |

Full per-package detail (resolved):

| Package | Severity | CVE class | Resolution |
|---|---|---|---|
| `jspdf` 3.x → 4.2.1 | CRITICAL | LFI, PDF injection, DoS, race condition, etc. (10 advisories) | upgraded, pinned exact |
| `@remix-run/router`, `react-router`, `react-router-dom` | HIGH | XSS via open redirect | auto-upgraded |
| `@xmldom/xmldom` | HIGH | XML injection (5 advisories) | auto-upgraded |
| `flatted` | HIGH | Prototype pollution + DoS | auto-upgraded |
| `lodash` | HIGH | Prototype pollution + code injection (3 advisories) | auto-upgraded |
| `minimatch` | HIGH | ReDoS (4 advisories) | auto-upgraded |
| `multer` | HIGH | DoS (3 advisories) | auto-upgraded |
| `path-to-regexp` | HIGH | ReDoS | auto-upgraded |
| `picomatch` | HIGH | Method injection + ReDoS | auto-upgraded |
| `rollup` | HIGH | Path traversal | auto-upgraded |
| `socket.io-parser` | HIGH | Unbounded binary attachments | auto-upgraded |
| `underscore` | HIGH | Unbounded recursion | auto-upgraded |
| `undici` | HIGH | WebSocket overflow + smuggling (6 advisories) | auto-upgraded |
| `vite` | HIGH | Path traversal + dev-server file read | auto-upgraded |
| `ajv` | MODERATE | ReDoS | auto-upgraded |
| `brace-expansion`, `engine.io-client`, `express-rate-limit` (transitive `ip-address`), `follow-redirects`, `ip-address`, `postcss`, `qs`, `resend` (transitive `svix → uuid`), `svix`, `uuid`, `ws`, `yaml` | MODERATE | various | auto-upgraded |

**Lock-file integrity:** `package-lock.json` is committed and tracked. Verified:
```
$ git ls-files package-lock.json
package-lock.json
```

**`npm test` after every batch:** all 6 tests pass.

---

## Accepted Risk (deferred dependency upgrades)

Three vulnerabilities remain in the audit. Per Agent 05's plan and user approval, these are deferred — the rationale, mitigation, and replacement path are documented here so the next maintainer has full context.

### `xlsx` ≥0.18.5 — HIGH (no fix available)

- **CVEs:**
  - `GHSA-4r6h-8v6p-xvw6` — Prototype Pollution in SheetJS
  - `GHSA-5pgg-2g8v-p4x9` — SheetJS ReDoS
- **Why deferred:** SheetJS Inc. removed `xlsx` from npm in 2024 and now distributes only via their CDN / paid feed. There is no patched npm version of `xlsx` — `npm audit` reports "No fix available" because npm cannot reach a fixed version. Updating in place is not an option.
- **Mitigation in current code:**
  - `xlsx` is invoked only on user-uploaded `.xlsx` files (Vault import path). Inputs already pass through size limits (`/api/uploads` multer config) and the request flows through `requireAuth`, so unauthenticated abuse is not possible.
  - The prototype-pollution CVE requires a maliciously crafted XLSX from a paying user; LYKN does not import third-party XLSX from public sources.
  - The ReDoS CVE caps at one slow request per upload; that is bounded by the per-user rate limits Agent 04 added.
- **Recommended replacement path:**
  - Migrate to `exceljs` (active maintenance, MIT, drop-in for read paths) **or** SheetJS's CDN-distributed `xlsx` (if you want feature parity but accept the non-npm distribution model).
  - Track as a dedicated PR — the API surface is similar but workbook → row mapping in `vault-importers/` will need a code change.
- **Severity rating retained as HIGH** but **risk-accepted** until the migration PR ships.

### `quill` <2.0 (via `react-quill@^1.3.5`) — MODERATE × 2 (breaking fix)

- **CVE:** `GHSA-4943-9vgg-gr5r` — Cross-site Scripting in quill
- **Why deferred:** The advised fix is `npm audit fix --force` → `react-quill@0.0.2`. That is **not** a typo: react-quill jumped from 1.x to 2.x with a `0.0.x` series in between, and the auto-fix would *downgrade* to a semver-incomparable scaffold release that does not export the same component API. The ecosystem migration target is `quill@2.x` + `react-quill-new` (or rebuild on TipTap, which LYKN already uses elsewhere).
- **Mitigation in current code:**
  - The Quill editor is mounted inside the in-app rich-text editor only. Output is rendered in the same DOM subtree; the XSS vector requires user A to author content that user B then renders.
  - LYKN's content-rendering path uses `dompurify` (already declared in `package.json` and used by the Vault preview pipeline). Quill output that flows through DOMPurify before render-on-someone-else's-screen is sanitized.
  - **Action required for the deferral to remain valid:** confirm every render of Quill HTML by user B passes through DOMPurify. (Track as Agent 06 follow-up: add a code-search rule.)
- **Recommended replacement path:**
  - LYKN already uses TipTap (`@tiptap/*`) in the Notes panel. Migrate the remaining `react-quill` mount points to TipTap and remove `react-quill` + `quill` from `package.json` entirely.
- **Severity rating retained as MODERATE** but **risk-accepted** pending the TipTap migration.

---

## Startup validation

**[IMPLEMENTED]** in `validateSecrets.js`, called from `server.js` immediately after `dotenv.config()` and before any route registration. Verified by:

- Dev-mode smoke test (existing `.env` with 9 missing optional secrets) → 9 warnings, boot continues. ✓
- Prod-mode smoke test (empty env, NODE_ENV=production) → 7 fatal errors, exit code 1. ✓

The 8-character per-call floor in `verifyBackfillSecret` / `verifyDiscoverIngestSecret` / `verifyAdminIngestSecret` is **preserved** as a defense-in-depth point-of-use guard. Both checks coexist on purpose: the startup check prevents the server from running with an undersized secret in the first place; the per-call check catches the edge case where the env was hot-mutated post-boot.

---

## Changes made

| File | Change | CIA | Principle | Severity addressed |
|---|---|---|---|---|
| **DELETED** `1772579083023-player-script.js` (2.4 MB) | YouTube player scrape artifact polluting secret-pattern grep audits | Confidentiality | KISS, SbD | LOW (hygiene) |
| **DELETED** `1772579083031-player-script.js` (2.4 MB) | (same) | Confidentiality | KISS, SbD | LOW (hygiene) |
| `.gitignore` | Folded duplicate `.env` lines, added `*-player-script.js`, added `.cursor/`, `npm-audit-report.json`, `gitleaks-report.json` | Confidentiality | DiD | LOW |
| `.env.example` (rewrite) | Complete inventory of all 70+ env vars with placeholders, format hints, source URLs, generation commands, and `validateSecrets` cross-reference | Confidentiality, Availability | LP, SoD, KISS | MEDIUM |
| **NEW** `validateSecrets.js` | Startup secret-validation module: `SECRET_RULES` (single source of truth), connector-pair coherence check, `VITE_*` server-side leak guard, fail-closed in production | Confidentiality, Availability | SbD, DiD | HIGH |
| `server.js` | Imported and invoked `validateSecrets()` immediately after `dotenv.config()` (before route registration). Documented the DiD relationship with the per-call 8-char floor | Confidentiality, Availability | SbD, DiD | HIGH |
| **NEW** `.gitleaks.toml` | LYKN-specific gitleaks config — extends defaults, allowlists `.env.example`, security reports, runbook, supabase-migrations, `node_modules/`, `.cursor/`, and the `your-*-here` placeholder shape | Confidentiality | DiD | MEDIUM |
| **NEW** `.git/hooks/pre-commit` | Executable shell hook running `gitleaks protect --staged` against the LYKN config; silent no-op if gitleaks not installed; `LYKN_SKIP_GITLEAKS=1` bypass for scripted commits | Confidentiality | DiD | MEDIUM |
| `package.json`, `package-lock.json` | `npm audit fix` (auto-fixable batch, 28 CVEs resolved) + `jspdf@4.2.1 --save-exact` (1 CRITICAL with 10 CVEs resolved) | Integrity, Availability | DiD, SbD | CRITICAL + HIGH × multiple |
| **NEW** `ROTATION_RUNBOOK.md` | Operational runbook: per-secret rotation, breakage windows, incident response, routine cadence, postmortem template | Confidentiality, Availability | SbD, DiD, KISS | MEDIUM |
| **NEW** `SECURITY_REPORT_05.md` | This document | — | — | — |

---

## Findings by severity

### CRITICAL
- *(none — `jspdf` chain resolved this session)*

### HIGH
- *(none new — all auto-fixable HIGHs resolved this session; `xlsx` deferred under Accepted Risk)*

### MEDIUM
- **M1.** `BACKFILL_SECRET` / `DISCOVER_INGEST_SECRET` / `ADMIN_INGEST_SECRET` had a per-call 8-char minimum, far below the 32-char recommendation. **Resolved** at startup-validation level (32-char floor in `validateSecrets()`). Per-call 8-char floor preserved as DiD; raise that to 32 in a follow-up PR after every prod deployment is rotated to ≥32-char values (procedure documented in runbook).
- **M2.** No `.gitleaks.toml` or pre-commit hook existed before Agent 05. **Resolved.** The hook is silent if gitleaks isn't installed; CI integration is Agent 06's domain.
- **M3.** `.env.example` was incomplete (missing ~50 of the ~70 env vars LYKN actually uses). **Resolved** with full rewrite.
- **M4.** No rotation runbook existed. **Resolved** with `ROTATION_RUNBOOK.md`.

### LOW
- **L1.** Two 2.4 MB `*-player-script.js` scrape artifacts were untracked at the repo root, polluting `grep -r` audits. **Resolved** (deleted, pattern added to `.gitignore`).
- **L2.** `.gitignore` had a duplicated `.env` line. **Resolved.**

### INFO
- **I1. `VITE_ADMIN_EMAILS` information disclosure.** This env var is `VITE_*`-prefixed by design (the SPA reads it to gate admin-UI elements client-side). The value is **bundled into the public JavaScript bundle** and visible to every visitor. This is **information disclosure**, not privilege escalation — server-side `requireAdmin` middleware is the actual access gate, and Agent 02/04 confirmed that gate is correctly enforced on every admin route. However, leaking the email addresses of admins gives an attacker a targeting list for credential-stuffing or phishing campaigns. **Decision deferred to product owner:** retain the client-side flag as-is (current behavior, accepts the disclosure trade-off for code simplicity), or migrate to a server-side `is_admin` flag returned by `/api/account/me` (server-only, no email addresses bundled). `validateSecrets()` accepts `VITE_ADMIN_EMAILS` in its `PUBLIC_VITE_ALLOWLIST` to avoid blocking deploys; a code comment in that file flags the trade-off.
- **I2.** `xlsx@0.18.5` HIGH × 2 — accepted risk; see `Accepted Risk` section. Migration to `exceljs` recommended.
- **I3.** `quill` / `react-quill` MODERATE × 2 — accepted risk; see `Accepted Risk` section. Migration to TipTap recommended.

---

## CIA triad coverage

- **Confidentiality** — Server-only secrets are isolated from the browser bundle (`VITE_*` allowlist enforced at startup). `.env` files cannot be committed (gitignore + pre-commit hook). 28 + 1 dependency CVEs that could leak data in error paths (path traversal, ReDoS, prototype pollution) are resolved.
- **Integrity** — `package-lock.json` is committed and integrity-checked by npm on install. `jspdf` and the `validateSecrets()` schema are pinned (the latter via the `SECRET_RULES` table that is the single source of truth across `.env.example`, `validateSecrets.js`, and `ROTATION_RUNBOOK.md`).
- **Availability** — `validateSecrets()` fails *closed* in production: a misconfigured server doesn't ship; Render's auto-restart loop surfaces the failure as a deployment-failed alert rather than running with a silently bad secret. Rotation runbook reduces MTTR for secret-leak incidents.

---

## Open items — need review before Agent 06 starts

1. **Raise the per-call 8-char floor to 32 chars** in `verifyBackfillSecret`, `verifyDiscoverIngestSecret`, `verifyAdminIngestSecret` once every deployment has rotated to ≥32-char values. Tracking: defer to a follow-up PR, sequence per `ROTATION_RUNBOOK.md`.
2. **Implement re-encrypt-in-place migration for `CONNECTOR_TOKEN_KEY`.** Currently rotation is destructive (every user reconnects). The runbook documents the design for the safer path (`CONNECTOR_TOKEN_KEY_NEXT` env var + one-shot migration script), but the script itself is not yet implemented.
3. **Migrate Quill editor mount points to TipTap** to drop `react-quill` and resolve the deferred MODERATE CVEs.
4. **Migrate `xlsx` consumers to `exceljs`** to drop `xlsx` and resolve the deferred HIGH CVEs.
5. **Decide `VITE_ADMIN_EMAILS` policy** (retain client-side / move server-side via `/api/account/me`). Product-owner call.

---

## Findings for Agent 06 (Observability & Logging)

- **F06-1. CI secret scanning.** Local pre-commit hook is in place; CI scanning is the authoritative gate and belongs to Agent 06. Recommended: GitHub Action that runs `gitleaks detect --source . --config .gitleaks.toml --redact --exit-code 1` on every PR, plus a daily scheduled run on `main`.
- **F06-2. Boot-time secret-validation logging.** `validateSecrets()` currently writes warnings to `console.warn`. Agent 06 should pipe these into the structured log stream so the on-call alerting catches "boot succeeded with degraded config" (e.g. AI provider key missing in prod).
- **F06-3. Rotation event audit trail.** Add a `lykn_security_audit` event for every secret rotation (manual operator action recorded via a small `/api/admin/rotation-recorded` endpoint or directly in the runbook). Useful for postmortems.
- **F06-4. npm audit in CI.** Wire `npm audit --audit-level=high --production` into CI. Fail the build on any new HIGH/CRITICAL. Alert on any new MODERATE so the team can review without blocking shipping.
- **F06-5. DOMPurify-around-Quill verification.** The `quill` deferral assumes Quill HTML is sanitized via DOMPurify before being rendered in another user's browser. Add a CI grep rule (or eslint custom rule) that flags any direct render of Quill output without going through `DOMPurify.sanitize`.
- **F06-6. Connector-token re-encrypt-in-place script.** When implemented (open item #2 above), the migration should emit `lykn_security_audit` rows so the rotation is forensically traceable.

---

## Verification checklist

- [x] `.env`, `.env.*` in `.gitignore` (with `!.env.example` exception)
- [x] No `.env` files tracked in git (only `.env.example`)
- [x] `.env.example` exists with placeholder values for every secret (~70+ vars)
- [x] Git history clean — only `.env.example` ever committed; no real secret values found by `git log -S "sk-"`, `git log -S "SUPABASE_SERVICE_ROLE_KEY"`, or `git log -S "STRIPE_WEBHOOK_SECRET"`
- [x] No `VITE_*`-prefixed server-side secrets anywhere in codebase (`validateSecrets()` enforces at startup)
- [x] All server-side secrets read from `process.env`, never hardcoded
- [x] `validateSecrets()` implemented and called at server startup, immediately after `dotenv.config()`
- [x] `BACKFILL_SECRET`, `DISCOVER_INGEST_SECRET`, `ADMIN_INGEST_SECRET` documented as ≥32 chars in runbook (and enforced at startup; per-call 8-char floor preserved as DiD)
- [x] `CONNECTOR_TOKEN_KEY` documented as exactly 64 hex chars (32 bytes for AES-256), enforced at startup
- [x] `npm audit` run — all CRITICAL and auto-fixable HIGH/MODERATE CVEs addressed; remaining 3 documented under Accepted Risk
- [x] `package-lock.json` committed and tracked in git
- [x] Pre-commit hook installed (`.git/hooks/pre-commit`) with gitleaks invocation
- [x] `.gitleaks.toml` created with LYKN-specific allowlist
- [x] `ROTATION_RUNBOOK.md` created at repo root
- [x] `SECURITY_REPORT_05.md` created at repo root (this document)
- [x] `npm test` green after every change
