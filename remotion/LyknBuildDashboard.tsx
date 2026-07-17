import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { OverlayUI, OVERLAY_CHAT_W, formatOverlayResponse } from "./OverlayUI";
import { MousePointer } from "./LyknGlassOverlay";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";

// ---------------------------------------------------------------------------
// Build Dashboard — a report sits in a preview panel on the crop off-white
// stage. Camera punches onto the glass bar, Build mode arms, the user types
// "build a dashboard for this report", LYKN thinks + codes, then the panel
// morphs into the finished management dashboard.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);
const OFFWHITE = "#faf9f7";

const QUESTION = "build a dashboard for this report";

// ── timeline (30 fps) ──
const T_BAR_IN = 6;
const T_ZBAR = 22; // glide onto the bar
const T_CHIP = 38; // Build mode chip arms
const T_TYPE = 50;
const T_SEND = 112; // cursor clicks send
const T_THREAD = 116; // thread opens (grows upward from the bar)
const T_CODE = 132; // coding stream starts
const T_CARD = 178; // dashboard artifact card lands in the response
const T_CLICK = 214; // cursor clicks the artifact card
const T_OPEN = 218; // dashboard expands out of the card over the panel
export const BUILD_DASHBOARD_DURATION = 390;

// ── preview panel ──
const PREVIEW_W = 1600;
const PREVIEW_H = 900;
const PANEL_LEFT = (1920 - PREVIEW_W) / 2;
const PANEL_TOP = (1080 - PREVIEW_H) / 2;
const K = PREVIEW_W / 1920;

// ── glass bar, bottom-pinned so the thread grows upward and stays visible ──
const SCALE = 1.3;
const BAR_BOTTOM = 890;
const BAR_LEFT = 960 - (OVERLAY_CHAT_W * SCALE) / 2;
// Bottom row buttons sit ~23px up from the component's bottom edge.
const SEND_CX = BAR_LEFT + (OVERLAY_CHAT_W - 27) * SCALE;
const BTN_CY = BAR_BOTTOM - 23 * SCALE;
// Stage rect of the artifact card inside the open thread (intro + code block
// sit above it): thread content spans 38px→504px inside the 520px overlay,
// and the card's bottom edge sits just above the composer. Used for the
// cursor click and as the dashboard's expansion origin.
const CARD_W = 466 - 38; // answer column width inside the overlay (unscaled)
const CARD_H = 178;
const CARD_RECT = {
  left: BAR_LEFT + 38 * SCALE,
  top: BAR_BOTTOM - (116 + 14 + CARD_H) * SCALE,
  width: CARD_W * SCALE,
  height: CARD_H * SCALE,
};
const CARD_CLICK_X = CARD_RECT.left + CARD_RECT.width / 2;
const CARD_CLICK_Y = CARD_RECT.top + CARD_RECT.height / 2;

const CODE_LINES = [
  "scaffold ManagementDashboard…",
  "layout: sidebar · gantt · stats · files",
  "wire KPIs from Q3 report metrics",
  "compose Team + progress panels",
  "polish glass surfaces + light theme",
];

