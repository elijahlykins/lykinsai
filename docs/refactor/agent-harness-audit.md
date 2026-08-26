# LYKN Agent Harness Pre-Redesign Architecture Audit

Status: factual read-only audit of the current worktree on 2026-08-26.

Scope: current LYKN chat-to-agent handoff, Electron agent host, modular browser agent, legacy browser path, Bot Harness, local-computer runner, prompts, state, security, failure handling, observability, and model cost.

This document does not design or implement the replacement architecture.

## Executive summary

LYKN does not currently have one Agent Harness.
It has a host orchestrator plus several partially overlapping agent systems:

1. The normal LYKN chat agent can call `local_browser_agent`, which asynchronously creates an Electron agent and hands it a model-written task.
2. Studio can send directly to an Electron agent through `window.lykn.studioAgentSend`.
3. Bot chats enqueue browser, local-computer, report, image, artifact, edit, or reply work through a separate Bot Harness.
4. `electron/agentRuntime.cjs` routes work among the modular browser agent, a large legacy browser loop, Bot Harness, local-computer loop, artifact/report/image paths, monitor paths, and ordinary streamed chat.
5. The modular browser agent has its own planner, decision loop, controller, task state, verification, recovery, memory, ownership abstraction, and prompt corpus.

The browser-agent core is substantially more disciplined than the surrounding host.
It has structured decisions, temporary element references, fresh observations, per-action verification, bounded retries, serialized checkpoints, explicit `successCondition` and `doNot` fields, and a real pre-action approval pause.
Those are strong foundations worth preserving.

The largest architecture problem is authority fragmentation.
The user request, chat turn, agent record, browser task, Bot task, browser view, approval request, UI transcript, and completion state are different objects owned by different layers.
There is no single canonical Task object that survives routing and remains authoritative through completion.

The second largest problem is that completion is still primarily semantic and model-mediated.
The modular planner writes the success condition, the executor decides whether to finish, and the loop accepts completion from generic evidence plus plan bookkeeping.
The runtime does not deterministically evaluate a machine-readable contract derived from the original user request.
The Bot Harness and local-computer runner have even looser completion contracts.

The third largest problem is duplicated orchestration.
Browser work can be selected by the normal chat model, by Electron routing heuristics and model classification, by Bot Harness, or by legacy route code.
Agent-tab browser actuation is split between `ownedBrowserAct.cjs` and `browser-agent/browser/controller.cjs`, while `browserAct.cjs` runs a separate external Chrome/Safari overlay path.
General chat, Bot Harness, modular browser, legacy browser, and local-computer work each implement their own loop, prompt, tool contract, state, limits, and completion behavior.

The primary token cost is repeated browser context.
Every modular browser decision carries roughly 8,900 tokens of always-loaded markdown before generated contracts, schemas, task state, memory, conversation, and the current page snapshot.
Planning adds another strong-model call.
Each action usually causes a strong-model decision call, and ambiguous outcomes cause a verification call with another substantial prompt.
Vision grounding and learning can add more calls.
A medium task can therefore make 10 to 30 model calls and repeatedly resend a five-figure-token context.
The decision system is intentionally byte-stable so provider prefix caching can discount some repeated input, but it remains logical input volume and still affects cache misses, latency, and providers without equivalent caching.

Agents can over-execute for architectural reasons, not merely because of model temperament.
The runtime prompts repeatedly prioritize end-to-end completion, discourage asking the user, treat plans as mutable guidance, and permit constraints to be dropped during replanning.
The canonical scope fields are themselves model-authored.
Completion is not checked against an immutable original-task contract.
The host also enriches goals with operational instructions, and the normal chat handoff compresses the conversation into a new task string that the browser agent treats as its complete request.

The most serious security finding is that human approval is not an independent trust domain.
Main-issued local-tool tokens are single-use, argument-bound, and expiring, which is good, but the code explicitly notes that a compromised privileged renderer can request a token and round-trip it without a human.
Browser consequences are also detected by regexes over accessible labels, model-written expected outcomes, and model-written labels for coordinate targets.
This is a useful defense, but it is not a deterministic understanding of the actual side effect.

## Current architecture diagram

```mermaid
flowchart TD
    U[User]

    subgraph Renderer["Renderer processes"]
      LC[LYKN Chat<br/>useChatEngine]
      SR[Studio Agent Rail]
      BC[Bot Chat Bridge]
      LTE[localToolExecutor]
    end

    subgraph Server["LYKN server"]
      AIS[/api/ai/stream]
      CAL[chat-agent-loop.js]
      CTR[Chat tool registry]
      DR[/api/desktop/agent-*]
      BR[/api/bots/*]
    end

    subgraph Main["Electron main process"]
      IPC[main.cjs IPC]
      AR[agentRuntime.cjs]
      VIEWS[Agent tabs and WebContentsViews]
      OBS[ownedBrowserAct.cjs]
      LSYS[localSystem.cjs]
    end

    subgraph BrowserAgent["Modular browser-agent"]
      PLAN[planner.cjs]
      DECIDE[executor.cjs]
      CTRL[controller.cjs]
      VERIFY[verifier.cjs]
      STATE[taskState.cjs]
      MEM[memory.cjs]
    end

    subgraph BotHarness["Bot Harness"]
      BH[bot-harness/index.cjs]
      BCTX[contextRouter.cjs]
      BTOOLS[toolRegistry.cjs]
    end

    U --> LC
    U --> SR
    U --> BC

    LC --> AIS
    AIS --> CAL
    CAL --> CTR
    CTR -->|local_browser_agent awaiting_client| LTE
    LTE -->|agentCreate and studioAgentSend| IPC

    SR -->|studioAgentSend| IPC
    BC --> BR
    BR --> DR
    DR --> AR

    IPC --> AR
    AR -->|browser route| PLAN
    PLAN --> STATE
    STATE --> DECIDE
    DECIDE --> CTRL
    CTRL --> OBS
    OBS --> VIEWS
    VIEWS --> CTRL
    CTRL --> VERIFY
    VERIFY --> STATE
    STATE --> DECIDE
    MEM --> PLAN
    MEM --> DECIDE

    AR -->|headless bot route| BH
    BH --> BCTX
    BH --> BTOOLS
    BTOOLS -->|browser: park, user opt-in, re-enter| AR
    BTOOLS -->|local computer| LSYS
    BTOOLS -->|reply, report, image, artifact| AR

    AR -->|legacy browser fallback and special paths| OBS
    AR -->|local route| LSYS
    AR -->|delta, state, choice, completion| IPC
    IPC --> SR
    DR --> BR
    BR --> BC
```

## End-to-end request trace

### Entry path A: normal LYKN chat hands work to the browser agent

1. `src/hooks/useChatEngine.ts` accepts the user send and delegates to `orchestrateChatSend`.
2. `src/lib/ai/chatSendOrchestrator.ts` builds attachment, workspace, conversation, memory, mode, and artifact context, then calls `/api/ai/stream`.
3. `server.js` classifies the enrichment tier and uses `mightBeBrowserTaskAsk` from `mcp-tools/localTools.js` only to keep tools enabled on browser-shaped turns.
4. The heuristic does not select the browser agent.
5. `server.js` appends the hardcoded `[BROWSER AGENT - AVAILABLE]` instruction and includes the `local_browser_agent` schema when Local Mode tools are enabled.
6. `chat-agent-loop.js` calls the selected chat model with the system prompt, conversation, context, and tool schemas.
7. The chat model may emit a `local_browser_agent` tool call containing a self-contained `task` and optional `url`.
8. `chat-agent-loop.js` recognizes local tools as client-executed tools and emits an SSE `tool_call` with `status: "awaiting_client"`.
9. `src/lib/ai/chatSendOrchestrator.ts` receives that SSE event and calls `executeAwaitingLocalTool`.
10. `src/lib/ai/localToolExecutor.ts:startBrowserAgentTask` calls `window.lykn.agentCreate({ goal })`.
11. It then fire-and-forgets `window.lykn.studioAgentSend(goal, [], agentId, {})`.
12. The chat turn does not await the browser run.
13. The chat model receives an immediate result saying that the browser task is underway and writes a normal chat response.
14. The browser run and chat turn now have separate lifecycle, state, cancellation, completion, and observability.
15. No cross-runtime task ID links the original chat tool call to the new browser task.
16. The browser agent sees the model-composed handoff string, not the original full conversation.

This path contains two semantic decisions before browser planning:

- A regex heuristic decides whether browser tools remain available.
- The normal chat model decides whether to call `local_browser_agent` and rewrites the request into a task brief.

### Entry path B: direct Studio Agent Rail send

1. `src/components/studio/agentRail/StudioAgentRail.jsx` submits text through `window.lykn.studioAgentSend`.
2. `electron/preload.cjs` invokes `lykn:studio-bar-send`.
3. `electron/main.cjs` enables agent mode, resolves the requested or active agent ID, and calls `agentRuntime.send`.
4. `electron/agentRuntime.cjs:send` resolves pending user choices first, then determines whether to dispatch to a worker, run a tool path, run a browser path, or stream ordinary chat.
5. `classifyAgentSkill`, `decideBrowserRoute`, `agentSkillClassifier`, `browserTaskRouter`, and several regex checks participate in routing.
6. Routing is mixed, not purely model-driven or deterministic.
7. A browser-shaped request reaches `runModularBrowserAgent`, subject to legacy and special-case fallbacks in the host.

### Entry path C: Bot chat and standing Bot task

