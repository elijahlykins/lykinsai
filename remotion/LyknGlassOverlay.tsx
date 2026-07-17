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
import { OverlayUI, OVERLAY_CHAT_W } from "./OverlayUI";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";

// ---------------------------------------------------------------------------
// LYKN Glass Overlay — two shots on a dark grey stage.
// Shot 1: the glass bar pops in as typing starts, the camera snaps onto the
// input, darts to the send button, and the cursor clicks it. The send button
// rotates 90° (arrow → right) and rockets out the right side as a transition.
// Shot 2: a focused glass card slides in from the right (following the
// button's motion) and the AI types out a screen read + suggestions fast,
// showing off what it can do.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);

const QUESTION = "Summarize what's on my screen";

// Timeline (30 fps).
const T_BAR_IN = 4;
const T_TYPE_START = 8;
const T_TYPE_END = 58;
const T_CLICK = 72; // cursor clicks send
const T_SPIN = 74; // button starts rotating 90°
const T_LAUNCH = 82; // button shoots right
const T_TRANS_START = 88; // camera starts the punch-zoom
const T_SWAP = 98; // hard swap to shot 2 at the zoom peak
const T_TRANS_END = 112; // card fully settled
const T_TYPE2_START = 112;
const T_TYPE2_END = 148;
// Suggestion button beat: pop in, fast punch-zoom, cursor click.
const T_BTN = 150;
const T_BTN_ZOOM = 156;
const T_BTN_CLICK = 172;
const T_ADDED = 175;

const SCALE = 1.15;

// Shot 2: floating screen-preview panel size (16:9, centered).
const PREVIEW_W = 1600;
const PREVIEW_H = 900;
// Glass card: smaller, parked on the left side of the preview.
const CARD_SCALE = 0.58;
const CARD_CX = 570;
const CARD_CY = 540;
// "Add that to my project" button center on the stage (tuned to the card layout).
const BTN_CX = 390;
const BTN_CY = 668;

// Laptop mockup geometry on the 1920x1080 stage.
export const LAP_PANEL_LEFT = 198;
export const LAP_PANEL_TOP = 38;
export const LAP_PANEL_W = 1524;
export const LAP_PANEL_H = 969;
export const LAP_BEZEL = 22;
export const SCREEN_LEFT = LAP_PANEL_LEFT + LAP_BEZEL;
export const SCREEN_TOP = LAP_PANEL_TOP + LAP_BEZEL;
export const SCREEN_W = LAP_PANEL_W - LAP_BEZEL * 2;
export const SCREEN_H = LAP_PANEL_H - LAP_BEZEL * 2;
const SCREEN_CY = SCREEN_TOP + SCREEN_H / 2; // ≈ 522

// Bar geometry (centered on the laptop screen).
const BAR_H = 116;
const BAR_LEFT = 960 - (OVERLAY_CHAT_W * SCALE) / 2;
const BAR_TOP = SCREEN_CY - (BAR_H * SCALE) / 2;
// Send button center inside the 520px overlay: ~27px from the right edge,
// ~23px up from the bottom.
const SEND_CX = BAR_LEFT + (OVERLAY_CHAT_W - 27) * SCALE;
const SEND_CY = BAR_TOP + (BAR_H - 23) * SCALE;
const SEND_SIZE = 36 * SCALE;

// Input click target (where the caret sits).
const INPUT_CX = BAR_LEFT + 78 * SCALE;
const INPUT_CY = BAR_TOP + 42 * SCALE;

// Camera keyframes: full laptop → input (typing) → send button, then hold
// for the click + button launch (the cut happens while zoomed in).
const CAM_T = [0, 8, 20, 60, 70];
const CAM_CX = [960, 960, INPUT_CX + 113, INPUT_CX + 113, SEND_CX];
const CAM_CY = [540, 540, INPUT_CY, INPUT_CY, SEND_CY];
const CAM_Z = [1, 1, 3.4, 3.5, 4.8];

