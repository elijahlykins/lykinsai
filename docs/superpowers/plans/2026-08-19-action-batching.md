# Action Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one model round execute a short sequence of actions whose results cannot change what the next action should be, cutting round-trips on read-heavy work without weakening the per-action safety gate.

**Architecture:** The decision contract gains an optional `steps` array alongside `action`. A batch is admissible only if **every** step is both ref-free and non-committing — the ref-free rule is what makes it safe, because refs come from the snapshot taken before the batch and are meaningless after step 1. Admission is decided by a new pure module `runtime/batch.cjs`; `normalizeDecision` degrades any inadmissible batch to its first step rather than rejecting the round; the loop executes admitted steps in order, stops on the first failure, and hands the verifier one composite description.

**Tech Stack:** Node.js CommonJS, `node:test` + `node:assert`.

**Spec:** This plan is self-contained; it implements finding #2 from the ego-lite comparison (ego composes many steps into one agent turn via code-mode; LYKN pays a model round-trip per action).

## Global Constraints

- Runtime is CommonJS (`.cjs`) under `electron/`. No ESM `import` in these files.
- **The safety gate is not weakened.** `classifyActionRisk`, `goalAuthorizesAction` and the approval flow continue to run against `decision.action` — the first step — and no step admitted into a batch may be one those gates would ever have to judge. That is guaranteed by the admission rule, not by the caller.
- Admission rule, in full: a batch is admissible iff every step's `type` is in `BATCHABLE_ACTIONS` **and** no step carries a `target`, `to`, `targetDescription`, `x`, `y`, `toX` or `toY`.
- `extract` is **not** batchable: `executeAction` dispatches `controller.extract(action.target)` and a ref-free extract resolves to `missing_target`. Do not add it back without changing that dispatch.
- `MAX_BATCH_STEPS = 6`.
- An inadmissible batch **degrades to its first step**. It never fails the round, and it never executes unvalidated.
- `decision.action` always remains the first step, so every existing code path that reads `decision.action` keeps working untouched.
- Tests run with `node --test`. `electron/browser-agent/batching.test.cjs` is already matched by the
  existing `test:agent` glob `electron/browser-agent/*.test.cjs` — **do not edit `package.json`**.
- **File ownership:** this plan writes ONLY `electron/browser-agent/runtime/batch.cjs`, `electron/browser-agent/runtime/model.cjs`, `electron/browser-agent/runtime/executor.cjs`, `electron/browser-agent/agent/browser.md`, `electron/browser-agent/index.cjs`, `electron/browser-agent/batching.test.cjs`. Do not edit any other file — in particular, **not `package.json`**.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `electron/browser-agent/runtime/batch.cjs` | Admission policy + description | **New** — pure, no deps |
| `electron/browser-agent/runtime/model.cjs` | Decision contract | `DECISION_SCHEMA` gains `steps`; `decide()` passes it through |
| `electron/browser-agent/runtime/executor.cjs` | Decision normalisation | Degrade inadmissible batches to step 1 |
| `electron/browser-agent/index.cjs` | The loop | Execute admitted batches; report composite result |
| `electron/browser-agent/agent/browser.md` | Prompt | Tell the model when batching is correct |
| `electron/browser-agent/batching.test.cjs` | Tests | **New** |

---

### Task 1: The admission policy module

**Files:**
- Create: `electron/browser-agent/runtime/batch.cjs`
- Test: `electron/browser-agent/batching.test.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MAX_BATCH_STEPS: number` (6)
  - `BATCHABLE_ACTIONS: Set<string>`
  - `admitBatch(steps: object[]): {steps: object[], admitted: boolean, reason: string}` — returns the admitted sequence, or `{steps: [], admitted: false, reason}` when inadmissible.
  - `describeBatch(steps: object[]): string` — one line for history and progress.

- [ ] **Step 1: Write the failing test**

Create `electron/browser-agent/batching.test.cjs`:

