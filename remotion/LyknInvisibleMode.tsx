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

// ---------------------------------------------------------------------------
// LYKN Invisible Mode — a popped-out preview of a live video meeting floats
// on the blue backdrop. The glass bar pops in over it, the cursor opens the
// three-dot menu, picks "Invisible mode", the camera pulls back, and the bar
// dissolves off the screen — invisible to screen sharing and screenshots.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);

// Global playback speed — the frame clock is multiplied by this, so every
// beat (camera zoom, clicks, menu, dissolve) runs proportionally faster.
const SPEED = 2;

// Timeline (30 fps, pre-speed frame numbers).
const T_BAR_IN = 4;
const T_DOTS_CLICK = 26; // cursor clicks the ... button
const T_MENU_OPEN = 28;
const T_ITEM_CLICK = 52; // cursor clicks "Invisible mode"
const T_MENU_CLOSE = 58;
const T_VANISH = 96; // bar starts dissolving
const T_VANISH_END = 120;
const T_CAPTION = 110;

export const INVISIBLE_MODE_DURATION = Math.ceil(210 / SPEED);

const SCALE = 1.3;

// Bar geometry on the 1920x1080 stage (centered, pre-thread height 116).
const BAR_H = 116;
const BAR_LEFT = 960 - (OVERLAY_CHAT_W * SCALE) / 2;
const BAR_TOP = 540 - (BAR_H * SCALE) / 2;
const BAR_BOTTOM = BAR_TOP + BAR_H * SCALE;

// Three-dot button center: 95px from the right edge, 23px up from the bottom.
const DOTS_CX = BAR_LEFT + (OVERLAY_CHAT_W - 95) * SCALE;
const DOTS_CY = BAR_TOP + (BAR_H - 23) * SCALE;

// Dropdown menu (unscaled design px, drawn at SCALE).
const MENU_W = 224;
const MENU_PAD = 6;
const MENU_ITEM_H = 36;
const MENU_ITEMS = 3;
const MENU_H = MENU_PAD * 2 + MENU_ITEM_H * MENU_ITEMS;
// Anchored below the bar, right-aligned to the dots button.
const MENU_RIGHT = DOTS_CX + 15 * SCALE;
const MENU_LEFT = MENU_RIGHT - MENU_W * SCALE;
const MENU_TOP = BAR_BOTTOM + 8 * SCALE;
// "Invisible mode" is the first item.
const ITEM_CX = MENU_LEFT + (MENU_W / 2) * SCALE;
const ITEM_CY = MENU_TOP + (MENU_PAD + MENU_ITEM_H / 2) * SCALE;

// Camera: full → dots button + menu area → back to full for the vanish.
const FOCUS_X = (MENU_LEFT + MENU_RIGHT) / 2;
const FOCUS_Y = MENU_TOP + (MENU_H * SCALE) / 2 - 20;
const CAM_T = [0, 10, 24, 62, 84];
const CAM_CX = [960, 960, FOCUS_X, FOCUS_X, 960];
const CAM_CY = [540, 540, FOCUS_Y, FOCUS_Y, 540];
const CAM_Z = [1, 1, 3.1, 3.1, 1];

// Mouse cursor: enters, clicks the dots, drops to "Invisible mode", clicks.
const CUR_T = [0, 24, 34, 48];
const CUR_X = [1330, DOTS_CX, DOTS_CX, ITEM_CX + 40];
const CUR_Y = [880, DOTS_CY, DOTS_CY, ITEM_CY];

// macOS-style pointer, tip at (0,0).
const MousePointer: React.FC<{ x: number; y: number; press: number; opacity: number }> = ({
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

const EyeOffIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
    <line x1={2} x2={22} y1={2} y2={22} />
  </svg>
);

const SlidersIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
    <line x1={21} x2={14} y1={4} y2={4} />
    <line x1={10} x2={3} y1={4} y2={4} />
    <line x1={21} x2={12} y1={12} y2={12} />
    <line x1={8} x2={3} y1={12} y2={12} />
    <line x1={21} x2={16} y1={20} y2={20} />
    <line x1={12} x2={3} y1={20} y2={20} />
    <line x1={14} x2={14} y1={2} y2={6} />
    <line x1={8} x2={8} y1={10} y2={14} />
    <line x1={16} x2={16} y1={18} y2={22} />
  </svg>
);

const PowerIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
    <path d="M12 2v10" />
    <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
  </svg>
);

// Popped-out screen-preview panel (16:9, centered), matching LyknGlassOverlay.
const PREVIEW_W = 1600;
const PREVIEW_H = 900;
// Baked "frost" behind the glass bar / menu — a blurred impression of the
// meeting scene (dark room with soft colored glows from the video tiles).
const MEETING_FROST =
  "radial-gradient(42% 62% at 22% 38%, rgba(124,92,240,0.22), transparent 70%), " +
  "radial-gradient(40% 60% at 76% 42%, rgba(59,130,246,0.18), transparent 70%), " +
  "radial-gradient(36% 55% at 50% 78%, rgba(236,72,153,0.10), transparent 70%), " +
  "linear-gradient(160deg, #262932 0%, #17191f 100%)";

// ── video-meeting scene shown inside the preview panel ──
const MicIcon: React.FC<{ size: number; color: string; muted?: boolean }> = ({
  size,
  color,
  muted,
}) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
    <rect x={9} y={3} width={6} height={11} rx={3} />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <line x1={12} x2={12} y1={18} y2={21} />
    {muted ? <line x1={3} x2={21} y1={3} y2={21} stroke="#f87171" /> : null}
  </svg>
);

const VideoIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
    <rect x={2.5} y={6} width={13} height={12} rx={2.5} />
    <path d="m15.5 10 5-3v10l-5-3" />
  </svg>
);

const ShareIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
    <rect x={3} y={5} width={18} height={13} rx={2.2} />
    <path d="M12 14v-4.5" />
    <path d="m9.8 11.2 2.2-2.2 2.2 2.2" />
  </svg>
);

const ChatIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const PeopleIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
    <circle cx={9} cy={8} r={3.2} />
    <path d="M3.5 20c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
    <circle cx={17} cy={9} r={2.5} />
    <path d="M16 15.3c2.3.2 4 1.8 4.5 4.7" />
  </svg>
);

const PhoneOffIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 24 24" fill={color} width={size} height={size}>
    <path d="M12 9c-3.9 0-7.4 1.3-10 3.4-.6.5-.7 1.4-.2 2l1.6 1.9c.4.5 1.1.7 1.7.4l3-1.4c.5-.2.8-.7.8-1.3v-1.6c2-.6 4.2-.6 6.2 0V14c0 .6.3 1.1.8 1.3l3 1.4c.6.3 1.3.1 1.7-.4l1.6-1.9c.5-.6.4-1.5-.2-2C19.4 10.3 15.9 9 12 9Z" />
  </svg>
);

type Participant = {
  name: string;
  initials: string;
  from: string;
  to: string;
  speaking?: boolean;
  muted?: boolean;
  cameraOff?: boolean;
};

const PARTICIPANTS: Participant[] = [
  { name: "Maya Chen", initials: "MC", from: "#8b6cf5", to: "#5546e0", speaking: true },
  { name: "Derek Ross", initials: "DR", from: "#f5a623", to: "#e5484d" },
  { name: "Priya Patel", initials: "PP", from: "#22c08b", to: "#0f9488" },
  { name: "Sam Ortiz", initials: "SO", from: "#4a5568", to: "#2d3748", cameraOff: true, muted: true },
  { name: "Lena Fischer", initials: "LF", from: "#ec6a9c", to: "#c2337a" },
  { name: "You", initials: "EL", from: "#5b8def", to: "#3457c4", muted: true },
];

const ControlButton: React.FC<{ children: React.ReactNode; active?: boolean }> = ({
  children,
  active,
}) => (
  <div
    style={{
      width: 58,
      height: 58,
      borderRadius: 99,
      background: active ? "rgba(229,72,77,0.22)" : "rgba(255,255,255,0.09)",
      border: "1px solid rgba(255,255,255,0.10)",
      display: "grid",
      placeItems: "center",
      flex: "none",
    }}
  >
    {children}
  </div>
);

