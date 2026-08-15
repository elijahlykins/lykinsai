/**
 * The browser agent has to finish what it starts. These tests pin down the two
 * behaviours that decide whether it does:
 *
 *  1. Which actions it may take alone vs. which warrant interrupting the user.
 *  2. That a task told to happen in a named product goes to that product.
 *
 * Both were previously wrong in ways that stranded real tasks: every
 * consequential-looking click (including plain "Confirm") halted the run, and
 * email-shaped wording was rerouted into Gmail regardless of the app named.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const executor = require("./runtime/executor.cjs");
const owned = require("../ownedBrowserAct.cjs");

/** Does the agent act on its own, given this goal and this button? */
function proceedsAlone(goal, label, expectedOutcome = "") {
  const snapshot = { byRef: new Map([["e1", { ref: "e1", label, role: "button" }]]) };
  const decision = {
    kind: "act",
    // The model over-reports risk constantly; the gate must not defer to it.
    risk: "consequential",
    expectedOutcome,
    action: { type: "click", target: "e1" },
  };
  const risk = executor.classifyActionRisk(decision, snapshot);
  return risk !== "consequential" || executor.goalAuthorizesAction(goal, decision, snapshot);
}

test("mid-flow confirmations are the agent's job, not the user's", () => {
  const goal = "link our instagram account on meta business suite";
  for (const label of ["Confirm", "Continue", "Next", "Done", "Save changes", "Link account", "Allow", "OK"]) {
    assert.equal(proceedsAlone(goal, label, "the account is linked"), true, `should click "${label}" alone`);
  }
});

test("spending money always needs the user", () => {
  assert.equal(proceedsAlone("buy the black hoodie in size large", "Place order"), false);
  assert.equal(proceedsAlone("find me a cheap monitor on amazon", "Buy now"), false);
  assert.equal(proceedsAlone("book a table for two at 7pm", "Confirm and pay"), false);
  assert.equal(proceedsAlone("upgrade us to the pro plan", "Start trial"), false);
});

test("destroying data always needs the user", () => {
  assert.equal(proceedsAlone("clean up my inbox", "Delete"), false);
  assert.equal(proceedsAlone("cancel my netflix subscription", "Cancel subscription"), false);
});

test("an explicitly requested send goes through", () => {
  assert.equal(proceedsAlone("send john@acme.com an email about the launch", "Send", "the message is sent"), true);
  assert.equal(proceedsAlone("email the team the new pricing", "Send"), true);
  assert.equal(proceedsAlone("reply to sarah and tell her yes", "Send"), true);
  assert.equal(proceedsAlone("share this doc with mike@acme.com", "Send"), true);
});

test("a prepare-only ask stops at the draft", () => {
  const goal = "prep an email in mailchimp to all of our clients about our new updates";
  assert.equal(proceedsAlone(goal, "Send", "campaign sent to all subscribers"), false);
  // …but everything up to the send is still done autonomously.
  assert.equal(proceedsAlone(goal, "Save as draft", "draft saved"), true);
  assert.equal(proceedsAlone("write an update but don't send it yet", "Send"), false);
});

test("mass-audience sends need an unmistakable instruction", () => {
  assert.equal(proceedsAlone("draft a campaign in mailchimp for the whole list", "Send now", "sent to everyone"), false);
  assert.equal(proceedsAlone("send the newsletter to all subscribers now", "Send", "sent to all subscribers"), true);
});

test("reads and navigation are never gated", () => {
  const snapshot = { byRef: new Map() };
  for (const type of ["navigate", "scroll", "extract", "go_back", "screenshot", "wait"]) {
    assert.equal(
      executor.classifyActionRisk({ kind: "act", risk: "consequential", action: { type } }, snapshot),
      "read",
      `${type} should never be consequential`,
    );
  }
});

test("a named app is where the work happens", () => {
  assert.match(owned.resolveNamedWorkVenueUrl("prep an email in mailchimp for our clients"), /mailchimp/);
  assert.match(owned.resolveNamedWorkVenueUrl("add a deal in hubspot for acme corp"), /hubspot/);
  assert.match(owned.resolveNamedWorkVenueUrl("write up the launch notes in notion"), /notion/);
  assert.match(owned.resolveNamedWorkVenueUrl("make a chart in google sheets"), /spreadsheets/);
});

test("'go to <app>' names the venue just like 'in <app>'", () => {
  for (const ask of [
    "go to mailchimp and write out an email about our product updates",
    "head to mailchimp and draft the update email",
    "open mailchimp and start a campaign",
    "pull up mailchimp and write the newsletter",
  ]) {
    assert.match(owned.resolveNamedWorkVenueUrl(ask), /mailchimp/, ask);
    assert.equal(owned.namesNonMailVenue(ask), true, ask);
  }
});

test("app names spelled with a space still resolve", () => {
  // "mail chimp", "square space" — people space product names however.
  assert.match(owned.resolveNamedWorkVenueUrl("go to mail chimp and write the update email"), /mailchimp/);
  assert.match(owned.resolveNamedWorkVenueUrl("open square space and edit the homepage"), /squarespace/);
  assert.match(owned.resolveNamedWorkVenueUrl("go to quick books and check the invoices"), /qbo\.intuit/);
  assert.match(owned.resolveNamedWorkVenueUrl("go to word press and publish the post"), /wordpress/);
});

test("email wording does not hijack a named non-mail app into Gmail", () => {
  const ask = "can you prep and email in mailchimp to all of our clients about our new updates";
  assert.equal(owned.namesNonMailVenue(ask), true);
  assert.match(owned.resolveBrowseTargetUrl(ask), /mailchimp/);
  assert.equal(owned.namesNonMailVenue("draft an email in mailchimp to our client list"), true);

  // The exact ask that ended up as a Gmail draft: "write out an email" trips
  // the mail-compose detector, so the named venue has to override it.
  const reported = "go to mail chimp and write out an email explaining our new product updates";
  assert.equal(owned.looksLikeMailComposeTask(reported), true, "still reads as a compose ask");
  assert.equal(owned.namesNonMailVenue(reported), true, "but Mailchimp must win");
  assert.match(owned.resolveBrowseTargetUrl(reported), /mailchimp/);
});

test("ordinary email asks still route to mail", () => {
  assert.equal(owned.namesNonMailVenue("send john@acme.com an email about the launch"), false);
  assert.equal(owned.namesNonMailVenue("draft an email to the team about pricing"), false);
  assert.equal(owned.namesNonMailVenue("reply to that message in gmail"), false);
});

test("everyday prepositions are not mistaken for app names", () => {
  for (const ask of [
    "email me the report in the morning",
    "share this with all of our clients",
    "put it on the calendar for tuesday",
  ]) {
    assert.equal(owned.resolveNamedWorkVenueUrl(ask), "", `"${ask}" should name no venue`);
  }
});

test("existing dashboard routing is unaffected", () => {
  assert.match(owned.resolveBrowseTargetUrl("check my shopify admin"), /shopify/);
  assert.match(owned.resolveBrowseTargetUrl("open my reddit ads thing"), /ads\.reddit/);
  assert.match(owned.resolveBrowseTargetUrl("link our instagram account on meta business suite"), /business\.facebook/);
});