```js
/**
 * Action batching tests.
 *
 * Run: node --test electron/browser-agent/batching.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const batch = require("./runtime/batch.cjs");

test("a ref-free read-only sequence is admitted", () => {
  const out = batch.admitBatch([
    { type: "scroll", direction: "down" },
    { type: "wait", ms: 400 },
    { type: "scroll", direction: "down" },
  ]);
  assert.equal(out.admitted, true);
  assert.equal(out.steps.length, 3);
});

test("a step carrying an element ref is refused", () => {
  const out = batch.admitBatch([
    { type: "scroll", direction: "down" },
    { type: "screenshot", target: "e12" },
  ]);
  assert.equal(out.admitted, false);
  assert.match(out.reason, /reference/i);
});

test("extract is refused — reading a named field is inherently targeted", () => {
  const out = batch.admitBatch([{ type: "scroll" }, { type: "extract" }]);
  assert.equal(out.admitted, false);
  assert.match(out.reason, /extract/);
});

test("a click is refused even without a ref", () => {
  const out = batch.admitBatch([{ type: "scroll" }, { type: "click_coord", x: 10, y: 10, label: "Buy" }]);
  assert.equal(out.admitted, false);
});

test("press_key is refused — Enter submits forms", () => {
  const out = batch.admitBatch([{ type: "scroll" }, { type: "press_key", key: "Enter" }]);
  assert.equal(out.admitted, false);
  assert.match(out.reason, /press_key/);
});

test("a sequence longer than the cap is refused", () => {
  const steps = Array.from({ length: 7 }, () => ({ type: "scroll" }));
  const out = batch.admitBatch(steps);
  assert.equal(out.admitted, false);
  assert.match(out.reason, /6/);
});

test("a single step is not a batch", () => {
  const out = batch.admitBatch([{ type: "scroll" }]);
  assert.equal(out.admitted, false);
  assert.match(out.reason, /single/i);
});

test("an empty or non-array input is refused without throwing", () => {
  assert.equal(batch.admitBatch([]).admitted, false);
  assert.equal(batch.admitBatch(null).admitted, false);
  assert.equal(batch.admitBatch(undefined).admitted, false);
});

test("a step with no type is refused", () => {
  assert.equal(batch.admitBatch([{ type: "scroll" }, {}]).admitted, false);
});

test("describeBatch names each step in order", () => {
  const line = batch.describeBatch([
    { type: "scroll", direction: "down" },
    { type: "screenshot" },
  ]);
  assert.match(line, /scroll/);
  assert.match(line, /screenshot/);
});

test("navigate may lead a batch but its url is required by the caller, not here", () => {
  const out = batch.admitBatch([
    { type: "navigate", url: "https://x.test/list" },
    { type: "wait", ms: 500 },
    { type: "screenshot" },
  ]);
  assert.equal(out.admitted, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test electron/browser-agent/batching.test.cjs`
Expected: FAIL — `Cannot find module './runtime/batch.cjs'`.

- [ ] **Step 3: Write the module**

Create `electron/browser-agent/runtime/batch.cjs`:

