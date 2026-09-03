# LYKN Connections, OAuth, MCP, and Agent Tool Access Audit

Status: read-only architecture audit of current HEAD.
Date: 2026-09-02.

This document does not implement Composio.
It does not change runtime behavior.

Companion docs used as orientation, then re-verified against code:

- `docs/architecture/OWNERSHIP.md`
- `docs/architecture/universal-mcp.md`
- `docs/architecture/memory-vault-connections.md`
- `docs/SECURITY.md`
- `docs/refactor/mcp-connector-audit.md` (stale as of 2026-08-26; Universal MCP landed after it)

Location: `docs/architecture/` is the canonical architecture directory.
The older connector audit lives under `docs/refactor/` and describes a pre-MCP-client HEAD.
This file is the current connections and auth audit.

Confirmed vs inference: a claim is **confirmed** when a runtime call path was read.
A claim is **inference** when it is a likely consequence that was not executed.

This file was later reconciled with parallel traces of MCP runtime, Electron auth, agent tools, credentials/schema, and OAuth inventory.
No runtime code was changed.

---

## 1. Executive Summary

LYKN already has a Universal MCP client.
It is not waiting to become an MCP client.

The live external-app lane is:

```text
user ask
  -> first-party capability disclosure
  -> inferCapabilityNeeds / ExternalToolResolver
  -> McpConnectionManager
  -> MCP server (Streamable HTTP or stdio)
```

That lane is real in `lib/mcp/`, `server/routes/mcp.routes.js`, `server/ai/chatStream.routes.js`, Electron TaskRuntime, and Settings → Connections.

It is not yet a product-complete Gmail experience.

There is **no live first-party Gmail OAuth adapter**.
The old Vault-sync connector adapters (`connectors/*.js`, `connectors-service.js`, `connectionsOAuth.routes.js`) are gone.
`social_connections` remains as a legacy table.
The frontend catalog in `src/lib/connectors/catalog.js` still labels GitHub, Slack, and Notion as "Live".
Those tiles are leftover Vault-sync copy.
They are not a working Connect flow.

Native Google Calendar OAuth exists in `lib/calendar/` and is **currently gated off** (`EXTERNAL_CALENDAR_SYNC_ENABLED = false`).
Apple Calendar is CalDAV, not OAuth, and is gated by the same flag.

Chat can discover MCP tools for a turn and call them.
If Gmail is not connected, chat does **not** open an in-conversation auth card that later resumes the same run.
If the user already has some other MCP connection, chat injects a Settings prompt and an in-memory Activity "Connect Gmail" item.
If the user has **zero** MCP connections, `resolveMcpToolsForTurn` returns `reason: 'no_connections'` and that prompt/attention path **does not run**.
Desktop bots can offer "Connect Gmail", open Settings, and **cancel** the current task with "ask me again".

Credentials that LYKN encrypts use AES-256-GCM via `CONNECTOR_TOKEN_KEY` in `lib/security/credentialStore.js`.
The model is supposed to see `credentialRef` handles, not tokens.
That invariant is largely held on the MCP path.
Custom API secrets are also encrypted and server-injected.

The closest future Connection Manager is not a greenfield type.
It is `createMcpConnectionManager` plus `resolveExternalTools` plus `createSupabaseCredentialStore`, with Calendar and Cursor remaining as product-owned exceptions.

Composio should enter as an **MCP catalog / hosted-server source** behind that manager (`lib/mcp/catalog/aggregatorSeam.js` already names Composio as a non-authority aggregator).
It should not become a second agent-facing connection system.

---

## 2. Current Connection Architecture

### Real system today

```text
                         ┌─────────────────────────────────────┐
                         │  Agent surfaces                      │
                         │  Chat stream / Voice / Bot harness   │
                         │  Browser agent / TaskRuntime         │
                         └──────────────┬──────────────────────┘
                                        │
          ┌─────────────────────────────┼─────────────────────────────┐
          │                             │                             │
          v                             v                             v
 ┌─────────────────┐         ┌──────────────────┐          ┌────────────────────┐
 │ First-party     │         │ Universal MCP    │          │ Browser / local    │
 │ mcp-tools/*     │         │ lib/mcp          │          │ Electron           │
 │ CHAT_TOOL_NAMES │         │ McpConnectionMgr │          │ BrowserExecutor    │
 │ Voice LYKN_TOOLS│         │ ExternalToolRes. │          │ LocalExecutor      │
 └────────┬────────┘         └────────┬─────────┘          └─────────┬──────────┘
          │                           │                              │
          │                           v                              │
          │                  lykn_mcp_connections                    │
          │                  oauth_encrypted / secret_encrypted      │
          │                  lykn_mcp_oauth_sessions                 │
          │                           │                              │
          v                           v                              v
 ┌─────────────────┐         ┌──────────────────┐          ┌────────────────────┐
 │ Custom REST     │         │ MCP OAuth client │          │ User's logged-in   │
 │ lykn_call_app   │         │ PKCE + DCR       │          │ browser cookies    │
 │ Voice-only      │         │ /oauth/mcp/*     │          │ (not LYKN tokens)  │
 │ lykn_custom_    │         └──────────────────┘          └────────────────────┘
 │ connections     │
 └────────┬────────┘
          │
          v
 Specialized product credentials (not MCP)
   Cursor API key  -> lykn_credentials (cursor_cloud_api_key)
   Google Calendar -> lykn_credentials (calendar_google_oauth)  [DISABLED]
   Apple CalDAV    -> lykn_credentials (calendar_apple_caldav)  [DISABLED]
   LYKN identity   -> Supabase Auth (Google/Apple/Microsoft/GitHub)
   Stripe          -> LYKN billing, not a user Gmail-style connection

 Legacy / leftover
   social_connections          Vault-sync OAuth rows (adapters deleted)
   CONNECTORS catalog          UI metadata, still says some apps are Live
   lykn_mcp_tokens             inbound LYKN-as-MCP-server PATs (runtime deleted)
   lykn_oauth_clients etc.     inbound LYKN-as-OAuth-provider (runtime deleted)
```

### Confirmed properties

- LYKN is an MCP **client only** (`lib/mcp/protocol.js`).
- It is not an inbound MCP server.
- `mcp-tools/` is a first-party in-process tool registry that happens to use MCP-shaped `{ content: [...] }` results.
- Universal MCP is a separate runtime that speaks `@modelcontextprotocol/sdk` 1.30.0.
- There is no single type named `Connection` that covers Gmail + Calendar + Cursor + Custom API + SSH.
- "Is this user connected to Gmail?" has **no one canonical answer**.

---

## 3. OAuth Inventory

### 3.1 Live or implemented OAuth clients

