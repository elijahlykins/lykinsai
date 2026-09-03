# Composio Connection Foundation (Phase 1)

Status: implemented on this branch.
Date: 2026-09-02.
Baseline audit: `docs/architecture/connections-auth-audit.md`.

Phase 1 makes Composio the managed connection/auth backend for mainstream SaaS accounts, proven end to end with Gmail.
It does not touch chat resume, the agent harness, or the existing Universal MCP stack.

## Current implementation

New modules:

- `lib/connections/composioGateway.js` — the only code that talks to Composio (SDK `@composio/core` 0.18.0 plus two v3.1 REST endpoints).
- `lib/connections/connectionService.js` — the LYKN Connection Service: provider registry, one-shot connect state, product-facing status objects.
- `lib/connections/callbackPage.js` — callback/verifier popup HTML (mirrors the MCP OAuth callback page).
- `server/routes/connectionService.routes.js` — `/api/connections/managed/*`, `/oauth/connections/callback`, `/oauth/connections/verify`.
- `src/lib/connections/managedConnectionsApi.js` and `src/components/connections/ManagedConnectionsSection.jsx` — the Settings surface.

Current Composio APIs only: `composio.create(userId)` sessions, `session.authorize(toolkit)` Connect Links, `session.toolkits()` state, `connectedAccounts.delete()`, REST `complete_auth` and `revoke`.
The retired `connectedAccounts.initiate()` managed-OAuth flow and the deprecated standalone MCP-server API are not used.

## Why Composio owns mainstream SaaS credentials

LYKN has no live first-party Gmail/Slack/Notion OAuth adapters (audit §3), and building and operating them per provider is undifferentiated risk.
With Composio-managed auth, the provider refresh/access tokens live at Composio, scoped to the LYKN user id.
LYKN stores no Gmail token anywhere: not in `lykn_credentials`, not in `lykn_mcp_connections`, not in any new table.
A leaked LYKN database therefore cannot leak Gmail grants, and disconnect deletes the account at Composio rather than orphaning a local ciphertext row.

## LYKN Connection Service boundary

```text
Settings UI / (later) chat
        |
        v
ConnectionService  (lib/connections/connectionService.js)
  listConnections(userId)
  getStatus(userId, provider)
  connect(userId, provider)          -> { url }  (Connect Link)
  completeCallback({ state })
  completeVerifiedCallback(userId, { sessionUri })
  disconnect(userId, provider)
        |
        +-- backend: composio -> composioGateway (Gmail today)
        +-- backend: mcp      -> existing Universal MCP stack (unchanged, not routed through this service yet)
```

`MANAGED_PROVIDERS` declares each provider with a `backend` field, so future providers can map to Composio or to the MCP stack without changing callers.
Product code never sees Composio SDK objects, toolkit sessions, or raw Composio errors; the gateway normalizes everything into `ManagedConnectionError` codes (`not_configured`, `provider_unavailable`, `rate_limited`, `link_creation_failed`, `not_connected`, `identity_verification_failed`, `verification_session_expired`, `unknown_provider`, `provider_requires_setup`).
`provider_requires_setup` covers toolkits Composio cannot auto-create an auth config for (e.g. Twitter/X requires every product to bring its own developer app); offering such an app requires a LYKN-owned auth config in the Composio dashboard.
Setup-required toolkits are also hidden from the connections directory: the catalog is sourced from REST `GET /toolkits` (the only shape that carries `composio_managed_auth_schemes` and `auth_schemes`), and a toolkit is offered only when it needs no auth, has a Composio-managed OAuth app, has at least one self-service auth scheme (API_KEY, BASIC, BEARER_TOKEN, DCR_OAUTH, ... - the user supplies their own credentials in the Connect Link form), or has a LYKN-owned auth config in this project (`GET /auth_configs`).
Unmanaged `OAUTH2`, `S2S_OAUTH2`, `OAUTH1`, and `SAML` are the setup-required schemes (verified live: `authorize()` fails with the auth-config error for those and succeeds for the rest).
Registering a custom auth config in the Composio dashboard (e.g. a LYKN-owned Twitter/X developer app) makes the toolkit reappear automatically after the catalog cache expires.
This is deliberately a thin seam, not a plugin framework.

## Stable user-ID strategy

The Composio `userId` is always the authenticated Supabase user id (`req.user.id` from `requireAuth`).
Every `/api/connections/managed/*` route derives it server-side; renderer-provided user identity is never accepted.
Emails, display names, device names, and conversation ids are never used as the Composio identity.

## Gmail flow

