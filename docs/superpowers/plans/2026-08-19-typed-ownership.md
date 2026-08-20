# Typed Browser Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "the user has taken the browser back" a typed state the controller enforces, instead of a rule in a prompt the model may or may not honour.

**Architecture:** A new pure state machine, `browser/ownership.cjs`, holds one of three states — `agent`, `delegated`, `user`. The controller consults it before every action that changes the page and refuses with `user_controlling` when the agent does not hold control. Real user input in the agent's tab seizes control automatically; because Electron's `input-event` fires for the agent's own synthetic input too, the controller wraps every actuator call in a suppression window so the agent can never mistake its own clicks for the user's. In the loop, `user_controlling` is a hard stop routed to the existing `waitForUser` handover — never a recovery retry.

**Tech Stack:** Node.js CommonJS, Electron `webContents.on("input-event")`, `node:test` + `node:assert`.

**Spec:** This plan is self-contained; it implements finding #3 from the ego-lite comparison (ego enforces task-space ownership in its API; LYKN states the same intent only in `AGENTS.md` prose).

## Global Constraints

- Runtime is CommonJS (`.cjs`) under `electron/`. No ESM `import` in these files.
- `browser/ownership.cjs` must be **pure** — no Electron imports, no timers other than those injected — so it is testable without a browser.
- **`takeOver()` must never be reachable from the `user` state.** Once the user has seized the browser, only an explicit `release()` — driven by the user answering in the UI — returns control. This is the whole point of the plan; an implementation where the agent can grab control back is worse than no plan.
- **The agent must never mistake its own input for the user's.** `sendInputEvent` raises `input-event`. Any implementation that lacks the suppression window will deadlock every run on its first click.
- `createBrowserController` must keep working when no `ownership` is passed. Every existing call site and test constructs it without one, and they must all continue to pass unchanged.
- Tests run with `node --test`. `electron/browser-agent/ownership.test.cjs` is already matched by the
  existing `test:agent` glob `electron/browser-agent/*.test.cjs` — **do not edit `package.json`**.
- **File ownership:** this plan writes ONLY `electron/browser-agent/browser/ownership.cjs`, `electron/browser-agent/browser/controller.cjs`, `electron/browser-agent/index.cjs`, `electron/agentRuntime.cjs`, `electron/browser-agent/ownership.test.cjs`. Do not edit any other file — in particular, **not `package.json`**.
- **Sequencing:** Tasks 2 and 3 modify `controller.cjs` and `index.cjs`, which the stable-refs and action-batching plans also modify. Those plans' changes to those two files must land **before** this plan's Task 2 begins.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `electron/browser-agent/browser/ownership.cjs` | The state machine | **New** — pure, no deps |
| `electron/browser-agent/browser/controller.cjs` | Enforcement point | Gate mutating actions; wrap actuator calls in a suppression window |
| `electron/browser-agent/index.cjs` | The loop | Treat `user_controlling` as a handover, not a retry |
| `electron/agentRuntime.cjs` | Electron wiring | Build the store, attach `input-event`, release on resume |
| `electron/browser-agent/ownership.test.cjs` | Tests | **New** |

---

### Task 1: The ownership state machine

**Files:**
- Create: `electron/browser-agent/browser/ownership.cjs`
- Test: `electron/browser-agent/ownership.test.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `createOwnership({now, graceMs} = {})` returning an object with:
  - `state(): "agent" | "delegated" | "user"`
  - `mayAct(): boolean` — true only in state `agent`
  - `handOff(reason: string): {ok: true, state: "delegated"}`
  - `takeOver(): {ok: boolean, state, error?: "user_controlling"}` — refused from `user`
  - `seize(reason: string): {ok: true, state: "user"}`
  - `release(): {ok: true, state: "agent"}`
  - `noteInput(source: "user"|"agent"): boolean` — returns true if this input seized control
  - `beginAgentInput(): void` / `endAgentInput(): void`
  - `reason(): string`

- [ ] **Step 1: Write the failing test**

Create `electron/browser-agent/ownership.test.cjs`:

```js
/**
 * Browser ownership state-machine tests.
 *
 * Run: node --test electron/browser-agent/ownership.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const { createOwnership } = require("./browser/ownership.cjs");

/** A store with a clock we control, so grace windows are deterministic. */
function makeStore(graceMs = 250) {
  let t = 1000;
  const store = createOwnership({ now: () => t, graceMs });
  return { store, tick: (ms) => { t += ms; } };
}

