# First-party tool disclosure

Status: Phase B complete (Voice alignment, prompt cleanup, result bounding, dead-tool retirement).
Phase A (Chat progressive disclosure) is unchanged in principle.

Disclosure is not authorization.
Hiding a schema from the model is a token and accuracy optimization.
Execution still requires `runChatTool` (Chat whitelist ∩ per-turn `allowedToolNames` ∩ handler gates), Local Mode Electron approval, Voice `POST /api/ai/realtime/tool` dispatch, and TaskRuntime capability/consequence checks when Chat is running as a Task.

## Pipeline

```
Canonical first-party tool definitions
        ↓
Canonical capability metadata          mcp-tools/firstPartyCapabilities.js
        ↓
FirstPartyCapabilityResolver           request / context → families
        ↓
surface-specific resolver
     ┌───────┴────────┐
   Chat             Voice
   FirstPartyToolResolver    voiceToolResolver.js
        ↓                      ↓
bounded Chat tools        bounded Voice aliases
        ↓                      ↓
composeWithExternalTools  same MCP cap (≤10)
        ↓                      ↓
provider serializers      Realtime / custom-LLM tools[]
```

Provider adapters only serialize.
They do not choose tools.
There is no extra LLM routing call.

Bot Harness remains a separate tool surface.
Browser / Local / Remote action schemas are not forced into this registry.

## Capability families

Grammar is small and shared by Chat and Voice:

- `memory.read` / `memory.write`
- `prefs.read` / `prefs.write`
- `projects.read` / `projects.write` / `projects.destroy`
- `vault.read` / `vault.write`
- `calendar.read` / `calendar.write`
- `reminders.read` / `reminders.write`
- `tasks.read` / `tasks.write`
- `steward.read` / `steward.write`
- `web.search` / `web.read` / `web.http`
- `compute.math` / `compute.code` / `compute.time`
- `media.image` / `media.video` / `media.audio` / `media.parse` / `media.translate`
- `artifacts.build` / `artifacts.edit`
- `coding.cursor`
- `shell.open`
- `self.write`
- `local.files.read` / `local.files.write` / `local.apps` / `local.shell` / `local.desktop`
- `browser.agent`
- `connections.external` (MCP need; zero first-party Chat tools)

There is no always-visible core.
Ordinary conversation (`hello`) discloses **0** tools on Chat and Voice.

## Chat resolver

`resolveChatTurnDisclosure` maps families onto canonical Chat names, then optionally attaches ≤10 MCP tools.

Ambiguous but tool-capable turns do **not** receive the old 42-tool leftover dump.
The bounded fallback is **empty** (or Local discovery when Local Mode is on and the ask is local-shaped but unspecific).

## Voice resolver

Canonical Voice aliases live in `mcp-tools/voiceTools.js`.
That is the schema owner for the spoken surface.
Chat handler schemas stay on the Chat/MCP tools.

`resolveVoiceTurnDisclosure` reuses `resolveFirstPartyCapabilities`, then maps families onto Voice-supported names (`VOICE_TOOLS_BY_CAPABILITY`).

Voice-only adapters (kept):

- `search_vault` — live Voice vault search (`lykn_searchVault` under the hood; Chat still rejects it)
- `read_document` / `display_document` — hear vs show
- `add_to_project` — session-attachment clustering
- `update_voice_instructions` — client-only
- `create_project` / `get_project_state` — confirm-first / no-arg Voice contracts

OpenAI Realtime mints a session with **zero** tools (`create_response: false`).
After each transcript, `POST /api/ai/realtime/tools` returns the subset; the client `session.update`s (accumulating names for the live session) then `response.create`s.

ElevenLabs custom LLM filters `body.tools` to the same subset before the upstream model call.
Connection restrictions and consequence policy are unchanged.

`list_apps` / `call_app` stay an isolated custom-REST Voice lane.
They are not disclosed for Gmail/Slack/MCP asks and are not a hidden MCP fallback.

Retired Voice aliases (not in the live registry): `list_custom_models`, `communicate_with_model`, `get_facts`, `get_beliefs`, `propose_fact`.

## Prompt guidance

Static per-tool encyclopedias are gone.

`mcp-tools/chatToolGuidance.js` supplies:

- a small generic tool-use block
- family stubs only for disclosed capabilities
- Voice family stubs on custom-LLM turns

Create / Imagine still attach the existing visual / design / scheduling detail blocks in `server.js` when that turn needs them.

If a tool is not disclosed this turn, the prompt does not spend hundreds of tokens explaining it.

## Result bounding

`mcp-tools/toolResultBounds.js` clips oversized first-party results before they enter model context.
Chat applies it in `chat-agent-loop.js`.
Voice applies it in `/api/ai/realtime/tool`.

| Kind | Strategy |
| --- | --- |
| Small create/update | unchanged |
| Calendar / todo / project lists | cap 25 compact rows, drop decorative fields, keep ids |
| Vault search | cap 10 hits: `node_id`, title, snippet, match |
| Web search | snippets + ≤3 pages at 2k chars |
| HTTP | 8k body |
| `lykn_loadNeuron` / Voice `read_document` | full-read path kept, 16k cap |
| Local / Remote | existing limits; Chat does not re-expand |
| Universal MCP | MCP bounding stays in MCP |

## Legacy tools

Classified on current HEAD, not from the Phase A label alone:

| Tool | Class | Why |
| --- | --- | --- |
| `lykn_searchVault` | LIVE Voice / Chat-rejected | Voice `search_vault` still dispatches |
| `lykn_list_apps` / `lykn_call_app` | LIVE Voice isolated | Custom REST Connections still exist; not MCP |
| `lykn_listCustomModels` + orchestration four | FEATURE-GATED | Product/UI/runtime remain behind `CUSTOM_MODELS_ENABLED` |
| `lykn_proposeBelief` | DEAD | Runtime mapping removed; historical ChatNeuron kinds kept |

Universal MCP is the canonical external lane.

## Authorization

A model that emits a hidden name still hits:

- `tool_not_enabled_for_model` when the name is missing from this turn's allowlist
- `tool_not_whitelisted_for_chat` when the name is not in `CHAT_TOOLS_BY_NAME`
- Voice `unknown_tool` when the name is not in the Voice dispatch table

Progressive disclosure cannot bypass those gates and is not itself a security boundary.

Task capabilities, MCP consequence policy, Local approvals, Remote production approvals, and Browser approval gates are unchanged.

## Historical compatibility

Runtime deletion and renderer compatibility are distinct.
`toolStatusVerbs` still maps `lykn_searchVault` for old chats / Voice status.
ChatNeuron `belief` / `fact` / `concept` card kinds remain for saved threads.
`lykn_proposeBelief` is no longer a live status verb.

## Observability

Chat streams log capability ids, tool count, schema bytes, and approximate tokens.
Voice tools endpoint returns the same `inspect` shape.
Tests: `inspectFirstPartyDisclosure` / `measureChatToolSchemas` / `measureVoiceToolSchemas` (UTF-8 bytes / 4).