```js
/**
 * Which action sequences may run inside one model round.
 *
 * The agent decides one action per round and re-reads the page after each one.
 * That is correct when the result could change what to do next, and pure
 * overhead when it cannot: reading a long list costs one model round-trip per
 * scroll, and a 10-screen list burns half the round budget on scrolling.
 *
 * A batch is admissible only when every step in it is BOTH ref-free and
 * non-committing.
 *
 * The ref-free half is the load-bearing one. Element references are minted by
 * the snapshot taken before the round and resolve against that snapshot only;
 * after step 1 has run, every ref in the batch describes a page that no longer
 * exists. Refusing refs is therefore not a conservative nicety — it is the
 * property that makes a batch safe to plan in advance at all.
 *
 * The non-committing half keeps the safety gate honest. The gate judges
 * `decision.action`; if a later step could spend money, destroy data or deliver
 * something, it would run without ever being judged. So the batchable set holds
 * nothing that commits — `press_key` is excluded despite being ref-free,
 * because Enter submits forms.
 *
 * `extract` is excluded for a third reason: it is ref-free only in the sense
 * that a batch could omit the ref, and `controller.extract` has nothing to read
 * without one — `executeAction` dispatches `controller.extract(action.target)`,
 * which resolves an empty ref to `missing_target`. Reading a named field is
 * inherently a targeted act, so it stays its own round. Scrolling to make
 * content load still batches, and the observe that follows the batch reads the
 * whole document anyway.
 */

/** Most steps a batch may hold. Past this the page has usually moved on. */
const MAX_BATCH_STEPS = 6;

/**
 * Action types that may appear in a batch: ref-free, non-committing, and
 * meaningful when planned in advance.
 */
const BATCHABLE_ACTIONS = new Set([
  "scroll",
  "wait",
  "screenshot",
  "navigate",
  "go_back",
  "go_forward",
  "open_tab",
  "switch_tab",
]);

/**
 * Fields that carry a target resolved against the pre-batch snapshot. Any of
 * them present makes the step unplannable, whatever its type.
 */
const TARGET_FIELDS = ["target", "to", "targetDescription", "x", "y", "toX", "toY"];

function hasTarget(step) {
  return TARGET_FIELDS.some((f) => {
    const v = step[f];
    return v !== undefined && v !== null && v !== "";
  });
}

/**
 * Decide whether a proposed sequence may run as one round.
 *
 * @param {object[]} steps
 * @returns {{steps: object[], admitted: boolean, reason: string}}
 */
function admitBatch(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { steps: [], admitted: false, reason: "no steps" };
  }
  if (steps.length === 1) {
    return { steps: [], admitted: false, reason: "a single step is not a batch" };
  }
  if (steps.length > MAX_BATCH_STEPS) {
    return {
      steps: [],
      admitted: false,
      reason: `${steps.length} steps exceeds the cap of ${MAX_BATCH_STEPS}`,
    };
  }
  for (const step of steps) {
    if (!step || typeof step !== "object") {
      return { steps: [], admitted: false, reason: "a step is not an object" };
    }
    const type = String(step.type || "").trim();
    if (!type) return { steps: [], admitted: false, reason: "a step is missing its type" };
    if (!BATCHABLE_ACTIONS.has(type)) {
      return {
        steps: [],
        admitted: false,
        reason: `${type} cannot be planned in advance — it must be its own round`,
      };
    }
    if (hasTarget(step)) {
      return {
        steps: [],
        admitted: false,
        reason: `${type} carries an element reference, which is meaningless after the first step runs`,
      };
    }
  }
  return { steps: [...steps], admitted: true, reason: "" };
}

/** One history/progress line for a whole batch. */
function describeBatch(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return list
    .map((s) => {
      const type = String(s?.type || "?");
      if (type === "navigate" && s.url) return `navigate ${String(s.url).slice(0, 60)}`;
      if (type === "scroll") return `scroll ${s.direction === "up" ? "up" : "down"}`;
      if (type === "wait") return `wait ${Number(s.ms) || 800}ms`;
      return type;
    })
    .join(" → ");
}

module.exports = { MAX_BATCH_STEPS, BATCHABLE_ACTIONS, admitBatch, describeBatch };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test electron/browser-agent/batching.test.cjs`
Expected: PASS (11/11).

- [ ] **Step 5: Commit**

```bash
git add electron/browser-agent/runtime/batch.cjs electron/browser-agent/batching.test.cjs
git commit -m "feat(browser-agent): add batch admission policy"
```

---

### Task 2: Put `steps` in the decision contract

**Files:**
- Modify: `electron/browser-agent/runtime/model.cjs:38-90` (`DECISION_SCHEMA`) and `:251-264` (the `decide` return object)
- Test: `electron/browser-agent/batching.test.cjs`

**Interfaces:**
- Consumes: `MAX_BATCH_STEPS` from `runtime/batch.cjs` (Task 1) — for the schema description text only.
- Produces: `model.decide()` returns `steps: object[] | null` alongside the existing fields.

- [ ] **Step 1: Write the failing test**

Append to `electron/browser-agent/batching.test.cjs`:

```js
const { createAgentModel } = require("./runtime/model.cjs");

/** A model whose transport returns one canned payload. */
function cannedModel(payload) {
  return createAgentModel({
    apiBase: "https://api.test",
    getAuthToken: async () => "t",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }),
  });
}

test("decide passes a steps array through", async () => {
  const model = cannedModel({
    kind: "act",
    action: { type: "scroll", direction: "down" },
    steps: [
      { type: "scroll", direction: "down" },
      { type: "wait", ms: 400 },
    ],
    reason: "load the whole list",
  });
  const out = await model.decide({ system: "s", user: "u" });
  assert.equal(Array.isArray(out.steps), true);
  assert.equal(out.steps.length, 2);
});

test("decide reports steps as null when the model sends none", async () => {
  const model = cannedModel({ kind: "act", action: { type: "scroll" }, reason: "r" });
  const out = await model.decide({ system: "s", user: "u" });
  assert.equal(out.steps, null);
});

test("decide ignores a steps value that is not an array", async () => {
  const model = cannedModel({ kind: "act", action: { type: "scroll" }, steps: "nope", reason: "r" });
  const out = await model.decide({ system: "s", user: "u" });
  assert.equal(out.steps, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test electron/browser-agent/batching.test.cjs`
Expected: FAIL — `decide passes a steps array through` fails with `out.steps` being `undefined`, not an array.

> If the canned-transport shape does not match how `createAgentModel` calls `fetchImpl`, read `call()` at `runtime/model.cjs:166` and adjust `cannedModel` to match it exactly. Do not change `model.cjs` to suit the test.

- [ ] **Step 3: Add `steps` to the schema**

In `DECISION_SCHEMA`, immediately after the `action: {...}` property block closes and before `reason`, add:

```js
    steps: {
      type: "array",
      description:
        "Optional. A short sequence to run in one go INSTEAD of stopping after `action`, for when the " +
        "result of each step cannot change what the next one should be — scrolling down a long list to " +
        "make it load, or navigate → wait → screenshot. Every entry must be one of scroll, wait, screenshot, " +
        "navigate, go_back, go_forward, open_tab, switch_tab, and NONE may name an element (no target, " +
        "no coordinates) — element references stop meaning anything once the first step has run. " +
        "The first entry must equal `action`. Maximum 6. Anything else is ignored and only `action` runs.",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          url: { type: "string" },
          direction: { type: "string", enum: ["up", "down"] },
          ms: { type: "number" },
          tabId: { type: "string" },
        },
        required: ["type"],
      },
    },
```

- [ ] **Step 4: Pass `steps` through `decide`**

In the object returned by `decide` (around line 253), add after the `action:` line:

```js
        steps: Array.isArray(out.steps) ? out.steps : null,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test electron/browser-agent/batching.test.cjs`
Expected: PASS (14/14).

- [ ] **Step 6: Commit**

```bash
git add electron/browser-agent/runtime/model.cjs electron/browser-agent/batching.test.cjs
git commit -m "feat(browser-agent): add optional steps array to the decision contract"
```

---

### Task 3: Degrade inadmissible batches in `normalizeDecision`

**Files:**
- Modify: `electron/browser-agent/runtime/executor.cjs:1-13` (requires) and `:334-415` (`normalizeDecision`)
- Test: `electron/browser-agent/batching.test.cjs`

**Interfaces:**
- Consumes: `admitBatch` from `runtime/batch.cjs` (Task 1); `steps` from `model.decide` (Task 2).
- Produces: a normalised decision whose `steps` is either an admitted array of ≥2 entries or `null`. Never an inadmissible array. `batchRejected: string` carries the reason when one was dropped.

- [ ] **Step 1: Write the failing test**

Append to `electron/browser-agent/batching.test.cjs`:

```js
const { normalizeDecision } = require("./runtime/executor.cjs");

const emptySnapshot = { byRef: new Map(), elements: [] };

test("an admissible batch survives normalisation", () => {
  const out = normalizeDecision(
    {
      kind: "act",
      action: { type: "scroll", direction: "down" },
      steps: [{ type: "scroll", direction: "down" }, { type: "wait", ms: 400 }],
    },
    emptySnapshot,
  );
  assert.equal(out.kind, "act");
  assert.equal(out.steps.length, 2);
});

test("an inadmissible batch degrades to the first step, it does not fail the round", () => {
  const out = normalizeDecision(
    {
      kind: "act",
      action: { type: "scroll", direction: "down" },
      steps: [{ type: "scroll", direction: "down" }, { type: "click_coord", x: 5, y: 5, label: "Buy" }],
    },
    emptySnapshot,
  );
  assert.equal(out.kind, "act", "the round must still run");
  assert.equal(out.steps, null, "the batch must be gone");
  assert.deepEqual(out.action, { type: "scroll", direction: "down" });
  assert.match(out.batchRejected, /click_coord/);
});

test("a batch whose first step disagrees with action is refused", () => {
  const out = normalizeDecision(
    {
      kind: "act",
      action: { type: "scroll", direction: "down" },
      steps: [{ type: "extract" }, { type: "scroll" }],
    },
    emptySnapshot,
  );
  assert.equal(out.steps, null);
  assert.match(out.batchRejected, /first step/i);
});

test("a batch on a non-act decision is dropped", () => {
  const out = normalizeDecision(
    { kind: "finish", answer: "done", steps: [{ type: "scroll" }, { type: "extract" }] },
    emptySnapshot,
  );
  assert.equal(out.steps, null);
});

test("an invalid action still reports invalid even with a batch attached", () => {
  const out = normalizeDecision(
    { kind: "act", action: { type: "navigate" }, steps: [{ type: "navigate" }, { type: "extract" }] },
    emptySnapshot,
  );
  assert.equal(out.kind, "invalid");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test electron/browser-agent/batching.test.cjs`
Expected: FAIL — `an admissible batch survives normalisation` fails because `out.steps` is the raw array and no admission ran; more importantly `an inadmissible batch degrades…` fails with `out.steps` still holding the `click_coord`.

- [ ] **Step 3: Require the policy module**

At the top of `electron/browser-agent/runtime/executor.cjs`, alongside the existing requires, add:

```js
const batchPolicy = require("./batch.cjs");
```

- [ ] **Step 4: Screen the batch inside `normalizeDecision`**

`normalizeDecision` has several early `return { ...decision, kind: "invalid", ... }` paths and one final `return decision`. A batch must be stripped on **every** path, so do it once at the top rather than at each exit.

Insert this as the **first statement** in the function body, before `const describesTarget = ...`:

```js
  // Screen any proposed batch before anything else, so every exit below —
  // including the invalid ones — carries a decision whose `steps` is either
  // admitted or absent. An inadmissible batch is never a failed round: it
  // degrades to its first action, which is the one the safety gate judges.
  let batchRejected = "";
  if (Array.isArray(decision.steps) && decision.steps.length) {
    const first = decision.steps[0];
    if (decision.kind !== "act") {
      batchRejected = "only an act decision may carry steps";
      decision = { ...decision, steps: null };
    } else if (String(first?.type || "") !== String(decision.action?.type || "")) {
      batchRejected = "the first step must be the same action as `action`";
      decision = { ...decision, steps: null };
    } else {
      const admitted = batchPolicy.admitBatch(decision.steps);
      if (admitted.admitted) {
        decision = { ...decision, steps: admitted.steps };
      } else {
        batchRejected = admitted.reason;
        decision = { ...decision, steps: null };
      }
    }
  } else if (decision.steps !== null && decision.steps !== undefined) {
    decision = { ...decision, steps: null };
  }
  if (batchRejected) decision = { ...decision, batchRejected };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test electron/browser-agent/batching.test.cjs`
Expected: PASS (19/19).

- [ ] **Step 6: Run the full agent suite**

Run: `npm run test:agent`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add electron/browser-agent/runtime/executor.cjs electron/browser-agent/batching.test.cjs
git commit -m "feat(browser-agent): degrade inadmissible batches to their first step"
```

---

### Task 4: Execute batches in the loop, and tell the model when to use them

**Files:**
- Modify: `electron/browser-agent/index.cjs` — the requires block (~line 19-30), the execute section (~line 645-660), and `executeAction` (~line 838)
- Modify: `electron/browser-agent/agent/browser.md`
- Test: `electron/browser-agent/batching.test.cjs`

**Interfaces:**
- Consumes: `decision.steps` (Task 3), `describeBatch` (Task 1).
- Produces: `executeBatch(controller, steps)` → `{ok, error, ran, total, results, lastType}`.

- [ ] **Step 1: Write the failing test**

Append to `electron/browser-agent/batching.test.cjs`:

```js
const { executeBatch } = require("./index.cjs");

