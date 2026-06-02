import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import NeuronPanel from "@/components/synthesis/NeuronPanel";
import { simulateLayout } from "@/pages/synthesis/layoutEngine";
import type { SimNode } from "@/pages/synthesis/layoutTypes";
import {
  buildTourPreviewGraph,
  nudgeTourPreviewChatsTowardCenter,
} from "@/pages/synthesis/tourPreviewGraph";
import {
  WAKE_SYNTHESIS_ADD_MENU,
  WAKE_WALKTHROUGH_GATE_TEXT,
  WAKE_WALKTHROUGH_GATED_KEYS,
  type WakeAddMenuKey,
} from "@/components/wake/wakeSynthesisAddMenu";

const SynthesisScene3D = lazy(() => import("@/pages/synthesis/SynthesisScene3D"));

interface WakeSynthesisTourPreviewProps {
  /** False while the slide is pre-mounted off-screen; full scene quality when true. */
  active?: boolean;
}

export default function WakeSynthesisTourPreview({
  active = true,
}: WakeSynthesisTourPreviewProps) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ w: 0, h: 0 });
  const [simNodes, setSimNodes] = useState<SimNode[]>([]);
  const [sceneReady, setSceneReady] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [walkthroughGateOpen, setWalkthroughGateOpen] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => buildTourPreviewGraph(), []);
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const selectedNode = selectedId ? nodeMap.get(selectedId) ?? null : null;
  const highlightSet = useMemo(() => {
    if (!hoveredNode) return new Set<string>();
    const s = new Set<string>();
    s.add(hoveredNode);
    edges.forEach((e) => {
      if (e.from === hoveredNode) s.add(e.to);
      if (e.to === hoveredNode) s.add(e.from);
    });
    return s;
  }, [hoveredNode, edges]);

  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;

    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        setDimensions({ w, h });
      }
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (dimensions.w <= 0 || dimensions.h <= 0) return;
    try {
      const cx = dimensions.w / 2;
      const cy = dimensions.h / 2;
      const laidOut = nudgeTourPreviewChatsTowardCenter(
        simulateLayout(nodes, edges, cx, cy, "connections", null),
      );
      setSimNodes(laidOut);
      setSceneReady(laidOut.length > 0);
    } catch {
      setSimNodes([]);
      setSceneReady(false);
    }
  }, [nodes, edges, dimensions.w, dimensions.h]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (addMenuRef.current?.contains(e.target as Node)) return;
      setAddMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [addMenuOpen]);

  const noop = () => {};

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      const node = nodeMap.get(nodeId);
      if (!node || node.kind !== "category") return;
      setSelectedId((prev) => (prev === nodeId ? null : nodeId));
    },
    [nodeMap],
  );

  const handleBackgroundClick = useCallback(() => {
    setHoveredNode(null);
    setSelectedId(null);
  }, []);

  const handleMenuSelect = (key: WakeAddMenuKey) => {
    setAddMenuOpen(false);
    if (WAKE_WALKTHROUGH_GATED_KEYS.has(key)) {
      setWalkthroughGateOpen(true);
    }
  };

  return (
    <div className="lykn-wake-synth-preview">
      <div ref={sceneRef} className="lykn-wake-synth-preview-scene">
        <div
          aria-hidden
          className="lykn-wake-synth-preview-spotlight pointer-events-none absolute inset-0"
        />
        <div
          aria-hidden
          className="lykn-wake-synth-preview-grid pointer-events-none absolute inset-0"
        />

        <div className="lykn-wake-synth-preview-header pointer-events-none">
          <h2 className="lykn-wake-synth-preview-title">Synthesis Layer</h2>
        </div>

        <div className="lykn-wake-synth-preview-stats pointer-events-none">
          <span>0 chats</span>
          <span className="lykn-wake-synth-preview-stats-divider" aria-hidden />
          <span>0 notes</span>
        </div>

        <div
          className={`lykn-wake-synth-preview-canvas transition-opacity duration-700 ease-out ${
            sceneReady ? "opacity-100" : "opacity-0"
          }`}
        >
          {sceneReady && (
            <Suspense fallback={null}>
              <SynthesisScene3D
                key={active ? "wake-synth-full" : "wake-synth-lite"}
                nodes={simNodes}
                edges={edges}
                hoveredId={hoveredNode}
                selectedId={selectedId}
                highlightSet={highlightSet}
                isTopicMode={false}
                zoom={1}
                resetSignal={0}
                focusNodeId={selectedId}
                onHoverNode={setHoveredNode}
                onClickNode={handleNodeClick}
                onBackgroundClick={handleBackgroundClick}
                autoRotate={active && !selectedId}
                litePreview={!active}
              />
            </Suspense>
          )}
        </div>

        {!sceneReady && (
          <div className="lykn-wake-synth-preview-loading" aria-hidden />
        )}

        <div ref={addMenuRef} className="lykn-wake-synth-preview-add">
          {!addMenuOpen && !walkthroughGateOpen && (
            <span aria-hidden className="lykn-wake-synth-preview-add-ring pointer-events-none" />
          )}
          <button
            type="button"
            onClick={() => {
              setWalkthroughGateOpen(false);
              setAddMenuOpen((open) => !open);
            }}
            className={`lykn-wake-synth-preview-add-btn backdrop-blur transition-colors ${
              addMenuOpen
                ? "lykn-wake-synth-preview-add-btn-open"
                : "hover:bg-white/12 hover:border-white/25"
            }`}
            title="See neuron types you can build"
            aria-label="See neuron types you can build"
            aria-expanded={addMenuOpen}
          >
            <Plus className="w-5 h-5" strokeWidth={2.1} />
          </button>

          {addMenuOpen && (
            <div
              className="lykn-wake-synth-add-menu"
              role="menu"
              aria-label="Neuron types"
            >
              {WAKE_SYNTHESIS_ADD_MENU.map((item, idx, arr) => (
                <div key={item.key}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => handleMenuSelect(item.key)}
                    className="lykn-wake-synth-add-menu-item"
                  >
                    <item.Icon
                      size={13}
                      className="mt-0.5 text-white/85 flex-shrink-0"
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <div className="text-[0.72rem] font-medium text-white">
                        {item.label}
                      </div>
                      <div className="text-[0.62rem] text-white/55 mt-0.5 leading-snug">
                        {item.blurb}
                      </div>
                    </div>
                  </button>
                  {idx < arr.length - 1 ? (
                    <div
                      className={
                        item.divider
                          ? "h-px bg-white/25 mx-0"
                          : "h-px bg-white/12 mx-0"
                      }
                      aria-hidden
                    />
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {walkthroughGateOpen && (
          <div
            className="lykn-wake-synth-gate-backdrop"
            role="presentation"
            onClick={() => setWalkthroughGateOpen(false)}
          >
            <div
              className="lykn-wake-synth-gate-card"
              role="alertdialog"
              aria-label="Walkthrough required"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="lykn-wake-synth-gate-text">{WAKE_WALKTHROUGH_GATE_TEXT}</p>
            </div>
          </div>
        )}

        <NeuronPanel
          embedded
          open={Boolean(selectedNode)}
          node={selectedNode}
          allNodes={nodes}
          edges={edges}
          onClose={() => setSelectedId(null)}
          onSelectNode={setSelectedId}
        />
      </div>
    </div>
  );
}