| Integration | Role | Status | Initiate | Callback | Scopes | Client ID / secret | PKCE | State | Token store | Multi-account |
|---|---|---|---|---|---|---|---|---|---|---|
| MCP generic | LYKN as OAuth **client** to an MCP authorization server | Live | `McpConnectionManager.beginAuthorization` / `startAuthorization`; UI `openMcpOAuth` | `GET /oauth/mcp/callback` | Whatever the MCP AS advertises | DCR or `MCP_OAUTH_CLIENT_ID` / `MCP_OAUTH_CLIENT_SECRET`; else SEP-991 URL client id | Yes, S256 | `lykn_mcp_oauth_sessions.state`, one-shot, replay rejected | `lykn_mcp_connections.oauth_encrypted` AES-GCM | Yes, one `McpConnection` row per server/account |
| Google Calendar | Native product OAuth | **Implemented, currently disabled** | `POST /api/calendar/connections/google/start` → `startGoogleCalendarAuthorization` | `GET /oauth/calendar/google/callback` | `openid email profile https://www.googleapis.com/auth/calendar.readonly` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | No | `lykn_external_auth_states` | `lykn_credentials` type `calendar_google_oauth` | `findActive` upserts one Google calendar credential |
| LYKN identity (Google) | Sign in to LYKN, not Gmail API | Live | Supabase Auth + `electron/auth/desktopAuth.cjs` | Loopback `127.0.0.1:38472` and/or `lykn://auth` | Supabase/Google sign-in scopes (not Gmail) | Supabase project OAuth apps | Provider-dependent | `desktop_state` | Supabase session (renderer localStorage `sb-*-auth-token`) | One LYKN user session |
| LYKN identity (Apple) | Sign in to LYKN | Live | Same desktop auth allowlist `appleid.apple.com` | Same | Sign in with Apple | Supabase | Provider-dependent | `desktop_state` | Supabase session; Apple refresh in `lykn_apple_tokens` (account deletion path) | One LYKN user |
| LYKN identity (Microsoft) | Sign in to LYKN | Live | `login.microsoftonline.com` allowlisted in desktop auth | Same | Sign-in | Supabase | Provider-dependent | `desktop_state` | Supabase session | One LYKN user |
| LYKN identity (GitHub) | Sign in to LYKN, path-limited | Live | GitHub `/login` `/session` only, not all of github.com | Same | Sign-in | `GITHUB_CLIENT_ID` is **not** read by current GitHub API tools; identity is Supabase | Provider-dependent | `desktop_state` | Supabase session | One LYKN user |
| Sign in with Apple (token exchange) | iOS account-deletion support, not Gmail | Live, narrow | `POST /api/auth/apple/token-exchange` (`lib/appleAuth.js`, `server/routes/authFlows.routes.js`) | n/a (authorization code already issued by Apple/Supabase) | Sign in with Apple | `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_CLIENT_ID` | n/a | requireAuth | `lykn_apple_tokens.refresh_token` **plaintext** | One row per user |

### 3.2 MCP OAuth details (confirmed)

Files:

- `lib/mcp/oauth/oauthProvider.js` (`createLyknOAuthProvider`, `runMcpAuth`, `persistOAuth`, `decryptOAuthBlob`)
- `lib/mcp/oauth/oauthSession.js` (`createSupabaseOAuthSessionStore`, `newOAuthState`)
- `lib/mcp/oauth/clientIdentity.js` (`mcpOAuthRedirectUri`, `lyknOAuthClientMetadata`, `preRegisteredClientInformation`)
- `lib/mcp/oauth/endpointPolicy.js`, `revoke.js`, `callbackPage.js`
- `server/routes/mcp.routes.js`

Flow:

1. `connect` or `startAuthorization` builds an SDK `OAuthClientProvider`.
2. SDK discovers protected-resource metadata (RFC 9728) and authorization-server metadata (RFC 8414).
3. Authorization-code + PKCE S256.
4. Dynamic client registration (RFC 7591) or URL client id (SEP-991) or `MCP_OAUTH_CLIENT_ID`.
5. Redirect URI: `{PUBLIC_API_BASE_URL|RENDER_EXTERNAL_URL|localhost:PORT}/oauth/mcp/callback`.
6. Callback HTML posts `lykn:mcp-oauth` to `FRONTEND_BASE_URL` origin and closes the popup.
7. Tokens stay in `oauth_encrypted`.
8. Refresh is SDK-driven; invalid grant marks `authentication_required`.
9. Disconnect/revoke: `lib/mcp/oauth/revoke.js` plus local credential delete.

Not implemented for MCP (confirmed in `clientIdentity.js` / `protocol.js`): client_credentials, JWT bearer, device code, implicit, legacy HTTP+SSE.

Env vars (names only):

- `PUBLIC_API_BASE_URL`
- `RENDER_EXTERNAL_URL`
- `PORT`
- `FRONTEND_BASE_URL` / `FRONTEND_URL`
- `MCP_OAUTH_CLIENT_ID`
- `MCP_OAUTH_CLIENT_SECRET`
- `CONNECTOR_TOKEN_KEY` (encrypts the OAuth blob)

### 3.3 Google Calendar OAuth details (confirmed, disabled)

Files:

- `lib/calendar/googleCalendar.js` (`googleCalendarAuthUrl`, `exchangeGoogleCalendarCode`, `refreshGoogleCalendarToken`)
- `lib/calendar/calendarService.js` (`startGoogleCalendarAuthorization`, `finishGoogleCalendarAuthorization`)
- `server/routes/calendarConnections.routes.js`
- `lib/calendar/calendarConfig.js` (`EXTERNAL_CALENDAR_SYNC_ENABLED = false`)

When the flag is false, start/callback/sync return HTTP 410.
The code path is still present.

Redirect: `{PUBLIC_API_BASE_URL|RENDER_EXTERNAL_URL|localhost}/oauth/calendar/google/callback`.
Confidential client (secret on server).
No PKCE.
CSRF via one-shot `lykn_external_auth_states`.
Reconnect overwrites the active `calendar_google_oauth` credential.
Disconnect: `DELETE /api/calendar/connections/:id` deletes the credential row.
There is **no Google token-revocation call** (`disconnectCalendarConnection` → `store.remove` only).
UI: Calendar page, not the MCP marketplace (`src/components/calendar/LyknCalendarPage.jsx`).
Settings Connections card only appears when the flag is true (`ConnectionsAppGrid.jsx`).

Env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_API_BASE_URL`, `RENDER_EXTERNAL_URL`, `FRONTEND_BASE_URL`, `CONNECTOR_TOKEN_KEY`.

### 3.4 Identity OAuth (confirmed, out of Gmail-product scope)

`electron/auth/desktopAuth.cjs` is LYKN sign-in, not Gmail/Slack/Notion API access.

It allowlists Google, Apple, Microsoft, and GitHub login paths inside the app chrome.
Packaged Mac prefers system-browser + loopback handoff (`LYKN_DEV_AUTH_PORT`, default 38472).
`lykn://auth` remains a fallback.
Comments in `electron/main.cjs` warn that `lykn://auth#access_token=` is sensitive.

This must not be confused with Gmail connected-account OAuth.

### 3.5 Deleted or leftover OAuth

| Item | Status | Evidence |
|---|---|---|
| Vault-sync connector adapters (`connectors/gmail.js`, Slack, Notion, GitHub, …) | **Deleted** | No `connectors-service.js`, no `connectionsOAuth.routes.js`, no `buildAuthUrl` outside calendar |
| `social_connections` / `oauth_states` | **Legacy tables** | Created in `037_social_connections.sql` / `038_oauth_states_metadata.sql`. JS no longer reads `oauth_states`. Calendar and Cursor still **migrate from** `social_connections` |
| `CONNECTOR_PAIRS` in `validateSecrets.js` | **Leftover env validation** | Still lists GitHub, Reddit, Notion, Spotify, Pinterest, Linear, Todoist, Vimeo, Raindrop, Dribbble, Google, Microsoft, Slack, X, Canva. Only Google is used by live calendar code |
| LYKN-as-OAuth-provider (`oauth-server.js`) | **Runtime deleted** | Tables from `050_lykn_oauth_provider.sql` remain. `lykn_mcp_tokens` still queried by `server/routes/admin.routes.js` |
| Catalog "Live" OAuth tiles | **Stale UX** | `src/lib/connectors/catalog.js` marks notion/slack/github `status: "available"` |