/** A controller that records calls and can be told to fail at step N. */
function fakeController({ failAt = -1 } = {}) {
  const calls = [];
  const ok = () => ({ ok: true });
  let n = 0;
  const step = (type) => async (...args) => {
    n += 1;
    calls.push({ type, args });
    return n === failAt ? { ok: false, error: "boom" } : ok();
  };
  return {
    calls,
    controller: {
      scroll: step("scroll"),
      wait: step("wait"),
      screenshot: step("screenshot"),
      screenshot: step("screenshot"),
      navigate: step("navigate"),
      goBack: step("go_back"),
      goForward: step("go_forward"),
      openTab: step("open_tab"),
      switchTab: step("switch_tab"),
      settle: async () => {},
    },
  };
}

test("a batch runs every step in order", async () => {
  const { calls, controller } = fakeController();
  const out = await executeBatch(controller, [
    { type: "scroll", direction: "down" },
    { type: "screenshot" },
    { type: "scroll", direction: "down" },
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.ran, 3);
  assert.deepEqual(calls.map((c) => c.type), ["scroll", "screenshot", "scroll"]);
});

test("a batch stops at the first failing step", async () => {
  const { calls, controller } = fakeController({ failAt: 2 });
  const out = await executeBatch(controller, [
    { type: "scroll" },
    { type: "screenshot" },
    { type: "scroll" },
  ]);
  assert.equal(out.ok, false);
  assert.equal(out.ran, 2, "the step that failed counts as run; the one after it must not");
  assert.equal(calls.length, 2);
  assert.equal(out.error, "boom");
});

test("a batch reports how far it got", async () => {
  const { controller } = fakeController({ failAt: 1 });
  const out = await executeBatch(controller, [{ type: "scroll" }, { type: "screenshot" }]);
  assert.equal(out.total, 2);
  assert.equal(out.ran, 1);
});

test("a throwing step is caught, not propagated", async () => {
  const controller = {
    scroll: async () => {
      throw new Error("detached");
    },
    settle: async () => {},
  };
  const out = await executeBatch(controller, [{ type: "scroll" }, { type: "screenshot" }]);
  assert.equal(out.ok, false);
  assert.match(out.error, /detached/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test electron/browser-agent/batching.test.cjs`
Expected: FAIL — `executeBatch is not a function`.

- [ ] **Step 3: Add `executeBatch` and export it**

In `electron/browser-agent/index.cjs`, add immediately **after** the existing `executeAction` function (which ends around line 890):

```js
/**
 * Run an admitted batch as one unit.
 *
 * Steps are ordered and the page settles between them, because a scroll that
 * has not painted yet extracts the previous screen. The first failure ends the
 * batch: the sequence was planned against a page that has now behaved
 * unexpectedly, so everything after it was planned on a false premise.
 *
 * Nothing here re-validates the steps — `normalizeDecision` has already
 * guaranteed they are ref-free and non-committing, and duplicating that rule
 * is how the two copies drift apart.
 */
async function executeBatch(controller, steps) {
  const list = Array.isArray(steps) ? steps : [];
  const results = [];
  let lastType = "";
  for (let i = 0; i < list.length; i += 1) {
    const step = list[i];
    lastType = String(step?.type || "");
    let res;
    try {
      res = await executeAction(controller, step);
    } catch (e) {
      res = { ok: false, error: e?.message || String(e) };
    }
    results.push(res);
    if (!res || res.ok === false) {
      return {
        ok: false,
        error: res?.error || "batch_step_failed",
        ran: i + 1,
        total: list.length,
        results,
        lastType,
      };
    }
    // Let the page catch up before the next step reads or scrolls it.
    if (i < list.length - 1) {
      try {
        await controller.settle(2500);
      } catch {
        /* settling is best-effort */
      }
    }
  }
  return { ok: true, error: "", ran: list.length, total: list.length, results, lastType };
}
```

Add `executeBatch` to the `module.exports` object at the bottom of `index.cjs`:

```js
  executeBatch,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test electron/browser-agent/batching.test.cjs`
Expected: PASS (23/23).

- [ ] **Step 5: Use it in the loop**

In `index.cjs`, require the policy module alongside the other runtime requires:

```js
const batchPolicy = require("./runtime/batch.cjs");
```

Then, in the execute section, replace the single-action call:

```js
    const actionResult = await timer.time("actuate", () =>
      executeAction(controller, decision.action)).catch((e) => ({
      ok: false,
      error: e?.message || String(e),
    }));
```

with:

```js
    // A batch runs the whole planned sequence; everything else is one action.
    // `decision.steps` is only ever populated when normalizeDecision admitted
    // it, so this branch never needs to re-check what is in it.
    const batched = Array.isArray(decision.steps) && decision.steps.length > 1;
    const actionResult = await timer.time("actuate", () =>
      batched
        ? executeBatch(controller, decision.steps)
        : executeAction(controller, decision.action)).catch((e) => ({
      ok: false,
      error: e?.message || String(e),
    }));
    if (batched) {
      debug.log("batch_ran", {
        round: task.round,
        steps: batchPolicy.describeBatch(decision.steps),
        ran: actionResult?.ran,
        total: actionResult?.total,
        ok: actionResult?.ok !== false,
      });
      // The batch spent one round for several actions; say so in history or the
      // model reads the transcript as though only the first step happened.
      taskState.addFact(
        task,
        `ran ${actionResult?.ran ?? 0}/${actionResult?.total ?? 0} steps in one round: ` +
          batchPolicy.describeBatch(decision.steps),
      );
    }
```

Then extend the `onProgress({ phase: "acting", ... })` call just above it with one field so the UI can narrate a sequence:

```js
      batch: batched ? batchPolicy.describeBatch(decision.steps) : "",
```

Note: `batched` is declared after that `onProgress` call in the code above. Move the `const batched = ...` line to sit **before** the `onProgress({ phase: "acting", ... })` call — immediately after `const targetEl = ...` — so both can read it.

- [ ] **Step 6: Tell the model when batching is correct**

Append to `electron/browser-agent/agent/browser.md`:

```markdown
## Doing several things in one round

Most rounds are one action, because the result of that action decides what
should happen next. Some are not: scrolling to the end of a long list, or
opening a page and waiting for it, is a sequence you can plan before you start,
because nothing you learn part-way through would change the rest of it.

For those, send `steps` — the whole sequence — alongside `action`. The first
entry must be the same action as `action`. All of it runs in one round.

A sequence may only contain `scroll`, `wait`, `screenshot`, `navigate`,
`go_back`, `go_forward`, `open_tab` and `switch_tab`, and **no step may name an
element**. That is not a style rule. Element references belong to
the page as it was when you were handed the list; once the first step runs, the
page has moved and those references mean nothing. Anything you have to aim at —
a click, typing into a field, a drag — is its own round, so you can look first.

Send at most six steps. If any of this does not hold, only `action` runs and
the rest is discarded, so a sequence you were unsure about costs you the round
you were trying to save.

Good: `scroll → scroll → scroll` to make a long lazy-loading list render. The
page you are handed afterwards is read whole, so you do not need to stop and
read between scrolls.
Good: `navigate → wait → screenshot` to open a page and look at it.
Wrong: `click → type → click` — every one of those needs to see the page first.
Wrong: anything containing `extract`. Reading a named field means aiming at it,
and what you aim at has to come from the page in front of you.
```

- [ ] **Step 7: Run the full agent suite**

Run: `npm run test:agent`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add electron/browser-agent/index.cjs electron/browser-agent/agent/browser.md electron/browser-agent/batching.test.cjs
git commit -m "feat(browser-agent): execute admitted action batches in one round"
```

---

## Verification

- [ ] `npm run test:agent` passes.
- [ ] `npm run test:eval` passes.
- [ ] Grep confirms no batch bypasses admission — this must print exactly two hits, both in `index.cjs`
      (the `async function executeBatch` definition and the single call site):
      `grep -rn "executeBatch(" electron/browser-agent --include=*.cjs | grep -v test`
- [ ] `npm run lint` reports no new errors in the touched files.