1. `src/hooks/useBotChatBridge.ts` and `src/lib/bots/botChatBridge.js` send a user turn to the Bot API.
2. `src/lib/bots/botStore.ts` and `src/lib/bots/botsClient.js` own renderer-side Bot identity, chat history, queue, and task status.
3. `server/routes/desktop.routes.js` exposes desktop Bot execution endpoints and proxies execution to Electron.
4. `electron/agentRuntime.cjs:runBotTask` finds or creates a headless worker with the Bot profile.
5. `agentRuntime.send` routes that worker into `runBotHarnessTask`.
6. `electron/bot-harness/index.cjs` creates Bot task state and runs a decide, use-tool, observe, continue, ask, or deliver loop.
7. `electron/bot-harness/runtime/toolRegistry.cjs` exposes a compact tool index.
8. Full tool documentation is loaded only when a tool is first selected.
9. Bot tools call back into host capabilities such as `runLocalTask`, report generation, artifact building, image generation, or reply streaming.
10. Selecting `browser` does not immediately invoke the browser agent.
11. It parks `pendingBotBrowse` and returns a user opt-in question.
12. A positive answer sets `botBrowserRun`, re-enters the normal browse pipeline, and only then invokes the modular or configured legacy browser runtime.
13. Browser work is therefore nested: Bot Harness selects and parks the capability, the host resumes it after opt-in, and the browser agent plans and decides again.
14. Bot events and final delivery are returned through the desktop Bot route and renderer subscription.

### Entry path D: agent creation and lifecycle controls

The following Electron IPC entry points can start or affect work:

- `lykn:agent-create` creates an agent and browser tab.
- `lykn:agent-send` sends text and attachments to a specific agent.
- `lykn:studio-bar-send` sends from Studio to an active or specified agent.
- Agent choice resolution resumes an approval or question.
- Agent stop increments generation and aborts the active run.
- Agent restart, removal, visibility, active-agent, and browser-tab operations change the host environment around a run.
- Browser-home privileged IPC can start work only after exact packaged-document sender validation.
- Desktop server routes can assign and execute Bot tasks.
- Monitor schedules can re-enter `send` without an immediate foreground user send.

### Modular browser-agent lifecycle

1. `agentRuntime.runModularBrowserAgent` resolves the agent WebContents, creates the controller and memory store, prepares conversation history, and installs cancellation and user-input listeners.
2. It calls `browser-agent.runBrowserAgentTask`.
3. `browser-agent/index.cjs:runTask` creates or restores `runtime/taskState.cjs` state.
4. `runtime/contextRouter.cjs` chooses skills with keyword heuristics.
5. `runtime/planner.cjs:createPlan` calls the model with the goal, conversation, memory, current page, skill guidance, and a planning schema.
6. The planner returns steps, constraints, `successCondition`, and `doNot`.
7. The task checkpoint is serialized back to the host.
8. For each round, `browser/controller.cjs:snapshot` obtains URL, title, tabs, accessibility-derived elements, visible text, and optional image state from `ownedBrowserAct.cjs`.
9. `runtime/visionPolicy.cjs` decides whether a screenshot is needed based on page opacity, prior failure, and requested visual grounding.
10. `runtime/contextRouter.cjs:buildDecisionSystem` assembles the always-loaded corpus, chosen skills, memory, action contract, safety contract, and JSON schema.
11. `runtime/taskState.cjs:formatTaskForModel` and `formatHistoryForModel` provide the plan, open step, facts, constraints, recent actions, retries, and prior verification.
12. `runtime/executor.cjs:decideNext` calls the model for one structured decision.
13. `normalizeDecision` rejects invalid action shapes, stale references, invalid coordinates, and inadmissible batches.
14. `classifyActionRisk` independently classifies the action from action type, snapshot target label, expected outcome, and regexes.
15. If the action is consequential, the loop pauses before actuation unless the host explicitly marked the resumed send as approved.
16. `agentRuntime` surfaces an in-memory choice with a random ID and Yes/No controls.
17. On approval, `browser/controller.cjs:act` converts the structured action to an `ownedBrowserAct` operation.
18. `ownedBrowserAct.cjs` performs deterministic WebContents operations, CDP input, navigation, JavaScript evaluation, screenshot capture, overlay dismissal, tab operations, or visual-coordinate actions.
19. The controller waits for page stabilization and takes a fresh snapshot.
20. `runtime/verifier.cjs` runs deterministic comparison first.
21. If the comparison is inconclusive, `buildVerificationSystem` and the model classify success from before state, after state, action, expected outcome, and image evidence.
22. `runtime/taskState.cjs:recordAction` records the observation and caps recent working history.
23. Success advances or completes a plan step.
24. Failure invokes `runtime/recovery.cjs` and `runtime/deadEnd.cjs`, which choose retry, visual escalation, alternate target, replan, ask, or fail.
25. `runtime/planner.cjs:revisePlan` can replace plan steps and constraints.
26. A later decision can return `finish`, `ask_user`, `replan`, or another `act`.
27. `finish` is checked for answer text, evidence, open plan steps, repeated no-op finish attempts, and task-specific guards.
28. The final task state is checkpointed and the JSONL debug log is closed.
29. `agentRuntime` maps modular history into its legacy-shaped history, sets `verifiedComplete`, updates the Studio transcript, persists agent state, emits final deltas, and returns an answer.

### Browser takeover and continuation

1. `browser/ownership.cjs` implements `"agent"`, `"delegated"`, and `"user"` states for the current controller.
2. The host also listens for WebContents `input-event` on the main and child tabs.
3. User input aborts or pauses the active automated interaction and moves control to the user.
4. Sign-in walls and missing user-only facts return `waiting_for_user`.
5. The host stores `pendingChoice`, a serialized browser task checkpoint, and the browser tab itself.
6. A subsequent user response can resume from serialized task state and a fresh browser snapshot.
7. The checkpoint belongs to browser task state, while the pause and choice belong to `agentRuntime`.
8. Production uses `"agent"` and `"user"` transitions; `handOff()` and `takeOver()` for `"delegated"` are present but not called outside tests or planning code.

## File/module ownership map

### UI and chat handoff

- `src/hooks/useChatEngine.ts`
  Owns per-board send locking, renderer abort controllers, chat thread snapshots, composer mode, and delegation to the chat send orchestrator.
- `src/lib/ai/chatSendOrchestrator.ts`
  Owns normal chat context construction, server streaming, SSE tool event handling, local-tool dispatch, visible chat state, and post-processing.
- `src/lib/ai/localToolExecutor.ts`
  Owns client execution of server-requested local tools and the normal-chat to browser-agent handoff.
- `src/components/studio/agentRail/StudioAgentRail.jsx`
  Owns the Studio representation of agent list, active agent, live transcript, choices, and send controls.
- `src/lib/bots/botChatBridge.js`
  Owns Bot chat streaming and reattachment from the renderer.
- `src/hooks/useBotChatBridge.ts`
  Adapts Bot bridge state into React.
- `src/lib/bots/botStore.ts`
  Owns renderer-persisted Bot profiles, queue records, chat records, and task status.
- `src/lib/bots/botsClient.js`
  Owns Bot API calls, subscriptions, assignment, and browser reveal requests.

### Server chat and Bot ingress

- `server.js`
  Owns normal chat prompt construction, enrichment gates, model/provider selection, tool enablement, the Browser Agent availability prompt, and `/api/ai/stream`.
- `chat-agent-loop.js`
  Owns the provider-specific normal-chat tool loop, hop limits, tool batches, tool-result injection, continuation, and final model response.
- `mcp-tools/localTools.js`
  Defines Local Mode tool schemas, including `local_browser_agent`, and the regex heuristics that preserve those tools on likely local or browser turns.
- `mcp-tools/chatTools.js`
  Owns the normal chat tool allowlist, provider schema conversion, and server-side tool dispatcher.
- `server/routes/desktop.routes.js`
  Owns authenticated desktop model proxy endpoints and Bot task bridge endpoints.

### Electron host and browser surfaces

- `electron/main.cjs`
  Owns IPC registration, windows, WebContentsViews, agent tab creation, tab maps, session partitions, navigation policy, popup policy, permissions, browser visibility, and runtime initialization.
- `electron/preload.cjs`
  Exposes the privileged renderer-to-main agent API.
- `electron/agent-browser-preload.cjs`
  Exposes the restricted browser-tab bridge.
- `electron/agentRuntime.cjs`
  Is the 11,882-line orchestration god object.
  It owns agent records, routing, threads, worker dispatch, pending choices, abort generations, browser task integration, Bot integration, local integration, persistence, transcripts, monitor work, and final responses.
- `electron/ownedBrowserAct.cjs`
  Is the 12,759-line low-level browser implementation and snapshot/interaction compatibility layer used by current agent paths.
- `electron/browserAct.cjs`
  Is a separate 1,306-line browser actuation abstraction still present in the architecture.
- `electron/localSystem.cjs`
  Owns local filesystem, shell, app, and desktop operations plus path and risk enforcement.
- `electron/localAgentTask.cjs`
  Owns a separate LLM-driven local-computer loop.
- `electron/localToolApproval.cjs`
  Owns main-issued, argument-bound, expiring, single-use local approval tokens.

### Modular browser-agent

- `electron/browser-agent/index.cjs`
  Owns the 1,787-line browser run state machine, approval pause, completion guards, retry progression, replanning, checkpoint callbacks, and final result.
- `electron/browser-agent/runtime/instructions.cjs`
  Loads and caches runtime markdown from explicit paths.
- `electron/browser-agent/runtime/contextRouter.cjs`
  Selects skills and builds planning, decision, verification, and learning systems.
- `electron/browser-agent/runtime/planner.cjs`
  Creates and revises plans through structured model calls.
- `electron/browser-agent/runtime/executor.cjs`
  Calls the decision model, validates actions, classifies consequence risk, and checks whether an approved user ask authorizes delivery.
- `electron/browser-agent/runtime/verifier.cjs`
  Performs deterministic and model-based action verification.
- `electron/browser-agent/runtime/taskState.cjs`
  Owns canonical in-run browser state and serialization.
- `electron/browser-agent/runtime/recovery.cjs`
  Chooses recovery strategy from failures.
- `electron/browser-agent/runtime/deadEnd.cjs`
  Detects repeated or exhausted paths.
