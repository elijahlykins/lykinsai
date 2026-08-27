# LYKN residual megafile and composition-root audit

**Date:** 2026-08-26
**Mode:** audit only.
**Constraint:** no source modifications except this file.
**Scope:** current working tree, excluding `node_modules`, `dist`, `build`, `.worktrees`, generated files, lockfiles, fixtures, migrations, snapshots, and vendored code.

This document replaces stale megafile numbers from earlier decomposition plans.
`docs/refactor/server-decomposition-plan.md` still describes `server.js` at 17,803 lines after Wave 7.
That number is obsolete.
`docs/refactor/dedup-dead-code-audit.md` (same day) is re-evaluated in §15.

Concurrent streams that are **not** on this HEAD:

- Universal MCP lives in `.worktrees/universal-mcp`.
- Teach-by-Demonstration lives in `.worktrees/teach-by-demonstration`.
- Neither has a product UI or runtime on current HEAD.
- Do not churn those worktrees from this cleanup plan.

Prioritization used here is **not** line count:

1. correctness risk
2. duplicated lifecycle authority
3. feature-change collision rate
4. responsibility count / import fanout
5. test coverage
6. deletion opportunity
7. line count

Large + cohesive + stable is **KEEP**.
Large + mixed + hot is **debt**.

---

## Executive summary

The architecture overhaul worked.
Route domains, TaskRuntime, the four executors, Routines, progressive tool disclosure, and Memory cutover removed the old "everything lives in three files" shape.

What remains is a different problem:

- Three files are still genuinely oversized mixed-responsibility hosts: `electron/agentRuntime.cjs`, `server.js`, `electron/ownedBrowserAct.cjs`.
- Two Electron composition roots are still large because extraction moved **functions** but left **state and glue**: `electron/main.cjs`, `electron/overlay.js`.
- Two frontend pages remain god components despite successful leaf extraction: `src/pages/Vault.jsx`, `src/pages/LyknChat.tsx`.
- New runtimes (TaskRuntime, executors, Remote, Routines, first-party disclosure) are **healthy and modular**.
- Do not decompose them for size.

`server.js` is no longer an undisciplined route dump.
It is a composition root plus a still-inline Chat stack.
`agentRuntime.cjs` is no longer the sole execution authority.
It is still the Glass host, skill router, multi-step orchestrator, and legacy-fallback owner.

The highest-value remaining work is **authority cleanup**, not another round of random file splitting.

---

## 1. Current file-size inventory

Mechanical count of `.js` / `.ts` / `.tsx` / `.jsx` / `.cjs` / `.mjs` / `.css` / `.scss`.
**1,135 source files. ~379k physical lines** in that set.

### Top 20 (physical lines)

| Rank | Lines | Nonblank | Bytes | File |
|---:|---:|---:|---:|---|
| 1 | 13075 | 12584 | 526k | `electron/agentRuntime.cjs` |
| 2 | 12941 | 12305 | 691k | `server.js` |
| 3 | 12759 | 12253 | 509k | `electron/ownedBrowserAct.cjs` |
| 4 | 6375 | 6019 | 226k | `electron/overlay.js` |
| 5 | 6232 | 5725 | 278k | `electron/main.cjs` |
| 6 | 3744 | 3540 | 150k | `src/pages/Vault.jsx` |
| 7 | 3577 | 3368 | 150k | `src/pages/LyknChat.tsx` |
| 8 | 3339 | 2940 | 75k | `src/styles/landing.css` |
| 9 | 3076 | 2952 | 78k | `src/pages/GlassLanding.css` |
| 10 | 3011 | 2645 | 77k | `src/styles/wake-onboarding.css` |
| 11 | 2560 | 2485 | 125k | `src/components/lyknChat/LyknChatView.tsx` |
| 12 | 2297 | 2176 | 83k | `src/pages/GlassLanding.tsx` |
| 13 | 2198 | 2111 | 89k | `electron/overlay/askPipeline.cjs` |
| 14 | 2171 | 2035 | 87k | `chat-agent-loop.js` |
| 15 | 2127 | 2023 | 83k | `src/components/lyknChat/StudioImagineMode.tsx` |
| 16 | 2028 | 1909 | 70k | `src/components/macdesktop/DesktopWidgets.jsx` |
| 17 | 1984 | 1872 | 72k | `src/lib/synthesis/loadInUpdates.ts` |
| 18 | 1843 | 1738 | 71k | `src/components/notes/SettingsModal.jsx` |
| 19 | 1818 | 1737 | 88k | `src/lib/ai/chatSendOrchestrator.ts` |
| 20 | 1810 | 1730 | 84k | `electron/browser-agent/index.cjs` |

### Top 50 grouped

**Server** (34 files, ~25k lines).
Largest: `server.js` 12941, `server/routes/desktop.routes.js` 1747, `voice.routes.js` 1221, `assist.routes.js` 972.
Extracted route modules are in the 300–550 band and look healthy.

**Electron** (162 files, ~89k lines).
Largest: `agentRuntime.cjs` 13075, `ownedBrowserAct.cjs` 12759, `overlay.js` 6375, `main.cjs` 6232, `overlay/askPipeline.cjs` 2198, `browser-agent/index.cjs` 1810, `ipc/overlayAi.cjs` 1492, `localSystem.cjs` 1347, `browserAct.cjs` 1306, `ipc/agentBridge.cjs` 1131.

**Frontend** (422 files, ~127k lines).
Largest: `Vault.jsx` 3744, `LyknChat.tsx` 3577, `LyknChatView.tsx` 2560, `GlassLanding.tsx` 2297, `StudioImagineMode.tsx` 2127, `DesktopWidgets.jsx` 2028, `loadInUpdates.ts` 1984, `SettingsModal.jsx` 1843, `chatSendOrchestrator.ts` 1818, `ProjectDetailPage.jsx` 1702, `AdminUsage.jsx` 1688, `Studio.jsx` 1661.

**AI / chat libs** (106 files, ~25k lines).
Largest: `chat-agent-loop.js` 2171, `lib/exterior/capabilities/buildReactArtifact.js` 966, `lib/agentToolVenues.cjs` 893.

**Agent runtime** (canonical new modules, not the host file).
`taskRuntime.cjs` 342, `taskCompiler.cjs` 335, `localExecutor.cjs` 229, `remoteExecutor.cjs` 187, `browserExecutor.cjs` 161, `bot-harness/index.cjs` 347, `routineRuntime.cjs` 418.
These are **not** megafiles.

**Vault backend** is small.
Largest live vault libs: `lib/rag/vaultHybrid.js` 480, `jobs/vaultReconcilerJob.js` 527.
The Vault **frontend** lives under frontend above.

