/**
 * The file windows that are open, and the one way to open another.
 *
 * A file window is not a modal. Several can be up at once, each with its own
 * geometry and its own place in the z-order, which is why they live in a
 * registry rather than in one component's state: the surface that opens a
 * window is usually not the surface that renders it.
 *
 * Opening dispatches a cancelable event, the same handshake installed apps use
 * (see OPEN_APP_EVENT). The Studio desktop claims it so the window joins the
 * app windows — dock, tiling, wallpaper peek and all. Anywhere the desktop
 * isn't mounted, the event goes unclaimed and a plain layer over the page
 * hosts the window instead.
 */

import { fileSourceKey, type FileSource } from "./fileSource";

export const OPEN_FILE_WINDOW_EVENT = "lykn:open-file-window";

const ID_PREFIX = "file-window:";

export interface FileWindowEntry {
  id: string;
  key: string;
  source: FileSource;
  /** True once the Studio desktop has taken responsibility for rendering it. */
  claimed: boolean;
}

const windows = new Map<string, FileWindowEntry>();
const listeners = new Set<() => void>();
let seq = 0;

function emit() {
  for (const listener of [...listeners]) listener();
}

export function subscribeFileWindows(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function listFileWindows(): FileWindowEntry[] {
  return [...windows.values()];
}

export function getFileWindow(id: string): FileWindowEntry | null {
  return windows.get(id) || null;
}

export function isFileWindowId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(ID_PREFIX);
}

/**
 * Put a file on screen. Returns the window id — the same one every time for
 * the same file, so asking twice raises the open window instead of stacking a
 * second copy of it.
 */
export function openFileWindow(source: FileSource): string {
  const key = fileSourceKey(source);
  const existing = [...windows.values()].find((entry) => entry.key === key);
  const id = existing?.id || `${ID_PREFIX}${(seq += 1)}`;
  windows.set(id, { id, key, source, claimed: existing?.claimed ?? false });
  emit();

  if (typeof window !== "undefined") {
    const event = new CustomEvent(OPEN_FILE_WINDOW_EVENT, {
      detail: { id },
      cancelable: true,
    });
    window.dispatchEvent(event);
    const entry = windows.get(id);
    if (entry && event.defaultPrevented !== entry.claimed) {
      entry.claimed = event.defaultPrevented;
      emit();
    }
  }

  return id;
}

export function closeFileWindow(id: string): void {
  if (windows.delete(id)) emit();
}
