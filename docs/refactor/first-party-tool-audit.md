# LYKN first-party tool / context architecture audit

**Date:** 2026-08-26
**Mode:** audit only.
**HEAD:** `d9224d4` (`feat(agent): add remote execution and github workflows`) on `main`.
**Working tree:** tool registries in `mcp-tools/**` match HEAD.
Uncommitted `server.js` edits in this workspace do not change tool names, schema converters, or the intent-filter pipeline.
**Concurrent streams (do not collide):** Teach-by-Demonstration worktree; Universal MCP worktree.
**Constraint:** no source modifications except this file.

Token estimates use UTF-8 bytes / 4, which is the same engineering estimator used in `docs/refactor/agent-harness-audit.md` comments for mixed JSON.
JSON schemas with punctuation can tokenize slightly denser.
Bytes are authoritative.
Tokens are approximate.

This is not an MCP migration.
Internal LYKN tools should remain internal.

`mcp-tools/` is a **legacy name for the in-process first-party registry**.
It is not the Model Context Protocol.
Current HEAD is neither an MCP client nor an MCP server.
Universal MCP lives in `.worktrees/universal-mcp` and is cited only as the proven external-tool pattern to evaluate against.

---

## Executive summary

LYKN already does **partial** progressive disclosure for first-party Chat tools.
It does not do it as a capability architecture.

The Chat model-callable allowlist is **66 tools**.
The full OpenAI `tools[]` JSON for that allowlist is **91,464 bytes (~22.9K tokens)** after the 1,000-character description clip.
Unclipped MCP-style descriptions would be **~118K bytes (~29.6K tokens)**.
That unclipped figure is the origin of the "~29K tool-schema tokens" characterization.
`server.js` comments still say "~34K-token CHAT_TOOLS dump".
Those comments are stale versus the clipped measurement.

Simple chat does **not** ship that dump.
`"hello"` hits the casual-turn gate and the lean no-action-intent gate and ships **0 tool schemas**.
The expensive path is the **ambiguous-intent fallback**: when `resolveIntentChatToolNames` returns `null` but `messageWantsAgentTools` stays true, Chat still ships **42 first-party schemas (~13.2K tokens)** after maker/project strips, or **56 (~16.1K tokens)** with Local Mode.

That leftover set still mixes Memory, Vault writes, calendar, to-dos, steward, math, HTTP, and open-app.
It is already filtered.
It is not capability-scoped.

Universal MCP (worktree, not HEAD) already does Task → infer need → ≤10 external tools.
First-party Chat can reuse that **philosophy** without changing Task semantics:
a `FirstPartyCapabilityResolver` would sit beside `ExternalToolResolver`, both feeding one provider-formatted `tools[]`.
Execution must stay independent of disclosure.
`runChatTool` already rejects names outside `CHAT_TOOLS_BY_NAME` and the per-turn `allowedToolNames`.
Disclosure is not the security boundary today, with one caveat: Local Mode tools are authorized by the turn's `localMode` flag plus Electron approval, not by Task capabilities.

Bot Harness already has the right second-stage pattern (index → load full doc → decide again) and must **not** be merged into Chat.
TaskRuntime already has the right authorization pattern (`capabilities[]` → allowlist → refuse) for browser, local, remote, and GitHub.
Chat does not use TaskRuntime.

Recommended work is two phases only:
**Phase A** canonical first-party capability metadata + Chat disclosure resolver.
**Phase B** Voice alignment, result bounding, prompt cleanup.
Do not start by deleting tools.

---

## Current tool count

| Surface | Model-callable tools | Notes |
|---|---:|---|
| Chat allowlist `CHAT_TOOL_NAMES` | **66** | All 66 resolve to live handlers. |
| Full `LYKN_TOOLS` registry | **43** | Voice/MCP-named in-process tools. 4 are **not** in Chat. |
| Exterior / capability tools | **21** | All 21 are in the Chat 66. |
| Local Mode schemas | **14** | Offered only when desktop `localMode` is true. |
| Voice server defs | **35** | Different names; most map to `lykn_*`. |
| Overlay voice client | **34** | Drifted vs server. |
| ElevenLabs chat voice client | **33** | Drifted vs server. |
| Bot Harness index | **8** | Capability tools, not Chat schemas. |
| Browser-agent actions | **20** | Structured actions, not Chat tools. |
| Local decision loop | **13** | Subset of Local Mode; no `local_browser_agent`. |
| Remote decision loop | **5** | TaskRuntime only. Not Chat. |
| First-party GitHub | **13** | TaskRuntime only. Not Chat. |
| Soft-unplugged custom-model tools | **4** | Defined; not in `CHAT_TOOL_NAMES`. `CUSTOM_MODELS_ENABLED=false`. |

Mechanical Chat count on this HEAD: **66**.
The historical "66" is still correct.

Chat-hidden but live in `LYKN_TOOLS`:

- `lykn_searchVault`
- `lykn_listCustomModels`
- `lykn_list_apps`
- `lykn_call_app`

Defined in `mcp-tools/` and imported by `chatTools.js`, but **not** in `CHAT_TOOL_NAMES`:

- `lykn_delegate_to_sub_model`
- `lykn_list_sub_model_tasks`
- `lykn_get_sub_model_task`
- `lykn_communicate_with_model`

---

## Current token cost

Measured with `buildOpenAiTools()` / `toOpenAIToolSchema()` from `mcp-tools/chatTools.js`.
Description clip = 1,000 characters (`DESCRIPTION_CAP`).

| Pack | Tools | Schema bytes | ~tokens (bytes/4) |
|---|---:|---:|---:|
| Full Chat OpenAI `tools[]` | 66 | 91,464 | **22,866** |
| Full Chat Anthropic `tools[]` | 66 | 89,550 | 22,388 |
| Unclipped descriptions (same 66) | 66 | ~118,254 | **~29,564** |
| Clipped description bytes only | 66 | 44,002 | 11,001 |
| Raw unclipped description bytes | 66 | 70,792 | 17,698 |
| Parameter-schema bytes only | 66 | 40,297 | 10,074 |
| Fallback Chat (no image/speech/chart/diagram) | 62 | 87,063 | 21,766 |
| After maker strip | 54 | 72,449 | 18,112 |
| After maker + project strip (ambiguous regular) | 42 | 52,802 | **13,201** |
| Same + Local Mode | 56 | 64,333 | 16,083 |
| Lean web | 2 | 2,127 | 532 |
| Exclusive Imagine | 2 | 2,883 | 721 |
| Lean vault-save | 4 | 8,337 | 2,084 |
| Lean project | 10 | 16,728 | 4,182 |
| Lean calendar/todos/reminders | 12 | 21,128 | 5,282 |
| Local Mode schemas alone | 14 | 11,532 | 2,883 |
| Tiny core candidate (5) | 5 | 4,178 | 1,045 |

Where the ~29K figure comes from:

1. Tool **descriptions** are written as long MCP-style prose.
2. `clipDescription` cuts each description to 1,000 characters before provider serialization.
3. Unclipped 66-tool OpenAI JSON is ~29.6K tokens.
4. Clipped shipped JSON is ~22.9K tokens.
5. `server.js` still comments "~34K-token CHAT_TOOLS dump" and "~30K" tool guidance.
   Those comments overstate current clipped schema cost and mix schema cost with prompt guidance.

The ~29K cost is introduced in `mcp-tools/chatTools.js` at `toOpenAIToolSchema` / `buildOpenAiTools(undefined)` when the stream path falls through to the full (or near-full) whitelist.
It is **not** introduced by provider-specific formatting.
Anthropic is slightly smaller.
Gemini sanitizes keywords but does not shrink descriptions.

Prompt guidance is a second bill:

