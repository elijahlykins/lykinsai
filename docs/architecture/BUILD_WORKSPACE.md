# Build Mode: Workspace Agent Architecture

Audit, hardening, and implementation record for turning Studio Build into a general-purpose software engineering agent.
Date: 2026-09-04.

## Architecture before

Build Mode was an artifact generator, not a workspace agent.

The Studio "Build" pill armed `composerMode create:webapp`, which set `forceArtifact: true` on the request.
The server forced `lykn_build_react_artifact` on hop 0 of the agent loop (`chat-agent-loop.js`, up to 28 hops for fresh coded builds).
The tool validated JSX, wrapped it in a CDN runner HTML (Babel in-browser transpilation), persisted it to Supabase `user-files`, and previewed it in a sandboxed iframe.
Multi-file "projects" were virtual: `codeProjectBundle.js` inlined relative ESM imports into one `__lyknRequire` bundle, capped at 48 files / 240k chars, never touching disk.

Separately, Local Mode offered real primitives — `local_list_dir/read/search/write/edit` and `local_run_command` — executing in the Electron main process via a server round trip (`awaiting_client` tool_call event → renderer → `lykn:local-tool-run` IPC → `localSystem.run` → result POSTed to `/api/ai/local-tool-result`).
Local Mode was disconnected from Build Mode, gated behind a Vault switch, scoped to user-synced folders, and had no concept of a project workspace.

## Problems found

Critical (capability blockers):

- No workspace: nothing could be built on disk; no project persistence between turns beyond the artifact blob.
- No long-running processes: `local_run_command` blocked until exit and hard-killed at 60s, making dev servers, watchers, and long installs impossible.
- Build Mode could not reach the shell/filesystem at all: local tools required the Local Mode switch and intent-based disclosure keyed on file-ish keywords.
- Hop 0 was hard-locked to the artifact builder on every armed build turn, so no other build strategy could exist.

High (reliability and friction):

- Fixed 60s command timeout with no override: `npm install`, builds, and clones routinely exceed it.
- Output truncation at 50KB discarded the remainder permanently.
- Approval prompts on every `rm`, `curl`, and `git clone` made autonomous engineering loops impossible (approve-per-command).
- `commandPathTargets` treated URL path portions as filesystem paths, denying `curl http://localhost:8000/...` as an out-of-allowlist path (found live in E2E).
- Relative tool paths resolved against `~`, not the working project, so first-call writes landed outside the permitted area (found live in E2E).
- Follow-up turns in a build session could lose all tools to the casual/lean classifier gates ("now run the tests" has no action keywords).
- Loop budget (28 hops / hard cap 40) is too small for real engineering tasks.

Medium (architecture):

- Build intent decided by regex/keyword routing (`artifactBuildIntent`) rather than by the model choosing tools.
- `chatStream.routes.js` at its 4000-line budget with prompt guidance inlined.
- No canonical owner for on-disk build execution.

## Changes made

New subsystem: `electron/build-workspace/` (canonical owner of on-disk build execution).

- `workspace.cjs`: workspace root `~/LYKN/Builds` (override `LYKN_BUILDS_DIR`), symlink-safe containment via nearest-existing-ancestor canonicalization, project listing, logs dir.
- `processManager.cjs`: managed background processes — spawn detached zsh process groups, 256KB output ring buffer plus on-disk log file, dev-server port/url detection from output, early-crash detection, status/stop/stop-all, caps (8 running / 24 tracked), kill-all on app exit.

`electron/localSystem.cjs` integration:

- Four new tools dispatched: `local_build_workspace`, `local_start_process`, `local_process_status`, `local_stop_process`.
- Workspace paths always allowed regardless of the Vault sync allowlist.
- `workspaceOnly` run mode (used when Local Mode is off): every tool confined to the workspace root, Mac-wide tools refused, relative paths rebased onto the workspace, denials carry self-explanatory errors.
- Deletes/downloads/clones fully scoped to the workspace are routine (no approval); outside it the existing consequence tiers are unchanged.
- `local_run_command`: `timeoutSec` up to 240s; on truncation the full output (up to 4MB) is written to `.lykn/logs/` and returned as `fullOutputPath`; PATH extended with Homebrew dirs.
- URL path portions and `/dev/tcp|udp` sockets excluded from command path-target extraction.

Transport and gates:

