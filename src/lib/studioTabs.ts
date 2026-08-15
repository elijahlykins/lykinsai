/**
 * Ask LYKN Studio to open one of its tabs or app windows from anywhere in the
 * document.
 *
 * Studio's surfaces aren't top-level routes — the stage tabs and the floating
 * Calendar / To-dos windows live in their own MemoryRouters — so navigating to
 * /projects/:id instead bounces off LegacyProductToStudio and lands back on
 * Home. Studio marks the event handled with preventDefault, following the same
 * "true when handled, otherwise fall back" shape as openInStudioBrowser.
 */

export const STUDIO_OPEN_TAB_EVENT = "lykn-studio-open-tab";

/**
 * @param id A Studio section id ("projects", "calendar", "todos", "vault"…).
 * @param src Optional MemoryRouter entry to deep-link, e.g. "/projects/abc".
 * @returns true when Studio handled it; false means navigate normally.
 */
export function openStudioTab(id: string, src?: string): boolean {
  if (typeof window === "undefined") return false;
  const event = new CustomEvent(STUDIO_OPEN_TAB_EVENT, {
    detail: { id, src },
    cancelable: true,
  });
  return !window.dispatchEvent(event);
}