// Mouse cursor keyframes: enters, clicks the input, parks below the bar
// while typing, then darts to the send button for the click.
const CUR_T = [0, 7, 20, 58, 69];
const CUR_X = [1160, INPUT_CX, INPUT_CX + 90, INPUT_CX + 90, SEND_CX];
const CUR_Y = [790, INPUT_CY, INPUT_CY + 115, INPUT_CY + 115, SEND_CY];
const T_INPUT_CLICK = 7;

// Shot 2: the AI's typed-out response, line by line.
type Line = { text: string; kind: "heading" | "bullet" | "footer" };
const LINES: Line[] = [
  { text: "You're looking at the Q3 launch plan — release locks Aug 12.", kind: "heading" },
  { text: "• I can add the 3 open tasks to your project — pricing page, demo video, beta invites", kind: "bullet" },
  { text: "• I can draft the launch announcement in your voice", kind: "bullet" },
  { text: "• I can schedule the beta review — Friday 2:00 works for everyone", kind: "bullet" },
  { text: "• I can watch your inbox tonight and flag anything about the embargo", kind: "bullet" },
  { text: "Just say the word.", kind: "footer" },
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

// macOS-style pointer, tip at (0,0).
export const MousePointer: React.FC<{ x: number; y: number; press: number; opacity: number }> = ({
  x,
  y,
  press,
  opacity,
}) => (
  <svg
    width={34}
    height={44}
    viewBox="0 0 17 22"
    style={{
      position: "absolute",
      left: x,
      top: y,
      opacity,
      transform: `scale(${1 - press * 0.14})`,
      transformOrigin: "0 0",
      filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.55))",
    }}
  >
    <path
      d="M1 1 L1 16.5 L4.9 12.9 L7.4 19 L10.3 17.8 L7.8 11.8 L13.2 11.6 Z"
      fill="#0b0b0d"
      stroke="#ffffff"
      strokeWidth={1.3}
      strokeLinejoin="round"
    />
  </svg>
);

// Photo wallpaper — a real-looking desktop background.
export const Wallpaper: React.FC = () => (
  <Img
    src={staticFile("wallpaper-room.png")}
    style={{
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "cover",
    }}
  />
);

// ── macOS dock app icons (SVG approximations of the real apps) ──
const ICON_R = 10;
const iconBase: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: ICON_R,
  boxShadow: "0 4px 10px rgba(0,0,0,0.3)",
  overflow: "hidden",
  flex: "none",
};

const FinderIcon = () => (
  <div style={{ ...iconBase, position: "relative", background: "#ffffff" }}>
    <div style={{ position: "absolute", inset: 0, width: "50%", background: "linear-gradient(180deg, #4aa8f0, #1e7de0)" }} />
    <div style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, background: "linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(0,0,0,0.06) 100%)" }} />
    <svg viewBox="0 0 44 44" style={{ position: "absolute", inset: 0 }}>
      <path d="M15 12 Q14 22 15 32" stroke="#0b3f77" strokeWidth={1.6} fill="none" opacity={0.7} />
      <path d="M29 12 Q30 22 29 32" stroke="#9bb2c8" strokeWidth={1.6} fill="none" opacity={0.8} />
      <circle cx={13} cy={19} r={1.6} fill="#0b3f77" />
      <circle cx={31} cy={19} r={1.6} fill="#6b7f94" />
      <path d="M14 27 Q22 33 30 27" stroke="#0b3f77" strokeWidth={1.8} fill="none" strokeLinecap="round" />
    </svg>
  </div>
);

