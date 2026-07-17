import { useMemo } from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { SceneBackground } from "./SceneBackground";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";
import {
  Laptop,
  MousePointer,
  Wallpaper,
  SCREEN_LEFT,
  SCREEN_TOP,
  SCREEN_W,
} from "./LyknGlassOverlay";

// ---------------------------------------------------------------------------
// LYKN Voice Overlay — follows LyknGlassOverlay's language, but for voice.
// The laptop desktop sits full frame; the camera zooms into the menu-bar
// corner where the LYKN icon lives, the cursor clicks it, and the voice mode
// panel (neuron orb + status + live captions) drops out of the corner. The
// camera reframes on the panel while a quick conversation plays out.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);

// ── LYKN menu-bar icon (anchored inside the menu bar, stage coords derived) ──
const MENU_ICON_RIGHT = 150; // px from the menu bar's right edge
const MENU_ICON_SIZE = 20;
const ICON_CX = SCREEN_LEFT + SCREEN_W - MENU_ICON_RIGHT - MENU_ICON_SIZE / 2;
const ICON_CY = SCREEN_TOP + 16;

// ── voice panel, top-right corner of the screen ──
const PANEL_W = 380;
const PANEL_H = 430;
const PANEL_LEFT = SCREEN_LEFT + SCREEN_W - 14 - PANEL_W; // ≈ 1306
const PANEL_TOP = SCREEN_TOP + 40;
const PANEL_CX = PANEL_LEFT + PANEL_W / 2;
const PANEL_CY = PANEL_TOP + PANEL_H / 2;

// Timeline (30 fps).
const T_CURSOR_IN = 6;
const T_CLICK = 26;
const T_PANEL = 32;
const T_LISTEN = 44;
const T_USER_START = 52;
const T_USER_END = 92;
const T_THINK = 98;
const T_SPEAK = 122;
const T_SPEAK_END = 218;
const T_RELISTEN = 226;
export const VOICE_OVERLAY_DURATION = 260;

const USER_LINE = "What's left before the Q3 launch?";
const AI_LINE =
  "Three tasks are still open — pricing page, demo video, and beta invites. Want me to add them to your project?";

// Camera: full laptop → punch into the menu-bar corner for the click →
// pull back to frame the voice panel for the conversation. The end frame is
// pinned so the view's right edge sits on the laptop screen edge (no stage
// background peeking through on the right).
const CAM_END_Z = 2.2;
const CAM_END_CX = SCREEN_LEFT + SCREEN_W - 960 / CAM_END_Z;
const CAM_END_CY = PANEL_CY;
const CAM_T = [0, 6, 20, 34, 40, 54];
const CAM_CX = [960, 960, ICON_CX - 40, ICON_CX - 40, ICON_CX - 40, CAM_END_CX];
const CAM_CY = [540, 540, ICON_CY + 60, ICON_CY + 60, ICON_CY + 60, CAM_END_CY];
const CAM_Z = [1, 1, 4.2, 4.2, 4.2, CAM_END_Z];

// Cursor: flies in from mid-screen and lands on the menu-bar icon.
const CUR_T = [T_CURSOR_IN, T_CLICK - 2, T_CLICK + 14];
const CUR_X = [1240, ICON_CX + 3, ICON_CX + 26];
const CUR_Y = [560, ICON_CY + 3, ICON_CY + 46];