| Block | Bytes | ~tokens |
|---|---:|---:|
| `LYKN_CHAT_TOOL_GUIDANCE` (always-on when tools on and not lean) | 24,510 | 6,128 |
| `TOOL_GUIDANCE_VISUAL` | 4,362 | 1,091 |
| `TOOL_GUIDANCE_SCHEDULING` | 4,108 | 1,027 |
| `TOOL_GUIDANCE_EXTERIOR` | 2,456 | 614 |
| `TOOL_GUIDANCE_AGENTS_APPS_CODE` | 1,134 | 284 |
| Artifact/app/minimal edit blocks | 557–1,505 | 139–376 |
| `buildSlimChatToolGuidance` | ~591 | ~148 |
| Stream persona (contains tool policy, not schemas) | ~13,875 | ~3,469 |

A tool-on turn that misses the lean path can therefore spend **~23K schema tokens + ~6K–9K tool-guidance tokens** before conversation.

---

## Registry map

Competing registries, current HEAD:

| Registry | Source of truth | Schema format | Allowlist | Execution router | Prompt documentation | Filtering |
|---|---|---|---|---|---|---|
| **Chat** | `mcp-tools/chatTools.js` `CHAT_TOOL_NAMES` | MCP-shaped `{name,description,inputSchema,handler}` → OpenAI / Anthropic / Gemini | Explicit 66-name whitelist | `runChatTool` → handler; local names → Electron | `LYKN_CHAT_TOOL_GUIDANCE` + gated `TOOL_GUIDANCE_*` + slim lean block | Intent regex, composer mode, maker strip, project strip, Glass strip, casual/lean gates |
| **LYKN in-process ("MCP")** | `mcp-tools/index.js` `LYKN_TOOLS` | Same objects | Full 43 | Voice `runMcp`; Chat only if also in `CHAT_TOOL_NAMES` | Voice tool descriptions; Chat clips them | Chat does not use this list as the model allowlist |
| **Exterior / Model Builder** | `mcp-tools/exterior/index.js` + `capabilityTools.js` | Same | All 21 are in Chat 66 | Same `runChatTool` | Exterior + visual guidance blocks | Maker strip / exclusive Create/Imagine |
| **Local Mode (Chat schemas)** | `mcp-tools/localTools.js` | Schema-only | `LOCAL_TOOL_NAMES` (14) | `chat-agent-loop` `awaitLocalTool` → `localToolExecutor.ts` → `electron/localSystem.cjs` | Slim guidance + Local Mode prompt | Offered only when `localMode===true` |
| **Local decision loop** | `electron/localAgentTask.cjs` + `localCapabilities.cjs` | Structured decision JSON `tool` enum | Task `capabilities[]` → 13 names | `localSystem.run` after capability + consequence | Hardcoded `TOOL_LINES` | Capability compiler from objective |
| **Remote decision loop** | `electron/remote/remoteAgentTask.cjs` + `remotePolicy.cjs` | Structured decision JSON | Task capabilities → 5 names | SSH session | Hardcoded `TOOL_LINES` | Capability + environment consequence |
| **Browser decision loop** | `electron/browser-agent/runtime/model.cjs` + `capabilities.cjs` | Structured `action.type` enum (20) | Task `browser*` capabilities | `controller.cjs` → `ownedBrowserAct.cjs` | Always-loaded markdown corpus (~8.9K tokens) | Capability-narrowed action enum |
| **Bot Harness** | `electron/bot-harness/runtime/toolRegistry.cjs` | Index `{name,summary,risk}` + markdown docs | 8 tools (7 without Local Mode) | `agentRuntime` executors | Progressive: index always; full doc on first select | `primaryTool` preloads one doc; `requiresLocalMode` filter |
| **Voice** | `server/routes/voice.routes.js` `LYKN_VOICE_TOOL_DEFS` | OpenAI realtime / ElevenLabs client-tool shape | 35 server names | `runMcp` or special-case | Descriptions on the defs; no Chat-style gated guidance | **Static giant set.** No intent filter. |
| **Custom-model Chat** | `lib/modelBuilder/customModelChatTools.js` + `modelCapabilitiesCatalog.js` | Capability id → Chat tool names | User toggles / defaults | Same `runChatTool` | Soft-unplugged (`CUSTOM_MODELS_ENABLED=false`) | Maps to `CHAT_TOOL_NAMES` only |
| **First-party GitHub** | `mcp-tools/githubTools.js` | Internal runner, not Chat schemas | 13 names via `github.*` capabilities | `runGithubTool` | None in Chat | Not model-visible in Chat |
| **Universal MCP (worktree only)** | `lib/mcp/externalToolResolver.js` | MCP protocol tools, bounded | ≤10 per disclosure | MCP client runtime | Marketplace text never becomes instructions | Task need → connection → subset |

Duplication: Voice re-declares schemas instead of calling `toOpenAIToolSchema`.
Bot tools (`generate_image`, `browser`, `local_computer`) are host capabilities, not aliases of `lykn_generate_image` / `local_*`.
Local Mode Chat schemas and the local decision-loop enum overlap 13 names.
`local_browser_agent` exists only on the Chat Local Mode path.
`providerForModel` is duplicated in `chatTools.js` and `lib/agentModelProviders.js` (exact; already noted in the dead-code audit).

---

## Tool inventory

Status key: **LIVE** callable on a current surface.
**LEGACY** still dispatched or rendered for old data / Voice, but Chat forbids or has replaced it.
**DEAD** no handler or no live caller.
**COMPATIBILITY** kept so saved chats / old payloads still render.
**FEATURE-GATED** code exists, product flag off.

Consequence: `read` / `write` from tool `scope`, plus Chat confirm-gates and Electron approval where noted.

### Chat allowlist (66) — LIVE

