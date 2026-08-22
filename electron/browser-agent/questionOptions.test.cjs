/**
 * One-tap answers on an agent's question.
 *
 * A question the user has to compose from scratch is slower than one they can
 * answer with a tap, so the model may propose 2-4 complete answers alongside
 * it. They become buttons, which is why the shape is enforced here rather
 * than trusted to the prompt: a model that ignores "never Yes/No" would turn
 * a free-text question into a fake binary, and a single option reads as the
 * agent having already decided.
 *
 * Run: node --test electron/browser-agent/questionOptions.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const { normalizeAnswerOptions, createAgentModel } = require("./runtime/model.cjs");

test("real answers survive, trimmed and capped at four", () => {
  const out = normalizeAnswerOptions([
    "  Quick favor —   2 mins?  ",
    "Something fun for you",
    "A link you'll like",
    "One more thing",
    "A fifth that must not fit",
  ]);
  assert.equal(out.length, 4);
  assert.equal(out[0], "Quick favor — 2 mins?");
});

test("yes/no and filler are dropped — a question is not a binary", () => {
  assert.deepEqual(normalizeAnswerOptions(["Yes", "No"]), []);
  assert.deepEqual(normalizeAnswerOptions(["Okay", "Sure", "Other"]), []);
});

test("a lone option is no choice at all", () => {
  assert.deepEqual(normalizeAnswerOptions(["The only idea I had"]), []);
});

test("duplicates collapse case-insensitively", () => {
  assert.deepEqual(normalizeAnswerOptions(["Hello there", "hello there", "Second one"]), [
    "Hello there",
    "Second one",
  ]);
});

test("malformed payloads never become buttons", () => {
  assert.deepEqual(normalizeAnswerOptions(null), []);
  assert.deepEqual(normalizeAnswerOptions("not an array"), []);
  assert.deepEqual(normalizeAnswerOptions([null, "", "  "]), []);
});

/** A model whose responses come from a canned JSON payload. */
function scriptedModel(json) {
  return createAgentModel({
    apiBase: "https://api.test",
    getAuthToken: async () => "t",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "0" },
      json: async () => ({ ok: true, json }),
    }),
  });
}

test("the plan stage hands back clarification options", async () => {
  const model = scriptedModel({
    plan: ["Do the thing"],
    clarification: "What subject line would you like?",
    clarificationOptions: ["Quick favor — 2 mins?", "A link you'll like"],
  });
  const out = await model.plan({ system: "s", user: "u" });
  assert.equal(out.clarification, "What subject line would you like?");
  assert.deepEqual(out.clarificationOptions, ["Quick favor — 2 mins?", "A link you'll like"]);
});

test("the decide stage hands back question options only when they are real", async () => {
  const good = await scriptedModel({
    kind: "ask_user",
    question: "Which account should I use?",
    questionOptions: ["The work one (elijah@lykn.io)", "The personal one"],
  }).decide({ system: "s", user: "u" });
  assert.equal(good.questionOptions.length, 2);

  const junk = await scriptedModel({
    kind: "ask_user",
    question: "Should I continue?",
    questionOptions: ["Yes", "No"],
  }).decide({ system: "s", user: "u" });
  assert.deepEqual(junk.questionOptions, [], "a yes/no pair is not a set of answers");
});

test("a decision with no options is unchanged", async () => {
  const out = await scriptedModel({ kind: "ask_user", question: "What is your password?" }).decide({
    system: "s",
    user: "u",
  });
  assert.deepEqual(out.questionOptions, []);
});