**MCP / first-party tools** (`mcp-tools/`, 63 files, ~14k lines).
Largest: `firstPartyCapabilities.js` 1058, `voiceTools.js` 823, `exterior/capabilityTools.js` 764, `chatTools.js` 674.
Modular.
No Universal MCP runtime on this HEAD.

**Tests** (158 files, ~32k lines).
Largest are characterization suites (`lib/agentSkillRouting.test.cjs` 1475, `browserAgent.test.cjs` 1082).
Large tests are not a megafile problem.

**Other**
Remotion compositions (1k–1.5k each), `youtubeQa.js` 984, `usageTracking.js` 830.
Marketing CSS listed in the top 20 is TIER 4.

---

## 2. Size bands

| Band | Count | Files that matter |
|---|---:|---|
| **>10,000** | 3 | `agentRuntime.cjs`, `server.js`, `ownedBrowserAct.cjs` |
| **5,000–10,000** | 2 | `overlay.js`, `main.cjs` |
| **3,000–5,000** | 5 | `Vault.jsx`, `LyknChat.tsx`, plus three CSS sheets |
| **2,000–3,000** | 6 | `LyknChatView.tsx`, `GlassLanding.tsx`, `askPipeline.cjs`, `chat-agent-loop.js`, `StudioImagineMode.tsx`, `DesktopWidgets.jsx` |
| **1,000–2,000** | 37 | Mix of healthy extracts, catalogs, Remotion, tests, and a few overgrown pages |

CSS / Remotion / connector catalog / demo chats are **not** automatically problems.

---

## 3. `server.js`

**Current:** 12,941 lines.
**Inline HTTP routes remaining:** 6.

- `GET /api/ai/models`
- `POST /api/ai/stream-guest`
- `POST /api/ai/feedback`
- `POST /api/ai/invoke`
- `POST /api/ai/local-tool-result`
- `POST /api/ai/stream`

26 `register*Routes` calls remain.
Route extraction (Waves 0–7) succeeded.

### Band classification

| Band | ~Lines | Class |
|---|---:|---|
| Imports, perimeter, CORS, JSON parsers, auth, limiter construction, error handler, listen + poller start | ~1.5–2.0k | **COMPOSITION ROOT — KEEP** |
| Web/YouTube intent helpers | ~314 | **EXTRACT** |
| Caches / Gemini context cache / output caps | ~317 | **EXTRACT** |
| Vault retrieval (still named "synthesis") | ~1031 | **EXTRACT** (name is LEGACY; logic is live RAG) |
| Connected tools + project/custom-model sections | ~352 | **EXTRACT** |
| Memory seam (`resolveProductionChatMemory`) | ~115 | **COMPOSITION ROOT — KEEP** (thin adapter) |
| Voice greeting / briefing helpers | ~435 | **EXTRACT** (already a voice-route dep) |
| Model routing / provider invoke | ~428 | **EXTRACT** |
| Personas + remaining inline tool-guidance families | ~1.2k | **EXTRACT** |
| `/api/ai/stream-guest` | ~606 | **EXTRACT** |
| `/api/ai/invoke` including `returnActions` | ~1749 | **EXTRACT** (LEGACY protocol still live on invoke) |
| `/api/ai/stream` | ~3366 | **EXTRACT** (hard; agent-loop call site) |
| Billing helpers + caches (`userPlanCache`, `requireAppAccess`, Stripe sync) | ~743 | **EXTRACT** / **COUPLED — DEFER** only if AI gates cannot take a dep |
| MCP host | 0 | **DEAD** as a band (tools live in `mcp-tools/`) |
| Calendar / Remote / GitHub as dedicated bands | 0 | **DEAD** as bands (prompt/poller residue only) |
| Process pollers (RSS, connectors, cursor builds) | wiring only | **COMPOSITION ROOT — KEEP** |

### Mutable process state still in `server.js`

`_memCaches`, Gemini cache Maps, `_embedQueryCache`, `projectSectionCache`, `connectedToolsSectionCache`, `localToolStreams`, `openaiModelsCache`, guest-hour counters, `userPlanCache`, `appAccessGrace`, `freeCreditsCache`.

Owner should move **with** the subsystem (billing caches with billing; `localToolStreams` with stream).

### Residue vs earlier audits

| Item | Now |
|---|---|
| Identifier `LYKN_CHAT_TOOL_GUIDANCE` | **GONE**. Replaced by `mcp-tools/chatToolGuidance.js` plus smaller inline family blocks |
| `fetchBeliefSection` / `lykn_findConnections` in `server.js` | **GONE**. Cutover test still mentions the string as a negative assertion |
| `toolStatusVerbs.ts` deleted-tool names | **GONE** |
| `returnActions` / action JSON on invoke | **STILL PRESENT** (LEGACY public contract; client callers are dead) |
| Agent loop implementation | Already extracted to `chat-agent-loop.js` (2171) |

### Is `server.js` still a genuine megafile problem?

**Yes for Chat + shared infra size. No for "undisciplined routes dump."**

Much of the remaining size is cohesive bootstrap plus shared Chat infrastructure.
That cohesion is why further cuts should be **Chat-stack modularization**, not more unrelated `register*Routes`.

### Realistic target

```
Current:                 12,941
Likely removable/extractable:
  helpers                ~4.5–5.0k  (moved)
  AI handlers            ~5.9k      (moved)
Healthy composition root: 2.5k–4.5k
Planning number:          ~3.5k
Do not chase <1000.
```

Helpers-only (handlers stay): ~6.5k–8.0k.
That is a valid intermediate if stream extraction is deferred.

Testability: `tests/server/` (manifest, middleware order, critical routes) makes **route** extraction **READY**.
Chat stream/invoke extraction is **NEEDS HARNESS** (SSE + provider fallback + tool loop).
Do not extract `/api/ai/stream` without a characterization harness.

---

## 4. Chat core

| File | Lines | Role | Mix? |
|---|---:|---|---|
| `src/lib/ai/chatSendOrchestrator.ts` | 1818 | Send pipeline | Multi-phase lib, not a React god |
| `src/hooks/useChatEngine.ts` | 1319 | Engine hook | **Hook god** |
| `src/pages/LyknChat.tsx` | 3577 | Page composition root | **Still a god wiring hub** |
| `src/components/lyknChat/LyknChatView.tsx` | 2560 | Thread UI projection | Thread cluster; `MessageItem` nested-god |
| `src/lib/ai/chatTranscription.ts` | ~318 | Attachment/YouTube/media phases | **Healthy extract** |
| `src/components/lyknChat/chatMarkdownComponents.ts` | ~148 | ReactMarkdown map | **Healthy extract** |
| `src/lib/ai/chatArtifacts.ts` | 829 | Artifact types + parsing | Cohesive, slightly large |
| `src/hooks/useLyknChatPersistence.ts` | 1223 | Hydrate/reconcile | Single domain, oversized |
| `chat-agent-loop.js` | 2171 | Server tool loop | Cohesive extracted loop |