### 3.6 Count

- Live generic OAuth client implementations: **1** (MCP).
- Live native product OAuth clients: **0** (Calendar is written but disabled).
- Live identity OAuth: Supabase-delegated Google/Apple/Microsoft/GitHub sign-in, plus a server-side Apple code exchange used for SIWA revocation (`lykn_apple_tokens`).
- Live first-party Gmail/Slack/Notion/Drive OAuth adapters: **0**.

---

## 4. API-Key Integration Inventory

### 4.1 User-provided keys (per LYKN user)

| Integration | Where entered | Store | Encrypted | Agent access | Sent to model? | Renderer exposure |
|---|---|---|---|---|---|---|
| Cursor Cloud | Settings → Connections → Cursor Cloud (`CursorCredentialDialog.jsx`) | `lykn_credentials` type `cursor_cloud_api_key` | AES-GCM `encryptToken` | `lib/cursor/cursorBuilds.js` trusted runtime | No | Write-only POST; list API returns metadata only |
| Custom API / BYO REST | Settings → Connections → Custom API (`CustomApiDialog.jsx`) | `lykn_custom_connections.secret_encrypted` | AES-GCM | Voice `lykn_call_app` / `lykn_list_apps` only. **Not** in `CHAT_TOOL_NAMES` | Slug, base URL, description yes. Secret no | Secret never returned by `/api/custom-connections` |
| MCP bearer | Connections panel token field | `lykn_mcp_connections.secret_encrypted` | AES-GCM | `McpConnectionManager.resolveAuth` Authorization header | No, `credentialRef` only in public rows | List APIs omit secrets. RLS SELECT on the table still includes the ciphertext column (see Security) |
| Apple Calendar CalDAV | Calendar page app-specific password | `lykn_credentials` type `calendar_apple_caldav` | AES-GCM | Calendar sync only | No | Disabled with the calendar flag |
| Stdio MCP env secrets | Connections local command `envCredentialRefs` | Refs into `lykn_credentials`, not raw env | Via credential store | Child process env at launch (`lib/mcp/stdio/envRefs.js`) | No (`assertNoRawEnvSecrets`) | Public API shows refs only |

Custom API presets (`src/lib/connectors/customApiPresets.js`): openai, anthropic, github, slack, notion, stripe, resend, sendgrid, linear, cursor, airtable, openweather, twilio, vercel, hubspot, figma, canva, atlassian, microsoft365.

These are form prefills, not OAuth apps.

### 4.2 Application-wide keys (LYKN server, not per user)

Entered in deployment env, not Settings.

