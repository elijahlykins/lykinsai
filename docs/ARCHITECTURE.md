# LYKN Studio — Architecture

Audit date: 2026-08-25. Describes the system **as it exists**, plus the dependency
rules we want to preserve. Companion docs: `LEGACY_CODE.md` (suspicious code),
`REFACTOR_LOG.md` (structural change history).

## The four runtime surfaces

LYKN is not one app — it is four cooperating programs that share this repo:

| Surface | Entry point | Runs where | Deploy |
|---|---|---|---|
| **Web frontend** | `index.html` → `src/main.jsx` → `src/App.jsx` | Browser (and inside Electron's main window) | Vercel (`vercel.json`, SPA from `dist/`) |
| **Desktop shell** | `electron/main.cjs` (`package.json` `main`) | User's Mac/PC | electron-builder (`electron-builder.json`) |
| **API backend** | `server.js` | Render web service (`render.yaml`) | Render |
| **Scheduled jobs** | `jobs/run*.js` | Render cron services | Render (4 crons, 03:00–04:30 UTC) |

Supporting, non-runtime areas: `remotion/` (marketing video renders),
`ios/` + `capacitor.config.ts` (iOS wrapper around lykn.io), `extensions/save-to-lykn`
(Chrome extension shipped inside the desktop app), `eval/` + `scripts/eval/`
(browser-agent benchmark harness), `supabase-migrations/` (schema + RLS + RPCs),
`supabase-queries/` (manual ops SQL), `scripts/` (build/ops tooling).

Key fact: **Electron does not bundle the React app.** The desktop main window loads
the *remote* `https://lykn.io/studio?glass=1` (or local Vite in dev via
`LYKN_APP_URL`). Overlay, welcome, agent chrome, and popups are local HTML files
inside `electron/`.

## Codebase map

```text
LYKN STUDIO
├── Entry points
│   ├── src/main.jsx                  (web/Studio frontend)
│   ├── electron/main.cjs             (desktop shell, ~16.4k lines)
│   ├── server.js                     (Express API, ~27.8k lines, ~160 routes)
│   └── jobs/run{Synthesis,Concepts,VaultReconciler,NightBrief}.js
│
├── Routing
│   ├── src/App.jsx                   (BrowserRouter; Studio-first, legacy paths redirect)
│   └── src/pages/Studio.jsx          (nested MemoryRouter hosting product surfaces)
│
├── Features (frontend)
│   ├── Chat        src/components/lyknChat/ + src/hooks/useChatEngine.ts
│   │               + src/lib/ai/ (chatSendOrchestrator) + src/lib/chat/ + src/lib/lyknChat/
│   ├── Vault       src/pages/Vault.jsx + src/lib/vault/ + src/components/vault/
│   ├── Studio home src/components/macdesktop/ + macdock/ + macfiles/
│   ├── Synthesis   src/pages/SynthesisLayer.tsx (soft-disabled) + src/pages/synthesis/
│   │               + src/components/synthesis/ + src/lib/synthesis/
│   ├── Bots        src/components/bots/ + src/lib/bots/
│   ├── Projects    src/pages/Project*.jsx + src/components/projects/
│   ├── Calendar/Todos/Notes/Settings/Connections/Billing under src/components/
│   └── Marketing   src/pages/GlassLanding.tsx, Pricing, News, Templates, CapabilityPage…
│
├── Shared UI       src/components/ui/ (shadcn-style primitives)
├── Hooks           src/hooks/ (useChatEngine, useLyknChatPersistence, voice, viewport…)
├── State           src/store/ (zustand), src/context/, module singletons
│                   (lib/bots/botStore, lib/chat/chatThreadRuntime, lib/files/fileWindows)
├── Data / API      NO central client: ~148 fetch() sites over src/lib/api-config.js
│                   base URL; auth via src/lib/installAuthFetch.ts (patched fetch);
│                   direct Supabase via src/lib/supabase.ts; desktop via window.lykn IPC
│
├── Desktop (electron/)
│   ├── main.cjs                      windows + ~217 IPC handlers ("lykn:<domain>-<action>")
│   ├── Agent OS
│   │   ├── agentRuntime.cjs          orchestrator (~11.9k lines) — skills, workers, persistence
│   │   ├── browser-agent/            modular browse loop (runtime/ + markdown doctrine)
│   │   ├── bot-harness/              NEW multi-tool bot loop (same shape, not a fork)
│   │   ├── ownedBrowserAct.cjs       page actuator + legacy adaptive loop (~12.8k lines)
│   │   └── localAgentTask/localSystem/documentEditor  (Local Mode: files, shell, docs)
│   ├── localStore/                   on-device SQLite vault + ONNX embeddings + blobs
│   ├── 16 preload bridges            window.lykn, lyknOverlay, lyknWelcome, …
│   ├── Local UIs                     overlay.js/.html, welcome.html, agent-stage, popups
│   └── vendor/                       vendored ElevenLabs IIFE bundle (third-party)
│
├── Backend
│   ├── server.js                     auth, chat streaming, RAG, billing, admin — inline
│   ├── Root services (ALL ACTIVE)    beliefSystem, userModelLearning, chat-agent-loop,
│   │                                 connectors-service, rss-service, synthesis-service,
│   │                                 youtubeQa, usageTracking, security-logger, validation,
│   │                                 validateSecrets, prompt-sanitizer, {concept,fact}Embedding
│   ├── lib/                          exterior/ (web+artifact tools), rag/, holo/, modelBuilder/,
│   │                                 nightShift/, training/, lora/, auth/, billing/, eval/
│   ├── mcp-tools/                    in-process chat/voice tool registry (NOT an MCP server);
│   │                                 localTools.js = schemas only, executed in Electron
│   ├── connectors/                   ~30 integrations, statically registered
│   └── jobs/                         nightly synthesis/concepts/reconciler/brief
│
├── Types            sparse: src/lib/types/; most TS types inline per file
├── Configuration    vite.config.js, tailwind.config.js, eslint.config.js (JS-in-src only!),
│                    electron-builder.json, render.yaml, vercel.json, .env
└── Legacy / questionable   → see docs/LEGACY_CODE.md
```

## Dependency direction (current reality and the rule to keep)

```text
UI (pages/components)
  ↓
feature logic (hooks, src/lib/<feature>/)
  ↓
services (fetch → server.js API, window.lykn → electron IPC, supabase client)
  ↓
external systems (Supabase, Stripe, LLM providers, OS)
```

Rules to preserve:

1. **The server holds all provider API keys.** Electron and the frontend call
   `/api/*`; never move key material client-side.
2. **Renderers never touch Node.** All desktop capability flows through preload
   bridges (`window.lykn.*`) → IPC (`lykn:<domain>-<action>`) → main process.
3. **`server.js` imports from `src/lib/` only for shared config**
   (`modelTiers.js`, `pricing-config.js`, `ai/conversationFormat.js`). Do not
   widen this backdoor; if more sharing is needed, move the shared module to a
   neutral location instead.
4. **Electron ⇄ server share `lib/*.cjs` intent helpers** (browserScreen,
   webSearchIntent, artifactBuildIntent, …). These must stay dependency-light
   (no Electron, no Express imports) so both sides can load them.
5. **`agentRuntime.cjs` is deliberately Electron-free behind dependency
   injection** so tests run in plain Node. Keep it that way.

## Where new code should go

- **New chat behavior** → `src/lib/ai/` (send pipeline) or `src/hooks/` (UI state);
  server side in the `/api/ai/*` section of `server.js` (until extracted).
- **New product surface** → its own folder under `src/components/<feature>/` +
  register in Studio's `WINDOW_APPS` / MemoryRouter, not new top-level routes.
- **New agent tool** → schema in `mcp-tools/` (+ `chatTools.js` whitelist);
  Local-Mode execution in `electron/localSystem.cjs`.
- **New connector** → `connectors/<provider>.js` + explicit entry in
  `connectors-service.js` registry (static, on purpose).
- **New desktop capability** → handler in the matching IPC domain, exposed via
  `preload.cjs`; never a new global.
- **Shared utility** → `src/lib/` top level only if genuinely cross-feature;
  otherwise keep it in the feature folder.

## Shared vs feature-specific

`src/lib/` is mostly **feature-owned** (vault/, ai/, chat/, bots/, synthesis/…) with
a thin shared layer (api-config, supabase, theme, appearance, drag/, utils). The
top-level of `src/lib/` has accumulated ~80 loose files; prefer placing new files in
a feature subfolder.

## Naming expectations

- Electron IPC channels: `lykn:<domain>-<action>` kebab-case.
- Preload globals: `lykn*` camelCase per window (`lyknOverlay`, `lyknWelcome`, …).
- Tests colocated: `*.test.{cjs,mjs,ts}` next to the module, run via `node --test`
  (see `package.json` `test:*` scripts).
- `.cjs` = loadable by Electron main / shared with server; `.js`/`.mjs` = ESM.

## Known structural debt (tracked, not yet acted on)

The five megafiles — `server.js` (~27.8k), `electron/main.cjs` (~16.4k),
`electron/ownedBrowserAct.cjs` (~12.8k), `electron/agentRuntime.cjs` (~11.9k),
`src/pages/Vault.jsx` (~10.2k) — plus `src/index.css` (~10.5k, mixes product and
marketing styles). See `REFACTOR_LOG.md` for the incremental extraction plan and
history. `electron/browser-agent/` and `electron/bot-harness/` show the preferred
modular shape for new work.
