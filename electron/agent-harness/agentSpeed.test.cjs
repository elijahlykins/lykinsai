// The latency work: what each change is supposed to remove, asserted so it
// cannot quietly come back.
//
// Baseline being fixed — every Bot turn paid, in sequence:
//   route → decide → the work → verify → decide(deliver)
// three to five blocking model round-trips wrapped around one piece of work.
const test = require("node:test");
const assert = require("node:assert/strict");

const contextRouter = require("./runtime/contextRouter.cjs");
const { createTurnTimings } = require("./runtime/turnTimings.cjs");
const agentExecutor = require("../task-runtime/executors/agentExecutor.cjs");

/* ── 02: the fast path ──────────────────────────────────────────────────── */

const EXECUTORS = {
  reply: () => {},
  web_search: () => {},
  generate_image: () => {},
  write_document: () => {},
  browser: () => {},
  research_report: () => {},
  connected_apps: () => {},
};

test("a settled single-tool ask runs without a planning round", () => {
  const direct = (primaryTool, objective) =>
    agentExecutor.resolveDirectTool({ primaryTool, objective, executors: EXECUTORS });

  assert.equal(direct("web_search", "check the news"), "web_search");
  assert.equal(direct("generate_image", "draw me a logo"), "generate_image");
  assert.equal(direct("reply", "what do you think of this idea"), "reply");
});

test("consequential and composing tools always keep the full harness", () => {
  const direct = (primaryTool, objective) =>
    agentExecutor.resolveDirectTool({ primaryTool, objective, executors: EXECUTORS });

  // Reaches the outside world or the user's accounts.
  assert.equal(direct("browser", "book me a flight"), "");
  assert.equal(direct("connected_apps", "check my inbox"), "");
  // Composes with later work often enough that the planner has a job.
  assert.equal(direct("research_report", "write me a report on X"), "");
});

test("a multi-part ask keeps the loop, because one call cannot finish it", () => {
  const direct = (objective) =>
    agentExecutor.resolveDirectTool({ primaryTool: "web_search", objective, executors: EXECUTORS });

  assert.equal(direct("check the news and put the headlines in a doc"), "");
  assert.equal(direct("look up tesla earnings, then email me a summary"), "");
  assert.equal(direct("find the latest AI news and then build me a deck"), "");
  assert.equal(direct("search for X as well as a chart"), "");
  assert.equal(direct("get the scores. next, save them"), "");
  // …but an ordinary single ask is not tripped by an incidental "and".
  assert.equal(direct("what happened with tesla and rivian this week"), "web_search");
});

test("reply stays direct even when the message rambles", () => {
  // A chatty multi-part message is still one reply — this branch has always
  // been unconditional and must stay that way.
  assert.equal(
    agentExecutor.resolveDirectTool({
      primaryTool: "reply",
      objective: "tell me about X and then also what you think of Y",
      executors: EXECUTORS,
    }),
    "reply",
  );
  assert.equal(
    agentExecutor.resolveDirectTool({ replyOnly: true, primaryTool: "", objective: "hi", executors: EXECUTORS }),
    "reply",
  );
});

test("an unavailable executor never takes the fast path", () => {
  assert.equal(
    agentExecutor.resolveDirectTool({ primaryTool: "web_search", objective: "check the news", executors: {} }),
    "",
  );
});

/* ── 04: the split schema ───────────────────────────────────────────────── */

test("a next-step decision no longer reserves the deliver budget", () => {
  assert.ok(!("answer" in contextRouter.AGENT_STEP_SCHEMA.properties));
  assert.ok("tool" in contextRouter.AGENT_STEP_SCHEMA.properties);
  assert.ok("narration" in contextRouter.AGENT_STEP_SCHEMA.properties);
  assert.ok(contextRouter.STEP_MAX_TOKENS < contextRouter.DELIVER_MAX_TOKENS);
  assert.equal(contextRouter.DELIVER_MAX_TOKENS, 4000);
});

test("the deliver call asks for the answer and nothing else", () => {
  assert.deepEqual(Object.keys(contextRouter.AGENT_DELIVER_SCHEMA.properties), ["answer"]);
  assert.deepEqual(contextRouter.AGENT_DELIVER_SCHEMA.required, ["answer"]);
});

test("the deliver prompt drops the next-step framing", () => {
  const state = require("./runtime/taskState.cjs").createTaskState({
    goal: "check the news",
    successCondition: "",
    doNot: [],
  });
  const user = contextRouter.buildDeliverUser({ state });
  assert.ok(!user.includes("Decide the next structured step now."));
  assert.match(user, /Write the final message the user reads now/);
  assert.match(user, /check the news/);
});

/* ── 01: instrumentation ────────────────────────────────────────────────── */

test("a turn reports where its wall clock went", async () => {
  const t = createTurnTimings({ taskId: "task_abc123" });
  await t.span("decide", "r1", async () => {});
  t.markFirstOutput();
  await t.span("tool", "web_search", async () => {});
  await t.span("deliver", async () => {});

  const s = t.summary({ calls: 2, upstreamMs: 0 });
  assert.equal(s.taskId, "task_abc123");
  assert.deepEqual(s.spans.map((x) => x.phase), ["decide", "tool", "deliver"]);
  assert.deepEqual(s.spans.map((x) => x.detail), ["r1", "web_search", ""]);
  assert.ok(s.totalMs >= 0);
  // First output is recorded even though it happened mid-turn.
  assert.ok(s.firstOutputMs >= 0);
});

test("timing separates provider time from our own overhead", async () => {
  const t = createTurnTimings({});
  await t.span("decide", async () => new Promise((r) => setTimeout(r, 20)));
  // The provider says it spent 5ms of that; the rest is ours.
  const s = t.summary({ calls: 1, upstreamMs: 5 });
  assert.ok(s.overheadMs > 0, "overhead should be the gap between wall clock and upstream");
  // Tool time is the work, not model overhead, so it never inflates the gap.
  const t2 = createTurnTimings({});
  await t2.span("tool", "browser", async () => new Promise((r) => setTimeout(r, 20)));
  assert.equal(t2.summary({ calls: 0, upstreamMs: 0 }).overheadMs, 0);
});

test("a throwing span is still recorded", async () => {
  const t = createTurnTimings({});
  await assert.rejects(() => t.span("decide", async () => { throw new Error("boom"); }));
  assert.equal(t.summary().spans.length, 1);
});

/* ── Stage model tuning ─────────────────────────────────────────────────── */
//
// The harness's stages resolve their model from env tuning with a shared
// default. The plumbing stages stay cheap: dragging a 120-token dispatcher
// onto a frontier model spends the user's money without changing an answer.
const { resolveAgentStageModel } = require("../../lib/agentModelProviders.js");

test("stage env tuning applies over the shared default", () => {
  const env = { BOT_DECIDE_MODEL: "gpt-5.6-luna", BROWSER_AGENT_VERIFY_MODEL: "gpt-4.1-mini" };
  assert.equal(resolveAgentStageModel({ stage: "decide", env }).model, "gpt-5.6-luna");
  assert.equal(resolveAgentStageModel({ stage: "verify", env }).model, "gpt-4.1-mini");
  // Untuned stages fall back to the shared base model.
  assert.equal(resolveAgentStageModel({ stage: "deliver", env: {} }).model, resolveAgentStageModel({ stage: "decide", env: {} }).model);
});
