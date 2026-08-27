# LYKN Canonical Ownership

Keep this file short and current.
Architecture details and audits live elsewhere.

## Execution

Task lifecycle
→ TaskRuntime

Task compilation
→ TaskCompiler

Bot execution
→ BotExecutor

Browser execution
→ BrowserExecutor

Local execution
→ LocalExecutor

Remote execution
→ RemoteExecutor

MCP tool execution
→ McpExecutor

## Automation

Schedules and monitoring
→ RoutineRuntime

Learned workflows
→ WorkflowDefinition + canonical TaskRuntime execution

## Data

Personal durable memory
→ Markdown Memory (`server/memory`)

Explicit retained content
→ Vault

External application data
→ Universal MCP / live source

## Credentials

Credential persistence/encryption
→ credentialStore

## Product Integrations

Calendar
→ Calendar service

GitHub / remote coding
→ RemoteExecutor and first-party GitHub tools

## Composition Roots

server.js
→ server construction/registration only

electron/main.cjs
→ Electron construction/lifecycle only

electron/agentRuntime.cjs
→ Agent session host (routing and projection only; Task lifecycle stays in TaskRuntime)

electron/overlay.js
→ Glass overlay renderer bootstrap

LyknChat.tsx
→ Chat page composition

Vault.jsx
→ Vault page composition

## Invariant

No new subsystem may independently implement a responsibility assigned above.
Do not add a second lifecycle owner, fallback runtime, or compatibility fork unless an explicit compatibility requirement says so.
