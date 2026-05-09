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

// A device is considered "touch-only" (i.e. an actual phone/tablet) when its
// primary pointer is coarse AND it can't hover. Laptops/desktops — even ones
// with touchscreens — report a fine pointer or hover capability, so this
// stays false for them. We use this to gate mobile-mode UI so that resizing
// or split-screening a desktop browser below 768px doesn't punt the user
// into the phone shell.
export function getIsTouchOnlyDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return (
      window.matchMedia("(pointer: coarse)").matches &&
      window.matchMedia("(hover: none)").matches
    );
  } catch {
    return false;
  }
}

// Subscribe to the touch-only-device signal. Components that previously gated
// behaviour on raw viewport width (e.g. `< 768px = phone`) should compose this
// with their width check so a split-screened laptop window stays on the
// desktop UI even when narrow.
export function useIsTouchOnlyDevice(): boolean {
  const [isTouchOnly, setIsTouchOnly] = useState<boolean>(() => getIsTouchOnlyDevice());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const pointerMql = window.matchMedia("(pointer: coarse)");
    const hoverMql = window.matchMedia("(hover: none)");
    const update = () => setIsTouchOnly(getIsTouchOnlyDevice());
    pointerMql.addEventListener("change", update);
    hoverMql.addEventListener("change", update);
    update();
    return () => {
      pointerMql.removeEventListener("change", update);
      hoverMql.removeEventListener("change", update);
    };
  }, []);

  return isTouchOnly;
}

export function useIsMobile() {
  const { tier } = useViewportTier();
  const isTouchOnly = useIsTouchOnlyDevice();
  return tier === "mobile" && isTouchOnly;
}

export function getVaultSidebarWidth(viewportWidth: number): number {
  if (viewportWidth < 640) return viewportWidth;
  if (viewportWidth < 1366) return 300;
  if (viewportWidth < 1600) return 340;
  return 380;
}
