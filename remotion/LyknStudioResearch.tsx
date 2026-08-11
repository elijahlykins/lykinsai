import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { StudioGlassStage } from "./LyknStudioOpen";

// ---------------------------------------------------------------------------
// LYKN Studio Research — after Studio is up, click Chat → Research, pick
// Markets sources, type a Tesla research question, then stream a full market
// report with stock/chart/sheet embeds + the Research links rail.
// ---------------------------------------------------------------------------

export const STUDIO_RESEARCH_DURATION = 900; // 30s @ 30fps — slower zooms + clicks

const EASE_SOFT = Easing.bezier(0.4, 0.0, 0.2, 1);
const SANS = "Inter, system-ui, -apple-system, sans-serif";

const QUESTION =
  "Research Tesla stock: recent performance, valuation, and analyst outlook";

const MODES = [
  { id: "chat", label: "Chat", paths: ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"] },
  {
    id: "build",
    label: "Build",
    paths: [
      "m16 18 6-6-6-6",
      "m8 6-6 6 6 6",
    ],
  },
  {
    id: "imagine",
    label: "Imagine",
    paths: [
      "M16 5h6",
      "M19 2v6",
      "M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5",
      "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
      "M9 9h.01",
    ],
  },
  {
    id: "research",
    label: "Research",
    paths: [
      "m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44",
      "m13.331 15.472 6.395-1.361",
      "m16.215 9.265 2.39-5.8",
      "M12.5 15.5 16 8",
      "m2.5 12.5 6.5 2",
      "M19.5 5.5 22 12",
    ],
  },
] as const;

// Lucide paths matching RESEARCH_SOURCE_ICONS in LyknChat.tsx
// (Layers / Globe / GraduationCap / Newspaper / Users / TrendingUp).
const SOURCE_ICONS: Record<string, string[]> = {
  all: [
    "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z",
    "M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12",
    "M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17",
  ],
  web: [
    "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10Z",
    "M2 12h20",
    "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z",
  ],
  academic: [
    "M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0z",
    "M22 10v6",
    "M6 12.5V16a6 3 0 0 0 12 0v-3.5",
  ],
  news: [
    "M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2",
    "M18 14h-8",
    "M15 18h-5",
    "M10 6h8v4h-8V6Z",
  ],
  social: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    "M22 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75",
  ],
  finance: [
    "M16 7h6v6",
    "m22 7-8.5 8.5-5-5L2 17",
  ],
};

const SOURCE_OPTS = [
  { value: "all", label: "All sources", short: "All sources" },
  { value: "web", label: "Web", short: "Web" },
  { value: "academic", label: "Academic", short: "Academic" },
  { value: "news", label: "News", short: "News" },
  { value: "social", label: "Social", short: "Social" },
  { value: "finance", label: "Markets & finance", short: "Markets" },
] as const;

const CHIPS = [
  "Tesla stock performance",
  "AI chip market",
  "Sleep and memory",
  "Global EV trends",
  "CRISPR research",
];

const SOURCES = [
  { title: "Tesla, Inc. (TSLA) — Yahoo Finance", host: "finance.yahoo.com", url: "https://finance.yahoo.com/quote/TSLA" },
  { title: "Tesla Q2 2026 vehicle production & deliveries", host: "ir.tesla.com", url: "https://ir.tesla.com" },
  { title: "TSLA analyst ratings and price targets", host: "bloomberg.com", url: "https://www.bloomberg.com/quote/TSLA:US" },
  { title: "SEC Form 10-Q — Tesla Inc.", host: "sec.gov", url: "https://www.sec.gov" },
  { title: "EV market share — Tesla vs rivals", host: "reuters.com", url: "https://www.reuters.com" },
  { title: "Autopilot / FSD regulatory outlook", host: "ft.com", url: "https://www.ft.com" },
  { title: "Tesla valuation multiples vs peers", host: "wsj.com", url: "https://www.wsj.com" },
  { title: "Energy storage growth thesis", host: "cnbc.com", url: "https://www.cnbc.com" },
];

