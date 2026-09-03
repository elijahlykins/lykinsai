import test from "node:test";
import assert from "node:assert/strict";

import {
  addBotSkill,
  BOT_COLOR_DEFAULT,
  BOT_COLORS,
  BOT_EYES,
  BOT_FACES,
  BOT_SKILL_LIMIT,
  BOT_TEMPLATES,
  botColorId,
  botEyesId,
  botFaceId,
  botForAgent,
  botHasBoardActivity,
  botShouldResumeBoard,
  botSeed,
  bindRuntimeTask,
  assignBotConnections,
  createBot,
  enqueueTask,
  findBotByName,
  finishTask,
  finishRunningTask,
  latestSettledTask,
  nextQueuedTask,
  parseAskTeammate,
  presentBotTaskResult,
  parseBots,
  queuedTasks,
  removeBotSkill,
  removeQueuedTask,
  sanitizeBotDeliverables,
  settleUnfinishedTasks,
  updateBotSkill,
  runningTask,
  serializeBots,
  startTask,
  stripAskTeammate,
  taskBrief,
  teammatesNamedInAsk,
} from "@/lib/bots/botStore";

test("a new hire is a durable persona with an empty desk", () => {
  const bot = createBot({
    name: "  Scout ",
    role: "Research Analyst",
    face: "triangle",
    eyes: "bar",
    color: "sky",
  });
  assert.equal(bot.name, "Scout");
  assert.equal(bot.role, "Research Analyst");
  assert.equal(bot.face, "triangle");
  assert.equal(bot.eyes, "bar");
  assert.equal(bot.color, "sky");
  assert.equal(bot.modelPolicy, undefined);
  assert.equal(bot.agentId, null);
  assert.deepEqual(bot.tasks, []);
  assert.deepEqual(bot.skills, []);
  // Every bot gets its own chat board the moment it's hired.
  assert.ok(bot.chatId.length >= 8);
  assert.notEqual(createBot({ name: "Y" }).chatId, bot.chatId);
});

test("Bot connectionIds are an allowlist and never keep secrets", () => {
  const bot = createBot({
    name: "Mailer",
    connectionIds: ["conn_work", "sk-secret.token", "Bearer abc"],
  });
  assert.deepEqual(bot.connectionIds, ["conn_work"]);
  const revived = parseBots(serializeBots([bot]));
  assert.deepEqual(revived[0].connectionIds, ["conn_work"]);
  assert.ok(!serializeBots([bot]).includes("sk-secret"));
});

test("undefined Bot connections mean all; empty means none", () => {
  const open = createBot({ name: "Open" });
  assert.equal(open.connectionIds, undefined);
  const none = assignBotConnections(open, []);
  assert.deepEqual(none.connectionIds, []);
  const subset = assignBotConnections(none, ["conn_work"]);
  assert.deepEqual(subset.connectionIds, ["conn_work"]);
});

test("an unknown face part or color falls back instead of breaking the avatar", () => {
  const bot = createBot({ name: "X", face: "toaster", eyes: "laser", color: "plaid" });
  assert.equal(bot.face, BOT_FACES[0].id);
  assert.equal(bot.eyes, BOT_EYES[0].id);
  assert.equal(bot.color, BOT_COLOR_DEFAULT);
  assert.equal(botFaceId("cloud"), "cloud");
  assert.equal(botEyesId("bar"), "bar");
  assert.equal(botEyesId("visor"), "visor");
  assert.equal(botEyesId("ring"), BOT_EYES[0].id);
  assert.equal(botColorId("navy"), "navy");
});

test("a bot's animation seed is stable and personal", () => {
  assert.equal(botSeed("bot_abc"), botSeed("bot_abc"));
  assert.notEqual(botSeed("bot_abc"), botSeed("bot_xyz"));
});

test("bot colors are the settings message palette, minus Default", () => {
  assert.ok(BOT_COLORS.length >= 10);
  assert.ok(!BOT_COLORS.some((c) => c.id === "default"));
  // "My accent" stays available, like the chat ink pickers.
  assert.ok(BOT_COLORS.some((c) => c.id === "accent"));
});

test("bots saved with older visual fields still revive whole", () => {
  const raw = JSON.stringify({
    v: 1,
    bots: [{ id: "bot_old", name: "Ember", look: "ember", icon: "ghost", tasks: [] }],
  });
  const [revived] = parseBots(raw);
  assert.equal(revived.color, "orange");
  assert.equal(revived.face, BOT_FACES[0].id);
  assert.equal(revived.eyes, BOT_EYES[0].id);
  // Bots saved before per-bot chats get a board minted on revival — and it
  // sticks across the next round trip instead of being re-minted.
  assert.ok(revived.chatId.length >= 8);
  const again = parseBots(serializeBots([revived]));
  assert.equal(again[0].chatId, revived.chatId);
});

