import test from "node:test";
import assert from "node:assert/strict";

import {
  LYKN_DEFAULT_IMAGE_MODEL,
  LYKN_DEFAULT_VIDEO_MODEL,
  STUDIO_MODEL_AUTO,
  catalogFromPickerGroups,
  isImagineCatalogModel,
  isImagineVideoModelId,
  isTextCatalogModel,
  optionsForStudioMode,
  peekStudioSendModels,
  preferredImagineModel,
  saveStudioModeModel,
  studioImagineOverride,
  studioLlmOverride,
  switchImagineLaneModel,
} from "./studioModeModels";
import { LYKN_ID } from "@/lib/modelCatalog";
import { isModelAllowedForPlan } from "@/lib/modelTiers";

const FALLBACK = catalogFromPickerGroups();

test("chat lists LYKN first and every curated text model, including cheap ones", () => {
  const opts = optionsForStudioMode("chat", FALLBACK);
  assert.equal(opts[0].value, LYKN_ID);
  const values = new Set(opts.map((o) => o.value));
  assert.ok(values.has("gpt-5-nano"), "cheap closed models belong in Chat");
  assert.ok(values.has("claude-haiku-4-5"));
  assert.ok(values.has("gpt-5.6-sol"));
  assert.ok(values.has("gpt-6-astra"));
  assert.ok(values.has("claude-fable-5.1"));
  assert.equal(values.has(STUDIO_MODEL_AUTO), false);
});

test("picker rows show cost and speed tags, never Free", () => {
  const opts = optionsForStudioMode("chat", [
    ...FALLBACK,
    {
      id: "meta-llama/llama-3.3-70b-instruct:free",
      label: "Meta: Llama 3.3 70B Instruct (free)",
      provider: "meta-llama",
      pricing: { input: 0, output: 0 },
      modalities: { output: ["text"] },
    },
  ]);
  const llama = opts.find((o) => o.value.includes("llama-3.3"));
  assert.ok(llama);
  assert.equal(llama.label, "Llama 3.3 70B Instruct");
  assert.match(llama.hint, /Cheap/);
  assert.doesNotMatch(llama.hint, /free/i);
  const nano = opts.find((o) => o.value === "gpt-5-nano");
  assert.match(nano.hint, /Cheap/);
  assert.match(nano.hint, /Fast/);
  const astra = opts.find((o) => o.value === "gpt-6-astra");
  assert.match(astra.hint, /Top tier/);
});

test("research is text-only Auto, not image generators", () => {
  const opts = optionsForStudioMode("research", FALLBACK);
  assert.equal(opts[0].value, STUDIO_MODEL_AUTO);
  assert.ok(opts.some((o) => o.value === "gpt-5-nano"));
  assert.ok(!opts.some((o) => o.value === "gpt-image-2"));
});

test("build includes cheap and flagship text models, not image generators", () => {
  const opts = optionsForStudioMode("build", FALLBACK);
  assert.equal(opts[0].value, STUDIO_MODEL_AUTO);
  const values = new Set(opts.map((o) => o.value));
  assert.ok(values.has("gpt-5-nano"));
  assert.ok(values.has("gpt-4.1-nano"));
  assert.ok(values.has("claude-opus-5"));
  assert.ok(values.has("gpt-6-astra"));
  assert.ok(values.has("claude-fable-5.1"));
  assert.ok(values.has("grok-build-0.1"));
  assert.equal(values.has("gpt-image-2"), false);
});

test("imagine lists curated image models and catalog image/video rows", () => {
  const opts = optionsForStudioMode("imagine", [
    ...FALLBACK,
    {
      id: "black-forest-labs/flux-2",
      label: "FLUX.2",
      provider: "black-forest-labs",
      modalities: { output: ["image"] },
    },
    {
      id: "openai/sora",
      label: "Sora",
      provider: "openai",
      modalities: { output: ["video"] },
    },
  ]);
  assert.equal(opts[0].value, STUDIO_MODEL_AUTO);
  assert.ok(opts.some((o) => o.value === "gpt-image-2"));
  assert.ok(opts.some((o) => o.value === "black-forest-labs/flux-2"));
  assert.ok(opts.some((o) => o.value === "openai/sora"));
  assert.ok(!opts.some((o) => o.value === "claude-opus-5"));
});

