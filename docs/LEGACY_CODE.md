# Legacy / suspicious code report

Audit date: 2026-08-25. Static reference analysis of the whole repo, with dynamic-
reference checks (dynamic imports, `React.lazy`, `path.join` HTML loads, IPC string
channels, env-gated features, webhooks, crons). Nothing here has been deleted;
"Confirmed dead" items are safe-to-delete candidates awaiting sign-off.

Rule used: **never delete something only because it looks unused.** Evidence is
recorded per item so classifications can be re-verified.

## Confirmed dead (strong static evidence, no dynamic consumers found)

| Item | Evidence |
|---|---|
| `src/components/FeedbackModal.jsx` | Zero references outside itself (repo-wide grep). |
| `src/components/chat/ChatThreadSidebarGroups.jsx` | Zero importers; it is the only file in `components/chat/`, so the folder dies with it. |
| `src/components/lyknChat/LoadInBriefingPanel.tsx` | Zero importers. Only mention is a *comment* in `SynthesisLayer.tsx:1387` describing it as the successor UI — the actual load-in UI now lives inline in `LyknChatView.tsx` (`LoadInBubble`). Update that comment when removing. |
| `scripts/tmp-check-admin-user.mjs` | One-off debugging script, untracked in git, zero references. |
| npm deps with zero imports anywhere: `react-leaflet`, `moment`, `immer`, `cmdk`, `vaul`, `input-otp`, `embla-carousel-react`, `next-themes`, `sonner`, `react-hot-toast` | Grepped `src/`, `electron/`, `lib/`, `server.js`, `mcp-tools/`, `connectors/`, `jobs/`, `scripts/`, `remotion/` for import/require of each: 0 hits. `react-hot-toast` appears only in a comment in `use-toast.jsx`. Note: `eslint.config.js` still ignores `cmdk-input-wrapper` in `react/no-unknown-property` — stale once cmdk is removed. |

## NOT dead despite appearances (verified live — do not remove)

| Item | Why it looks dead | Why it is live |
|---|---|---|
| `date-fns` | Zero direct imports | **Required peer dependency of `react-day-picker`** (used by `src/components/ui/DatePickerPopover.jsx`). Must stay. |
| All root-level service files (`beliefSystem.js`, `userModelLearning.js`, `chat-agent-loop.js`, `connectors-service.js`, `rss-service.js`, `synthesis-service.js`, `youtubeQa.js`, `usageTracking.js`, `security-logger.js`, `validation.js`, `validateSecrets.js`, `prompt-sanitizer.js`, `conceptEmbedding.js`, `factEmbedding.js`, `custom-models-{routes,service}.js`) | Loose files at repo root | All imported by `server.js` and/or `jobs/`, `mcp-tools/`, `connectors/`, `lib/`. `chat-agent-loop.js` survived the deletion of `electron/chatAgentRoute.cjs` because `server.js` imports it directly (plus a dynamic import in `lib/modelBuilder/runSubModelDelegate.js`). |
| Every top-level `electron/*.cjs`/`*.js` runtime module | Some have no `require()` hits | Loaded by path string: `preload: path.join(__dirname, …)`, `loadFile(*.html)` with `<script src>` tags, `electron-builder.json` `afterSign` (`notarize.cjs`). |
| `electron/vendor/elevenlabs-client.iife.js` (~24k lines) | Giant unexplained file | Vendored third-party ElevenLabs bundle, loaded by `overlay.html` script tag. |
| Voice trio: `LyknChatVoiceMode.tsx` / `LyknChatVoiceModeEleven.tsx` / `VoiceModePopup.tsx` | Looks like three generations | It's a provider switch: facade picks Eleven vs OpenAI path; popup is the shared chrome. All three render. |
| `extensions/save-to-lykn` | Sits outside src | Packaged into the desktop app via `electron-builder.json` extraResources; installed by `extensionInstaller.cjs`. |
| Secret/env-gated server routes (`/api/synthesis/backfill`, `*/poll-due`, `/api/discover/ingest`, Stripe webhook) | No in-repo callers | External consumers: Stripe, Render crons, ops scripts with shared secrets. |

## Probably dead (flagged — needs your decision, not auto-removed)

| Item | Evidence / uncertainty |
|---|---|
| `restart-server.ps1` | Not referenced by any npm script; only mentioned in the stale repo audit doc. Manual Windows helper — harmless, likely obsolete on a Mac-centric project. |
| Default export of `src/components/lyknChat/LyknChatComposer.tsx` | The component itself is never mounted (composer is inlined in `LyknChat.tsx`); only the `resizeLyknChatInput` helper is imported (by `WakeChatTourPreview.tsx`). Candidate: keep helper, drop dead component — but verify no dynamic mount first. |
| npm `lodash`, `canvas-confetti` | REQUIRES MANUAL REVIEW. App code never imports them — `lib/exterior/capabilities/buildReactArtifact.js` rewrites artifact imports to CDN globals (unpkg). BUT test fixtures (`electron/localStore/apps.test.cjs`, `scripts/test-react-artifact.mjs`) contain fixture apps that `import _ from "lodash"`; if the local app compiler (`electron/appRuntime/compile.cjs`, esbuild) resolves bare imports from `node_modules`, removing lodash breaks `test:apps` and possibly user-app installs that import lodash. Do not remove until compile-path resolution is confirmed. |
| `src/pages/TagManagement.jsx` | Routed at `/tag-management` but is a 12-line stub saying the feature migrated into chat. The route works; the page does nothing. Decide: remove route+page, or leave as tombstone. |