test("custom skills persist and ride on the first briefing", () => {
  let bot = createBot({ name: "Hero" });
  bot = addBotSkill(bot, {
    name: "Invoice chase",
    instructions: "Check unpaid invoices and draft a polite reminder.",
  });
  assert.equal(bot.skills.length, 1);
  assert.equal(bot.skills[0].name, "Invoice chase");
  const first = taskBrief(bot, "Do the morning sweep", { introduce: true });
  assert.match(first, /Invoice chase/);
  assert.match(first, /unpaid invoices/);
  const [revived] = parseBots(serializeBots([bot]));
  assert.equal(revived.skills[0].name, "Invoice chase");
  bot = updateBotSkill(bot, bot.skills[0].id, {
    name: "Invoice chase",
    instructions: "Only ping invoices older than 14 days.",
  });
  assert.match(bot.skills[0].instructions, /14 days/);
  bot = removeBotSkill(bot, bot.skills[0].id);
  assert.deepEqual(bot.skills, []);
});

test("a bot cannot be taught more than the skill cap", () => {
  let bot = createBot({ name: "Packed" });
  for (let i = 0; i < BOT_SKILL_LIMIT; i += 1) {
    bot = addBotSkill(bot, { name: `Skill ${i + 1}`, instructions: `Do thing ${i + 1}.` });
  }
  assert.equal(bot.skills.length, BOT_SKILL_LIMIT);
  assert.equal(addBotSkill(bot, { name: "One more", instructions: "Nope." }), null);
});

test("the persona rides on the first task; identity rides on every task", () => {
  const bot = createBot({
    name: "Scout",
    role: "Research Analyst",
    persona: "Prefer primary sources.",
  });
  const first = taskBrief(bot, "Compare M4 MacBook prices", { introduce: true });
  assert.match(first, /You are Scout, my Research Analyst/);
  assert.match(first, /Prefer primary sources/);
  assert.match(first, /warm, friendly/);
  assert.match(first, /First task: Compare M4 MacBook prices/);
  // Later briefs skip the persona but never the name — history is a sliding
  // window, so a bot must be re-told who it is on every dispatch.
  const later = taskBrief(bot, "Now check refurb prices");
  assert.match(later, /You are Scout, my Research Analyst/);
  assert.match(later, /warm and friendly/);
  assert.doesNotMatch(later, /Prefer primary sources/);
  assert.match(later, /Now check refurb prices$/);
});

test("botForAgent finds the bot whose worker owns a browser tab", () => {
  const scout = { ...createBot({ name: "Scout" }), agentId: "agent-scout" };
  const fin = { ...createBot({ name: "Fin" }), agentId: "agent-fin" };
  assert.equal(botForAgent([scout, fin], "agent-fin")?.name, "Fin");
  assert.equal(botForAgent([scout, fin], "agent-other"), null);
  assert.equal(botForAgent([scout, fin], ""), null);
  assert.equal(botForAgent([], "agent-fin"), null);
});

test("assignments queue in order and dispatch oldest-first", () => {
  let bot = createBot({ name: "Concierge" });
  bot = enqueueTask(bot, "Book the dentist").bot;
  bot = enqueueTask(bot, "Renew the domain").bot;
  assert.equal(queuedTasks(bot).length, 2);
  assert.equal(nextQueuedTask(bot)?.text, "Book the dentist");

  bot = startTask(bot, nextQueuedTask(bot)!.id);
  assert.equal(runningTask(bot)?.text, "Book the dentist");
  assert.equal(queuedTasks(bot).length, 1);
  assert.equal(nextQueuedTask(bot)?.text, "Renew the domain");
});

