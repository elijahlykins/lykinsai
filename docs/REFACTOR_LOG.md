# Refactor log

Breadcrumb trail for structural changes. One entry per batch; each batch has ONE
architectural objective. Rule: **move first, improve later** — structural moves
never change logic, interfaces, or behavior in the same commit.

Template:

```text
### Change
Moved `X` from `A` to `B`.

### Reason
Why X belongs in B.

### Behavioral change
None intended.

### References checked
- imports/exports re-verified (grep for old paths)
- duplicate definitions checked
- typecheck / relevant `npm run test:*` suites run
```

---

## Batch 1 — 2026-08-25 — Extract pure vault card helpers

### Change
Moved 27 pure top-level helper functions from `src/pages/Vault.jsx` (formerly
lines ~206–868) into new module `src/lib/vault/vaultCardHelpers.js`:
`driveFolderIdFor`, `stripAttachmentJsonMarker`, `isVoiceNoteCard`,
`parseStorageTarget`, `buildTextExcerpt`, `buildSpacedExcerpt`,
`resolveTextNoteStyle`, `textNoteLabel`, `isSupabaseStorageUrlText`,
`sanitizeCardTitle`, `parseAttachmentNotes`, `parseQuickNoteComments`,
`withAttachmentJsonMarker`, `decodeHtmlEntities`, `extractChatPreview`,
`formatDate`, `toNumber`, `resolveAttachmentAspectRatio`, `isYouTubeShortUrl`,
`stableBucket`, `getYouTubeOffsetClass`, `vaultPdfEmbedUrl`,
`isUniformVaultTileClass`, `getAttachmentHeightClass`, `estimateCardHeightUnit`,
`resolveStableTileHeight`, `extractYouTubeLinks`.

Function bodies and comments moved verbatim; only `export` keywords added.
`Vault.jsx` imports 24 of them (the other 3 — `decodeHtmlEntities`,
`isYouTubeShortUrl`, `stableBucket` — were only called by other moved helpers).
The now-unused `isVerticalSocialContent` import moved from `Vault.jsx` to the
new module.

### Deliberately NOT moved
`resolveSourceFolder` (module-level memo cache + CONNECTORS), signed-URL cache
trio (`parseSignedUrlExpiry`/`readCachedSignedUrl`/`writeCachedSignedUrl` —
mutates caller cache, time-dependent), `renderConnectorListCard` (JSX),
`trapPopoverWheel` (DOM events), all module constants.

### Reason
Vault card parsing/layout helpers are deterministic functions with no React
or I/O dependencies; extracting them shrinks the 10.2k-line page and creates
the seam for future Vault splits.

### Behavioral change
None intended. Bodies byte-identical apart from `export`.

### References checked
- Each moved name: exactly 1 definition repo-wide after move (grep).
- All in-file call sites resolve via the new import (ESLint `no-undef` +
  `unused-imports` clean for this batch; the 2 remaining errors —
  `ChevronUp`/`ArrowRight` icons — were already unused at HEAD, left for a
  dedicated cleanup batch).
- `stripAttachmentsMarker`/`withAttachmentsMarker` imports kept in Vault.jsx
  (still used at ~3187/3697/9053).
- `npm run build` (vite): success.
- Known drift NOT touched: `src/lib/vault/vaultContentsForAi.ts` keeps its own
  older private copies of 7 of these helpers — future dedup batch must diff
  them first.

### Result
`Vault.jsx`: 10,163 → 9,706 lines (−457). New module: 498 lines.

---

## Batch 2 — 2026-08-25 — Remove unused imports in Vault.jsx

### Change
Removed two unused named imports from the `lucide-react` import block in
`src/pages/Vault.jsx`: `ChevronUp`, `ArrowRight`.

### Reason
Both symbols had zero references in the file. Verified against the
pre-Batch-1 baseline (`git show 85be9a4~1`): each already had exactly one
reference (the import line itself) before the helper extraction, so they were
pre-existing dead imports, not orphans created by Batch 1.

### Behavioral change
None. Named icon imports have no side effects.

