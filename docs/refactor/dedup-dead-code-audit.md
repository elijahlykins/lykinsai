# LYKN duplication and dead-code audit

**Date:** 2026-08-26
**Mode:** audit only.
**Scope:** full repository, static import graph plus traced registries, IPC, and route dispatch.
**Constraint:** no source modifications.
**Concurrent work (do not collide):** Memory Architecture Phase 3 demolition; Electron `main.cjs` decomposition.

This document is a cleanup plan, not a delete list.
Do not merge two similar implementations unless the evidence below proves they are duplicates.

`docs/LEGACY_CODE.md` (2026-08-25) is now partially stale.
Phase 3 and Synthesis UI demolition have already removed several items it still treated as live (`beliefSystem.js`, `userModelLearning.js`, `SynthesisLayer.tsx`, `FactConfirmChip.tsx`, `LoadInBriefingPanel.tsx`, `learnedTag.ts`).

---

## Executive summary

Working-tree Phase 3 demolition has already deleted on the order of **15,000+ lines** (belief/concept jobs, MCP tools, Synthesis UI, fact-learning client).
That work is in flight and is **not** this audit's cleanup target.

What remains on disk after that demolition:

| Bucket | Estimated lines | Notes |
|---|---:|---|
| Proven dead (still present) | **~1,550** | Unused UI, unused helpers, unreachable functions |
| Likely dead | **~900** | CSS selectors, permanently-true `chatMode` branches, unused store methods, unused npm deps |
| Duplicate (removable after a canonical owner) | **~400–550** | Exact clones plus small helper twins |
| Legacy / keep until a product decision | **~3,000–4,500** | Canvas DI stubs, custom-models soft-unplug, action-JSON apply, ChatNeuron belief/fact/concept renderers for old chats |
| Cleanup opportunity after concurrent streams land | **~3,500–5,000** plus a prompt rewrite | Frontend orphans first; `server.js` / Electron second |

Highest-risk residue is not unused files.
It is **live prompts that still describe deleted tools**.
`LYKN_CHAT_TOOL_GUIDANCE` still teaches `lykn_findConnections`.
Voice grounding still calls undefined `fetchBeliefSection`.
`memoryCutover.test.mjs` dropped the deleted `memoryBridge` / `userModelLearning` imports during this audit window.
Re-run `npm run test:memory` after Phase 3 lands to confirm the remaining assertions still match the new resolver.

---

## Highest-value removals

Ranked by (1) confidence, (2) maintenance burden, (3) code reduction, (4) architectural simplification.

| Rank | Item | Confidence | Burden | Reduction | Simplification | Collision |
|---|---|---|---|---|---|---|
| 1 | Proven-dead frontend UI (`FeedbackModal`, `ChatThreadSidebarGroups`, `StewardKanban`, `MorningBriefCard`, `PlanGate`, `RichTextRenderer`, unused Wake shells, unused shadcn primitives) | Proven | Low | ~1,100 | Removes orphan product surfaces | Safe vs concurrent streams |
| 2 | Phase 3 prompt residue (`LYKN_CHAT_TOOL_GUIDANCE`, Glass `lykn_findConnections` strip set, `toolStatusVerbs`, `fetchBeliefSection`) | Proven (stale / broken call) | High | ~150 code + ~200 prompt | Stops teaching deleted tools | **Wait for Memory Phase 3** (`server.js`, `server/memory/**`) |
| 3 | Canvas action-path leftovers (`handleActionPath`, `handleOrganizeIdeas` trio, `GridIcon` dead branch, `notesOpen` always-false, `createChatThreadWithBoard`) | Proven / likely | Medium | ~250 | Shrinks the "canvas might return" fiction | Chat files; not the listed concurrent set |
| 4 | Exact helper clones (`providerForModel`, connection-dialog `authedFetch`/`relativeTime`/`truncate`, `extractYouTubeLinks`/`formatDate`, `CUSTOM_MODELS_ENABLED`, `runOsascript`, `escapeHtml`, `readCached`) | Exact | Low–medium | ~150–250 | One owner per helper | Electron clones wait for `main.cjs` decomp |
| 5 | YouTube `description_fallback` → `retryWhisper` control flow (chat attachment vs grounding; also Electron/server policy) | Near | Medium | ~50–80 in chat file | One fetch helper | Do not merge abort semantics blindly |
| 6 | Unused npm deps (`umap-js`, `density-clustering`, plus the 2026-08-25 shadcn leftovers) | Likely | Low | package only | Smaller install | Confirm no dynamic/artifact imports |
| 7 | Invoke `returnActions` / server XML action rescue | Likely dead client; public HTTP contract | High | large `server.js` block | Drops canvas apply from invoke | **Do not touch `server.js` until route decomp settles** |
| 8 | Wake `LyknChatBarToolbar.tsx` vs product `ChatBarToolbar.tsx` | Drifted, intentional | Medium | 0 if kept | Naming clarity only | Do not merge without a visual 1:1 proof |

Do not start with Electron or `server.js`.
Those files are being rewritten in parallel.

---

## Exact duplicates

### 1. `providerForModel` (JS)

