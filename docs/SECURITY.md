# LYKN Security Architecture

This is the living description of how LYKN handles identity, data, and access.
It is derived from the implementation, not from marketing copy.
Historical audit notes live in `MASTER_SECURITY_REPORT.md` and `SECURITY_REPORT_01.md` through `SECURITY_REPORT_06.md`.
Those reports are snapshots from May 2026.
This document is the current architecture.

Do not paste secret values into this file.

## Trust boundaries

```
User
  -> LYKN web UI (Vercel) or LYKN desktop (Electron)
       -> local machine (files, screen, mic, owned browser, Local Mode tools)
       -> LYKN API (Render, Express in server.js)
            -> Supabase (Auth, Postgres, Storage)
            -> model providers (OpenAI, Anthropic, Google, xAI, Together, ElevenLabs)
            -> search (Serper)
            -> Stripe
            -> connected apps (OAuth / MCP) at the user's request
```

The desktop main window loads the remote web app (`https://lykn.io/studio` in production).
Overlay, welcome, agent chrome, and popups are local HTML inside `electron/`.
The API is a separate Render service.

## Authentication

End-user identity is Supabase Auth.
Web sign-in is email (OTP signup plus password) or Google OAuth.
Apple Sign In is used on native paths.
LYKN does not implement its own Google OAuth callback.
`requireAuth` in `server.js` requires `Authorization: Bearer <jwt>` and verifies it by calling Supabase `GET /auth/v1/user`.
That is server-side validation, not UI-only hiding.

Sessions persist in the browser via the Supabase JS client (`localStorage`), not HttpOnly cookies.
On the desktop app, that same session is also stored on this machine so LYKN stays signed in after a restart.
The file is `desktop-session` in Electron userData, encrypted with the OS keychain via `safeStorage`.
Sign out deletes that file.
`src/lib/installAuthFetch.ts` attaches the Bearer token to `/api/*` requests.
Sign out of all devices uses `supabase.auth.signOut({ scope: 'global' })`.

Production refuses unauthenticated API calls when Supabase env is missing.
Local development can skip `requireAuth` if those env vars are unset.

Admin API routes (`/api/admin/*`) require `requireAuth` plus `requireAdmin`.
The real allowlist is server `ADMIN_EMAILS`.
Client `VITE_ADMIN_EMAILS` only hides UI and ships in the frontend bundle.

## Authorization and database isolation

Authenticated API routes typically use `supabaseAdmin` (service role), which bypasses Row Level Security.
Isolation for those routes is application-layer ownership filtering.

The reusable pattern is `lib/security/userOwnedAccess.js`.
Helpers such as `getUserRowById(client, table, userId, id)` require both the resource id and the authenticated user id.
A caller cannot fetch another user's row by forgetting one `.eq('user_id', ...)`.
`userOwnedTable` is the builder used for lists, inserts, and extra predicates (version CAS, chat_id, status).
Updates drop any `user_id` field from the patch so a caller cannot reassign ownership.

Live route families that use this helper (or `assertUserPath` for storage keys):

- Chat: `GET /api/desktop/chats`, `POST /api/desktop/chats/save`, `POST /api/ai/name-chat` in `server/routes/desktop.routes.js`
- Memory: `server/memory/memoryStore.js` (there is no object-id Memory HTTP API; Chat tools go through this store)
- Vault: `POST /api/vault/enrich-note`, `POST /api/synthesis/reindex` (vault_note source ids), description backfill, `server/ai/vaultEnrichment.js`, `persistLiveFetchedBody` in `server/ai/chatRetrieval.js`
- Files: `POST /api/storage/signed-url`, `POST /api/storage/file-proxy-url` (`assertUserPath`), Vault save-image/save-file inserts via `userOwnedTable`
- Feeds: `PATCH /api/feeds/:id`, `DELETE /api/feeds/:id`, `POST /api/feeds/:id/refresh`
- Projects: `POST /api/projects/invite` (owner lookup). Collaborators are members, not owners; invite still requires the authenticated user to own the project. MCP `lykn_updateProject` / `lykn_deleteProject` use the same helpers.
- Steward: `PATCH /api/steward/items/:id`

HTTP User A / User B ID-substitution coverage lives in `tests/server/crossUserAccess.test.mjs`.
Those tests register the production route functions with a filter-faithful fake database.
They fail if a handler looks up by resource id without the owner filter.

Memory already follows this shape in `server/memory/memoryStore.js`.
Signed URL minting uses `assertUserPath` so a path cannot leave `{userId}/...`.

Some paths create a user-JWT PostgREST client so RLS applies (`createSynthesisUserClient` in `server/ai/chatRetrieval.js`).

RLS is enabled on application tables in `supabase-migrations/`.
Typical user tables use `auth.uid() = user_id`.
A set of tables are RLS-on with zero policies, so only the service role can read or write them (OAuth codes, security audit, Stripe events, credentials, Apple tokens, and similar).

Do not claim every query is enforced by RLS.
Service-role routes are not.
New user-data routes should use `userOwnedAccess` (or an equivalent owner-required helper) rather than a bare id lookup.

