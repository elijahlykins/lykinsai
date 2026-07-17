/* eslint-disable react/no-unknown-property */
// react/no-unknown-property fires on every R3F `position`, `args`, `attach`,
// etc. — those are valid props for fiber primitives. Disable for this file.

import { useMemo } from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { SceneBackground } from "./SceneBackground";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";

// ---------------------------------------------------------------------------
// LYKN Synthesis Layer — real 3D zoom. The same three.js recipe the live app
// uses (emissive spheres + ACES tone mapping + Bloom postprocess from
// SynthesisScene3D.tsx), driven deterministically by the Remotion frame.
// Camera opens locked on a single neuron, then rips out fast to reveal the
// whole brain while orbiting.
// ---------------------------------------------------------------------------

export const SYNTHESIS_ZOOM_DURATION = 96; // ~3.2s @ 30fps

const EASE = Easing.inOut(Easing.cubic);
const FPS = 30;

// Popped-out preview panel (16:9, centered), matching the other comps.
const PREVIEW_W = 1600;
const PREVIEW_H = 900;

// Palette — matches tourPreviewGraph.ts / the live scene.
const PAL = {
  root: "#6366f1",
  chats: "#3b82f6",
  vault: "#10b981",
  belief: "#ffffff",
  facts: "#ec4899",
  concepts: "#f97316",
  projects: "#14b8a6",
} as const;

// kind → emissive intensity, straight from SynthesisScene3D's glowConfig.
type Kind =
  | "root"
  | "category"
  | "chat"
  | "vault"
  | "belief"
  | "neuron"
  | "concept"
  | "project"
  | "micro";
const EMISSIVE: Record<Kind, { emissive: number; pulse: boolean }> = {
  root: { emissive: 2.2, pulse: true },
  category: { emissive: 1.6, pulse: false },
  chat: { emissive: 1.2, pulse: false },
  vault: { emissive: 1.0, pulse: false },
  belief: { emissive: 3.6, pulse: true },
  neuron: { emissive: 2.6, pulse: true },
  concept: { emissive: 1.0, pulse: false },
  project: { emissive: 1.6, pulse: true },
  micro: { emissive: 1.3, pulse: true },
};

// ── 3D graph (tour-preview data, deterministic 3D layout) ──
type Node3D = {
  id: string;
  label: string;
  color: string;
  kind: Kind;
  r: number;
  p: [number, number, number];
};
type Edge3D = { from: string; to: string; cross?: boolean };

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATS: { id: string; label: string; color: string; childKind: Kind; dir: [number, number, number]; children: string[] }[] = [
  { id: "chats", label: "Chats", color: PAL.chats, childKind: "chat", dir: [0.1, 1, 0.25], children: ["Q3 strategy", "Trip to Japan", "Resume review", "Book notes"] },
  { id: "concepts", label: "Concepts", color: PAL.concepts, childKind: "concept", dir: [0.95, 0.45, -0.4], children: ["First principles", "Compounding", "Systems thinking", "Minimalism"] },
  { id: "projects", label: "Projects", color: PAL.projects, childKind: "project", dir: [0.85, -0.6, 0.45], children: ["Launch LYKN v1", "Write a book", "Marathon training"] },
  { id: "facts", label: "Facts", color: PAL.facts, childKind: "neuron", dir: [-0.1, -1, -0.3], children: ["Lives in Austin", "Founder of LYKN", "Vegetarian", "Speaks Spanish"] },
  { id: "vault", label: "Vault", color: PAL.vault, childKind: "vault", dir: [-0.9, -0.5, -0.45], children: ["resume.pdf", "lease.pdf", "moodboard.fig"] },
  { id: "belief", label: "Beliefs", color: PAL.belief, childKind: "belief", dir: [-0.9, 0.5, 0.4], children: ["Honesty over comfort", "Ship fast, iterate", "Health first", "Think long-term"] },
];

const CROSS_LINKS: [string, string][] = [
  ["belief-2", "concepts-0"],
  ["projects-0", "chats-0"],
  ["concepts-1", "projects-2"],
  ["facts-0", "projects-2"],
  ["belief-0", "facts-1"],
  ["vault-0", "facts-1"],
  ["concepts-2", "belief-1"],
];

