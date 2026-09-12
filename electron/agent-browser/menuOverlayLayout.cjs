"use strict";

/**
 * Bounds for the live page view while a chrome dropdown (Sync, omnibox) is
 * open. Chrome-style: the page KEEPS its rect so it stays visible while the
 * user types — the chrome view is raised above it (transparent outside the
 * bars/menu), so the dropdown paints over the page. Clicks in the page area
 * land on the chrome document, which closes the dropdown and restores normal
 * layering — the same one-click dismiss Chrome has.
 */
function dockedPageBoundsForOverlay({ overlay: _overlay, x, y, chromeH, width, pageH }) {
  const left = Math.round(Number(x) || 0);
  const top = Math.round(Number(y) || 0) + Math.max(0, Math.round(Number(chromeH) || 0));
  return {
    x: left,
    y: top,
    width: Math.max(0, Math.round(Number(width) || 0)),
    height: Math.max(0, Math.round(Number(pageH) || 0)),
  };
}

module.exports = { dockedPageBoundsForOverlay };
