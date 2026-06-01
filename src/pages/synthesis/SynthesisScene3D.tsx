/* eslint-disable react/no-unknown-property */
// react/no-unknown-property fires on every R3F `position`, `args`, `attach`,
// etc. — those are valid props for fiber primitives. Disable for this file.

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";

// Detect any touch-capable input device (phones, tablets, hybrid laptops
// with touchscreens). Used to enable OrbitControls' built-in pinch-zoom
// gesture, which is grouped behind the same `enableZoom` flag as wheel
// zoom — so the existing page-level wheel handler that drives external
// zoom on desktop has to coexist with native pinch on touch.
function useIsTouchDevice() {
  const [isTouch, setIsTouch] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(any-pointer: coarse)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(any-pointer: coarse)");
    const onChange = () => setIsTouch(mql.matches);
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else mql.removeListener(onChange);
    };
  }, []);
  return isTouch;
}

/* ------------------------------------------------------------------ */
/*  Shape contracts (mirror SynthesisLayer.tsx — kept loose to avoid   */
/*  cross-importing the parent's types and creating a circular dep)    */
/* ------------------------------------------------------------------ */

export interface Scene3DNode {
  id: string;
  label: string;
  kind:
    | "root"
    | "category"
    | "grid"
    | "vault"
    | "tag"
    | "neuron"
    | "belief"
    | "concept"
    | "perspective"
    | "project";
  color: string;
  glow: string;
  radius: number;
  x: number;
  y: number;
  z: number;
  connectionCount: number;
  relevance: number;
}

export interface Scene3DEdge {
  from: string;
  to: string;
  cross?: boolean;
  /**
   * Provenance overlay: edge came from the belief→fact→source RPC
   * pass, not the heuristic theme/tag cross-edges. Rendered with a
   * distinct indigo tint + higher base opacity so the "web of
   * beliefs" reads even when the underlying provenance is sparse.
   */
  provenance?: boolean;
  /**
   * User-authored cross-link from the "Link neurons" mode. Rendered
   * in a brighter blue accent at higher opacity so the user can spot
   * the threads they wired themselves amongst the AI-inferred web.
   */
  userLink?: boolean;
}

interface Props {
  nodes: Scene3DNode[];
  edges: Scene3DEdge[];
  hoveredId: string | null;
  selectedId: string | null;
  highlightSet: Set<string>;
  isTopicMode: boolean;
  /** External zoom 0.15-3 — drives camera dolly & a uniform scene scale. */
  zoom: number;
  /** Imperative reset signal: bumping this number recenters the camera. */
  resetSignal: number;
  /**
   * Node id to fly the camera to. When this changes, the orbit pivot lerps
   * to that node's world position and the camera follows by the same delta
   * (so the user's current viewing angle is preserved). Used by the side
   * panel's "click a connection" UX so clicking a related neuron actually
   * shows the user where it lives in the 3D cloud.
   */
  focusNodeId: string | null;
  onHoverNode: (id: string | null) => void;
  onClickNode: (id: string) => void;
  onBackgroundClick: () => void;
  /**
   * Prototype handoff: id of a neuron node that should "form" rather than
   * render in place. When set, the edge from its parent category draws in
   * over ~800ms (electric blue), then the neuron scales from 0 → 1 over
   * the next ~600ms. After ~1500ms the parent should set this back to
   * null and trigger camera focus separately.
   */
  formingNodeId?: string | null;
  /**
   * Optional override for the camera-to-target distance used when focusing
   * on a single node. Lower = camera pulls in closer. Used by the landing
   * prototype handoff so the brand-new neuron really fills the screen.
   * When unset, the scene uses the default `NEURON_FOCUS_DISTANCE`.
   */
  focusDistanceOverride?: number | null;
  /**
   * When true, OrbitControls is disabled entirely — the camera is locked
   * on whatever the focus target is and won't respond to drag/pan/wheel.
   * Used by the landing prototype handoff so the user can hover/click
   * their freshly-formed neuron without the click-and-tiny-mouse-move
   * triggering an orbit gesture (which otherwise reads as the neuron
   * "moving away from the cursor").
   */
  lockCamera?: boolean;
  /**
   * When true, OrbitControls slowly auto-orbits the scene for the
   * synthesis-layer tour intro. See CameraControllerProps.autoRotate.
   */
  autoRotate?: boolean;
  /**
   * Set of node IDs currently in the user's "Link neurons" selection.
   * When non-empty the scene paints those nodes with a brighter
   * emissive boost so the user can see which neurons they've picked
   * across the cloud — otherwise link mode has no visual feedback
   * beyond the floating action bar's count. Empty (or omitted) means
   * we render exactly as before.
   */
  linkSelectedIds?: Set<string>;
  /**
   * Set of node IDs that should "glow" against a dimmed background.
   * Driven by the synthesis-layer filter dropdown — currently only
   * the "By Project" filter, but designed as a general-purpose
   * focus channel so future filters (saved searches, "my notes
   * from this week", …) can reuse the same render path.
   *
   * Behaviour when the set is non-empty:
   *   • members get the same emissive boost as a link-mode selection
   *     so they brighten against the rest of the cloud,
   *   • non-members get isDimmed=true (~0.35 emissive, ~0.18 opacity)
   *     so they recede instead of competing for the user's eye.
   *   • edges where BOTH endpoints are members render bright; any
   *     edge with a non-member endpoint is dimmed alongside it.
   *
   * Empty / undefined / null → no filter applied; identical to the
   * pre-filter render. We accept null too because react-query's
   * loading state often reads as "not yet known."
   */
  focusedSet?: Set<string> | null;
  /**
   * Landing walkthrough mini preview: skip the Bloom post-process pass
   * and cap DPR at 1 so we don't stack a heavy GPU pipeline on top of
   * three live app iframes in the same tab (Chrome error code 5 OOM).
   */
  litePreview?: boolean;
}

