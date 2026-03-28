import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WireConnection, WireSide } from "@/store/canvasStore";

type BlockRect = { x: number; y: number; width: number; height: number; data?: { brickScale?: number; [k: string]: any } };

type ActiveWireDrag = {
  fromId: string;
  fromSide: WireSide;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  nearTarget?: { id: string; side: WireSide } | null;
};

type LiveDragOffset = { ids: string[]; dx: number; dy: number } | null;

type ConnectionWiresProps = {
  blocks: Record<string, BlockRect>;
  wireConnections: WireConnection[];
  activeDrag: ActiveWireDrag | null;
  liveDragOffset?: LiveDragOffset;
  surfaceWidth: number;
  surfaceHeight: number;
  onRemoveWire?: (id: string) => void;
  onUpdateWire?: (id: string, patch: Partial<Omit<WireConnection, "id">>) => void;
};

const BASE_NODE_OUTSET = 13;
const HOVER_LINGER_MS = 400;

function getAnchorPoint(block: BlockRect, side: WireSide) {
  const outset = BASE_NODE_OUTSET;
  switch (side) {
    case "top":
      return { x: block.x + block.width / 2, y: block.y - outset };
    case "right":
      return { x: block.x + block.width + outset, y: block.y + block.height / 2 };
    case "bottom":
      return { x: block.x + block.width / 2, y: block.y + block.height + outset };
    case "left":
      return { x: block.x - outset, y: block.y + block.height / 2 };
  }
}

function getControlOffset(side: WireSide, distance: number) {
  const offset = Math.max(40, Math.min(distance * 0.4, 150));
  switch (side) {
    case "top":
      return { dx: 0, dy: -offset };
    case "right":
      return { dx: offset, dy: 0 };
    case "bottom":
      return { dx: 0, dy: offset };
    case "left":
      return { dx: -offset, dy: 0 };
  }
}

function buildBezierPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromSide: WireSide,
  toSide: WireSide
) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const c1 = getControlOffset(fromSide, dist);
  const c2 = getControlOffset(toSide, dist);
  return `M ${from.x} ${from.y} C ${from.x + c1.dx} ${from.y + c1.dy}, ${to.x + c2.dx} ${to.y + c2.dy}, ${to.x} ${to.y}`;
}

function buildPathWithControlPoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromSide: WireSide,
  toSide: WireSide,
  points: Array<{ x: number; y: number }>
): string {
  if (!points.length) return buildBezierPath(from, to, fromSide, toSide);

  const all = [from, ...points, to];
  const dist0 = Math.hypot(all[1].x - from.x, all[1].y - from.y);
  const c1 = getControlOffset(fromSide, dist0);
  let d = `M ${from.x} ${from.y}`;

  if (all.length === 3) {
    const mid = all[1];
    const distEnd = Math.hypot(to.x - mid.x, to.y - mid.y);
    const c2 = getControlOffset(toSide, distEnd);
    d += ` C ${from.x + c1.dx} ${from.y + c1.dy}, ${mid.x} ${mid.y}, ${mid.x} ${mid.y}`;
    d += ` C ${mid.x} ${mid.y}, ${to.x + c2.dx} ${to.y + c2.dy}, ${to.x} ${to.y}`;
    return d;
  }

  const first = all[1];
  d += ` C ${from.x + c1.dx} ${from.y + c1.dy}, ${first.x} ${first.y}, ${first.x} ${first.y}`;

  for (let i = 1; i < all.length - 2; i++) {
    const cur = all[i];
    const next = all[i + 1];
    const mx = (cur.x + next.x) / 2;
    const my = (cur.y + next.y) / 2;
    d += ` Q ${cur.x} ${cur.y}, ${mx} ${my}`;
  }

  const last = all[all.length - 2];
  const distEnd = Math.hypot(to.x - last.x, to.y - last.y);
  const c2 = getControlOffset(toSide, distEnd);
  d += ` C ${last.x} ${last.y}, ${to.x + c2.dx} ${to.y + c2.dy}, ${to.x} ${to.y}`;

  return d;
}

function buildDragPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromSide: WireSide
) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const c1 = getControlOffset(fromSide, dist);
  const cx2 = (from.x + to.x) / 2;
  const cy2 = (from.y + to.y) / 2;
  return `M ${from.x} ${from.y} C ${from.x + c1.dx} ${from.y + c1.dy}, ${cx2} ${cy2}, ${to.x} ${to.y}`;
}

function getPointOnPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromSide: WireSide,
  toSide: WireSide,
  t: number
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const c1 = getControlOffset(fromSide, dist);
  const c2 = getControlOffset(toSide, dist);
  const p0 = from;
  const p1 = { x: from.x + c1.dx, y: from.y + c1.dy };
  const p2 = { x: to.x + c2.dx, y: to.y + c2.dy };
  const p3 = to;
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

type CpDrag = {
  wireId: string;
  cpIndex: number;
  isNew: boolean;
  x: number;
  y: number;
};

