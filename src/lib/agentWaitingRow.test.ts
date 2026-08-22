/**
 * The rail showed a paused run as finished whenever it had not personally
 * witnessed the pause. `lykn:agent-waiting` fires once, and a surface that
 * mounted after the wall, reloaded, or was looking at another agent's tab simply
 * never got it — so the amber pulse was missing under a reply that said
 * "Waiting on you to: finish signing in".
 */

import test from "node:test";
import assert from "node:assert/strict";

import { agentWaitingRow } from "@/lib/agentWaitingRow";

test("a parked agent shows the pulse with no event to go on", () => {
  const row = agentWaitingRow({
    waiting: true,
    step: "Waiting for you: finish signing in to login.mailchimp.com",
    waitingKind: "signin",
    waitingDetail: "Enter the code sent to the number ending 4094.",
    waitingHost: "login.mailchimp.com",
  });
  assert.ok(row);
  assert.match(row.label, /Waiting for you/i);
  assert.match(row.detail, /ending 4094/);
});

test("the event's wording wins when we did catch it", () => {
  const row = agentWaitingRow(
    { waiting: true, step: "Waiting for you", waitingKind: "signin" },
    { label: "Waiting for you to sign in to login.mailchimp.com", detail: "" },
  );
  assert.equal(row?.label, "Waiting for you to sign in to login.mailchimp.com");
});

test("a pause with no readable step still names the wall", () => {
  const row = agentWaitingRow({
    waiting: true,
    step: "",
    waitingKind: "signin",
    waitingHost: "login.mailchimp.com",
  });
  assert.match(row!.label, /sign in to login\.mailchimp\.com/i);
});

test("a pause of unknown kind still shows something", () => {
  const row = agentWaitingRow({ waiting: true, step: "", waitingKind: "blocked" });
  assert.equal(row?.label, "Waiting for you");
});

test("nothing shows for a finished or working agent", () => {
  assert.equal(agentWaitingRow({ waiting: false, step: "Done" }), null);
  assert.equal(agentWaitingRow({ waiting: false, step: "Opening Mailchimp…" }), null);
  assert.equal(agentWaitingRow(null), null);
});

test("an empty event does not stand in for a finished agent", () => {
  // A cleared wait arrives as {waiting:false}, which the caller turns into null;
  // a row with no label must never keep the pulse alive on its own.
  assert.equal(agentWaitingRow({ waiting: false, step: "Done" }, { label: "", detail: "" }), null);
});

test("a question pause carries its kind and one-tap answers", () => {
  const row = agentWaitingRow(
    { waiting: true, step: "Needs an answer from you", waitingKind: "question" },
    {
      label: "Needs an answer from you",
      detail: "What subject line would you like?",
      kind: "question",
      options: ["Quick favor — 2 mins?", "  Something fun for you  ", ""],
    },
  );
  assert.equal(row?.kind, "question");
  // Blanks dropped, whitespace collapsed — these render as buttons.
  assert.deepEqual(row?.options, ["Quick favor — 2 mins?", "Something fun for you"]);
});

test("options survive a rail that mounted after the question", () => {
  const row = agentWaitingRow({
    waiting: true,
    step: "Needs an answer from you",
    waitingKind: "question",
    waitingDetail: "What subject line would you like?",
    waitingOptions: ["Top secret inside", "A link you'll like"],
  });
  assert.equal(row?.kind, "question");
  assert.equal(row?.options.length, 2);
});

test("a pause with no options offers none rather than undefined", () => {
  const row = agentWaitingRow({ waiting: true, step: "Waiting for you", waitingKind: "signin" });
  assert.deepEqual(row?.options, []);
});
