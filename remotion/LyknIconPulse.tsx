import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { SceneBackground } from "./SceneBackground";
import {
  BRAND_BLUE,
  ICON_BODY_PATH,
  ICON_SPARKLE_CX,
  ICON_SPARKLE_CY,
  ICON_SPARKLE_PATH,
  ICON_VIEWBOX,
  WHITE,
} from "./brand";

const ICON_SIZE = 380;
const RING_BASE = 340; // px diameter where a ring is born
const RING_COUNT = 4;
const RING_PERIOD = 38; // frames between pulses
const PULSE_START = 18; // frame the pulses begin

export type LyknIconPulseProps = {
  background: string;
  iconColor: string;
  haloColor: string;
};

export const LyknIconPulse: React.FC<LyknIconPulseProps> = ({
  background,
  iconColor,
  haloColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Icon entrance.
  const enter = spring({
    frame,
    fps,
    config: { damping: 12, mass: 0.8, stiffness: 120 },
  });
  const iconScale = interpolate(enter, [0, 1], [0.6, 1]);
  const iconOpacity = interpolate(frame, [0, 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Beat phase (0..1 each pulse) drives the sparkle twinkle + glow swell.
  const beat = ((frame - PULSE_START) % RING_PERIOD) / RING_PERIOD;
  const beatPulse =
    frame > PULSE_START ? Math.pow(1 - Math.min(1, beat), 2.2) : 0;

  // Gentle life.
  const floatY = Math.sin(frame * 0.06) * 8;
  const breathe = 1 + 0.02 * Math.sin(frame * 0.05);

  // Rotating colored halo behind the icon.
  const haloRot = frame * 1.1;
  const haloScale = interpolate(enter, [0, 1], [0.7, 1]);

  // Sparkle twinkle on the beat (subtle here; the rings are the star).
  const sparkleScale = 0.92 + 0.22 * beatPulse;
  const sparkleOpacity = 0.7 + 0.3 * beatPulse;

  const cx = ICON_SPARKLE_CX;
  const cy = ICON_SPARKLE_CY;

  const rings = Array.from({ length: RING_COUNT }, (_, i) => {
    const p =
      frame > PULSE_START
        ? ((frame - PULSE_START) / RING_PERIOD + i / RING_COUNT) % 1
        : -1;
    if (p < 0) return null;
    const scale = interpolate(p, [0, 1], [1, 3]);
    const opacity = interpolate(p, [0, 0.12, 1], [0, 0.45, 0]);
    return (
      <div
        key={i}
        style={{
          position: "absolute",
          width: RING_BASE,
          height: RING_BASE,
          borderRadius: "50%",
          border: `2px solid ${haloColor}`,
          transform: `scale(${scale})`,
          opacity: opacity * iconOpacity,
        }}
      />
    );
  });

  return (
    <AbsoluteFill
      style={{
        background,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <SceneBackground />
      {/* Rotating colored glow halo */}
      <div
        style={{
          position: "absolute",
          width: 620,
          height: 620,
          borderRadius: "50%",
          background: `conic-gradient(from 0deg, ${haloColor}, ${BRAND_BLUE}, transparent 55%, ${haloColor})`,
          filter: "blur(70px)",
          opacity: 0.55 * iconOpacity * (0.85 + 0.15 * beatPulse),
          transform: `rotate(${haloRot}deg) scale(${haloScale})`,
        }}
      />

      {/* Sonar rings */}
      {rings}

      {/* Icon */}
      <div
        style={{
          transform: `translateY(${floatY}px) scale(${iconScale * breathe})`,
          opacity: iconOpacity,
        }}
      >
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          style={{
            overflow: "visible",
            filter: `drop-shadow(0 0 ${22 + 14 * beatPulse}px ${haloColor}cc)`,
          }}
        >
          <path d={ICON_BODY_PATH} fill={iconColor} />
          <g
            transform={`translate(${cx} ${cy}) scale(${sparkleScale}) translate(${-cx} ${-cy})`}
            opacity={sparkleOpacity}
          >
            <path d={ICON_SPARKLE_PATH} fill={iconColor} />
          </g>
        </svg>
      </div>
    </AbsoluteFill>
  );
};

export const lyknIconPulseDefaults: LyknIconPulseProps = {
  background:
    "radial-gradient(circle at 50% 42%, #131a33 0%, #07080f 70%)",
  iconColor: WHITE,
  haloColor: "#6f9bff",
};
