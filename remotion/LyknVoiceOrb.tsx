import { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { BRAND_BLUE, WHITE } from "./brand";
import { SceneBackground } from "./SceneBackground";

// Deterministic version of the in-app VoiceTechOrb: a Fibonacci-lattice
// sphere of "neuron" dots that rotates, pulses, and bobs. All motion is
// driven by `frame` (no Math.random / rAF) and uses whole sine cycles over
// the composition length, so it loops seamlessly.

const COUNT = 700;
const TILT = 0.32;

// Stable per-index pseudo-random so dot phases are identical every frame.
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

interface NeuronBase {
  x: number;
  y: number;
  z: number;
  bobPhase: number;
  driftPhase: number;
  driftAxis: number;
  size: number;
}

function buildNeurons(): NeuronBase[] {
  const arr: NeuronBase[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < COUNT; i++) {
    const y = 1 - (i / (COUNT - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * golden;
    arr.push({
      x: Math.cos(phi) * radius,
      y,
      z: Math.sin(phi) * radius,
      bobPhase: hash(i) * Math.PI * 2,
      driftPhase: hash(i + 0.5) * Math.PI * 2,
      driftAxis: hash(i + 0.8) * Math.PI * 2,
      size: 0.8 + hash(i + 0.3) * 1.1,
    });
  }
  return arr;
}

export type LyknVoiceOrbProps = {
  background: string;
  dotColor: string;
  glow: boolean;
};

export const LyknVoiceOrb: React.FC<LyknVoiceOrbProps> = ({
  background,
  dotColor,
  glow,
}) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const neurons = useMemo(buildNeurons, []);

  const t = frame / durationInFrames; // 0..1 loop progress
  const cx = width / 2;
  const cy = height / 2;
  const R = Math.min(width, height) * 0.3;
  const dotScale = Math.min(width, height) / 320;

  const rot = t * Math.PI * 2; // exactly one rotation per loop
  const pulse = 1 + Math.sin(t * Math.PI * 2 * 2) * 0.04; // two breaths per loop
  const Reff = R * pulse;
  const activity = 0.6;

  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);

  const dots = neurons
    .map((n) => {
      const bob =
        Math.sin(t * Math.PI * 2 * 2 + n.bobPhase) * (0.02 + activity * 0.04);
      const drift =
        (0.01 + activity * 0.04) * Math.sin(t * Math.PI * 2 + n.driftPhase);
      const da = n.driftAxis;
      let bx = n.x + Math.cos(da) * drift;
      let by = n.y + Math.sin(da) * drift;
      let bz = n.z + Math.cos(da * 1.7) * drift;
      const len = Math.hypot(bx, by, bz) || 1;
      const rr = 1 + bob;
      bx = (bx / len) * rr;
      by = (by / len) * rr;
      bz = (bz / len) * rr;

      const x1 = bx * cosR + bz * sinR;
      const z1 = -bx * sinR + bz * cosR;
      const y1 = by;
      const y2 = y1 * cosT - z1 * sinT;
      const z2 = y1 * sinT + z1 * cosT;

      const px = cx + x1 * Reff;
      const py = cy - y2 * Reff;
      const depth = (z2 + 1) / 2;
      const a = Math.min(1, 0.18 + depth * 0.82);
      const r = n.size * (0.5 + depth * 0.55) * dotScale;
      return { px, py, r, a, z2 };
    })
    .sort((p, q) => p.z2 - q.z2);

  return (
    <AbsoluteFill
      style={{ background, justifyContent: "center", alignItems: "center" }}
    >
      <SceneBackground />
      {glow && (
        <div
          style={{
            position: "absolute",
            width: R * 2.6,
            height: R * 2.6,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${dotColor}22, transparent 62%)`,
          }}
        />
      )}
      <svg
        width={width}
        height={height}
        style={{ position: "absolute", inset: 0 }}
      >
        {dots.map((d, i) => (
          <circle
            key={i}
            cx={d.px}
            cy={d.py}
            r={d.r}
            fill={dotColor}
            opacity={d.a}
            style={{ mixBlendMode: glow ? "screen" : "normal" }}
          />
        ))}
      </svg>
    </AbsoluteFill>
  );
};

export const lyknVoiceOrbDefaults: LyknVoiceOrbProps = {
  background: "#0b0b0c",
  dotColor: WHITE,
  glow: true,
};

// Light-mode variant: blue dots on white, no additive glow.
export const lyknVoiceOrbLight: LyknVoiceOrbProps = {
  background: "#ffffff",
  dotColor: BRAND_BLUE,
  glow: false,
};
