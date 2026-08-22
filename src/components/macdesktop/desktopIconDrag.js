import { useCallback } from "react";

import { parentDir, startFilesDrag } from "@/components/macfiles/filesDrag";
import {
  desktopFilePaths,
  desktopIconsFor,
  desktopRootOf,
  snapshotDesktopIcons,
  useDesktopSelect,
} from "./desktopSelect";

/**
 * Picking up an icon on the Home desktop.
 *
 * One hook for all three kinds — a mirrored file, a folder the user made, the
 * pinned Files/Vault shortcuts — because from a drag's point of view they only
 * differ in whether they have a path behind them. A shortcut doesn't, so it
 * can be rearranged but has nothing to hand a folder it's dropped on.
 *
 * Whatever else is selected comes too, keeping its offsets, so a marquee of
 * six icons lands as the same six icons.
 */
export function useDesktopIconDrag({ id, path, onMoveStart }) {
  const select = useDesktopSelect();

  return useCallback(
    (event) => {
      if (event.button !== 0) return;
      const ids = select.prepareDrag(id, event);
      const root = desktopRootOf(event.currentTarget);
      startFilesDrag(event, () => {
        onMoveStart?.();
        const paths = desktopFilePaths(root, ids);
        const carried = paths.length ? paths : path ? [path] : [];
        return {
          source: "desktop",
          iconIds: ids,
          bases: snapshotDesktopIcons(root, ids),
          paths: carried,
          sourceDir: carried.length ? parentDir(carried[0]) : null,
          elements: desktopIconsFor(root, ids),
        };
      });
    },
    [id, path, onMoveStart, select],
  );
}
