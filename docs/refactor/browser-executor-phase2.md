# Agent Harness Phase 2: The Canonical BrowserExecutor

This report documents the second phase of the LYKN Agent Harness refactor: replacing the temporary browser compatibility adapter with a real, canonical `BrowserExecutor` that runs under `TaskRuntime`, and retiring the Bot "browser eject" architecture.
It covers the baseline, the new architecture, what was adopted from the AXI reference, the measured prompt reduction, cost accounting, security, and testing.

## 1. Baseline

Before this phase, browser work reached the browser through three unrelated doors:

- A normal Agent's browse ran `runModularBrowserAgent` directly from `runAdaptiveBrowse`, with no canonical Task at all: no recorded identity, no capability set, no terminal state, and cancellation only through the agent's own abort signal.
- A Bot's browser-shaped ask hit `BrowserExecutorAdapter`, which never executed anything: it parked a `pendingBotBrowse` note and paused the Task. A "yes" then **ejected** from the harness — `beginCompatibilityExecution` flipped the Task to running by fiat, the parked ask re-entered `send()` as if the user had typed it, and generic routing decided all over again what to do with it. The Task record and the actual execution were only loosely correlated, and the send-tail had to guess how to settle the Task afterward.
- The mail-compose venue called `runModularBrowserAgent` on its own, also outside any Task.

Element references were minted as `e{uid}` with no notion of which observation they came from.
A ref from three snapshots ago, or from a different agent's controller entirely, was indistinguishable from a fresh one until the actuator failed to find it.

The decision prompt loaded the full corpus every round regardless of what the task was licensed to do.
The measured baseline is preserved at `tests/fixtures/legacy-browser-decision-system.txt`: **46,448 chars ≈ 10,560 tokens** per decision round, for every task.

The audit (`agent-harness-audit.md`) also flagged M11: the server logs every harness stage as `browser_agent_<stage>`, but the admin cost catalog did not list any of them, so the dominant harness spend was invisible to cost review.

## 2. New architecture

### 2.1 BrowserSession and generation-scoped references

`electron/browser-agent/browser/session.cjs` is the authority for task-scoped observation state.
Each snapshot begins a new **generation** from a process-global monotonic counter, and every element reference embeds it: `g{generation}:{uid}` (for example `g7:12`).
The `uid` half remains the document-lifetime element identity minted by the page-side `WeakMap` store in `ownedBrowserAct`, so the same control keeps the same uid across re-observations while its ref changes with each one.

A session owns the set of generations it has minted, which lets `resolveRef` classify every miss precisely:

- `malformed_reference` — not a g-format ref at all (for example a leftover `e7`).
- `stale_reference` — a generation this session minted, but older than the current snapshot; the hint tells the model to re-observe and re-aim.
- `foreign_reference` — a generation this session never minted; another task's refs can never act on this tab.
- `unknown_reference` — current generation, but no such uid; the model invented it.

Because the counter is process-global, two concurrent tasks can never resolve each other's references, and a restart can never resurrect one.
That is the session-isolation guarantee, enforced in code rather than by prompt.

`diffElementStates` and the verifier both match elements across snapshots by `uid`, so change detection and action verification are unaffected by refs changing per generation.

### 2.2 Capabilities

`electron/browser-agent/runtime/capabilities.cjs` translates a Task's capability strings — `browser.read`, `browser.navigate`, `browser.interact`, or the legacy blanket `browser` — into the exact set of action types the run may perform.
Enforcement is layered three deep, none of it prompt-dependent:

1. `runTask` refuses to run at all when the capabilities license no browser operation.
2. The decision schema's action-type enum is filtered to the licensed set, so the model is never even offered a forbidden action.
3. `normalizeDecision` rejects any action outside the set at runtime, before the safety gate.

The prompt corpus is selected by the same set (see §4), so a read-only task neither pays for nor sees interaction rules.

### 2.3 BrowserExecutor under TaskRuntime

`electron/task-runtime/executors/browserExecutor.cjs` is the one canonical way browser work executes.
It does not duplicate the browser brain — the modular loop in `electron/browser-agent` remains the single implementation — it owns the contract between that loop and the canonical Task:

- Capabilities are checked before anything runs, and the licensed action set is derived from the Task, not from the caller.
- Cancellation arrives through the TaskRuntime signal, composed in the host with the agent's own Stop, so either one ends the run.
- Results map onto truthful Task statuses: `completed`, `waiting_for_user` (with the question and its tappable options), `failed` (a run the loop gave up on is filed as a failure even though its answer still reaches the user), and `cancelled`.
- Lifecycle milestones flow out as Task `PROGRESS` events.

In `agentRuntime.cjs`, `runBrowserTaskViaExecutor` is the single seam: it ensures the canonical Task (`ensureBrowserTask`), executes it through the shared `browserExecutor` instance, and hands the browse pipeline back the same legacy-shaped result it always consumed.
A Bot's browse reuses the Bot's own canonical Task; a normal agent resumes a parked Task only when the objective matches, and a different ask supersedes it — one active Task per agent, always truthful.
Both the general browse path and the mail-compose venue go through this seam.
The transient model-blip retry lives **inside** the execution, so a rate-limited round no longer fails the Task or swaps the engine.

Electron browser ownership is untouched: the WebContents, tab adapters, input-seizure listeners, and the `ownedBrowserAct` actuator are wired exactly where they were, inside `runModularBrowserAgent`.

### 2.4 The Bot flow, without the eject

