# Repo Split Audit — Dedicated MacApp Repo

**Date:** 2026-08-15 · **Scope:** every file/directory in the repo (322 classified entries, 83 adversarially re-verified against actual import graphs)

**Goal:** make this repo the dedicated **Mac desktop app** repo. Everything that doesn't need to live here is marked below with its destination: website repo, backend repo, iOS repo, extension repo, legacy (freeze), or dead (delete).

---

## 1. The architecture fact that shapes everything

The shipped Mac app is a **thin native shell that loads the deployed web frontend remotely**:

- `electron/main.cjs:128` — `APP_URL = process.env.LYKN_APP_URL || "https://lykn.io"`
- `electron-builder.json` packages **only** `electron/**`, two `lib/*.cjs` files, and the bundled `save-to-lykn` extension. **No `dist/`, no `src/` ships in the binary.**
- The iOS Capacitor shell loads the same `https://lykn.io` deployment.
- In a plain browser, `src/lib/webAppAccess.ts` gates all product routes to `/download` (`VITE_WEB_APP_ENABLED` unset in prod — confirmed constant-folded to `false` in the live bundle).

So one Vite SPA serves **three audiences from one deployment**: browser visitors see the marketing subset, and the Electron + iOS shells render the full product UI. "The website" and "the Mac app's UI" are the same build; the fork between them is client-side. Every split decision below flows from this.

## 2. Proposed end-state repos

| Repo | Contents | Size of the move |
|---|---|---|
| **lykn-macapp** (this repo) | `electron/**`, 6 `lib/*.cjs` intent/screen modules + their tests, vendored extension (temporarily), `electron-builder.json`, ~15-dep `package.json`, 5 `scripts/`, CI hygiene. Plus `src/` **temporarily** (see Decision A) | stays |
| **lykn-backend** | `server.js` + 21 root service files, `lib/**` (most), `jobs/**`, `mcp-tools/**`, `connectors/**`, `supabase-migrations/**`, `supabase-queries/**`, `render.yaml`, ~26 ops scripts, ops/security docs | 98 entries |
| **lykn-website** | 13 marketing/legal pages + CSS, `src/components/landing/**`, news content, `remotion/**` (video toolchain), ~56 MB of `public/videos`, marketing assets, robots/sitemap/OG | 36 entries + shared copies |
| **lykn-ios** | `ios/**`, `capacitor.config.ts`, `@capacitor/*` deps, iOS compliance docs | 3 entries |
| **lykn-extension** | `extensions/save-to-lykn/**` — Mac repo consumes a pinned build artifact | 1 tree |

## 3. What "make the WebApp legacy" actually means

The browser web app is **already legacy in production** — the gate bounces every product route to `/download`, and login-in-browser dead-ends at the download page. Making it official:

1. **Keep the gate as the mechanism.** `VITE_WEB_APP_ENABLED` stays unset; `webAppAccess.ts` is the enforcement point and stays.
2. **`src/` cannot be archived or deleted** — it *is* the Mac app's UI, loaded remotely. "Legacy" applies to the *browser access path*, not the SPA itself.
3. Four items are true legacy (§tables): `ResetPassword.jsx` (superseded by code-based reset), `IMPLEMENTATION_GUIDE.md` + `QUICK_START.md` (document an abandoned file-storage design — `file_embeddings`/`chat_queries` tables referenced nowhere in code), and the Feb 2026 repo-usage audit snapshot.
4. 24 entries are **dead** (imported by nothing — full list in tables): the wake-tour preview chain (7 files), 5 unused shadcn components, ~14 unreferenced hero/demo assets including a 34 MB mp4, `electron/documentReader.cjs` (its five exports have zero callers), and 12.4 MB of committed marketing renders nothing references.

## 4. How easily can the website move to its own repo? — **Moderate**

The *code* move is surprisingly clean; the *deployment seam* is the hard 20%.

**Clean:** marketing pages import zero shadcn/ui; their product-code deps are type-only or single functions (copy-with-inline, ~8 small files); `GlassLanding.css` self-tokens; news content is hardcoded TS (no CMS work); the landing chat demo's only backend contract is `POST /api/ai/stream-guest`.

**Hard — the blockers:**

