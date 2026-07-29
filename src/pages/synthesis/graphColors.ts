/**
 * Theme-aware node colors for the synthesis graph.
 *
 * Dark mode keeps the vivid neon palette baked into each node's `color`
 * at build time. Light mode uses a separate, softer set of hues that
 * read on a pale paper background — no purple / indigo / violet.
 */

export type GraphColorKind =
  | "root"
  | "category"
  | "chat"
  | "vault"
  | "tag"
  | "neuron"
  | "belief"
  | "concept"
  | "perspective"
  | "project"
  | string;

/**
 * Light-mode swatches — medium, sunny tones (not ink-dark, not purple).
 * Sky / teal / amber / rose / coral so the graph feels airy on paper.
 */
export const LIGHT_PALETTE = {
  root: "#0ea5e9", // sky
  chats: "#0284c7", // sky-600
  chat: "#38bdf8", // sky-400
  vault: "#0d9488", // teal-600
  note: "#2dd4bf", // teal-400
  belief: "#f59e0b", // amber — replaces white/purple “stars”
  facts: "#f43f5e", // rose
  neuron: "#fb7185", // rose-400
  concepts: "#ea580c", // orange
  concept: "#fb923c", // orange-400
  projects: "#14b8a6", // teal
  project: "#5eead4", // teal-300
  perspective: "#fbbf24", // amber-400
  tag: "#eab308", // yellow
} as const;

/** Dark-mode legend swatches (match buildGraph palette). */
export const DARK_PALETTE = {
  chats: "#3b82f6",
  vault: "#10b981",
  belief: "#ffffff",
  facts: "#ec4899",
  concepts: "#f97316",
} as const;

function isNearWhiteHex(color: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return r > 220 && g > 220 && b > 220;
}

/**
 * Resolve the fill color for a graph node. In dark mode returns the
 * baked `color`. In light mode maps by kind to the soft paper palette.
 */
export function resolveGraphNodeColor(
  kind: GraphColorKind,
  color: string,
  isLight: boolean,
  /** Category node id (e.g. `__cat_belief__`) or parent categoryId. */
  categoryKey?: string | null,
): string {
  if (!isLight) return color;

  switch (kind) {
    case "root":
      return LIGHT_PALETTE.root;
    case "chat":
      return LIGHT_PALETTE.chat;
    case "vault":
      return LIGHT_PALETTE.note;
    case "tag":
      return LIGHT_PALETTE.tag;
    case "neuron":
      return LIGHT_PALETTE.neuron;
    case "belief":
      return LIGHT_PALETTE.belief;
    case "concept":
      return LIGHT_PALETTE.concept;
    case "perspective":
      return LIGHT_PALETTE.perspective;
    case "project":
      return LIGHT_PALETTE.project;
    case "category": {
      const key = categoryKey || "";
      if (key === "__cat_chats__" || color === DARK_PALETTE.chats) {
        return LIGHT_PALETTE.chats;
      }
      if (key === "__cat_vault__" || color === DARK_PALETTE.vault) {
        return LIGHT_PALETTE.vault;
      }
      if (
        key === "__cat_belief__" ||
        color === DARK_PALETTE.belief ||
        isNearWhiteHex(color)
      ) {
        return LIGHT_PALETTE.belief;
      }
      if (key === "__cat_facts__" || color === DARK_PALETTE.facts) {
        return LIGHT_PALETTE.facts;
      }
      if (key === "__cat_concepts__" || color === DARK_PALETTE.concepts) {
        return LIGHT_PALETTE.concepts;
      }
      if (key === "__cat_projects__") {
        return LIGHT_PALETTE.projects;
      }
      return isNearWhiteHex(color) ? LIGHT_PALETTE.belief : color;
    }
    default:
      return isNearWhiteHex(color) ? LIGHT_PALETTE.belief : color;
  }
}

export function legendSwatch(
  key: keyof typeof DARK_PALETTE,
  isLight: boolean,
): string {
  if (isLight) {
    const map: Record<keyof typeof DARK_PALETTE, string> = {
      chats: LIGHT_PALETTE.chats,
      vault: LIGHT_PALETTE.vault,
      belief: LIGHT_PALETTE.belief,
      facts: LIGHT_PALETTE.facts,
      concepts: LIGHT_PALETTE.concepts,
    };
    return map[key];
  }
  return DARK_PALETTE[key];
}