const SafariIcon = () => (
  <div style={{ ...iconBase, position: "relative", background: "#ffffff", display: "grid", placeItems: "center" }}>
    <svg viewBox="0 0 44 44" width={44} height={44}>
      <circle cx={22} cy={22} r={17} fill="url(#safb)" />
      <defs>
        <linearGradient id="safb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3fb7f7" />
          <stop offset="1" stopColor="#1a6ee8" />
        </linearGradient>
      </defs>
      {Array.from({ length: 12 }).map((_, i) => {
        const a = (i * 30 * Math.PI) / 180;
        return (
          <line
            key={i}
            x1={22 + Math.cos(a) * 13.5}
            y1={22 + Math.sin(a) * 13.5}
            x2={22 + Math.cos(a) * 15.5}
            y2={22 + Math.sin(a) * 15.5}
            stroke="rgba(255,255,255,0.85)"
            strokeWidth={1}
          />
        );
      })}
      <polygon points="22,22 29.5,14.5 25,25" fill="#ff3b30" />
      <polygon points="22,22 14.5,29.5 19,19" fill="#f2f2f2" />
    </svg>
  </div>
);

const MessagesIcon = () => (
  <div style={{ ...iconBase, background: "linear-gradient(180deg, #67e56b, #1fc73a)", display: "grid", placeItems: "center" }}>
    <svg viewBox="0 0 24 24" width={28} height={28} fill="#ffffff">
      <path d="M12 4c-4.7 0-8.5 3-8.5 6.7 0 2.1 1.2 4 3.1 5.2-.1.9-.5 2-1.4 2.9 1.6-.2 2.9-.8 3.8-1.4.9.3 1.9.4 3 .4 4.7 0 8.5-3 8.5-6.7S16.7 4 12 4Z" />
    </svg>
  </div>
);

const MailIcon = () => (
  <div style={{ ...iconBase, background: "linear-gradient(180deg, #59b6f8, #1673e6)", display: "grid", placeItems: "center" }}>
    <svg viewBox="0 0 24 24" width={26} height={26} fill="none" stroke="#ffffff" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <rect x={3} y={5.5} width={18} height={13} rx={2.4} />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  </div>
);

const PhotosIcon = () => (
  <div style={{ ...iconBase, background: "#ffffff", display: "grid", placeItems: "center" }}>
    <svg viewBox="0 0 44 44" width={44} height={44}>
      {["#f7c948", "#f78c48", "#f74848", "#e048b8", "#8048f7", "#4884f7", "#48c8f7", "#48d788"].map((c, i) => (
        <ellipse
          key={i}
          cx={22}
          cy={13.5}
          rx={4.6}
          ry={8}
          fill={c}
          opacity={0.82}
          transform={`rotate(${i * 45} 22 22)`}
        />
      ))}
    </svg>
  </div>
);

const CalendarIcon = () => (
  <div style={{ ...iconBase, position: "relative", background: "#ffffff" }}>
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 13, background: "#f0332a", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 7.5, fontWeight: 700, letterSpacing: "0.06em" }}>
      TUE
    </div>
    <div style={{ position: "absolute", top: 13, left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#26262b", fontSize: 21, fontWeight: 300 }}>
      8
    </div>
  </div>
);

const MusicIcon = () => (
  <div style={{ ...iconBase, background: "linear-gradient(180deg, #fb5c74, #f2273e)", display: "grid", placeItems: "center" }}>
    <svg viewBox="0 0 24 24" width={26} height={26} fill="#ffffff">
      <path d="M9 18.5a2.5 2.5 0 1 1-1.5-2.29V7.2c0-.5.35-.93.84-1.03l8-1.7c.65-.14 1.26.36 1.26 1.03v9.5a2.5 2.5 0 1 1-1.5-2.29V8.2l-7 1.5v8.8Z" />
    </svg>
  </div>
);

const SettingsIcon = () => (
  <div style={{ ...iconBase, background: "linear-gradient(180deg, #8e939c, #5b6069)", display: "grid", placeItems: "center" }}>
    <svg viewBox="0 0 24 24" width={28} height={28} fill="none" stroke="#e8eaee" strokeWidth={1.6}>
      <circle cx={12} cy={12} r={3.2} fill="#e8eaee" stroke="none" />
      <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.55 1.55M16.45 16.45 18 18M18 6l-1.55 1.55M7.55 16.45 6 18" strokeLinecap="round" strokeWidth={2.2} />
      <circle cx={12} cy={12} r={6.4} />
    </svg>
  </div>
);

const DOCK_APPS = [FinderIcon, SafariIcon, MessagesIcon, MailIcon, PhotosIcon, CalendarIcon, MusicIcon, SettingsIcon];

// ── Q3 briefing document — the screen the AI is reading in shot 2 ──
const DocChip: React.FC<{ label: string; bg: string; color: string }> = ({ label, bg, color }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "5px 14px",
      borderRadius: 999,
      background: bg,
      color,
      fontSize: 17,
      fontWeight: 600,
    }}
  >
    {label}
  </span>
);