test("imagine curates video generators and classifies lanes", () => {
  const opts = optionsForStudioMode("imagine", FALLBACK);
  const values = new Set(opts.map((o) => o.value));
  // The committed defaults are visible on the Auto row, not a mystery.
  assert.equal(opts[0].value, STUDIO_MODEL_AUTO);
  assert.match(opts[0].hint, /GPT Image 2/);
  assert.match(opts[0].hint, /Veo 3\.1 Fast/);
  // Curated video generators are offered alongside the image ones.
  assert.ok(values.has("google/veo-3.1-fast"));
  assert.ok(values.has("google/veo-3.1"));
  assert.ok(values.has("kwaivgi/kling-v3.0-pro"));
  assert.ok(values.has("bytedance/seedance-2.0"));
  assert.ok(values.has("openai/sora-2-pro"));
  // Lane classification: a video pick must never reach the image endpoint
  // and vice versa — this predicate is what the composer guards with.
  assert.equal(isImagineVideoModelId("google/veo-3.1-fast"), true);
  assert.equal(isImagineVideoModelId("kwaivgi/kling-v3.0-pro"), true);
  assert.equal(isImagineVideoModelId("gpt-image-2"), false);
  assert.equal(isImagineVideoModelId("gemini-3.1-flash-image"), false);
  assert.equal(isImagineVideoModelId(""), false);
  // Video generators never leak into the text-model modes.
  const build = optionsForStudioMode("build", FALLBACK);
  assert.ok(!build.some((o) => o.value === "google/veo-3.1-fast"));
});

test("open-source catalog rows appear in chat/research/build", () => {
  const catalog = [
    ...FALLBACK,
    {
      id: "deepseek/deepseek-r1",
      label: "DeepSeek R1",
      provider: "deepseek",
      modalities: { output: ["text"] },
      capabilities: { tools: true },
    },
    {
      id: "meta-llama/llama-4-maverick",
      label: "Llama 4 Maverick",
      provider: "meta-llama",
      modalities: { output: ["text"] },
    },
  ];
  for (const mode of ["chat", "research", "build"] as const) {
    const values = new Set(optionsForStudioMode(mode, catalog).map((o) => o.value));
    assert.ok(values.has("deepseek/deepseek-r1"), `${mode} missing DeepSeek`);
    assert.ok(values.has("meta-llama/llama-4-maverick"), `${mode} missing Llama`);
  }
});

test("text vs imagine filters", () => {
  assert.equal(isTextCatalogModel({ id: "gpt-5-nano", label: "Nano" }), true);
  assert.equal(
    isImagineCatalogModel({ id: "gpt-5-nano", label: "Nano", modalities: { output: ["text"] } }),
    false,
  );
  assert.equal(isImagineCatalogModel({ id: "gpt-image-2", label: "GPT Image 2" }), true);
});

test("LLM override: Chat/Research/Build explicit picks, Imagine is the generator", () => {
  const catalog = FALLBACK;
  assert.equal(
    studioLlmOverride({
      mode: "build",
      value: "claude-opus-5",
      catalog,
      modelTier: "top",
    }),
    "claude-opus-5",
  );
  assert.equal(
    studioLlmOverride({
      mode: "chat",
      value: "claude-opus-5",
      catalog,
      modelTier: "top",
    }),
    "claude-opus-5",
  );
  assert.equal(
    studioLlmOverride({
      mode: "chat",
      value: LYKN_ID,
      catalog,
      modelTier: "top",
    }),
    "",
  );
  assert.equal(
    studioImagineOverride({
      mode: "imagine",
      value: "gpt-image-2",
      catalog,
      modelTier: "top",
    }),
    "gpt-image-2",
  );
  assert.equal(
    studioImagineOverride({
      mode: "build",
      value: "gpt-image-2",
      catalog,
      modelTier: "top",
    }),
    "",
  );
});

