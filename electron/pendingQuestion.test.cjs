/**
 * Answering the agent's question resumes the work it asked about.
 *
 * The agent stops and asks ("what should the email say?"), and the reply comes
 * back as a fragment — "tell him the deck is ready". A fragment classifies as
 * ordinary chat, so without this the answer went to the chat model, which
 * wrote the email into the response area while the real compose stayed parked
 * and nothing was ever sent. The user saw an agent that asked a question,
 * ignored the answer, and stopped working.
 *
 * Run: node --test electron/pendingQuestion.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const { takePendingQuestion, looksLikeNewTaskAsk } = require("./agentRuntime.cjs");

const ASK = "write an email to elijah@lykn.io";

function parkedAgent(overrides = {}) {
  return {
    pendingQuestion: { ask: ASK, at: Date.now() },
    pendingMailAsk: { ask: ASK, at: Date.now() },
    ...overrides,
  };
}

test("an answer resumes the ask that raised the question", () => {
  const agent = parkedAgent();
  const resumed = takePendingQuestion(agent, "tell him the deck is ready for review");
  assert.equal(resumed?.ask, ASK);
});

test("answers do not have to look like anything in particular", () => {
  for (const answer of [
    "make it funny",
    "idk something short",
    "that the deck is ready",
    "Quick favor — 2 mins?",
    "just say hi",
  ]) {
    assert.ok(
      takePendingQuestion(parkedAgent(), answer),
      `"${answer}" is an answer, not chatter to be routed elsewhere`,
    );
  }
});

test("a question is answered once — the record is consumed", () => {
  const agent = parkedAgent();
  assert.ok(takePendingQuestion(agent, "say hello"));
  assert.equal(agent.pendingQuestion, null);
  assert.equal(
    takePendingQuestion(agent, "and mention the deadline"),
    null,
    "a second message is a follow-up to the resumed run, not a re-resume of the old ask",
  );
});

test("the mail path's copy of the ask is dropped so it cannot fold twice", () => {
  const agent = parkedAgent();
  takePendingQuestion(agent, "say hello");
  assert.equal(agent.pendingMailAsk, null);
});

test("a stale question is not resumed by an unrelated message an hour later", () => {
  const agent = parkedAgent({
    pendingQuestion: { ask: ASK, at: Date.now() - 60 * 60 * 1000 },
  });
  assert.equal(takePendingQuestion(agent, "what's the weather"), null);
  assert.equal(agent.pendingQuestion, null, "and it is cleared rather than left to fire later");
});

test("a brand-new instruction supersedes the question instead of answering it", () => {
  for (const fresh of [
    "write an email to sam@example.com",
    "go to mailchimp and make a campaign",
    "open my calendar",
    "search for flights to Denver",
  ]) {
    assert.equal(
      takePendingQuestion(parkedAgent(), fresh),
      null,
      `"${fresh}" starts something new`,
    );
    assert.equal(looksLikeNewTaskAsk(fresh), true);
  }
});

test("an agent with no question pending is unaffected", () => {
  const agent = { pendingQuestion: null };
  assert.equal(takePendingQuestion(agent, "anything at all"), null);
});

test("an empty message answers nothing", () => {
  assert.equal(takePendingQuestion(parkedAgent(), "   "), null);
});

// ── an approval is not an answer ────────────────────────────────────────────
//
// The agent asked "are you ready for me to send it?" in the free-text card,
// the user said yes, and that "yes" was folded back into the original request
// and replayed the entire task from the top instead of clicking Send. A yes is
// about the action already prepared and waiting; it is never a new instruction.

test("a yes releases the prepared action instead of replaying the task", () => {
  for (const yes of ["yes", "yes send it", "go ahead", "send it", "looks good", "yep", "do it"]) {
    const agent = parkedAgent();
    assert.equal(
      takePendingQuestion(agent, yes),
      null,
      `"${yes}" approves what is waiting — it must not re-run the original ask`,
    );
  }
});

test("a real answer still resumes the work", () => {
  // The distinction that matters: this one carries content, so it belongs
  // folded into the ask it answers.
  assert.ok(takePendingQuestion(parkedAgent(), "tell him the deck is ready"));
  assert.ok(takePendingQuestion(parkedAgent(), "make it short and friendly"));
});
