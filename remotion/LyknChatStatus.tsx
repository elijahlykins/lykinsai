import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";

// ---------------------------------------------------------------------------
// "What's the status of my project?" — the actual LYKN UI (dark theme) with
// the sidebar COLLAPSED to its icon rail, presented as a device screen
// floating on a blue gradient. Camera zooms into the real neumorphic chat
// bar, types the question, zooms out, and LYKN streams the status back.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);

// Real theme tokens (src/lib/theme.js + src/index.css).
const APP_BG = "#1e1e1e";
const SIDEBAR_BG = "#292929"; // hsl(0 0% 16%)
const TXT = "rgba(255,255,255,0.92)";
const TXT_60 = "rgba(255,255,255,0.6)";
const TXT_45 = "rgba(255,255,255,0.45)";
const TXT_40 = "rgba(255,255,255,0.4)";
const TXT_35 = "rgba(255,255,255,0.35)";
const BLUE_400 = "#60a5fa";
const BLUE_500_10 = "rgba(59,130,246,0.10)";
const GREEN_400 = "#4ade80";

const QUESTION = "What's the status of my project?";

// Preview-card window on the gradient (matches .lykn-wake-subwindow):
// a 16:9 body under a chrome bar with traffic-light dots + title.
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
const BAR_CY = 944;

const ZOOM = 2.0;
const TX_END = 960 - ZOOM * MAIN_CX;
const TY_END = 540 - ZOOM * BAR_CY;

