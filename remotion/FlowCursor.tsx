import type { CSSProperties } from "react";

export type Point = readonly [number, number];
export type CursorArc = { from: number; to: number; points: readonly [Point, Point, Point, Point] };

/** Screen-space cubic choreography. The cursor's rounded nose is its click hotspot. */
export const cursorPoint = (frame: number, arcs: readonly CursorArc[]): Point => {
  const arc = arcs.find((a) => frame <= a.to) ?? arcs[arcs.length - 1];
  const t = Math.max(0, Math.min(1, (frame - arc.from) / (arc.to - arc.from)));
  const u = 1 - t;
  const [a, b, c, d] = arc.points;
  return [u*u*u*a[0] + 3*u*u*t*b[0] + 3*u*t*t*c[0] + t*t*t*d[0],
    u*u*u*a[1] + 3*u*u*t*b[1] + 3*u*t*t*c[1] + t*t*t*d[1]];
};

export const FlowCursor: React.FC<{
  frame: number; arcs: readonly CursorArc[]; opacity: number; scale: number;
}> = ({ frame, arcs, opacity, scale }) => {
  const [x, y] = cursorPoint(frame, arcs);
  const before = cursorPoint(frame - 0.5, arcs);
  const after = cursorPoint(frame + 0.5, arcs);
  // Gentle banking follows velocity; the pointer stays recognizable, not a spinner.
  const bank = Math.max(-28, Math.min(28, (after[0] - before[0]) * 0.7 - (after[1] - before[1]) * 0.35));
  const style: CSSProperties = {
    position: "absolute", left: x - 8, top: y - 8, width: 48, height: 48,
    zIndex: 40, opacity, pointerEvents: "none", overflow: "visible",
    transform: `rotate(${bank}deg) scale(${scale})`, transformOrigin: "8px 8px",
    filter: "drop-shadow(0 2px 1px rgba(255,255,255,0.42)) drop-shadow(0 4px 5px rgba(0,0,0,0.15))",
  };
  return <svg viewBox="0 0 512 512" style={style} aria-label="Animated cursor">
    {/* Traced rounded, stemless silhouette from the supplied reference. */}
    <path d="M112 50 L425 134 C471 148 479 205 432 226 L288 288 L226 432 C205 479 148 471 134 425 L50 112 C40 74 74 40 112 50 Z" fill="#000000" />
  </svg>;
};