| Tool | Definition | Executor | Family | Surfaces | Gate | Consequence | Tests | Status |
|---|---|---|---|---|---|---|---|---|
| `memory_list` | `mcp-tools/memoryTools.js` ← `server/memory/memoryTools.js` | `runChatTool` | memory.read | Chat, Voice | auth `ctx.userId` | read | `tests/memory/memoryTools.test.mjs`, `memoryCutover.test.mjs` | LIVE |
| `memory_read` | same | same | memory.read | Chat, Voice | path policy | read (full doc) | same | LIVE |
| `memory_patch` | same | same | memory.write | Chat, Voice | `sourceType`, version | write | same | LIVE |
| `memory_create` | same | same | memory.write | Chat, Voice | path policy | write | same | LIVE |
| `memory_forget` | same | same | memory.write | Chat, Voice | confirm hard-delete | write | same | LIVE |
| `lykn_getUserPreferences` | `getUserPreferences.js` | `runChatTool` | prefs.read | Chat | auth | read | none dedicated | LIVE |
| `lykn_updateUserPreference` | `updateUserPreference.js` | `runChatTool` | prefs.write | Chat | prompt ASK FIRST | write | none dedicated | LIVE |
| `lykn_listProjects` | `listProjects.js` | `runChatTool` | projects.read | Chat, Voice | project strip unless scoped/ask | read | none dedicated | LIVE |
| `lykn_resolveProject` | `resolveProject.js` | `runChatTool` | projects.read | Chat | same | read | none dedicated | LIVE |
| `lykn_getProjectState` | `getProjectState.js` | `runChatTool` | projects.read | Chat, Voice | same | read | none dedicated | LIVE |
| `lykn_getProjectNeurons` | `getProjectNeurons.js` | `runChatTool` | projects.read | Chat | same | read | none dedicated | LIVE |
| `lykn_loadNeuron` | `loadNeuron.js` | `runChatTool` + UI card | vault.read / projects.read | Chat | Glass saved-recall strip | read; 16KB body cap | renderer via orchestrator | LIVE |
| `lykn_loadNeurons` | `loadNeurons.js` | same | vault.read | Chat | same | read; 4KB/item batch | same | LIVE |
| `lykn_getRecentActivity` | `getRecentActivity.js` | `runChatTool` | activity.read | Chat, Voice | none extra | read | none dedicated | LIVE |
| `lykn_pushProjectState` | `pushProjectState.js` | `runChatTool` | projects.write | Chat, Voice | project strip | write, reversible | none dedicated | LIVE |
| `lykn_addProjectNeurons` | `addProjectNeurons.js` | `runChatTool` | projects.write | Chat | project strip | write, reversible | none dedicated | LIVE |
| `lykn_removeProjectNeurons` | `removeProjectNeurons.js` | `runChatTool` | projects.write | Chat | project strip | write, reversible | none dedicated | LIVE |
| `lykn_uploadToProject` | `uploadToProject.js` | `runChatTool` | projects.write | Chat only | turn attachments | write | none dedicated | LIVE |
| `lykn_setActiveProject` | `setActiveProject.js` | `runChatTool` | projects.write | Chat, Voice | project strip | write | none dedicated | LIVE |
| `lykn_createProject` | `createProject.js` | `runChatTool` | projects.write | Chat, Voice | confirm-first in prompt | write | none dedicated | LIVE |
| `lykn_updateProject` | `updateProject.js` | `runChatTool` | projects.write | Chat | project strip | write | none dedicated | LIVE |
| `lykn_deleteProject` | `deleteProject.js` | `runChatTool` | projects.write | Chat | `confirm` + exact name | irreversible | none dedicated | LIVE |
| `lykn_mergeProjects` | `mergeProjects.js` | `runChatTool` | projects.write | Chat | dry-run then confirm | irreversible | none dedicated | LIVE |
| `lykn_createVaultNote` | `createVaultNote.js` | `runChatTool` | vault.write | Chat, Voice | prompt ASK FIRST | write | none dedicated | LIVE |
| `lykn_saveFileToVault` | `saveFileToVault.js` | `runChatTool` | vault.write | Chat only | ASK FIRST | write | none dedicated | LIVE |
| `lykn_saveLinkToVault` | `saveLinkToVault.js` | `runChatTool` | vault.write | Chat, Voice | agentic silent-save policy | write | none dedicated | LIVE |
| `lykn_createReminder` | `createReminder.js` | `runChatTool` | calendar.write | Chat, Voice | managed-surface intent | write | none dedicated | LIVE |
| `lykn_listReminders` | `listReminders.js` | `runChatTool` | calendar.read | Chat, Voice | same | read | none dedicated | LIVE |
| `lykn_updateReminder` | `updateReminder.js` | `runChatTool` | calendar.write | Chat, Voice | same | write | none dedicated | LIVE |
| `lykn_createEvent` | `createEvent.js` | `runChatTool` | calendar.write | Chat, Voice | same | write | none dedicated | LIVE |
| `lykn_listEvents` | `listEvents.js` | `runChatTool` | calendar.read | Chat, Voice | same | read | none dedicated | LIVE |
| `lykn_updateEvent` | `updateEvent.js` | `runChatTool` | calendar.write | Chat, Voice | read-only synced events | write | none dedicated | LIVE |
| `lykn_deleteEvent` | `deleteEvent.js` | `runChatTool` | calendar.write | Chat, Voice | same | write | none dedicated | LIVE |
| `lykn_createTodo` | `createTodo.js` | `runChatTool` | tasks.write | Chat, Voice | managed-surface intent | write | none dedicated | LIVE |
| `lykn_listTodos` | `listTodos.js` | `runChatTool` | tasks.read | Chat, Voice | same | read | none dedicated | LIVE |
| `lykn_updateTodo` | `updateTodo.js` | `runChatTool` | tasks.write | Chat, Voice | same | write | none dedicated | LIVE |
| `lykn_deleteTodo` | `deleteTodo.js` | `runChatTool` | tasks.write | Chat, Voice | same | write | none dedicated | LIVE |
| `lykn_createStewardItem` | `createStewardItem.js` | `runChatTool` | steward.write | Chat | not in lean intent | write | none dedicated | LIVE |
| `lykn_listStewardItems` | `listStewardItems.js` | `runChatTool` | steward.read | Chat | not in lean intent | read | none dedicated | LIVE |
| `lykn_updateStewardItem` | `updateStewardItem.js` | `runChatTool` | steward.write | Chat | not in lean intent | write | none dedicated | LIVE |
| `lykn_build_with_cursor` | `buildWithCursor.js` | `runChatTool` | coding.write | Chat, Voice | maker strip in regular chat | write (PR) | none dedicated | LIVE |
| `lykn_check_cursor_build` | `checkCursorBuild.js` | `runChatTool` | coding.read | Chat, Voice | maker strip | read | none dedicated | LIVE |
| `lykn_update_assistant_instructions` | `updateAssistantInstructions.js` | `runChatTool` + client persist | self.write | Chat | none extra | write | orchestrator persist | LIVE |
| `lykn_open_settings` | `openSettings.js` | `runChatTool` + client | shell.open | Chat | none extra | read (opens UI) | orchestrator | LIVE |
| `lykn_open_app` | `openApp.js` | `runChatTool` + client | shell.open | Chat | none extra | read (opens UI) | `openApp.test.mjs` | LIVE |
| `lykn_web_search` | `exterior/index.js` | `runChatTool` | web.search | Chat, Voice | web intent / exclusive web | read | `lib/webSearchIntent.test.cjs` (intent only) | LIVE |
| `lykn_web_fetch` | `exterior/index.js` | `runChatTool` | web.read | Chat, Voice | same | read | none dedicated | LIVE |
| `lykn_calculate` | `exterior/index.js` | `runChatTool` | compute.math | Chat | calc intent | read | `lib/exterior/calculate.test.js` | LIVE |
| `lykn_symbolic_math` | `capabilityTools.js` | `runChatTool` | compute.math | Chat | calc / making | read | capabilities tests | LIVE |
| `lykn_run_python` | `exterior/index.js` | `runChatTool` | compute.code | Chat | calc / making | read | none dedicated | LIVE |
| `lykn_run_code` | `capabilityTools.js` | `runChatTool` | compute.code | Chat | making | read | `capabilities.test.js` | LIVE |
| `lykn_get_current_time` | `exterior/index.js` | `runChatTool` | compute.time | Chat | scheduling lean | read | none dedicated | LIVE |
| `lykn_http_request` | `capabilityTools.js` | `runChatTool` | web.http | Chat | remains on ambiguous leftover | read/write by method | none dedicated | LIVE |
| `lykn_parse_document` | `capabilityTools.js` | `runChatTool` | media.parse | Chat | remains on leftover | read | capabilities tests | LIVE |
| `lykn_transcribe_audio` | `capabilityTools.js` | `runChatTool` | media.audio | Chat | leftover | read | none dedicated | LIVE |
| `lykn_translate` | `capabilityTools.js` | `runChatTool` | media.translate | Chat | exclusive translate → **empty** tools | read | none dedicated | LIVE |
| `lykn_generate_image` | `exterior/index.js` | `runChatTool` | media.image.generate | Chat | Imagine / `forceImage` | write; 5/month | `imageGenQuota.test.js`, artifacts tests | LIVE |
| `lykn_process_image` | `capabilityTools.js` | `runChatTool` | media.image.edit | Chat | Imagine exclusive | write | artifacts tests | LIVE |
| `lykn_generate_speech` | `capabilityTools.js` | `runChatTool` | media.audio.generate | Chat | stripped from default fallback | write | none dedicated | LIVE |
| `lykn_generate_chart` | `exterior/index.js` | `runChatTool` | media.chart | Chat | Build/Create only | write | artifacts tests | LIVE |
| `lykn_generate_diagram` | `exterior/index.js` | `runChatTool` | media.diagram | Chat | Build/Create only | write | artifacts tests | LIVE |
| `lykn_manage_file` | `capabilityTools.js` | `runChatTool` | media.file | Chat | maker strip | write | artifacts tests | LIVE |
| `lykn_build_spreadsheet` | `capabilityTools.js` | `runChatTool` | media.spreadsheet | Chat | maker strip | write | artifacts tests | LIVE |
| `lykn_build_template` | `capabilityTools.js` | `runChatTool` | media.template | Chat | maker strip | write | artifacts tests | LIVE |
| `lykn_build_react_artifact` | `capabilityTools.js` | `runChatTool` | media.app | Chat | maker strip | write | artifacts + bundle tests | LIVE |
| `lykn_render_video` | `capabilityTools.js` | `runChatTool` | media.video | Chat | maker strip | write | none dedicated | LIVE |