const ReportPage: React.FC = () => (
  <div
    style={{
      width: 1920,
      height: 1080,
      background: OFFWHITE,
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      color: "#1c1c1e",
      position: "relative",
      overflow: "hidden",
    }}
  >
    <div
      style={{
        height: 52,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 28px",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
        background: "rgba(255,255,255,0.72)",
      }}
    >
      <div style={{ display: "flex", gap: 7 }}>
        <span style={{ width: 11, height: 11, borderRadius: 99, background: "#ff5f57" }} />
        <span style={{ width: 11, height: 11, borderRadius: 99, background: "#febc2e" }} />
        <span style={{ width: 11, height: 11, borderRadius: 99, background: "#28c840" }} />
      </div>
      <div
        style={{
          margin: "0 auto",
          height: 28,
          minWidth: 340,
          borderRadius: 8,
          background: "rgba(0,0,0,0.05)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          color: "#8e8e93",
        }}
      >
        Q3 Operations Report.pdf
      </div>
    </div>

    <div style={{ padding: "40px 88px 48px", maxWidth: 1240 }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          borderRadius: 999,
          background: "rgba(0,0,0,0.05)",
          color: "#636366",
          fontSize: 13,
          fontWeight: 600,
          marginBottom: 18,
        }}
      >
        Operations · June 2023
      </div>

      <h1
        style={{
          margin: 0,
          fontSize: 44,
          fontWeight: 700,
          letterSpacing: "-0.035em",
          lineHeight: 1.08,
        }}
      >
        Operations Report
      </h1>
      <p style={{ margin: "14px 0 0", fontSize: 18, color: "#636366", lineHeight: 1.5, maxWidth: 720 }}>
        Headcount, project load, and delivery health across Design, Marketing,
        and Development — ready to turn into a live management dashboard.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr 1fr",
          gap: 16,
          marginTop: 36,
        }}
      >
        {[
          { label: "Total users", value: "1,240" },
          { label: "Active", value: "562" },
          { label: "Projects", value: "18" },
          { label: "On track", value: "72%" },
        ].map((m) => (
          <div
            key={m.label}
            style={{
              background: "rgba(255,255,255,0.78)",
              border: "1px solid rgba(0,0,0,0.06)",
              borderRadius: 18,
              padding: "18px 20px",
              boxShadow: "0 10px 30px rgba(0,0,0,0.04)",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: "#8e8e93", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              {m.label}
            </div>
            <div style={{ marginTop: 8, fontSize: 32, fontWeight: 700, letterSpacing: "-0.03em" }}>
              {m.value}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.35fr 1fr",
          gap: 16,
          marginTop: 18,
        }}
      >
        <div
          style={{
            background: "rgba(255,255,255,0.78)",
            border: "1px solid rgba(0,0,0,0.06)",
            borderRadius: 18,
            padding: "22px 24px",
            minHeight: 300,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Workload by team</div>
          {[
            { name: "UX / UI Design", pct: 45 },
            { name: "Marketing", pct: 70 },
            { name: "Development", pct: 58 },
            { name: "Infography", pct: 32 },
          ].map((row) => (
            <div key={row.name} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>{row.name}</span>
                <span style={{ color: "#8e8e93" }}>{row.pct}%</span>
              </div>
              <div style={{ height: 8, borderRadius: 99, background: "rgba(0,0,0,0.06)", overflow: "hidden" }}>
                <div
                  style={{
                    width: `${row.pct}%`,
                    height: "100%",
                    borderRadius: 99,
                    background: "#1c1c1e",
                  }}
                />
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            background: "rgba(255,255,255,0.78)",
            border: "1px solid rgba(0,0,0,0.06)",
            borderRadius: 18,
            padding: "22px 24px",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Highlights</div>
          {[
            "Design sprint closed 3 days early.",
            "Mobile apps track is 12 hours ahead.",
            "File preview pipeline ready for demo.",
            "Team capacity supports a June push.",
          ].map((t) => (
            <div
              key={t}
              style={{
                display: "flex",
                gap: 10,
                marginBottom: 14,
                fontSize: 14.5,
                lineHeight: 1.45,
                color: "#3a3a3c",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 99,
                  background: "#1c1c1e",
                  marginTop: 7,
                  flexShrink: 0,
                }}
              />
              {t}
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);

// ── the built dashboard (authored 1920x1080, modeled on the reference:
// sidebar, gantt schedule, ongoing-projects trend, file preview, team panel).
// `t` is frames since the build reveal started — blocks assemble staggered. ──

const INK = "#141416";
const GREY = "#8e8e93";
const CARD_BORDER = "1px solid rgba(0,0,0,0.06)";

const AVATAR_COLORS = [
  "linear-gradient(135deg, #f0a58f, #c96f56)",
  "linear-gradient(135deg, #9fb4d8, #5d7bb0)",
  "linear-gradient(135deg, #d8b46a, #a9823a)",
  "linear-gradient(135deg, #b79ad1, #7e5aa8)",
  "linear-gradient(135deg, #8fc9a8, #4f9371)",
  "linear-gradient(135deg, #e39ab4, #b05a7e)",
];

const Avatar: React.FC<{ i: number; size?: number; ring?: boolean }> = ({
  i,
  size = 26,
  ring = true,
}) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: 99,
      background: AVATAR_COLORS[i % AVATAR_COLORS.length],
      border: ring ? "2px solid #ffffff" : "none",
      flexShrink: 0,
      display: "inline-block",
    }}
  />
);

const AvatarStack: React.FC<{ ids: number[]; size?: number }> = ({ ids, size = 26 }) => (
  <span style={{ display: "inline-flex" }}>
    {ids.map((id, idx) => (
      <span key={idx} style={{ marginLeft: idx === 0 ? 0 : -(size / 3) }}>
        <Avatar i={id} size={size} />
      </span>
    ))}
  </span>
);

const NavIcon: React.FC<{ kind: string; color: string }> = ({ kind, color }) => {
  const paths: Record<string, React.ReactNode> = {
    home: <path d="M3 10.5 12 3l9 7.5V21h-6v-6h-6v6H3z" />,
    calendar: (
      <>
        <rect x={3} y={4} width={18} height={18} rx={2} />
        <path d="M8 2v4M16 2v4M3 10h18" />
      </>
    ),
    grid: (
      <>
        <rect x={3} y={3} width={7} height={7} rx={1.5} />
        <rect x={14} y={3} width={7} height={7} rx={1.5} />
        <rect x={3} y={14} width={7} height={7} rx={1.5} />
        <rect x={14} y={14} width={7} height={7} rx={1.5} />
      </>
    ),
    arrows: <path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" />,
    chart: <path d="M4 20V10m6 10V4m6 16v-7m4 7H2" />,
    folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
    gear: (
      <>
        <circle cx={12} cy={12} r={3.2} />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
      </>
    ),
  };
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      {paths[kind]}
    </svg>
  );
};

/** Gantt rows: label, bar text, start/width as fraction of the 1PM–8PM axis. */
const GANTT_ROWS: {
  label: string;
  text: string;
  start: number;
  width: number;
  avatars: number[];
  plus?: boolean;
}[] = [
  { label: "Design", text: "about 2 hours", start: 0.02, width: 0.3, avatars: [0, 1], plus: true },
  { label: "Mobile Apps", text: "about 5 hours", start: 0.1, width: 0.24, avatars: [2] },
  { label: "Infography", text: "about 3 hours", start: 0.18, width: 0.2, avatars: [3], plus: true },
  { label: "Wireframes", text: "about 5 hours", start: 0.4, width: 0.26, avatars: [4, 5] },
  { label: "Team Management", text: "about 3 hours", start: 0.3, width: 0.22, avatars: [1] },
];

const TREND_POINTS = "0,46 24,40 48,44 72,30 96,36 120,18 144,26 168,10 192,16 216,4";

const FILE_ROWS = [
  { name: "Licence on Figma templates.pdf", tint: "#e05d5d" },
  { name: "Devspire_UI-Kit.fig", tint: "#8f6ae0" },
  { name: "Devspire redisign.word", tint: "#4f7ddb" },
  { name: "National Bank.fig", tint: "#4aa877" },
];

const DashboardScene: React.FC<{ t: number; fps: number }> = ({ t, fps }) => {
  // staggered assembly: each block springs in at its own delay
  const pop = (delay: number) => {
    const p = spring({ frame: t - delay, fps, config: { damping: 15, stiffness: 130 } });
    return {
      opacity: Math.min(1, p * 1.3),
      transform: `translateY(${(1 - p) * 22}px)`,
    } as const;
  };
  // gantt bars grow after their row appears
  const grow = (delay: number) =>
    spring({ frame: t - delay, fps, config: { damping: 17, stiffness: 110 } });
  // trend line draws on
  const lineDraw = interpolate(t, [26, 52], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  return (
    <div
      style={{
        width: 1920,
        height: 1080,
        background: "#e9e8e6",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
        color: INK,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 1800,
          height: 990,
          borderRadius: 30,
          background: "rgba(250,249,247,0.92)",
          boxShadow: "0 30px 80px rgba(0,0,0,0.10), 0 0 0 1px rgba(255,255,255,0.6)",
          display: "flex",
          overflow: "hidden",
          ...pop(0),
        }}
      >
        {/* ── sidebar ── */}
        <div
          style={{
            width: 190,
            flexShrink: 0,
            borderRight: "1px solid rgba(0,0,0,0.05)",
            padding: "26px 18px",
            display: "flex",
            flexDirection: "column",
            ...pop(3),
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 40 }}>
            <span
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                background: INK,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 15,
                fontWeight: 700,
              }}
            >
              C
            </span>
            <span style={{ fontSize: 15.5, fontWeight: 650 }}>Coders</span>
          </div>

          {[
            { kind: "home", label: "Home" },
            { kind: "calendar", label: "Schedule" },
            { kind: "grid", label: "Projects", active: true },
            { kind: "arrows", label: "Projects" },
            { kind: "chart", label: "Projects" },
            { kind: "folder", label: "Projects" },
            { kind: "gear", label: "Projects" },
          ].map((item, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "10px 13px",
                marginBottom: 4,
                borderRadius: 12,
                background: item.active ? INK : "transparent",
                color: item.active ? "#ffffff" : GREY,
                fontSize: 13.5,
                fontWeight: item.active ? 600 : 500,
              }}
            >
              <NavIcon kind={item.kind} color={item.active ? "#ffffff" : GREY} />
              {item.label}
            </div>
          ))}

          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
            <Avatar i={5} size={44} ring={false} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Ann Kowalski</div>
              <div style={{ fontSize: 11, color: GREY }}>Product lead</div>
            </div>
          </div>
        </div>

        {/* ── main column ── */}
        <div style={{ flex: 1, padding: "24px 28px", display: "flex", flexDirection: "column", minWidth: 0 }}>
          {/* header */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, ...pop(6) }}>
            <h1 style={{ margin: 0, fontSize: 34, fontWeight: 700, letterSpacing: "-0.03em" }}>
              Management
            </h1>
            <div style={{ flex: 1 }} />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: 40,
                padding: "0 16px",
                borderRadius: 99,
                background: INK,
                color: "#fff",
                fontSize: 12.5,
                fontWeight: 600,
              }}
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="m22 8-6 4 6 4V8Z" />
                <rect x={2} y={6} width={14} height={12} rx={2} />
              </svg>
              Video call
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: 40,
                padding: "0 16px",
                borderRadius: 99,
                background: "#ffffff",
                border: CARD_BORDER,
                fontSize: 12.5,
                color: "#3a3a3c",
              }}
            >
              14:20 · ☀︎ 23° Sunny
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                height: 40,
                width: 260,
                padding: "0 15px",
                borderRadius: 99,
                background: "#ffffff",
                border: CARD_BORDER,
                fontSize: 12.5,
                color: GREY,
              }}
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={GREY} strokeWidth={2} strokeLinecap="round">
                <circle cx={11} cy={11} r={7} />
                <path d="m21 21-4.3-4.3" />
              </svg>
              Type searching...
            </div>
            <span
              style={{
                width: 40,
                height: 40,
                borderRadius: 99,
                background: INK,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
            </span>
          </div>

          {/* content grid */}
          <div style={{ display: "flex", gap: 20, marginTop: 20, flex: 1, minHeight: 0 }}>
            {/* left: gantt + files */}
            <div style={{ flex: 1.55, display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
              {/* gantt card */}
              <div
                style={{
                  flex: 1.25,
                  background: "#ffffff",
                  border: CARD_BORDER,
                  borderRadius: 22,
                  padding: "18px 24px 14px",
                  display: "flex",
                  flexDirection: "column",
                  ...pop(9),
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
                  <span style={{ fontSize: 12.5, color: GREY, fontWeight: 600 }}>
                    ▸ JUNE 1, 2023
                  </span>
                  <div style={{ flex: 1 }} />
                  {["Day", "Week", "Month", "Year"].map((seg, i) => (
                    <span
                      key={seg}
                      style={{
                        padding: "6px 15px",
                        borderRadius: 99,
                        fontSize: 11.5,
                        fontWeight: 600,
                        background: i === 0 ? INK : "transparent",
                        color: i === 0 ? "#fff" : GREY,
                      }}
                    >
                      {seg}
                    </span>
                  ))}
                </div>

                <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                  {GANTT_ROWS.map((row, i) => {
                    const g = grow(14 + i * 4);
                    return (
                      <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 12, height: 44, ...pop(12 + i * 4) }}>
                        <span style={{ width: 132, fontSize: 12, color: "#3a3a3c", fontWeight: 550, flexShrink: 0 }}>
                          {row.label}
                        </span>
                        <div style={{ flex: 1, position: "relative", height: 38 }}>
                          <div
                            style={{
                              position: "absolute",
                              left: `${row.start * 100}%`,
                              top: 2,
                              width: `${row.width * g * 100}%`,
                              height: 34,
                              borderRadius: 99,
                              background: INK,
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              padding: "0 5px 0 13px",
                              overflow: "hidden",
                              boxShadow: "0 6px 16px rgba(0,0,0,0.18)",
                            }}
                          >
                            <span style={{ fontSize: 11, color: "#fff", fontWeight: 550, whiteSpace: "nowrap" }}>
                              {row.text}
                            </span>
                            <span style={{ flex: 1 }} />
                            <AvatarStack ids={row.avatars} size={24} />
                            {row.plus ? (
                              <span
                                style={{
                                  width: 24,
                                  height: 24,
                                  borderRadius: 99,
                                  background: "rgba(255,255,255,0.18)",
                                  color: "#fff",
                                  fontSize: 13,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  flexShrink: 0,
                                }}
                              >
                                +
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {/* time axis */}
                  <div style={{ display: "flex", paddingLeft: 144, marginTop: 6, ...pop(30) }}>
                    {["1 PM", "2 PM", "3 PM", "4 PM", "5 PM", "6 PM", "7 PM", "8 PM"].map((tick) => (
                      <span key={tick} style={{ flex: 1, fontSize: 10.5, color: "#b6b6ba" }}>
                        {tick}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {/* files card */}
              <div
                style={{
                  flex: 1,
                  background: "#ffffff",
                  border: CARD_BORDER,
                  borderRadius: 22,
                  padding: "16px 22px",
                  display: "flex",
                  flexDirection: "column",
                  ...pop(34),
                }}
              >
                <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                  <span
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 99,
                      background: INK,
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      marginRight: 10,
                    }}
                  >
                    <NavIcon kind="folder" color="#ffffff" />
                  </span>
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>All files</span>
                  <div style={{ flex: 1 }} />
                  <NavIcon kind="grid" color={GREY} />
                </div>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                  {FILE_ROWS.map((f, i) => (
                    <div
                      key={f.name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 11,
                        padding: "9px 14px",
                        borderRadius: 13,
                        border: CARD_BORDER,
                        background: "#fdfdfc",
                        fontSize: 12.5,
                        fontWeight: 550,
                        color: "#2c2c2e",
                        ...pop(38 + i * 3),
                      }}
                    >
                      <span
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 7,
                          background: f.tint,
                          opacity: 0.85,
                          flexShrink: 0,
                        }}
                      />
                      {f.name}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* right: ongoing projects + file preview */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 18, flex: 1.25, minHeight: 0 }}>
                {/* ongoing projects */}
                <div
                  style={{
                    flex: 1.15,
                    background: "#ffffff",
                    border: CARD_BORDER,
                    borderRadius: 22,
                    padding: "18px 22px",
                    display: "flex",
                    flexDirection: "column",
                    ...pop(18),
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600 }}>Ongoing projects</span>
                    <div style={{ flex: 1 }} />
                    <NavIcon kind="grid" color={GREY} />
                  </div>
                  <div style={{ marginTop: 14, fontSize: 12, color: GREY }}>Sales trend</div>
                  <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.03em", marginTop: 2 }}>
                    68,5%
                  </div>
                  <div style={{ fontSize: 11, color: "#b6b6ba" }}>Compared to last month</div>

                  <svg
                    viewBox="0 0 216 52"
                    style={{ width: "100%", height: 62, marginTop: 12 }}
                    fill="none"
                  >
                    <polyline
                      points={TREND_POINTS}
                      stroke={INK}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      pathLength={1}
                      strokeDasharray={1}
                      strokeDashoffset={1 - lineDraw}
                    />
                    <circle
                      cx={216 * lineDraw}
                      cy={interpolate(lineDraw, [0, 1], [46, 4])}
                      r={3.4}
                      fill={INK}
                      opacity={lineDraw > 0.05 ? 1 : 0}
                    />
                  </svg>

                  <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 7 }}>
                    {[
                      { name: "Finance", val: "48,900" },
                      { name: "Design Reviews", val: "15,200" },
                      { name: "Other", val: "90,00" },
                    ].map((row) => (
                      <div key={row.name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 }}>
                        <span style={{ width: 6, height: 6, borderRadius: 99, background: INK }} />
                        <span style={{ color: "#3a3a3c" }}>{row.name}</span>
                        <span style={{ marginLeft: "auto", color: GREY }}>% {row.val}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* file preview (dark) */}
                <div
                  style={{
                    flex: 1,
                    background: "#0f0f10",
                    borderRadius: 22,
                    padding: "16px 18px",
                    display: "flex",
                    flexDirection: "column",
                    color: "#fff",
                    position: "relative",
                    overflow: "hidden",
                    ...pop(22),
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 600 }}>
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                      <circle cx={12} cy={12} r={3} />
                    </svg>
                    File Preview
                  </div>
                  {/* glossy blob */}
                  <div style={{ flex: 1, position: "relative", margin: "10px 0" }}>
                    <div
                      style={{
                        position: "absolute",
                        left: "50%",
                        top: "50%",
                        width: 130,
                        height: 130,
                        transform: "translate(-50%, -50%)",
                        borderRadius: "50%",
                        background:
                          "radial-gradient(circle at 38% 32%, #f2f4f6 0%, #c3cad2 34%, #6d757e 62%, #23262b 100%)",
                        boxShadow: "0 20px 50px rgba(0,0,0,0.6), inset 0 -8px 22px rgba(0,0,0,0.4)",
                      }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        left: "50%",
                        top: "42%",
                        width: 44,
                        height: 30,
                        transform: "translate(-70%, -50%) rotate(-18deg)",
                        borderRadius: "50%",
                        background: "rgba(255,255,255,0.75)",
                        filter: "blur(7px)",
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 11.5, fontWeight: 600 }}>Virtual_and_Scope.mp4</div>
                  <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
                    2.5 GB · Preview
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                    <Avatar i={0} size={24} ring={false} />
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.75)" }}>Marta Adams</span>
                  </div>
                </div>
              </div>

              {/* team panel (dark) */}
              <div
                style={{
                  flex: 1,
                  background: "#0f0f10",
                  borderRadius: 22,
                  padding: "16px 22px",
                  color: "#fff",
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                  ...pop(28),
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 16, fontWeight: 650 }}>Team</span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "3px 8px",
                      borderRadius: 99,
                      background: "rgba(255,255,255,0.14)",
                    }}
                  >
                    +5
                  </span>
                  <div style={{ flex: 1 }} />
                  {[
                    { label: "Total Users", val: "1240", delta: "+124" },
                    { label: "Active Users", val: "562", delta: "+124" },
                    { label: "Dynamics", val: "25", delta: "" },
                  ].map((s) => (
                    <div key={s.label} style={{ display: "flex", alignItems: "baseline", gap: 6, marginLeft: 18 }}>
                      <span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.45)" }}>{s.label}</span>
                      <span style={{ fontSize: 17, fontWeight: 700 }}>{s.val}</span>
                      {s.delta ? (
                        <span style={{ fontSize: 10, color: "#7ee2a8" }}>{s.delta}</span>
                      ) : null}
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", gap: 14, marginTop: 14, flex: 1, minHeight: 0 }}>
                  {[
                    { name: "UX UI Design", sub: "Design and creative", pct: 20, avatars: [0, 1, 2] },
                    { name: "Marketing", sub: "Design and creative", pct: 79, avatars: [3, 4, 5] },
                  ].map((team, ti) => (
                    <div
                      key={team.name}
                      style={{
                        flex: 1,
                        borderRadius: 16,
                        background: "rgba(255,255,255,0.05)",
                        border: "1px solid rgba(255,255,255,0.07)",
                        padding: "13px 15px",
                        display: "flex",
                        flexDirection: "column",
                        ...pop(32 + ti * 4),
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 650 }}>{team.name}</div>
                      <div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.45)", marginTop: 2 }}>
                        {team.sub}
                      </div>
                      <div style={{ marginTop: 9 }}>
                        <AvatarStack ids={team.avatars} size={22} />
                      </div>
                      <div style={{ marginTop: "auto" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(255,255,255,0.5)", marginBottom: 5 }}>
                          <span>PROGRESS</span>
                          <span style={{ color: "#fff", fontWeight: 600 }}>{team.pct}%</span>
                        </div>
                        <div style={{ height: 5, borderRadius: 99, background: "rgba(255,255,255,0.12)", overflow: "hidden" }}>
                          <div
                            style={{
                              width: `${team.pct * grow(36 + ti * 4)}%`,
                              height: "100%",
                              borderRadius: 99,
                              background: "#ffffff",
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* development equalizer */}
                  <div
                    style={{
                      flex: 1,
                      borderRadius: 16,
                      background: "rgba(255,255,255,0.05)",
                      border: "1px solid rgba(255,255,255,0.07)",
                      padding: "13px 15px",
                      display: "flex",
                      flexDirection: "column",
                      ...pop(40),
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 650 }}>Development</div>
                    <div
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "flex-end",
                        gap: 4,
                        marginTop: 10,
                      }}
                    >
                      {[0.35, 0.6, 0.45, 0.8, 0.55, 0.95, 0.7, 0.5, 0.85, 0.4, 0.65, 0.9].map(
                        (h, i) => (
                          <div
                            key={i}
                            style={{
                              flex: 1,
                              height: `${h * 100 * grow(42 + i)}%`,
                              borderRadius: 3,
                              background: "#ffffff",
                              opacity: 0.9,
                            }}
                          />
                        )
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const CodeBlock: React.FC<{ progress: number }> = ({ progress }) => {
  const visible = Math.min(
    CODE_LINES.length,
    Math.floor(interpolate(progress, [0, 1], [0, CODE_LINES.length + 0.2]))
  );
  return (
    <div
      style={{
        marginTop: 10,
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(8,10,16,0.45)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        opacity: progress,
        transform: `translateY(${(1 - progress) * 10}px)`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          fontSize: 11,
          color: "rgba(255,255,255,0.55)",
        }}
      >
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#93c5fd" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
        ManagementDashboard.tsx
      </div>
      <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 5 }}>
        {CODE_LINES.map((line, i) => (
          <div
            key={line}
            style={{
              fontSize: 11,
              lineHeight: 1.4,
              color: i < visible ? "#dbeafe" : "rgba(255,255,255,0.18)",
            }}
          >
            <span style={{ color: "rgba(147,197,253,0.55)", marginRight: 8 }}>
              {String(i + 1).padStart(2, "0")}
            </span>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
};

/** The artifact card shown in the chat response once the build finishes —
    mirrors ChatArtifactCard: live preview thumbnail, title row, open hint. */
const ArtifactCard: React.FC<{
  landing: number;
  hover: number;
  thumb: React.ReactNode;
}> = ({ landing, hover, thumb }) => (
  <div
    style={{
      marginTop: 10,
      width: CARD_W,
      height: CARD_H,
      borderRadius: 12,
      overflow: "hidden",
      border: `1px solid rgba(255,255,255,${0.14 + hover * 0.28})`,
      background: "rgba(255,255,255,0.06)",
      boxShadow: hover > 0.01 ? `0 0 0 ${1.5 * hover}px rgba(96,165,250,0.55)` : "none",
      opacity: landing,
      transform: `translateY(${(1 - landing) * 14}px)`,
      display: "flex",
      flexDirection: "column",
    }}
  >
    {/* live preview thumbnail */}
    <div style={{ flex: 1, position: "relative", overflow: "hidden", background: "#e9e8e6" }}>
      {thumb}
    </div>
    {/* footer row */}
    <div
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 12px",
        borderTop: "1px solid rgba(255,255,255,0.10)",
        background: "rgba(10,12,18,0.55)",
      }}
    >
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x={3} y={3} width={18} height={18} rx={2} />
        <path d="M3 9h18M9 21V9" />
      </svg>
      <span style={{ fontSize: 12, fontWeight: 600, color: "#f4f6fb" }}>
        Management Dashboard
      </span>
      <span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.45)" }}>Interactive · React</span>
      <span style={{ flex: 1 }} />
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 10.5,
          fontWeight: 600,
          color: "#93c5fd",
        }}
      >
        Open
        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#93c5fd" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 3h6v6M10 14 21 3" />
        </svg>
      </span>
    </div>
  </div>
);

export const LyknBuildDashboard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const camOpts = {
    extrapolateLeft: "clamp" as const,
    extrapolateRight: "clamp" as const,
    easing: EASE,
  };

  // ── camera: full → bar → open thread → card → pull back as it opens ──
  const CAM_T = [
    T_ZBAR, T_ZBAR + 14, // glide onto the bar
    T_THREAD, T_THREAD + 12, // widen as the thread grows upward
    T_CARD, T_CARD + 12, // settle on the artifact card
    T_OPEN, T_OPEN + 20, // pull back for the fullscreen dashboard
  ];
  const camCy = interpolate(frame, CAM_T, [540, 800, 800, 590, 590, CARD_CLICK_Y, CARD_CLICK_Y, 540], camOpts);
  const camZ = interpolate(frame, CAM_T, [1, 1.5, 1.5, 1.12, 1.12, 1.32, 1.32, 1], camOpts);
  const camCx = 960;

  // ── bar entrance ──
  const barIn = spring({ frame: frame - T_BAR_IN, fps, config: { damping: 16, stiffness: 180 } });
  const barOpacity = Math.min(1, barIn * 1.5);
  const barY = (1 - barIn) * 24;

  // Build mode chip
  const showChip = frame >= T_CHIP;

  // ── typing ──
  const typedChars = Math.floor(
    interpolate(frame, [T_TYPE, T_SEND - 8], [0, QUESTION.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.linear,
    })
  );
  const askText = QUESTION.slice(0, typedChars);
  const showAskCursor = frame >= T_TYPE && frame < T_SEND && Math.floor(frame / 8) % 2 === 0;

  // ── thread phases ──
  const threadOpen = frame >= T_THREAD;
  const thinking = threadOpen && frame < T_CODE;
  const coding = frame >= T_CODE && frame < T_CARD;
  const built = frame >= T_CARD;

  const codeProg = spring({ frame: frame - T_CODE, fps, config: { damping: 18, stiffness: 90 } });
  const cardLanding = spring({ frame: frame - T_CARD, fps, config: { damping: 15, stiffness: 140 } });
  const cardHover = interpolate(frame, [T_CLICK - 8, T_CLICK - 1, T_CLICK + 6], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ── dashboard expansion: artifact card rect → preview panel rect ──
  const openP = spring({ frame: frame - T_OPEN, fps, config: { damping: 19, stiffness: 70 } });
  const dashRect = {
    left: interpolate(openP, [0, 1], [CARD_RECT.left, PANEL_LEFT]),
    top: interpolate(openP, [0, 1], [CARD_RECT.top, PANEL_TOP]),
    width: interpolate(openP, [0, 1], [CARD_RECT.width, PREVIEW_W]),
    height: interpolate(openP, [0, 1], [CARD_RECT.height, PREVIEW_H]),
    radius: interpolate(openP, [0, 1], [12, 22]),
  };
  const dashScale = dashRect.width / 1920;
  // bar fades away once the dashboard takes over (it "opened fullscreen")
  const barExit = interpolate(frame, [T_OPEN + 4, T_OPEN + 22], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ── cursor: to send, click, then to the artifact card, click, fade ──
  const pressAt = (at: number) =>
    interpolate(frame, [at, at + 3, at + 7], [0, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const curX = interpolate(
    frame,
    [T_TYPE, T_SEND - 4, T_CARD + 6, T_CLICK - 2],
    [1330, SEND_CX + 4, SEND_CX + 4, CARD_CLICK_X],
    camOpts
  );
  const curY = interpolate(
    frame,
    [T_TYPE, T_SEND - 4, T_CARD + 6, T_CLICK - 2],
    [1000, BTN_CY + 4, BTN_CY + 4, CARD_CLICK_Y],
    camOpts
  );
  const curPress = Math.max(pressAt(T_SEND), pressAt(T_CLICK));
  const curOp =
    interpolate(frame, [T_TYPE + 2, T_TYPE + 8], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) *
    interpolate(frame, [T_OPEN + 2, T_OPEN + 12], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  // click ripple on the card
  const ripple = (at: number, rx: number, ry: number) => {
    if (frame < at || frame > at + 16) return null;
    const p = (frame - at) / 16;
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
          pointerEvents: "none",
        }}
      />
    );
  };

  // mini dashboard inside the card thumbnail — pre-assembled by landing time
  const thumbScale = CARD_W / 1920;
  const cardThumb = (
    <div
      style={{
        position: "absolute",
        width: 1920,
        height: 1080,
        transform: `scale(${thumbScale})`,
        transformOrigin: "0 0",
      }}
    >
      <DashboardScene t={frame - T_CARD + 60} fps={fps} />
    </div>
  );

  // ── thread answer content ──
  const threadAnswer = (
    <>
      {formatOverlayResponse(
        built
          ? "Done — I coded a live management dashboard from this report."
          : "Building a management dashboard from this report…"
      )}
      {coding ? <CodeBlock progress={Math.min(1, codeProg)} /> : null}
      {built ? (
        <>
          {/* collapsed build row (the streaming code folded up, like the real UI) */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              marginTop: 8,
              padding: "7px 10px",
              borderRadius: 9,
              border: "1px solid rgba(255,255,255,0.10)",
              background: "rgba(8,10,16,0.4)",
              fontSize: 11,
              color: "rgba(255,255,255,0.6)",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >
            <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
            ManagementDashboard.tsx · 214 lines
          </div>
          <ArtifactCard landing={cardLanding} hover={cardHover} thumb={cardThumb} />
        </>
      ) : null}
    </>
  );

  return (
    <AbsoluteFill
      style={{
        background: OFFWHITE,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      }}
    >
      {/* camera rig */}
      <div
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          transformOrigin: "0 0",
          transform: `translate(960px, 540px) scale(${camZ}) translate(${-camCx}px, ${-camCy}px)`,
        }}
      >
        {/* floating preview panel with the report */}
        <div
          style={{
            position: "absolute",
            left: PANEL_LEFT,
            top: PANEL_TOP,
            width: PREVIEW_W,
            height: PREVIEW_H,
            borderRadius: 22,
            overflow: "hidden",
            boxShadow: "0 40px 100px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.07)",
            background: OFFWHITE,
          }}
        >
          <div
            style={{
              position: "absolute",
              width: 1920,
              height: 1080,
              transform: `scale(${K})`,
              transformOrigin: "0 0",
            }}
          >
            <ReportPage />
          </div>
        </div>

        {/* glass bar — bottom pinned so the thread grows upward */}
        {barExit > 0.001 && (
          <div
            style={{
              position: "absolute",
              left: "50%",
              bottom: 1080 - BAR_BOTTOM,
              opacity: barOpacity * barExit,
              transform: `translateX(-50%) translateY(${barY}px) scale(${SCALE})`,
              transformOrigin: "bottom center",
            }}
          >
            <div
              style={{
                position: "relative",
                borderRadius: 16,
                boxShadow: "0 24px 70px rgba(0,0,0,0.3), 0 0 0 0.5px rgba(255,255,255,0.2)",
              }}
            >
              <OverlayUI
                askText={threadOpen ? "" : askText}
                askPlaceholder="Ask LYKN about your screen…"
                showAskCursor={showAskCursor && !threadOpen}
                threadQuestion={threadOpen ? QUESTION : undefined}
                threadAnswer={threadAnswer}
                showThinking={thinking}
                thinkingLabel="Reading the report…"
                showSnip
                modeChip={showChip ? "Build mode" : undefined}
              />
            </div>
          </div>
        )}

        {/* the dashboard expanding out of the artifact card over the panel */}
        {frame >= T_OPEN && (
          <div
            style={{
              position: "absolute",
              left: dashRect.left,
              top: dashRect.top,
              width: dashRect.width,
              height: dashRect.height,
              borderRadius: dashRect.radius,
              overflow: "hidden",
              background: "#e9e8e6",
              boxShadow: "0 40px 100px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.07)",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 0,
                top: (dashRect.height - 1080 * dashScale) / 2,
                width: 1920,
                height: 1080,
                transform: `scale(${dashScale})`,
                transformOrigin: "0 0",
              }}
            >
              <DashboardScene t={frame - T_CARD + 60} fps={fps} />
            </div>
          </div>
        )}

        {/* click ripples */}
        {ripple(T_SEND, SEND_CX, BTN_CY)}
        {ripple(T_CLICK, CARD_CLICK_X, CARD_CLICK_Y)}

        {curOp > 0 && <MousePointer x={curX} y={curY} press={curPress} opacity={curOp} />}
      </div>
    </AbsoluteFill>
  );
};