test("peekStudioSendModels reads the picker, not a stale React value", () => {
  const memory = new Map<string, string>();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => {
      memory.set(key, String(value));
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  } as Storage;
  try {
    saveStudioModeModel("research", "gpt-5-nano", FALLBACK, "top");
    saveStudioModeModel("build", "claude-opus-5", FALLBACK, "top");
    saveStudioModeModel("imagine", "dall-e-3", FALLBACK, "top");
    assert.equal(
      peekStudioSendModels({ mode: "research", catalog: FALLBACK, modelTier: "top" }).llmOverride,
      "gpt-5-nano",
    );
    assert.equal(
      peekStudioSendModels({ mode: "build", catalog: FALLBACK, modelTier: "top" }).llmOverride,
      "claude-opus-5",
    );
    assert.equal(
      peekStudioSendModels({
        mode: "chat",
        catalog: FALLBACK,
        modelTier: "top",
        chatModelId: "gpt-5.6-sol",
      }).llmOverride,
      "gpt-5.6-sol",
    );
    assert.equal(
      peekStudioSendModels({ mode: "imagine", catalog: FALLBACK, modelTier: "top" }).imageModel,
      "dall-e-3",
    );
  } finally {
    globalThis.localStorage = prev;
  }
});

test("imagine lane auto-switch: user preference first, LYKN defaults otherwise", () => {
  const memory = new Map<string, string>();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => {
      memory.set(key, String(value));
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  } as Storage;
  try {
    // No pick made yet — both lanes fall back to the LYKN defaults.
    assert.equal(preferredImagineModel("image"), LYKN_DEFAULT_IMAGE_MODEL);
    assert.equal(preferredImagineModel("video"), LYKN_DEFAULT_VIDEO_MODEL);
    assert.equal(switchImagineLaneModel("video"), LYKN_DEFAULT_VIDEO_MODEL);
    assert.equal(
      peekStudioSendModels({ mode: "imagine", catalog: FALLBACK, modelTier: "top" }).imageModel,
      LYKN_DEFAULT_VIDEO_MODEL,
    );

    // Explicit picks become that lane's preference.
    saveStudioModeModel("imagine", "kwaivgi/kling-v3.0-pro", FALLBACK, "top");
    saveStudioModeModel("imagine", "dall-e-3", FALLBACK, "top");
    assert.equal(preferredImagineModel("video"), "kwaivgi/kling-v3.0-pro");
    assert.equal(preferredImagineModel("image"), "dall-e-3");

    // "Make me a video" while DALL·E 3 is picked → the picker moves to the
    // user's preferred video model, and the send reads it immediately.
    assert.equal(switchImagineLaneModel("video"), "kwaivgi/kling-v3.0-pro");
    assert.equal(
      peekStudioSendModels({ mode: "imagine", catalog: FALLBACK, modelTier: "top" }).imageModel,
      "kwaivgi/kling-v3.0-pro",
    );
    // And back: an image ask while Kling is picked → the image preference.
    assert.equal(switchImagineLaneModel("image"), "dall-e-3");
    assert.equal(
      peekStudioSendModels({ mode: "imagine", catalog: FALLBACK, modelTier: "top" }).imageModel,
      "dall-e-3",
    );
    // Auto-switches never overwrite the lane preferences themselves.
    assert.equal(preferredImagineModel("video"), "kwaivgi/kling-v3.0-pro");
    assert.equal(preferredImagineModel("image"), "dall-e-3");
  } finally {
    globalThis.localStorage = prev;
  }
});

test("plan gating: catalog open-source is frontier, auto stays free", () => {
  assert.equal(isModelAllowedForPlan("auto", "basic"), true);
  assert.equal(isModelAllowedForPlan("deepseek/deepseek-r1", "basic"), false);
  assert.equal(isModelAllowedForPlan("deepseek/deepseek-r1", "top"), true);
  assert.equal(isModelAllowedForPlan("gpt-image-2", "top"), true);
});
