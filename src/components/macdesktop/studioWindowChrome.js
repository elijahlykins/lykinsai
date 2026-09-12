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
    !hidden &&
    !minimized &&
    !closing &&
    !peeked
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
  return Boolean(desktop) && Boolean(fullscreen) && !surfaceFullscreen;
}

/**
 * Native Browser views paint above every React window. They may only sit on
 * screen while the Browser window is the one in front — otherwise they cover
 * the window the user just clicked to raise.
 */
export function studioBrowserFront({
  splitHasBrowser = false,
  appWins = [],
  browserId = "browser",
} = {}) {
  return Boolean(splitHasBrowser) || appWins[appWins.length - 1] === browserId;
}

export function studioBrowserViewsLive({
  splitHasBrowser = false,
  tab = "dashboard",
  desktopPeek = false,
  browserOpen = false,
  browserMinimized = false,
  browserSettled = false,
  split = null,
  browserFront = false,
} = {}) {
  if (splitHasBrowser) return tab === "dashboard" && !desktopPeek;
  return (
    tab === "dashboard" &&
    Boolean(browserOpen) &&
    !browserMinimized &&
    Boolean(browserSettled) &&
    !desktopPeek &&
    !split &&
    Boolean(browserFront)
  );
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
