"use strict";

/** Keep the glass bar inside a display work area while the user drags it. */
function clampOverlayMove(bounds, workArea, { margin = 8 } = {}) {
  if (!bounds || !workArea) return bounds || { x: 0, y: 0, width: 0, height: 0 };
  const width = Math.max(1, Math.round(Number(bounds.width) || 0));
  const height = Math.max(1, Math.round(Number(bounds.height) || 0));
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height - margin;
  const minY = workArea.y + margin;
  const x = Math.round(Math.max(workArea.x, Math.min(Number(bounds.x) || 0, maxX)));
  const y = Math.round(Math.max(minY, Math.min(Number(bounds.y) || 0, Math.max(minY, maxY))));
  return { x, y, width, height };
}

function unionRects(rects) {
  const list = (Array.isArray(rects) ? rects : []).filter(
    (r) => r && typeof r.x === "number" && typeof r.y === "number",
  );
  if (!list.length) return { x: 0, y: 0, width: 0, height: 0 };
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of list) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + (Number(r.width) || 0));
    y2 = Math.max(y2, r.y + (Number(r.height) || 0));
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Place the bar by the cursor's offset from the drag-start grab, then clamp
 * to the given work area (often the union of every display so it can travel).
 */
function overlayMoveFromCursor(origin, cursor, workArea, { margin = 8 } = {}) {
  const dx = (Number(cursor?.x) || 0) - (Number(origin?.cursorX) || 0);
  const dy = (Number(cursor?.y) || 0) - (Number(origin?.cursorY) || 0);
  return clampOverlayMove(
    {
      x: (Number(origin?.x) || 0) + dx,
      y: (Number(origin?.y) || 0) + dy,
      width: origin?.width,
      height: origin?.height,
    },
    workArea,
    { margin },
  );
}

module.exports = { clampOverlayMove, overlayMoveFromCursor, unionRects };
