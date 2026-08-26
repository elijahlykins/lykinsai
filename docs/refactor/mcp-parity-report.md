# Universal MCP Phase 3 — External Service Replacement Parity

Status: proof complete.
Connectors were **not** deleted.
No tables were dropped.
No provider-specific LYKN execution files were added.

Companion architecture: `docs/architecture/universal-mcp.md`, `docs/architecture/memory-vault-connections.md`.
Earlier inventory (pre-runtime): `docs/refactor/mcp-connector-audit.md` (Phase 0; parts of that audit are stale now that Phase 1/2 exist).

---

## Baseline

Worktree: `.worktrees/universal-mcp` on `feat/universal-mcp`.

Phase 1: `101cf5e` `feat(mcp): add universal external tool runtime`

Phase 2: `01e6ac2` `feat(mcp): add universal authorization and tool trust`

This phase proves the universal runtime can replace provider-specific LYKN execution **without** demolishing the legacy connector-to-Vault path yet.

Product rule used as the test oracle:

NEED TO READ EXTERNAL DATA → LIVE MCP

USER EXPLICITLY SAYS SAVE → VAULT

Environment at proof time:

- No MCP server URLs in `.env`
- No Composio / Pipedream aggregator credentials
- Legacy OAuth client ids exist (`GOOGLE_CLIENT_ID`, `NOTION_CLIENT_ID`) for Vault-sync connectors only
- Those credentials were **not** used to call Gmail/Notion APIs from LYKN provider code

Live hosted Gmail / Drive / Notion / Slack / GitHub MCP was therefore **not** headed-tested.
Proofs below are Streamable HTTP MCP against representative in-process fixtures, plus the Phase 1/2 OAuth fixture.
That is still a real MCP client talking to a real MCP server over HTTP.
It is not a claim that a production Gmail MCP account was connected.

---

## Services tested

Four representative families, one URL-based MCP server each.
No `gmailConnector.js` / `notionConnector.js` / etc.

| Family | Role | Live or fixture | MCP source | Auth |
| --- | --- | --- | --- | --- |
| Communication / email | Work Gmail + Personal Gmail | Fixture (Streamable HTTP) | `tests/mcp/parityWorld.mjs` tools on `startFixtureMcpServer({ includeDefaults: false })` | none (loopback `local_trusted`) |
| Documents / files | Drive-like search/read/create | Fixture | same runtime, drive tool family | none |
| Documents / wiki | Notion-like search/read/write | Fixture | same runtime, notion tool family | none |
| Developer / source-control | GitHub-like issues/PR/delete | Fixture | same runtime, github tool family | none |
| Direct MCP openness | generic URL, zero provider id | Fixture | `lib/mcp/fixtures/testMcpServer.js` | none / bearer (Phase 1) |
| OAuth lifecycle | PKCE, refresh, revoke | Fixture | `lib/mcp/fixtures/oauthMcpServer.js` | MCP OAuth (Phase 2) |
| Aggregator (Composio/Pipedream) | optional | **Not tested** | credentials unavailable | — |

Connect path for every service:

Task → `inferCapabilityNeeds` → `ExternalToolResolver` → `McpConnectionManager.callTool` → MCP server

There is no adapter registry keyed by provider for execution.

---

## Live freshness proof

**Tested** (fixture).

Sequence in `tests/mcp/parityProof.test.mjs`:

1. Connect Work Gmail MCP.
2. Search Sarah. Hits do not include a contract mail.
3. Insert `{ id: 'em-new', from: 'Sarah Chen', subject: 'Latest contract' }` into the source inbox **without** reconnecting or waiting for a poller.
4. Search `contract` immediately.
5. `em-new` is returned.

This is the reason to replace sync architecture.
Vault embeddings, connector pollers, and `runSync` were not involved.
`world.vaultWrites` and `world.connectorSyncCalls` stayed empty.

Not claimed: freshness against a hosted Gmail API.

---

## Read/search parity

**Tested** (fixture, four families in one test).

| Ask | Inferred need | Connection selected | Tool | Vault? |
| --- | --- | --- | --- | --- |
| Find my newest email from Sarah. | `communication.email.search` / `.read` | Work Gmail | `search_messages` | no |
| Find the Q3 proposal in Drive | `documents.read` | Drive (not Gmail) | `search_files` | no |
| Find the roadmap page in Notion | `documents.read` | Notion | `search_pages` | no |
| Show the open PR for issue 183 | `source_control.read` | GitHub | `search_issues` | no |

