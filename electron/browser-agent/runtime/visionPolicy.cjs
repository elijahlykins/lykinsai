/**
 * When the agent needs to see pixels.
 *
 * The structured snapshot is the cheap, precise way to understand a page, and
 * for most of the web it is enough. It is not enough for apps that draw
 * themselves: a design tool's page is one big canvas, and its DOM says almost
 * nothing about what is on screen. Waiting for semantic targeting to fail twice
 * before attaching a screenshot means spending most of the round budget blind
 * on exactly the pages where the budget matters most.
 *
 * So vision is offered up front when the page looks drawn rather than marked
 * up, and stays off for ordinary pages where it would only add latency and
 * cost.
 */

/** Products whose working surface is rendered, not described in the DOM. */
const VISUAL_EDITOR_URL_RE =
  /(canva\.com\/design|figma\.com\/(file|design|proto|board|slides)|docs\.google\.com\/(document|spreadsheets|presentation)|miro\.com\/app\/board|figjam|excalidraw\.com|lucid(chart|spark)\.com|framer\.com\/project|sketch\.com\/s|photopea\.com|pixlr\.com|spline\.design|tldraw|whimsical\.com|penpot\.app)/i;

/** Builders whose editing surface is real DOM, but nested and drag-driven. */
const VISUAL_BUILDER_URL_RE =
  /(mailchimp\.com\/(campaigns|email|templates)|klaviyo\.com|hubspot\.com\/(email|content)|beefree\.io|stripo\.email|unbounce\.com|webflow\.com\/design|squarespace\.com\/config|wix\.com\/editor|wordpress\.com\/(post|page|site-editor)|elementor|shopify\.com\/admin\/themes)/i;

/** Elements that only exist as pixels — a canvas has no readable interior. */
function countDrawnSurfaces(snapshot) {
  let drawn = 0;
  for (const el of snapshot?.elements || []) {
    const tag = String(el?.raw?.tag || "").toLowerCase();
    if (tag === "canvas" || tag === "svg") drawn += 1;
  }
  return drawn;
}

/** Controls the agent could actually name and target from the snapshot alone. */
function countNamedControls(snapshot) {
  let named = 0;
  for (const el of snapshot?.elements || []) {
    const label = String(el?.label || "").trim();
    if (!label || label === "image") continue;
    if (["button", "link", "textbox", "combobox", "searchbox", "checkbox", "radio", "tab", "menuitem"].includes(
        String(el.role || ""),
      )) {
      named += 1;
    }
  }
  return named;
}

/**
 * Whether to attach a screenshot to this round's decision.
 *
 * @param {object} args
 * @param {object} args.snapshot current page snapshot
 * @param {boolean} [args.forced] recovery escalated to visual inspection
 * @param {number} [args.roundsSinceShot] rounds since the last screenshot
 * @returns {{ see: boolean, reason: string, everyRound: boolean }}
 */
function shouldSeePixels({ snapshot, forced = false, roundsSinceShot = Infinity, always = false } = {}) {
  // When targets are located visually rather than by element reference, the
  // screenshot is not a supplement to the element list — it IS the working
  // view, and there is no round in which the agent can do without it. Default
  // false, so every heuristic below is untouched in production.
  if (always) {
    return {
      see: true,
      reason: "this run locates targets visually — the screenshot is the working view",
      everyRound: true,
    };
  }
  if (forced) {
    return { see: true, reason: "recovery escalated to visual inspection", everyRound: false };
  }
  const url = String(snapshot?.url || "");
  if (VISUAL_EDITOR_URL_RE.test(url)) {
    return {
      see: true,
      reason: "this is a visual editor — its working surface is drawn, so the element list cannot describe it",
      everyRound: true,
    };
  }
  const drawn = countDrawnSurfaces(snapshot);
  const named = countNamedControls(snapshot);
  if (VISUAL_BUILDER_URL_RE.test(url)) {
    // Builders do expose DOM, so pixels are a supplement rather than the only
    // source — refresh every few rounds instead of every one.
    return {
      see: roundsSinceShot >= 2,
      reason: "this is a drag-driven builder — the layout matters as much as the element list",
      everyRound: false,
    };
  }
  // A page that draws itself and offers almost nothing to target by name.
  if (drawn > 0 && named < 8) {
    return {
      see: true,
      reason: "the page renders its content (canvas/SVG) and exposes few named controls",
      everyRound: true,
    };
  }
  // Almost nothing in the catalog at all: either a custom widget set the
  // collector cannot name, or a page mid-render. Either way, look.
  if (named <= 2 && (snapshot?.elements?.length || 0) < 8) {
    return {
      see: roundsSinceShot >= 2,
      reason: "the element list is nearly empty — the interface may be drawn or built from unnamed custom elements",
      everyRound: false,
    };
  }
  return { see: false, reason: "", everyRound: false };
}

module.exports = {
  shouldSeePixels,
  countDrawnSurfaces,
  countNamedControls,
  VISUAL_EDITOR_URL_RE,
  VISUAL_BUILDER_URL_RE,
};