1. **Entry-URL topology.** The shells load the domain **root**, and the desktop-vs-browser fork for `/` happens client-side. Moving `/` to a website repo requires edge path-routing between two Vercel deployments **plus** repointing `electron/main.cjs` `APP_URL` and `capacitor server.url` to a product path (`/studio`) — i.e. a Mac binary update **and** an App Store release — plus a shim on the new website homepage (`if (window.lykn?.desktop) location.replace('/studio')`) for not-yet-updated binaries.
2. **Functional pages wearing website clothes.** `/login`, `/desktop-auth`, `/reset-password`, `/oauth/consent`, `/share`, `/billing/success|cancel` are load-bearing for Mac Google sign-in (the `mintDesktopAuthUrl` → loopback/`lykn://auth` handoff), the API's OAuth 302s, Stripe returns, the extension share target, and iOS universal links (AASA). **These stay with the product deployment**, whatever else moves.
3. **`/download` bounces.** Every gate redirect is a client-side router `Navigate` today; post-split `/download` lives in a different deployment, so each bounce becomes a full-page load and the edge rewrite list must include it.
4. **Three-way pricing coupling.** `src/lib/pricing-config.js` is imported by the marketing Pricing page, product billing, **and `server.js`** — post-split a price change must sync across three repos.
5. **List maintained twice.** `WEB_PUBLIC_PATHS` (`webAppAccess.ts:66`) and the new edge rewrite list are the same ~20 paths in two repos; divergence silently breaks the gate or the rewrites.
6. `index.html` does two jobs (marketing SEO/GA + SPA boot) — each repo needs its own; GA consent state won't span origins if a subdomain is chosen.
7. `remotion/` moves with the website, but two compositions feed **Mac build assets** (`electron/welcome-anim.webm`, DMG background) — keep the committed binaries here, re-render from the website repo (they're manually invoked; no build step runs remotion).

**Recommended topology:** the **product** project keeps the `lykn.io` domain, `vercel.json`, CSP/AASA/favicon headers, and all functional pages; the website becomes a second Vercel project reached by rewriting exactly the ~20 marketing paths. The 12-step cutover sequence is in the workflow appendix below; the non-negotiable ordering is **shell entry-URLs move off `/` before any rewrite ships**.

## 5. Open strategic decisions

| # | Decision | Recommendation |
|---|---|---|
| **A** | Does `src/` (product UI) stay here or get its own frontend repo? | **Extract eventually** — sequence it last. The binary already ships zero bytes of `src/`; the same deployment serves three shells; leaving it here makes the iOS repo depend on the "Mac" repo for its entire UI. Prerequisite: document the `window.lykn.*` preload bridge as a versioned contract (an `app.getVersion` handshake already exists at `main.cjs:14498`) and add a min-shell-version check in the deployed UI. Until then `src/` rides along here, clearly marked. |
| **B** | One shared `package.json` or per-repo manifests? | **Per-repo, immediately.** The Mac manifest drops from ~140 deps to ~15 (electron-updater + allowlisted transitives, pdfjs-dist, electron/electron-builder/concurrently + lazy-require optionals). The genuinely shared intent trio (`webSearchIntent`, `artifactBuildIntent`, `imageGenIntent`) gets copied to both repos with a contract test; graduate to a tiny private package if churn continues. |
| **C** | Bundled extension: vendored source or build artifact? | **Artifact, when ready.** Today the Mac bundle is the extension's *only* distribution channel (the Chrome-store URL env default is empty), so keep it vendored until the extension repo publishes pinned builds; the real coupling is the native-messaging contract (`bridge-config.json` + `extensionBridge.cjs`) — keep a bridge contract test here. No submodules. |
| **D** | Where does the welcome-animation source live? | **Website repo gets all of `remotion/`.** Only 1 of ~50 compositions feeds the shell, its 304 KB output is already committed, and no Mac build invokes remotion. Document the re-render recipe in both repos. Deletes the whole `@remotion/*`/`three`/`@react-three/*` block from the Mac manifest. |

## 6. Cross-repo contracts registry

The split's long-term risk isn't the move — it's these implicit contracts becoming invisible once they span repos. Registry to keep (and test) explicitly:

| Contract | Parties | Nature |
|---|---|---|
| `https://lykn.io` routes hardcoded in the shell: `/desktop-auth`, `/auth-handoff`, `/download`, `/news`, `/pricing`, `/privacy`, `/support`, `/terms`, `/watch` | macapp ↔ website/product deployments | Shipped binaries break if paths move |
| `window.lykn.*` preload bridge (incl. `app.getVersion` sync-IPC) | macapp ↔ frontend | The shell↔UI API; formalize + version |
| `lib/{webSearchIntent,artifactBuildIntent,imageGenIntent}.cjs` | macapp ↔ backend | Same files required by both `electron/` and `server.js` |
| `src/lib/pricing-config.js` (+ `CREDIT_COSTS` in `usageTracking.js`) | website ↔ frontend ↔ backend | Prices/weights must not drift from Stripe |
| `server.js` imports `src/lib/{modelTiers,pricing-config,ai/conversationFormat}` | backend ↔ frontend | Real import edges crossing the split — promote or copy |
| `mcp-tools/recommendTools.js` imports `src/lib/connectors/outboundTargets.js` | backend ↔ frontend | Only backend→src import in the MCP layer |
| `mcp-tools/localTools.js` ↔ `electron/localSystem.cjs` tool-name lists | backend ↔ macapp | Duplicated, not imported — drifts silently |
| `src/lib/ai/toolSyntaxStrip.ts` mirrors `chat-agent-loop.js` stripper | frontend ↔ backend | Comment-level sync contract |
| `WEB_PUBLIC_PATHS` ↔ edge rewrite list | frontend ↔ website | Same ~20 paths, two repos |
| Extension ↔ shell native-messaging bridge; extension → `{LYKN}/share`; content bridge → `127.0.0.1:38471` | extension ↔ macapp ↔ website | Save-to-Vault + Live Screen Watch text feed |
| `POST /api/ai/stream-guest` | website ↔ backend | Landing chat demo; CORS must admit website origin |
| AASA at `/.well-known/` on the domain owner | ios ↔ product deployment | Universal links |

## 7. Git mechanics of the split

- **742 commits, 182.9 MiB pack, single remote, no submodules** — history-preserving extraction via `git filter-repo --path <dirs>` per destination repo is mechanically straightforward.
- The pack is dominated by media that *leaves*: ~56 MB `public/videos`, 34 MB + 21.6 MB revisions of `src/assets/lykn-demo-hero.mp4` (unreferenced), 7.5 MB `LoadingScreen.mov` (unreferenced). Post-extraction `filter-repo` slims this repo dramatically.
- `package-lock.json` (842 KB) regenerates per-repo after manifest trims.

## 8. Defects found during the audit (fix regardless of split)

1. **Packaged Mac build from HEAD crashes at launch** — `electron-builder.json` `files` omits four `lib/*.cjs` modules top-level-required by `main.cjs:347` and `agentRuntime.cjs:20/40/44/45` (`artifactBuildIntent`, `imageGenIntent`, `agentToolVenues`, `agentMultiStep`). Verified directly. Either releases are cut from older commits or the last release predates these requires.
2. **Shadowed route** — `GET /api/v1/synthesis/activity` registered twice in `server.js` (lines 9519 and 10365); the MCP-token variant is unreachable dead code.
3. **Prod deps in `devDependencies`** — `express`/`cors`/`dotenv`/`node-fetch` are devDeps; the Render deploy works only because it runs plain `npm install`. Will break under `npm install --omit=dev` or `NODE_ENV=production` installs.
4. `README.md` is one line; the audit tables below are a starting inventory for a real one.

## 9. Suggested sequencing

1. **Fix the electron-builder `files` gap** (defect 1) — ship-blocking, independent of everything.
2. **Backend extraction first** — cleanest seam: nothing in `electron/` or `src/` imports the server files; resolve the 3 `server.js`→`src/lib` imports + intent trio by copy-with-contract-test. Move `render.yaml`, ops scripts, security/ops docs with it.
3. **iOS extraction** — trivial (3 entries); take `IOS_RELEASE_COMPLIANCE_PLAN.md`; AASA ownership goes to whoever owns the domain.
4. **Website extraction** — the 12-step sequence in §4; shell entry-URL repointing ships *first*.
5. **Extension → artifact** consumption once it has its own repo/publishing (Decision C).
6. **Decision A last** — extract `src/` to a frontend repo once the preload bridge is a documented, versioned contract.
7. **`git filter-repo` slim** of this repo after the moves; delete the dead list; retire legacy docs.

---

## Appendix — Full classification (322 entries)

Destinations: **KEEP** (macapp-shell) · **KEEP-for-now** (product-ui, pending Decision A) · **SHARED** (needs resolution per §6) · **EXTRACT** (website / backend / ios / extension) · **LEGACY** · **DEAD**.

### KEEP — Mac app shell (the core of this repo) — 31 entries

| Path | Why |
|---|---|
| `electron-builder.json` | The Mac/Windows packaging config — defines exactly what ships in the desktop binary (electron/**, lib/browserScreen.cjs, lib/webSearchIntent.cjs, extensions/save-to-lykn). |
| `electron/*-preload.cjs (agent-browser, agent-finished-popup, agent-sidebar, agent-stage, extension-install, lang-picker, live, menu, onboarding, overlay, panel, picker, snip, welcome)` | All 14 preloads verified referenced by main.cjs for their corresponding BrowserWindows. |
| `electron/*.html + electron/*.js + electron/hover-tips.css (agent-browser-welcome, agent-finished-popup, agent-sidebar, agent-stage, burst, extension-install, lang-picker, live, menu, onboarding, overlay, panel, picker, snip, welcome + their same-name renderer .js and hover-tips assets)` | Every HTML surface is loaded by main.cjs (welcome/agent-browser-welcome also by ownedBrowserAct.cjs); each .js is loaded by its own .html; hover-tips.css/js loaded by agent-stage/panel/overlay.html. |
| `electron/*.test.mjs + electron/browser-agent/*.test.* (agentWaiting, signInWall, chatAgentRoute, browserAgent, agentAutonomy, builders, needsUser, signInHandoff)` | node --test suites exercising only electron/ modules; wired into the test:agent script. |
| `electron/agentRuntime.cjs` | Agent orchestration core imported by main.cjs and chatAgentRoute.cjs; its four top-level ../lib requires are MISSING from electron-builder files list (packaging gap). |
| `electron/appDock.cjs + electron/agentRecentVisits.cjs + electron/markdownToStageHtml.cjs` | Dock/window helpers, agent visit history, and stage-report HTML rendering, all imported by shell code. |
| `electron/browser-agent/** (index.cjs, runtime/*.cjs, browser/*.cjs, agent/**/*.md prompt+memory corpus, AGENTS.md)` | Local browser-agent runtime (planner/executor/verifier/memory) plus its markdown instruction corpus; entered via index.cjs from agentRuntime.cjs; model calls proxy through the backend. |
| `electron/browserAct.cjs` | Drives the user's real browser via AppleScript/nut-js; nut-js require is try/catch-optional and ../lib/holo/ordinalIntent.js dynamic import is guarded. |
| `electron/chatAgentRoute.cjs` | Chat-vs-agent intent router used by main.cjs. |
| `electron/chromeSync.cjs` | Pulls Chrome cookies (Keychain decrypt) and open tabs into the agent browser — macOS-native, opt-in. |
| `electron/extensionBridge.cjs + electron/extensionInstaller.cjs` | Installs/bridges the bundled save-to-lykn extension from process.resourcesPath — the shell side of the extension coupling. |
| `electron/localSystem.cjs + electron/localAgentTask.cjs` | Local Mode (files/terminal/JXA ObjC bridge) task runner, inherently machine-local. |
| `electron/main.cjs` | 28k-line main process entry (package.json "main"); loads deployed SPA at APP_URL=https://lykn.io and API_BASE=https://api.lykn.io, owns all windows/tray/protocol/auto-update. |
| `electron/notarize.cjs` | electron-builder afterSign hook shelling to xcrun notarytool (deliberately not @electron/notarize). |
| `electron/ownedBrowserAct.cjs` | LYKN-owned agent browser window controller; hub for agent flows and sign-in wall. |
| `electron/preload.cjs` | Main-window preload, referenced by main.cjs. |
| `electron/resources/**` | App icons, tray icons, DMG background, entitlements — all referenced by electron-builder.json (buildResources, mac.icon, dmg, entitlements). |
| `electron/sounds/welcome-reveal.mp3` | Played by welcome.html. |
| `electron/vendor/elevenlabs-client.iife.js` | Vendored ElevenLabs realtime client loaded by overlay.html for voice — external service contract (api.elevenlabs.io / rtc.elevenlabs.io, signed via backend /api/ai/elevenlabs/signed-url). |
| `electron/welcome-anim.webm` | Welcome-window video asset shipped in the app, but it is a BUILD ARTIFACT rendered by the remotion toolchain (remotion:render:welcome renders remotion/index.ts composition LyknSayHello into this exact path) — regenera... |
| `lib/agentMultiStep.cjs` | Agent plan builder required only by the Electron agent runtime; NOT in electron-builder.json files list (packaging gap). |
| `lib/agentMultiStep.test.cjs` | Colocated test for lib/agentMultiStep.cjs (Electron-only module). |
| `lib/agentSkillRouting.test.cjs` | Tests electron/agentRuntime.cjs and electron/ownedBrowserAct.cjs (the agentSkillRouting logic lives in electron/); wired into the test:agent npm script. |
| `lib/agentToolVenues.cjs` | Tool-venue routing used only by Electron agent runtime and lib/agentMultiStep.cjs; NOT in electron-builder.json files list (packaging gap). |
| `lib/browserScreen.cjs` | Electron-only screen-diff/text-similarity helper; already in electron-builder.json files list; no server/src usage. |
| `lib/markdownToStageHtml.test.cjs` | Tests electron/markdownToStageHtml.cjs. |
| `lib/ownedBrowseGoal.test.cjs` | Tests electron/ownedBrowserAct.cjs. |
| `scripts/generate-tray-icon.mjs` | Generates macOS menu-bar template icons into electron/resources/ consumed by the Electron tray. |
| `scripts/generate-windows-icons.mjs` | Generates Windows app/tray icons into electron/resources/ for electron-builder. |
| `scripts/test-browser-act.mjs` | macOS smoke test for the Electron browser-control layer. |
| `scripts/wait-for-port.mjs` | TCP-port waiter used so Electron dev doesn't race the Vite dev server. |

### KEEP (for now) — product UI the shells render remotely — 63 entries

| Path | Why |
|---|---|
| `components.json` | shadcn/ui generator config pointing at src/components/ui and src/index.css. |
| `public/embed-detect.js` | First-paint ?embedded=1 detector loaded by index.html:47 that pairs with html.embedded-transparent in src/index.css:194 so embedding hosts (Notion, Loom) get transparent product share/embed pages — travels with the fr... |
| `src/components/AddLinkDialog.tsx` | Imported only by product pages. |
| `src/components/LinkPreview.tsx` | Imported only by product pages/components. |
| `src/components/LoadingScreen.tsx` | Suspense/loading fallback for the app shell and product pages; website pages do not use it. |
| `src/components/LyknLogoRevealLoader.tsx` | Only used inside LoadingScreen. |
| `src/components/ModelSelectOptions.jsx` | Model picker used by product chat and settings (its third importer, LyknChatBarToolbar, is dead). |
| `src/components/PlanGate.jsx` | Plan gating for the synthesis layer; product-only. |
| `src/components/SignInActionBlocker.jsx` | Imported only by the Vault product page. |
| `src/components/SignInPill.jsx` | Floating sign-in pill mounted by App shell on chrome-less non-marketing pages (explicitly hidden on marketing routes). |
| `src/components/SiteFavicon.tsx` | Favicon fetcher used by product chat surfaces. |
| `src/components/StudioHoverTips.jsx` | Imported only by the Studio product page. |
| `src/components/UpgradeModal.jsx` | Imported only by product pages. |
| `src/components/billing/**` | Billing dialog and free-credits nudge for signed-in users; mounted from App shell and product pages. |
| `src/components/brief/**` | Morning-brief overlay mounted at App-shell level; authenticated product feature. |
| `src/components/calendar/**` | Calendar product page routed from App.jsx; product-only reachability. |
| `src/components/connections/**` | Connector/OAuth/token dialogs and app dock; imported only by product pages (Vault/Settings/connections shell). |
| `src/components/files/**` | Drag-drop upload component used only by product surfaces. |
| `src/components/lyknChat/**` | Core chat product surface (LyknChatView, composer toolbars, voice modes, artifact panel, MobileLyknChat) imported by product pages LyknChat/Studio/SynthesisLayer; exceptions listed separately. |
| `src/components/macdesktop/**` | Mac desktop-mirror/home-screen UI (widgets, HomeChatBar, MacDesktopMirror) rendered inside the product Studio page; ships in the deployed SPA (not the Electron binary) but is only meaningful inside the Mac shell via t... |
| `src/components/macdock/**` | Studio glass-shell dock, imported only by the Studio product page. |
| `src/components/macfiles/**` | Local-files browser for the Mac shell experience, imported only by Studio. |
| `src/components/media/**` | Social-embed renderer imported only by the Vault product page. |
| `src/components/notes/**` | Notes/quick-note/rich-text editing plus the product SettingsModal; product-only reachability. Exception: RichTextRenderer.jsx below. |
| `src/components/projects/**` | Projects/steward/tasks boards imported by ProjectsPage/ProjectDetailPage and App shell. Exception: DailyDocketCard.tsx below. |
| `src/components/settings/**` | Appearance/wallpaper/widget-picker settings panels; product-only reachability. |
| `src/components/synthesis/**` | Synthesis-layer panels (beliefs, neurons, projects, vault attachments); product-only reachability. |
| `src/components/todos/**` | Todos page/panel routed from App.jsx; product-only reachability. |
| `src/components/ui/**` | shadcn/primitive kit imported only by product pages and the App shell; verified that NO website-classified page imports any ui component, so it is not shared with the website. |
| `src/components/vault/**` | Vault pickers, note chooser, LocalModeToggle; product-only reachability; LocalModeToggle bridges to the Mac shell's local mode. |
| `src/components/wake/wakeSynthesisAddMenu.ts` | Only living importer is the product Vault page (WAKE_WALKTHROUGH_GATE_TEXT for the welcome walkthrough); its other importers are the dead tour previews. |
| `src/context/IntakeContext.jsx` | Synthesis-intake provider mounted at App-shell level; authenticated product feature. |
| `src/hooks/**` | All ten hooks are product-feature hooks (chat engine, persistence, voice, brief, project files, viewport) with product/App-shell-only reachability; exception noted for useRealtimeVoice. |
| `src/hooks/useRealtimeVoice.ts` | Product realtime-voice engine, but ALSO transitively powers the marketing CapabilityPage live voice demo via WakeVoiceTourPreview — website extraction must replicate or drop that demo. |
| `src/lib/** (remaining root files: ErrorBoundary, RouteErrorBoundary, errorRecovery, installAuthFetch, query-client, theme, appearance, authContext, billingAccess, useUserPlan, useUsageGate, utils, agentWaitingRow(+test), ai-model, ai-prefs, brief, morningBrief, conversationMemory, copyRichClipboard, customModelsEnabled, embedScripts, extract-text, fileDropModePrompt, heifToJpeg, markdownToTiptap, modelCatalog, modelTiers, pasteFromClipboard, projectChartTheme, projectKnowledgeBase, projectMembers, projectWorkspace, safeExternalUrl(+test), sanitizeEmbedHtml, saveToVault, stewardQueue, studioTabs, synthesisLayerUi, userLinks, userProjects, vaultContent(+test), workspaceContext)` | App-shell infrastructure plus product-feature helpers, all with App/product-only reachability and no website-page importers; website extraction needs at most trivial replacements (error boundaries, theme). |
| `src/lib/admin/**` | Static catalogs for the in-SPA admin usage dashboard; imported only by pages/AdminUsage.jsx (admin-email-gated product route). Could move with a future internal-admin split but has no backend/website importers. |
| `src/lib/ai/**` | Chat/AI orchestration core (chatSendOrchestrator, promptBuilder, artifacts, local tool executor + colocated tests); product-only reachability except learnedTag.ts and userFacingErrors.ts which are also reached from ma... |
| `src/lib/chat/**` | Chat thread runtime/client/markdown utilities; product-only reachability. |
| `src/lib/connectors/**` | Connector catalog and presets for the product connections surface. |
| `src/lib/embeddedPreview.ts` | Studio iframe-embed / glass-skin query-param plumbing (?embedded=1&glass=1) for the product surfaces Studio mounts. |
| `src/lib/lyknChat/**` | Chat helpers (model key, artifact download, studio browser open); product-only reachability. |
| `src/lib/media/**` | Social-embed/YouTube helpers; product-only reachability. |
| `src/lib/modelBuilder/**` | Custom-model storage/selection/client; product-only reachability. |
| `src/lib/synthesis/**` | Synthesis clients (beliefs, intake, docket briefing, projectLiveSync + colocated test); product/App-shell reachability; projectLiveSync is also transitively reached from the marketing voice demo — noted. |
| `src/lib/vault/**` | Vault upload pipeline, media compression, attachment helpers (+ colocated test); product-only reachability. |
| `src/lib/voice/**` | Mic access, tune instructions, voice config for product voice modes; micAccess/tuneInstructions are transitively reached by the CapabilityPage marketing voice demo via useRealtimeVoice — noted. |
| `src/lib/wake/{wakeVaultDemoCards.js,wakeVaultPreviewComments.js,wakeVaultPreviewQuickNotes.js}` | Welcome-walkthrough demo content rendered inside the product Vault page for new users. |
| `src/lib/{demoLyknChats.js,demoSynthesis.js,demoVault.js}` | Demo/welcome content consumed by live product pages (SynthesisLayer, chat engine, Vault demo cards) — part of the shipped onboarding experience, not web-gate-only legacy. |
| `src/lib/{macApps.js,macSync.js,macDesktopSync.js,desktopWidgets.js,localMode.ts,homeChatFiles.js}` | Renderer-side Electron-bridge callers (window.lykn/electronAPI detected in macApps/macSync/macDesktopSync) for local mode, desktop widgets, and Mac sync; ship in the deployed SPA that the Mac shell loads — the SPA hal... |
| `src/lyknChat/**` | Chat block-system model (definitions, notion-style model, migration, snapping) imported only by product chat code. |
| `src/pages/Billing.jsx` | In-app billing page (/billing, ProtectedRoute), reached from product upgrade surfaces. |
| `src/pages/LyknChat.tsx` | Chat surface (256KB); rendered in-document by Studio and via /app and /chat/:chatId embedded routes — the LegacyProductToStudio wrapper redirects only non-embedded top-level visits, it is not dead. |
| `src/pages/Onboarding.jsx` | Product funnel: protected /onboarding/connect 'connect your AI tools' post-signup step (Cursor/Claude/Codex MCP deeplinks), entered from Login and StartTrial — not a website page. |
| `src/pages/ProjectDetailPage.jsx` | Project detail surface; Studio in-document + /projects/:projectId embedded route. |
| `src/pages/ProjectsPage.jsx` | Projects list surface; Studio in-document + /projects embedded route. |
| `src/pages/Settings.tsx` | Thin wrapper mounting SettingsModal; rendered by Studio in-document and /settings embeds. |
| `src/pages/StartTrial.jsx` | Product funnel, not website: post-signup paywall (/start-trial) behind DesktopProductOnly (browsers bounce to /download), embedded Stripe checkout against api.lykn.io, subscription gate redirects here. |
| `src/pages/Studio.jsx` | Primary post-login product shell (/studio); the desktop main window boots straight into it and it mounts chat/vault/projects/settings in-document. |
| `src/pages/SynthesisLayer.tsx` | Product graph page but soft-unplugged: SYNTHESIS_LAYER_UI_ENABLED=false in src/lib/synthesisLayerUi.ts redirects /synthesis-layer to /studio — keep with product but flag dormant/freeze candidate. |
| `src/pages/Vault.jsx` | Vault surface (421KB), mounted through VaultConnectionsShell in Studio and /vault embeds. |
| `src/pages/VaultConnectionsShell.jsx` | Shell mounting Vault + VaultAppDock for /vault route and Studio's in-document surface. |
| `src/pages/synthesis/**` | 3D/2D graph engine used only by the unplugged SynthesisLayer page and by WakeSynthesisTourPreview whose sole importer (WakeSynthesisSubwindow.tsx) is itself unimported — effectively dormant product code, freeze candid... |
| `src/store/**` | Zustand stores (aiStore, lyknChatStore, vaultUploadStore) imported only by product chat/vault code. |

### SHARED — needed by 2+ destinations, needs a resolution — 62 entries

| Path | Why |
|---|---|
| `.env.example` | Shared backend + product-ui/website + macapp-shell, by section: lines ~33-557 are server secrets (Supabase service role, Stripe, cron secrets, AI providers, ElevenLabs, connector OAuth creds); lines 558-630 are browse... |
| `.github/workflows/security.yml` | Shared backend + all repos: anon-permission-probe job is Supabase/backend-specific, while the gitleaks and npm-audit jobs are repo-wide gates pinned to this repo's manifest — must be forked into each extracted repo. |
| `.gitleaks.toml` | Shared across every destination: pre-commit + CI secret-scanning config whose allowlist covers .env.example placeholders; each extracted repo needs its own copy. |
| `.npmrc` | legacy-peer-deps=true for the single shared manifest; must travel with each split-off package.json until dependency trees are cleaned per-repo. |
| `DEPLOYMENT.md` | Shared backend + website/product-ui: documents env-var setup for both the Vercel frontend and the Render backend. |
| `eslint.config.js` | Shared product-ui + website: lint config scoped to src/components/**, src/pages/**, src/Layout.jsx (the SPA that contains both). |
| `extensions/save-to-lykn/**` | Shared between macapp-shell and extension: the Mac app bundles it via electron-builder.json extraResources, and electron/extensionInstaller.cjs copies it into the user's Chrome/Edge/Brave profile and writes a per-mach... |
| `index.html` | Single Vite entry for BOTH the marketing site and the product UI (website: SEO/OG meta, GA gtag G-Q4KSD1G8YF, manifest; product: boots the SPA the Electron/iOS shells load remotely). |
| `jsconfig.json` | Shared product-ui + website: the config npm run typecheck actually uses (tsc -p ./jsconfig.json) over src/**. |
| `lib/artifactBuildIntent.cjs` | Shared between macapp-shell and backend: required top-level by electron/main.cjs and agentRuntime AND by server.js, but MISSING from electron-builder.json files list — likely packaging bug. |
| `lib/artifactBuildIntent.test.cjs` | Tests the shared artifactBuildIntent.cjs; follows that module wherever it lands. |
| `lib/exclusiveComposerMode.test.cjs` | Second test file for shared artifactBuildIntent.cjs (composer-mode exports); follows that module. |
| `lib/holo/ordinalIntent.js` | Shared between backend and macapp-shell: server.js imports it statically; electron/browserAct.cjs dynamic-imports it inside try/catch (optional, silently degrades in packaged app since it is not packaged). |
| `lib/imageGenIntent.cjs` | Shared between macapp-shell and backend intent detection; MISSING from electron-builder.json files list. |
| `lib/imageGenIntent.test.cjs` | Tests the shared imageGenIntent.cjs. |
| `lib/webSearchIntent.cjs` | Shared between macapp-shell and backend: intent detector required by both electron/main.cjs and server.js (main.cjs comment says 'Shared with server.js'); packaged in the Mac binary. |
| `lib/webSearchIntent.test.cjs` | Tests the shared webSearchIntent.cjs. |
| `package-lock.json` | Lockfile of the union manifest; must be regenerated per repo after the split. |
| `package.json` | THE split's biggest mechanical problem: one manifest and one scripts block serve all five surfaces — Electron shell (electron, electron-builder, electron-updater, nut-js, version 1.0.23 doubles as the auto-update app ... |
| `postcss.config.js` | Shared product-ui + website: tailwind/autoprefixer pipeline for the same single SPA build. |
| `public/.well-known/apple-app-site-association` | Shared ios + website: declares universal links (/i/*, /billing/success, /billing/cancel) and webcredentials for app ID B45S92XC36.io.lykn.app, and MUST be served from the lykn.io web root — it belongs with whatever re... |
| `public/email/lykn-wordmark.png` | Shared backend + website: lib/auth/emailBranding.js attaches it from disk at path.join(process.cwd(),'public','email','lykn-wordmark.png') — so the Render-deployed backend needs this file in ITS repo at the same relat... |
| `public/gtag-init.js` | Shared website + product-ui: Google Analytics consent-mode bootstrap (G-Q4KSD1G8YF) loaded from the shared index.html:43 as a same-origin file for CSP reasons, and React Router emits page_view on product routes too — ... |
| `public/manifest.json` | Shared website + product-ui: PWA manifest for the deployment, and its share_target posts to /share which is handled by the product's ShareReceiver route — so it is not pure marketing plumbing. |
| `public/{favicon.ico,favicon-32.png,favicon-192.png,favicon-512.png,favicon.svg}` | Shared website + product-ui: referenced by the single index.html (lines 5-12) and manifest.json icons of the one Vercel deployment that serves both the browser marketing pages and the full product UI loaded inside the... |
| `remotion.config.ts` | Remotion CLI config (jpeg frames, ANGLE for @remotion/three, publicDir=remotion/public) used by all renders including the macapp asset renders; file header itself notes it is completely separate from the Vite build an... |
| `remotion/LyknDmgBackground.tsx` | Shared macapp-shell + website: this composition is the documented source of electron/resources/dmgBackground.tiff (its header contains the exact render + tiffutil commands), which electron-builder.json:81 uses as the ... |
| `remotion/LyknSayHello.tsx` | Shared macapp-shell + website: renders electron/welcome-anim.webm via package.json script remotion:render:welcome, and that webm is played by electron/welcome.html:1790 in the Mac welcome window; the committed 310KB w... |
| `remotion/Root.tsx` | Composition registry required by every render, including the two macapp-asset compositions (LyknSayHello at line 300, LyknDmgBackground at line 449); splits cleanly only if the app-asset comps get their own minimal ro... |
| `remotion/brand.ts` | Brand icon/wordmark path constants imported by 27 compositions including both app-asset ones (LyknSayHello.tsx, LyknDmgBackground.tsx), so any repo that re-renders the Mac welcome anim or DMG background needs it along... |
| `remotion/index.ts` | registerRoot entrypoint passed to every remotion CLI invocation, including the macapp welcome-anim render script — same split logic as Root.tsx. |
| `remotion/public/bg-deep-blue.png` | staticFile background used by LyknSayHello (the electron welcome-anim render) as well as 6 marketing compositions, so the macapp asset pipeline needs it wherever LyknSayHello re-renders happen. |
| `scripts/reset-test-account.mjs` | Shared macapp-shell + backend: wired as npm welcome:reset for the Electron welcome-walkthrough dev loop, but is a service-role Supabase account-deletion admin op that a Mac-only repo should not need credentials for. |
| `scripts/test-alias-loader.mjs` | Shared product-ui + macapp-shell: node --import loader registered by both test:vault (src/lib vault tests) and test:agent (electron tests plus src/lib agent tests) to resolve the @/ alias. |
| `scripts/test-resolve-alias.mjs` | Shared product-ui + macapp-shell: the actual @/ → src/ ESM resolve hook used by the node test runner for src/** tests. |
| `server.js (cross-boundary imports of src/lib)` | Not a file in my area but a hard edge the split must handle: the backend imports src/lib/modelTiers.js, src/lib/pricing-config.js, and src/lib/ai/conversationFormat.js, making those three src modules shared between ba... |
| `src/App.jsx` | One router mounts marketing, legal, auth-bridge, admin, and product routes — this file IS the seam the website/product split has to cut; also holds the desktop-only gates (DesktopProductOnly, ProtectedRoute, isDesktop... |
| `src/assets/FINAL/**` | Brand kit: ~10 specific PNGs/SVGs are imported by both website pages and product components; the other ~95 files (all EPS, master/small variants) are unreferenced design collateral that belongs in a brand/website repo... |
| `src/assets/imagine-{clouds,cube,figure,headphones,hovercraft,meadow,pastel,porsche-gt3,sneaker}.png` | Imagine-mode sample images used by both the marketing landing page and the product StudioImagineMode. |
| `src/components/CookieConsentBanner.jsx` | Shared by website and product-ui: App shell renders it on every non-embedded route, including all marketing pages, and the extracted website will need cookie consent. |
| `src/components/lyknChat/VoiceTechOrb.tsx` | Shared by product-ui and website: powers product voice modes AND is imported directly by the marketing landing page for the live voice demo. |
| `src/index.css` | Single 9.5k-line global stylesheet imported by main.jsx covering marketing glass pages, product UI, and the lykn-glass-embed shell skin — must be split when the website is extracted. |
| `src/lib/PageNotFound.jsx` | 404 page used by the App router for all routes and directly by the marketing News page. |
| `src/lib/SupabaseAuth.jsx` | Auth provider wrapping all routes; the website keeps Login/DesktopAuth (browser half of the Mac Google sign-in handoff), so both destinations need it. |
| `src/lib/analytics.js` | Pageview/consent analytics used by the App shell across all routes and directly by marketing CookiePolicy + CookieConsentBanner; the extracted website needs it too. |
| `src/lib/api-config.js` | API_BASE_URL (https://api.lykn.io) consumed by product, App shell, and website-reachable flows alike; needed by both extracted repos. |
| `src/lib/desktopHotkey.ts` | Pure hotkey-label helper (⌘L vs Ctrl+L) needed by both marketing pages and product widgets. |
| `src/lib/landingHandoff.ts` | localStorage keys + post-signup onboarding flags bridging website login/trial flows into the product; imported by both website-reachable auth pages and product onboarding. |
| `src/lib/pricing-config.js` | Plan/pricing constants used by the marketing Pricing page and by product billing/gating code — must stay in sync across both repos. |
| `src/lib/supabase.ts` | Supabase client used by the product everywhere AND by auth flows that stay website-reachable (Login/DesktopAuth/ResetPassword per App.jsx routing comments). |
| `src/lib/webAppAccess.ts` | The web-gate itself: needed by website (bounces browsers to /download, WEB_PUBLIC_PATHS), product-ui (route gating), and macapp-shell (isDesktopShell reads window.lykn.desktop set by electron/preload.cjs). |
| `src/main.jsx` | SPA bootstrap for the one deployment serving website + product; applies product theme/appearance before first paint. |
| `src/pages/BillingCancel.jsx` | Shared website + ios + backend: Stripe cancel_url mirror of BillingSuccess, same deep-link/AASA contract. |
| `src/pages/BillingSuccess.jsx` | Shared website + ios + backend: Stripe success_url for iOS-initiated checkouts (server.js /api/billing/checkout source:'ios'), deep-links back via lykn://lykn.io/billing/success and is AASA-whitelisted; must stay outs... |
| `src/pages/DesktopAuth.jsx` | Shared macapp-shell + website: browser-side half of the Mac Google sign-in — runs OAuth in the real browser then hands tokens back via loopback POST / lykn://auth; must stay deployed at lykn.io/desktop-auth or Mac Goo... |
| `src/pages/Login.jsx` | Shared macapp-shell + website: it is the desktop shell's in-app sign-in page (signed-out desktop '/' redirects to /login) AND a public website path for share-target/email-confirm flows; resolvePostAuthPath sends web u... |
| `src/pages/OAuthConsent.jsx` | Shared website + backend: functional consent UI for Connect-LYKN OAuth/MCP clients, reached via 302 from the API's /oauth/authorize and POSTing to /oauth/authorize/decide — must stay wherever lykn.io/oauth/consent is ... |
| `src/pages/ShareReceiver.jsx` | Shared website + extension (+ PWA): /share is the open target of extensions/save-to-lykn/background.js and public/manifest.json share_target; saves links to Vault after explicit confirm. |
| `tailwind.config.js` | Shared product-ui + website: styles the whole src/ SPA (content globs index.html + src/**); website extraction needs a copy. |
| `tsconfig.json` | Shared product-ui + website: typechecks src/** and remotion/** (Remotion comps render marketing videos), with the @/ alias. |
| `vercel.json` | Shared website + product-ui (+ iOS): deploys the single dist/ SPA to lykn.io, which serves marketing to browsers, the full product UI to the Electron/iOS shells, and the apple-app-site-association header for iOS deep ... |
| `vite.config.js` | Shared product-ui + website: builds the single src/ SPA (product UI plus public marketing pages) deployed to Vercel; also carries the Electron-friendly dev-server binding and the /api dev proxy. |

### EXTRACT → website repo — 36 entries

| Path | Why |
|---|---|
| `public/google18932b4b00f751aa.html` | Google Search Console domain-verification file — must keep being served from lykn.io; pure website hosting concern. |
| `public/og-image.png` | Social share image referenced only by og:image/twitter:image meta tags pointing at https://lykn.io/og-image.png. |
| `public/robots.txt` | Search-engine plumbing for lykn.io (disallows product routes, points at sitemap) — meaningful only for the public website hosting. |
| `public/sitemap.xml` | SEO sitemap for the public marketing pages, referenced by robots.txt. |
| `public/videos/lykn-demo.mp4` | 5.8MB hero demo video referenced only by the marketing landing header (not rendered by any remotion script — appears to be a screen recording export). |
| `public/videos/lykn-glass-overlay.mp4` | 4.8MB remotion render (LyknGlassOverlay via remotion:render:glass-overlay) referenced only by the landing capability demos component. |
| `public/videos/lykn-snip-article.mp4` | 3.5MB render of the LyknSnipArticle composition referenced only by the GlassLanding marketing page. |
| `public/videos/lykn-studio-browser.mp4` | 10MB remotion render (LyknStudioBrowser via remotion:render:studio-browser) referenced only by the landing capability demos component. |
| `public/videos/lykn-studio-demo.mp4` | 19MB remotion render (LyknStudioDemo via remotion:render:studio-demo) referenced only by the landing capability demos component — the single largest file in public/ and a repo-bloat concern for a Mac app repo. |
| `public/wake-demo/voice/** (12 mp3s)` | Scripted voice-tour audio consumed by WakeVoiceTourPreview, which mounts only on the public marketing capability pages (/product/:capId), not in the in-product welcome flow; WakeVoiceSubwindow also imports the preview... |
| `remotion/**` | Marketing/social video toolchain: ~50 compositions plus helpers (OverlayUI.tsx, SceneBackground.tsx) render to out/*.mp4 scratch or public/videos/*.mp4 consumed only by landing/marketing pages; nothing in src/ imports... |
| `remotion/public/** (all except bg-deep-blue.png)` | 2.6MB of backgrounds (ad-promax, aurora-blob, bg-blue, bg-clouds, build-dashboard, canva-bg, glass-hero, scene-bg, wallpaper-room) and 9 AI-brand SVGs in icons/ referenced only via staticFile() from marketing composit... |
| `scripts/generate-wake-voice-audio.mjs` | Generates static ElevenLabs demo MP3s into public/wake-demo/voice/ for the wake marketing tour preview shipped in the Vercel deploy. |
| `src/assets/{hero-clouds.jpg,hero-dunes.jpg,hero-lake.jpg,hero-mountains.png,hero-ocean.jpg,glass-ad-demo.png,ai-drive-vault.png,news-tile-glass.jpg,news-tile-projects.jpg,news-tile-studio.jpg,news-tile-voice.jpg}` | Marketing imagery referenced only by GlassLanding, News (via newsPosts.ts), and CapResearchBrowserDemos. |
| `src/components/landing/**` | Marketing-only components (LandingHeader, GlassBackdrop, CapResearchBrowserDemos) imported exclusively by website pages. |
| `src/components/wake/WakePreviewFit.tsx` | Preview-scaling wrapper whose only living importer is CapabilityPage; the three Subwindow importers are dead. |
| `src/components/wake/WakeVoiceTourPreview.tsx` | Live voice-demo embed whose only living importer is the marketing CapabilityPage (its other importer WakeVoiceSubwindow is dead); note it pulls real product voice code. |
| `src/lib/newsPosts.ts` | News/changelog post data imported only by marketing pages; references news-tile assets. |
| `src/lib/wake/wakeChatPreviewStream.ts` | Fake-streamed chat demo for the marketing landing hero; only living importer is GlassLanding (other importer WakeChatTourPreview is dead); depends on product lib/ai/learnedTag. |
| `src/pages/AppsChatGPT.tsx` | Public /apps/chatgpt landing: OpenAI Apps catalog submission-review gate + conversion page; must stay live for the ChatGPT app listing. |
| `src/pages/AppsClaude.tsx` | Public /apps/claude landing, same submission/conversion pattern as AppsChatGPT for the Claude connector. |
| `src/pages/CapabilityPage.css` | Styles imported only by CapabilityPage.tsx. |
| `src/pages/CapabilityPage.tsx` | Public /product/:capId marketing pages (Chat/Build/Imagine/Voice/Research/Browser/Drive/Glass) built from GlassLanding demos and wake tour previews. |
| `src/pages/CookiePolicy.jsx` | Public legal page at /cookies, paired with CookieConsentBanner. |
| `src/pages/DPA.jsx` | Public legal page at /dpa. |
| `src/pages/DownloadLykn.css` | Styles for the download page. |
| `src/pages/DownloadLykn.tsx` | Public /download page — but it is the universal redirect target of the web gate (webAppAccess, DesktopProductOnly, ProtectedRoute, AdminOnly all bounce here), so the website repo must keep serving it or the gate 404s. |
| `src/pages/GlassLanding.css` | Styles for the Glass marketing system, imported by three website surfaces. |
| `src/pages/GlassLanding.tsx` | Marketing landing for '/', '/landing', '/glass' (GuestOnly); the desktop shell never renders it — signed-out desktop users are redirected to /login; note it also exports CapBuildDemo/CapChatDemo/CapImagineDemo/SiteFoo... |
| `src/pages/News.tsx` | Public news/blog pages (/news, /news/:slug) wearing the Glass landing chrome. |
| `src/pages/Pricing.jsx` | Public pricing page; in-product upgrade flows go to /start-trial and /billing, not here (FreeCreditsNudge lists /pricing only as a suppression path). |
| `src/pages/Privacy.jsx` | Public legal page; also a compliance dependency for App Store and OpenAI/Anthropic app reviews — keep the URL stable. |
| `src/pages/Support.jsx` | Public /support help+contact page; it is the App Store listing's Support URL (App Review 1.5/2.1), so the iOS release depends on the website keeping it live. |
| `src/pages/Templates.css` | Styles imported only by Templates.tsx. |
| `src/pages/Templates.tsx` | Public marketing templates gallery with LandingHeader; linked only from LandingHeader nav and GlassLanding footer (the electron/agentRuntime.cjs 'templates' regex matches agent browser URLs, not this page). |
| `src/pages/Terms.jsx` | Public legal page (links /pricing); compliance dependency like Privacy. |

### EXTRACT → backend repo — 98 entries

| Path | Why |
|---|---|
| `INCIDENT_RUNBOOK.md` | Security incident response runbook for the server (security-logger.js, /api/admin/security/audit, /api/health, Render). |
| `IOS_RELEASE_COMPLIANCE_PLAN.md` | Despite the name, it specifies BACKEND work required for iOS unlisted release; iOS-side fixes already live in the separate LYKN-Mobile/LYKN-iOS repo. |
| `MASTER_SECURITY_REPORT.md` | Consolidated record of the six-agent security plan over server.js/Supabase/Render/Vercel. |
| `ORPHAN_RECONCILIATION_PLAN.md` | Design doc for the user-files orphaned-storage reconciliation (prepared, not executed). |
| `PRODUCTION_RUNBOOK.md` | Connector-provider production setup (OAuth creds, env vars) for the Render backend. |
| `ROTATION_RUNBOOK.md` | Secret-rotation runbook for server-side secrets (Supabase, Stripe, connector keys). |
| `SECURITY_REPORT_01.md` | Perimeter hardening report for the Render/Vercel/Supabase backend surface. |
| `SECURITY_REPORT_02.md` | Auth/session security report for server.js + Supabase Auth + OAuth provider. |
| `SECURITY_REPORT_03.md` | Database/RLS security report; ships supabase-migrations/065. |
| `SECURITY_REPORT_04.md` | API/application hardening report for server.js and oauth-server.js (rate limits, validation.js, prompt-sanitizer.js). |
| `SECURITY_REPORT_05.md` | Secrets/supply-chain report; also the canonical home of the CI accepted-risk list. |
| `SECURITY_REPORT_06.md` | Observability/IR report (security-logger.js, /api/health, audit table, CI gates). |
| `STORAGE_SETUP.md` | Supabase Storage bucket setup guide; backend/DB ops topic, likely stale. |
| `SUBMIT_TO_CHATGPT_APPS.md` | Submission manifest for the LYKN MCP connector to the ChatGPT Apps catalog; the MCP/OAuth surface it describes lives in the backend. |
| `SUBMIT_TO_CLAUDE_DIRECTORY.md` | Submission manifest for the Anthropic Connectors Directory; same backend MCP surface. |
| `beliefSystem.js` | Beliefs/rules engine used by server.js, MCP tools, and training pipeline; no client-side importer. |
| `chat-agent-loop.js` | Server-side agent loop imported only by server.js; src/lib/ai/toolSyntaxStrip.ts mirrors its stripper by convention only (comment, no import). |
| `conceptEmbedding.js` | Concept embedding helpers used by the API server, the concepts cron job, and a backfill script. |
| `connectors-service.js` | Connector sync core consumed by server.js and every connectors/*.js integration module. |
| `connectors/**` | All 35 files are server-side sync adapters (32 provider adapters incl. google/* and apple/calendar.js, plus 3 internal helpers _save.js, _calendarEvent.js, google/_shared.js), every adapter registered in the connector... |
| `custom-models-routes.js` | Express route registrar for custom models, mounted by server.js. |
| `custom-models-service.js` | Custom-models data service consumed by routes and modelBuilder/nightShift libs; src reaches it only via HTTP (/api/v1/custom-models), not import. |
| `docs/artifacts-domain.md` | DNS/origin setup for artifacts.lykn.io serving /f/<token> from the API host. |
| `docs/discover-ops.md` | Ops notes for the server-side Discover crawl/ingest schedule and its schema migration. |
| `docs/google-signin-branding.md` | Supabase Auth custom-domain + Google consent-screen ops checklist; infra work with no app code change. |
| `docs/security/2026-05-anon-rpc-leak-forensics.sql` | Forensics SQL for the same Supabase incident. |
| `docs/security/2026-05-anon-rpc-leak.md` | Incident note for the anon-RPC info-disclosure vulnerability in Supabase migrations. |
| `factEmbedding.js` | Fact embedding helpers reached transitively from server.js (via userModelLearning.js) and from the Render synthesis cron. |
| `jobs/**` | Render cron entrypoints (runSynthesis, runConcepts, runVaultReconciler, runNightBrief) declared in render.yaml plus their job modules; probeOauthFlow.js is a manual backend OAuth-probe dev script referenced by the MCP... |
| `lib/appleAuth.js` | Apple sign-in token verification imported only by server.js (server-side even though it supports iOS/Mac login). |
| `lib/auth/**` | Signup/password-reset email flows imported by server.js; emailBranding.js only imported by the other two auth files. |
| `lib/billing/creditWallet.js` | Credit wallet service used by server.js and modelBuilder wallet. |
| `lib/cursor/cursorBuilds.js` | Cursor build launcher used by server.js and MCP tools. |
| `lib/customConnections/customConnections.js` | Custom-connection/app-calling service used by server.js and MCP tools. |
| `lib/customModelsEnabled.js` | Backend copy of the CUSTOM_MODELS_ENABLED=false kill-switch used by server.js and mcp-tools; a separate twin src/lib/customModelsEnabled.ts serves the product UI — must stay in sync across repos. |
| `lib/exterior/**` | Server-side tool/capability suite (web search/fetch, deep research, image gen, code run, file ops, design guides as fs-loaded .md) consumed only by server.js and mcp-tools/exterior; includes its own tests; no electron... |
| `lib/hdbscan.js` | Clustering used only by nightly cron jobs. |
| `lib/holo/**` | Server-side Holo browser-agent runtime (browserAgent, screenReader, browserReport) imported only by server.js — EXCEPT lib/holo/ordinalIntent.js which is shared (listed separately). |
| `lib/lora/**` | Together.ai LoRA training/inference services used by server.js and modelBuilder; constants.js and loraJobService.js internal to the cluster. |
| `lib/modelBuilder/**` | Custom-model builder runtime used by server.js and MCP tools; non-server-imported files (modelBehavior, customModelPrompt, syncSystemPromptBasics, modelBuilderWallet, modelCapabilitiesCatalog, subModel*) are internal ... |
| `lib/nightShift/**` | Night Shift steward/brief pipeline consumed by cron jobs, server.js, and MCP tools. |
| `lib/projectResolver.js` | Project resolution for MCP tools and projectWriteTarget. |
| `lib/projectWriteTarget.js` | Project write-authorization helper used by server.js and ~10 MCP tools. |
| `lib/rag/**` | Vault hybrid retrieval stack used by server.js and MCP tools; rrf.js/rerank.js internal to vaultHybrid.js; rag.test.mjs wired to npm test:rag. |
| `lib/synthesis/relatedNeighborhood.js` | Imported only by server.js. |
| `lib/synthesisPrompt.js` | Synthesis-cron prompt builder. |
| `lib/training/**` | LoRA training-data pipeline (chunking, pair cleaning, JSONL) used by server.js, modelBuilder, and lora modules; includes own tests. |
| `lib/umap.js` | Projection math used only by nightly cron jobs. |
| `lib/vault/attachmentType.js` | Attachment column builder for server.js and vault MCP tools. |
| `lib/vault/attachmentsMarker.js` | ESM attachment-marker logic used by server.js, userModelLearning.js, training, and a backfill script; electron/main.cjs re-implements it by hand (comment at main.cjs:6262) because main cannot import ESM — hidden cross... |
| `lib/vaultAttachment.js` | Vault attachment resolver for server.js and MCP tools; pulls lib/exterior/constants.js. |
| `mcp-server.js` | Remote MCP endpoint handlers mounted into server.js for external MCP clients. |
| `mcp-service.js` | Shared MCP session/token service used only by backend modules. |
| `mcp-tools/**` | All 64 files are server-side tool registry/handlers: the external MCP surface (index.js -> mcp-server.js + server.js REST mirror) and the in-app chat tool surface (chatTools.js -> server.js + chat-agent-loop.js); no e... |
| `mcp-tools/exterior/**` | Server-executed exterior/capability tools (web search, fetch, charts, python, Model Builder capabilities) that run inside the agent loop, not the MCP pull surface; depend on backend-only lib/exterior/** and usageTrack... |
| `mcp-tools/localTools.js` | Schema-only Local Mode tool definitions the server offers to the model but never executes — execution happens in electron/localSystem.cjs, which hand-duplicates the LOCAL_TOOL_NAMES list (electron/localSystem.cjs:96) ... |
| `mcp-tools/recommendTools.js` | Registered MCP tool (mcp-tools/index.js:66) but it imports OUTBOUND_TARGETS from the frontend tree — a backend->src/ dependency that breaks the moment backend and product-ui are split into separate repos; outboundTarg... |
| `oauth-server.js` | OAuth server mounted into the Express app, not a separate process. |
| `prompt-sanitizer.js` | Prompt-injection sanitizer used only by the API server. |
| `render.yaml` | Render blueprint for the web service (server.js) and four nightly crons (runSynthesis, runConcepts, runVaultReconciler, runNightBrief). |
| `rss-service.js` | RSS ingestion service used exclusively by the API server. |
| `scripts/anon-permission-probe.mjs` | CI regression gate that probes production Supabase anon-role permissions (migration-068 leak); pure backend/DB security tooling. |
| `scripts/backfill-attachment-columns.mjs` | One-shot service-role Supabase backfill for migration 104 attachment columns. |
| `scripts/backfill-concepts.mjs` | One-shot service-role promotion of themes/tags into lykn_concepts rows, companion to the nightly concepts cron. |
| `scripts/backfill-stripe-customer-emails.mjs` | Stripe+Supabase service-role admin backfill of customer email/name. |
| `scripts/backfill-stripe-period-end.mjs` | Repairs user_billing rows broken by the stripe@22 webhook change; service-role admin op. |
| `scripts/backfill-youtube-titles.mjs` | One-shot service-role vault-row repair for YouTube drops saved with placeholder titles. |
| `scripts/create-elevenlabs-agent.mjs` | Provisions the LYKN Voice agent on ElevenLabs pointing at the server's custom-LLM endpoint (PUBLIC_SERVER_URL). |
| `scripts/diagnose-discover-images.mjs` | Read-only service-role diagnostic over the Discover article index in Supabase. |
| `scripts/diagnose-provenance.console.js` | Paste-into-DevTools diagnostic of belief-provenance data shape for the /synthesis-layer feature; a DB-data debugging aid, not shipped code. |
| `scripts/diagnose-provenance.sql` | Supabase SQL-editor twin of the provenance diagnostic; read-only DB debugging aid. |
| `scripts/fix-discover-thumbnails.mjs` | Idempotent service-role rewrite of Discover thumbnail URLs (og:image scrape). |
| `scripts/lib/elevenlabsVoiceTools.mjs` | Single source of truth for the ElevenLabs agent's client-tool defs, kept in lockstep with server.js. |
| `scripts/probe-together-lora-serverless.mjs` | Probes Together serverless Multi-LoRA using the server-side LoRA module. |
| `scripts/purge-discover-junk.mjs` | Service-role retroactive cleanup mirroring ARTICLE_DOMAIN_BLOCKLIST in server.js. |
| `scripts/reconcile-orphaned-storage.mjs` | Server-side reconciliation of orphaned user-files storage objects; replaces the deleted iOS client sweep. |
| `scripts/rotate-connector-key.mjs` | CONNECTOR_TOKEN_KEY re-encrypt-in-place rotation tool sharing AES exports with the running server. |
| `scripts/set-elevenlabs-pronunciation.mjs` | Ops script attaching a pronunciation dictionary to the production ElevenLabs voice agent. |
| `scripts/set-elevenlabs-voice-settings.mjs` | Ops script tuning the production ElevenLabs voice agent's delivery settings. |
| `scripts/set-user-plan.mjs` | Service-role admin override of a user's billing plan; plan list mirrors server.js billing. |
| `scripts/stripe-reconcile.mjs` | Reconciles Stripe against the user_billing mirror to detect dropped webhooks. |
| `scripts/test-react-artifact.mjs` | Sanity test for the server-side lykn_build_react_artifact capability's runner HTML. |
| `scripts/test-render-video.mjs` | Sanity test for the server-side lykn_render_video Remotion pipeline. |
| `scripts/update-elevenlabs-agent.mjs` | Updates the production ElevenLabs voice agent (voice, overrides, client tools). |
| `security-logger.js` | Server-side security event logger used only by server.js and its test. |
| `security-logger.test.js` | node --test suite for security-logger.js; moves with its module. |
| `server.js` | 28k-line Express API deployed to Render (startCommand `npm run server`); imports nearly every other root service; not packaged in the Mac binary. |
| `src/pages/AdminBilling.jsx` | Same as AdminUsage: admin-only client over /api/admin/billing/overview (user_billing + stripe_events), reachable in prod only via the desktop shell — backend ops tooling. |
| `src/pages/AdminUsage.jsx` | Founder/ops dashboard (allowlist admin@lykn.io) over /api/admin/usage/*; AdminOnly sits behind canUseWebApp so in prod it renders only inside the desktop shell or dev builds — it is backend ops tooling, not Mac produc... |
| `supabase-migrations/**` | 129 SQL migrations plus 116_DISPOSITION.md for the Supabase database behind server.js; referenced by backend code/runbooks (oauth-server.js, mcp-service.js, usageTracking.js, PRODUCTION_RUNBOOK.md). |
| `supabase-queries/**` | Ops/verification SQL (usage dashboard, orphan reconciliation, migration rollback/verify) tied to backend runbooks and security docs. |
| `synthesis-service.js` | Text-chunking/synthesis helpers used by the API server, connectors, MCP tools, and RAG lib. |
| `usageTracking.js` | Credit/usage accounting used across backend; src/lib/pricing-config.js only references it in a keep-in-sync comment, no import. |
| `userModelLearning.js` | Facts/user-model learning service used by server.js, MCP tools, and training pipeline. |
| `validateSecrets.js` | Boot-time env/secret validation for the API server only. |
| `validation.js` | zod request-validation wrapper used only by the API server. |
| `youtubeQa.js` | YouTube Q&A pipeline consumed only by the API server and its own test. |
| `youtubeQa.test.js` | node --test suite for youtubeQa.js (root `npm test` picks it up); moves with its module. |

### EXTRACT → iOS repo — 3 entries

| Path | Why |
|---|---|
| `capacitor.config.ts` | Consumed only by @capacitor/cli for the ios/ project; sets server.url=https://lykn.io (webDir dist is offline fallback only), so it carries no build coupling to src/ and moves with ios/. |
| `ios/**` | Standard Capacitor iOS scaffold (App.xcodeproj, AppDelegate.swift, Info.plist, storyboards, assets, CapApp-SPM pinning capacitor-swift-pm 8.4.0) that loads the deployed https://lykn.io frontend; nothing else in the re... |
| `package.json (scripts "ios:sync", "ios:open" at lines 57-58; deps "@capacitor/core", "@capacitor/ios" at lines 64-65; devDep "@capacitor/cli" at line 198)` | Grep confirms zero @capacitor/* imports in src/, electron/, lib/, or server.js — these three deps and two scripts exist solely to sync/open the ios/ Xcode project and can be deleted from this repo when ios/ extracts. |

### LEGACY — freeze or retire — 4 entries

| Path | Why |
|---|---|
| `IMPLEMENTATION_GUIDE.md` | Walkthrough for the early file-storage system (Supabase migration 001, buckets); backend/DB topic, likely stale. |
| `QUICK_START.md` | Setup steps for the early file-storage system (Supabase migration 001); backend topic, likely stale. |
| `REPO_USAGE_AUDIT_2026-02-24.md` | Repo-wide historical usage-audit snapshot; direct input to this split rather than any one destination's docs. |
| `src/pages/ResetPassword.jsx` | Shared website + product-ui: password-recovery email-link landing on a public path — account plumbing for every surface, functional not marketing. |

### DEAD — delete — 24 entries

| Path | Why |
|---|---|
| `electron/documentReader.cjs` | No file requires it and none of its five exports (isSupportedDocumentPath, urlLooksLikePdf, getFrontmostDocument, extractDocumentFile, extractPdfFromUrl) are referenced anywhere in the repo; the four pdfjs-dist entrie... |
| `electron/set-url-handler.swift` | Standalone `swift set-url-handler.swift <scheme> <bundleId>` dev utility referenced by nothing; main.cjs:794-800 inlines the equivalent LSSetDefaultHandlerForURLScheme via `swift -e`, superseding it. |
| `public/email/lykn-icon.png` | No references anywhere in the repo (only the wordmark is used by emailBranding.js); could conceivably be hot-linked by already-sent emails, so verify before deleting from the hosted domain. |
| `public/videos/{lykn-build-dashboard,lykn-build-presentation,lykn-create-report,lykn-generate-ad}.mp4` | 12.4MB combined of committed marketing renders (matching LyknBuildDashboard/LyknBuildPresentation/LyknCreateReport/LyknGenerateAd compositions) with zero references anywhere in src/, electron/, server.js, or index.htm... |
| `public/wake-demo/{video-thumb-*.svg, lykn-mcp-spec.pdf, lykn-synthesis-overview.pdf}` | Four demo thumbnails and two PDFs with zero references repo-wide, including fragment searches (mcp-spec, synthesis-overview, thumb-notes, ai-workflow) — leftovers from an earlier wake vault demo. |
| `restart-server.ps1` | Windows dev helper that restarts npm run server (server.js); unreferenced anywhere else, borderline dead. |
| `src/assets/{Colored.jpg,Maybe.jpg,LoadingScreen.mov,lykn-demo-hero.mp4,glass-hero.png,lykn-hero-bg.png,hero-blue-wash.png,hero-cloud-drift.png,hero-cloudscape.png,hero-cobalt.png,hero-cobalt-smooth.png,hero-meadow.png,imagine-car.png,imagine-controller.png}` | Unreferenced anywhere in src/, electron/, or index.html (part of the 109/139 unreferenced files in the 41MB assets dir). |
| `src/components/FeedbackModal.jsx` | Imported by nothing. |
| `src/components/chat/ChatThreadSidebarGroups.jsx` | Sole file in src/components/chat; imported by nothing. |
| `src/components/lyknChat/LoadInBriefingPanel.tsx` | Imported by nothing; only a code comment in SynthesisLayer.tsx mentions it as the thing that superseded an older panel. |
| `src/components/lyknChat/LyknChatBarToolbar.tsx` | Only importer is src/components/wake/WakeChatTourPreview.tsx, which is itself unreachable (dead wake-tour chain). |
| `src/components/lyknChat/LyknChatComposer.tsx` | Only importer is the dead WakeChatTourPreview.tsx; the live composer used by LyknChatView is a different component. |
| `src/components/notes/RichTextRenderer.jsx` | Imported by nothing. |
| `src/components/projects/DailyDocketCard.tsx` | Imported by nothing. |
| `src/components/ui/hint.jsx` | Imported by nothing in the repo. |
| `src/components/ui/label.jsx` | Imported by nothing in the repo. |
| `src/components/ui/progress.jsx` | Imported by nothing in the repo. |
| `src/components/ui/scroll-area.jsx` | Imported by nothing in the repo. |
| `src/components/ui/sheet.jsx` | Imported by nothing in the repo. |
| `src/components/wake/{WakeAppShellPreview,WakeChatSubwindow,WakeChatTourPreview,WakeModelMenuPreview,WakeSynthesisSubwindow,WakeSynthesisTourPreview,WakeVoiceSubwindow}.tsx` | Self-contained wake-tour subwindow layer with no external importers anywhere (7 files importing each other in a closed dead chain) — apparent remnant of a superseded welcome experience. |
| `src/lib/chatChunks.ts` | Only importer is the dead WakeChatTourPreview.tsx. |
| `src/lib/types/vault.ts` | Imported by nothing (grep for types/vault across repo returns no importers). |
| `src/lib/wake/wakeChatTour.ts` | Only importer is the dead WakeChatTourPreview.tsx. |
| `src/pages/TagManagement.jsx` | Placeholder ('being migrated to the new LYKNChat architecture'); /tag-management route exists but zero in-app links anywhere in src/. |

### UNRESOLVED — 1 entries

| Path | Why |
|---|---|
| `README.md` | One-line placeholder ('# LYKN Software'); stays as this repo's README but needs a Mac-app rewrite. |