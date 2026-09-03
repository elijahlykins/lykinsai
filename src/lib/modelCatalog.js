// Canonical AI model catalog used by every model picker in the product.
// All `<Select>` menus in the UI render the groups below verbatim — they
// never hard-code their own model lists.
//
// LYKN is one brand-aliased Auto model. The server routes each turn to
// Luna / Terra / Sol (see `server/ai/chatRouting`) based on complexity.
// Explicit picks pass through verbatim to the provider API.
//
// Current as of August 29, 2026. Chat/reasoning IDs only — image, audio,
// realtime, embeddings, and ChatGPT-only aliases stay out of the picker.

export const LYKN_ID = "lykn";
export const MY_SETUP_ID = "lykn-setup";

// One flagship per lab in the Top group.
export const FRONTIER_OPENAI_ID = "gpt-5.6-sol";
export const FRONTIER_ANTHROPIC_ID = "claude-fable-5";
export const FRONTIER_GOOGLE_ID = "gemini-3.1-pro-preview";
export const FRONTIER_XAI_ID = "grok-4.6";

export const CLAUDE_OPUS_5_ID = "claude-opus-5";
export const CLAUDE_SONNET_5_ID = "claude-sonnet-5";
export const CLAUDE_OPUS_4_8_ID = "claude-opus-4-8";
export const CLAUDE_HAIKU_4_5_ID = "claude-haiku-4-5";

// Retired picker ids that should migrate to a current id. Still-served
// models (gpt-5.5, grok-4.5, grok-4.3, Claude Sonnet 4.6) stay themselves.
export const LEGACY_FRONTIER_ALIASES = {};

export const LYKN_ROUTED_MODELS = {
  [LYKN_ID]: "gpt-5.6-terra",
};

export const LEGACY_LYKN_LITE_ID = "lykn-lite";
export const LEGACY_LYKN_FAST_ID = "lykn-fast";
export const LEGACY_LYKN_DEEP_ID = "lykn-deep";

/**
 * @typedef {Object} ModelOption
 * @property {string} value  Model id sent to the server.
 * @property {string} label  Display name shown in the picker.
 * @property {string} hint   Short trailing description.
 */

/**
 * @typedef {Object} ModelGroup
 * @property {string} id
 * @property {string} label
 * @property {ModelOption[]} items
 */