### Seams left by prior decomposition

| Seam | Clean? |
|---|---|
| Attachments (ingest libs) | Partial. Page still owns Home/Studio/Bot/Vault ingress |
| Send lifecycle | Good (`handleChatSend` → `orchestrateChatSend`) |
| Stream lifecycle | Good (orchestrator + `chatThreadRuntime`) |
| Thread reconciliation | Good / heavy (persistence hook) |
| Composer | Partial. Studio/Home duplicate composer paths |
| Tool loop | Good (server `chat-agent-loop` + client local executor) |
| Imagine | Good as a module. Dirty integration with chat thread/home bar |
| Artifacts | Partial. Cards/panel extracted; open/edit still page+engine |
| UI projection | Good (`LyknChatView`) |
| Markdown components | Good |
| Transcription | Good extract. Internal YouTube retry loops still duplicated inside the file |

Remaining mixed responsibilities in the page: event-bus for desktop, Studio mode stickiness, Home-bar send, Bot bridge, app-edit, research prefs, rail resize, overlays.

`handleActionPath` is still defined and never invoked (~93 lines).
Canvas DI stubs on `ChatSendParams` are still the orchestrator contract.

---

## 5. `electron/main.cjs`

**Current:** 6,232 lines.

IPC extraction is effectively complete.

- `electron/ipc/*.cjs`: **229** handlers (`handle` + `on`)
- `main.cjs`: **1** remaining (`lykn:get-version`, sync `returnValue`)

What remains is not "more IPC to move."

### Remaining bands

| Band | ~Lines | Class |
|---|---:|---|
| Privileged schemes, `whenReady`, lifecycle, protocol | ~400 | **BOOTSTRAP — KEEP** |
| 238 thin `function x(...a) { return d.x(...a); }` forwarders | ~238 | **LEGACY BRIDGE — DELETE** |
| `bindShellContext` (`defineProperty` + 238 `typeof` fallbacks) | ~519 | **LEGACY BRIDGE — DELETE** |
| Agent browser Maps, stage layout, studio dock, sidebar, artifacts | ~3724 | **STATE OWNER — MOVE** (Agent Harness) |
| `initAgentRuntime` / `initRoutineRuntime` wiring | thin | **REGISTRATION — KEEP** |
| `showAgentFinishedPopup` | ~165 | **REGISTRATION — EXTRACT** |
| Empty `notifyAgentFinished` | stub | **DEAD** |
| Duplicate early `attachDesktopAuth` | — | **DUPLICATE** |

Mutable Maps still **declared in main** even when modules own behavior: `agentBrowserViews`, `agentBrowserMeta`, `agentIncognito`, `artifactHtmlCache`, Live Watch vars, overlay ask gens.

Comment at the harness band already says this stays until a dedicated Agent Harness redesign.

MCP: **absent from main**.
TaskRuntime: **not constructed in main** (lives in `agentRuntime`).
Remote IPC: `ipc/remoteTargets.cjs`.
Routines: thin `initRoutineRuntime` plus `ipc/routines.cjs`.

Nearby extracted files:

| File | Lines | Health |
|---|---:|---|
| `electron/overlay.js` | 6375 | Renderer megafile. Not a failed extract. Still a god UI |
| `electron/overlay/askPipeline.cjs` | 2198 | Domain-coherent extract, already oversized |
| `electron/ipc/overlayAi.cjs` | 1492 | IPC kitchen-sink. Acceptable registration file |
| `electron/ipc/agentBridge.cjs` | 1131 | Acceptable bridge. Shrinks if harness moves |

### Realistic target

```
Current:                          6,232
Delete LEGACY BRIDGE glue:        ~3,800–4,200 remaining (harness still in main)
Extract Agent Harness:            ~500–800
Ideal thin shell:                 ~400–600
Near-term without harness move:   ~4,000
Honest thin-main end state:       ~500–800
```

Testability: `tests/electron/ipcManifest.test.cjs` + `ipcSurface.cjs` make IPC moves **READY**.
Harness extraction is **NEEDS HARNESS** / **HIGH RISK**.

---

## 6. `electron/agentRuntime.cjs`

**Current:** 13,075 lines.
`createAgentRuntime` is lines 937–13059 (~93% of the file).

Canonical owners now exist and **are used**:

- `TaskRuntime` instantiated once
- `BotExecutor`, `BrowserExecutor`, `LocalExecutor`, `RemoteExecutor` wired
- `browser-agent` is the default browse brain
- `localAgentTask` / `remoteAgentTask` are the local/remote brains
- Routines late-bind via `setRoutineBridge`

### What it still owns (real authority)

1. Agent roster, persist, Glass status, IPC emit
2. Skill classification and turn routing (`classifyAgentSkill`, `runOneSkill`, `send`)
3. Non-executor chat delivery (`streamChat`)
4. Browse **pre-routing** (`runBrowse`, ~1.1k)
5. Multi-step plan loop inside `send()`
6. Tool-venue / sheets / mail / delegate UX
7. Approval/question UI
8. Electron browser session glue (`runModularBrowserAgent`)
9. **Legacy fallbacks** and **send-tail Task settlement**

### Compatibility / authority leftovers (highest value)

| Item | Class |
|---|---|
| `LYKN_BROWSER_AGENT=legacy` → `ownedBrowserAct.executeOwnedAdaptiveTask` | **LEGACY BRIDGE — DELETE** when retired |
| `AgentModelUnavailableError` → same legacy loop | **LEGACY BRIDGE** keep only until `/api/desktop/agent-model` is universal |
| `LYKN_BOT_HARNESS=0` → single-shot `streamChat` | **LEGACY BRIDGE — DELETE** |
| Harness throw → `bot:harness-fallback` → `streamChat` | **LEGACY BRIDGE** |
| Send-tail `taskRuntime.complete` / `waitForUser` for dangling Bot tasks (`browser_legacy_fallback`) | **STATE OWNER leftover / duplicated authority** |
| Hardcoded Bot capability lists + `ensureBrowserTask` bypassing `taskCompiler` | **DUPLICATE** |
| Duplicated Bot vs routine child-executor maps | **DUPLICATE** |
| `@deprecated` `runCreateInSheets` | **DEAD** (test uses it as a source-slice delimiter) |
| `MAX_AGENTS` alias | tiny **KEEP** |

### Realistic post-cleanup size

```
Current:            13,075
Conservative:       ~10.5k–11.5k   (kill switches + cap compile + aliases)
Realistic:          ~8.5k–9.5k     (plus drop legacy browse ladder; extract modular host)
Aggressive extract: ~6.5k–7.5k     (also move classify/streamChat/formatters)
Irreducible host:   ~4–5k          (roster, send() multi-step, runBrowse, Glass done)
```

