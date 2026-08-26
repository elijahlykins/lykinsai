# Universal MCP

LYKN is an MCP **client**.
It is not an MCP server.
It is an open MCP client.
Composio, Pipedream, Zapier, or any other aggregator is never architectural authority.

## Protocol

- SDK: `@modelcontextprotocol/sdk` 1.30.0
- Remote transport: Streamable HTTP (current recommended remote transport)
- Local transport: official SDK `StdioClientTransport`
- Spec revision assumed: 2025-06-18 as implemented by that SDK
- Legacy HTTP+SSE: not implemented
- Authorization: MCP OAuth (see below).
  Bearer `credentialRef` remains supported.

```
LYKN MCP Runtime
    ├── Direct Remote MCP
    ├── Local MCP / stdio
    ├── Marketplace-discovered MCP
    └── Aggregator MCP
```

All four are `McpConnection` rows.
Only the transport and source metadata differ.

## Runtime

```
TaskRuntime
  → CapabilityRegistry
  → ExternalToolResolver
  → ConsequencePolicy
  → McpConnectionManager
  → McpClientRuntime
       Streamable HTTP  |  stdio
       tools / resources / prompts
  → connected MCP servers
```

The MCP server is never Task authority.
TaskRuntime owns objective, capabilities, approvals, cancellation, and budgets.
No remote MCP response, prompt, description, annotation, catalog text, or auth payload may override Task authority.

External app data remains authoritative.
Marketplace installs **connections**, not Vault syncs.

## Marketplace / catalog

Catalog entries are untrusted discovery metadata.

```
McpCatalogEntry {
  id, name, description, icon, categories,
  connectionType, remoteUrlTemplate?, localPackage?,
  authExpectation, trust, source
}
```

Sources:

- LYKN curated recommendations
- Official MCP Registry (`https://registry.modelcontextprotocol.io/v0.1/servers`)
- Aggregator adapters (optional, later)
- Manual / custom URL or local command

Marketplace text never becomes model system instructions.
Trust labels come from LYKN source policy, not from a listing that calls itself Official.
A community result that says "Official Gmail" stays Community.

Search ranks name, description, capabilities, verified trust, then popularity.
Categories stay small: communication, documents, productivity, development, crm, calendar, finance, other.

Connecting a remote catalog entry creates an `McpConnection` and reuses the existing manager + OAuth path.
It does not install a provider-specific executor.

## Remote MCP UX

Add MCP URL remains a first-class path.
LYKN validates the URL, applies SSRF policy, connects, discovers identity/tools, and handles OAuth through the existing MCP auth stack.

## Local stdio MCP

A local connection stores:

- `command`
- `args[]`
- safe `workingDirectory`
- `envCredentialRefs`
- trust and catalog metadata

It does not persist raw environment secrets, tool results, screenshots, or process output.

Launch is argv-direct.
`shell: true` is not used.
`npx package`, `node server.js`, `python server.py`, and a local binary are parsed into `command` + `args`.
`npx` / `uvx` / `bunx` require an explicit user confirmation before `-y` is added.

Local MCP servers are executable programs.
New local connections require that explicit user action.
Later tool calls follow Task capability + consequence policy.
Transport being local does not add a per-invocation approval gate.

### Process lifecycle

`createLocalMcpProcessManager` owns start, health, bounded restart, stop, and crash detection.

- **Lazy start.**
  Configured local servers are not launched at app or API boot.
  `ensureRuntime` / Connect starts one server when needed.
- **Idle shutdown.**
  Unused local processes can stop after 15 minutes.
  An active Routine may pin a connection.
- **Crash.**
  Bounded backoff (3 restarts).
  Then the connection is marked `error` / offline.
  No tight restart loop.
- **Cancel.**
  Task cancellation aborts the in-flight tool call.
- **Delete / disconnect.**
  Kills the owned child.
- **Process exit.**
  The API process shutdown hook stops remaining children.
  Children are not detached, so they do not survive the parent.

