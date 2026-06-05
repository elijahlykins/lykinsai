import {
  CLOSED_LLM_MODEL_SECTIONS,
  DEFAULT_CLOSED_LLM_MODEL_ID,
} from "@/lib/modelCatalog";
import {
  LORA_OPEN_SOURCE_MODEL_OPTIONS,
  OPEN_SOURCE_MODEL_OPTIONS,
} from "@/lib/modelBuilder/draftDefaults";

export const MODEL_ENGINE_OPEN = "open_source";
export const MODEL_ENGINE_CLOSED = "closed";

/** @typedef {{ value: string, label: string, hint?: string, kind: 'standard' | 'open_source', modelId: string }} ModelEngineSelectItem */
/** @typedef {{ id: string, label: string, items: ModelEngineSelectItem[] }} ModelEngineSelectSection */

/**
 * Grouped model list for the Model engine dropdown.
 * Closed sections first (frontier → fast → deep), open source last.
 * @param {{ loraOnlyOpenSource?: boolean }} [opts]
 * @returns {ModelEngineSelectSection[]}
 */
export function buildModelEngineSelectSections({ loraOnlyOpenSource = false } = {}) {
  const openSourceItems = loraOnlyOpenSource
    ? LORA_OPEN_SOURCE_MODEL_OPTIONS
    : OPEN_SOURCE_MODEL_OPTIONS;

  const closed = CLOSED_LLM_MODEL_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    items: section.items.map((m) => ({
      value: `standard:${section.id}:${m.id}`,
      label: m.label,
      hint: m.hint,
      kind: /** @type {'standard'} */ ("standard"),
      modelId: m.id,
    })),
  }));

  return [
    ...closed,
    {
      id: "open_source",
      label: "Open source",
      items: openSourceItems.map((m) => ({
        value: `open_source:${m.id}`,
        label: m.label,
        hint: m.hint,
        kind: /** @type {'open_source'} */ ("open_source"),
        modelId: m.id,
      })),
    },
  ];
}

export function modelEngineFromDraft(draft = {}) {
  return draft.baseKind === "open_source" ? MODEL_ENGINE_OPEN : MODEL_ENGINE_CLOSED;
}

export function selectedModelIdForDraft(draft = {}) {
  return draft.baseKind === "open_source" ? draft.openSourceModelId : draft.standardModelId;
}

/** Current `<Select>` value for the unified model engine dropdown. */
export function modelEngineSelectValue(
  draft = {},
  sections = buildModelEngineSelectSections(),
) {
  const modelId = selectedModelIdForDraft(draft);
  if (!modelId) return undefined;

  if (draft.baseKind === "open_source") {
    return `open_source:${modelId}`;
  }

  for (const section of sections) {
    for (const item of section.items) {
      if (item.kind === "standard" && item.modelId === modelId) {
        return item.value;
      }
    }
  }

  return `standard:frontier:${modelId}`;
}

/** Resolve display label for the trigger when the value is set. */
export function modelEngineSelectLabel(
  draft = {},
  sections = buildModelEngineSelectSections(),
) {
  const value = modelEngineSelectValue(draft, sections);
  if (!value) return null;
  for (const section of sections) {
    for (const item of section.items) {
      if (item.value === value) return item.label;
    }
  }
  const modelId = selectedModelIdForDraft(draft);
  return modelId || null;
}

/** Parse dropdown value → draft patch for base model. */
export function patchFromModelEngineSelect(value, draft = {}) {
  if (!value || typeof value !== "string") return {};
  const parts = value.split(":");

  if (parts[0] === "open_source") {
    const modelId = parts.slice(1).join(":");
    if (!modelId) return {};
    return {
      baseKind: "open_source",
      openSourceModelId: modelId,
      trainingMode: draft.trainingMode === "lora" ? "lora" : draft.trainingMode || "prompt_only",
    };
  }

  if (parts[0] === "standard") {
    const modelId = parts.length >= 3 ? parts.slice(2).join(":") : parts.slice(1).join(":");
    if (!modelId) return {};
    return {
      baseKind: "standard",
      standardModelId: modelId,
      trainingMode: "prompt_only",
    };
  }

  return {};
}

export function patchModelEngine(draft, engine) {
  if (engine === MODEL_ENGINE_OPEN) {
    return patchFromModelEngineSelect(
    `open_source:${draft.openSourceModelId || OPEN_SOURCE_MODEL_OPTIONS[0]?.id || "qwen3-8b-lora"}`,
    draft,
  );
  }
  const closedId =
    draft.standardModelId &&
    CLOSED_LLM_MODEL_SECTIONS.some((s) => s.items.some((i) => i.id === draft.standardModelId))
      ? draft.standardModelId
      : DEFAULT_CLOSED_LLM_MODEL_ID;
  return patchFromModelEngineSelect(`standard:fast:${closedId}`, draft);
}
