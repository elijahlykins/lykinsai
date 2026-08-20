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