test("a fresh store belongs to the agent", () => {
  const { store } = makeStore();
  assert.equal(store.state(), "agent");
  assert.equal(store.mayAct(), true);
});

test("handing off delegates and blocks the agent", () => {
  const { store } = makeStore();
  store.handOff("needs a login");
  assert.equal(store.state(), "delegated");
  assert.equal(store.mayAct(), false);
  assert.match(store.reason(), /login/);
});

test("takeOver returns control after a hand-off", () => {
  const { store } = makeStore();
  store.handOff("needs a login");
  const out = store.takeOver();
  assert.equal(out.ok, true);
  assert.equal(store.state(), "agent");
  assert.equal(store.mayAct(), true);
});

test("takeOver is REFUSED once the user has seized control", () => {
  const { store } = makeStore();
  store.seize("user clicked");
  const out = store.takeOver();
  assert.equal(out.ok, false);
  assert.equal(out.error, "user_controlling");
  assert.equal(store.state(), "user", "the agent must not be able to grab the wheel back");
  assert.equal(store.mayAct(), false);
});

test("only an explicit release returns control after a seize", () => {
  const { store } = makeStore();
  store.seize("user clicked");
  store.release();
  assert.equal(store.state(), "agent");
  assert.equal(store.mayAct(), true);
});

test("user input while the agent holds control seizes it", () => {
  const { store } = makeStore();
  assert.equal(store.noteInput("user"), true);
  assert.equal(store.state(), "user");
});

test("input during an agent action is the agent's own and is ignored", () => {
  const { store } = makeStore();
  store.beginAgentInput();
  assert.equal(store.noteInput("user"), false, "the agent's synthetic input must not seize control");
  assert.equal(store.state(), "agent");
  store.endAgentInput();
});

test("echo input just after an agent action is still the agent's", () => {
  const { store, tick } = makeStore(250);
  store.beginAgentInput();
  store.endAgentInput();
  tick(100);
  assert.equal(store.noteInput("user"), false, "events lag sendInputEvent; the grace window covers them");
  assert.equal(store.state(), "agent");
});

test("user input after the grace window has passed does seize control", () => {
  const { store, tick } = makeStore(250);
  store.beginAgentInput();
  store.endAgentInput();
  tick(400);
  assert.equal(store.noteInput("user"), true);
  assert.equal(store.state(), "user");
});

test("nested agent actions do not end the suppression window early", () => {
  const { store } = makeStore();
  store.beginAgentInput();
  store.beginAgentInput();
  store.endAgentInput();
  assert.equal(store.noteInput("user"), false, "the outer action is still running");
  store.endAgentInput();
});