The ask-first product behavior survives as `BrowserOptInGate` (same module, documented): it parks the original tool instruction against the same canonical Task and pauses it as `waiting_for_user`.
On a yes, nothing is ejected anymore.
The Task stays `waiting_for_user` through routing, and the moment the browse dispatches, `TaskRuntime.execute` moves that same Task to running under the canonical `BrowserExecutor` — the parked ask is the objective that resumes, never a re-interpreted user reply.
`beginCompatibilityExecution` had no remaining callers and was deleted from `TaskRuntime`.

What remains of the bridge, deliberately and documented:

- The yes-reply still travels through `send()` routing before the browse dispatches; the send-tail settles any Task a turn leaves open (a chat answer to a parked question, or the legacy engine) so no Task dangles.
- The legacy adaptive loop survives as a fallback engine for the explicit `LYKN_BROWSER_AGENT=legacy` opt-out and for structural model-endpoint unavailability. It executes outside the runtime; when it finishes a Bot turn, the send-tail records the result on the Task as `browser_legacy_fallback`.

## 3. AXI reference: adopted, adapted, rejected

- **Adopted:** generation-scoped element references; precise staleness classification with recovery hints instead of a generic miss; compact, bounded, semantic observations as the model-facing surface.
- **Adapted:** AXI derives identity from the accessibility tree; LYKN keeps its page-side `WeakMap` uid store as element identity and layers generations on top, because the DOM-script catalog, frame namespacing (`{routingId}_{uid}`), and the actuator's live re-resolution all already key on those uids.
- **Rejected:** the CLI/tool-per-call execution model (LYKN's controller is a long-lived, ownership-aware authority over an Electron tab, not a stateless tool); wholesale replacement of the DOM catalog with an a11y-tree snapshot (the catalog's dialog prioritization, editable-state, and frame handling encode years of site-specific lessons the tree does not carry).

## 4. Prompt reduction

The corpus was re-cut along the capability tiers, and the identity moved out of the per-round decision prompt entirely:

- `agent/identity.md` (from the old runtime `AGENTS.md`) — planning only.
- `agent/browser-read.md` and `agent/safety-core.md` — every browser decision.
- `agent/browser-interact.md` and `agent/safety-actions.md` — only when the capabilities license interaction.
- `agent/skills/builders/SKILL.md` — only when the goal routes the `builders` skill.
- `decisionOutputContract` filters its action guidance to the licensed set.

Measured per decision round, against the recorded baseline:

| Corpus | Chars | ~Tokens | vs. baseline |
| --- | --- | --- | --- |
| Legacy (every round) | 46,448 | 10,560 | — |
| Interactive task | 39,490 | 9,011 | −15% |
| Read-only task | 23,433 | 5,357 | −49% |

The savings compound: decide is the dominant stage and runs once per round, up to 48 rounds per task.

## 5. Cost accounting

`src/lib/admin/aiCallCatalog.js` now carries an `browser_agent` surface listing the whole stage family the server already logs — `browser_agent_plan`, `_decide`, `_verify`, `_learn`, `_route`, `_offer`, `_judge`, and `_ground` — closing audit finding M11.
Per-run usage (tokens, upstream latency, per-stage buckets) continues to accumulate into `agent.lastModelUsage` / `agent.lastBotModelUsage` on the host.

## 6. Security

- Capability enforcement is code, not prompt, at three layers (§2.2); a task compiled read-only cannot click, whatever the model asks for.
- Approval semantics are unchanged and now recorded: the consequential-action gate (`classifyActionRisk` → interactive Yes/No) still lives in the browser runtime, and `awaitBrowseApproval` records `waiting_for_approval` / resolution on the canonical Task for every surface, including normal agents that previously had no Task.
- Session isolation is structural: foreign-generation references are refused by classification, so no prompt injection can steer a task with another task's handles.
- The navigation allowlist, sensitive-field redaction, and send-policy gates are untouched.
- The runtime-identity prompt rule is enforced by test: neither runtime may carry an `AGENTS.md`; identities live inside their prompt corpora.

## 7. Testing

Everything below is green at the end of the phase.

- `npm run test:agent` — 669 + 29 tests, 0 failures.
- `npm run test:electron` — 17 tests (IPC manifest, security gates, safeFetch).
- `npm run test:eval` — 139 pass, 1 pre-existing skip.
- `node --test electron/task-runtime/*.test.cjs` — 21 tests, including a new `browserExecutor.test.cjs` suite covering capability refusal, status mapping (completed / waiting / failed / cancelled), pause-and-resume under the same Task identity, cancellation through the Task signal, and the opt-in gate.

The contract change forced a migration of roughly fifty behavior tests that had hardcoded `e{uid}` refs; they now read refs off the state the code under test returns, which is also the only correct way to write them under a process-global generation counter.
The migration itself caught real defects:

- `runtime/recovery.cjs` keyed retry budgets on the raw ref, which now changes every re-observation — the escalation ladder past "retry fresh" had become unreachable for ref-targeted actions. Signatures now normalize targets to their generation-free uid.
- Two tests had been passing vacuously because their dead `e1` refs meant the behavior under test never ran (the multi-step Amazon search, the drag risk-gate tolerance); both genuinely protect their behavior again.
- A dead conditional in `runtime/verifier.cjs` (both branches returned `"recover"`) was simplified.

## 8. Known residuals

- The legacy adaptive loop still executes outside the runtime when it is the fallback engine; its result is recorded on the Task by the send-tail. Retiring it is future work, as is splitting `ownedBrowserAct.cjs` along the actuator/intelligence boundary mapped during this phase.
- A structural model-endpoint outage fails the Task truthfully even though the legacy fallback may still deliver an answer for the turn; the Task record and the chat transcript can disagree in that rare case, by design in favor of the record staying honest.