const DocCheck: React.FC<{ label: string; done?: boolean }> = ({ label, done }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 21, color: done ? "#9a958c" : "#3a372f" }}>
    <span
      style={{
        width: 21,
        height: 21,
        borderRadius: 6,
        border: done ? "none" : "2px solid #c4beb2",
        background: done ? "#3b78ff" : "#ffffff",
        display: "grid",
        placeItems: "center",
        flex: "none",
      }}
    >
      {done ? (
        <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="#fff" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 13 4 4 10-10" />
        </svg>
      ) : null}
    </span>
    <span style={{ textDecoration: done ? "line-through" : "none" }}>{label}</span>
  </div>
);

const DocSection: React.FC<{ title: string; accent: string; children: React.ReactNode }> = ({ title, accent, children }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ width: 5, height: 26, borderRadius: 3, background: accent }} />
      <span style={{ fontSize: 26, fontWeight: 700, color: "#26231d" }}>{title}</span>
    </div>
    {children}
  </div>
);

const BriefingDoc: React.FC = () => (
  <div style={{ position: "absolute", inset: 0, background: "#e9e4da" }}>
    {/* document page */}
    <div
      style={{
        position: "absolute",
        left: (1920 - 1300) / 2,
        top: -60,
        width: 1300,
        height: 1220,
        background: "#fbf9f5",
        borderRadius: 20,
        boxShadow: "0 24px 70px rgba(60,50,30,0.18)",
        padding: "110px 110px 0",
        display: "flex",
        flexDirection: "column",
        gap: 34,
      }}
    >
      <div style={{ fontSize: 17, fontWeight: 600, color: "#a39c8e", letterSpacing: "0.04em" }}>
        MARKETING / LAUNCHES
      </div>
      <div style={{ fontSize: 52, fontWeight: 800, color: "#211e18", letterSpacing: "-0.02em", lineHeight: 1.1 }}>
        Q3 Launch Plan — Briefing
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <DocChip label="Status: On track" bg="#def0dd" color="#2e7d3a" />
        <DocChip label="Release locks Aug 12" bg="#ffe4cc" color="#c05b12" />
        <DocChip label="Owner: Elijah" bg="#dfe8ff" color="#2f5dd0" />
      </div>
      <div style={{ height: 1, background: "#e8e2d5" }} />

      <DocSection title="Timeline" accent="#3b78ff">
        <div style={{ fontSize: 21, color: "#4a463c", lineHeight: 1.75 }}>
          Feature freeze Jul 28 · QA pass Aug 4 ·{" "}
          <span style={{ background: "#ffd9b8", borderRadius: 5, padding: "2px 8px", fontWeight: 700, color: "#8a4a0e" }}>
            release locks Aug 12
          </span>{" "}
          · public launch Aug 19 with press embargo until 9:00 AM.
        </div>
      </DocSection>

      <DocSection title="Open tasks" accent="#f0872a">
        <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
          <DocCheck label="Finalize pricing page copy" />
          <DocCheck label="Cut the 60-second demo video" />
          <DocCheck label="Send beta invites to waitlist" />
          <DocCheck label="Lock launch blog headline" done />
          <DocCheck label="Confirm App Store screenshots" done />
        </div>
      </DocSection>

      <DocSection title="Notes" accent="#8a5cf6">
        <div style={{ fontSize: 21, color: "#4a463c", lineHeight: 1.75 }}>
          Beta review moved to Friday 2:00 — whole team confirmed. Keep the embargo
          list tight; anything inbound about launch timing goes to comms first.
        </div>
      </DocSection>
    </div>
  </div>
);