| Env var | Purpose |
|---|---|
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY` | Chat / tools / images |
| `TOGETHER_API_KEY` | Custom model building |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_LLM_SECRET` | Voice |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `VITE_STRIPE_PUBLISHABLE_KEY` | LYKN billing, not a user Stripe connection |
| `SERPER_API_KEY` | Web search |
| `YOUTUBE_API_KEY` | Chat YouTube lookup (LYKN's key) |
| `RESEND_API_KEY` | Transactional email |
| `WHISPER_HOSTED_API_KEY` | ASR |
| `CONNECTOR_TOKEN_KEY` | AES-256-GCM for all connector-style secrets |
| `SUPABASE_SERVICE_ROLE_KEY` | Server DB |
| `LASTFM_API_KEY`, `TRELLO_API_KEY` | Validated in `validateSecrets.js`; no live connector adapters found |

Users cannot paste their own OpenAI key into Settings for LYKN chat.
There is no BYOK model-key Settings pane.

### 4.3 Unwired first-party GitHub tools

`mcp-tools/githubTools.js` (`runGithubTool`, capability split `github.read` / `github.write` / `github.pr.*`) is a complete REST helper.

Confirmed: it is imported only by `mcp-tools/githubTools.test.mjs`.
It is not in `CHAT_TOOL_NAMES`.
It is not registered in the bot harness tool index.
Token resolution is injected (`resolveToken(authRef)`), which is the right shape, but nothing production-wires a GitHub token into it.

---

## 5. MCP Architecture

### 5.1 What LYKN supports (confirmed)

| Mechanism | Status | Owner |
|---|---|---|
| MCP client | Yes | `createMcpClientRuntime` |
| MCP server (inbound) | No | Explicit in `lib/mcp/protocol.js` |
| Remote MCP | Yes, Streamable HTTP | `StreamableHTTPClientTransport` |
| Local MCP | Yes, stdio | `StdioClientTransport` + `createLocalMcpProcessManager` |
| HTTP+SSE legacy | No | `protocol.js` |
| Server discovery | Marketplace catalog + manual URL + local command | `lib/mcp/catalog/*`, `searchMcpCatalog` |
| Tool discovery | `runtime.listTools()` on connect/refresh | `McpConnectionManager.discover` |
| MCP OAuth | Yes | `lib/mcp/oauth/*` |
| API-key / bearer MCP | Yes | `authMode: bearer` |
| User-defined servers | Yes | URL or stdio command |
| Built-in first-party MCP server | No | First-party tools are in-process `mcp-tools/` |
| Aggregator MCP (Composio etc.) | Seam only | `catalogEntryFromAggregator`; no vendor SDK |

### 5.2 End-to-end path (confirmed)

```text
Settings Connections / POST /api/mcp/connections
  -> createMcpConnectionManager.connect
  -> persist McpConnection (createSupabaseMcpStore)
  -> if 401: beginAuthorization -> popup OAuth -> GET /oauth/mcp/callback
       -> finishAuthorization -> encrypted tokens
  -> createMcpClientRuntime (HTTP or stdio)
  -> listTools / listResources / listPrompts
  -> classifyToolList (deterministic_v2, optional model classify)
  -> classified_tools + capability_summary stored on the row

Later turn:
  user text
  -> inferCapabilityNeeds (regex)
  -> resolveExternalTools (ExternalToolResolver)
  -> toChatTools (namespaced mcp_<id8>_<tool>)
  -> composeWithExternalTools (first-party + MCP)
  -> chat-agent-loop schemas
  -> runChatTool finds extraChatToolsByName
  -> bindMcpChatHandlers -> executeMcpTool
  -> manager.callTool -> runtime.callTool
  -> wrapUntrustedObservation back to the model
```

Chat wiring: `server/ai/chatStream.routes.js` calls `resolveMcpToolsForTurn` and `bindMcpChatHandlers` from `lib/mcp/chatTurn.js`.

Desktop wiring: `electron/mcp/desktopMcpClient.cjs` calls `/api/mcp/*` with the user session.
Electron does not hold MCP tokens.

TaskRuntime: `electron/task-runtime/executors/mcpExecutor.cjs` (`McpExecutor`).
It prefers `lib/mcp/executeMcpTool`.
The CJS require of `executeMcpTool.cjs` does not exist.
Confirmed: only `lib/mcp/executeMcpTool.js` is present.
Electron bot/workflow MCP calls instead POST `/api/mcp/connections/:id/tools/call` from `electron/agentRuntime.cjs`.

### 5.3 Internal representation

A public connection is `toPublicConnection` in `lib/mcp/mcpStore.js`:

- `id`, `userId`, `name`, `serverUrl`, `transport`, `authMode`, `credentialRef`, `trustLevel`, `status`, `accountLabel`, `accountIdentity`, `catalogId`, `providedThrough`, `classifiedTools` (detail APIs), …

Tool names in the model: `mcpChatToolName(connectionId, toolName)` → `mcp_<8hex>_<sanitized>`.

MCP tools are **normalized into the chat tool schema** (`toOpenAIToolSchema` etc.) as `extraChatTools`.
They are **not** merged into `LYKN_TOOLS` / `CHAT_TOOL_NAMES`.

Bot/Routine scoping: `connectionIds` on the association.
Missing / undefined = all user connections (product default, documented in `universal-mcp.md`).
Empty array = none.

### 5.4 Catalog gap (confirmed)

Curated entries in `lib/mcp/catalog/curated.js` include `lykn:gmail`, Drive, Slack, Notion, GitHub, Linear, Granola.

They have capabilities and trust labels.
They do **not** set `remoteUrlTemplate`.

`McpConnectionsPanel.connectCatalog` refuses connect without a hosted URL:

> "No hosted URL for Gmail yet."

So the marketplace can **recommend** Gmail and cannot **connect** Gmail until a URL (official registry hit, manual URL, local stdio, or later aggregator) exists.

Official registry fetch: `lib/mcp/catalog/officialRegistry.js` against `https://registry.modelcontextprotocol.io`.

### 5.5 Naming collision

`mcp-tools/` means first-party LYKN functions.
Universal MCP means the protocol client.
Voice still names its dispatcher `runMcp` for in-process tools (`mcp-tools/voiceTools.js`).

---

## 6. Agent Tool Architecture

LYKN has several runtimes.
They do not share one tool registry.

### 6.1 In-app chat (server)

Entry: `server/ai/chatStream.routes.js` → `chat-agent-loop.js`.

First-party disclosure:

- `mcp-tools/chatIntentSignals.js` (regex intent, including `inferExternalCapabilityNeeds`)
- `mcp-tools/firstPartyCapabilities.js` (`resolveFirstPartyCapabilities`, `resolveChatTurnDisclosure`, `composeWithExternalTools`)
- `mcp-tools/chatTools.js` (`CHAT_TOOL_NAMES`, `runChatTool`, provider schema converters)
- `mcp-tools/chatToolGuidance.js` (when-to-call policy)

Tools are filtered per turn by intent and capability family, not by dumping the full registry.
They are not filtered by "Gmail connected" except through the MCP resolver.

MCP extras attach only when `resolveMcpToolsForTurn` returns tools.
If the user has zero MCP connections, MCP resolve returns `reason: 'no_connections'` and no extra tools.

Dispatch: `runChatTool` allows `ctx.extraChatToolsByName`.
Failures return `{ isError, payload }`.
Auth failures from `executeMcpTool` become JSON text in the tool result (`connection_auth_required`, `waiting_for_user`), not a first-class chat UI card.

### 6.2 Voice

`mcp-tools/index.js` `LYKN_TOOLS` plus `server/routes/voice.routes.js`.
Voice still includes `lykn_list_apps` / `lykn_call_app`.
Chat explicitly excludes those (`firstPartyCapabilities.js`).

### 6.3 Desktop bot harness

`electron/bot-harness/runtime/toolRegistry.cjs`.

Index (progressive disclosure, markdown docs):

- `reply`, `write_document`, `research_report`, `edit_report`, `build_artifact`, `generate_image`, `local_computer`, `ai_drive`, `create_routine`, `browser`

There is **no `gmail` or `mcp` tool** in this index.
Gmail work is expected to go through `browser` (`electron/bot-harness/agent/tools/browser.md`) or through TaskRuntime MCP when a connection is assigned (inbox watch / learned workflow).

### 6.4 Browser agent

`electron/browser-agent/` operates the owned browser with the user's cookies.
It does not use LYKN OAuth tokens for Gmail.
This is why "check my Gmail" can still work without a Gmail connection: the Mac browser is already signed in.

### 6.5 TaskRuntime

Canonical executors per `OWNERSHIP.md`: Bot, Browser, Local, Remote, MCP.

`BrowserOptInGate` (`electron/task-runtime/executors/browserOptInChoice.cjs`) is **legacy park-and-ask**.
Interactive bots now start the browser immediately.
The gate remains so a parked question can still be answered.

Plugin offer regexes: Gmail, Drive, Slack, Notion, GitHub, Linear.

### 6.6 Keyword / regex routing (confirmed, important)

Capability inference is regex, not a learned classifier:

- `lib/mcp/inferCapabilityNeed.js` (`NEED_RULES`, e.g. gmail → `communication.email.search/read`)
- `mcp-tools/chatIntentSignals.js` (`inferExternalCapabilityNeeds`, `messageWantsConnectedAppApis`)
- `electron/task-runtime/executors/browserOptInChoice.cjs` (`PLUGIN_OFFERS`)
- `electron/bot-routines/inboxWatch.cjs` (`INBOX_WATCH_RE`)
- `electron/agent-runtime/skillRouting.cjs` (email/gmail excluded from artifact-edit routing)

This is the hardcoded provider-keyword routing the target architecture wants to avoid putting in the agent harness.
It already lives **above** MCP execution, in disclosure.

### 6.7 First-party vs MCP GitHub

`externalToolResolver.js` documents: first-party GitHub stays outside the resolver.
In practice first-party GitHub tools are not on the chat whitelist.
If a GitHub MCP connection exists, MCP GitHub tools can appear when needs include `source_control.read`.

---

## 7. Connection State and Credential Storage

### 7.1 Concepts that exist

| Concept | Exists? | Where |
|---|---|---|
| `McpConnection` | Yes | `lib/mcp/mcpStore.js` |
| `credentialRef` | Yes | `lib/mcp/credentialRef.js`, `lib/security/credentialStore.js` `createCredentialRef` |
| `Credential` (`lykn_credentials`) | Yes | typed Cursor / calendar secrets |
| Semantic `Capability` | Yes | `lib/mcp/capabilityRegistry.js` |
| MCP `Tool` (classified) | Yes | `lib/mcp/toolClassifier.js` |
| Auth session (MCP OAuth) | Yes | `lykn_mcp_oauth_sessions` |
| Auth session (calendar) | Yes | `lykn_external_auth_states` |
| Catalog entry | Yes | `lib/mcp/catalog/types.js` |
| ConnectedAccount as a unified type | **No** | |
| Integration as a unified type | **No** | catalog.js leftover + MCP catalog are different |
| Provider registry | Partial | MCP catalog + stale CONNECTORS + Custom API presets + credential types |

### 7.2 "Is Gmail connected?" sources (scattered)

1. `lykn_mcp_connections` where `catalogId` is `lykn:gmail` / Google Workspace, or classified tools include `communication.email.*`, or name/account looks like Gmail (`inboxWatch.isInboxConnection`).
2. Legacy Vault notes with sources `gmail_inbox` / `gmail_starred` (`src/lib/vault/vaultCardModel.js`) from the deleted sync connectors.
3. Browser cookies in the agent browser (user signed into mail.google.com).
4. Custom API slug that happens to point at a Gmail-related REST host (unlikely, no Gmail preset).
5. Stale `social_connections` rows with `provider = 'gmail'` if any remain from before adapter deletion.

There is no function named `isConnected(userId, 'gmail')`.

### 7.3 Canonical credential owner

`docs/architecture/OWNERSHIP.md`: credential persistence/encryption → `credentialStore`.

MCP OAuth blobs are **not** rows in `lykn_credentials`.
They are columns on `lykn_mcp_connections`, encrypted with the same `encryptToken` / `decryptToken`.

Stdio env secrets **are** intended to be `lykn_credentials` referenced by `envCredentialRefs`.

Two different `createCredentialRef` helpers exist:

- `lib/mcp/credentialRef.js` → `{ type, connectionId }` (`none | mcp_secret | mcp_oauth | oauth_social_connection`)
- `lib/security/credentialStore.js` → `{ type, credentialId }` pointing at `lykn_credentials`

`getMcpManager` bridges stdio env refs `{ type: 'lykn_credential', id }` through the generic store.
This naming collision is a unification hazard for a future Connection Manager.

---

## 8. Database / Schema

All secrets below are column names only.

| Table | Purpose | Important columns | User relation | RLS | Encryption | Active? |
|---|---|---|---|---|---|---|
| `lykn_mcp_connections` | Universal MCP connections | `server_url`, `transport`, `auth_mode`, `secret_encrypted`, `oauth_encrypted`, `classified_tools`, `status`, `account_label`, `catalog_id`, `provided_through`, `command`, `env_credential_refs` | `user_id` | RLS on; **authenticated CRUD own rows, all columns** | AES-GCM in app for secret/oauth columns | **Active** |
| `lykn_mcp_oauth_sessions` | MCP PKCE/state | `state`, `code_verifier`, `connection_id`, `used`, `expires_at` | `user_id` | RLS on, **no policies** (service-role only in practice) | verifier stored plaintext in DB | **Active** |
| `lykn_credentials` | Typed secrets | `credential_type`, `secret_encrypted`, `status`, `metadata`, `expires_at` | `user_id` | RLS on, **no authenticated policies** (service-role only) | AES-GCM | **Active** (Cursor; calendar when enabled) |
| `lykn_external_auth_states` | Calendar OAuth CSRF | `state`, `purpose`, `redirect_after`, `expires_at` | `user_id` | RLS on, no authenticated policies | n/a | **Active code, unused while calendar flag is false** |
| `lykn_custom_connections` | BYO REST | `slug`, `base_url`, `auth_type`, `secret_encrypted`, `allow_writes` | `user_id` | RLS on; authenticated can SELECT own (including secret column if they select `*`) | AES-GCM | **Active**, Voice-only action |
| `social_connections` | Legacy Vault-sync OAuth | `provider`, `access_token`, `refresh_token`, `status` | `user_id` | Historical RLS | AES-GCM blobs | **Legacy**. Read for Cursor/Calendar migration only |
| `oauth_states` | Legacy connector CSRF | from 037/038 | `user_id` | Historical | n/a | **Unused in JS** |
| `lykn_mcp_tokens` | Inbound PAT hashes for deleted LYKN-as-MCP-server | `token_hash`, `scopes` | `user_id` | Historical | hash only | **Leftover**; admin usage query |
| `lykn_oauth_clients`, `lykn_oauth_authorization_codes`, `lykn_oauth_refresh_tokens`, `lykn_oauth_consents` | LYKN as IdP | 050 | mixed | Historical | | **Leftover**; runtime deleted |
| `lykn_apple_tokens` | Sign in with Apple refresh | 114 | `user_id` | service-oriented | **plaintext refresh_token** | Identity, not Gmail |
| `user_billing` | Stripe customer/subscription | billing service | `user_id` | server | Stripe ids, not card PAN | LYKN payments |

Migrations of record: `127_lykn_mcp_connections.sql`, `128_lykn_mcp_auth_trust.sql`, `129_lykn_generic_credentials.sql`, `130_lykn_mcp_stdio_catalog.sql`.

---

## 9. Current Settings UX

Settings modal: `src/components/notes/SettingsModal.jsx`.

The sidebar id is `integrations`.
The visible title is **Connections**.
Alias: `connections` → `integrations`.
`lykn_open_settings` uses the same ids (`mcp-tools/openSettings.js`).

Confirmed flow today:

```text
Settings
  -> Connections
       -> MCP marketplace / search / Add URL / local command   (primary)
       -> Specialized
            -> Calendars (hidden while EXTERNAL_CALENDAR_SYNC_ENABLED is false)
            -> Cursor Cloud (API key dialog)
            -> Custom API (BYO key dialog)
            -> Remote targets (SSH, no secrets in UI)
```

Deep link: `/settings?section=connections` or `#connections` or event `lykn-open-connections`.

There is no separate "OAuth providers" or "Developer MCP server" pane for inbound LYKN-as-server (that product was removed).

### UX problems (not a redesign)

- Catalog file `CONNECTORS` still describes Vault sync OAuth as Live / pending Google review.
- Vault dock (`VaultAppDock.jsx`) still uses that catalog for folder chrome and can send users to Settings Connections.
- Marketplace Gmail tile cannot complete connect (no `remoteUrlTemplate`).
- Chat "connect Gmail" and Bot "Connect Gmail" open Settings, not an in-chat OAuth card.
- Custom API is a second, Voice-only action lane.
- Calendar is a third surface (`/calendar?sync=1`) and is currently unavailable.
- Users can still add a raw MCP URL, which is developer-shaped compared with "Connect Gmail".

---

## 10. Current Chat Authentication Flow

### Scenario: "Check my Gmail" and Gmail is not connected

#### In-app chat (confirmed)

1. `inferExternalCapabilityNeeds` / `inferCapabilityNeeds` match gmail/inbox.
2. `resolveMcpToolsForTurn` lists MCP connections (`lib/mcp/chatTurn.js`).
3. If **none**: `reason: 'no_connections'`.
   `chatStream.routes.js` only binds tools when `mcpTurn.tools.length` is non-zero.
   The later `missing_capability` prompt/attention block checks `mcpTurn.resolution.reason === 'missing_capability'` and therefore **does not run**.
   First-party disclosure may still add `connections.external` with no MCP tools listed.
4. If some connections exist but none provide email capabilities: `reason: 'missing_capability'` plus curated suggestions (Gmail).
5. Only in that case `chatStream.routes.js`:
   - `noteAttention` in-memory (`Connect Gmail`)
   - appends `[MCP CONNECTIONS — NEEDS CONNECTION]` telling the model to use Settings → Connections
6. First-party tools may still include `lykn_open_settings`.
7. Voice maps `connections.external` to **no tools** (`VOICE_TOOLS_BY_CAPABILITY['connections.external'] = []` in `mcp-tools/voiceToolResolver.js`).
8. There is **no** chat message type for `AUTH_REQUIRED` / connect card in `src/components/lyknChat/`.

If Gmail **is** connected via MCP, matching tools are attached as `mcp_*` functions and can run in the same turn.

If Gmail is connected but auth-expired, chat has no connection allowlist, so the resolver's `connection_auth_required` early-return (which requires an allowlist) does not fire.
The expired row is simply not `eligible`, which again looks like `missing_capability` unless a tool call actually executes and `executeMcpTool` returns `connection_auth_required` as JSON to the model.

#### Desktop bot (confirmed)

Default path is **browser**, not plugin.

`browser.md` tells the harness to operate Gmail in the live browser.

If a leftover opt-in question is showing, answering "Connect Gmail":

- `classifyOptInReply` → `connect`
- `openConnectionsSettings`
- `taskRuntime.cancel(..., "chose_plugin_connection")`
- message: "Once it's connected, ask me again"

The original instruction is **not** resumed.

If the user already has exactly one inbox MCP connection, `create_routine` inbox watch can bind `connectionIds` (`electron/agentRuntime.cjs` + `inboxWatch.cjs`).
Creating a watch without a plugin says it will check Gmail in the browser and suggests Settings.

#### Inference

A user who is signed into Gmail in the agent browser can complete "check my mail" without LYKN ever storing a Gmail token.
That is the current working product path.

---

## 11. Agent Pause / Resume Capabilities

### What exists

| Mechanism | Pause | Resume | Durable? | Reuse for OAuth? |
|---|---|---|---|---|
| TaskRuntime `waiting_for_user` / `waiting_for_approval` | Yes | `runtime.execute(taskId)` same identity (`taskRuntime.test.cjs`) | Task record in Electron runtime | **Yes, closest** |
| MCP tool approval tokens | `waiting_for_approval` + `mintMcpApprovalToken` | caller sends `approvalToken` | **In-memory Map**, 10 min TTL, lost on process restart | Pattern is right; storage is not |
| Desktop workflow MCP | 409 approval → `awaitBrowseApproval` then retry with token | Same call | Process-local | Already used for MCP writes |
| Bot "Connect Gmail" | Cancels task | User must ask again | No | Anti-pattern for Composio |
| Browser sign-in / paywall | `pendingPlan` + "done/signed in" regex resume | Same agent, remaining steps | Agent memory | Similar UX, not connection-manager |
| Local Mode file/shell approval | `localApprovals.issue/consume` | Same tool call | Process-local | Same token shape as MCP approvals |
| Chat agent loop | Continues until model stops; no suspended run id for auth | New HTTP turn | Conversation history only | Weak |
| Billing / usage | Balance checks in chat routing | N/A | Ledger | Not an auth pause |

`executeMcpTool` already returns `waiting_for_user` + `connection_auth_required` when the connection status is in `AUTH_REQUIRED_STATUSES`.

Confirmed: chat `bindMcpChatHandlers` does **not** park the chat run and wait for OAuth.
It returns that JSON to the model as a tool error.

Learned workflows **do** refuse to start when assigned connections are unavailable (`waitingKind: "connection_required"` in `agentRuntime.cjs`).
That is a stop, not an OAuth popup + continue.

### Implication

The reusable primitive is TaskRuntime wait + one-time approval/auth token, plus the existing MCP callback `postMessage` that already refreshes the Connections UI.

Chat needs a new continuation, or chat must become a Task.

Do not invent a second pause system if TaskRuntime can own it.

---

## 12. Electron Authentication Flow

| Flow | Where it happens |
|---|---|
| LYKN sign-in | System browser preferred + loopback `127.0.0.1:38472+`; fallback `lykn://auth`; some IdP pages allowed in-app (`desktopAuth.cjs`) |
| MCP OAuth | Renderer `window.open` (`src/lib/mcp/mcpApi.js` `openMcpOAuth`) to AS; callback is **backend HTTPS** `/oauth/mcp/callback`, not a custom protocol |
| Calendar OAuth | Same popup + backend callback `/oauth/calendar/google/callback` |
| MCP API calls from desktop | Renderer/main uses user JWT against `/api/mcp/*`. Tokens never copied into Electron storage (`desktopMcpClient.cjs`) |
| SSH remotes | OS agent / key files via `authRef`; no secret in UI |
| Agent browser Gmail | User cookies in the owned BrowserWindow |

Protocol: `lykn://` is registered for identity fallback and in-app chrome (`lykn://new-tab`, artifacts).
It is **not** the MCP OAuth callback.

IPC: `electron/trustedIpcSender.cjs` attests high-risk Local Mode / open-url handlers.
Credential material is not supposed to cross IPC.
MCP secrets stay on the server.

Security implication: MCP OAuth popup depends on `window.opener` postMessage to `FRONTEND_BASE_URL`.
If Electron isolates the popup so `opener` is null, the Connections list may not auto-refresh until manual reload.
Callback still completes on the server (connection becomes `connected`).
Inference: UI refresh is best-effort; authorization itself is server-side.

---

## 13. Security Findings

Scoped to connections and credentials.

### Critical

None confirmed as plaintext token theft in current MCP/calendar/Cursor write paths.

Identity deep-link `lykn://auth#access_token=` is treated as sensitive in `electron/main.cjs`.
That is existing login risk, not Gmail API risk.
Do not extend that pattern to provider OAuth.

### High

1. **Plaintext Apple refresh token in `lykn_apple_tokens`.**
   `POST /api/auth/apple/token-exchange` upserts `{ user_id, refresh_token }` with no `encryptToken` (`server/routes/authFlows.routes.js`).
   This is the only live OAuth token store that skips AES-GCM.
   Used so account deletion can revoke SIWA (`lib/appleAuth.js` `revokeAppleToken`).
   Identity-only, not Gmail, but it is credential persistence.

2. **`lykn_mcp_connections` RLS allows authenticated SELECT/UPDATE of `secret_encrypted` and `oauth_encrypted`.**
   List APIs omit those columns.
   Any browser session with the user's JWT can still `select('*')` via PostgREST and exfiltrate ciphertext.
   Contrast with `lykn_credentials`, which has no authenticated policies.
   Confirmed: `127_lykn_mcp_connections.sql` policies.

3. **Same pattern on `lykn_custom_connections.secret_encrypted`.**
   Routes strip secrets.
   RLS SELECT own is still full-row (`093_lykn_custom_connections.sql`).

4. **PKCE verifiers in `lykn_mcp_oauth_sessions.code_verifier` are plaintext.**
   Table is service-role-only if policies stay empty.
   If a policy is added later without stripping `code_verifier`, this becomes a live secret leak.

### Medium

5. **MCP OAuth callback does not pass `userId` into `finishAuthorization`.**
   `GET /oauth/mcp/callback` calls `manager.finishAuthorization(undefined, { state, code, ... })`.
   `oauthSessions.consume` skips the user-match check when `userId` is falsy.
   Binding is the 24-byte one-shot state (10 min TTL).
   A leaked callback URL could complete another user's in-flight connect (login-CSRF style).
   Inference: low probability, real shape.

6. **Stale connector OAuth env pairs** in `validateSecrets.js`.
   If old `SLACK_CLIENT_SECRET` etc. remain in production env, they are unused by current adapters but still sit on the server.

7. **In-memory MCP approval tokens and Activity attention.**
   Restart drops pending approvals and "Connect Gmail" attention.
   Multi-instance API hosts will not share them.

8. **Calendar OAuth has no PKCE and no Google-side revocation on disconnect.**
   `disconnectCalendarConnection` only deletes the `lykn_credentials` row.
   Acceptable-ish for a confidential server client while the flag is off.
   If this flow is ever moved into a public Electron client, missing PKCE becomes High.

9. **Chat prompt includes Custom API names, slugs, and base URLs** (`server/ai/chatContext.js`).
   Secrets are not included.
   Combined with Voice-only `lykn_call_app`, this can confuse the chat model into inventing REST calls it cannot execute.

10. **`lastError` from MCP servers (up to 300 chars) is stored and shown in Settings.**
    `credentialRef` redaction is not applied on that path.
    A malicious MCP server can place attacker-controlled text in the UI.

### Low

11. **`executeMcpTool.cjs` missing.**
    `McpExecutor` falls back.
    Desktop production path uses HTTP instead.
    Brittle if someone expects the CJS require to work.

12. **`githubTools.js` unwired.**
    Not a leak by itself.
    A future naive wire-up could put PATs in prompts if `resolveToken` is ignored.

13. **`VITE_PUBLIC_MCP_URL` remains in the Vite public allowlist** (`validateSecrets.js`).
    Leftover from inbound MCP.

14. **In-memory MCP store can keep bearer secrets plaintext** when `store.encrypt` is not wired (`mcpConnectionManager.connect`).
    Production `getMcpManager` always wires `encryptToken`.
    Dev-only gap.

### Informational

15. MCP OAuth uses public client + PKCE (`token_endpoint_auth_method: 'none'`).
    Correct for this profile.
16. Google Calendar scopes are read-only calendar, not Gmail.
17. MCP disconnect attempts RFC 7009 revocation (`lib/mcp/oauth/revoke.js`). Calendar disconnect does not.
18. Tool results from MCP are wrapped as untrusted (`lib/mcp/trust.js`).
19. `docs/SECURITY.md` already states connected-account tokens are encrypted and that disconnect revokes.
20. Two `createCredentialRef` shapes (`lib/mcp/credentialRef.js` vs `lib/security/credentialStore.js`).

---

## 14. Duplication / Architectural Debt

1. **Three "MCP" meanings:** first-party `mcp-tools`, Universal MCP client, leftover inbound `lykn_mcp_tokens`.
2. **Four connection products:** Universal MCP, Custom API, Cursor key, Calendar (disabled), plus browser cookies as a silent fifth.
3. **Two catalogs:** `src/lib/connectors/catalog.js` (Vault-era) vs `lib/mcp/catalog` (live).
4. **Two credential homes:** `lykn_credentials` vs encrypted columns on `lykn_mcp_connections`.
5. **Two GitHub stories:** unwired `githubTools.js`, Custom API GitHub PAT, MCP GitHub, identity GitHub login, SSH remotes.
6. **Regex capability routing in three modules.**
7. **Voice can call Custom APIs; Chat cannot**, but Chat still lists them in `[CONNECTED_APPS]`.
8. **Stale Aug 26 audit** (`docs/refactor/mcp-connector-audit.md`) says LYKN is not an MCP client.
   That is false on current HEAD.
9. **`oauthActionApps` in `chatContext.js` is always `[]`.**
   Slack-OAuth-as-call_app synthesis is dead.
10. **`CONNECTOR_PAIRS` and catalog "available" statuses** advertise OAuth that cannot start.

---

## 15. Composio Integration Points

Do not attach the agent to Composio.

Use the existing Universal MCP stack.

```text
user asks for a capability
    -> inferCapabilityNeeds / firstPartyCapabilities.externalNeeds
         modules: mcp-tools/chatIntentSignals.js, lib/mcp/inferCapabilityNeed.js
    -> agent selects tool
         chat: chat-agent-loop + extraChatTools from toChatTools
         bot: toolRegistry (browser today) or TaskRuntime McpExecutor
    -> connection check
         resolveExternalTools / resolveMcpToolsForTurn
         McpConnectionManager.store.list
    -> connected?
         yes -> executeMcpTool -> manager.callTool
         no  -> missing_capability | connection_auth_required
    -> create auth session
         McpConnectionManager.connect / startAuthorization
         catalogEntryFromAggregator({ aggregator: 'composio', remoteUrl, serviceName: 'Gmail' })
    -> chat renders Connect action
         TODAY: ActivityPanel Connect + Settings + lykn_open_settings
         NEEDED: conversation action that calls the same authorize API
    -> user authenticates
         existing popup + GET /oauth/mcp/callback
         or Composio-hosted redirect that still finishes as an McpConnection
    -> connection event
         callback postMessage lykn:mcp-oauth
         MCP_EVENT_TYPES.CONNECTION_AUTH_REQUIRED / connected
    -> original task resumes
         TODAY: not for chat; partial for TaskRuntime wait states
         NEEDED: park task/run id; on finishAuthorization, execute() again
```

`providedThrough: 'composio'` is already a first-class catalog field.
UI helper `displayNameForConnection` can show "Gmail" with source metadata, matching `universal-mcp.md`.

---

## 16. Proposed Target Architecture

```text
LYKN Agent (chat, voice, bot, routines)
    |
    v
LYKN Tool / Capability Layer
    first-party resolver + ExternalToolResolver
    (capabilities, connectionIds, approvals)
    |
    v
LYKN Connection Manager   ← thin facade, product vocabulary
    isConnected(user, capability)
    startConnect(user, catalogId)
    resumeRun(runId)
    |
    +------------------+------------------+------------------+
    |                  |                  |                  |
    v                  v                  v                  v
Managed Auth        Native OAuth        MCP Auth           Local / other
(Composio as        Calendar?           McpConnection      Cursor key
 hosted MCP /       keep if needed      Manager            Custom REST?
 aggregator URL)    Identity stays
                    Supabase
```

UI vocabulary: Connect Gmail, Reconnect Slack, Disconnect Notion.
Never: Create Composio Connected Account.

Composio is infrastructure behind `McpConnection` + catalog `providedThrough`.

---

## 17. Native vs Composio vs MCP Classification

| Integration | Today | Likely future | Why |
|---|---|---|---|
| Gmail | MCP catalog stub + browser cookies | **Composio-managed auth as MCP source**, or official Gmail MCP URL | No native Gmail OAuth left; this is the product gap |
| Google Drive / Docs | Catalog stub + browser | Same as Gmail / Workspace MCP | No native adapter |
| Google Calendar | Native OAuth, **disabled** | **Keep native** or later MCP; do not dual-write | Dedicated calendar service, read-only sync into LYKN calendar |
| Apple Calendar | CalDAV password, disabled | **Native / local** | Not a Composio OAuth story |
| Slack | Catalog stub + Custom API preset + browser | Composio or Slack MCP | Native adapter deleted |
| Notion | Same | Composio or Notion MCP | Native adapter deleted |
| GitHub API | Unwired tools + Custom API PAT + MCP catalog | **Decision needed**: first-party tools vs MCP vs Composio | Identity GitHub login is unrelated |
| Linear | Catalog + Custom API | MCP / Composio | No native OAuth |
| Cursor Cloud | Native API key | **Keep native** | Product-owned builds, already on `lykn_credentials` |
| Custom REST | Native BYO key | **Keep native** as power-user escape hatch | Not Composio |
| SSH remotes | OS credentials | **Local desktop** | Never Composio |
| Browser-logged-in sites | Cookies | **Keep** as fallback when no plugin exists | Current Gmail-without-plugin path |
| Stripe | LYKN billing key | **Not a user connection** | Do not mix with Gmail-style Connect |
| OpenAI/Anthropic/Gemini/xAI | App keys | Stay app-wide | Not user OAuth |
| ElevenLabs | App keys | Stay app-wide | Voice infra |
| LYKN login Google/Apple/Microsoft/GitHub | Supabase | **Keep native identity** | Different from connected apps |
| Local stdio MCP | Native | **Keep MCP** | Composio is remote hosted auth |
| Granola / long tail | Catalog stubs | Composio or registry MCP | |

Do not delete working native Calendar/Cursor/Custom API/SSH because Composio exists.

---

## 18. Migration Risks

Highest risk: **standing up Composio as a parallel "Connections" system** while MCP connections, stale CONNECTORS tiles, Custom API, Calendar, and browser cookies all still answer "is Gmail connected?" differently.

Other risks:

- Curated Gmail connect already fails without a URL.
  Shipping Composio URLs without replacing catalog.js copy will show two Gmails.
- Chat does not resume.
  Users will connect and think the agent forgot the invoice ask.
- Bot "Connect Gmail" **cancels** the task.
  Wiring Composio into that button without resume will feel broken.
- Regex routing will attach Composio Gmail tools on any "email" mention, including "write an email draft in this chat".
- Enabling Calendar while adding Composio Google Workspace can sync events **and** expose Calendar MCP writes.
- Moving MCP OAuth blobs into Composio without a `credentialRef` mapping will break Routines that stored `connectionIds`.
- `lykn_mcp_connections` RLS ciphertext leak gets worse if Composio tokens are stored in those columns unchanged.
- In-memory `noteAttention` will not notify the other API instance after OAuth completes.
- Voice Custom API Slack vs Composio Slack MCP can both exist.
  Ambiguous writes already refuse to guess accounts (`externalToolResolver.js`).

---

## 19. Recommended Implementation Sequence

Do not execute this here.

1. Freeze product vocabulary: Connections = MCP rows + named exceptions (Calendar, Cursor, Custom API, Remote).
2. Stop advertising deleted Vault OAuth in `CONNECTORS` statuses, or clearly mark them capture/legacy.
   Do not build Composio on top of that catalog.
3. Close the RLS secret-column gap on `lykn_mcp_connections` (and ideally custom connections) **before** storing more refresh tokens.
4. Give curated Gmail (and siblings) a real connect URL via aggregator seam or official registry, still creating `McpConnection` rows.
5. Add a LYKN-facing `startConnect(catalogId)` that Settings and chat both call.
   Hide Composio.
6. Add an in-chat Connect action that starts that flow.
   Reuse Activity Connect as a secondary surface, not the only one.
7. Persist a `runId` / pending tool when `connection_auth_required` or `missing_capability` happens.
   Resume with TaskRuntime `execute`, not "ask me again".
8. Persist attention and approval tokens (DB or shared store), replacing the in-memory Maps.
9. Only then decide Calendar restore vs Calendar MCP.
10. Only then decide first-party GitHub tools vs GitHub MCP/Composio.
11. Leave identity OAuth and Stripe billing untouched.

---

## 20. Files Likely To Change

Future implementation only.

| File / module | Why |
|---|---|
| `lib/mcp/catalog/curated.js` | Add hosted URLs / aggregator metadata for Gmail etc. |
| `lib/mcp/catalog/aggregatorSeam.js` | Composio catalog entries without a vendor SDK in the agent |
| `lib/mcp/mcpConnectionManager.js` | Connect/auth session; possibly map Composio account ids to `McpConnection` |
| `lib/mcp/chatTurn.js` | Chat-time missing_capability / auth_required signaling |
| `server/routes/mcp.routes.js` | Authorize + callback already here; may add connect-from-chat |
| `server/ai/chatStream.routes.js` | Replace prompt-only missing_capability with a client event |
| `src/components/connections/McpConnectionsPanel.jsx` | Keep as management surface |
| `src/lib/mcp/mcpApi.js` | Shared `openMcpOAuth` / open Connections |
| `src/components/lyknChat/*` | Connect action in conversation |
| `src/components/activity/ActivityPanel.jsx` | Already has Connect; keep as secondary |
| `electron/agentRuntime.cjs` | Stop cancelling on Connect; park/resume |
| `electron/task-runtime/executors/browserOptInChoice.cjs` | Point Connect at LYKN connect, not Settings-only |
| `electron/task-runtime/executors/mcpExecutor.cjs` | Resume after auth using existing wait statuses |
| `electron/bot-routines/inboxWatch.cjs` | Already MCP-inbox aware |
| `mcp-tools/openSettings.js` | Should become Connect capability, not only Settings |
| `mcp-tools/firstPartyCapabilities.js` | `connections.external` already exists; keep agent off Composio types |
| `src/lib/connectors/catalog.js` | Legacy tile cleanup (copy only, not a new OAuth stack) |
| `validateSecrets.js` | Drop dead `CONNECTOR_PAIRS` when product agrees |
| `lib/security/credentialStore.js` | Only if Composio tokens are stored as typed credentials instead of MCP blobs |
| `supabase-migrations/*` | Pending auth, run continuation, tighter RLS on secret columns |

Unlikely to need Composio imports: `chat-agent-loop.js`, `electron/bot-harness/runtime/toolRegistry.cjs`, `electron/browser-agent/**`.

---

## 21. Open Questions / Decisions

1. For Gmail, is the source of truth a Composio-hosted MCP URL, an official Google MCP, or either with user-visible "Gmail" and hidden `providedThrough`?
2. Should the in-chat Connect action resume the **same agent turn**, or is a follow-up user message acceptable for v1?
3. Keep Google Calendar native when the flag is turned back on, or fold Calendar into Workspace MCP/Composio?
4. Ship or delete unwired `mcp-tools/githubTools.js` before adding GitHub via Composio?
5. Is Custom API / `lykn_call_app` allowed to coexist with Composio Slack/GitHub, and should Chat gain those tools or stay Voice-only?
6. When both browser-signed-in Gmail and a Gmail plugin exist, which wins without asking?
7. Should Routines with empty `connectionIds` keep "all connections" after Composio adds many servers?
8. Store Composio tokens in `lykn_mcp_connections.oauth_encrypted` (current MCP OAuth) or in `lykn_credentials` (current Cursor/Calendar)?
9. Demolish `social_connections` after confirming no production rows still matter, or leave a read-only Vault residue?
10. Is Activity "Needs Attention" enough for mobile/web users who never open Bots, or must chat own the Connect card?

---

## Appendix A. "Check my Gmail" trace (compact)

```text
Chat, no MCP connections at all:
  inferCapabilityNeeds → communication.email.*
  resolveMcpToolsForTurn → no_connections
  missing_capability prompt/attention does NOT run
  result: model may guess; no Connect card

Chat, other MCP connections but no Gmail:
  resolveMcpToolsForTurn → missing_capability
  prompt: use Settings → Connections
  Activity: Connect Gmail
  optional lykn_open_settings
  result: explanation / Settings, not live inbox

Chat, MCP Gmail connected:
  toChatTools → mcp_* email tools
  executeMcpTool → live MCP
  result: tool observation (untrusted wrapper)

Bot, default:
  toolRegistry.browser → owned browser with user cookies
  result: can work without LYKN Gmail OAuth

Bot, user taps Connect Gmail on leftover opt-in:
  open Settings, cancel task, ask again
```

## Appendix B. Prior audit

`docs/refactor/mcp-connector-audit.md` (2026-08-26) described HEAD as neither MCP client nor server.
That was accurate then.
It is **not** accurate now.
Use this document for Composio planning.
