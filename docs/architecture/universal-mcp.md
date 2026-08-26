# Universal MCP

LYKN is an MCP **client**. It is not an MCP server.

## Protocol

- SDK: `@modelcontextprotocol/sdk` 1.30.0
- Transport: Streamable HTTP (current recommended remote transport)
- Spec revision assumed: 2025-06-18 as implemented by that SDK
- Legacy HTTP+SSE: not implemented
- Local stdio: not implemented; the client runtime is transport-pluggable
- Authorization: MCP OAuth (see below). Bearer `credentialRef` remains supported.

## Runtime

```
TaskRuntime
  → CapabilityRegistry
  → ExternalToolResolver
  → ConsequencePolicy
  → McpConnectionManager
  → McpClientRuntime
       tools / resources / prompts
  → connected MCP servers
```

The MCP server is never Task authority.
TaskRuntime owns objective, capabilities, approvals, cancellation, and budgets.
No remote MCP response, prompt, description, annotation, or auth payload may override Task authority.

## Authorization

Standards path used by the pinned SDK:

1. RFC 9728 protected-resource metadata
2. RFC 8414 authorization-server metadata
3. Authorization-code + PKCE S256
4. SEP-991 URL-based client IDs when the AS advertises support and LYKN can publish HTTPS client metadata
5. RFC 7591 dynamic client registration as fallback
6. Optional pre-registered public client via `MCP_OAUTH_CLIENT_ID`

Not implemented: client_credentials, JWT bearer, device code, implicit, provider-specific Gmail OAuth.

Callback: `GET /oauth/mcp/callback`
Client metadata: `GET /oauth/mcp/client-metadata`

OAuth state is one-shot, 10-minute TTL, bound to `userId` + `connectionId`. Replay and expiry fail closed.

## Credential lifecycle

Raw tokens exist only in encrypted store (`oauth_encrypted` / `secret_encrypted` using the existing connector AES-GCM key).

The model, Task, Bot, Routine, schema cache, events, and UI see `credentialRef` only.

- Refresh uses the refresh token when present.
- `invalid_grant` → `authentication_required` / `connection_auth_required`.
- Disconnect deletes local credentials and calls RFC 7009 revocation when `revocation_endpoint` exists.
- If remote revocation is unavailable, local deletion still happens. That limitation is reported honestly.

Statuses: `connected`, `authentication_required`, `authorizing`, `refreshing`, `offline`, `error`, `revoked`, `disconnected`.

A Task that hits an expired connection pauses as `waiting_for_user` with `connection_auth_required`. It does not receive a token error. After the human completes Connect, the same Task may resume.

## Trust levels

`official` | `verified` | `community` | `custom` | `local_trusted` | `enterprise`

A user-entered URL is **custom** by default. TLS success does not promote trust.
`local_trusted` is an explicit loopback/fixture path. Trust never bypasses Task capabilities or consequence approval.

Server identity persists origin + authorization-server issuer. Origin/issuer changes are mismatches. Version upgrades are not.

## Tool classification

Deterministic classifier (`deterministic_v2`) on connect / refresh / schema change, not per Task.

MCP annotations are **signals**. A `readOnlyHint` cannot authorize a delete-named tool.

Unknown writes default to CONSEQUENTIAL.
Destructive name/schema indicators default to DESTRUCTIVE.
Permission/ACL tools default to SENSITIVE.

Optional model classification may run when deterministic confidence is low. Input is tool metadata only. Cached by schema fingerprint + classifier version. The model cannot lower the deterministic consequence floor.

Schema fingerprint mismatch blocks writes until reclassification.

## Consequence policy

| Class | Policy |
|---|---|
| READ | Execute |
| WRITE | Execute when Task capability explicitly permits. Low-confidence unknown writes escalate. |
| CONSEQUENTIAL | Live approval unless `standing_authorization` |
| DESTRUCTIVE | Live approval always |
| SENSITIVE | Live approval / human takeover |

## Multi-account

Connection identity is authoritative (`connectionId`, label, optional account identity).

READ may auto-select only when intent/association is unambiguous.
Consequential WRITE with multiple plausible accounts and no explicit association returns `ambiguous_account`.
Bots and Routines store `connectionIds` only. A missing/disconnected Routine connection becomes `connection_required` and does not pick another account.

## Prompts and resources

MCP prompts are discovered but never installed as system instructions (`untrusted_skill_candidate` / `provider_guidance`).
MCP resources are untrusted external content for the current Task. They are not auto-saved to Vault.

## Progressive disclosure

The model must not see every discovered tool.

Task → semantic needs → relevant connection(s) → small tool subset → model.

## Parallel stream

This work does not modify `electron/task-runtime/executors/remoteExecutor.cjs` or `electron/remote/**`.

## Deferred

- Local stdio MCP
- MCP Registry / marketplace
- Connector demolition
- First-party tool progressive disclosure migration
- Provider-specific Gmail/Drive/Notion/Slack/GitHub MCP adapters
- Enterprise auth beyond the generic MCP OAuth profile
