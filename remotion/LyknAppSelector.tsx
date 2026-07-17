import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { SceneBackground } from "./SceneBackground";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";
import { MousePointer, ScreenChrome, Wallpaper } from "./LyknGlassOverlay";

// ---------------------------------------------------------------------------
// LYKN App Selector — a glassmorphic launcher bar full of real AI tool icons
// pops up over a full-frame desktop preview. The camera punches into the
// right end of the bar, glides across every icon (dock-style magnify as it
// passes), and lands on the LYKN icon at the far left, where the cursor
// flies in and clicks it.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);

// ── bar geometry, centered on the full 1920x1080 frame ──
const ICON_SIZE = 84;
const ICON_GAP = 24;
const BAR_PAD = 24;
const N_ICONS = 10;
const BAR_W = N_ICONS * ICON_SIZE + (N_ICONS - 1) * ICON_GAP + BAR_PAD * 2;
const BAR_H = ICON_SIZE + BAR_PAD * 2;
const BAR_CY = 540;
const BAR_LEFT = 960 - BAR_W / 2;
const BAR_TOP = BAR_CY - BAR_H / 2;
const iconCX = (i: number) =>
  BAR_LEFT + BAR_PAD + ICON_SIZE / 2 + i * (ICON_SIZE + ICON_GAP);
const LYKN_I = 0; // far left, so the slide crosses the whole bar
const LYKN_CX = iconCX(LYKN_I);
const RIGHT_CX = iconCX(N_ICONS - 1);

// Timeline (30 fps).
const T_BAR_IN = 5;
const T_ZOOM = 16; // camera starts punching into the right end
const T_SLIDE_START = 34;
const T_SLIDE_END = 110; // camera settles on LYKN after the long glide
const T_CURSOR_IN = 100;
const T_CLICK = 122;
export const APP_SELECTOR_DURATION = 160;

// Camera keyframes.
const CAM_T = [0, T_ZOOM, T_SLIDE_START, T_SLIDE_END];
const CAM_CX = [960, 960, RIGHT_CX, LYKN_CX];
const CAM_CY = [540, 540, BAR_CY, BAR_CY];
const CAM_Z = [1, 1, 3.0, 3.0];

// Cursor flies in from below and lands on the LYKN icon.
const CUR_T = [T_CURSOR_IN, T_CLICK - 2];
const CUR_X = [LYKN_CX + 170, LYKN_CX + 6];
const CUR_Y = [BAR_CY + 160, BAR_CY + 8];

// ── app tiles: real brand glyphs (white SVGs in public/icons) on brand tiles ──
type TileDef = {
  name: string;
  bg: string;
  icon?: string; // staticFile path; LYKN renders its own stroke mark
  glyphScale?: number;
};

const TILES: TileDef[] = [
  { name: "LYKN", bg: "linear-gradient(160deg, #1e4fd6 0%, #0f2b7d 100%)" },
  { name: "OpenAI", bg: "#0d0d0f", icon: "icons/openai.svg" },
  { name: "Claude", bg: "#d97757", icon: "icons/claude.svg" },
  { name: "Gemini", bg: "linear-gradient(160deg, #1f2a5e 0%, #12131c 100%)", icon: "icons/googlegemini.svg" },
  { name: "Perplexity", bg: "#20808d", icon: "icons/perplexity.svg" },
  { name: "Copilot", bg: "linear-gradient(160deg, #6e56ff 0%, #3c2eb3 100%)", icon: "icons/githubcopilot.svg" },
  { name: "Grok", bg: "#101014", icon: "icons/grok.svg" },
  { name: "Mistral", bg: "linear-gradient(160deg, #ff8205 0%, #fa500f 100%)", icon: "icons/mistralai.svg" },
  { name: "DeepSeek", bg: "#4d6bfe", icon: "icons/deepseek.svg" },
  { name: "Midjourney", bg: "linear-gradient(160deg, #23253a 0%, #101120 100%)", icon: "icons/midjourney.svg", glyphScale: 1.12 },
];

const Tile: React.FC<{ def: TileDef }> = ({ def }) => (
  <div
    style={{
      width: ICON_SIZE,
      height: ICON_SIZE,
      borderRadius: 20,
      background: def.bg,
      boxShadow:
        "0 6px 16px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.18)",
      display: "grid",
      placeItems: "center",
      overflow: "hidden",
      flex: "none",
    }}
  >
    {def.icon ? (
      <Img
        src={staticFile(def.icon)}
        style={{
          width: ICON_SIZE * 0.55 * (def.glyphScale ?? 1),
          height: ICON_SIZE * 0.55 * (def.glyphScale ?? 1),
        }}
      />
    ) : (
      <svg viewBox={ICON_VIEWBOX} width={ICON_SIZE * 0.62} height={ICON_SIZE * 0.62}>
        <path d={ICON_PATH} fill="#ffffff" />
      </svg>
    )}
  </div>
);

