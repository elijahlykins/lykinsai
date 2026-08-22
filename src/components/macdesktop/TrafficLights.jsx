import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Shared macOS traffic lights — every app window, chromeless page, split pane,
 * and preview uses this cluster so the dots, glyphs, spacing, and green-button
 * menu are identical.
 *
 * 12px dots, 8px gap, glyphs on cluster hover, green click zooms, hover ~350ms
 * opens Fill / Tile Left / Tile Right / Quadrants. The menu is portaled so a
 * window's overflow and transform can't clip or mis-place it.
 */

export const TRAFFIC_GLYPH = {
  close: "M2 2 L8 8 M8 2 L2 8",
  min: "M2 5 H8",
  zoom: "M2.5 7.5 L7.5 2.5 M3 3 H7 V7",
};

export const TRAFFIC_COLOR = {
  close: "#ff5f57",
  min: "#febc2e",
  zoom: "#28c840",
};

const GLYPH_CLASS =
  "h-2 w-2 opacity-0 transition-opacity group-hover/traffic:opacity-60";

export function TrafficLight({ color, label, glyph, onClick }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className="flex h-3 w-3 flex-shrink-0 cursor-default items-center justify-center rounded-full transition-transform active:scale-90"
      style={{ background: color }}
    >
      <svg
        viewBox="0 0 10 10"
        className={GLYPH_CLASS}
        stroke="rgba(0,0,0,0.75)"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      >
        <path d={glyph} />
      </svg>
    </button>
  );
}

export function ZoomTrafficLight({
  zoomed = false,
  title = "Window",
  onZoom,
  onTileLeft,
  onTileRight,
  onTileQuad,
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const timer = useRef(0);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const hasTiles = !!(onTileLeft || onTileRight || onTileQuad);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const btn = btnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const width = 248;
      const left = Math.min(
        window.innerWidth - width - 8,
        Math.max(8, r.left),
      );
      const top = r.bottom + 6;
      setPos({ top, left });
    };
    place();
    const onDown = (e) => {
      const t = e.target;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  const arm = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 350);
  };
  const disarm = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 180);
  };

  const pick = (fn) => (e) => {
    e.stopPropagation();
    setOpen(false);
    fn?.();
  };

  const menu = open ? (
    <div
      ref={menuRef}
      role="menu"
      className="lykn-zoom-tile-menu fixed z-[400] w-[15.5rem] rounded-xl py-1"
      style={{ top: pos.top, left: pos.left }}
      onMouseEnter={() => {
        clearTimeout(timer.current);
      }}
      onMouseLeave={disarm}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button type="button" role="menuitem" onClick={pick(onZoom)} className="lykn-zoom-tile-item">
        {zoomed ? "Restore" : "Fill Desktop"}
      </button>
      {onTileLeft && (
        <button type="button" role="menuitem" onClick={pick(onTileLeft)} className="lykn-zoom-tile-item">
          Tile Window to Left of Screen
        </button>
      )}
      {onTileRight && (
        <button type="button" role="menuitem" onClick={pick(onTileRight)} className="lykn-zoom-tile-item">
          Tile Window to Right of Screen
        </button>
      )}
      {onTileQuad && (
        <button type="button" role="menuitem" onClick={pick(onTileQuad)} className="lykn-zoom-tile-item">
          Tile Windows in Quadrants
        </button>
      )}
    </div>
  ) : null;

  return (
    <div
      className="relative"
      onMouseEnter={arm}
      onMouseLeave={disarm}
    >
      <button
        ref={btnRef}
        type="button"
        title={zoomed ? `Restore ${title}` : `Zoom ${title}`}
        aria-label={zoomed ? `Restore ${title}` : `Zoom ${title}`}
        aria-haspopup={hasTiles ? "menu" : undefined}
        aria-expanded={open || undefined}
        onClick={() => {
          clearTimeout(timer.current);
          setOpen(false);
          onZoom?.();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="flex h-3 w-3 flex-shrink-0 cursor-default items-center justify-center rounded-full transition-transform active:scale-90"
        style={{ background: TRAFFIC_COLOR.zoom }}
      >
        <svg
          viewBox="0 0 10 10"
          className={GLYPH_CLASS}
          stroke="rgba(0,0,0,0.75)"
          strokeWidth="1.4"
          strokeLinecap="round"
          fill="none"
        >
          <path d={TRAFFIC_GLYPH.zoom} />
        </svg>
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}

export default function TrafficLights({
  title = "Window",
  zoomed = false,
  closeLabel,
  minLabel,
  zoomLabel,
  onClose,
  onMinimize,
  onZoom,
  onTileLeft,
  onTileRight,
  onTileQuad,
  padded = false,
  className = "",
  drag,
}) {
  return (
    <div
      className={`group/traffic relative z-20 flex flex-shrink-0 touch-none select-none items-center gap-2 ${
        padded ? "px-[14px] pb-[10px] pt-[14px]" : ""
      } ${className}`}
      {...(drag || {})}
    >
      <TrafficLight
        color={TRAFFIC_COLOR.close}
        label={closeLabel || `Close ${title}`}
        onClick={onClose}
        glyph={TRAFFIC_GLYPH.close}
      />
      <TrafficLight
        color={TRAFFIC_COLOR.min}
        label={minLabel || `Minimize ${title}`}
        onClick={onMinimize}
        glyph={TRAFFIC_GLYPH.min}
      />
      <ZoomTrafficLight
        zoomed={zoomed}
        title={zoomLabel || title}
        onZoom={onZoom}
        onTileLeft={onTileLeft}
        onTileRight={onTileRight}
        onTileQuad={onTileQuad}
      />
    </div>
  );
}