/** @type {ModelGroup[]} */
export const MODEL_GROUPS = [
  {
    id: "lykn",
    label: "",
    items: [
      { value: LYKN_ID, label: "LYKN", hint: "" },
      { value: MY_SETUP_ID, label: "My Setup", hint: "Your routing" },
    ],
  },
  {
    id: "frontier",
    label: "Top models",
    items: [
      { value: FRONTIER_OPENAI_ID, label: "GPT-5.6 Sol", hint: "OpenAI" },
      { value: FRONTIER_ANTHROPIC_ID, label: "Claude Fable 5", hint: "Anthropic" },
      { value: FRONTIER_GOOGLE_ID, label: "Gemini 3.1 Pro", hint: "Google" },
      { value: FRONTIER_XAI_ID, label: "Grok 4.6", hint: "xAI" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    items: [
      { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", hint: "Balanced" },
      { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "Fast" },
      { value: "gpt-5.5", label: "GPT-5.5", hint: "" },
      { value: "gpt-5.5-pro", label: "GPT-5.5 Pro", hint: "" },
      { value: "gpt-5.4", label: "GPT-5.4", hint: "" },
      { value: "gpt-5.4-pro", label: "GPT-5.4 Pro", hint: "" },
      { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: "" },
      { value: "gpt-5.4-nano", label: "GPT-5.4 Nano", hint: "" },
      { value: "gpt-5.2", label: "GPT-5.2", hint: "" },
      { value: "gpt-5.2-pro", label: "GPT-5.2 Pro", hint: "" },
      { value: "gpt-5.1", label: "GPT-5.1", hint: "" },
      { value: "gpt-5", label: "GPT-5", hint: "" },
      { value: "gpt-5-pro", label: "GPT-5 Pro", hint: "" },
      { value: "gpt-5-mini", label: "GPT-5 Mini", hint: "" },
      { value: "gpt-5-nano", label: "GPT-5 Nano", hint: "" },
      { value: "gpt-4.1", label: "GPT-4.1", hint: "" },
      { value: "gpt-4.1-mini", label: "GPT-4.1 Mini", hint: "" },
      { value: "gpt-4.1-nano", label: "GPT-4.1 Nano", hint: "" },
      { value: "gpt-4o", label: "GPT-4o", hint: "" },
      { value: "gpt-4o-mini", label: "GPT-4o Mini", hint: "" },
      { value: "o3", label: "o3", hint: "Reasoning" },
      { value: "o3-pro", label: "o3 Pro", hint: "Reasoning" },
      { value: "o4-mini", label: "o4-mini", hint: "Reasoning" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    items: [
      { value: CLAUDE_OPUS_5_ID, label: "Claude Opus 5", hint: "Flagship" },
      { value: CLAUDE_SONNET_5_ID, label: "Claude Sonnet 5", hint: "Everyday" },
      { value: CLAUDE_OPUS_4_8_ID, label: "Claude Opus 4.8", hint: "" },
      { value: "claude-opus-4-7", label: "Claude Opus 4.7", hint: "" },
      { value: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "" },
      { value: "claude-opus-4-5", label: "Claude Opus 4.5", hint: "" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "" },
      { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", hint: "" },
      { value: CLAUDE_HAIKU_4_5_ID, label: "Claude Haiku 4.5", hint: "Fast" },
    ],
  },
  {
    id: "google",
    label: "Google",
    items: [
      { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash", hint: "Workhorse" },
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "" },
      { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", hint: "Fast" },
      { value: "gemini-3-flash-preview", label: "Gemini 3 Flash", hint: "" },
      { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", hint: "" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "" },
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "" },
      { value: "gemini-pro-latest", label: "Gemini Pro", hint: "Latest" },
      { value: "gemini-flash-latest", label: "Gemini Flash", hint: "Latest" },
    ],
  },
  {
    id: "xai",
    label: "xAI",
    items: [
      { value: "grok-4.5", label: "Grok 4.5", hint: "" },
      { value: "grok-4.3", label: "Grok 4.3", hint: "" },
      { value: "grok-build-0.1", label: "Grok Build", hint: "Coding" },
    ],
  },
];

export const KNOWN_MODEL_IDS = [...new Set(
  MODEL_GROUPS.flatMap((g) => g.items.map((i) => i.value)),
)];

/**
 * Closed / hosted LLM sections for Model Builder (base_kind: standard).
 * @type {{ id: string, label: string, items: { id: string, label: string, hint: string }[] }[]}
 */
export const CLOSED_LLM_MODEL_SECTIONS = [
  {
    id: "frontier",
    label: "Top models",
    items: [
      { id: FRONTIER_OPENAI_ID, label: "GPT-5.6 Sol", hint: "OpenAI" },
      { id: FRONTIER_ANTHROPIC_ID, label: "Claude Fable 5", hint: "Anthropic" },
      { id: FRONTIER_GOOGLE_ID, label: "Gemini 3.1 Pro", hint: "Google" },
      { id: FRONTIER_XAI_ID, label: "Grok 4.6", hint: "xAI" },
    ],
  },
  {
    id: "fast",
    label: "Fast models",
    items: [
      { id: LYKN_ID, label: "LYKN", hint: "Everyday routed model" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "OpenAI, low latency" },
      { id: "gpt-4.1-nano", label: "GPT-4.1 Nano", hint: "OpenAI, low latency" },
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", hint: "Google, fast" },
      { id: CLAUDE_HAIKU_4_5_ID, label: "Claude Haiku 4.5", hint: "Anthropic, fast" },
    ],
  },
  {
    id: "deep",
    label: "Deep thinking",
    items: [
      { id: FRONTIER_ANTHROPIC_ID, label: "Claude Fable 5", hint: "Anthropic, highest" },
      { id: CLAUDE_OPUS_5_ID, label: "Claude Opus 5", hint: "Anthropic, everyday flagship" },
      { id: FRONTIER_OPENAI_ID, label: "GPT-5.6 Sol", hint: "OpenAI, flagship" },
      { id: FRONTIER_GOOGLE_ID, label: "Gemini 3.1 Pro", hint: "Google, long context" },
      { id: FRONTIER_XAI_ID, label: "Grok 4.6", hint: "xAI, agents" },
    ],
  },
];

export const ALL_CLOSED_LLM_MODEL_IDS = CLOSED_LLM_MODEL_SECTIONS.flatMap((s) =>
  s.items.map((i) => i.id),
);

export const DEFAULT_CLOSED_LLM_MODEL_ID = LYKN_ID;
