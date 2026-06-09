import type { NavigateFunction } from "react-router-dom";

/**
 * Navigate away from the chat grid WITHOUT losing the active conversation.
 *
 * The grid chat lives in `OmniaGrid`'s React state and is only persisted via
 * a debounced save. Navigating straight to another route unmounts the grid
 * before that debounce fires, so the board's `updated_at` never gets bumped
 * and the conversation can come back empty (or resolve to a different board)
 * on return. Firing `omnia_flush_save` makes `useBoardPersistence` write the
 * local draft synchronously + kick the DB save before we leave, mirroring the
 * sidebar/mobile-tab navigation path.
 *
 * Use this for any in-chat affordance that navigates away (tool pills, neuron
 * cards, etc.) instead of calling `navigate` directly.
 */
export function flushAndNavigate(navigate: NavigateFunction, path: string): void {
  try {
    window.dispatchEvent(new Event("omnia_flush_save"));
  } catch {
    /* SSR / no window — fall through to navigate */
  }
  // Small delay lets the synchronous draft write land before the grid unmounts.
  setTimeout(() => navigate(path), 60);
}
