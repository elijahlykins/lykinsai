// Canonical AI model catalog used by every model picker in the product.
// All `<Select>` menus in the UI render the groups below verbatim — they
// never hard-code their own model lists. Add / rename / re-order entries
// here and every picker updates in lockstep.
//
// Scope rule: this catalog only lists models from the four supported
// providers — Anthropic (Claude), OpenAI (ChatGPT), Google (Gemini), and
// xAI (Grok) — plus the in-house "LYKN" alias. The rest of the product
// (plan gating, provider fallbacks, billing) assumes those four; don't add
// anything else without updating server-side routing.
//
// "LYKN" is a brand alias that the server rewrites to a real Google model
// before hitting any provider SDK. See `LYKN_ROUTED_MODEL` and the lykn
// alias handling in `server.js`. The id below is what the UI sends; the
// server is the single source of truth for what it actually runs.

export const LYKN_MODEL_ID = "lykn";

// Server-side: the real model invoked when a request comes in with id
// `lykn`. Surfaced here for documentation; the runtime mapping lives in
// `server.js` so the client can't be tricked into bypassing routing.
export const LYKN_ROUTED_MODEL = "gemini-3.1-pro-preview";

/**
 * @typedef {Object} ModelOption
 * @property {string} value  Model id sent to the server.
 * @property {string} label  Display name shown in the picker.
 * @property {string} hint   Short trailing description (e.g. "Anthropic flagship").
 */

/**
 * @typedef {Object} ModelGroup
 * @property {string} id     Stable id (used as React key + analytics tag).
 * @property {string} label  Section header in the dropdown.
 * @property {ModelOption[]} items
 */

/** @type {ModelGroup[]} */
//
// Two groups only: the headline "Top Models" (paid flagships + LYKN) and
// a "Free Tier" row that pairs each provider with their Haiku-equivalent
// fast model. Keep the per-provider parallelism (one top + one fast per
// company) — it's what makes the picker scannable. If you add a model,
// pick the *newest* fast variant for that provider so basic-tier users
// always get the freshest one we've green-lit.
//
// Every value in the "fast" group must also live in
// `BASIC_MODEL_IDS` (src/lib/modelTiers.js) so free-plan users aren't
// silently downgraded the moment they pick one.
export const MODEL_GROUPS = [
  {
    id: "top",
    label: "Top Models",
    items: [
      { value: LYKN_MODEL_ID, label: "LYKN", hint: "" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "Anthropic flagship" },
      { value: "gpt-5.4", label: "GPT-5.4", hint: "OpenAI flagship" },
      { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", hint: "Google flagship" },
      { value: "grok-4-1-fast-reasoning", label: "Grok 4.1 Fast Reasoning", hint: "xAI flagship" },
    ],
  },
  {
    id: "fast",
    label: "Free Tier",
    items: [
      { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", hint: "Fast Anthropic" },
      { value: "gpt-5-mini", label: "GPT-5 Mini", hint: "Fast OpenAI" },
      { value: "gemini-3-flash-preview", label: "Gemini 3 Flash", hint: "Fast Google" },
      { value: "grok-4-1-fast-non-reasoning", label: "Grok 4.1 Fast Non-Reasoning", hint: "Fast xAI" },
    ],
  },
];

// Flat list of every model id the picker can produce. Useful for "is this
// id known?" checks; never relied on for routing — the server has its own
// catalog.
export const KNOWN_MODEL_IDS = MODEL_GROUPS.flatMap((g) =>
  g.items.map((i) => i.value)
);
