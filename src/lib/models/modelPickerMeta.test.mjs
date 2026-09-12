import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanModelLabel,
  costBandForModel,
  displayModelLabel,
  modelPickerHint,
} from "./modelPickerMeta.js";

test("OpenRouter free marks are stripped from the display name", () => {
  assert.equal(cleanModelLabel("Meta: Llama 3.3 70B Instruct (free)"), "Llama 3.3 70B Instruct");
  assert.equal(cleanModelLabel("Gemma 3 27B [free]"), "Gemma 3 27B");
  assert.equal(cleanModelLabel("Qwen 3 32B:free"), "Qwen 3 32B");
  assert.equal(cleanModelLabel("DeepSeek V3.1"), "DeepSeek V3.1");
  assert.equal(
    displayModelLabel({
      id: "meta-llama/llama-3.3-70b-instruct:free",
      label: "Meta: Llama 3.3 70B Instruct (free)",
    }),
    "Llama 3.3 70B Instruct",
  );
});

test("cost bands use live pricing when present and never say Free", () => {
  assert.equal(costBandForModel({ id: "x", pricing: { input: 0, output: 0 } }), "Cheap");
  assert.equal(costBandForModel({ id: "x", pricing: { input: 0.0002, output: 0.0008 } }), "Cheap");
  assert.equal(costBandForModel({ id: "x", pricing: { input: 0.001, output: 0.006 } }), "Low");
  assert.equal(costBandForModel({ id: "x", pricing: { input: 0.0025, output: 0.015 } }), "Standard");
  assert.equal(costBandForModel({ id: "x", pricing: { input: 0.005, output: 0.03 } }), "Expensive");
  assert.equal(costBandForModel({ id: "x", pricing: { input: 0.01, output: 0.05 } }), "Top tier");
});

test("picker hints name cost, speed, and capability, not the lab", () => {
  assert.equal(modelPickerHint({ id: "lykn" }), "Everyday");
  assert.equal(modelPickerHint({ id: "lykn-setup" }), "Your routing");
  assert.match(modelPickerHint({ id: "gpt-5-nano", label: "GPT-5 Nano" }), /Cheap/);
  assert.match(modelPickerHint({ id: "gpt-5-nano", label: "GPT-5 Nano" }), /Fast/);
  assert.match(modelPickerHint({ id: "gpt-6-astra", label: "GPT-6 Astra" }), /Top tier/);
  assert.match(
    modelPickerHint({ id: "o3", label: "o3", capabilities: { reasoning: true } }),
    /Reasoning/,
  );
  assert.equal(
    modelPickerHint({
      id: "google/veo-3.1-fast",
      label: "Veo 3.1 Fast",
      modalities: { output: ["video"] },
    }),
    "Standard · Fast · Video",
  );
  assert.equal(
    modelPickerHint({
      id: "gpt-image-2",
      label: "GPT Image 2",
      modalities: { output: ["image"] },
    }),
    "Standard · Image",
  );
  assert.doesNotMatch(
    modelPickerHint({
      id: "meta-llama/llama-3.3-70b-instruct:free",
      label: "Llama 3.3 70B Instruct (free)",
      pricing: { input: 0, output: 0 },
    }),
    /free/i,
  );
});