export const LyknAppSelector: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const camOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE } as const;
  const cx = interpolate(frame, CAM_T, CAM_CX, camOpts);
  const cy = interpolate(frame, CAM_T, CAM_CY, camOpts);
  const z = interpolate(frame, CAM_T, CAM_Z, camOpts);

  // bar entrance: appears whole but stretched wide and squashed, then
  // bounces back and clicks into place (spring overshoot dips past 1)
  const barIn = spring({
    frame: frame - T_BAR_IN,
    fps,
    config: { damping: 7.5, stiffness: 130, mass: 0.85 },
  });
  const barOpacity = interpolate(frame, [T_BAR_IN, T_BAR_IN + 4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const barScaleX = interpolate(barIn, [0, 1], [1.9, 1]);
  const barScaleY = interpolate(barIn, [0, 1], [0.45, 1]);

  // cursor
  const curX = interpolate(frame, CUR_T, CUR_X, camOpts);
  const curY = interpolate(frame, CUR_T, CUR_Y, camOpts);
  const curPress = interpolate(frame, [T_CLICK, T_CLICK + 3, T_CLICK + 7], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const curOpacity = interpolate(frame, [T_CURSOR_IN, T_CURSOR_IN + 6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // click ripple
  const rippleP = interpolate(frame, [T_CLICK, T_CLICK + 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // LYKN icon punch on click
  const clickPunch = spring({
    frame: frame - T_CLICK,
    fps,
    config: { damping: 10, stiffness: 240 },
  });
  const clicked = frame >= T_CLICK;

  return (
    <AbsoluteFill
      style={{
        background: "#141416",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      }}
    >
      <SceneBackground />

      {/* camera rig */}
      <div
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          transformOrigin: "0 0",
          transform: `translate(960px, 540px) scale(${z}) translate(${-cx}px, ${-cy}px)`,
        }}
      >
        {/* full-frame desktop preview */}
        <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
          <Wallpaper />
          <ScreenChrome hideDock />
        </div>

        {/* glassmorphic app selector bar — pops in stretched wide, bounces,
        and clicks into place */}
        <div
          style={{
            position: "absolute",
            left: BAR_LEFT,
            top: BAR_TOP,
            width: BAR_W,
            height: BAR_H,
            borderRadius: 32,
            background:
              "linear-gradient(160deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.07) 40%, rgba(255,255,255,0.05) 100%), " +
              "linear-gradient(rgba(18,20,28,0.42), rgba(18,20,28,0.42))",
            backdropFilter: "blur(30px) saturate(1.5)",
            WebkitBackdropFilter: "blur(30px) saturate(1.5)",
            border: "1px solid rgba(255,255,255,0.22)",
            boxShadow:
              "0 30px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.22), 0 0 0 0.5px rgba(255,255,255,0.12)",
            display: "flex",
            alignItems: "center",
            gap: ICON_GAP,
            padding: `0 ${BAR_PAD}px`,
            boxSizing: "border-box",
            opacity: barOpacity,
            transform: `scale(${barScaleX}, ${barScaleY})`,
            transformOrigin: "center",
          }}
        >
          {TILES.map((def, i) => {
            // dock-style magnify as the camera glides over each icon
            const zoomed = interpolate(frame, [T_ZOOM, T_SLIDE_START], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            const d = (iconCX(i) - cx) / 140;
            const magnify = 1 + zoomed * 0.16 * Math.exp(-d * d);
            const isLykn = i === LYKN_I;
            const punch = isLykn && clicked ? 0.88 + clickPunch * 0.12 : 1;
            const lyknLift = isLykn && clicked ? clickPunch * 0.14 : 0;
            const dimOthers = !isLykn && clicked ? clickPunch * 0.35 : 0;
            return (
              <div
                key={def.name}
                style={{
                  transform: `scale(${(magnify + lyknLift) * punch})`,
                  transformOrigin: "center",
                  opacity: 1 - dimOthers,
                  filter:
                    isLykn && clicked
                      ? `drop-shadow(0 0 ${10 + clickPunch * 14}px rgba(77,141,255,${0.5 * clickPunch}))`
                      : "none",
                }}
              >
                <Tile def={def} />
              </div>
            );
          })}
        </div>

        {/* click ripple on the LYKN icon */}
        {rippleP > 0 && rippleP < 1 && (
          <div
            style={{
              position: "absolute",
              left: LYKN_CX - (12 + rippleP * 36),
              top: BAR_CY - (12 + rippleP * 36),
              width: (12 + rippleP * 36) * 2,
              height: (12 + rippleP * 36) * 2,
              borderRadius: 99,
              border: "1.5px solid rgba(96,165,250,0.9)",
              opacity: (1 - rippleP) * 0.9,
            }}
          />
        )}

        {/* mouse cursor */}
        {curOpacity > 0 && (
          <MousePointer x={curX} y={curY} press={curPress} opacity={curOpacity} />
        )}
      </div>
    </AbsoluteFill>
  );
};