- **Locations:** `mcp-tools/chatTools.js:662-669` and `lib/agentModelProviders.js:31-38`.
- **Proof:** Function bodies are identical (gpt- / o3 / claude / grok / gemini routing).
- **Comment drift:** `agentModelProviders.js:21-26` still says the copy exists to avoid importing `beliefSystem.js`.
  That module is deleted in this working tree.
  The remaining reason is still valid: `chatTools.js` imports the full MCP registry (`./index.js` + exterior + local tools), so a direct import would pull that graph into the browser-agent provider module.
- **Canonical owner:** a tiny shared module (for example `lib/modelProvider.js`), **not** `chatTools.js`.
- **Classification:** EXACT DUPLICATE (intentional isolation; justification comment is stale).
- **Estimated removable lines:** 8 after a shared extract (keep one definition).

### 2. `CUSTOM_MODELS_ENABLED`

- **Locations:** `lib/customModelsEnabled.js:5` and `src/lib/customModelsEnabled.ts:5`.
- **Proof:** Identical file text, both `export const CUSTOM_MODELS_ENABLED = false`.
- **Canonical owner:** keep both if the Vite/Node split is required; otherwise generate one from the other.
- **Classification:** EXACT DUPLICATE of a live feature flag, not dead code.
- **Estimated removable lines:** 0 unless you add a codegen/shared package.
  Flag stays FEATURE-GATED.

### 3. `runOsascript`

- **Locations:** `electron/main.cjs:9068-9078` (default timeout 4000) and `electron/appDock.cjs:215-225` (default timeout 8000).
- **Proof:** Bodies are the same `execFile("osascript", ["-e", script], { timeout }, …)` sequence.
  Only the default timeout differs.
- **Canonical owner:** extract during `main.cjs` decomposition; do not edit `main.cjs` now.
- **Classification:** EXACT DUPLICATE (timeout default is the only variance).
- **Estimated removable lines:** ~12.

### 4. `readCached` instruction loader

- **Locations:** `electron/browser-agent/runtime/instructions.cjs:26-36` and `electron/bot-harness/runtime/instructions.cjs:23-33`.
- **Proof:** Identical cache/read/trim/catch empty implementation.
- **Canonical owner:** leave in each runtime, or a 15-line shared `electron/lib/readCached.cjs`.
- **Classification:** EXACT DUPLICATE of scaffolding; surrounding loaders are INTENTIONAL VARIANTS (different corpora).
- **Estimated removable lines:** ~11.

### 5. Connection-dialog helper trio

- **Locations:**
  - `src/components/connections/OAuthConnectDialog.jsx:500-529` (`authedFetch`, `relativeTime`, `truncate`)
  - `src/components/connections/TokenConnectDialog.jsx:475-505` (same three)
- **Nearby variants:** `VaultAppDock.jsx` also has `authedFetch` + `relativeTime`; `CustomApiDialog.jsx`, `ConnectionsAppGrid.jsx`, and `LyknCalendarPage.jsx` each have `authedFetch`.
- **Proof:** OAuth and Token copies of `authedFetch` / `relativeTime` / `truncate` match line-for-line in this tree.
- **Canonical owner:** a small `src/lib/connections/http.ts` (or reuse `projectShared.jsx` `relativeTime` after proving identical formatting).
- **Classification:** EXACT DUPLICATE (OAuth vs Token); NEAR DUPLICATE vs the other `authedFetch` copies.
- **Estimated removable lines:** ~30 from the OAuth/Token pair; more if the other `authedFetch` copies are inlined later.

### 6. Vault `extractYouTubeLinks` + `formatDate`

- **Locations:** `src/lib/vault/vaultCardHelpers.js:320-325` and `:492-498`; private copies in `src/lib/vault/vaultContentsForAi.ts:145-159`.
- **Proof:** Same YouTube URL regex and same "No date" / short locale `toLocaleDateString` behavior.
- **Canonical owner:** `vaultCardHelpers.js` (already exported).
  `vaultContentsForAi.ts` should import instead of redefining.
- **Classification:** EXACT DUPLICATE of logic.
- **Estimated removable lines:** ~15.
- **Not the same:** `src/components/macfiles/fileKinds.js:74` `formatDate` ("Today …" vs absolute) is an INTENTIONAL VARIANT.

### 7. Root `AGENTS.md` / `agents.md`

- **Locations:** repository root.
- **Proof:** Same inode on this Darwin volume; identical 10-line workspace rules.
- **Classification:** EXACT DUPLICATE (case alias), not two copies.
- **Do not delete either name.**
  Workspace tooling and humans resolve both casings.
- **Estimated removable lines:** 0.

### 8. Floating-UI `escapeHtml`

- **Locations (exact set, per mechanical compare):** `electron` overlay scripts `agent-stage.js`, `menu.js`, `picker.js`, `lang-picker.js`, `agent-sidebar.js`.
- **Near/drifted:** `markdownToStageHtml.cjs` vs `appRuntime/shell.cjs` (shell omits quote escaping); `overlay.js` adds href-safe escaping.
- **Canonical owner:** one shared overlay util, extracted with the Electron UI split.
- **Classification:** EXACT DUPLICATE (5 files) plus INTENTIONAL VARIANTS.
- **Estimated removable lines:** ~30–40 of the exact set.
- **Do not touch during `main.cjs` decomposition unless those scripts are already being moved.**

---