const CAT_R = 300;
const CHILD_R = 150;

function buildGraph() {
  const rand = mulberry32(20260708);
  const nodes: Node3D[] = [
    { id: "root", label: "Your Synthesis Layer", color: PAL.root, kind: "root", r: 42, p: [0, 0, 0] },
  ];
  const edges: Edge3D[] = [];

  for (const cat of CATS) {
    const len = Math.hypot(...cat.dir);
    const d = cat.dir.map((v) => (v / len) * CAT_R) as [number, number, number];
    nodes.push({ id: cat.id, label: cat.label, color: cat.color, kind: "category", r: 30, p: d });
    edges.push({ from: "root", to: cat.id });

    cat.children.forEach((label, k) => {
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      const rr = CHILD_R * (0.85 + rand() * 0.5);
      const p: [number, number, number] = [
        d[0] * 1.3 + rr * Math.sin(phi) * Math.cos(theta),
        d[1] * 1.3 + rr * Math.sin(phi) * Math.sin(theta),
        d[2] * 1.3 + rr * Math.cos(phi),
      ];
      nodes.push({ id: `${cat.id}-${k}`, label, color: cat.color, kind: cat.childKind, r: 15, p });
      edges.push({ from: cat.id, to: `${cat.id}-${k}` });

      // a small constellation of unlabeled micro-neurons around each child
      const micros = 3 + Math.floor(rand() * 3); // 3–5
      for (let m = 0; m < micros; m++) {
        const mt = rand() * Math.PI * 2;
        const mp = Math.acos(2 * rand() - 1);
        const mr = 45 + rand() * 55;
        const q: [number, number, number] = [
          p[0] + mr * Math.sin(mp) * Math.cos(mt),
          p[1] + mr * Math.sin(mp) * Math.sin(mt),
          p[2] + mr * Math.cos(mp),
        ];
        nodes.push({
          id: `${cat.id}-${k}-m${m}`,
          label: "",
          color: cat.color,
          kind: "micro",
          r: 4 + rand() * 5,
          p: q,
        });
        edges.push({ from: `${cat.id}-${k}`, to: `${cat.id}-${k}-m${m}` });
      }
    });

    // loose micro-neurons drifting through the category's cluster
    for (let m = 0; m < 7; m++) {
      const mt = rand() * Math.PI * 2;
      const mp = Math.acos(2 * rand() - 1);
      const mr = 90 + rand() * 160;
      const q: [number, number, number] = [
        d[0] * 1.25 + mr * Math.sin(mp) * Math.cos(mt),
        d[1] * 1.25 + mr * Math.sin(mp) * Math.sin(mt),
        d[2] * 1.25 + mr * Math.cos(mp),
      ];
      nodes.push({
        id: `${cat.id}-f${m}`,
        label: "",
        color: cat.color,
        kind: "micro",
        r: 3.5 + rand() * 4.5,
        p: q,
      });
      edges.push({ from: cat.id, to: `${cat.id}-f${m}`, cross: true });
    }
  }

  const ids = new Set(nodes.map((n) => n.id));
  for (const [from, to] of CROSS_LINKS) {
    if (ids.has(from) && ids.has(to)) edges.push({ from, to, cross: true });
  }

  // faint dashed synapses between random micro-neurons across the brain
  const microIds = nodes.filter((n) => n.kind === "micro").map((n) => n.id);
  for (let i = 0; i < 26; i++) {
    const a = microIds[Math.floor(rand() * microIds.length)];
    const b = microIds[Math.floor(rand() * microIds.length)];
    if (a !== b) edges.push({ from: a, to: b, cross: true });
  }
  return { nodes, edges };
}

const { nodes: NODES, edges: EDGES } = buildGraph();
const NODE_BY_ID = new Map(NODES.map((n) => [n.id, n]));

// Deterministic per-node pulse phase (replaces the app's Math.random()).
function pulsePhase(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h >>> 0) % 628) / 100;
}