- `electron/browser-agent/runtime/visionPolicy.cjs`
  Controls screenshot escalation.
- `electron/browser-agent/runtime/grounding.cjs`
  Grounds described targets into coordinates through a vision model.
- `electron/browser-agent/runtime/memory.cjs`
  Loads and persists browser-agent user and site memory.
- `electron/browser-agent/runtime/debugLog.cjs`
  Writes redacted per-task JSONL traces.
- `electron/browser-agent/runtime/model.cjs`
  Owns structured stage calls and schemas.
- `electron/browser-agent/runtime/batch.cjs`
  Restricts safe multi-action batches.
- `electron/browser-agent/runtime/timing.cjs`
  Provides optional stage timing.
- `electron/browser-agent/browser/controller.cjs`
  Maps browser-agent actions and snapshots onto the host browser API.
- `electron/browser-agent/browser/ownership.cjs`
  Owns the local user-versus-agent ownership flag.
- `electron/browser-agent/browser/snapshot.cjs`
  Normalizes snapshots and element references.

### Bot Harness

- `electron/bot-harness/index.cjs`
  Owns the Bot decide, select-tool, execute, observe, ask, recover, and deliver loop.
- `electron/bot-harness/runtime/contextRouter.cjs`
  Builds Bot identity, task, event, tool-index, and output-contract context.
- `electron/bot-harness/runtime/toolRegistry.cjs`
  Defines the Bot-level tool index and progressive documentation loading.
- `electron/bot-harness/runtime/taskState.cjs`
  Owns Bot run events, loaded documents, execution count, recovery count, guidance, and brief.
- `electron/bot-harness/runtime/instructions.cjs`
  Explicitly loads Bot runtime markdown.

### Model/provider boundary

- `lib/agentModelProviders.js`
  Owns provider-agnostic structured calls, provider schema conversion, API-key lookup, and server desktop proxy calls for plan, decide, verify, learn, route, bot route, and grounding stages.
- `server/routes/desktop.routes.js`
  Resolves the requested stage, provider, model, entitlement, session, usage logging, and response for Electron agent calls.
- `src/lib/agentSkillClassifier.cjs`
  Provides a structured model classifier for top-level skill selection.
- `src/lib/agentIntentInterpreter.cjs`
  Provides structured interpretation for ambiguous user asks.
- `src/lib/browserTaskRouter.cjs`
  Provides model and heuristic browser-route decisions.
- `src/lib/agentToolVenues.cjs`
  Heuristically identifies named external product venues.
- `src/lib/agentWorkDestination.cjs`
  Heuristically identifies where the requested work should land.

## Runtime prompt inventory

Token estimates use approximately 1.33 tokens per English word.
Generated schemas, JSON punctuation, URLs, DOM text, and code can tokenize less efficiently.

### Browser-agent markdown corpus

- `electron/browser-agent/AGENTS.md`
  - Size: 583 words, about 780 tokens.
  - Loader: `browser-agent/runtime/instructions.cjs:loadAgentsMd`.
  - Consumer: `runtime/contextRouter.cjs`.
  - Scope: every planning and decision system.
  - Purpose: identity, operating loop, evidence, completion, and prompt-file map.
- `electron/browser-agent/agent/core.md`
  - Size: 752 words, about 1,000 tokens.
  - Loader: `loadCoreInstructions`.
  - Consumer: planning and decision systems.
  - Purpose: identity, observe-decide-act-verify-update loop, plan flexibility, priorities, and termination.
- `electron/browser-agent/agent/browser.md`
  - Size: 3,743 words, about 5,000 tokens.
  - Loader: `loadBrowserRules`.
  - Consumer: decision systems only.
  - Purpose: observation, navigation, interaction, forms, editing, builders, tabs, downloads, recovery, and batches.
- `electron/browser-agent/agent/safety.md`
  - Size: 1,591 words, about 2,120 tokens.
  - Loader: `loadSafetyRules`.
  - Consumer: decision systems only.
  - Purpose: autonomous actions, approval boundaries, delivery, purchases, destructive actions, credentials, and sign-in handoff.

The decision-call markdown subtotal is 6,669 words, roughly 8,900 tokens.
Planning loads only `AGENTS.md`, `core.md`, and the shorter generated planning contract, not `browser.md`, `safety.md`, or full skill documents.
The decision subtotal excludes the generated output contract, JSON schema, task state, current snapshot, goal, conversation, memory, and skills.

### Browser-agent task-selected skill prompts

- `agent/skills/communication/SKILL.md`
  - 781 words, about 1,040 tokens.
  - Selected by keyword heuristics for communication work.
- `agent/skills/data-entry/SKILL.md`
  - 179 words, about 240 tokens.
  - Selected for forms and record entry.
- `agent/skills/research/SKILL.md`
  - 157 words, about 210 tokens.
  - Selected for browser research.
- `agent/skills/scheduling/SKILL.md`
  - 151 words, about 200 tokens.
  - Selected for calendar and booking work.
- `agent/skills/shopping/SKILL.md`
  - 157 words, about 210 tokens.
  - Selected for shopping.

Loader: `runtime/instructions.cjs:loadSkill`.

Router: `runtime/contextRouter.cjs:routeSkills`.

Consumer: decision systems for the full task.

The planner receives candidate skill names and available-skill metadata, not the full selected skill documents.

The router is regex/keyword heuristic, not embedding or model selection.

### Browser-agent memory prompt sources

- `agent/memory/user.md`
  - 39 words, about 50 seed tokens.
- `agent/memory/preferences.md`
  - 39 words, about 50 seed tokens.
- `agent/memory/websites/canva.com.md`
  - 458 words, about 610 tokens.
- `agent/memory/websites/mail.google.com.md`
  - 263 words, about 350 tokens.
- `agent/memory/websites/mailchimp.com.md`
  - 462 words, about 615 tokens.
- `agent/memory/websites/README.md`
  - 54 words and not a normal host prompt.

Loader: `runtime/instructions.cjs` through `runtime/memory.cjs`.

Consumers: planner and decision calls.

Scope: user memory across runs and current-host site memory.

Runtime additions live under `userData/browser-agent-memory`.

Site notes and user notes are deduplicated and capped at 24 entries per file.

### Browser-agent generated prompt sources

- `runtime/contextRouter.cjs:buildPlanningSystem`
  Adds `AGENTS.md`, `core.md`, and the planning contract.
- `runtime/planner.cjs:createPlan`
  Adds the goal, conversation, user memory, site memory, skill instructions, and initial snapshot.
- `runtime/planner.cjs:revisePlan`
  Adds current plan, completed work, failure/replan reason, constraints, and current page.
- `runtime/contextRouter.cjs:buildDecisionSystem`
  Adds the decision corpus, task-selected skills, platform note, action catalog, safety notes, and structured output contract.
- `runtime/executor.cjs:decideNext`
  Adds formatted task state, formatted recent history, current snapshot, recovery hint, verification, and optional screenshot.
- `runtime/contextRouter.cjs:buildVerificationSystem`
  Adds a verification rubric.
- `runtime/verifier.cjs`
  Adds before/after snapshots, action, expected outcome, deterministic signals, and optional images.
- `runtime/contextRouter.cjs:buildLearningSystem`
  Adds rules for extracting durable, non-secret user and site facts.
- `runtime/grounding.cjs`
  Adds a visual target description, screenshot, and coordinate schema.
- `runtime/model.cjs`
  Adds provider-specific structured-output schema descriptions for every stage.
- `agentRuntime.cjs`
  Enriches browser goals with route, product, destination, drafting, and completion instructions before the modular task sees them.

### Legacy browser prompt sources

The modular markdown corpus is not the only browser prompt architecture.

- `electron/agentRuntime.cjs:runAdaptiveBrowse` contains hardcoded goal interpretation, round budgets, status, legacy planner context, finish handling, and fallback instructions.
- `electron/agentRuntime.cjs` contains route, gap-check, summary, recovery, and worker prompts.
- `electron/ownedBrowserAct.cjs` contains hardcoded browser semantics and prompt-facing snapshot descriptions.
- `electron/browserAct.cjs` contains a separate adaptive browser abstraction for the external Chrome/Safari overlay path.
- `src/lib/agentSkillClassifier.cjs`, `src/lib/agentIntentInterpreter.cjs`, and `src/lib/browserTaskRouter.cjs` contain top-level model prompts.

These are runtime prompt sources even though they are JavaScript strings rather than markdown.

### Bot Harness markdown

- `electron/bot-harness/AGENTS.md`
  - 357 words, about 475 tokens.
  - Always loaded.
  - Defines Bot identity, LYKN promise, operating loop, and file map.
- `electron/bot-harness/agent/core.md`
  - 539 words, about 720 tokens.
  - Always loaded.
  - Defines reasoning, tool choice, instructions, asking, delivery, and narration.
- `electron/bot-harness/agent/safety.md`
  - 271 words, about 360 tokens.
  - Always loaded.
  - Defines consequence risk, delivery, data handling, honesty, and refusal.

The Bot always-loaded markdown subtotal is 1,167 words, roughly 1,550 tokens.

### Bot Harness progressive tool prompts

- `agent/tools/browser.md`
  - 234 words, about 310 tokens.
- `agent/tools/build_artifact.md`
  - 192 words, about 255 tokens.
- `agent/tools/edit_report.md`
  - 134 words, about 180 tokens.
- `agent/tools/generate_image.md`
  - 176 words, about 235 tokens.
- `agent/tools/local_computer.md`
  - 340 words, about 450 tokens.
- `agent/tools/reply.md`
  - 210 words, about 280 tokens.
- `agent/tools/research_report.md`
  - 210 words, about 280 tokens.

Loader: `bot-harness/runtime/instructions.cjs:loadToolDoc`.

Registry: `bot-harness/runtime/toolRegistry.cjs`.

Consumer: `bot-harness/index.cjs`.

Scope: the full selected tool documentation is loaded after first selection and remains in Bot task state.

