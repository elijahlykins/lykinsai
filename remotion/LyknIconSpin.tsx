import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { SceneBackground } from "./SceneBackground";
import {
  ICON_BODY_PATH,
  ICON_SPARKLE_CX,
  ICON_SPARKLE_CY,
  ICON_SPARKLE_PATH,
  ICON_VIEWBOX,
  WHITE,
} from "./brand";

const ICON_SIZE = 420;

export type LyknIconSpinProps = {
  background: string;
  iconColor: string;
  glowColor: string;
};

export const LyknIconSpin: React.FC<LyknIconSpinProps> = ({
  background,
  iconColor,
  glowColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // --- Body: clean modern reveal (spring scale + fade + settle rotate) ---
  const bodyEnter = spring({
    frame,
    fps,
    config: { damping: 13, mass: 0.85, stiffness: 110 },
  });
  const bodyScale = interpolate(bodyEnter, [0, 1], [0.72, 1]);
  const bodyRotate = interpolate(bodyEnter, [0, 1], [-8, 0]);
  const bodyOpacity = interpolate(frame, [0, 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // --- Sparkle: pops in after the body, then spins + blinks forever ---
  const sparkleAppear = spring({
    frame: frame - 18,
    fps,
    config: { damping: 10, mass: 0.6, stiffness: 140 },
  });
  const spin = frame * 5; // continuous rotation (deg)
  // Sharp twinkle: sine raised to a power gives a quick blink peak.
  const blink = Math.pow(0.5 + 0.5 * Math.sin((frame * Math.PI * 2) / 24), 3);
  const sparkleScale = (0.78 + 0.5 * blink) * sparkleAppear;
  const sparkleOpacity =
    Math.min(1, 0.4 + 0.6 * blink) * Math.min(1, sparkleAppear);

  // --- Whole-icon life: gentle float + breathing ---
  const floatY = Math.sin(frame * 0.06) * 7;
  const breathe = 1 + 0.015 * Math.sin(frame * 0.05);

  // Ambient white glow that blooms in with the icon and pulses with the blink.
  const ambientGlow = bodyOpacity * (0.16 + 0.12 * blink);

  const cx = ICON_SPARKLE_CX;
  const cy = ICON_SPARKLE_CY;

  return (
    <AbsoluteFill
      style={{
        background,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <SceneBackground />
      {/* Soft radial vignette for depth */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle at 50% 42%, rgba(255,255,255,0.10), transparent 45%), radial-gradient(circle at 50% 100%, rgba(0,0,0,0.28), transparent 60%)",
        }}
      />

      {/* Ambient white glow behind the icon */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 50%, ${glowColor}, transparent 52%)`,
          opacity: ambientGlow,
        }}
      />

      <div
        style={{
          transform: `translateY(${floatY}px) scale(${breathe})`,
        }}
      >
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          style={{
            overflow: "visible",
            filter: `drop-shadow(0 0 26px ${glowColor}aa)`,
          }}
        >
          {/* Swirl body — revealed, then holds */}
          <g
            style={{
              transformBox: "fill-box",
              transformOrigin: "center",
              transform: `rotate(${bodyRotate}deg) scale(${bodyScale})`,
              opacity: bodyOpacity,
            }}
          >
            <path d={ICON_BODY_PATH} fill={iconColor} />
          </g>

          {/* Sparkle — spins around its own center + twinkles */}
          <g
            transform={`rotate(${spin} ${cx} ${cy}) translate(${cx} ${cy}) scale(${sparkleScale}) translate(${-cx} ${-cy})`}
            opacity={sparkleOpacity}
          >
            <path d={ICON_SPARKLE_PATH} fill={iconColor} />
          </g>
        </svg>
      </div>
    </AbsoluteFill>
  );
};

export const lyknIconSpinDefaults: LyknIconSpinProps = {
  background:
    "radial-gradient(circle at 50% 38%, #3b74ff 0%, #1a4ee2 46%, #0e2f9e 100%)",
  iconColor: WHITE,
  glowColor: WHITE,
};