Resolved env secrets exist only in the child process environment at launch.
The trusted runtime resolves `envCredentialRefs` from `credentialStore`.
They never appear in model context.

## Trust UX

`official` | `verified` | `community` | `custom` | `local_trusted` | `enterprise`

Displayed as Official, Verified, Community, Custom MCP, Local MCP, Enterprise.
Community is not presented as audited.

A user-entered URL is **custom** by default.
TLS success does not promote trust.
`local_trusted` is the explicit local/loopback path.
Trust never bypasses Task capabilities or consequence approval.

## Connection assignment

Bots and Routines store `connectionIds` only.

- Missing / undefined Bot `connectionIds` = all user connections (existing product default).
- Empty array = no external connections.
- A Routine keeps the specific connection it was given.
  Disconnect becomes `connection_required` and does not pick another account.

If a user later replaces a Composio Gmail connection with an official Gmail MCP, they reselect `connectionId`.
No automatic migration in this phase.

## Missing capability

When a Task needs a capability no connected server provides, ExternalToolResolver returns `missing_capability` plus catalog suggestions.
The UI may offer Connect Gmail.
The model must not invent OAuth URLs or browse/install MCP servers.

Activity shows authorization-waiting and missing-capability items as Needs Attention.
That reuses the existing Activity surface.

## Aggregators

An aggregator endpoint is just another MCP source.
There is no vendor SDK and no mandatory aggregator.
If a catalog entry is provided through Composio, the user sees **Gmail** and "Provided through Composio".
The stored connection still keeps source metadata for debugging.

## Authorization

Standards path used by the pinned SDK:

1. RFC 9728 protected-resource metadata
2. RFC 8414 authorization-server metadata
3. Authorization-code + PKCE S256
4. SEP-991 URL-based client IDs when the AS advertises support and LYKN can publish HTTPS client metadata
5. RFC 7591 dynamic client registration as fallback
6. Optional pre-registered public client via `MCP_OAUTH_CLIENT_ID`

Marketplace quick-connect uses this same stack.
It does not implement a second OAuth client.

Not implemented: client_credentials, JWT bearer, device code, implicit, provider-specific Gmail OAuth.

Callback: `GET /oauth/mcp/callback`
Client metadata: `GET /oauth/mcp/client-metadata`

## Credential lifecycle

Raw tokens exist only in encrypted store (`oauth_encrypted` / `secret_encrypted` / `lykn_credentials` using the existing AES-GCM key).

The model, Task, Bot, Routine, schema cache, events, and UI see `credentialRef` only.

## Tool classification

Deterministic classifier (`deterministic_v2`) on connect / refresh / schema change, not per Task.

MCP annotations are **signals**.
A `readOnlyHint` cannot authorize a delete-named tool.

## Progressive disclosure

The model must not see every discovered tool.
Marketplace entries are not loaded into prompt context.

Task → semantic needs → relevant connection(s) → small tool subset → model.

Connection detail shows grouped capabilities (Search / Read / Send requires approval), not raw JSON Schema by default.

## First-party GitHub

First-party GitHub workflows remain.
A GitHub MCP connection may coexist.
ExternalToolResolver only sees MCP tools.
If both are plausible and no connection is assigned, first-party GitHub stays in the first-party set and MCP GitHub waits for an explicit assignment.
This phase does not migrate providers.

## Calendar

Calendar still owns Google/Apple through the dedicated Calendar service.
This phase does not force Calendar through Marketplace/MCP.

## Prompts and resources

MCP prompts are discovered but never installed as system instructions.
MCP resources are untrusted external content for the current Task.
They are not auto-saved to Vault.
V1 does not add a giant resource browser.

## Parallel stream

This work does not modify `electron/task-runtime/executors/remoteExecutor.cjs` or `electron/remote/**`.

## Deferred

- Teach-by-Demonstration
- First-party tool progressive disclosure (the 66-tool / large schema issue)
- General cleanup
- DB legacy drops
- Cloud companion
- Mobile
- Enterprise auth beyond the generic MCP OAuth profile
