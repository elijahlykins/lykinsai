import { useEffect } from "react";

/**
 * Marketing pages are designed light-only, but the app ships dark-first
 * (`.dark` on <html> for fresh sessions). Force light while a marketing page
 * is mounted so embedded real-UI components (Studio research rail, suggestion
 * chips, chat composer) render their light theme; restore on unmount.
 */
export function useLandingLightTheme() {
  useEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains("dark");
    root.classList.remove("dark");
    return () => {
      if (hadDark) root.classList.add("dark");
    };
  }, []);
}