## Drifted duplicates

### 1. Product toolbar vs Wake toolbar vs voice toolbar

| File | Role | Importers |
|---|---|---|
| `src/components/lyknChat/ChatBarToolbar.tsx` (~398 lines) | Product chat-bar toolbar | `LyknChat.tsx:176` (imported **as** `LyknChatBarToolbar`) |
| `src/components/lyknChat/LyknChatBarToolbar.tsx` (~141 lines) | Simpler Wake tour toolbar | `WakeChatTourPreview.tsx` only |
| `src/components/lyknChat/LyknChatToolbar.tsx` (~81 lines) | Top-right Voice Mode toggle | `LyknChat.tsx` |

- **Classification:** first pair is DRIFTED DUPLICATE (documented at `ChatBarToolbar.tsx:7-13`).
  Third is INTENTIONAL VARIANT (different job).
- **Behavior differences:** product toolbar has composer modes, Research/Imagine selects, and the plus menu.
  Wake toolbar has `toolbarSelect` override and a single attach button.
- **Consolidation:** not recommended until a visual 1:1 proof.
  Recommended now: stop aliasing the product import as `LyknChatBarToolbar` so the names match the files.

### 2. YouTube `description_fallback` → `retryWhisper`

- **Locations:** `src/lib/ai/chatTranscription.ts:39-72` (attachment mutate-in-place) and `:168-236` (grounding string + cache + 120s abort).
- **Also related:** `youtubeQa.js` (canonical server pipeline) and `electron/main.cjs` `getBrowserYouTubeTranscript` (in-page captions first, then the same API policy).
- **Classification:** NEAR DUPLICATE of client control flow; server vs Electron are INTENTIONAL VARIANTS (different runtimes).
- **Behavior differences (load-bearing):**
  - Attachment path mutates `att.transcript` in place and does not abort the send on timer.
  - Grounding path aborts the **whole send** on 120s timeout, caches, truncates at 12k chars, and writes UI status strings.
- **Consolidation:** extract `fetchYoutubeTranscriptWithWhisperFallback(videoId, signal)` **inside** `chatTranscription.ts`.
  Do not fold Electron/server into that helper.
- **Recommended:** yes for the two client loops.
  No for a three-way merge.

### 3. Invoke persona vs stream persona

- **Locations:** `server.js` `LYKN_CHAT_PERSONA_STATIC` (~4708) and `LYKN_STREAM_PERSONA_STATIC` (~4800).
- **Classification:** NEAR / DRIFTED DUPLICATE.
  File comments already admit the stream persona duplicated the invoke persona plus extra no-actions rules.
- **Behavior differences:** stream persona is stricter about action JSON (`{"type":"create_text"}`, `<add_blocks>`, fences).
  Vault paragraph is slightly shorter.
  Opening "SYSTEM" sentence differs by a few words.
- **Consolidation:** recommended **after** `server.js` is stable, by sharing a common stem plus a stream-only addendum.
  Do not rewrite personas during Phase 3.
- **Related naming drift:** personas still say learn/update `[WHO_I_AM]` while tool guidance and `formatChatMemoryPrompt` inject `[USER MEMORY]`.
  That is prompt drift, not two memory systems.

### 4. `SentChatAttachmentData` vs `FocusedChatAttachment`

- **Locations:**
  - `FocusedChatAttachment` `src/lib/lyknChat/chatTurnTypes.ts:249-292`
  - `ChatAttachmentLike` `src/lib/chat/chatAttachmentFile.ts:23-40`
  - `SentChatAttachmentData` `src/components/lyknChat/SentChatAttachment.tsx:24-34`
- **Classification:** DRIFTED DUPLICATE of types.
- **Behavior differences:** runtime objects are largely the same.
  `FocusedChatAttachment` is required (`id`, `type`, `url`, `name`, `mime`, `size`) and adds `aiDescription`, `canvasBlockId`, OG link fields.
  `ChatAttachmentLike` is optional-field and omits OG / `aiDescription` / `canvasBlockId`.
  `SentChatAttachmentData` re-declares the OG fields on top of `ChatAttachmentLike`.
- **Canonical owner:** `FocusedChatAttachment` in `chatTurnTypes.ts`.
  `ChatAttachmentLike` should be a Pick/Omit (or Sent should accept Focused).
- **Consolidation:** recommended as a type-only pass.
  Do not change chip UI while doing it.

### 5. `ChatNeuronAttachment` (canonical vs renderer)

- **Locations:** `chatTurnTypes.ts:72-83` (`payload: any`) and `ChatNeuronCard.tsx:140-142` (narrowed payload union).
- **Classification:** INTENTIONAL VARIANT.
  The card file documents itself as payload-shape authority; the canonical type stays loose because the orchestrator stashes tool JSON.
- **Consolidation:** not recommended.
  Optionally export the narrowed payload union from the card (or a `chatNeuronPayload.ts`) so View/orchestrator share it.

### 6. Intent classifiers `userWants*`

- **Locations:** `electron/browserAct.cjs` (~681) and `server/routes/desktop.routes.js` (~122).
- **Classification:** DRIFTED DUPLICATE.
- **Behavior differences:** `desktop.routes` adds `wantsMultiQuestion`; regexes for "complex" diverge.
  Electron vs server can disagree on whether a Glass external-browser ask is "complex".
