/**
 * Web-app access gate.
 *
 * LYKN is shipping as a downloadable desktop app. The full product UI
 * (/app, /vault, /login in a browser, …) stays in the codebase but is
 * unreachable from a normal browser. The Electron shell always has access
 * via `window.lykn.desktop` (see electron/preload.cjs).
 *
 * Flip access back on without deleting routes:
 *   VITE_WEB_APP_ENABLED=true
 *
 * Local Vite (`import.meta.env.DEV`) keeps the web app on by default so
 * browser development still works; set VITE_WEB_APP_ENABLED=false to test
 * the production gate locally.
 */

export function isDesktopShell(): boolean {
  try {
    return typeof window !== "undefined" && Boolean((window as any).lykn?.desktop);
  } catch {
    return false;
  }
}

export function isWebAppEnabled(): boolean {
  const raw = import.meta.env.VITE_WEB_APP_ENABLED;
  if (raw != null && String(raw).trim() !== "") {
    const v = String(raw).trim().toLowerCase();
    return v !== "false" && v !== "0" && v !== "off" && v !== "no";
  }
  // Production builds: web app off. Dev server: on (unless env overrides).
  return Boolean(import.meta.env.DEV);
}

/** True when this client may use the full in-app product UI. */
export function canUseWebApp(): boolean {
  return isWebAppEnabled() || isDesktopShell();
}

/** Public marketing / legal / desktop-auth surfaces that stay on the website. */
export const WEB_PUBLIC_PATHS = new Set([
  "/",
  "/landing",
  "/glass",
  "/download",
  "/pricing",
  "/privacy",
  "/terms",
  "/cookies",
  "/dpa",
  "/news",
  "/desktop-auth",
  "/reset-password",
  "/oauth/consent",
  "/share",
  "/apps/chatgpt",
  "/apps/claude",
]);

export function isWebPublicPath(pathname: string): boolean {
  if (WEB_PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/news/")) return true;
  if (pathname.startsWith("/product/")) return true;
  if (pathname.startsWith("/apps/")) return true;
  return false;
}
