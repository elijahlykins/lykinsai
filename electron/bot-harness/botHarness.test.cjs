"use strict";

/**
 * The Bot harness: persona-carrying system prompt, progressive tool
 * disclosure, the decide → act → verify loop, the safety gate, and the
 * terminal delivery.
 *
 * Run: node --test electron/bot-harness/botHarness.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const harness = require("./index.cjs");
const contextRouter = require("./runtime/contextRouter.cjs");
const registry = require("./runtime/toolRegistry.cjs");

const BOT = { name: "Scout", role: "Research Analyst", persona: "Blunt, fast, loves tables." };

/** A scripted model: decisions play in order; verify verdicts likewise. */
function fakeModel(decisions, verifications = []) {
  const seen = { systems: [], users: [], verifies: [] };
  return {
    seen,
    model: {
      structured: async (stage, { system, user }) => {
        seen.systems.push(system);
        seen.users.push(user);
        const next = decisions.shift();
        if (!next) throw new Error("fake model ran out of scripted decisions");
        return next;
      },
      verify: async ({ user }) => {
        seen.verifies.push(user);
        return verifications.shift() || { success: true, evidence: "verified", next: "continue" };
      },
    },
  };
}

function okExecutor(output) {
  const calls = [];
  return {
    calls,
    fn: async ({ instruction }) => {
      calls.push(instruction);
      return { ok: true, output };
    },
  };
}

/* ── System prompt ────────────────────────────────────────────────────────── */

