import React, { useMemo } from "react";
import type { WireConnection, WireSide } from "@/store/canvasStore";

type BlockRect = { x: number; y: number; width: number; height: number };

type ActiveWireDrag = {
  fromId: string;
  fromSide: WireSide;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  nearTarget?: { id: string; side: WireSide } | null;
};

type ConnectionWiresProps = {
  blocks: Record<string, BlockRect>;
  wireConnections: WireConnection[];
  activeDrag: ActiveWireDrag | null;
  surfaceWidth: number;
  surfaceHeight: number;
  onRemoveWire?: (id: string) => void;
};

function getAnchorPoint(block: BlockRect, side: WireSide) {
  switch (side) {
    case "top":
      return { x: block.x + block.width / 2, y: block.y };
    case "right":
      return { x: block.x + block.width, y: block.y + block.height / 2 };
    case "bottom":
      return { x: block.x + block.width / 2, y: block.y + block.height };
    case "left":
      return { x: block.x, y: block.y + block.height / 2 };
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

function getArrowPoints(
  to: { x: number; y: number },
  toSide: WireSide,
  size: number = 8
): string {
  const inward = { top: Math.PI / 2, right: Math.PI, bottom: -Math.PI / 2, left: 0 }[toSide];
  const angle = inward;
  const p1x = to.x + size * Math.cos(angle + 0.5);
  const p1y = to.y + size * Math.sin(angle + 0.5);
  const p2x = to.x + size * Math.cos(angle - 0.5);
  const p2y = to.y + size * Math.sin(angle - 0.5);
  return `${p1x},${p1y} ${to.x},${to.y} ${p2x},${p2y}`;
}

export default function ConnectionWires({
  blocks,
  wireConnections,
  activeDrag,
  surfaceWidth,
  surfaceHeight,
  onRemoveWire,
}: ConnectionWiresProps) {
  const persistedWires = useMemo(
    () =>
      wireConnections
        .map((wire) => {
          const fromBlock = blocks[wire.fromId];
          const toBlock = blocks[wire.toId];
          if (!fromBlock || !toBlock) return null;
          const from = getAnchorPoint(fromBlock, wire.fromSide);
          const to = getAnchorPoint(toBlock, wire.toSide);
          const path = buildBezierPath(from, to, wire.fromSide, wire.toSide);
          const arrowPts = getArrowPoints(to, wire.toSide);
          return { wire, path, from, to, arrowPts };
        })
        .filter(Boolean) as Array<{
        wire: WireConnection;
        path: string;
        from: { x: number; y: number };
        to: { x: number; y: number };
        arrowPts: string;
      }>,
    [wireConnections, blocks]
  );

  const dragPath = useMemo(() => {
    if (!activeDrag) return null;
    const { startX, startY, currentX, currentY, fromSide, nearTarget } = activeDrag;
    const from = { x: startX, y: startY };

    if (nearTarget) {
      const targetBlock = blocks[nearTarget.id];
      if (targetBlock) {
        const to = getAnchorPoint(targetBlock, nearTarget.side);
        return {
          path: buildBezierPath(from, to, fromSide, nearTarget.side),
          to,
          arrowPts: getArrowPoints(to, nearTarget.side),
          snapped: true,
        };
      }
    }

    const to = { x: currentX, y: currentY };
    return {
      path: buildDragPath(from, to, fromSide),
      to,
      arrowPts: null,
      snapped: false,
    };
  }, [activeDrag, blocks]);

  if (!persistedWires.length && !dragPath) return null;

  return (
    <svg
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

      {persistedWires.map(({ wire, path }) => (
        <g key={wire.id} className="pointer-events-auto" style={{ cursor: "pointer" }}>
          {/* Invisible wider hit area */}
          <path
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth={14}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onRemoveWire?.(wire.id);
            }}
          />
          <path
            d={path}
            fill="none"
            stroke="rgba(59,130,246,0.45)"
            strokeWidth={2}
            markerEnd="url(#wire-arrow)"
            style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.15))" }}
          />
        </g>
      ))}

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