This progressive disclosure is materially more token-efficient than the browser agent's always-loaded 3,743-word browser manual.

### Bot generated prompt sources

- `bot-harness/runtime/contextRouter.cjs`
  Builds persona identity, task brief, recent conversation, recent task events, tool index, loaded tool docs, guidance, and output schema.
- `bot-harness/index.cjs`
  Adds per-round results and recovery guidance.
- `agentRuntime.cjs:runBotHarnessTask`
  Builds the Bot task brief and host tool dispatch instructions.
- `agentRuntime.cjs` Bot route calls choose whether a prompt is task-shaped and whether Bot Harness should own it.

### Normal chat handoff prompt sources

- `server.js`
  Appends `[LOCAL MODE - ACTIVE]` and `[BROWSER AGENT - AVAILABLE]`.
- `mcp-tools/localTools.js`
  Supplies the `local_browser_agent` name, description, task semantics, and input schema.
- `chat-agent-loop.js`
  Supplies provider-native tool descriptors, tool results, continuation prompts, and hop behavior.
- The normal chat model's `task` argument becomes the browser agent's effective user request.

### `AGENTS.md` runtime loading and development-agent semantics

`electron/browser-agent/AGENTS.md` is loaded by explicit code:

1. `browser-agent/runtime/instructions.cjs` resolves the browser-agent root.
2. `loadAgentsMd()`, `loadCoreInstructions()`, `loadBrowserRules()`, and `loadSafetyRules()` read the four files separately.
3. The file text is cached in memory.
4. `runtime/contextRouter.cjs` injects `AGENTS.md` and core into planning, and all four files into decision systems.

`electron/bot-harness/AGENTS.md` is loaded similarly:

1. `bot-harness/runtime/instructions.cjs` resolves the Bot Harness root.
2. `loadAgentsMd()`, `loadCoreRules()`, and `loadSafetyRules()` read the three files separately.
3. The file text is cached.
4. `bot-harness/runtime/contextRouter.cjs` injects it into Bot decision systems.

The repository root `AGENTS.md` is not loaded by either runtime loader.
It is intended for development agents.

The naming collision still matters because development agents commonly discover `AGENTS.md` hierarchically.
A development agent editing `electron/browser-agent/**` or `electron/bot-harness/**` can interpret the nested runtime identity and behavior as development instructions in addition to the root development instructions.
The runtime files therefore have two accidental consumers with different semantics.
This can cause instruction conflict, unusual coding-agent behavior, and unsafe confusion about whether phrases such as "finish what you start" or "operate the browser" govern code changes.

Runtime prompt files should eventually have names and locations that are not development-agent instruction sentinels.
That is a redesign boundary, not a change made by this audit.

### Prompt duplication

The browser `AGENTS.md` and `core.md` both define identity, the loop, evidence, completion, asking, and recovery.

`core.md` and `safety.md` both define when to stop, what requires approval, and how to handle outbound actions.

`browser.md` and `safety.md` both define forms, committing controls, retry rules, and handoff.

The generated decision contract repeats action semantics already stated in `browser.md`.

The JSON schema descriptions repeat fields explained in the generated output contract.

Code-level regex policy repeats natural-language safety policy.
The duplication is partly defense in depth, but it creates drift because the code, schema, and prose do not share one generated policy source.

The Bot `AGENTS.md`, `core.md`, and generated output contract repeat tool selection, evidence, completion, narration, and delivery rules.

The normal chat handoff repeats browser capability and routing guidance in both the tool description and the server system prompt.

The host-enriched browser goal can repeat completion and destination instructions already present in the runtime corpus.

## Context construction

### Modular browser decision context

Every decision can include:

- Approximately 8,900 tokens of always-loaded markdown.
- A generated action and safety contract.
- A provider JSON schema.
- The full current goal.
- The planner-generated success condition and `doNot` rules.
- Plan steps and completion flags.
- Current constraints.
- Current open step.
- Working facts.
- Recent actions and observed outcomes.
- Last verification.
- Recovery or replan guidance.
- Chosen skill documents.
- User memory.
- Current-host site memory.
- Current URL, title, tabs, visible text, and interactive elements.
- A screenshot when visual policy escalates.
- Recent conversation history.

The dominant variable contributor is the page snapshot.
The dominant fixed contributor is the always-loaded browser markdown.
Including the generated decision contract, platform note, separators, and zero to two selected skills, the assembled stable decision system is approximately 11,600 to 12,800 tokens before the per-round user message.

### Bounded and potentially growing context

The modular browser state intentionally caps recent actions, facts, conversation slices, site memory notes, and user memory notes.
The audit did not find a model-facing list that grows without any cap in the modular loop.

The problem is repeated bounded context, not currently unlimited context.
The same large fixed corpus and mostly unchanged task state are sent again on every round.

The task goal itself can be large because it may contain a model-composed handoff, attachments, draft text, and host-added instructions.
Long page snapshots and screenshots can dominate a round.

Bot events, loaded tool docs, and recent conversation are also bounded, but the selected tool documentation remains loaded on later rounds.

Normal chat maintains a capped recent thread plus conversation summary, workspace context, attachments, memory, and tool schemas.
Its browser handoff loses that structured context and replaces it with one model-written string.

### Caching and summarization candidates

Without prescribing an implementation, the current architecture exposes these clear opportunities:

- Cache or provider-cache the immutable browser core corpus.
- Separate invariant tool semantics from round-specific state.
- Send only changed browser observations when safe.
- Keep an explicit compact task ledger instead of repeatedly rendering prose state.
- Summarize older action evidence into verified facts.
- Preserve the original user request and structured constraints across the chat-to-browser handoff.
- Avoid resending site memory when the host has not changed.
- Avoid strong-model verification when deterministic verification is conclusive.
- Avoid a second planning call for atomic one-action tasks.

## Token/cost map

### Call classification

#### REASONING CRITICAL

- Complex initial browser planning with ambiguous constraints.
- Browser decisions on unfamiliar, stateful, or visually opaque pages.
- Replanning after meaningful environmental change.
- Final evaluation of a consequential or multi-party result when deterministic evidence is insufficient.
- Bot orchestration across genuinely different tools with dependent outputs.

These calls deserve the strongest model available when task risk or ambiguity warrants it.

#### NORMAL

- Ordinary browser next-action selection on clear accessible pages.
- Bot delivery drafting.
- Local-computer next-step selection after a clear tool result.
- Browser final response wording after deterministic completion.

These calls do not uniformly require the strongest reasoning model.

#### ROUTING

- `classifyAgentSkill`.
- `decideBrowserRoute`.
- Bot task-shaped routing.
- Tool venue and work destination selection.
- Normal chat choice to call `local_browser_agent`.

These are prime candidates for a cheap, fast model such as Composer 2.5 or Grok 4.6, with deterministic shortcuts for obvious cases.

#### CLASSIFICATION

- Vague-intent interpretation.
- Action risk preclassification where used as an advisory signal.
- Visual-versus-DOM surface classification.
- Simple task complexity classification.

These should generally use a cheap model or deterministic features.
Security enforcement must not rely solely on the cheap model.

#### SUMMARIZATION

- Final browser narrative from already-verified history.
- Conversation summaries.
- Bot delivery from successful tool records.
- Memory fact extraction after a run.
- Chat board naming.

These are strong cheap-model candidates.

#### VERIFICATION

- Ambiguous before/after browser comparison.
- Bot tool-result verification.
- Artifact or report completion checks.

Verification needs a strong model only when evidence is ambiguous, visual, or consequential.
Clear URL, element, field value, file existence, tool status, and exact-output checks should remain deterministic.

#### MECHANICAL

- Schema repair.
- Output normalization.
- Target grounding on a clear screenshot.
- Tool index selection.
- Status narration.
- Formatting a delivery from structured facts.

These should use deterministic code or the cheapest adequate model.

### Approximate modular browser call shape

An initial run normally incurs:

1. Zero to several top-level route or interpretation calls.
2. One strong planning call.
3. One decision call per browser round.
4. Zero or one verification model call per acted round.
5. Optional vision-grounding calls after DOM targeting fails.
6. Optional replanning calls.
7. One learning call after qualifying runs.
8. Optional final host summarization or gap-check calls.

For a 10-action task, a plausible range is 12 to 25 model calls.
For a 20-action task with ambiguous verification, the range can exceed 30 calls.
Nested Bot-to-browser work adds Bot decisions and Bot verification around the browser calls.

### Current stage model policy

`lib/agentModelProviders.js:resolveAgentStageModel` currently resolves:

- `decide` to `BROWSER_AGENT_MODEL`, default `gpt-5.6-terra`.
- `plan` to `BROWSER_AGENT_PLAN_MODEL`, otherwise the same base model.
- `verify` to `BROWSER_AGENT_VERIFY_MODEL`, otherwise the same base model.
- `learn` to `BROWSER_AGENT_LEARN_MODEL`, default `gpt-4.1-mini`.
- `route` and `offer` to `BROWSER_AGENT_ROUTE_MODEL`, default `gpt-4.1-mini`.
- `judge` to `BROWSER_AGENT_JUDGE_MODEL`, default `claude-opus-5`.

The eval-arm path is different: its planner defaults to `claude-opus-5` so comparisons isolate the middle model.
The default reasoning effort is `low`.

### Largest cost drivers

1. The roughly 8,900-token browser decision corpus repeated on every decision, subject to provider prefix-cache behavior.
2. Large DOM/accessibility snapshots repeated each round.
3. Strong-model use as the default for plan, decide, verify, and Bot decide.
4. Separate planning and next-action calls even for atomic tasks.
5. Model verification after deterministic checks remain inconclusive.
6. Nested orchestration when Bot Harness selects browser or local-computer tools.
7. Multiple route/classifier calls before the actual agent loop.
8. Screenshots and visual grounding on canvas-heavy applications.
9. Replanning and retry loops caused by stale or ambiguous browser state.
10. Final summarization and learning calls after the work is already complete.
11. Bot progressive disclosure spends a model round the first time it selects each new tool before execution.

