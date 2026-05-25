# LYKN Secret Rotation Runbook

**Owner:** Agent 05 (Secrets & Supply Chain Security)
**Companion docs:** `.env.example`, `validateSecrets.js`, `SECURITY_REPORT_05.md`

---

## How to read this document

Every secret used by LYKN is documented in **three layers**:

1. **`.env.example`** — placeholder, format, and where to obtain it.
2. **`validateSecrets.js → SECRET_RULES`** — minimum length and required-in-prod flag, enforced at server startup.
3. **This runbook** — how to rotate, what breaks during rotation, and the incident-response sequence if leaked.

If those three diverge, **this runbook wins** — update the code to match it.

## Generation primitives

```bash
# 32-byte URL-safe random string (use for all *_SECRET, BACKFILL_SECRET, etc.)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# 32-byte hex string (use for CONNECTOR_TOKEN_KEY — must be exactly 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
openssl rand -hex 32

# Base64 (alternative to base64url; use only if downstream consumer requires)
openssl rand -base64 32
```

The `validateSecrets()` startup check enforces a **32-character minimum** for `BACKFILL_SECRET`, `DISCOVER_INGEST_SECRET`, and `ADMIN_INGEST_SECRET` in production. The per-call `verifyBackfillSecret` / `verifyDiscoverIngestSecret` / `verifyAdminIngestSecret` functions in `server.js` keep their pre-existing 8-char point-of-use floor as defense-in-depth — both checks coexist intentionally.

---

## Standard rotation procedure (Render)

For every secret below, the canonical rotation flow is:

1. Generate a new value with the correct primitive above.
2. **Render Dashboard** → service → **Environment** → update the key → **Save Changes**.
3. Render auto-redeploys. Watch boot logs for `[secrets] Validated N/M required secrets — boot OK`. If `validateSecrets()` reports a fatal error, the service exits 1 and Render flags the deploy as failed — fix the env var and redeploy.
4. Update the source-of-truth password manager (1Password / Bitwarden) **immediately** so the value isn't lost.
5. If the secret is verified by HMAC at the edge of an incoming webhook (Stripe), **also** update the webhook signing secret in the source provider's dashboard so they sign with the new key. Otherwise webhooks 400 with `signature_failed`.

Each entry below documents the deviations from this standard flow.

---

## Per-secret rotation entries

Severity legend: blast radius if the secret leaks today.

### 1. `SUPABASE_SERVICE_ROLE_KEY` — **Catastrophic**

- **What it does:** Server-only Supabase JWT that bypasses every Row-Level-Security policy. Used by every `supabaseAdmin` call.
- **Where to rotate:** Supabase Dashboard → Project → **Settings → API** → there are two slots; rotate the service-role key.
- **What breaks during rotation:** Window between dashboard rotation and Render restart. Everything that talks to Supabase from the server returns 5xx until the new value is live. Plan for ~60s of degraded API.
- **Token invalidation:** Existing user sessions (anon-key Supabase Auth) are **not** affected — those use a separate anon-key signing key. Background jobs in flight will fail and need a retry pass.
- **If leaked:**
  1. Rotate **immediately** (this is the highest-blast-radius secret).
  2. Open a Supabase support ticket noting the leak window so they can review their audit logs for anomalous service-role traffic.
  3. Audit `lykn_security_audit` for the leak window — look for unexpected admin reads of user data.

### 2. `STRIPE_SECRET_KEY` — **Catastrophic (financial)**

- **Where to rotate:** Stripe Dashboard → **Developers → API keys** → "Roll" the secret key.
- **What breaks:** Stripe API calls (Checkout session creation, subscription queries) fail with `invalid_api_key` between rotation and Render redeploy. Stripe lets the old key live for ~12h after rotation by default unless you explicitly revoke — pick "expire in 1h" for incident rotation, "expire in 12h" for routine rotation.
- **Token invalidation:** Customer/subscription IDs are unaffected (those are public-by-design Stripe object IDs). Existing Checkout sessions in the user's browser tab continue to work because they reference Stripe-side state.
- **If leaked:** Rotate, then check Stripe **Developers → Logs** for unexpected calls in the leak window. Refund any unauthorized charges in the same window.

### 3. `STRIPE_WEBHOOK_SECRET` — **High**

- **Where to rotate:** Stripe Dashboard → **Developers → Webhooks** → endpoint → **Signing secret → Roll**.
- **What breaks:** Webhook signature verification fails (returns 400) until the new value is in Render. Stripe retries failed webhooks for 3 days, so a brief mismatch is recoverable, but order/subscription state in `lykn_user_billing` may be temporarily stale.
- **Token invalidation:** N/A.
- **If leaked:** An attacker with this can forge `customer.subscription.updated` events. Rotate immediately; replay any legitimately-missed events from the Stripe Dashboard.

### 4. `BACKFILL_SECRET` — **Medium**