Email tools were excluded from the documents resolution.
Document tools were excluded from the email resolution.

Path did **not** use:

- Vault connector sync
- Vault embeddings
- `CONNECTOR_REGISTRY`
- `lykn_call_app`
- synthesis chunks as the source of truth

---

## Ordinary write parity

**Tested** (fixture).

`create_draft` classified as `WRITE`.
`mcpCallRequiresApproval(..., preserve_executor_security_gates)` is false.
The draft is written into the source inbox with `draft: true`.
No send occurred.

Execution is `executeMcpTool` → manager `callTool`.
No provider-specific LYKN action function.

---

## Consequential parity

**Tested** (fixture, safe destination only).

Destination allowlisted to `sarah.fixture@lykn.test`.
Other recipients are rejected by the fixture.

Sequence:

1. Same Task, `send_email`, approval `not_requested` → `waiting_for_approval` / `approval_required`.
2. Inbox unchanged.
3. Same Task, `approval.state = approved` → MCP send.
4. Fixture stores a non-draft message to the safe address.

`delete_item` is `DESTRUCTIVE`.
Approval is required even under `standing_authorization`.
The delete handler was not invoked.

No production email, Slack post, PR merge, or real delete was performed.

---

## Multi-account

**Tested** (two connections, identical email tool capabilities).

- "Check my Work Gmail" with `association.connectionIds = [work]` → Work only.
- "Send this from Work Gmail" with explicit Work id → Work only.
- "Send this email" with Work + Personal both connected → `ambiguous_account`, zero tools, no arbitrary pick.

Real dual-account Gmail OAuth was not available.
The resolver behavior does not depend on provider-specific code.

---

## Bot

**Tested** (code-level).

Research Bot allowlist: Work Gmail + Notion.
Personal Gmail is connected in the world but not on the Bot.

Naming "Personal Gmail" in the objective does not select that connection.
`executeMcpTool` with `association.connectionIds = ['work','notion']` and `connectionId = 'personal'` returns `bot_connection_restricted` and does not call the tool.

---

## Routine

**Tested** (store + compile + Run-Now-style occurrence).

Durable Routine record keeps:

- `connectionId` (allowlist cleaned)
- `capabilities`
- `instructions`

It does **not** keep:

- access token
- refresh token
- OAuth state
- tool result history

A value matching `/token|secret|bearer/` is stripped at persist time.

Occurrence:

Routine → `compileRoutineTask` (fresh Task) → `ExternalToolResolver` → MCP search.

Disconnect the Routine connection → `connection_required`, empty tools, no fallback account, no Vault sync.

Reconnect → live MCP search succeeds again.

Scheduling time was not waited out.
The occurrence compiler is the same path Run Now uses.

---

## Explicit Vault save

**Tested** (contract + first-party tool names).

Read of Sarah's mail:

- MCP observation `persistToVault: false`
- `authority.mayAutoIngestVault: false`
- no vault write spy entries

"Find Sarah's latest contract email." does **not** plan a Vault save.

"Save that email to my Vault." plans the existing generic primitive.

Exact primitives (already in `CHAT_TOOL_NAMES`; not new ingestion):

| Content | Tool |
| --- | --- |
| Email body / snippet / text the user asked to keep | `lykn_createVaultNote` |
| Generated file / artifact the user asked to keep | `lykn_saveFileToVault` |
| URL the user asked to keep | `lykn_saveLinkToVault` |

Code: `lib/mcp/explicitVaultSave.js`.

This is the only intended external-data-to-Vault behavior.
No connector-specific ingestion was added.

---

## Automatic Vault side effects

**Confirm none** on MCP reads in this phase.

MCP observations and resources set `persistToVault: false`.
The MCP runtime files do not call `saveConnectorNote`, `embedAndStoreChunks`, `runSync`, or insert `notes` rows.

Exceptions (unrelated, already existed, not triggered by MCP read):

- User-driven Vault upload pipeline
- Vault reconciler for orphan storage objects (`jobs/vaultReconcilerJob.js`)
- Explicit chat tools listed above
- Legacy connector poller, still running if `CONNECTOR_POLLER_ENABLED=1` (not on the MCP path)

---

## Token disclosure

Phase 1/2 characterization **did not regress**.

Baseline still measured in `universalMcp.test.mjs`:

