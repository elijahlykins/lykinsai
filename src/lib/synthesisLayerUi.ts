/**
 * Soft-unplug the Synthesis Layer graph from the product UI.
 * Data + APIs stay; nav / deep links / the route are hidden or redirected
 * until we ship a clearer Memory surface (or bring the graph back).
 */
export const SYNTHESIS_LAYER_UI_ENABLED = false;

export const SYNTHESIS_LAYER_PATH = "/synthesis-layer";

/** Where to send users instead of the graph while it's unplugged. */
export const SYNTHESIS_LAYER_FALLBACK_PATH = "/app";

/** Build a synthesis URL, or the fallback when the UI is unplugged. */
export function synthesisLayerHref(query?: string): string {
  if (!SYNTHESIS_LAYER_UI_ENABLED) return SYNTHESIS_LAYER_FALLBACK_PATH;
  if (!query) return SYNTHESIS_LAYER_PATH;
  const q = query.startsWith("?") ? query : `?${query}`;
  return `${SYNTHESIS_LAYER_PATH}${q}`;
}
