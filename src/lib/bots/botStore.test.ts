import test from "node:test";
import assert from "node:assert/strict";

import {
  BOT_COLOR_DEFAULT,
  BOT_COLORS,
  BOT_EYES,
  BOT_FACES,
  BOT_TEMPLATES,
  botColorId,
  botEyesId,
  botFaceId,
  botForAgent,
  botHasBoardActivity,
  botSeed,
  createBot,
  enqueueTask,
  finishRunningTask,
  latestSettledTask,
  nextQueuedTask,
  parseAskTeammate,
  parseBots,
  queuedTasks,
  removeQueuedTask,
  runningTask,
  serializeBots,
  startTask,
  stripAskTeammate,
  taskBrief,
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
  assert.equal(bot.agentId, null);
  assert.deepEqual(bot.tasks, []);
  // Every bot gets its own chat board the moment it's hired.
  assert.ok(bot.chatId.length >= 8);
  assert.notEqual(createBot({ name: "Y" }).chatId, bot.chatId);
});

test("an unknown face part or color falls back instead of breaking the avatar", () => {
  const bot = createBot({ name: "X", face: "toaster", eyes: "laser", color: "plaid" });
  assert.equal(bot.face, BOT_FACES[0].id);
  assert.equal(bot.eyes, BOT_EYES[0].id);
  assert.equal(bot.color, BOT_COLOR_DEFAULT);
  assert.equal(botFaceId("cloud"), "cloud");
  assert.equal(botEyesId("bar"), "bar");
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
  // A reload ends the task — no silent retry on the next dispatch. The chat
  // row re-attaches to this settled result and says what happened.
  assert.equal(revived[0].tasks[0].status, "failed");
  assert.match(revived[0].tasks[0].result || "", /Stopped/);
  assert.ok(revived[0].tasks[0].finishedAt);
  // Ending it once is final — another round trip doesn't rewrite the result.
  const again = parseBots(serializeBots(revived));
  assert.equal(again[0].tasks[0].result, revived[0].tasks[0].result);
  // Queued work that never started is untouched.
  let q = enqueueTask(createBot({ name: "Q" }), "Later").bot;
  assert.equal(parseBots(serializeBots([q]))[0].tasks[0].status, "queued");
});

test("garbage in storage is an empty roster, not a crash", () => {
  assert.deepEqual(parseBots(null), []);
  assert.deepEqual(parseBots("not json"), []);
  assert.deepEqual(parseBots('{"bots": "nope"}'), []);
});

test("the brief names teammates and how to hand work to them", () => {
  const scout = createBot({ name: "Scout", role: "Research Analyst" });
  const fin = createBot({ name: "Fin", role: "Finance" });
  const brief = taskBrief(scout, "What's our runway?", { teammates: [fin, scout] });
  assert.match(brief, /Teammates you can ask: Fin \(Finance\)/);
  assert.match(brief, /\[\[ask Fin: the question\]\]/);
  // Never lists the bot itself as its own teammate.
  assert.doesNotMatch(brief, /Scout \(Research Analyst\)/);
  assert.match(brief, /What's our runway\?$/);
  // Alone on the team, no teammate lines — just identity and the ask.
  const solo = taskBrief(scout, "What's our runway?", { teammates: [scout] });
  assert.doesNotMatch(solo, /Teammates you can ask/);
  assert.match(solo, /You are Scout/);
  assert.match(solo, /What's our runway\?$/);
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
