# LYKN Custom Bot Flow Architecture Audit

Status: factual read-only audit of the current worktree on 2026-08-26.

Scope: what a custom Bot is, how it is stored, how it is invoked, and how one Bot run actually executes.

Compared against `docs/refactor/agent-harness-audit.md`.
Where that document is stale for Bots, this audit says so.

This document does not design or implement TaskRuntime / BotExecutor.

## Executive summary

A Bot run in LYKN today is not one object.

It is a renderer-owned persona plus queue (`src/lib/bots/botStore.ts`), a headless Electron worker agent (`electron/agentRuntime.cjs`), and - for task-shaped turns only - a decide/use-tool/verify/deliver loop (`electron/bot-harness/index.cjs`).

There is no server Bot API.
There is no Bot capability system.
There is no Bot-owned model preference, tool allowlist, schedule, memory policy, or browser session.

The durable Bot definition is a localStorage roster:

- `id`, `name`, `role`, `persona`, face/eyes/color
- `agentId` of the paired worker
- `chatId` of the Bot's chat board
- a list of `BotTask` records (`queued` / `running` / `done` / `failed`)

Creation UI collects name, persona, and look.
It does not collect role, model, tools, permissions, triggers, or memory.

Invocation is always a chat send to that Bot.
The chat page wraps the user's text in `taskBrief()`, enqueues a `BotTask`, and calls `window.lykn.studioAgentSend`.
That is the same IPC path Studio Agent Rail uses.

`agentRuntime.send` then splits the turn:

1. Casual / un-nominated chat skips Bot Harness and streams `/api/ai/stream` as ordinary Agent Mode chat, with a "You are LYKN" prompt, not the Bot identity.
2. Task-shaped turns (image, build, research, local, browser, or a `routeBotTool` verdict other than `chat`) enter `runBotHarnessTask`.
3. Selecting the `browser` tool does not run the browser agent inside the harness.
   It parks `pendingBotBrowse`, asks the user, and on yes sets `botBrowserRun` and **ejects** into the normal host browse pipeline.
4. `local_computer` stays nested: Bot Harness calls `runLocalTask` → `electron/localAgentTask.cjs`, then may verify and continue.

Completion is split.

Bot Harness completes when the model emits `deliver`, when a terminal `reply` is the only executed tool, when the user is asked, when the round budget expires, or when the abort signal fires.
The renderer `BotTask` completes later, when `lykn:agent-done` arrives, unless the turn parked on a question or a teammate hand-off.
After browser opt-in, the host `send()` finish path owns completion, not Bot Harness.

There is **not** one BotDefinition authority at runtime.
Renderer `Bot`, Electron `botProfile`, dispatch `taskBrief` text, and the casual-chat "You are LYKN" prompt are four identity surfaces.
`successCondition` / `doNot` are model-authored on the first harness decision, then pinned.
They are not an immutable user Task.

The inner harness loop (`runBotTask`) is already a reasonable BotExecutor candidate.
The surrounding lifecycle is not.
Task identity, queue, routing, abort, browser eject, casual-chat bypass, UI status, and persistence live in `botsClient` and `agentRuntime.send`.
Adapting Bot Harness behind a BotExecutor without first moving those authorities would leave two Task owners.

## Current architecture diagram

```mermaid
flowchart TD
  U[User]

  subgraph Studio["LYKN Studio"]
    BP[BotsPage builder]
    HB[HomeChatBar Bot menu]
    CH[LyknChat / useBotChatBridge]
  end

  subgraph Renderer["Renderer singleton"]
    BS[botStore Bot + BotTask]
    BC[botsClient queue / dispatch / relays]
    LS["localStorage lykn_bots_v1"]
  end

  subgraph IPC["Privileged IPC"]
    AC[lykn:agent-create]
    SS[lykn:studio-bar-send]
    ST[lykn:agent-stop]
  end

  subgraph Host["electron/agentRuntime.cjs"]
    AG[headless worker agent]
    RT[routeBotTool]
    SK[runOneSkill]
    BH[runBotHarnessTask]
    SC[streamChat /api/ai/stream]
    BR[browse pipeline]
    LC[runLocalTask]
  end

  subgraph Harness["electron/bot-harness"]
    LOOP[runBotTask]
    CTX[contextRouter]
    REG[toolRegistry]
    TS[taskState]
  end

  subgraph Server["LYKN server"]
    AM[/api/desktop/agent-model]
    AIS[/api/ai/stream]
  end

  U --> BP
  BP --> BS
  BS --> LS
  U --> HB
  HB --> CH
  CH --> BC
  BC --> AC
  BC --> SS
  AC --> AG
  SS --> AG
  AG --> RT
  RT --> AM
  RT --> SK
  SK -->|task-shaped| BH
  SK -->|casual chat or harness off| SC
  BH --> LOOP
  LOOP --> CTX
  LOOP --> REG
  LOOP --> TS
  LOOP --> AM
  LOOP -->|reply report image artifact| SC
  LOOP -->|local_computer| LC
  LOOP -->|browser parks| AG
  AG -->|yes: botBrowserRun| BR
  SC --> AIS
  LC --> AM
  AG -->|delta progress done| BC
  BC --> CH
```

## Bot definition

### Canonical renderer type

`src/lib/bots/botStore.ts` `Bot`:

| Field | Meaning in code |
|---|---|
| `id` | `bot_${timestamp36}${rand}` |
| `name` | Display name, max 40 chars |
| `role` | Job title, max 60 chars. Builder does not collect it. Templates define it. Runtime uses it in identity strings when present. |
| `persona` | Working-style instructions, max 1200 chars. The only user-authored behavior field. |
| `face` / `eyes` / `color` | Visual identity. Not used by the harness. |
| `agentId` | Paired Electron worker. `null` until first dispatch. |
| `chatId` | UUID of the Bot's own chat board. |
| `chatStartedAt` | Stamp set when "new chat" re-homes the board. |
| `createdAt` | ISO timestamp |
| `tasks` | Renderer queue and history. Finished tasks trimmed to 30. |

There is no field for model, tools, capabilities, triggers, schedule, memory, project, workspace, browser permissions, local permissions, or output configuration.

Status is not a Bot field.
Presence is derived from `tasks`, `agentStates[agentId]`, and `live[agentId]`.

### What creation actually writes

`src/components/bots/BotsPage.jsx` `BotBuilder.create` calls `addBot({ name, persona, face, eyes, color })`.

Role is omitted, so `createBot` stores `role: ""`.

`BOT_TEMPLATES` (Scout, Concierge, Watchtower, Drafter) exist in `botStore.ts` and are tested.
They are not wired into the builder UI.

There is no edit-Bot path after create.
`removeBot` closes the worker and drops the roster entry.

