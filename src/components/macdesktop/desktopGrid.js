import {
  createContext,
  createElement,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

/**
 * How big an icon is on the Home desktop, and where it sits.
 *
 * Both answers have to come from the size of the desktop rather than from
 * constants, because the same window is dragged between a laptop panel and a
 * 32" display. Pixels that were right for one are wrong for the other: an icon
 * parked against the right edge of a big screen sits marooned in the middle of
 * a small one, and an icon sized for the small one is a postage stamp on the
 * big one.
 *
 * So nothing here is stored in pixels. A position is a *placement* — how many
 * icon cells in from the top-right corner — and a size is a multiple of the
 * cell, which itself scales with the desktop. Pixels are computed at render
 * time, from the desktop the icons are actually being drawn on.
 */

/* The desktop these sizes were drawn against: a 14" MacBook Pro, less the
 * chrome LYKN puts around the wallpaper. Everything scales from here. */
const REF_W = 1512;
const REF_H = 900;

/* A 6K display shouldn't get icons you can read from the hallway, and a small
 * window shouldn't shrink them past legible. */
const MIN_SCALE = 0.9;
const MAX_SCALE = 1.55;

/* One icon's worth of desktop at 1×: the cell it occupies in the grid, the
 * tile the button draws, the art inside it, and the label under that. */
const BASE_CELL_W = 104;
const BASE_CELL_H = 112;
const BASE_PAD = 16;
const BASE_TILE = 96;
const BASE_ART = 64;
const BASE_LABEL = 0.72; // rem

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * How much bigger or smaller than the reference desktop this one is.
 *
 * The smaller of the two ratios wins, so a wide-but-short desktop scales by
 * its height and doesn't push the bottom row off the screen.
 */
export function desktopScale(layer) {
  const w = layer?.w || REF_W;
  const h = layer?.h || REF_H;
  return clamp(Math.min(w / REF_W, h / REF_H), MIN_SCALE, MAX_SCALE);
}

/** Every icon dimension for a desktop this size, in pixels. */
export function desktopMetrics(layer) {
  const scale = desktopScale(layer);
  return {
    scale,
    w: layer?.w || REF_W,
    h: layer?.h || REF_H,
    cellW: Math.round(BASE_CELL_W * scale),
    cellH: Math.round(BASE_CELL_H * scale),
    pad: Math.round(BASE_PAD * scale),
    tile: Math.round(BASE_TILE * scale),
    art: Math.round(BASE_ART * scale),
    label: Number((BASE_LABEL * scale).toFixed(3)),
  };
}

/**
 * The CSS variables the icon components size themselves from.
 *
 * They go on the document root rather than on the desktop element, because a
 * drag ghost is a clone of an icon parented to <body> — scoped any tighter and
 * a picked-up icon would snap back to 1x the moment it left the wallpaper.
 * Sizing this way also means a monitor change resizes every icon without a
 * single component re-rendering.
 */
export function useDesktopIconVars(layer) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const m = desktopMetrics(layer);
    root.style.setProperty("--desk-tile", `${m.tile}px`);
    root.style.setProperty("--desk-art", `${m.art}px`);
    root.style.setProperty("--desk-label", `${m.label}rem`);
  }, [layer]);
}

/* ── Placements ───────────────────────────────────────────────────────────
   Where an icon lives, in cells in from the top-right corner — `{ col, row }`,
   fractional, so a hand-placed icon keeps its exact spot rather than snapping.

   Anchored to the right because that's the corner a Mac desktop fills from:
   an icon in the rightmost column stays in the rightmost column on every
   display, and two icons a column apart stay a column apart instead of
   drifting together or apart with the width. ──────────────────────────── */

/** A stored placement, as opposed to a legacy pixel pair or nothing at all. */
export function isPlacement(saved) {
  return !!saved && Number.isFinite(saved.col) && Number.isFinite(saved.row);
}

function isPixelPos(saved) {
  return !!saved && Number.isFinite(saved.x) && Number.isFinite(saved.y);
}