test("BotTask projects canonical identity and exact-task settlement", () => {
  const first = enqueueTask(createBot({ name: "Queue" }), "First");
  const second = enqueueTask(first.bot, "Second");
  let bot = startTask(second.bot, first.task.id);
  bot = bindRuntimeTask(bot, first.task.id, { taskId: "task-a", runId: "run-a" });

  bot = finishTask(bot, second.task.id, { result: "late second event" });
  assert.equal(bot.tasks.find((task) => task.id === first.task.id)?.status, "running");
  assert.equal(bot.tasks.find((task) => task.id === second.task.id)?.status, "done");

  bot = finishTask(bot, first.task.id, { result: "first done" });
  assert.deepEqual(
    {
      runtimeTaskId: bot.tasks.find((task) => task.id === first.task.id)?.runtimeTaskId,
      runId: bot.tasks.find((task) => task.id === first.task.id)?.runId,
      status: bot.tasks.find((task) => task.id === first.task.id)?.status,
      result: bot.tasks.find((task) => task.id === first.task.id)?.result,
    },
    {
      runtimeTaskId: "task-a",
      runId: "run-a",
      status: "done",
      result: "first done",
    },
  );
});

test("finishing the running task records the result and frees the bot", () => {
  let bot = createBot({ name: "Scout" });
  bot = enqueueTask(bot, "Find flight prices").bot;
  bot = startTask(bot, bot.tasks[0].id);
  bot = finishRunningTask(bot, { ok: true, result: "Cheapest is $312 on Tuesday." });
  assert.equal(runningTask(bot), null);
  assert.equal(bot.tasks[0].status, "done");
  assert.equal(bot.tasks[0].result, "Cheapest is $312 on Tuesday.");
  // Finishing again with nothing running is a no-op, not a crash.
  assert.deepEqual(finishRunningTask(bot).tasks, bot.tasks);
});

test("the status dot reports the newest settled task", () => {
  let bot = createBot({ name: "Scout" });
  assert.equal(latestSettledTask(bot), null);
  bot = enqueueTask(bot, "First").bot;
  bot = startTask(bot, bot.tasks[0].id);
  bot = finishRunningTask(bot, { ok: true, result: "done first" });
  bot = enqueueTask(bot, "Second").bot;
  bot = startTask(bot, bot.tasks[1].id);
  bot = finishRunningTask(bot, { ok: false, result: "broke" });
  assert.equal(latestSettledTask(bot)?.status, "failed");
  assert.equal(latestSettledTask(bot)?.result, "broke");
  // Something still running doesn't hide the last settled outcome.
  bot = enqueueTask(bot, "Third").bot;
  assert.equal(latestSettledTask(bot)?.status, "failed");
});

test("idle bots do not resume last session's board until this session opens it", () => {
  let bot = createBot({ name: "Scout" });
  bot = enqueueTask(bot, "Yesterday's research").bot;
  bot = finishTask(bot, bot.tasks[0].id, { ok: true, result: "Done." });
  assert.equal(botShouldResumeBoard(bot), false);
  assert.equal(botShouldResumeBoard(bot, { sessionChatId: bot.chatId }), true);
  bot = enqueueTask(bot, "Still going").bot;
  bot = startTask(bot, bot.tasks[bot.tasks.length - 1].id);
  assert.equal(botShouldResumeBoard(bot), true);
  bot = createBot({ name: "Idle" });
  assert.equal(botShouldResumeBoard(bot, { agent: { botBrowser: true } }), true);
});

test("only bots with conversation on their CURRENT chat sit in the bar strip", () => {
  // Brand new — empty chat, dropdown only.
  let bot = createBot({ name: "Scout" });
  assert.equal(botHasBoardActivity(bot), false);
  // First message lands — the face appears in the strip.
  bot = enqueueTask(bot, "Compare prices").bot;
  assert.equal(botHasBoardActivity(bot), true);
  // "New chat" re-homes the bot onto a fresh board (what setBotChatBoard
  // stamps) — old tasks belong to the retired board, so the face leaves.
  bot = { ...bot, chatId: "fresh-board", chatStartedAt: new Date(Date.now() + 1).toISOString() };
  assert.equal(botHasBoardActivity(bot), false);
  // Talking on the new board brings it back.
  bot = enqueueTask({ ...bot, chatStartedAt: new Date(Date.now() - 1).toISOString() }, "Hi again").bot;
  assert.equal(botHasBoardActivity(bot), true);
  // The stamp survives a storage round trip; older bots without one keep
  // counting every task.
  const [revived] = parseBots(serializeBots([bot]));
  assert.equal(revived.chatStartedAt, bot.chatStartedAt);
  const legacy = parseBots(
    JSON.stringify({ v: 1, bots: [{ id: "bot_old", name: "Ember", tasks: bot.tasks }] }),
  )[0];
  assert.equal(botHasBoardActivity(legacy), true);
});