// ── macOS screen chrome: menu bar on top, dock on the bottom ──
export const ScreenChrome: React.FC<{
  menuExtra?: React.ReactNode;
  hideDock?: boolean;
}> = ({ menuExtra, hideDock }) => (
  <>
    {/* macOS menu bar */}
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 32,
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        gap: 20,
        fontSize: 13.5,
        color: "rgba(255,255,255,0.92)",
        background: "rgba(30,32,44,0.34)",
        backdropFilter: "blur(24px) saturate(1.4)",
        WebkitBackdropFilter: "blur(24px) saturate(1.4)",
      }}
    >
      <span style={{ fontSize: 15 }}>{"\uF8FF"}</span>
      <span style={{ fontWeight: 700 }}>Finder</span>
      <span>File</span>
      <span>Edit</span>
      <span>View</span>
      <span>Go</span>
      <span>Window</span>
      <span>Help</span>
      <span style={{ flex: 1 }} />
      {menuExtra}
      <span>Tue Jul 8</span>
      <span>9:41 AM</span>
    </div>
    {/* dock */}
    {hideDock ? null : (
    <div
      style={{
        position: "absolute",
        bottom: 12,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: 12,
        padding: "9px 14px",
        borderRadius: 20,
        background: "rgba(255,255,255,0.16)",
        backdropFilter: "blur(24px) saturate(1.5)",
        WebkitBackdropFilter: "blur(24px) saturate(1.5)",
        border: "1px solid rgba(255,255,255,0.18)",
      }}
    >
      {DOCK_APPS.map((App, i) => (
        <App key={i} />
      ))}
    </div>
    )}
  </>
);

