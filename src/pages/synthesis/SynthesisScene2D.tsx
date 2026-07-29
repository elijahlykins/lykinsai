import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Scene3DEdge, Scene3DNode } from "./SynthesisScene3D";
import { resolveGraphNodeColor } from "./graphColors";

export type { Scene3DEdge as Scene2DEdge, Scene3DNode as Scene2DNode };

const VIEW_STORAGE_KEY = "lykn.synthesis.viewMode";
export type SynthesisViewMode = "2d" | "3d";

export function readStoredViewMode(): SynthesisViewMode {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY);
    if (v === "3d" || v === "2d") return v;
  } catch {
    /* ignore */
  }
  return "2d";
}

export function storeViewMode(mode: SynthesisViewMode) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

interface Props {
  nodes: Scene3DNode[];
  edges: Scene3DEdge[];
  hoveredId: string | null;
  selectedId: string | null;
  highlightSet: Set<string>;
  isTopicMode: boolean;
  /** External zoom 0.15–3 — kept in sync with parent camera state. */
  zoom: number;
  resetSignal: number;
  focusNodeId: string | null;
  onHoverNode: (id: string | null) => void;
  onClickNode: (id: string) => void;
  onBackgroundClick: () => void;
  formingNodeId?: string | null;
  lockCamera?: boolean;
  linkSelectedIds?: Set<string>;
  focusedSet?: Set<string> | null;
  isLight?: boolean;
  onZoomChange?: (zoom: number) => void;
}

const LABEL_ZOOM_THRESHOLD = 1.15;
const MIN_ZOOM = 0.12;
const MAX_ZOOM = 4;

/** Obsidian-style: more connections → larger dot (sqrt so hubs grow gently). */
function nodeScreenRadius(node: Scene3DNode): number {
  const cc = Math.max(0, node.connectionCount || 0);
  const byConn = 7.5 + Math.sqrt(cc) * 2.2;
  if (node.kind === "root") return Math.max(18, Math.min(30, byConn + 5));
  if (node.kind === "category") return Math.max(14, Math.min(24, byConn + 3));
  return Math.max(7.5, Math.min(20, byConn));
}

function shouldShowLabel(
  node: Scene3DNode,
  zoom: number,
  hoveredId: string | null,
  selectedId: string | null,
): boolean {
  // While a node is selected, only that node (and hover) keeps a title.
  if (selectedId) {
    return node.id === selectedId || node.id === hoveredId;
  }
  if (node.kind === "root" || node.kind === "category") return true;
  if (node.id === hoveredId) return true;
  if (zoom >= LABEL_ZOOM_THRESHOLD && node.connectionCount >= 3) return true;
  if (zoom >= 1.8) return true;
  return false;
}

/** Stable-ish fingerprint of node positions so we re-fit after layout settles. */
function layoutFingerprint(nodes: Scene3DNode[]): string {
  if (!nodes.length) return "empty";
  let sx = 0;
  let sy = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const n of nodes) {
    sx += n.x;
    sy += n.y;
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
  }
  // Round so tiny force jitter doesn't thrash fit.
  return `${nodes.length}:${Math.round(sx / nodes.length)}:${Math.round(sy / nodes.length)}:${Math.round(maxX - minX)}`;
}

