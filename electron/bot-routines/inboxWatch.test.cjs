"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  looksLikeInboxWatch,
  matchInboxConnections,
  connectionIdentity,
  bindInboxInstructions,
  pickInboxSearchTool,
  extractMessages,
  formatNewMail,
  diffNewMessages,
  nextSeenIds,
} = require("./inboxWatch.cjs");
const { parseTriggerFromText, compileRoutineCapabilities } = require("./nlRoutine.cjs");

test("watch-my-email phrasing is an inbox watch", () => {
  assert.equal(looksLikeInboxWatch("can you watch my email and ping me when I get a new email"), true);
  assert.equal(looksLikeInboxWatch("can you set a routine to monitor my email every minute"), true);
  assert.equal(looksLikeInboxWatch("watch my gmail"), true);
  assert.equal(looksLikeInboxWatch("check competitor pricing every morning"), false);
});

test("watch my email becomes a one-minute poll, not a missing trigger", () => {
  const trigger = parseTriggerFromText("watch my email and ping me when I get a new email");
  assert.equal(trigger.type, "schedule");
  assert.equal(trigger.schedule.kind, "interval");
  assert.equal(trigger.schedule.everyMs, 60 * 1000);
});

test("set a routine to monitor email every minute is a one-minute poll", () => {
  const trigger = parseTriggerFromText("can you set a routine to monitor my email every minute");
  assert.equal(trigger.type, "schedule");
  assert.equal(trigger.schedule.kind, "interval");
  assert.equal(trigger.schedule.everyMs, 60 * 1000);
});

test("inbox watches get email read caps, not a research report", () => {
  const caps = compileRoutineCapabilities("Watch my Gmail and ping me on new mail.", {
    type: "schedule",
    schedule: { kind: "interval", everyMs: 60000 },
  });
  assert.ok(caps.includes("communication.email.search"));
  assert.ok(caps.includes("communication.email.read"));
  assert.ok(caps.includes("browser.read"));
  assert.ok(caps.includes("browser.navigate"));
  assert.ok(!caps.includes("research_report"));
});

test("only live Gmail-shaped connections match", () => {
  const matches = matchInboxConnections([
    { id: "g1", name: "Work Gmail", catalogId: "lykn:gmail", status: "connected", accountIdentity: "ada@lykn.io" },
    { id: "s1", name: "Slack", catalogId: "lykn:slack", status: "connected" },
    { id: "g2", name: "Gmail", catalogId: "lykn:gmail", status: "revoked" },
  ]);
  assert.deepEqual(matches.map((c) => c.id), ["g1"]);
  assert.equal(connectionIdentity(matches[0]), "ada@lykn.io");
});

test("bound instructions name the account", () => {
  const text = bindInboxInstructions("ping me on new mail", {
    accountLabel: "Work",
    accountIdentity: "ada@lykn.io",
  });
  assert.match(text, /^Watching: Work \(ada@lykn\.io\)/);
});

test("search-shaped mail tools win over send/delete", () => {
  const tool = pickInboxSearchTool([
    { name: "send_email", capabilities: ["communication.email.send"] },
    { name: "search_emails", capabilities: ["communication.email.search"] },
  ]);
  assert.equal(tool.name, "search_emails");
});

test("message extraction and unseen-id diff", () => {
  const messages = extractMessages({
    messages: [
      { id: "m1", from: "Pat", subject: "Hello" },
      { id: "m2", from: "Sam", subject: "Later" },
    ],
  });
  assert.equal(messages.length, 2);
  const fresh = diffNewMessages(messages, ["m1"]);
  assert.deepEqual(fresh.map((m) => m.id), ["m2"]);
  assert.match(formatNewMail(fresh, "Work Gmail"), /Sam: Later/);
  assert.deepEqual(nextSeenIds(messages, ["m1"]), ["m1", "m2"]);
});
