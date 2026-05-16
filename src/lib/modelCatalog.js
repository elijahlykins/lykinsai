// Canonical AI model catalog used by every model picker in the product.
// All `<Select>` menus in the UI render the groups below verbatim — they
// never hard-code their own model lists.
//
// LYKN's main lineup is three brand-aliased tiers (Lite / Fast Reasoning
// / Deep Thinking). The server rewrites them to whichever real model is
// currently best for that role, which lets us swap underlyings without
// a client release. See `resolveLyknAlias` and `LYKN_ROUTED_MODELS` in
// `server.js` for the runtime routing table.
//
// Max plan ($65/mo) ALSO gets direct access to the four current frontier
// models from each major provider (OpenAI / Anthropic / Google / xAI).
// Those are passed through verbatim — no alias rewriting — so the user
// is paying for the real top-tier model from the vendor of their choice.

// LYKN-branded model ids the UI sends to the server. The server is the
// single source of truth for the actual model each one resolves to
// (kept in `LYKN_ROUTED_MODELS` in `server.js`).
export const LYKN_LITE_ID = "lykn-lite";
export const LYKN_FAST_ID = "lykn-fast";
export const LYKN_DEEP_ID = "lykn-deep";

// Top frontier models — one flagship per major provider, gated to the
// Max ($65/mo) plan via `modelTiers.js`. These ids are sent to the
// server verbatim and hit the provider API exactly as written.
//
// Verified against each provider's API docs on 2026-05-16:
//   OpenAI:    gpt-5.5 (released 2026-04-23, current flagship; gpt-5.5-pro
//              also exists for premium reasoning at $15/$120 per 1M).
//   Anthropic: claude-sonnet-4-6 (current Sonnet — Sonnet 4.7 has NOT
//              shipped; only Opus is at 4.7). To swap to top-tier
//              reasoning instead of speed/cost balance, change to
//              claude-opus-4-7.
//   Google:    gemini-3.1-pro-preview (announced 2026-02-19, still
//              labeled preview on the Gemini API but it IS the
//              current flagship; same backend as lykn-deep).
//   xAI:       grok-4.3 (the bare grok-4 ID was retired 2026-05-15
//              and now redirects to 4.3 — we use 4.3 directly to
//              avoid the redirect hop).
//
// When providers ship a new flagship, bump the constant below — the
// server's prefix-based routing (`gpt-*`, `claude-*`, `gemini-*`,
// anything containing `grok`) picks them up automatically with no
// other code changes.
export const FRONTIER_OPENAI_ID = "gpt-5.5";
export const FRONTIER_ANTHROPIC_ID = "claude-sonnet-4-6";
export const FRONTIER_GOOGLE_ID = "gemini-3.1-pro-preview";
export const FRONTIER_XAI_ID = "grok-4.3";

// Documented for reference; the runtime mapping lives in `server.js` so
// the client can't be tricked into bypassing routing.
export const LYKN_ROUTED_MODELS = {
  [LYKN_LITE_ID]: "gemini-3.1-flash-lite-preview",
  [LYKN_FAST_ID]: "gpt-4.1-nano",
  [LYKN_DEEP_ID]: "gemini-3.1-pro-preview",
};

// Legacy alias kept so existing client storage / DB rows that still
// reference the old single-tier "lykn" id resolve sensibly. Treated as
// "Fast Reasoning" because that's the workhorse middle tier.
export const LEGACY_LYKN_ID = "lykn";

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
//
// Two groups: the LYKN brand-aliased tiers (Lite / Fast / Deep) for
// every paid plan, and the frontier models (one per provider) gated
// to the Max plan via `modelTiers.js`. Pickers render both groups in
// order; locked items show a lock badge so Pro users can see what
// they'd unlock at Max. Group labels appear as section headers in the
// dropdown, except when blank.
export const MODEL_GROUPS = [
  {
    id: "lykn",
    label: "",
    items: [
      { value: LYKN_DEEP_ID, label: "LYKN Deep Thinking", hint: "Heavy" },
      { value: LYKN_FAST_ID, label: "LYKN Fast Reasoning", hint: "Everyday" },
      { value: LYKN_LITE_ID, label: "LYKN Lite", hint: "Free tier" },
    ],
  },
  {
    id: "frontier",
    label: "Top frontier models",
    items: [
      { value: FRONTIER_OPENAI_ID,    label: "GPT-5.5",          hint: "OpenAI" },
      { value: FRONTIER_ANTHROPIC_ID, label: "Claude Sonnet 4.6", hint: "Anthropic" },
      { value: FRONTIER_GOOGLE_ID,    label: "Gemini 3.1 Pro",   hint: "Google" },
      { value: FRONTIER_XAI_ID,       label: "Grok 4.3",         hint: "xAI" },
    ],
  },
];

// Flat list of every model id the picker can produce. Used for "is this
// id known?" checks (e.g. migrating stale localStorage values); never
// relied on for routing — the server has its own catalog.
export const KNOWN_MODEL_IDS = MODEL_GROUPS.flatMap((g) =>
  g.items.map((i) => i.value)
);
