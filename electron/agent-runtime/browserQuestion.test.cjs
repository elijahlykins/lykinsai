"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createBrowserQuestionHost,
  displayAsk,
  ensureAskHistory,
} = require("./browserQuestion.cjs");

test("displayAsk prefers the typed question over attachment fallback", () => {
  assert.equal(displayAsk("What's on this page?", [{ name: "shot.png" }]), "What's on this page?");
  assert.equal(displayAsk("  ", [{ name: "a" }]), "(1 attachment)");
  assert.equal(displayAsk("", [{ name: "a" }, { name: "b" }]), "(2 attachments)");
  assert.equal(displayAsk("   ", []), "");
});

test("ensureAskHistory creates and reuses the question thread", () => {
  const agent = {};
  const first = ensureAskHistory(agent);
  assert.deepEqual(first, []);
  first.push({ role: "user", content: "hi" });
  assert.equal(ensureAskHistory(agent), first);
});

test("runBrowserQuestion writes askHistory and never touches work history", async () => {
  const events = [];
  const agent = {
    id: "tab-1",
    history: [{ role: "user", content: "book the flight" }],
    askGeneration: 0,
  };
  const { runBrowserQuestion } = createBrowserQuestionHost({
    streamChat: async () => "The page is a Gmail inbox.",
    sendToAgentChannels: (_id, channel, payload) => events.push({ channel, payload }),
    emitProgress: (_id, payload) => events.push({ channel: "progress", payload }),
    schedulePersist: () => {},
  });

  const out = await runBrowserQuestion(agent, { text: "what is this?" });
  assert.equal(out.ok, true);
  assert.equal(out.ask, true);
  assert.equal(agent.history.length, 1);
  assert.equal(agent.history[0].content, "book the flight");
  assert.equal(agent.askHistory.length, 2);
  assert.equal(agent.askHistory[0].role, "user");
  assert.equal(agent.askHistory[0].content, "what is this?");
  assert.equal(agent.askHistory[1].content, "The page is a Gmail inbox.");
  assert.equal(agent.askBusy, false);
  assert.ok(events.every((e) => e.payload?.ask === true));
});

test("a superseded question does not append a second answer", async () => {
  const agent = { id: "tab-1", askGeneration: 0 };
  let started = false;
  const { runBrowserQuestion } = createBrowserQuestionHost({
    streamChat: async (_agent, _text, _atts, _skill, gen) => {
      started = true;
      agent.askGeneration = gen + 1;
      return "stale";
    },
    sendToAgentChannels: () => {},
    emitProgress: () => {},
    schedulePersist: () => {},
  });

  const out = await runBrowserQuestion(agent, { text: "summarize this" });
  assert.equal(started, true);
  assert.equal(out.ok, false);
  assert.equal(out.error, "superseded");
  assert.equal(agent.askHistory.length, 1);
  assert.equal(agent.askHistory[0].role, "user");
});