```text
authenticated user clicks Connect in Settings
  -> POST /api/connections/managed/gmail/connect
  -> service issues one-shot state (lykn_external_auth_states, purpose managed_connect:gmail, 10 min TTL)
  -> gateway session.authorize("gmail", { callbackUrl: {API}/oauth/connections/callback?state=... })
  -> { url } returned; renderer opens the Connect Link in the OAuth popup (same pattern as MCP OAuth)
  -> user completes Google consent at Composio
  -> browser returns to /oauth/connections/callback?state=...
  -> server consumes the state (one-shot, user-bound), then re-reads session.toolkits() from Composio
  -> only an ACTIVE Composio connection yields success; callback query values are hints, never state
  -> popup posts lykn:connection-auth to the trusted frontend origin and closes; Settings refreshes
```

Connection state always comes from Composio (`session.toolkits()`), so it survives app reload and API restarts with zero LYKN persistence.

## Callback / identity verification

Composio's protection against OAuth session fixation is project-level callback identity verification.
When a verifier URL is set in the Composio dashboard, Composio ignores the per-connect `callbackUrl` and redirects to the verifier with a single-use `session_uri` (10 min TTL) carrying no user or toolkit information.
LYKN implements the application side at `/oauth/connections/verify`: the page relays the `session_uri` via `postMessage` to the trusted frontend origin only, and the signed-in renderer posts it to `POST /api/connections/managed/complete`.
That route calls Composio `complete_auth` with the server-derived user id, so the connection activates only if the completing LYKN user matches the initiating one; a mismatch returns 400 and Composio marks the connection FAILED.

Manual setup that cannot be done from code: enable the verifier URL in the Composio dashboard under Settings → General → Configuration, pointing at `{PUBLIC_API_BASE_URL}/oauth/connections/verify`.
The URL must be public HTTPS, so local development needs a tunnel (for example `ngrok http 3001` with `PUBLIC_API_BASE_URL` set to the tunnel URL).
Until it is enabled, the fallback path still binds identity through the one-shot user-bound state and never trusts callback query values, which already avoids reproducing the MCP-callback gap flagged in the audit (§13.5).

## Credential security boundary

- `COMPOSIO_API_KEY` is server-only, registered warn-only in `validateSecrets.js`, never sent to the renderer, and redacted from error details by the gateway.
- Provider OAuth tokens never enter LYKN code or storage; product-facing status objects contain only `provider`, `label`, `description`, `backend`, `status`, `connected`, `connectionId`.
- `connectionId` is the Composio connected-account id — a safe identifier kept for multi-account support later.
- Structured logs record user id, provider, status, and connected-account id; they never record tokens, Connect Link URLs, session URIs, or the API key.

## Settings flow

Settings → Connections opens with a searchable "Apps" directory (`ManagedConnectionsSection`) listing every connectable app with its icon.
The directory comes from `GET /api/connections/managed/directory`, backed by `ConnectionService.searchDirectory`.
The default (no-query) view is a fast path: one popularity page (`listToolkitFirstPage`, ~1 s cold) merged with the user's live connection state (`listConnectedToolkits`, never cached), while `warmToolkitCatalog` kicks off the full catalog fetch in the background.
Searches and See-more paging use the full catalog (`listToolkitCatalog`, cached in-process for 6 hours with in-flight dedupe because a cold page-through of the ~1,500-toolkit catalog takes ~15 seconds — usually already warm by the time a user types).
Connected apps always appear, even when they fall outside the top popularity page, using display metadata carried on the connected-toolkits listing.
Auth-less toolkits are excluded; connected apps sort first, the rest keep Composio popularity order; results are filtered server-side by name or slug substring, capped at 96 per response, and the response's `hasMore` drives the UI's See more button (24 per page).
Any auth toolkit in the catalog is connectable: `resolveProvider` accepts curated LYKN providers first (product copy wins) and falls back to a validated catalog lookup, so Connect/Disconnect works for the whole directory, not just Gmail.
Card states: Connect, Connecting…, Connected (with Disconnect), Needs attention (with Reconnect), and an inline error with retry.
Completion is detected two ways: the popup's `postMessage` fast path (web), and status polling of `GET /api/connections/managed/:provider` every 2.5 seconds for up to 3 minutes.
Polling is the authoritative desktop path: the Electron main window denies `window.open` for non-app origins and reroutes the Connect Link into the LYKN in-app browser, so the OAuth window has no `window.opener` and its `postMessage` never reaches Settings.
Server-side, `completeCallback` retries a briefly-pending account (3 × 1.5 s) before reporting failure, because Composio can still show `INITIATED` at the instant the OAuth redirect lands on the callback.
Icons are the toolkit logos served from Composio's CDN, with a letter-avatar fallback when an image fails to load.
The section hides itself entirely when the server reports `unconfigured` (no `COMPOSIO_API_KEY`), so no dead tiles appear.
No separate "Composio" section exists and no Composio terminology is shown to users.
The MCP marketplace/Discover browser was removed from Settings entirely: the managed Apps directory is the discovery surface, and `McpConnectionsPanel` is now a slim connect-any-MCP-by-URL card opened from a "MCP servers" tile in the Specialized grid.

