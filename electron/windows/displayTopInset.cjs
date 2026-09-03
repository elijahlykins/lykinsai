"use strict";

/**
 * How many CSS pixels of the menu-bar / camera-notch strip this window
 * actually covers. Windowed Studio already lives in the work area (0).
 * Simple fullscreen fills the display, so the pill and other top chrome
 * have to clear `workArea.y - bounds.y` — 25px on a plain menu bar,
 * ~38px on a notched MacBook.
 */
function displayTopInsetForWindow(bounds, display) {
  if (!bounds || !display) return 0;
  const workY = Number(display.workArea?.y);
  const displayY = Number(display.bounds?.y);
  const strip = Math.max(0, workY - displayY);
  if (!Number.isFinite(strip) || strip <= 0) return 0;
  const top = Number(bounds.y);
  if (!Number.isFinite(top)) return 0;
  const height = Number(bounds.height);
  const bottom = top + (Number.isFinite(height) ? Math.max(height, 0) : 0);
  const overlap = Math.min(bottom, workY) - top;
  if (!Number.isFinite(overlap) || overlap <= 0) return 0;
  return Math.max(0, Math.min(Math.round(strip), Math.round(overlap)));
}

module.exports = { displayTopInsetForWindow };
