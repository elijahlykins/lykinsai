"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  pluginOfferForAsk,
  browserOptInPrompt,
  classifyOptInReply,
} = require("./executors/browserOptInChoice.cjs");

test("check my gmail offers the Gmail plugin", () => {
  const offer = pluginOfferForAsk("check the inbox", "check my gmail");
  assert.equal(offer.name, "Gmail");
  const prompt = browserOptInPrompt("check the inbox", "check my gmail");
  assert.match(prompt.question, /plugin/i);
  assert.deepEqual(prompt.questionOptions, [
    "Connect Gmail",
    "Use the browser",
    "Just answer here",
  ]);
});

test("ordering pizza stays on the browser-only question", () => {
  const prompt = browserOptInPrompt(
    "reorder the usual",
    "go to my dominos account and reorder my usual pizza",
  );
  assert.equal(prompt.plugin, null);
  assert.match(prompt.question, /need the browser for/i);
});

test("naming the browser skips the plugin fork", () => {
  const offer = pluginOfferForAsk(
    "use the browser to check gmail",
    "use the browser to check gmail",
  );
  assert.equal(offer, null);
});

test("Connect Gmail classifies as connect, not browser", () => {
  const plugin = { name: "Gmail", catalogId: "lykn:gmail" };
  assert.equal(classifyOptInReply("Connect Gmail", plugin), "connect");
  assert.equal(classifyOptInReply("use the plugin", plugin), "connect");
  assert.equal(classifyOptInReply("Yes, use the browser", plugin), "");
  assert.equal(classifyOptInReply("Just answer here", plugin), "");
});