Runtime consumers for all 66: `server.js` `/api/ai/stream` → `chat-agent-loop.js`.
UI: `src/lib/ai/chatSendOrchestrator.ts`, `chatArtifacts.ts`, `ChatNeuronCard.tsx`, `toolStatusVerbs.ts`.

### Chat-hidden first-party tools

| Tool | Definition | Surfaces | Status |
|---|---|---|---|
| `lykn_searchVault` | `searchVault.js` | Voice `search_vault`; Chat `skipVaultSearch` returns retired error | **LEGACY** live Voice; Chat public-contract reject |
| `lykn_list_apps` | `listApps.js` | Voice only | **LIVE** Voice; Chat prompt still advertises it |
| `lykn_call_app` | `callApp.js` | Voice only | **LIVE** Voice; Chat prompt still advertises it |
| `lykn_listCustomModels` | `listCustomModels.js` | Overlay voice list only; server Voice defs dropped it | **FEATURE-GATED / DRIFTED** |
| `lykn_delegate_to_sub_model` | `delegateToSubModel.js` | Main-agent path when custom models on | **FEATURE-GATED** |
| `lykn_list_sub_model_tasks` | `listSubModelTasks.js` | same | **FEATURE-GATED** |
| `lykn_get_sub_model_task` | `getSubModelTask.js` | same | **FEATURE-GATED** |
| `lykn_communicate_with_model` | `communicateWithModel.js` | Overlay voice stale; Chat guidance still names it | **FEATURE-GATED** + **misleading prompt** |

### Local Mode (14) — LIVE when armed

`local_list_dir`, `local_read_file`, `local_search_files`, `local_pull_file`, `local_write_file`, `local_edit_file`, `local_run_command`, `local_synced_folders`, `local_running_apps`, `local_read_app`, `local_open_app`, `local_open_path`, `local_organize_desktop`, `local_browser_agent`.

Definition: `mcp-tools/localTools.js`.
Executor: `src/lib/ai/localToolExecutor.ts` → `electron/localSystem.cjs`.
`local_browser_agent` → `agentCreate` / `studioAgentSend`.
Writes/risky shell: `electron/localToolApproval.cjs`.
Tests: `electron/localSystem.test.cjs`, `localDocumentTools.test.cjs`, `localConsequence.test.cjs`, `task-runtime/localExecutor.test.cjs`.

### Voice aliases (35 server)

See Voice section.
Special-cased (not generic `runMcp`): `search_vault`, `read_document`, `display_document`, `get_project_state`, `create_project`, `add_to_project`.
Client-only: `update_voice_instructions`.

### Bot Harness (8)

`reply`, `research_report`, `edit_report`, `build_artifact`, `generate_image`, `local_computer`, `create_routine`, `browser`.
LIVE.
Progressive docs in `electron/bot-harness/agent/tools/*.md`.
Tests: `botHarness.test.cjs`, `botHarnessIntegration.test.cjs`, `botToolRouting.test.cjs`.

### Browser actions (20)

`extract`, `wait`, `screenshot`, `scroll`, `dismiss_overlay`, `navigate`, `go_back`, `go_forward`, `open_tab`, `close_tab`, `switch_tab`, `click`, `click_coord`, `type`, `type_coord`, `replace_text`, `paste_text`, `select`, `drag`, `press_key`.
LIVE under Task `browser*` capabilities.
`browser.eval` is reserved and not exposed.

### Remote (5) and GitHub (13)

Remote: `remote_exec`, `remote_read_file`, `remote_list_dir`, `remote_search`, `remote_write_file`.
GitHub: `github_get_repo` … `github_merge_pull_request`.
LIVE on TaskRuntime.
Not Chat-callable.
Tests: `remoteExecutor.test.cjs`, `githubTools.test.mjs`.

### Deleted synthesis tools

No handlers on HEAD for `lykn_findConnections`, `lykn_getBeliefs`, `lykn_getFacts`, `lykn_proposeFact`, `lykn_touchConcept`, `lykn_getRules`, `lykn_getContextBlock`, `lykn_createNeuronLink`, `lykn_getNeuronLinks`, `lykn_recordRuleApplication`.
`LYKN_CHAT_TOOL_GUIDANCE` on this HEAD **no longer advertises** `lykn_findConnections`.
The 2026-08-26 dead-code audit is stale on that specific prompt line.
Residue that remains: `toolStatusVerbs.ts` `lykn_proposeBelief`; ChatNeuron `belief`/`fact`/`concept` kinds; `loadNeuron` docs still teach `lykn_searchVault`.

---

## Largest schemas

OpenAI clipped `tools[]` entries, largest → smallest (top 20):

| Rank | Tool | Bytes | ~tokens | Desc clipped | Params |
|---:|---|---:|---:|---:|---:|
| 1 | `lykn_build_react_artifact` | 4,111 | 1,028 | 1,008 | 2,987 |
| 2 | `lykn_saveFileToVault` | 2,936 | 734 | 1,008 | 1,817 |
| 3 | `lykn_createEvent` | 2,915 | 729 | 1,020 | 1,778 |
| 4 | `lykn_updateEvent` | 2,696 | 674 | 798 | 1,790 |
| 5 | `lykn_build_template` | 2,610 | 653 | 1,004 | 1,489 |
| 6 | `lykn_createTodo` | 2,545 | 636 | 1,010 | 1,407 |
| 7 | `lykn_updateTodo` | 2,423 | 606 | 754 | 1,555 |
| 8 | `lykn_generate_image` | 2,261 | 565 | 1,008 | 1,139 |
| 9 | `lykn_createVaultNote` | 2,127 | 532 | 1,016 | 996 |
| 10 | `lykn_createReminder` | 2,088 | 522 | 1,012 | 948 |
| 11 | `lykn_uploadToProject` | 2,083 | 521 | 1,006 | 955 |
| 12 | `lykn_listEvents` | 2,025 | 506 | 1,012 | 900 |
| 13 | `lykn_mergeProjects` | 2,006 | 502 | 1,006 | 885 |
| 14 | `lykn_pushProjectState` | 1,952 | 488 | 1,006 | 817 |
| 15 | `lykn_setActiveProject` | 1,880 | 470 | 1,008 | 754 |
| 16 | `lykn_addProjectNeurons` | 1,810 | 453 | 923 | 767 |
| 17 | `lykn_build_with_cursor` | 1,793 | 448 | 1,008 | 665 |
| 18 | `lykn_render_video` | 1,782 | 446 | 1,010 | 654 |
| 19 | `lykn_saveLinkToVault` | 1,766 | 442 | 1,012 | 627 |
| 20 | `lykn_update_assistant_instructions` | 1,762 | 441 | 1,004 | 611 |

Offenders are **parameter-schema heavy** (artifact builder, calendar/todo update objects) plus descriptions hitting the 1KB clip.
`lykn_build_react_artifact` raw description is **12,340 bytes**; 11KB is thrown away by the clip and still leaves the largest params blob.
Smallest Chat tool: `memory_list` at 321 bytes (~80 tokens).

Largest Local Mode schemas: `local_edit_file` (1,735), `local_browser_agent` (1,656), `local_organize_desktop` (1,111).

---

## Representative turn disclosure

Static reconstruction of `server.js` `/api/ai/stream` for a signed-in in-app Chat turn.
Assumptions unless noted: not exclusive composer mode, not Glass overlay, not custom model, not project-scoped, `useTools` requested, model supports tools.
No model calls.