Collapsing this file to TaskRuntime size is a product change, not a cleanup.
Glass multi-step and browse pre-routing are still first-party host loops.

Testability: many characterization tests import `createAgentRuntime` or slice source (`toolWriteInLoop`, `verifiedComplete`, `agentSkillRouting`, persist, waiting, bot routing).
Kill-switch deletion: **READY** (behavior change, but testable).
Factory split: **HIGH RISK** without moving tests with the extract.

---

## 7. Browser legacy

**Canonical contract:** `BrowserExecutor` (~161 lines).
**Canonical brain:** `electron/browser-agent/` (`index.cjs` 1810, plus runtime/browser modules).
**Canonical actuator + leftover loop:** `ownedBrowserAct.cjs` (12759).

`ownedBrowserAct` is **not** uniformly dead.

- DOM catalog, `runAction`, screenshots, mail helpers, URL heuristics, and exported `looksLike*` classifiers are the **live actuator**.
- `executeOwnedAdaptiveTask` (~5319–6698, ~1,380 lines) is the **obsolete compatibility loop**.
- It remains reachable via `LYKN_BROWSER_AGENT=legacy` and agent-model-unavailable fallback.

`electron/browserAct.cjs` (1306) is **external Chrome via AppleScript**, not the owned-browser loop.
Do not merge it with `browser-agent`.
Do not merge `browser-agent` with `bot-harness`.

`ownedBrowserAct` change concentration since 2026-07-01: **7 commits** (stable relative to size).
`browser-agent/index.cjs`: 8 commits.
`overlay.js`: 20.
This file is large and cohesive as an actuator, dangerous only because the legacy loop still shares the file.

Realistic ownedBrowserAct target after loop retirement: **~11k**, still an actuator megafile, **KEEP** as inner-loop/security-adjacent code.
Do not split the actuator merely to lower the number.

---

## 8. Local legacy

| File | Lines | Role |
|---|---:|---|
| `LocalExecutor` | 229 | Canonical Task contract. **KEEP** |
| `localAgentTask.cjs` | 662 | Local brain (decide → act → observe). **KEEP** |
| `localSystem.cjs` | 1347 | Filesystem/shell/security/path owner. **KEEP** |
| `localCapabilities.cjs` | 206 | Capability compile. **KEEP** |

Header comments already state the split correctly.
Remaining large code is **valid inner loop / security**, not duplicate lifecycle authority.

Do not delete path/security code because LocalExecutor exists.
LocalExecutor does not execute tools.

Tests: `localExecutor.test.cjs` (512), `localSystem.test.cjs` (307), `localConsequence.test.cjs`.
**READY** to keep; **HIGH RISK** to "simplify" security.

---

## 9. Remote

Healthy modularity **already**.
Do not clean because files are large. They are not.

| File | Lines |
|---|---:|
| `remoteExecutor.cjs` | 187 |
| `remoteAgentTask.cjs` | 425 |
| `remotePolicy.cjs` | (policy) |
| `remoteSession.cjs` / `sshTransport.cjs` / `remoteTargetStore.cjs` / `remoteConnect.cjs` | split |

Tests: `remoteExecutor.test.cjs` (514), plus policy/session/target/ssh tests.

Watch for god-object growth in `remoteAgentTask.cjs` if it starts absorbing session/policy/transport.
It has not yet.

**KEEP.**

---

## 10. MCP

**Current HEAD is not a Universal MCP runtime.**
`docs/refactor/mcp-connector-audit.md` and `docs/refactor/first-party-tool-audit.md` already state this.
`mcp-tools/` is the in-process first-party registry (legacy name).

Largest first-party files:

| File | Lines | Verdict |
|---|---:|---|
| `firstPartyCapabilities.js` | 1058 | Catalog + resolver. Cohesive. **KEEP** |
| `voiceTools.js` | 823 | Voice disclosure. New, modular. **KEEP** |
| `chatTools.js` | 674 | Registry. **KEEP** |
| `chatToolGuidance.js` | ~199 | Slim guidance after disclosure cleanup. **KEEP** |
| `chatIntentSignals.js` | 481 | **KEEP** |
| `toolResultBounds.js` | 263 | New bounder. **KEEP** |

Universal MCP (connection manager, client runtime, stdio catalog, OAuth, local process manager) is in `.worktrees/universal-mcp` (migrations 127–130 in that tree).
**Do not churn it from this plan.**
Re-audit after merge.

No MCP file on HEAD is a megafile problem.

---

## 11. Vault frontend

Canonical page: `src/pages/Vault.jsx` (**3744** lines).

Hook counts (signal only): **40 useState, 30 useRef, 26 useEffect, 15 useMemo, 50 useCallback**, ~51 imports / ~30 subsystems.

### Responsibilities still in the page

| Concern | Still in page? | Extracted leaf? |
|---|---|---|
| Navigation / picker | Yes | Partial |
| Search | Yes (wiring) | Concept-search hook |
| Filters / views | Yes | Toolbar presentational |
| Folders / AI Drive | Yes | `useVaultDriveWindow` |
| Uploads | Yes (ghosts/merge) | `vaultUploadStore` / `uploadPipeline.ts` (1610, not imported by the page) |
| Preview | Open-state in page | `VaultPreviewOverlay` (1156) |
| AI | Thin | Classification hooks |
| Projects | Yes | `listUserProjects` |
| Selection | Yes | Mostly still page |
| Context menu | Yes | `VaultCardPopovers` |
| Bulk / trash | Yes | Mutations hook partial |
| Drag/drop | Yes | Drag engine elsewhere |
| Editing | Partial | `useVaultCardMutations` |
| Network | Infinite notes query in page | Signed-URL / tags hooks |

**Still a god component.**
Prior work peeled renderers/preview/hooks.
The page remains the integration brain.

Natural seams (responsibility, not line count):

1. Vault data plane (notes query, refresh, upload merge)
2. Selection / picker
3. Interaction (drag / trash / bulk / keyboard)
4. Folders / views
5. Preview controller (open state only)

Healthy page target after those controllers exist: **~800–1,400** layout/wiring, not 500.

Hotspot: **22 commits** since 2026-07-01 (frontend collision file).

Testability: **HIGH RISK**. No page-level characterization tests.

---

## 12. Chat frontend

Canonical page: `src/pages/LyknChat.tsx` (**3577**).
View: `LyknChatView.tsx` (**2560**).

LyknChat hook signal: **41 useState, 28 useRef, 47 useEffect, 11 useMemo, 63 useCallback**, **80 imports / 69 unique modules**.
Highest frontend fanout in the inventory.

### Map

