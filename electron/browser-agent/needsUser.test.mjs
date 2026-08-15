/**
 * When the agent reaches something only the user can do — a login, a click it
 * isn't allowed to make, a wall it can't get past — it should hand over the tab
 * and WAIT, then carry on from where it left off. Ending the run there means the
 * user has to ask for the whole task again, losing everything already done.
 *
 * These tests drive the real loop with a fake browser and a scripted model.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { runBrowserAgentTask } = require("./index.cjs");

function makeSnapshot(overrides = {}) {
  const elements = overrides.elements || [
    { ref: "e1", role: "button", label: "Continue", inView: true },
    { ref: "e2", role: "button", label: "Send", inView: true },
  ];
  return {
    url: overrides.url || "https://example.com/step",
    title: overrides.title || "Example",
    tabs: [{ id: 1, title: "Example", url: "https://example.com/step", active: true }],
    elements,
    visibleText: overrides.visibleText || "a page",
    byRef: new Map(elements.map((e) => [e.ref, e])),
  };
}

/** Minimal controller: every action succeeds and the page always "changes". */
function makeController() {
  let snapshot = makeSnapshot();
  return {
    getPageState: async () => snapshot,
    getCurrentSnapshot: () => snapshot,
    settle: async () => {},
    invalidate: () => {},
    diffSnapshots: () => ({ urlChanged: true, summary: "page advanced" }),
    click: async () => ({ ok: true, clickedLabel: "Continue" }),
    type: async () => ({ ok: true }),
    navigate: async () => ({ ok: true }),
    extract: async () => ({ ok: true, value: "" }),
    screenshot: async () => ({ ok: false }),
    scroll: async () => ({ ok: true }),
    pressKey: async () => ({ ok: true }),
    wait: async () => ({ ok: true }),
  };
}

/** Returns each scripted decision in turn, repeating the last one forever. */
function makeModel(decisions) {
  let i = 0;
  return {
    plan: async () => ({ plan: ["do the thing"], constraints: [], knownFacts: {}, skills: [] }),
    decide: async () => {
      const d = decisions[Math.min(i, decisions.length - 1)];
      i += 1;
      return { factsLearned: [], candidateResults: [], ...d };
    },
    verify: async () => ({ success: true, evidence: "page advanced", reason: "", next: "continue" }),
  };
}

const ACT_CONTINUE = {
  kind: "act",
  risk: "low",
  reason: "advance",
  expectedOutcome: "the next screen",
  action: { type: "click", target: "e1" },
};
const ASK_PASSWORD = {
  kind: "ask_user",
  risk: "read",
  question: "I need your password to sign in — can you enter it?",
};
const FINISH = { kind: "finish", risk: "read", answer: "All done.", reason: "goal achieved" };

function run(decisions, opts = {}) {
  return runBrowserAgentTask({
    goal: "finish the setup flow",
    userAsk: "finish the setup flow",
    controller: makeController(),
    model: makeModel(decisions),
    maxRounds: 6,
    ...opts,
  });
}

test("a login stop waits for the user, then finishes the task", async () => {
  const calls = [];
  const result = await run([ASK_PASSWORD, ACT_CONTINUE, FINISH], {
    onNeedsUser: async (req) => {
      calls.push(req.kind);
      return { resumed: true, note: "the user signed in" };
    },
  });

  assert.deepEqual(calls, ["input"], "should have handed over exactly once");
  assert.equal(result.status, "completed");
  assert.equal(result.answer, "All done.");
});

test("what the user did is recorded so the agent doesn't re-ask", async () => {
  const result = await run([ASK_PASSWORD, FINISH], {
    onNeedsUser: async () => ({ resumed: true, note: "the user signed in" }),
  });
  assert.ok(
    result.task.workingMemory.facts.includes("the user signed in"),
    "the assist should land in working memory",
  );
});

test("if the user never acts, it still reports what it needs", async () => {
  const result = await run([ASK_PASSWORD, FINISH], {
    onNeedsUser: async () => ({ resumed: false }),
  });
  assert.equal(result.status, "waiting_for_user");
  assert.equal(result.needsUser, true);
  assert.match(result.answer, /password/i);
});

test("with no watcher wired up, behaviour is unchanged", async () => {
  const result = await run([ASK_PASSWORD, FINISH]);
  assert.equal(result.status, "waiting_for_user");
  assert.equal(result.needsUser, true);
});

/** A run whose only gated action is clicking Send on a prepared campaign. */
function runSendApproval(opts = {}) {
  return runBrowserAgentTask({
    goal: "prep a campaign for all of our clients",
    userAsk: "prep a campaign for all of our clients",
    controller: makeController(),
    model: makeModel([
      { ...ACT_CONTINUE, action: { type: "click", target: "e2" }, expectedOutcome: "sent to all subscribers" },
      FINISH,
    ]),
    maxRounds: 6,
    ...opts,
  });
}

test("a send that needs a decision asks one short yes/no question", async () => {
  const asked = [];
  const result = await runSendApproval({
    onApprovalNeeded: async ({ question }) => {
      asked.push(question);
      return true;
    },
  });

  assert.equal(asked.length, 1, "should ask exactly once");
  assert.match(asked[0], /want me to click "Send"\?$/, "should be a plain yes/no question");
  assert.equal(result.status, "completed", "approving continues the same run");
});

test("answering no ends it there instead of nagging", async () => {
  const handedOver = [];
  const result = await runSendApproval({
    onApprovalNeeded: async () => false,
    onNeedsUser: async (req) => {
      handedOver.push(req.kind);
      return { resumed: true, note: "the user changed the page by hand" };
    },
  });

  assert.deepEqual(handedOver, [], "a no must not fall through to watching the tab");
  assert.equal(result.status, "waiting_for_user");
  assert.equal(result.needsApproval, true);
});

test("with no way to ask inline, it watches in case the user clicks it", async () => {
  const calls = [];
  const result = await runSendApproval({
    onNeedsUser: async (req) => {
      calls.push(req.kind);
      return { resumed: true, note: "the user changed the page by hand" };
    },
  });

  assert.deepEqual(calls, ["approval"]);
  assert.equal(result.status, "completed");
});

test("running out of rounds asks for a nudge before failing", async () => {
  const calls = [];
  const result = await runBrowserAgentTask({
    goal: "finish the setup flow",
    userAsk: "finish the setup flow",
    controller: makeController(),
    // Never finishes on its own — it will burn through the budget.
    model: makeModel([ACT_CONTINUE]),
    maxRounds: 2,
    onNeedsUser: async (req) => {
      calls.push(req.kind);
      // Decline the second time so the test terminates.
      return calls.length === 1 ? { resumed: true, note: "the user moved it along" } : { resumed: false };
    },
  });

  assert.deepEqual(calls, ["exhausted", "exhausted"], "should offer the wheel, then give up");
  assert.equal(result.status, "failed");
  assert.match(result.answer, /ran out of steps/i);
});

test("a resume buys more rounds rather than dying mid-flow", async () => {
  let handed = 0;
  const result = await runBrowserAgentTask({
    goal: "finish the setup flow",
    userAsk: "finish the setup flow",
    controller: makeController(),
    // One ask_user, then enough acting to exceed the original 2-round budget.
    model: makeModel([ASK_PASSWORD, ACT_CONTINUE, ACT_CONTINUE, ACT_CONTINUE, FINISH]),
    maxRounds: 2,
    onNeedsUser: async () => {
      handed += 1;
      return { resumed: true, note: "the user signed in" };
    },
  });

  assert.equal(handed, 1, "only the login should need the user");
  assert.equal(result.status, "completed");
});