export default function ConnectionWires({
  blocks,
  wireConnections,
  activeDrag,
  liveDragOffset,
  surfaceWidth,
  surfaceHeight,
  onRemoveWire,
  onUpdateWire,
}: ConnectionWiresProps) {
  const [hoveredWireId, setHoveredWireId] = useState<string | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cpDrag, setCpDrag] = useState<CpDrag | null>(null);
  const cpDragRef = useRef<CpDrag | null>(null);
  cpDragRef.current = cpDrag;

  const showWire = useCallback((id: string) => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    setHoveredWireId(id);
  }, []);

  const hideWire = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHoveredWireId(null);
      hoverTimerRef.current = null;
    }, HOVER_LINGER_MS);
  }, []);

  const dragSet = useMemo(
    () => (liveDragOffset ? new Set(liveDragOffset.ids) : null),
    [liveDragOffset]
  );

  const offsetBlock = useMemo(() => {
    if (!liveDragOffset || !dragSet) return (b: BlockRect, _id: string) => b;
    const { dx, dy } = liveDragOffset;
    return (b: BlockRect, id: string): BlockRect =>
      dragSet.has(id)
        ? { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height }
        : b;
  }, [liveDragOffset, dragSet]);

  const persistedWires = useMemo(
    () =>
      wireConnections
        .map((wire) => {
          const fromBlock = blocks[wire.fromId];
          const toBlock = blocks[wire.toId];
          if (!fromBlock || !toBlock) return null;
          const from = getAnchorPoint(offsetBlock(fromBlock, wire.fromId), wire.fromSide);
          const to = getAnchorPoint(offsetBlock(toBlock, wire.toId), wire.toSide);

          let cps = wire.controlPoints || [];
          if (cpDrag && cpDrag.wireId === wire.id) {
            cps = [...cps];
            if (cpDrag.isNew && cps.length === 0) {
              cps = [{ x: cpDrag.x, y: cpDrag.y }];
            } else if (cps[cpDrag.cpIndex]) {
              cps[cpDrag.cpIndex] = { x: cpDrag.x, y: cpDrag.y };
            }
          }

          const path = cps.length
            ? buildPathWithControlPoints(from, to, wire.fromSide, wire.toSide, cps)
            : buildBezierPath(from, to, wire.fromSide, wire.toSide);

          const midpoint = cps.length
            ? { x: cps[Math.floor(cps.length / 2)].x, y: cps[Math.floor(cps.length / 2)].y }
            : getPointOnPath(from, to, wire.fromSide, wire.toSide, 0.5);

          return { wire, path, from, to, cps, midpoint };
        })
        .filter(Boolean) as Array<{
        wire: WireConnection;
        path: string;
        from: { x: number; y: number };
        to: { x: number; y: number };
        cps: Array<{ x: number; y: number }>;
        midpoint: { x: number; y: number };
      }>,
    [wireConnections, blocks, offsetBlock, cpDrag]
  );

  const dragPath = useMemo(() => {
    if (!activeDrag) return null;
    const { startX, startY, currentX, currentY, fromSide, nearTarget } = activeDrag;
    const from = { x: startX, y: startY };

    if (nearTarget) {
      const targetBlock = blocks[nearTarget.id];
      if (targetBlock) {
        const to = getAnchorPoint(offsetBlock(targetBlock, nearTarget.id), nearTarget.side);
        return {
          path: buildBezierPath(from, to, fromSide, nearTarget.side),
          to,
          snapped: true,
        };
      }
    }

    const to = { x: currentX, y: currentY };
    return {
      path: buildDragPath(from, to, fromSide),
      to,
      snapped: false,
    };
  }, [activeDrag, blocks, offsetBlock]);

  useEffect(() => {
    if (!cpDrag) return;

    const onMove = (e: PointerEvent) => {
      const svgEl = document.querySelector("[data-wire-svg]") as SVGSVGElement | null;
      if (!svgEl) return;
      const ctm = svgEl.getScreenCTM();
      if (!ctm) return;
      const pt = svgEl.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const world = pt.matrixTransform(ctm.inverse());
      setCpDrag((prev) => prev ? { ...prev, x: world.x, y: world.y } : null);
    };

    const onUp = () => {
      const drag = cpDragRef.current;
      if (drag && onUpdateWire) {
        const wire = wireConnections.find((w) => w.id === drag.wireId);
        if (wire) {
          const cps = [...(wire.controlPoints || [])];
          if (drag.isNew && cps.length === 0) {
            cps.push({ x: drag.x, y: drag.y });
          } else if (cps[drag.cpIndex]) {
            cps[drag.cpIndex] = { x: drag.x, y: drag.y };
          }
          onUpdateWire(drag.wireId, { controlPoints: cps });
        }
      }
      setCpDrag(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [!!cpDrag, wireConnections, onUpdateWire]);

  const beginCpDrag = useCallback(
    (wireId: string, cpIndex: number, isNew: boolean, startX: number, startY: number, e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setCpDrag({ wireId, cpIndex, isNew, x: startX, y: startY });
    },
    []
  );

  if (!persistedWires.length && !dragPath) return null;

  return (
    <svg
      data-wire-svg
      className="absolute top-0 left-0 pointer-events-none"
      style={{ width: surfaceWidth, height: surfaceHeight, zIndex: 32, overflow: "visible" }}
    >
      <defs>
        <marker
          id="wire-arrow"
          markerWidth="10"
          markerHeight="8"
          refX="9"
          refY="4"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 0 0 L 10 4 L 0 8 Z" fill="rgba(59,130,246,0.7)" />
        </marker>
        <marker
          id="wire-arrow-hover"
          markerWidth="10"
          markerHeight="8"
          refX="9"
          refY="4"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 0 0 L 10 4 L 0 8 Z" fill="rgba(59,130,246,0.9)" />
        </marker>
        <marker
          id="wire-arrow-drag"
          markerWidth="10"
          markerHeight="8"
          refX="9"
          refY="4"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 0 0 L 10 4 L 0 8 Z" fill="rgba(59,130,246,0.5)" />
        </marker>
      </defs>

      {persistedWires.map(({ wire, path, from, to, cps, midpoint }) => {
        const isHovered = hoveredWireId === wire.id;
        return (
          <g key={wire.id} className="pointer-events-auto" style={{ cursor: "pointer" }}>
            {/* Wide invisible hit area */}
            <path
              d={path}
              fill="none"
              stroke="transparent"
              strokeWidth={18}
              onPointerEnter={() => showWire(wire.id)}
              onPointerLeave={hideWire}
            />
            {/* Visible wire */}
            <path
              d={path}
              fill="none"
              stroke={isHovered ? "rgba(59,130,246,0.8)" : "rgba(59,130,246,0.45)"}
              strokeWidth={isHovered ? 2.5 : 2}
              markerEnd={isHovered ? "url(#wire-arrow-hover)" : "url(#wire-arrow)"}
              style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.15))", transition: "stroke 0.15s, stroke-width 0.15s" }}
              pointerEvents="none"
            />

            {/* Hover controls */}
            {isHovered && (
              <>
                {/* Delete button near the start of the wire */}
                {(() => {
                  const delPt = getPointOnPath(from, to, wire.fromSide, wire.toSide, 0.12);
                  return (
                    <g
                      onPointerEnter={() => showWire(wire.id)}
                      onPointerLeave={hideWire}
                      style={{ cursor: "pointer" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveWire?.(wire.id);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <circle
                        cx={delPt.x}
                        cy={delPt.y}
                        r={9}
                        fill="rgba(239,68,68,0.85)"
                        stroke="white"
                        strokeWidth={1.5}
                        style={{ filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.3))" }}
                      />
                      <line
                        x1={delPt.x - 3} y1={delPt.y - 3}
                        x2={delPt.x + 3} y2={delPt.y + 3}
                        stroke="white" strokeWidth={2} strokeLinecap="round"
                        pointerEvents="none"
                      />
                      <line
                        x1={delPt.x + 3} y1={delPt.y - 3}
                        x2={delPt.x - 3} y2={delPt.y + 3}
                        stroke="white" strokeWidth={2} strokeLinecap="round"
                        pointerEvents="none"
                      />
                    </g>
                  );
                })()}

                {/* Existing control point handles */}
                {cps.map((cp, i) => (
                  <circle
                    key={`cp-${i}`}
                    cx={cp.x}
                    cy={cp.y}
                    r={6}
                    fill="rgba(59,130,246,0.7)"
                    stroke="white"
                    strokeWidth={2}
                    style={{ cursor: "grab", filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.25))" }}
                    onPointerEnter={() => showWire(wire.id)}
                    onPointerLeave={hideWire}
                    onPointerDown={(e) => beginCpDrag(wire.id, i, false, cp.x, cp.y, e)}
                  />
                ))}

                {/* Default midpoint handle when no control points exist */}
                {cps.length === 0 && (
                  <circle
                    cx={midpoint.x}
                    cy={midpoint.y}
                    r={6}
                    fill="rgba(59,130,246,0.5)"
                    stroke="white"
                    strokeWidth={2}
                    strokeDasharray="3 2"
                    style={{ cursor: "grab", filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.25))" }}
                    onPointerEnter={() => showWire(wire.id)}
                    onPointerLeave={hideWire}
                    onPointerDown={(e) => beginCpDrag(wire.id, 0, true, midpoint.x, midpoint.y, e)}
                  />
                )}
              </>
            )}
          </g>
        );
      })}

      {dragPath && (
        <g>
          <path
            d={dragPath.path}
            fill="none"
            stroke={dragPath.snapped ? "rgba(59,130,246,0.7)" : "rgba(59,130,246,0.4)"}
            strokeWidth={dragPath.snapped ? 2.5 : 2}
            strokeDasharray={dragPath.snapped ? "none" : "6 4"}
            markerEnd="url(#wire-arrow-drag)"
          />
          {!dragPath.snapped && (
            <circle
              cx={dragPath.to.x}
              cy={dragPath.to.y}
              r={5}
              fill="rgba(59,130,246,0.3)"
              stroke="rgba(59,130,246,0.6)"
              strokeWidth={1.5}
            />
          )}
        </g>
      )}
    </svg>
  );
}