- **Where to rotate:** Render env var only (no upstream provider).
- **What breaks:** Manual synthesis-backfill curl commands using the old value get a 401. Cron jobs (if any) need updating in their scheduler.
- **Required length:** ≥32 chars (production). The in-code per-call floor is 8 chars for backwards compatibility — rotate every prod deployment to ≥32 chars before raising the in-code floor in a follow-up PR.
- **If leaked:** An attacker can re-run synthesis on any user — increases cost (LLM calls) and could be used for resource exhaustion. Rotate, then audit `lykn_synthesis_runs` for unexpected runs in the leak window.

### 5. `DISCOVER_INGEST_SECRET` — **Medium**

- **Where to rotate:** Render env var only.
- **What breaks:** Discovery-ingest cron 401s until updated. If `ADMIN_INGEST_SECRET` is unset, this also gates `/api/feeds/poll-due` and `/api/connections/poll-due` (legacy fallback).
- **Required length:** ≥32 chars (production).
- **If leaked:** Attacker can spam ingest jobs (cost amplifier). Rotate, audit `lykn_discover_runs`.

### 6. `ADMIN_INGEST_SECRET` — **Medium**

- **Where to rotate:** Render env var only.
- **What breaks:** `/api/feeds/poll-due` and `/api/connections/poll-due` 401 until updated. Background poll jobs miss their tick.
- **Required length:** ≥32 chars (production).
- **If leaked:** Can be used to force-poll any user's feeds/connectors at attacker-chosen cadence (cost amplifier; potential side-channel for inferring user activity timing). Rotate, audit `lykn_feed_polls` for anomalous tick rates.

### 7. `CONNECTOR_TOKEN_KEY` — **High (and rotation is non-trivial)**

- **What it does:** AES-256-GCM key that encrypts every stored connector OAuth token in `lykn_connections`. Compromise == every user's connected-service tokens are decryptable.
- **Format:** Exactly 64 hex chars (32 raw bytes). Generate with `openssl rand -hex 32`.

- **Naive rotation (DESTRUCTIVE):**
  - Rotate the env var → every existing encrypted token becomes undecryptable → every user must reconnect every connector.
  - Use this path only if the key is **confirmed compromised**.

- **Safe rotation (re-encrypt-in-place):**
  1. Add a new env var `CONNECTOR_TOKEN_KEY_NEXT` alongside the old one.
  2. Deploy a one-shot migration script that, for each row in `lykn_connections`: decrypts with the old key, re-encrypts with the new key, writes both ciphertexts. (Not yet implemented; track as Agent 06 follow-up.)
  3. Once the migration completes, swap `CONNECTOR_TOKEN_KEY` → new key, delete `CONNECTOR_TOKEN_KEY_NEXT` and the old-cipher column.
  4. Restart Render.

