import { useMemo } from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { SceneBackground } from "./SceneBackground";

// ---------------------------------------------------------------------------
// LYKN Voice Mode — a faithful demo of the actual in-app voice overlay
// (LyknChatVoiceMode.tsx): fullscreen bg-background, the VoiceTechOrb neuron
// sphere centered, the real status labels cycling through a conversation
// (Connecting → Listening → Searching your vault → Speaking), and the
// paste bar pinned to the bottom. No marketing chrome — just the product.
// ---------------------------------------------------------------------------

const BG = "#1f1f1f"; // hsl(0 0% 12%) — dark bg-background
const FG80 = "rgba(250,250,250,0.8)";

// Timeline (30 fps).
const FADE_IN = 8;
const T_LISTEN = 36;
const T_THINK = 120;
const T_SPEAK = 168;
export const VOICE_MODE_DURATION = 300;

type Phase = "connecting" | "listening" | "thinking" | "speaking";
function phaseAt(frame: number): Phase {
  if (frame < T_LISTEN) return "connecting";
  if (frame < T_THINK) return "listening";
  if (frame < T_SPEAK) return "thinking";
  return "speaking";
}

const STATUS: Record<Phase, string> = {
  connecting: "Connecting…",
  listening: "Listening…",
  thinking: "Searching your vault…",
  speaking: "Speaking…",
};
const PHASES: { phase: Phase; start: number }[] = [
  { phase: "connecting", start: 0 },
  { phase: "listening", start: T_LISTEN },
  { phase: "thinking", start: T_THINK },
  { phase: "speaking", start: T_SPEAK },
];

// ── orb (deterministic port of VoiceTechOrb) ──
const COUNT = 1100;
const TILT = 0.32;
const ORB_SIZE = 520;

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function buildNeurons() {
  const arr: { x: number; y: number; z: number; bobPhase: number; driftPhase: number; driftAxis: number; size: number }[] = [];
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

/** Synthetic mic envelope while listening — layered sines so it reads as
    natural speech input rather than a metronome. */
function micLevel(frame: number) {
  const t = frame / 30;
  const v =
    0.45 +
    0.3 * Math.sin(t * 5.1) +
    0.2 * Math.sin(t * 8.7 + 1.4) +
    0.12 * Math.sin(t * 13.3 + 0.6);
  return Math.max(0, Math.min(1, v));
}

const VoiceOrb: React.FC<{ frame: number; phase: Phase; appear: number }> = ({
  frame,
  phase,
  appear,
}) => {
  const neurons = useMemo(buildNeurons, []);
  const t = frame / 30;

  // State-driven scale, mirroring the app: listening follows the mic,
  // speaking pulses at speech rate, thinking breathes gently.
  const mic = phase === "listening" ? micLevel(frame) : 0;
  const speakPulse = phase === "speaking" ? Math.sin(t * 6.5) * 0.05 : 0;
  const breathe = Math.sin(t * 2.2) * 0.015;
  const stateScale =
    phase === "listening" ? 1 + mic * 0.18 : 1 + speakPulse + breathe;

  const activity =
    phase === "connecting" ? 0.3 : phase === "thinking" ? 0.75 : 0.6;
  const intensity = phase === "speaking" ? 0.9 : 0.6;

  const half = ORB_SIZE / 2;
  const R = ORB_SIZE * 0.34;
  const Reff = R * stateScale * (0.85 + appear * 0.15);

  const rot = t * 0.5;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);

  const dots = neurons
    .map((n) => {
      const bob = Math.sin(t * 2 + n.bobPhase) * (0.02 + activity * 0.04);
      const drift = (0.01 + activity * 0.04) * Math.sin(t + n.driftPhase);
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

      const px = half + x1 * Reff;
      const py = half - y2 * Reff;
      const depth = (z2 + 1) / 2;
      const a = Math.min(1, 0.18 + depth * 0.82);
      const r = n.size * (0.5 + depth * 0.55) * (ORB_SIZE / 320);
      return { px, py, r, a, z2 };
    })
    .sort((p, q) => p.z2 - q.z2);

  return (
    <div style={{ position: "relative", width: ORB_SIZE, height: ORB_SIZE, opacity: appear }}>
      {/* radial glow (dark theme) */}
      <div
        style={{
          position: "absolute",
          inset: -ORB_SIZE * 0.15,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(255,255,255,${0.06 * intensity}) 0%, rgba(255,255,255,0.03) 45%, transparent 72%)`,
        }}
      />
      <svg width={ORB_SIZE} height={ORB_SIZE} style={{ position: "absolute", inset: 0 }}>
        {dots.map((d, i) => (
          <circle
            key={i}
            cx={d.px}
            cy={d.py}
            r={d.r}
            fill="#ffffff"
            opacity={d.a}
            style={{ mixBlendMode: "screen" }}
          />
        ))}
      </svg>
    </div>
  );
};

export const LyknVoiceMode: React.FC = () => {
  const frame = useCurrentFrame();
  const phase = phaseAt(frame);

  const appear = interpolate(frame, [0, FADE_IN], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: BG,
        alignItems: "center",
        justifyContent: "center",
        fontFamily:
          "Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
        opacity: appear,
      }}
    >
      <SceneBackground />
      <VoiceOrb frame={frame} phase={phase} appear={appear} />

      {/* status label — text-base font-medium text-foreground/80, mt-10 */}
      <div style={{ position: "relative", marginTop: 40, height: 24, width: 600 }}>
        {PHASES.map(({ phase: p, start }, i) => {
          const end = i < PHASES.length - 1 ? PHASES[i + 1].start : VOICE_MODE_DURATION;
          const o =
            interpolate(frame, [start, start + 6], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }) *
            interpolate(frame, [end - 6, end], [1, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
          if (o <= 0) return null;
          const rise = interpolate(frame, [start, start + 6], [6, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={p}
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 16,
                fontWeight: 500,
                color: FG80,
                opacity: o,
                transform: `translateY(${rise}px)`,
              }}
            >
              {STATUS[p]}
            </div>
          );
        })}
      </div>

      {/* paste bar — fixed bottom-8, rounded-2xl border-foreground/10 */}
      <div
        style={{
          position: "absolute",
          bottom: 32,
          left: "50%",
          transform: "translateX(-50%)",
          width: 512,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderRadius: 16,
          border: "1px solid rgba(250,250,250,0.10)",
          background: "rgba(250,250,250,0.04)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 99,
            display: "grid",
            placeItems: "center",
            color: "rgba(250,250,250,0.6)",
            flexShrink: 0,
          }}
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </div>
        <span style={{ fontSize: 14, color: "rgba(250,250,250,0.4)" }}>
          Paste a link, image, PDF, doc — or drag &amp; drop
        </span>
      </div>
    </AbsoluteFill>
  );
};