- **Consolidation:** only after proving both call sites want the same decision.
  Until then, document the drift next to both functions.
- **Do not edit `desktop.routes.js` while route extraction is landing.**

### 7. PDF text extraction

- **Locations:** `electron/documentReader.cjs`, `electron/documentEditor.cjs`, `lib/exterior/capabilities/pdfExtract.js`, `src/lib/extract-text.ts`.
- **Classification:** NEAR DUPLICATE / INTENTIONAL VARIANT (same `pdfjs-dist`, different worker/fonts/page caps/runtimes).
- **Consolidation:** not recommended as a delete.
  A shared "extract first N pages" helper is optional later.

### 8. Browser-agent vs bot-harness markdown

- **Locations:** `electron/browser-agent/agent/{core,safety,browser}.md` vs `electron/bot-harness/agent/{core,safety}.md` and `bot-harness/agent/tools/browser.md`.
- **Classification:** INTENTIONAL VARIANT (two products).
- **Do not merge.**
  Safety rules already differ in length and emphasis; collapsing them would change agent behavior.

---

## Dead code

Conservative.
Dynamic IPC, tool name strings, lazy routes, and old persisted chat JSON can keep a symbol alive.

### Proven dead (safe to remove after a quick product glance)

| Location | Proof | Est. lines | Notes |
|---|---|---:|---|
| `src/components/FeedbackModal.jsx` | Zero importers | ~135 | Also listed in `docs/LEGACY_CODE.md` |
| `src/components/chat/ChatThreadSidebarGroups.jsx` | Zero importers; only file in `components/chat/` | ~333 | Folder dies with it |
| `src/components/projects/MorningBriefCard.jsx` | Zero importers | ~71 | |
| `src/components/projects/StewardKanban.jsx` | Zero importers | ~227 | |
| `src/components/PlanGate.jsx` | Zero importers (comment-only in `useUsageGate.js`) | ~158 | |
| `src/components/notes/RichTextRenderer.jsx` | Zero importers | ~33 | |
| `src/components/wake/WakeChatSubwindow.tsx` | Zero importers | ~45 | Live Wake uses `WakeChatTourPreview` |
| `src/components/wake/WakeVoiceSubwindow.tsx` | Zero importers | ~43 | |
| `src/components/wake/WakeAppShellPreview.tsx` | Zero importers | ~59 | Confirm Remotion/HTML does not string-load these |
| `src/components/macdesktop/ZoomTrafficLight.jsx` | Re-export file; nothing imports the file | 1 | Symbol still lives in `TrafficLights.jsx` |
| `src/hooks/useChatDictation.ts:38,89` `dictationTimerRef` | Declared and cleared; never assigned a `setInterval` | 3 | Wave 3A leftover |
| `src/lib/chat/chatThreadsClient.ts:299-303` `createChatThreadWithBoard` | Defined, zero callers | ~5 | `@deprecated` |
| `src/pages/LyknChat.tsx:1164-1186` `handleOrganizeIdeas` / `handleProjectSuggestions` / `handleProjectSummary` | Defined, never passed or called | ~25 | `applyProjectActions` on organize results is a no-op anyway |
| `src/lib/synthesis/categoryExplainers.ts` | Zero importers | 23 | Copy for deleted Synthesis graph categories |
| `src/lib/ai/chatSendOrchestrator.ts:424-516` `handleActionPath` | Defined; never invoked (comment at `:1651` says the path is permanently disabled) | ~93 | Keep only if canvas is a committed return |
| Unused shadcn: `ui/label.jsx`, `ui/sheet.jsx`, `ui/hint.jsx`, `ui/progress.jsx`, `ui/scroll-area.jsx`, `ui/GridIcon.tsx` | No `@/components/ui/{name}` imports outside themselves | ~250 | Also leaves `@radix-ui/react-label`, `progress`, `scroll-area` unused except by those files |

### Proven dead (read path only)

| Location | Proof | Est. lines |
|---|---|---:|
| `PromptMessage.aiResponseStats` writes in `useLoadInGreeting.ts` | `LoadInBriefingPanel` was deleted this window; nothing renders the stats | keep writing only if a new Memory briefing UI will consume them |

Keep the writes if a later transcript filter needs them.
Otherwise drop the field.

### Likely dead

