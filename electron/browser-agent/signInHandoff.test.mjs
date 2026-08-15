/**
 * When the agent parks on a sign-in wall it is still running — watching the tab
 * and ready to resume. The brief it shows has to read that way.
 *
 * The old text led with "Take the next step in the agent browser tab, then say
 * continue", which told the user the run had ended and that restarting it was
 * their job. It also stayed silent about Google refusing OAuth inside an
 * app-embedded browser, so a dead "Continue with Google" button looked like a
 * bug in LYKN.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const owned = require("../ownedBrowserAct.cjs");

test("a sign-in handoff says it is waiting, not that it stopped", () => {
  const brief = owned.formatUserHelpBrief({
    userAction: "Type your **password** for **admin.mailchimp.com**.",
    host: "admin.mailchimp.com",
    kind: "signin",
    stillTodo: ["Create the campaign draft"],
  });
  assert.match(brief, /Waiting for you/i);
  assert.match(brief, /watching this tab/i);
  // The specific site and field survive into the visible text.
  assert.match(brief, /admin\.mailchimp\.com/);
  // "say continue" may remain as a fallback, never as the headline instruction.
  assert.doesNotMatch(brief, /^\s*##\s*Needs you/i);
  assert.ok(
    brief.indexOf("Waiting on you to:") < brief.indexOf("continue"),
    "the ask must come before the escape hatch",
  );
});

test("a stuck (unwatched) handoff still asks for an explicit continue", () => {
  const brief = owned.formatUserHelpBrief({
    userAction: "Open a blank campaign editor.",
    kind: "stuck",
  });
  assert.match(brief, /Needs you/i);
  assert.match(brief, /continue/i);
});

test("a wall detector never hands over a generic instruction", () => {
  const blocker = owned.detectBrowseBlocker({
    url: "https://login.mailchimp.com/signin/",
    title: "Log in to Mailchimp",
    pageText: "Log in Username Password Log in Continue with Google Forgot username?",
  });
  assert.equal(blocker?.kind, "signin");
  assert.match(blocker.userAction, /mailchimp/i);
  assert.doesNotMatch(blocker.message, /Take the next step/i);
});

test("Google's button is flagged as the path that will not work here", () => {
  const note = owned.signInPageThirdPartyNote({
    title: "Log in to Mailchimp",
    pageText: "Username Password Log in or Continue with Google",
  });
  assert.match(note, /email \+ password/i);
  assert.match(note, /embedded/i);
});

test("Google's refusal page is explained instead of left as a dead end", () => {
  const note = owned.signInPageThirdPartyNote({
    title: "Couldn't sign you in",
    pageText: "This browser or app may not be secure. Try using a different browser.",
  });
  assert.match(note, /email \+ password/i);
});

test("sign-in pages without a Google option get no Google note", () => {
  const note = owned.signInPageThirdPartyNote({
    title: "Log in",
    pageText: "Email Password Log in Forgot your password?",
  });
  assert.equal(note, "");
});

test("the note rides along into the brief the user reads", () => {
  const blocker = owned.detectBrowseBlocker({
    url: "https://login.mailchimp.com/signin/",
    title: "Log in to Mailchimp",
    pageText: "Log in Username Password Log in Continue with Google",
  });
  assert.match(blocker.message, /email \+ password/i);
});
