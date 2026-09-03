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

User-owned cloud rows (service-role)
→ `lib/security/userOwnedAccess.js` (userId required)

Explicit retained content
→ Vault

External application data
→ Universal MCP / live source

## Credentials

Credential persistence/encryption
→ credentialStore

Desktop sign-in on this machine
→ desktopSessionStore (`electron/auth`)

Managed app connections (OAuth via Composio)
→ LYKN Connection Service (`lib/connections`); tool access flows through Universal MCP rows owned by `managedToolBridge`

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

Chat model / economics routing
→ server/ai/chatRouting

Model registry / capabilities
→ lib/models

Inference gateway / OpenRouter adapter
→ lib/inference

Normalized usage events
→ lib/usage (Usage Balance stays in lib/billing)

User model settings and named routes
→ lib/models/userModelSettings.js + server/routes/modelPlatform.routes.js

Chat context / prompt-cache pipeline
→ server/ai/contextPipeline

Usage Balance / prepaid dollar ledger
→ lib/billing (usageBalance)

Desktop auto-update
→ electron/updater

In-account product update
→ src/lib/productUpdate.js

LyknChat.tsx
→ Chat page composition

Vault.jsx
→ Vault page composition

Public marketing site
→ standalone `LYKN Landing` repo (see LANDING_SEPARATION.md). This app still serves a temporary copy.

## Invariant

No new subsystem may independently implement a responsibility assigned above.
Do not add a second lifecycle owner, fallback runtime, or compatibility fork unless an explicit compatibility requirement says so.
