/**
 * Native window buttons do not appear in macOS simple fullscreen, which is
 * how Studio first loads. Home draws an in-page cluster only then, revealed
 * when the pointer hits the top of the display — unless a hosted surface
 * already owns that corner (a zoomed app, Split View, or HTML fullscreen).
 * Those surfaces have their own traffic lights; LYKN's stay hidden until the
 * occupying window is restored, minimized, or closed.
 */

export function studioWindowFillsDesktop({
  zoomed = false,
  hidden = false,
  minimized = false,
  closing = false,
  peeked = false,
} = {}) {
  return (
    Boolean(zoomed) &&
    !Boolean(hidden) &&
    !Boolean(minimized) &&
    !Boolean(closing) &&
    !Boolean(peeked)
  );
}

export function studioSurfaceFullscreen({
  zoomedWins = {},
  split = false,
  htmlFullscreen = false,
} = {}) {
  return (
    Boolean(split) ||
    Boolean(htmlFullscreen) ||
    Object.values(zoomedWins).some(Boolean)
  );
}

export function studioFullscreenTrafficVisible({
  desktop = false,
  fullscreen = false,
  surfaceFullscreen = false,
} = {}) {
  return Boolean(desktop) && Boolean(fullscreen) && !Boolean(surfaceFullscreen);
}

export function applyStudioWindowAction(lykn, action, { fullscreen = false } = {}) {
  if (!lykn) return;
  if (action === "close") {
    lykn.closeStudio?.();
    return;
  }
  if (action === "minimize") {
    lykn.minimizeStudio?.();
    return;
  }
  if (action === "zoom") {
    lykn.setStudioFullscreen?.(!fullscreen);
  }
}