| Location | Proof | Est. lines | Caveat |
|---|---|---:|---|
| Default export of `LyknChatComposer.tsx` | Component never mounted; only `resizeLyknChatInput` is imported (Wake) | ~90 | Keep the helper re-export |
| `src/pages/LyknChat.tsx:500-505` `notesOpen` | `useState(false)`; `setNotesOpen(true)` never called; engine never calls `setNotesOpen` | ~10 + z-index branches | `LyknChatToolbar` still branches z-index on it |
| `chatMode = true` / no-op `setChatMode` (`LyknChat.tsx:500-501`) | Permanently true; `if (!chatMode)` rail/layout branches never run | ~80–150 | Do not delete until rail UI is formally retired |
| `LyknChatView` "Add to grid" (`canAddToGrid` + missing `GridIcon` import) | `addChatResponseToGrid` is never passed from the page, so the branch never evaluates | ~10 | Latent `GridIcon` reference if re-enabled |
| `src/store/aiStore.ts` `organizeIdeas` (`returnActions: true`) | Only caller is dead `handleOrganizeIdeas` | ~40 | Server invoke still accepts `returnActions` (public contract) |
| `letteredOptions` / `parseAgentQuestions` (`src/lib/agentQuestions.ts`) | Production uses `questionChips`; tests still import the deprecated helpers | ~20 | Keep until tests are rewritten |
| `src/styles/model-builder.css` class names | No TS/JSX class usage; file is still `@import`ed | ~190 | Wake CSS has one nested `.model-builder-page` selector |
| `.lykn-sidebar-synthesis-glow` / `.lykn-wake-neuron-pill` in `wake-onboarding.css` | No JS/TSX class references | tens | Rest of the file is live Wake |
| `umap-js` / `density-clustering` in `package.json` | Zero runtime imports after `lib/umap.js` / `lib/hdbscan.js` deleted | deps only | Confirm no dynamic `import()` |
| Prior leftover deps from `docs/LEGACY_CODE.md`: `react-leaflet`, `moment`, `immer`, `cmdk`, `vaul`, `input-otp`, `embla-carousel-react`, `next-themes`, `sonner`, `react-hot-toast` | Still in `package.json`; still zero app imports in this pass | deps only | Re-verify `lodash` / `canvas-confetti` (artifact compile path) |
| `electron/main.cjs` `lykn:agent-recents-list` | Handler registered; no `ipcRenderer.invoke` of that channel | ~3 | Recents are pushed via stage state; `lykn:agent-recents-remove` is live |
| `agentRuntime.cjs` `runCreateInSheets` / `formatMultiStepAnswer` | `@deprecated`; definition only | small | `toolWriteInLoop.test.cjs` uses `runCreateInSheets` as a **source slice delimiter** |

### Feature-gated (not dead)

| Flag | Value | Keep |
|---|---|---|
| `CUSTOM_MODELS_ENABLED` | `false` | Tools/UI remain; product paths skip them |
| `SYNTHESIS_LAYER_UI_ENABLED` | `false` | Route `/synthesis-layer` redirects to `/studio`; page files already deleted in WT |
| `WINDOWS_DOWNLOAD_ENABLED` | `false` | Download page still renders a coming-soon branch |
| `LYKN_BROWSER_AGENT=legacy` | env | Falls back to `ownedBrowserAct` loop |
| `LYKN_BOT_HARNESS=0` | env | Restores single-shot streamChat |
| `VITE_WEB_APP_ENABLED` / poller / reconciler-delete flags | env | Live gates |

### Runtime-dynamic / cannot prove

- String-dispatched `localStore.run(op)` and `localSystem.run(name)`.
- Electron `loadFile` / `<script src>` overlay modules.
- MCP / chat tool names in ElevenLabs / voice config.
- Persisted `aiNeurons` in old chats (`belief` / `fact` / `concept` kinds).
- Operator scripts under `scripts/` not listed in `package.json`.

### Public contract / do not delete

- `server/routes/synthesis.routes.js` vault chunk reindex/purge (RAG, not the belief graph).
  `docs/refactor/server-decomposition-plan.md` forbids Synthesis-only cleanup until Memory replacement ships.
- `lykn_searchVault` (voice / full registry; chat prompt says NEVER call it).
- Redirect routes (`/synthesis-layer`, `/vaultchat`, `/dashboard`, …).
- `memory_*` tools and `server/memory/**`.
- `lib/projectContext.js` (new canonical project-context module).
- Canvas DI stubs on `ChatSendParams` until the orchestrator contract is shrunk in the same change.
- `actionJsonRescue` **strip** path (`stripStreamingActionJson`, envelope rescue).
  Apply-to-grid is a no-op, but stripping leaked JSON from visible chat is live.

---

## Legacy architecture residue

### Memory / Synthesis (Phase 3 in flight)

**Already deleted in this working tree (do not re-delete):**
`beliefSystem.js`, `userModelLearning.js`, `factEmbedding.js`, `conceptEmbedding.js`, `server/memory/memoryBridge.js`, `jobs/{run,*}Synthesis|Concepts*`, `lib/{hdbscan,umap,synthesisPrompt}.js`, `lib/synthesis/relatedNeighborhood.js`, MCP tools `findConnections` / `getBeliefs` / `getFacts` / `getRules` / `proposeFact` / `getContextBlock` / `createNeuronLink` / `getNeuronLinks` / `touchConcept` / `recordRuleApplication`, Synthesis UI pages, `FactConfirmChip.tsx`, `LoadInBriefingPanel.tsx`, `learnedTag.ts`, `beliefsClient.js`.

**Residue still live (finish after Phase 3, not during it):**

