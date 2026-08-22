/**
 * Handing a chat ask to the browser agent — after asking.
 *
 * Two regressions live here. The first: a second browser task sent from the chat
 * appeared underneath the first task's agent. Agents and browser tabs are paired
 * one to one, so a task with no agent of its own has to borrow a tab — and
 * sending with a blank id does not opt out of that, because the runtime resolves
 * a blank id to whichever agent happens to be active.
 *
 * The second: the chat jumped to the browser on its own. The classifier reads
 * intent from a sentence and cannot tell "go do it" from "talk me through it",
 * so a browser-shaped ask now becomes an offer, and the next message decides.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  handOffAskToBrowserAgent,
  productNameFromUrl,
  resetBrowserHandoffOffers,
} from "@/lib/ai/agentHandoff";

type Sent = { text: string; agentId: string };

/** A stand-in for the desktop bridge, recording what the chat asked it to do. */
function fakeDesktop(
  opts: { route?: "agent" | "chat"; venue?: string; canCreate?: boolean } = {},
) {
  const { route = "agent", venue = "https://admin.mailchimp.com", canCreate = true } = opts;
  const created: string[] = [];
  const sent: Sent[] = [];
  let n = 0;
  const api = {
    // Main only routes to the agent for work verbs aimed at a named product;
    // questions come back as chat however this fake is configured.
    agentRouteCheck: async (text: string) => {
      const isQuestion = /\?\s*$/.test(text) || /^\s*(?:what|how|why|who|when|which|is|does|can)\b/i.test(text);
      const isWork = !isQuestion && /\b(open|create|design|build|fill|send)\b/i.test(text);
      const decided = isWork ? route : "chat";
      return {
        route: decided,
        skill: decided === "agent" ? "browse" : "general",
        venue,
        destination: venue,
        _text: text,
      };
    },
    agentCreate: async (_payload: { goal?: string }) => {
      if (!canCreate) return { ok: false };
      n += 1;
      const agentId = `agent-${n}`;
      created.push(agentId);
      return { ok: true, agentId };
    },
    studioAgentSend: async (text: string, _atts: unknown[], agentId: string) => {
      sent.push({ text, agentId });
      return { ok: true };
    },
  };
  (globalThis as { lykn?: unknown }).lykn = api;
  resetBrowserHandoffOffers();
  return { created, sent };
}

function clearDesktop() {
  delete (globalThis as { lykn?: unknown }).lykn;
  resetBrowserHandoffOffers();
}

test("a browser task is offered first, not taken", async () => {
  const desktop = fakeDesktop();
  const result = await handOffAskToBrowserAgent("open mailchimp and create a campaign", {
    chatId: "c1",
  });
  assert.equal(result.handed, false, "nothing may start before the user answers");
  assert.equal(result.asked, true);
  assert.match(result.note || "", /stay here/i, "the offer has to name both options");
  assert.deepEqual(desktop.created, [], "no agent until there is a yes");
  assert.deepEqual(desktop.sent, []);
  clearDesktop();
});

test("a yes hands the original ask over in an agent of its own", async () => {
  const desktop = fakeDesktop();
  await handOffAskToBrowserAgent("open mailchimp and create a campaign", { chatId: "c1" });
  const result = await handOffAskToBrowserAgent("yes", { chatId: "c1" });
  assert.equal(result.handed, true);
  assert.deepEqual(desktop.created, ["agent-1"], "it should make an agent for the task");
  assert.equal(desktop.sent.length, 1);
  assert.equal(
    desktop.sent[0].text,
    "open mailchimp and create a campaign",
    "the agent gets the task, not the word 'yes'",
  );
  assert.equal(
    desktop.sent[0].agentId,
    "agent-1",
    "the task must be addressed to its own agent, not left blank",
  );
  clearDesktop();
});

test("a no leaves the work in the chat", async () => {
  const desktop = fakeDesktop();
  await handOffAskToBrowserAgent("open mailchimp and create a campaign", { chatId: "c1" });
  const result = await handOffAskToBrowserAgent("no, stay here", { chatId: "c1" });
  assert.equal(result.handed, false);
  assert.equal(result.asked, undefined, "declining must not re-open the same offer");
  assert.deepEqual(desktop.created, []);
  assert.deepEqual(desktop.sent, []);
  clearDesktop();
});

test("an instruction attached to the yes travels with the task", async () => {
  const desktop = fakeDesktop();
  await handOffAskToBrowserAgent("open mailchimp and create a campaign", { chatId: "c1" });
  await handOffAskToBrowserAgent("yes, and keep the subject line under 40 characters", {
    chatId: "c1",
  });
  assert.equal(desktop.sent.length, 1);
  assert.match(desktop.sent[0].text, /create a campaign/);
  assert.match(
    desktop.sent[0].text,
    /subject line under 40 characters/,
    "the agent would otherwise work from the older version of the ask",
  );
  clearDesktop();
});

test("naming the browser in the ask skips the question", async () => {
  // "open mailchimp in the browser" has already answered it.
  const desktop = fakeDesktop();
  const result = await handOffAskToBrowserAgent(
    "open mailchimp in the browser and create a campaign",
    { chatId: "c1" },
  );
  assert.equal(result.handed, true);
  assert.equal(desktop.sent.length, 1);
  clearDesktop();
});

test("'always' stops the asking for the rest of the chat", async () => {
  const desktop = fakeDesktop();
  await handOffAskToBrowserAgent("open mailchimp and create a campaign", { chatId: "c1" });
  await handOffAskToBrowserAgent("yes, always", { chatId: "c1" });
  const next = await handOffAskToBrowserAgent("open canva and design a poster", {
    chatId: "c1",
  });
  assert.equal(next.handed, true, "consent given once should not be re-asked");
  assert.equal(desktop.sent.length, 2);
  clearDesktop();
});

