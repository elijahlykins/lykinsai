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

// Agent Studio (/agents) — coding-tier frontier models (no LYKN alias).
export const CLAUDE_OPUS_4_8_ID = "claude-opus-4-8";

/** @type {ModelGroup[]} */
export const AGENT_BUILDER_MODEL_GROUPS = [
  {
    id: "coding",
    label: "Coding models",
    items: [
      { value: CLAUDE_OPUS_4_8_ID, label: "Claude Opus 4.8", hint: "Anthropic" },
      { value: FRONTIER_ANTHROPIC_ID, label: "Claude Sonnet 4.6", hint: "Anthropic" },
      { value: FRONTIER_OPENAI_ID, label: "GPT-5.5", hint: "OpenAI" },
      { value: FRONTIER_GOOGLE_ID, label: "Gemini 3.1 Pro", hint: "Google" },
      { value: FRONTIER_XAI_ID, label: "Grok 4.3", hint: "xAI" },
    ],
  },
];

export const AGENT_BUILDER_MODEL_IDS = AGENT_BUILDER_MODEL_GROUPS.flatMap((g) =>
  g.items.map((i) => i.value),
);

export const AGENT_BUILDER_DEFAULT_MODEL = CLAUDE_OPUS_4_8_ID;
