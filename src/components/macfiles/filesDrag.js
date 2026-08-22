import { armDrag } from "@/lib/drag/dragEngine";

/**
 * What it means to drag files around inside LYKN.
 *
 * Only paths travel, never bytes. Every drop turns into a main-process move or
 * copy, which re-checks the sync allowlist, so a drag can't put a file
 * somewhere the user hasn't shared.
 *
 * The mechanics of the drag itself live in `@/lib/drag/dragEngine`; this
 * module is the file-shaped vocabulary on top of it, shared by the desktop and
 * the Files browser because both ends of a drag need to agree on it.
 */

/**
 * How long a folder has to be hovered before it will take a drop.
 *
 * Dropping into a folder moves real files on disk, and the pointer passes over
 * plenty of folders on its way anywhere, so a folder stays inert — and unlit —
 * until the drag settles on it. Long enough to require aiming at it, short
 * enough that aiming at it doesn't feel like waiting.
 */
export const FOLDER_DWELL_MS = 500;

export function parentDir(p) {
  const s = String(p || "").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i <= 0 ? "/" : s.slice(0, i);
}

export function baseName(p) {
  return String(p || "").replace(/\/+$/, "").split("/").pop() || "";
}

export function normalizeDir(p) {
  return String(p || "").replace(/\/+$/, "");
}

/** True when dest is one of the dragged folders, or lives inside one. */
export function wouldDropIntoSelf(paths, dest) {
  const d = normalizeDir(dest);
  return (paths || []).some((p) => {
    const from = normalizeDir(p);
    return !!from && (d === from || d.startsWith(`${from}/`));
  });
}

/** The ones a move would actually touch — the rest are already there. */
export function movablePaths(paths, dest) {
  const d = normalizeDir(dest);
  return (paths || []).filter((p) => p && parentDir(p) !== d);
}

/**
 * Can this payload land in `dest`? A folder can't swallow itself, and a drag
 * that's entirely already in `dest` has nowhere to go — say no to both so the
 * drop falls through to whatever is behind the folder.
 */
export function canDropIntoFolder(payload, dest) {
  const d = normalizeDir(dest);
  if (!d || !payload?.paths?.length) return false;
  if (wouldDropIntoSelf(payload.paths, d)) return false;
  return movablePaths(payload.paths, d).length > 0;
}

/**
 * Pick up files. Nothing happens until the pointer moves, so this is safe to
 * call from any pointerdown — a plain click still reaches onClick.
 *
 * `make()` is called at the moment the drag starts and returns the paths, the
 * elements to draw under the cursor, and (on the desktop) the icons riding
 * along with their pick-up positions.
 */
export function startFilesDrag(event, make) {
  armDrag(event, (start) => {
    const spec = make?.(start);
    if (!spec) return null;
    return { source: "files", ...spec };
  });
}
