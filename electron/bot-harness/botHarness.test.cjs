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

test("system prompt contains no em dashes", () => {
  const system = contextRouter.buildDecisionSystem({ bot: BOT, localMode: true });
  assert.equal(system.includes("\u2014"), false, "agent system prompt must not contain em dashes");
  assert.equal(
    contextRouter.buildVerificationSystem().includes("\u2014"),
    false,
    "verification system prompt must not contain em dashes",
  );
});

test("system prompt carries custom skills the user taught the bot", () => {
  const system = contextRouter.buildDecisionSystem({
    bot: {
      ...BOT,
      skills: [
        {
          id: "skill_1",
          name: "Invoice chase",
          instructions: "Check unpaid invoices and draft a polite reminder.",
        },
      ],
    },
    localMode: false,
  });
  assert.match(system, /Custom skills the user taught you/);
  assert.match(system, /Invoice chase/);
  assert.match(system, /unpaid invoices/);
});

test("system prompt is byte-stable for the same bot, and local mode gates the local tool", () => {
  const a = contextRouter.buildDecisionSystem({ bot: BOT, localMode: false });
  const b = contextRouter.buildDecisionSystem({ bot: BOT, localMode: false });
  assert.equal(a, b);
  assert.doesNotMatch(a, /`local_computer`/);
  assert.match(a, /`ai_drive`/);
  assert.match(a, /`create_routine`/);
  assert.match(a, /`connected_apps`/);
  const withLocal = contextRouter.buildDecisionSystem({ bot: BOT, localMode: true });
  assert.match(withLocal, /`local_computer`/);
  assert.match(withLocal, /`ai_drive`/);
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
    { kind: "deliver", answer: "Report's ready — it's in the document above." },
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
  // The report is delivered to the user as a document card; the answer is
  // the model's short close, not the report repeated.
  assert.equal(res.answer, "Report's ready — it's in the document above.");
  // The doc was in context from round one.
  assert.match(seen.users[0], /# Tool: research_report/);
});

test("create_routine is a first-class tool and preloads when routed", async () => {
  const names = registry.listTools({ localMode: false }).map((t) => t.name);
  assert.ok(names.includes("create_routine"));
  assert.ok(names.includes("connected_apps"));
  const { model, seen } = fakeModel([
    {
      kind: "use_tool",
      tool: "create_routine",
      instruction: JSON.stringify({
        name: "Inbox watch",
        instructions: "Check Gmail and ping me when new mail arrives.",
        trigger: { type: "schedule", schedule: { kind: "interval", everyMs: 60000 } },
      }),
      narration: "Setting up the inbox watch.",
    },
    {
      kind: "deliver",
      answer:
        'Routine created: "Inbox watch". It will check every minute. You can pause, run, or delete it on my page.',
    },
  ]);
  const routine = okExecutor(
    'Routine created: "Inbox watch". Runs: every minute. The user can pause, run, or delete it from this bot\'s page.',
  );
  const res = await harness.runBotTask({
    goal: "set a routine to monitor my email every minute",
    bot: BOT,
    model,
    executors: { create_routine: routine.fn },
    primaryTool: "create_routine",
  });
  assert.equal(res.status, "completed");
  assert.equal(routine.calls.length, 1);
  assert.match(seen.users[0], /# Tool: create_routine/);
  assert.match(res.answer, /Inbox watch/);
});

/* ── Delivery discipline ──────────────────────────────────────────────────── */

test("a prior conversation report is not this task — empty delivery is pushed back to the routed tool", async () => {
  const { model, seen } = fakeModel([
    { kind: "deliver", answer: "Here is the report I already wrote." },
    { kind: "use_tool", tool: "research_report", instruction: "espresso machines under $500", narration: "Researching again." },
    { kind: "deliver", answer: "Fresh report's done — it's in the document above." },
  ]);
  const research = okExecutor("# Fresh report");
  const res = await harness.runBotTask({
    goal: "research espresso machines under $500",
    bot: BOT,
    model,
    executors: { research_report: research.fn },
    primaryTool: "research_report",
    conversationHistory: [
      { role: "user", content: "research espresso machines under $500" },
      { role: "assistant", content: "Report's ready — three machines stood out." },
    ],
  });
  assert.equal(res.status, "completed");
  assert.equal(research.calls.length, 1);
  assert.match(seen.users[0], /references only/i);
  assert.match(seen.users[1], /research_report/);
  assert.match(res.answer, /Fresh report's done/);
});

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

test("the browser tool can park a mid-run question — no double ask through the approval gate", async () => {
  // A mid-browse handback (sign-in, which size) is the consent gate for
  // THAT pause. A consequential floor here would make the user approve
  // opening the tab, then answer the real question: two prompts for one yes.
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
  assert.equal(asked, 0, "the parked question is the gate — no approval prompt on top of it");
  assert.equal(res.status, "waiting_for_user");
  assert.equal(res.parked, true);
});

test("an executor can park the whole turn on the user (mid-browse question)", async () => {
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

test("a local child that needs approval parks the turn instead of looking finished", async () => {
  const { model } = fakeModel([
    {
      kind: "use_tool",
      tool: "local_computer",
      instruction: "delete the draft",
      narration: "Removing the draft.",
    },
  ]);
  const res = await harness.runBotTask({
    goal: "delete the draft on disk",
    bot: BOT,
    model,
    localMode: true,
    executors: {
      local_computer: async () => ({
        terminal: "waiting_for_approval",
        question: "Approve before I delete ~/Documents/draft.pdf?",
      }),
    },
    primaryTool: "local_computer",
  });
  assert.equal(res.status, "waiting_for_approval");
  assert.equal(res.parked, true);
  assert.match(res.question, /delete/);
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

test("verification asks whether the instruction landed, not leftover teammate steps", () => {
  const system = contextRouter.buildVerificationSystem();
  assert.match(system, /accomplished its INSTRUCTION/);
  assert.match(system, /teammate consult/);
});

test("a verify-retry that rewrote the report yields one deliverable card, not two", async () => {
  const { model } = fakeModel(
    [
      { kind: "use_tool", tool: "research_report", instruction: "top landing pages", narration: "Researching." },
      { kind: "use_tool", tool: "research_report", instruction: "top landing pages, more proof", narration: "Rewriting." },
      { kind: "deliver", answer: "Report's done — it's in the document above." },
    ],
    [
      { success: false, reason: "too thin on proof", next: "recover" },
      { success: true, evidence: "sourced comparisons", next: "continue" },
    ],
  );
  let attempt = 0;
  const research = {
    fn: async () => {
      attempt += 1;
      return {
        ok: true,
        output: `# Landing pages v${attempt}`,
        deliverable: { kind: "html", title: `Landing pages v${attempt}`, html: `<html>v${attempt}</html>` },
      };
    },
  };
  const browser = okExecutor("Opened docs.google.com");
  const res = await harness.runBotTask({
    goal: "go to the top landing pages in the world and find out how they do so good",
    bot: BOT,
    model,
    executors: { research_report: research.fn, browser: browser.fn },
    primaryTool: "research_report",
  });
  assert.equal(res.status, "completed");
  assert.equal(browser.calls.length, 0, "do not follow a finished report into the browser");
  // The failed-verify attempt's card was replaced by the verified rewrite.
  assert.equal(res.deliverables.length, 1);
  assert.equal(res.deliverables[0].title, "Landing pages v2");
  assert.equal(res.deliverables[0].tool, "research_report");
});

test("a report-then-presentation task keeps both deliverables for the chat", async () => {
  const { model } = fakeModel([
    { kind: "use_tool", tool: "research_report", instruction: "coffee market", narration: "Researching." },
    { kind: "use_tool", tool: "build_artifact", instruction: "present the report", narration: "Building." },
    { kind: "use_tool", tool: "build_artifact", instruction: "present the report", narration: "Building." },
    { kind: "deliver", answer: "Report and presentation are both above." },
  ]);
  const research = {
    fn: async () => ({
      ok: true,
      output: "# Coffee market",
      deliverable: { kind: "html", title: "Coffee market", html: "<html>report</html>" },
    }),
  };
  const build = {
    fn: async () => ({
      ok: true,
      output: "built",
      deliverable: { kind: "artifact", title: "Coffee deck", url: "http://stage/deck" },
    }),
  };
  const res = await harness.runBotTask({
    goal: "make a report on the coffee market and then turn it into a presentation",
    bot: BOT,
    model,
    executors: { research_report: research.fn, build_artifact: build.fn },
    primaryTool: "research_report",
  });
  assert.equal(res.status, "completed");
  assert.equal(res.answer, "Report and presentation are both above.");
  assert.deepEqual(
    res.deliverables.map((d) => [d.tool, d.kind]),
    [
      ["research_report", "html"],
      ["build_artifact", "artifact"],
    ],
  );
});

test("the verifier sees a long report's head AND tail, never a mid-sentence chop", async () => {
  // A 15k-character report clipped to its first 3000 characters used to read
  // as incomplete work — the verifier failed it and the harness re-ran the
  // whole research, which the user watched as a second report being written.
  const { model, seen } = fakeModel([
    { kind: "use_tool", tool: "research_report", instruction: "deep dive", narration: "Researching." },
    { kind: "deliver", answer: "Report's in the document above." },
  ]);
  const longReport =
    `# Deep dive\n\n${"Body paragraph with cited evidence. ".repeat(450)}\n\n## Sources\n- https://example.com/proof`;
  const research = { fn: async () => ({ ok: true, output: longReport }) };
  const res = await harness.runBotTask({
    goal: "write a deep dive report",
    bot: BOT,
    model,
    executors: { research_report: research.fn },
    primaryTool: "research_report",
  });
  assert.equal(res.status, "completed");
  const v = seen.verifies[0];
  assert.match(v, /# Deep dive/, "the opening survives the clip");
  assert.match(v, /characters omitted/, "the clip announces itself");
  assert.match(v, /https:\/\/example\.com\/proof/, "the ending (Sources) survives the clip");
});

test("a deliver that re-writes the finished report becomes a short close", async () => {
  const rewritten = `# Landing pages\n\n${"Findings prose. ".repeat(120)}\n\n## Methods\n\n${"More prose. ".repeat(40)}`;
  const { model } = fakeModel([
    { kind: "use_tool", tool: "research_report", instruction: "top landing pages", narration: "Researching." },
    { kind: "deliver", answer: rewritten },
  ]);
  const research = {
    fn: async () => ({
      ok: true,
      output: "# Landing pages",
      deliverable: { kind: "html", title: "Landing pages", html: "<html>r</html>" },
    }),
  };
  const res = await harness.runBotTask({
    goal: "report on the top landing pages",
    bot: BOT,
    model,
    executors: { research_report: research.fn },
    primaryTool: "research_report",
  });
  assert.equal(res.status, "completed");
  assert.equal(res.answer, `Your report "Landing pages" is ready - it's in the document above.`);
  assert.equal(res.deliverables.length, 1, "the card still carries the real report");
});

test("an unnamed teammate on the roster stays out of a report task's prompts", async () => {
  const { model, seen } = fakeModel([
    { kind: "use_tool", tool: "research_report", instruction: "top landing pages", narration: "Researching." },
    { kind: "deliver", answer: "Report's ready — above-the-fold findings are in the document above." },
  ]);
  const research = okExecutor("# Landing pages\nClear above-the-fold promise.");
  const res = await harness.runBotTask({
    task: {
      objective: "go to the top landing pages and find out how they do so good",
      collaborators: [{ name: "Cody", role: "Architect" }],
    },
    goal: "go to the top landing pages and find out how they do so good",
    bot: BOT,
    model,
    executors: { research_report: research.fn },
    primaryTool: "research_report",
  });
  assert.equal(res.status, "completed");
  assert.match(res.answer, /above-the-fold/);
  assert.doesNotMatch(res.answer, /\[\[ask Cody/);
  // Cody is not named in the goal, so no prompt advertises the roster.
  for (const user of seen.users) assert.doesNotMatch(user, /AVAILABLE TEAMMATES/);
});

test("a lone research report closes with a short deliver round, never the report repeated", async () => {
  const { model, seen } = fakeModel([
    { kind: "use_tool", tool: "research_report", instruction: "espresso machines under $500", narration: "Researching." },
    { kind: "deliver", answer: "Done — three machines stood out. Full findings are in the document above." },
  ]);
  const research = {
    fn: async () => ({
      ok: true,
      output: "# Espresso under $500\n\n## Summary\nThree machines stood out.",
      deliverable: { kind: "html", title: "Espresso under $500", html: "<html>report</html>" },
    }),
  };
  const res = await harness.runBotTask({
    goal: "research espresso machines under $500",
    bot: BOT,
    model,
    executors: { research_report: research.fn },
    primaryTool: "research_report",
  });
  assert.equal(res.status, "completed");
  // The chat shows the close; the report survives as the deliverable card.
  assert.match(res.answer, /three machines stood out/i);
  assert.equal(seen.users.length, 2, "one report round, one deliver round");
  assert.equal(res.deliverables.length, 1);
  assert.equal(res.deliverables[0].kind, "html");
});

test("a research report task still hands off when the goal names a teammate", async () => {
  const { model } = fakeModel([
    {
      kind: "use_tool",
      tool: "research_report",
      instruction: "compare the three landing pages",
      narration: "Researching.",
    },
    {
      kind: "deliver",
      answer: "[[ask Cody: How should we change the LYKN landing page to match this vibe?]]",
    },
  ]);
  const research = okExecutor("# Landing page report\nThey lead with product-as-OS.");
  const res = await harness.runBotTask({
    task: {
      objective: "look at those landing pages then talk to Cody about our codebase",
      collaborators: [{ name: "Cody", role: "Architect" }],
    },
    goal: "look at those landing pages then talk to Cody about our codebase",
    bot: BOT,
    model,
    executors: { research_report: research.fn },
    primaryTool: "research_report",
  });
  assert.equal(res.status, "completed");
  assert.match(res.answer, /\[\[ask Cody:/);
});

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
        tool: "generate_image",
        instruction: "a fox logo",
        narration: "Making the logo.",
        successCondition: "A flat orange fox logo has been generated.",
        doNot: ["Animate the logo.", "Design a second mark."],
      },
      { kind: "deliver", answer: "Logo's done — flat orange fox, opened for you." },
    ],
    [{ success: true, evidence: "the image is a flat orange fox", next: "continue" }],
  );
  const image = okExecutor("image generated: fox logo");
  const res = await harness.runBotTask({
    goal: "make me a fox logo",
    bot: BOT,
    model,
    executors: { generate_image: image.fn },
    primaryTool: "generate_image",
  });
  assert.equal(res.status, "completed");
  // Round 2 sees the brief the model defined on round 1.
  assert.match(seen.users[1], /SUCCESS CONDITION:\nA flat orange fox logo has been generated\./);
  assert.match(seen.users[1], /- Animate the logo\./);
  assert.match(seen.users[1], /- Design a second mark\./);
  // And the standing wall is still there beneath the task-specific list.
  assert.match(seen.users[1], /- Continue looking for additional useful work\./);
  // The verifier judges against the same success condition.
  assert.match(seen.verifies[0], /SUCCESS CONDITION:\nA flat orange fox logo has been generated\./);
});