## Possibly legacy (older generation of something that exists elsewhere)

| Item | Situation |
|---|---|
| `src/pages/SynthesisLayer.tsx` (~6.9k lines) + `src/pages/synthesis/` scene code | Soft-disabled: `SYNTHESIS_LAYER_UI_ENABLED = false` in `src/lib/synthesisLayerUi.ts` redirects `/synthesis-layer` → `/studio`. Code still compiles into a lazy chunk. Parked feature, not dead — product decision needed before touching. |
| Legacy top-level product routes (`/app`, `/settings`, `/chat/:id`, `/vault`, `/projects`, `/calendar`, `/todos`) | Wrapped in `LegacyProductToStudio`: redirect to `/studio` unless `?embedded=1`. Still load-bearing for Studio's embedded surfaces — the "legacy" wrapper is the mechanism, not dead code. |
| Redirect aliases `/dashboard`, `/omnia`, `/vaultchat`, `/vault-chat`, `/connections`, `/onboarding/connect` | Intentional tombstones for old bookmarks. Cheap to keep. |
| Retired adaptive browse loop (`executeOwnedAdaptiveTask` in `electron/ownedBrowserAct.cjs`) | Removed in C1. Production browse is TaskRuntime → BrowserExecutor → `browser-agent/`. `ownedBrowserAct` remains the actuator (`runAction`, catalog, heuristics). |
| Custom models product | `CUSTOM_MODELS_ENABLED = false` (`src/lib/customModelsEnabled.ts`): builder UI retired, but read path (`custom-models-service.js`, published models, sub-model delegate) is live. Feature-flagged, not dead. |
| `createStudioWindow` helpers in `electron/main.cjs` | Comments say Studio *is* the main window now; separate-window helpers kept for compatibility. |
| `REPO_USAGE_AUDIT_2026-02-24.md` | Stale — references `src/canvas/`, `OmniaCanvas`, `Dashboard` which no longer exist. Superseded by this document. |
| `jsconfig`/`eslint.config.js` reference to `src/Layout.jsx` | File no longer exists; stale config entry. |

## Duplicate implementation (understood, intentional — do not consolidate blindly)

| Pair | Verdict |
|---|---|
| `electron/browser-agent/` vs `electron/bot-harness/` | Sibling architectures, not a fork: same runtime shape (contextRouter/taskState/instructions) but different schemas; bot-harness imports `normalizeAnswerOptions` from browser-agent rather than copying. Both required by `agentRuntime.cjs`. |
| Embedding layers (`factEmbedding.js`, `conceptEmbedding.js`, `synthesis-service.js`, inline server embed paths, `electron/localStore` CJS ports) | Different tables/surfaces. Known real duplication: vault-chunk embedding exists both inline in `server.js` and in `synthesis-service.js` (noted in the file itself). Consolidation = Risk Level 3+. |
| Provider routing (`server.js` inline streaming, `lib/agentModelProviders.js`, `mcp-tools/chatTools.js` `providerForModel`) | `chatTools.js` duplicates provider mapping *intentionally* to avoid an import cycle — consolidating requires breaking that cycle first. |
| `LyknChatBarToolbar` (component file) vs inline memo toolbar in `LyknChat.tsx` | Real UI duplication: file version serves wake preview + HomeChatBar; LyknChat defines its own. Candidate for consolidation after diffing behavior. |
| Local tool definitions (`mcp-tools/localTools.js` schemas vs `electron/localSystem.cjs` execution list) | Deliberate split (server declares, desktop executes). Names must stay in sync — a sync test would help; merging would violate the key-holding boundary. |
| Pricing constants (`src/lib/pricing-config.js` + credit costs in `usageTracking.js`) | Comments say "keep in sync" — drift risk, single-source candidate (Risk 3: billing). |

## Needs manual investigation

| Item | Question |
|---|---|
| `src/assets/LoadingScreen.mov` (30k lines binary-ish in git) | Is this still shown anywhere, and should a video live in git / the bundle? |
| ~15 root-level `.md` reports (SECURITY_REPORT_01–06, MASTER_SECURITY_REPORT, API_SECURITY_REPORT_08, runbooks, plans) | Docs, not code. Move to `docs/` (pure file move, zero runtime risk) — confirm nothing external links to their GitHub paths. |
| `beliefSystem.js` promotion vs nightly `jobs/synthesisJob.js` clustering | Two belief-promotion paths by design or by drift? Product answer needed. |
| `stash@{0}` (WIP on local-first) | A git stash from an older branch state exists. Review and drop/apply deliberately. |