| Scenario | First-party tools | MCP tools | First-party tokens | MCP tokens | Total |
| --- | --- | --- | --- | --- | --- |
| Current chat dump | 66 | 0 | 29,201 | — | 29,201 |
| Email task (8 first-party + relevant MCP) | 8 | 10 | 1,980 | 343 | 2,322 |
| Documents among five servers | 8 | 10 | 1,980 | 371 | 2,350 |
| Simple chat (6 first-party, no MCP need) | 6 | 0 | 1,110 | — | 1,110 |

Phase 3 ecosystem stress (`parityProof.test.mjs`):

- 10 connections
- 550 discovered tools
- Email task → 10 MCP tools, 358 MCP schema tokens
- Documents task → 10 MCP tools, 386 MCP schema tokens
- `hello there` → zero MCP needs / zero MCP schemas
- Cap remains `MCP_BOUNDS.MAX_TOOLS_PER_DISCLOSURE = 10`

### First-party tool disclosure observation (do not refactor in this phase)

When the chat turn still attaches the full `CHAT_TOOLS` list, first-party schemas are ~29,201 tokens.
That is ~80× the MCP subset on an email task (~358 tokens).
The remaining context problem is first-party progressive disclosure, not MCP.
Leave that for a later cleanup phase.

`lykn_list_apps` / `lykn_call_app` are **not** in `CHAT_TOOL_NAMES`.

---

## Failure behavior

Structured connection states proven against `executeMcpTool`:

| Status | Model-facing reason |
| --- | --- |
| `authentication_required` | `connection_auth_required` |
| `authorizing` | `connection_auth_required` |
| `revoked` | `connection_auth_required` |
| `disconnected` | `connection_unavailable` |
| `offline` | `connection_unavailable` |
| `error` | `connection_unavailable` |
| `connected` + `invalid_grant` throw | `connection_auth_required` |

Raw strings such as `invalid_grant: refresh failed for client xyz` are not copied onto the result.
`refreshing` is a live-session state (Phase 2); it is not treated as a hard unavailability in `executeMcpTool`.

Token refresh: **fixture-proven in Phase 2**, not live-exercised against Google/Notion in Phase 3.

Schema change: Phase 2 `classificationIsStale` + write blocked with `schema_changed`. Not re-claimed as a new live OAuth test.

Tool removal: classified tool dropped from the connection cache → resolver omits it → `tool_not_in_resolution` does not call the stale tool.
A stale resolution that still names it fails with a structured MCP error, not a connector fallback.

---

## No-fallback proof

Mechanical:

MCP runtime files contain none of `CONNECTOR_REGISTRY`, `runSync(`, `pollDueConnections`, `saveConnectorNote`, `lykn_call_app`, `embedAndStoreChunks`:

- `lib/mcp/executeMcpTool.js`
- `lib/mcp/mcpConnectionManager.js`
- `lib/mcp/chatTurn.js`
- `lib/mcp/mcpClientRuntime.js`
- `lib/mcp/externalToolResolver.js`
- `electron/task-runtime/executors/mcpExecutor.cjs`

`server.js` MCP turn `catch` logs and skips.
It does not call `runSync` or `lykn_call_app`.

Runtime:

Offline connection → `connection_unavailable`.
Injected `callTool` (stand-in for connector sync / `callApp`) is **not** invoked.

`McpExecutor` surfaces `failed` with the MCP error.
It does not mention `legacy_connector`.

Malicious MCP result asking to delete local files cannot add `files.write` / `files.delete` to the Task.

---

## Provider parity matrix

| Provider | MCP server used | Live or fixture | Auth | Read/search | Ordinary write | Consequential | Multi-account | Bot | Routine | Explicit Vault save | Legacy equivalent | Safe to remove legacy adapter? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Gmail-like | fixture email family | Fixture | none | pass | `create_draft` pass | `send_email` + approval pass | Work/Personal pass | pass | pass | pass (generic note tool) | `connectors/google/gmail.js` | **Not yet.** Need a real Gmail MCP URL + account before demolition. Runtime does not need the adapter. |
| Drive-like | fixture drive family | Fixture | none | pass | `create_file` available | n/a this phase | n/a | n/a | n/a | pass (generic) | `connectors/google/drive.js` | Not yet. Same gap: hosted MCP. |
| Notion-like | fixture notion family | Fixture | none | pass | `write_page` available | n/a | n/a | allowlisted | n/a | pass | `connectors/notion.js` | Not yet. |
| GitHub-like | fixture github family | Fixture | none | pass | `create_issue` | `create_pull_request` classified; delete gated | n/a | n/a | n/a | pass | `connectors/github.js` | Not yet. Also: do not confuse with any parallel GitHub workflow stream. |
| Slack / Linear / Granola | — | **Not tested** | — | — | — | — | — | — | — | — | `connectors/slack.js`, `connectors/linear.js` | No. No MCP proof this phase. |
| Direct generic MCP | fixture URL | Fixture | none / bearer / OAuth fixture | pass | pass | pass | pass | pass | pass | pass | none | N/A (this *is* the replacement). |
| Aggregator | — | **Not tested** | — | — | — | — | — | — | — | — | none | Do not couple the product to an aggregator vendor. |