## Disconnect semantics

Disconnect does two things, in order:

1. Best-effort provider revocation via REST `POST /connected_accounts/{id}/revoke` (Google grant is revoked upstream; toolkits without revoke support return 400 and are tolerated).
2. Permanent deletion via `connectedAccounts.delete()`, which removes the account and the tokens Composio holds.

Deletion rather than disable was chosen because "Disconnect" in LYKN means the grant is gone, matching user expectations and the safest interpretation.
The connected-account id used for both calls comes from the user's own session state, so cross-user deletion is structurally impossible.

## Composio Session strategy

Sessions are created per user with `manageConnections: false` (auth is owned by LYKN UI, not in-chat meta-tools) and `sandbox: { enable: false }` (no code execution needed).
Sessions are cached in-process for 10 minutes per user+toolkit set to avoid creating a session per status poll.
Per-toolkit status checks use sessions restricted to that toolkit; the directory catalog and connected-state lookups use an unrestricted session (full catalog access, still no tool execution).

## Recommended Phase 2 execution transport

Two options for executing Gmail tools later:

- Option A — Session direct execution: `session.tools()` / `session.execute(toolSlug, args)` through the gateway.
- Option B — Session MCP endpoint: `session.mcp.url` + `session.mcp.headers` consumed by LYKN's existing Universal MCP client.

Recommendation: **Option B, the Session MCP endpoint.**

Reasons, against the evaluation criteria:

- Write approvals, permission gating, per-user isolation, Activity UI, tool observability, untrusted-result wrapping, and error normalization already exist on the MCP path (`executeMcpTool`, `classifyToolList`, approval tokens, `wrapUntrustedObservation`).
  Option A would need all of that rebuilt around a second execution lane, which is exactly the duplicate-execution-path anti-pattern OWNERSHIP.md forbids.
- Tool schema control and context cost are equivalent: both paths surface the same Composio tool schemas, and the existing per-turn capability resolver already limits what reaches the model.
- Future chat resume lands on TaskRuntime wait states that are MCP-aware today.
- Costs of Option B: one more network hop (Composio MCP endpoint) and per-user connection rows carrying a session-derived URL that must be refreshed when sessions rotate; the gateway should therefore mint/refresh `session.mcp` config on demand rather than persisting long-lived URLs.
- Vendor coupling is lower with B: the harness keeps speaking MCP, and Composio remains swappable infrastructure behind `providedThrough: 'composio'`.

Option A remains attractive only if Composio's session meta-tools (dynamic discovery, in-chat auth) become product requirements; nothing in this phase locks either choice in.

## Remaining legacy connection ambiguity

Still answering "is Gmail connected?" incorrectly or partially, deliberately untouched in this phase:

- `src/lib/connectors/catalog.js` still advertises Vault-era "Live" tiles (the MCP marketplace and its dead Gmail tile were removed from Settings).
- The browser agent can operate gmail.com with the user's cookies; that is browsing capability, not connection state, and the Connection Service never reads it.
- Chat/bot "Connect Gmail" prompts still point at Settings and do not resume.
- Legacy `social_connections` rows may still exist.

For Gmail via Composio, `ConnectionService -> Composio` is now the single canonical check; Phase 2 should route chat disclosure through it and retire the stale catalog copy.

## Phase 2 — managed tool execution (implemented)

Option B is now built.
Connecting an app makes its tools callable from chat, bot agents, and voice through one execution lane.

Transport:

- `composioGateway.getMcpEndpoint(userId, toolkit, { fresh })` mints a per-user tool session (`sessionPreset: 'direct_tools'`, `mcp: true`, no meta-tools, no sandbox) and returns `session.mcp` `{ url, headers, type }`, cached in-process per user+toolkit.
  The URL and headers are capability credentials: never persisted, never logged.
- `lib/connections/managedToolBridge.js` owns one `lykn_mcp_connections` row per connected app, marked `providedThrough: 'composio'` with `catalogId: composio:<toolkit>` and a stable `.invalid` placeholder `serverUrl` used only for identity/display.
  The Connection Service calls it fire-and-forget on connect completion and disconnect, and reconciles rows against the authoritative connected-toolkit set when the Settings directory loads.
