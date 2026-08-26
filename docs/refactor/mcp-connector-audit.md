# LYKN MCP / Connector Architecture Audit

Status: factual read-only audit of current HEAD on 2026-08-26.

This document does not design or implement a universal MCP connection layer.

Companion docs used as orientation only, then re-verified against code:

- `AGENTS.md` (repo agent rules)
- `docs/ARCHITECTURE.md`
- `docs/refactor/agent-harness-audit.md`
- `docs/refactor/bot-flow-audit.md`

Stale security reports still describe `oauth-server.js`, `mcp-server.js`, `/mcp`, and LYKN-as-OAuth-provider.
Those files are **not on current HEAD**.
They were deleted in `af0d79d` (2026-08-22).
This audit describes what the code does now.

---

## Executive summary

LYKN currently uses the word "MCP" as a **legacy name for its in-process tool registry**, not as a live Model Context Protocol implementation.

Current HEAD is **neither an MCP client nor an MCP server**.

There is no `@modelcontextprotocol` SDK.
There is no stdio, SSE, Streamable HTTP, or remote MCP transport.
There is no `tools/list`, `resources/list`, or `prompts/list` protocol loop.
The Connections catalog tile `id: "mcp"` is `status: "soon"` and describes a future **LYKN-as-MCP-client** product.

What exists instead is three separate external-integration systems:

1. **Connectors** (`connectors-service.js` + `connectors/*.js`) - provider-specific vault-sync adapters with a generic OAuth/token framework.
2. **Custom connections** (`lib/customConnections/customConnections.js`) - bring-your-own REST + API key, with a reserved `kind: 'mcp'` column that is unused.
3. **In-app tools** (`mcp-tools/`) - hardcoded LYKN functions for chat, voice, and Local Mode.

Connectors and MCP are **completely separate concepts** today.
Connectors pull into Vault.
They do not expose provider APIs as model tools, except for one hybrid path: Slack OAuth can be reused by `lykn_call_app`.

The largest product gap for the desired future architecture is that **chat cannot currently call connected apps**.
`lykn_list_apps` and `lykn_call_app` exist, are documented in the system prompt, and are wired for voice.
They are **not** in `CHAT_TOOL_NAMES`.
`messageWantsConnectedAppApis()` is defined in `server.js` and never called.

TaskRuntime already has a `capabilities: string[]` field.
That field currently means Bot/browser/local tool names (`reply`, `browser.read`, `files.write`).
It does **not** mean `gmail.read`, `drive.read`, or `github.write`.
It does **not** carry `connectionId`.

Arbitrary MCP is **not** feasible as a moderate adapter on current infrastructure.
The reusable pieces are OAuth/token persistence, credential encryption, custom-connection HTTP dispatch, and TaskRuntime's capability string slot.
The missing pieces are an MCP client runtime, protocol transports, dynamic tool discovery, per-Task connection resolution, and a semantic capability layer for untrusted third-party tools.

---

## Current MCP architecture

### What "MCP" currently means

In current code, "MCP" means **LYKN's own tool objects**.

`mcp-tools/index.js` states this explicitly:

- One source of truth for what LYKN's own AI can do.
- Consumed by in-app chat (via `chatTools.js` whitelist) and voice (via `runMcp` in `server/routes/voice.routes.js`).
- "LYKN does NOT expose these tools to outside AI models."
- "There is no MCP server, no REST mirror, and no bearer-token transport."

Tool shape is custom, not MCP JSON-RPC:

- `name`, `title`, `description`, `scope` (`read` | `write`), `inputSchema`, `handler(args, ctx)`
- Return value is `{ content: [{ type: 'text', text: '...' }] }`, mimicking MCP content blocks without speaking MCP.

Voice still names the dispatcher `runMcp`.
That function looks up `LYKN_TOOLS_BY_NAME` / `EXTERIOR_TOOLS_BY_NAME` and runs the handler in-process.

### Historical inbound MCP server (removed)

This repo previously acted as an **MCP server** so Cursor / Claude Desktop / ChatGPT could call LYKN.

Deleted from HEAD on 2026-08-22 (`af0d79d`):

- `mcp-server.js`
- `mcp-service.js`
- `oauth-server.js`

Database remnants remain:

- `lykn_mcp_tokens` (migration 044, later 050/051/065)
- `lykn_oauth_clients`, `lykn_oauth_authorization_codes`, `lykn_oauth_refresh_tokens`, `lykn_oauth_consents` (migration 050)
- Admin route `GET /api/admin/usage/mcp` still queries `lykn_mcp_tokens`

Those tables are leftover inbound-MCP/OAuth-provider state.
They are not used by a live `/mcp` endpoint on current HEAD.
`server.js` has no `/mcp` mount and no `.well-known/mcp.json`.

The product comment in `src/lib/connectors/catalog.js` now says the opposite of that history:

> "LYKN as MCP CLIENT: the user points LYKN at someone else's MCP server."
> "LYKN is not exposed as an MCP server to outside AI models."

### MCP-related modules on current HEAD

| Path | Responsibility | Runtime |
|---|---|---|
| `mcp-tools/index.js` | Full in-app tool registry (`LYKN_TOOLS`) | server |
| `mcp-tools/chatTools.js` | Chat whitelist, provider schema converters, `runChatTool` | server |
| `mcp-tools/localTools.js` | Schema-only Local Mode tools | server schemas; Electron execution |
| `mcp-tools/exterior/index.js` + `capabilityTools.js` | Web/search/build/HTTP tools | server |
| `mcp-tools/*.js` (per-tool files) | Individual handlers | server |
| `chat-agent-loop.js` | Provider-native function calling loop | server |
| `server/routes/voice.routes.js` | Voice tool defs + `runMcp` dispatcher | server |
| `src/lib/connectors/catalog.js` `id: "mcp"` | Future MCP-client tile, `status: "soon"` | frontend catalog only |
| `supabase-migrations/044_lykn_mcp_tokens.sql` (+ 050/051/065) | Leftover inbound MCP token/OAuth-provider schema | DB, unused by live MCP protocol |
| `server/routes/admin.routes.js` `/api/admin/usage/mcp` | Admin telemetry over leftover token table | server |

LYKN currently acts as: **NEITHER / custom protocol**.

Not an MCP client.
Not an MCP server.
It uses MCP-shaped content blocks and MCP-era naming.

---

## Current connector architecture

Connectors are a **generic OAuth + token-paste + vault-sync framework**.

Canonical modules:

| Path | Role |
|---|---|
| `connectors-service.js` | Registry, AES-256-GCM token crypto, OAuth state, `saveConnection`, `runSync`, `pollDueConnections` |
| `connectors/<provider>.js` | Provider adapters (`buildAuthUrl`, `exchangeCode`, `sync`, optional `refreshAccessToken` / `connectWithToken`) |
| `connectors/_save.js` | Shared vault-note writer |
| `connectors/google/_shared.js` | Shared Google OAuth helper |
| `server/routes/connectionsOAuth.routes.js` | HTTP: start, callback, token-connect, list, sync, pause, delete |
| `server/routes/connections.routes.js` | Custom REST connections CRUD + test |
| `lib/customConnections/customConnections.js` | BYO-key HTTP engine + Slack OAuth-action synthesis |
| `src/lib/connectors/catalog.js` | UI catalog (includes many unwired `soon` / `no-api` tiles) |
| `src/lib/connectors/customApiPresets.js` | Known-app REST presets for Custom API |
| `src/components/connections/*` | Settings → Integrations UI |
| `rss-service.js` + `server/routes/feeds.routes.js` | Separate RSS/Atom ingest, not OAuth connectors |

Adapter contract from `connectors-service.js`:

- `id`
- `buildAuthUrl({ clientId, redirectUri, state, scopes })`
- `exchangeCode(...)` → `{ providerUserId, accessToken, refreshToken?, tokenExpiresAt?, scopes, account, metadata }`
- `sync({ connection, supabaseAdmin, accessToken })` → `{ saved, skipped }`
- optional `refreshAccessToken`, `needsPkce`, `authMode: 'token'`, `connectWithToken`, `prepareAuth`, `connectInfo`

`CONNECTOR_REGISTRY` currently registers 32 adapters:

github, reddit, notion, spotify, pinterest, linear, todoist, vimeo, raindrop, dribbble, youtube, google-drive, google-calendar, gmail, outlook-365, slack, x, canva, mastodon, readwise, bluesky, trello, hackernews, lastfm, pinboard, hardcover, karakeep, linkding, goodreads, amazon-wishlist, apple-calendar, cursor.

Connectors persist in `social_connections`.
Sync writes Vault `notes` with `source` slugs (`gmail_inbox`, `notion_page`, `github_starred`, …).
Chat then sees those notes through Vault/memory retrieval, not through Gmail/Drive tools.

---

## MCP vs connector relationship

They are **completely separate**.

| | Connectors | "MCP tools" (`mcp-tools/`) | Custom connections |
|---|---|---|---|
| Purpose | Pull provider content into Vault | In-app LYKN functions | Call arbitrary REST APIs |
| Auth | OAuth / pasted token / username | Signed-in LYKN user session | BYO key or reused OAuth token |
| Model tool? | No (except Slack via `lykn_call_app`, Cursor via dedicated tools) | Yes, hardcoded | Intended yes, but chat whitelist omits the tools |
| Protocol | Provider REST/GraphQL | Custom in-process | HTTP |
| Persistence | `social_connections` | none (code registry) | `lykn_custom_connections` |
| MCP protocol | No | No | `kind: 'mcp'` reserved, unused |

Overlap is only:

- Shared AES-256-GCM (`encryptToken` / `decryptToken`).
- Shared `[CONNECTED_TOOLS]` / `[CONNECTED_APPS]` prompt block.
- Slack: connector OAuth token can be presented as a synthetic custom connection for `callApp`.
- Cursor: token-mode connector plus `lykn_build_with_cursor` / `lykn_check_cursor_build`.
- Schema comment on `lykn_custom_connections.kind` reserving `'mcp'` "for the future MCP-client lane."

---

## Protocol / transports

| Mechanism | Status |
|---|---|
| MCP stdio | NOT IMPLEMENTED. Electron `spawn` exists for local shell/Python/osascript, not MCP servers. |
| MCP SSE | NOT IMPLEMENTED. SSE in this repo is chat streaming (`/api/ai/stream`), not MCP. |
| Streamable HTTP | NOT IMPLEMENTED. |
| Remote HTTP MCP | NOT IMPLEMENTED. |
| Local command/package MCP (`npx some-mcp`) | NOT IMPLEMENTED. |
| WebSocket MCP | NOT IMPLEMENTED. |
| Custom adapters | Live: provider REST adapters + custom REST connections. |
| MCP SDK | None in `package.json`. |

Live transports for external services:

- Server-side `fetch` to provider APIs during connector `sync`.
- Server-side `fetch` in `callApp` / `lykn_http_request` (SSRF-guarded).
- Browser agent actuating live websites (Gmail/Notion/etc. in the user's browser session).
- Electron local process spawn for Local Mode, not MCP.

Historical inbound MCP used Streamable HTTP / `/mcp`.
That path is dead on this HEAD.

---

## Tool discovery

LYKN does **not** support MCP `tools/list`.

Current discovery is compile-time registration:

1. Drop a file in `mcp-tools/`.
2. Re-export it from `mcp-tools/index.js`.
3. Opt it into `CHAT_TOOL_NAMES` in `mcp-tools/chatTools.js` for text chat.
4. Optionally add a voice alias in `server/routes/voice.routes.js`.
5. Optionally document it in `LYKN_CHAT_TOOL_GUIDANCE` / `buildChatToolGuidance()` in `server.js`.

Answers:

- Are tool schemas discovered at runtime? **No.**
- Are tools persisted? **No** (code is the registry).
- Are tools cached? Prompt-side `[CONNECTED_TOOLS]` is cached ~per user; tool schemas are rebuilt per turn from code.
- Are tools manually registered? **Yes.**
- Are MCP tool names normalized? **No MCP names.** In-app names are `lykn_*` / `memory_*` / `local_*`.
- Can an arbitrary MCP expose a new tool without code changes? **No.**

Hard-coding sites:

- `mcp-tools/index.js` `LYKN_TOOLS`
- `mcp-tools/chatTools.js` `CHAT_TOOL_NAMES`
- `mcp-tools/localTools.js` `LOCAL_TOOL_NAMES`
- `mcp-tools/exterior/index.js` + `capabilityTools.js`
- `electron/bot-harness/runtime/toolRegistry.cjs` `TOOLS`
- `electron/browser-agent/runtime/capabilities.cjs` action sets
- `electron/task-runtime/executors/localCapabilities.cjs`
- `lib/modelBuilder/modelCapabilitiesCatalog.js` `CAPABILITY_RUNTIME_MAP`
- `lib/customConnections/customConnections.js` `OAUTH_ACTION_APPS` (currently Slack only)
- `src/lib/connectors/catalog.js` connector tiles
- `connectors-service.js` `CONNECTOR_REGISTRY`

`lykn_list_apps` is the closest thing to runtime discovery.
It lists **connection slugs**, not MCP tools.
The model is then expected to invent REST paths against a free-text `description`.

---

## Resources / prompts

MCP `resources/list`, `resources/read`, `prompts/list`, `prompts/get`: **NOT IMPLEMENTED**.

| Surface | Classification |
|---|---|
| MCP resources | NOT IMPLEMENTED |
| MCP prompts | NOT IMPLEMENTED |
| Vault notes as "resources" | PARTIAL analogue: `lykn_searchVault` / `lykn_loadNeuron` / memory tools |
| Agent Harness MCP resources/prompts | NOT IMPLEMENTED |
| Bot harness "prompts" | UNUSED for MCP: local markdown docs under `electron/bot-harness/agent/tools/*.md` |
| Browser-agent skill markdown | UNUSED for MCP: local corpus, not MCP prompts |

TaskRuntime `scope.resources` is a string list on the Task object.
It is not MCP resources.

---

## Tool registries

Multiple competing registries exist.

### 1. Chat tools

- Canonical source: `mcp-tools/chatTools.js` `CHAT_TOOL_NAMES` (66 names on HEAD).
- Schema: custom tool object → OpenAI / Anthropic / Gemini converters; descriptions clipped to 1000 chars.
- Consumer: `/api/ai/stream` → `chat-agent-loop.js` → `runChatTool`.
- Execution: server-side handlers, except `local_*` which return `awaiting_client` and run in Electron.
- Gate: explicit whitelist; `runChatTool` refuses non-whitelisted names; per-turn `resolveIntentChatToolNames` can shrink the list; custom-model capability map can shrink it further.
- Duplication: voice has a separate alias table; Local Mode schemas live in `localTools.js` while execution lives in `electron/localSystem.cjs`.

`lykn_list_apps` and `lykn_call_app` are in `LYKN_TOOLS` and **not** in `CHAT_TOOL_NAMES`.
Chat cannot execute them.

### 2. Full LYKN / voice tools

- Canonical source: `mcp-tools/index.js` `LYKN_TOOLS` plus exterior tools.
- Consumer: `server/routes/voice.routes.js` realtime tool endpoint.
- Execution: `runMcp` → tool `handler`.
- Gate: hardcoded voice name → `mcp:` mapping; includes `list_apps` / `call_app`.
- Duplication: voice names (`list_apps`) differ from chat names (`lykn_list_apps`).

### 3. Local Mode tools

- Canonical source: `mcp-tools/localTools.js` (schemas) + `electron/localSystem.cjs` (execution).
- Consumer: chat agent loop when Local Mode is on; TaskRuntime `LocalExecutor`.
- Gate: Local Mode switch; per-action approval in Electron; Task capabilities `files.*` / `local.*`.

### 4. Bot harness tools

- Canonical source: `electron/bot-harness/runtime/toolRegistry.cjs`.
- Names: `reply`, `research_report`, `edit_report`, `build_artifact`, `generate_image`, `local_computer`, `create_routine`, `browser`.
- Schema: one-line index in the system prompt; full markdown loaded on first select.
- Consumer: `electron/bot-harness/index.cjs`.
- Execution: injected executors in `agentRuntime.cjs` (streamChat, local runner, parked browser, routine store).
- Gate: `risk` floor (`read` / `low` / `consequential`); `requiresLocalMode`; browser parks a user opt-in.
- No connector/MCP tools.

### 5. Browser agent actions

- Canonical source: `electron/browser-agent/runtime/capabilities.cjs` + executor action vocabulary.
- Not tools in the chat sense.
- Capability strings: `browser`, `browser.read`, `browser.navigate`, `browser.interact`.
- Gate: `classifyActionRisk` regex/label classifier + human approval pause.

### 6. Model Builder capabilities

- Canonical source: `lib/modelBuilder/modelCapabilitiesCatalog.js`.
- Maps builder ids (`web_search`, `api_request`) to runtime chat tool names.
- Soft-unplugged product (`CUSTOM_MODELS_ENABLED = false`) but mapping is live on the read path.
- No external-provider capabilities (`gmail.read` does not exist here).

### 7. Connector catalog

- Canonical source: `src/lib/connectors/catalog.js`.
- Not a tool registry.
- UI/provider metadata, including unwired `soon` / `no-api` tiles.

### 8. OAuth action apps

- Canonical source: `OAUTH_ACTION_APPS` in `lib/customConnections/customConnections.js`.
- Currently `{ slack: { slug: 'slack', allow_writes: true, ... } }` only.
- Hard-coded REST method hints in `description`.

There is **no** unified CapabilityRegistry spanning these.

---

## TaskRuntime integration

`electron/task-runtime/` is live and wired from `electron/agentRuntime.cjs`.

Task fields that matter here (`electron/task-runtime/task.cjs`):

- `capabilities: string[]`
- `scope.resources: string[]`
- `association` (botId, botTaskId, chatId, agentId, parentTaskId, routineId)
- `approval.policy`
- **no `connectionId`**
- **no provider ids**
- **no credentialRef**

What capabilities currently represent:

| Compiler | Typical capabilities |
|---|---|
| `compileBotTask` | Caller-supplied. Production Bot create uses `reply`, `research_report`, `edit_report`, `build_artifact`, `generate_image`, optional `local_computer`, `browser`. |
| `compileLocalTask` | `files.read` / `files.write` / `local.apps.*` / `local.shell.*` derived from the objective. |
| `compileRoutineTask` | Copied from the durable Routine record (`reply`, `browser.read`, `files.read`, `research_report`, …). |
| Browser `ensureBrowserTask` | `browser.read`, `browser.navigate`, `browser.interact`. |

TaskRuntime does **not** know `gmail.read` or `drive.read`.
It knows raw harness/local/browser names.

BotExecutor does not resolve connections.
BrowserExecutor enforces browser action types.
LocalExecutor enforces local tool names.

External SaaS work today happens either:

- indirectly, via Vault text that connectors already synced, or
- by ejecting into the browser agent so the model clicks Gmail/Notion in the user's session, or
- (voice only) via `lykn_call_app` against custom/OAuth-action connections.

---

## Bot integration

A Bot definition (`src/lib/bots/botStore.ts`) has no connections, tools, capabilities, or provider IDs.

Fields: `id`, `name`, `role`, `persona`, look, `agentId`, `chatId`, `tasks`.

Access is **global to the signed-in user**, not per Bot.

One Bot cannot have Gmail while another cannot.
If the user connected Gmail, every Bot sees the same Vault-synced mail (and the same browser cookies if it uses the browser).

Tool availability for Bots is the harness index above, filtered only by Local Mode for `local_computer`.
It is not filtered by Connections.

`createBotTask` hard-codes the same capability list for every Bot.

---

## Routine integration

Routines can run without storing credentials.

A Routine stores `instructions`, `trigger`, `capabilities`, `approvalPolicy`, `botId`.
It does **not** store `connectionId` or secrets.

`compileRoutineTask` copies those fields into a Task.
Credentials never live on the Routine.

What a Routine **cannot** do today:

- Reference `gmail` / `slack` as a capability.
- Bind to a specific account.
- Call `lykn_call_app`.
- Discover MCP tools.

"Every morning check Gmail" currently has two unsafe/indirect paths:

1. **Browser watch / browse** - capability `browser.read` (and maybe interact).
   Uses the user's live browser session, not the Gmail connector token.
2. **Vault recall via chat-like tools** - not in the Bot harness tool index.
   Connector-synced `gmail_inbox` notes may already be in Vault, but the Routine/Task has no Gmail capability and no connection handle.

`nlRoutine.cjs` `compileRoutineCapabilities` can add `research_report`, `local_*`, `browser.*`.
It never adds connector or MCP capabilities.
"Gmail" in text does not become `gmail.read`.

Required seam for safe Routines: Task/Routine `capabilities` + `connectionId` (or `credentialRef`) that TaskRuntime can resolve without putting secrets in the Routine record.

---

## Bespoke provider inventory

Granola: **not present** anywhere in the repo.

| Provider | Class | How it works today | Approx. owned code | Universal MCP could replace? |
|---|---|---|---|---|
| Gmail | CONNECTOR + BROWSER-ONLY | Vault sync `gmail.readonly`; chat has no Gmail tool; browser agent can operate gmail.com | `connectors/google/gmail.js` ~256 + `_shared.js` ~365 | Sync path maybe; action path yes if MCP Gmail exists |
| Google Drive | CONNECTOR + BROWSER-ONLY | Metadata-only starred files; no file-content tool | `connectors/google/drive.js` ~199 | Yes for actions/read; current sync is bookmark-shaped |
| Google Calendar | CONNECTOR | Event notes into Vault | `connectors/google/calendar.js` ~260 | Yes |
| Google Docs / Sheets tiles | CATALOG ALIAS | Catalog aliases onto Drive OAuth; no dedicated adapters | catalog only | Yes |
| YouTube | CONNECTOR | Liked videos into Vault | `connectors/google/youtube.js` ~132 | Yes |
| Outlook 365 | CONNECTOR | Flagged mail / Microsoft Graph | `connectors/microsoft.js` ~261 | Yes |
| Slack | HYBRID | Vault saved-items sync **and** OAuth token reused by `lykn_call_app` (voice/custom-conn path) | `connectors/slack.js` ~293 + `OAUTH_ACTION_APPS.slack` | Yes for actions; sync is bespoke |
| GitHub | CONNECTOR + CUSTOM API PRESET | Starred-repo vault sync; also a Custom API preset using a PAT | `connectors/github.js` ~314 | Yes |
| Notion | CONNECTOR + live refetch | Pages into Vault; chat can live-refetch a Notion URL via stored token | `connectors/notion.js` ~579 + `server.js` `liveRefetchNotionPageBody` | Yes |
| Linear | CONNECTOR | Assigned issues into Vault | `connectors/linear.js` ~275 | Yes |
| Todoist | CONNECTOR | Tasks into Vault | `connectors/todoist.js` ~220 | Yes |
| Cursor | CONNECTOR + BESPOKE TOOLS | Token-mode key; `lykn_build_with_cursor` / `lykn_check_cursor_build`; `connection_id` on builds | `connectors/cursor.js` + `lib/cursor/cursorBuilds.js` | Unlikely soon; this is an action product, not MCP |
| Apple Calendar | CONNECTOR (app-specific password) | CalDAV | `connectors/apple/calendar.js` ~640 | Maybe |
| RSS feeds | BESPOKE API | `rss-service.js`, `rss_feeds` table | ~590 + routes | No (not MCP) |
| Custom API | CONNECTOR (generic REST) | `lykn_custom_connections` | `customConnections.js` ~683 + presets ~350 | Complements MCP; keep |
| Remaining vault pull adapters | CONNECTOR | reddit, spotify, pinterest, vimeo, raindrop, dribbble, x, canva, mastodon, readwise, bluesky, trello, hackernews, lastfm, pinboard, hardcover, karakeep, linkding, goodreads, amazon-wishlist | typically 200-400 lines each | Sync-into-Vault is product-specific; MCP would not automatically replace polling/embed |
| Chat `lykn_http_request` | BESPOKE API | Public HTTP, **strips Authorization/Cookie**, no stored connection | `lib/exterior/capabilities/httpRequest.js` | No; unsafe as a credentialed MCP substitute |

None of these are MCP-driven.

Largest bespoke burden is the **32-adapter vault-sync matrix**, not chat tools.
Each adapter owns OAuth quirks, pagination, cursors, and note shaping.
Notion (~579) and Apple Calendar (~640) are the heaviest single adapters.

---

## Auth architecture

| Mechanism | Where used | Storage | Encrypted? | Model sees it? | Owner | Refresh | Revoke | Multi-account |
|---|---|---|---|---|---|---|---|---|
| Supabase JWT | LYKN login | browser session | TLS in transit | no | frontend + server | Supabase | signOut | n/a (one LYKN user) |
| Connector OAuth access/refresh | Gmail, Notion, Slack, … | `social_connections.access_token` / `refresh_token` | AES-256-GCM via `CONNECTOR_TOKEN_KEY` | no | server | adapter `refreshAccessToken` if present; else `reauth` | DELETE row only; **does not call provider revoke** | yes: unique `(user_id, provider, provider_user_id)` |
| Token paste | Readwise, Cursor, Trello, Bluesky, Apple, … | same `social_connections` blobs | same | no | server | none / provider-specific | DELETE row | yes |
| Custom connection secret | BYO REST | `lykn_custom_connections.secret_encrypted` | same AES-256-GCM | no; model uses slug | server | none | DELETE/pause row | yes: unique `(user_id, slug)` |
| Slack OAuth reused as action | `OAUTH_ACTION_APPS` | reads `social_connections.access_token` | decrypted only in `callApp` | no | server | connector refresh | pause/reauth | **picks latest created row**, not user-selected |
| Cursor API key | Cursor connector | `social_connections` | same | no | server | n/a | delete | `resolveCursorCredential({ connectionId })` can pin a row |
| `lykn_http_request` | chat tool | none | n/a | model must not send Auth headers (stripped) | server | n/a | n/a | n/a |
| Historical MCP PAT `lkn_live_` | leftover table | `lykn_mcp_tokens.token_hash` | hash-only | n/a | dead protocol | n/a | status revoked | leftover |
| Electron local credentials | Local Mode | machine / OS | OS | no | Electron | n/a | Local Mode off | n/a |
| Browser cookies | Gmail/Notion in agent tab | Chromium session | OS | page snapshot may include visible UI, not cookie jar | Electron | browser | user sign-out | whatever is signed into that profile |

There is **no `credentialRef` type**.
Callers pass `connection` slug / UUID into `callApp`, or the sync poller loads the full row including ciphertext.

Security weaknesses (audit only):

1. Disconnect does not revoke provider tokens.
2. Slack action path selects the most recently created Slack connection, not an explicit account.
3. Notion live-refetch selects the most recently synced Notion connection.
4. `[CONNECTED_TOOLS]` lists account display names to the model (not tokens), which is intended, but does not pin later tool calls to those accounts because chat cannot call connector APIs.
5. `lykn_call_app` lets the model choose arbitrary REST paths on a write-enabled connection.
   Consequence classification is prompt text ("confirm destructive actions"), not a capability gate.
6. Authenticated Supabase policies still allow the owning user to SELECT `social_connections`.
   Token columns are encrypted, but the ciphertext is in a user-readable table if a client query selects `*`.
   List API explicitly omits token columns.
7. No provider trust classes (official vs community vs custom).
8. Historical MCP OAuth-provider tables remain in the database with no live protocol.

---

## OAuth architecture

### Identity login (not connectors)

Supabase Auth Google/etc.
Separate Google Cloud client from connector Google client.
Documented in `docs/google-signin-branding.md`.
`oauth-server.js` is named there but **does not exist on HEAD**; connector OAuth now lives in `connectionsOAuth.routes.js`.

### Connector OAuth lifecycle (live)

1. UI: Settings → Integrations (`ConnectionsAppGrid`) click.
2. `POST /api/connections/:provider/start` (`requireAuth`).
3. Optional `adapter.prepareAuth` (Mastodon per-instance DCR).
4. `createOAuthState` writes `oauth_states` (CSRF, optional PKCE verifier, metadata).
5. Adapter `buildAuthUrl`.
6. Frontend popup navigates to provider.
7. Provider redirects to `GET /oauth/callback/:provider`.
8. `consumeOAuthState` (one-time).
9. `adapter.exchangeCode`.
10. `saveConnection` upserts `social_connections` with encrypted tokens.
11. Invalidate `[CONNECTED_TOOLS]` cache.
12. Fire-and-forget `runSync`.
13. Popup `postMessage`s `{ type: 'lykn:oauth', provider, ok }` to trusted frontend origin only (no secrets).
14. Later sync decrypts, refreshes if expiry+refresh fn exist, or marks `reauth`.
15. `DELETE /api/connections/:id` drops the row; no provider revoke.

This framework is **generic enough to start MCP OAuth**, with provider-specific adapters behind one start/callback/save path.
PKCE, state, encrypted persistence, and popup UX are reusable.

It is **not** MCP authorization today:

- Redirect URIs are `/oauth/callback/:provider` for known registry ids, not arbitrary MCP servers.
- Client ids come from `PROVIDER_CREDENTIALS` env vars, not dynamic client metadata from an MCP server.
- No RFC 9728 protected-resource discovery on HEAD.
- Historical LYKN-as-authorization-server (DCR, `/oauth/register`, MCP token mint) was deleted.

### Custom API / token-paste

No OAuth.
User pastes a key into `TokenConnectDialog` or `CustomApiDialog`.
`POST /api/connections/:provider/connect-token` or `POST /api/custom-connections`.

### Reuse for MCP authorization

Reusable: popup connect UX, `oauth_states`, AES token blobs, `status` (`active` / `paused` / `reauth`), reconnect-by-upsert, cache invalidation.

Missing: resource-server metadata, dynamic client registration **as MCP client**, per-MCP-server client ids, PKCE bound to arbitrary redirect, token audience for MCP, and a connection row kind for MCP servers.

---

## Credential storage / redaction

No `credentialRef` abstraction.

Safe by construction in the intended paths:

- Custom connection list routes strip secrets (`decorate()`).
- `callApp` returns `{ ok, status, body }` never the secret.
- Tool descriptions tell the model never to ask for keys.
- Browser-agent debug logs redact token-shaped strings (`electron/browser-agent/runtime/debugLog.cjs`).
- `prompt-sanitizer.js` strips fake `lykn_*()` syntax from **user** input, not tool results.

Unsafe or leaky paths to flag:

- Connector `sync` writes email subjects/bodies and Notion page text into Vault notes.
  Those notes can later be retrieved into the model.
  That is the product (Vault), not a token leak, but it **is** data from a privileged token entering model context.
- `callApp` returns provider JSON bodies to the model/voice.
  A malicious or verbose API can return tokens in JSON.
  There is no response redaction layer.
- Slack `chat:write` via `lykn_call_app` is a write tool with only prompt-level confirmation.
- Task objects / Task events do not currently include tokens (no connection fields).
- `[CONNECTED_TOOLS]` includes account emails/display names.
- `liveRefetchNotionPageBody` decrypts in server memory and injects page text into chat context.

The model never receives `CONNECTOR_TOKEN_KEY` or raw OAuth access tokens in the designed chat/custom-connection path.

---

## Connection persistence

Source of truth is **mixed**:

| Store | What |
|---|---|
| Supabase `social_connections` | OAuth/token connectors; encrypted tokens; sync lifecycle |
| Supabase `oauth_states` | Short-lived OAuth CSRF/PKCE |
| Supabase `lykn_custom_connections` | BYO REST; encrypted secret; slug; `kind` rest\|mcp |
| Supabase `rss_feeds` | Feed URLs, no OAuth |
| Supabase leftover `lykn_mcp_tokens` / `lykn_oauth_*` | Dead inbound MCP/OAuth-provider |
| Electron routine store | Routine capabilities, not connections |
| Renderer `localStorage` `lykn_bots_v1` | Bots; no connections |
| Env vars | Provider **client** ids/secrets (`GOOGLE_CLIENT_ID`, …), `CONNECTOR_TOKEN_KEY` |
| Catalog JS | Hard-coded provider metadata |

Identity:

- Connector: `social_connections.id` UUID + `provider` + `provider_user_id` + `user_id`.
- Custom: `lykn_custom_connections.id` UUID + `slug` unique per user.
- Chat/voice action: model passes **slug** (`slack`, `acme-crm`), not UUID, except Cursor builds which store `connection_id`.
- No workspace/org tenancy beyond `user_id`.
- No Bot association column.

Multiple accounts per provider: **yes at DB level** for connectors.
Action execution often **does not select among them** (Slack: latest created; Notion refetch: latest synced).

---

## Connection UI

Surface: Settings → Integrations (`src/components/notes/SettingsModal.jsx` section `integrations`, aliases `connections`).
Rendered by `ConnectionsAppGrid`.

Also: `VaultAppDock` on Vault (status chips, not the connect catalog).
Legacy `/connections` redirects to Studio.

User can:

- Connect a catalog tile that is `available` / `beta` / `verification` / `paid` **and** has an adapter.
- OAuth popup (`OAuthConnectDialog`).
- Token paste (`TokenConnectDialog`).
- Custom API / presets (`CustomApiDialog`).
- See status, last sync, errors, pause/resume, sync now, disconnect (`ConnectorDetail`).
- Test a custom connection with GET.

User cannot:

- Connect an MCP URL.
- Connect a local MCP command.
- Search an MCP registry.
- Inspect discovered tools/resources/prompts.
- Choose a tool subset.
- Assign a connection to a Bot.
- Explicitly pick which Gmail/Slack account a Bot/Task should use (UI shows multiple accounts; action path does not consume that choice).
- Connect catalog `soon` tiles (including `mcp`, Zapier, Make, n8n).

`ConnectionsAppGrid` comments: "This page is INBOUND only" meaning apps LYKN reads/acts on, not LYKN-as-MCP-server.

---

## Local MCP support

**MISSING.**

Electron can spawn `/bin/zsh -lc`, `osascript`, and Python for Local Mode / exterior code tools.
That is not an MCP stdio client.

Missing: process lifecycle for MCP servers, stdio JSON-RPC, restart, sandbox distinct from Local Mode shell, package install (`npx`/`uvx`), stdout/stderr redaction, credential inheritance policy.

Security implication: a future local MCP launcher is equivalent to running untrusted code with inherited env.
Current Local Mode already treats shell as approval-gated.
A local MCP would need the same or stricter gate, plus tool-description distrust.

---

## Remote MCP support

**MISSING.**

There is no path from a user-supplied MCP URL to a client session.

Closest existing HTTP client is `callApp`:

- Host-pinned to a stored `base_url`
- SSRF guard
- Injected secret
- JSON/form HTTP, not MCP JSON-RPC

Missing: MCP initialize, tools/list, session/reconnect, MCP-OAuth, TLS identity beyond HTTPS URL, schema-change handling.

---

## Tool normalization

**No canonical semantic layer** for external services.

Existing capability languages (three, incompatible):

1. TaskRuntime / browser: `browser.read`, `browser.interact`, `files.write`, `local.shell.execute`
2. Model Builder: `web_search`, `api_request`, `search_vault`
3. mcp-tools `scope`: `'read' | 'write'`

There is no `communication.email.read`.

TaskRuntime depends on **raw tool/action names**.
Bot harness depends on `reply` / `browser` / `local_computer`.
Chat depends on `lykn_*`.

A future MCP classifier would have to sit **in front of** TaskRuntime capability checks and **after** MCP `tools/list`, because neither side shares a vocabulary with third-party MCP names (`search_messages`, `gmail_search`, …).

Best existing seam:

```
Task.capabilities (strings)
  → executor allowlists (already code-enforced for browser/local)
```

That string array is the right slot.
The grammar is not yet external-service-shaped, and nothing resolves those strings to connections.

---

## Capability model

Partial, executor-local, not provider-shaped.

- Browser capabilities are enforced three times (schema enum, normalizeDecision, executeAction).
- Local capabilities are enforced on the tool enum and again on shell shape.
- Bot capabilities on create are a blanket grant of the whole harness.
- Chat has no Task capabilities; it uses intent regex allowlists.
- Custom models map capabilities → chat tool names.
- Routines persist a capability envelope and refuse trigger-context expansion.

None of these represent `gmail.read`.

---

## Consequence / approval model

LYKN can classify **known** browser actions and **known** Bot tools.
It cannot classify dynamically discovered MCP tools.

Browser (`classifyActionRisk`):

- Independent of the model's `risk` field for gating.
- Regexes on labels/outcomes (Send, Share, Delete, …).
- Pauses for human Yes/No.
- Useful, not a semantic understanding of the real side effect.

Bot harness:

- Registry `risk` floor (`read` / `low` / `consequential`).
- Model may raise, not lower.
- `browser` is `low` because selecting it only parks opt-in.
- `local_computer` is `low` because LocalExecutor has its own approvals.
- `create_routine` is `low`.

Chat `lykn_call_app`:

- `scope: 'write'`
- Write methods blocked unless `allow_writes`
- Destructive confirmation is **prompt text only**
- Not wired into TaskRuntime approval

Chat other tools:

- Confirm-first lives in tool descriptions (`lykn_deleteProject`, `lykn_updateUserPreference`)
- Local write/edit/run require Electron approval tokens

For universal MCP this is a blocker:
untrusted `tools/list` descriptions cannot be trusted to self-report READ vs DESTRUCTIVE.

---

## Trust / security

No provider trust classification: official / verified / community / custom / local / enterprise.
No marketplace.
No MCP Registry client.

Prompt-injection defenses that **do** exist:

- Native function calling only (bracketed `lykn_*()` in user text is not dispatched).
- `prompt-sanitizer.js` strips tool-call/system markers from user content.
- Chat whitelist: model cannot invoke a non-whitelisted name.
- Browser/local capability allowlists in code.
- Routine compiler drops unwhitelisted trigger context.
- SSRF guards on `callApp` and `lykn_http_request`.
- Host pinning of custom connections.

Missing against untrusted MCP servers:

- No sanitizer for **tool descriptions** (they would be attacker-controlled).
- No isolation of MCP resource text vs system instructions.
- No "tool result cannot broaden capabilities" rule for MCP (Routines have a version of this for page observations).
- No schema-size / field-count caps for third-party tools (chat has `DESCRIPTION_CAP` only for first-party tools).
- No trust the MCP server as non-authority relative to Task (because there is no MCP layer).
- `callApp` already treats a connected API as a confused deputy: the model supplies path/body, LYKN attaches the user's token.

---

## Registry / discovery

No MCP Registry support.

Provider metadata is **hard-coded** in `src/lib/connectors/catalog.js` (large tile list) plus `CONNECTOR_REGISTRY` plus `CUSTOM_API_PRESETS`.

Catalog and registry are not 1:1.
The catalog includes dozens of `soon` / `no-api` brands.
The registry includes adapters whose catalog tiles may be filtered in or out by status.

Custom API presets (hard-coded): openai, anthropic, github, slack, notion, stripe, resend, sendgrid, linear, cursor, airtable, openweather, twilio, vercel, hubspot, figma, canva, atlassian, microsoft365.

---

## Tool-schema token cost

Measured from code, not a live token bill.

Chat default whitelist: **66** tools.
Each description clipped to **1000 characters** (`DESCRIPTION_CAP`).
Comment in `server.js`: full dump is treated as a **~34K-token** problem.

Local Mode adds **14** more schemas when enabled.

0 connections:

- Same 66 chat tools.
- `[CONNECTED_TOOLS]` omitted.

1 connection:

- Still 66 chat tools (connections do not add schemas).
- `[CONNECTED_TOOLS]` adds a few lines (provider name + up to 3 account labels).
- If custom/OAuth-action apps exist, `[CONNECTED_APPS]` adds slug/base_url/description (capped 25 custom + 10 OAuth-action; section clipped by `CONNECTED_TOOLS_SECTION_MAX_CHARS`).

5 connections:

- Still no extra function schemas.
- Prompt block grows linearly with names/hints.

Many tools:

- Cost is dominated by the **first-party chat whitelist**, not connections.
- Intent lean path (`resolveIntentChatToolNames`) can send a handful of tools instead of 66.
- Ambiguous asks fall back to the broad list (minus some maker/image tools).
- `messageWantsAgentTools` can skip the agent loop entirely for ordinary Q&A.

Bot harness is cheaper: 7-8 index lines, full docs loaded on first use.

Token-risk for future MCP:

- If every connected MCP's `tools/list` is merged into chat the way `CHAT_TOOLS` is, cost will explode.
- Current architecture does **not** send connected-provider tool schemas at all (because they do not exist).
- The future risk is introducing dynamic tools without a Task-scoped filter.

Drift: prompt tells the model to call `lykn_list_apps` / `lykn_call_app`, but those schemas are not on the chat wire.

---

## Dynamic filtering

Chat **can** expose a subset of **first-party** tools per turn:

- `resolveIntentChatToolNames`
- exclusive composer modes (research/image/translate)
- strip makers
- strip `lykn_list_apps` / `lykn_call_app` in agent/browser mode (currently a no-op because they are not in the whitelist)
- custom-model capability mapping

It cannot expose "only Gmail MCP" because there is no MCP.

Bot/Task filtering is by harness tool name, not connection.

Best future seam (not implemented):

```
Task.capabilities
  → CapabilityRegistry (does not exist)
  → ConnectionResolver (does not exist; slug lookup in callApp is the seed)
  → Relevant MCP tools
  → chat-agent-loop / BotExecutor tool list
```

`resolveChatTools(toolNames)` is the chat-side injection point.
Bot `registry.listTools({ localMode })` is the harness-side injection point.
TaskRuntime `task.capabilities` is the authority slot that browser/local already honor.

---

## Multi-account handling

DB allows multiple Gmail/GitHub accounts (`provider_user_id` uniqueness).

UI lists them and `[CONNECTED_TOOLS]` collapses up to three labels so the model can "disambiguate."

Execution:

- Vault sync runs **each** connection independently.
- Slack `callApp` uses **one** connection: newest `created_at`.
- Notion live refetch uses **one** connection: newest `last_synced_at`.
- Cursor can pin `connectionId` on a build.
- Browser agent uses **whatever account is signed into that browser profile**.
- Task does not carry `connectionId`.
- Model cannot choose a connectionId on chat tools because those tools are absent.

Wrong-account execution **can** occur on Slack action and Notion refetch.
It can also occur if a Bot browses a browser profile signed into work Gmail while the user meant personal.

---

## Error / reconnect behavior

| Failure | Current behavior |
|---|---|
| Auth expired + refresh exists | `runSync` refreshes, re-encrypts, continues |
| Refresh failed / decrypt failed | `status: 'reauth'`, skipped by poller |
| Provider 401/403 during sync | `ConnectorAuthError` → `reauth` |
| Repeated sync errors | `consecutive_errors`; after 3 → `error`; backoff on poll |
| User paused | skipped |
| User deleted | row gone; prompt cache invalidated; provider token may still live |
| MCP server offline | n/a |
| Tool schema changed | n/a (code registry) |
| Tool disappeared | n/a |
| `callApp` timeout | 15s; error object to caller |
| `callApp` rate limit | 30/min/user+host |
| Malformed tool result | chat loop JSON-parses best-effort; `TOOL_RESULT_CAP` 16k |
| Slack reauth during call | `{ error: 'reauth_required' }` message to reconnect in Connections |
| Chat `lykn_call_app` | tool not enabled (`tool_not_whitelisted_for_chat`) if the model emits it |

No MCP reconnect/session resume.

---

## Duplication

A universal layer could consolidate:

- OAuth start/callback/state/PKCE (already one framework for 32 providers; still duplicated conceptually with deleted inbound OAuth-provider).
- Token encrypt/decrypt (already shared).
- Connection list/pause/delete UI patterns (OAuth vs token vs custom API are three dialogs).
- Prompt "what is connected" (`fetchConnectedToolsSection` vs `lykn_list_apps` vs catalog).
- HTTP+SSRF (`callApp` vs `lykn_http_request` vs connector `fetch` helpers).
- Slack described twice (vault adapter + `OAUTH_ACTION_APPS` REST hints).
- GitHub twice (star sync adapter + Custom API preset).
- Notion twice (sync + live refetch).
- Voice vs chat tool names.
- Provider mapping (`chatTools.js` vs `lib/agentModelProviders.js`).

What should **not** be naively merged: Vault-sync adapters vs MCP action clients.
They have different jobs (index content vs call tools).

---

## Universal MCP readiness matrix

Target:

```
TaskRuntime
  → CapabilityRegistry
  → ExternalToolResolver
  → McpConnectionManager
  → McpClientRuntime (tools / resources / prompts)
  → Connected MCP servers
```

| Future component | Classification | Evidence |
|---|---|---|
| McpConnectionManager | MISSING | Catalog tile `soon`; `kind: 'mcp'` unused; no connect/discover/cache/status for MCP |
| McpClientRuntime | MISSING | No SDK, no JSON-RPC, no tools/list |
| CapabilityRegistry | PARTIAL | Task `capabilities[]` + three local grammars; no external-service ontology |
| ExternalToolResolver | PARTIAL | `callApp` slug lookup + `OAUTH_ACTION_APPS`; no MCP; Slack newest-account heuristic |
| MCP auth adapters | PARTIAL | Connector OAuth/PKCE/token-paste/AES blobs reusable; MCP OAuth/DCR-as-client missing |
| Registry/marketplace | MISSING | Hard-coded `catalog.js` only |
| Local MCP launcher | MISSING | Local Mode spawn is not MCP stdio |
| Remote MCP connector | MISSING | `callApp` is REST, not MCP |
| Tool classifier | MISSING | No READ/WRITE/DESTRUCTIVE classifier for unknown tools; browser regexes are page-action specific |

Per manager method:

| Method | Status |
|---|---|
| connect | MISSING (custom REST connect is the analogue) |
| authenticate | PARTIAL (connector OAuth/token) |
| discover tools | MISSING (`lykn_list_apps` lists connections, not tools) |
| discover resources | MISSING |
| discover prompts | MISSING |
| cache metadata | PARTIAL (`[CONNECTED_TOOLS]` cache only) |
| execute tool | PARTIAL (`runChatTool` / `callApp` / harness executors; none speak MCP) |
| disconnect | PARTIAL (connector/custom delete; no MCP session teardown) |

---

## Keep / Adapt / Replace / Delete Later

Do **not** delete anything in this audit pass.
This table is classification only.

| Piece | Recommendation | Why |
|---|---|---|
| `mcp-tools/` in-app registry | KEEP (rename later) | First-party LYKN tools; not MCP |
| `chat-agent-loop.js` + `resolveChatTools` | ADAPT | Injection point for Task-filtered tool lists |
| TaskRuntime `capabilities[]` | ADAPT | Right slot; wrong grammar for SaaS/MCP |
| Connector vault-sync adapters | KEEP | Product is "know my stuff"; MCP does not replace polling/embed |
| `connectors-service.js` OAuth/token/crypto | ADAPT | Become shared Connection Manager persistence/auth |
| `lykn_custom_connections` + `callApp` | ADAPT | REST lane; reserved `kind: 'mcp'`; host pin/SSRF/write gate |
| `OAUTH_ACTION_APPS` Slack hybrid | ADAPT then replace | Prototype of "OAuth connection → action tool"; account selection is unsafe |
| Cursor connector + build tools | KEEP | Distinct product surface |
| RSS | KEEP | Not MCP |
| Catalog `id: "mcp"` soon tile | REPLACE | Real connect flow, not a stub |
| Voice `runMcp` naming | ADAPT | Dispatcher is fine; name is misleading |
| Leftover `lykn_mcp_tokens` / `lykn_oauth_*` | DELETE LATER | Dead inbound MCP server state; confirm no production tokens first |
| Stale SECURITY_REPORT_* MCP-server claims | DELETE LATER / archive | Contradict HEAD |
| `lykn_http_request` | KEEP with caution | Must not become a backdoor around connection auth |
| Bot harness tool index | KEEP | Orthogonal to MCP; add an `external`/`mcp` tool only after resolver exists |
| Browser agent as Gmail/Notion operator | KEEP | Fallback when no MCP/API; do not treat as Connection Manager |

---

## Major architectural blockers

1. **No MCP client runtime or transport.**
2. **Chat whitelist omits the only generic external-action tools** (`lykn_list_apps` / `lykn_call_app`), while the prompt still advertises them.
3. **TaskRuntime has no connection identity** and no external-service capability grammar.
4. **Bots have global access** and no per-Bot connection assignment.
5. **Connectors are vault pullers**, not tool providers.
   Treating them as MCP would confuse two jobs.
6. **`messageWantsConnectedAppApis` is dead code**, so even intent routing toward connected APIs is unfinished.
7. **Hard-coded registries everywhere**; a new MCP tool cannot appear without a code change.

Arbitrary MCP is **not** feasible without major Agent Harness / chat-tool-pipeline work.
TaskRuntime itself does not need a rewrite to *store* capabilities, but every consumer that builds the model tool list does.

---

## Security blockers

1. Untrusted MCP tool descriptions/resources/prompts have no distrust boundary.
2. No dynamic consequence classification for unknown tools.
3. `callApp` is a confused deputy (model-chosen path + user token) with prompt-only destructive confirmation.
4. Multi-account action paths pick an implicit connection.
5. Disconnect does not revoke provider tokens.
6. Local MCP would be untrusted code execution; no launcher/sandbox exists.
7. Vault-sync already inserts provider content into model-visible notes; MCP resources would add another injection surface.
8. No official/community trust labels.

---

## Token / cost blockers

1. First-party chat already treats 66 schemas as expensive (~34K tokens) and added a lean allowlist to avoid sending them.
2. Naively concatenating MCP `tools/list` onto that list will blow the budget.
3. Bot harness progressive disclosure is the only existing pattern that does **not** ship full tool docs every turn.
4. `[CONNECTED_APPS]` already injects free-text API descriptions into the system prompt; MCP descriptions would be larger and adversarial.

---

## Recommended migration path

Five phases.
Do not implement them in this audit.

### Phase 1 - Finish the current action lane honestly

Reconnect `lykn_list_apps` / `lykn_call_app` to the chat whitelist **or** remove them from the prompt.
Call `messageWantsConnectedAppApis`.
Require explicit `connection` slug and, when multiple OAuth rows exist, explicit connection id.
Add Task/Bot-unaware but account-safe selection in `callApp`.
This makes Custom API + Slack-hybrid safe before MCP exists.

### Phase 2 - Connection Manager without MCP protocol

Lift `social_connections` + `lykn_custom_connections` behind one Connection record (`kind: oauth | token | rest | mcp`).
Keep vault-sync adapters as a **sync worker** on OAuth/token connections.
Give TaskRuntime `association.connectionIds` and capability strings that mean permissions, not raw MCP names.
Do not speak MCP yet.

### Phase 3 - MCP client runtime (remote HTTP first)

Implement McpClientRuntime: initialize, tools/list, tools/call, error/reconnect, schema cache.
Remote URL + bearer/API key only.
No stdio.
Discover tools into the Connection Manager cache.
Execute only through TaskRuntime-filtered allowlists.

### Phase 4 - MCP auth + classifier + distrust

MCP OAuth using the existing popup/state/PKCE bones.
Tool classifier (READ/WRITE/CONSEQUENTIAL) that does **not** trust the server's prose.
CapabilityRegistry maps classified tools → Task capabilities.
Prompt/resource text treated as untrusted data, never as system instructions.

### Phase 5 - Local MCP + registry UX

`npx`/binary stdio launcher behind Local Mode-class approvals.
Settings → Add Tool → URL / local command / search catalog.
Optional MCP Registry.
Only then consider replacing selected **action** adapters (Slack write, Gmail search) with MCP servers.
Keep vault-sync connectors until an MCP resource/sync story is real.

---

## Open product decisions

1. Is Vault-sync still a first-class job if MCP tools can read Gmail live?
   If yes, connectors stay; MCP does not replace them.
2. Are Connections global to the user, or assigned per Bot/Task?
   Current code is global.
3. When two Gmail accounts exist, who chooses: user at connect time, user per Task, or model?
   Current action code chooses silently.
4. Should LYKN remain not-an-MCP-server?
   Catalog says yes; leftover token tables say the old answer was no.
5. May a Routine call write-capable MCP tools under `standing_authorization`, or only read?
6. Is Custom REST (`callApp`) kept as a permanent non-MCP lane, or migrated into "generic HTTP MCP"?
7. What is an "official" MCP server vs a user-supplied URL, and who is liable for tool side effects?

---

## End-to-end execution traces

### Bespoke connector path (Gmail) - actual functions

1. User opens Settings → Integrations (`SettingsModal` → `ConnectionsAppGrid`).
2. Clicks Gmail → `OAuthConnectDialog` → `POST /api/connections/gmail/start` (`connectionsOAuth.routes.js`).
3. `createOAuthState` + `gmailAdapter.buildAuthUrl` (Google scopes `gmail.readonly`).
4. Callback `GET /oauth/callback/gmail` → `consumeOAuthState` → `exchangeCode` → `saveConnection`.
5. `runSync` → `decryptToken` → `syncGmail` in `connectors/google/gmail.js`.
6. Notes upserted as `source: gmail_starred` / `gmail_inbox`.
7. Later chat turn: `fetchConnectedToolsSection` may add `- Gmail (Work, Personal) — …`.
8. Model **cannot** call a Gmail tool.
9. If the user asks to "check my mail," typical live path is chat → `local_browser_agent` or Bot `browser` → `TaskRuntime` / `BrowserExecutor` → click gmail.com in the signed-in browser.

No MCP appears.

### Intended MCP-like path (Custom API / Slack action) - actual functions

1. User creates a custom connection (`POST /api/custom-connections`) or connects Slack OAuth.
2. Voice: realtime model emits `list_apps` / `call_app`.
3. `POST /api/ai/realtime/tool` → `runMcp('lykn_list_apps'|'lykn_call_app')`.
4. `callApp` loads `lykn_custom_connections` or `loadOAuthBackedConnection` (Slack newest row).
5. Decrypt secret, host-pin URL, SSRF check, inject Authorization, `fetch`.
6. JSON body returns to the voice model.

Chat: same tools exist in `mcp-tools/listApps.js` / `callApp.js`, but `runChatTool` refuses them as `tool_not_whitelisted_for_chat`.

There is **no** MCP JSON-RPC on either path.

---

## Validation notes

Verified against current HEAD, not stale SECURITY_REPORT MCP-server text.

Did not modify runtime.
Only this document was added.