function reveal(frame: number, start: number, dur = 22, dist = 16) {
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

// ── lucide-style icon helper (viewBox 0 0 24 24, stroke 2, round caps) ──
const Icon: React.FC<{
  size?: number;
  color?: string;
  sw?: number;
  fill?: string;
  children: React.ReactNode;
}> = ({ size = 16, color = TXT_60, sw = 2, fill = "none", children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
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
  checkCircle: (
    <>
      <path d="M21.8 10A10 10 0 1 1 17 3.34" />
      <path d="m9 11 3 3L22 4" />
    </>
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

// Collapsed-rail icon button.
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

// Real coding-agent task row (SubAgentTasksStrip, "completed" variant).
const AgentRow: React.FC<{
  frame: number;
  start: number;
  name: string;
  task: string;
}> = ({ frame, start, name, task }) => (
  <div
    style={{
      ...reveal(frame, start, 18, 14),
      display: "flex",
      alignItems: "flex-start",
      gap: 9,
      borderRadius: 10,
      border: "1px solid rgba(52,211,153,0.25)",
      background: "rgba(16,185,129,0.08)",
      padding: "10px 14px",
      fontSize: 16,
      color: "rgba(255,255,255,0.85)",
      lineHeight: 1.45,
    }}
  >
    <div style={{ marginTop: 2 }}>
      <Icon size={17} color="#34d399">
        {ICONS.checkCircle}
      </Icon>
    </div>
    <div>
      <span style={{ fontWeight: 600 }}>{name}</span>
      <span style={{ color: "rgba(255,255,255,0.55)" }}> finished </span>
      <span style={{ color: "rgba(255,255,255,0.78)" }}>{task}</span>
      <span style={{ color: "rgba(255,255,255,0.45)" }}> — pushed to main</span>
    </div>
  </div>
);

const Bullet: React.FC<{ frame: number; start: number; text: string }> = ({
  frame,
  start,
  text,
}) => (
  <div
    style={{
      ...reveal(frame, start, 16, 12),
      display: "flex",
      alignItems: "flex-start",
      gap: 12,
      fontSize: 18,
      color: "rgba(255,255,255,0.9)",
      lineHeight: 1.5,
    }}
  >
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: 99,
        background: "rgba(255,255,255,0.55)",
        marginTop: 9,
        flexShrink: 0,
      }}
    />
    <span>{text}</span>
  </div>
);

export const LyknChatStatus: React.FC = () => {
  const frame = useCurrentFrame();

  // Camera: zoom into the bar (60-110), hold, zoom out (150-200).
  const zoomIn = interpolate(frame, [60, 110], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const zoomOut = interpolate(frame, [150, 200], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const p = Math.min(zoomIn, zoomOut);
  const scale = 1 + p * (ZOOM - 1);
  const tx = p * TX_END;
  const ty = p * TY_END;

  // Typewriter (75-132), clears on send (150).
  const typedCount = Math.round(
    interpolate(frame, [75, 132], [0, QUESTION.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const sent = frame >= 150;
  const barText = sent ? "" : QUESTION.slice(0, typedCount);
  const showCursor =
    frame >= 70 && frame < 150 && Math.floor(frame / 8) % 2 === 0;

  // One-shot blue border trace around the shell (lykn-chat-border-trace).
  const traceAngle = interpolate(frame, [66, 150], [0, 360], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const traceOpacity = interpolate(frame, [66, 130, 150], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Real LyknOutlineSpinner draw (thinking beat, ~150-212).
  const showThinking = frame >= 150 && frame < 212;
  const tphase = interpolate(frame, [152, 205], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  let dashOffset = 1;
  let strokeOp = 1;
  let fillOp = 0;
  if (tphase < 0.4) {
    dashOffset = interpolate(tphase, [0, 0.4], [1, 0]);
  } else if (tphase < 0.55) {
    dashOffset = 0;
    strokeOp = interpolate(tphase, [0.4, 0.55], [1, 0]);
    fillOp = interpolate(tphase, [0.4, 0.55], [0, 1]);
  } else {
    dashOffset = 0;
    strokeOp = 0;
    fillOp = 1;
  }

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(135% 135% at 50% 0%, #357bff 0%, #1c47c0 42%, #0a205f 100%)",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      {/* Preview-card window floating on the gradient */}
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
        {/* Chrome bar (matches .lykn-wake-subwindow-chrome) */}
        <div
          style={{
            flex: "0 0 auto",
            height: CHROME_H,
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "0 15px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            background: "rgba(255,255,255,0.03)",
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
        {/* Body: app authored at 1920x1080, scaled to fit */}
        <div style={{ position: "relative", width: BODY_W, height: BODY_H, overflow: "hidden" }}>
          <div
            style={{
              width: 1920,
              height: 1080,
              transformOrigin: "0 0",
              transform: `scale(${WIN_SCALE})`,
            }}
          >
          {/* Camera: zoom into the chat bar */}
          <div
            style={{
              position: "absolute",
              width: 1920,
              height: 1080,
              transformOrigin: "0 0",
              transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            }}
          >
            <AbsoluteFill style={{ background: APP_BG }}>
              {/* ── Collapsed icon rail (real) ── */}
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
                }}
              >
                <div style={{ marginBottom: 20 }}>
                  <LyknMark size={28} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                  <RailBtn>
                    <Icon size={19} color={TXT_60}>
                      {ICONS.edit}
                    </Icon>
                  </RailBtn>
                  <RailBtn active>
                    <Icon size={19} color={TXT_60}>
                      {ICONS.message}
                    </Icon>
                  </RailBtn>
                  <RailBtn>
                    <Icon size={19} color={TXT_60}>
                      {ICONS.plug}
                    </Icon>
                  </RailBtn>
                  <RailBtn>
                    <Icon size={19} color={TXT_60}>
                      {ICONS.calendar}
                    </Icon>
                  </RailBtn>
                  <RailBtn>
                    <Icon size={19} color={TXT_60}>
                      {ICONS.folder}
                    </Icon>
                  </RailBtn>
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

              {/* ── Chat thread (bottom-aligned) ── */}
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
                  {/* User message — real bubble: bg-background + border */}
                  <div style={{ ...reveal(frame, 175, 16, 12), display: "flex", justifyContent: "flex-end" }}>
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
                      {QUESTION}
                    </div>
                  </div>

                  {/* Thinking beat — real LyknOutlineSpinner + label */}
                  {showThinking && (
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <svg width={26} height={26} viewBox={ICON_VIEWBOX} fill="none" style={{ flexShrink: 0 }}>
                        <path
                          d={ICON_PATH}
                          pathLength={1}
                          fill="#f2f2f2"
                          fillOpacity={fillOp}
                          stroke="#f2f2f2"
                          strokeOpacity={strokeOp}
                          strokeWidth={1.75}
                          strokeDasharray={1}
                          strokeDashoffset={dashOffset}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          vectorEffect="non-scaling-stroke"
                        />
                      </svg>
                      <span style={{ fontSize: 17, color: "rgba(255,255,255,0.75)" }}>Thinking…</span>
                    </div>
                  )}

                  {/* AI Response (real header + prose body) */}
                  <div style={{ ...reveal(frame, 210, 18, 14) }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "2px 0" }}>
                      <Icon size={18} color={TXT_40} sw={2}>
                        {ICONS.chevronDown}
                      </Icon>
                      <LyknMark size={20} />
                      <span style={{ fontSize: 17, color: TXT_40, fontWeight: 500 }}>AI Response</span>
                      <span style={{ fontSize: 17, color: TXT_35, fontWeight: 500 }}>· LYKN</span>
                      <Icon size={17} color={GREEN_400} sw={2.5}>
                        {ICONS.check}
                      </Icon>
                    </div>

                    <div style={{ paddingTop: 12, display: "flex", flexDirection: "column", gap: 14 }}>
                      <div style={{ fontSize: 19, color: "rgba(255,255,255,0.9)", lineHeight: 1.55 }}>
                        Here's where your project stands.
                      </div>

                      <div style={{ ...reveal(frame, 232, 14, 10), fontSize: 17, color: "rgba(255,255,255,0.9)", fontWeight: 600 }}>
                        Recent pushes from your coding agents
                      </div>
                      <AgentRow frame={frame} start={244} name="Coding agent" task="light / dark / system theming" />
                      <AgentRow frame={frame} start={262} name="Coding agent" task="the artifact viewport fix" />
                      <AgentRow frame={frame} start={280} name="Coding agent" task="the /projects management page" />

                      <div style={{ ...reveal(frame, 304, 14), fontSize: 17, color: "rgba(255,255,255,0.9)", lineHeight: 1.55, marginTop: 4 }}>
                        A few more things worth your attention:
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        <Bullet frame={frame} start={316} text="You have 2 events on the calendar today" />
                        <Bullet frame={frame} start={334} text="10 new signups for the app this week" />
                        <Bullet frame={frame} start={352} text="3 new features to preview before pushing" />
                      </div>

                      <div style={{ ...reveal(frame, 378, 18, 12), fontSize: 19, color: "rgba(255,255,255,0.92)", fontWeight: 600, marginTop: 6 }}>
                        What do you want to tackle next?
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Chat bar (real neumorphic shell + toolbar) ── */}
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
                    position: "absolute",
                    inset: -2,
                    borderRadius: 16,
                    padding: 2,
                    background: `conic-gradient(from ${traceAngle}deg at 50% 50%, transparent 0deg, transparent 300deg, rgba(59,130,246,0.15) 320deg, rgba(96,165,250,0.55) 338deg, rgba(147,197,253,1) 348deg, rgba(96,165,250,0.55) 352deg, rgba(59,130,246,0.15) 358deg, transparent 360deg)`,
                    WebkitMask:
                      "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
                    WebkitMaskComposite: "xor",
                    maskComposite: "exclude",
                    opacity: traceOpacity,
                    pointerEvents: "none",
                  }}
                />
                <div
                  style={{
                    minHeight: 52,
                    padding: "8px 12px",
                    fontSize: 18,
                    lineHeight: 1.35,
                    color: barText ? TXT : TXT_45,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  {barText || "Ask me anything..."}
                  {showCursor ? <span style={{ color: BLUE_400, marginLeft: 1 }}>|</span> : null}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 4 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "0 6px",
                      height: 36,
                      fontSize: 15,
                      fontWeight: 500,
                      color: TXT_60,
                    }}
                  >
                    LYKN
                    <Icon size={14} color={TXT_40}>
                      {ICONS.chevronDown}
                    </Icon>
                  </div>
                  <div style={{ flex: 1 }} />
                  <div style={{ width: 36, height: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Icon size={17} color="rgba(255,255,255,0.85)">
                      {ICONS.plus}
                    </Icon>
                  </div>
                  <div style={{ width: 36, height: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Icon size={17} color="rgba(255,255,255,0.8)">
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
                      opacity: barText ? 1 : 0.4,
                    }}
                  >
                    <Icon size={17} color={BLUE_400} sw={2.25}>
                      {ICONS.arrowUp}
                    </Icon>
                  </div>
                </div>
              </div>
            </AbsoluteFill>
          </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
