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
import { OverlayUI, OVERLAY_CHAT_W } from "./OverlayUI";
import { MousePointer } from "./LyknGlassOverlay";
import {
  AddNewPill,
  Badge,
  CARD,
  EventRow,
  Icon,
  ICONS,
  LyknMark,
  MiniCalendar,
  popAt,
  RailBtn,
  SectionTitle,
  StatTile,
  TaskRow,
} from "./LyknProjectsZoom";

// ---------------------------------------------------------------------------
// LYKN Glass — UI edition. A soft-UI (neumorphic) demo screen floats in a
// preview panel; the glass bar pops in and the user types "What kind of UI is
// this?". The answer streams into the bar's own thread view — exactly like
// the real overlay chat — with a "Save to project" pill at the end; the
// cursor clicks it and the shot punches through to the LYKN project page,
// where the ideas spring into an Ideas card with a saved toast.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);

// Global playback speed — the frame clock is multiplied by this, so every
// beat (typing, camera moves, clicks, springs) runs proportionally slower.
const SPEED = 0.8;

const QUESTION = "What kind of UI is this?";

// ── timeline (30 fps) ──
const T_BAR_IN = 4;
const T_TYPE_START = 14;
const T_TYPE_END = 42;
const T_CLICK = 48; // cursor clicks send
const T_THREAD = T_CLICK + 4; // thread opens with the question + spinner
const T_TYPE2_START = T_CLICK + 20; // answer starts streaming
const T_TYPE2_END = 128;
const T_BTN_IN = 132; // "Save to project" springs in
const T_CLICK2 = 154; // cursor clicks save
const T_PUNCH2 = 158; // camera accelerates into the thread
const T_SWAP2 = 166; // hard cut to the project page
const T_TOAST = 264;
export const GLASS_UI_DURATION = Math.ceil(298 / SPEED);

// ── shot 1 geometry ──
const PREVIEW_W = 1600;
const PREVIEW_H = 900;
const PANEL_LEFT = (1920 - PREVIEW_W) / 2;
const PANEL_TOP = (1080 - PREVIEW_H) / 2;

const SCALE = 1.3;
const BAR_H = 116;
const BAR_LEFT = 960 - (OVERLAY_CHAT_W * SCALE) / 2;
const BAR_TOP = 540 - (BAR_H * SCALE) / 2;
// The bar's bottom edge stays pinned here; the thread grows upward from it,
// like the real overlay.
const BAR_BOTTOM = BAR_TOP + BAR_H * SCALE;
const INPUT_CX = BAR_LEFT + 78 * SCALE;
const INPUT_CY = BAR_TOP + 42 * SCALE;
const SEND_CX = BAR_LEFT + (OVERLAY_CHAT_W - 27) * SCALE;
const SEND_CY = BAR_TOP + (BAR_H - 23) * SCALE;

// "Save to project" pill inside the thread answer (bottom of the answer
// block, just above the ask area). Unscaled bar coords → stage coords.
const BTN_CX = BAR_LEFT + (38 + 92) * SCALE;
const BTN_CY = BAR_BOTTOM - (96 + 14 + 17) * SCALE;

// framing while the AI answers in the expanded thread
const RESP_CY = 400;
const RESP_Z = 1.62;

// shot-1 camera: full → input while typing → send click → pull back to frame
// the bar as the thread expands above the input.
const CAM_T = [0, 10, 24, 44, T_CLICK, T_THREAD + 2, T_THREAD + 16];
const CAM_CX = [960, 960, INPUT_CX + 110, INPUT_CX + 110, SEND_CX, SEND_CX, 960];
const CAM_CY = [540, 540, INPUT_CY, INPUT_CY, SEND_CY, SEND_CY, RESP_CY];
const CAM_Z = [1, 1, 3.1, 3.1, 3.8, 3.8, RESP_Z];

// cursor: flies in and clicks send…
const CUR_T = [30, 44];
const CUR_X = [1380, SEND_CX];
const CUR_Y = [900, SEND_CY];
// …then returns for the save click
const CUR2_T = [138, 150];
const CUR2_X = [1420, BTN_CX + 56];
const CUR2_Y = [880, BTN_CY + 2];