// ── MacBook mockup: display panel, screen content, menu bar, dock, base ──
export const Laptop: React.FC<{
  children: React.ReactNode;
  menuExtra?: React.ReactNode;
}> = ({ children, menuExtra }) => (
  <>
    {/* laptop display panel */}
    <div
      style={{
        position: "absolute",
        left: LAP_PANEL_LEFT,
        top: LAP_PANEL_TOP,
        width: LAP_PANEL_W,
        height: LAP_PANEL_H,
        borderRadius: 28,
        background: "linear-gradient(180deg, #16161a 0%, #0b0b0d 100%)",
        boxShadow:
          "0 46px 110px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.09), inset 0 0 0 3px rgba(0,0,0,0.6)",
      }}
    >
      {/* screen */}
      <div
        style={{
          position: "absolute",
          left: LAP_BEZEL,
          top: LAP_BEZEL,
          width: SCREEN_W,
          height: SCREEN_H,
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        {children}
        <ScreenChrome menuExtra={menuExtra} />
      </div>
      {/* camera dot */}
      <div
        style={{
          position: "absolute",
          top: 8,
          left: "50%",
          transform: "translateX(-50%)",
          width: 7,
          height: 7,
          borderRadius: 99,
          background: "#1e2026",
          boxShadow: "inset 0 0 2px rgba(90,120,200,0.8)",
        }}
      />
    </div>
    {/* aluminum base */}
    <div
      style={{
        position: "absolute",
        left: 160,
        top: LAP_PANEL_TOP + LAP_PANEL_H,
        width: 1600,
        height: 24,
        borderRadius: "3px 3px 18px 18px",
        background: "linear-gradient(180deg, #b7bcc6 0%, #969ca8 55%, #6f747e 100%)",
        boxShadow: "0 18px 40px rgba(0,0,0,0.5)",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: "50%",
          transform: "translateX(-50%)",
          width: 260,
          height: 10,
          borderRadius: "0 0 12px 12px",
          background: "rgba(20,22,28,0.25)",
        }}
      />
    </div>
  </>
);

export const LyknGlassOverlay: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── shot 1 ──
  const camOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE } as const;
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
  const showCursor =
    frame >= T_TYPE_START && frame < T_CLICK && Math.floor(frame / 8) % 2 === 0;

  // mouse cursor
  const curX = interpolate(frame, CUR_T, CUR_X, camOpts);
  const curY = interpolate(frame, CUR_T, CUR_Y, camOpts);
  const pressAt = (at: number) =>
    interpolate(frame, [at, at + 3, at + 7], [0, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const curPress = Math.max(pressAt(T_INPUT_CLICK), pressAt(T_CLICK));
  const curOpacity =
    interpolate(frame, [0, 5], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) *
    interpolate(frame, [T_CLICK + 6, T_CLICK + 16], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  // click ripples
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

  // flying send button: rotate 90° then rocket right out of view
  const flying = frame >= T_SPIN;
  const spinDeg = interpolate(frame, [T_SPIN, T_SPIN + 7], [0, 90], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.back(1.6)),
  });
  const launchX = interpolate(frame, [T_LAUNCH, T_LAUNCH + 14], [0, 760], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });
  const launchStretch = interpolate(frame, [T_LAUNCH + 3, T_LAUNCH + 14], [1, 1.35], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });

  // ── transition: punch-zoom. Shot 1's camera accelerates into the frame,
  // then we swap at the peak and the glass card zooms in up to rest. ──
  const zoomPunch = interpolate(frame, [T_TRANS_START, T_SWAP], [1, 3.4], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });
  const showShot1 = frame < T_SWAP;
  const showShot2 = frame >= T_SWAP;
  const s2In = interpolate(frame, [T_SWAP, T_TRANS_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const s2Scale = CARD_SCALE * (0.55 + 0.45 * s2In);
  // shot-2 camera: full preview view, then a quick punch onto the card,
  // followed by a slow drift-in while the AI types.
  const cam2Opts = {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  } as const;
  const CAM2_T = [T_TRANS_END, T_TRANS_END + 12, T_BTN_ZOOM, T_BTN_ZOOM + 8, T_ADDED + 10, T_ADDED + 24];
  const c2x = interpolate(frame, CAM2_T, [960, CARD_CX, CARD_CX, BTN_CX, BTN_CX, CARD_CX], cam2Opts);
  const c2y = interpolate(frame, CAM2_T, [540, CARD_CY, CARD_CY, BTN_CY, BTN_CY, CARD_CY], cam2Opts);
  const z2 = interpolate(frame, CAM2_T, [1, 1.62, 1.72, 3.0, 3.0, 1.62], cam2Opts);
  const chars = Math.round(
    interpolate(frame, [T_TYPE2_START, T_TYPE2_END], [0, TOTAL_CHARS], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const caretOn = frame < T_TYPE2_END + 20 && Math.floor(frame / 7) % 2 === 0;

  // suggestion button: pop in, cursor click, "added" payoff
  const btnIn = spring({
    frame: frame - T_BTN,
    fps,
    config: { damping: 14, stiffness: 260 },
  });
  const added = frame >= T_ADDED;
  const btnPress = pressAt(T_BTN_CLICK);
  const cur2X = interpolate(frame, [T_BTN + 2, T_BTN_CLICK - 3], [BTN_CX + 310, BTN_CX + 12], cam2Opts);
  const cur2Y = interpolate(frame, [T_BTN + 2, T_BTN_CLICK - 3], [BTN_CY + 210, BTN_CY + 10], cam2Opts);
  const cur2Opacity =
    interpolate(frame, [T_BTN + 2, T_BTN + 7], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) *
    interpolate(frame, [T_BTN_CLICK + 8, T_BTN_CLICK + 18], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  return (
    <AbsoluteFill
      style={{
        background: "#141416",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      }}
    >
      <SceneBackground />
      {/* ── shot 1: laptop + glass bar camera rig, punch-zooms in for the transition ── */}
      {showShot1 && (
        <div style={{ position: "absolute", inset: 0 }}>
        <div
          style={{
            position: "absolute",
            width: 1920,
            height: 1080,
            transformOrigin: "0 0",
            transform: `translate(960px, 540px) scale(${z * zoomPunch}) translate(${-cx}px, ${-cy}px)`,
          }}
        >
          <Laptop>
            <Wallpaper />
          </Laptop>

          {/* glass bar, centered on the laptop screen */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <div
              style={{
                opacity: barOpacity,
                transform: `translateY(${SCREEN_CY - 540 + barY}px) scale(${SCALE * barScale})`,
                transformOrigin: "center",
              }}
            >
              <div
                style={{
                  borderRadius: 16,
                  boxShadow:
                    "0 24px 70px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.16), 0 0 30px 2px rgba(255,255,255,0.05)",
                }}
              >
                <OverlayUI
                  askText={askText}
                  askPlaceholder="Ask LYKN about your screen…"
                  showAskCursor={showCursor}
                  hideSend={flying}
                />
              </div>
            </div>
          </div>

          {/* flying send button replica */}
          {flying && (
            <div
              style={{
                position: "absolute",
                left: SEND_CX - SEND_SIZE / 2 + launchX,
                top: SEND_CY - SEND_SIZE / 2,
                width: SEND_SIZE,
                height: SEND_SIZE,
                borderRadius: 9 * SCALE,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.14)",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.08), 0 6px 20px rgba(0,0,0,0.4)",
                display: "grid",
                placeItems: "center",
                transform: `rotate(${spinDeg}deg) scaleX(${launchStretch})`,
                transformOrigin: "center",
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="#60a5fa"
                strokeWidth={2.25}
                strokeLinecap="round"
                strokeLinejoin="round"
                width={14 * SCALE}
                height={14 * SCALE}
              >
                <path d="m5 12 7-7 7 7" />
                <path d="M12 19V5" />
              </svg>
            </div>
          )}

          {/* click ripples */}
          {ripple(T_INPUT_CLICK, INPUT_CX, INPUT_CY)}
          {ripple(T_CLICK, SEND_CX, SEND_CY)}

          {/* mouse cursor */}
          {curOpacity > 0 && (
            <MousePointer x={curX} y={curY} press={curPress} opacity={curOpacity} />
          )}
        </div>
        </div>
      )}

      {/* ── shot 2: popped-out screen preview floating on the blue backdrop,
      camera punches in on the glass card at the left ── */}
      {showShot2 && (
        <div
          style={{
            position: "absolute",
            width: 1920,
            height: 1080,
            transformOrigin: "0 0",
            transform: `translate(960px, 540px) scale(${z2}) translate(${-c2x}px, ${-c2y}px)`,
          }}
        >
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
          {/* floating preview panel */}
          <div
            style={{
              position: "absolute",
              left: (1920 - PREVIEW_W) / 2,
              top: (1080 - PREVIEW_H) / 2,
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
              <BriefingDoc />
              <ScreenChrome />
            </div>
          </div>
          {/* glass card, parked on the left */}
          <div
            style={{
              position: "absolute",
              left: CARD_CX,
              top: CARD_CY,
              transform: `translate(-50%, -50%) scale(${s2Scale})`,
              transformOrigin: "center",
            }}
          >
          <div
            style={{
              position: "relative",
              width: 1080,
              padding: "48px 60px 54px",
              borderRadius: 32,
              // same glass material as the chat bar (OverlayUI)
              background: "rgba(16, 18, 24, 0.28)",
              backdropFilter: "blur(40px) saturate(180%)",
              WebkitBackdropFilter: "blur(40px) saturate(180%)",
              border: "1px solid rgba(255,255,255,0.12)",
              boxShadow:
                "0 24px 70px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.16), 0 0 30px 2px rgba(255,255,255,0.05)",
              overflow: "hidden",
            }}
          >
            {/* LYKN header */}
            <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 13, marginBottom: 30 }}>
              <svg
                viewBox={ICON_VIEWBOX}
                fill="none"
                style={{
                  width: 30,
                  height: 30,
                  color: "#3b78ff",
                  filter:
                    "drop-shadow(0 0 4px rgba(59,120,255,0.85)) drop-shadow(0 0 9px rgba(59,120,255,0.5))",
                }}
              >
                <path
                  d={ICON_PATH}
                  stroke="currentColor"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: "0.14em", color: "rgba(255,255,255,0.55)" }}>
                LYKN
              </span>
            </div>

            {/* typed lines */}
            <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 16 }}>
              {LINES.map((line, i) => {
                const visible = Math.max(
                  0,
                  Math.min(line.text.length, chars - LINE_STARTS[i])
                );
                if (visible === 0) return null;
                const text = line.text.slice(0, visible);
                const isActive =
                  chars >= LINE_STARTS[i] &&
                  chars < LINE_STARTS[i] + line.text.length;
                const showCaret =
                  caretOn && (isActive || (i === LINES.length - 1 && chars >= TOTAL_CHARS));
                const style: React.CSSProperties =
                  line.kind === "heading"
                    ? { fontSize: 34, fontWeight: 700, color: "#f4f6fb", lineHeight: 1.35, letterSpacing: "-0.01em", marginBottom: 6 }
                    : line.kind === "footer"
                      ? { fontSize: 27, fontWeight: 600, color: "#f4f6fb", lineHeight: 1.4, marginTop: 12 }
                      : { fontSize: 23, fontWeight: 400, color: "rgba(255,255,255,0.82)", lineHeight: 1.5 };
                return (
                  <div key={i} style={style}>
                    {text}
                    {showCaret ? (
                      <span
                        style={{
                          display: "inline-block",
                          width: 3,
                          height: "1em",
                          background: "#60a5fa",
                          marginLeft: 4,
                          verticalAlign: "text-bottom",
                          borderRadius: 2,
                        }}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>

            {/* suggested action — space is reserved so the card never reflows */}
            <div
              style={{
                position: "relative",
                marginTop: 30,
                opacity: Math.min(1, btnIn * 1.4),
                transform: `translateY(${(1 - btnIn) * 14}px)`,
              }}
            >
              <div style={{ height: 1, background: "rgba(255,255,255,0.14)", marginBottom: 18 }} />
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  letterSpacing: "0.14em",
                  color: "rgba(255,255,255,0.5)",
                  marginBottom: 14,
                }}
              >
                SUGGESTED ACTION
              </div>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "14px 26px",
                  borderRadius: 14,
                  fontSize: 22,
                  fontWeight: 600,
                  background: added
                    ? "rgba(74,222,128,0.16)"
                    : `rgba(96,165,250,${0.16 + btnPress * 0.18})`,
                  border: added
                    ? "1px solid rgba(74,222,128,0.55)"
                    : "1px solid rgba(96,165,250,0.5)",
                  color: added ? "#b8f0cb" : "#d7e7ff",
                  boxShadow: added
                    ? "0 0 24px 2px rgba(74,222,128,0.18)"
                    : "0 0 24px 2px rgba(96,165,250,0.14)",
                  transform: `scale(${1 - btnPress * 0.06})`,
                  transformOrigin: "center",
                }}
              >
                {added ? (
                  <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="#4ade80" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                    <path d="m4.5 12.5 5 5 10-11" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="#60a5fa" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                )}
                <span>{added ? "Added to your project" : "Add that to my project"}</span>
              </div>
            </div>
          </div>
          </div>

          {/* click ripple + cursor for the button beat */}
          {ripple(T_BTN_CLICK, BTN_CX, BTN_CY)}
          {cur2Opacity > 0 && (
            <MousePointer x={cur2X} y={cur2Y} press={btnPress} opacity={cur2Opacity} />
          )}
        </div>
      )}
    </AbsoluteFill>
  );
};
