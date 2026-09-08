import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILD_MODEL_AUTO,
  BUILD_MODEL_OPTIONS,
  buildModelLabel,
  buildTurnModelOverride,
  isBuildModelAllowed,
  isBuildModelId,
  normalizeBuildModel,
} from "./buildModels";
import { KNOWN_MODEL_IDS } from "@/lib/modelCatalog";

test("every coding pick exists in the canonical model catalog", () => {
  // The server validates the submitted `model` against this same catalog
  // (lib/models/registry.js seeds from MODEL_GROUPS). An id that drifts out
  // of the catalog would be silently dropped back to LYKN routing.
  for (const opt of BUILD_MODEL_OPTIONS) {
    if (opt.value === BUILD_MODEL_AUTO) continue;
    assert.ok(
      KNOWN_MODEL_IDS.includes(opt.value),
      `${opt.value} is not in MODEL_GROUPS`,
    );
  }
});

test("Auto is the first option and the fallback for junk input", () => {
  assert.equal(BUILD_MODEL_OPTIONS[0].value, BUILD_MODEL_AUTO);
  assert.equal(normalizeBuildModel(""), BUILD_MODEL_AUTO);
  assert.equal(normalizeBuildModel(null), BUILD_MODEL_AUTO);
  assert.equal(normalizeBuildModel("gpt-nonexistent"), BUILD_MODEL_AUTO);
  assert.equal(isBuildModelId("gpt-nonexistent"), false);
  assert.equal(buildModelLabel("gpt-nonexistent"), "Auto");
});

test("plan gating: basic keeps Auto, frontier picks unlock on top plans", () => {
  assert.equal(isBuildModelAllowed(BUILD_MODEL_AUTO, "basic"), true);
  assert.equal(isBuildModelAllowed("claude-opus-5", "basic"), false);
  assert.equal(isBuildModelAllowed("claude-opus-5", "top"), true);
  // A locked pick can never survive normalization into a send.
  assert.equal(normalizeBuildModel("claude-opus-5", "basic"), BUILD_MODEL_AUTO);
  assert.equal(normalizeBuildModel("claude-opus-5", "top"), "claude-opus-5");
});

test("the override only applies on the Build page", () => {
  const pick = { buildModel: "claude-opus-5", modelTier: "top" };
  assert.equal(
    buildTurnModelOverride({ ...pick, inBuildMode: true }),
    "claude-opus-5",
  );
  assert.equal(buildTurnModelOverride({ ...pick, inBuildMode: false }), "");
});

test("Auto and custom-model sessions send no override", () => {
  assert.equal(
    buildTurnModelOverride({
      buildModel: BUILD_MODEL_AUTO,
      inBuildMode: true,
      modelTier: "top",
    }),
    "",
  );
  // A Model Builder persona owns its own base model server-side.
  assert.equal(
    buildTurnModelOverride({
      buildModel: "claude-opus-5",
      inBuildMode: true,
      customModelId: "cm_123",
      modelTier: "top",
    }),
    "",
  );
});

test("a locked pick degrades to no override instead of a rejected send", () => {
  assert.equal(
    buildTurnModelOverride({
      buildModel: "claude-opus-5",
      inBuildMode: true,
      modelTier: "basic",
    }),
    "",
  );
});

test("Auto names the model it will actually run", async () => {
  const { autoStudioModelHint } = await import("@/lib/ai/studioModeModels");
  const { LYKN_ID, MY_SETUP_ID } = await import("@/lib/modelCatalog");

  // Chat model is LYKN's own routing → a coded turn goes to LYKN's coder,
  // not to the chat model. The row has to say so.
  assert.equal(autoStudioModelHint("build", LYKN_ID), "Grok 4.6");
  assert.equal(autoStudioModelHint("build", MY_SETUP_ID), "Grok 4.6");
  assert.equal(autoStudioModelHint("build", ""), "Grok 4.6");

  // The user picked a chat model → that model builds, nothing reroutes it.
  assert.equal(autoStudioModelHint("build", "claude-opus-5"), "Claude Opus 5");
  assert.equal(autoStudioModelHint("build", "gpt-5.6-sol"), "GPT-5.6 Sol");

  // Only Build has a dedicated coding route.
  assert.equal(autoStudioModelHint("research", LYKN_ID), "LYKN picks");
});

test("LYKN's coding model is named in exactly one place", async () => {
  const { LYKN_CODING_MODEL_ID, FRONTIER_XAI_ID } = await import("@/lib/modelCatalog");
  // The server reads this same constant as its CODED_ARTIFACT_MODEL default
  // (server/ai/modelInvoke.js), and modelInvoke.test.mjs asserts that end.
  assert.equal(LYKN_CODING_MODEL_ID, FRONTIER_XAI_ID);
  assert.equal(LYKN_CODING_MODEL_ID, "grok-4.6");
});
