# Electron host map

These files coordinate.
They do not own Task execution.

## main.cjs

Electron composition root.

Startup order is explicit: core services, artifact protocol, shell chrome, execution runtimes, windows, process lifecycle.

Shutdown is `shutdownServices`.

Window/view modules attach through `bindShellContext`.
Do not add a god `shellContext` of every method.

## agentRuntime.cjs

Host for:

input → session association → skill routing → Task compile/reuse → TaskRuntime → UI projection

Extracted helpers live in `electron/agent-runtime/`.

Executor construction stays in the host so tests can still see canonical wiring.

## agent-browser/host.cjs

Agent Mode sidebar, stage, tab views, artifacts, and runtime construction (`initAgentRuntime`, routines, teach).

Not a second Task runtime.

## overlay.js

Glass renderer bootstrap.

`electron/overlay-ui/` owns markdown, status rotation, side panel, voice, and listen/meeting UI.

`electron/overlay/askPipeline.cjs` is the main-process ask pipeline.
Do not merge it into the renderer.

## Canonical execution

TaskRuntime, TaskCompiler, BotExecutor, BrowserExecutor, LocalExecutor, RemoteExecutor, McpExecutor, RoutineRuntime.
