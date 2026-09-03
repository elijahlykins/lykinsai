import test from "node:test";
import assert from "node:assert/strict";

import { agentChoiceRow } from "@/lib/agentChoiceRow";

/**
 * The runtime offers choices over "lykn:agent-choice" and resolves them via
 * resolveChoice(agentId, { choiceId, buttonId }). `pendingChoice` lives only in
 * memory — it is never persisted — so a button may only ever be drawn from a
 * LIVE event. Anything reconstructed from restored agent state would resolve to
 * "no_pending_choice": a button that does nothing.
 */

const CHOICE = {
  agentId: "a1",
  choiceId: "c1",
  type: "browse-approval",
  message: "Send this email?",
  buttons: [
    { id: "approve", label: "Yes, go ahead", primary: true },
    { id: "decline", label: "No" },
  ],
};

test("a live choice for the active agent renders its buttons", () => {
  const row = agentChoiceRow({ ...CHOICE, tool: "browser" }, "a1");
  assert.ok(row);
  assert.equal(row.agentId, "a1");
  assert.equal(row.choiceId, "c1");
  assert.equal(row.tool, "browser");
  assert.deepEqual(
    row.buttons.map((b) => b.id),
    ["approve", "decline"],
  );
});

test("button ids are passed through untouched, since the runtime matches on them", () => {
  // resolveChoice keys off exact ids per type: approve/decline, send/keep,
  // use-artifact/stop. Renaming or normalising any of them silently declines.
  const sendApproval = {
    agentId: "a1",
    choiceId: "c2",
    type: "send-approval",
    buttons: [
      { id: "send", label: "Yes, send it", primary: true },
      { id: "keep", label: "No, I'll take it from here" },
    ],
  };
  const row = agentChoiceRow(sendApproval, "a1");
  assert.deepEqual(
    row.buttons.map((b) => b.id),
    ["send", "keep"],
  );
});

test("a choice belonging to another agent is not shown", () => {
  assert.equal(agentChoiceRow(CHOICE, "a2"), null);
});

test("nothing renders without a choice", () => {
  assert.equal(agentChoiceRow(null, "a1"), null);
});

test("a choice carrying no usable buttons renders nothing, not an empty row", () => {
  assert.equal(agentChoiceRow({ ...CHOICE, buttons: [] }, "a1"), null);
  assert.equal(agentChoiceRow({ ...CHOICE, buttons: undefined }, "a1"), null);
  assert.equal(
    agentChoiceRow({ ...CHOICE, buttons: [{ label: "no id" }] }, "a1"),
    null,
    "a button with no id cannot be resolved, so it must not be offered",
  );
});

test("the primary flag survives, so the affirmative reads as primary", () => {
  const row = agentChoiceRow(CHOICE, "a1");
  assert.equal(row.buttons[0].primary, true);
  assert.equal(row.buttons[1].primary, false);
});

test("a button with no label falls back to its id rather than rendering blank", () => {
  const row = agentChoiceRow({ ...CHOICE, buttons: [{ id: "approve" }] }, "a1");
  assert.equal(row.buttons[0].label, "approve");
});
