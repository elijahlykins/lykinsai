/**
 * Where a chat ask goes.
 *
 * These tests exist because of a specific failure: asked to "open up mail chimp
 * and create a campaign", LYKN replied "I can't log into your Mailchimp account
 * from here, so I'm building a full campaign draft you can drop straight into
 * Mailchimp as a draft." Nothing was broken in the browser agent — it was never
 * consulted. The turn went to the chat model, which had no browser, so it
 * substituted a deliverable the user had not asked for.
 *
 * Two failure directions matter and both are covered here. Sending real browser
 * work to the chat model produces that confident non-answer. Sending a question
 * to the browser agent opens a window on somebody who just wanted a sentence.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { decideChatRoute } = require("./chatAgentRoute.cjs");
const { classifyAgentSkill } = require("./agentRuntime.cjs");

/** The ask that started this: the exact wording the user typed. */
const MAILCHIMP_ASK =
  "open up mail chimp and create a campaign to go out following the style of " +
  "our other campaigns this one should be about the new LYKN ai browser";

test("the ask that shipped a draft instead of doing the work now reaches the agent", () => {
  const decision = decideChatRoute(MAILCHIMP_ASK);
  assert.equal(decision.route, "agent");
  assert.match(decision.venue || "", /mailchimp/i, "it should know where to go");
});

test("work in a named product goes to the browser, whatever the deliverable is called", () => {
  // Each of these once lost its turn to a LYKN-side builder because the noun
  // beside the product name — newsletter, report, flyer, landing page — looked
  // like something LYKN makes itself.
  for (const ask of [
    "log into hubspot and draft the newsletter",
    "log into hubspot and draft the report",
    "open mailchimp and draft a report on our open rates",
    "log into klaviyo and make a flyer for the sale",
    "log into shopify and build a landing page",
    "open squarespace and make the pricing page",
    "in mailchimp replicate our last campaign",
    "go to beehiiv and draft this week's newsletter",
  ]) {
    assert.equal(decideChatRoute(ask).route, "agent", ask);
  }
});

test("a named product is a destination, not a description", () => {
  // The distinction the classifier has to hold: being told to go somewhere is
  // different from merely mentioning the place.
  assert.equal(classifyAgentSkill("open mailchimp and make the campaign"), "browse");
  assert.notEqual(classifyAgentSkill("make me a landing page for mailchimp users"), "browse");
});

test("questions stay questions, even when they name a product", () => {
  for (const ask of [
    "how does mailchimp pricing work",
    "what is mailchimp good for?",
    "compare mailchimp vs klaviyo for us",
    "what is the best time to send a newsletter",
    "explain how our open rates compare to industry average",
    "what should I put in the campaign?",
  ]) {
    assert.equal(decideChatRoute(ask).route, "chat", ask);
  }
});

test("things LYKN makes itself are still made in LYKN", () => {
  for (const ask of [
    "make me a react dashboard",
    "build me a landing page",
    "make me an image of a mailbox",
    "write the copy for a campaign about the new LYKN ai browser",
    "write a subject line for our newsletter",
    "research the top 10 email tools and write a report",
  ]) {
    assert.equal(decideChatRoute(ask).route, "chat", ask);
  }
});

test("an ask with no destination is a conversation, however action-shaped", () => {
  // "draft an email to sarah" is real work in Agent Mode, where the user has
  // already chosen an agent that drives a browser. Typed into a chat it is a
  // request for words, and guessing otherwise opens a browser nobody asked for.
  const decision = decideChatRoute("draft an email to sarah about the meeting");
  assert.equal(decision.route, "chat");
  assert.equal(decision.reason, "no destination named");
});

test("an explicit URL is a destination even with no product name", () => {
  const decision = decideChatRoute("go to https://example.com and fill out the contact form");
  assert.equal(decision.route, "agent");
  assert.equal(decision.venue, "", "example.com is not a product we can name");
  assert.match(decision.destination || "", /example\.com/);
});

test("empty and oversized prompts never route anywhere", () => {
  assert.equal(decideChatRoute("").route, "chat");
  assert.equal(decideChatRoute("   ").route, "chat");
  assert.equal(decideChatRoute("open mailchimp ".repeat(400)).route, "chat");
  assert.equal(decideChatRoute(null).route, "chat");
  assert.equal(decideChatRoute(undefined).route, "chat");
});

test("the email platforms a marketing task actually names are all recognized", () => {
  // A product missing from the venue table resolves to no destination, and the
  // ask silently falls back to chat — which is how "make a flyer in Klaviyo"
  // became an image in the conversation.
  for (const [ask, expected] of [
    ["open klaviyo and create a campaign", /klaviyo/i],
    ["open brevo and build the email", /brevo/i],
    ["open convertkit and make a broadcast", /kit\.com/i],
    ["open beehiiv and draft the newsletter", /beehiiv/i],
    ["open mailerlite and send the campaign", /mailerlite/i],
    ["open constant contact and create a campaign", /constantcontact/i],
  ]) {
    const decision = decideChatRoute(ask);
    assert.equal(decision.route, "agent", ask);
    assert.match(decision.venue || "", expected, ask);
  }
});
