# First-party Chat tool disclosure

Status: Phase A complete.
Voice alignment, result bounding, and the ~6K tool-guidance menu cleanup are Phase B.

Disclosure is not authorization.
Hiding a schema from the model is a token and accuracy optimization.
Execution still requires `runChatTool` (Chat whitelist ∩ per-turn `allowedToolNames` ∩ handler gates), Local Mode Electron approval, and TaskRuntime capability/consequence checks when Chat is running as a Task.

## Pipeline

```
User turn / composer mode / Chat context
        ↓
FirstPartyCapabilityResolver     mcp-tools/firstPartyCapabilities.js
        ↓
small capability set
        ↓
FirstPartyToolResolver
        ↓
composeWithExternalTools         optional MCP / ExternalToolResolver
        ↓
resolveChatTools(names) → OpenAI / Anthropic / Gemini / Grok serialization
        ↓
model
```

Provider adapters only serialize.
They do not choose tools.

## Capability families

Grammar is small and derived from live Chat + Local Mode tools:

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
Ordinary conversation (`hello`) discloses **0** tools.

`connections.external` is a disclosure signal for Universal MCP, not a Chat-callable family.
`lykn_list_apps` / `lykn_call_app` stay Voice-only.

## Tool metadata

Canonical rows live in `FIRST_PARTY_TOOL_METADATA`.
Every `CHAT_TOOL_NAMES` entry and every Local Mode schema is mapped.
Eight Chat-hidden or feature-gated callables are listed in `FIRST_PARTY_TOOL_EXCLUSIONS` with a rationale.
They are not deleted.

Metadata refers to canonical tool definitions.
It does not duplicate schemas.

## Selection order

1. Exclusive composer mode (research / web / image / translate) hard-locks the surface.
2. Existing deterministic signals (`resolveIntentChatToolNames`, vault/project/web/calendar/local heuristics, composer flags) infer families.
3. FirstPartyToolResolver maps families to canonical names, then applies Glass / project / maker strips that exclusive modes already owned.
4. Local Mode adds only inferred local families.
5. Optional `composeWithExternalTools` attaches ≤10 MCP tools for inferred external needs.
6. Custom-model ceilings intersect; main-agent orchestration tools may be re-injected after resolve.

Ambiguous but tool-capable turns do **not** receive the old 42-tool leftover dump.
The bounded fallback is **empty** (or Local discovery `local_synced_folders` / `local_list_dir` / `local_search_files` when Local Mode is on and the ask is local-shaped but unspecific).

Remote SSH / GitHub remain TaskRuntime.
Chat discloses nothing for those paths.

Second-stage family expansion inside the agent loop is exported as `expandFirstPartyDisclosure` but not wired.
Phase A selects the relevant families up front.

## MCP composition

First-party resolve runs first.
External tools are selected by inferred need (`email`, `documents`, …) from a discovered catalog, capped at `MAX_EXTERNAL_TOOLS_PER_DISCLOSURE` (10).
An email turn is a small first-party subset plus ≤10 Gmail MCP tools, not 42 Chat tools plus a global MCP dump.
Normal Chat with no external need discloses 0 MCP tools even if 500 tools exist across 10 connections.

HEAD Chat does not yet run Universal MCP.
The composer is the seam for that worktree.

## Local Mode

Local Mode is not "all 14 local schemas plus leftover Chat tools".
`read this local file` gets file-read local tools and only minimal Chat support.
`search the web` while Local Mode is on gets web tools and does not automatically append unrelated local families.
Writes, shell, apps, desktop, and `local_browser_agent` attach only when inferred.
Turn enablement for local names is the disclosed `localToolNames` list; Electron approval remains the write gate.

## Authorization

A model that emits a hidden name still hits:

- `tool_not_enabled_for_model` when the name is missing from this turn's allowlist
- `tool_not_whitelisted_for_chat` when the name is not in `CHAT_TOOLS_BY_NAME`

Progressive disclosure cannot bypass those gates and is not itself a security boundary.

## Prompt guidance

Lean turns now use `buildSlimChatToolGuidance` listing the disclosed names.
Create / Imagine still receive the existing visual `LYKN_CHAT_TOOL_GUIDANCE` blocks.
The remaining ~6K capabilities menu cleanup is Phase B.

## Observability

Each tool-enabled stream logs capability ids, tool count, schema bytes, and approximate tokens.
It does not log user text.
Tests can call `inspectFirstPartyDisclosure` / `measureChatToolSchemas` (UTF-8 bytes / 4, same estimator as the audit).
