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

// ---------------------------------------------------------------------------
// LYKN Chat — camera edition. The chat page sits in the preview-card window
// on the blue gradient. The camera zooms into the chat bar's model selector,
// a dropdown opens and the model switches to Claude, then the camera glides
// to the mic button, the mic is pressed, and the whole page melts into voice
// mode with the neuron orb. Ends on a slow push-in toward the orb.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);
const APP_BG = "#1e1e1e";
const SIDEBAR_BG = "#292929";
const TXT = "rgba(255,255,255,0.92)";
const TXT_60 = "rgba(255,255,255,0.6)";
const TXT_45 = "rgba(255,255,255,0.45)";
const TXT_40 = "rgba(255,255,255,0.4)";
const TXT_35 = "rgba(255,255,255,0.35)";
const BLUE_400 = "#60a5fa";
const BLUE_500_10 = "rgba(59,130,246,0.10)";
const GREEN_400 = "#4ade80";

// Preview-card window (matches .lykn-wake-subwindow).
const BODY_W = 1680;
const BODY_H = 945;
const CHROME_H = 46;
const WIN_W = BODY_W;
const WIN_H = BODY_H + CHROME_H;
const WIN_LEFT = (1920 - WIN_W) / 2;
const WIN_TOP = (1080 - WIN_H) / 2;
const WIN_SCALE = BODY_W / 1920;

// App layout (authored at 1920x1080, collapsed icon rail).
const RAIL_W = 72;
const MAIN_X = RAIL_W;
const MAIN_W = 1920 - RAIL_W;
const MAIN_CX = MAIN_X + MAIN_W / 2;
const COL_W = 760;
const COL_LEFT = MAIN_CX - COL_W / 2;
const BAR_TOP = 884;

// Orb placement (voice mode, centered in main area).
const ORB_CX = MAIN_CX;
const ORB_CY = 452;
const ORB_R = 226;
const DOT_SCALE = 2.1;

// ── timeline ──
const T_MODEL_PRESS = 84;
const T_DD_OPEN = 88;
const T_HL_1 = 110; // highlight GPT
const T_HL_2 = 134; // highlight Claude
const T_SELECT = 164; // Claude selected (flash)
const T_DD_CLOSE = 174;
const T_LABEL_POP = 176;
const T_MIC_PRESS = 248;
const T_VOICE_IN = 256; // chat → voice crossfade start
const T_VOICE_DONE = 296;

const MODELS = [
  { name: "LYKN", tag: "Default", dot: "#f2f2f2" },
  { name: "GPT-5.6", tag: "OpenAI", dot: "#4ade80" },
  { name: "Claude Sonnet 4.6", tag: "Anthropic", dot: "#f59e0b" },
  { name: "Gemini 3.1 Pro", tag: "Google", dot: "#60a5fa" },
];
const SELECTED_MODEL = 2;

// ── camera ──
const toSceneX = (x: number) => WIN_LEFT + x * WIN_SCALE;
const toSceneY = (y: number) => WIN_TOP + CHROME_H + y * WIN_SCALE;

function focusOn(rect: { x: number; y: number; w: number; h: number }, pad = 1.12) {
  return {
    cx: toSceneX(rect.x + rect.w / 2),
    cy: toSceneY(rect.y + rect.h / 2),
    z: Math.min(
      1920 / (rect.w * WIN_SCALE * pad),
      1080 / (rect.h * WIN_SCALE * pad)
    ),
  };
}

const SHOT_MODEL = focusOn({ x: 600, y: 620, w: 520, h: 400 });
const SHOT_MIC = focusOn({ x: 1040, y: 840, w: 420, h: 260 });
const SHOT_ORB = {
  cx: toSceneX(ORB_CX),
  cy: toSceneY(ORB_CY + 60),
  z: 1.18,
};

