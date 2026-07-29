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

import { isEmbeddedSurfacePath } from "@/lib/embeddedPreview";

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

/**
 * Same-origin iframes like VaultPickerDialog (`/vault?embedded=1`) and the
 * chat vault panel. Electron's preload does not run in subframes by default,
 * so `window.lykn.desktop` is missing there and the desktop gate would
 * otherwise bounce the iframe to /download (Glass marketing chrome).
 *
 * Safe because:
 *   • only applies inside a frame (top-level ?embedded=1 still gated)
 *   • CSP `frame-ancestors 'self'` blocks cross-origin embedding
 *   • ProtectedRoute still requires an authenticated session
 */
export function isEmbeddedDesktopSurface(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if (window.self === window.top) return false;
    const params = new URLSearchParams(window.location.search);
    if (params.get("embedded") !== "1") return false;
    return isEmbeddedSurfacePath(window.location.pathname);
  } catch {
    return false;
  }
}

/** True when this client may use the full in-app product UI. */
export function canUseWebApp(): boolean {
  return isWebAppEnabled() || isDesktopShell() || isEmbeddedDesktopSurface();
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
  "/login",
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

/**
 * After browser auth (login / email confirm / password reset), send the user
 * somewhere the website can actually render. Product routes stay desktop-only
 * when the web app is unplugged; public paths like /share keep working.
 *
 * Always requires a same-app relative path — never `//evil.com` or absolute
 * URLs, even when the web app is enabled (open-redirect hardening).
 */
export function resolvePostAuthPath(dest: string): string {
  const raw = String(dest || "").trim() || "/app";
  // Inline the internal-path check (avoid coupling marketing gate to URL utils
  // in a way that surprises tests). Same rules as safeInternalPath.
  const trimmed = raw;
  const isInternal =
    trimmed.startsWith("/") &&
    !trimmed.startsWith("//") &&
    !trimmed.includes("\\") &&
    !/[\u0000-\u001f]/.test(trimmed);
  if (!isInternal) return canUseWebApp() ? "/app" : "/download";

  let pathWithQuery = trimmed;
  try {
    const url = new URL(trimmed, "https://lykn.local");
    if (url.origin !== "https://lykn.local") {
      return canUseWebApp() ? "/app" : "/download";
    }
    pathWithQuery = `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return canUseWebApp() ? "/app" : "/download";
  }

  if (canUseWebApp()) return pathWithQuery;
  try {
    const url = new URL(pathWithQuery, "https://lykn.local");
    if (isWebPublicPath(url.pathname)) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    /* fall through */
  }
  return "/download";
}
