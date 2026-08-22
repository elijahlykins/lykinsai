import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * Shared selection for every Home desktop icon — user folders, mirrored files,
 * and the Files / Vault shortcuts. They live in sibling trees, so a context
 * plus a window event is how a marquee in the wallpaper layer can still move
 * icons that aren't its children.
 *
 * Positions work the same way: an icon's coordinates belong to whichever store
 * owns it, so a group move is announced once and each store picks out the ids
 * it recognises.
 */

export const DESKTOP_GROUP_MOVE_EVENT = "lykn_desktop_group_move";
export const DESKTOP_ROOT = ".lykn-studio-desktop";

const DesktopSelectContext = createContext(null);

const EMPTY = new Set();

export function DesktopSelectProvider({ children }) {
  const [selected, setSelected] = useState(() => new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const selectOnly = useCallback((id) => {
    const next = id ? new Set([id]) : new Set();
    selectedRef.current = next;
    setSelected(next);
  }, []);

  const selectIds = useCallback((ids) => {
    const next = new Set(ids.filter(Boolean));
    selectedRef.current = next;
    setSelected(next);
  }, []);

  const toggle = useCallback((id) => {
    const next = new Set(selectedRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedRef.current = next;
    setSelected(next);
  }, []);

  const clear = useCallback(() => {
    if (selectedRef.current.size === 0) return;
    selectedRef.current = new Set();
    setSelected(selectedRef.current);
  }, []);

  const isSelected = useCallback((id) => selected.has(id), [selected]);

  /**
   * Finder-style: pressing an unselected icon selects it (alone) first.
   * Cmd/Ctrl keeps the current set and adds this one. Returns the ids that
   * should ride along with the drag.
   */
  const prepareDrag = useCallback((id, event) => {
    const additive = !!(event?.metaKey || event?.ctrlKey);
    const cur = selectedRef.current;
    if (additive) {
      if (!cur.has(id)) {
        const next = new Set(cur);
        next.add(id);
        selectedRef.current = next;
        setSelected(next);
        return [...next];
      }
      return [...cur];
    }
    if (cur.has(id)) return [...cur];
    const next = new Set([id]);
    selectedRef.current = next;
    setSelected(next);
    return [id];
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.closest?.("input, textarea, [contenteditable=true]")) return;
      const desk = document.querySelector(DESKTOP_ROOT);
      if (!desk || desk.classList.contains("is-dimmed")) return;
      if (e.key === "Escape") {
        clear();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectIds(allDesktopIconIds(desk));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [clear, selectIds]);

  const value = useMemo(
    () => ({
      selected,
      selectedRef,
      isSelected,
      selectOnly,
      selectIds,
      toggle,
      clear,
      prepareDrag,
    }),
    [selected, isSelected, selectOnly, selectIds, toggle, clear, prepareDrag],
  );

  return (
    <DesktopSelectContext.Provider value={value}>{children}</DesktopSelectContext.Provider>
  );
}

const FALLBACK = {
  selected: EMPTY,
  selectedRef: { current: EMPTY },
  isSelected: () => false,
  selectOnly: () => {},
  selectIds: () => {},
  toggle: () => {},
  clear: () => {},
  prepareDrag: (id) => [id],
};

export function useDesktopSelect() {
  return useContext(DesktopSelectContext) || FALLBACK;
}

/* Icons are sized from the desktop's own dimensions rather than fixed pixels,
 * so the same arrangement reads the same on a laptop panel and a 32" display.
 * The variables are set on the desktop root — see desktopGrid. */
export const DESKTOP_ICON_ART_CLASS = "h-[var(--desk-art)] w-[var(--desk-art)]";

export function desktopIconClass(selected, { hot = false } = {}) {
  return [
    // touch-none: every icon is draggable, and the browser's own pan gesture
    // would otherwise steal the pointer part-way through a drag.
    "group absolute flex w-[var(--desk-tile)] touch-none flex-col items-center gap-1 rounded-2xl p-2 transition-colors",
    hot ? "bg-blue-500/35" : selected ? "bg-blue-500/40" : "hover:bg-white/10",
    selected ? "z-20" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function desktopIconLabelClass(selected) {
  return selected
    ? "max-w-full truncate rounded-md bg-blue-600 px-1.5 py-px text-[length:var(--desk-label)] font-medium text-white"
    : "max-w-full truncate text-[length:var(--desk-label)] font-medium text-white/90 [text-shadow:0_1px_3px_rgba(0,0,0,0.45)]";
}

export function desktopRootOf(el) {
  return el?.closest?.(DESKTOP_ROOT) || document.querySelector(DESKTOP_ROOT);
}

function iconElements(root) {
  return root ? [...root.querySelectorAll("[data-desktop-icon]")] : [];
}

export function allDesktopIconIds(root) {
  return iconElements(root).map((el) => el.getAttribute("data-desktop-icon"));
}

/** The icons in `ids`, in the order they appear on the desktop. */
export function desktopIconsFor(root, ids) {
  const want = ids instanceof Set ? ids : new Set(ids);
  return iconElements(root).filter((el) => want.has(el.getAttribute("data-desktop-icon")));
}

export function desktopFilePaths(root, ids) {
  return desktopIconsFor(root, ids)
    .map((el) => el.getAttribute("data-desktop-path"))
    .filter(Boolean);
}

/** Where each icon sits inside the desktop layer, right now. */
export function snapshotDesktopIcons(root, ids) {
  const bases = {};
  if (!root) return bases;
  const origin = root.getBoundingClientRect();
  for (const el of desktopIconsFor(root, ids)) {
    const r = el.getBoundingClientRect();
    bases[el.getAttribute("data-desktop-icon")] = {
      x: r.left - origin.left,
      y: r.top - origin.top,
    };
  }
  return bases;
}

export function shiftPositions(bases, dx, dy) {
  const positions = {};
  for (const [id, b] of Object.entries(bases || {})) {
    positions[id] = { x: b.x + dx, y: b.y + dy };
  }
  return positions;
}

export function hitDesktopIcons(root, box) {
  if (!root || !box) return [];
  const origin = root.getBoundingClientRect();
  const hits = [];
  for (const el of iconElements(root)) {
    const r = el.getBoundingClientRect();
    const ir = {
      x: r.left - origin.left,
      y: r.top - origin.top,
      w: r.width,
      h: r.height,
    };
    if (
      box.x < ir.x + ir.w &&
      box.x + box.w > ir.x &&
      box.y < ir.y + ir.h &&
      box.y + box.h > ir.y
    ) {
      hits.push(el.getAttribute("data-desktop-icon"));
    }
  }
  return hits;
}

export function moveDesktopGroup(positions, commit = false) {
  if (typeof window === "undefined" || !positions) return;
  window.dispatchEvent(
    new CustomEvent(DESKTOP_GROUP_MOVE_EVENT, { detail: { positions, commit } }),
  );
}

export function useDesktopGroupMove(handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const fn = (e) => handlerRef.current?.(e.detail || {});
    window.addEventListener(DESKTOP_GROUP_MOVE_EVENT, fn);
    return () => window.removeEventListener(DESKTOP_GROUP_MOVE_EVENT, fn);
  }, []);
}

export function normalizeBox(x0, y0, x1, y1) {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return { x, y, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}