test("a standing yes does not leak into another chat", async () => {
  const desktop = fakeDesktop();
  await handOffAskToBrowserAgent("open mailchimp and create a campaign", { chatId: "c1" });
  await handOffAskToBrowserAgent("yes, always", { chatId: "c1" });
  const other = await handOffAskToBrowserAgent("open canva and design a poster", {
    chatId: "c2",
  });
  assert.equal(other.handed, false);
  assert.equal(other.asked, true, "a different conversation gets its own choice");
  assert.equal(desktop.sent.length, 1);
  clearDesktop();
});

test("a pending offer in one chat is not answered by a yes in another", async () => {
  const desktop = fakeDesktop();
  await handOffAskToBrowserAgent("open mailchimp and create a campaign", { chatId: "c1" });
  const stray = await handOffAskToBrowserAgent("yes", { chatId: "c2" });
  assert.equal(stray.handed, false, "the yes belongs to the chat that was asked");
  assert.deepEqual(desktop.sent, []);
  clearDesktop();
});

test("changing the subject drops the offer instead of banking the answer", async () => {
  const desktop = fakeDesktop();
  await handOffAskToBrowserAgent("open mailchimp and create a campaign", { chatId: "c1" });
  await handOffAskToBrowserAgent("actually, what does open rate mean?", { chatId: "c1" });
  // A later stray "sure" must not start the abandoned task.
  const stray = await handOffAskToBrowserAgent("sure", { chatId: "c1" });
  assert.equal(stray.handed, false);
  assert.deepEqual(desktop.sent, []);
  clearDesktop();
});

test("two accepted tasks from the same chat get two agents, not one shared tab", async () => {
  // The reported bug: the second prompt showed up under the first prompt's agent.
  const desktop = fakeDesktop();
  await handOffAskToBrowserAgent("open mailchimp and create a campaign", { chatId: "c1" });
  await handOffAskToBrowserAgent("yes", { chatId: "c1" });
  await handOffAskToBrowserAgent("open canva and design a poster", { chatId: "c1" });
  await handOffAskToBrowserAgent("yes", { chatId: "c1" });
  assert.deepEqual(desktop.created, ["agent-1", "agent-2"]);
  assert.equal(desktop.sent[0].agentId, "agent-1");
  assert.equal(desktop.sent[1].agentId, "agent-2");
  assert.notEqual(
    desktop.sent[0].agentId,
    desktop.sent[1].agentId,
    "each task belongs in its own tab",
  );
  clearDesktop();
});

test("at the agent ceiling the accepted task still starts rather than being refused", async () => {
  const desktop = fakeDesktop({ canCreate: false });
  await handOffAskToBrowserAgent("open mailchimp and create a campaign", { chatId: "c1" });
  const result = await handOffAskToBrowserAgent("yes", { chatId: "c1" });
  assert.equal(result.handed, true, "a full agent list must not swallow the task");
  assert.equal(desktop.sent.length, 1);
  assert.equal(desktop.sent[0].agentId, "", "falls back to the active agent");
  clearDesktop();
});

test("a conversational ask is left in the chat, unasked and uncreated", async () => {
  const desktop = fakeDesktop({ route: "chat" });
  const result = await handOffAskToBrowserAgent("what is mailchimp good for?", {
    chatId: "c1",
  });
  assert.equal(result.handed, false);
  assert.equal(result.asked, undefined, "a question must not be interrupted with an offer");
  assert.deepEqual(desktop.created, [], "no agent, no tab, no browser window");
  assert.deepEqual(desktop.sent, []);
  clearDesktop();
});

test("an ask carrying attachments stays in the chat", async () => {
  // The agent takes local file paths; the chat holds uploaded URLs. Handing it
  // over would deliver the words without the files.
  const desktop = fakeDesktop();
  const result = await handOffAskToBrowserAgent("put this logo in the mailchimp email", {
    hasAttachments: true,
    chatId: "c1",
  });
  assert.equal(result.handed, false);
  assert.equal(result.asked, undefined);
  assert.deepEqual(desktop.sent, []);
  clearDesktop();
});

test("with no desktop bridge (the web build) every ask stays in chat", async () => {
  clearDesktop();
  const result = await handOffAskToBrowserAgent("open mailchimp and create a campaign", {
    chatId: "c1",
  });
  assert.equal(result.handed, false);
  assert.equal(result.asked, undefined);
});

test("the offer and the handover both say which product is involved", async () => {
  const desktop = fakeDesktop({ venue: "https://admin.mailchimp.com" });
  const offer = await handOffAskToBrowserAgent("open mailchimp and create a campaign", {
    chatId: "c1",
  });
  assert.match(offer.note || "", /Mailchimp/);
  const result = await handOffAskToBrowserAgent("go ahead", { chatId: "c1" });
  assert.match(result.note || "", /Mailchimp/);
  assert.equal(desktop.sent.length, 1);
  clearDesktop();
});

test("product names read as the product, not the deployment", () => {
  assert.equal(productNameFromUrl("https://admin.mailchimp.com"), "Mailchimp");
  assert.equal(productNameFromUrl("https://app.hubspot.com"), "Hubspot");
  assert.equal(productNameFromUrl("https://www.klaviyo.com/dashboard"), "Klaviyo");
  assert.equal(productNameFromUrl(""), "");
  assert.equal(productNameFromUrl("not a url"), "");
});
