/**
 * Artifact "Open" inside LYKN Studio: route the URL into the Studio's own
 * docked browser instead of the OS default browser. The Studio document
 * always carries html.lykn-glass-embed (both Glass and Neutral themes), and
 * the in-document product surfaces share that document — so a truthy check
 * here means Studio.jsx is mounted and listening for the tab-switch event.
 */

export const STUDIO_SHOW_BROWSER_EVENT = "lykn-studio-show-browser";

type LyknStudioBridge = {
  studioOpenUrl?: (url: string, title?: string) => Promise<unknown>;
};

export function studioBrowserAvailable(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const lykn = (window as unknown as { lykn?: LyknStudioBridge }).lykn;
  return (
    typeof lykn?.studioOpenUrl === "function" &&
    document.documentElement.classList.contains("lykn-glass-embed")
  );
}

/**
 * Returns true when the URL was routed into the Studio browser (caller
 * should preventDefault); false means fall back to the default behavior.
 */
export function openInStudioBrowser(url: string, title?: string): boolean {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target) || !studioBrowserAvailable()) return false;
  try {
    const lykn = (window as unknown as { lykn?: LyknStudioBridge }).lykn;
    void lykn?.studioOpenUrl?.(target, title);
    window.dispatchEvent(new CustomEvent(STUDIO_SHOW_BROWSER_EVENT));
    return true;
  } catch {
    return false;
  }
}
