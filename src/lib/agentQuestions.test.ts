import test from "node:test";
import assert from "node:assert/strict";

import {
  letteredOptions,
  parseAgentQuestions,
  parseBulletOptions,
  questionChips,
  questionPrompt,
  SKIP_ANSWER,
  splitQuestion,
} from "@/lib/agentQuestions";

test("a plain question stays one prompt", () => {
  assert.equal(
    questionPrompt("What should these ERC client emails say?"),
    "What should these ERC client emails say?",
  );
  assert.deepEqual(parseAgentQuestions("What should these ERC client emails say?"), [
    "What should these ERC client emails say?",
  ]);
});

test("a numbered list is still one prompt, not a pager of boxes", () => {
  const text = [
    "1. What should these ERC client emails say?",
    "2. What tone should they use?",
    "3. When should they go out?",
  ].join("\n");
  const prompt = questionPrompt(text);
  assert.match(prompt, /What should these ERC client emails say/);
  assert.match(prompt, /What tone should they use/);
  assert.deepEqual(parseAgentQuestions(text), [prompt]);
});

test("blank and whitespace-only text is no question", () => {
  assert.equal(questionPrompt(""), "");
  assert.equal(questionPrompt("   "), "");
  assert.deepEqual(parseAgentQuestions(""), []);
  assert.deepEqual(parseAgentQuestions("   "), []);
});

test("proposed answers become chips with no Other row", () => {
  const chips = questionChips([
    "Status update on their ERC claim / IRS processing",
    "Request missing documents or info",
    "Invoice / payment or fee reminder",
    "General check-in / re-engagement",
  ]);
  assert.equal(chips.length, 4);
  assert.equal(chips[0], "Status update on their ERC claim / IRS processing");
  assert.ok(!chips.some((c) => /other/i.test(c)));
});

test("lettered options stay A–D and never invent Other", () => {
  const rows = letteredOptions(["one", "two"]);
  assert.deepEqual(
    rows.map((r) => r.text),
    ["one", "two"],
  );
  assert.ok(rows.every((r) => !r.other));
});

test("a fifth proposed answer is dropped so the card stays four chips", () => {
  assert.deepEqual(questionChips(["one", "two", "three", "four", "five"]), [
    "one",
    "two",
    "three",
    "four",
  ]);
});

test("splitQuestion uses the first line as the header", () => {
  const split = splitQuestion("Which part should I start with?\n\nI listed the folder already.");
  assert.equal(split.title, "Which part should I start with?");
  assert.match(split.body, /listed the folder/);
});

test("splitQuestion splits a single-line question after the first sentence", () => {
  const split = splitQuestion("What should the subject be? I drafted three options.");
  assert.equal(split.title, "What should the subject be?");
  assert.match(split.body, /three options/);
});

test("skip is a real answer the run can resume on", () => {
  assert.match(SKIP_ANSWER, /skip/i);
});

test("bullet options become tappable answers", () => {
  assert.deepEqual(
    parseBulletOptions(
      [
        "I can connect Gmail through a plugin, or open the browser.",
        "",
        "- Connect Gmail",
        "- Use the browser",
        "- Just answer here",
      ].join("\n"),
    ),
    ["Connect Gmail", "Use the browser", "Just answer here"],
  );
});
