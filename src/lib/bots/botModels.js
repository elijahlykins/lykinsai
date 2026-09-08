// The model a Bot runs on.
//
// A Bot's `modelPolicy` has always supported three shapes — `lykn` (LYKN's
// own routing), `my_setup` (the user's My Setup assignments), and `model` (a
// specific pinned model) — and the server has always honoured all three. The
// Bots page only ever offered the first two, so the third was unreachable.
//
// Default stays `lykn`: a bot that has never been touched routes exactly as
// it does today. Only an explicit pick changes anything.

import { MODEL_GROUPS, LYKN_ID, MY_SETUP_ID } from "@/lib/modelCatalog";
import { isModelAllowedForPlan } from "@/lib/modelTiers";

/** Select values for the two routing modes, which are not model ids. */
export const BOT_MODE_LYKN = LYKN_ID;
export const BOT_MODE_MY_SETUP = MY_SETUP_ID;

/**
 * Groups for the picker: the two routing modes first, then the catalog
 * verbatim. The catalog's own "lykn" group is dropped — its two entries are
 * the routing modes, already shown above.
 */
export const BOT_MODEL_GROUPS = [
  {
    id: "modes",
    label: "",
    items: [
      { value: BOT_MODE_LYKN, label: "LYKN (default)" },
      { value: BOT_MODE_MY_SETUP, label: "My Setup" },
    ],
  },
  ...MODEL_GROUPS.filter((g) => g.id !== "lykn").map((g) => ({
    id: g.id,
    label: g.label || "Models",
    items: g.items.map((i) => ({ value: i.value, label: i.label })),
  })),
];

/** Routing modes are always available; a pinned model follows the plan gate. */
export function isBotModelAllowed(value, modelTier) {
  const id = String(value || "").trim();
  if (!id || id === BOT_MODE_LYKN || id === BOT_MODE_MY_SETUP) return true;
  return isModelAllowedForPlan(id, modelTier);
}

/** The `<select>` value for a bot's stored policy. */
export function botModelSelectValue(policy) {
  const mode = String(policy?.mode || "lykn");
  if (mode === "my_setup") return BOT_MODE_MY_SETUP;
  if (mode === "model" && policy?.modelId) return String(policy.modelId);
  return BOT_MODE_LYKN;
}

/** The policy to store for a picked value. */
export function botModelPolicyFor(value) {
  const id = String(value || "").trim();
  if (id === BOT_MODE_MY_SETUP) return { mode: "my_setup", modelId: null };
  if (!id || id === BOT_MODE_LYKN) return { mode: "lykn", modelId: null };
  return { mode: "model", modelId: id };
}

/** Display name for a pinned model id, from the canonical catalog. */
export function botModelLabel(modelId) {
  const id = String(modelId || "").trim();
  for (const group of MODEL_GROUPS) {
    for (const item of group.items) if (item.value === id) return item.label;
  }
  return id;
}

/** One line under the picker saying what the current choice actually does. */
export function botModelHint(policy) {
  const mode = String(policy?.mode || "lykn");
  if (mode === "my_setup") {
    return "Follows your My Setup assignments — a different model per kind of work.";
  }
  if (mode === "model" && policy?.modelId) {
    return `Every turn this bot takes runs on ${botModelLabel(policy.modelId)}.`;
  }
  return "LYKN picks per turn. Leave this unless you want one specific model.";
}