| Concern | Where it lives |
|---|---|
| Composer | Engine owns input; page owns Studio/Home bars |
| Thread | View renders; page holds messages + rail |
| Attachments | **Mixed.** Page ingress + engine tray |
| Imagine | `StudioImagineMode` mounted here |
| Tool UI | View cards; orchestrator events |
| Source / research | Page + Studio chrome + view |
| Voice | `useChatVoiceMode` + page home-voice |
| Browser/agent | Page listeners + rail |
| Activity | `SubAgentTasksStrip` from page |
| Projects | Page picker + engine deps |
| Artifacts | Engine + page app-edit |
| Saved thread | `useLyknChatPersistence` |
| Modals | Upgrade, add-link, vault overlay, project picker |

What still resides in the page rather than hooks/components: the **event bus**.
Studio stickiness, Home-bar send, Bot bridge, attachment ingress from four surfaces, overlay mounts.

Natural seams:

1. Keep `LyknChat` as route shell
2. `useChatAttachmentIngress`
3. `useStudioChatSession`
4. Stop adding product features into the page body

Healthy page target: **~1,000–1,800** shell, not 500.
View target after extracting `MessageItem`: **~1,200–1,600**.

Hotspot: LyknChat **21**, useChatEngine **19**, orchestrator **17**, LyknChatView **17**, chat-agent-loop **17**.
This cluster is the frontend change-collision core.

---

## 13. Studio

`src/pages/Studio.jsx` (**1661**).
**32 useState, 11 useRef, 20 useEffect**, 42 imports.

Header already documents ownership: tabs, Home chat layer, desktop drops/widgets, floating windows, Split View, browser docking.

Size is **plausible for a shell**.
Mixed feature ownership is **growing** (browser host bounds, split geometry, installed apps, Home chat live/Imagine hiding).

Watchlist, not a current Tier-1 megafile.
Healthy shell target if window-manager vs desktop-layer split happens: **~700–1,200**.
Do not decompose purely for line count.

`StudioImagineMode.tsx` (**2127**, 26 useState / 20 useRef / 18 useEffect) is a **second chat product** living next to Studio.
Treat it as its own god-component risk (generate vs chrome vs persist).

---

## 14. Task / Bot / Routine / Teach UI

| Surface | Lines | Verdict |
|---|---:|---|
| `src/components/bots/BotsPage.jsx` | 438 | **Healthy page composition** |
| Inner `BotRoutines` / `RoutineRow` | in BotsPage | Fine until capability editor / teach UI lands |
| `src/components/activity/ActivityPanel.jsx` | 256 | **Healthy**. Zero local hooks; presentation over `useActivity()` |
| `ActivityNotificationBridge.tsx` | ~47 | Single-purpose. **KEEP** |
| `src/lib/routines/routinesClient.ts` | ~199 | **KEEP** |
| Teach-by-demonstration UI in `src/` | **none** | Lives only in the worktree |

Mild smell: `ActivityPanel` imports `RUN_STATUS_LABEL` from `BotsPage`.

Catch growth early: a Routine builder, capability editor, or teach recorder must get its **own module**, not inflate `BotsPage` or `ActivityPanel`.

**No new god component yet.** Leave this cluster alone in cleanup phases unless teach UI merges.

---

## 15. Updated dedup findings

Re-evaluated against current HEAD relative to `docs/refactor/dedup-dead-code-audit.md`.

| Prior finding | Now |
|---|---|
| `providerForModel` in `chatTools.js` and `agentModelProviders.js` | **STILL PRESENT** (intentional isolation; beliefSystem justification is gone) |
| `CUSTOM_MODELS_ENABLED` JS + TS twins | **STILL PRESENT** (FEATURE-GATED, keep both if Vite/Node split required) |
| `runOsascript` in `main.cjs` vs `appDock.cjs` | **NEW OWNER EXISTS**. Canonical is `electron/os/browserAutomation.cjs`. `main.cjs` is now a thin forwarder. `appDock.cjs` still has its own copy. **SAFE NOW** to share after glue deletion |
| `readCached` in browser-agent vs bot-harness | **STILL PRESENT**. INTENTIONAL VARIANT of scaffolding. **STILL DEFER** (do not merge runtimes) |
| Connection-dialog `authedFetch` / `relativeTime` / `truncate` | **STILL PRESENT** (OAuth, Token, CustomApi, VaultAppDock, ConnectionsAppGrid, Calendar) |
| Vault `extractYouTubeLinks` / `formatDate` vs `vaultContentsForAi.ts` | **STILL PRESENT** |
| Overlay `escapeHtml` clones | **STILL PRESENT** (overlay/menu/picker/lang-picker/agent-sidebar/stage). `main.cjs` now has `escapeHtmlForStage` as a renamed variant |
| `LYKN_CHAT_TOOL_GUIDANCE` teaching `lykn_findConnections` | **ALREADY FIXED** |
| Glass strip `lykn_findConnections` | **ALREADY FIXED** |
| `toolStatusVerbs` deleted-tool names | **ALREADY FIXED** |
| `fetchBeliefSection` in server.js | **ALREADY FIXED** (negative assertion remains in `memoryCutover.test.mjs`) |
| `umap-js` / `density-clustering` | **ALREADY FIXED** (gone from `package.json`) |
| `categoryExplainers.ts` | **ALREADY FIXED** (file gone) |
| YouTube `description_fallback` → `retryWhisper` in `chatTranscription.ts` | **STILL PRESENT** (two client loops inside the extracted file). **SAFE NOW** to share a helper inside that file |
| Invoke vs stream persona drift | **STILL PRESENT** inside `server.js`. **SAFE NOW** after Chat extract |
| Attachment types (`FocusedChatAttachment` vs `ChatAttachmentLike` vs `SentChatAttachmentData`) | **STILL PRESENT**. Type-only. **SAFE NOW** |
| Intent classifiers `userWants*` Electron vs `desktop.routes.js` | **STILL PRESENT**. **STILL DEFER** until both call sites want the same decision |
| `AGENTS.md` / `agents.md` case alias | **NO LONGER RELEVANT** as a cleanup item. Do not delete |
| Wake toolbar vs product toolbar | **STILL DEFER** (visual 1:1 required) |
| Prompt residue vs Memory Phase 3 | Mostly **ALREADY FIXED**. Remaining: `[WHO_I_AM]` vs `[USER MEMORY]` naming if still drifted in personas |

---

## 16. Dead code

### PROVEN DEAD (still on disk)

