import { useEffect, useState } from "react";

export type ViewportTier =
  | "mobile"
  | "tablet"
  | "small-laptop"
  | "laptop"
  | "desktop"
  | "ultrawide";

const BREAKPOINTS = {
  mobile: 0,
  tablet: 768,
  "small-laptop": 1024,
  laptop: 1366,
  desktop: 1600,
  ultrawide: 2200,
} as const;

function getTier(width: number): ViewportTier {
  if (width >= BREAKPOINTS.ultrawide) return "ultrawide";
  if (width >= BREAKPOINTS.desktop) return "desktop";
  if (width >= BREAKPOINTS.laptop) return "laptop";
  if (width >= BREAKPOINTS["small-laptop"]) return "small-laptop";
  if (width >= BREAKPOINTS.tablet) return "tablet";
  return "mobile";
}

export function useViewportTier() {
  const [state, setState] = useState(() => {
    const w = typeof window !== "undefined" ? window.innerWidth : 1280;
    const h = typeof window !== "undefined" ? window.innerHeight : 800;
    return { tier: getTier(w), width: w, height: h };
  });

  useEffect(() => {
    const queries = [
      window.matchMedia(`(max-width: ${BREAKPOINTS.tablet - 1}px)`),
      window.matchMedia(`(min-width: ${BREAKPOINTS.tablet}px) and (max-width: ${BREAKPOINTS["small-laptop"] - 1}px)`),
      window.matchMedia(`(min-width: ${BREAKPOINTS["small-laptop"]}px) and (max-width: ${BREAKPOINTS.laptop - 1}px)`),
      window.matchMedia(`(min-width: ${BREAKPOINTS.laptop}px) and (max-width: ${BREAKPOINTS.desktop - 1}px)`),
      window.matchMedia(`(min-width: ${BREAKPOINTS.desktop}px) and (max-width: ${BREAKPOINTS.ultrawide - 1}px)`),
      window.matchMedia(`(min-width: ${BREAKPOINTS.ultrawide}px)`),
    ];

    const update = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setState({ tier: getTier(w), width: w, height: h });
    };

    for (const mql of queries) mql.addEventListener("change", update);
    return () => {
      for (const mql of queries) mql.removeEventListener("change", update);
    };
  }, []);

  return state;
}

export function useIsMobile() {
  const { tier } = useViewportTier();
  return tier === "mobile";
}

export function getMemorySidebarWidth(viewportWidth: number): number {
  if (viewportWidth < 1366) return 300;
  if (viewportWidth < 1600) return 340;
  return 380;
}