### Runtime profile (fork)

`electron/agentRuntime.cjs:sanitizeBotProfile` keeps `{ name, role, persona }` with slightly different caps (60 / 80 / 1200).

It is stored on the worker as `agent.botProfile`.
It is refreshed on every `send(..., { bot })`.
It is **not** written to `overlay-agents.json`.
After process restart, identity returns only if the next renderer dispatch includes `bot`.

### Dispatch brief (fork)

`botStore.taskBrief` wraps the user's ask before IPC:

- Every turn: `[You are ${name}...]` plus optional teammate-handoff coaching.
- First dispatch only (`introduce: true`): full persona and "finish the job end to end".

`agentRuntime.botAskCore` strips those wrapper lines before routing and before showing Glass history.

### Casual-chat prompt (fork)

Headless `streamChat` for `skill === "general"` still uses:

`You are LYKN — a sharp, friendly teammate chatting in the browser sidebar.`

(`agentRuntime.cjs` around 4176-4191.)

Bot identity is therefore **not** in the casual-chat system prompt.
It rides only in the wrapped user text, and only if `taskBrief` ran.

### Persistence authority

| Copy | Store | Survives restart |
|---|---|---|
| Bot roster + tasks | renderer `localStorage` key `lykn_bots_v1` | yes, this device |
| Unseen-result dots | `lykn_bots_seen_v1` | yes, this device |
| Chat rows (`bot`, `botTaskId`, `aiResponse`, `botWorking`) | chat snapshot / DB via `useLyknChatPersistence` | yes, last 50 messages, truncated |
| Worker agent | `userData/overlay-agents.json` | headless flag and history yes; `botProfile` no |
| Harness `taskState` | process memory | no |
| Queued attachments | in-memory `attachmentsByTask` | no |
| Teammate relays | in-memory `relays` | no |

There is **no** `server/routes` Bot table and **no** `/api/bots/*`.
`docs/refactor/agent-harness-audit.md` Entry path C and the "server Bot records" note are stale on that point.

### Is there one BotDefinition authority?

No.

| Authority | Owns |
|---|---|
| `botStore.Bot` | Durable persona + queue + chat board |
| `agent.botProfile` | Harness identity for task-shaped turns |
| `taskBrief()` text | Identity injected into the user message |
| `streamChat` prompt | Casual-chat identity, currently LYKN, not the Bot |
| `electron/bot-harness/AGENTS.md` | Runtime "you are a LYKN Bot" identity, always loaded in harness |

The renderer `Bot` is the closest product authority.
The harness does not read it.
It reads `botProfile` plus markdown.

## Bot / Run / Task distinction

LYKN distinguishes these in names, then mixes them in lifecycle.

### BOT

Persistent configuration/persona: `botStore.Bot`.

One Bot has one `agentId` (after first hire) and one current `chatId`.

### BOT TASK

Renderer work item: `botStore.BotTask`.

Fields: `id`, `text`, `status`, timestamps, `result`.

Created by `enqueueTask` / `assign`.
`id` is `task_${...}`.
This is **not** the harness `taskState`.
This is **not** a browser-agent task.

A Bot has at most one `running` task.
Further asks queue.
`dispatchNext` starts the oldest queued task when the desk is clear.

### BOT RUN

Not a first-class object.

The closest run is `agentRuntime.send` for that worker:

- `agent.generation` incremented on each send/abort
- `agent.abort` AbortController
- `agent.busy` / `agent.status`
- optional Bot Harness loop with its own `round` / `events`
- optional nested local loop
- optional ejected browser pipeline

There is no `runId`.

### ID map

| ID | What it actually is |
|---|---|
| `bot.id` / `botId` | Renderer persona id |
| `bot.chatId` | Chat board UUID. Ordinary LYKN chat persistence. |
| `BotTask.id` / `botTaskId` | Renderer queue item. Stamped on the chat prompt row so the row can re-attach. |
| `bot.agentId` / `agentId` | Electron worker in `agents` Map |
| `chatId` | Same as `bot.chatId` when talking to that Bot |
| `boardId` | Not used by Bots |
| `runId` | Does not exist |
| `sessionId` | Not a Bot concept. Desktop model proxy may log a user session. |
| `choiceId` | In-memory approval/question on the agent |
| Browser task file | `userData/browser-agent-tasks/${agentId}.json` - browser child only |

### Where the concepts mix

1. `botsClient.onAgentDone` finishes whichever task is `running`, because the runtime reports per agent, not per task (`botStore.finishRunningTask` comment).
2. A parked question keeps the same `BotTask` running while `send()` starts a new host generation.
3. Teammate `[[ask Name: ...]]` keeps the origin task running and creates a **different** Bot's task.
4. Browser opt-in replaces the user's typed reply with `pendingBotBrowse.ask` inside `send()`, so the host run's `originalAsk` is no longer the chat row text.
5. Chat `aiThread` snapshots store `(asked ${bot.name}) ${text}` / `(${bot.name} replied) ${reply}` as ordinary user/assistant lines. The Bot is a string prefix, not a typed actor.

## End-to-end execution flow

Traced path for a task-shaped ask ("research X", "build me a page", "send that email").

```
BotsPage.addBot
  → botStore.createBot
  → localStorage lykn_bots_v1

HomeChatBar send with targetBot
  → sessionStorage lykn_pending_home_chat { botId, text }
  → event lykn-home-chat-send
  → LyknChat.tsx
  → useBotChatBridge.handleBotChatSend
  → botChatBridge.sendBotChatTurn
  → botsClient.assign
       enqueueTask (status=queued)
       setTimeout dispatchNext
  → botsClient.ensureAgent
       window.lykn.agentCreate({ silent, headless, bot: {name,role,persona} })
       IPC lykn:agent-create
       agentRuntime.createAgent
  → botsClient.startTask (status=running)
  → window.lykn.studioAgentSend(taskBrief(...), atts, agentId, { bot })
       IPC lykn:studio-bar-send
       agentRuntime.send
```

Inside `send` (`electron/agentRuntime.cjs` ~10162):

```
abortAgent (prior generation)
new AbortController
history.push(originalAsk)          // includes taskBrief wrapper
actsHeadless = headless && !botBrowserRun
resolveSkillForPrompt              // may coerce browse → general
routeBotTool                       // nominated asks only; stage=route
skill = verdict or heuristic
runOneSkill
  if headless && !botBrowserRun && skill !== general && botHarnessEnabled
    runBotHarnessTask
      botHarness.runBotTask
        loop:
          model.structured("decide")     // /api/desktop/agent-model
          use_tool → executor
          optional model.verify
          deliver | ask_user | continue
  else if skill === general
    streamChat → POST /api/ai/stream
```