/* ------------------------------------------------------------------ */
/*  World coords come from a 2D simulation centred on (cx, cy) ≈       */
/*  (dimensions.w/2, dimensions.h/2). Translating by (-cx, -cy, 0) at  */
/*  scene-mount time recentres the graph at world origin.              */
/* ------------------------------------------------------------------ */

function useGraphCentroid(nodes: Scene3DNode[]) {
  return useMemo(() => {
    if (!nodes.length) return [0, 0, 0] as const;
    let sx = 0, sy = 0, sz = 0;
    for (const n of nodes) { sx += n.x; sy += n.y; sz += n.z; }
    return [sx / nodes.length, sy / nodes.length, sz / nodes.length] as const;
  }, [nodes]);
}

/* ------------------------------------------------------------------ */
/*  Glowing neuron — single emissive core sphere. The soft halo around */
/*  each node is produced entirely by the Bloom postprocess on the     */
/*  parent <Canvas>: bright (high-luminance) pixels bleed into their   */
/*  neighbors after the scene is rendered, which gives the "neuron     */
/*  glow" without us having to draw a translucent outer ball per node. */
/* ------------------------------------------------------------------ */

interface NeuronProps {
  node: Scene3DNode;
  isHovered: boolean;
  isSelected: boolean;
  isDimmed: boolean;
  isTopicMode: boolean;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
  /**
   * If true, this neuron is in the user's current "Link neurons"
   * selection. Boosts the emissive multiplier so the node visibly
   * brightens against the rest of the cloud while link mode is on.
   */
  isLinkSelected?: boolean;
  /**
   * If true, this neuron is being "formed" — start with scale 0 and animate
   * up to 1 only AFTER the leading edge finishes drawing. The delay matches
   * the edge animation's duration in `Edge`.
   */
  isForming?: boolean;
}

const NEURON_FORMATION_DELAY_S = 0.8;
const NEURON_FORMATION_DURATION_S = 0.6;

