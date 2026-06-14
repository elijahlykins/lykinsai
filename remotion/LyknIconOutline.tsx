import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { ICON_PATH, ICON_VIEWBOX, WHITE } from "./brand";

const ICON_SIZE = 440;

export type LyknIconOutlineProps = {
  background: string;
  iconColor: string;
};

export const LyknIconOutline: React.FC<LyknIconOutlineProps> = ({
  background,
  iconColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Trace the outline on (normalized pathLength stroke draw).
  const draw = interpolate(frame, [0, 46], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });

  // Spring pop (scale + slight rotate settle).
  const pop = spring({
    frame,
    fps,
    config: { damping: 14, mass: 0.8, stiffness: 110 },
  });
  const iconScale = interpolate(pop, [0, 1], [0.84, 1]);
  const iconRotate = interpolate(pop, [0, 1], [-8, 0]);

  // Fill fades in as the traced stroke fades out underneath it.
  const fillOpacity = interpolate(frame, [30, 56], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const strokeOpacity = interpolate(frame, [34, 54], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Glow blooms as it fills.
  const glow = interpolate(frame, [32, 62], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Gentle life once settled.
  const floatY = Math.sin(frame * 0.06) * 6;

  return (
    <AbsoluteFill
      style={{
        background,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* Ambient glow */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 50%, ${iconColor}, transparent 52%)`,
          opacity: glow * 0.18,
        }}
      />

      <svg
        width={ICON_SIZE}
        height={ICON_SIZE}
        viewBox={ICON_VIEWBOX}
        style={{
          transform: `translateY(${floatY}px) scale(${iconScale}) rotate(${iconRotate}deg)`,
          filter: `drop-shadow(0 0 ${26 * glow}px ${iconColor}aa)`,
          overflow: "visible",
        }}
      >
        <path
          d={ICON_PATH}
          pathLength={1}
          fill={iconColor}
          fillOpacity={fillOpacity}
          stroke={iconColor}
          strokeWidth={2.4}
          strokeOpacity={strokeOpacity}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={1}
          strokeDashoffset={1 - draw}
        />
      </svg>
    </AbsoluteFill>
  );
};

export const lyknIconOutlineDefaults: LyknIconOutlineProps = {
  background:
    "linear-gradient(160deg, #3b74ff 0%, #1a4ee2 55%, #0e2f9e 100%)",
  iconColor: WHITE,
};
