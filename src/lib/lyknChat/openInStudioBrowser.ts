/**
 * Route http(s) clicks from chat (artifacts, sources, markdown links) into
 * the LYKN in-app browser — each open creates a new agent tab so the AI can
 * act on that page independently.
 *
 * Preference order:
 *  1. studioOpenUrl — fresh labeled agent tab + Studio Browser tab switch
 *  2. openExternal — desktop bridge → lykn:open-url → also a fresh agent tab
 *
 * Artifacts should use openArtifactInStudioBrowser (URL + optional srcDoc).
 *
 * Returns true when the desktop bridge handled the URL (caller should
 * preventDefault); false means fall back to the default <a> / window.open.
 */

export const STUDIO_SHOW_BROWSER_EVENT = "lykn-studio-show-browser";

type LyknStudioBridge = {
  studioOpenUrl?: (url: string, title?: string) => Promise<unknown>;
  studioOpenArtifact?: (payload: {
    url?: string;
    html?: string;
    title?: string;
    kind?: string;
  }) => Promise<unknown>;
  openExternal?: (url: string, title?: string) => void;
};

/** @deprecated Kept for call-site compatibility; every open is a new agent now. */
export type OpenInStudioBrowserOptions = {
  newTab?: boolean;
};

function lyknBridge(): LyknStudioBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { lykn?: LyknStudioBridge }).lykn;
}

function showStudioBrowserTab() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(STUDIO_SHOW_BROWSER_EVENT));
  }
}

/** True when the desktop app can open URLs in the LYKN browser. */
export function studioBrowserAvailable(): boolean {
  const lykn = lyknBridge();
  return (
    typeof lykn?.studioOpenArtifact === "function" ||
    typeof lykn?.studioOpenUrl === "function" ||
    typeof lykn?.openExternal === "function"
  );
}

/**
 * Open a URL in the LYKN in-app browser as a new agent.
 * Returns true when handled (caller should preventDefault).
 */
export function openInStudioBrowser(
  url: string,
  title?: string,
  _opts?: OpenInStudioBrowserOptions,
): boolean {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return false;
  const lykn = lyknBridge();
  if (!lykn) return false;

  try {
    // Prefer studioOpenUrl so each link/artifact gets its own labeled agent.
    if (typeof lykn.studioOpenUrl === "function") {
      void lykn.studioOpenUrl(target, title);
      showStudioBrowserTab();
      return true;
    }
    if (typeof lykn.openExternal === "function") {
      lykn.openExternal(target, title);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Open a chat artifact in the LYKN browser as a new agent.
 * Passes hosted preview URL and/or inline HTML so the page still paints when
 * the signed file-proxy link is slow or expired.
 */
export function openArtifactInStudioBrowser(artifact: {
  previewUrl?: string | null;
  downloadUrl?: string | null;
  srcDoc?: string | null;
  title?: string | null;
  kind?: string | null;
}): boolean {
  const lykn = lyknBridge();
  if (!lykn) return false;

  const url = String(artifact.previewUrl || artifact.downloadUrl || "").trim();
  const html = typeof artifact.srcDoc === "string" ? artifact.srcDoc : "";
  const title = String(artifact.title || "Artifact").trim() || "Artifact";
  const kind = String(artifact.kind || "artifact").trim() || "artifact";

  if (!/^https?:\/\//i.test(url) && !html.trim()) return false;

  try {
    if (typeof lykn.studioOpenArtifact === "function") {
      void lykn.studioOpenArtifact({
        url: /^https?:\/\//i.test(url) ? url : undefined,
        html: html.trim() || undefined,
        title,
        kind,
      });
      showStudioBrowserTab();
      return true;
    }
    if (/^https?:\/\//i.test(url)) {
      return openInStudioBrowser(url, title);
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Click handler for anchors that should stay inside LYKN.
 * preventDefault when the desktop bridge handled the navigation.
 */
export function handleLyknBrowserClick(
  e: { preventDefault: () => void; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number },
  url: string,
  title?: string,
  opts?: OpenInStudioBrowserOptions,
): boolean {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return false;
  if (!openInStudioBrowser(url, title, opts)) return false;
  e.preventDefault();
  return true;
}
