import { useEffect, useState } from "react";

/**
 * Whether Home is currently drawing its folders, files, and widgets. Hide is
 * a view flag — icons and layout stay where they are so Show puts everything
 * back.
 */

const VISIBILITY_KEY = "lykn_desktop_visibility";
const VISIBILITY_EVENT = "lykn_desktop_visibility_changed";

const DEFAULTS = { hideFolders: false, hideFiles: false, hideWidgets: false };

export function readDesktopVisibility() {
  try {
    const saved = JSON.parse(localStorage.getItem(VISIBILITY_KEY) || "null");
    if (saved && typeof saved === "object") {
      return {
        hideFolders: !!saved.hideFolders,
        hideFiles: !!saved.hideFiles,
        hideWidgets: !!saved.hideWidgets,
      };
    }
  } catch {
    /* defaults */
  }
  return { ...DEFAULTS };
}

export function writeDesktopVisibility(patch) {
  const next = { ...readDesktopVisibility(), ...patch };
  try {
    localStorage.setItem(VISIBILITY_KEY, JSON.stringify(next));
  } catch {
    /* hide still applies for this session */
  }
  try {
    window.dispatchEvent(new Event(VISIBILITY_EVENT));
  } catch {
    /* no window (SSR) */
  }
  return next;
}

export function useDesktopVisibility() {
  const [visibility, setVisibility] = useState(readDesktopVisibility);
  useEffect(() => {
    const sync = () => setVisibility(readDesktopVisibility());
    window.addEventListener(VISIBILITY_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(VISIBILITY_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return [visibility, writeDesktopVisibility];
}
