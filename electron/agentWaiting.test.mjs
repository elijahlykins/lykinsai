/**
 * A run parked on the user has to keep saying so.
 *
 * The waiting pulse used to depend entirely on catching one `lykn:agent-waiting`
 * event. Several routes into a pause never sent it — the end-of-turn honesty
 * check decides "still blocked" from unmet gaps, and a park with no steps left
 * to resume returned before announcing anything — so the turn ended with a reply
 * that read "Waiting on you to: finish signing in" and nothing on screen
 * suggesting the agent was still there. Worse, even when the event did fire, any
 * surface that mounted or switched tabs afterwards had already missed it.
 *
 * So the pause is carried on the agent, where every list, progress, and switch
 * payload picks it up. These tests pin that contract, since the rail now decides
 * whether to show the pulse from it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import os from "node:os";

const require = createRequire(import.meta.url);
const { createAgentRuntime } = require("./agentRuntime.cjs");

const runtime = createAgentRuntime({
  userDataPath: os.tmpdir(),
  apiBase: "http://localhost:0",
  getAuthToken: async () => "",
  emit: () => {},
});

test("a parked agent publishes the pause, its reason, and the exact ask", () => {
  const a = runtime.publicAgent({
    id: "w1",
    title: "Mailchimp campaign",
    status: "waiting",
    step: "Waiting for you: finish signing in to login.mailchimp.com",
    waitingReason: "signin",
    waitingUserAction: "Finish signing in to **login.mailchimp.com**.",
    waitingHost: "login.mailchimp.com",
  });
  assert.equal(a.waiting, true);
  assert.equal(a.waitingKind, "signin");
  assert.equal(a.waitingHost, "login.mailchimp.com");
  // Markdown emphasis is for the chat body, not a one-line indicator.
  assert.equal(a.waitingDetail, "Finish signing in to login.mailchimp.com.");
});

test("a pending choice reads as waiting on the user too", () => {
  const a = runtime.publicAgent({
    id: "w2",
    status: "waiting",
    step: "Waiting for your choice…",
    pendingChoice: { id: "c1", type: "complex-tool" },
  });
  assert.equal(a.waiting, true);
  assert.equal(a.waitingKind, "choice");
});

test("a finished agent publishes no pause", () => {
  const a = runtime.publicAgent({
    id: "w3",
    status: "idle",
    step: "Done",
    // Left over from an earlier turn — must not resurrect the indicator.
    waitingUserAction: "Finish signing in to login.mailchimp.com.",
    waitingHost: "login.mailchimp.com",
  });
  assert.equal(a.waiting, false);
  assert.equal(a.waitingKind, "");
  assert.equal(a.waitingDetail, "");
  assert.equal(a.waitingHost, "");
});

test("a working agent publishes no pause", () => {
  const a = runtime.publicAgent({ id: "w4", status: "running", step: "Opening Mailchimp…" });
  assert.equal(a.waiting, false);
});