test("user input during a hand-off seizes control rather than leaving it delegated", () => {
  const { store } = makeStore();
  store.handOff("sign in please");
  store.noteInput("user");
  assert.equal(store.state(), "user");
  assert.equal(store.takeOver().ok, false, "the agent must now wait to be released");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test electron/browser-agent/ownership.test.cjs`
Expected: FAIL — `Cannot find module './browser/ownership.cjs'`.

- [ ] **Step 3: Write the module**

Create `electron/browser-agent/browser/ownership.cjs`:

```js
/**
 * Who holds the browser: the agent, or the person watching it.
 *
 * Only one of them at a time. This used to be a paragraph in AGENTS.md asking
 * the model to notice when the user had stepped in, which meant it was advice
 * rather than a rule: nothing stopped the agent carrying on clicking while the
 * user was typing into the same tab, and the two of them fought over the page.
 *
 * Three states:
 *   agent      — the agent may act. The starting state.
 *   delegated  — the agent handed off and is waiting. It may take control back,
 *                because it is the one that gave it up.
 *   user       — the user took control. The agent may NOT take it back. Only an
 *                explicit release, driven by the user answering in the UI,
 *                returns control.
 *
 * That asymmetry is the whole design. A hand-off is the agent's own decision
 * and reversing it is safe. A seizure is the user overruling the agent, usually
 * because it is going wrong, and an agent that can undo it has not been stopped
 * at all.
 *
 * The suppression window exists because Electron raises `input-event` for
 * synthetic input too, so every click the agent makes looks exactly like the
 * user grabbing the wheel. Without it the first click of every run would seize
 * the browser away from the agent and the task would deadlock immediately. The
 * depth counter handles actions that actuate more than once, and the grace
 * window covers events that arrive after `sendInputEvent` has returned.
 */

/** How long after an agent action its input events may still arrive. */
const DEFAULT_GRACE_MS = 250;

function createOwnership({ now = () => Date.now(), graceMs = DEFAULT_GRACE_MS } = {}) {
  let state = "agent";
  let why = "";
  /** Nesting depth of in-flight agent actions. */
  let agentDepth = 0;
  /** When the last agent action finished, for the trailing grace window. */
  let agentInputEndedAt = -Infinity;

  function agentIsActuating() {
    return agentDepth > 0 || now() - agentInputEndedAt < graceMs;
  }

  return {
    state: () => state,
    reason: () => why,
    mayAct: () => state === "agent",

    handOff(reason = "") {
      state = "delegated";
      why = String(reason || "waiting for the user");
      return { ok: true, state };
    },

    /** Reclaim after our own hand-off. Never valid against a user seizure. */
    takeOver() {
      if (state === "user") return { ok: false, state, error: "user_controlling" };
      state = "agent";
      why = "";
      return { ok: true, state };
    },

    seize(reason = "") {
      state = "user";
      why = String(reason || "the user took control of the browser");
      return { ok: true, state };
    },

    /** The user has finished and handed the browser back, in so many words. */
    release() {
      state = "agent";
      why = "";
      // A release ends any in-flight suppression: whatever the agent thought it
      // was doing happened before the user intervened.
      agentDepth = 0;
      agentInputEndedAt = -Infinity;
      return { ok: true, state };
    },

    /**
     * Real input landed in the agent's tab.
     * @returns {boolean} true when this input took control away from the agent.
     */
    noteInput(source = "user") {
      if (source === "agent" || agentIsActuating()) return false;
      if (state === "user") return false;
      this.seize("the user acted in the browser");
      return true;
    },

    beginAgentInput() {
      agentDepth += 1;
    },

    endAgentInput() {
      agentDepth = Math.max(0, agentDepth - 1);
      if (agentDepth === 0) agentInputEndedAt = now();
    },
  };
}

module.exports = { createOwnership, DEFAULT_GRACE_MS };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test electron/browser-agent/ownership.test.cjs`
Expected: PASS (11/11).

- [ ] **Step 5: Commit**

```bash
git add electron/browser-agent/browser/ownership.cjs electron/browser-agent/ownership.test.cjs
git commit -m "feat(browser-agent): add typed browser ownership state machine"
```

---

### Task 2: Enforce ownership in the controller

> **Blocked on:** the stable-refs plan's Task 3 (which rewrites `resolveRef` in this same file). Do not start until that has landed.

**Files:**
- Modify: `electron/browser-agent/browser/controller.cjs` — the factory signature (line 20), a new gate + wrapper, and every mutating action
- Test: `electron/browser-agent/ownership.test.cjs`

**Interfaces:**
- Consumes: `createOwnership` (Task 1).
- Produces: `createBrowserController({webContents, actuator, tabs, ownership})` — `ownership` optional. Mutating actions return `{ok: false, error: "user_controlling", reason}` when the agent does not hold control. New exported controller method `ownership()` returning the store or `null`.

- [ ] **Step 1: Write the failing test**

Append to `electron/browser-agent/ownership.test.cjs`:

```js
const { createBrowserController } = require("./browser/controller.cjs");

function harness(ownership) {
  const calls = [];
  const actuator = {
    getDOMCatalog: async () => ({
      ok: true,
      url: "https://x.test/",
      items: [
        {
          uid: 1, id: "el0", tag: "button", type: "", role: "", selector: "#go",
          label: "Go", value: "", checked: false, href: "", clientX: 5, clientY: 5, inView: true,
        },
      ],
    }),
    getPageContext: async () => ({ ok: true, url: "https://x.test/", title: "X", text: "hi" }),
    runAction: async (_wc, action) => {
      calls.push(action.type);
      return { ok: true };
    },
    navigate: async () => {
      calls.push("navigate");
      return { ok: true };
    },
    waitForLoad: async () => {},
  };
  const webContents = { isDestroyed: () => false, getURL: () => "https://x.test/", getTitle: () => "X" };
  return { calls, controller: createBrowserController({ webContents, actuator, ownership }) };
}

test("the controller acts normally when the agent holds control", async () => {
  const store = createOwnership();
  const { calls, controller } = harness(store);
  await controller.getPageState();
  const res = await controller.click("e1");
  assert.equal(res.ok, true);
  assert.deepEqual(calls, ["click"]);
});

test("a mutating action is refused while the user holds control", async () => {
  const store = createOwnership();
  const { calls, controller } = harness(store);
  await controller.getPageState();
  store.seize("user clicked");
  const res = await controller.click("e1");
  assert.equal(res.ok, false);
  assert.equal(res.error, "user_controlling");
  assert.deepEqual(calls, [], "nothing may reach the actuator");
});

test("navigation is refused too", async () => {
  const store = createOwnership();
  const { calls, controller } = harness(store);
  store.seize("user clicked");
  const res = await controller.navigate("https://y.test/");
  assert.equal(res.error, "user_controlling");
  assert.deepEqual(calls, []);
});

test("observing is always allowed — the agent may look while the user drives", async () => {
  const store = createOwnership();
  const { controller } = harness(store);
  store.seize("user clicked");
  const snap = await controller.getPageState();
  assert.equal(snap.url, "https://x.test/");
  assert.equal((await controller.screenshot()).ok !== undefined, true);
});

test("the agent's own click does not seize control from itself", async () => {
  const store = createOwnership();
  const { controller } = harness(store);
  await controller.getPageState();
  // Simulate the input-event Electron raises for the agent's synthetic click,
  // arriving while the action is still in flight.
  const original = controller.click("e1");
  store.noteInput("user");
  await original;
  assert.equal(store.state(), "agent", "the suppression window must cover the agent's own input");
});

test("a controller built without an ownership store behaves exactly as before", async () => {
  const { calls, controller } = harness(undefined);
  await controller.getPageState();
  assert.equal((await controller.click("e1")).ok, true);
  assert.deepEqual(calls, ["click"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test electron/browser-agent/ownership.test.cjs`
Expected: FAIL — `a mutating action is refused while the user holds control` fails with `res.ok === true`, because nothing consults the store.

- [ ] **Step 3: Accept the store and add the gate**

Change the factory signature at `controller.cjs:20` from:

```js
function createBrowserController({ webContents, actuator, tabs = null }) {
```

to:

```js
function createBrowserController({ webContents, actuator, tabs = null, ownership = null }) {
```

Then add, immediately after the `invalidate()` function:

```js
  /**
   * Actions that change the page, and so may only run while the agent holds
   * the browser. Observation is deliberately absent: the agent watching while
   * the user signs in is exactly what makes a hand-off resumable.
   */
  const MUTATING = new Set([
    "navigate", "goBack", "goForward", "click", "clickCoord", "typeAtCoord",
    "drag", "type", "replaceText", "select", "scroll", "pressKey",
    "openTab", "closeTab", "switchTab",
  ]);

  /**
   * Refuse an action the agent is not entitled to perform.
   * @returns {null|{ok: false, error: "user_controlling", reason: string}}
   */
  function ownershipBlock(name) {
    if (!ownership || !MUTATING.has(name)) return null;
    if (ownership.mayAct()) return null;
    return {
      ok: false,
      error: "user_controlling",
      reason: ownership.reason() || "the user has control of the browser",
      state: ownership.state(),
    };
  }

  /**
   * Run an actuator call inside the suppression window.
   *
   * Electron raises `input-event` for synthetic input as well as real input,
   * so without this every click the agent makes reads as the user taking the
   * wheel — the agent would stop itself on its own first action.
   */
  async function asAgent(fn) {
    ownership?.beginAgentInput?.();
    try {
      return await fn();
    } finally {
      ownership?.endAgentInput?.();
    }
  }
```

- [ ] **Step 4: Gate and wrap every mutating action**

Each mutating action needs two changes: a gate at the top, and its actuator call wrapped in `asAgent`. Apply this shape to **every** name in `MUTATING`.

`navigate` becomes:

```js
  async function navigate(url) {
    const blocked = ownershipBlock("navigate");
    if (blocked) return blocked;
    const res = await asAgent(() => actuator.navigate(wc(), url));
    invalidate();
    return res;
  }
```

`click` becomes (keeping its existing body, including the `hint` handling added by the stable-refs plan):

```js
  async function click(ref) {
    const blocked = ownershipBlock("click");
    if (blocked) return blocked;
    const { el, error, hint } = resolveRef(ref);
    if (error) return { ok: false, error, ...(hint ? { hint } : {}) };
    const res = await asAgent(() => actuator.runAction(
      wc(),
      { /* ...the existing action object, unchanged... */ },
      catalogItems(),
    ));
    invalidate();
    return res;
  }
```

Apply the same two edits to `goBack`, `goForward`, `clickCoord`, `typeAtCoord`, `drag`, `type`, `replaceText`, `select`, `scroll`, `pressKey`, `openTab`, `closeTab` and `switchTab`.

Verify none were missed — every name in `MUTATING` must appear in a gate call. This must print 15:

```bash
grep -c 'ownershipBlock("' electron/browser-agent/browser/controller.cjs
```

- [ ] **Step 5: Expose the store on the controller**

Add to the returned object, after `diffSnapshots,`:

```js
    ownership: () => ownership,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test electron/browser-agent/ownership.test.cjs`
Expected: PASS (17/17).

- [ ] **Step 7: Run the full agent suite**

Run: `npm run test:agent`
Expected: PASS. Every existing test constructs the controller without `ownership`, so `ownershipBlock` returns `null` and `asAgent` is a passthrough.

- [ ] **Step 8: Commit**

```bash
git add electron/browser-agent/browser/controller.cjs electron/browser-agent/ownership.test.cjs
git commit -m "feat(browser-agent): enforce browser ownership in the controller"
```

---

### Task 3: Treat `user_controlling` as a handover in the loop

> **Blocked on:** Task 2, and the action-batching plan's Task 4 (which rewrites the execute section of this same file). Do not start until both have landed.

**Files:**
- Modify: `electron/browser-agent/index.cjs` — the execute/verify section (immediately after `const actionResult = ...`)
- Test: `electron/browser-agent/ownership.test.cjs`

**Interfaces:**
- Consumes: `actionResult.error === "user_controlling"` from the controller (Task 2); the existing `waitForUser(kind, question, decision)` closure.
- Produces: no new exports. A run that hits `user_controlling` either resumes with ownership back at `agent`, or ends `waiting_for_user`.

- [ ] **Step 1: Write the failing test**

Append to `electron/browser-agent/ownership.test.cjs`:

```js
const { runBrowserAgentTask } = require("./index.cjs");

/** A model that always clicks, so the run reaches the gate immediately. */
function clickingModel() {
  return {
    plan: async () => ({ plan: ["click the thing"], skills: [], constraints: [] }),
    // factsLearned and candidateResults are NOT optional: index.cjs iterates
    // both unguarded right after the decide call, so a model that omits them
    // makes every test throw "decision.factsLearned is not iterable" long
    // before it reaches the ownership gate.
    decide: async () => ({
      kind: "act",
      action: { type: "click", target: "e1" },
      reason: "click",
      expectedOutcome: "something",
      risk: "low",
      factsLearned: [],
      candidateResults: [],
    }),
    verify: async () => ({ progressed: true, note: "" }),
    learn: async () => ({ notes: [], userNotes: [] }),
  };
}

test("a run stops and asks when the user seizes the browser mid-task", async () => {
  const store = createOwnership();
  const { controller } = harness(store);
  store.seize("user clicked");
  let asked = null;
  const out = await runBrowserAgentTask({
    goal: "do the thing",
    controller,
    model: clickingModel(),
    maxRounds: 3,
    onNeedsUser: async (req) => {
      asked = req;
      return { resumed: false };
    },
  });
  assert.equal(out.status, "waiting_for_user");
  assert.equal(asked?.kind, "handover", "the loop must route this to a handover, not a retry");
});

test("a run resumes when the user hands the browser back", async () => {
  const store = createOwnership();
  const { controller } = harness(store);
  store.seize("user clicked");
  let calls = 0;
  const out = await runBrowserAgentTask({
    goal: "do the thing",
    controller,
    model: {
      ...clickingModel(),
      decide: async () => {
        calls += 1;
        const base = { factsLearned: [], candidateResults: [] };
        return calls > 1
          ? { ...base, kind: "finish", answer: "done", reason: "r", risk: "read" }
          : { ...base, kind: "act", action: { type: "click", target: "e1" }, reason: "click", risk: "low" };
      },
    },
    maxRounds: 4,
    onNeedsUser: async () => {
      store.release();
      return { resumed: true, note: "the user handed it back" };
    },
  });
  assert.equal(store.state(), "agent");
  assert.equal(out.status, "completed");
});

test("the agent never takes control back on its own", async () => {
  const store = createOwnership();
  const { controller } = harness(store);
  store.seize("user clicked");
  await runBrowserAgentTask({
    goal: "do the thing",
    controller,
    model: clickingModel(),
    maxRounds: 3,
    // Says it resumed, but never actually released. The agent must not act.
    onNeedsUser: async () => ({ resumed: true, note: "claims to be done" }),
  });
  assert.equal(store.state(), "user", "a lying resume must not hand the agent the wheel");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test electron/browser-agent/ownership.test.cjs`
Expected: FAIL — `asked?.kind` is `undefined` or the run reports a plain action failure; `user_controlling` currently falls through to ordinary recovery.

- [ ] **Step 3: Handle it in the loop**

In `index.cjs`, immediately **after** the `const actionResult = await timer.time("actuate", ...)` assignment (and after the batching plan's `if (batched) { ... }` block, if present) and **before** `debug.log("acted", ...)`, insert:

```js
    // The user has the browser. This is not an obstacle to route around: they
    // took it deliberately, usually because this run is going wrong. Retrying,
    // recovering or replanning would all be the agent fighting them for the
    // page. The only correct move is to ask and wait.
    if (actionResult?.error === "user_controlling") {
      debug.log("user_controlling", { round: task.round, reason: actionResult.reason || "" });
      const question =
        "You've taken over the browser — I've stopped so we're not both driving. " +
        "Tell me when you'd like me to pick it back up and I'll carry on from where you leave it.";
      const resumed = await waitForUser("handover", question);
      // A resume is not enough on its own: control comes back only when the
      // ownership store says so. Anything else would let a stray callback hand
      // the agent a browser the user is still using.
      if (resumed && controller.ownership?.()?.mayAct?.()) {
        recovering = true;
        recoveryHint =
          `You stopped because the user took over the browser. They have handed it back (${resumed}). ` +
          `Read the page before doing anything — they may have moved it on, or done the step ` +
          `themselves. Do not repeat work that is already on screen.`;
        continue;
      }
      return finish("waiting_for_user", question, { needsUser: true, handover: true });
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test electron/browser-agent/ownership.test.cjs`
Expected: PASS (20/20).

- [ ] **Step 5: Run the full agent suite**

Run: `npm run test:agent`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/browser-agent/index.cjs electron/browser-agent/ownership.test.cjs
git commit -m "feat(browser-agent): treat user takeover as a hard-stop handover"
```

---

### Task 4: Wire real user input to a seizure

> **Blocked on:** Task 3.

**Files:**
- Modify: `electron/agentRuntime.cjs` — the browse-agent setup where `controller` and `onNeedsUser` are built (around lines 6190-6310)

**Interfaces:**
- Consumes: `createOwnership` (Task 1); `createBrowserController({..., ownership})` (Task 2).
- Produces: no new exports. Real mouse/keyboard input in the agent tab moves ownership to `user`; the existing resume path calls `release()`.

- [ ] **Step 1: Build the store and pass it to the controller**

In `electron/agentRuntime.cjs`, find where `createBrowserController` is called for the browse agent. Immediately above it, add:

```js
    // Who holds this tab. Real input from the user seizes it; the controller
    // refuses to act until they hand it back.
    const ownership = browserAgent.createOwnership();
```

and add `ownership` to the `createBrowserController({ ... })` argument object.

If `createOwnership` is not yet re-exported from the browser-agent entry point, add it to the `module.exports` block at the bottom of `electron/browser-agent/index.cjs`:

```js
  createOwnership: require("./browser/ownership.cjs").createOwnership,
```

- [ ] **Step 2: Attach the input listener**

Immediately after the store is created, add:

```js
    // Electron raises this for the agent's synthetic input as well as the
    // user's, so the store's suppression window — not this listener — is what
    // tells them apart. Filtering to down-events only keeps mouse-move and
    // key-up noise out of it.
    const onTabInput = (_event, input) => {
      const type = String(input?.type || "");
      if (type !== "mouseDown" && type !== "keyDown" && type !== "mouseWheel") return;
      if (ownership.noteInput("user")) {
        emitProgress(agent.id, {
          status: "waiting",
          step: "You've taken the browser — I've paused.",
          url: wc.getURL?.() || agent.url,
          skill: "browse",
        });
      }
    };
    try {
      wc.on("input-event", onTabInput);
    } catch {
      /* older Electron without input-event: ownership stays agent-only */
    }
```

- [ ] **Step 3: Remove the listener when the run ends**

Find the cleanup path that runs after `browserAgent.runBrowserAgentTask(...)` resolves (the same place the generation guard and status reset live) and add:

```js
    try {
      wc.off?.("input-event", onTabInput);
    } catch {
      /* the tab may already be gone */
    }
```

If the call is not already inside a `try/finally`, wrap it in one and put the removal in the `finally`, so an exception cannot leak the listener.

- [ ] **Step 4: Release ownership when the user hands the tab back**

In `onNeedsUser`, in the success branch — immediately after `emitAgentWaiting(agent.id, { waiting: false });` and before `agent.status = "running";` — add:

```js
      // They are done with the tab; the agent may drive again.
      ownership.release();
```

- [ ] **Step 5: Verify by hand**

The listener needs a real Electron window, so this step is manual.

```bash
npm run electron:dev
```

Give the agent a multi-step browse task. While it is working, click somewhere in its tab. Confirm:
1. The agent stops rather than continuing to click.
2. The UI shows the paused/waiting state.
3. Answering the resume prompt lets it carry on.
4. **A run you do not interfere with completes normally** — this is the regression that proves the suppression window works. If a run stalls on its own first click, `beginAgentInput`/`endAgentInput` are not wrapping the actuator call; go back to Task 2 Step 4.

- [ ] **Step 6: Run the full agent suite**

Run: `npm run test:agent`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add electron/agentRuntime.cjs electron/browser-agent/index.cjs
git commit -m "feat(browser-agent): seize ownership on real user input in the agent tab"
```

---

## Verification

- [ ] `npm run test:agent` passes.
- [ ] `npm run test:eval` passes.
- [ ] `grep -c 'ownershipBlock("' electron/browser-agent/browser/controller.cjs` prints 15.
- [ ] Manual check from Task 4 Step 5 passes, **including item 4** (an uninterrupted run completes).
- [ ] `npm run lint` reports no new errors in the touched files.