/** Same Google S2 favicon helper SiteFavicon uses in the app. */
function faviconSrc(hostOrUrl: string, size = 64) {
  const host = hostOrUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`;
}

const SourceIcon: React.FC<{
  value: string;
  size?: number;
  color?: string;
}> = ({ value, size = 14, color = "rgba(255,255,255,0.7)" }) => {
  const paths = SOURCE_ICONS[value] || SOURCE_ICONS.all;
  return (
    <Icon size={size} color={color} sw={2}>
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </Icon>
  );
};

const SiteFav: React.FC<{ host: string; url: string }> = ({ host, url }) => (
  <Img
    src={faviconSrc(url || host, 64)}
    style={{
      width: 14,
      height: 14,
      borderRadius: 3,
      marginTop: 2,
      flexShrink: 0,
      objectFit: "contain",
      background: "rgba(255,255,255,0.06)",
    }}
  />
);

const KPI_ROWS = [
  ["Last close", "$248.40"],
  ["Market cap", "$792B"],
  ["Forward P/E", "62.4×"],
  ["YTD return", "+18.2%"],
  ["Avg target", "$265"],
  ["Consensus", "Hold / Buy mix"],
];

const CHART_BARS = [
  { label: "Jan", v: 42 },
  { label: "Mar", v: 55 },
  { label: "May", v: 48 },
  { label: "Jul", v: 68 },
  { label: "Sep", v: 61 },
  { label: "Nov", v: 74 },
];

// ── timeline (slow: arrive → pause → click → react → hold) ──
const T = {
  // Cursor arrives at Chat dock, holds, clicks
  chatArrive: 12,
  chatHold: 36,
  chatClick: 48,
  chatIn: 54,
  // Settle on Chat, then glide to mode pills
  chatSettle: 78,
  pillArrive: 110,
  pillHold: 132,
  researchClick: 148,
  researchIn: 156,
  // Settle on Research empty state
  researchSettle: 188,
  // Glide to Sources, open menu, browse, pick Markets
  srcArrive: 230,
  srcHold: 252,
  srcOpen: 264,
  srcHl: 286,
  srcPick: 318,
  srcClose: 340,
  // Glide to chat bar, type slowly, click send
  barArrive: 372,
  barHold: 396,
  typeStart: 408,
  typeEnd: 530,
  sendArrive: 542,
  send: 556,
  think: 568,
  report: 620,
  stock: 670,
  chart: 720,
  sheet: 770,
  sidebar: 650,
  scroll: 800,
  settle: 880,
} as const;

// Camera framing anchors (no cursor).
const HIT = {
  chatDock: { x: 718, y: 1032 },
  researchPill: { x: 1118, y: 168 },
  sourcesBtn: { x: 1180, y: 640 },
  marketsRow: { x: 1180, y: 560 },
  input: { x: 960, y: 580 },
  send: { x: 1260, y: 640 },
} as const;

// Camera focus — gentler zooms so switches read clearly.
const FULL = { cx: 960, cy: 540, z: 1 };
const SHOT_DOCK_CHAT = { cx: HIT.chatDock.x, cy: HIT.chatDock.y - 20, z: 1.75 };
const SHOT_PILLS = { cx: 980, cy: 168, z: 1.85 };
const SHOT_SOURCES = { cx: 1120, cy: 600, z: 1.75 };
const SHOT_BAR = { cx: 960, cy: 560, z: 1.55 };
const SHOT_REPORT = { cx: 820, cy: 480, z: 1.22 };
const SHOT_SIDEBAR = { cx: 1500, cy: 520, z: 1.35 };
const SHOT_END = { cx: 960, cy: 500, z: 1.05 };

const Icon: React.FC<{
  size?: number;
  color?: string;
  sw?: number;
  children: React.ReactNode;
}> = ({ size = 14, color = "currentColor", sw = 2, children }) => (
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

function camAt(
  frame: number,
  keys: number[],
  cxs: number[],
  cys: number[],
  zs: number[]
) {
  const opts = {
    extrapolateLeft: "clamp" as const,
    extrapolateRight: "clamp" as const,
    easing: EASE_SOFT,
  };
  return {
    cx: interpolate(frame, keys, cxs, opts),
    cy: interpolate(frame, keys, cys, opts),
    z: interpolate(frame, keys, zs, opts),
  };
}

/** Hold-then-press pulse for send button. */
function clickPulse(frame: number, at: number, hold = 5, release = 8) {
  return interpolate(
    frame,
    [at, at + 2, at + hold, at + hold + release],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
}

function typedChars(frame: number, start: number, end: number, text: string) {
  const n = Math.floor(
    interpolate(frame, [start, end], [0, text.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  return text.slice(0, n);
}

function reportReveal(frame: number, start: number, dur = 36) {
  return interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_SOFT,
  });
}

/** Fake stock embed — Remotion-safe stand-in for TradingView. */
const StockEmbed: React.FC<{ enter: number }> = ({ enter }) => (
  <div
    style={{
      margin: "14px 0",
      borderRadius: 16,
      overflow: "hidden",
      border: "1px solid rgba(255,255,255,0.10)",
      background: "linear-gradient(145deg, #141413, #111110 50%, #0c0c0b)",
      boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
      opacity: enter,
      transform: `translateY(${(1 - enter) * 16}px)`,
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 14px",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: 99, background: "#6b8f74" }} />
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", color: "rgba(255,255,255,0.75)" }}>
          TSLA
        </span>
      </div>
      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>Live market</span>
    </div>
    <div style={{ padding: "16px 18px 20px", height: 220, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <span style={{ fontSize: 28, fontWeight: 600, color: "rgba(255,255,255,0.92)" }}>$248.40</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#6b8f74" }}>+4.82 (+1.98%)</span>
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
        NASDAQ · Aug 7, 2026
      </div>
      <svg width="100%" height={130} viewBox="0 0 560 130" style={{ marginTop: 12, display: "block" }}>
        <defs>
          <linearGradient id="tslaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(63,63,70,0.45)" />
            <stop offset="100%" stopColor="rgba(63,63,70,0.02)" />
          </linearGradient>
        </defs>
        <path
          d="M0 98 C40 92 70 70 110 74 C150 78 170 50 210 46 C250 42 280 58 320 40 C360 22 390 28 430 18 C470 8 510 22 560 12 L560 130 L0 130 Z"
          fill="url(#tslaFill)"
        />
        <path
          d="M0 98 C40 92 70 70 110 74 C150 78 170 50 210 46 C250 42 280 58 320 40 C360 22 390 28 430 18 C470 8 510 22 560 12"
          fill="none"
          stroke="#3f3f46"
          strokeWidth={2.5}
        />
      </svg>
    </div>
  </div>
);

const ChartEmbed: React.FC<{ enter: number }> = ({ enter }) => {
  const max = Math.max(...CHART_BARS.map((b) => b.v));
  return (
    <div
      style={{
        margin: "14px 0",
        borderRadius: 16,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.10)",
        background: "linear-gradient(145deg, #141413, #111110 50%, #0c0c0b)",
        opacity: enter,
        transform: `translateY(${(1 - enter) * 16}px)`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 14px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: "#6b8f74" }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.75)" }}>
            Quarterly deliveries (×10k)
          </span>
        </div>
        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>From evidence</span>
      </div>
      <div
        style={{
          height: 200,
          padding: "18px 20px 14px",
          display: "flex",
          alignItems: "flex-end",
          gap: 14,
          boxSizing: "border-box",
        }}
      >
        {CHART_BARS.map((b) => (
          <div
            key={b.label}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              height: "100%",
              justifyContent: "flex-end",
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: 36,
                borderRadius: "8px 8px 4px 4px",
                height: `${(b.v / max) * 100}%`,
                background: "linear-gradient(180deg, #6b8f74, #3d5a45)",
                opacity: 0.55 + enter * 0.45,
              }}
            />
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.45)" }}>{b.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const SheetEmbed: React.FC<{ enter: number }> = ({ enter }) => (
  <div
    style={{
      margin: "14px 0",
      borderRadius: 16,
      overflow: "hidden",
      border: "1px solid rgba(255,255,255,0.10)",
      background: "linear-gradient(145deg, #141413, #111110 50%, #0c0c0b)",
      opacity: enter,
      transform: `translateY(${(1 - enter) * 16}px)`,
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 14px",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: 99, background: "#6b8f74" }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.75)" }}>
          TSLA snapshot
        </span>
      </div>
      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>Mini sheet</span>
    </div>
    <div style={{ padding: "4px 0" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          padding: "8px 16px",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.4)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <span>Metric</span>
        <span>Value</span>
      </div>
      {KPI_ROWS.map(([k, v]) => (
        <div
          key={k}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            padding: "9px 16px",
            fontSize: 13,
            borderBottom: "1px solid rgba(255,255,255,0.04)",
          }}
        >
          <span style={{ color: "rgba(255,255,255,0.7)" }}>{k}</span>
          <span style={{ color: "#8fbc9a", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
            {v}
          </span>
        </div>
      ))}
    </div>
  </div>
);

const ModePill: React.FC<{ active: string }> = ({ active }) => (
  <div
    style={{
      position: "absolute",
      top: 12,
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: 20,
      display: "flex",
      alignItems: "center",
      gap: 2,
      borderRadius: 99,
      border: "1px solid rgba(255,255,255,0.15)",
      background: "rgba(0,0,0,0.35)",
      backdropFilter: "blur(40px)",
      WebkitBackdropFilter: "blur(40px)",
      boxShadow: "0 10px 30px rgba(0,0,0,0.28)",
      padding: 4,
    }}
  >
    {MODES.map((m) => {
      const on = m.id === active;
      return (
        <div
          key={m.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            borderRadius: 99,
            padding: "6px 14px",
            fontSize: 11.5,
            fontWeight: 500,
            background: on ? "#ffffff" : "transparent",
            color: on ? "#000000" : "rgba(255,255,255,0.65)",
            boxShadow: on ? "0 4px 12px rgba(0,0,0,0.2)" : undefined,
          }}
        >
          <Icon size={13} color={on ? "#000" : "rgba(255,255,255,0.65)"}>
            {m.paths.map((d) => (
              <path key={d} d={d} />
            ))}
          </Icon>
          {m.label}
        </div>
      );
    })}
  </div>
);

const ResearchSidebar: React.FC<{
  count: number;
  enter: number;
}> = ({ count, enter }) => {
  const shown = SOURCES.slice(0, Math.max(0, Math.min(SOURCES.length, count)));
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 300,
        borderLeft: "1px solid rgba(255,255,255,0.15)",
        display: "flex",
        flexDirection: "column",
        background: "transparent",
        transform: `translateX(${(1 - enter) * 100}%)`,
        opacity: enter,
        zIndex: 15,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "56px 16px 10px",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.6)",
          }}
        >
          Research links
        </span>
        {shown.length > 0 ? (
          <span
            style={{
              borderRadius: 99,
              border: "1px solid rgba(255,255,255,0.10)",
              background: "rgba(255,255,255,0.07)",
              padding: "2px 8px",
              fontSize: 10,
              fontWeight: 500,
              color: "rgba(255,255,255,0.7)",
            }}
          >
            {shown.length}
          </span>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "0 8px" }}>
        {shown.map((s) => (
          <div
            key={s.url}
            style={{
              display: "flex",
              gap: 10,
              padding: "8px 10px",
              borderRadius: 12,
              alignItems: "flex-start",
            }}
          >
            <SiteFav host={s.host} url={s.url} />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  color: "rgba(255,255,255,0.85)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {s.title}
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{s.host}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: 12 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            borderRadius: 99,
            background: "#ffffff",
            color: "#000000",
            padding: "8px 0",
            fontSize: 12,
            fontWeight: 600,
            boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
          }}
        >
          <Icon size={13} color="#000">
            <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
            <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
            <path d="M7 3v4a1 1 0 0 0 1 1h8" />
          </Icon>
          Save report
        </div>
      </div>
    </div>
  );
};

/** Chat / Research surface inside the frost panel. */
const ResearchSurface: React.FC<{
  frame: number;
  mode: "chat" | "research";
  sourcePref: "all" | "finance";
  sourcesOpen: boolean;
  sourceHighlight: number;
  typed: string;
  sent: boolean;
  thinking: boolean;
  reportProgress: number;
  scrollY: number;
  sidebarEnter: number;
  sourceCount: number;
  sendPress: number;
}> = ({
  frame,
  mode,
  sourcePref,
  sourcesOpen,
  sourceHighlight,
  typed,
  sent,
  thinking,
  reportProgress,
  scrollY,
  sidebarEnter,
  sourceCount,
  sendPress,
}) => {
  const empty = !sent && !thinking && reportProgress <= 0;
  const shortLabel =
    SOURCE_OPTS.find((o) => o.value === sourcePref)?.short || "All sources";
  const stockIn = reportReveal(frame, T.stock, 20);
  const chartIn = reportReveal(frame, T.chart, 20);
  const sheetIn = reportReveal(frame, T.sheet, 20);
  const summaryIn = reportReveal(frame, T.report, 22);
  const findingsIn = reportReveal(frame, T.report + 28, 24);
  const caveatsIn = reportReveal(frame, T.sheet + 30, 22);

  const placeholder =
    mode === "research" ? "What should LYKN research?" : "Ask me anything...";

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        fontFamily: SANS,
        color: "rgba(255,255,255,0.9)",
        overflow: "hidden",
      }}
    >
      <ModePill active={mode} />

      {sidebarEnter > 0.01 ? (
        <ResearchSidebar count={sourceCount} enter={sidebarEnter} />
      ) : null}

      {/* Main chat column */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          right: sidebarEnter > 0.01 ? 300 : 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: empty ? "64px 24px 48px" : "56px 24px 28px",
          boxSizing: "border-box",
        }}
      >
        {empty ? (
          /* Empty: headline + chips + bar as one centered cluster (not bottom-pinned). */
          <div
            style={{
              flex: 1,
              width: "100%",
              maxWidth: 680,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 18,
              marginTop: -36,
            }}
          >
            {mode === "research" ? (
              <div style={{ textAlign: "center", maxWidth: 440 }}>
                <h2
                  style={{
                    margin: 0,
                    fontSize: 28,
                    fontWeight: 600,
                    letterSpacing: "-0.02em",
                    color: "rgba(255,255,255,0.95)",
                  }}
                >
                  What should LYKN research?
                </h2>
                <p
                  style={{
                    margin: "10px 0 0",
                    fontSize: 13.5,
                    lineHeight: 1.45,
                    color: "rgba(255,255,255,0.45)",
                  }}
                >
                  Give a topic or question and LYKN digs into current sources, then writes a
                  structured research report.
                </p>
              </div>
            ) : (
              <h2
                style={{
                  margin: 0,
                  fontSize: 28,
                  fontWeight: 600,
                  letterSpacing: "-0.02em",
                  color: "rgba(255,255,255,0.9)",
                }}
              >
                How can I help?
              </h2>
            )}

            {mode === "research" ? (
              <div
                style={{
                  width: "100%",
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                {CHIPS.map((c) => (
                  <div
                    key={c}
                    style={{
                      borderRadius: 99,
                      border: "1px solid rgba(255,255,255,0.10)",
                      background: "rgba(255,255,255,0.05)",
                      padding: "5px 11px",
                      fontSize: 11,
                      color: "rgba(255,255,255,0.7)",
                    }}
                  >
                    {c}
                  </div>
                ))}
              </div>
            ) : null}

            <ComposerBlock
              frame={frame}
              mode={mode}
              typed={typed}
              sent={sent}
              placeholder={placeholder}
              shortLabel={shortLabel}
              sourcesOpen={sourcesOpen}
              sourceHighlight={sourceHighlight}
              sourcePref={sourcePref}
              sendPress={sendPress}
            />
          </div>
        ) : (
          <>
            <div
              style={{
                flex: 1,
                width: "100%",
                maxWidth: 680,
                minHeight: 0,
                overflow: "hidden",
                position: "relative",
              }}
            >
              <div
                style={{
                  transform: `translateY(${-scrollY}px)`,
                  paddingBottom: 24,
                }}
              >
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 18 }}>
                  <div
                    style={{
                      maxWidth: "85%",
                      borderRadius: 18,
                      padding: "12px 16px",
                      background: "rgba(255,255,255,0.92)",
                      color: "#0b0b0d",
                      fontSize: 14,
                      lineHeight: 1.45,
                      boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
                    }}
                  >
                    {QUESTION}
                  </div>
                </div>

                {thinking && reportProgress <= 0 ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 4px",
                      color: "rgba(255,255,255,0.55)",
                      fontSize: 13,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 99,
                        background: "#60a5fa",
                        boxShadow: "0 0 12px rgba(96,165,250,0.6)",
                      }}
                    />
                    Researching markets & finance sources…
                  </div>
                ) : null}

                {reportProgress > 0 ? (
                  <div style={{ fontSize: 14.5, lineHeight: 1.55, color: "rgba(255,255,255,0.88)" }}>
                    <div style={{ opacity: summaryIn }}>
                      <p style={{ margin: "0 0 14px", color: "rgba(255,255,255,0.8)" }}>
                        Tesla (TSLA) has reclaimed momentum into H2 2026: deliveries are trending
                        higher, energy storage is becoming a meaningful second engine, and the
                        Street remains split between a growth premium and execution risk on
                        autonomy. Near-term valuation looks rich vs auto peers but less extreme vs
                        high-growth software comps.
                      </p>
                    </div>

                    <div style={{ opacity: findingsIn }}>
                      <h3
                        style={{
                          margin: "18px 0 8px",
                          fontSize: 17,
                          fontWeight: 600,
                          letterSpacing: "-0.01em",
                        }}
                      >
                        Recent performance
                      </h3>
                      <ul style={{ margin: 0, paddingLeft: 18, color: "rgba(255,255,255,0.75)" }}>
                        <li style={{ marginBottom: 6 }}>
                          YTD total return ≈ <strong style={{ color: "#8fbc9a" }}>+18%</strong>,
                          outpacing the S&P 500 autos basket.
                        </li>
                        <li style={{ marginBottom: 6 }}>
                          Last two reported quarters showed sequential delivery growth with
                          improving China mix.
                        </li>
                        <li>Volatility remains elevated around FSD / robotaxi narrative beats.</li>
                      </ul>
                    </div>

                    <StockEmbed enter={stockIn} />

                    <div style={{ opacity: Math.min(1, chartIn + 0.2) }}>
                      <h3
                        style={{
                          margin: "8px 0",
                          fontSize: 17,
                          fontWeight: 600,
                          letterSpacing: "-0.01em",
                        }}
                      >
                        Valuation snapshot
                      </h3>
                      <p style={{ margin: "0 0 8px", color: "rgba(255,255,255,0.75)" }}>
                        Forward earnings multiples compress if Cybercab timelines slip; energy
                        gross margin expansion is the cleanest fundamental support for the
                        premium today.
                      </p>
                    </div>

                    <ChartEmbed enter={chartIn} />
                    <SheetEmbed enter={sheetIn} />

                    <div style={{ opacity: caveatsIn }}>
                      <h3
                        style={{
                          margin: "8px 0",
                          fontSize: 17,
                          fontWeight: 600,
                          letterSpacing: "-0.01em",
                        }}
                      >
                        Analyst outlook & caveats
                      </h3>
                      <ul style={{ margin: 0, paddingLeft: 18, color: "rgba(255,255,255,0.75)" }}>
                        <li style={{ marginBottom: 6 }}>
                          Consensus clusters around a Hold/Buy mix with a ~$265 average target.
                        </li>
                        <li style={{ marginBottom: 6 }}>
                          Bulls emphasize energy + autonomy optionality; bears flag competition
                          and margin compression.
                        </li>
                        <li>
                          Sources disagree most on when unsupervised FSD becomes material to
                          earnings.
                        </li>
                      </ul>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div style={{ width: "100%", maxWidth: 680, flexShrink: 0, marginTop: 12 }}>
              <ComposerBlock
                frame={frame}
                mode={mode}
                typed={typed}
                sent={sent}
                placeholder={placeholder}
                shortLabel={shortLabel}
                sourcesOpen={sourcesOpen}
                sourceHighlight={sourceHighlight}
                sourcePref={sourcePref}
                sendPress={sendPress}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const ComposerBlock: React.FC<{
  frame: number;
  mode: "chat" | "research";
  typed: string;
  sent: boolean;
  placeholder: string;
  shortLabel: string;
  sourcesOpen: boolean;
  sourceHighlight: number;
  sourcePref: "all" | "finance";
  sendPress: number;
}> = ({
  frame,
  mode,
  typed,
  sent,
  placeholder,
  shortLabel,
  sourcesOpen,
  sourceHighlight,
  sourcePref,
  sendPress,
}) => (
  <div style={{ width: "100%", maxWidth: 680, position: "relative", flexShrink: 0 }}>
    <div
      style={{
        borderRadius: 16,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(16,18,24,0.55)",
        backdropFilter: "blur(28px)",
        WebkitBackdropFilter: "blur(28px)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
        padding: "12px 14px 10px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          minHeight: 52,
          fontSize: 15,
          lineHeight: 1.45,
          color: typed ? "rgba(244,246,251,0.95)" : "rgba(255,255,255,0.45)",
          whiteSpace: "pre-wrap",
        }}
      >
        {typed || (sent ? "" : placeholder)}
        {!sent && typed ? (
          <span
            style={{
              display: "inline-block",
              width: 2,
              height: 16,
              marginLeft: 1,
              background: "rgba(255,255,255,0.75)",
              verticalAlign: "text-bottom",
              opacity: Math.floor(frame / 8) % 2 === 0 ? 1 : 0.2,
            }}
          />
        ) : null}
      </div>

      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          style={{
            borderRadius: 99,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.06)",
            padding: "5px 10px",
            fontSize: 11.5,
            color: "rgba(255,255,255,0.7)",
          }}
        >
          LYKN
        </div>
        <div style={{ flex: 1 }} />

        {mode === "research" ? (
          <div style={{ position: "relative" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                borderRadius: 99,
                border: "1px solid rgba(255,255,255,0.12)",
                background: sourcesOpen
                  ? "rgba(255,255,255,0.12)"
                  : "rgba(255,255,255,0.06)",
                padding: "5px 10px",
                fontSize: 11.5,
                color: "rgba(255,255,255,0.8)",
                maxWidth: 148,
              }}
            >
              <SourceIcon
                value={sourcePref}
                size={13}
                color="rgba(255,255,255,0.7)"
              />
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {shortLabel}
              </span>
            </div>

            {sourcesOpen ? (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  bottom: 40,
                  width: 220,
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(18,20,26,0.92)",
                  backdropFilter: "blur(28px)",
                  WebkitBackdropFilter: "blur(28px)",
                  boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
                  padding: 6,
                  zIndex: 30,
                }}
              >
                {SOURCE_OPTS.map((o, i) => {
                  const hl = i === sourceHighlight;
                  const picked = frame >= T.srcPick && o.value === "finance";
                  return (
                    <div
                      key={o.value}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        borderRadius: 10,
                        padding: "8px 10px",
                        fontSize: 12.5,
                        background: hl
                          ? "rgba(255,255,255,0.12)"
                          : picked
                            ? "rgba(96,165,250,0.12)"
                            : "transparent",
                        color: picked ? "#fff" : "rgba(255,255,255,0.8)",
                        fontWeight: picked ? 600 : 400,
                      }}
                    >
                      <SourceIcon
                        value={o.value}
                        size={14}
                        color={
                          picked
                            ? "rgba(255,255,255,0.9)"
                            : "rgba(255,255,255,0.65)"
                        }
                      />
                      {o.label}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            display: "grid",
            placeItems: "center",
            color: "rgba(255,255,255,0.55)",
          }}
        >
          <Icon size={15}>
            <path d="M5 12h14" />
            <path d="M12 5v14" />
          </Icon>
        </div>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            display: "grid",
            placeItems: "center",
            color: "rgba(255,255,255,0.55)",
          }}
        >
          <Icon size={15}>
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1={12} x2={12} y1={19} y2={22} />
          </Icon>
        </div>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            display: "grid",
            placeItems: "center",
            background: "rgba(255,255,255,0.92)",
            color: "#0b0b0d",
            transform: `scale(${1 - sendPress * 0.12})`,
            boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
          }}
        >
          <Icon size={16} color="#0b0b0d" sw={2.4}>
            <path d="m5 12 7-7 7 7" />
            <path d="M12 19V5" />
          </Icon>
        </div>
      </div>
    </div>
  </div>
);

export const LyknStudioResearch: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const onChat = frame >= T.chatIn;
  const mode: "chat" | "research" = frame >= T.researchIn ? "research" : "chat";
  const sourcesOpen = frame >= T.srcOpen && frame < T.srcClose;
  // Slow browse through the sources menu before landing on Markets.
  const sourceHighlight =
    frame < T.srcHl
      ? 0
      : frame < T.srcHl + 10
        ? 1
        : frame < T.srcHl + 18
          ? 2
          : frame < T.srcHl + 26
            ? 3
            : frame < T.srcPick - 6
              ? 4
              : 5;
  const sourcePref: "all" | "finance" = frame >= T.srcPick ? "finance" : "all";

  const typed =
    frame < T.send
      ? typedChars(frame, T.typeStart, T.typeEnd, QUESTION)
      : "";
  const sent = frame >= T.send;
  const thinking = frame >= T.think && frame < T.report + 10;
  const reportProgress = frame >= T.report ? 1 : 0;

  const sidebarEnter = spring({
    frame: frame - T.sidebar,
    fps,
    config: { damping: 20, stiffness: 70, mass: 1.05 },
  });
  const sourceCount = Math.floor(
    interpolate(frame, [T.sidebar + 12, T.sidebar + 120], [0, SOURCES.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const scrollY = interpolate(
    frame,
    [T.scroll, T.scroll + 70, T.settle],
    [0, 260, 200],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_SOFT }
  );
  const sendPress = clickPulse(frame, T.send, 6, 10);

  // Camera: long glides with holds on each beat.
  const CAM_T = [
    0,
    T.chatArrive,
    T.chatHold,
    T.chatClick,
    T.chatIn + 10,
    T.chatSettle,
    T.pillArrive,
    T.pillHold,
    T.researchClick,
    T.researchIn + 14,
    T.researchSettle,
    T.srcArrive,
    T.srcHold,
    T.srcOpen,
    T.srcPick,
    T.srcClose + 8,
    T.barArrive,
    T.barHold,
    T.typeStart,
    T.sendArrive,
    T.send + 8,
    T.report,
    T.sidebar + 50,
    T.scroll,
    T.settle,
  ];
  const cam = camAt(
    frame,
    CAM_T,
    [
      FULL.cx,
      SHOT_DOCK_CHAT.cx,
      SHOT_DOCK_CHAT.cx,
      SHOT_DOCK_CHAT.cx,
      FULL.cx,
      FULL.cx,
      SHOT_PILLS.cx,
      SHOT_PILLS.cx,
      SHOT_PILLS.cx,
      FULL.cx,
      FULL.cx,
      SHOT_SOURCES.cx,
      SHOT_SOURCES.cx,
      SHOT_SOURCES.cx,
      SHOT_SOURCES.cx,
      FULL.cx,
      SHOT_BAR.cx,
      SHOT_BAR.cx,
      SHOT_BAR.cx,
      SHOT_BAR.cx,
      SHOT_BAR.cx,
      SHOT_REPORT.cx,
      SHOT_SIDEBAR.cx,
      SHOT_REPORT.cx,
      SHOT_END.cx,
    ],
    [
      FULL.cy,
      SHOT_DOCK_CHAT.cy,
      SHOT_DOCK_CHAT.cy,
      SHOT_DOCK_CHAT.cy,
      FULL.cy,
      FULL.cy,
      SHOT_PILLS.cy,
      SHOT_PILLS.cy,
      SHOT_PILLS.cy,
      FULL.cy,
      FULL.cy,
      SHOT_SOURCES.cy,
      SHOT_SOURCES.cy,
      SHOT_SOURCES.cy,
      SHOT_SOURCES.cy,
      FULL.cy,
      SHOT_BAR.cy,
      SHOT_BAR.cy,
      SHOT_BAR.cy,
      SHOT_BAR.cy,
      SHOT_BAR.cy,
      SHOT_REPORT.cy,
      SHOT_SIDEBAR.cy,
      SHOT_REPORT.cy,
      SHOT_END.cy,
    ],
    [
      FULL.z,
      SHOT_DOCK_CHAT.z,
      SHOT_DOCK_CHAT.z,
      SHOT_DOCK_CHAT.z,
      1.04,
      1.04,
      SHOT_PILLS.z,
      SHOT_PILLS.z,
      SHOT_PILLS.z,
      1.06,
      1.06,
      SHOT_SOURCES.z,
      SHOT_SOURCES.z,
      SHOT_SOURCES.z,
      SHOT_SOURCES.z,
      1.08,
      SHOT_BAR.z,
      SHOT_BAR.z,
      SHOT_BAR.z,
      SHOT_BAR.z * 1.05,
      1.45,
      SHOT_REPORT.z,
      SHOT_SIDEBAR.z,
      SHOT_REPORT.z,
      SHOT_END.z,
    ]
  );

  return (
    <AbsoluteFill style={{ background: "#0a0c12", overflow: "hidden", fontFamily: SANS }}>
      <div
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          transformOrigin: "0 0",
          transform: `translate(960px, 540px) scale(${cam.z}) translate(${-cam.cx}px, ${-cam.cy}px)`,
        }}
      >
        <StudioGlassStage
          pullProgress={1}
          fullscreen
          showMenuBar={false}
          activeTab={onChat ? "chat" : "home"}
          main={
            onChat ? (
              <ResearchSurface
                frame={frame}
                mode={mode}
                sourcePref={sourcePref}
                sourcesOpen={sourcesOpen}
                sourceHighlight={sourceHighlight}
                typed={typed}
                sent={sent}
                thinking={thinking}
                reportProgress={reportProgress}
                scrollY={scrollY}
                sidebarEnter={sidebarEnter}
                sourceCount={sourceCount}
                sendPress={sendPress}
              />
            ) : undefined
          }
        />
      </div>
    </AbsoluteFill>
  );
};
