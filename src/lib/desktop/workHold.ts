/**
 * Tell the desktop shell that a renderer turn is in flight so macOS can
 * sleep the display without freezing LYKN.
 */

type LyknWorkHold = {
  workHold?: (source: string) => void;
  workRelease?: (source: string) => void;
};

function lykn(): LyknWorkHold | null {
  if (typeof window === "undefined") return null;
  return (window as { lykn?: LyknWorkHold }).lykn || null;
}

export function setDesktopWorkHold(source: string, on: boolean) {
  const api = lykn();
  const key = String(source || "work");
  try {
    if (on) api?.workHold?.(key);
    else api?.workRelease?.(key);
  } catch {
    /* not running in Electron */
  }
}