## What is stored in LYKN cloud

Account email, auth user id, and sign-in method live in Supabase Auth.

LYKN content in Postgres includes Markdown Memory, Vault items, chats, project state, preferences, usage and billing metadata, OAuth client metadata, and encrypted connector credentials.

File objects (vault uploads, generated images, artifacts) live in Supabase Storage bucket `user-files`.
Object keys use `{userId}/...`.
Authenticated Storage policies are versioned in `supabase-migrations/132_user_files_storage_policies.sql`.
Those policies allow an authenticated user to CRUD only objects whose name starts with `{auth.uid()}/`.
The bucket is private.
Service role still bypasses Storage RLS for server-side signed URLs and account-deletion purge.
Applying migration 132 to production is an operational step; this repo cannot prove the live project has already been migrated.
Review any leftover dashboard-only Storage policies after apply.

Screen stills, snips, page text, and audio are captured on the desktop when a feature needs them.
They are sent to the API and then to the model or speech provider for that request.
Idle Glass does not stream desktop video.

## What stays on the machine

Local Mode settings and the synced-folder list live in the desktop application support folder (`local-mode.json`), not on LYKN servers.
Wallpaper copies and mirrored desktop icons used by Home stay local unless the user asks about them.
Uninstalling the app does not delete the cloud account.

Local Mode is off until the user turns it on (`electron/localSystem.cjs`).
Enabling it does not grant the whole home folder.
Access is limited to approved roots: folders the user picked, or the home directory if they explicitly turn on "Share my whole home folder".
Legacy configs that were already enabled before this allowlist keep whole-home access.
Reads, writes, and many commands inside an approved root run without a per-action prompt once Local Mode is on.
Operations outside approved roots fail closed with a structured error.
Consequential commands (delete-like, download, clone) and some file pulls require an approval token minted in the main process.
The renderer cannot pass `approved: true`.
Tokens are bound to the exact tool and normalized args, single-use, and expire after two minutes.

Shell commands use `/bin/zsh -lc`.
The working directory must be inside an approved root.
Obvious absolute, `~`, and `..` path tokens in the command string are resolved and rejected if they leave approved roots.
This is not an OS sandbox.
A process can still construct paths at runtime (for example in Python or Node) or follow mechanisms these token checks do not see.
Package managers and Git still work inside an approved project folder.

## When information leaves the machine

Chat prompts, attachments, tool results, Glass screen/audio captures, and browse snapshots needed to plan the next step are sent to the LYKN API, then to the selected model provider.

Web search queries go to Serper.
Agent browsing runs in an Electron-owned browser on the Mac.
Page text and screenshots used for planning go to the API and the model.

Connected accounts receive data only while connected, for the action or sync the user requested.
Disconnect removes stored tokens (`lib/mcp/oauth/revoke.js` plus local credential delete).

Custom model building can send selected Vault notes to Together AI.
That path is user-initiated.

## AI providers

Active inference keys are provider env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `TOGETHER_API_KEY`, `ELEVENLABS_API_KEY`).
Default LYKN chat routes to an OpenAI model alias (`server/ai/modelInvoke.js`).
Users on paid plans can pick Claude, Gemini, or Grok.

This repo does not configure provider-side "do not train" flags on every call.
LYKN does not send other customers' data into a shared training set in the serving path.
A `training_opt_out` preference exists and is honored by training-export helpers and custom-model knowledge fetch.
Do not claim providers cannot retain request data.
That is governed by each provider's terms.

## Agents and tools

Chat tools must be on the `CHAT_TOOL_NAMES` allowlist (`mcp-tools/chatTools.js`) and pass per-turn capability gates.

Desktop bots use `electron/bot-harness`.
`local_computer` is omitted unless Local Mode is on.
`browser` drives the owned browser.
Headless bots do not get the browser unless explicitly enabled.

The owned browser can open public `http(s)` sites.
It is not a host allowlist.
Consequential browse acts use in-loop approvals.
Password-like fields are redacted in snapshots.