export default function SynthesisScene2D({
  nodes,
  edges,
  hoveredId,
  selectedId,
  highlightSet,
  isTopicMode,
  zoom: externalZoom,
  resetSignal,
  focusNodeId,
  onHoverNode,
  onClickNode,
  onBackgroundClick,
  formingNodeId = null,
  lockCamera = false,
  linkSelectedIds,
  focusedSet,
  isLight = false,
  onZoomChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Camera is owned here; parent `zoom` / onZoomChange stay in sync for chrome.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(() =>
    typeof externalZoom === "number" && externalZoom > 0 ? externalZoom : 1,
  );

  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  panRef.current = pan;
  zoomRef.current = zoom;

  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;

  const commitCamera = useCallback((p: { x: number; y: number }, z: number) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    panRef.current = p;
    zoomRef.current = clamped;
    setPan(p);
    setZoom(clamped);
    onZoomChangeRef.current?.(clamped);
  }, []);

  const dragRef = useRef<{
    active: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    originPanX: number;
    originPanY: number;
  }>({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    originPanX: 0,
    originPanY: 0,
  });

  const pinchRef = useRef<{
    active: boolean;
    startDist: number;
    startZoom: number;
  }>({ active: false, startDist: 0, startZoom: 1 });

  const nodeMap = useMemo(() => {
    const m = new Map<string, Scene3DNode>();
    nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [nodes]);

  const fitToView = useCallback(() => {
    const w = size.w;
    const h = size.h;
    if (w < 40 || h < 40) return;

    if (!nodes.length) {
      commitCamera({ x: w / 2, y: h / 2 }, zoomRef.current);
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    const gw = Math.max(maxX - minX, 120);
    const gh = Math.max(maxY - minY, 120);
    const pad = 0.72;
    const fitZ = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((w * pad) / gw, (h * pad) / gh)),
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    commitCamera({ x: w / 2 - cx * fitZ, y: h / 2 - cy * fitZ }, fitZ);
  }, [nodes, size.w, size.h, commitCamera]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setSize({ w, h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fittedFingerprintRef = useRef<string | null>(null);
  const userNavigatedRef = useRef(false);
  const layoutKey = layoutFingerprint(nodes);

  useEffect(() => {
    if (!nodes.length || size.w < 40 || size.h < 40) return;
    if (userNavigatedRef.current && fittedFingerprintRef.current != null) return;
    if (fittedFingerprintRef.current === layoutKey) return;
    fittedFingerprintRef.current = layoutKey;
    fitToView();
  }, [layoutKey, size.w, size.h, fitToView, nodes.length]);

  useEffect(() => {
    if (resetSignal === 0) return;
    userNavigatedRef.current = false;
    fittedFingerprintRef.current = null;
    fitToView();
    fittedFingerprintRef.current = layoutFingerprint(nodes);
  }, [resetSignal, fitToView, nodes]);

  /** Instant pan + zoom onto a node (no animation — keeps the graph stable). */
  const focusCameraOnNode = useCallback(
    (nodeId: string) => {
      const n = nodeMap.get(nodeId);
      if (!n || size.w < 40 || size.h < 40) return;
      userNavigatedRef.current = true;
      const z = Math.min(
        MAX_ZOOM,
        Math.max(
          n.kind === "root" || n.kind === "category" ? 1.6 : 2.0,
          zoomRef.current,
        ),
      );
      commitCamera(
        { x: size.w / 2 - n.x * z, y: size.h / 2 - n.y * z },
        z,
      );
    },
    [nodeMap, size.w, size.h, commitCamera],
  );

  // Deep-link / side-panel selection: jump camera once when selectedId changes.
  // Clearing selection (background click / deselect) returns to the default fit.
  const lastFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusNodeId) {
      if (lastFocusRef.current != null) {
        lastFocusRef.current = null;
        userNavigatedRef.current = true;
        fitToView();
      }
      return;
    }
    if (focusNodeId === lastFocusRef.current) return;
    lastFocusRef.current = focusNodeId;
    focusCameraOnNode(focusNodeId);
  }, [focusNodeId, focusCameraOnNode, fitToView]);

  const applyZoomAt = useCallback(
    (nextZoom: number, clientX: number, clientY: number) => {
      const el = containerRef.current;
      if (!el) return;
      userNavigatedRef.current = true;
      const rect = el.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const prevZ = zoomRef.current;
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
      const worldX = (mx - panRef.current.x) / prevZ;
      const worldY = (my - panRef.current.y) / prevZ;
      commitCamera({ x: mx - worldX * z, y: my - worldY * z }, z);
    },
    [commitCamera],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (lockCamera) return;
      e.preventDefault();
      e.stopPropagation();
      const intensity =
        e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 0.2 : 0.0015;
      const factor = Math.exp(-e.deltaY * intensity);
      applyZoomAt(zoomRef.current * factor, e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [lockCamera, applyZoomAt]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (lockCamera) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const d = dragRef.current;
      d.active = true;
      d.moved = false;
      d.startX = e.clientX;
      d.startY = e.clientY;
      d.originPanX = panRef.current.x;
      d.originPanY = panRef.current.y;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [lockCamera],
  );

  const handleNodePointerDown = useCallback((e: ReactPointerEvent) => {
    e.stopPropagation();
    dragRef.current.active = false;
    dragRef.current.moved = false;
    dragRef.current.startX = e.clientX;
    dragRef.current.startY = e.clientY;
  }, []);

  const handleNodePointerUp = useCallback(
    (e: ReactPointerEvent, nodeId: string) => {
      e.stopPropagation();
      const d = dragRef.current;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) + Math.abs(dy) > 6) return;
      // Mark so the focusNodeId effect doesn't jump again after select.
      lastFocusRef.current = nodeId;
      focusCameraOnNode(nodeId);
      onClickNode(nodeId);
    },
    [focusCameraOnNode, onClickNode],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const d = dragRef.current;
      if (!d.active || lockCamera) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        d.moved = true;
        userNavigatedRef.current = true;
      }
      const nextPan = { x: d.originPanX + dx, y: d.originPanY + dy };
      panRef.current = nextPan;
      setPan(nextPan);
    },
    [lockCamera],
  );

  const onPointerUp = useCallback(() => {
    const d = dragRef.current;
    if (!d.active) return;
    const wasDrag = d.moved;
    d.active = false;
    // Node clicks stopPropagation, so a non-drag pointerUp on the
    // container always means empty space. (Don't key off data-bg — with
    // pointer capture the event target is often the container, not the
    // rect, so the old check silently failed.)
    if (!wasDrag) {
      const hadFocus = lastFocusRef.current != null || selectedId != null;
      lastFocusRef.current = null;
      onBackgroundClick();
      if (hadFocus) {
        userNavigatedRef.current = true;
        fitToView();
      }
    }
  }, [onBackgroundClick, fitToView, selectedId]);

  // Pinch zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const dist = (a: Touch, b: Touch) => {
      const dx = a.clientX - b.clientX;
      const dy = a.clientY - b.clientY;
      return Math.hypot(dx, dy);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinchRef.current = {
          active: true,
          startDist: dist(e.touches[0], e.touches[1]),
          startZoom: zoomRef.current,
        };
        dragRef.current.active = false;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!pinchRef.current.active || e.touches.length !== 2) return;
      e.preventDefault();
      const d = dist(e.touches[0], e.touches[1]);
      const ratio = d / Math.max(pinchRef.current.startDist, 1);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      applyZoomAt(pinchRef.current.startZoom * ratio, midX, midY);
    };
    const onTouchEnd = () => {
      if (pinchRef.current.active) pinchRef.current.active = false;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [applyZoomAt]);

  const hasFocusFilter = !!(focusedSet && focusedSet.size > 0);
  const hasHighlight = highlightSet.size > 0;
  const hasLinkSel = !!(linkSelectedIds && linkSelectedIds.size > 0);
  const hasSelection = !!selectedId;

  // Light mode: every connector is the same light grey.
  const edgeStroke = isLight ? "rgba(180,180,180,0.85)" : "rgba(220,220,230,0.18)";
  const crossStroke = isLight ? "rgba(180,180,180,0.85)" : "rgba(200,200,210,0.10)";
  const provenanceStroke = isLight ? "rgba(180,180,180,0.85)" : "rgba(165,180,252,0.55)";
  const userLinkStroke = isLight ? "rgba(180,180,180,0.85)" : "rgba(96,165,250,0.75)";
  const labelFill = isLight ? "rgba(28,28,30,0.88)" : "rgba(245,245,247,0.88)";
  const labelHalo = isLight ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.65)";

  const svgW = size.w || "100%";
  const svgH = size.h || "100%";
  const worldTransform = `translate(${pan.x}, ${pan.y}) scale(${zoom})`;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 touch-none"
      style={{ cursor: dragRef.current.active ? "grabbing" : "grab" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <svg width={svgW} height={svgH} className="absolute inset-0 block w-full h-full">
        <rect
          data-bg="1"
          x={0}
          y={0}
          width={size.w || 1}
          height={size.h || 1}
          fill="transparent"
        />
        <g transform={worldTransform}>
          {edges.map((e) => {
            const a = nodeMap.get(e.from);
            const b = nodeMap.get(e.to);
            if (!a || !b) return null;

            const aFocused = !hasFocusFilter || focusedSet!.has(a.id);
            const bFocused = !hasFocusFilter || focusedSet!.has(b.id);
            const touchesSelection =
              !hasSelection ||
              e.from === selectedId ||
              e.to === selectedId;
            const edgeDimmed =
              !touchesSelection ||
              (hasFocusFilter && !(aFocused && bFocused)) ||
              (hasHighlight && !(highlightSet.has(a.id) && highlightSet.has(b.id))) ||
              (isTopicMode && (a.relevance < 0.25 || b.relevance < 0.25));

            const isFormingEdge =
              formingNodeId != null &&
              (e.to === formingNodeId || e.from === formingNodeId);

            let stroke = e.cross ? crossStroke : edgeStroke;
            let width = e.cross ? 0.7 : 0.9;
            let opacity = edgeDimmed ? (hasSelection ? 0.08 : 0.12) : 1;
            if (e.provenance) {
              stroke = provenanceStroke;
              width = 1.15;
              opacity = edgeDimmed ? 0.15 : 0.95;
            }
            if (e.userLink) {
              stroke = userLinkStroke;
              width = 1.35;
              opacity = edgeDimmed ? 0.15 : 1;
            }
            if (isFormingEdge) {
              stroke = isLight ? "rgba(180,180,180,0.95)" : "#60a5fa";
              width = 1.6;
              opacity = 1;
            }

            return (
              <line
                key={`${e.from}__${e.to}${e.provenance ? "_p" : ""}${e.userLink ? "_u" : ""}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={stroke}
                strokeWidth={width / Math.max(zoom, 0.4)}
                opacity={opacity}
                strokeLinecap="round"
              />
            );
          })}

          {nodes.map((n) => {
            const r = nodeScreenRadius(n);
            const fill = resolveGraphNodeColor(
              n.kind,
              n.color,
              isLight,
              n.kind === "category" ? n.id : null,
            );
            const isHovered = hoveredId === n.id;
            const isSelected = selectedId === n.id;
            const isLinkSel = hasLinkSel && linkSelectedIds!.has(n.id);
            const inFocus = !hasFocusFilter || focusedSet!.has(n.id);
            const inHighlight = !hasHighlight || highlightSet.has(n.id);
            const topicDim =
              isTopicMode &&
              n.relevance < 0.25 &&
              n.kind !== "root" &&
              n.kind !== "category";
            const isDimmed =
              (hasSelection
                ? !isSelected && !isHovered
                : !inFocus || !inHighlight || topicDim) &&
              !isSelected &&
              !isHovered;
            const isForming = formingNodeId === n.id;
            const showLabel = shouldShowLabel(n, zoom, hoveredId, selectedId);

            const scale =
              isForming ? 0.55 : isHovered || isSelected || isLinkSel ? 1.2 : 1;
            const opacity = isSelected
              ? 1
              : isDimmed
                ? hasSelection
                  ? 0.12
                  : 0.22
                : isForming
                  ? 0.7
                  : 1;
            const stroke =
              isSelected || isLinkSel
                ? isLight
                  ? "rgba(37,99,235,0.9)"
                  : "rgba(147,197,253,0.95)"
                : isHovered
                  ? isLight
                    ? "rgba(0,0,0,0.35)"
                    : "rgba(255,255,255,0.55)"
                  : "transparent";

            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                opacity={opacity}
                style={{ cursor: "pointer" }}
                onPointerEnter={(ev) => {
                  ev.stopPropagation();
                  onHoverNode(n.id);
                }}
                onPointerLeave={(ev) => {
                  ev.stopPropagation();
                  onHoverNode(null);
                }}
                onPointerDown={handleNodePointerDown}
                onPointerUp={(ev) => handleNodePointerUp(ev, n.id)}
              >
                {(n.kind === "category" ||
                  n.kind === "root" ||
                  isSelected ||
                  isLinkSel) && (
                  <circle
                    r={(r + 4) * scale}
                    fill={fill}
                    opacity={isLight ? 0.18 : 0.22}
                  />
                )}
                <circle
                  r={r * scale}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={
                    (isSelected || isLinkSel ? 2.2 : 1.2) / Math.max(zoom, 0.5)
                  }
                />
                {showLabel && (
                  <text
                    x={0}
                    y={-(r * scale + 6)}
                    textAnchor="middle"
                    fill={labelFill}
                    fontSize={Math.max(
                      9,
                      Math.min(12, 11 / Math.sqrt(Math.max(zoom, 0.5))),
                    )}
                    style={{
                      paintOrder: "stroke",
                      stroke: labelHalo,
                      strokeWidth: 3,
                      strokeLinejoin: "round",
                      pointerEvents: "none",
                      fontFamily:
                        'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
                      fontWeight:
                        n.kind === "category" || n.kind === "root" || isSelected
                          ? 600
                          : 500,
                    }}
                  >
                    {n.label.length > 42 ? `${n.label.slice(0, 40)}…` : n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
