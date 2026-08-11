import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  ICON_PATH,
  ICON_VIEWBOX,
  WHITE,
  WORDMARK_PATH,
  WORDMARK_VIEWBOX,
} from "./brand";
import { SceneBackground } from "./SceneBackground";

const LOGO_FILL = WHITE;
const LOGO_GLOW = WHITE;
const WORDMARK_FILL = WHITE;

// Lockup sizing (px).
const ICON_SIZE = 248;
const WORDMARK_H = 200;
const WORDMARK_W = Math.round((WORDMARK_H * 480.27) / 194.53); // keep aspect
// Negative because the wordmark SVG has built-in left whitespace inside its
// viewBox; this pulls the "L" right up against the icon.
const GAP = -34;

export type LyknLogoRevealProps = {
  background: string;
  /** Multiplier on the whole lockup size (1 = original). */
  scale?: number;
  /** Animation speed multiplier (2 = twice as fast). */
  speed?: number;
};

export const LyknLogoReveal: React.FC<LyknLogoRevealProps> = ({
  background,
  scale = 1,
  speed = 1,
}) => {
  const rawFrame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const frame = rawFrame * speed;

  // 1) Icon traces on (stroke draw via normalized pathLength).
  const draw = interpolate(frame, [0, 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });

  // 2) Icon pops in with a spring (scale + slight rotate settle).
  const pop = spring({
    frame,
    fps,
    config: { damping: 14, mass: 0.7, stiffness: 120 },
  });
  const iconScale = interpolate(pop, [0, 1], [0.82, 1]);
  const iconRotate = interpolate(pop, [0, 1], [-9, 0]);

  // 3) Fill fades in; the traced stroke fades out underneath it.
  const fillOpacity = interpolate(frame, [26, 50], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const strokeOpacity = interpolate(frame, [30, 48], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Glow behind the icon blooms as it fills.
  const glow = interpolate(frame, [28, 56], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // 4) Wordmark wipes open (icon glides left to center the full lockup).
  const reveal = interpolate(frame, [54, 90], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const wordWidth = reveal * WORDMARK_W;
  const wordGap = reveal * GAP;
  const wordOpacity = interpolate(frame, [54, 74], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // "transparent" renders the lockup alone (alpha video for the desktop
  // welcome splash) — no studio backdrop.
  const transparent = background === "transparent";

  return (
    <AbsoluteFill
      style={{
        background,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {transparent ? null : <SceneBackground />}
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${scale})`,
        }}
      >
        {/* Icon */}
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          style={{
            transform: `scale(${iconScale}) rotate(${iconRotate}deg)`,
            filter: `drop-shadow(0 0 ${28 * glow}px ${LOGO_GLOW}99)`,
            overflow: "visible",
          }}
        >
          <path
            d={ICON_PATH}
            pathLength={1}
            fill={LOGO_FILL}
            fillOpacity={fillOpacity}
            stroke={LOGO_GLOW}
            strokeWidth={2.4}
            strokeOpacity={strokeOpacity}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={1}
            strokeDashoffset={1 - draw}
          />
        </svg>

        {/* Wordmark wrapper animates its width so the row stays centered
            and the icon glides left as the wordmark wipes open. */}
        <div
          style={{
            width: wordWidth,
            marginLeft: wordGap,
            height: WORDMARK_H,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
          }}
        >
          <svg
            width={WORDMARK_W}
            height={WORDMARK_H}
            viewBox={WORDMARK_VIEWBOX}
            style={{
              flex: "0 0 auto",
              opacity: wordOpacity,
              filter: `drop-shadow(0 0 ${22 * glow}px ${LOGO_GLOW}66)`,
            }}
          >
            <path d={WORDMARK_PATH} fill={WORDMARK_FILL} />
          </svg>
        </div>
      </div>
    </AbsoluteFill>
  );
};