Harness executors (`runBotHarnessTask` ~6751):

| Tool | Host function |
|---|---|
| `reply` | `streamChat(..., "general")` |
| `research_report` | `streamChat(..., "research")` |
| `edit_report` | `streamChat(..., "report-edit")` |
| `build_artifact` | `streamChat(..., "build")` |
| `generate_image` | `streamChat(..., "image")` |
| `local_computer` | `runLocalTask` → `localAgentTask.runLocalAgentTask` |
| `browser` | set `pendingBotBrowse`; return `terminal: "waiting_for_user"` |

Progress:

```
onProgress → agent.step → lykn:agent-status + lykn:agent-progress
botsClient.onAgentProgress / onAgentDelta
botChatBridge.followBotTask
chat row: botWorking, botStatus, botTrail, aiResponse
```

Completion:

```
runBotTask returns { status, answer }
runBotHarnessTask returns answer or offerAgentQuestion
send() finish → lykn:agent-done { agentId, text, stopped }
botsClient.onAgentDone
  maybe tryRelayHandoff
  else finishRunningTask
  dispatchNext after 400ms
followBotTask sees status done/failed → done:true
```

### Casual-chat fork

If the ask is not nominated (`skill === "general"` and no browser-shaped heuristics) or `routeBotTool` returns `chat`:

`runOneSkill` never calls the harness.
`streamChat` runs immediately.

Kill switch: `LYKN_BOT_HARNESS=0` restores that single-shot path for task-shaped skills too (`botHarnessEnabled`).

### Browser-opt-in fork

See Browser integration.
After yes, this send() does **not** re-enter `runBotTask`.

## Task authority

The user's original text lives on `BotTask.text`.

The model does not receive that field as a typed contract.
It receives:

1. `goal: botAskCore(ask)` in harness task state (wrapper stripped)
2. `taskBrief` identity/teammate lines in `agent.history`
3. last 8 history lines in `buildTaskUser` (400 chars each)
4. On first harness decision, model-authored `successCondition` and `doNot`, then pinned by `taskState.setTaskBrief` ("first non-empty wins")

The model **can**:

- Reinterpret the objective as `successCondition` (prompt-required, not validated against `BotTask.text`)
- Expand or shrink via tool `instruction` strings (the child executor sees only that brief)
- Continue after a successful tool by choosing another `use_tool` instead of `deliver`
- Ask the user (`ask_user`) and later resume with `takePendingQuestion`, which concatenates `answered.ask + Additional guidance`
- Hand off to a teammate, which injects a new ask on another Bot
- After browser yes, have the browse pipeline plan its own `successCondition` / steps from `pendingBotBrowse.ask` plus optional extra guidance

The model **cannot** mutate `BotTask.text` or the renderer queue.

Places scope mutates:

| Location | Mutation |
|---|---|
| `taskBrief` | Adds identity, teammate coaching, "finish end to end" on first hire |
| `botAskCore` | Strips that wrapper for routing/goal |
| `setTaskBrief` | Pins model-written success/doNot |
| `buildTaskUser` | Always appends `DO NOT: Continue looking for additional useful work` |
| Tool `instruction` | New child goal |
| `send()` pending-question resume | Concatenates original parked ask + user answer |
| Browser yes/no | Replaces `q` with parked ask ± guidance |
| Teammate relay | New task text on another Bot; resume text "Finish my original ask yourself now" |
| `streamChat` skill prompts | Agent Mode doctrine, research/build/image flags |

There is no immutable Task object.
The closest freeze is harness `state.goal` plus first-write `successCondition`.
Both are still prompt-enforced.

## Completion authority

### Who owns "I am finished"?

Multiple owners, depending on path.

**Bot Harness** (`index.cjs`) ends the loop when:

- `kind === "deliver"` (after one empty-handed pushback if nothing has run)
- `kind === "ask_user"`
- executor returns `terminal: "waiting_for_user"` (browser park, or theoretically a waiting child)
- `tool.terminal && state.executed === 1` (`reply` success)
- `maxRounds` (default 12) → status `failed` with a "ran out of working room" answer
- abort → status `aborted`

Deliver is a **model signal**.
The only deterministic pushback is "no tool has run yet".
Success condition is not evaluated in code.

**Host `send()`** still wraps the harness return.
`waiting_for_user` becomes `offerAgentQuestion`.
Otherwise the answer is formatted (`formatHeadlessCompletion` when still headless) and `lykn:agent-done` fires.

**Renderer `botsClient.onAgentDone`** owns `BotTask` settlement:

- If `live.waiting` and not `stopped`, it returns without finishing (parked)
- If reply matches `[[ask Name: ...]]` and a teammate exists, origin task stays running
- Else `finishRunningTask({ ok: !p.stopped, result })`

**UI** does not decide completion.
`followBotTask` mirrors `BotTask.status`.
If the bot/task disappears, the row is forced to a failed done state so the spinner cannot run forever.

**Casual chat / harness-disabled / browser-ejected paths** never hit `runBotTask` completion.
They use `streamChat` provider-final or browser-agent `finish`.

### Over-execution after the user's ask is done

Documented in code, not inferred from temperament:

1. Empty-handed deliver is pushed back once, which can force a tool the user did not need if routing marked the ask task-shaped.
2. Progressive disclosure spends a round to read a tool doc, then another to call it, then optional verify, then a deliver round - up to 12.
3. `reply` is terminal only when it is the **first** executed tool. A research-then-reply sequence still wants a later deliver.
4. `core.md` / `AGENTS.md`: "Work gets finished, not described" and "Ask me only when something genuinely needs my decision; otherwise finish the job end to end" (`taskBrief` first hire).
5. Child `streamChat` research/build/image loops have their own hop/tool completion, then the harness may verify and continue.
6. Browser eject runs a full browser-agent plan after the Bot already decided the errand.
7. `dispatchNext` starts the next queued task 400ms after done, which is correct queue behavior but can look like continued work.
8. Round-limit failure asks the user to "continue", which is a new Task if they do.

## Cancellation

UI → deepest operation:

There is **no Bot-chat Stop control** in `LyknChatView` or `HomeChatBar`.
`withdrawTask` only removes **queued** tasks, not running ones.

Documented stop paths:

| Path | Code | Effect |
|---|---|---|
| App reload | `parseBots` marks `running` → `failed`; `ensureWired` calls `agentStop` if the worker is still busy with no running BotTask | Stops orphaned host run |
| `removeBot` | `agentClose` | abort + destroy tab + drop roster |
| New send to same agent | `abortAgent(..., "restart")` then new generation | Prior AbortController aborted |
| Studio/agent rail stop | `lykn:agent-stop` → `stopAgent` | abort, `lykn:agent-done` `{ stopped: true }` |
| Approval abort | `awaitBrowseApproval` / local approval listen on `agent.abort` | resolves false |