- **If leaked:** Treat as full compromise of every user's third-party connections.
  1. Rotate the key (destructive path).
  2. Force every user to reconnect (truncate `lykn_connections` or set every row's `is_active = false`).
  3. Tell users their integrations were reset and to revoke + reissue any sensitive tokens at the upstream provider as well.
  4. Open audit ticket — every connector's data accessed during the leak window is potentially compromised at the upstream provider too.

### 8. AI provider keys — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` (Gemini), `XAI_API_KEY` — **High (financial)**

- **Where to rotate:**
  - OpenAI: https://platform.openai.com/api-keys → revoke old → create new
  - Anthropic: https://console.anthropic.com/settings/keys
  - Gemini: https://aistudio.google.com/apikey
  - xAI: https://console.x.ai/

- **What breaks:** Calls to the provider 401 until Render env var is updated. The chat agent loop falls back to other providers if `getProviderForModel()` chooses a different one for the current model — but a model pinned to the rotated provider returns `provider_unavailable` until rotation completes.

- **If leaked:** Rotate, then check the provider's **Usage** page for the leak window — anomalous spikes indicate active abuse. Some providers (OpenAI, Anthropic) bill on the leaked key until revoked, so revocation speed = $$ saved.

### 9. Other server keys — `YOUTUBE_API_KEY`, `RESEND_API_KEY`, `SERPER_API_KEY`, `LASTFM_API_KEY`, `META_APP_TOKEN`, `WHISPER_HOSTED_API_KEY`, `TRELLO_API_KEY`, `GOOGLE_CSE_ID` — **Medium**

- All single-secret integrations. Standard flow: rotate at the provider's developer console, update Render env var, redeploy.
- For YouTube and Google CSE: rotate at https://console.cloud.google.com → APIs & Services → Credentials.
- For Resend: https://resend.com → API Keys.
- For Trello: https://trello.com/app-key (note: Trello's "API key" is actually shared per app and is treated more like a public client_id — but rotate it anyway if leaked).

### 10. Connector OAuth `*_CLIENT_SECRET` × 17 providers — **Medium per-connector**

- **Where to rotate:** Each provider's developer console (see `.env.example` for direct links per connector).
- **What breaks:**
  - Existing user connections continue to work — refresh tokens were issued under the old client and remain valid until the upstream provider revokes them. Most providers tolerate client-secret rotation as long as the `client_id` stays stable.
  - **New** OAuth flows (a user connecting that provider for the first time, or reconnecting) will use the new secret as soon as Render's env vars are updated.
- **Special cases:**
  - **GitHub** invalidates all access tokens issued under a rotated client secret — every user must reconnect GitHub. Coordinate with users before rotating.
  - **Notion** allows graceful rotation; old tokens keep working.
  - **Google** (covers YouTube/Drive/Calendar/Gmail): rotating the secret does not invalidate user tokens but **does** require updating the redirect URIs to match if you regenerate the OAuth client. Plan: rotate secret only, not the whole client.
- **If leaked:** Rotate. The `client_id` is public — only the `client_secret` is sensitive — so an attacker with both can complete the OAuth flow on behalf of users they redirect.

### 11. Browser-safe values (`VITE_*`) — informational

These are **bundled into the browser by design**:

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — RLS-gated; the anon key has **no privileges** beyond what RLS grants. "Rotation" means rotating Supabase's anon-key signing key, which invalidates all existing sessions — only do this if a confirmed compromise of the anon key is in progress.
- `VITE_STRIPE_PUBLISHABLE_KEY` — public by design.
- `VITE_ADMIN_EMAILS` — Agent 05 INFO finding: admin email addresses are exposed in the JS bundle. This is information disclosure, not privilege escalation (server-side `requireAdmin` is the actual gate). Product owner decision pending on whether to move admin gating server-side via `/api/account/me`.

---

## Routine rotation cadence

When nothing has leaked but you want a healthy rotation rhythm:

| Secret class | Cadence |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Annually, or on team-member departure with prod access |
| AI provider keys | Quarterly |
| `STRIPE_SECRET_KEY` | Annually |
| `STRIPE_WEBHOOK_SECRET` | Annually (or on webhook endpoint URL change) |
| `BACKFILL_SECRET`, `DISCOVER_INGEST_SECRET`, `ADMIN_INGEST_SECRET` | Annually |
| `CONNECTOR_TOKEN_KEY` | Every 2 years (re-encrypt-in-place; never the destructive path on a routine cadence) |
| Connector `*_CLIENT_SECRET` | Annually per-connector, staggered |
| Misc API keys (YouTube, Serper, Resend, etc.) | Annually |
| `VITE_*` public values | Only on actual rotation events at the upstream service |

Note: schedule rotations during low-traffic windows. Render's auto-redeploy takes ~30–90s during which API calls 5xx.

---

## Incident response — suspected secret leak

When a secret is suspected leaked (e.g. accidentally pushed in a git commit, posted in a public channel, exfiltrated via dependency CVE):

1. **Rotate first, ask questions later.** Do not wait for confirmation. The cost of an unnecessary rotation is one redeploy; the cost of waiting on a real leak is open-ended.

2. **Update Render** → manual deploy → watch boot logs for `[secrets] Validated N/M required secrets — boot OK`.

3. **Provider-specific containment:**
   - `SUPABASE_SERVICE_ROLE_KEY` → contact Supabase support.
   - AI provider keys → revoke old key in provider dashboard; review usage logs for anomalies in the leak window.
   - `STRIPE_*` → review Stripe **Developers → Logs** for unexpected calls. Audit `lykn_user_billing` for state mismatches.
   - `CONNECTOR_TOKEN_KEY` → all stored connector tokens must be assumed compromised. Force every user to reconnect (set `is_active = false` on every row of `lykn_connections`). Coordinate user comms — this is a noticeable disruption.
   - Connector `*_CLIENT_SECRET` → rotate at the provider; for GitHub, accept that all user tokens will be invalidated.

4. **Search git history for the leaked value (do this even if you "know" the leak source):**
   ```bash
   git log -p --all -S "<leaked-value>" | head -200
   gitleaks detect --source . --redact   # if gitleaks installed
   ```
   - If the leaked value appears in any commit (current or historical), the value is **permanently** in history regardless of subsequent fix commits.
   - **Do not** push a "remove the secret" commit and assume you're done. The secret persists in `git log` forever.
   - Plan a history rewrite (BFG Repo-Cleaner or `git filter-repo`) — destructive operation requiring force-push and coordination with every collaborator. Record the decision in an incident ticket.

5. **Audit blast radius:**
   - For server-side secrets: query `lykn_security_audit` for the leak window — look for anomalous admin actions.
   - For provider keys: review the provider's usage/audit logs for the same window.

6. **Postmortem:**
   - How did the secret leak?
   - Did the pre-commit hook miss it? If yes, update `.gitleaks.toml` with the missing rule.
   - Did `validateSecrets()` give the wrong signal? If yes, update `SECRET_RULES`.
   - File the postmortem in the incident-response repo, not in this runbook.

---

## Pre-commit hook reminder

Every developer workstation should have:

```bash
brew install gitleaks
chmod +x .git/hooks/pre-commit  # already executable in repo, may need re-applying after fresh clone
```

The hook silently no-ops if gitleaks isn't installed (intentional — onboarding friction tradeoff). The CI scan in Agent 06's purview is the authoritative gate; the local hook is the fast feedback loop. Bypass with `git commit --no-verify` (document the reason in the commit message) or `LYKN_SKIP_GITLEAKS=1` (for scripted commits).

---

*Last updated: Agent 05 — Secrets & Supply Chain Security audit.*