| Residue | Class | Proof |
|---|---|---|
| `LYKN_CHAT_TOOL_GUIDANCE` still documents `lykn_findConnections` as CROSS-SOURCE SEARCH | DRIFTED vs `CHAT_TOOL_NAMES` | `server.js:5323-5350`; tool is absent from `mcp-tools/chatTools.js:88-205` |
| Glass vault-tool strip still lists `lykn_findConnections` | LEGACY string | `server.js:10026-10030` |
| `src/lib/ai/toolStatusVerbs.ts` still maps deleted tool names | LEGACY UI copy | `lykn_findConnections`, `lykn_getBeliefs`, `lykn_getFacts`, `lykn_proposeFact`, `lykn_touchConcept`, … |
| `buildRealtimeSynthesisGrounding` calls `fetchBeliefSection` | PROVEN broken reference | `server.js:12720`; **no function definition** in the tree |
| `tests/memory/memoryCutover.test.mjs` | In-flight repair | Deleted `memoryBridge` / `userModelLearning` imports were dropped during this audit window. Re-run the suite after Phase 3 lands. |
| `LOAD_NEURON_KINDS` includes `belief` / `fact` / `concept` | LEGACY COMPATIBILITY | `chatSendOrchestrator.ts:198`; old chats may still carry those cards |
| `ChatNeuronCard` KIND_ICON/LABEL for belief/fact/concept | LEGACY COMPATIBILITY | Not proven dead; persisted `aiNeurons` can still render |
| `memoryMigration.js` still reads `lykn_user_model_facts` | LEGACY COMPATIBILITY | Intentional Phase 2→3 bridge; keep until the table is retired |
| `src/lib/synthesis/loadPolicy.ts` comments still mention `refresh-profile` / `[USER_MODEL]` | Stale comments | `queueReindex.ts` still uses the live constants |
| `mcp-tools/index.js` header still exemplifies `lykn_getBeliefs` | Stale docs | Registry itself is updated |
| `lib/rag/vaultHybrid.js` header still mentions `lykn_findConnections` | Stale comment | |
| `docs/memory-architecture.md` / `docs/LEGACY_CODE.md` / `docs/ARCHITECTURE.md` | DRIFTED DOCS | Still describe nightly synthesis jobs / dual-write bridge / live SynthesisLayer |

`lib/projectContext.js` is **new canonical**, not dead.
Empty `lib/synthesis/` (after `relatedNeighborhood.js` delete) can be removed when convenient.

Vault synthesis reindex (`queueReindex.ts` + `synthesis.routes.js`) is **not** the belief graph.
Keep it.

### Old Chat architecture

| Residue | Class |
|---|---|
| `useChatEngine` canvas stubs always `""` / `[]` / no-op (`buildLyknChatContext`, `getAllYouTubeBlocks`, `applyProjectActions`, `typeIntoAiResponseBlock`, `replaySavedPromptResponse`, `extractAndEmbedMediaItems`) | LEGACY DI contract for the orchestrator |
| `chatSendOrchestrator` re-exports types for legacy import paths | LEGACY COMPATIBILITY |
| `chatThreadRuntime.ts:6` imports `PromptMessage` from the orchestrator, not `chatTurnTypes` | LEGACY import path (1 line) |
| `actionJsonRescue` still maps `create_h2` / `create_h3` and XML `<add_wires>` | FEATURE-GATED / LEGACY apply; live strip |
| Server `/api/ai/invoke` `returnActions` + `convertAddWireToActionServer` (`server.js:~8849+`) | LEGACY public contract; client callers are dead |
| `notesPages` still persisted in `useLyknChatPersistence` | LEGACY snapshot field; may still hydrate old chats |
| `TagManagement.jsx` 12-line stub route | LEGACY tombstone |

### Old server architecture

Remaining HTTP in `server.js` is the AI core (`/api/ai/models`, `stream-guest`, `feedback`, `invoke`, `local-tool-result`, `stream`).
That split looks intentional, not leftover duplicate handlers.

Do not invest Synthesis-only cleanup (`synthesis.routes.js`) per the existing decomposition plan.

Shared helpers still in `server.js` (`createSynthesisUserClient`, chunk replace/delete, `enrichVaultNoteSummary`) are INTENTIONAL sharing with notes-ingest.
Extract later, do not delete.

### Electron

Four live agent paths, not abandoned copies:

1. `browser-agent/` (default browse)
2. `ownedBrowserAct.cjs` (legacy browse)
3. `bot-harness/` (Bot)
4. `browserAct.cjs` (external Chrome via AppleScript)

`main.cjs` still hosts a large AppleScript browser cluster and dual history/recents stores.
That is decomposition debt, not dead code.

Do not merge history (`agent-browser-history.json`) with recents (`agent-browser-recents.json`).
Different UX, schemas, and caps.

### Temporary compatibility bridges

| Bridge | State |
|---|---|
| `memoryBridge.syncTrustedFactToMemory` | Deleted; cutover test no longer imports it |
| `lykn_proposeFact` / `/api/learned` | Deleted; prompts/comments still mention |
| `ensureLegacyMemoryMigrated` | Live; keep |
| `SYNTHESIS_LAYER_UI_ENABLED` redirect | Live bookmark compatibility |
| `MAX_AGENTS` alias in `agentRuntime.cjs` | Live back-compat |
| `openInStudioBrowser` `newTab` | Deprecated option, still typed |

---

## Type duplication

