"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAskTeammate, looksLikeTeammateHandoff } = require("./runtime/teammate.cjs");

test("parses a teammate handoff and ignores ordinary prose", () => {
  assert.deepEqual(parseAskTeammate("[[ask Cody: inspect the landing page]]"), {
    name: "Cody",
    question: "inspect the landing page",
  });
  assert.equal(looksLikeTeammateHandoff("[[ask Cody: inspect the landing page]]"), true);
  assert.equal(looksLikeTeammateHandoff("Needs an answer from you"), false);
});

test("a long inspect brief still parses as a handoff", () => {
  const question =
    "Please inspect the current landing page in the LYKN folder and report its present state based on the actual files: what is working; the most important weaknesses in messaging, structure, visual hierarchy, trust, conversion flow, performance, and accessibility; and a prioritized list of concrete improvements.";
  const parsed = parseAskTeammate(`[[ask Cody: ${question}]]`);
  assert.equal(parsed?.name, "Cody");
  assert.match(parsed?.question || "", /visual hierarchy/);
});
