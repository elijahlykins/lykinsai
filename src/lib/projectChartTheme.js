// Theme-aware colour palettes for the project dashboard charts.
//
// Two design constraints from the project surface:
//   • Light mode  → neutral, paper-like tones (black / stone / beige) so the
//                   charts read as calm and editorial against the white cards.
//   • Dark mode   → stable green, orange, pink, white, and blue accents
//                   shared by project charts.
import { useEffect, useState } from "react";

// Reflects the `.dark` class that lib/theme.js toggles on <html>. A
// MutationObserver keeps charts in sync when the user flips themes live.
export function useIsDark() {
  const read = () =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setDark(el.classList.contains("dark"));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

// Two-series charts (deadlines bars, activity line).
const SERIES = {
  light: { tasks: "#292524", events: "#b8a589", line: "#57534e" },
  dark: { tasks: "#2dd4bf", events: "#fb923c", line: "#818cf8" },
};

// Donut slices, keyed by the project member / file-type kind. Light values are
// a neutral black→beige ramp (distinguished by lightness); dark values are
// shared by retained project charts.
const SLICE = {
  light: {
    pdf: "#1c1917",
    image: "#57534e",
    video: "#8a7c68",
    link: "#a8a29e",
    audio: "#c9b79c",
    doc: "#78716c",
    note: "#d6d3d1",
    vault: "#57534e",
    concept: "#8a7c68",
    belief: "#c9b79c",
    fact: "#a8a29e",
    rule: "#b8a589",
    other: "#d6d3d1",
  },
  dark: {
    pdf: "#ec4899",
    image: "#60a5fa",
    video: "#a78bfa",
    link: "#2dd4bf",
    audio: "#fb923c",
    doc: "#10b981",
    note: "#94a3b8",
    vault: "#10b981",
    concept: "#fb923c",
    belief: "#e5e7eb",
    fact: "#ec4899",
    rule: "#818cf8",
    other: "#94a3b8",
  },
};

export function chartSeries(isDark) {
  return isDark ? SERIES.dark : SERIES.light;
}

export function chartSlice(isDark, key) {
  const map = isDark ? SLICE.dark : SLICE.light;
  return map[key] || (isDark ? "#94a3b8" : "#a8a29e");
}