const CAM_T = [0, 40, 56, 96, 190, 238, 268, 320, 400, 540];
const CAM_CX = [960, 960, 960, SHOT_MODEL.cx, SHOT_MODEL.cx, SHOT_MIC.cx, SHOT_MIC.cx, 960, 960, SHOT_ORB.cx];
const CAM_CY = [540, 540, 540, SHOT_MODEL.cy, SHOT_MODEL.cy, SHOT_MIC.cy, SHOT_MIC.cy, 540, 540, SHOT_ORB.cy];
const CAM_Z = [1.045, 1, 1, SHOT_MODEL.z, SHOT_MODEL.z * 1.03, SHOT_MIC.z, SHOT_MIC.z * 1.02, 1, 1, SHOT_ORB.z];

// ── icons ──
const Icon: React.FC<{
  size?: number;
  color?: string;
  sw?: number;
  children: React.ReactNode;
}> = ({ size = 16, color = TXT_60, sw = 2, children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
  >
    {children}
  </svg>
);

const ICONS = {
  edit: (
    <>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="m18 2 4 4-9.5 9.5L8 17l1.5-4.5z" />
    </>
  ),
  message: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />,
  plug: (
    <>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </>
  ),
  calendar: (
    <>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width={18} height={18} x={3} y={4} rx={2} />
      <path d="M3 10h18" />
    </>
  ),
  folder: (
    <>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <path d="M8 10v6" />
      <path d="M12 10v3" />
      <path d="M16 10v5" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  mic: (
    <>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1={12} x2={12} y1={19} y2={22} />
    </>
  ),
  arrowUp: (
    <>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  check: <path d="M20 6 9 17l-5-5" />,
  paperclip: (
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  ),
};

const LyknMark: React.FC<{ size: number; color?: string }> = ({
  size,
  color = "#f2f2f2",
}) => (
  <svg width={size} height={size} viewBox={ICON_VIEWBOX} style={{ flexShrink: 0 }}>
    <path d={ICON_PATH} fill={color} />
  </svg>
);

const RailBtn: React.FC<{ active?: boolean; children: React.ReactNode }> = ({
  active,
  children,
}) => (
  <div
    style={{
      width: 42,
      height: 42,
      borderRadius: 10,
      background: active ? BLUE_500_10 : "transparent",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    {children}
  </div>
);

// expanding click ripple ring
const Ripple: React.FC<{ frame: number; at: number; cx: number; cy: number }> = ({
  frame,
  at,
  cx,
  cy,
}) => {
  if (frame < at || frame > at + 26) return null;
  const p = (frame - at) / 26;
  const r = 14 + p * 44;
  return (
    <div
      style={{
        position: "absolute",
        left: cx - r,
        top: cy - r,
        width: r * 2,
        height: r * 2,
        borderRadius: 99,
        border: "2px solid rgba(96,165,250,0.8)",
        opacity: (1 - p) * 0.9,
        pointerEvents: "none",
      }}
    />
  );
};

// ── neuron orb (same math as VoiceTechOrb) ──
const COUNT = 700;
const TILT = 0.32;
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

function reveal(frame: number, start: number, dur = 20, dist = 16) {
  const opacity = interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const y = interpolate(frame, [start, start + dur], [dist, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  return { opacity, transform: `translateY(${y}px)` };
}

export const LyknChatZoom: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const neurons = useMemo(buildNeurons, []);
  const tsec = frame / fps;

  // ── camera ──
  const camOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE } as const;
  const cx = interpolate(frame, CAM_T, CAM_CX, camOpts);
  const cy = interpolate(frame, CAM_T, CAM_CY, camOpts);
  const z = interpolate(frame, CAM_T, CAM_Z, camOpts);

  // ── model dropdown ──
  const ddSpring = spring({
    frame: frame - T_DD_OPEN,
    fps,
    config: { damping: 16, stiffness: 170 },
  });
  const ddClose = interpolate(frame, [T_DD_CLOSE, T_DD_CLOSE + 12], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const ddVisible = frame >= T_DD_OPEN && frame < T_DD_CLOSE + 12;
  const ddScale = Math.min(ddSpring, 1) * (0.9 + ddClose * 0.1);
  const ddOpacity = Math.min(ddSpring * 1.4, 1) * ddClose;

  const highlightIdx = frame >= T_HL_2 ? 2 : frame >= T_HL_1 ? 1 : 0;
  const selectFlash =
    frame >= T_SELECT && frame < T_SELECT + 12
      ? interpolate(frame, [T_SELECT, T_SELECT + 4, T_SELECT + 12], [0, 1, 0.4], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 0;
  const currentModel = frame >= T_SELECT + 4 ? SELECTED_MODEL : 0;

  // model button press dip + label pop
  const modelPress = interpolate(frame, [T_MODEL_PRESS, T_MODEL_PRESS + 5, T_MODEL_PRESS + 11], [1, 0.92, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const labelPop = interpolate(frame, [T_LABEL_POP, T_LABEL_POP + 6, T_LABEL_POP + 16], [1, 1.18, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const labelGlow = interpolate(frame, [T_LABEL_POP, T_LABEL_POP + 8, T_LABEL_POP + 40], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ── mic press + voice transition ──
  const micPress = interpolate(frame, [T_MIC_PRESS, T_MIC_PRESS + 5, T_MIC_PRESS + 11], [1, 0.88, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const micActive = frame >= T_MIC_PRESS;
  const voiceT = interpolate(frame, [T_VOICE_IN, T_VOICE_DONE], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  // ── voice status + orb energy ──
  const status =
    frame < 320 ? "Connecting…" : frame < 402 ? "Listening…" : "Speaking…";
  const intensity = interpolate(frame, [T_VOICE_IN, 320, 402, 430], [0.5, 0.66, 0.74, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const activity = interpolate(frame, [T_VOICE_IN, 320, 402, 430], [0.18, 0.34, 0.48, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const speaking = interpolate(frame, [402, 428], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const rot = tsec * 0.32;
  const orbPulse =
    1 +
    Math.sin(tsec * 1.4) * 0.015 * (1 - speaking) +
    Math.sin(tsec * 6.5) * 0.05 * speaking;
  const Reff = ORB_R * orbPulse * (0.85 + voiceT * 0.15);

  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);

  const dots =
    voiceT > 0
      ? neurons
          .map((n) => {
            const bob = Math.sin(tsec * 1.6 + n.bobPhase) * (0.018 + activity * 0.05);
            const drift = (0.01 + activity * 0.06) * Math.sin(tsec * 1.1 + n.driftPhase);
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

            const px = ORB_CX + x1 * Reff;
            const py = ORB_CY - y2 * Reff;
            const depth = (z2 + 1) / 2;
            const a = Math.min(1, (0.18 + depth * 0.82) * intensity) * voiceT;
            const r = n.size * (0.5 + depth * 0.55) * DOT_SCALE;
            return { px, py, r, a, z2 };
          })
          .sort((p, q) => p.z2 - q.z2)
      : [];

  const modelName = MODELS[currentModel].name;

  return (
    <AbsoluteFill
      style={{
        background: "#0a205f",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      {/* backdrop stays fixed while the camera zooms */}
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
        {/* preview window */}
        <div
          style={{
            position: "absolute",
            left: WIN_LEFT,
            top: WIN_TOP,
            width: WIN_W,
            height: WIN_H,
            borderRadius: 16,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            border: "1px solid rgba(255,255,255,0.14)",
            boxShadow:
              "0 50px 110px -24px rgba(4,12,40,0.62), 0 18px 50px -30px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.05)",
          }}
        >
          {/* chrome */}
          <div
            style={{
              flex: "0 0 auto",
              height: CHROME_H,
              display: "flex",
              alignItems: "center",
              gap: 11,
              padding: "0 15px",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              background: "#2b2b2b",
              boxSizing: "border-box",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 11, height: 11, borderRadius: 99, background: "rgba(248,113,113,0.55)" }} />
              <span style={{ width: 11, height: 11, borderRadius: 99, background: "rgba(251,191,36,0.55)" }} />
              <span style={{ width: 11, height: 11, borderRadius: 99, background: "rgba(74,222,128,0.55)" }} />
            </div>
            <span style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: "0.02em", color: "rgba(255,255,255,0.72)" }}>
              LYKN — Chat
            </span>
          </div>

          {/* body */}
          <div style={{ position: "relative", width: BODY_W, height: BODY_H, overflow: "hidden" }}>
            <div style={{ width: 1920, height: 1080, transformOrigin: "0 0", transform: `scale(${WIN_SCALE})` }}>
              <div style={{ position: "absolute", width: 1920, height: 1080, background: APP_BG, overflow: "hidden" }}>
                {/* rail */}
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: RAIL_W,
                    height: 1080,
                    background: SIDEBAR_BG,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    padding: "16px 0 18px",
                    boxSizing: "border-box",
                    zIndex: 5,
                  }}
                >
                  <div style={{ marginBottom: 20 }}>
                    <LyknMark size={28} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                    <RailBtn><Icon size={19} color={TXT_60}>{ICONS.edit}</Icon></RailBtn>
                    <RailBtn active><Icon size={19} color={BLUE_400}>{ICONS.message}</Icon></RailBtn>
                    <RailBtn><Icon size={19} color={TXT_60}>{ICONS.plug}</Icon></RailBtn>
                    <RailBtn><Icon size={19} color={TXT_60}>{ICONS.calendar}</Icon></RailBtn>
                    <RailBtn><Icon size={19} color={TXT_60}>{ICONS.folder}</Icon></RailBtn>
                  </div>
                  <div style={{ flex: 1 }} />
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 99,
                      background: "rgba(96,165,250,0.2)",
                      color: BLUE_400,
                      fontSize: 13,
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    E
                  </div>
                </div>

                {/* ── chat UI (fades out into voice mode) ── */}
                <div style={{ position: "absolute", inset: 0, opacity: 1 - voiceT, transform: `scale(${1 - voiceT * 0.02})`, transformOrigin: "50% 60%" }}>
                  {/* thread */}
                  <div
                    style={{
                      position: "absolute",
                      left: MAIN_X,
                      top: 0,
                      width: MAIN_W,
                      height: BAR_TOP - 30,
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "flex-end",
                      alignItems: "center",
                      padding: "0 40px 10px",
                      boxSizing: "border-box",
                    }}
                  >
                    <div style={{ width: COL_W, display: "flex", flexDirection: "column", gap: 20 }}>
                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <div
                          style={{
                            maxWidth: "80%",
                            background: APP_BG,
                            border: "1px solid rgba(255,255,255,0.10)",
                            borderRadius: "16px 16px 6px 16px",
                            boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
                            padding: "13px 17px",
                            fontSize: 18,
                            lineHeight: 1.5,
                            color: "rgba(255,255,255,0.9)",
                          }}
                        >
                          Draft a tagline for the Q3 launch.
                        </div>
                      </div>

                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "2px 0" }}>
                          <Icon size={18} color={TXT_40}>{ICONS.chevronDown}</Icon>
                          <LyknMark size={20} />
                          <span style={{ fontSize: 17, color: TXT_40, fontWeight: 500 }}>AI Response</span>
                          <span style={{ fontSize: 17, color: TXT_35, fontWeight: 500 }}>· LYKN</span>
                          <Icon size={17} color={GREEN_400} sw={2.5}>{ICONS.check}</Icon>
                        </div>
                        <div style={{ paddingTop: 12, fontSize: 19, color: "rgba(255,255,255,0.9)", lineHeight: 1.55 }}>
                          "Your AI, everywhere you work." Want a couple more options, or should we
                          punch this one up?
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* ── chat bar ── */}
                  <div
                    style={{
                      position: "absolute",
                      left: COL_LEFT,
                      top: BAR_TOP,
                      width: COL_W,
                      padding: 14,
                      boxSizing: "border-box",
                      borderRadius: 14,
                      background: "linear-gradient(145deg, #343840, #282c32)",
                      border: "1px solid rgba(255,255,255,0.05)",
                      boxShadow:
                        "0 4px 16px rgba(0,0,0,0.45), 0 1.5px 4px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.07)",
                    }}
                  >
                    <div
                      style={{
                        minHeight: 52,
                        padding: "8px 12px",
                        fontSize: 18,
                        lineHeight: 1.35,
                        color: TXT_45,
                        display: "flex",
                        alignItems: "center",
                      }}
                    >
                      Ask me anything...
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 4 }}>
                      {/* model selector */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "0 10px",
                          height: 36,
                          fontSize: 15,
                          fontWeight: 500,
                          borderRadius: 10,
                          color: labelGlow > 0.1 ? BLUE_400 : TXT_60,
                          background:
                            ddVisible || labelGlow > 0.1
                              ? "rgba(96,165,250,0.10)"
                              : "rgba(255,255,255,0.04)",
                          border: `1px solid ${ddVisible || labelGlow > 0.1 ? "rgba(96,165,250,0.35)" : "rgba(255,255,255,0.06)"}`,
                          transform: `scale(${modelPress * labelPop})`,
                          transformOrigin: "left center",
                        }}
                      >
                        <span
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: 99,
                            background: MODELS[currentModel].dot,
                            flexShrink: 0,
                          }}
                        />
                        {modelName}
                        <Icon size={14} color={TXT_40}>{ICONS.chevronDown}</Icon>
                      </div>
                      <div style={{ flex: 1 }} />
                      <div style={{ width: 36, height: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Icon size={17} color="rgba(255,255,255,0.85)">{ICONS.plus}</Icon>
                      </div>
                      {/* mic button */}
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 10,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          background: micActive ? "rgba(96,165,250,0.16)" : "transparent",
                          border: micActive ? "1px solid rgba(96,165,250,0.4)" : "1px solid transparent",
                          boxSizing: "border-box",
                          transform: `scale(${micPress})`,
                        }}
                      >
                        <Icon size={17} color={micActive ? BLUE_400 : "rgba(255,255,255,0.8)"}>
                          {ICONS.mic}
                        </Icon>
                      </div>
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 10,
                          background: "linear-gradient(145deg, #383c44, #2a2e35)",
                          border: "1px solid rgba(255,255,255,0.06)",
                          boxShadow:
                            "3px 3px 8px rgba(0,0,0,0.45), -2px -2px 6px rgba(255,255,255,0.02)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          opacity: 0.4,
                        }}
                      >
                        <Icon size={17} color={BLUE_400} sw={2.25}>{ICONS.arrowUp}</Icon>
                      </div>
                    </div>
                  </div>

                  {/* ── model dropdown (opens upward above the bar) ── */}
                  {ddVisible && (
                    <div
                      style={{
                        position: "absolute",
                        left: COL_LEFT + 14,
                        bottom: 1080 - BAR_TOP + 10,
                        width: 316,
                        borderRadius: 14,
                        border: "1px solid rgba(255,255,255,0.10)",
                        background: "#26262b",
                        boxShadow: "0 20px 50px -12px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.05)",
                        padding: 6,
                        boxSizing: "border-box",
                        opacity: ddOpacity,
                        transform: `scale(${ddScale})`,
                        transformOrigin: "bottom left",
                        zIndex: 10,
                      }}
                    >
                      <div style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: TXT_35, padding: "8px 12px 6px" }}>
                        Model
                      </div>
                      {MODELS.map((m, i) => {
                        const isHl = i === highlightIdx;
                        const isCur = i === currentModel;
                        const flash = i === SELECTED_MODEL ? selectFlash : 0;
                        return (
                          <div
                            key={m.name}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              padding: "10px 12px",
                              borderRadius: 9,
                              background:
                                flash > 0
                                  ? `rgba(59,130,246,${0.12 + flash * 0.18})`
                                  : isHl
                                    ? "rgba(255,255,255,0.06)"
                                    : "transparent",
                            }}
                          >
                            <span style={{ width: 8, height: 8, borderRadius: 99, background: m.dot, flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 15, fontWeight: 500, color: TXT }}>{m.name}</div>
                              <div style={{ fontSize: 12, color: TXT_40, marginTop: 1 }}>{m.tag}</div>
                            </div>
                            {isCur ? (
                              <Icon size={16} color={BLUE_400} sw={2.5}>{ICONS.check}</Icon>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* click ripples (model button + mic button) */}
                  <Ripple frame={frame} at={T_MODEL_PRESS} cx={COL_LEFT + 14 + 60} cy={BAR_TOP + 96} />
                  <Ripple frame={frame} at={T_MIC_PRESS} cx={COL_LEFT + COL_W - 14 - 36 - 6 - 18} cy={BAR_TOP + 96} />
                </div>

                {/* ── voice mode (fades in) ── */}
                {voiceT > 0 && (
                  <div style={{ position: "absolute", inset: 0, opacity: voiceT }}>
                    {/* ambient depth behind the orb */}
                    <div
                      style={{
                        position: "absolute",
                        left: ORB_CX - 520,
                        top: ORB_CY - 520,
                        width: 1040,
                        height: 1040,
                        borderRadius: "50%",
                        background:
                          "radial-gradient(circle, rgba(96,165,250,0.10) 0%, rgba(96,165,250,0.04) 38%, transparent 66%)",
                      }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        left: ORB_CX - Reff * 1.2,
                        top: ORB_CY - Reff * 1.2,
                        width: Reff * 2.4,
                        height: Reff * 2.4,
                        borderRadius: "50%",
                        background: `radial-gradient(circle, rgba(255,255,255,${0.06 * intensity}) 0%, rgba(255,255,255,${0.03 * intensity}) 55%, transparent 72%)`,
                      }}
                    />
                    <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
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

                    {/* status word */}
                    <div
                      style={{
                        position: "absolute",
                        left: ORB_CX - 300,
                        top: ORB_CY + ORB_R + 64,
                        width: 600,
                        textAlign: "center",
                        fontSize: 26,
                        fontWeight: 500,
                        color: "rgba(255,255,255,0.8)",
                        letterSpacing: "0.01em",
                      }}
                    >
                      {status}
                    </div>

                    {/* active model chip */}
                    <div
                      style={{
                        ...reveal(frame, 316, 18, 12),
                        position: "absolute",
                        left: ORB_CX - 110,
                        top: ORB_CY + ORB_R + 116,
                        width: 220,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 8,
                        fontSize: 14.5,
                        fontWeight: 500,
                        color: TXT_60,
                        padding: "7px 0",
                        borderRadius: 99,
                        border: "1px solid rgba(255,255,255,0.10)",
                        background: "rgba(255,255,255,0.04)",
                      }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: 99, background: MODELS[SELECTED_MODEL].dot }} />
                      {MODELS[SELECTED_MODEL].name}
                    </div>

                    {/* speaking caption */}
                    <div
                      style={{
                        ...reveal(frame, 416, 20, 14),
                        position: "absolute",
                        left: ORB_CX - 340,
                        top: ORB_CY + ORB_R + 186,
                        width: 680,
                        textAlign: "center",
                        fontSize: 20,
                        lineHeight: 1.45,
                        color: "rgba(255,255,255,0.75)",
                      }}
                    >
                      "Switched over — I'm listening. What should we dig into first?"
                    </div>

                    {/* paste bar */}
                    <div
                      style={{
                        ...reveal(frame, 340, 20, 14),
                        position: "absolute",
                        left: ORB_CX - 290,
                        top: 980,
                        width: 580,
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        borderRadius: 16,
                        border: "1px solid rgba(255,255,255,0.1)",
                        background: "rgba(255,255,255,0.04)",
                        padding: "12px 14px",
                        boxSizing: "border-box",
                      }}
                    >
                      <div
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 99,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "rgba(255,255,255,0.6)",
                        }}
                      >
                        <Icon size={19} color="rgba(255,255,255,0.6)">{ICONS.paperclip}</Icon>
                      </div>
                      <span style={{ fontSize: 16, color: "rgba(255,255,255,0.4)" }}>
                        Paste a link, image, PDF, doc — or drag &amp; drop
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
