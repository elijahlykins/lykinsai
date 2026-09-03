"use strict";

/** Uniform radius for docked WebContentsViews.
 *  Electron 42's `setBorderRadius` takes a single integer. Passing a
 *  per-corner object is coerced to 0 with no throw, which squares the
 *  native page against the rounded window. Always clip with the matching
 *  container curve. */

function roundPx(n) {
  return Math.max(0, Math.round(Number(n) || 0));
}

function normalizeViewRadius(radius) {
  if (radius == null) return null;
  if (typeof radius === "object" && !Array.isArray(radius)) {
    return {
      topLeft: roundPx(radius.topLeft),
      topRight: roundPx(radius.topRight),
      bottomRight: roundPx(radius.bottomRight),
      bottomLeft: roundPx(radius.bottomLeft),
    };
  }
  if (Number.isFinite(Number(radius))) return roundPx(radius);
  return null;
}

function viewRadiusMax(radius) {
  const n = normalizeViewRadius(radius);
  if (n == null) return 0;
  if (typeof n === "number") return n;
  return Math.max(n.topLeft, n.topRight, n.bottomRight, n.bottomLeft);
}

function viewRadiiEqual(a, b) {
  const x = normalizeViewRadius(a);
  const y = normalizeViewRadius(b);
  if (x === y) return true;
  if (!x || !y || typeof x !== "object" || typeof y !== "object") return false;
  return (
    x.topLeft === y.topLeft &&
    x.topRight === y.topRight &&
    x.bottomRight === y.bottomRight &&
    x.bottomLeft === y.bottomLeft
  );
}

/** Integer Electron actually clips with. Join specs keep the container curve. */
function fallbackUniformRadius(radius) {
  return viewRadiusMax(radius);
}

/** Live page under the tab strip. Electron 42 only clips with one integer, so
 *  a 14px page would round the seam with the chrome. Bottom corners follow the
 *  window frame; the visible join with the tabs stays square. */
function pageClipRadius() {
  return 0;
}

function applyViewRadius(view, radius) {
  if (!view?.setBorderRadius) return;
  const uniform = viewRadiusMax(radius);
  try {
    view.setBorderRadius(uniform);
  } catch (_) {}
}

module.exports = {
  applyViewRadius,
  fallbackUniformRadius,
  normalizeViewRadius,
  pageClipRadius,
  viewRadiiEqual,
  viewRadiusMax,
};