// The neuron the camera starts on — a pink "AI learned" fact neuron (they
// carry the hottest colored glow; white belief stars read grey up close
// under ACES tone mapping).
const FOCUS_ID = "facts-1"; // "Founder of LYKN"
const FOCUS = NODE_BY_ID.get(FOCUS_ID)!;

// ── camera choreography ──
const HOLD_END = 14;
const PULL_END = 68;
// Close-up distance. A bit farther than the app's formed-neuron focus (240):
// bloom's halo is screen-space, so a screen-filling orb barely glows relative
// to its size — backing off keeps the close-up looking lit.
const DIST_IN = 330;
const DIST_OUT = 1250; // ≈ the app's default 1200/zoom^0.85 wide framing
const FOV = 55;

function cameraAtFrame(frame: number) {
  const pull = interpolate(frame, [HOLD_END, PULL_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  // Log-space dolly so the pull-out feels constant-speed to the eye.
  const dist = Math.exp(interpolate(pull, [0, 1], [Math.log(DIST_IN), Math.log(DIST_OUT)]));
  const yaw = 2.1 + frame * 0.006 + pull * 0.55;
  const pitch = 0.16 - pull * 0.04;
  const target = new THREE.Vector3(
    FOCUS.p[0] * (1 - pull),
    FOCUS.p[1] * (1 - pull),
    FOCUS.p[2] * (1 - pull),
  );
  const pos = new THREE.Vector3(
    target.x + dist * Math.cos(pitch) * Math.sin(yaw),
    target.y + dist * Math.sin(pitch),
    target.z + dist * Math.cos(pitch) * Math.cos(yaw),
  );
  return { pos, target, pull, dist };
}

// Drives the ThreeCanvas camera from the Remotion frame.
const CameraRig: React.FC = () => {
  const frame = useCurrentFrame();
  const camera = useThree((s) => s.camera);
  const { pos, target } = cameraAtFrame(frame);
  camera.position.copy(pos);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return null;
};

// ── scene ──
const Scene: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / FPS; // seconds, like state.clock.elapsedTime in the app
  const { pull } = cameraAtFrame(frame);
  const ringOpacity = interpolate(pull, [0, 0.25], [0.45, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const edgeGeo = useMemo(
    () =>
      EDGES.map((e) => ({
        e,
        points: [
          new THREE.Vector3(...NODE_BY_ID.get(e.from)!.p),
          new THREE.Vector3(...NODE_BY_ID.get(e.to)!.p),
        ],
      })),
    []
  );

  return (
    <>
      {/* Dark grey clear — matches the app surface the scene sits on */}
      <ambientLight intensity={0.55} />
      <pointLight position={[400, 500, 600]} intensity={0.6} color="#ffffff" />
      <pointLight position={[-500, -300, 200]} intensity={0.35} color="#a78bfa" />

      <CameraRig />

      {/* edges — same colors/widths/dashes as the app's Edge component */}
      {edgeGeo.map(({ e, points }, i) => (
        <Line
          key={i}
          points={points}
          color="#94a3b8"
          lineWidth={e.cross ? 0.5 : 0.8}
          transparent
          opacity={e.cross ? 0.2 : 0.4}
          dashed={!!e.cross}
          dashSize={6}
          gapSize={6}
          toneMapped={false}
        />
      ))}

      {/* neurons — single emissive core sphere; Bloom supplies the halo */}
      {NODES.map((n) => {
        const cfg = EMISSIVE[n.kind];
        // Pulse everywhere except the focused neuron during the close-up —
        // same as the app, where the focal neuron stays perfectly still.
        const pulses = cfg.pulse && !(n.id === FOCUS_ID && ringOpacity > 0.01);
        const wave = pulses ? 0.88 + 0.12 * Math.sin(t * 1.4 + pulsePhase(n.id)) : 1;
        // The focused neuron gets the app's hover/selection emissive boost
        // (×1.4) while the camera sits on it, fading back to 1 as we pull out.
        const focusBoost = n.id === FOCUS_ID ? 1 + 0.4 * (ringOpacity / 0.45) : 1;
        return (
          <group key={n.id} position={n.p}>
            <mesh>
              <sphereGeometry args={[n.r, 32, 32]} />
              <meshStandardMaterial
                color={n.color}
                emissive={n.color}
                emissiveIntensity={cfg.emissive * wave * focusBoost}
                metalness={0.1}
                roughness={0.45}
                toneMapped={false}
              />
            </mesh>
          </group>
        );
      })}

      {/* Bloom — the app's in-app tuning (softer, wider halo than the
          landing-preview variant so the close-up neuron really glows) */}
      <EffectComposer multisampling={0} enableNormalPass={false}>
        <Bloom
          intensity={1.05}
          luminanceThreshold={0.18}
          luminanceSmoothing={0.18}
          mipmapBlur
          radius={0.7}
        />
      </EffectComposer>
    </>
  );
};

// ── 2D label overlay (mirrors the app's drei <Html> labels) ──
// Projected with the same camera math as the rig so labels stay pinned.
const Labels: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const cam = useMemo(() => new THREE.PerspectiveCamera(FOV, 1920 / 1080, 1, 12000), []);
  const { pos, target, pull } = cameraAtFrame(frame);
  cam.position.copy(pos);
  cam.lookAt(target);
  cam.updateMatrixWorld();

  // Category/root labels fade in as the camera pulls wide; the focused
  // neuron's label shows during the close-up (it reads as "selected").
  const wideLabels = interpolate(pull, [0.55, 0.85], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const focusLabel = interpolate(pull, [0, 0.2], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const labeled = NODES.filter(
    (n) => n.kind === "root" || n.kind === "category" || n.id === FOCUS_ID
  );

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {labeled.map((n) => {
        const isFocus = n.id === FOCUS_ID;
        const opacity = isFocus ? focusLabel : wideLabels;
        if (opacity < 0.01) return null;
        const v = new THREE.Vector3(...n.p).project(cam);
        if (v.z > 1) return null;
        const x = (v.x * 0.5 + 0.5) * width;
        const y = (1 - (v.y * 0.5 + 0.5)) * height;
        // Perspective-correct offset below the orb.
        const camDist = new THREE.Vector3(...n.p).distanceTo(pos);
        const pxPerUnit = height / 2 / (Math.tan((FOV * Math.PI) / 360) * camDist);
        const offset = (n.r + 16) * pxPerUnit;
        const fontSize = isFocus ? 24 : n.kind === "root" ? 17 : 14.5;
        return (
          <div
            key={n.id}
            style={{
              position: "absolute",
              left: x,
              top: y + offset,
              transform: "translateX(-50%)",
              fontFamily: "system-ui, -apple-system, sans-serif",
              fontSize,
              fontWeight: n.kind === "root" || n.kind === "category" ? 600 : 400,
              color: "rgba(225,225,235,0.92)",
              textShadow: "0 1px 4px rgba(0,0,0,0.6), 0 0 8px rgba(0,0,0,0.4)",
              whiteSpace: "nowrap",
              opacity,
            }}
          >
            {n.label}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

export const LyknSynthesisZoom: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const fadeIn = interpolate(frame, [0, 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: "#141416" }}>
      <SceneBackground />
      {/* popped-out dark grey preview card floating on the backdrop */}
      <div
        style={{
          position: "absolute",
          left: (1920 - PREVIEW_W) / 2,
          top: (1080 - PREVIEW_H) / 2,
          width: PREVIEW_W,
          height: PREVIEW_H,
          borderRadius: 22,
          overflow: "hidden",
          background: "#1e1e1e",
          boxShadow:
            "0 50px 130px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.14), 0 0 90px 8px rgba(40,90,200,0.18)",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: 1920,
            height: 1080,
            transform: `scale(${PREVIEW_W / 1920})`,
            transformOrigin: "0 0",
            opacity: fadeIn,
          }}
        >
          <ThreeCanvas
            width={width}
            height={height}
            gl={{
              antialias: true,
              alpha: true,
              toneMapping: THREE.ACESFilmicToneMapping,
              toneMappingExposure: 1.05,
            }}
            camera={{ position: [0, 0, DIST_OUT], fov: FOV, near: 1, far: 12000 }}
          >
            <Scene />
          </ThreeCanvas>
          <Labels />
        </div>
      </div>
    </AbsoluteFill>
  );
};
