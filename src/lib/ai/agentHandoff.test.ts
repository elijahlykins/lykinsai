/**
 * Handing a chat ask to the browser agent, in its own tab.
 *
 * The regression that prompted these: a second browser task sent from the chat
 * appeared underneath the first task's agent. Agents and browser tabs are paired
 * one to one, so a task with no agent of its own has to borrow a tab — and
 * sending with a blank id does not opt out of that, because the runtime resolves
 * a blank id to whichever agent happens to be active.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { handOffAskToBrowserAgent, productNameFromUrl } from "@/lib/ai/agentHandoff";

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
    agentRouteCheck: async (text: string) => ({
      route,
      skill: route === "agent" ? "browse" : "general",
      venue,
      destination: venue,
      _text: text,
    }),
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
  return { created, sent };
}

function clearDesktop() {
  delete (globalThis as { lykn?: unknown }).lykn;
}

test("a browser task is handed over in an agent of its own", async () => {
  const desktop = fakeDesktop();
  const result = await handOffAskToBrowserAgent("open mailchimp and create a campaign");
  assert.equal(result.handed, true);
  assert.deepEqual(desktop.created, ["agent-1"], "it should make an agent for the task");
  assert.equal(desktop.sent.length, 1);
  assert.equal(
    desktop.sent[0].agentId,
    "agent-1",
    "the task must be addressed to its own agent, not left blank",
  );
  clearDesktop();
});

test("a blank agent id is never sent, because that lands on the active agent", async () => {
  const desktop = fakeDesktop();
  await handOffAskToBrowserAgent("open mailchimp and create a campaign");
  assert.notEqual(desktop.sent[0].agentId, "");
  clearDesktop();
});

test("two tasks from the same chat get two agents, not one shared tab", async () => {
  // The reported bug: the second prompt showed up under the first prompt's agent.
  const desktop = fakeDesktop();
  await handOffAskToBrowserAgent("open mailchimp and create a campaign");
  await handOffAskToBrowserAgent("open canva and design a poster");
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

test("at the agent ceiling the task still starts rather than being refused", async () => {
  const desktop = fakeDesktop({ canCreate: false });
  const result = await handOffAskToBrowserAgent("open mailchimp and create a campaign");
  assert.equal(result.handed, true, "a full agent list must not swallow the task");
  assert.equal(desktop.sent.length, 1);
  assert.equal(desktop.sent[0].agentId, "", "falls back to the active agent");
  clearDesktop();
});

test("a conversational ask is left in the chat and creates nothing", async () => {
  const desktop = fakeDesktop({ route: "chat" });
  const result = await handOffAskToBrowserAgent("what is mailchimp good for?");
  assert.equal(result.handed, false);
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
  });
  assert.equal(result.handed, false);
  assert.deepEqual(desktop.sent, []);
  clearDesktop();
});

test("with no desktop bridge (the web build) every ask stays in chat", async () => {
  clearDesktop();
  const result = await handOffAskToBrowserAgent("open mailchimp and create a campaign");
  assert.equal(result.handed, false);
});

test("the handover says which product it went to", async () => {
  const desktop = fakeDesktop({ venue: "https://admin.mailchimp.com" });
  const result = await handOffAskToBrowserAgent("open mailchimp and create a campaign");
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
