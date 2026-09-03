"use strict";

/**
 * Bounds for the live page view while a chrome dropdown (Sync, omnibox) is
 * open. The menu paints in the chrome document and overflows the 40px toolbar
 * into the page area. If the page view still occupies that rect, clicks miss
 * the menu even when chrome is raised.
 */
function dockedPageBoundsForOverlay({ overlay, x, y, chromeH, width, pageH }) {
  const left = Math.round(Number(x) || 0);
  const top = Math.round(Number(y) || 0) + Math.max(0, Math.round(Number(chromeH) || 0));
  if (overlay) {
    return { x: left, y: top, width: 0, height: 0 };
  }
  return {
    x: left,
    y: top,
    width: Math.max(0, Math.round(Number(width) || 0)),
    height: Math.max(0, Math.round(Number(pageH) || 0)),
  };
}

module.exports = { dockedPageBoundsForOverlay };
