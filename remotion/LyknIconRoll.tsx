import {
  AbsoluteFill,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  ICON_PATH,
  ICON_VIEWBOX,
  WORDMARK_PATH,
  WORDMARK_VIEWBOX,
} from "./brand";
import { SceneBackground } from "./SceneBackground";

// ---------------------------------------------------------------------------
// LYKN Icon Roll — the white icon drops from the sky, lands (one quick
// squash, no bounce), and immediately rolls left across the stage. As it
// rolls, the white wordmark is revealed in its wake (masked to everything
// right of the icon's trailing edge), ending on the icon + wordmark lockup.
// Dark grey background.
// ---------------------------------------------------------------------------

const BG_DARK = "#1a1a1a";
const BG_MID = "#262626";
const INK = "#ffffff";

// Stage geometry.
const FLOOR_Y = 662; // where the icon's bottom rests
const ICON_SIZE = 190;
const R = ICON_SIZE / 2;

// Wordmark sizing: scale the 480.27 x 194.53 viewBox to 168px tall.
const WM_H = 168;
const WM_W = (WM_H * 480.27) / 194.53; // ≈ 415
// Letters sit at roughly y 36..175.5 inside the viewBox; vertically center
// them on the icon's center (icon center rests at FLOOR_Y - R).
const WM_SCALE = WM_H / 194.53;
const WM_LETTER_CENTER = ((36 + 175.5) / 2) * WM_SCALE;
// negative: both the icon art and the wordmark letters have empty padding
// inside their viewBoxes, so the boxes overlap to bring the ink closer
const GAP = -30;
// positive = wordmark sits lower relative to the icon (icon reads higher)
const WM_NUDGE_Y = 12;

// Final lockup, centered.
const LOCKUP_W = ICON_SIZE + GAP + WM_W;
const LOCKUP_LEFT = (1920 - LOCKUP_W) / 2;
const X_END = LOCKUP_LEFT + R; // icon center, final
const WM_LEFT = LOCKUP_LEFT + ICON_SIZE + GAP;
const WM_TOP = FLOOR_Y - R - WM_LETTER_CENTER + WM_NUDGE_Y;

// Drop lands with the icon's trailing edge exactly at the wordmark's right
// end — the shortest roll that still reveals every letter in its wake, and
// noticeably closer to center than a full-circumference roll. The icon lands
// flat (bottom down) and spins exactly one turn over the roll, so it starts
// and ends upright; the slight contact slippage isn't perceptible.
const ROLL_DIST = LOCKUP_W - 2 * R;
const X_START = X_END + ROLL_DIST;

// Timeline (30 fps).
const T_LAND = 10;
const T_ROLL = 11;

export const LyknIconRoll: React.FC<{ black?: boolean }> = ({ black = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // gravity fall from above the frame, done at T_LAND
  const fallT = Math.min(1, frame / T_LAND);
  const lift = 940 * (1 - fallT * fallT);

  // one quick landing squash, no bounce
  let sy = 1;
  if (frame >= T_LAND && frame <= T_LAND + 5) {
    const p = (frame - T_LAND) / 5;
    sy = p < 0.4 ? 1 - 0.1 * (p / 0.4) : 0.9 + 0.1 * ((p - 0.4) / 0.6);
  }
  const sx = 1 / sy;

  // roll left with a light spring (small overshoot = settle rock-back)
  const rollP = spring({
    frame: frame - T_ROLL,
    fps,
    config: { damping: 16, stiffness: 170, mass: 1 },
  });
  const x = frame < T_ROLL ? X_START : X_START + (X_END - X_START) * rollP;
  // lands flat and spins exactly one counterclockwise turn across the roll,
  // so it's upright at both ends (rotation is keyed to travel, not radius)
  const rotDeg = (-360 * (X_START - x)) / ROLL_DIST;

  // wordmark reveal: visible only to the right of the icon's trailing edge
  const clipLeft = Math.max(0, Math.min(WM_W, x + R - WM_LEFT));

  const iconTop = FLOOR_Y - ICON_SIZE - lift;

  return (
    <AbsoluteFill
      style={{
        background: black
          ? "#000000"
          : `radial-gradient(120% 120% at 50% 32%, ${BG_MID} 0%, ${BG_DARK} 70%)`,
      }}
    >
      {!black ? <SceneBackground /> : null}
      {/* wordmark, revealed in the icon's wake */}
      <div
        style={{
          position: "absolute",
          left: WM_LEFT,
          top: WM_TOP,
          width: WM_W,
          height: WM_H,
          clipPath: `inset(0 0 0 ${clipLeft}px)`,
        }}
      >
        <svg width={WM_W} height={WM_H} viewBox={WORDMARK_VIEWBOX}>
          <path d={WORDMARK_PATH} fill={INK} />
        </svg>
      </div>

      {/* icon: position → squash (bottom anchor) → roll rotation (center) */}
      <div
        style={{
          position: "absolute",
          left: x - R,
          top: iconTop,
          width: ICON_SIZE,
          height: ICON_SIZE,
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            transform: `scale(${sx}, ${sy})`,
            transformOrigin: "50% 100%",
          }}
        >
          <svg
            width={ICON_SIZE}
            height={ICON_SIZE}
            viewBox={ICON_VIEWBOX}
            style={{
              transform: `rotate(${rotDeg}deg)`,
              transformOrigin: "50% 50%",
              display: "block",
            }}
          >
            <path d={ICON_PATH} fill={INK} />
          </svg>
        </div>
      </div>
    </AbsoluteFill>
  );
};