// ── mini neuron orb (small port of the in-app VoiceTechOrb) ──
const ORB_COUNT = 450;
const TILT = 0.32;
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
function buildNeurons() {
  const arr: { x: number; y: number; z: number; bobPhase: number; size: number }[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < ORB_COUNT; i++) {
    const y = 1 - (i / (ORB_COUNT - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * golden;
    arr.push({
      x: Math.cos(phi) * radius,
      y,
      z: Math.sin(phi) * radius,
      bobPhase: hash(i) * Math.PI * 2,
      size: 0.8 + hash(i + 0.3) * 1.1,
    });
  }
  return arr;
}

type Phase = "listening" | "thinking" | "speaking";

const MiniOrb: React.FC<{ frame: number; phase: Phase; size: number }> = ({
  frame,
  phase,
  size,
}) => {
  const neurons = useMemo(buildNeurons, []);
  const t = frame / 30;

  const mic =
    phase === "listening"
      ? Math.max(
          0,
          Math.min(
            1,
            0.45 + 0.3 * Math.sin(t * 5.1) + 0.2 * Math.sin(t * 8.7 + 1.4)
          )
        )
      : 0;
  const speakPulse = phase === "speaking" ? Math.sin(t * 6.5) * 0.05 : 0;
  const stateScale =
    phase === "listening"
      ? 1 + mic * 0.14
      : 1 + speakPulse + Math.sin(t * 2.2) * 0.015;

  const half = size / 2;
  const Reff = size * 0.36 * stateScale;
  const rot = t * 0.55;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);

  const dots = neurons
    .map((n) => {
      const bob = Math.sin(t * 2 + n.bobPhase) * 0.045;
      const rr = 1 + bob;
      const bx = n.x * rr;
      const by = n.y * rr;
      const bz = n.z * rr;
      const x1 = bx * cosR + bz * sinR;
      const z1 = -bx * sinR + bz * cosR;
      const y2 = by * cosT - z1 * sinT;
      const z2 = by * sinT + z1 * cosT;
      const depth = (z2 + 1) / 2;
      return {
        px: half + x1 * Reff,
        py: half - y2 * Reff,
        r: n.size * (0.4 + depth * 0.5) * (size / 320),
        a: Math.min(1, 0.18 + depth * 0.82),
        z2,
      };
    })
    .sort((p, q) => p.z2 - q.z2);

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <div
        style={{
          position: "absolute",
          inset: -size * 0.12,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(255,255,255,${phase === "speaking" ? 0.07 : 0.045}) 0%, rgba(255,255,255,0.02) 50%, transparent 72%)`,
        }}
      />
      <svg width={size} height={size} style={{ position: "absolute", inset: 0 }}>
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

export const LyknVoiceOverlay: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const camOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE } as const;
  const cxRaw = interpolate(frame, CAM_T, CAM_CX, camOpts);
  const cy = interpolate(frame, CAM_T, CAM_CY, camOpts);
  const zBase = interpolate(frame, CAM_T, CAM_Z, camOpts);
  // slow push-in while the conversation plays
  const drift = interpolate(frame, [60, VOICE_OVERLAY_DURATION], [1, 1.05], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.sin),
  });
  const z = zBase * drift;
  // once settled, keep the view's right edge pinned to the laptop screen edge
  // so the drift never reveals the stage or crops the panel
  const cx = frame >= 54 ? SCREEN_LEFT + SCREEN_W - 960 / z : cxRaw;

  // cursor
  const curX = interpolate(frame, CUR_T, CUR_X, camOpts);
  const curY = interpolate(frame, CUR_T, CUR_Y, camOpts);
  const curPress = interpolate(frame, [T_CLICK, T_CLICK + 3, T_CLICK + 7], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const curOpacity =
    interpolate(frame, [T_CURSOR_IN, T_CURSOR_IN + 5], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) *
    interpolate(frame, [T_CLICK + 10, T_CLICK + 22], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  // menu icon active highlight once clicked
  const iconActive = frame >= T_CLICK;

  // click ripple
  const rippleP = interpolate(frame, [T_CLICK, T_CLICK + 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // voice panel springs out of the corner
  const panelIn = spring({
    frame: frame - T_PANEL,
    fps,
    config: { damping: 15, stiffness: 190 },
  });

  // conversation state
  const phase: Phase =
    frame < T_THINK ? "listening" : frame < T_SPEAK ? "thinking" : frame < T_RELISTEN ? "speaking" : "listening";
  const status =
    frame < T_LISTEN
      ? "Connecting…"
      : phase === "listening"
        ? "Listening…"
        : phase === "thinking"
          ? "Thinking…"
          : "Speaking…";

  const userChars = Math.round(
    interpolate(frame, [T_USER_START, T_USER_END], [0, USER_LINE.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const aiChars = Math.round(
    interpolate(frame, [T_SPEAK, T_SPEAK_END], [0, AI_LINE.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );

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
        <Laptop
          menuExtra={
            <span
              style={{
                position: "absolute",
                right: MENU_ICON_RIGHT,
                top: 6,
                width: MENU_ICON_SIZE,
                height: MENU_ICON_SIZE,
                display: "grid",
                placeItems: "center",
                borderRadius: 5,
                background: iconActive ? "rgba(255,255,255,0.22)" : "transparent",
                boxShadow: iconActive ? "0 0 0 3px rgba(255,255,255,0.22)" : "none",
              }}
            >
              <svg viewBox={ICON_VIEWBOX} width={16} height={16} fill="none">
                <path
                  d={ICON_PATH}
                  stroke="rgba(255,255,255,0.95)"
                  strokeWidth={1.9}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </span>
          }
        >
          <Wallpaper />

          {/* voice mode panel, dropping out of the menu-bar corner */}
          {frame >= T_PANEL && (
            <div
              style={{
                position: "absolute",
                left: PANEL_LEFT - SCREEN_LEFT,
                top: PANEL_TOP - SCREEN_TOP,
                width: PANEL_W,
                height: PANEL_H,
                borderRadius: 22,
                background:
                  "linear-gradient(160deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.045) 34%, rgba(255,255,255,0.03) 100%), " +
                  "linear-gradient(rgba(16,18,26,0.66), rgba(16,18,26,0.66))",
                backdropFilter: "blur(32px) saturate(1.4)",
                WebkitBackdropFilter: "blur(32px) saturate(1.4)",
                border: "1px solid rgba(255,255,255,0.16)",
                boxShadow:
                  "0 30px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.16), 0 0 0 0.5px rgba(255,255,255,0.12)",
                opacity: Math.min(1, panelIn * 1.5),
                transform: `scale(${0.6 + panelIn * 0.4}) translateY(${(1 - panelIn) * -16}px)`,
                transformOrigin: "top right",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                padding: "18px 22px 16px",
                boxSizing: "border-box",
              }}
            >
              {/* header */}
              <div style={{ alignSelf: "stretch", display: "flex", alignItems: "center", gap: 8 }}>
                <svg
                  viewBox={ICON_VIEWBOX}
                  fill="none"
                  style={{ width: 16, height: 16, color: "#3b78ff", filter: "drop-shadow(0 0 3px rgba(59,120,255,0.8))" }}
                >
                  <path d={ICON_PATH} stroke="currentColor" strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
                </svg>
                <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: "0.14em", color: "rgba(255,255,255,0.55)" }}>
                  LYKN VOICE
                </span>
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 99,
                    background: phase === "speaking" ? "#60a5fa" : "#34d399",
                    boxShadow: `0 0 6px ${phase === "speaking" ? "rgba(96,165,250,0.9)" : "rgba(52,211,153,0.9)"}`,
                  }}
                />
              </div>

              {/* orb */}
              <div style={{ marginTop: 6 }}>
                <MiniOrb frame={frame} phase={phase} size={190} />
              </div>

              {/* status */}
              <div style={{ marginTop: 2, fontSize: 13, fontWeight: 500, color: "rgba(250,250,250,0.8)" }}>
                {status}
              </div>

              {/* captions */}
              <div
                style={{
                  alignSelf: "stretch",
                  marginTop: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {userChars > 0 && (
                  <div
                    style={{
                      alignSelf: "flex-end",
                      maxWidth: "88%",
                      padding: "7px 12px",
                      borderRadius: "12px 12px 4px 12px",
                      background: "rgba(255,255,255,0.10)",
                      border: "1px solid rgba(255,255,255,0.10)",
                      fontSize: 12.5,
                      lineHeight: 1.45,
                      color: "rgba(255,255,255,0.92)",
                    }}
                  >
                    {USER_LINE.slice(0, userChars)}
                  </div>
                )}
                {aiChars > 0 && (
                  <div
                    style={{
                      alignSelf: "flex-start",
                      maxWidth: "92%",
                      padding: "7px 12px",
                      borderRadius: "12px 12px 12px 4px",
                      background: "rgba(59,120,255,0.14)",
                      border: "1px solid rgba(96,165,250,0.22)",
                      fontSize: 12.5,
                      lineHeight: 1.45,
                      color: "rgba(255,255,255,0.92)",
                    }}
                  >
                    {AI_LINE.slice(0, aiChars)}
                  </div>
                )}
              </div>
            </div>
          )}
        </Laptop>

        {/* click ripple on the menu icon */}
        {rippleP > 0 && rippleP < 1 && (
          <div
            style={{
              position: "absolute",
              left: ICON_CX - (8 + rippleP * 26),
              top: ICON_CY - (8 + rippleP * 26),
              width: (8 + rippleP * 26) * 2,
              height: (8 + rippleP * 26) * 2,
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