| Item | Est. lines |
|---|---:|
| `FeedbackModal.jsx` | ~135 |
| `ChatThreadSidebarGroups.jsx` | ~333 |
| `MorningBriefCard.jsx` | ~71 |
| `StewardKanban.jsx` | ~227 |
| `PlanGate.jsx` (zero importers; recently touched, still unused) | ~158 |
| `RichTextRenderer.jsx` | ~33 |
| `WakeChatSubwindow.tsx` / `WakeVoiceSubwindow.tsx` / `WakeAppShellPreview.tsx` | ~147 |
| `createChatThreadWithBoard` | ~5 |
| `handleOrganizeIdeas` / related handlers in `LyknChat.tsx` | ~25 |
| `handleActionPath` in orchestrator | ~93 |
| `dictationTimerRef` never assigned | ~3 |
| Unused shadcn primitives listed in the prior audit | ~250 |

Confirm Remotion/HTML does not string-load Wake shells before deleting them.

### LIKELY DEAD

`notesOpen` always-false branches; permanently-true `chatMode` rail; default export of `LyknChatComposer` (helper still imported); `lykn:agent-recents-list` IPC; leftover CSS selectors in `wake-onboarding.css` / `model-builder.css`.

### COMPATIBILITY (not dead)

ChatNeuron belief/fact/concept renderers; `memoryMigration.js` facts-table reader; `LOAD_NEURON_KINDS` legacy kinds; canvas DI stubs; `actionJsonRescue` **strip** path; `returnActions` HTTP contract; `ensureLegacyMemoryMigrated`.

### FEATURE-GATED (not dead)

`CUSTOM_MODELS_ENABLED === false`; `LYKN_BROWSER_AGENT=legacy`; `LYKN_BOT_HARNESS=0`; `WINDOWS_DOWNLOAD_ENABLED`.

### HISTORICAL RENDER SUPPORT

Persisted `aiNeurons` in old chats.
Do not delete card layouts because create-tools are gone.

---

## 17. Compatibility bridges

High-value candidates now that TaskRuntime / executors exist:

| Bridge | Can remove now? |
|---|---|
| `LYKN_BOT_HARNESS=0` | **Yes**, as a product kill-switch retirement |
| Bot harness → `streamChat` catch fallback | **Probably yes** (or keep a thin retry, not a second Bot architecture) |
| `LYKN_BROWSER_AGENT=legacy` + `executeOwnedAdaptiveTask` | **Yes, after** confirming `/api/desktop/agent-model` availability in all shipped builds |
| Send-tail `browser_legacy_fallback` settlement | **Yes, after** legacy browse and non-executor Bot exits are gone |
| `main.cjs` thin forwarders + `bindShellContext` | **Yes**. Pure glue |
| Canvas `handleActionPath` / `returnActions` client | **Yes** on the client. Server invoke contract is a **product decision** |
| `openInStudioBrowser` `newTab` deprecated option | Tiny. Optional |
| `MAX_AGENTS` alias | Keep |
| `memoryBridge` | Already deleted |
| Universal MCP / Teach adapters | **Not on HEAD**. Do not touch worktrees here |

---

## 18. Runtime authority duplication

Flagged above ordinary style cleanup.

| Duplication | Risk |
|---|---|
| Task completion in `agentRuntime` send-tail for paths that never entered `TaskRuntime.execute` | **High.** Task record can lie |
| Bot settlement via `complete(..., executor: "bot"|"browser_legacy_fallback")` after the turn | **High** |
| Legacy browse loop completing outside `BrowserExecutor` | **High** while the flag exists |
| `ensureBrowserTask` registering caps without `taskCompiler` | **Medium.** Policy drift |
| Bot vs routine child maps calling `localExecutor.execute` / `browserExecutor.execute` directly (budget via `runChild`) | **Low–medium.** Intended nesting; duplicated wiring |
| Local cancellation | **OK.** Stop/close already calls `taskRuntime.cancel` |
| Routine execution bypass | Occurrence run is inside agentRuntime by design; scheduler is `routineRuntime`. Not a bypass of TaskRuntime for executor work |
| Workflow / teach executor | Worktree only |

Architecture correctness > line count.
Phase C1 exists because of this section.

---

## 19. State ownership (module-level)

| File | State | Owner today | Move with |
|---|---|---|---|
| `server.js` | billing Maps | server.js | billing module |
| `server.js` | `localToolStreams` | stream handler | chat stream module |
| `server.js` | project/tools section caches | prompt assembly | chat context module |
| `agentRuntime.cjs` | `agents` Map, `taskRuntime`, route/bot tool caches | factory closure | **KEEP in host** (this is the agent owner) |
| `main.cjs` | `agentBrowserViews` and friends | main | Agent Harness module |
| `main.cjs` | Live Watch / snip / overlay ask vars | declared in main, mutated via `d` | already-extracted attach modules |
| `ownedBrowserAct.cjs` | user site aliases | module | **KEEP** (actuator config) |

Large files stay large when state and behavior split across extraction.
`main.cjs` is the clearest example.

---

## 20. Frontend state signal

| File | useState | useRef | useEffect | useMemo | useCallback | God risk |
|---|---:|---:|---:|---:|---:|---|
| `Vault.jsx` | 40 | 30 | 26 | 15 | 50 | Critical |
| `LyknChat.tsx` | 41 | 28 | 47 | 11 | 63 | Critical |
| `LyknChatView.tsx` | 17 | 9 | 7 | 3 | 9 | High (nested `MessageItem`) |
| `StudioImagineMode.tsx` | 26 | 20 | 18 | 2 | 23 | High |
| `Studio.jsx` | 32 | 11 | 20 | 4 | 7 | Medium-High shell |
| `useChatEngine.ts` | 14 | 32 | 12 | — | 41 | Hook god |
| `useLyknChatPersistence.ts` | 4 | 14 | 14 | — | 9 | Focused, large |
| `BotsPage.jsx` | 11 | 2 | 3 | 0 | 0 | Low |
| `ActivityPanel.jsx` | 0 | 0 | 0 | 0 | 0 | Low |

---

## 21. Import fanout

High lines + high subsystem fanout is stronger evidence than size alone.

| File | Lines | Unique import modules | Fanout verdict |
|---|---:|---:|---|
| `LyknChat.tsx` | 3577 | 69 | Strongest frontend god evidence |
| `server.js` | 12941 | 58 | Composition root (expected) + Chat blob |
| `Vault.jsx` | 3744 | 39 | Strong |
| `main.cjs` | 6232 | 43 | Composition root + leftover harness |
| `Studio.jsx` | 1661 | 33 | Shell, watchlist |
| `LyknChatView.tsx` | 2560 | 31 | UI cluster |
| `StudioImagineMode.tsx` | 2127 | 27 | Feature god |
| `agentRuntime.cjs` | 13075 | 23 | Lower import count, huge closure. Host, not a dump of deps |
| `ownedBrowserAct.cjs` | 12759 | 4 | **Low fanout.** Cohesive actuator, not a composition root |
| `chat-agent-loop.js` | 2171 | 2 | Cohesive extracted loop |
| `overlay.js` | 6375 | 0 (script) | Renderer monolith |
| `firstPartyCapabilities.js` | 1058 | 2 | Catalog. KEEP |