"Safe to remove legacy adapter?" is **no** for hosted providers until at least one real MCP for that family is connected in production-like conditions.
The execution architecture already does not need those adapters.

---

## MCP provider quality (fixture / protocol only)

Do not rank hosted vendors from this sample.

| Server | Trust | Tool quality | Schema quality | Auth quality | Latency | Reliability | Coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lykn-fixture` Streamable HTTP | `local_trusted` | deterministic, small | zod schemas, short descriptions | none on parity servers; OAuth fixture covers PKCE | local ms | stable in tests | representative verbs only |
| OAuth fixture (Phase 2) | `local_trusted` | protocol | PRM + AS metadata | RFC 9728 / 8414 / PKCE / refresh / revoke | local ms | stable in tests | auth lifecycle, not app coverage |

Hosted MCP quality for Marketplace defaults is **unknown** until real servers are connected.

---

## Direct MCP openness proof

**Proven.**

`mgr.connect(userId, { name, serverUrl, trustLevel: local_trusted })` has no provider id, no adapter import, and no LYKN Gmail/Notion module.

A newly named tool on that URL is classified and resolved with zero LYKN source registration (Phase 1 test, still passing).

---

## Aggregator proof

**Not performed.**
No Composio/Pipedream credentials or MCP URL were present.
Do not redesign around an aggregator.
If one is added later, it is just another row in `lykn_mcp_connections`.

---

## E2E scenarios (what was / was not run)

| # | Scenario | Result |
| --- | --- | --- |
| 1 | Find newest email from Sarah | Fixture MCP, Work account, no Vault |
| 2 | Draft a reply thanking her | Ordinary WRITE draft, no send |
| 3 | Send it | Approval → same Task → fixture send to `sarah.fixture@lykn.test` |
| 4 | Find the proposal in Drive and save to Vault | Drive MCP read + explicit save **planned** via `lykn_createVaultNote`; no auto-save |
| 5 | Research Bot Work Gmail + Notion | Only permitted connections |
| 6 | Routine Run Now | Fresh Task, MCP search, connectionId only |
| 7 | MCP offline | `connection_unavailable`, no legacy fallback |
| 8 | Malicious result asks to delete local files | No capability expansion |

Headed UI / production accounts: **not performed**.

---

## Legacy connector inventory

Target of demolition: **automatic external-app mirroring/synchronization**.
Not Vault itself.
Not TaskRuntime.
Not MCP.

### DELETE (Vault-sync / provider adapters)

- `connectors/**` (35 JS files, 9,998 lines) including `_save.js` and `_calendarEvent.js`
- `CONNECTOR_REGISTRY` and `runSync` / `pollDueConnections` / `makeConnectorPoller` in `connectors-service.js` (keep encrypt helpers until extracted)
- `server/routes/connectionsOAuth.routes.js` (538) — provider OAuth popup for Vault sync
- Provider tiles and sync dialogs: `OAuthConnectDialog.jsx`, `TokenConnectDialog.jsx`, `ConnectorDetail.jsx`, `VaultAppDock.jsx` (sync chrome)
- `src/lib/connectors/catalog.js` provider catalog (1,598) once MCP Marketplace exists
- `src/lib/vault/connectorSources.ts` (76) rollup map of `notes.source` slugs
- `scripts/rotate-connector-key.mjs` after MCP credentials no longer share `CONNECTOR_TOKEN_KEY` (or keep if encryption stays)
- `server.js` Notion live-refetch from `social_connections` (~ connector-token decrypt + `connectors/notion.js`)
- `server.js` poller boot (`CONNECTOR_POLLER_ENABLED`)
- SQL helper allowlists that exist **only** to fold synced sources: `vault_connector_source_counts()` body in `097_vault_connector_sources_sync.sql` (rewrite, do not drop `notes`)

### KEEP GENERIC

- Vault explicit upload / `src/lib/vault/uploadPipeline.ts`
- Vault embeddings for **Vault-owned** content
- `lykn_createVaultNote` / `lykn_saveFileToVault` / `lykn_saveLinkToVault`
- `jobs/vaultReconcilerJob.js` (orphan storage, not connector sync)
- TaskRuntime, NotificationService, Bot/Routine stores
- `lib/mcp/**` and `src/components/connections/McpConnectionsPanel.jsx`
- AES-256-GCM `encryptToken` / `decryptToken` (today in `connectors-service.js`; **extract** before deleting that file)
- SSRF URL policy reused by MCP
- Memory subsystem (`server/memory/**`)

### KEEP TEMPORARILY

- `lib/customConnections/customConnections.js` + `mcp-tools/callApp.js` + `mcp-tools/listApps.js` + `CustomApiDialog.jsx` — generic REST BYO-key lane, **not** Vault mirroring.
  Not in `CHAT_TOOL_NAMES`.
  Do not silently use it as MCP fallback.
  Revisit after MCP covers arbitrary HTTP/MCP URLs for power users.
- `lykn_custom_connections` table
- `lykn_mcp_tokens` (legacy inbound synthesis PAT, `044_lykn_mcp_tokens.sql`) — not connector sync; confirm whether any client still uses it
- `ConnectionsAppGrid.jsx` until MCP UI fully replaces the tile grid (today it already hosts `McpConnectionsPanel`)

### REPLACED BY MCP

- Live read/search/write/send for connected apps
- Multi-account selection
- Bot/Routine connection allowlists
- OAuth for **MCP servers** (`/oauth/mcp/callback`, `lykn_mcp_oauth_sessions`)
- Tool trust / consequence / bounded disclosure

### MIGRATE TO MCP UI

- Connections Settings surface (`SettingsModal` → `ConnectionsAppGrid`)
- Account labels / reconnect / disconnect copy
- Catalog "soon" MCP tile (already obsolete as a promise; the panel exists)

### UNKNOWN

None required for the sync demolition target.
Hosted MCP availability per vendor is a **blocker**, not an inventory unknown.

---

## DB legacy candidates

**Do not drop in this phase. Do not delete user data.**

| Object | Classification | Notes |
| --- | --- | --- |
| `social_connections` | runtime dead after MCP + data-retention | Encrypted tokens, sync counters, `last_synced_at`. Preserve until a migration copies nothing (MCP is a new table) and product agrees notes can remain without live sync. |
| `oauth_states` | runtime dead after connector OAuth removal | CSRF for Vault-sync OAuth. MCP uses `lykn_mcp_oauth_sessions`. |
| `notes` rows with connector `source` (`gmail_inbox`, `notion_page`, …) | data-retention | User-visible Vault items created by sync. **Keep**. Optionally stop treating them as live. |
| `lykn_synthesis_chunks` for those notes | data-retention | Embeddings of synced content. Keep until notes policy is decided. |
| `vault_connector_source_counts()` / `vault_manual_notes_for_graph()` | rewrite later | Hard-coded connector slug allowlists. Safe future change; not a drop. |
| `lykn_mcp_connections` / `lykn_mcp_oauth_sessions` | **keep** | Phase 1/2 MCP. |
| `lykn_custom_connections` | shared / keep temporarily | REST BYO keys. |
| `lykn_mcp_tokens` | shared / confirm | Inbound PAT for synthesis API; unrelated to connector sync. |

Safe future drop (after product approval, after token revoke, after UI gone): `social_connections`, `oauth_states`.
Not before.

---

## Exact demolition scope

Mechanical counts from this worktree (2026-08-26).

| Bucket | Files / unit | Lines |
| --- | --- | --- |
| Provider adapter JS (`connectors/**`) | 35 files / 32 registry ids | 9,998 |
| `connectors-service.js` (registry + sync + poller + encrypt) | 1 | 697 |
| Connector OAuth + connections routes | 2 | 653 |
| Legacy connection UI + catalog (excl. MCP panel) | 6 | 4,370 |
| `connectorSources.ts` | 1 | 76 |
| `rotate-connector-key.mjs` | 1 | 263 |
| Notion live-refetch + poller wiring in `server.js` | mixed | ~400 (not isolated; do not delete `server.js`) |
| **Adapter + sync + UI subtotal** | | **~16,000** |
| Custom REST lane (keep temporarily) | 5 | 1,924 |
| MCP panel (keep) | 1 | 294 |

Pollers / jobs:

- In-process `makeConnectorPoller` in `server.js` (interval `CONNECTOR_POLLER_INTERVAL_MS`, default 60s)
- Optional HTTP `POST /api/connections/poll-due`
- **No** dedicated `jobs/*connector*` worker file
- Vault reconciler is **not** a connector poller

OAuth:

- Legacy: `/oauth/callback/:provider` style in `connectionsOAuth.routes.js`
- MCP: `/oauth/mcp/callback` (keep)

Tests/scripts:

- Almost no dedicated `connectors/*.test.js`
- `scripts/rotate-connector-key.mjs`
- Catalog / Vault rollup unit usage via `connectorSources.ts`

Dependencies:

- Per-provider API clients live inside adapters (Octokit-style fetches, Notion SDK usage inside `notion.js`, Google APIs inside `connectors/google/*`)
- Shared: `CONNECTOR_TOKEN_KEY`, provider `*_CLIENT_ID` / `*_CLIENT_SECRET`
- MCP does not need those provider client secrets if the MCP server does its own OAuth

**Estimated deletion once approved:** ~16k lines of adapter/sync/UI, plus poller wiring, plus later SQL drops of `social_connections` / `oauth_states`.
Plus a smaller follow-up if custom REST is retired.

Prefer **one** demolition phase after blockers below, in this order:

1. Stop sync jobs/pollers (`CONNECTOR_POLLER_ENABLED` off, remove boot).
2. Remove provider adapter code and `CONNECTOR_REGISTRY`.
3. Remove connector → Vault ingestion (`_save.js`, adapter `sync()`).
4. Remove sync UI/status; keep MCP panel.
5. Remove Notion live-refetch and chat "connected apps" lists that read `social_connections`.
6. Extract `encryptToken`/`decryptToken`; then delete leftover `connectors-service.js` sync.
7. Remove obsolete provider OAuth routes/registry.
8. Remove dead tests/scripts/env client secrets.
9. Preserve DB data until a separate approved migration.
10. Validate no runtime imports of `connectors/`.

Do **not** execute that list in Phase 3.

---

## Blockers before demolition

1. At least one **real** hosted MCP per family we still advertise (Gmail or Workspace, Drive or Notion, GitHub or Linear).
2. Extract shared encryption out of `connectors-service.js` so MCP routes do not import a file being deleted.
3. Product decision on existing synced `notes` (keep as historical Vault vs hide vs user export).
4. Replace Settings catalog tiles with MCP URL / future Marketplace without stranding connected users.
5. Confirm custom REST (`lykn_call_app`) is either kept as a separate power-user surface or also replaced by MCP.
6. Confirm inbound `lykn_mcp_tokens` still has users.
7. Do not collide with parallel RemoteExecutor / GitHub workflow work on main.
8. Headed pass of MCP Settings UI (Phase 2 noted this was not browser-exercised).

---

## Tests

Added:

- `tests/mcp/parityProof.test.mjs`
- `tests/mcp/parityWorld.mjs` (test metadata only)
- `lib/mcp/explicitVaultSave.js` (contract, not an adapter)

`package.json` `test:mcp` includes the new file.

Run this phase:

| Suite | Result |
| --- | --- |
| `npm run test:mcp` (56 tests: Phase 1+2+3 + McpExecutor) | pass |
| `npm run test:server` (45) | pass |
| `npm run test:security` (11) | pass |
| Routine store + `compileRoutineTask` + McpExecutor (23) | pass |

Not re-run here (unchanged, out of scope): full Electron browser/local/remote packs, `test:memory`, `test:agent`, `vite build`, `typecheck`.
RemoteExecutor was not modified.

Baseline comparison: Phase 1 email-task total **2,322** tokens (8 first-party + 10 MCP) still holds.
66 first-party tools still **29,201** tokens.

---

## Runtime behavior differences

After Phase 3, vs legacy connectors:

- External data is live at call time, not last `sync_interval_minutes`.
- Writes go to the source app through MCP + Task capabilities/approvals.
- Failures are structured MCP states, not a quiet Vault miss and not `lykn_call_app`.
- Multi-account writes refuse to guess.
- Bots cannot be talked into a disallowed connection.
- Routines store ids, not tokens.
- MCP reads do not mint Vault rows.

Still true until demolition:

- Connector poller can still mirror into Vault if enabled.
- Chat may still mention synced connector content via `[WHAT_IVE_SAVED]` if those notes exist.
- Those paths are legacy and were not used by the MCP proofs.

---

## Git

Commit message for this phase:

`test(mcp): prove external service replacement parity`

Stop after that commit.
Do not begin connector demolition.
