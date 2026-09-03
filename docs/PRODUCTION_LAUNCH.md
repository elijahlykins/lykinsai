# LYKN Production Launch

This is the canonical operator runbook for the web app, API, and Mac and Windows desktop releases.
Do not use `PRODUCTION_RUNBOOK.md` for connected-app callbacks because that document describes the retired provider-specific OAuth path.

## Current production topology

- Vercel serves `https://lykn.io`.
- Render serves `https://api.lykn.io`.
- The same Render service serves locked-down artifact links on `https://artifacts.lykn.io`.
- Supabase owns Postgres, Auth, and the private `user-files` bucket.
- Stripe owns subscriptions, portal sessions, invoices, and Usage Balance funding events.
- Composio owns managed connected-app authorization.
- GitHub Releases in `elijahlykins/lykn-releases` distributes signed desktop installers and update metadata.

## Release rule

Vercel, Render, and Electron must be built from one tested commit.
Do not launch from a dirty worktree.
Record the commit SHA in the launch ticket before deployment.

Run:

```bash
npm ci
npm run production:check
npm run test:architecture
npm run test:server
npm run test:security
npm run test:mcp
npm run test:agent
npm run test:electron
npm run test:vault
npm run test:chat
npm run test:memory
npm run lint
npm run build
```

## 1. Supabase

### Backup

Open the production Supabase project.
Confirm that a current backup exists and that the account can restore it.
Record the backup timestamp in the launch ticket.
Do not apply a production migration without this evidence.

### Migrations

Inspect production migration history before applying SQL.
The recent launch chain must be applied in this order:

1. `supabase-migrations/131_usage_balance.sql`
2. `supabase-migrations/132_user_files_storage_policies.sql`
3. `supabase-migrations/133_model_platform.sql`
4. `supabase-migrations/134_usage_pricing_profiles.sql`
5. `supabase-migrations/135_usage_internal_rls.sql`

Each file is intended to be re-runnable, but migration history must still be checked because this repository contains duplicate numbers for 114 and 116.
Run `scripts/verify-usage-balance.sql` with a controlled test user after the SQL is applied.
Then run:

```bash
node --env-file=.env scripts/anon-permission-probe.mjs --strict
```

The `user-files` bucket must be private.
Its object policies must limit paths to the authenticated user's UUID prefix.
Migration 135 must leave internal usage lots, reservations, ledger rows, usage events, and legacy raw-cost telemetry inaccessible to user JWTs.

### Auth

In Supabase Authentication URL Configuration, set the production site URL to `https://lykn.io`.
Allow only the production paths actually used by login, password reset, and desktop handoff.
Keep localhost entries only when they are intentionally needed for development.

Enable the intended email methods and Google provider.
Google's Supabase callback is `https://<auth-host>/auth/v1/callback`.
If `auth.lykn.io` is configured as a Supabase custom domain, follow `docs/google-signin-branding.md` and keep the original project callback until production cutover testing passes.

Never expose `SUPABASE_SERVICE_ROLE_KEY` to Vercel or a desktop client.

## 2. Render

Use the existing `lykinsai-web` service and the two cron services declared in `render.yaml`.
The web service must run `npm start`, not the development file watcher.

Set the production environment from `.env.example`.
At minimum, Render needs:

- `NODE_ENV=production`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APP_URL=https://lykn.io`
- `PUBLIC_API_BASE_URL=https://api.lykn.io`
- `ALLOWED_ORIGINS=https://lykn.io,https://www.lykn.io`
- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`
- Active `STRIPE_PRICE_*` IDs
- `BACKFILL_SECRET`
- `ADMIN_INGEST_SECRET`
- `CONNECTOR_TOKEN_KEY`
- `ADMIN_EMAILS`
- `VOICE_SESSION_SECRET`
- `OPENROUTER_API_KEY`

Generate independent random values for each signing or bearer secret.
`CONNECTOR_TOKEN_KEY` must be exactly 64 hexadecimal characters.
Do not reuse the Supabase service-role key as another secret.

Set `CUSTOMER_USAGE_MARKUP_PERCENT` deliberately.
Leaving it unset currently preserves the 1.6x historical default.

The cron services need the Supabase values required by their jobs.
Night Shift also needs the configured model provider key.
The vault reconciler must remain non-destructive unless both the explicit delete option and its second secret gate are intentionally enabled.

After deployment, require:

```bash
npm run production:check:live
```

The API health payload must report `status=ok`, `database=ok`, and `secrets=ok`.
The artifact host health route must return 404 because non-artifact routes are intentionally blocked there.

## 3. Stripe live mode

Create or verify recurring monthly and annual Prices for Student, Pro, and Max.
The plan mapping and expected customer prices are owned by `lib/billing/planCatalog.js`.
Copy live `price_...` IDs to the matching Render variables.
Do not use the legacy $25 Pro Price for new checkout.

Create a live webhook endpoint:

```text
https://api.lykn.io/api/stripe/webhook
```

Subscribe it to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Store the endpoint's live signing secret as `STRIPE_WEBHOOK_SECRET`.
Choose one `STRIPE_TRIAL_DAYS` value and verify checkout displays it.

Dry-run migrations before executing them:

```bash
npm run billing:migrate-credits
npm run billing:migrate-pro-20 -- --dry-run
```

After reviewing counts and Stripe schedules, execute only the intended migration.
Test checkout, return URL, billing portal, cancellation, failed payment, webhook replay, invoice funding, and metered usage with a controlled live account.

## 4. Vercel and DNS

The Vercel production environment receives only public browser configuration:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_API_BASE_URL=https://api.lykn.io`
- `VITE_FRONTEND_BASE_URL=https://lykn.io`
- `VITE_STRIPE_PUBLISHABLE_KEY` when used directly by the frontend