// ── neumorphism palette (the demo screen keeps the soft-UI look) ──
const NEO_BG = "#e0e5ec";
const NEO_DARK = "#b8c0cc";
const NEO_LIGHT = "#ffffff";
const NEO_TEXT = "#3d4452";
const NEO_MUTED = "#8a94a6";
const NEO_BLUE = "#3b78ff";
const RAISED = `9px 9px 18px ${NEO_DARK}, -9px -9px 18px ${NEO_LIGHT}`;
const RAISED_SM = `6px 6px 12px ${NEO_DARK}, -6px -6px 12px ${NEO_LIGHT}`;
const INSET = `inset 6px 6px 12px ${NEO_DARK}, inset -6px -6px 12px ${NEO_LIGHT}`;

type Line = { text: string; kind: "heading" | "bullet" | "footer" };
const LINES: Line[] = [
  { text: "This is neumorphism — a soft, extruded take on UI.", kind: "heading" },
  { text: "• Raised cards float with twin light + dark shadows", kind: "bullet" },
  { text: "• One low-contrast hue keeps the surface calm", kind: "bullet" },
  { text: "• Pressed controls flip to inset shadows", kind: "bullet" },
  { text: "Want me to save this UI design to your Website project?", kind: "footer" },
];
const LINE_STARTS: number[] = [];
{
  let acc = 0;
  for (const l of LINES) {
    LINE_STARTS.push(acc);
    acc += l.text.length;
  }
}
const TOTAL_CHARS = LINES.reduce((a, l) => a + l.text.length, 0);

// ── shot 2 (project page) geometry — matches LyknProjectsZoom exactly ──
const WIN_W = 1680;
const CHROME_H = 46;
const BODY_H = 945;
const WIN_H = BODY_H + CHROME_H;
const WIN_LEFT = (1920 - WIN_W) / 2;
const WIN_TOP = (1080 - WIN_H) / 2;
const WIN_SCALE = WIN_W / 1920;
const RAIL_W = 72;
const COL_W = 1180;
const COL_X = RAIL_W + (1920 - RAIL_W - COL_W) / 2; // 406
const LEFT_W = 580;
const RIGHT_X = COL_X + LEFT_W + 20; // 1006

const toSceneX = (x: number) => WIN_LEFT + x * WIN_SCALE;
const toSceneY = (y: number) => WIN_TOP + CHROME_H + y * WIN_SCALE;
const TASKS_FOCUS = (() => {
  const rect = { x: RIGHT_X - 14, y: 278, w: LEFT_W + 28, h: 570 };
  return {
    cx: toSceneX(rect.x + rect.w / 2),
    cy: toSceneY(rect.y + rect.h / 2),
    z: Math.min(
      1920 / (rect.w * WIN_SCALE * 1.12),
      1080 / (rect.h * WIN_SCALE * 1.12)
    ),
  };
})();

// project-page camera: settle full → zoom onto the todo list while the saved
// ideas land as tasks → pull back out to the full page.
const CAM3_T = [T_SWAP2, T_SWAP2 + 12, T_SWAP2 + 18, T_SWAP2 + 32, 240, 260];
const CAM3_CX = [960, 960, 960, TASKS_FOCUS.cx, TASKS_FOCUS.cx, 960];
const CAM3_CY = [540, 540, 540, TASKS_FOCUS.cy, TASKS_FOCUS.cy, 540];
const CAM3_Z = [0.94, 1, 1, TASKS_FOCUS.z, TASKS_FOCUS.z * 1.03, 1];

// the saved ideas landing in the Website project's todo list
const IDEAS: { text: string; at: number }[] = [
  { text: "Soft extruded cards — twin light/dark shadows", at: 204 },
  { text: "Single-hue, low-contrast surface palette", at: 216 },
  { text: "Inset pressed states for buttons + inputs", at: 228 },
];

// fixed Website-project content
const WEB_BASE_TASKS = [
  { title: "Ship hero section copy", due: "AUG 14", priority: "high" as const },
  { title: "Fix mobile nav overflow", due: "AUG 20" },
];
const WEB_CAL_MARKS = {
  12: { event: true },
  14: { event: true, task: true },
  20: { task: true },
};