`abortAgent` (~2791): increments `generation`, aborts the controller, clears `busy`, stops monitors.

What the signal actually reaches:

| Work | Cancelled? |
|---|---|
| Harness decide/verify | yes, `signal` on `model.structured` / `verify` |
| `streamChat` `/api/ai/stream` | yes, fetch `signal: agent.abort.signal` |
| Local loop rounds | checks `signal.aborted` between rounds |
| Local `callModel` fetch | **does not pass signal** (`localAgentTask.cjs` ~116-123). In-flight local model call can outlive abort until HTTP returns |
| Browser child after eject | yes, same `agent.abort` as other host runs |
| `botRoute` | yes, 6s timeout + signal |
| Queued renderer tasks | not started; not cancelled unless `withdrawTask` |
| Teammate relay in flight | origin abort does not stop the teammate's agent |
| `dispatchNext` timer | 400ms `setTimeout` is not generation-guarded |

Orphan possibilities:

- Reload is explicitly handled for running BotTasks.
- `LYKN_BOT_HARNESS` child `streamChat` with `suppressDone: true` still uses the same abort.
- A teammate relay can continue after the asker is dismissed only until `removeBot` resumes/drops relays.
- Local model fetch without abort is the deepest leak.

## Budgets

| Limit | Value | Enforced by | Model-modifiable? |
|---|---|---|---|
| Harness rounds | 12 (`DEFAULT_MAX_ROUNDS`) | runtime | no |
| Harness recoveries | 2 (`MAX_RECOVERIES`) | runtime | no |
| Empty deliver pushback | 1 | runtime | no |
| Decide `maxTokens` | 1800 | runtime | no |
| Verify `maxTokens` | 350 | model client | no |
| Route `maxTokens` | 120 | model client | no |
| Route timeout | 6000 ms | `createAgentModel({ timeoutMs: 6000 })` | no |
| Other structured timeout | 90s (`CALL_TIMEOUT_MS`) | model client | no |
| Structured HTTP retry | 1 | model client | no |
| Conversation in harness user msg | last 8, 400 chars each | runtime | no |
| `historyForPlanner` | blended last 10 | host | no |
| Local rounds | 20 | `localAgentTask` | no |
| Browser rounds | 24 default, host-documented extras | browser-agent (after eject) | no |
| Worker agents | 20 | `MAX_WORKER_AGENTS` | no |
| Pending question TTL | 30 minutes | `PENDING_QUESTION_MS` | no |
| Teammate hops | 2 per origin task | renderer | no |
| Finished BotTask history | 30 | renderer | no |
| Persona | 1200 chars | create/sanitize | no |
| `streamChat` text clip | 4000 default; 14000 research/build/edit | host | no |
| Token budget | none Bot-specific | - | - |

Prompt-only (not runtime-enforced): stop when success condition holds, one question per task, one tool per round, "never retry a declined action" (runtime **does** record decline and injects guidance; the model could still select the tool again).

Dangerous defaults:

- Casual chat has **no** harness round cap; `/api/ai/stream` hop limits apply instead.
- Browser eject inherits the full browser-agent budget, not the remaining 12 harness rounds.
- Local 20 rounds sit **inside** one harness round.
- Research `streamChat` can enable `deepResearch: true` inside one `research_report` tool call.

## Tools/capabilities

### Inventory

From `electron/bot-harness/runtime/toolRegistry.cjs`:

| Tool | Class | Registry risk | Verify | Terminal | Gate |
|---|---|---|---|---|---|
| `reply` | communication | read | no | yes | none |
| `research_report` | web/research | low | yes | no | none |
| `edit_report` | web/research | low | yes | no | none |
| `build_artifact` | files/apps | low | yes | no | none |
| `generate_image` | other | low | yes | no | none |
| `local_computer` | local computer | low | yes | no | Local Mode on, else absent from index |
| `browser` | browser | low | no | no | user opt-in park; later browse-pipeline approvals |

There is no Vault tool, no Memory tool, no project tool, no connector tool, no Bot-specific allowlist.

Granting:

- Global index for every Bot.
- `localMode` from `localSystem.readLocalMode(userDataPath)`, not per-Bot.
- Progressive disclosure: first selection loads markdown, does not execute.
- Consequential floor: registry risk cannot be lowered; decision `risk` can raise to `consequential`, which calls `onApproval` (`awaitBrowseApproval`).
- `browser` is intentionally **not** registry-consequential, so asking permission to open the browser is not itself a Yes/No "consequential" pause.

This is **not** a real capability system.
It is a global tool index plus Local Mode plus a browser opt-in flag on the agent.

Child `streamChat` then uses normal chat tools (`useTools` unless softChat).
A Bot `reply` is softChat-like only when skill is `general`.
Harness `reply` calls `streamTool("general")` → `streamChat` with `skill: "general"` → `softChat` true → `useTools: false`.
Research/build/image enable tools and composer modes.

## Browser integration

Bot does **not** call `ownedBrowserAct` from the harness.

Sequence:

1. `routeBotTool` or heuristics nominate `browser`.
2. Harness preloads `agent/tools/browser.md` when `primaryTool === "browser"`.
3. Model `use_tool` `browser` (or the preloaded first call after doc-read).
4. Executor sets `agent.pendingBotBrowse = { ask: instruction || original ask, at }` and returns `waiting_for_user` with Yes/No options.
5. `offerAgentQuestion` parks the host turn.
6. Next user message in `send()`:
   - bare/start yes → `botBrowserRun = true`, `q = pending ask` (± guidance)
   - no → `skipBotBrowseAskOnce`, `botBrowseDeclinedAt`, re-run ask headless
   - anything else → fresh ask, parked browse dropped
7. With `botBrowserRun`, `runOneSkill` **skips** the harness branch and runs the normal browse pipeline (`runBrowse` / modular browser-agent / legacy fallback).
8. Hidden tab still exists (`createAgent` always pairs a tab).
   Window is not raised.
   `captureBotBrowserShots` CDP-screenshots into `lykn:bot-browser-shot` for the chat-bar mini viewport.
9. `revealBotBrowser` binds chat, switches agent, shows the real tab.
10. When `send()` finishes idle, `botBrowserRun` clears so the next errand asks again.

State ownership during a Bot browser run:

| State | Owner |
|---|---|
| Tab / WebContents | `main.cjs` agent views, same pairing as Studio workers |
| Partition | `persist:lykn-agent-browser` shared with **all** non-incognito agents |
| Active tab / snapshot / DOM refs | browser-agent controller + `ownedBrowserAct` after eject |
| Mini viewport frames | `agentRuntime` shot loop, renderer `shots[agentId]` |
| Opt-in flag | `agent.botBrowserRun` / `pendingBotBrowse` (memory only, not persisted) |

