import test from "node:test";
import assert from "node:assert/strict";

import {
  BOT_MODEL_GROUPS,
  BOT_MODE_LYKN,
  BOT_MODE_MY_SETUP,
  botModelHint,
  botModelLabel,
  botModelPolicyFor,
  botModelSelectValue,
  isBotModelAllowed,
} from "./botModels";
import { KNOWN_MODEL_IDS } from "@/lib/modelCatalog";

test("a bot nobody has touched stays on LYKN routing", () => {
  // The whole contract: default unless the user manually changes it.
  assert.equal(botModelSelectValue(undefined), BOT_MODE_LYKN);
  assert.equal(botModelSelectValue(null), BOT_MODE_LYKN);
  assert.equal(botModelSelectValue({}), BOT_MODE_LYKN);
  assert.equal(botModelSelectValue({ mode: "lykn" }), BOT_MODE_LYKN);
  assert.deepEqual(botModelPolicyFor(BOT_MODE_LYKN), { mode: "lykn", modelId: null });
});

test("picking a model pins it; picking a mode clears the pin", () => {
  assert.deepEqual(botModelPolicyFor("claude-opus-5"), { mode: "model", modelId: "claude-opus-5" });
  assert.deepEqual(botModelPolicyFor(BOT_MODE_MY_SETUP), { mode: "my_setup", modelId: null });
  // Round-trips back to the same select value.
  assert.equal(botModelSelectValue(botModelPolicyFor("claude-opus-5")), "claude-opus-5");
  assert.equal(botModelSelectValue(botModelPolicyFor(BOT_MODE_MY_SETUP)), BOT_MODE_MY_SETUP);
});

test("a pinned model that lost its id falls back to the default", () => {
  assert.equal(botModelSelectValue({ mode: "model", modelId: null }), BOT_MODE_LYKN);
  assert.equal(botModelSelectValue({ mode: "model" }), BOT_MODE_LYKN);
});

test("every offered model is a real catalog id the server will accept", () => {
  // The server validates with isSelectableModelId against this same catalog,
  // so an id that drifts out of it would be silently dropped.
  for (const group of BOT_MODEL_GROUPS) {
    for (const item of group.items) {
      if (item.value === BOT_MODE_LYKN || item.value === BOT_MODE_MY_SETUP) continue;
      assert.ok(KNOWN_MODEL_IDS.includes(item.value), `${item.value} is not in MODEL_GROUPS`);
    }
  }
});

test("the routing modes lead and are never plan-gated", () => {
  assert.deepEqual(
    BOT_MODEL_GROUPS[0].items.map((i) => i.value),
    [BOT_MODE_LYKN, BOT_MODE_MY_SETUP],
  );
  assert.equal(isBotModelAllowed(BOT_MODE_LYKN, "basic"), true);
  assert.equal(isBotModelAllowed(BOT_MODE_MY_SETUP, "basic"), true);
  // A specific model still follows the plan.
  assert.equal(isBotModelAllowed("claude-opus-5", "basic"), false);
  assert.equal(isBotModelAllowed("claude-opus-5", "top"), true);
});

test("the hint says what the current choice actually does", () => {
  assert.match(botModelHint({ mode: "lykn" }), /LYKN picks per turn/);
  assert.match(botModelHint({ mode: "my_setup" }), /My Setup/);
  assert.match(botModelHint({ mode: "model", modelId: "claude-opus-5" }), /Claude Opus 5/);
  assert.equal(botModelLabel("claude-opus-5"), "Claude Opus 5");
});
