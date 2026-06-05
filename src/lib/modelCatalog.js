// Canonical AI model catalog used by every model picker in the product.
// All `<Select>` menus in the UI render the groups below verbatim — they
// never hard-code their own model lists.
//
// LYKN is one brand-aliased model; the server rewrites it to whichever
// real model is currently best for everyday chat (see `LYKN_ROUTED_MODELS`
// in `server.js`). Pro plan ($25/mo) also gets direct access to frontier
// flagships from each major provider — those pass through verbatim.

// LYKN-branded model id the UI sends to the server.
export const LYKN_ID = "lykn";

// Top frontier models — one flagship per major provider, gated to the
// Pro ($25/mo) plan via `modelTiers.js`. These ids are sent to the
// server verbatim and hit the provider API exactly as written.
export const FRONTIER_OPENAI_ID = "gpt-5.5";
export const FRONTIER_ANTHROPIC_ID = "claude-sonnet-4-6";
export const FRONTIER_GOOGLE_ID = "gemini-3.1-pro-preview";
export const FRONTIER_XAI_ID = "grok-4.3";

// Documented for reference; the runtime mapping lives in `server.js`.
export const LYKN_ROUTED_MODELS = {
  [LYKN_ID]: "gpt-4.1-nano",
};

// Retired tier ids — still accepted from localStorage / DB and canonicalized
// to `lykn` in `modelTiers.js`. Server routing keeps them on the same backend.
export const LEGACY_LYKN_LITE_ID = "lykn-lite";
export const LEGACY_LYKN_FAST_ID = "lykn-fast";
export const LEGACY_LYKN_DEEP_ID = "lykn-deep";

/**
 * @typedef {Object} ModelOption
 * @property {string} value  Model id sent to the server.
 * @property {string} label  Display name shown in the picker.
 * @property {string} hint   Short trailing description (e.g. "Free tier").
 */

/**
 * @typedef {Object} ModelGroup
 * @property {string} id     Stable id (used as React key + analytics tag).
 * @property {string} label  Section header in the dropdown.
 * @property {ModelOption[]} items
 */

/** @type {ModelGroup[]} */
export const MODEL_GROUPS = [
  {
    id: "lykn",
    label: "",
    items: [{ value: LYKN_ID, label: "LYKN", hint: "" }],
  },
  {
    id: "frontier",
    label: "Top frontier models",
    items: [
      { value: FRONTIER_OPENAI_ID, label: "GPT-5.5", hint: "OpenAI" },
      { value: FRONTIER_ANTHROPIC_ID, label: "Claude Sonnet 4.6", hint: "Anthropic" },
      { value: FRONTIER_GOOGLE_ID, label: "Gemini 3.1 Pro", hint: "Google" },
      { value: FRONTIER_XAI_ID, label: "Grok 4.3", hint: "xAI" },
    ],
  },
];

export const KNOWN_MODEL_IDS = MODEL_GROUPS.flatMap((g) =>
  g.items.map((i) => i.value)
);

/** Frontier id also used by server routing (e.g. Anthropic Opus). */
export const CLAUDE_OPUS_4_8_ID = "claude-opus-4-8";

/**
 * Closed / hosted LLM sections for Model Builder (base_kind: standard).
 * @type {{ id: string, label: string, items: { id: string, label: string, hint: string }[] }[]}
 */
export const CLOSED_LLM_MODEL_SECTIONS = [
  {
    id: "frontier",
    label: "Top frontier models",
    items: [
      { id: FRONTIER_OPENAI_ID, label: "GPT-5.5", hint: "OpenAI" },
      { id: FRONTIER_ANTHROPIC_ID, label: "Claude Sonnet 4.6", hint: "Anthropic" },
      { id: FRONTIER_GOOGLE_ID, label: "Gemini 3.1 Pro", hint: "Google" },
      { id: FRONTIER_XAI_ID, label: "Grok 4.3", hint: "xAI" },
    ],
  },
  {
    id: "fast",
    label: "Fast models",
    items: [
      { id: LYKN_ID, label: "LYKN", hint: "Everyday routed model" },
      { id: "gpt-4.1-nano", label: "GPT-4.1 Nano", hint: "OpenAI — low latency" },
      { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", hint: "Google — fast reasoning" },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", hint: "Google — lightweight" },
    ],
  },
  {
    id: "deep",
    label: "Deep thinking",
    items: [
      { id: CLAUDE_OPUS_4_8_ID, label: "Claude Opus 4.8", hint: "Anthropic — deepest reasoning" },
      { id: FRONTIER_OPENAI_ID, label: "GPT-5.5", hint: "OpenAI — flagship" },
      { id: "deepseek-r1", label: "DeepSeek R1", hint: "Reasoning-focused" },
      { id: FRONTIER_GOOGLE_ID, label: "Gemini 3.1 Pro", hint: "Google — long context" },
    ],
  },
];

export const ALL_CLOSED_LLM_MODEL_IDS = CLOSED_LLM_MODEL_SECTIONS.flatMap((s) =>
  s.items.map((i) => i.id),
);

export const DEFAULT_CLOSED_LLM_MODEL_ID = LYKN_ID;