test("a queued task can be withdrawn, a settled one cannot", () => {
  let bot = createBot({ name: "Drafter" });
  const { bot: withTask, task } = enqueueTask(bot, "Draft the intro email");
  bot = removeQueuedTask(withTask, task.id);
  assert.equal(bot.tasks.length, 0);

  let done = enqueueTask(createBot({ name: "Drafter" }), "Draft it").bot;
  done = startTask(done, done.tasks[0].id);
  done = finishRunningTask(done, { ok: true, result: "sent" });
  assert.equal(removeQueuedTask(done, done.tasks[0].id).tasks.length, 1);
});

test("bots survive a round trip and a task caught mid-run ends right there", () => {
  let bot = createBot({ name: "Watchtower", role: "Monitor" });
  bot = enqueueTask(bot, "Watch the status page").bot;
  bot = startTask(bot, bot.tasks[0].id);
  const revived = parseBots(serializeBots([bot]));
  assert.equal(revived.length, 1);
  assert.equal(revived[0].name, "Watchtower");
  // A reload ends the task - no silent retry on the next dispatch. The chat
  // row re-attaches to this settled result and says what happened.
  assert.equal(revived[0].tasks[0].status, "failed");
  assert.match(revived[0].tasks[0].result || "", /Stopped/);
  assert.ok(revived[0].tasks[0].finishedAt);
  // Ending it once is final - another round trip doesn't rewrite the result.
  const again = parseBots(serializeBots(revived));
  assert.equal(again[0].tasks[0].result, revived[0].tasks[0].result);
  // Queued work that never started also ends. Shutting off must not leave a queue.
  let q = enqueueTask(createBot({ name: "Q" }), "Later").bot;
  const stoppedQueue = parseBots(serializeBots([q]))[0].tasks[0];
  assert.equal(stoppedQueue.status, "failed");
  assert.match(stoppedQueue.result || "", /Stopped/);
});

test("settleUnfinishedTasks ends the running task and drops the rest of the queue", () => {
  let bot = enqueueTask(createBot({ name: "Scout" }), "Research the pages").bot;
  bot = enqueueTask(bot, "Then ask Cody").bot;
  bot = startTask(bot, bot.tasks[0].id);
  bot = settleUnfinishedTasks(bot, { result: "Stopped." });
  assert.equal(bot.tasks.every((t) => t.status === "failed"), true);
  assert.equal(bot.tasks.every((t) => t.result === "Stopped."), true);
});

test("garbage in storage is an empty roster, not a crash", () => {
  assert.deepEqual(parseBots(null), []);
  assert.deepEqual(parseBots("not json"), []);
  assert.deepEqual(parseBots('{"bots": "nope"}'), []);
});

test("findBotByName matches exact, then a single partial", () => {
  const cody = createBot({ name: "Cody", role: "Architect" });
  const scout = createBot({ name: "Scout", role: "Research" });
  assert.equal(findBotByName([cody, scout], "cody")?.id, cody.id);
  assert.equal(findBotByName([cody, scout], cody.id)?.id, cody.id);
  assert.equal(findBotByName([cody, scout], "sco")?.id, scout.id);
  assert.equal(findBotByName([cody, scout], "nobody"), null);
  const codyTwo = createBot({ name: "Cody Two", role: "Pair" });
  assert.equal(findBotByName([cody, codyTwo], "cody")?.name, "Cody");
  assert.equal(findBotByName([cody, codyTwo], "two")?.name, "Cody Two");
});