/** Where an icon drawn at `x, y` on this desktop belongs, as a placement. */
export function placementOf({ x, y }, layer) {
  const m = desktopMetrics(layer);
  return {
    col: Number((((m.w - m.pad - m.cellW - x) / m.cellW)).toFixed(4)),
    row: Number((((y - m.pad) / m.cellH)).toFixed(4)),
  };
}

/**
 * Where a placement lands on this desktop, in pixels.
 *
 * Clamped to the wallpaper: a display narrow enough to leave no room for an
 * icon's column pulls it back in rather than parking it off-screen, which is
 * the failure this whole module exists to prevent.
 */
export function pixelsOf(placement, layer) {
  const m = desktopMetrics(layer);
  const maxX = Math.max(m.pad, m.w - m.cellW - m.pad);
  const maxY = Math.max(m.pad, m.h - m.cellH - m.pad);
  return {
    x: Math.round(clamp(m.w - m.pad - m.cellW - placement.col * m.cellW, m.pad, maxX)),
    y: Math.round(clamp(m.pad + placement.row * m.cellH, m.pad, maxY)),
  };
}

/**
 * Read whatever a store has saved for an icon. Positions written before
 * placements existed are plain pixels; they're read against the current
 * desktop, which is the display they were parked on, and the stores rewrite
 * them as placements once they've measured.
 */
export function savedPlacement(saved, layer) {
  if (isPlacement(saved)) return { col: saved.col, row: saved.row };
  if (isPixelPos(saved)) return placementOf(saved, layer);
  return null;
}

/** Pixels for whatever a store has saved, or null if it has nothing. */
export function savedPixels(saved, layer) {
  const placement = savedPlacement(saved, layer);
  return placement ? pixelsOf(placement, layer) : null;
}

/* ── The grid ─────────────────────────────────────────────────────────── */

/** How many icons fit in a column on this desktop. */
export function gridRows(layer) {
  const m = desktopMetrics(layer);
  return Math.max(1, Math.floor((m.h - m.pad * 2) / m.cellH));
}

/**
 * The `index`th slot, filling columns from the top-right the way the Finder
 * does. A slot is already a column and a row, which is a placement.
 */
export function gridSlot(index, layer) {
  const rows = gridRows(layer);
  return { col: Math.floor(index / rows), row: index % rows };
}

/** Two icons would draw on top of each other at these placements. */
export function placementsOverlap(a, b) {
  return Math.abs(a.col - b.col) < 0.7 && Math.abs(a.row - b.row) < 0.7;
}

/* ── Sharing the measurement ──────────────────────────────────────────── */

const DesktopLayerContext = createContext(null);

const UNMEASURED = { w: 0, h: 0 };

/**
 * The desktop's size, measured once at the root and handed down. Every icon
 * layer used to run its own ResizeObserver over the same box and reach its own
 * conclusion, which is how they drifted out of step on a monitor change.
 */
export function DesktopLayerProvider({ layer, children }) {
  const value = useMemo(() => layer || UNMEASURED, [layer]);
  // createElement rather than JSX so this module stays plain JavaScript and
  // the placement maths below can be exercised by the test runner directly.
  return createElement(DesktopLayerContext.Provider, { value }, children);
}

/** `{ w, h }` of the desktop — zeroes until it has been measured. */
export function useDesktopLayer() {
  return useContext(DesktopLayerContext) || UNMEASURED;
}

/** Icon dimensions for the desktop this component is drawing on. */
export function useDesktopMetrics() {
  const layer = useDesktopLayer();
  return useMemo(() => desktopMetrics(layer), [layer]);
}

/** Track an element's content box. Drives everything above. */
export function useMeasuredLayer(ref) {
  const [layer, setLayer] = useState(UNMEASURED);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () =>
      setLayer((prev) =>
        prev.w === el.clientWidth && prev.h === el.clientHeight
          ? prev
          : { w: el.clientWidth, h: el.clientHeight },
      );
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return layer;
}