### References checked
- ESLint `unused-imports/no-unused-imports`: 0 errors after change
  (was 2; remaining warnings are pre-existing unused eslint-disable
  directives, out of scope).
- `npm run build` (vite): success.

### Result
`Vault.jsx`: 9,706 → 9,704 lines (−2).

---

## Batch 3 — 2026-08-25 — Extract VaultLoadMoreSkeleton component

### Change
Moved the inline `VaultLoadMoreSkeleton` component and its private
`VAULT_SKELETON_HEIGHTS` constant (formerly `src/pages/Vault.jsx` lines
428–481) into `src/components/vault/VaultLoadMoreSkeleton.jsx`
(default export, matching the folder's existing convention). Added one
import in `Vault.jsx`.

### Reason
Purely presentational loading-skeleton component: props only
(`masonry`/`embedded`/`count`), zero external dependencies, two call sites,
no page state. Safest first JSX extraction; establishes the pattern for
moving larger Vault subcomponents.

### Behavioral change
None intended. Component + constant bodies verified byte-identical to the
pre-extraction file (diff against `git show HEAD` range); both call sites
and their props untouched.

### References checked
- Exactly one definition repo-wide after move.
- `Vault.jsx` refs: 1 import + 2 call sites (lines ~7895/7902), unchanged
  props (`masonry`, `embedded`, `count`).
- `VAULT_SKELETON_HEIGHTS`: 0 references left in `Vault.jsx`.
- ESLint on both files: 0 errors (warnings are pre-existing unused
  eslint-disable directives).
- `npm run build` (vite): success.

### Result
`Vault.jsx`: 9,704 → 9,649 lines (−55). New component file: 59 lines.

---

## Batch 4 — 2026-08-25 — Extract WhyEditor component

### Change
Moved the inline `WhyEditor` component (formerly `src/pages/Vault.jsx`
lines 467–617, including its docblock) into
`src/components/vault/WhyEditor.jsx` (default export). Added one import in
`Vault.jsx`.

### Reason
Next difficulty step after the skeleton: a component with local draft state
(`useState` ×3, `useEffect`), async `onSave` handling, and icon imports —
but all data/callbacks arrive via props (`initialValue`, `onSave`, `busy`,
`variant`, `onAddComment`, `commentActive`) and it has exactly one call
site. Proves the extraction workflow for stateful presentational
components.

### Dependencies
New file imports `useEffect`/`useState` (react) and
`MessageCircle`/`Pencil` (lucide-react). Both icons remain imported in
`Vault.jsx` for their other call sites (5 and 2 remaining uses) — shared
import, no code duplication.

### Behavioral change
None intended. 151-line body verified byte-identical against
`git show HEAD` (diff clean); the single call site (~line 9062) and its
props/callback expressions untouched.

### References checked
- Exactly one definition repo-wide after move.
- `Vault.jsx` refs: 1 import + 1 call site; prop names/defaults identical.
- ESLint on both files: 0 errors (8 pre-existing unused eslint-disable
  warnings, out of scope).
- `npm run build` (vite): success.

### Result
`Vault.jsx`: 9,649 → 9,498 lines (−151). New component file: 158 lines.

---

## Batch 5 — 2026-08-25 — Extract SourceFolderTile component

### Change
Moved the inline `SourceFolderTile` component (formerly `src/pages/Vault.jsx`
lines 9455–9498, including banner docblock) into
`src/components/vault/SourceFolderTile.jsx` (default export). Added one
import in `Vault.jsx`.

### Reason
Final named-component extraction from Vault.jsx. Connector "app icon" tile
with one visual responsibility; props only (`card`, `heightClass`), zero
external dependencies (it does NOT use the module-level
`resolveSourceFolder` cache — the page resolves connector config into the
card before rendering; verified all three `resolveSourceFolder` call sites
are page card-building code).

### Selection note
The batch goal was "slightly more connected than WhyEditor", but after
Batches 3–4 only two named inline components remained (`SourceFolderTile`
and the 10-line `VaultPickerTapOverlay`) — everything more connected is
anonymous JSX closing over page-level state. Per the safety-first rule the
less-connected candidate was chosen rather than forcing a state-owning
boundary. Next step: map Vault.jsx state ownership before any hook
extraction.

### Behavioral change
None intended. 44-line body verified byte-identical against
`git show HEAD`; both call sites (lines ~3545 and ~7501) and their prop
expressions untouched.

### References checked
- Exactly one definition repo-wide after move.
- `Vault.jsx` refs: 1 import + 2 call sites; prop names/defaults identical.
- ESLint on both files: 0 errors (8 pre-existing warnings).
- `npm run build` (vite): success.

### Result
`Vault.jsx`: 9,498 → 9,455 lines (−43). New component file: 49 lines.

---

## Phase V — 2026-08-25 — Vault megafile decomposition

### Change
Full architectural decomposition of `src/pages/Vault.jsx` (9,455 → 3,744
lines) guided by `docs/VAULT_STATE_MAP.md`. One coherent phase, staged as a
single commit. All code moved verbatim ("move first, improve later"); every
extraction validated with ESLint no-undef probing plus a Vite production
build before proceeding.

### Modules created

Hooks (behavioral subsystems; state that page memos read stays in Vault.jsx
and is passed in):
- `src/hooks/useVaultSignedUrls.js` (689) — signed-URL/media resolution:
  visibility-driven resolve queue, signed-URL cache, video posters, drive
  artifact markup, image-dimension learning + DB backfill, tab-refocus pass.
- `src/hooks/useVaultTags.js` (216) — tag directory, filter selection, tag
  picker state, tag mutations, AI Drive tag strip.
- `src/hooks/useVaultConceptSearch.js` (199) — hybrid local+AI concept
  search behavior (state stays on the page; visibleCards reads it).
- `src/hooks/useVaultQuickCapture.js` (240) — quick-note composer,
  new-note chooser, save-link dialog write paths.
- `src/hooks/useVaultCardOrdering.js` (185) — manual collage order
  (localStorage-persisted), connector-folder pinning, wake strip split,
  Tags/Type groupings.
- `src/hooks/useVaultReveal.js` (233) — progressive reveal window for the
  feed views + plain infinite scroll for Tags/Type.
- `src/hooks/useVaultMasonry.js` (93) — fixed-column JS masonry: column
  count, frozen height estimates, shortest-column buckets.
- `src/hooks/useVaultCardMutations.jsx` (728) — every per-card write path:
  delete (single/confirmed/bulk+undo), project membership, comments CRUD,
  "why" field, move-to-folder, wake-preview local equivalents.
- `src/hooks/useVaultDriveWindow.js` (487) — AI Drive listing integration:
  entries + preview art, select/open/folder navigation, file-window picks
  (move / add-to-project), save-to-device, ?pane=drive deep link. Exports
  `DRIVE_FOLDERS` (also read by the page's visibleCards memo).

Components / render modules:
- `src/components/vault/vaultCardRenderers.jsx` (1,218) —
  `renderConnectorListCard` plus `createRenderAttachmentCard` /
  `createRenderCollageCard` factories (deliberately factories, not
  components, to preserve closure/reconciliation semantics).
- `src/components/vault/VaultPreviewOverlay.jsx` (1,156) — expanded-card
  lightbox + details rail + `VaultPreviewShareMenu` (named export).
- `src/components/vault/VaultCardPopovers.jsx` (539) — the three
  card-anchored portals: "⋯" action menu, comment composer, tag picker.
- `src/components/vault/VaultToolbar.jsx` (429) — search inputs (embedded +
  standard), view dropdown, tag-filter dropdown, connect-apps buttons,
  concept-search status line. Owns `VAULT_VIEW_OPTIONS`.
- `src/components/vault/VaultGrid.jsx` (449) — the card views: breadcrumb,
  empty state, Tags/Type groupings, wake strip, masonry/plain grid feed,
  sentinel, load-more skeletons.

Lib:
- `src/lib/vault/signedUrlCache.js` (76) — pure signed-URL cache helpers
  over a caller-owned Map (cache identity/lifetime unchanged: still a ref).

### Deliberately left in Vault.jsx (cohesive page concerns)
Data loading (notes query + pagination + ghost-card merge), the vaultCards /
visibleCards memos and the state they read (search, view, drive folder),
selection + card press handling, picker-mode postMessage protocol, upload /
drag-drop wiring, popover chrome effects (shared dismissal/positioning),
first-paint eager preload gate, page JSX composition.

### Behavior changes
None intended. Known pre-existing dead code kept as-is: `handleCardDrag` /
`handleCardDragEnd` were already unreferenced at HEAD (only
`handleCardDragStart` is wired).

### Validation
- ESLint on all phase files: 0 errors (6 warnings, pre-existing).
- `npm run test:vault`: 51/51 pass.
- `npm run typecheck`: 822 errors before AND after (repo baseline; zero
  introduced — verified by stashing and re-running).
- `npx vite build`: success (repeated after every extraction).

### Result
`Vault.jsx`: 9,455 → 3,744 lines (−5,711). 15 new modules, 6,937 lines.
Diff: 18 files changed, +7,620 / −6,257.

---

## Phase VI — LyknChat megafile decomposition

Single architectural phase (one commit): decompose `src/pages/LyknChat.tsx`
from 6,127 lines toward the ~4,000-line target while preserving behavior.
Method identical to Phase V: verbatim line-range extraction (Python scripts,
no retyping), lint/typecheck/build after every extraction, "move first,
improve later".

### What moved where

Lib (module-scope types + helpers):
- `src/lib/lyknChat/chatTurnTypes.ts` (186) — PromptMessage (turn row with
  bot/greeting metadata), FocusedChatAttachment, BotSendAttachment,
  CreateAction / OrchestratorResult contracts, board→chat import payload
  types + `CHAT_TO_BOARD_IMPORT_KEY`.
- `src/lib/lyknChat/chatAttachmentInput.ts` (62) — URL attachment-type
  inference, attachment id minting, chat-attachments → Imagine input mapping.

Components:
- `src/components/lyknChat/StudioChatChrome.tsx` (459) — the Studio glass
  chrome: StudioView model (Chat/Build/Imagine/Research) with per-mode
  system prompts / headlines / placeholders, `StudioModePill`,
  `StudioComposerStrip` quick-start chips, post-report/post-build
  `StudioFollowUpSuggestions` (+ item builders), `StudioResearchSidebar`.
- `src/components/lyknChat/ChatBarToolbar.tsx` (398) — the page's inline
  chat-bar toolbar (model select, mode/project chips, research-source and
  imagine-layout selects, "+" menu, dictate/stop/send) plus
  `LyknChatModelSelectMenuBody` and `composerModeLabel`.

Hooks:
- `src/hooks/useChatVaultSaves.ts` (650) — every save-to-vault path: AI
  images, YouTube/link bookmark notes, chat file attachments (bytes copied
  into user storage), research report save, artifact save with per-chat
  lineage upsert map.
- `src/hooks/useChatVoiceMode.ts` (395) — Voice Mode: eligibility + silent
  exit on model switch, session instruction assembly (prefs + recent chat +
  workspace/KB under the 8k budget), voice-turn mirroring into the thread,
  display_document hook, voice paste/attach pipeline (ingest → OCR → vision
  description → chat mirror → quiet vault auto-save → contextual update).
- `src/hooks/useBotChatBridge.ts` (261) — Bot turns: send + streamed reply
  patching, re-attach/catch-up after remount, board hop, mark-seen, and the
  held-send ref pair (`pendingBotSendRef` / `chatIdLiveRef`) consumed by the
  page's home-screen stash effect.
- `src/hooks/useLoadInGreeting.ts` (406) — load-in greeting lifecycle:
  consume the stashed payload (typewriter seed), stale-greeting in-place
  refresh + placeholder-upgrade animation.

### `LyknChatBarToolbar` duplicate — verdict
Drifted duplication with intentionally different behavior, NOT consolidated.
`src/components/lyknChat/LyknChatBarToolbar.tsx` (141 lines) is an earlier,
simpler variant used only by the Wake marketing tour
(`WakeChatTourPreview`), with a different prop contract (`toolbarSelect`
override, single `handleOpenAttachments` button, no mode chips/selects).
The page's inline version had grown the "+" menu, composer-mode and
scoped-project chips, research-source and imagine-layout selects, and its
own open-state management. Both files now carry header comments explaining
the relationship; merge only with proven equivalence.

### Dead code removed (verified, not moved)
`TASK_LINE_RE`, `tiptapJsonToPlainText`, `flattenNodeText`,
`normalizeChecklistSyntax`, `splitResponseIntoChunks` were file-private and
unreferenced in LyknChat.tsx — stale copies left behind by the earlier
LyknChatView extraction (live versions exist in `LyknChatView.tsx` /
`useChatEngine.ts`). Imports orphaned by the moves were removed; imports
that were already unused at HEAD were left untouched.

### Deliberately left in LyknChat.tsx (orchestration concerns)
Engine integration (`useChatEngine` wiring), send pipeline
(`studioGuardedSend`, bot routing, home-screen stash consumption),
hydration/persistence (`useLyknChatPersistence` + attachment re-signing),
app-edit strip, imagine thread persistence/commit, focused-chat handlers,
rail sizing, dialogs, page JSX composition. `useChatEngine` and
`chatSendOrchestrator` untouched (own phases later).

### Behavior changes
None intended.

### Validation
- `npm run typecheck`: 822 errors at HEAD baseline; 822 attributable errors
  after (signature-level diff: zero new). Note: a parallel work stream
  dropped untracked `src/components/studio/` files into the working tree
  mid-phase; the 5 extra diagnostics they add are theirs, not this phase's
  (verified by stash/re-run).
- `npx vite build`: success after every extraction and at phase end.
- Chat tests (`browserChatAttach.test.ts`): 6/6 pass.
- `npm run test:vault` regression: 51/51 pass.
- ESLint: repo config does not cover .ts/.tsx (validated via tsc instead).

### Result
`LyknChat.tsx`: 6,127 → 3,594 lines (−2,533). 8 new modules, 2,817 lines.

---

## Phase VII — Studio megafile decomposition

Single architectural phase (one commit): decompose `src/pages/Studio.jsx`
from 4,454 lines toward the ~4,000-line target while preserving behavior.
Method identical to Phases V–VI: verbatim extraction, page retains
orchestration only.

### What moved where

Registry / layout:
- `src/components/studio/studioAppRegistry.js` (210) — WINDOW_APPS,
  SECTIONS, SETTINGS_VIEWS, NAV_ITEMS / DOCK_ITEMS, Split View app list,
  dock hide-set persistence, frost/drag tokens, query-param helper.
- `src/components/studio/studioSplitLayout.js` (47) — Split View cell
  geometry helpers (`splitCells`, span/sibling/hidden index).
- `src/components/studio/studioLinks.jsx` (92) — `openStudioLink`,
  favicon helper, `PageFavicon` (consumed by the agent rail).

Surfaces:
- `src/components/studio/StudioSurface.jsx` (79) — MemoryRouter-hosted
  product surfaces + `StudioChatPane`.
- `src/components/studio/StudioBrowserBody.jsx` (169) — Browser window
  body (native-view dock surface, skeleton/screenshot stand-ins) and
  `BROWSER_VIEW_RADIUS` / `BROWSER_CHROME_HEIGHT`.
- `src/components/studio/StudioDock.jsx` (480) — bottom dock and chats
  popover.

Agent rail:
- `src/components/studio/agentRail/StudioAgentRail.jsx` (1,262) — Browser
  agent rail UI and thread controls.
- `src/components/studio/agentRail/AgentRailMarkdown.jsx` (386) — rail
  markdown body + live-step/transcript helpers.
- `src/components/studio/agentRail/agentRailData.js` (230) — labels,
  grouping, follow-up chips, source-link extraction.

### Deliberately left in Studio.jsx (orchestration concerns)
Tabs, the Home chat layer, desktop drops/widgets, floating windows,
Split View state, and browser docking.

### Behavior changes
None intended.

### Result
`Studio.jsx`: 4,454 → 1,661 lines (−2,793). 9 new modules, 2,955 lines.
