# Universal MCP — Phase 1

LYKN is an MCP **client**. It is not an MCP server.

## Protocol

- SDK: `@modelcontextprotocol/sdk` 1.30.0
- Transport: Streamable HTTP (current recommended remote transport)
- Spec revision assumed: 2025-06-18 as implemented by that SDK
- Legacy HTTP+SSE: not implemented
- Local stdio: not implemented in Phase 1; the client runtime is transport-pluggable
- MCP OAuth: not implemented. A 401 becomes `authentication_required`. Bearer token references are supported. OAuth is not faked.

## Runtime

```
TaskRuntime
  → CapabilityRegistry
  → ExternalToolResolver
  → McpConnectionManager
  → McpClientRuntime
       tools / resources / prompts
  → connected MCP servers
```

The MCP server is never Task authority.
TaskRuntime owns objective, capabilities, approvals, completion, cancellation, and budgets.

## Progressive disclosure

The model must not see every discovered tool.

Task → semantic needs → relevant connection(s) → relevant MCP server → small tool subset → model.

Target: relevant subset ideally under 10 tools unless more are legitimately required.

Measured on this branch:

- Current first-party chat schemas: 66 tools, about 29k schema tokens
- Email-shaped Task with 100 discovered external tools: model sees ≤10 MCP tools
- Simple chat with no external need: 0 MCP tools

## Security

- SSRF on remote MCP URLs (`lib/mcp/urlPolicy.js`)
- HTTPS required for remote; loopback only with `trustLevel: local_trusted`
- Tool descriptions and results are untrusted and cannot change Task/Bot/Routine/Memory authority
- Credentials use `credentialRef`; secrets never enter Task, events, prompts, or public connection JSON
- Consequence gating at the MCP boundary
- MCP calls observe Task cancellation
- Connection rows are owned by `user_id`

## Bot / Routine seam

Bots and Routines may store `connectionIds` (never tokens).
A Routine occurrence compiles a fresh Task; ExternalToolResolver uses those ids.

## Parallel stream

This work does not modify `electron/task-runtime/executors/remoteExecutor.cjs` or `electron/remote/**`.

Likely later merge seams:

- `Task.association.connectionIds`
- `sanitizeBotProfile` / `createBotTask` in `electron/agentRuntime.cjs`
- `compileBotTask` / `compileRoutineTask`
- Express route registration order (`registerMcpRoutes`)

## Deferred

- Full MCP OAuth
- Local stdio MCP
- MCP Registry / marketplace
- Connector demolition
- First-party tool progressive disclosure migration
- Provider-specific Gmail/Drive/Notion/Slack/GitHub MCP adapters