`ownedBrowserAct` being huge with 4 imports is why it is **not** ranked like `LyknChat`.

---

## 22. Change hotspots (git since 2026-07-01)

| File | Commits | Reading |
|---|---:|---|
| `server.js` | 59 | Hottest architectural file. Still dangerous to touch casually |
| `electron/main.cjs` | 45 | Extraction has been happening here continuously |
| `src/pages/Vault.jsx` | 22 | Frontend collision core |
| `src/pages/LyknChat.tsx` | 21 | Same |
| `electron/overlay.js` | 20 | Overlay product still lands in the renderer megafile |
| `useChatEngine.ts` | 19 | Chat engine still a magnet |
| `App.jsx` | 18 | App shell |
| `chatSendOrchestrator.ts` / `LyknChatView.tsx` / `chat-agent-loop.js` | 17 | Chat cluster |
| `agentRuntime.cjs` | 14 | Large and hot, but less than server/main |
| `ownedBrowserAct.cjs` | 7 | Large and **relatively stable** |
| `firstPartyCapabilities.js` | 2 | New, quiet |
| `localSystem.cjs` | 6 | Stable security owner |

A 3,000-line stable actuator can wait.
A 3,000-line page edited by every feature cannot.

---

## 23. Testability

| Target | Existing tests | Extraction class |
|---|---|---|
| `server.js` routes | `tests/server/*` manifest + middleware + critical routes | **READY** for remaining helper/billing extract |
| `server.js` stream/invoke | Limited; security scans; memory cutover source asserts | **NEEDS HARNESS** |
| `agentRuntime.cjs` | Skill routing, persist, waiting, bot routing, security hardening, source-slice tests | Kill-switches **READY**. Factory split **HIGH RISK** |
| `ownedBrowserAct.cjs` | Broad (`ownedBrowseGoal`, sign-in, layout, delivery, autonomy, field correction) | Actuator **KEEP**. Loop deletion **NEEDS HARNESS** (reuse existing goal tests) |
| `main.cjs` IPC | `ipcManifest` / `ipcSurface` | Glue deletion **READY**. Harness move **HIGH RISK** |
| TaskRuntime / executors | Dedicated unit tests, including remote/local/browser/bot/routine | **READY** (already extracted) |
| `chatSendOrchestrator.ts` | artifacts, transcription, actionJsonRescue, artifactSendPlan | Phase split **NEEDS HARNESS** |
| `Vault.jsx` / `LyknChat.tsx` | No page-level tests | **HIGH RISK** |
| Bots/Activity | `botStore.test.ts` | UI **HIGH RISK** if changed; currently leave alone |

---

## 24. `server.js` target

```
Current:                      12,941
Likely moved (helpers):       ~4.5–5.0k
Likely moved (AI handlers):   ~5.9k
Actual deletion inside file:  small (dead comments, unused aliases)
Healthy target:               2,500–4,500
Planning number:              ~3,500
```

Recommended extraction order inside the Chat stack: personas/guidance → vault retrieval helpers → billing helpers → guest/models/feedback → invoke → stream last.

---

## 25. Electron targets

```
main.cjs
  Current:           6,232
  After glue delete: ~3,800–4,200
  After harness move:~500–800
  Should remain:     whenReady, lifecycle, DI wiring, protocol, 1 version IPC

agentRuntime.cjs
  Current:           13,075
  After authority cleanup: ~8,500–9,500
  Should remain:     agent roster, send() multi-step, runBrowse routing,
                     streamChat, approval UI, executor injectors, Glass closer

ownedBrowserAct.cjs
  Current:           12,759
  After legacy loop: ~11,000 (actuator KEEP)
  Should remain:     catalog, runAction, screenshots, mail/URL heuristics,
                     exported looksLike* used by browser-agent and tests
  Do not merge with browser-agent or bot-harness
```

---

## 26. Frontend targets

```
Vault.jsx
  Current:     3,744
  Healthy:     ~800–1,400 layout after controller extraction
  Do not force <500

LyknChat.tsx
  Current:     3,577
  Healthy:     ~1,000–1,800 route shell
  Do not force <500

LyknChatView.tsx
  Current:     2,560
  Healthy:     ~1,200–1,600 after MessageItem extract

Studio.jsx
  Current:     1,661
  Healthy:     leave, or ~700–1,200 if window-manager splits
  Not required for correctness

StudioImagineMode.tsx
  Current:     2,127
  Healthy:     ~600–1,000 chrome after generate/mask/persist split

BotsPage.jsx
  Current:     438
  Healthy:     leave. Extract BotRoutines only if teach/capability UI lands
```

---

## Priority tiers

### TIER 1 — architecture debt

1. Duplicated Task settlement in `agentRuntime` send-tail
2. Legacy browse loop (`LYKN_BROWSER_AGENT=legacy` / `executeOwnedAdaptiveTask`) still reachable beside `BrowserExecutor`
3. `LYKN_BOT_HARNESS=0` second Bot architecture
4. Hardcoded capability compile bypassing `taskCompiler`
5. `main.cjs` Agent Harness state still in the composition root (correctness of window/tab identity)
6. `server.js` `/api/ai/stream` + `/api/ai/invoke` still mixed with bootstrap (collision + review risk)

### TIER 2 — maintainability megafiles

7. `src/pages/Vault.jsx` god page
8. `src/pages/LyknChat.tsx` wiring hub + `useChatEngine.ts` hook god
9. `electron/overlay.js` renderer monolith
10. `StudioImagineMode.tsx` feature god
11. `chatSendOrchestrator.ts` multi-phase blob
12. `LyknChatView.tsx` / `MessageItem` cluster
13. `overlay/askPipeline.cjs` already-extracted but oversized

### TIER 3 — dedup / dead cleanup

Proven-dead UI (~1.1k+).
`handleActionPath`.
`authedFetch` clones.
Vault YouTube/date helpers.
YouTube retry helper inside `chatTranscription.ts`.
Attachment type unification.
`providerForModel` shared extract.
`appDock` `runOsascript` vs `browserAutomation`.
Overlay `escapeHtml` (only while those scripts are already moving).

### TIER 4 — cosmetic / leave alone

Remotion compositions.
Landing / wake CSS.
`src/lib/connectors/catalog.js`.
`src/lib/demoLyknChats.js`.
`mcp-tools/*` modular registry.
TaskRuntime / executors / Remote / Routines.
`localSystem.cjs` security.
`browser-agent/` vs `bot-harness/` (do not merge).
`loadInUpdates.ts` (live greeting, name is leftover).
`synthesis.routes.js` (RAG isolation boundary).
BotsPage / ActivityPanel.
Universal MCP worktree.
Teach worktree.
`CUSTOM_MODELS_ENABLED` tools.
ChatNeuron historical kinds.