Do not place service-role keys, provider keys, Stripe secrets, connector keys, or signing keys in a `VITE_*` variable.

Verify `lykn.io` and `www.lykn.io` have valid TLS and resolve to Vercel.
Verify `api.lykn.io` resolves through the intended Cloudflare policy to Render.
Verify `artifacts.lykn.io` resolves to the same Render service.
Set `ARTIFACTS_BASE_URL` only after artifact DNS and TLS work.

Enable and verify Cloudflare WAF and rate-limit rules for the API.
Repository configuration cannot prove dashboard-side Cloudflare rules exist.

## 5. Connected apps and email

Set `COMPOSIO_API_KEY` only on Render.
In Composio, configure the identity verifier:

```text
https://api.lykn.io/oauth/connections/verify
```

The live managed callback is:

```text
https://api.lykn.io/oauth/connections/callback
```

Do not configure the retired `/oauth/callback/<provider>` routes described by the old connector runbook.
Start with Gmail and test connect, list or search, disconnect, token revocation, and reconnect with a non-admin account.

If transactional email is enabled, verify the LYKN sending domain in Resend.
Set the approved From addresses and test both ordinary and security email paths.

## 6. Deploy web production

Deploy Render before Vercel.
This order is required because the new frontend expects model billing-state APIs and Usage Balance fields from the new backend.

After both deployments, test:

- Signup, email login, Google login, logout, and password reset
- Chat streaming, Auto routing, manual model selection, and insufficient-balance handling
- Private file upload, signed download, and artifact sharing
- Student, Pro, and Max checkout and billing portal
- Usage funding, reservations, settlement, and recent usage display
- Gmail managed connection
- Admin denial for ordinary users and admin access for allowlisted users
- CORS denial from an untrusted origin
- Desktop authentication handoff

Configure GitHub Actions secrets `PROBE_SUPABASE_URL` and `PROBE_SUPABASE_ANON_KEY`.
The anonymous-permission job must run and pass rather than skip.

## 7. Desktop release

Desktop production defaults are `https://lykn.io` and `https://api.lykn.io`.
Do not override them in a public release.

For macOS, configure a Developer ID Application identity and one notarization method supported by `electron/notarize.cjs`.
The preferred method uses `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
Do not publish if the notarization hook reports that it skipped.

For Windows, use a trusted code-signing certificate.
An unsigned installer is not production-ready because SmartScreen will materially damage install trust.

Build and test:

```bash
npm run prepack:desktop
npm run test:electron
npm run electron:build
npm run electron:build:win
```

Install both artifacts on clean machines.
Test Gatekeeper or SmartScreen, login, overlay permissions, local file tools, browser agent, bundled extension installation, and quit and restart behavior.

Publish with:

```bash
npm run electron:release
npm run electron:release:win
```

Before broad release, install version N, publish N+1, and verify the in-app updater downloads and installs the new signed version from GitHub Releases.

## 8. Monitoring, rollback, and launch

Assign a human owner for API health, Render deploy failures, cron failures, Stripe webhook failures, provider failures, and security events.
Connect Render logs to an alerting destination.
Implement the thresholds in `INCIDENT_RUNBOOK.md`.

Document and test:

- Supabase restore
- Render rollback
- Vercel rollback
- Stripe webhook replay
- Secret rotation
- Desktop release withdrawal and replacement

Block launch when any of these conditions is true:

- The release worktree is dirty or web and desktop use different commits.
- A required migration or backup is unverified.
- The anonymous-permission probe fails or skips.
- API health is degraded.
- Billing has not passed a controlled live transaction.
- Desktop artifacts are unsigned or macOS notarization was skipped.
- No owner receives production alerts.

Launch to the internal team first.
Expand to a small external cohort after one stable observation window.
Open broad availability only after the rollback paths and alerts have been exercised.
