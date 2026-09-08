"use strict";

/**
 * The usable desktop a windowed Studio should fill: the display's work area
 * (screen minus menu bar / Dock / taskbar). Fullscreen covers the whole
 * display; windowed mode should still use every pixel the OS leaves for apps.
 */
function workAreaBoundsForDisplay(display) {
  const area = display?.workArea;
  if (!area) return null;
  const x = Number(area.x);
  const y = Number(area.y);
  const width = Number(area.width);
  const height = Number(area.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 1 || height < 1) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

module.exports = { workAreaBoundsForDisplay };
