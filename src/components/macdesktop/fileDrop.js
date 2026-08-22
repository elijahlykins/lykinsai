import { useEffect } from "react";

import {
  canDropIntoFolder,
  FOLDER_DWELL_MS,
  movablePaths,
  normalizeDir,
} from "@/components/macfiles/filesDrag";
import { useDropZone } from "@/lib/drag/dragEngine";
import { copyLyknFolders, relocateLyknFolders, transferredPairs } from "@/lib/lyknFolders";
import { forgetDesktopDrops } from "@/lib/macDesktopSync";

/**
 * Turning a drop into something that happens on disk, plus the two
 * announcements the Home desktop listens for:
 *
 *  - place, "these icons belong at this spot now" (a rearrange, or a file
 *    that just landed on the wallpaper)
 *  - moved, "these paths aren't where they were" (so an icon stops drawing
 *    somewhere it no longer lives)
 *
 * The desktop's icon positions are spread across three stores — mirrored
 * files, user folders, the pinned Files/Vault icons — and any of them can own
 * the path in a given drop, so these go out as window events rather than
 * props threaded through Studio.
 */

export const DESKTOP_PLACE_EVENT = "lykn_desktop_place";
export const DESKTOP_FILES_MOVED_EVENT = "lykn_desktop_files_moved";

export function placeDesktopIcons(paths, x, y) {
  if (typeof window === "undefined" || !paths?.length) return;
  window.dispatchEvent(
    new CustomEvent(DESKTOP_PLACE_EVENT, { detail: { paths, x, y } }),
  );
}

export function useDesktopPlace(onPlace) {
  useEffect(() => {
    const fn = (e) => onPlace?.(e.detail || {});
    window.addEventListener(DESKTOP_PLACE_EVENT, fn);
    return () => window.removeEventListener(DESKTOP_PLACE_EVENT, fn);
  }, [onPlace]);
}

export function useDesktopFilesMoved(onMoved) {
  useEffect(() => {
    const fn = (e) => onMoved?.(e.detail?.paths || []);
    window.addEventListener(DESKTOP_FILES_MOVED_EVENT, fn);
    return () => window.removeEventListener(DESKTOP_FILES_MOVED_EVENT, fn);
  }, [onMoved]);
}

function bridge() {
  return typeof window !== "undefined" ? window.lykn?.files || null : null;
}

/**
 * Move (or, holding Option, copy) paths into a folder.
 *
 * Returns the main process's result, with `paths` set to where the items
 * ended up — callers use that to park a new icon at the drop point.
 */
export async function moveFilesInto(paths, dest, { copy = false } = {}) {
  const destination = normalizeDir(dest);
  const moving = movablePaths(paths, destination);
  if (!destination) return { ok: false, error: "no_destination" };
  if (!moving.length) return { ok: true, paths: [], skipped: true };

  const files = bridge();
  if (!files) return { ok: false, error: "no_bridge" };

  const result = await (copy
    ? files.copy({ paths: moving, dest: destination })
    : files.move({ paths: moving, dest: destination }));

  // A folder LYKN made stays LYKN's after it's dragged somewhere else.
  const pairs = transferredPairs(moving, result);
  if (copy) copyLyknFolders(pairs);
  else relocateLyknFolders(pairs);

  if (!copy && result && result.ok !== false) {
    forgetDesktopDrops(moving);
    window.dispatchEvent(
      new CustomEvent(DESKTOP_FILES_MOVED_EVENT, { detail: { paths: moving } }),
    );
  }
  return result;
}

/** The drop half of the above, straight from a drag payload. */
export function dropPayloadInto(payload, dest) {
  return moveFilesInto(payload.paths, dest, { copy: payload.copy });
}

/**
 * A folder that lights up once a drag settles on it, takes the drop, and
 * spring-opens if the hover lasts — a folder icon on the desktop, a tile in
 * the Files browser, a favourite in the sidebar.
 *
 * "Settles" is the whole point: the highlight and the drop arrive together, so
 * an unlit folder under the cursor is a folder that won't swallow the drag.
 */
export function useFolderDropZone(destPath, { onHoverOpen, disabled, onDropped } = {}) {
  return useDropZone({
    disabled: disabled || !destPath,
    accept: (payload) => canDropIntoFolder(payload, destPath),
    dwell: FOLDER_DWELL_MS,
    onHoverOpen,
    onDrop: async (payload) => {
      const result = await dropPayloadInto(payload, destPath);
      onDropped?.(result, payload);
    },
  });
}