### Cheap-model opportunities

Composer 2.5 or Grok 4.6 should be evaluated for:

- Top-level skill routing.
- Browser route classification.
- Bot task-shaped routing.
- Atomic plan generation.
- Straightforward next-action selection on high-quality accessible snapshots.
- Memory extraction.
- Final delivery wording.
- Chat naming and status narration.
- Low-risk verification from concise structured diffs.

A stronger model should remain available for:

- Ambiguous multi-step plans.
- High-impact work.
- Visually opaque applications.
- Recovery after contradictory evidence.
- Cross-tool Bot orchestration.
- Final checks before irreversible effects.

The architecture should make this stage policy explicit.
Today model selection is distributed across server defaults, provider preferences, stage mappings, fallbacks, and caller choices.

### Metering and cost-observability gap

`server/routes/desktop.routes.js` logs browser stages as `browser_agent_<stage>`.

`src/lib/admin/aiCallCatalog.js` does not list `browser_agent_plan`, `browser_agent_decide`, `browser_agent_verify`, `browser_agent_learn`, or `browser_agent_route`.

The admin cost catalog can therefore omit or fail to classify the core Agent Harness spend even though the underlying usage is logged.

The catalog also still references deleted `userModelLearning.js` paths for legacy profile/fact-extraction surfaces, so its static inventory has drifted from the current worktree.

## Tool architecture

### Normal chat tools

Definitions live in `mcp-tools/**`.

`mcp-tools/chatTools.js` builds the exposed set, converts schemas for providers, and dispatches only allowlisted names.

`chat-agent-loop.js` supports OpenAI, Grok, Anthropic, and Gemini native tool calling.

The loop permits up to:

- 6 normal hops.
- 8 open-artifact edit hops.
- 28 coding hops.
- 40 through the explicit hard cap.
- 5 normal tool calls per hop.
- 8 coding tool calls per hop.

Local tools are not executed by the server.
They are emitted as `awaiting_client`, executed in Electron, and posted back to `/api/ai/local-tool-result`.

### Browser-agent actions

The browser action vocabulary is declared in the model schema and enforced again by `normalizeDecision`, batch policy, controller mapping, and low-level actuation.

Core actions include:

- Navigation and history.
- Tab open, switch, and close.
- Semantic click.
- Coordinate click.
- Type, paste, and replace text.
- Select.
- Scroll.
- Key press.
- Drag.
- Wait.
- Extract.
- Screenshot.
- Overlay dismissal.

The allowlist is stronger than free-form browser JavaScript from the model.
The model chooses a structured action, and deterministic controller code performs it.

The controller still delegates to a broad low-level implementation that can execute JavaScript and CDP operations inside the selected WebContents.

### Bot-level tools

Bot Harness exposes:

- `reply`
- `research_report`
- `edit_report`
- `build_artifact`
- `generate_image`
- `local_computer`
- `browser`

These are not the same registry as normal chat tools or browser actions.
They are high-level host capabilities.

The Bot registry is an index plus progressive markdown documentation.
The host implements each tool through `agentRuntime`.

### Local-computer tools

`electron/localSystem.cjs` implements:

- Directory listing.
- File read and search.
- File pull.
- File write.
- Exact file edit.
- Shell command.
- Synced-folder inspection.
- Running-app inspection.
- App content read.
- App launch.
- Path open.
- LYKN desktop organization.

`electron/localAgentTask.cjs` adds a separate model loop over these tools.

The normal chat path can also call these tools through `src/lib/ai/localToolExecutor.ts`.

The same capabilities therefore have at least two orchestration surfaces: normal chat and the Electron local task runner.

### Tool result handling

Normal chat appends tool results into provider-native message history and streams tool status to the renderer.

Browser agent converts actuation results into a fresh browser snapshot and verification record.

Bot Harness appends compact task events, optionally verifies results, and asks the Bot model for the next tool or final delivery.

AgentRuntime separately converts results into Studio live steps, deliverables, persisted history, and final messages.

There is no shared ToolResult envelope across these systems.

## Browser architecture

### Session and WebContents ownership

`electron/main.cjs` owns browser views and session partitions.

Non-incognito agent tabs use a shared persistent agent-browser partition.
This intentionally shares cookies and sign-in state across agents and child tabs.

Incognito agents use an owner-specific ephemeral partition.

Sub-tabs inherit the partition of their owner.

The host owns maps for agents, browser metadata, tab parentage, active tab, visibility, and incognito status.

The browser-agent controller receives a WebContents and host callbacks.
It does not create the session or view.

### Navigation boundary

`agentStageUrlAllowed` permits:

- Any `http://` URL.
- Any `https://` URL.
- `about:blank`.
- `lykn-artifact://`.
- `data:text/html`.

Other schemes are denied for agent-stage navigation.

There is no host/domain allowlist for ordinary web navigation.
The browser can reach localhost, private network addresses, and arbitrary public hosts through HTTP or HTTPS.

Popups are restricted to the same protocol policy and use sandboxed, context-isolated windows without Node integration.

OAuth popups share the agent session partition and preserve opener behavior.

### `browserAct`, `ownedBrowserAct`, and controller

`electron/browserAct.cjs` controls the front tab of external Chrome or Safari through AppleScript and physical/overlay interaction.
It is used by the command-overlay browser path, not by agent-tab modular browsing.

`electron/ownedBrowserAct.cjs` is the current broad browser implementation for snapshots and interactions.

`electron/browser-agent/browser/controller.cjs` adapts the modular agent's action schema to `ownedBrowserAct`.

This layering is not a clean one-directional abstraction.
The host, controller, and low-level browser module each know about action semantics, tabs, snapshots, visual state, and recovery.

### DOM inspection and snapshots

Snapshots include:

- Current URL and title.
- Tab list and active tab.
- Interactive elements with generated temporary references.
- Roles, labels, values, state, destinations, and embedded-frame annotations.
- Visible text.
- Overlay and dialog information.
- Visual opacity signals.

Element references are valid only for one snapshot.
`normalizeDecision` rejects a reference absent from the current snapshot.

Embedded-frame elements are resolved into the same reference space.

### Screenshots and vision

The normal path prefers structured snapshots.

`visionPolicy.cjs` escalates for canvas, SVG, opaque editors, contradictory snapshots, repeated failures, and explicit screenshot requests.

Screenshots can be attached to the decision model.

Holo-assisted targeting lets the decision model describe a target and a separate grounding stage return coordinates.

Coordinate actions are required for some visual surfaces, but their security classification depends partly on the model-written `action.label` and `expectedOutcome`.

### Interaction and verification

The controller maps semantic references to current elements and executes one meaningful action per round.

Safe navigation, waiting, scrolling, screenshot, and tab sequences can be batched up to six actions.

Targeted actions cannot be batched because element references become stale after state changes.

Verification compares before and after state for:

- URL changes.
- Element appearance or disappearance.
- Value changes.
- Text changes.
- Tab changes.
- Dialog changes.
- Loading and layout signals.

Opaque visual actions can require screenshot-based model verification.

### Browser ownership ambiguity

There are several ownership concepts:

- Main owns WebContentsViews and partitions.
- AgentRuntime owns the active run and generation.
- Browser task state owns logical progress.
- `browser/ownership.cjs` owns a local `"agent"`, `"delegated"`, or `"user"` state.
- WebContents input listeners detect user takeover.
- UI owns which tab is visible and active.

These are coordinated by callbacks and mutable maps rather than one lease object.

The ownership helper is created for a controller/run, while the browser view survives across runs.
The durable browser surface and ephemeral logical ownership therefore have different lifetimes.

## Bot Harness

Bot Harness is an orchestrator above host capabilities, not a replacement for browser-agent.

It has its own:

- Identity prompt.
- Task state.
- Decision schema.
- Tool registry.
- Retry and recovery counters.
- Ask/deliver completion states.
- Narration.

When it chooses `browser`, the host parks `pendingBotBrowse` and asks the user to opt in.
After a positive answer, `botBrowserRun` re-enters the host browse pipeline.
The configured modular or legacy browser runtime then performs its own planning, decision, safety, verification, retry, memory, and completion loop.

When it chooses `local_computer`, the host invokes the separate local-computer agent loop.

This yields nested planning and nested completion:

1. Bot decides what capability should act.
2. Browser selection pauses for a separate capability opt-in.
3. Child capability decides how to complete its brief.
4. Bot evaluates the child result.
5. Bot decides whether the overall task is done.

Progressive tool documentation is a strong design.
The competing Task and completion abstractions are not.

## Completion architecture

### Modular browser completion signals

The decision model can emit:

- `finish`
- `ask_user`
- `replan`
- `act`

The planner creates:

- Plan steps.
- Constraints.
- `successCondition`.
- `doNot`.

The task state records:

- Step completion.
- Facts.
- Recent actions.
- Retry count.
- Round.
- Status.
- Completion reason.

The loop accepts completion only after several guards:

- `finish` must contain an answer.
- There must be substantive evidence or a valid non-action result.
- Open plan steps trigger pushback or explicit accounting.
- Consequential-action completion has special handling.
- Repeated finish-without-evidence attempts are bounded.
- Certain task shapes have additional completion heuristics.
- Maximum rounds terminate exhausted work.
- Abort signals terminate canceled work.
- Model unavailability and hard failure return failure.

The modular browser default is 24 rounds.
Successful user unblocks add six rounds at a time, capped at 30 extra rounds above the starting budget.
The recovery layer allows two same-action retries and six total recoveries, with progress able to decay the total.
Per-stage model calls use a 90-second timeout and retry once on selected transient HTTP failures.

On accepted completion, the host sets `agent.verifiedComplete = true`.
This suppresses a downstream legacy gap checker that previously restarted already-completed work.

### What completion does not do