- `McpConnectionManager` accepts an injected `resolveManagedEndpoint(userId, row, { fresh })` (wired in `server/routes/mcp.routes.js`).
  For managed rows it substitutes the live-minted URL/headers at runtime creation, retries once with a fresh session on 401 (sessions rotate), never falls into MCP OAuth discovery, and reconnects+retries once when a tool call hits an auth error mid-session.
  `providedThrough: 'composio'` is rejected from client connect input; only the bridge sets it.

Surfaces (all consume the same rows through the existing gates — classification, capability check, consequence approval tokens, untrusted-result wrapping):

- Chat: connected apps are used through `lykn_search_connected_tools` / `lykn_call_connected_tool` — a searchable registry of every app's actions (skill-style lookup). Ranked `mcp_*` schemas are not dumped into the turn; a 10-tool guess was filling with GET_A_* variants and the model treated that as the whole app (GitHub, Supabase, Mailchimp). Search is schema-driven for every app: it prefers tools that can run now (no missing opaque `*_id` / `*_ref` / `*_sha`), boosts ready list/search and authenticated/current-user entry points, and fills name-shaped args from the query.
  Large catalogs are cached with the same rule: keep discovery tools, not the first 500 alphabetically (GitHub was dropping `LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER`). Composio `successful:false` is a failed call so the model retries instead of inventing a reconnect story. `[CONNECTED_APPS — OAuth]` in the prompt gives standing awareness of what is connected. Consequential calls still pause for live approval.
  Capability needs are inferred over the current message plus the recent conversation (`contextText`), so follow-up turns like "ok now send it" still disclose the app's tools.
  Consequential calls pause mid-turn: the handler mints an approval token, `requestMcpApproval` ships the request to the chat client as an `mcp_approval` tool event over the local-tool result channel, the client renders the shared approval card (`LocalToolApprovalCard`), and the handler retries once with the token on approve or reports `user_declined` on decline.
- Bots: a new `connected_apps` harness tool (`electron/bot-harness/runtime/connectedAppsTool.cjs`) lists connected apps + tools and executes one call per instruction through the authenticated `/api/mcp` routes via `desktopMcpClient`; consequential calls round-trip user approval with the server-minted token, and headless routine runs stop at the approval gate.
  `browser.md` now defers account work to `connected_apps` when the app is connected.
- Voice: `/api/ai/realtime/tools` and the ElevenLabs custom-LLM proxy attach the turn's bridged `mcp_*` tools; `/api/ai/realtime/tool` executes them via `executeMcpToolByBridgedName` (`lib/mcp/chatTurn.js`) with the full MCP gate stack.

## Phase 3 plan

1. Route chat `missing_capability` for managed providers into `connectionService.connect()` with an in-chat Connect action instead of a Settings pointer.
2. Park-and-resume: persist the pending run (TaskRuntime wait state) at `connection_auth_required` and resume on connection completion.
3. Retire the stale connector catalog copy in `src/lib/connectors/catalog.js`.
4. Decide multi-account UX (Composio already keys accounts by connected-account id, which the service preserves as `connectionId`).
5. Spoken approval flow for consequential calls in voice (chat now has a live in-stream approval round trip).

## Developer setup

```text
COMPOSIO_API_KEY   Composio project API key (dashboard -> project settings). Server-side only.
```

1. Create a Composio project and copy its API key into the server environment as `COMPOSIO_API_KEY`.
2. Gmail managed auth needs no Google OAuth client and no `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; Composio's managed Gmail app handles consent.
3. Optional but recommended for production: enable callback identity verification in the Composio dashboard (Settings → General → Configuration) with verifier URL `{PUBLIC_API_BASE_URL}/oauth/connections/verify`.
4. Local development with verification enabled requires a public HTTPS tunnel to the API server; without verification, the state-bound `/oauth/connections/callback` flow works on localhost.
5. Manual check: `COMPOSIO_API_KEY=... node scripts/verify-composio-gmail.mjs <lykn-user-id>`.

## Known limitations (Phase 1)

- One Gmail account is exposed in the UI; this is a product limitation, not a schema one (`connectionId` preserves the Composio connected-account id).
- `session.toolkits()` does not return an account alias/email, so the card shows no account label yet.
- Popup completion relies on `window.opener` `postMessage` (same best-effort behavior as MCP OAuth); if the opener is unavailable, state still completes server-side on the callback route and Settings shows Connected on next refresh — except in the verifier flow, where the user must retry Connect.

## Known limitations (Phase 2)

- Users who connected an app before the tool bridge existed get their tool row created lazily, the next time the Settings connections directory loads (the reconcile pass); until then chat/bots/voice do not see the app's tools.
- Consequential managed calls in voice return the approval request as tool output for the model to voice; there is no dedicated spoken approval card yet.
- The ElevenLabs custom-LLM path attaches per-user app tools upstream, but tool execution still depends on the browser client relaying the call to `/api/ai/realtime/tool`.