test("the brief names teammates only when this ask names them", () => {
  const scout = createBot({ name: "Scout", role: "Research Analyst" });
  const fin = createBot({ name: "Fin", role: "Finance" });
  const unnamed = taskBrief(scout, "What's our runway?", { teammates: [fin, scout] });
  assert.doesNotMatch(unnamed, /Teammates you can ask/);
  assert.doesNotMatch(unnamed, /\[\[ask Fin/);
  assert.match(unnamed, /What's our runway\?$/);

  const named = taskBrief(scout, "Ask Fin what's our runway?", { teammates: [fin, scout] });
  assert.match(named, /Teammates you can ask: Fin \(Finance\)/);
  assert.match(named, /\[\[ask Fin: the question\]\]/);
  assert.doesNotMatch(named, /Scout \(Research Analyst\)/);

  const solo = taskBrief(scout, "Ask Fin what's our runway?", { teammates: [scout] });
  assert.doesNotMatch(solo, /Teammates you can ask/);
  assert.match(solo, /You are Scout/);
});

test("teammatesNamedInAsk ignores the rest of the roster", () => {
  const cody = createBot({ name: "Cody", role: "Architect" });
  const fin = createBot({ name: "Fin", role: "Finance" });
  assert.deepEqual(
    teammatesNamedInAsk("go to the top landing pages and find out how they do so good", [cody, fin]),
    [],
  );
  assert.deepEqual(
    teammatesNamedInAsk("look at those pages then talk to Cody about the codebase", [cody, fin]).map(
      (b) => b.name,
    ),
    ["Cody"],
  );
});

test("a hand-off marker parses out the teammate and the question", () => {
  assert.deepEqual(parseAskTeammate("[[ask Fin: what's our current runway?]]"), {
    name: "Fin",
    question: "what's our current runway?",
  });
  // Survives surrounding prose and odd spacing.
  assert.deepEqual(
    parseAskTeammate("Let me check.\n[[ ask  Fin :  runway? ]]\nBack soon."),
    { name: "Fin", question: "runway?" },
  );
  // Ordinary replies are not hand-offs.
  assert.equal(parseAskTeammate("The runway is 14 months."), null);
  assert.equal(parseAskTeammate(""), null);
  const longQ = "Please inspect the current landing page. ".repeat(40).trim();
  assert.equal(parseAskTeammate(`[[ask Cody: ${longQ}]]`)?.name, "Cody");
  assert.match(parseAskTeammate(`[[ask Cody: ${longQ}]]`)?.question || "", /landing page/);
});

test("cancelled runtime events become a readable chat line", () => {
  assert.deepEqual(
    presentBotTaskResult({ type: "task_cancelled", detail: { reason: "agent_closed" } }),
    {
      ok: false,
      result:
        "The browser session closed while I was still working. Ask me again and I'll pick it up.",
    },
  );
  assert.deepEqual(presentBotTaskResult({ type: "task_cancelled", detail: { reason: "user_stop" } }), {
    ok: false,
    result: "Stopped.",
  });
  assert.deepEqual(
    presentBotTaskResult({ type: "task_completed", detail: { output: "Done." } }),
    { ok: true, result: "Done." },
  );
});

test("deliverables off a task event are validated and bounded", () => {
  assert.deepEqual(sanitizeBotDeliverables(undefined), []);
  assert.deepEqual(sanitizeBotDeliverables("junk"), []);
  const out = sanitizeBotDeliverables([
    { kind: "html", title: "Coffee report", tool: "research_report", html: "<html>r</html>", filename: "coffee.html" },
    { kind: "artifact", title: "Deck", url: "http://stage/deck", code: "export default X" },
    { kind: "image", title: "Logo", url: "http://img/logo.png" },
    { kind: "html", title: "empty doc dropped", html: "   " },
    { kind: "artifact", title: "no url or code dropped" },
    { kind: "mystery", title: "unknown kind dropped", html: "<html>x</html>" },
  ]);
  assert.deepEqual(
    out.map((d) => [d.kind, d.title]),
    [
      ["html", "Coffee report"],
      ["artifact", "Deck"],
      ["image", "Logo"],
    ],
  );
  assert.equal(out[0].tool, "research_report");
  assert.equal(out[0].filename, "coffee.html");
  assert.equal(out[1].url, "http://stage/deck");
});

test("deliverable sanitizing fills default titles and caps the list", () => {
  const many = Array.from({ length: 12 }, () => ({ kind: "image", url: "http://img/x.png" }));
  const out = sanitizeBotDeliverables(many);
  assert.equal(out.length, 8);
  assert.equal(out[0].title, "Generated image");
  assert.equal(sanitizeBotDeliverables([{ kind: "html", html: "<html>x</html>" }])[0].title, "Document");
});

test("stripping the marker leaves a readable reply", () => {
  assert.equal(
    stripAskTeammate("I'd defer to finance here. [[ask Fin: runway?]]"),
    "I'd defer to finance here.",
  );
  assert.equal(stripAskTeammate("[[ask Fin: runway?]]"), "");
  assert.equal(stripAskTeammate("No marker here."), "No marker here.");
});

test("quick starts are complete enough to prefill the builder", () => {
  assert.ok(BOT_TEMPLATES.length >= 3);
  for (const t of BOT_TEMPLATES) {
    assert.ok(t.name && t.role && t.persona);
    assert.equal(botFaceId(t.face), t.face, `${t.name} names a real face`);
    assert.equal(botEyesId(t.eyes), t.eyes, `${t.name} names real eyes`);
    assert.equal(botColorId(t.color), t.color, `${t.name} names a real color`);
  }
});