The runtime does not compile the original request into a deterministic success predicate and evaluate it at the end.

The planner's `successCondition` is model-authored.

The executor deciding `finish` is a model.

The evidence guard checks that useful evidence exists, but generic evidence is not proof that every requested constraint is satisfied.

Plan steps are also model-authored and mutable.

Replanning can replace steps and constraints.

The final answer can therefore be internally consistent with the current model-authored plan while diverging from the original user's intended boundary.

### Bot completion

Bot Harness completes when the Bot model emits `deliver`.

It has event history and tool-result evidence, but no machine-evaluated success contract.

The prompt instructs the Bot to deliver only when done.
That is a behavioral instruction, not an independent completion authority.

The Bot loop has execution and recovery limits that can force partial delivery or failure.
Its default budget is 12 rounds with two recoveries.

### Local-computer completion

The local agent model decides whether to call another tool or return a final answer.

Risky actions can pause for approval.

The host enforces round limits and abort generation.

There is no shared task contract with browser or Bot completion.

### Normal chat completion

`chat-agent-loop.js` stops when the provider returns final text with no more tool calls or when hop limits are reached.

The `local_browser_agent` handoff completes immediately from the normal chat loop's perspective.
The browser task continues independently.

The user can therefore receive a completed chat turn while the actual requested work is still running, waiting, failed, or canceled in another subsystem.

### Why agents may over-execute

1. Runtime prompts repeatedly say "finish what you start," "never hand it back," and "anything else: keep working."
2. Completion is prioritized above efficiency in `core.md`.
3. The model may interpret the requested outcome broadly and then create a broad plan.
4. `successCondition`, `doNot`, and constraints are generated by the same planner expected to pursue them.
5. The original request is not an immutable structured authority during replanning.
6. Plans are explicitly guidance and can be reordered, skipped, or replaced.
7. Replanning can drop constraints when the decision model says they no longer apply.
8. The action gate primarily blocks consequential effects, not unnecessary low-risk edits or navigation.
9. The host enriches goals with completion and destination instructions that can amplify autonomy.
10. The normal chat handoff rewrites the user's conversation into a self-contained task and can accidentally add scope.
11. Long multi-step regexes increase round budgets from 18 to 36 and permit up to 48.
12. Nested Bot-to-browser execution introduces two agents that can each expand a brief.
13. Generic evidence can satisfy a finish guard without proving the narrow original intent.
14. Legacy fallback paths have different completion heuristics and can second-guess or restart modular work.

## Scope-control architecture

### Explicit scope that exists

The modular browser task explicitly stores:

- `goal`
- `successCondition`
- `doNot`
- `constraints`
- Plan steps.
- Current step.
- Conversation history.
- Facts and recent actions.

The safety layer independently limits:

- Money.
- Destructive actions.
- Outbound deliveries.
- Missing message substance.
- Missing recipients.
- Credentials.

The low-level browser action schema limits what the model can directly request.

### Missing authoritative scope

The task does not preserve separately:

- The exact original user utterance.
- A canonical normalized requested action.
- Required outputs.
- Explicitly allowed side effects.
- Explicitly forbidden side effects.
- Machine-testable success criteria.
- A maximum autonomy or exploration budget.
- A set of resources the task may modify.
- A deterministic completion contract.

`userAsk` is preserved separately for consequence authorization, which is good.
It is not the authoritative source for general scope or final completion.

The browser goal may contain caller-added instructions.
The planner then infers the rest.

### Handoff scope loss

The normal chat agent sees the conversation and produces `local_browser_agent.task`.

The browser agent sees only that task plus what the host later supplies.

Any omitted recipient, exact wording, "draft only" constraint, prior correction, or scope limit can be lost.

Conversely, the chat model can add a route, deliverable, or implied action that the user did not request.

This handoff should be treated as delegation with provenance, not as a new authoritative user message.

## Memory

### Browser-agent durable memory

`runtime/memory.cjs` reads seed user and preference markdown.

Runtime-learned user facts are written under:

- `userData/browser-agent-memory/user.md`
- `userData/browser-agent-memory/preferences.md`

Website facts are written under:

- `userData/browser-agent-memory/websites/<host>.md`

Site lookup includes parent-domain seed playbooks but learned notes are exact-host.

Notes are deduplicated and capped at 24 entries.

Secret-shaped facts are rejected by regex.

The learning stage can extract user facts and website notes after a run.

### Browser working memory

Working facts, plan, constraints, recent actions, retries, and conversation live in `runtime/taskState.cjs`.

Serialized task checkpoints support continuation after pause or restart.

### Host and Bot memory

`agentRuntime` persists agent records, history, task metadata, live steps, and selected browser checkpoint state.

Bot renderer state persists profile, queue, chat, and task records separately.

Bot Harness itself holds compact per-run events and loaded docs.

Normal LYKN chat has its own conversation memory and summary system.

These memory systems are not unified and do not share provenance or retention semantics.

## Security architecture

### Browser consequence approval

The modular loop classifies money, destruction, and outbound delivery independently of the model's declared `risk`.

For reference-based actions, the classifier reads the current snapshot element label.

For coordinate and visually grounded actions, it may rely on model-written labels and expected outcomes.

The loop pauses before actuation and calls the host approval callback.

The host creates a pending choice with a random ID and surfaces Yes/No controls.

Only a resumed send marked `sendPolicy: "approved"` can bypass a second outbound prompt.

Money and destructive actions always require interactive confirmation.

The raw `userAsk`, not the enriched goal, is used for authorization.
This prevents caller-added "send" text from self-authorizing a delivery.

### Local tool approval

Reads require a one-time renderer-session grant when invoked from normal chat.

Writes, edits, unknown tools, and risky shell commands require per-action approval.

`localToolApproval.cjs` issues 256-bit random tokens that are:

- Minted in main.
- Bound to normalized tool name and arguments.
- Single-use.
- Expiring after two minutes.

This closes renderer-supplied `approved: true` forgery and token replay.

It does not prove that a human clicked Approve.
The source file explicitly records that a compromised privileged renderer can round-trip a token.

### Filesystem and shell boundary

The local system reads Local Mode configuration.

When `syncAll` is false, filesystem calls are limited to user-synced folders, with more-specific exclusions winning.

When `syncAll` is true and no exclusions exist, all paths accepted by the tool remain reachable.

The default configuration is compatibility-oriented and can effectively expose the home folder.

Shell commands run through `/bin/zsh -lc`.

An allowlist recognizes read-oriented commands.

Regexes classify writes, installs, process control, Git mutation, redirection, package changes, and unknown commands as risky.

The command classifier is a gate to approval, not a sandbox.
After approval, the shell has the Electron app user's OS authority.

### Trusted sender validation

Browser-home privileged IPC validates the exact packaged document identity with `agentHomeIdentity`.

Remote browser pages cannot pass that exact URL check.

