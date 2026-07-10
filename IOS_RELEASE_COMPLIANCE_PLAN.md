# iOS Unlisted-Release Compliance — Implementation Plan

Backend work required before the LYKN iOS app can be submitted for unlisted
App Store distribution. Companion to the iOS-side fixes already on
`LYKN-Mobile/LYKN-iOS` main (`48e4729`, `7644ae5`: privacy manifests,
encryption flag, fail-closed deletion, corrected delete contract).

## Why

Verified against the live Supabase project (`yxntfqgbkxjiyesewyoz`) on
2026-07-09:

- **No FK in the database referenced `auth.users`** — `DELETE /api/account`
  claimed cascade behavior it didn't have. Deleting an account removed the
  auth identity + storage files but orphaned every row of user content
  (App Review Guideline 5.1.1(v) violation in substance).
- **No Sign in with Apple revocation** — Apple requires revoking the SIWA
  token during account deletion; also, without it a re-signup returns nil
  email/name to the app.
- **`POST /api/metrics/ingest` didn't exist** — the iOS MetricKitForwarder
  has been 404ing silently.
- **AASA missing** — `lykn.io/.well-known/apple-app-site-association`
  returned the SPA's HTML, so universal links (`applinks:lykn.io`) are dead.
- **Privacy policy gaps** — no disclosure of Voice Mode audio streaming to
  OpenAI or of MetricKit crash/performance forwarding.

## Rollout order (dependencies are real — don't reorder)

### Phase 1 — Database migrations 113–115 (before any server deploy)

Apply in order via the Supabase SQL editor or migration tooling:

1. `supabase-migrations/113_account_deletion_cascade.sql` — purges orphaned
   rows, then adds `ON DELETE CASCADE` FKs to `auth.users` on every
   user-scoped table. **Take a database backup first**: the orphan purge is
   destructive by design. As of 2026-07-09 the main content tables have
   zero orphans (verified), so the purge should be a no-op — the backup is
   insurance. Idempotent; skips the `notes`/`sessions` compat views.
   Dry-run validated against live (BEGIN/ROLLBACK): 70 FKs created cleanly.
2. `supabase-migrations/114_apple_refresh_tokens.sql` — `lykn_apple_tokens`
   (service-role only) for SIWA revocation.
3. `supabase-migrations/115_client_metrics.sql` — `lykn_client_metrics`
   (service-role only) for MetricKit ingest.

Phase 1 must land first because the deployed server code reads
`lykn_apple_tokens` in the delete flow and inserts into
`lykn_client_metrics` on ingest; deploying the server against a database
without these tables degrades (logged warnings / 500s on ingest) but is
pointless. The FKs in 113 are also what makes the existing delete endpoint
honest — until they exist, deletion keeps orphaning content.

### Phase 2 — Render environment variables

Set on the `lykinsai-web` service before (or with) the server deploy:

| Var | Value |
| --- | --- |
| `APPLE_TEAM_ID` | `B45S92XC36` |
| `APPLE_KEY_ID` | Key ID of the SIWA key (create under Certificates → Keys if none exists) |
| `APPLE_PRIVATE_KEY` | Contents of the downloaded `.p8` (newlines may be `\n`-escaped) |
| `APPLE_CLIENT_ID` | `io.lykn.app` (optional — this is the default) |

All helpers no-op gracefully when unset, so a deploy without these doesn't
break deletion — it just skips revocation. Don't ship the App Store build
until they're set.

### Phase 3 — Deploy the backend (Render)

Merging this branch to main deploys, bringing:

- `DELETE /api/account`: revokes the stored Apple token (best-effort)
  before `auth.admin.deleteUser`, which now genuinely cascades via the 113
  FKs. Storage purge and Stripe cleanup unchanged.
- `POST /api/auth/apple/token-exchange`: exchanges the native sign-in
  authorizationCode within Apple's ~10-minute window, stores the refresh
  token for later revocation.
- `POST /api/metrics/ingest`: lands MetricKit payloads (1 MB JSON cap via
  the global parser).

### Phase 4 — Deploy the frontend (Vercel)

Same merge deploys the SPA, bringing:

- `public/.well-known/apple-app-site-association` served with
  `Content-Type: application/json` (vercel.json header rule; static files
  win over the SPA rewrite). Verify post-deploy:
  `curl -sI https://lykn.io/.well-known/apple-app-site-association` →
  expect `200` + `application/json`, no redirect.
- Privacy page: Voice Mode → OpenAI audio disclosure; MetricKit
  crash/performance disclosure.

### Phase 5 — iOS follow-up (separate session, already spawned)

`AppleSignIn.swift` must POST the sign-in `authorizationCode` to
`/api/auth/apple/token-exchange` after session establishment (fire-and-
forget). Until that ships, no refresh token is stored and revocation is
skipped for those sign-ins. Existing signed-in users never provided a code;
their tokens revoke on next sign-in-after-reinstall at the earliest.

### Phase 6 — End-to-end verification (before App Store submission)

1. Sign in with Apple on a test account → confirm a row lands in
   `lykn_apple_tokens`.
2. Delete the account in-app → confirm: `auth.users` row gone; zero rows
   remain for that user_id in `vault_items`, `lykn_chats`,
   `lykn_user_preferences` (spot-check); `user-files/{uid}/` empty; the
   LYKN entry disappears from iOS Settings → Apple Account → Sign-In &
   Security → Sign in with Apple.
3. Launch the app a day later / trigger MetricKit → confirm rows in
   `lykn_client_metrics`.
4. Tap a `https://lykn.io/i/<id>` link on-device → app opens (universal
   link), not Safari. AASA changes can take time to propagate via Apple's
   CDN — retest after a few hours if it fails immediately post-deploy.
5. Re-run the iOS pre-submission checklist
   (`LYKN-iOS/AppStore/pre-submission-checklist.md`).

## Rollback

- Server/front-end: revert the merge; endpoints disappear, delete flow
  returns to prior behavior.
- Migration 113 is not auto-reversible (purged orphans are gone — though
  none existed at verification time). Dropping the FKs restores the old
  non-cascading behavior if a cascade ever misfires:
  `ALTER TABLE <t> DROP CONSTRAINT <t>_user_id_auth_users_fkey;`
- 114/115 are plain `CREATE TABLE IF NOT EXISTS` — drop to revert.