// The full 1920x1080 meeting screen rendered inside the preview panel.
const MeetingScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(180deg, #17181d 0%, #101115 100%)",
      }}
    >
      {/* top bar: meeting title + recording indicator */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 68,
          display: "flex",
          alignItems: "center",
          padding: "0 34px",
          gap: 16,
          color: "rgba(255,255,255,0.88)",
        }}
      >
        <span style={{ fontSize: 21, fontWeight: 600 }}>Weekly Product Sync</span>
        <span style={{ fontSize: 17, color: "rgba(255,255,255,0.4)" }}>6 participants</span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "6px 16px",
            borderRadius: 999,
            background: "rgba(229,72,77,0.16)",
            border: "1px solid rgba(229,72,77,0.35)",
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: "#ff8589",
          }}
        >
          <span style={{ width: 9, height: 9, borderRadius: 99, background: "#e5484d" }} />
          REC
        </span>
        <span style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", fontVariantNumeric: "tabular-nums" }}>
          32:14
        </span>
      </div>

      {/* participant grid (2 rows x 3) */}
      <div
        style={{
          position: "absolute",
          left: 30,
          right: 30,
          top: 72,
          bottom: 112,
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gridTemplateRows: "1fr 1fr",
          gap: 18,
        }}
      >
        {PARTICIPANTS.map((p, i) => (
          <div
            key={p.name}
            style={{
              position: "relative",
              borderRadius: 16,
              overflow: "hidden",
              background: p.cameraOff
                ? "#1c1e24"
                : `radial-gradient(120% 130% at 50% 30%, ${p.from}33 0%, #1a1c22 55%, #15161b 100%)`,
              border: p.speaking
                ? "2.5px solid rgba(52,211,153,0.9)"
                : "1px solid rgba(255,255,255,0.07)",
              boxShadow: p.speaking ? "0 0 34px rgba(52,211,153,0.22)" : undefined,
            }}
          >
            {/* avatar */}
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "44%",
                transform: "translate(-50%,-50%)",
                width: 128,
                height: 128,
                borderRadius: 99,
                background: `linear-gradient(150deg, ${p.from}, ${p.to})`,
                display: "grid",
                placeItems: "center",
                fontSize: 44,
                fontWeight: 700,
                color: "rgba(255,255,255,0.94)",
                letterSpacing: "0.02em",
                boxShadow: "0 14px 40px rgba(0,0,0,0.45)",
              }}
            >
              {p.initials}
            </div>

            {/* name pill */}
            <div
              style={{
                position: "absolute",
                left: 14,
                bottom: 14,
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "7px 14px",
                borderRadius: 10,
                background: "rgba(10,11,14,0.62)",
                fontSize: 17,
                fontWeight: 500,
                color: "rgba(255,255,255,0.9)",
              }}
            >
              <MicIcon
                size={15}
                color={p.muted ? "#f87171" : "rgba(255,255,255,0.75)"}
                muted={p.muted}
              />
              {p.name}
            </div>

            {/* live audio bars on the active speaker */}
            {p.speaking ? (
              <div
                style={{
                  position: "absolute",
                  right: 16,
                  bottom: 16,
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 4,
                  height: 24,
                }}
              >
                {[0, 1, 2].map((b) => (
                  <span
                    key={b}
                    style={{
                      width: 5,
                      borderRadius: 3,
                      background: "#34d399",
                      height: 8 + 12 * Math.abs(Math.sin(frame * 0.55 + b * 1.3 + i)),
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* bottom control bar */}
      <div
        style={{
          position: "absolute",
          bottom: 22,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "11px 18px",
          borderRadius: 999,
          background: "rgba(24,26,32,0.85)",
          border: "1px solid rgba(255,255,255,0.09)",
          boxShadow: "0 14px 40px rgba(0,0,0,0.4)",
        }}
      >
        <ControlButton>
          <MicIcon size={24} color="rgba(255,255,255,0.85)" />
        </ControlButton>
        <ControlButton>
          <VideoIcon size={24} color="rgba(255,255,255,0.85)" />
        </ControlButton>
        <ControlButton>
          <ShareIcon size={24} color="rgba(255,255,255,0.85)" />
        </ControlButton>
        <ControlButton>
          <ChatIcon size={23} color="rgba(255,255,255,0.85)" />
        </ControlButton>
        <ControlButton>
          <PeopleIcon size={24} color="rgba(255,255,255,0.85)" />
        </ControlButton>
        <div
          style={{
            marginLeft: 8,
            height: 58,
            padding: "0 30px",
            borderRadius: 99,
            background: "#e5484d",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 18,
            fontWeight: 600,
            color: "#ffffff",
          }}
        >
          <PhoneOffIcon size={24} color="#ffffff" />
          Leave
        </div>
      </div>
    </div>
  );
};

export const LyknInvisibleMode: React.FC = () => {
  // Scaled clock: all timeline constants below stay untouched while the
  // whole choreography plays back SPEED× faster.
  const frame = useCurrentFrame() * SPEED;
  const { fps } = useVideoConfig();

  const camOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE } as const;
  const cx = interpolate(frame, CAM_T, CAM_CX, camOpts);
  const cy = interpolate(frame, CAM_T, CAM_CY, camOpts);
  const z = interpolate(frame, CAM_T, CAM_Z, camOpts);

  // bar entrance
  const inSpring = spring({
    frame: frame - T_BAR_IN,
    fps,
    config: { damping: 14, stiffness: 220 },
  });
  const barInOpacity = Math.min(1, inSpring * 1.6);
  const barInScale = 0.92 + inSpring * 0.08;
  const barInY = (1 - inSpring) * 20;

  // bar dissolve — the "going invisible" moment
  const vanish = interpolate(frame, [T_VANISH, T_VANISH_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.quad),
  });
  const barOpacity = barInOpacity * (1 - vanish);
  const barBlur = vanish * 18;
  const barScale = barInScale * (1 - vanish * 0.05);

  // mouse cursor
  const curX = interpolate(frame, CUR_T, CUR_X, camOpts);
  const curY = interpolate(frame, CUR_T, CUR_Y, camOpts);
  const pressAt = (at: number) =>
    interpolate(frame, [at, at + 3, at + 7], [0, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const curPress = Math.max(pressAt(T_DOTS_CLICK), pressAt(T_ITEM_CLICK));
  const curOpacity =
    interpolate(frame, [0, 5], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) *
    interpolate(frame, [T_ITEM_CLICK + 8, T_ITEM_CLICK + 18], [1, 0], {
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

  // dropdown menu open/close
  const menuSpring = spring({
    frame: frame - T_MENU_OPEN,
    fps,
    config: { damping: 15, stiffness: 240 },
  });
  const menuClose = interpolate(frame, [T_MENU_CLOSE, T_MENU_CLOSE + 7], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });
  const menuVisible = frame >= T_MENU_OPEN && menuClose < 1;
  const menuScale = (0.82 + menuSpring * 0.18) * (1 - menuClose * 0.06);
  const menuOpacity = Math.min(1, menuSpring * 1.5) * (1 - menuClose);

  // hover + click flash on the "Invisible mode" item
  const hovered = frame >= 44;
  const flash = interpolate(frame, [T_ITEM_CLICK, T_ITEM_CLICK + 3, T_ITEM_CLICK + 12], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // closing caption
  const captionIn = interpolate(frame, [T_CAPTION, T_CAPTION + 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  const menuItems = [
    { label: "Invisible mode", icon: EyeOffIcon, accent: true },
    { label: "Settings", icon: SlidersIcon, accent: false },
    { label: "Quit LYKN", icon: PowerIcon, accent: false },
  ];

  return (
    <AbsoluteFill
      style={{
        background: "#1a1a1a",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      }}
    >
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
        {/* blue backdrop */}
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
        {/* floating screen-preview panel */}
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
            <MeetingScene />
          </div>
        </div>

        {/* glass bar, dissolves when invisible mode kicks in */}
        {barOpacity > 0.001 && (
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
                filter: barBlur > 0.1 ? `blur(${barBlur}px)` : undefined,
                transform: `translateY(${barInY}px) scale(${SCALE * barScale})`,
                transformOrigin: "center",
              }}
            >
              <div
                style={{
                  position: "relative",
                  borderRadius: 16,
                  boxShadow:
                    "0 24px 70px rgba(0,0,0,0.55), 0 0 0 0.5px rgba(255,255,255,0.16), 0 0 30px 2px rgba(255,255,255,0.05)",
                }}
              >
                {/* baked frost: a blurred impression of the meeting scene
                behind the bar, so the glass reads as translucent */}
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: 16,
                    overflow: "hidden",
                    background: MEETING_FROST,
                  }}
                />
                <div style={{ position: "relative" }}>
                  <OverlayUI askPlaceholder="Ask LYKN about your screen…" />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* three-dot dropdown menu */}
        {menuVisible && (
          <div
            style={{
              position: "absolute",
              left: MENU_LEFT,
              top: MENU_TOP,
              width: MENU_W * SCALE,
              opacity: menuOpacity,
              transform: `scale(${menuScale})`,
              transformOrigin: "top right",
            }}
          >
            <div
              style={{
                position: "relative",
                width: MENU_W,
                padding: MENU_PAD,
                transform: `scale(${SCALE})`,
                transformOrigin: "top left",
                borderRadius: 14,
                overflow: "hidden",
                border: "1px solid rgba(255,255,255,0.16)",
                boxShadow:
                  "0 18px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.14), 0 0 0 0.5px rgba(255,255,255,0.1)",
              }}
            >
              {/* baked frost behind the menu, matching the meeting scene */}
              <div style={{ position: "absolute", inset: 0, background: MEETING_FROST }} />
              {/* glass tint over the frost */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background:
                    "linear-gradient(160deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.05) 40%, rgba(255,255,255,0.035) 100%), rgba(16, 18, 24, 0.28)",
                  backdropFilter: "blur(30px) saturate(1.4)",
                  WebkitBackdropFilter: "blur(30px) saturate(1.4)",
                }}
              />
              {menuItems.map((item, i) => {
                const isTarget = i === 0;
                const bg = isTarget
                  ? flash > 0
                    ? `rgba(96,165,250,${0.14 + flash * 0.2})`
                    : hovered
                      ? "rgba(255,255,255,0.09)"
                      : "transparent"
                  : "transparent";
                const Icon = item.icon;
                return (
                  <div
                    key={item.label}
                    style={{
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      height: MENU_ITEM_H,
                      padding: "0 10px",
                      borderRadius: 9,
                      background: bg,
                      color: item.accent ? "#eaf1ff" : "rgba(255,255,255,0.78)",
                      fontSize: 12.5,
                      fontWeight: 500,
                    }}
                  >
                    <Icon size={15} color={item.accent ? "#60a5fa" : "rgba(255,255,255,0.6)"} />
                    <span>{item.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* click ripples */}
        {ripple(T_DOTS_CLICK, DOTS_CX, DOTS_CY)}
        {ripple(T_ITEM_CLICK, ITEM_CX + 40, ITEM_CY)}

        {/* mouse cursor */}
        {curOpacity > 0 && (
          <MousePointer x={curX} y={curY} press={curPress} opacity={curOpacity} />
        )}
      </div>

      {/* closing caption where the bar used to be */}
      {captionIn > 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: captionIn,
            transform: `translateY(${(1 - captionIn) * 14}px)`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              padding: "20px 34px",
              borderRadius: 999,
              background:
                "linear-gradient(160deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.05) 40%, rgba(255,255,255,0.035) 100%), " +
                "linear-gradient(rgba(16,18,26,0.55), rgba(16,18,26,0.55))",
              backdropFilter: "blur(28px) saturate(1.4)",
              WebkitBackdropFilter: "blur(28px) saturate(1.4)",
              border: "1px solid rgba(255,255,255,0.16)",
              boxShadow:
                "0 24px 70px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.14), 0 0 0 0.5px rgba(255,255,255,0.1)",
            }}
          >
            <EyeOffIcon size={30} color="rgba(255,255,255,0.7)" />
            <span
              style={{
                fontSize: 27,
                fontWeight: 500,
                color: "rgba(255,255,255,0.85)",
                letterSpacing: "0.01em",
              }}
            >
              Invisible to screen sharing, screenshots, and recordings
            </span>
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};
