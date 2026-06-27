import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// Full-screen warp: hundreds of tiny particles streak past the camera at high
// speed from the center outward, while waves of color bloom out to fill the
// whole frame. Palette is pulled straight from the aurora image (pink / magenta
// / electric blue / lavender). Everything is a pure function of `frame`, so it
// renders deterministically.
export type ParticleBurstProps = {
  speed: number;
  particleCount: number;
  background: string;
};

const PALETTE = [
  "#ff5fa2", // hot pink
  "#ff86c2", // soft pink
  "#c46bff", // violet
  "#5d7bff", // periwinkle
  "#2e57ff", // electric blue
  "#1f3df0", // deep blue
  "#7fa6ff", // sky
  "#dbe4ff", // lavender white
];

// Tiny deterministic PRNG so particle attributes are stable across renders.
function rand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export const ParticleBurst: React.FC<ParticleBurstProps> = ({
  speed,
  particleCount,
  background,
}) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();

  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.hypot(width, height) * 0.62;

  // Burst waves: color blooms that expand outward and fill the screen, pulsing
  // a few times across the clip.
  const burstCycles = 3;
  const burstPhase = ((frame / durationInFrames) * burstCycles) % 1;
  const burstScale = interpolate(burstPhase, [0, 1], [0.2, 2.4]);
  const burstOpacity = interpolate(
    burstPhase,
    [0, 0.12, 0.6, 1],
    [0, 0.85, 0.25, 0],
  );

  // A single hard flash right at the start to kick the whole thing off.
  const kick = interpolate(frame, [0, 6, 22], [0.9, 0.5, 0], {
    extrapolateRight: "clamp",
  });

  const particles = Array.from({ length: particleCount }, (_, i) => {
    const angle = rand(i + 1) * Math.PI * 2;
    const pSpeed = 0.6 + rand(i + 2) * 1.6; // per-particle velocity
    const offset = rand(i + 3); // where it is in its life cycle
    const color = PALETTE[Math.floor(rand(i + 4) * PALETTE.length)];
    const baseSize = 1 + rand(i + 5) * 3; // really small

    // Loop the particle outward over and over.
    const life =
      ((frame * 0.018 * speed * pSpeed + offset) % 1 + 1) % 1;
    // Accelerate as it flies toward the edges (warp feel).
    const r = Math.pow(life, 1.9) * maxR;

    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;

    // Streak length + size grow with distance; fade in fast, out near the edge.
    const streak = 4 + life * 60 * pSpeed;
    const size = baseSize * (0.6 + life * 1.8);
    const opacity = interpolate(life, [0, 0.06, 0.8, 1], [0, 1, 1, 0]);
    const angleDeg = (angle * 180) / Math.PI;

    return (
      <div
        key={i}
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: streak,
          height: size,
          borderRadius: size,
          background: `linear-gradient(90deg, ${color}00 0%, ${color} 80%, #ffffff 100%)`,
          boxShadow: `0 0 ${size * 3}px ${color}`,
          opacity,
          transform: `translate(-100%, -50%) rotate(${angleDeg}deg)`,
          transformOrigin: "100% 50%",
        }}
      />
    );
  });

  return (
    <AbsoluteFill style={{ background, overflow: "hidden" }}>
      {/* Color burst waves blooming out to fill the screen. */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          mixBlendMode: "screen",
        }}
      >
        <div
          style={{
            width: maxR * 2,
            height: maxR * 2,
            borderRadius: "50%",
            transform: `scale(${burstScale})`,
            opacity: burstOpacity,
            background:
              "radial-gradient(circle, rgba(255,120,190,0.9) 0%, rgba(90,110,255,0.55) 38%, rgba(46,87,255,0) 70%)",
            filter: "blur(20px)",
          }}
        />
      </AbsoluteFill>

      {/* Second, offset bloom for a layered, multi-color burst. */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          mixBlendMode: "screen",
        }}
      >
        <div
          style={{
            width: maxR * 2,
            height: maxR * 2,
            borderRadius: "50%",
            transform: `scale(${interpolate(
              ((burstPhase + 0.5) % 1),
              [0, 1],
              [0.2, 2.4],
            )})`,
            opacity: interpolate(
              ((burstPhase + 0.5) % 1),
              [0, 0.12, 0.6, 1],
              [0, 0.7, 0.2, 0],
            ),
            background:
              "radial-gradient(circle, rgba(150,120,255,0.85) 0%, rgba(46,87,255,0.4) 40%, rgba(46,87,255,0) 72%)",
            filter: "blur(24px)",
          }}
        />
      </AbsoluteFill>

      {/* The streaking particles. */}
      <AbsoluteFill style={{ mixBlendMode: "screen" }}>{particles}</AbsoluteFill>

      {/* Opening flash. */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle at 50% 50%, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0) 55%)",
          opacity: kick,
          mixBlendMode: "screen",
        }}
      />

      {/* Center core glow that keeps the burst origin hot. */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle at 50% 50%, rgba(255,150,210,0.5) 0%, rgba(90,110,255,0.25) 18%, rgba(0,0,0,0) 40%)",
          mixBlendMode: "screen",
        }}
      />
    </AbsoluteFill>
  );
};

export const particleBurstDefaults: ParticleBurstProps = {
  speed: 1,
  particleCount: 320,
  background: "#05060e",
};
