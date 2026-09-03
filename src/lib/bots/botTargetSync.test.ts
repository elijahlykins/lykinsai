import test from "node:test";
import assert from "node:assert/strict";

import { PICK_PIN_MS, resolveBarTarget } from "./botTargetSync";

test("without a pick, the face simply follows the active board's owner", () => {
  assert.deepEqual(resolveBarTarget({ ownerId: "", pick: null }), { targetId: "", pick: null });
  assert.deepEqual(resolveBarTarget({ ownerId: "bot-1", pick: null }), {
    targetId: "bot-1",
    pick: null,
  });
});

test("a fresh pick pins the face while the old board is still active", () => {
  const pick = { botId: "bot-1", at: 1000 };
  // Runtime events keep firing while the hop is in flight — the face must
  // hold the picked bot, not flip back to the old board's owner (LYKN here).
  const held = resolveBarTarget({ ownerId: "", pick, now: 1200 });
  assert.equal(held.targetId, "bot-1");
  assert.deepEqual(held.pick, pick, "pick stays outstanding until its board lands");
  // Same while another bot still owns the visible board.
  assert.equal(resolveBarTarget({ ownerId: "bot-9", pick, now: 1200 }).targetId, "bot-1");
});

test("the pin releases the moment the picked board becomes active", () => {
  const pick = { botId: "bot-1", at: 1000 };
  const landed = resolveBarTarget({ ownerId: "bot-1", pick, now: 1500 });
  assert.deepEqual(landed, { targetId: "bot-1", pick: null });
});

test("picking LYKN pins the LYKN face until a non-bot board is active", () => {
  const pick = { botId: "", at: 1000 };
  // The bot's board is still on screen while the hop back runs.
  const held = resolveBarTarget({ ownerId: "bot-1", pick, now: 1300 });
  assert.equal(held.targetId, "");
  assert.deepEqual(held.pick, pick);
  const landed = resolveBarTarget({ ownerId: "", pick, now: 1600 });
  assert.deepEqual(landed, { targetId: "", pick: null });
});

test("an expired pick stops pinning so a failed hop cannot wedge the face", () => {
  const pick = { botId: "bot-1", at: 1000 };
  const expired = resolveBarTarget({ ownerId: "", pick, now: 1000 + PICK_PIN_MS });
  assert.deepEqual(expired, { targetId: "", pick: null });
});
