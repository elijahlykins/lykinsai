// The Bot's tool set, and the two ways it used to fail a task.
//
// 1. There was no way to look something up. The registry went straight from
//    "answer from memory" to "open a real browser and drive it", so "check
//    the news" meant watching a browser window.
// 2. `browser` was terminal — a successful browse ENDED the task — so a
//    two-part ask ("check the news and put it in a doc") stopped after the
//    first part.
const test = require("node:test");
const assert = require("node:assert/strict");

const registry = require("../agent-harness/runtime/toolRegistry.cjs");
const instructions = require("../agent-harness/runtime/instructions.cjs");

test("the bot can look something up without opening a browser", () => {
  const tool = registry.getTool("web_search");
  assert.ok(tool, "web_search must exist in the registry");
  assert.equal(tool.risk, "read");
  // Searching is a step in a task, never the end of one.
  assert.equal(tool.terminal, false);
});

test("every registered tool has a doc the disclosure step can load", () => {
  for (const tool of registry.listTools({ localMode: true })) {
    const doc = instructions.loadToolDoc(tool.name);
    assert.ok(
      doc && doc.trim(),
      `${tool.name} has no doc — progressive disclosure would load nothing and the model would call it blind`,
    );
  }
});

test("the tool index tells the model when to search instead of browsing", () => {
  const index = registry.toolIndexBlock({ localMode: false });
  assert.match(index, /`web_search`/);
  assert.match(index, /`browser`/);
  assert.match(index, /`connected_apps`/);
});

test("the web_search doc routes the reader to the right neighbour", () => {
  const doc = instructions.loadToolDoc("web_search");
  assert.match(doc, /Prefer this over `browser`/);
  assert.match(doc, /connected_apps/);
  assert.match(doc, /research_report/);
});

test("browsing no longer ends the task on its own", () => {
  const browser = registry.getTool("browser");
  assert.equal(
    browser.terminal,
    false,
    "a terminal browser tool stops a multi-part task after its first step",
  );
  // Its write-up still has to survive: the user already read it, so a later
  // deliver must close over it rather than replace it with a teaser.
  assert.equal(browser.preserveAnswer, true);
});

test("only tools whose output IS the delivery end a task", () => {
  const terminal = registry
    .listTools({ localMode: true })
    .filter((t) => t.terminal)
    .map((t) => t.name);
  // reply and write_document both hand the user the finished thing directly.
  assert.deepEqual(terminal.sort(), ["reply", "write_document"]);
});

test("connected apps outrank the browser in both directions", () => {
  assert.match(registry.getTool("connected_apps").summary, /Prefer this over the browser/i);
  assert.match(registry.getTool("browser").summary, /use connected_apps instead/i);
});

// --- The planner has to KNOW what is connected -----------------------------
//
// The tool index says "prefer connected_apps when the app is connected", but
// nothing told the model which apps those were — so it defaulted to the
// browser and logged in by hand. The list rides in the per-round user message
// (the system prompt is byte-stable per bot so its cache prefix survives).
const contextRouter = require("../agent-harness/runtime/contextRouter.cjs");
const taskState = require("../agent-harness/runtime/taskState.cjs");

function stateFor(goal) {
  return taskState.createTaskState({ goal, successCondition: "", doNot: [] });
}

test("connected apps are named in the task context", () => {
  const user = contextRouter.buildTaskUser({
    state: stateFor("check my email"),
    connectedApps: [{ id: "gmail", name: "Gmail" }, { id: "slack", name: "Slack" }],
  });
  assert.match(user, /CONNECTED APPS/);
  assert.match(user, /Gmail, Slack/);
  assert.match(user, /not the browser/);
});

test("no connections means no block, not an empty heading", () => {
  const user = contextRouter.buildTaskUser({ state: stateFor("check my email") });
  assert.ok(!user.includes("CONNECTED APPS"));
});

test("the connected list rides in the user turn, never the cached system prompt", () => {
  const system = contextRouter.buildDecisionSystem({ bot: { name: "Ada" } });
  assert.ok(
    !system.includes("CONNECTED APPS"),
    "putting the connection list in the system prompt would bust the per-bot cache prefix",
  );
});

test("the deliver contract no longer calls the browser a terminal delivery", () => {
  const system = contextRouter.buildDecisionSystem({ bot: null });
  assert.ok(
    !/wrap-up after reply, write_document, or browser/.test(system),
    "the contract still tells the model the browser ends the task",
  );
  assert.match(system, /finish any remaining parts of the task/);
});
