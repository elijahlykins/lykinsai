// Canonical AI model catalog used by every model picker in the product.
// All `<Select>` menus in the UI render the groups below verbatim — they
// never hard-code their own model lists.
//
// LYKN runs exclusively on Google Gemini under the hood. The product
// surfaces three brand-aliased tiers (Lite / Fast Reasoning / Deep
// Thinking) and the server rewrites them to a real Gemini model before
// hitting the SDK. This indirection lets us swap the underlying Gemini
// version without a client release. See `resolveLyknAlias` and
// `LYKN_ROUTED_MODELS` in `server.js` for the routing table.

// LYKN-branded model ids the UI sends to the server. The server is the
// single source of truth for the actual Gemini model each one resolves
// to (kept in `LYKN_ROUTED_MODELS` in `server.js`).
export const LYKN_LITE_ID = "lykn-lite";
export const LYKN_FAST_ID = "lykn-fast";
export const LYKN_DEEP_ID = "lykn-deep";

// Documented for reference; the runtime mapping lives in `server.js` so
// the client can't be tricked into bypassing routing.
// NOTE: Google's Gemini 3.1 series does NOT include a standard non-lite
// text-generation Flash model — only `gemini-3.1-flash-lite-preview` for
// text plus the audio/TTS/image-gen specializations. So the middle Fast
// Reasoning tier stays on `gemini-3-flash-preview` (Gemini 3 Flash from
// the previous gen). This will be updated when Google ships a real 3.1
// non-lite Flash. Server is the source of truth — see `LYKN_ROUTED_MODELS`
// in server.js.
export const LYKN_ROUTED_MODELS = {
  [LYKN_LITE_ID]: "gemini-3.1-flash-lite-preview",
  [LYKN_FAST_ID]: "gemini-3-flash-preview",
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
// Single group, three tiers, ordered best → worst so the most capable
// model sits at the top of the picker. Deep Thinking is the heavyweight
// for multi-step problems, Fast Reasoning is the everyday workhorse,
// and Lite is the free-plan default. Group label is intentionally
// empty — the picker skips the heading when it's blank, which keeps
// the dropdown clean now that there's only one group.
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
];

// Flat list of every model id the picker can produce. Used for "is this
// id known?" checks (e.g. migrating stale localStorage values); never
// relied on for routing — the server has its own catalog.
export const KNOWN_MODEL_IDS = MODEL_GROUPS.flatMap((g) =>
  g.items.map((i) => i.value)
);