Interference with normal browser-agent:

- Same shared cookie partition (`agent-harness-audit.md` H8 still applies).
- Same `agents` Map and tab strip.
- Headless agents are excluded from becoming `activeAgentId` on send, so untargeted Studio sends should not steal the Bot mid-run.
- A user who reveals the Bot tab can type/click; modular ownership still seizes on real input.
- Bot and Studio workers can operate signed-in sites concurrently in one session.

`docs/refactor/agent-harness-audit.md` says Bot Harness then verifies and delivers after the child browser run.
Current code does **not** do that.
Eject leaves Bot Harness.
Host `send()` completion is the browser pipeline's completion.

## Local executor integration

```
harness executor local_computer
  → agentRuntime.runLocalTask
  → electron/localAgentTask.cjs runLocalAgentTask
       decide loop (stage=decide, DECISION_SCHEMA)
       localSystem tools
       first file read: awaitLocalApproval
       risky write/command: awaitLocalApproval per action
```

IPC boundary: none extra.
Already in the main process.
`localSystem.cjs` is the filesystem/shell authority.

Approval: agent `pendingChoice` type `local-approval`.
Typed yes/no in `send()` resolves it.
Harness `onApproval` is **not** used for local risk; the local runner holds its own pause.
If local returns `waiting_for_user`, `runLocalTask` currently still returns `result.answer` as a string and does **not** set `terminal: "waiting_for_user"` on the harness executor.
A local ask/approval-wait can therefore look like a completed tool output to Bot Harness unless `runLocalTask` surfaces it (it returns the answer text; status `waiting_for_user` is not forwarded in `runBotHarnessTask`'s executor).

Cancellation: loop checks abort between rounds; model fetch ignores the signal.

Result format: `{ ok, status, answer, history }` collapsed to `{ ok: !!text, output, summary }` for the harness.

Scope: synced folders only, same as other Local Mode.

## Model calls

Representative **task-shaped** Bot run (no browser eject):

| Call | Stage | Default model | Role | Mandatory? |
|---|---|---|---|---|
| `routeBotTool` | `route` | `BROWSER_AGENT_ROUTE_MODEL` or `gpt-4.1-mini` | tool/venue classification | only if nominated; cache hits skip |
| Each harness round `model.structured("decide")` | `decide` | `BROWSER_AGENT_MODEL` or `gpt-5.6-terra` | tool/deliver/ask + first-round successCondition | yes, every harness round |
| `model.verify` | `verify` | `BROWSER_AGENT_VERIFY_MODEL` or base | tool-output check | if `tool.verify` and executor `ok` |
| Child `streamChat` | `/api/ai/stream` | user/workspace chat model (`body.model: "lykn"`) | reply, research, build, or image | if that tool runs |
| Nested chat-agent-loop tool hops | chat tools | same stream | research crawl, artifact build, image gen | if child enables tools |
| Local child decides | `decide` | same desktop decide default | local act/finish | if `local_computer` |

Browser eject then adds the full browser-agent plan/decide/verify/ground set from the Agent Harness audit.

Casual chat: **zero** harness/route calls if not nominated; one `/api/ai/stream`.

Expensive calls that are classification, not work:

- `routeBotTool` on every nominated prompt (cheap model, small prompt - acceptable)
- First-round `successCondition`/`doNot` on the strong decide model
- Verify after research/build/image even though those pipelines already completed
- Progressive-disclosure extra decide round per new tool

`runBotHarnessTask` does **not** attach `onUsage`, unlike `runModularBrowserAgent`.
Bot decide/verify cost is not accumulated on `agent.lastModelUsage`.

## Token/context cost

Estimates use ~1.33 tokens per English word, same as the Agent Harness audit.
Verified word counts for Bot markdown match that audit.

### Always-loaded harness system (byte-stable per bot + localMode)

| Piece | Words | ~Tokens | Every round? |
|---|---|---|---|
| `AGENTS.md` | 357 | 475 | yes |
| `agent/core.md` | 539 | 720 | yes |
| `agent/safety.md` | 271 | 360 | yes |
| Tool index | ~120 | 160 | yes |
| Identity block | ~40-120 | 50-160 | yes |
| Output contract | ~280 | 370 | yes |
| **System subtotal** |  | **~2,100-2,300** | yes |

Materially smaller than browser-agent's ~8,900-token always-loaded markdown.

### Per-round user message (`buildTaskUser`)

| Piece | Bound | Every round? |
|---|---|---|
| Recent conversation | 8 × 400 chars | yes |
| TASK / SUCCESS / SCOPE / DO NOT / STOP RULE | small + pinned model brief | yes |
| Attachments note | names only at harness layer | yes if present |
| Loaded tool docs | 134-340 words each, stay loaded | after first select |
| Event ledger | grows, tool summaries 800 chars | yes |
| Recovery guidance | ~300 chars | after failure |
| Extra note | progressive disclosure / decline | sometimes |

Initial stable input ≈ system 2.2k + brief/history ~0.5-1.5k ≈ **3-4k tokens** before any tool doc.

After one tool doc (typical): **+180-450 tokens** every later decide.

Variable observation: tool output is **not** resent in full.
Only `summary` (800 chars) plus optional verify's 3000-char output on the **verify** call, not the decide call.

Biggest Bot-specific consumers:

1. Child `streamChat` research/build (14k text clip, full chat persona, tools) - **outside** the harness prefix, often larger than the harness itself
2. Event ledger on long 12-round tasks
3. Repeated system prefix (cacheable; `desktop.routes.js` cacheKey is `browser-agent:${stage}:${userId}`, **not** per-Bot, so identity in system prompt can bust prefix cache across Bots)

Route call is a few hundred tokens on mini.

## Memory

Bot does **not** use the Markdown Memory system (`server/memory/*`, `lykn_memory_documents`).

| Kind | Used by Bot today? |
|---|---|
| Markdown personal Memory | no seam in bot-harness or botsClient |
| Conversation history | yes: renderer chat board; `agent.history`; harness last 8; streamChat last 12 |
| Bot configuration | persona string only |
| Bot execution history | `BotTask.result` in localStorage, trimmed to 30 |
| Project context | no |
| Vault | no Bot tool; child streamChat may still hit Vault if the chat persona/tools include it |
| Browser-agent memory.cjs | only after browser eject, same as Studio workers |
| Synthesis | not used here; do not resurrect |

Seam if Memory is added later: harness `buildDecisionSystem` / `buildTaskUser`, or `streamChat` body construction.
Neither reads `memoryStore` today.

## Runtime prompts

### Loaded markdown

Loader: `electron/bot-harness/runtime/instructions.cjs`.
Files cached in a `Map` after first read.
Not invalidated on change without process restart.

Always injected into `buildDecisionSystem`:

- `electron/bot-harness/AGENTS.md`
- `electron/bot-harness/agent/core.md`
- `electron/bot-harness/agent/safety.md`

On first tool select, `agent/tools/${name}.md`.

### Generated strings

- `contextRouter.identityBlock`
- `decisionOutputContract`
- `toolIndexBlock`
- `buildTaskUser` TASK/SUCCESS/SCOPE/DO NOT/STOP RULE
- `buildVerificationSystem` / `buildVerificationUser`
- `botRoute` dispatcher system (`browser-agent/runtime/model.cjs` ~490)
- `taskBrief` (`botStore.ts`)
- `streamChat` Agent Mode / LYKN sidebar prompts
- Local `SYSTEM_PROMPT` in `localAgentTask.cjs`
- Status lines in `botHarnessStatusLine`

### `AGENTS.md` collision (mechanical)

`electron/bot-harness/AGENTS.md` is runtime identity.
A development agent editing that tree can treat it as development instructions.

Current behavior: `instructions.cjs` resolves `path.join(__dirname, "..")` = `electron/bot-harness/`.

Recommended mechanical migration (do not perform):

1. Move runtime files to a non-`AGENTS.md` name, e.g. `electron/bot-harness/runtime/BOT.md` or `prompts/identity.md`.
2. Change the single `loadAgentsMd()` path.
3. Keep `agent/core.md`, `agent/safety.md`, `agent/tools/*.md` or relocate with the same loader.
4. Add a stub `electron/bot-harness/AGENTS.md` for developers that says it is not injected, **or** omit it so Cursor does not treat it as agent instructions.
5. Update `tests/electron/securityGates.test.cjs` which currently asserts `bot-harness/AGENTS.md` exists.

Same pattern as browser-agent, already noted in the Agent Harness audit.

## UI/events

### Structured-ish events

| Channel / field | Shape |
|---|---|
| `lykn:agent-progress` | public agent + status/step/skill/`botBrowser` |
| `lykn:agent-delta` | `{ text, final? }` full text so far |
| `lykn:agent-status` | `{ status: string }` |
| `lykn:agent-choice` | `{ choiceId, type, message, buttons }` |
| `lykn:agent-waiting` | `{ waiting, kind, label, detail, options }` |
| `lykn:agent-done` | `{ agentId, text, stopped }` |
| `lykn:bot-browser-shot` | `{ agentId, dataUrl, url }` |
| `lykn:agent-list` | all public agents |

Harness `onProgress` phases: `thinking`, `reading`, `acting`, `awaiting_approval`, `verifying`, `recovering`, `delivered`, `waiting_for_user`.
These are collapsed to **one string** `agent.step` before the renderer.

### Chat row fields (UI, not runtime authority)

`PromptMessage`: `bot`, `botTaskId`, `botWorking`, `botStatus`, `botTrail`, `aiResponse`.

`followBotTask` builds `trail` as last 6 distinct status strings.
`botWorking` is `!done && working` (working false when parked).

Authoritative when it should not be:

- Spinner can persist in saved chat until re-attach (`useBotChatBridge` clears `botWorking` if task settled or vanished).
- `agent.step` right after dispatch can still say the previous turn's "Done"; the bridge ignores step unless `agent.status` is running/waiting.
- Live text lives in `botsClient.live[agentId]` and in the chat row. Either can be stale after remount until follow re-attaches.

Approvals: Glass/rail buttons plus typed yes/no.
Main chat shows the question as markdown, not the buttons (`botChatBridge.choiceBlock`).

## Persistence

| Data | Durable? | Stale risk |
|---|---|---|
| Bot roster/tasks | localStorage | multi-window: singleton per document, not cross-window synced except storage events are unused |
| Chat rows | chat DB snapshot | `botWorking` mid-save; `aiResponse` up to 50k |
| `aiThread` convenience lines | snapshot, last 40 | not the Bot task log |
| Worker history/deliverables | `overlay-agents.json` | `botProfile`, `pendingBotBrowse`, `botBrowserRun` omitted |
| Harness events | no | gone on restart |
| Browser task checkpoint | disk per agentId | can resume **browser** goal after crash; renderer BotTask already marked failed on reload |
| Attachments for queued tasks | memory | lost on reload; ask arrives without files |

Reload policy is explicit: running BotTasks become failed with "Stopped — the app reloaded…", and `agentStop` is issued if the worker is still busy.

## Triggers

| Entry | Converges on |
|---|---|
| Manual chat send (home bar / Bot board) | `assign` → `dispatchNext` → `studioAgentSend` |
| Parked question / approval typed answer | `assign` short-circuit: same running task, new `send` |
| Choice button | `answerChoice` → `agentChoiceResolve` |
| Teammate `[[ask Name]]` | `enqueueTask` on mate → `dispatchNext` |
| Browser yes/no | `send()` rewrite of `q` |
| Queue drain | `onAgentDone` → `dispatchNext` |

No schedule, cron, Watchtower monitor loop, email trigger, or webhook.

`HEADLESS_SKILLS` is `{ general, build, image, research, report-edit, local }`.
`monitor` is coerced to `general`.
The Watchtower template persona cannot actually monitor.

All entries that execute work converge on `agentRuntime.send`.
Queueing and identity wrapping do not.

## Error/retry/fallback

| Failure | Next |
|---|---|
| `agentCreate` fails | BotTask finished failed; no retry |
| `studioAgentSend` throws | running task failed |
| `routeBotTool` throws | `""`; heuristic skill stands; **no** browser park |
| Harness `runBotHarnessTask` throws | diagnostics `bot:harness-fallback`; legacy `streamChat` / park / local |
| Unknown tool | note + another decide round |
| Missing executor | note + continue |
| Tool `ok: false` | recovery guidance, up to 2, then "deliver honestly" |
| Verify `success !== true` | same recovery budget |
| Verify throws | ignored; raw output stands |
| Consequential no `onApproval` | recorded declined; extraNote to deliver/ask |
| User declines consequential | extraNote never retry |
| Browser already declined this errand | browser executor returns `ok: false` summary |
| Round budget | status `failed`, partial list of tools |
| `LYKN_BOT_HARNESS=0` | skip harness entirely |
| Local model fail | local `{ ok:false, answer: ... }` into harness as failed tool |

Silent / behavior-changing:

- Route failure → chat, not park (intentional).
- Harness exception → legacy single-shot (quality drop, turn still runs).
- Verify failure is swallowed.
- `normalizeDecision` defaults unknown `kind` to `use_tool`.

No automatic replan API in the harness (unlike browser-agent `replan`).
Recovery is prompt guidance only.

## Security

Compared with Agent Harness audit; Bot-specific facts only.

### Approval gates

- Browser capability: parked question, not the browse-pipeline consequence classifier.
- Harness consequential: model `risk` or registry floor; `browser` and `local_computer` floors are `low`.
- Local: first-read grant + per-risky-action `awaitLocalApproval`.
- After eject, same heuristic consequence detection as Studio browser-agent (audit H4).

A compromised privileged renderer can call `studioAgentSend` / `agentCreate` / `agentChoiceResolve` without a human.
Same note as main-issued local-tool tokens in the Agent Harness audit.

### Renderer trust / sender identity

`lykn:studio-bar-send` and `lykn:agent-create` in `electron/ipc/agentBridge.cjs` do **not** use `agentBrowserHomeSender`.
They rely on the privileged preload (`electron/preload.cjs`) being on the Studio/chat renderer.

`lykn:agent-browser-ai-mode` **does** validate packaged home URL.
Bots do not use that path.

### Browser partition / filesystem / shell / navigation / SSRF / secrets

Same as Agent Harness for ejected browser and local tools.

Bot-specific: every Bot worker still gets a paired tab on create, even while "headless".
The tab shares `persist:lykn-agent-browser`.
Opt-in prevents unsolicited actuation; it does not isolate cookies from other agents.

### Prompt injection

- Tool `instruction` is model-written and may include conversation facts (`core.md` says fold them in).
- Browser instruction "may be typed into a live website" (`browser.md`).
- Casual-chat and child `streamChat` still ingest attached file text and, for non-headless agents, page content.
  Headless `streamChat` skips live page scrape (`!agent.headless` guard ~3962).
- External page content reaches the Bot only after eject.

### Persona vs safety

`identityBlock`: "the safety rules always outrank it."
`safety.md`: overrides user instructions and persona.
Enforced as prompt text, not a separate policy engine.

## Duplicate authorities

| Concern | Forks |
|---|---|
| Identity | Bot, botProfile, taskBrief, AGENTS.md, streamChat "You are LYKN" |
| Objective | BotTask.text, send originalAsk, harness goal, tool instruction, browser pending ask, model successCondition |
| Completion | harness status, send() finish, BotTask.status, chat botWorking |
| Tool routing | classifyAgentSkill, botAskWantsBrowser, routeBotTool, harness decide, LYKN_BOT_HARNESS fallback |
| Browser consent | pendingBotBrowse, botBrowserRun, browse-approval, send-approval |
| History | chatMessages, aiThread, agent.history, BotTask.result, Glass historyForGlass |
| Progress | agent.step, live.text, botStatus/botTrail, lykn:agent-status |

## God objects

| Object | Bot role |
|---|---|
| `electron/agentRuntime.cjs` | create/headless, routing, harness adapter, streamChat, local, browser eject, shots, persist, completions |
| `src/lib/bots/botsClient.js` | roster singleton, queue, IPC wiring, relays, live/shots, dispatch |
| `send()` | generation, abort, pending questions/choices, browse arming, skill loop, final events |

Bot Harness `index.cjs` is **not** a god object.
It is a bounded loop with injected executors.

## Over-execution causes

1. Task-shaped routing plus empty-deliver pushback.
2. Progressive disclosure extra rounds.
3. Strong-model decide after cheap route already chose a primary tool.
4. Child pipelines (research/build/browser) with their own "finish the job" prompts.
5. Browser eject replans the errand from a model-written instruction.
6. First-hire `taskBrief` "otherwise finish the job end to end."
7. Model-authored successCondition can be broader than `BotTask.text`.
8. No runtime check that successCondition holds.
9. Queue auto-dispatch of the next BotTask.

## Cost causes

1. Strong decide model every harness round (~2.2k+ stable tokens).
2. Verify calls on already-expensive child deliverables.
3. Nested `/api/ai/stream` research/build/image.
4. Nested local 20-round decide loop.
5. Nested full browser-agent after opt-in.
6. `routeBotTool` on nominated chat (cheap, but still a blocking call before work).
7. System prompt includes Bot identity, so desktop `cacheKey` `browser-agent:decide:${userId}` is not stable across different Bots.
8. No Bot usage accounting (`onUsage` unused in `runBotHarnessTask`).

## Future TaskRuntime compatibility

Classification of current responsibilities (conservative):

| Responsibility today | Future bucket |
|---|---|
| User ask string | TASK RUNTIME |
| Renderer BotTask queue | TASK RUNTIME or UI+PERSISTENCE (product choice) |
| Round/recovery/timeouts | TASK RUNTIME |
| Abort generation | TASK RUNTIME |
| Completion/deliver/ask | TASK RUNTIME (today: model + harness + renderer) |
| Approval pause | TASK RUNTIME |
| Event stream to UI | TASK RUNTIME |
| Name/role/persona/look | BOT DEFINITION |
| Global tool index | BOT DEFINITION defaults + TASK capabilities |
| `AGENTS.md` / core / safety | BOT EXECUTOR prompts (runtime pack) |
| Progressive disclosure loop | BOT EXECUTOR |
| `runBotTask` decide/act/verify | BOT EXECUTOR |
| `routeBotTool` | LEGACY / fold into TaskCompiler |
| `taskBrief` wrapping | LEGACY / BOT DEFINITION injection |
| Casual `streamChat` bypass | LEGACY / BOT EXECUTOR or a Reply skill |
| `pendingBotBrowse` eject | LEGACY; should be BrowserExecutor under TaskRuntime |
| `runLocalTask` nested loop | LOCAL EXECUTOR |
| Modular browser after eject | BROWSER EXECUTOR |
| `botsClient` IPC singleton | UI + PERSISTENCE |
| `overlay-agents.json` worker | PERSISTENCE / host process |
| Chat board `chatId` | UI + PERSISTENCE |
| Markdown Memory | MEMORY (unused) |
| Skills | SKILL (unused at Bot layer; browser skills after eject) |
| Watchtower/monitor persona | UNKNOWN / not implemented |
| Teammate `[[ask]]` protocol | UNKNOWN (product) |
| `LYKN_BOT_HARNESS=0` | LEGACY / DELETE CANDIDATE after BotExecutor exists |

## BotExecutor migration seam

`electron/bot-harness/index.cjs` `runBotTask({ goal, bot, model, executors, conversationHistory, attachmentsNote, localMode, primaryTool, onProgress, onApproval, signal, maxRounds })` is already an injected-capability loop.

Adapting **that function** behind `BotExecutor.execute(task)` is straightforward.

What is **not** a BotExecutor today:

- `botsClient.assign` / `dispatchNext` / `BotTask`
- `agentRuntime.send` routing and `botBrowserRun`
- casual-chat `streamChat`
- completion mapping to chat rows
- identity `taskBrief`

If BotExecutor is installed without moving those, TaskRuntime would still not own objective, completion, cancellation, or browser/local child lifetimes.

## Keep / Adapt / Replace / Delete table

| Piece | Verdict | Evidence |
|---|---|---|
| `botStore.Bot` persona fields | Keep | Only durable product identity |
| `botStore.BotTask` queue | Adapt | Useful UX queue; must not remain Task authority |
| `botsClient` singleton | Adapt | IPC fan-in; strip lifecycle ownership |
| `BotsPage` builder | Keep / extend | No role/tools/model yet |
| `BOT_TEMPLATES` | Keep or wire | Present, unused in UI |
| `taskBrief` | Replace | Identity belongs in BotDefinition/system, not user text |
| `bot-harness/index.cjs` | Adapt | Natural BotExecutor core |
| `contextRouter` / `taskState` / `toolRegistry` | Adapt | Move success/doNot authorship to TaskCompiler |
| Runtime markdown pack | Adapt | Rename off `AGENTS.md` |
| `runBotHarnessTask` executors | Adapt | Bind BrowserExecutor/LocalExecutor instead of eject/nest |
| `routeBotTool` | Replace | TaskCompiler / capability selection |
| `pendingBotBrowse` / `botBrowserRun` | Replace | TaskRuntime capability + BrowserExecutor |
| Headless worker-per-Bot | Adapt or replace | Process/tab pairing is host, not Bot definition |
| Casual streamChat bypass | Replace | Same executor, cheaper path as a Reply skill |
| `LYKN_BOT_HARNESS=0` | Delete later | Kill switch for the old single-shot path |
| `[[ask teammate]]` | Unknown | Product protocol, not harness |
| Watchtower monitor claims | Delete or implement | Persona without runtime |
| Server Bot API | N/A | Does not exist |

## Open architecture questions

These are not answered by current code.

1. Should a BotTask queue remain a user-visible desk after TaskRuntime exists, or is every chat send one Task with no Bot-level queue?
2. Is casual chat a BotExecutor path with a reply skill, or a non-Task message that never enters TaskRuntime?
3. After browser opt-in, should BotExecutor stay parent (verify/deliver) or should TaskRuntime switch executor?
4. Are teammate hand-offs Tasks, sub-Tasks, or a Bot-only protocol outside TaskRuntime?
5. Should BotDefinition include role, default tools, model, memory, and Local/Browser permissions, given the builder collects only name/persona/look today?
6. Is `localStorage` still acceptable as BotDefinition persistence, or does a Bot become a server object?
7. Should each Bot get an isolated browser partition, or keep the shared `persist:lykn-agent-browser` session?
8. Does "New chat" re-homing stay a Bot concern, or is it ordinary chat-board UX?
9. Should running Bots expose a Stop control in chat, or only inherit TaskRuntime cancellation UI?
10. Is Watchtower-style monitoring in scope for BotExecutor, or a different scheduled Task trigger?

## Recommended migration sequence

Mechanical order implied by current coupling, not a product plan.

1. Freeze Bot behavior behind tests already in `electron/bot-harness/botHarness.test.cjs`, `botHarnessIntegration.test.cjs`, `botToolRouting.test.cjs`, `src/lib/bots/botStore.test.ts`.
2. Introduce Task as an immutable host object **outside** `runBotTask`, populated from `BotTask.text` (not from model `successCondition`).
3. Stop using `taskBrief` as the IPC payload; pass `{ goal, botId, botProfile }` structured.
4. Point BotExecutor at current `runBotTask`, with Task-owned signal, budgets, and onProgress.
5. Replace `pendingBotBrowse` eject with TaskRuntime → BrowserExecutor, keeping the user opt-in as a Task approval, not a second send() rewrite.
6. Replace nested `runLocalTask` with LocalExecutor under the same Task abort/budget.
7. Fold casual chat into an explicit Reply path so identity cannot silently become "You are LYKN".
8. Move completion: executor proposes; TaskRuntime records; renderer BotTask becomes a projection.
9. Rename runtime `AGENTS.md` (mechanical; see Runtime prompts).
10. Only then consider deleting `LYKN_BOT_HARNESS=0` and shrinking `send()`'s Bot special cases.

## Most important question

**Can the current Bot Harness be adapted behind a BotExecutor interface, or does its task/lifecycle ownership require structural rework first?**

The **inner loop** can be adapted.

`runBotTask` already takes goal, bot identity, model, executors, signal, approvals, and progress.
Tests already drive it with fakes.
That is a BotExecutor-shaped function.

The **lifecycle** requires structural rework first.

Evidence:

1. Objective authority is `BotTask.text` in the renderer, then `taskBrief` text, then `botAskCore(goal)`, then model `successCondition`. None of these is a single immutable Task (`botStore.ts`, `botsClient.js`, `contextRouter.cjs` `setTaskBrief`).
2. Completion is at least three objects: harness `status`, `lykn:agent-done`, renderer `BotTask.status` (`index.cjs` deliver; `botsClient.onAgentDone`).
3. Browser work **leaves** the harness (`botBrowserRun` skips `runBotHarnessTask` in `runOneSkill`). A BotExecutor that does not own that branch does not own the run.
4. Casual turns never enter the harness (`botSkill !== "general"` gate).
5. `agentRuntime.send` owns generation, abort, history, routing, and finish formatting for every Bot dispatch.
6. `docs/refactor/agent-harness-audit.md` already identifies authority fragmentation; this audit confirms Bot is a second, renderer-heavy instance of the same problem, not a clean persona layer over a shared Task.

Therefore: wrap `runBotTask` as BotExecutor **after** (or while) TaskRuntime takes objective, budgets, completion, cancellation, approvals, and child executors.
Doing only the wrap would preserve two Task owners.

## Corrections to the Agent Harness audit (Bot sections)

Verified against this worktree; do not treat the following Agent Harness lines as Bot source of truth:

- There is no `server/routes/desktop.routes.js` Bot assign/execute API. Desktop routes used by Bots are `/api/desktop/agent-model` (and stream `/api/ai/stream`).
- Host function is `runBotHarnessTask`, not `runBotTask`. `runBotTask` lives in `electron/bot-harness/index.cjs`.
- There are no server Bot records. Persistence is renderer localStorage plus Electron `overlay-agents.json`.
- Bot Harness does not verify/deliver after a browser child. Browser opt-in ejects into the host browse pipeline.
- `botProfile` is not persisted with agents.

End of audit.
