import { useEffect, useState } from "react";

/**
 * A file drawn the way macOS draws it: the first page of a PDF, a frame from a
 * video, an app's own icon, a photo's contents.
 *
 * The picture comes from the main process, which asks QuickLook and falls back
 * to the file's icon. Nothing here decodes anything — that's what makes HEIC
 * and RAW work, since Chromium can't read either.
 *
 * Everything that fails lands on the same place: the kind icon the caller
 * passes in. A file with no preview, a folder LYKN can't read, Local Mode off,
 * running in a browser with no bridge — all of them just draw the icon, so no
 * tile is ever empty.
 */

// Results live past unmount so scrolling a folder, switching panes, and coming
// back doesn't re-ask for pictures we already have. Misses are cached as null
// for the same reason: a file with no preview shouldn't be retried on every
// pass. Main caches too, but that's still an IPC round trip per tile.
const cache = new Map();
const CACHE_MAX = 800;

function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// mtime is part of the key so an edited file redraws instead of showing the
// picture of what it used to be.
function keyFor(entry, size) {
  return `${entry.path}|${size}|${entry.modifiedAt || 0}`;
}

/**
 * Which entries are worth asking about. Plain folders are drawn by the UI, and
 * anything the caller already renders straight from disk shouldn't make the
 * round trip.
 */
export function wantsSystemThumb(entry, alreadyDrawn = false) {
  if (!entry || alreadyDrawn) return false;
  if (entry.type === "dir" && !entry.package) return false;
  return true;
}

export function useSystemThumb(entry, size) {
  const enabled = wantsSystemThumb(entry);
  const key = enabled ? keyFor(entry, size) : null;
  const [url, setUrl] = useState(() => (key ? cache.get(key) ?? null : null));

  useEffect(() => {
    if (!key) return undefined;
    if (cache.has(key)) {
      setUrl(cache.get(key));
      return undefined;
    }
    const files = typeof window !== "undefined" ? window.lykn?.files : null;
    if (!files?.thumbnail) return undefined;

    let alive = true;
    files
      .thumbnail(entry.path, size)
      .then((r) => {
        const value = r?.ok ? r.dataUrl : null;
        remember(key, value);
        if (alive) setUrl(value);
      })
      .catch(() => {
        remember(key, null);
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [key, size, entry?.path]);

  return url;
}

/**
 * `size` is the pixel budget for the generated image; `className` styles the
 * box it's drawn into. Ask for a little more than the box so the tile stays
 * sharp on a Retina display.
 */
export default function FileThumb({ entry, size, className = "", fallback }) {
  const url = useSystemThumb(entry, size);
  if (!url) return fallback;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      className={`object-contain ${className}`}
    />
  );
}