| User message | Tools exposed | Count | Schema bytes / ~tokens | Notes |
|---|---|---:|---|---|
| `"hello"` | **none** | 0 | 0 | Casual-turn gate (`enrichment tier none`) and `messageWantsAgentTools` both disable the agent loop. Fast-lean persona, no schemas. |
| `"what's in this file?"` | **none** (no Local Mode) | 0 | 0 | No vault/project/web/make intent. If Local Mode on: 14 local + leftover Chat 42 = **56 / ~16.1K**. |
| `"search the web for today's AI news"` | `lykn_web_search`, `lykn_web_fetch` | 2 | 2,127 / **532** | Lean intent. Slim guidance (~148 tokens) instead of 6K guidance. |
| `"make an image"` without Imagine | leftover 42 Chat tools, **no** `lykn_generate_image` | 42 | 52,802 / **13,201** | `wantsMake` returns `null` (ambiguous make). Fallback dump, then maker strip removes image gen. Prompt tells user to click Imagine. |
| `"make an image"` with Imagine | `lykn_generate_image`, `lykn_process_image` | 2 | 2,883 / **721** | Exclusive image set. |
| `"save this to my Vault"` | `lykn_open_app`, `lykn_createVaultNote`, `lykn_saveFileToVault`, `lykn_saveLinkToVault` | 4 | 8,337 / **2,084** | Lean vault set. |
| `"find my project"` | 10 project tools (no delete/merge) | 10 | 16,728 / **4,182** | Lean project set. Delete/merge only on the full leftover path. |
| `"check Gmail"` | **none** on HEAD Chat | 0 | 0 | No first-party Gmail tool. Prompt says LYKN does not connect to outside apps. `messageWantsConnectedAppApis` exists and is **never called**. Voice still has `list_apps`/`call_app`. Universal MCP worktree would attach ≤10 external tools **only if `useTools` stayed true**. |
| `"browse example.com"` | **none** without Local Mode | 0 | 0 | `mightBeBrowserTaskAsk` is true, but that only preserves tools when Local Mode is on. With Local Mode: 56 tools including `local_browser_agent`. |
| `"read a local file"` | **none** without Local Mode | 0 | 0 | `looksLikeLocalSystemAsk` true. Local Mode keeps tools and appends 14 local schemas (~16.1K with leftover Chat). |
| `"SSH into dev server"` | **none** in Chat | 0 | 0 | Remote tools are TaskRuntime/Bot only. Chat has no `remote_*`. |

The characterization "simple chat still pays ~29K" is **false on current HEAD**.
Simple chat pays **0 schema tokens**.
The live expensive Chat path is **ambiguous make / leftover 42-tool dump (~13K schemas + full tool guidance)**.

---

## Capability families

Derived from actual tools, not from a wish list.
Keep the grammar small.

| Family | Tools |
|---|---|
| `memory.read` | `memory_list`, `memory_read` |
| `memory.write` | `memory_patch`, `memory_create`, `memory_forget` |
| `prefs.read` / `prefs.write` | `lykn_getUserPreferences`, `lykn_updateUserPreference` |
| `projects.read` | list/resolve/state/neurons/load/activity |
| `projects.write` | push/add/remove/upload/setActive/create/update |
| `projects.destroy` | delete, merge |
| `vault.write` | createVaultNote, saveFileToVault, saveLinkToVault |
| `vault.surface` | loadNeuron, loadNeurons, open_app (AI Drive) |
| `calendar.read` / `calendar.write` | events + reminders |
| `tasks.read` / `tasks.write` | todos |
| `steward.*` | steward trio |
| `web.search` / `web.read` / `web.http` | web_search, web_fetch, http_request |
| `compute.math` / `compute.code` / `compute.time` | calculate, symbolic_math, run_python, run_code, get_current_time |
| `media.image.generate` / `media.image.edit` | generate_image, process_image |
| `media.chart` / `media.diagram` / `media.file` / `media.spreadsheet` / `media.template` / `media.app` / `media.video` / `media.audio` / `media.parse` / `media.translate` | corresponding builders |
| `coding.cursor` | build_with_cursor, check_cursor_build |
| `shell.open` | open_settings, open_app |
| `self.write` | update_assistant_instructions |
| `local.files.read` / `local.files.write` / `local.apps.*` / `local.shell.*` | Local Mode + TaskRuntime local capabilities (already exist) |
| `browser.read` / `browser.navigate` / `browser.interact` | already exist on TaskRuntime |
| `remote.*` / `github.*` | already exist; not Chat |
| `connections.call` | `lykn_list_apps`, `lykn_call_app` (Voice only today) |

Do not create hundreds of capabilities.
One family should map to a handful of schemas.

Custom-model `CAPABILITY_RUNTIME_MAP` is a **drifted earlier grammar**.
It maps `search_vault` → `lykn_searchVault` which Chat no longer allowlists.
It never learned memory_*, calendar, todos, open_app, or Local Mode.
Do not reuse it as the Chat capability source of truth.

---

## Always-visible core candidates

Evidence: `"hello"` already runs with **zero** tools and the product accepts that.
Do not put utilities in core "just in case".

If a non-zero core is required so the model can *discover* that tools exist without a 6K capabilities menu, the minimum that is actually used on ordinary non-make turns is:

1. **Nothing** (current simple-chat behavior). Preferred.
2. Else at most: `memory_list` (portrait follow-up), `lykn_open_app` (put a LYKN surface on screen), `lykn_get_current_time` (scheduling follow-up).
   That pack is ~1.0K tokens.

Do **not** always-include: project cluster, vault writes, web, builders, local, HTTP, steward, cursor.
Those have clear intent or mode gates today.

The capabilities menu inside `LYKN_CHAT_TOOL_GUIDANCE` is the current substitute for a tiny core: it spends ~6K tokens so the model "knows" tools exist even when detail blocks are gated.
A family index of ~20 lines would replace most of that menu.

---

## TaskRuntime relationship

Chat disclosure today is **not** driven by TaskRuntime.

| Driver | Used today? | Where |
|---|---|---|
| Task `capabilities[]` | Yes for Bot/browser/local/remote/GitHub. **No for Chat.** | `taskCompiler.cjs`, `localCapabilities.cjs`, `browser-agent/runtime/capabilities.cjs`, `remotePolicy.cjs`, `githubTools.js` |
| Message intent regex | **Yes, Chat primary** | `resolveIntentChatToolNames`, `messageWantsAgentTools`, `messageWantsProjectContext`, `messageWantsSavedRecall`, `webSearchIntent` |
| Composer mode | **Yes** | Imagine, Build/Create, Web, Research, Translate exclusive sets |
| Bot profile | Bot Harness tool index + `primaryTool`; custom-model tool toggles (flag off) | `toolRegistry.cjs`, `customModelChatTools.js` |
| Active product surface | Partial | Glass strips makers/vault; overlay page fetch; Local Mode desktop flag |

First-party Chat disclosure should be a **combination**, in this order:

1. Composer / exclusive mode (hard lock).
2. Task capabilities **when the Chat turn is already a Task** (Bot, Routine, future Chat-as-Task).
3. Deterministic message+mode inference for ordinary Chat (replace today's regex soup with the small family grammar).
4. Optional second-stage family request inside the same agent loop (see Audit 10).

Do not invent a second Task system.
When Chat is not running under TaskRuntime, composer mode + inferred families are enough.
When it is (Bot/Routine), Task `capabilities[]` is the authorization source and the disclosure subset must be a subset of that allowlist.

Existing seams to reuse:

- `resolveChatTools(toolNames)` already accepts a per-turn name list.
- `runChatTool(..., { allowedToolNames })` already re-checks that list.
- `compileLocalCapabilities(objective)` is the local analogue of a first-party Chat resolver.
- Universal MCP `inferCapabilityNeeds` is the external analogue (worktree).

---

## Current filtering seams

All in `server.js` unless noted.

1. Exclusive composer: research/web → 2 web tools; translate → 0; image → 2 image tools.
2. `resolveIntentChatToolNames` tiny allowlist or `null`.
3. Fallback: all Chat tools minus image/speech/chart/diagram.
4. Agent-browser strip of `lykn_list_apps` / `lykn_call_app` (those names are not in Chat anyway).
5. Maker strip unless Create/Build armed or open artifact.
6. Force-add artifact builder / open-artifact edit tool.
7. Glass strip of chart/diagram/webapp builders and vault load tools.
8. Project-tool strip unless scoped or explicit project ask.
9. Casual-turn gate: `useTools=false` on enrichment `none`.
10. Lean gate: `useTools=false` unless `messageWantsAgentTools`.
11. Local Mode: append 14 `local_*` and keep tools on for local/browser-shaped asks.
12. `buildChatToolGuidance` vs `buildSlimChatToolGuidance`.
13. `chat-agent-loop.js` `allowedToolNames` on every `runChatTool`.
14. `skipVaultSearch: true` in `buildChatToolCtx` so even a smuggled `lykn_searchVault` errors if it were allowlisted.

This is already progressive disclosure.
It is regex-stacked, order-sensitive, and leaves a 42-tool "everything else" bucket.

---

## MCP interaction

On **current HEAD**: Chat never combines with protocol MCP tools.
`lykn_list_apps` / `lykn_call_app` are Voice-only.
The persona still says connected apps are callable, and also says LYKN does not connect to outside apps.
Those two sentences conflict.

In **`.worktrees/universal-mcp`**:

- `resolveMcpToolsForTurn` runs only when `useTools` is already true.
- It **appends** up to `MAX_TOOLS_PER_DISCLOSURE` (10) external tools onto `streamChatToolNames`.
- It does **not** shrink first-party tools.
- An email Task therefore gets: whatever first-party set Chat already chose **plus** ≤10 MCP tools.
- If Chat's lean/casual gates set `useTools=false` (`"check Gmail"` on HEAD), MCP tools never attach.

The "~8 first-party + 10 MCP" characterization is **not a named constant**.
Closest HEAD packs: web=2, image=2, vault=4, project=10, scheduling=12, leftover=42.
An email turn on the Universal MCP worktree would likely still carry the **42-tool leftover** (no email family in first-party intent) plus ≤10 Gmail MCP tools: **~52 schemas**, not 18.
That is why first-party disclosure must be generalized **before** MCP combination looks like the architecture diagram.

First-party GitHub vs MCP GitHub: ExternalToolResolver leaves first-party GitHub in the first-party set and omits MCP GitHub until an explicit connection assignment.
Chat does not currently expose first-party GitHub tools at all.

---

## Bot architecture reuse

Reuse these concepts. Do not merge Bot Harness into Chat.

| Reuse | Why |
|---|---|
| Compact **index** (name + one line) as the always-visible set | Bot `toolIndexBlock` is 1,158 chars (~290 tokens) for 8 tools |
| Load full contract **on first select**, keep it for the rest of the Task | Progressive docs without a meta-tool |
| `risk` floor on the registry, never lowerable by the model | Independent of disclosure |
| `requiresLocalMode` filter | Same as Chat Local Mode |
| `primaryTool` preload when routing already knows the family | Avoids the extra "read the doc" round on obvious turns |

Do not reuse:

- Bot tool **names** (`reply`, `browser`) as Chat tools.
- Nested Bot→browser planning as Chat's disclosure mechanism.
- Bot `deliver` completion as Chat hop completion.

Chat already has hops.
Second-stage family expansion should be a new hop with an expanded `chatToolNames`, not a Bot rewrite.

---

## Voice

Voice is a **static giant set**.

- Server: **35** tools in `LYKN_VOICE_TOOL_DEFS`.
- Overlay client: **34** names, including stale `list_custom_models` and `communicate_with_model`.
- ElevenLabs chat client: **33** names; missing `list_apps` / `call_app`; extra client `update_voice_instructions`.

No `resolveIntentChatToolNames`.
Every voice turn pays the full client-tool schema bill.
The def block in `voice.routes.js` is ~38,623 bytes of source (~9.7K tokens if all descriptions shipped).
Realtime `tool_choice: 'auto'`.

Voice still calls `lykn_searchVault` via `search_vault` (LIVE for Voice, retired for Chat).
Voice has `list_apps` / `call_app` (LIVE).
Chat prompts tell the text model those app tools exist; they do not.

Latency: Voice is the surface that most needs family disclosure, and it has the least.

Do not change Voice in Phase A.

---

## Tool execution security

Desired: disclosure ≠ authorization.

**Chat server tools**

- Hidden name not in `CHAT_TOOLS_BY_NAME` → `tool_not_whitelisted_for_chat`.
- Name in registry but not in this turn's `allowedToolNames` → `tool_not_enabled_for_model`.
- Unauthenticated → `unauthenticated`.
- `lykn_searchVault` additionally `skipVaultSearch` in Chat ctx.

A hallucinated `lykn_deleteProject` on a `"hello"` turn never executes: tools are off, and if they were on without project family, `allowedToolNames` would omit it.
A hallucinated `lykn_searchVault` cannot run on Chat even if listed.

**Gap:** `allowedToolNames` is the same list used for disclosure.
That is correct as a **turn enablement** gate, not as a Task capability gate.
Chat turns are not Tasks, so there is no second capability check.
Project delete still has in-tool `confirm` + name match.
Preference writes rely on prompt "ASK FIRST" (weak).

**Local Mode**

- Server does not execute.
- Client `localToolExecutor` + main `localSystem` + approval tokens.
- Hallucinated `local_write_file` when Local Mode is off is not in `ctx.localToolNames`, so it goes to `runChatTool` and is **not whitelisted**.
- When Local Mode is on, all 14 local names are enabled, including write/shell/browser.
- TaskRuntime local capabilities are **not** applied on the Chat Local Mode path.
  Chat Local Mode is a blanket grant plus per-action approval.
  That is the largest disclosure/authorization coupling.

**Browser / remote / GitHub**

- Capability allowlists are enforced in code before actuation.
- Model-visible enum is filtered, **and** execution re-checks.
- This is the pattern Chat first-party disclosure should copy when Chat runs under a Task.

**Voice**

- `runMcp` looks up `LYKN_TOOLS_BY_NAME` / `EXTERIOR_TOOLS_BY_NAME` by mapped name.
- No Chat whitelist.
- A voice model can call `call_app` / `search_vault` that Chat cannot.

---

## Dead/legacy guidance

Rechecked on this HEAD after Memory demolition.

| Item | Class | Evidence |
|---|---|---|
| `lykn_findConnections` in `LYKN_CHAT_TOOL_GUIDANCE` | **FIXED vs prior audit** | Not present in current `server.js` guidance |
| Glass `lykn_findConnections` strip | **FIXED vs prior audit** | `GLASS_VAULT_TOOLS` is only loadNeuron(s) |
| `fetchBeliefSection` | **FIXED vs prior audit** | No call on HEAD `server.js` |
| Prompt advertises `lykn_call_app` / connected apps | **LIVE mismatch** | `LYKN_CHAT_TOOL_GUIDANCE` CAPABILITY-AWARE ROUTING; `lykn_list_apps` not in Chat allowlist |
| Same prompt later says LYKN does not connect to outside apps | **Contradictory prompt** | Same guidance block |
| `lykn_communicate_with_model` in saveFileToVault guidance | **Stale** | Tool not in `CHAT_TOOL_NAMES` |
| `lykn_searchVault`: persona + guidance say NEVER call; descriptions of `loadNeuron` / `createVaultNote` / `web_search` still teach it | **LEGACY docs** | Chat ctx also hard-disables it |
| `listProjects.js` header still says outside MCP clients / "AI agents cannot create projects" | **Stale** | Chat has `lykn_createProject` |
| `toolStatusVerbs.ts` `lykn_proposeBelief` | **DEAD mapping** | Tool gone |
| `toolStatusVerbs.ts` `lykn_searchVault` | **LEGACY mapping** | Voice / old chats |
| Overlay `VOICE_TOOL_NAMES` includes `list_custom_models`, `communicate_with_model` | **DRIFTED client** | Server Voice defs dropped them |
| ElevenLabs `TOOL_NAMES` omits `list_apps` / `call_app` | **DRIFTED client** | Server Voice defs include them |
| `CAPABILITY_RUNTIME_MAP.search_vault` → `lykn_searchVault` | **DRIFTED catalog** | Not in Chat allowlist |
| `messageWantsConnectedAppApis` | **DEAD function** | Defined, never called |
| ChatNeuron `belief` / `fact` / `concept` | **COMPATIBILITY** | `LOAD_NEURON_KINDS`; tools that created them are gone |
| `lykn_inline_html` | **COMPATIBILITY renderer** | `chatArtifacts.ts` only; not a callable tool |

Dead/legacy **callable-tool** count (not including prompt-only residue): **8** Chat-hidden or gated (`searchVault`, `list_apps`, `call_app`, `listCustomModels`, 4 custom-model orchestration tools).
Dead/legacy **guidance/status** items: **~12** (table above, excluding the three prior-audit items that are already gone).

---

## Duplicates

| Pair | Class | Notes |
|---|---|---|
| Voice `web_search` vs Chat `lykn_web_search` | INTENTIONAL VARIANT | Shorter Voice schema; same handler |
| Voice `save_to_vault` vs `lykn_createVaultNote` | INTENTIONAL VARIANT | Voice omits tags/file_url |
| Voice `read_document` / `display_document` vs `lykn_loadNeuron` | INTENTIONAL VARIANT | Voice is query-based; Chat is node_id |
| Overlay vs ElevenLabs vs server Voice lists | DRIFTED DUPLICATE | 35 / 34 / 33 names |
| Chat Local Mode `local_*` vs `localAgentTask` enum | INTENTIONAL VARIANT | Chat adds `local_browser_agent` |
| Bot `generate_image` vs `lykn_generate_image` | INTENTIONAL VARIANT | Host capability vs Chat schema |
| Bot `local_computer` vs Chat Local Mode | INTENTIONAL VARIANT | Nested local agent vs Chat tools |
| `providerForModel` in `chatTools.js` vs `agentModelProviders.js` | EXACT DUPLICATE | Isolation comment stale |
| `CAPABILITY_RUNTIME_MAP` vs `CHAT_TOOL_NAMES` | DRIFTED DUPLICATE | Catalog ≠ Chat allowlist |
| Stream vs invoke personas | DRIFTED DUPLICATE | Both still teach vault/search policy |
| `lykn_run_python` vs `lykn_run_code` | INTENTIONAL VARIANT | Snippet vs heavier runner |

Do not merge Voice and Chat schemas in Phase A.
Do not merge Bot into Chat.

---

## Result payload costs

`chat-agent-loop.js` caps every tool result at **16,000 characters** (`TOOL_RESULT_CAP`).
`lykn_loadNeuron` vault body cap is 16KB; batch load is 4KB/item.
`local_pull_file` uploads bytes and returns a URL; base64 must not enter model context (enforced in `localToolExecutor.ts`).

| Tool | Payload shape | Opportunity |
|---|---|---|
| `lykn_listProjects` | up to 50 projects with state/neuron counts | already limited; fine |
| `lykn_listTodos` | up to 200 | **pagination** |
| `lykn_listEvents` | up to 100 | windowed; still large weeks |
| `lykn_listReminders` | up to 100 | fine |
| `lykn_loadNeuron` | full note + display string | **artifact reference** already via card; model still gets 16KB |
| `lykn_loadNeurons` | up to 10 × 4KB | bounded |
| `lykn_web_search` | ranked snippets + optional deep browse | can be huge before 16KB clip |
| `lykn_web_fetch` | page text | 16KB clip; prefer summary |
| `lykn_build_react_artifact` | full code/files echoed back | **artifact reference**; result still large |
| `lykn_generate_image` | URLs, not pixels, in tool JSON | good |
| `lykn_http_request` | raw body | **bound + redact** |
| `lykn_getProjectNeurons` | member list | can be large clusters |
| `memory_list` | compact metadata, no bodies | good |
| `memory_read` | full markdown, `maxTokens` | already has a bound |
| Voice `search_vault` | hybrid hits | Chat retired this path |

The 16KB hop cap is a blunt instrument: the model still pays for truncated JSON plus a `truncated:true` wrapper.

---

## Prompt tool-guidance costs

When tools are on and the lean slim block is **not** used:

- Core `LYKN_CHAT_TOOL_GUIDANCE`: **~6.1K tokens**, every tool-on leftover turn.
- Plus visual+exterior on make turns: **+1.7K**.
- Plus design-system / style-guide injection (variable, can exceed the tool blocks).
- Plus scheduling **+1.0K** when `MANAGED_SURFACE_INTENT` matches.

When lean allowlist hits: **~148 tokens** of slim policy.

Dynamic disclosure of schemas can drop the 6.1K core menu if the model only sees the families that are actually attached.
That is a second major saving, possibly larger than schema savings on simple turns (already 0) and comparable on leftover turns (6K guidance + 13K schemas).

Personas also contain vault/web/image/build policy (~3.5K).
That remains even when tools are off (fast-lean uses a slimmer persona).

---

## Provider serialization

Preferred shape already exists:

`canonical tool objects` → `resolveChatTools(names)` → `buildOpenAiTools` / `buildAnthropicTools` / `buildGeminiTools` → `chat-agent-loop.js` provider branch.

Progressive disclosure must happen **before** `build*Tools`, as `chatToolNames`.
It already does.

Gemini sanitizes `additionalProperties` / `$schema` / `const`.
That is formatting, not filtering.
`tool_choice` forces a named tool on Create/Imagine hops; it is not a substitute for allowlists.

Grok uses the OpenAI tool JSON.

Do not add provider-specific tool subsets.

---

## Historical UI compatibility

| Tool | UI | Saved-chat note |
|---|---|---|
| `lykn_loadNeuron` / `lykn_loadNeurons` | `ChatNeuronCard`, `VaultDocumentViewer` | Keep even if model call rate is low |
| `belief` / `fact` / `concept` neurons | same card kinds | **COMPATIBILITY**; creators deleted |
| `lykn_generate_image` | artifact card, Imagine thread | LIVE |
| Builders (`build_react_artifact`, template, spreadsheet, manage_file, chart, diagram, video) | `LyknChatArtifactPanel` | LIVE; `lykn_inline_html` is a renderer alias only |
| `lykn_open_app` / `lykn_open_settings` | client window actions | LIVE |
| `lykn_update_assistant_instructions` | client persist | LIVE |
| Voice `display_document` | media pop / neuron payload | LIVE Voice |

Do not mark a tool DEAD because the model rarely calls it if historical messages still render its results.

---

## Test coverage

| Area | Tests | Gap |
|---|---|---|
| Memory tools execute + Chat allowlist membership | `tests/memory/memoryTools.test.mjs`, `memoryCutover.test.mjs` | Does not snapshot the other 61 Chat names |
| Chat whitelist reject | implied by `runChatTool` + memory steal tests | **No test** that `lykn_searchVault` / `lykn_list_apps` are rejected from Chat |
| Intent allowlists | none import `resolveIntentChatToolNames` (it is private in `server.js`) | **Characterization gap** for every representative turn |
| Casual/lean `useTools=false` | none | **Gap** |
| Maker/project/Glass strips | none | **Gap** |
| Provider schema converters | none for Chat `buildOpenAiTools` | **Gap** (Gemini sanitizer untested) |
| Local capability denial | `localExecutor.test.cjs`, `localConsequence.test.cjs` | Strong |
| Remote / browser / GitHub capability denial | corresponding executor tests | Strong |
| Artifact UI parsing | `chatArtifacts.test.ts` | Strong for builders |
| Voice tool list parity overlay/Eleven/server | none | **Gap** |
| `allowedToolNames` hallucination | none end-to-end | **Gap** |

Before changing disclosure, add characterization tests that freeze:

1. `"hello"` → 0 tools.
2. Web ask → `{lykn_web_search, lykn_web_fetch}`.
3. Vault save → 4-name set.
4. Project ask → 10-name set.
5. Ambiguous `"make me something"` → leftover 42 (or whatever the new resolver returns).
6. `runChatTool('lykn_searchVault')` from Chat ctx → error.
7. Hallucinated name with a lean allowlist → `tool_not_enabled_for_model`.

Those tests should extract the filter functions from `server.js` or they will rot.

---

## Progressive disclosure feasibility

**Yes**, without changing Task semantics.

Chat already:

- selects a name subset per turn
- serializes only that subset
- re-checks the subset at execution
- expands Local Mode onto the same list
- can slim prompt guidance when the subset is small

What is missing is a **named family layer** so the leftover 42-tool bucket goes away, and a **second-stage expand** so a turn that starts as web can add vault.write without restarting the Task/turn.

Bot Harness proves second-stage inside one run.
Chat hops can do the same: hop 1 sees `{web.search, web.read}`; model calls a reserved `request_capability` **or** the runtime infers from the first tool result; hop 2 gets the extra family.
Prefer **deterministic expansion** (user said "save that") over a model-visible `search_tools`.

A model-visible `search_tools` / meta-tool is **not required** for the majority.
Current intent regex already covers web, vault, project, scheduling, calc, cursor, exclusive modes.
The failure mode is ambiguous "make" and "Gmail"/external apps, which should become `media.*` (mode-locked) and `connections.*` / MCP families, not an embedding search over 66 schemas.

---

## Recommended architecture

```
User message / composer mode / Task.capabilities
        ↓
FirstPartyCapabilityResolver   (deterministic; small family grammar)
        ↓
small capability set
        ↓
FirstPartyToolResolver         (family → tool names; clip still applies)
        ↓
combine with ExternalToolResolver  (Universal MCP; ≤10; not on HEAD)
        ↓
resolveChatTools(names) → provider serialization
        ↓
model

Execution independently:
  Chat: CHAT_TOOLS_BY_NAME ∩ turn allowed names ∩ handler gates
  Task: capabilities[] ∩ consequence policy ∩ approvals
```

The model not seeing a tool is **not** the security gate.

Chat-as-ordinary-turn uses composer + message inference.
Chat-as-Task (Bot/Routine) uses `capabilities[]` as the ceiling; inference only **narrows**.

---

## Expected token reduction

Do not chase a vanity number.
Realistic ranges after Phase A, using current measurements:

| Turn class | Today schemas ~tokens | After family disclosure | Notes |
|---|---:|---:|---|
| Simple chat `"hello"` | 0 | 0 | Already optimal |
| Web task | 532 | 500–700 | Already lean; maybe add `web.http` only on demand |
| Vault save | 2,084 | 1.5K–2.5K | 4 tools; could drop `open_app` unless "show me" |
| Project find | 4,182 | 2K–4K | 10 tools is still fat; split read vs write |
| Imagine | 721 | 700 | Fine |
| Scheduling | 5,282 | 2K–3K if split todos vs calendar vs reminders | Biggest lean-path offender after leftover |
| Ambiguous make (regular chat) | **13,201** + ~6K guidance | **0–1K** (redirect to Build) or one builder | Largest Chat win |
| Local file (Local Mode on) | **16,083** | **2.9K local + 0–1K Chat core** | Stop appending leftover 42 |
| MCP email (worktree, today) | leftover 42 + ≤10 MCP | **~2K first-party core + ≤2.3K MCP** | Only after first-party families exist |
| Complex multi-surface Task | 13K–16K + MCP | low thousands per active family, stacked | e.g. web+vault+project ≈ 7K if all three armed |

Common-turn reduction is **not** "29K → 2K" for hello (already 0).
It **is** "13K–23K leftover dumps → low thousands", plus dropping 6K of always-on tool guidance on those turns.
That is the honest win.

---

## Implementation phases

Two phases only.

### Phase A — Chat capability metadata + resolver + disclosure

1. Freeze characterization tests for the representative turns and the leftover 42-name set.
2. Add a small canonical table: family → tool names → default risk → prompt stub.
   Live in one module next to `chatTools.js`, not in `server.js` regexes.
3. Replace `resolveIntentChatToolNames` + leftover fallback with family inference.
   Exclusive composer modes stay hard locks.
   Ambiguous `"make…"` must not dump 42 tools.
4. Stop appending the leftover Chat 42 when Local Mode is on; append only local families plus a tiny core if needed.
5. Keep `runChatTool` allowlist as authorization for Chat.
   Do not treat missing schemas as the only gate.
6. When Universal MCP lands, combine **after** first-party resolve, and allow `useTools` to stay on for external-only needs (`connections.*` / inferred MCP needs) so `"check Gmail"` can receive ≤10 MCP tools without 42 first-party schemas.

Out of scope for A: Voice, Bot merge, deleting tools, Teach-by-Demonstration, shrinking artifact parameter schemas.

### Phase B — Voice/Bot consolidation, result bounding, prompt cleanup

1. Voice: same family resolver; drop overlay/Eleven drift; keep Voice-only aliases where UX needs them (`display_document`).
2. Replace 6K `LYKN_CHAT_TOOL_GUIDANCE` menu with the attached families' short stubs (slim path becomes the default).
3. Bound list endpoints and artifact tool results (pagination / artifact refs).
4. Optional Chat second-stage: expand families mid-loop without a meta-tool, matching Bot "load doc on first select".
5. Delete stale prompt/status strings (`lykn_proposeBelief`, `lykn_communicate_with_model`, connected-app contradictions).
6. Align `CAPABILITY_RUNTIME_MAP` or isolate it as Model-Builder-only.

Do not merge Bot Harness into Chat in either phase.

---

## Risks

- **Regex false negatives** already drop tools (Gmail, browse without Local Mode).
  A stricter family resolver can make that worse if families are too few.
  Prefer fail-open to a **small default** (web.read + memory.read) rather than fail-open to 42 tools.
- **Local Mode blanket grant** remains if Phase A only hides schemas.
  Writes would still be callable if the model guessed names **and** Local Mode is on, because `LOCAL_TOOL_NAMES` is appended in full.
  Phase A must subset local families too, and keep Electron approval as the write gate.
- **Saved UI**: do not remove loadNeuron/artifact renderers.
- **Voice contract**: ElevenLabs agent tool names are configured outside this repo.
  Changing Voice names is a product/ops risk for Phase B.
- **Custom-model catalog drift** if Phase A ignores `modelCapabilitiesCatalog.js`.
- **MCP combination**: if `useTools` stays false for email, Universal MCP never attaches.
  Phase A must treat external need as a reason to keep the loop on.
- **Teach-by-Demonstration / TaskRuntime files**: do not edit them for this work.

---

## Exact files likely involved

Phase A (expected):

- `mcp-tools/chatTools.js` (resolver export, family table; keep converters)
- `server.js` (replace intent/fallback/maker/project strips with resolver calls; keep exclusive modes)
- `chat-agent-loop.js` (only if second-stage names change mid-loop; otherwise untouched)
- `lib/webSearchIntent.cjs` (keep as web-family input)
- `mcp-tools/localTools.js` (`looksLikeLocalSystemAsk` / `mightBeBrowserTaskAsk` as family inputs)
- New tests under `tests/` or `mcp-tools/*.test.mjs` for disclosure characterization
- `lib/modelBuilder/modelCapabilitiesCatalog.js` (read-only alignment, or isolate)

Phase B:

- `server/routes/voice.routes.js`
- `electron/overlay.js` `VOICE_TOOL_NAMES`
- `src/components/lyknChat/LyknChatVoiceModeEleven.tsx`
- `src/lib/ai/toolStatusVerbs.ts`
- `LYKN_CHAT_TOOL_GUIDANCE` / personas in `server.js`
- `mcp-tools/loadNeuron.js` and other descriptions that still teach `lykn_searchVault`
- Artifact result shaping in `mcp-tools/exterior/capabilityTools.js` / `chat-agent-loop.js`

Do not touch for this work:

- `.worktrees/teach-by-demonstration/**`
- `electron/task-runtime/**` except as a **read** template for capability enforcement
- Bot Harness runtime (read template only)

---

## Method

- Read root `AGENTS.md`, `docs/refactor/dedup-dead-code-audit.md`, `docs/refactor/agent-harness-audit.md`, and Universal MCP architecture in the worktree.
- Mechanical import of `CHAT_TOOL_NAMES`, `buildOpenAiTools`, Local Mode schemas.
- Traced `server.js` stream tool pipeline, `runChatTool`, Voice defs, Bot registry, TaskRuntime executors.
- Repository search for the requested symbols.
- Did not call models.
- Did not modify Teach-by-Demonstration or Universal MCP worktrees.