function Neuron({ node, isHovered, isSelected, isDimmed, isTopicMode, onHover, onClick, isLinkSelected = false, isForming = false }: NeuronProps) {
  const groupRef = useRef<THREE.Group>(null);
  const coreMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const formStartRef = useRef<number | null>(null);
  // Smoothly-tracked hover/dim multipliers. Stepping straight to the
  // target each frame (the previous behavior) caused the bloom post-pass
  // to flash whenever a hovered neuron snapped from 1.0 → 1.4 emissive
  // (and every other neuron snapped 1.0 → 0.35). Lerping these here
  // turns each hover into a soft ~80ms fade instead of a hard flash.
  const hoverMulRef = useRef(1);
  const dimMulRef = useRef(1);

  // Map kind → base emissive intensity. Neurons (the "AI Learned" pink nodes)
  // glow brightest by design; root + category get strong glows; vault notes
  // and tags are softer so the neurons read as the "alive" elements. Bloom
  // turns these intensities into the actual visible halo.
  const glowConfig = useMemo(() => {
    switch (node.kind) {
      case "neuron":   return { emissive: 2.6, pulse: true };
      // Beliefs are the higher-order tier — they should READ as "lit from
      // within" before anything else in the scene. Bumped well above neurons
      // so even at low DPR / weak bloom the principles look like the
      // brightest things in the room.
      case "belief":   return { emissive: 3.6, pulse: true };
      case "root":     return { emissive: 2.2, pulse: true };
      case "category": return { emissive: 1.6, pulse: false };
      case "grid":     return { emissive: 1.2, pulse: false };
      case "vault":    return { emissive: 1.0, pulse: false };
      case "tag":      return { emissive: 0.9, pulse: false };
      // Perspectives are first-class user-authored neurons — emit
      // brighter than Vault notes (which are passive captures) but
      // dimmer than the principle-bearing belief stars. A gentle
      // pulse signals they're alive and the AI uses them.
      case "perspective": return { emissive: 1.8, pulse: true };
      // Projects are user-authored neuron clusters. Treat them as
      // landmarks similar to concepts — emit a touch brighter than
      // vault/tags so the teal cluster reads as deliberate, with a
      // gentle pulse so the user notices when an AI client just
      // pushed an update to one (the scene-side pulse is global, but
      // the alive feel matches how "working" each project is).
      case "project":  return { emissive: 1.6, pulse: true };
      default:         return { emissive: 1.0, pulse: false };
    }
  }, [node.kind]);

  // Subtle pulse on neurons + root → keeps the "thinking" feel alive. With
  // the halo gone, the pulse rides on the core's emissive intensity so bloom
  // breathes in/out with it. Per-node phase offset prevents sync pulsing.
  const pulsePhase = useMemo(() => Math.random() * Math.PI * 2, []);
  // Opacity target — also lerped each frame on the material directly so
  // un-hovered neurons fade rather than snap when another neuron is
  // hovered (the snap was the visible "glitch" that read as a page jump
  // because the bloom post-pass picks up every step change).
  const opacityTarget = isDimmed
    ? 0.18
    : isTopicMode
      ? Math.max(0.2, node.relevance)
      : 1;
  useFrame((state) => {
    const mat = coreMatRef.current;
    if (!mat) return;
    const hoverTarget = isHovered ? 1.4 : 1;
    const dimTarget = isDimmed ? 0.35 : 1;
    const hoverDelta = hoverTarget - hoverMulRef.current;
    const dimDelta = dimTarget - dimMulRef.current;
    const opacityDelta = opacityTarget - mat.opacity;
    // Skip per-frame writes when this neuron's emissive/opacity has
    // already converged AND we don't need to drive a pulse. Without this
    // every neuron pushed three uniform updates per frame regardless of
    // whether anything was changing — multiplied by ~300 neurons × 60fps
    // that's ~54k writes/sec just to set values to themselves. The bloom
    // post-pass also stays cheaper when emissive uniforms don't churn.
    const wantsPulse = glowConfig.pulse && !isSelected && !isHovered;
    const atRest =
      Math.abs(hoverDelta) < 0.002 &&
      Math.abs(dimDelta) < 0.002 &&
      Math.abs(opacityDelta) < 0.002;
    if (atRest && !wantsPulse && !isForming) return;

    hoverMulRef.current += hoverDelta * 0.18;
    dimMulRef.current += dimDelta * 0.18;
    // Link-mode multiplier — boosts emissive by ~60% so a neuron the
    // user has tapped into their pending link selection visibly
    // brightens against the rest of the cloud. Applied as a flat
    // multiplier on top of the existing hover/dim chain so the
    // selection signal layers cleanly with hover (a selected
    // neuron the user is also hovering glows brightest).
    const linkMul = isLinkSelected ? 1.6 : 1;
    const base = glowConfig.emissive * hoverMulRef.current * dimMulRef.current * linkMul;
    // Pulse stays off for the focused / hovered neuron. With the camera
    // pulled in close, the bloom halo around a pulsing emissive grows
    // and shrinks several pixels per cycle, which reads as the neuron
    // physically wobbling up and down. The user's focal neuron should
    // be perfectly still.
    if (wantsPulse) {
      const t = state.clock.elapsedTime;
      const wave = 0.88 + 0.12 * Math.sin(t * 1.4 + pulsePhase);
      mat.emissiveIntensity = base * wave;
    } else {
      mat.emissiveIntensity = base;
    }
    mat.opacity = mat.opacity + opacityDelta * 0.18;
  });

  // Hover scale is animated subtly through a useFrame on the group's scale,
  // not via re-renders, so adjacent nodes don't jitter when the cursor
  // grazes between them. When `isForming` is true, the same scale handle
  // also drives the formation grow-in: scale stays at 0 until the leading
  // edge finishes drawing, then ramps from 0 → 1 with a slight overshoot.
  const hoverScale = isHovered || isSelected ? 1.18 : 1;
  useFrame((state) => {
    if (!groupRef.current) return;

    // Forming pass — overrides hover lerp until the formation completes.
    // Lands at scale 1 (not hoverScale) so the regular hover lerp can
    // smoothly grow it to 1.18 once isForming clears and isSelected fires.
    if (isForming) {
      if (formStartRef.current === null) formStartRef.current = state.clock.elapsedTime;
      const t = state.clock.elapsedTime - formStartRef.current;
      let scale: number;
      if (t < NEURON_FORMATION_DELAY_S) {
        scale = 0;
      } else {
        const p = Math.min(1, (t - NEURON_FORMATION_DELAY_S) / NEURON_FORMATION_DURATION_S);
        // Cubic ease-out with a tiny overshoot mid-animation.
        const eased = 1 - Math.pow(1 - p, 3);
        const overshoot = p < 1 ? 1 + 0.12 * Math.sin(p * Math.PI) : 1;
        scale = eased * overshoot;
      }
      groupRef.current.scale.set(scale, scale, scale);
      return;
    }

    const cur = groupRef.current.scale.x;
    const target = hoverScale;
    if (Math.abs(cur - target) > 0.001) {
      const next = cur + (target - cur) * 0.15;
      groupRef.current.scale.set(next, next, next);
    }
  });

  const r = node.radius;

  return (
    <group ref={groupRef} position={[node.x, node.y, node.z]}>
      {/* Selection ring — wireframe sphere ever-so-slightly larger than core */}
      {isSelected && (
        <mesh>
          <sphereGeometry args={[r * 1.35, 32, 32]} />
          <meshBasicMaterial
            color={node.color}
            wireframe
            transparent
            opacity={0.45}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}

      {/* Core neuron — single emissive sphere. Bloom on the Canvas turns the
          high emissive intensity into the visible glow; no extra halo mesh. */}
      <mesh
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          if (node.kind === "root") return;
          onHover(node.id);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          onHover(null);
          document.body.style.cursor = "";
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onClick(node.id);
        }}
      >
        <sphereGeometry args={[r, 32, 32]} />
        <meshStandardMaterial
          ref={coreMatRef}
          color={node.color}
          emissive={node.color}
          emissiveIntensity={glowConfig.emissive}
          transparent
          // Initial opacity only — useFrame above lerps the actual value
          // toward `opacityTarget` so hover/dim transitions don't snap.
          opacity={1}
          metalness={0.1}
          roughness={0.45}
          toneMapped={false}
        />
      </mesh>

      {/* Labels — root/category always visible (navigational anchors).
          High-connection nodes also stay labeled so the busiest hubs always
          read. Other nodes show their label only on hover/selection. This
          keeps DOM cost bounded (drei <Html> mounts a real DOM element per
          instance) and the scene visually clean instead of label-soup. */}
      {(
        node.kind === "root" ||
        node.kind === "category" ||
        node.connectionCount >= 5 ||
        isHovered ||
        isSelected
      ) && (
        <Html
          position={[0, -(r + 14), 0]}
          center
          distanceFactor={node.kind === "root" ? 360 : node.kind === "category" ? 420 : 520}
          zIndexRange={[10, 0]}
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          <div
            style={{
              fontFamily: "system-ui, -apple-system, sans-serif",
              fontSize: node.kind === "root"
                ? "16px"
                : node.kind === "category"
                  ? "14px"
                  : "12px",
              fontWeight: node.kind === "root" || node.kind === "category" ? 600 : 400,
              color: isDimmed ? "rgba(150,150,150,0.4)" : "rgba(225,225,235,0.92)",
              textShadow: "0 1px 4px rgba(0,0,0,0.6), 0 0 8px rgba(0,0,0,0.4)",
              whiteSpace: "nowrap",
              transform: "translate(-50%, 0)",
              transition: "color 180ms ease, opacity 180ms ease",
              opacity: isDimmed ? 0.45 : 1,
            }}
          >
            {node.label.length > 28 ? node.label.slice(0, 26) + "…" : node.label}
          </div>
        </Html>
      )}

      {/* Connection-count badge — a tiny floating indicator */}
      {node.connectionCount > 3 && node.kind !== "root" && node.kind !== "category" && !isDimmed && (
        <Html
          position={[r * 0.7, r * 0.7, 0]}
          center
          distanceFactor={580}
          zIndexRange={[10, 0]}
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          <div
            style={{
              fontFamily: "system-ui, -apple-system, sans-serif",
              fontSize: "10px",
              fontWeight: 700,
              color: node.color,
              background: "rgba(255,255,255,0.92)",
              borderRadius: "999px",
              padding: "1px 5px",
              minWidth: "14px",
              textAlign: "center",
              boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
              transform: "translate(-50%, -50%)",
            }}
          >
            {node.connectionCount}
          </div>
        </Html>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/*  Edge — straight 3D line. Curves cost extra geometry and at our     */
/*  scale (~few hundred edges) flat lines look cleaner anyway.         */
/* ------------------------------------------------------------------ */

interface EdgeProps {
  a: Scene3DNode;
  b: Scene3DNode;
  isHl: boolean;
  isDimmed: boolean;
  isCross: boolean;
  isTopicMode: boolean;
  edgeRelevance: number;
  /**
   * Provenance overlay edge (belief→fact, fact→vault, fact→board). Drawn
   * in the belief category indigo at a higher base opacity than regular
   * cross-edges so the "this belief is grounded in these things" web
   * reads as a distinct layer over the heuristic theme links.
   */
  isProvenance?: boolean;
  /**
   * User-authored link from the "Link neurons" mode. Drawn in a bright
   * blue accent at higher opacity than heuristic cross-edges so the
   * threads the user wired themselves stand out from the AI-inferred
   * web around them. Always rendered solid (no dashes) — these are
   * deliberate, not guessed.
   */
  isUserLink?: boolean;
  /**
   * If true, this edge is the "leading line" of a neuron formation — it
   * draws out from `a` toward `b` over EDGE_FORMATION_DURATION_S in bright
   * electric blue, then sits at full extent.
   */
  isForming?: boolean;
}

const EDGE_FORMATION_DURATION_S = 0.8;

/**
 * Animated forming edge: a line whose endpoint travels from `a` toward `b`
 * over a fixed duration. Drawn separately from the regular static `Edge`
 * because <Line> from drei expects a static `points` prop and we want to
 * mutate the endpoint every frame.
 */
function FormingEdge({ a, b }: { a: Scene3DNode; b: Scene3DNode }) {
  const startRef = useRef<number | null>(null);
  const lineRef = useRef<THREE.Line | null>(null);
  // Two-vertex BufferGeometry; we mutate the second vertex every frame.
  const geometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const verts = new Float32Array([a.x, a.y, a.z, a.x, a.y, a.z]);
    geom.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    return geom;
  }, [a.x, a.y, a.z]);

  useFrame((state) => {
    if (startRef.current === null) startRef.current = state.clock.elapsedTime;
    const t = Math.min(1, (state.clock.elapsedTime - startRef.current) / EDGE_FORMATION_DURATION_S);
    // Ease-out cubic for the front of the line — starts fast, settles in.
    const p = 1 - Math.pow(1 - t, 3);
    const x = a.x + (b.x - a.x) * p;
    const y = a.y + (b.y - a.y) * p;
    const z = a.z + (b.z - a.z) * p;
    const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
    attr.setXYZ(1, x, y, z);
    attr.needsUpdate = true;
  });

  return (
    // @ts-expect-error - R3F intrinsic (line) typing is loose; ref typing isn't a great match for Three.Line vs LineSegments.
    <line ref={lineRef} geometry={geometry}>
      <lineBasicMaterial
        color={"#60a5fa"}
        linewidth={2.4}
        transparent
        opacity={0.95}
        toneMapped={false}
      />
    </line>
  );
}

function Edge({ a, b, isHl, isDimmed, isCross, isProvenance = false, isUserLink = false, isTopicMode, edgeRelevance, isForming = false }: EdgeProps) {
  const points = useMemo(
    () => [
      new THREE.Vector3(a.x, a.y, a.z),
      new THREE.Vector3(b.x, b.y, b.z),
    ],
    [a.x, a.y, a.z, b.x, b.y, b.z],
  );

  if (isForming) {
    return <FormingEdge a={a} b={b} />;
  }

  // Provenance edges sit visually between heuristic cross-edges and
  // structural edges: more present than a faint dashed theme link
  // (because the user explicitly asked "show me the web of beliefs")
  // but not so loud they drown out the hover-highlighted path.
  const opacity = isDimmed
    ? 0.06
    : isTopicMode && edgeRelevance < 0.3
      ? 0.10
      : isHl
        ? 0.95
        : isUserLink
          ? 0.78
          : isProvenance
            ? 0.55
            : isCross
              ? 0.20
              : 0.40;

  // Indigo matches `palette.beliefs.bg` in SynthesisLayer.tsx so the
  // provenance overlay reads as "these edges come from the belief
  // cluster you can see above," not a random new color.
  const PROVENANCE_COLOR = "#a5b4fc";
  // Bright sky-blue for user links — same family as the "+" menu's
  // primary action accent and the link-mode action bar, so the user
  // visually associates "their" threads with the linking affordance.
  const USER_LINK_COLOR = "#60a5fa";
  const color = isHl
    ? a.color
    : isUserLink
      ? USER_LINK_COLOR
      : isProvenance
        ? PROVENANCE_COLOR
        : "#94a3b8";
  const lineWidth = isHl
    ? 1.6
    : isUserLink
      ? 1.4
      : isProvenance
        ? 1.1
        : isCross
          ? 0.5
          : 0.8;

  return (
    <Line
      points={points}
      color={color}
      lineWidth={lineWidth}
      transparent
      opacity={opacity}
      // Heuristic cross-edges stay dashed (they're inferred). Provenance
      // and user-authored links render solid so the eye reads them as
      // audited/deliberate, not guessed.
      dashed={isCross && !isProvenance && !isUserLink}
      dashSize={6}
      gapSize={6}
      toneMapped={false}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Internal scene tree — sits inside <Canvas>                         */
/* ------------------------------------------------------------------ */

interface InnerProps extends Omit<Props, "zoom" | "resetSignal" | "focusNodeId" | "onBackgroundClick"> {
  centroid: readonly [number, number, number];
}

function SceneInner({
  nodes, edges, hoveredId, selectedId, highlightSet, isTopicMode, onHoverNode, onClickNode, centroid, formingNodeId, linkSelectedIds, focusedSet,
}: InnerProps) {
  // Materialise the filter focus set's membership test once per
  // render rather than asking it inside every Neuron/Edge map below.
  // The Set already gives O(1) membership, but caching the
  // "any-focus-applied" flag lets us skip the dim/boost branches
  // entirely when no filter is active — the common case.
  const hasFocus = !!focusedSet && focusedSet.size > 0;
  const posMap = useMemo(() => {
    const m = new Map<string, Scene3DNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  const visibleEdges = useMemo(
    () => edges.filter((e) => posMap.has(e.from) && posMap.has(e.to)),
    [edges, posMap],
  );

  return (
    <group position={[-centroid[0], -centroid[1], -centroid[2]]}>
      {/* Background deselect is handled at the Canvas level (with a manual
          drag-vs-click threshold) — no invisible click-catcher mesh here.
          R3F's onClick movement detection breaks down when OrbitControls
          captures the pointer for orbiting, so we can't rely on a mesh
          onClick to fire only on real clicks. */}

      {visibleEdges.map((e, i) => {
        const a = posMap.get(e.from)!;
        const b = posMap.get(e.to)!;
        const isHl = hoveredId !== null && highlightSet.has(e.from) && highlightSet.has(e.to);
        // Edge dimming: hover-driven (existing behaviour) OR
        // filter-driven (new). An edge counts as "in focus" only
        // when BOTH endpoints are members of the filter set —
        // otherwise it dangles into the dimmed background and
        // would visually drag a member node down with it.
        const inFocus =
          !hasFocus ||
          (focusedSet!.has(e.from) && focusedSet!.has(e.to));
        const isDimmed = (hoveredId !== null && !isHl) || !inFocus;
        const edgeRelevance = isTopicMode ? Math.min(a.relevance, b.relevance) : 1;
        // The forming edge is the one whose endpoint is the forming neuron.
        const isFormingEdge = formingNodeId != null && e.to === formingNodeId;
        return (
          <Edge
            key={`${e.from}__${e.to}__${i}`}
            a={a}
            b={b}
            isHl={isHl}
            isDimmed={isDimmed}
            isCross={!!e.cross}
            isProvenance={!!e.provenance}
            isUserLink={!!e.userLink}
            isTopicMode={isTopicMode}
            edgeRelevance={edgeRelevance}
            isForming={isFormingEdge}
          />
        );
      })}

      {nodes.map((n) => {
        const isHovered = hoveredId === n.id;
        const isSelected = selectedId === n.id;
        // Node dimming: hover-driven (existing) OR filter-driven
        // (new — non-members of the active focus set fade so the
        // members visually pop). The two channels OR together so
        // hovering inside a filtered view still spotlights the
        // hovered node's neighbours within the focus.
        const isFocusMember = !hasFocus || focusedSet!.has(n.id);
        const isDimmed =
          (hoveredId !== null && !highlightSet.has(n.id)) || !isFocusMember;
        const isForming = formingNodeId === n.id;
        // Members of the filter focus set borrow the same emissive
        // boost link-mode selections use — that's what the user
        // asked for ("only the neurons connected to that project
        // glow"). When linkSelectedIds is also active (e.g. user
        // is in linking mode while a filter is on) either signal
        // alone is enough to trigger the glow.
        const isLinkSelected =
          (!!linkSelectedIds && linkSelectedIds.has(n.id)) ||
          (hasFocus && isFocusMember);
        return (
          <Neuron
            key={n.id}
            node={n}
            isHovered={isHovered}
            isSelected={isSelected}
            isDimmed={isDimmed}
            isTopicMode={isTopicMode}
            onHover={onHoverNode}
            onClick={onClickNode}
            isForming={isForming}
            isLinkSelected={isLinkSelected}
          />
        );
      })}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/*  Camera controller — exposes external zoom + reset signals          */
/* ------------------------------------------------------------------ */

interface CameraControllerProps {
  zoom: number;
  resetSignal: number;
  /** World-space coordinates to fly the orbit pivot to, or null for no focus. */
  focusPos: readonly [number, number, number] | null;
  /** Optional close-in distance used in place of NEURON_FOCUS_DISTANCE. */
  focusDistanceOverride?: number | null;
  /** When true, OrbitControls is mounted with all interaction disabled. */
  lockCamera?: boolean;
  /**
   * When true, OrbitControls slowly auto-orbits the scene around the
   * current target (`autoRotate`). Used by the synthesis-layer tour
   * intro to give a brand-new visitor a "cinematic" first impression
   * of their digital brain — they see the graph from multiple angles
   * without having to figure out the drag gesture yet. The parent
   * flips this off the first time the user actually grabs the canvas
   * or after a short timer, whichever comes first.
   */
  autoRotate?: boolean;
}

/**
 * Camera-to-target distance to use when focusing on an individual neuron.
 * Picked so the node clearly fills the center of the view but the
 * surrounding cloud is still visible for context (~equivalent to external
 * zoom ≈ 2.6 given the 1200/zoom^0.85 mapping). When the user deselects
 * and the camera flies back to the centroid we restore whatever distance
 * their external zoom slider currently dictates.
 */
const NEURON_FOCUS_DISTANCE = 420;

function CameraController({ zoom, resetSignal, focusPos, focusDistanceOverride, lockCamera = false, autoRotate = false }: CameraControllerProps) {
  const ctrlRef = useRef<any>(null);
  const focusTargetRef = useRef<THREE.Vector3 | null>(null);

  // Map the external 0.15..3 zoom value to a camera-to-target distance.
  // Higher zoom → closer camera (smaller distance). Inverse curve so wheel
  // ticks feel natural across the whole range.
  const targetDistance = useMemo(() => {
    const z = Math.max(0.05, zoom);
    return 1200 / Math.pow(z, 0.85);
  }, [zoom]);

  // Apply zoom through OrbitControls' own state: rescale (cam.position − target)
  // to the new distance, then call controls.update() so dampening kicks in.
  // This cooperates with OrbitControls instead of fighting its update loop.
  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    const cam = ctrl.object as THREE.PerspectiveCamera;
    const target = ctrl.target as THREE.Vector3;
    const offset = new THREE.Vector3().subVectors(cam.position, target);
    const len = offset.length();
    if (len < 1e-4) {
      // Camera sitting on its target — nudge it back along +z so we have a
      // direction to scale. (Should basically never happen in practice.)
      offset.set(0, 0, 1);
    } else {
      offset.divideScalar(len);
    }
    cam.position.copy(target.clone().add(offset.multiplyScalar(targetDistance)));
    cam.updateMatrixWorld();
    try { ctrl.update(); } catch { /* drei may not expose update on first render */ }
  }, [targetDistance]);

  // Reset: re-snap camera to its initial angle/distance and clear any focus.
  useEffect(() => {
    focusTargetRef.current = null;
    if (!ctrlRef.current) return;
    try {
      ctrlRef.current.reset();
    } catch { /* drei version may not expose reset; safe to ignore */ }
  }, [resetSignal]);

  // Stash the latest focus position. The actual lerp happens in useFrame so
  // it animates smoothly and cooperates with OrbitControls' own update loop.
  //
  // When focus clears (user deselects / closes the panel / clicks empty
  // space), we re-target the orbit pivot to world origin — which is the
  // graph centroid since SceneInner is translated by -centroid. So the
  // camera glides back to "centered on the main section" instead of being
  // stuck wherever the last selected neuron was. The lerp loop nulls the
  // ref once it lands, so subsequent user orbits aren't yanked back.
  useEffect(() => {
    if (!focusPos) {
      focusTargetRef.current = new THREE.Vector3(0, 0, 0);
      return;
    }
    focusTargetRef.current = new THREE.Vector3(focusPos[0], focusPos[1], focusPos[2]);
  }, [focusPos]);

  // Per-frame: lerp orbit target AND camera position toward the focus.
  // Two things happen simultaneously so the move feels like a single "fly
  // to neuron" gesture:
  //   1. Orbit pivot lerps from current target → focus point.
  //   2. Camera position lerps to (focus + currentDirection * desiredDist),
  //      where desiredDist is short for neuron focuses (zoom in) and the
  //      user's external zoom distance for origin focus (zoom back out).
  // Reusing the *current* camera direction means the user's orbit angle is
  // preserved — they don't get yanked to a fixed face-on view.
  useFrame(() => {
    const ctrl = ctrlRef.current;
    const focus = focusTargetRef.current;
    if (!ctrl || !focus) return;
    const target = ctrl.target as THREE.Vector3;
    const cam = ctrl.object as THREE.PerspectiveCamera;

    // Origin focus = "centered on the main section". Use the user's external
    // zoom for the resting distance so deselecting visually undoes the
    // zoom-in. Anything else is a real neuron focus → pull in close. The
    // override (when supplied) lets a caller pull in even tighter, e.g.
    // for the landing prototype's "centered on the new neuron" beat.
    const isOriginFocus = focus.lengthSq() < 1;
    const neuronDist =
      focusDistanceOverride != null && focusDistanceOverride > 0
        ? focusDistanceOverride
        : NEURON_FOCUS_DISTANCE;
    const desiredDist = isOriginFocus ? targetDistance : neuronDist;

    // Direction from current target → camera. If the camera is sitting on
    // the target (shouldn't happen in practice), default to +z so we have
    // a sane direction to scale.
    const dir = new THREE.Vector3().subVectors(cam.position, target);
    const curDist = dir.length();
    if (curDist < 1e-4) dir.set(0, 0, 1);
    else dir.divideScalar(curDist);

    const desiredCamPos = focus.clone().add(dir.multiplyScalar(desiredDist));

    const LERP = 0.12;
    const targetStep = focus.clone().sub(target).multiplyScalar(LERP);
    const camStep = desiredCamPos.clone().sub(cam.position).multiplyScalar(LERP);
    target.add(targetStep);
    cam.position.add(camStep);

    // Done when both the pivot and the camera are within ~0.5 world units
    // of their endpoints. Snap exactly so we don't accumulate drift, then
    // clear the ref so subsequent user orbits aren't pulled back.
    if (
      target.distanceToSquared(focus) < 0.25 &&
      cam.position.distanceToSquared(desiredCamPos) < 0.25
    ) {
      target.copy(focus);
      cam.position.copy(desiredCamPos);
      focusTargetRef.current = null;
    }

    cam.updateMatrixWorld();
    try { ctrl.update(); } catch { /* OrbitControls may be mid-init */ }
  });

  // Touch-capable devices need OrbitControls' built-in pinch-zoom because
  // the page-level wheel listener (which drives external zoom on desktop)
  // never receives wheel events from a finger. `enableZoom` toggles BOTH
  // wheel AND pinch in three.js, so we leave it false on desktop (external
  // zoom stays the single source of truth) and turn it on for touch — at
  // the cost of a hybrid touchscreen-laptop user double-counting wheel
  // ticks, which is a rare papercut we can fix later if it matters.
  const isTouch = useIsTouchDevice();
  // One finger rotates, two fingers pinch + pan. ROTATE/DOLLY_PAN are the
  // OrbitControls defaults already, but we set them explicitly so a future
  // drei version that flips defaults doesn't quietly break touch UX.
  const touchGestures = useMemo(
    () => ({ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }),
    [],
  );

  return (
    <OrbitControls
      ref={ctrlRef}
      // Damping kept off: OrbitControls' damping decays residual angular
      // velocity over many frames after any input. In the prototype handoff
      // (and really anywhere with a nearby focus) that decay reads as the
      // focused neuron drifting up/down/sideways for a beat after every
      // hover, click, or wheel tick. Snap behavior keeps the camera dead
      // still until the user actually drags it.
      enableDamping={false}
      // In `lockCamera` mode every form of user interaction is off — the
      // camera holds whatever focus the parent set. Used by the landing
      // prototype handoff so clicking the freshly-formed neuron doesn't
      // also start an orbit gesture and visually drift it off-cursor.
      enablePan={!lockCamera}
      enableRotate={!lockCamera}
      // Slow cinematic spin during the tour intro — autoRotate disables
      // itself the moment the user grabs the canvas (drei wires that up
      // internally), and the parent flips the prop off after its timer
      // anyway, so we don't fight a user who wants to drive.
      autoRotate={autoRotate && !lockCamera}
      autoRotateSpeed={0.55}
      panSpeed={0.7}
      // Mouse rotation is dialled in for fine-grained orbit; finger
      // gestures travel a much shorter pixel distance per intent, so we
      // turn the speed up on touch so a half-screen drag actually rotates
      // the scene meaningfully.
      rotateSpeed={isTouch ? 0.9 : 0.55}
      // On desktop, external wheel handler + +/- buttons own the zoom.
      // On touch, OrbitControls owns it via pinch (no wheel exists).
      enableZoom={!lockCamera && isTouch}
      zoomSpeed={isTouch ? 1.0 : 1.0}
      touches={touchGestures}
      // Hard caps so users can't fly inside neurons or out into oblivion.
      minDistance={120}
      maxDistance={6000}
      makeDefault
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Public Scene component                                             */
/* ------------------------------------------------------------------ */

export default function SynthesisScene3D(props: Props) {
  const centroid = useGraphCentroid(props.nodes);
  const litePreview = props.litePreview === true;

  // Translate the focus node id into a world-space coord. SceneInner is
  // rendered inside a group translated by -centroid, so the world position
  // of a node is its scene position minus the centroid. Recomputed when
  // either the focus id or the layout changes (so re-layouts still focus
  // on the right neuron).
  const focusPos = useMemo<[number, number, number] | null>(() => {
    if (!props.focusNodeId) return null;
    const n = props.nodes.find((x) => x.id === props.focusNodeId);
    if (!n) return null;
    return [n.x - centroid[0], n.y - centroid[1], n.z - centroid[2]];
  }, [props.focusNodeId, props.nodes, centroid]);

  // Manual click-vs-drag detection for "click empty space to deselect".
  //
  // Why we can't lean on R3F's built-in click detection here:
  //   • R3F's mesh onClick uses a small movement threshold to differentiate
  //     a click from a drag — but it tracks pointermove via R3F's own
  //     pointer events. OrbitControls captures the pointer on pointerdown
  //     and intercepts pointermove for orbiting, so R3F never sees the
  //     movement and on pointerup it incorrectly thinks "this was a click".
  //   • Same issue applies to onPointerMissed on the Canvas — it fires on
  //     every pointer-up that didn't hit a mesh, including the end of a
  //     drag-orbit.
  //
  // The fix: track pointerdown clientX/Y ourselves at the Canvas root (which
  // sees events regardless of OrbitControls), then in onPointerMissed only
  // call onBackgroundClick if the pointer barely moved. Threshold is a few
  // pixels — anything larger is treated as the user having dragged the
  // camera, and we leave their selected neuron focused.
  const pointerDownPos = useRef<{ x: number; y: number } | null>(null);
  const CLICK_DRAG_THRESHOLD_PX = 5;
  const { onBackgroundClick } = props;
  const handlePointerDown = useCallback((e: ReactPointerEvent) => {
    pointerDownPos.current = { x: e.clientX, y: e.clientY };
  }, []);
  const handlePointerMissed = useCallback(
    (e: MouseEvent) => {
      const start = pointerDownPos.current;
      pointerDownPos.current = null;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) return;
      onBackgroundClick();
    },
    [onBackgroundClick],
  );

  // WebGL context loss + recovery. The browser fires `webglcontextlost` when
  // the GPU resets (driver hiccup, alt-tabbing for too long with the page
  // throttled, GPU memory pressure from too many simultaneous WebGL contexts
  // — this page also runs the OmniaGrid canvas + bloom postprocess, so we're
  // not dirt-cheap). Three.js's WebGLRenderer attaches its own listener that
  // calls preventDefault and logs "Context Lost.", but on some Windows GPU
  // drivers the browser never automatically restores even when our scene is
  // visible — leaving the user staring at a frozen black canvas with the
  // useFrame loop still ticking against a dead GL state.
  //
  // Belt-and-braces:
  //   1. Capture-phase preventDefault so even if the three.js handler is
  //      somehow detached or fires after a re-init, the browser still knows
  //      we want to recover.
  //   2. On `webglcontextrestored`, recompile materials/programs against the
  //      new context and force a single render — this is what unsticks the
  //      frozen frame.
  //   3. If the browser doesn't fire a restore event within 3.5s of the loss
  //      AND the scene is still on-screen, manually request a restore via
  //      the WEBGL_lose_context extension. This is the workaround for the
  //      Windows-driver "context lost forever" failure mode.
  const handleCanvasCreated = useCallback(
    ({ gl, scene, camera }: { gl: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera }) => {
      const canvas = gl.domElement;
      let manualRestoreTimer: number | null = null;
      const onLost = (e: Event) => {
        e.preventDefault();
        console.warn("[SynthesisScene3D] WebGL context lost — waiting for restore…");
        if (manualRestoreTimer != null) window.clearTimeout(manualRestoreTimer);
        manualRestoreTimer = window.setTimeout(() => {
          if (!document.body.contains(canvas)) return; // unmounted, give up
          try {
            const ext = gl.getContext().getExtension("WEBGL_lose_context");
            if (ext) {
              console.warn("[SynthesisScene3D] No automatic restore after 3.5s — forcing restoreContext()");
              ext.restoreContext();
            }
          } catch (err) {
            console.warn("[SynthesisScene3D] Manual restoreContext() failed:", err);
          }
        }, 3500);
      };
      const onRestored = () => {
        if (manualRestoreTimer != null) {
          window.clearTimeout(manualRestoreTimer);
          manualRestoreTimer = null;
        }
        console.log("[SynthesisScene3D] WebGL context restored — recompiling materials");
        try {
          gl.compile(scene, camera);
          gl.render(scene, camera);
        } catch (err) {
          console.warn("[SynthesisScene3D] Recompile after restore failed (scene may need a remount):", err);
        }
      };
      // Capture-phase so we run before three.js's own handler — the browser
      // requires the FIRST listener to call preventDefault for the restore
      // event to ever fire.
      canvas.addEventListener("webglcontextlost", onLost, { capture: true });
      canvas.addEventListener("webglcontextrestored", onRestored);
    },
    [],
  );

  return (
    <Canvas
      // dpr capped to 1.5 (was 2). On retina the bloom post-pass runs
      // per-fragment so 2x DPR is ~78% more shader work than 1.5x for
      // ~no perceptible quality gain at typical viewing distance — the
      // emissive cores are already bigger than the half-pixel difference
      // a retina screen would show. Mobile floor stays at 1.
      // Lite preview (walkthrough grid) locks DPR at 1 and skips Bloom.
      dpr={litePreview ? 1 : [1, 1.5]}
      gl={{
        antialias: !litePreview,
        alpha: true,
        powerPreference: litePreview ? "default" : "high-performance",
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.05,
      }}
      camera={{ position: [0, 0, 1200], fov: 55, near: 1, far: 12000 }}
      style={{ width: "100%", height: "100%", background: "transparent" }}
      onPointerDown={handlePointerDown}
      onPointerMissed={handlePointerMissed}
      onCreated={handleCanvasCreated}
    >
      {/* Ambient + a couple of point lights so non-emissive faces of nodes
          have some directional shading; the emissive material does the
          heavy lifting for the glow look. */}
      <ambientLight intensity={0.55} />
      <pointLight position={[400, 500, 600]} intensity={0.6} color="#ffffff" />
      <pointLight position={[-500, -300, 200]} intensity={0.35} color="#a78bfa" />

      <SceneInner
        nodes={props.nodes}
        edges={props.edges}
        hoveredId={props.hoveredId}
        selectedId={props.selectedId}
        highlightSet={props.highlightSet}
        isTopicMode={props.isTopicMode}
        onHoverNode={props.onHoverNode}
        onClickNode={props.onClickNode}
        centroid={centroid}
        formingNodeId={props.formingNodeId}
        linkSelectedIds={props.linkSelectedIds}
        focusedSet={props.focusedSet}
      />

      <CameraController
        zoom={props.zoom}
        resetSignal={props.resetSignal}
        focusPos={focusPos}
        // While a neuron is forming we pull the camera in closer than the
        // standard NEURON_FOCUS_DISTANCE so the new neuron really lands
        // dead-center on the screen. Falls back to caller-provided value
        // (or null) once the formation completes.
        focusDistanceOverride={
          props.formingNodeId != null
            ? 240
            : (props.focusDistanceOverride ?? null)
        }
        lockCamera={props.lockCamera}
        autoRotate={props.autoRotate}
      />

      {/* Bloom is what actually creates the "neurons glowing" effect — bright
          (high luminance) pixels bleed light into surrounding pixels. Tuned
          so emissive cores bloom strongly but the page background stays
          black-ish; tweak intensity if the user's display blows out. */}
      {!litePreview && (
      <EffectComposer multisampling={0} enableNormalPass={false}>
        <Bloom
          intensity={1.05}
          luminanceThreshold={0.18}
          luminanceSmoothing={0.18}
          mipmapBlur
          // Radius tightened from 0.85 → 0.7. The mipmap-blur pass cost
          // scales with kernel radius; this trims the largest mip levels
          // while keeping the halo around emissive cores visually identical
          // (the visible glow is dominated by the inner mips, not the outer
          // ones). Combined with the lower DPR above this halves the
          // per-frame post-process budget on typical machines.
          radius={0.7}
        />
      </EffectComposer>
      )}
    </Canvas>
  );
}