test("system prompt carries identity + rules + tool index, but no full tool docs", () => {
  const system = contextRouter.buildDecisionSystem({ bot: BOT, localMode: false });
  // Corpus layers.
  assert.match(system, /You are a LYKN Bot/);
  assert.match(system, /# Core Rules/);
  assert.match(system, /# Safety Rules/);
  assert.match(system, /# Output Contract/);
  // Per-bot identity, in the SYSTEM prompt — not a decaying message header.
  assert.match(system, /Your name is Scout, and you work as their Research Analyst/);
  assert.match(system, /Blunt, fast, loves tables\./);
  // The index: names + one line each.
  assert.match(system, /# Tool Index/);
  for (const t of registry.listTools({ localMode: false })) {
    assert.ok(system.includes(`\`${t.name}\``), `index lists ${t.name}`);
  }
  // Progressive disclosure: full docs stay OUT of the system prompt.
  assert.doesNotMatch(system, /# Tool: reply/);
  assert.doesNotMatch(system, /# Tool: browser/);
});

test("system prompt is byte-stable for the same bot, and local mode gates the local tool", () => {
  const a = contextRouter.buildDecisionSystem({ bot: BOT, localMode: false });
  const b = contextRouter.buildDecisionSystem({ bot: BOT, localMode: false });
  assert.equal(a, b);
  assert.doesNotMatch(a, /`local_computer`/);
  const withLocal = contextRouter.buildDecisionSystem({ bot: BOT, localMode: true });
  assert.match(withLocal, /`local_computer`/);
});

/* ── Progressive disclosure ───────────────────────────────────────────────── */

test("first selection of a tool loads its doc instead of running; the call runs next round", async () => {
  const { model, seen } = fakeModel([
    { kind: "use_tool", tool: "generate_image", instruction: "a fox logo", narration: "Making the logo." },
    { kind: "use_tool", tool: "generate_image", instruction: "a fox logo, flat, orange", narration: "Making the logo." },
    { kind: "deliver", answer: "Logo's done — flat orange fox, opened for you." },
  ]);
  const image = okExecutor("image generated: fox logo");
  const res = await harness.runBotTask({
    goal: "make me a fox logo",
    bot: BOT,
    model,
    executors: { generate_image: image.fn },
  });
  assert.equal(res.status, "completed");
  // Round 1 selected the tool → doc read, no execution.
  assert.equal(image.calls.length, 1);
  assert.equal(image.calls[0], "a fox logo, flat, orange");
  // Round 2's user message carried the full doc.
  assert.match(seen.users[1], /# Tool: generate_image/);
  assert.match(seen.users[1], /read the full instructions/);
  // And the record shows the read.
  assert.ok(res.events.some((e) => e.kind === "doc" && e.tool === "generate_image"));
});

test("primaryTool preloads its doc so the routed single-tool task runs on round one", async () => {
  const { model, seen } = fakeModel([
    { kind: "use_tool", tool: "research_report", instruction: "espresso machines under $500", narration: "Researching." },
    { kind: "deliver", answer: "Report's ready — three machines stood out." },
  ]);
  const research = okExecutor("# Report\nLots of sourced findings…");
  const res = await harness.runBotTask({
    goal: "research espresso machines under $500",
    bot: BOT,
    model,
    executors: { research_report: research.fn },
    primaryTool: "research_report",
  });
  assert.equal(res.status, "completed");
  assert.equal(research.calls.length, 1);
  // The doc was in context from round one.
  assert.match(seen.users[0], /# Tool: research_report/);
});

/* ── Delivery discipline ──────────────────────────────────────────────────── */

test("delivering with nothing run gets one pushback, then stands", async () => {
  const { model, seen } = fakeModel([
    { kind: "deliver", answer: "All done!" },
    { kind: "deliver", answer: "This needs nothing from my tools — here's the answer directly." },
  ]);
  const res = await harness.runBotTask({ goal: "task", bot: BOT, model, executors: {} });
  assert.equal(res.status, "completed");
  assert.match(res.answer, /nothing from my tools/);
  assert.match(seen.users[1], /no tool has run this task/i);
});

test("ask_user hands back one bundled question with tappable options", async () => {
  const { model } = fakeModel([
    {
      kind: "ask_user",
      question: "What should the email to Dana say?",
      questionOptions: ["Short thank-you for the demo", "Ask her to reschedule to Friday"],
    },
  ]);
  const res = await harness.runBotTask({ goal: "email dana", bot: BOT, model, executors: {} });
  assert.equal(res.status, "waiting_for_user");
  assert.equal(res.needsUser, true);
  assert.match(res.question, /What should the email to Dana say/);
  assert.equal(res.questionOptions.length, 2);
});

/* ── Safety gate ──────────────────────────────────────────────────────────── */

test("a consequential decision runs only after approval; a decline is recorded and never retried", async () => {
  const { model, seen } = fakeModel([
    { kind: "use_tool", tool: "generate_image", instruction: "poster", narration: "Making it.", risk: "consequential" },
    { kind: "deliver", answer: "You said no, so I stopped — nothing was sent." },
  ]);
  const image = okExecutor("made");
  const approvals = [];
  const res = await harness.runBotTask({
    goal: "make and post a poster",
    bot: BOT,
    model,
    executors: { generate_image: image.fn },
    primaryTool: "generate_image",
    onApproval: async (a) => {
      approvals.push(a);
      return false;
    },
  });
  assert.equal(res.status, "completed");
  assert.equal(image.calls.length, 0, "declined action must not run");
  assert.equal(approvals.length, 1);
  assert.ok(res.events.some((e) => e.kind === "approval" && e.approved === false));
  assert.match(seen.users[1], /user declined/i);
});

test("the browser tool parks its own opt-in — no double ask through the approval gate", async () => {
  // The browser executor's only act is parking "want me to use the browser?"
  // — that question IS the consent gate. A consequential floor here made the
  // user approve being asked, then answer the ask: two prompts for one yes.
  const { model } = fakeModel([
    { kind: "use_tool", tool: "browser", instruction: "send the mail", narration: "Sending.", risk: "low" },
  ]);
  let asked = 0;
  const res = await harness.runBotTask({
    goal: "send the mail",
    bot: BOT,
    model,
    executors: {
      browser: async () => ({
        terminal: "waiting_for_user",
        question: "Want me to open the browser and take care of it?",
      }),
    },
    primaryTool: "browser",
    onApproval: async () => {
      asked += 1;
      return true;
    },
  });
  assert.equal(asked, 0, "the opt-in question is the gate — no approval prompt on top of it");
  assert.equal(res.status, "waiting_for_user");
  assert.equal(res.parked, true);
});

test("an executor can park the whole turn on the user (browser opt-in)", async () => {
  const { model } = fakeModel([
    { kind: "use_tool", tool: "browser", instruction: "reorder the pizza", narration: "Heading to the site." },
  ]);
  const res = await harness.runBotTask({
    goal: "reorder my pizza",
    bot: BOT,
    model,
    executors: {
      browser: async () => ({
        terminal: "waiting_for_user",
        question: "Want me to open the browser and take care of it?",
        questionOptions: ["Yes, use the browser", "No, just answer here"],
      }),
    },
    primaryTool: "browser",
    onApproval: async () => true,
  });
  assert.equal(res.status, "waiting_for_user");
  assert.equal(res.parked, true);
  assert.match(res.question, /open the browser/);
});

/* ── Verification and recovery ────────────────────────────────────────────── */

test("a failed verification feeds guidance into the next round, and the retry can pass", async () => {
  const { model, seen } = fakeModel(
    [
      { kind: "use_tool", tool: "build_artifact", instruction: "build the page", narration: "Building." },
      { kind: "use_tool", tool: "build_artifact", instruction: "build the page WITH the pricing table", narration: "Fixing." },
      { kind: "deliver", answer: "Page is up, pricing table included." },
    ],
    [
      { success: false, reason: "the output has no pricing table", next: "recover" },
      { success: true, evidence: "pricing table present", next: "continue" },
    ],
  );
  const build = okExecutor("built a page");
  const res = await harness.runBotTask({
    goal: "build a page with a pricing table",
    bot: BOT,
    model,
    executors: { build_artifact: build.fn },
    primaryTool: "build_artifact",
  });
  assert.equal(res.status, "completed");
  assert.equal(build.calls.length, 2);
  assert.match(seen.users[1], /GUIDANCE FROM THE LAST FAILURE/);
  assert.match(seen.users[1], /no pricing table/);
  const verdicts = res.events.filter((e) => e.kind === "verify");
  assert.deepEqual(verdicts.map((v) => v.success), [false, true]);
});

test("a failing tool burns the recovery budget, then the model is told to deliver honestly", async () => {
  const failing = async () => ({ ok: false, output: "", summary: "provider exploded" });
  const { model, seen } = fakeModel([
    { kind: "use_tool", tool: "generate_image", instruction: "try 1", narration: "…" },
    { kind: "use_tool", tool: "generate_image", instruction: "try 2", narration: "…" },
    { kind: "use_tool", tool: "generate_image", instruction: "try 3", narration: "…" },
    { kind: "deliver", answer: "The image tool is failing on my side — I couldn't produce it." },
  ]);
  const res = await harness.runBotTask({
    goal: "make an image",
    bot: BOT,
    model,
    executors: { generate_image: failing },
    primaryTool: "generate_image",
  });
  assert.equal(res.status, "completed");
  assert.match(res.answer, /couldn't produce it/);
  assert.match(seen.users[3], /out of retries/i);
});

/* ── Terminal reply and budget ────────────────────────────────────────────── */

test("a successful lone reply ends the task without a duplicate delivery round", async () => {
  const { model, seen } = fakeModel([
    { kind: "use_tool", tool: "reply", instruction: "explain the difference between RAM and storage", narration: "Answering." },
  ]);
  const reply = okExecutor("RAM is working memory; storage is long-term…");
  const res = await harness.runBotTask({
    goal: "what's the difference between RAM and storage?",
    bot: BOT,
    model,
    executors: { reply: reply.fn },
    primaryTool: "reply",
  });
  assert.equal(res.status, "completed");
  assert.equal(res.answer, "RAM is working memory; storage is long-term…");
  assert.equal(seen.users.length, 1, "no extra deliver round after a lone reply");
});

test("an unknown tool is noted and the loop keeps going", async () => {
  const { model, seen } = fakeModel([
    { kind: "use_tool", tool: "teleport", instruction: "beam it", narration: "…" },
    { kind: "deliver", answer: "Couldn't find a way to do that with my tools." },
  ]);
  const res = await harness.runBotTask({ goal: "x", bot: BOT, model, executors: {} });
  assert.equal(res.status, "completed");
  assert.match(seen.users[1], /unknown tool "teleport"/);
});

test("the round budget ends with an honest failure that names what was completed", async () => {
  const spin = { kind: "use_tool", tool: "generate_image", instruction: "again", narration: "…" };
  const { model } = fakeModel(Array.from({ length: 4 }, () => ({ ...spin })));
  const res = await harness.runBotTask({
    goal: "impossible task",
    bot: BOT,
    model,
    executors: { generate_image: async () => ({ ok: true, output: "img" }) },
    primaryTool: "generate_image",
    maxRounds: 4,
  });
  assert.equal(res.status, "failed");
  assert.match(res.answer, /ran out of working room/);
  assert.match(res.answer, /generate_image/);
});

test("conversation context and attachments ride in the user message, not the system prompt", async () => {
  const { model, seen } = fakeModel([{ kind: "deliver", answer: "hi" }, { kind: "deliver", answer: "hi" }]);
  await harness.runBotTask({
    goal: "greet",
    bot: BOT,
    model,
    executors: {},
    conversationHistory: [{ role: "user", content: "my dog is named Biscuit" }],
    attachmentsNote: "an image: biscuit.png",
  });
  assert.match(seen.users[0], /Biscuit/);
  assert.match(seen.users[0], /biscuit\.png/);
  assert.doesNotMatch(seen.systems[0], /Biscuit/);
});

/* ── The task brief ───────────────────────────────────────────────────────── */

test("every round carries a full brief — TASK / SUCCESS CONDITION / SCOPE / DO NOT / STOP RULE", async () => {
  const { model, seen } = fakeModel([{ kind: "deliver", answer: "hi" }, { kind: "deliver", answer: "hi" }]);
  await harness.runBotTask({ goal: "check the user's email", bot: BOT, model, executors: {} });
  const user = seen.users[0];
  assert.match(user, /TASK:\ncheck the user's email/);
  // Before the model defines a task-specific one, the generic brief still
  // gives it a complete scope wall and stop rule.
  assert.match(user, /SUCCESS CONDITION:\nThe user's literal request has been satisfied/);
  assert.match(user, /SCOPE:\nPerform only actions strictly necessary to satisfy the user's literal request\./);
  assert.match(user, /DO NOT:\n- Continue looking for additional useful work\./);
  assert.match(user, /STOP RULE:\nAs soon as the success condition is satisfied, deliver and stop\./);
});

test("the model's first-round brief is pinned into every later round and into verification", async () => {
  const { model, seen } = fakeModel(
    [
      {
        kind: "use_tool",
        tool: "research_report",
        instruction: "espresso machines under $500",
        narration: "Researching.",
        successCondition: "A sourced report on sub-$500 espresso machines has been produced.",
        doNot: ["Recommend machines over budget.", "Draft a purchase order."],
      },
      { kind: "deliver", answer: "Report's ready." },
    ],
    [{ success: true, evidence: "the report covers three machines with sources", next: "continue" }],
  );
  const research = okExecutor("# Report\nThree machines stood out…");
  const res = await harness.runBotTask({
    goal: "research espresso machines under $500",
    bot: BOT,
    model,
    executors: { research_report: research.fn },
    primaryTool: "research_report",
  });
  assert.equal(res.status, "completed");
  // Round 2 sees the brief the model defined on round 1.
  assert.match(seen.users[1], /SUCCESS CONDITION:\nA sourced report on sub-\$500 espresso machines has been produced\./);
  assert.match(seen.users[1], /- Recommend machines over budget\./);
  assert.match(seen.users[1], /- Draft a purchase order\./);
  // And the standing wall is still there beneath the task-specific list.
  assert.match(seen.users[1], /- Continue looking for additional useful work\./);
  // The verifier judges against the same success condition.
  assert.match(seen.verifies[0], /SUCCESS CONDITION:\nA sourced report on sub-\$500 espresso machines has been produced\./);
});
