"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  looksLikeInspectAsk,
  looksLikeSpecialistWork,
  looksLikeRerunAsk,
  shouldRouteDeliverableEdit,
  classifyAgentSkill,
} = require("./skillRouting.cjs");

test("folder inspect asks stay with Main", () => {
  for (const q of [
    "What's in this folder?",
    "what's in here",
    "what is in this folder",
    "list the files",
    "just list what's inside",
    "what is this",
  ]) {
    assert.equal(looksLikeInspectAsk(q), true, q);
    assert.equal(looksLikeSpecialistWork(q), false, q);
  }
});

test("a repeat of the last job is a rerun, not a leftover-report edit", () => {
  for (const q of [
    "try again",
    "do that again",
    "run it again",
    "one more time",
    "research espresso machines under $500 again",
  ]) {
    assert.equal(looksLikeRerunAsk(q), true, q);
    assert.equal(shouldRouteDeliverableEdit(q, { hasReport: true, deliverableKind: "report" }), false, q);
  }
  assert.equal(looksLikeRerunAsk("make the report shorter"), false);
  assert.equal(
    shouldRouteDeliverableEdit("make the report shorter", { hasReport: true, deliverableKind: "report" }),
    true,
  );
  assert.equal(
    classifyAgentSkill("research espresso machines under $500 again", {
      hasReport: true,
      deliverableKind: "report",
    }),
    "research",
  );
});

test("a letter or write-out is write-document, not research or build", () => {
  assert.equal(classifyAgentSkill("write me a letter to my landlord"), "write-document");
  assert.equal(classifyAgentSkill("draft a memo about the hire"), "write-document");
  assert.equal(classifyAgentSkill("write this out"), "write-document");
  assert.equal(classifyAgentSkill("write me a report on espresso machines"), "research");
  assert.equal(classifyAgentSkill("build me a landing page"), "build");
});

test("watch/alert phrasing is still a monitor skill at classify time", () => {
  assert.equal(classifyAgentSkill("watch this page and tell me when the status changes"), "monitor");
  assert.equal(classifyAgentSkill("alert me when the export finishes"), "monitor");
});

test("coding work still belongs to a specialist", () => {
  for (const q of [
    "refactor the auth module",
    "fix the bug in server.js",
    "implement a coding bot handoff",
    "what's in this folder and then refactor it",
  ]) {
    assert.equal(looksLikeSpecialistWork(q), true, q);
    assert.equal(looksLikeInspectAsk(q), false, q);
  }
});
