/**
 * Glass `/model` catalog. Chat rows come from the canonical picker
 * (`src/lib/modelCatalog.js`). Image mode uses the curated Imagine list.
 */

import { MODEL_GROUPS } from "../../src/lib/modelCatalog.js";
import { modelPickerHint } from "../../src/lib/models/modelPickerMeta.js";

const IMAGINE_MODELS = [
  { value: "auto", label: "Auto", hint: "LYKN picks", group: "" },
  { value: "gpt-image-2", label: "GPT Image 2", group: "Image" },
  { value: "dall-e-3", label: "DALL·E 3", group: "Image" },
  { value: "gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image", group: "Image" },
  { value: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image", group: "Image" },
];

function withPickerHint(item, extras = {}) {
  return {
    ...item,
    hint: modelPickerHint({
      id: item.value,
      label: item.label,
      ...extras,
    }),
  };
}

export function overlayModelOptions(mode) {
  if (mode === "image") {
    return IMAGINE_MODELS.map((item) =>
      item.value === "auto"
        ? item
        : withPickerHint(item, { modalities: { output: [String(item.group || "Image").toLowerCase()] } }),
    );
  }
  const out = [];
  for (const group of MODEL_GROUPS || []) {
    for (const item of group.items || []) {
      const value = String(item.value || "").trim();
      const label = String(item.label || value).trim();
      if (!value || !label) continue;
      out.push({
        value,
        label,
        hint: modelPickerHint({ id: value, label }),
        group: String(group.label || ""),
      });
    }
  }
  return out;
}