// dark-app tokens (match LyknProjectsZoom)
const APP_BG = "#1e1e1e";
const TXT = "rgba(255,255,255,0.92)";
const TXT_90 = "rgba(255,255,255,0.9)";
const TXT_60 = "rgba(255,255,255,0.6)";
const TXT_55 = "rgba(255,255,255,0.55)";
const TXT_45 = "rgba(255,255,255,0.45)";
const TXT_35 = "rgba(255,255,255,0.35)";
const BLUE_400 = "#60a5fa";
const GREEN_400 = "#4ade80";

// ── small bits ──
const FolderPlusIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    <path d="M12 10v6" />
    <path d="M9 13h6" />
  </svg>
);

const CheckIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
    <path d="m5 13 4 4 10-10" />
  </svg>
);

// ── the neumorphic demo screen inside the preview panel ──
const NeoToggle: React.FC<{ on?: boolean }> = ({ on }) => (
  <div
    style={{
      width: 74,
      height: 40,
      borderRadius: 99,
      background: NEO_BG,
      boxShadow: INSET,
      position: "relative",
      flex: "none",
    }}
  >
    <div
      style={{
        position: "absolute",
        top: 5,
        left: on ? 39 : 5,
        width: 30,
        height: 30,
        borderRadius: 99,
        background: on ? NEO_BLUE : NEO_BG,
        boxShadow: on ? "3px 3px 8px rgba(59,120,255,0.4)" : RAISED_SM,
      }}
    />
  </div>
);