- `lykn:local-tool-run` IPC accepts a `workspace` opt-in; Local Mode off + workspace on → `workspaceOnly` confinement (approval tokens unchanged, still main-issued and single-use).
- `preload.cjs`, `overlay-preload.cjs`, `src/lib/localMode.ts`, `src/lib/ai/localToolExecutor.ts` thread the flag through.

Server wiring:

- `server/ai/buildWorkspaceTurn.js` (new owner): `armBuildWorkspaceTools` and `buildWorkspaceGuidance` (the workspace system-prompt block: surface choice, inspect-before-edit, validate-by-running, recover-don't-report, prompt-injection defense, completion criteria).
- `chatStream.routes.js`: `buildWorkspace` request flag arms the tool set on every Build-view turn, keeps tools on despite casual-tier gates, extends the client-tools transport gates, skips hop-0 artifact forcing on workspace-armed fresh builds (the model chooses artifact preview vs workspace), passes `workspaceMode` to the loop.
- `chat-agent-loop.js`: `workspaceMode` → 60 hops (hard cap 80), 8 tool calls per hop.
- Local Mode / ask-bot guidance moved to `chatGuidance.js` (`buildLocalModeGuidance`, `buildAskBotGuidance`) to keep the route under its line budget.
- Schemas in `mcp-tools/localTools.js` (+`BUILD_WORKSPACE_TOOL_NAMES`), registry entries in `firstPartyCapabilities.js`, voice registry explicitly excludes the new tools.

Client:

- `useChatEngine` sends `buildWorkspace: true` on every Studio Build send (sticky view mode, so conversational follow-ups keep the tools); `chatRequestBuilder` forwards it only from the desktop shell.

## Tool inventory (build workspace turns)

| Tool | Purpose | Approval |
|---|---|---|
| `local_build_workspace` | Workspace root + existing projects (anchor call) | never |
| `local_list_dir` / `local_read_file` / `local_search_files` | Inspection | never |
| `local_write_file` / `local_edit_file` | Creation / surgical edits | never |
| `local_run_command` | One-shot shell, exit code + output, `timeoutSec` ≤ 240, overflow log file | only consequential commands outside the workspace |
| `local_start_process` | Managed background process; early output, port/url, crash detection | same as run_command |
| `local_process_status` | Running/exited, exit code, port, recent logs; omit id to list all | never |
| `local_stop_process` | SIGTERM → SIGKILL group termination | never |
| `local_install_app` | Install a project's production build into the user's dock as a static app | never |

## Build-surface precedence

Which surface builds a request is a deterministic rule, not a model judgment call.
Build mode on desktop used to send both `forceArtifact` (an in-prompt block pushing `lykn_build_react_artifact`, whose pitch claims games and multi-file apps) and `buildWorkspace` (a block pushing real on-disk projects); the model picked per turn, which read as random surface switching — worst for games, which both blocks claimed.

The rule (`workspaceOwnsFreshBuild` in `server/ai/buildWorkspaceTurn.js`):

- Workspace armed + fresh webapp/game build → the workspace owns it. The forced artifact spec is cleared and `lykn_build_react_artifact` is removed from the turn's tool set entirely.
- Workspace armed + the user is editing an artifact that already lives in the chat (`activeArtifactEditable`) → the artifact pipeline keeps the turn; its source rides along as before.
- Other Create kinds (deck, chart, document, video) keep their own builders on any turn.
- Web (non-desktop) never arms the workspace, so artifacts remain the only build surface there.

Continuity: the client remembers workspace chats (`src/lib/ai/buildWorkspaceChats.ts`, localStorage) and re-arms `buildWorkspace` on every later send in that chat, so follow-ups after a reload or from Chat view stay in the same on-disk project instead of falling back to an artifact.

## Dock installs (static apps)

A finished frontend project does not have to live behind a dev server.
After `npm run build`, `local_install_app` collects the emitted `dist/`/`build/`/`out/` folder (or a root `index.html` for plain sites) and installs it into the existing app host (`electron/appHost.cjs`) as a static app.

- `electron/build-workspace/distFiles.cjs` finds and packages the bundle: text files verbatim, binary assets base64-encoded for the `app_files` TEXT column (migration 7 added the `encoding` column).
- `appHost.installStaticApp` stores the files under `entry: "index.html"` with no capabilities and no JSX compile.
- `electron/appProtocol.cjs` serves static apps verbatim from their own `lykn-app://<id>/` origin: real mime types, decoded binaries, and an index.html fallback for client-side routes. The React shell and bundle compiler are bypassed entirely.
- `.lykn-app.json` in the project root records the installed app id. Reinstalling the same project updates the app in place, and because the id is the app's origin, everything the user saved inside the app survives updates.
- The install broadcasts `lykn:apps-changed`, so the dock (`InstalledAppDock`) picks the app up immediately. Launching, windowing, uninstall, and icons all ride the existing installed-app system.
- The model passes an app-specific `icon` (a lucide name, e.g. `Crosshair` for a shooter) with the install.
  It ranks like a manifest icon in `resolveIcon`: an icon the user picked from the dock survives every reinstall, and the model's choice never claims `icon_source: "user"`.

Apps that need their own backend cannot be installed this way; the guidance tells the model to say so and leave the dev server running instead.

## Creative compute and the vision loop

Build turns are taught (buildWorkspaceTurn.js CREATIVE COMPUTE block) to reach real creative tools through the shell instead of settling for placeholders: headless Blender (`blender --background --python`) for 3D assets exported as .glb plus a rendered preview, the Godot CLI for engine projects (text scenes and scripts are ordinary workspace files), ffmpeg/ImageMagick for media, `lykn_generate_image` for textures, and curl for free asset libraries.

Two generation paths cover what scripting cannot:

- `lykn_generate_3d_model` (`lib/exterior/generate3dModel.js`, armed on every workspace turn plus any 3D-worded chat) turns a prompt and/or reference image into a textured PBR GLB through Tripo (text+image) with Meshy as the image-to-3D fallback, picked by which API key is configured.
  Provider URLs expire in minutes, so the GLB (and the provider's preview render) is downloaded and persisted to LYKN storage immediately; the agent curls the durable `model_url` into the project and judges `preview_image_url` through the vision loop before building on it.
  Usage is metered as the fixed-cost `model3d_gen` action.
- Code-first CAD guidance: parts with real dimensions go through a CAD kernel (`uv run --with build123d part.py` → STEP + STL/GLB + read-back measurements; `openscad -o part.stl` when installed), never a mesh sculpt.

The loop can now SEE.
Any tool result carrying `imageDataUrl` (a `local_read_file` of a render, a screenshot, a desktop-MCP viewport capture) is attached to the model as a real image by chat-agent-loop.js in each provider's own grammar (OpenAI `image_url` parts, Anthropic `tool_result` image blocks, Gemini `inlineData`), capped at 2 images per hop.
The base64 is stripped from the JSON text serialization — the model gets pixels, not noise.
This closes the render→look→refine loop the guidance demands: "Never ship a visual you have not looked at."

Two sibling subsystems extend the same reach beyond the workspace (see OWNERSHIP.md):

- Desktop MCP servers (`electron/mcp/localMcpHost.cjs`): stdio MCP processes on the user's machine (blender-mcp, ableton-mcp, anything under `localCommandPolicy`). Chat reaches them through `local_mcp_search_tools` / `local_mcp_call_tool`; reads run free, consequential calls take a one-time remembered approval.
  Chat can also CREATE connections: `local_mcp_catalog` searches the vetted catalog (`electron/mcp/desktopMcpCatalog.cjs` — every command validated against npm/PyPI, env keys and app-side setup steps declared, entries badged when the app is detected in `/Applications` or on PATH) plus the official MCP registry as a fail-soft long tail, and `local_mcp_connect` connects one behind a main-issued approval token whose card shows the exact command line.
  Catalog names pin their command from the catalog — the model can never launder its own command through a known name; custom commands stand on the approval card alone.
  Servers that need API keys return `env_required` with per-key hints; the model collects values in chat and they persist encrypted via Electron `safeStorage`.
  The connect tools arm on connect-shaped wording (`messageWantsMcpConnect`) whenever the desktop bridge is present (`desktopMcpAvailable`), so "connect to blender" works at zero connections; the Settings "On this Mac" chips render from the same catalog + detection over IPC.
- Desktop control (`electron/desktop-agent/desktopControl.cjs`): `local_desktop_look` (screenshot the model sees) and `local_desktop_act` (native click/drag/scroll/type/key via libnut), guarded by frame epochs and drift refusals from `surface/frame.cjs`. One approval arms the session.

## Capability matrix

| Capability | Status | Mechanism |
|---|---|---|
| Persistent on-disk projects | Yes | `~/LYKN/Builds/<project>`, listed by anchor tool across conversations |
| Read/inspect unfamiliar codebases | Yes | list/read/search + shell (`grep`, `wc`, …) |
| Targeted file edits | Yes | `local_edit_file` exact-snippet replace |
| Shell commands with exit codes | Yes | `local_run_command` |
| Dependency install (npm/pip/cargo/go/brew) | Yes | shell, `timeoutSec` ≤ 240, longer via managed process |
| Git (clone/branch/commit/log) | Yes | shell; clone auto-runs inside workspace |
| Dev servers / watchers | Yes | managed processes with port detection |
| Build/test/fix loops | Yes | 60-hop workspace loop; validated E2E |
| Long command output recovery | Yes | `fullOutputPath` overflow log |
| Network downloads (curl/wget) | Yes | auto-run inside workspace |
| Browser/visual validation of built apps | Partial | HTTP checks via curl; renders/screenshots reach the model as images (vision loop) |
| See and drive native desktop apps | Yes | `local_desktop_look` / `local_desktop_act` (Local Mode, session approval) |
| Control apps via their MCP servers | Yes | `local_mcp_search_tools` / `local_mcp_call_tool` (user connects servers in Settings) |
| Generate organic 3D assets (GLB) | Yes | `lykn_generate_3d_model` (Tripo/Meshy, metered, persisted to storage) |
| Dimensioned CAD parts | Yes | code-first CAD guidance (build123d STEP + measurement read-back) + FreeCAD/KiCad catalog entries |
| Video generation | Yes (Imagine) | `/api/ai/imagine-video` → OpenRouter `/api/v1/videos` (Veo/Kling/Seedance/Wan/Sora), direct Gemini Veo fallback (`lib/exterior/generateVideo.js`) |
| Interactive commands (stdin) | No | non-interactive by design |
| Processes surviving app quit | No | by design (kill-all on exit) |

## E2E results

Harness: `scripts/build-workspace-e2e.mjs` — drives the production `runAgentLoop` with production tools in `workspaceOnly` mode against a real model (`claude-sonnet-5`), approvals auto-granted like a user clicking Allow.

| Scenario | Result | Tool calls | Tool errors |
|---|---|---|---|
| Greenfield: pomodoro app + static server as managed process, verify, stop | PASS | 8 | 0 |
| Debug: find and fix an off-by-one in `broken-calc`, make `npm test` pass | PASS | 7 | 0 |
| Repo: clone octocat/Hello-World, inspect, add NOTES.md, commit, show log | PASS | 7 | 0 |
| Game: scaffold Vite snake game (5 modules), npm install, dev server on :5173, curl 200, stop | PASS | 14 | 0 |

The first greenfield run surfaced the URL-as-path and relative-path bugs (10 tool errors); both fixed with regression tests, after which all scenarios ran clean.

Unit/integration: 22 tests in `electron/build-workspace/*.test.cjs` (containment, symlink escape, process lifecycle, port detection, confinement, approval tiers, timeout, overflow recovery); full sweep of `test:electron`, `test:security`, `test:tools`, `test:chat`, `test:server`, `test:agent`, `test:architecture` — 2,225 tests passing.

## Remaining gaps

- Visual validation is now possible (image tool results reach the model; `local_desktop_look` screenshots the screen) but there is no purpose-built "screenshot this localhost URL" tool yet; the agent goes through a render/export or a desktop look.
- The artifact-vs-workspace choice is guided but unmeasured; add telemetry on which surface the model picks and mis-pick rates.
- No per-project state file (branch, task list, last validation) for resuming complex multi-session builds; currently the agent re-inspects.
- `LOCAL_TOOL_WAIT_MS` (5 min) bounds any single tool call; installs longer than that must go through managed processes, which the schema teaches but nothing enforces.
- Workspace builds require the desktop shell; web-only users still get artifacts only.
- No disk quota on the workspace.

## Recommended next phase

1. Visual validation: bridge the existing browser agent so build turns can open `http://localhost:<port>`, screenshot, and iterate.
2. Project state: a `.lykn/project.json` the agent maintains (goal, todos, validation status) surfaced through `local_build_workspace` for cross-session resume.
3. Surface telemetry: log artifact-vs-workspace choice per build turn; tune guidance from data, not regex.
4. Open-the-result UX: a "open project folder / open served app" card in chat when a workspace build completes.
5. Retire regex build-intent routing in favor of model-chosen tools once telemetry confirms the guidance works.
