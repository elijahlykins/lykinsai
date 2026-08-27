# Task execution

Canonical Electron execution is a single pipeline.

```
TaskCompiler
    ↓
TaskRuntime
    ↓
canonical Executor (Bot / Browser / Local / Remote)
    ↓
result
    ↓
TaskRuntime terminal transition
```

There is no second path that can independently create Task semantics, settle success or failure, perform browser execution, bypass capability compilation, convert a waiting state into success, or complete stale or cancelled work.

## Owners

`TaskCompiler` (`electron/task-runtime/taskCompiler.cjs`) compiles the envelope: objective, capabilities, budgets, origin, association.

`TaskRuntime` (`electron/task-runtime/taskRuntime.cjs`) is the sole Task terminal authority.
It maps executor results onto `completed`, `failed`, `cancelled`, `waiting_for_user`, and `waiting_for_approval`.
Host code may cancel or fail unfinished work on abort.
It must not call `complete()` after a canonical `execute()`.

`agentRuntime` is the host and orchestrator.
It associates input, compiles or reuses a Task, routes skills, calls `TaskRuntime.execute`, and projects UI/events.
It is not Task terminal authority.
The `send()` tail may format Glass output and emit `lykn:agent-done`.
It must not independently decide terminal success.

`BrowserExecutor` is the only browser Task execution authority.
The browse brain is `electron/browser-agent/`.
The actuator is `electron/ownedBrowserAct.cjs` (`runAction`, catalog, screenshots, mail/sheet helpers, satisfaction heuristics).

`BotExecutor` is the only Bot Task execution authority.
Casual chat: TaskRuntime → BotExecutor → reply-only stream.
Task-shaped Bot work: TaskRuntime → BotExecutor → Bot Harness → child executors/tools → TaskRuntime.

Browser-agent and Bot Harness are sibling runtimes.
They are not merged.

## Browser compilation

Every dedicated browse Task is `compileBrowserTask` (or reuse of an existing non-terminal Task) then `TaskRuntime.register` / `execute`.
Default capabilities are `browser.read`, `browser.navigate`, `browser.interact`.
`browser.eval` is never granted by the compiler.
The compiler does not infer extra capabilities from prose.
`BrowserExecutor` still enforces the capability set at action time.

Bot Tasks use `defaultBotCapabilities({ localMode })` at the compiler boundary.
The Bot `"browser"` string is the blanket read+navigate+interact grant, not `browser.eval`.

## Retired execution forks

These are gone:

- `LYKN_BROWSER_AGENT=legacy`
- `ownedBrowserAct.executeOwnedAdaptiveTask`
- `browser_legacy_fallback` send-tail settlement
- `LYKN_BOT_HARNESS=0` host-level skip around BotExecutor

If someone intentionally set `LYKN_BROWSER_AGENT=legacy`, that mode no longer exists.
If someone intentionally disabled Bot Harness via `LYKN_BOT_HARNESS=0`, that alternate architecture no longer exists.

Ordinary product behavior is otherwise equivalent.

A structural miss of `/api/desktop/agent-model` fails the Task.
It does not swap to a second browse engine.
Transient 408/429/5xx retries stay inside the same `TaskRuntime.execute`.

BotExecutor may still degrade *inside the executor* to the capability stream when harness `decide` cannot run.
That is still TaskRuntime → BotExecutor, not a second host architecture.

## Approvals and waiting

Approvals remain structural.
The model does not decide them.
The renderer does not decide them.
The send tail does not decide them.
TaskRuntime and the executor consequence/approval gates remain authority.

`waiting_for_user` and `waiting_for_approval` are not success.
Host formatting must not project them as completed.

Cancellation is transitive through TaskRuntime's abort signal into Browser, Local, Remote, Bot, and Workflow runs.
A late executor result after cancel is ignored (`stale: true`).
A late `complete()` on a failed or cancelled Task is ignored.

## Events

Canonical Task events keep `taskId` and `runId`.
Do not emit unattributed compatibility events.

## `main.cjs`

`main.cjs` bootstraps Electron, composes windows, constructs services, and registers modules.
Browser *view* Maps (`agentBrowserViews` and related) stay with window composition.
They are not a second Task lifecycle.

`lykn:get-version` stays in `main.cjs` because it is a synchronous preload bootstrap read of `app.getVersion()`.

The retired `planOwnedBrowserNext` planner existed only for the deleted adaptive loop.

## Intentionally retained (not execution authority)

- `legacy:${agent.id}` Bot profile identity when synthesizing a missing profile
- Bot skill-name aliases in harness routing (`BOT_SKILL_TO_TOOL`)
- `recordRuntimeFallback` diagnostics reader for historical on-disk records
- Overlay `browser-plan-next` fetch in `electron/ipc/overlayAi.cjs` (overlay AI, not the Agent browse engine)
- `"browser"` as a capability string meaning read+navigate+interact