const NeoDemoScreen: React.FC = () => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: NEO_BG,
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      color: NEO_TEXT,
    }}
  >
    {/* header */}
    <div
      style={{
        position: "absolute",
        top: 44,
        left: 70,
        right: 70,
        display: "flex",
        alignItems: "center",
        gap: 26,
      }}
    >
      <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.01em" }}>
        soften<span style={{ color: NEO_BLUE }}>.</span>
      </span>
      <span style={{ fontSize: 17, color: NEO_MUTED, fontWeight: 500 }}>Soft UI Kit — v2 concept</span>
      <span style={{ flex: 1 }} />
      {/* inset search field */}
      <div
        style={{
          width: 360,
          height: 52,
          borderRadius: 99,
          background: NEO_BG,
          boxShadow: INSET,
          display: "flex",
          alignItems: "center",
          padding: "0 22px",
          gap: 12,
          color: NEO_MUTED,
          fontSize: 16,
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke={NEO_MUTED} strokeWidth={2} width={17} height={17}>
          <circle cx={11} cy={11} r={7} />
          <path d="m20 20-3.5-3.5" />
        </svg>
        Search components…
      </div>
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 99,
          background: NEO_BG,
          boxShadow: RAISED_SM,
          display: "grid",
          placeItems: "center",
          fontSize: 17,
          fontWeight: 700,
          color: NEO_BLUE,
        }}
      >
        EL
      </div>
    </div>

    {/* left card: player */}
    <div
      style={{
        position: "absolute",
        left: 70,
        top: 160,
        width: 560,
        height: 380,
        borderRadius: 34,
        background: NEO_BG,
        boxShadow: RAISED,
        padding: 38,
        boxSizing: "border-box",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.1em", color: NEO_MUTED }}>
        NOW PLAYING
      </div>
      <div style={{ marginTop: 10, fontSize: 26, fontWeight: 700 }}>Ambient Focus</div>
      <div style={{ marginTop: 4, fontSize: 16, color: NEO_MUTED }}>Soft Sessions · 24 min</div>
      {/* progress: inset track, raised knob */}
      <div style={{ marginTop: 40, position: "relative", height: 18 }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 99,
            background: NEO_BG,
            boxShadow: INSET,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 5,
            top: 5,
            width: "58%",
            height: 8,
            borderRadius: 99,
            background: `linear-gradient(90deg, ${NEO_BLUE}, #6d9dff)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "58%",
            top: -9,
            width: 36,
            height: 36,
            borderRadius: 99,
            background: NEO_BG,
            boxShadow: RAISED_SM,
          }}
        />
      </div>
      {/* transport buttons */}
      <div style={{ marginTop: 46, display: "flex", justifyContent: "center", gap: 34 }}>
        {[-1, 0, 1].map((k) => (
          <div
            key={k}
            style={{
              width: k === 0 ? 96 : 72,
              height: k === 0 ? 96 : 72,
              borderRadius: 99,
              background: NEO_BG,
              boxShadow: RAISED,
              display: "grid",
              placeItems: "center",
            }}
          >
            {k === 0 ? (
              <svg viewBox="0 0 24 24" width={34} height={34} fill={NEO_BLUE}>
                <path d="M8 5.5v13l11-6.5z" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                width={26}
                height={26}
                fill={NEO_MUTED}
                style={{ transform: k < 0 ? "rotate(180deg)" : undefined }}
              >
                <path d="M5 6v12l8.5-6z" />
                <rect x={15} y={6} width={3} height={12} rx={1} />
              </svg>
            )}
          </div>
        ))}
      </div>
    </div>

    {/* middle column: stats */}
    <div style={{ position: "absolute", left: 680, top: 160, width: 540 }}>
      {[
        { label: "ACTIVE USERS", value: "12,480", delta: "+8.2%" },
        { label: "SESSIONS TODAY", value: "3,905", delta: "+2.4%" },
      ].map((s) => (
        <div
          key={s.label}
          style={{
            borderRadius: 28,
            background: NEO_BG,
            boxShadow: RAISED,
            padding: "30px 36px",
            marginBottom: 30,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.1em", color: NEO_MUTED }}>
            {s.label}
          </div>
          <div style={{ marginTop: 8, display: "flex", alignItems: "baseline", gap: 16 }}>
            <span style={{ fontSize: 44, fontWeight: 700 }}>{s.value}</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: "#31b57d" }}>{s.delta}</span>
          </div>
        </div>
      ))}
      {/* pill button row */}
      <div style={{ display: "flex", gap: 22 }}>
        <div
          style={{
            flex: 1,
            height: 66,
            borderRadius: 99,
            background: NEO_BG,
            boxShadow: RAISED,
            display: "grid",
            placeItems: "center",
            fontSize: 18,
            fontWeight: 700,
            color: NEO_BLUE,
          }}
        >
          Upgrade
        </div>
        <div
          style={{
            flex: 1,
            height: 66,
            borderRadius: 99,
            background: NEO_BG,
            boxShadow: INSET,
            display: "grid",
            placeItems: "center",
            fontSize: 18,
            fontWeight: 600,
            color: NEO_MUTED,
          }}
        >
          Pressed
        </div>
      </div>
    </div>

    {/* right column: settings toggles */}
    <div
      style={{
        position: "absolute",
        left: 1270,
        top: 160,
        width: 580,
        borderRadius: 34,
        background: NEO_BG,
        boxShadow: RAISED,
        padding: "34px 38px",
        boxSizing: "border-box",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.1em", color: NEO_MUTED }}>
        PREFERENCES
      </div>
      {[
        { label: "Soft shadows", on: true },
        { label: "Haptic feedback", on: true },
        { label: "Reduce motion", on: false },
        { label: "Auto theme", on: true },
        { label: "Compact mode", on: false },
      ].map((row) => (
        <div
          key={row.label}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "19px 0",
            borderBottom: `1px solid rgba(138,148,166,0.16)`,
          }}
        >
          <span style={{ fontSize: 19, fontWeight: 600 }}>{row.label}</span>
          <NeoToggle on={row.on} />
        </div>
      ))}
    </div>

    {/* bottom chips */}
    <div style={{ position: "absolute", left: 70, top: 590, display: "flex", gap: 24 }}>
      {["Buttons", "Cards", "Inputs", "Toggles", "Sliders"].map((c, i) => (
        <div
          key={c}
          style={{
            padding: "16px 34px",
            borderRadius: 99,
            background: NEO_BG,
            boxShadow: i === 1 ? INSET : RAISED_SM,
            fontSize: 17,
            fontWeight: 600,
            color: i === 1 ? NEO_BLUE : NEO_TEXT,
          }}
        >
          {c}
        </div>
      ))}
    </div>
  </div>
);

export const LyknGlassUi: React.FC = () => {
  // Scaled clock: all timeline constants stay untouched while the whole
  // choreography plays back SPEED× (slower when SPEED < 1).
  const frame = useCurrentFrame() * SPEED;
  const { fps } = useVideoConfig();

  const camOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE } as const;

  // ── shot 1 camera ──
  const cx = interpolate(frame, CAM_T, CAM_CX, camOpts);
  const cy = interpolate(frame, CAM_T, CAM_CY, camOpts);
  const z = interpolate(frame, CAM_T, CAM_Z, camOpts);

  const inSpring = spring({
    frame: frame - T_BAR_IN,
    fps,
    config: { damping: 14, stiffness: 220 },
  });
  const barOpacity = Math.min(1, inSpring * 1.6);
  const barScale = 0.92 + inSpring * 0.08;
  const barY = (1 - inSpring) * 20;

  const typed = Math.round(
    interpolate(frame, [T_TYPE_START, T_TYPE_END], [0, QUESTION.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const askText = QUESTION.slice(0, typed);
  const showAskCursor =
    frame >= T_TYPE_START && frame < T_CLICK && Math.floor(frame / 8) % 2 === 0;

  const pressAt = (at: number) =>
    interpolate(frame, [at, at + 3, at + 7], [0, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  // send-click cursor
  const cur1X = interpolate(frame, CUR_T, CUR_X, camOpts);
  const cur1Y = interpolate(frame, CUR_T, CUR_Y, camOpts);
  const cur1Press = pressAt(T_CLICK);
  const cur1Opacity =
    interpolate(frame, [CUR_T[0], CUR_T[0] + 5], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) *
    interpolate(frame, [T_CLICK + 6, T_CLICK + 14], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  // save-click cursor
  const cur2X = interpolate(frame, CUR2_T, CUR2_X, camOpts);
  const cur2Y = interpolate(frame, CUR2_T, CUR2_Y, camOpts);
  const btnPress = pressAt(T_CLICK2);
  const cur2Opacity = interpolate(frame, [CUR2_T[0], CUR2_T[0] + 5], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const ripple = (at: number, rx: number, ry: number) => {
    if (frame < at || frame > at + 20) return null;
    const p = (frame - at) / 20;
    const r = 10 + p * 30;
    return (
      <div
        style={{
          position: "absolute",
          left: rx - r,
          top: ry - r,
          width: r * 2,
          height: r * 2,
          borderRadius: 99,
          border: "1.5px solid rgba(96,165,250,0.9)",
          opacity: (1 - p) * 0.9,
        }}
      />
    );
  };

  // AI answer streaming into the bar's thread view
  const chars = Math.round(
    interpolate(frame, [T_TYPE2_START, T_TYPE2_END], [0, TOTAL_CHARS], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const caretOn = frame < T_BTN_IN && Math.floor(frame / 7) % 2 === 0;

  const btnSpring = spring({
    frame: frame - T_BTN_IN,
    fps,
    config: { damping: 13, stiffness: 200 },
  });

  // thread answer content — same 14px/1.55 body the app's overlay uses
  const threadOpen = frame >= T_THREAD;
  const thinking = threadOpen && frame < T_TYPE2_START;
  const threadAnswer = (
    <div>
      {LINES.map((line, i) => {
        const visible = Math.max(0, Math.min(line.text.length, chars - LINE_STARTS[i]));
        if (visible === 0) return null;
        const text = line.text.slice(0, visible);
        const isActive = chars >= LINE_STARTS[i] && chars < LINE_STARTS[i] + line.text.length;
        const showCaret =
          caretOn && (isActive || (i === LINES.length - 1 && chars >= TOTAL_CHARS));
        const style: React.CSSProperties =
          line.kind === "heading"
            ? { fontWeight: 700, color: "#f4f6fb", margin: "2px 0 8px" }
            : line.kind === "footer"
              ? { fontWeight: 600, color: "#f4f6fb", margin: "10px 0 0" }
              : { color: "#e9edf6", margin: "0 0 5px" };
        return (
          <p key={i} style={style}>
            {text}
            {showCaret ? (
              <span
                style={{
                  display: "inline-block",
                  width: 2,
                  height: "1em",
                  background: BLUE_400,
                  marginLeft: 3,
                  verticalAlign: "text-bottom",
                  borderRadius: 2,
                }}
              />
            ) : null}
          </p>
        );
      })}
      {/* save-to-project pill, styled like the overlay's own glass buttons */}
      {frame >= T_BTN_IN && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            height: 34,
            padding: "0 16px",
            marginTop: 12,
            borderRadius: 10,
            background:
              btnPress > 0.4 ? "rgba(96,165,250,0.22)" : "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.14)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
            fontSize: 13,
            fontWeight: 600,
            color: BLUE_400,
            opacity: Math.min(1, btnSpring * 1.5),
            transform: `scale(${(0.85 + btnSpring * 0.15) * (1 - 0.04 * btnPress)})`,
            transformOrigin: "left center",
          }}
        >
          <FolderPlusIcon size={15} color={BLUE_400} />
          Save to project
        </div>
      )}
    </div>
  );

  // punch-zoom into the card for the cut
  const zoomPunch = interpolate(frame, [T_PUNCH2, T_SWAP2], [1, 3.0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  // ── shot 2 camera (project page): settle → tasks → back out ──
  const c3x = interpolate(frame, CAM3_T, CAM3_CX, camOpts);
  const c3y = interpolate(frame, CAM3_T, CAM3_CY, camOpts);
  const z3 = interpolate(frame, CAM3_T, CAM3_Z, camOpts);

  // stat pops as the saved ideas land
  const landed = IDEAS.filter((i) => frame >= i.at);
  const lastLand = landed.length ? Math.max(...landed.map((i) => i.at)) : null;
  const openPop = popAt(frame, lastLand);

  const toastSpring = spring({
    frame: frame - T_TOAST,
    fps,
    config: { damping: 14, stiffness: 200 },
  });

  const showShot1 = frame < T_SWAP2;
  const showShot3 = frame >= T_SWAP2;

  const savedCount = IDEAS.filter((i) => frame >= i.at).length;
  // the add-task input glows while the ideas are streaming into the list
  const savingActive =
    frame >= IDEAS[0].at - 8 && frame <= IDEAS[IDEAS.length - 1].at + 10;

  return (
    <AbsoluteFill
      style={{
        background: "#0a1020",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      }}
    >
      {/* blue backdrop behind everything */}
      <Img
        src={staticFile("bg-blue.png")}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />

      {/* ── shot 1: demo screen + glass bar + response card ── */}
      {showShot1 && (
        <div
          style={{
            position: "absolute",
            width: 1920,
            height: 1080,
            transformOrigin: "0 0",
            transform: `translate(960px, 540px) scale(${z * zoomPunch}) translate(${-cx}px, ${-cy}px)`,
          }}
        >
          {/* floating preview panel with the soft-UI demo */}
          <div
            style={{
              position: "absolute",
              left: PANEL_LEFT,
              top: PANEL_TOP,
              width: PREVIEW_W,
              height: PREVIEW_H,
              borderRadius: 22,
              overflow: "hidden",
              boxShadow:
                "0 50px 130px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.14), 0 0 90px 8px rgba(40,90,200,0.18)",
            }}
          >
            <div
              style={{
                position: "absolute",
                width: 1920,
                height: 1080,
                transform: `scale(${PREVIEW_W / 1920})`,
                transformOrigin: "0 0",
              }}
            >
              <NeoDemoScreen />
            </div>
          </div>

          {/* glass bar — bottom edge pinned so the thread grows upward,
          exactly like the real overlay */}
          <div
            style={{
              position: "absolute",
              left: "50%",
              bottom: 1080 - BAR_BOTTOM,
              opacity: barOpacity,
              transform: `translateX(-50%) translateY(${barY}px) scale(${SCALE * barScale})`,
              transformOrigin: "bottom center",
            }}
          >
            <div
              style={{
                position: "relative",
                borderRadius: 16,
                boxShadow:
                  "0 24px 70px rgba(0,0,0,0.45), 0 0 0 0.5px rgba(255,255,255,0.16)",
              }}
            >
              {/* baked frost: blurred impression of the light demo behind the glass */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: 16,
                  overflow: "hidden",
                  background:
                    "linear-gradient(160deg, #99a1ae 0%, #8b93a1 55%, #848c9b 100%)",
                }}
              />
              <div style={{ position: "relative" }}>
                <OverlayUI
                  askText={threadOpen ? "" : askText}
                  askPlaceholder="Ask LYKN about your screen…"
                  showAskCursor={showAskCursor}
                  threadQuestion={threadOpen ? QUESTION : undefined}
                  threadAnswer={threadAnswer}
                  showThinking={thinking}
                  thinkingLabel="Reading your screen…"
                />
              </div>
            </div>
          </div>

          {ripple(T_CLICK, SEND_CX, SEND_CY)}
          {ripple(T_CLICK2, BTN_CX + 56, BTN_CY + 2)}
          {cur1Opacity > 0 && (
            <MousePointer x={cur1X} y={cur1Y} press={cur1Press} opacity={cur1Opacity} />
          )}
          {frame >= CUR2_T[0] && cur2Opacity > 0 && (
            <MousePointer x={cur2X} y={cur2Y} press={btnPress} opacity={cur2Opacity} />
          )}
        </div>
      )}

      {/* ── shot 2: project page, ideas save in ── */}
      {showShot3 && (
        <div
          style={{
            position: "absolute",
            width: 1920,
            height: 1080,
            transformOrigin: "0 0",
            transform: `translate(960px, 540px) scale(${z3}) translate(${-c3x}px, ${-c3y}px)`,
            fontFamily: "Inter, system-ui, sans-serif",
          }}
        >
          {/* app window */}
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
                "0 50px 110px -24px rgba(4,12,40,0.62), 0 18px 50px -30px rgba(0,0,0,0.55)",
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
                LYKN — Projects
              </span>
            </div>

            {/* body: 1920x1080 app canvas scaled into the window */}
            <div style={{ position: "relative", width: WIN_W, height: BODY_H, overflow: "hidden" }}>
              <div style={{ width: 1920, height: 1080, transformOrigin: "0 0", transform: `scale(${WIN_SCALE})` }}>
                <div style={{ position: "absolute", width: 1920, height: 1080, background: APP_BG }}>
                  {/* rail — same as the projects page */}
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      width: RAIL_W,
                      height: 1080,
                      background: "#292929",
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
                      <RailBtn><Icon size={19} color={TXT_60}>{ICONS.edit}</Icon></RailBtn>
                      <RailBtn><Icon size={19} color={TXT_60}>{ICONS.message}</Icon></RailBtn>
                      <RailBtn><Icon size={19} color={TXT_60}>{ICONS.plug}</Icon></RailBtn>
                      <RailBtn><Icon size={19} color={TXT_60}>{ICONS.calendar}</Icon></RailBtn>
                      <RailBtn active><Icon size={19} color={BLUE_400}>{ICONS.folder}</Icon></RailBtn>
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

                  {/* header */}
                  <div style={{ position: "absolute", left: COL_X, top: 32, width: COL_W }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, color: TXT_45, marginBottom: 12 }}>
                      <Icon size={14} color={TXT_45}>{ICONS.arrowLeft}</Icon>
                      All projects
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                      <Icon size={24} color={TXT_55}>{ICONS.folder}</Icon>
                      <span style={{ fontSize: 32, fontWeight: 600, color: TXT, letterSpacing: "-0.02em" }}>Website</span>
                      <Badge bg="rgba(34,197,94,0.10)" color={GREEN_400}>Active</Badge>
                      <Badge bg="rgba(59,130,246,0.10)" color={BLUE_400}>AI focus</Badge>
                      <div style={{ flex: 1 }} />
                      <span style={{ fontSize: 13, color: TXT_35 }}>
                        used just now · {4 + savedCount} items
                      </span>
                    </div>
                  </div>

                  {/* stat tiles */}
                  <div
                    style={{
                      position: "absolute",
                      left: COL_X,
                      top: 156,
                      width: COL_W,
                      display: "grid",
                      gridTemplateColumns: "repeat(4,1fr)",
                      gap: 14,
                    }}
                  >
                    <StatTile
                      icon={ICONS.listTodo}
                      label="Open tasks"
                      value={WEB_BASE_TASKS.length + savedCount}
                      pop={openPop}
                    />
                    <StatTile icon={ICONS.clock} label="Overdue" value={0} />
                    <StatTile icon={ICONS.checkCircle} label="Done · 7d" value={1} />
                    <StatTile icon={ICONS.calendarPlus} label="Events · 7d" value={2} tone="accent" />
                  </div>

                  {/* left: calendar */}
                  <div style={{ position: "absolute", left: COL_X, top: 290, width: LEFT_W, height: 446 }}>
                    <MiniCalendar frame={frame} pulse={0} marks={WEB_CAL_MARKS} />
                  </div>

                  {/* left: events */}
                  <div style={{ position: "absolute", left: COL_X, top: 754, width: LEFT_W, height: 286, ...CARD, padding: 20 }}>
                    <SectionTitle right={<AddNewPill />}>Your events</SectionTitle>
                    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                      <EventRow day={12} weekday="WED" title="Design review" when="Wed, Aug 12 · 10:00 AM" location="Zoom" />
                      <EventRow day={14} weekday="FRI" title="Site content lock" when="Fri, Aug 14 · 3:00 PM" />
                    </div>
                  </div>

                  {/* right: todo list — the saved ideas land here */}
                  <div style={{ position: "absolute", left: RIGHT_X, top: 290, width: LEFT_W, height: 750, ...CARD, padding: 22 }}>
                    <SectionTitle right={<AddNewPill />}>
                      Todo list{" "}
                      <span style={{ fontSize: 13, fontWeight: 400, color: TXT_45 }}>
                        {WEB_BASE_TASKS.length + savedCount} open
                      </span>
                    </SectionTitle>

                    {/* add-task input — flashes active while ideas stream in */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 9,
                        fontSize: 15,
                        padding: "11px 14px",
                        borderRadius: 12,
                        border: `1px solid ${savingActive ? "rgba(59,130,246,0.45)" : "rgba(255,255,255,0.1)"}`,
                        background: savingActive ? "rgba(59,130,246,0.05)" : "rgba(255,255,255,0.03)",
                        boxShadow: savingActive ? "0 0 0 3px rgba(59,130,246,0.12)" : "none",
                        marginBottom: 12,
                      }}
                    >
                      <Icon size={15} color={savingActive ? BLUE_400 : TXT_35}>{ICONS.plus}</Icon>
                      <span style={{ color: savingActive ? TXT_90 : TXT_35 }}>
                        {savingActive ? "Saving from screen chat…" : "Add a task…"}
                      </span>
                    </div>

                    {/* rows */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      {WEB_BASE_TASKS.map((t) => (
                        <TaskRow key={t.title} title={t.title} due={t.due} priority={t.priority} />
                      ))}
                      {IDEAS.map((idea) => {
                        if (frame < idea.at) return null;
                        const enter = spring({
                          frame: frame - idea.at,
                          fps,
                          config: { damping: 15, stiffness: 160 },
                        });
                        return <TaskRow key={idea.text} title={idea.text} enter={enter} />;
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* saved toast — pinned to the screen so the zoomed-in camera keeps it */}
      {showShot3 && frame >= T_TOAST && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 64,
            transform: `translateX(-50%) translateY(${(1 - toastSpring) * 40}px)`,
            opacity: Math.min(1, toastSpring * 1.5),
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "16px 30px",
            borderRadius: 999,
            background: "rgba(30,32,38,0.92)",
            border: "1px solid rgba(255,255,255,0.12)",
            boxShadow: "0 18px 50px rgba(0,0,0,0.5)",
          }}
        >
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: 99,
              background: "rgba(74,222,128,0.15)",
              display: "grid",
              placeItems: "center",
            }}
          >
            <CheckIcon size={17} color={GREEN_400} />
          </span>
          <span style={{ fontSize: 19, fontWeight: 500, color: TXT_90 }}>
            3 ideas saved from screen chat
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};