---

## Estimated cleanup

Separate **actual deletion** from **code moved into modules**.
Extraction does not reduce repository lines.

| Bucket | Estimate |
|---|---|
| Proven dead lines (delete) | **~1,200–1,500** |
| Compatibility lines deletable after kill-switch retirement | **~400–800** in `agentRuntime` + **~1,380** `executeOwnedAdaptiveTask` **if** the loop is retired |
| `main.cjs` glue deletion | **~750–1,200** |
| Client canvas fiction (`handleActionPath`, organize handlers) | **~120** |
| Duplicate helpers | **~150–250** after a canonical owner |
| **Actual deletion, conservative (no loop retirement)** | **~2,000–2,800** |
| **Actual deletion, if legacy browse loop also dies** | **~3,400–4,200** |
| Extractable composition-root lines (moved, not deleted) | **~10k–14k** (`server.js` Chat stack ~8k + `main.cjs` harness ~3.7k + optional `agentRuntime` host extracts ~2–4k) |
| Frontend decomposition (moved) | **~4k–7k** across Vault / LyknChat / Imagine / MessageItem |

Invoke `returnActions` (~1.3k of the invoke path) is **not** counted as deletion until a product decision.

---

## Top 10 cleanup targets

Ranked by the priority model (correctness > duplicated authority > collision > responsibilities > tests > deletion > lines).

1. **`agentRuntime.cjs` authority leftovers** — send-tail settlement, Bot/browse kill switches, cap compile
2. **`ownedBrowserAct.executeOwnedAdaptiveTask` reachability** — retire the loop, keep the actuator
3. **`electron/main.cjs` LEGACY BRIDGE glue** — forwarders + `bindShellContext` (unlocks later harness move)
4. **`server.js` Chat stack extraction** — stream/invoke/personas/vault helpers/billing helpers
5. **`src/pages/Vault.jsx` controller split** — selection/picker/trash (hottest remaining mixed page)
6. **`src/pages/LyknChat.tsx` event-bus split** — attachment ingress + Studio/Home session
7. **Proven-dead frontend UI** — actual deletion, low risk
8. **`useChatEngine.ts` peel** — attachments/artifacts off the send hook
9. **`electron/overlay.js`** — overlay product still dumps here; maintainability only
10. **Helper dedup** — `authedFetch`, YouTube retry, attachment types, `providerForModel`

---

## Recommended cleanup phases

Maximum three.
Agents can handle substantial work.
Do not invent a micro-phase per file.

### Phase C1 — Electron / runtime authority

**Goal:** one lifecycle owner per kind of work.
No more silent second Bot or second browse engine.

Includes:

- Retire `LYKN_BOT_HARNESS=0` and the harness→`streamChat` architecture
- Retire `LYKN_BROWSER_AGENT=legacy` once agent-model availability is guaranteed
- Stop send-tail Task settlement for executor paths
- Route Bot/browser caps through `taskCompiler`
- Dedupe Bot vs routine child-executor wiring
- Delete `main.cjs` thin-forwarder / `bindShellContext` glue
- Optional same phase if tests stay green: move Agent Harness Maps/stage out of `main.cjs`

Does **not** include: merging browser-agent and bot-harness; splitting `ownedBrowserAct` actuator; deleting `localSystem` security.

**Recommended model: Grok 4.6**
This phase is architectural judgment against TaskRuntime/executors, with many load-bearing comments and characterization tests.
It needs a model that will refuse false "just delete the loop" simplifications.

### Phase C2 — server / chat residual decomposition

**Goal:** `server.js` becomes a composition root of ~2.5–4.5k lines.

Includes:

- Extract personas + remaining guidance, vault retrieval helpers, billing helpers
- Extract AI routes (`models`, guest, feedback, invoke, local-tool-result, stream) behind the existing `tests/server` harness plus a new stream characterization harness
- Share invoke/stream persona stem
- Product decision on `returnActions` (keep as isolated invoke module, or delete with the public-contract note)

Does **not** include: Synthesis RAG deletion; Memory module rewrite; MCP worktree.

**Recommended model: GPT-5.6 Sol**
This phase is mechanical extraction against an existing route manifest.
It rewards strict "zero behavior change" execution and large-file patience more than product taste.

### Phase C3 — frontend megafiles + dead / dedup

**Goal:** stop Vault/LyknChat from being every feature's collision file; delete proven dead code.

Includes:

- Delete proven-dead UI listed in §16
- Dedup helpers in §15 marked SAFE NOW
- Vault selection/picker/trash controllers
- LyknChat attachment ingress + Studio session bridge
- `useChatEngine` peel
- Imagine generate vs chrome vs persist if it fits the same PR series
- Overlay `escapeHtml` only if those renderer scripts are already being touched

Does **not** include: Bots/Activity unless teach UI merged; landing CSS; Remotion; Wake toolbar merge.

**Recommended model: Claude Fable**
This phase is UI ownership and product-surface judgment.
It needs restraint on visual 1:1 (Wake toolbar, overlay CSS) and careful React state seams.

If only one phase can run: **C1**.
Line count will barely move.
Correctness will.

---

## What NOT to touch

- Merge `electron/browser-agent` with `electron/bot-harness`
- Delete or "simplify" `localSystem.cjs` path/security because `LocalExecutor` exists
- Remote modules (already modular)
- `mcp-tools/` progressive-disclosure modules (just cleaned)
- Universal MCP worktree
- Teach-by-demonstration worktree
- `server/routes/synthesis.routes.js` and vault chunk reindex
- `server/memory/**` (canonical Memory)
- ChatNeuron belief/fact/concept renderers
- `CUSTOM_MODELS_ENABLED` tool implementations
- `memoryMigration.js`
- Remotion, landing CSS, wake CSS restyle
- `BotsPage` / `ActivityPanel` until a new product surface appears
- `ownedBrowserAct` actuator (catalog, `runAction`, heuristics)
- TaskRuntime / executor classes themselves

---

## Audit path

Inventory: Python walk of source files with exclusions listed at top.
Bands, fanout, and hook counts from the same tree.
`server.js` remaining routes via anchored `app.get/post` scan (6 inline).
Electron IPC via `ipcMain.handle/on` (1 in main, 229 in `electron/ipc`).
Compatibility via `LYKN_BROWSER_AGENT`, `LYKN_BOT_HARNESS`, `executeOwnedAdaptiveTask`, send-tail comments.
Dedup re-verified by current ripgrep, not by trusting the prior audit.
Hotspots: `git log --since=2026-07-01 --name-only`.
Worktrees cited only to avoid colliding with Universal MCP and Teach.

No source was modified except this document.