OAuth popup windows use:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`

The normal app preload exposes broad privileged APIs to the app renderer.
Approval integrity therefore depends on the integrity of that renderer.

### Browser restrictions

Navigation blocks non-HTTP schemes except explicit app/artifact/data cases.

It does not limit HTTP/HTTPS hosts or private network ranges.

Agent tabs share persistent cookies unless incognito.

Downloads are constrained mainly by prompt policy and browser implementation checks.

Credentials are supposed to remain in existing browser sessions and must not enter task state, prompts, memory, or logs.

### Debug redaction

`runtime/debugLog.cjs` redacts sensitive keys and common credential shapes, bounds string length, bounds object depth, and avoids hidden reasoning.

Regex redaction is defense in depth, not a proof that all private data is removed.
Ordinary private page content can still appear in observable snapshots and trace fields when it does not look like a secret.

## Failure/retry architecture

### Modular browser failure handling

- Abort signals are checked throughout the loop.
- Host generation changes invalidate old results.
- Model unavailability is distinguished from ordinary model errors.
- Action normalization catches malformed output before actuation.
- Controller failures produce fresh observations.
- Deterministic verification runs before model verification.
- Recovery checks whether an apparently failed action actually succeeded.
- It searches for renamed or moved semantic targets.
- It escalates from DOM references to screenshot and visual grounding.
- It retries an essentially identical operation at most twice.
- It replans when the route is invalid.
- It stops when recovery and replanning are exhausted.
- Maximum rounds bound total autonomy.
- Serialized checkpoints allow continuation after user action or restart.

### Browser failure modes

- Stale element references.
- Overlay interception.
- Navigation timeout.
- Auth wall.
- CAPTCHA or paywall.
- Canvas or iframe opacity.
- Missing target.
- Inconclusive verification.
- User takeover.
- Consequential action awaiting approval.
- Model outage or malformed structured output.
- Grounding failure.
- Repeated no-progress action.

### Bot failure handling

Bot Harness records tool errors as events.

It can recover, choose another tool, ask the user, or deliver a partial failure.

Execution and recovery counters cap the loop.

A child browser or local run can return stuck, waiting, failed, or partial results.

Bot must interpret those results correctly through its own model decision.

### Normal chat failure handling

`chat-agent-loop.js` has provider-specific retries and fallbacks.

It retries truncated streams once.

Deep research can continue up to three times when output appears incomplete.

Tool calls are deduplicated and capped per hop.

Provider failure can fall back through server routing.

The local client post-back can time out after network failure.

The asynchronous browser handoff does not propagate later browser failure into the original chat turn.

### Cancellation

Normal chat has a renderer `AbortController`.

Electron agents use generation counters and run abort state.

Browser task state also consumes an abort signal.

Bot API tasks and renderer Bot tasks have their own status and follow behavior.

There is no single cancellation token spanning normal chat handoff, new Electron agent, nested Bot, browser child task, and local child task.

## Observability

### Existing observability

- `browser-agent/runtime/debugLog.cjs` writes per-task redacted JSONL under `userData/browser-agent-logs`.
- Browser debug events include goal, plan, skills, actions, expected outcomes, observed outcomes, verification, retry, replan, and completion reason.
- `LYKN_AGENT_DEBUG=1` mirrors compact events to the console.
- `agentRuntime` records per-stage model call count, input tokens, output tokens, and upstream latency in `agent.lastModelUsage`.
- `diagnostics.cjs` records route decisions and runtime fallbacks.
- Studio receives `lykn:agent-delta`, agent state, choices, and final events.
- Live steps and step deliverables render a user-facing work transcript.
- Browser action history is converted into legacy-shaped records for host summaries.
- Normal chat exposes tool calls and statuses in SSE and renderer message state.
- Bot tasks expose queue/running/done/failed state and can be followed after reattachment.
- Serialized browser task state provides a checkpoint suitable for debugging.

### Observability gaps

- No end-to-end correlation ID spans normal chat, `local_browser_agent`, created Electron agent, browser task, and final result.
- No unified trace spans Bot decision, child browser/local task, and Bot delivery.
- Multiple logs and state stores use different event schemas.
- User-facing transcript steps are sanitized summaries, not the authoritative execution record.
- Model usage is attached to the agent record but not consistently connected to the originating chat or Bot task.
- Route decisions are spread across server logs, diagnostics, and runtime state.
- Approval events do not form a single auditable ledger across browser and local tools.
- Legacy and modular browser paths report different histories and completion evidence.

## State ownership

### Threads

- Normal chat thread: renderer chat state, server prompt history, and conversation memory.
- Studio agent thread: `agentRuntime` history and renderer Agent Rail projection.
- Bot thread: renderer Bot store and server Bot records.
- Browser task conversation: a bounded copy inside browser task state.

### Tasks

- Normal chat turn: `chat-agent-loop.js` hop state.
- Agent work item: mutable `agentRuntime` agent record.
- Modular browser task: `runtime/taskState.cjs`.
- Bot task: renderer/server Bot task plus Bot Harness state.
- Local task: `localAgentTask.cjs` loop state.
- Monitor task: `agentRuntime` monitor state.

### Runs

`agentRuntime` owns active generation and most Electron run lifecycles.

The modular browser loop owns browser rounds inside that host run.

Bot Harness owns Bot rounds and invokes child runs.

Normal chat owns provider hops but not the browser run it starts.

### Browser sessions

`electron/main.cjs` owns partitions, WebContentsViews, tabs, popups, and session permissions.

AgentRuntime owns which worker is associated with which browser surface.

Controller owns the logical action interface.

### State

The same progress is represented in:

- Agent record fields.
- Browser task state.
- Browser debug log.
- Legacy-shaped browser history.
- Live output steps.
- Step deliverables.
- Renderer Agent Rail state.
- Persisted agent file.

These copies serve different purposes but can drift.

### Abort

- Renderer chat abort controller.
- AgentRuntime generation.
- Browser loop abort signal.
- User-input takeover listener.
- Bot task status/cancellation.
- Server request timeout.

### Retries

- Provider retry and fallback.
- Chat truncated-stream retry.
- Browser action retry.
- Browser verification retry.
- Browser visual grounding retry.
- Browser replan.
- Bot recovery.
- Local model rounds.

Each subsystem owns its own retry budget.

### Continuation

- Provider tool loop continues on tool results.
- Browser continues from task state.
- Browser can resume after choice, sign-in, or restart.
- Bot continues from compact events.
- Normal chat does not continue with the browser task it spawned.

### Completion

- Chat model final text completes a normal chat turn.
- Browser model plus loop guards complete a browser task.
- Bot model `deliver` completes Bot Harness.
- Local model final text completes a local task.
- AgentRuntime maps each child completion into agent and UI state.

There is no shared completion authority.

## Duplication

### Competing agent abstractions

- Normal chat tool agent.
- Studio agent host.
- Modular browser agent.
- Legacy adaptive browser agent.
- Bot Harness.
- Local-computer agent.
- Monitor/scheduled agent.
- Custom-model/subagent infrastructure outside this Electron harness.

### Duplicate routing

- Server enrichment and tool-preservation regexes.
- Normal chat model tool selection.
- AgentRuntime regex skill classification.
- AgentRuntime model skill classification.
- Browser task router.
- Tool venue matcher.
- Work destination matcher.
- Bot route model.
- Browser-agent skill regex router.

### Duplicate browser semantics

- `browserAct.cjs`.
- `ownedBrowserAct.cjs`.
- Modular controller.
- Modular browser markdown.
- Legacy browser prompts in AgentRuntime.
- Risk and completion regexes in multiple modules.

### Duplicate state

- Browser task history and legacy host history.
- Browser plan and UI live steps.
- Agent status and Bot task status.
- Pending choice and waiting task state.
- Browser ownership flag and host input listeners.
- Persisted agent record and serialized browser checkpoint.

### Duplicate prompts

- Runtime identity and completion across `AGENTS.md` and `core.md`.
- Safety rules across markdown, output contracts, schema descriptions, and regex code.
- Browser availability across server system prompt and tool description.
- Bot capability semantics across tool index, tool markdown, host dispatch prompt, and child harness prompts.

## Major architectural problems

### CRITICAL

#### C1. Human approval is not an independent trust boundary

The local-tool token implementation is well designed against forgery and replay.
However, the privileged renderer that requests the action can also return the token.
The code explicitly notes that renderer compromise can bypass the human.
Because approved local commands run with the user's OS authority, this is a critical trust-boundary gap.

Browser approval is also surfaced and resolved through privileged renderer IPC.
The redesign must decide whether renderer compromise is in scope and, if so, place human authorization in a separately attested boundary.

#### C2. No canonical task authority survives delegation

The original user request can be rewritten by the normal chat model into `local_browser_agent.task`.
That string becomes the browser agent's authoritative goal.
There is no preserved immutable request, constraint provenance, or parent-child task contract used for final acceptance.
This creates a critical integrity risk for actions performed in signed-in accounts.

#### C3. Runtime fallback changes browser safety and completion semantics

A transient modular model-endpoint failure can fall back to `executeOwnedAdaptiveTask`.
The legacy loop has different planning, verification, completion, multi-outcome, and approval behavior.
A reliability fallback therefore changes the policy governing the same authorized task rather than only changing implementation availability.

### HIGH

#### H1. `agentRuntime.cjs` is a god object

At 11,882 lines, it owns routing, agents, workers, browser integration, local work, Bot work, approvals, persistence, transcripts, monitor behavior, finalization, and compatibility paths.
Changes in one behavior can affect unrelated runtimes.

#### H2. Browser actuation is dominated by another god object

`ownedBrowserAct.cjs` is 12,759 lines.
It combines observation, accessibility extraction, interaction, visual behavior, tabs, browser compatibility, and site-specific recovery.

#### H3. Completion is not checked against an immutable contract

The planner, actor, replanner, and finisher all participate in defining what "done" means.
Generic evidence and mutable plan accounting can diverge from the user's narrow request.

#### H4. Consequence detection is heuristic

Risk depends on regexes over labels and model-written expected outcomes.
Coordinate clicks can depend on model-written action labels.
False negatives can execute an irreversible action without approval.
False positives can interrupt ordinary work and train users to approve reflexively.

#### H5. Multiple runtime loops compete

Modular browser, legacy browser, Bot, local, normal chat, and monitors have different state, tool, retry, completion, and model policies.
Fallback between them is behaviorally meaningful and difficult to reason about.

#### H6. Normal chat and browser completion are disconnected

The chat tool returns success when the browser task starts.
Later failure, approval wait, or cancellation is not reflected in the originating turn.

#### H7. Cancellation is not transitive

Stopping the parent chat or Bot task does not inherently cancel every delegated child.
A child can outlive the context that authorized it.

#### H8. Shared persistent browser partition broadens authority

All non-incognito agents share authentication state.
Any agent that can navigate to a signed-in service can act with that account's session.
This may be an intended product behavior, but it must be explicit in the security model.

### MEDIUM

#### M1. Browser prompt bloat

Roughly 8,900 fixed markdown tokens precede dynamic decision context.
Most of those tokens repeat on every round.

#### M2. Too many strong-model calls

Routing, planning, deciding, verification, replanning, learning, and finalization can all use strong models.
Many calls are classification, summarization, or mechanical.

#### M3. Nested orchestration duplicates reasoning

Bot Harness plans tool use, then browser or local agents plan again, then Bot verifies and delivers.

#### M4. Mixed heuristic and model routing is hard to predict

Regexes decide whether tools are present, model calls choose routes, and host fallbacks can override or reinterpret outcomes.

#### M5. State is copied into many projections

Browser task state, host history, UI steps, deliverables, and persisted agents can disagree after partial failures.

#### M6. Runtime prompt policy and code policy can drift

Safety and completion semantics are repeated in markdown, generated contracts, schemas, and regexes.

#### M7. Browser ownership is a coordinated convention, not one durable lease

The view, host run, controller flag, input listeners, and UI active tab have different owners and lifetimes.

#### M8. Navigation policy permits arbitrary HTTP/HTTPS destinations

There is no explicit private-network or host policy.
This is broader than the product-level description of operating ordinary websites.

#### M9. Model policy is distributed

Stage defaults, provider preferences, server fallback, user selection, and nested tool calls make actual cost and capability hard to predict.

#### M10. Observability is fragmented

There is no unified task graph or cost trace across handoffs and nested runs.

#### M11. Browser-agent spend is absent from the static AI cost catalog

The live usage logger emits `browser_agent_*` action types, but `AI_SURFACES` does not map them.
Admin cost views can miss the dominant stage-level Agent Harness spend.

#### M12. Bot browser selection is a parked two-stage state transition

The Bot Harness browser executor records `pendingBotBrowse` instead of executing.
A later answer mutates `botBrowserRun` and re-enters host routing.
That implicit bridge can desynchronize Bot task state, pending choice state, browser child state, and the eventual consequence approval.

#### M13. The documented three-state browser ownership model is only partly wired

The ownership module defines `"delegated"` for agent-initiated handoff.
Production takeover currently moves only between `"agent"` and `"user"`, leaving `handOff()` and `takeOver()` unused.
The implemented lifecycle therefore differs from the ownership abstraction's documented contract.

### LOW

#### L1. Runtime `AGENTS.md` names collide with development-agent conventions

The collision can make coding agents interpret runtime identity prompts as repository instructions.

#### L2. Prompt file comments describe historical architecture

Some prompt text explains past routing failures.
That history consumes runtime tokens without directly guiding the current action.

#### L3. User-facing transcript is derived twice

Browser history is converted to legacy shape and then to live steps and deliverables.
This creates avoidable formatting and drift risk.

#### L4. Status narration uses model output where deterministic labels often exist

This is a small but recurring cost and consistency issue.

## What currently works well

- Browser actions are structured rather than arbitrary model code.
- Element references are snapshot-scoped and validated.
- The runtime observes again after state-changing actions.
- Deterministic verification runs before model verification.
- The recovery ladder checks for quiet success before retrying.
- Same-operation retries are bounded.
- Batch execution is narrowly restricted to target-free mechanical actions.
- Consequential actions pause before actuation.
- Authorization checks use raw `userAsk`, not host-enriched instructions.
- Local approval tokens are random, argument-bound, expiring, and single-use.
- Filesystem access has a synced-folder allowlist model.
- Browser task state can be serialized and restored.
- Debug logs are structured and redact common secrets.
- Per-stage usage and latency are already measured.
- Browser site memory is capped and rejects secret-shaped notes.
- Bot tool docs use progressive disclosure.
- Provider-specific structured-output adaptation is centralized.
- User takeover is treated as a first-class browser event.
- The browser remains the source of truth after user handoff or restart.
- The controller blocks coordinate actions when viewport dimensions drift by more than its layout threshold and forces a re-observation.

## What should be preserved

- Structured action schemas.
- Deterministic controller execution.
- Fresh-snapshot reference validation.
- Deterministic-first verification.
- Pre-actuation approval.
- Raw-user-request separation for authorization.
- Argument-bound approval tokens.
- Browser checkpoint serialization.
- Bounded retry and round budgets.
- User takeover and resumable handoff.
- Layered DOM then screenshot then grounding observation.
- Secret-aware structured trace logging.
- Per-stage usage metrics.
- Progressive tool documentation.
- Provider-agnostic structured model adapter.
- Explicit browser session and tab ownership in main.
- Site-specific durable knowledge that excludes selectors and secrets.

## What should probably be replaced

This section identifies replacement boundaries, not replacement designs.

- The monolithic ownership surface in `agentRuntime.cjs`.
- The monolithic browser implementation boundary in `ownedBrowserAct.cjs`.
- Parallel browser action abstractions.
- Model-written handoff strings as the only delegation contract.
- Independent Task objects for Bot, browser, local, and chat without a shared parent-child contract.
- Completion based primarily on mutable model-authored plan state.
- Regex-heavy routing distributed across server, renderer, and Electron.
- Strong-model defaults for routine routing and verification.
- Repeated full browser prompt corpus on every round.
- Runtime prompt files named `AGENTS.md`.
- UI transcript projections that also serve as runtime state.
- Non-transitive abort and approval ownership.
- Legacy browser fallback behavior that can second-guess modular completion.

## Questions requiring product/architecture decisions

These questions must be decided with the user.
This audit does not answer them.

### Task and scope

1. What exact object represents a user's authorized task?
2. Must the immutable original user message remain attached to every delegated child?
3. Which fields are user-authored, model-inferred, host-authored, or tool-discovered?
4. Should inferred success criteria require user confirmation for ambiguous tasks?
5. How should allowed side effects and forbidden side effects be represented?
6. Can a replanner remove a constraint, or may it only propose removal?
7. Should every child task have a strict subset of the parent's scope?
8. What should happen when the normal chat model omits information from a browser handoff?
9. Is "start the browser task" a successful chat tool result, or should the parent remain attached until terminal completion?

### Completion

10. Who has authority to declare a task complete: actor model, verifier, deterministic state machine, parent orchestrator, or a combination?
11. Which task classes require machine-testable success predicates?
12. What evidence is sufficient for completion on opaque visual surfaces?
13. Can the agent finish with open plan steps when the success condition is met?
14. Should completion be evaluated against the original request, current plan, or both?
15. How should partial success be represented without being mistaken for completion?
16. Should a parent Bot independently verify a child that already produced verified completion?

### Autonomy and approval

17. Does the initial user request authorize outbound delivery, or must every delivery receive a second confirmation?
18. Which actions count as consequential beyond money, deletion, and delivery?
19. Should account linking, permissions grants, subscription trials, and settings changes require approval?
20. Is a privileged renderer considered potentially compromised?
21. If yes, where must the trusted human-approval UI live?
22. Should approvals bind to a semantic effect, a concrete UI action, or both?
23. How should coordinate clicks be classified safely?
24. Should approvals expire when the page or target changes?

### Browser sessions

25. Should all agents share one persistent authenticated browser partition?
26. Should each task, Bot, project, or user context have a separate partition?
27. What is the intended policy for localhost and private-network navigation?
28. Who owns a browser tab when no task is running?
29. Can two tasks share one browser surface?
30. What should happen to a task when the user takes over and performs more than the requested handoff?

### Runtime architecture

31. Is Bot Harness the future top-level orchestrator, or one specialized persona layer?
32. Should browser and local-computer be tools under one harness or independent agent runtimes?
33. Which legacy browser paths must remain during migration?
34. Is planning mandatory for every task, or only tasks above a complexity threshold?
35. Should skills be static documents, executable policies, tool bundles, or all three with distinct types?
36. Should one registry define normal chat tools, Bot tools, browser actions, and local tools?
37. How should runtime prompts be versioned and tested?
38. Which state belongs in main, a runtime service, the server, or the renderer?

### Models and cost

39. What latency and cost budget applies to one browser action?
40. Which stages are permitted to use the strongest model?
41. Is model selection a product setting, a stage policy, or an adaptive runtime decision?
42. May a cheap model act on signed-in accounts if deterministic safety gates remain independent?
43. Should visual grounding use a dedicated vision model?
44. What percentage of outcomes should be deterministically verified before model verification is invoked?

### Observability and retention

45. What is the canonical task ID across chat, Bot, Electron, browser, approvals, and server usage?
46. How long should snapshots, screenshots, prompts, and action logs be retained?
47. Which trace data may contain private page content?
48. Should users be able to inspect and export the execution ledger?
49. What cost, model, prompt version, and tool version must be attached to every step?
50. What replay or simulation capability is needed for debugging?

## Candidate target principles

These are requirements suggested by current failure modes, not a final design.

1. One canonical Task object with immutable provenance.
2. Explicit requested action, outputs, success criteria, allowed scope, forbidden scope, and completion contract.
3. Parent-child delegation with subset scope and transitive cancellation.
4. One deterministic runtime state machine around model decisions.
5. One tool registry with typed capabilities, risk, input, output, and verification contracts.
6. Model output proposes actions but never defines its own authority.
7. Consequential effects are identified and authorized outside the actor model.
8. Approval is bound to the exact effect and current state.
9. Browser ownership is a durable lease with one owner and explicit takeover transitions.
10. Context is bounded, incremental, and cacheable.
11. Runtime prompts are separate from development-agent instructions.
12. Strong reasoning is reserved for ambiguity and risk.
13. Routing, summarization, and mechanical checks use cheap models or deterministic code.
14. Deterministic verification is preferred whenever the environment exposes a reliable signal.
15. Completion is independently evaluated against the original task contract.
16. Every run has one trace ID, event schema, cost ledger, and terminal state.
17. Checkpointing and resume are standard across browser, local, Bot, and nested tasks.
18. Partial success, waiting, canceled, declined, failed, and completed are distinct terminal or paused states.
19. UI state is a projection of runtime events, not a second source of truth.
20. Legacy and new runtimes have explicit migration boundaries and cannot silently fall back across semantics.

## Suggested redesign boundaries

These boundaries are suitable units for later architecture discussion.
They are not implementation steps.

### Boundary 1: task contract and task graph

Define the canonical request, provenance, constraints, success, side effects, parent-child delegation, lifecycle, and cancellation semantics.

### Boundary 2: orchestrator state machine

Separate deterministic lifecycle transitions from model planning and action proposals.

### Boundary 3: capability and tool registry

Unify capability metadata while allowing specialized executors for browser, local, report, artifact, image, and reply.

### Boundary 4: browser service

Give one service responsibility for session, tab, ownership lease, observation, actuation, stabilization, and deterministic evidence.

### Boundary 5: policy and approval service

Centralize risk classification, scope authorization, approval binding, expiry, sender trust, and audit records.

### Boundary 6: context and prompt service

Separate immutable runtime prompts, task context, memory, observation diffs, schemas, and provider caching.

### Boundary 7: model policy

Map each stage and risk level to an allowed model class, budget, timeout, and fallback.

### Boundary 8: verification and completion

Define evidence types, deterministic checks, semantic verification, partial success, and independent final acceptance.

### Boundary 9: event log and observability

Create one correlated event stream for route, model, tool, browser, approval, cost, checkpoint, cancellation, and completion.

### Boundary 10: migration adapters

Contain legacy `agentRuntime`, legacy browser paths, Bot store, and current UI contracts behind explicit adapters until each owner can be retired.

## Bottom line

The current harness works because it has accumulated strong local safeguards around a fragmented ownership model.
The modular browser agent is the strongest part: structured actions, fresh observations, verification, checkpoints, recovery, and pre-action approval are real assets.

The redesign should not begin by rewriting browser clicks.
It should begin by deciding task authority, completion authority, approval trust, parent-child lifecycle, browser ownership, and model policy.

Until those decisions are made, moving files or merging loops would mostly rearrange the ambiguity.