| Pair | Class | Canonical |
|---|---|---|
| `FocusedChatAttachment` vs `ChatAttachmentLike` vs `SentChatAttachmentData` | DRIFTED | `chatTurnTypes.FocusedChatAttachment` |
| `PromptMessage` imported from orchestrator vs `chatTurnTypes` | LEGACY re-export | `chatTurnTypes.ts` |
| `ChatNeuronAttachment` (loose) vs card narrowed type | INTENTIONAL | Keep both; optionally share payload union |
| `CreateAction` still contains `create_h2` / `create_h3` plus `create_heading`+level | INTENTIONAL (model variance) | Keep until rescue is retired |
| `ArtifactKind` (engine create modes) vs `ChatArtifactKind` (render kinds) | INTENTIONAL VARIANT | Different unions |
| `BotSendAttachment` vs `FocusedChatAttachment` | INTENTIONAL VARIANT | Bot wire vs composer |

---

## CSS duplication

No copy-paste twin stylesheets under `src/styles/`.
Foundation files are imported once from `src/index.css`.

| Finding | Class |
|---|---|
| Repeated selectors inside `landing.css` / `wake-onboarding.css` / `editors.css` / `studio-shell.css` | Normal cascade, not twins |
| `.lg-menu` language in `chat-appearance.css` + `settings.css` | INTENTIONAL VARIANT |
| Electron overlay `:root` glass tokens duplicated across `menu.html` / `panel.html` / `live.html` / `picker.html` | EXACT DUPLICATE of tokens; full sheets are NEAR |
| `model-builder.css` still imported; classes unused from TS/JSX | LIKELY DEAD file content |
| Synthesis glow / neuron-pill selectors in `wake-onboarding.css` | LIKELY DEAD selectors |

Do not rewrite global CSS in the same pass as JS deletions.

---

## Tests / scripts / docs

### Tests

| Item | Class | Proof |
|---|---|---|
| `tests/memory/memoryCutover.test.mjs` | In-flight | Deleted-module imports already dropped mid-audit. Confirm remaining assertions against the new resolver. |
| Other `tests/memory/*.test.mjs` | LIVE | No deleted-module imports |
| `src/lib/ai/actionJsonRescue.test.ts` | LIVE characterization | Locks quirks including wire XML; do not "fix" without a product decision |
| `src/lib/agentQuestions.test.ts` | LIVE but tests deprecated `letteredOptions` / `parseAgentQuestions` | Production uses `questionChips` |
| Electron tests | LIVE | Relative requires resolve; no refs to deleted server modules |

### Scripts

| Item | Class |
|---|---|
| `package.json` named scripts | All targets exist |
| Deleted `scripts/backfill-concepts.mjs` | Already gone; still named in `SECURITY_REPORT_03.md` |
| ~25 operator scripts not in `package.json` | LEGACY / manual ops; do not mass-delete |
| `jobs/runVaultReconciler.js`, `jobs/runNightBrief.js` | LIVE (`render.yaml`) |

### Docs

| Item | Class |
|---|---|
| `docs/LEGACY_CODE.md` | Partially superseded by this audit and by Phase 3 deletions |
| `docs/memory-architecture.md`, `docs/memory-legacy-audit.md`, `docs/ARCHITECTURE.md` | Stale vs current tree (`render.yaml` already dropped synthesis/concepts crons) |
| `REPO_USAGE_AUDIT_2026-02-24.md` | LEGACY (paths like `src/canvas/` gone) |
| `SECURITY_REPORT_01–06.md`, `MASTER_SECURITY_REPORT.md`, `API_SECURITY_REPORT_08.md` | INTENTIONAL historical series |
| Root `116_DISPOSITION.md` | Content live; migration SQL still says "same directory" as `supabase-migrations/` |
| Root `AGENTS.md` / `agents.md` | Case alias, not two files |
| Electron `AGENTS.md` files | INTENTIONAL VARIANT runtimes; do not rewrite in this cleanup |

---

## Dangerous false positives

Things that look dead but are dynamically consumed, or that would change product behavior if removed.

1. **`lykn_searchVault`**
   Chat prompt forbids it.
   It remains in `SYNTHESIS_TOOLS` and voice dispatch.
   PUBLIC CONTRACT.

2. **ChatNeuron belief / fact / concept layouts**
   Tools that *create* those neurons are gone.
   Old `aiNeurons` JSON in saved chats can still render.
   LEGACY COMPATIBILITY, not proven dead.

3. **Canvas DI stubs on `ChatSendParams`**
   Always empty/no-op, but the orchestrator still calls them.
   Deleting without shrinking the orchestrator is a type/runtime break.

4. **`actionJsonRescue` strip**
   Apply is a no-op.
   Strip still prevents leaked JSON/`<add_blocks>` from showing in chat.

5. **Custom-models tools and UI**
   Hard-false flag.
   Read path and tool modules are an intentional soft-unplug.

6. **`memoryMigration.js` facts-table reader**
   Looks like leftover Synthesis.
   It is the Phase 2→3 import path.

7. **Vault synthesis reindex**
   Name says Synthesis.
   It is vault RAG chunking.

8. **Electron IPC with no renderer `invoke`**
   Overlay/app preloads use different bridges (`lykn:app-bridge`, stage `pushAgentStageState`).
   Only `lykn:agent-recents-list` was traced as a likely orphan.

9. **`date-fns`**
   Zero direct imports.
   Peer of `react-day-picker`.

10. **`lodash` / `canvas-confetti`**
    App code may not import them.
    Artifact compile / test fixtures can resolve bare imports from `node_modules`.