IPC: main Studio, overlay, and agent chrome use `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
Installed-app host windows set `sandbox: false` while keeping context isolation.
There is no global IPC channel allowlist.
High-risk handlers require a trusted LYKN sender (Studio origin, `lykn:` scheme, or a `file:` HTML page inside the app's `electron/` directory from `app.getAppPath()`, not a `/electron/` substring anywhere on disk):
`lykn:local-tool-run`, `lykn:local-mode-set`, `lykn:mac-sync-set` / `folder` / `pick-folder`, `lykn:store-run`, `lykn:open-url`, `lykn:mac-fs-list` / `open`, `lykn:files-*` (list, mkdir, rename, move, copy, trash, watch), `lykn:save-to-downloads`, `lykn:save-file-as`, `lykn:mac-app-launch` / `quit`.
Other handlers still trust any renderer that can invoke them.
External URLs go through `openExternalSafe` (`http`, `https`, `mailto`, `tel`).

Loopback servers: extension bridge `127.0.0.1:38471` (token-gated) and desktop auth `127.0.0.1:38472`.

## Secrets and credentials

Connector and calendar tokens are encrypted with AES-256-GCM using `CONNECTOR_TOKEN_KEY` (`lib/security/credentialStore.js`).
`validateSecrets.js` fail-closes in production if required secrets are missing or too short.
Stripe webhook uses `express.raw` before JSON parsing and `stripe.webhooks.constructEvent`.
Do not log tokens, card data, or raw webhook payloads (`security-logger.js`).

## Payments

Stripe holds card numbers.
LYKN stores Stripe customer and subscription ids on `user_billing`.
Credit and usage ledgers are server-side.
Webhook funding ignores client-supplied amounts and reads Stripe's `amount_total`.

## Logging, analytics, telemetry

`security-logger.js` writes operational security events to Render logs and `lykn_security_audit` (service-role only, append-oriented).
Those events are not chat bodies.

The public website can use Google Analytics 4 when the visitor accepts analytics cookies.
The Mac app does not report to that analytics path.

iOS MetricKit diagnostics can be associated with an account.
They are not vault or message content.

## Deletion and export

`DELETE /api/account` requires `{ confirm: "DELETE" }`.
It cancels Stripe (best-effort), purges `user-files/{userId}/`, revokes a stored Apple refresh token (best-effort), then `auth.admin.deleteUser`.
Postgres rows that reference `auth.users` with `ON DELETE CASCADE` go with the auth user (`113_account_deletion_cascade.sql` and later migrations).

Settings → Account exposes Delete Account with a typed `DELETE` confirmation.
The UI calls the existing API. It does not invent a second deletion path.
Privacy, Support, and `/settings` open Studio on the Account pane (`/studio?settings=account`).
The top-level `/settings` route redirects there rather than to a bare Studio home.
`/settings?section=connections` (and other known panes / hashes) is preserved instead of being rewritten to Account.

There is no first-party LYKN content export API in this repo.
Settings can import ChatGPT or Claude zip exports.
It does not export LYKN data as JSON.
Data-copy requests go to privacy@lykn.io.

Provider copies, Stripe records, and any backups outside this codebase are not deleted by that handler.
Do not describe deletion as instantaneous everywhere.

`chat_retention_days` can be stored on preferences.
A nightly purge of old chats is described in tool copy.
Do not claim it is always on.

## Encryption claims that are true

TLS for HTTPS to the API and to providers.
AES-256-GCM at rest for connector-style secrets LYKN encrypts itself.
Supabase and other hosts apply their own disk encryption.
That is not application-layer encryption of chat or Vault rows.

## Known limitations (do not oversell)

- Service-role database access remains on most API routes. High-value Chat, Memory, Vault, file, feed, and project ID HTTP paths now go through `userOwnedAccess` or `assertUserPath`. Remaining inline `.eq('user_id', ...)` filters are mostly lists, jobs, billing, and MCP tools that are not object-id HTTP endpoints. A brittle regex over every `.eq('id')` is not used as a CI gate because too many legitimate privileged queries look the same. The approved pattern is: user-owned lookup requires authenticated user context in the query itself (`userOwnedAccess`), not a later `if (row.user_id !== req.user.id)` check. `lib/securityRegressions.test.mjs` requires the helper import on the migrated route files.
- Remaining service-role uses that are intentional: billing and Stripe webhooks, account deletion, admin routes, vault reconciler / synthesis backfill jobs, signed-URL minting after `assertUserPath`, and system tables with no user RLS policies.
- Storage policies exist in git as migration 132. This repo does not apply that migration to production. Do not claim live Storage RLS matches git until the migration has been run on the project.
- Local shell commands are not a macOS sandbox. Token/cwd checks catch obvious escapes, not every interpreter-constructed path.
- Agent browser can visit arbitrary https sites after cookie sync.
- `appHost` windows are not Chromium-sandboxed.
- Some IPC besides the attested Local Mode / files / app-launch / open-url set is not sender-attested.
- Provider retention and training are not fully controlled by LYKN flags in this repo.
- Cloudflare WAF in front of the API is an open infra item in the 2026 audit, not a verified current control.

## Related files

- Auth: `server.js` (`requireAuth`), `src/lib/SupabaseAuth.jsx`, `src/lib/installAuthFetch.ts`
- User-owned queries: `lib/security/userOwnedAccess.js`
- HTTP cross-user tests: `tests/server/crossUserAccess.test.mjs`
- Account lifecycle: `server/routes/account.routes.js`, `src/lib/account/deleteAccount.js`
- Settings deep link: `src/lib/settingsDeepLink.js`
- Credentials: `lib/security/credentialStore.js`
- Desktop local access: `electron/localSystem.cjs`, `electron/ipc/localMode.cjs`, `electron/ipc/localFiles.cjs`, `electron/localToolApproval.cjs`, `electron/trustedIpcSender.cjs`
- Desktop gates: `tests/electron/securityGates.test.cjs`, `electron/agentSecurityHardening.test.cjs`
- Billing: `server/routes/stripeWebhook.routes.js`, `server/routes/billing.routes.js`
- Public policy: `src/pages/Privacy.jsx`, `src/pages/DPA.jsx`, `src/pages/Security.tsx`
