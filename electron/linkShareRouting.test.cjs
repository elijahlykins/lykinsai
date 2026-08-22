/**
 * "Send it to sam@example.com" — but send WHAT?
 *
 * From a real run: the user asked the agent to check whether a Drive folder
 * called FINAL existed and send it to someone. The browser happened to be on
 * google.com. Before any browsing, the runtime read the ask as "share the page
 * that is open", froze that page into an instruction — "The ENTIRE body is …
 * this link on its own line: https://www.google.com/" — and the agent emailed
 * a link to Google's homepage.
 *
 * Two conditions have to hold before "share this page" is a safe reading, and
 * neither was being checked: the open page must BE something worth sending,
 * and the ask must be about it rather than about something the agent has yet
 * to find.
 *
 * Run: node --test electron/linkShareRouting.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert");

const { askNeedsFindingFirst } = require("./agentRuntime.cjs");
const { looksLikeShareCurrentPageAsk, looksLikeMarketingOrHomeUrl } = require("./ownedBrowserAct.cjs");

const REAL_ASK =
  "I think I have a folder with my logos in my google drive I think the folder is called final " +
  "can you verify that and send it to elijahlykins@lykinsai.com";

test("an ask that starts with finding something is not about the open page", () => {
  assert.equal(askNeedsFindingFirst(REAL_ASK), true);
  for (const ask of [
    "find my logo folder and send it to sam@example.com",
    "check if I have a doc called Q3 and share it with bob@x.com",
    "verify the invoice is there and email it to me",
    "look for the deck I made and send it to sam@example.com",
    "I think I saved a file about pricing — send it to bob@x.com",
    "the folder is called something like final, share it with sam@example.com",
  ]) {
    assert.equal(askNeedsFindingFirst(ask), true, `"${ask}" needs looking before sending`);
  }
});

test("a plain share of what is on screen needs no finding", () => {
  for (const ask of [
    "share this with sam@example.com",
    "send this page to bob@x.com",
    "email this video to sam@example.com",
  ]) {
    assert.equal(askNeedsFindingFirst(ask), false, `"${ask}" is about the open page`);
  }
});

test("a homepage or search page is never the thing being shared", () => {
  // The exact page the failing run was sitting on, plus its neighbours.
  for (const url of [
    "https://www.google.com/",
    "https://google.com",
    "https://www.google.com/search?q=logos",
  ]) {
    assert.equal(
      looksLikeMarketingOrHomeUrl(url, ""),
      true,
      `${url} is somewhere you start from, not something you send`,
    );
  }
});

test("a real document or video page still is", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=abc123",
    "https://example.com/reports/q3-summary",
  ]) {
    assert.equal(looksLikeMarketingOrHomeUrl(url, "a page of real content here"), false);
  }
});

test("the share-page reading survives for the asks it was built for", () => {
  // The guards added around this must not disable it: sharing the page you are
  // looking at is still a real, common request.
  assert.equal(looksLikeShareCurrentPageAsk("share this with sam@example.com"), true);
  assert.equal(looksLikeShareCurrentPageAsk("send this page to bob@x.com"), true);
});

test("and stays off for a bare compose ask", () => {
  // Fixed earlier, pinned here too: this is the other way a fabricated body
  // reached a real recipient.
  assert.equal(looksLikeShareCurrentPageAsk("write an email to elijah@lykn.io"), false);
});
