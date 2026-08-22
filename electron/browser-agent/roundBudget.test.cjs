/**
 * Round-budget termination.
 *
 * The loop grants extra rounds every time the user unblocks a task by hand, up
 * to a ceiling. Reaching that ceiling used to leave the exhaustion guard
 * permanently true: waitForUser kept resolving, `continue` looped, and the run
 * never ended. With real I/O it was an unbounded run; with mocked I/O it is a
 * tight microtask loop that starves timers, so nothing can interrupt it.
 *
 * Run: node --test electron/browser-agent/roundBudget.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const { runBrowserAgentTask, createBrowserController } = require("./index.cjs");

function harness() {
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
    runAction: async () => ({ ok: true }),
    navigate: async () => ({ ok: true }),
    waitForLoad: async () => {},
  };
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "https://x.test/",
    getTitle: () => "X",
  };
  return createBrowserController({ webContents, actuator });
}

/** Never finishes on its own, so only the budget can end the run. */
function neverFinishingModel() {
  return {
    plan: async () => ({ plan: ["keep going"], skills: [], constraints: [] }),
    decide: async () => ({
      kind: "act",
      action: { type: "scroll", direction: "down" },
      reason: "keep going",
      expectedOutcome: "more of the page",
      risk: "read",
      factsLearned: [],
      candidateResults: [],
    }),
    verify: async () => ({ progressed: true, note: "" }),
    learn: async () => ({ notes: [], userNotes: [] }),
  };
}

test("a user who keeps resuming an exhausted task still gets an ending", async () => {
  let resumes = 0;
  const out = await runBrowserAgentTask({
    goal: "scroll forever",
    controller: harness(),
    model: neverFinishingModel(),
    maxRounds: 2,
    // Always says the user nudged it along. Before the ceiling guard this
    // looped forever; the run must now terminate on its own.
    onNeedsUser: async () => {
      resumes += 1;
      if (resumes > 200) throw new Error("runaway: onNeedsUser called 200+ times");
      return { resumed: true, note: "the user scrolled" };
    },
  });
  assert.ok(out, "the run must resolve");
  assert.ok(resumes > 0, "the user should have been asked at least once");
  assert.ok(resumes < 200, `the run must stop asking; it asked ${resumes} times`);
});

test("declining to help ends the run immediately, as before", async () => {
  let resumes = 0;
  const out = await runBrowserAgentTask({
    goal: "scroll forever",
    controller: harness(),
    model: neverFinishingModel(),
    maxRounds: 2,
    onNeedsUser: async () => {
      resumes += 1;
      return { resumed: false };
    },
  });
  assert.ok(out);
  assert.equal(resumes, 1, "one ask, then the run ends");
});
