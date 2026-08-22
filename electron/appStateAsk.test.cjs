/**
 * "Who is that folder shared with?" is an errand, not a question.
 *
 * From a real run: the user asked the agent to check who a Drive folder was
 * shared with. It read as a question about the open page, routed to the chat
 * model — which has no browser — and the reply was "I'm checking the 'final'
 * folder's sharing permissions now." Then nothing. The browser agent was never
 * started, and no trace was even written.
 *
 * The distinction that matters: some answers are written on the page, and some
 * live behind a dialog nobody has opened. Sharing, permissions and access are
 * the second kind — Drive shows none of it in the page text — so answering
 * means going to look.
 *
 * Run: node --test electron/appStateAsk.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const { asksAboutAppState, looksLikePageQuestionAsk } = require("./ownedBrowserAct.cjs");

test("asking who something is shared with is browser work", () => {
  for (const ask of [
    "in my google drive I have a folder titled final I need you to check who it's shared with then lmk",
    "check who my final folder is shared with",
    "who has access to the final folder in my drive",
    "what are the sharing settings on this doc",
    "who can edit this spreadsheet",
    "show me the collaborators on this file",
    "what permissions does sam have on the deck",
  ]) {
    assert.equal(asksAboutAppState(ask), true, `"${ask.slice(0, 48)}" needs a dialog opened`);
  }
});

test("a question the page can actually answer stays a question", () => {
  for (const ask of [
    "what does this page say",
    "summarize this article",
    "who wrote this post",
    "what is this about",
    "what is the price",
    "how many results are there",
  ]) {
    assert.equal(asksAboutAppState(ask), false, `"${ask}" is answerable from what is on screen`);
  }
});

test("sharing questions stop being treated as page questions", () => {
  // This is the specific misroute: a page question goes to the chat model.
  assert.equal(looksLikePageQuestionAsk("check who it's shared with"), false);
  assert.equal(looksLikePageQuestionAsk("who has access to this folder"), false);
});

test("ordinary page questions are untouched", () => {
  assert.equal(looksLikePageQuestionAsk("what is this article about"), true);
  assert.equal(looksLikePageQuestionAsk("summarize what's on screen"), true);
});

// ── the user's own material is an errand ────────────────────────────────────
//
// Every failing test in this session was typed in the agent rail, where the
// agent has a browser tab of its own. An ask about the user's OWN material —
// "my drive", "my inbox", "the final folder in Google Drive" — is work in that
// tab, not a question the chat model can field: it has no browser, so the best
// it can do is say it is looking into it while nothing happens.

const { looksLikeOwnAppContentAsk } = require("./ownedBrowserAct.cjs");

test("asks about the user's own app content drive the browser", () => {
  for (const ask of [
    "in my google drive I have a folder titled final I need you to check who it's shared with then lmk",
    "check my inbox for anything urgent",
    "what is in my drive",
    "is my Q3 deck finished",
    "what meetings do I have on my calendar",
    "clean up my google drive folders",
    "find the final folder in google drive",
  ]) {
    assert.equal(looksLikeOwnAppContentAsk(ask), true, `"${ask.slice(0, 46)}" is an errand`);
  }
});

test("conversation and questions about the open page stay in chat", () => {
  // Spinning up a browse loop for these would be worse than useless — it would
  // type the question into whatever search box the page happens to have.
  for (const ask of [
    "summarize this page",
    "what do you think of this",
    "what is the capital of France",
    "who wrote this article",
    "make me an image of a cat",
    "what does this say",
    "is this good",
  ]) {
    assert.equal(looksLikeOwnAppContentAsk(ask), false, `"${ask}" needs no browser`);
  }
});
