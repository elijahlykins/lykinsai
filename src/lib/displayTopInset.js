export const DISPLAY_TOP_INSET_VAR = "--lykn-display-top-inset";

/**
 * Renderer fallback when Electron has not sent a measured inset.
 * `availTop - screenY` is the menu-bar / notch overlap for this window.
 */
export function readDisplayTopInset(win = globalThis.window) {
  if (!win) return 0;
  const availTop = Number(win.screen?.availTop);
  const screenY = Number(win.screenY);
  if (!Number.isFinite(availTop) || !Number.isFinite(screenY)) return 0;
  return Math.max(0, Math.round(availTop - screenY));
}

export function applyDisplayTopInset(px, root = globalThis.document?.documentElement) {
  if (!root?.style) return 0;
  const n = Math.max(0, Math.round(Number(px) || 0));
  root.style.setProperty(DISPLAY_TOP_INSET_VAR, `${n}px`);
  return n;
}

export function syncDisplayTopInset(payload, win = globalThis.window) {
  const fromHost = Number(payload?.topInset);
  const px = Number.isFinite(fromHost) && fromHost >= 0
    ? Math.round(fromHost)
    : readDisplayTopInset(win);
  return applyDisplayTopInset(px, win?.document?.documentElement);
}