11. **Operator scripts, Stripe webhooks, poll-due routes**
    No in-repo UI callers.
    External/cron consumers.

12. **Voice trio** (`LyknChatVoiceMode` / Eleven / `VoiceModePopup`)
    Looks like three generations.
    It is a provider switch.

13. **`AppLauncherWidget` vs `LyknAppLauncherWidget`**
    macOS apps vs LYKN-installed apps.
    Both live in the widget catalog.

14. **Redirect aliases** (`/omnia`, `/vaultchat`, …)
    Bookmark compatibility.

15. **`lib/projectContext.js` (untracked in this tree)**
    New extract from deleted `beliefSystem.js` project helpers.
    Already imported by `server.js` and `mcp-tools/resolveProject.js`.

---

## Recommended cleanup sequence

Four aggressive passes.
Do not run them as dozens of one-file PRs.
Do not start a pass that touches a file a parallel stream is rewriting.

### Pass A — Frontend orphans (do now; no collision)

Delete proven-dead UI and tiny leftovers that do not touch `server.js`, `server/memory/**`, or Electron main:

- `FeedbackModal`, `ChatThreadSidebarGroups`, `MorningBriefCard`, `StewardKanban`, `PlanGate`, `RichTextRenderer`
- unused Wake shells (after a Remotion/HTML string check)
- `ZoomTrafficLight.jsx` re-export file
- `dictationTimerRef`
- `createChatThreadWithBoard`
- `categoryExplainers.ts`
- unused shadcn primitives listed above
- `handleOrganizeIdeas` / `handleProjectSuggestions` / `handleProjectSummary`
- `viaVoice` if product does not need the marker
- stop writing `aiResponseStats` **or** mount a replacement Memory briefing UI (the briefing panel was deleted this window)

Optional same-pass mechanicals (no behavior change):

- point `chatThreadRuntime` (and other stragglers) at `chatTurnTypes`
- import `extractYouTubeLinks` / `formatDate` from `vaultCardHelpers`
- share OAuth/Token `authedFetch` / `relativeTime` / `truncate`
- rename the `LyknChat.tsx` toolbar import so it is not aliased as `LyknChatBarToolbar`

### Pass B — Chat canvas fiction (after A; still avoid concurrent files)

Single PR that shrinks the "grid might return" story in the chat client only:

- delete `handleActionPath` or hide it behind an explicit flag that is off
- drop Grid add-to-grid props / missing `GridIcon` branch
- collapse `notesOpen` if notes UI is retired
- extract YouTube retry helper inside `chatTranscription.ts`
- unify attachment types
- decide whether `actionJsonRescue` should **only strip** (stop calling `applyActions`)
- keep orchestrator DI stubs until this pass also narrows `ChatSendParams`

Do not touch `server.js` invoke `returnActions` in this pass.

### Pass C — Phase 3 residue (after Memory demolition lands)

Coordinate with the Memory stream.
Then, in one prompt/test pass:

1. Rewrite `LYKN_CHAT_TOOL_GUIDANCE` to match `CHAT_TOOL_NAMES`.
2. Drop `lykn_findConnections` from Glass strip sets and `toolStatusVerbs`.
3. Remove `fetchBeliefSection` from voice grounding (use `resolveProductionChatMemory` + project context only).
4. Re-run `test:memory` and trim any remaining cutover assertions that still describe the deleted bridge.
5. Unify `[WHO_I_AM]` vs `[USER MEMORY]` naming in personas vs injector.
6. Refresh `docs/memory-*` and `docs/LEGACY_CODE.md`.
7. Remove `umap-js` / `density-clustering` if still unimported.

Do not delete `synthesis.routes.js` or vault reindex here.

### Pass D — Electron helpers (after `main.cjs` decomposition)

When AppleScript / overlay scripts are already being moved:

- share `runOsascript`
- share overlay `escapeHtml`
- delete or wire `lykn:agent-recents-list`
- drop unused deprecated aliases (`formatMultiStepAnswer`, `runCreateInSheets`) and update the slice test
- optionally share `readCached`

Do **not** merge `browser-agent` with `bot-harness`.

### Explicitly out of scope until a product decision

- Custom models (`CUSTOM_MODELS_ENABLED`)
- Wake toolbar fork
- ChatNeuron belief/fact/concept renderers
- `memoryMigration` facts table
- `lykn_searchVault`
- Persona rewrite beyond the memory-tag alias
- Global CSS restyle
- Billing/pricing constant unification (`pricing-config.js` vs `usageTracking.js`)

---

## Method

- Static ripgrep of imports, registries (`CHAT_TOOL_NAMES`, `SYNTHESIS_TOOLS`), `ipcMain.handle` / `ipcRenderer.invoke`, and route files.
- Mechanical body compare for the exact-duplicate claims above (`providerForModel`, `runOsascript`, `readCached`, connection-dialog helpers, YouTube/date helpers, `CUSTOM_MODELS_ENABLED`).
- Line estimates from file reads and `wc`-scale sizes, rounded.
- Conservative default: FEATURE-GATED or PUBLIC CONTRACT when a string-based dispatcher exists.

Working tree at audit time already contained large uncommitted Phase 3 deletions.
Counts above describe **remaining** opportunity, not the in-flight demolition.
