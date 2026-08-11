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

// ---------------------------------------------------------------------------
// LYKN Studio Open — starting animation / reusable demo background.
//
// A desktop wallpaper holds as the glass vibrancy backdrop. The real LYKN
// Studio shell springs up into fullscreen Glass mode — edge-to-edge chrome
// (notch padding, traffic lights, max-w-full Home dashboard) matching
// /studio?glass=1 in fullscreen.
//
// Use as a Sequence intro, or drop <StudioGlassHome /> / <StudioGlassStage />
// into other compositions when you need the Studio home already on screen.
// ---------------------------------------------------------------------------

export const STUDIO_OPEN_DURATION = 120; // 4s @ 30fps — pull-up + settle hold

const EASE_OUT = Easing.out(Easing.cubic);

const SERIF =
  'Georgia, "Iowan Old Style", "Times New Roman", "Playfair Display", serif';
const SANS = "Inter, system-ui, -apple-system, sans-serif";

// Glass chrome tokens (Studio.jsx BAR / FROST_PANEL / CARD, dark).
const BAR: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(0,0,0,0.40)",
  backdropFilter: "blur(40px) saturate(1.4)",
  WebkitBackdropFilter: "blur(40px) saturate(1.4)",
  boxShadow: "0 10px 30px rgba(0,0,0,0.28)",
  color: "rgba(255,255,255,0.85)",
};
const FROST: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(0,0,0,0.40)",
  boxShadow: "0 24px 80px rgba(0,0,0,0.28)",
};
const CARD: React.CSSProperties = {
  borderRadius: 22,
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(255,255,255,0.08)",
  backdropFilter: "blur(24px)",
  WebkitBackdropFilter: "blur(24px)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
  color: "rgba(255,255,255,0.92)",
  boxSizing: "border-box",
};

const CONTENT_W = 1240;
const FIRST_NAME = "Sawyer";

const EVENTS = [
  { title: "Design review — Glass shell", day: "Today", time: "2:00 PM", color: "#3b82f6" },
  { title: "Ship Studio home demo", day: "Today", time: "4:30 PM", color: "#8b5cf6" },
  { title: "Team standup", day: "Tomorrow", time: "9:00 AM", color: "#14b8a6" },
  { title: "Vault sync check-in", day: "Thu", time: "11:30 AM", color: "#f59e0b" },
  { title: "Brand system polish", day: "Fri", time: "3:00 PM", color: "#60a5fa" },
];

const TODOS = [
  { title: "Polish glass surfaces + light theme", due: "Today" },
  { title: "Wire Home widgets to live data", due: "Today" },
  { title: "Record Studio open for remotion", due: "Aug 8" },
  { title: "Tighten rail focus transitions", due: null },
  { title: "Review ⌘L overlay latency", due: "Aug 9" },
];

const PROJECTS = [
  { name: "Q3 Product Launch", meta: "2h ago", initial: "Q" },
  { name: "LYKN Glass Overlay", meta: "Yesterday", initial: "L" },
  { name: "Brand System", meta: "Shared · 3d ago", initial: "B" },
  { name: "Vault Collage", meta: "5d ago", initial: "V" },
];

const ACTIVITY = [2, 5, 3, 7, 4, 6, 8];
const ACTIVITY_DAYS = ["M", "T", "W", "T", "F", "S", "S"];

const UPDATES = [
  { title: "Introducing LYKN Studio", tag: "LYKN Studio", date: "Jul 16, 2026" },
  { title: "Building LYKN Glass: AI on every screen", tag: "LYKN Glass", date: "Jul 8, 2026" },
  { title: "Your AI project manager, explained", tag: "Projects", date: "Jun 30, 2026" },
];

const NAV = [
  { id: "home", label: "Home", paths: ["M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V9.5Z"] },
  {
    id: "chat",
    label: "Chat",
    paths: ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"],
  },
  {
    id: "browser",
    label: "Browser",
    paths: [
      "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10Z",
      "M2 12h20",
      "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z",
    ],
  },
  {
    id: "projects",
    label: "Projects",
    paths: [
      "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z",
    ],
  },
  {
    id: "vault",
    label: "Vault",
    paths: [
      "M7 11V7a5 5 0 0 1 10 0v4",
      "M5 11h14v10H5V11Z",
    ],
  },
  {
    id: "calendar",
    label: "Calendar / To-do",
    paths: [
      "M8 2v4",
      "M16 2v4",
      "M3 10h18",
      "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
    ],
  },
  {
    id: "settings",
    label: "Settings",
    paths: [
      "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z",
      "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    ],
  },
];

const Icon: React.FC<{
  size?: number;
  color?: string;
  sw?: number;
  children: React.ReactNode;
}> = ({ size = 16, color = "rgba(255,255,255,0.65)", sw = 2, children }) => (
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

const PathIcon: React.FC<{
  paths: string[];
  size?: number;
  color?: string;
  sw?: number;
}> = ({ paths, size = 17, color, sw = 2 }) => (
  <Icon size={size} color={color} sw={sw}>
    {paths.map((d) => (
      <path key={d} d={d} />
    ))}
  </Icon>
);

const LyknMark: React.FC<{ size?: number }> = ({ size = 32 }) => (
  <svg width={size} height={size} viewBox="0 0 204.29 204.29" style={{ flexShrink: 0 }}>
    <path
      d="M167.39,60.26l-.86-.39c-9.83-4.41-17.7-12.28-22.12-22.12l-.39-.86c-1.77-3.94-7.36-3.94-9.13,0l-.39.86c-4.41,9.83-12.28,17.71-22.12,22.12l-.86.39c-3.94,1.77-3.94,7.36,0,9.13l.86.39c9.83,4.41,17.7,12.28,22.12,22.12l.39.86c1.77,3.94,7.36,3.94,9.13,0l.39-.86c4.41-9.83,12.28-17.7,22.12-22.12l.86-.39c3.94-1.77,3.94-7.36,0-9.13ZM134.87,116.05c-14.73,2.8-17.97,18.72-32.73,18.72-8.11,0-12.75-4.81-17.72-9.61-1.8-1.73-3.56-3.5-5.29-5.29-4.8-4.98-9.62-9.61-9.62-17.73,0-14.76,15.93-18,18.72-32.73,2.66-14.03-7.74-27.55-21.99-28.38-13.8-.8-25.24,10.16-25.24,23.79,0,18.8,19.14,21.14,19.14,37.32s-19.14,18.52-19.14,37.32c0,13.16,10.67,23.83,23.83,23.83,18.8,0,21.14-19.14,37.32-19.14s18.52,19.14,37.32,19.14c13.63,0,24.58-11.44,23.78-25.24-.82-14.25-14.35-24.66-28.38-21.99Z"
      fill="#f2f2f2"
    />
  </svg>
);

function WidgetHeader({
  title,
  right,
  iconPaths,
}: {
  title: string;
  right?: React.ReactNode;
  iconPaths: string[];
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <PathIcon paths={iconPaths} size={14} color="rgba(255,255,255,0.45)" />
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.6)",
          }}
        >
          {title}
        </span>
      </div>
      {right}
    </div>
  );
}

function CircleNav({
  active,
  paths,
}: {
  active?: boolean;
  paths: string[];
}) {
  return (
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: 99,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        background: active ? "#ffffff" : "transparent",
        color: active ? "#000000" : "rgba(255,255,255,0.65)",
        boxShadow: active ? "0 8px 20px rgba(0,0,0,0.35)" : undefined,
      }}
    >
      <PathIcon
        paths={paths}
        size={17}
        color={active ? "#000000" : "rgba(255,255,255,0.65)"}
      />
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        height: 24,
        minWidth: 24,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 6,
        border: "1px solid rgba(255,255,255,0.15)",
        background: "rgba(255,255,255,0.10)",
        padding: "0 6px",
        fontSize: 11,
        fontWeight: 500,
        color: "rgba(255,255,255,0.8)",
        fontFamily: SANS,
      }}
    >
      {children}
    </span>
  );
}

/** The Home dashboard grid — matches Studio.jsx DEFAULT_LAYOUT. */
export const StudioHomeDashboard: React.FC<{ cardEnter?: number[] }> = ({
  cardEnter,
}) => {
  const enter = (i: number) => {
    const p = cardEnter?.[i] ?? 1;
    return {
      opacity: p,
      transform: `translateY(${(1 - p) * 18}px) scale(${0.97 + p * 0.03})`,
    };
  };

  const maxActivity = Math.max(...ACTIVITY);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(12, 1fr)",
        gridTemplateRows: "repeat(8, 1fr)",
        gap: 12,
        height: "100%",
        width: "100%",
        padding: 16,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      {/* hero — Welcome */}
      <div
        style={{
          ...CARD,
          ...enter(0),
          gridColumn: "1 / span 6",
          gridRow: "1 / span 2",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          padding: "20px 22px",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontFamily: SERIF,
              fontStyle: "italic",
              fontSize: 28,
              letterSpacing: "-0.02em",
              color: "rgba(255,255,255,0.95)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            Good afternoon, {FIRST_NAME}
          </p>
          <p style={{ margin: "8px 0 0", fontSize: 12, color: "rgba(255,255,255,0.45)" }}>
            Here's what your day looks like.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
          {[
            { n: 3, label: "done today", color: "#34d399" },
            { n: 2, label: "events left", color: "#60a5fa" },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                borderRadius: 16,
                border: "1px solid rgba(255,255,255,0.10)",
                background: "rgba(255,255,255,0.07)",
                padding: "10px 16px",
                textAlign: "center",
                minWidth: 78,
              }}
            >
              <p style={{ margin: 0, fontSize: 24, fontWeight: 600, lineHeight: 1 }}>{s.n}</p>
              <p
                style={{
                  margin: "8px 0 0",
                  fontSize: 10,
                  color: "rgba(255,255,255,0.5)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 99,
                    background: s.color,
                  }}
                />
                {s.label}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* side — Date */}
      <div
        style={{
          ...CARD,
          ...enter(1),
          gridColumn: "7 / span 3",
          gridRow: "1 / span 2",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px 22px",
        }}
      >
        <div>
          <p
            style={{
              margin: 0,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "#60a5fa",
            }}
          >
            Friday
          </p>
          <p
            style={{
              margin: "6px 0 0",
              fontSize: 42,
              fontWeight: 600,
              lineHeight: 1,
              letterSpacing: "-0.03em",
            }}
          >
            7
          </p>
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
            August 2026
          </p>
        </div>
        <p style={{ margin: 0, fontSize: 20, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
          5:08 PM
        </p>
      </div>

      {/* tall — Events */}
      <div
        style={{
          ...CARD,
          ...enter(2),
          gridColumn: "10 / span 3",
          gridRow: "1 / span 8",
          display: "flex",
          flexDirection: "column",
          padding: 16,
          overflow: "hidden",
        }}
      >
        <WidgetHeader
          title="Events"
          iconPaths={[
            "M8 2v4",
            "M16 2v4",
            "M3 10h18",
            "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
          ]}
          right={
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 99,
                display: "grid",
                placeItems: "center",
                color: "rgba(255,255,255,0.5)",
              }}
            >
              <Icon size={14} color="rgba(255,255,255,0.5)">
                <path d="M5 12h14" />
                <path d="M12 5v14" />
              </Icon>
            </div>
          }
        />
        <div style={{ marginTop: 10, flex: 1, minHeight: 0, overflow: "hidden" }}>
          {EVENTS.map((ev) => (
            <div
              key={ev.title}
              style={{
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.06)",
                borderLeft: `3px solid ${ev.color}`,
                background: "rgba(255,255,255,0.07)",
                padding: "10px 12px",
                marginBottom: 8,
              }}
            >
              <p
                style={{
                  margin: 0,
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: "rgba(255,255,255,0.9)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {ev.title}
              </p>
              <div
                style={{
                  marginTop: 4,
                  display: "flex",
                  gap: 8,
                  fontSize: 10.5,
                  color: "rgba(255,255,255,0.45)",
                }}
              >
                <span style={{ fontWeight: 500, color: "rgba(255,255,255,0.6)" }}>{ev.day}</span>
                <span>{ev.time}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* midA — To-dos */}
      <div
        style={{
          ...CARD,
          ...enter(3),
          gridColumn: "1 / span 3",
          gridRow: "3 / span 4",
          display: "flex",
          flexDirection: "column",
          padding: 16,
          overflow: "hidden",
        }}
      >
        <WidgetHeader
          title="To-dos"
          iconPaths={[
            "M3 5h6v6H3z",
            "m3 17 2 2 4-4",
            "M13 6h8",
            "M13 12h8",
            "M13 18h8",
          ]}
          right={
            <span
              style={{
                borderRadius: 99,
                border: "1px solid rgba(255,255,255,0.10)",
                background: "rgba(255,255,255,0.07)",
                padding: "3px 10px",
                fontSize: 10.5,
                fontWeight: 500,
                color: "rgba(255,255,255,0.7)",
              }}
            >
              {TODOS.length} open
            </span>
          }
        />
        <div style={{ marginTop: 8, flex: 1, minHeight: 0, overflow: "hidden" }}>
          {TODOS.map((t) => (
            <div
              key={t.title}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 8px",
                borderRadius: 12,
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 99,
                  border: "1.5px solid rgba(52,211,153,0.8)",
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  color: "rgba(255,255,255,0.85)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {t.title}
              </span>
              {t.due ? (
                <span
                  style={{
                    flexShrink: 0,
                    borderRadius: 6,
                    border: "1px solid rgba(255,255,255,0.10)",
                    background: "rgba(255,255,255,0.07)",
                    padding: "2px 6px",
                    fontSize: 9.5,
                    color: "rgba(255,255,255,0.55)",
                  }}
                >
                  {t.due}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {/* midB — Projects */}
      <div
        style={{
          ...CARD,
          ...enter(4),
          gridColumn: "4 / span 3",
          gridRow: "3 / span 4",
          display: "flex",
          flexDirection: "column",
          padding: 16,
          overflow: "hidden",
        }}
      >
        <WidgetHeader
          title="Projects"
          iconPaths={[
            "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z",
          ]}
        />
        <div style={{ marginTop: 8, flex: 1, minHeight: 0, overflow: "hidden" }}>
          {PROJECTS.map((p) => (
            <div
              key={p.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 8px",
                borderRadius: 12,
              }}
            >
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.20)",
                  background: "rgba(255,255,255,0.10)",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: "rgba(255,255,255,0.85)",
                  flexShrink: 0,
                }}
              >
                {p.initial}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 500,
                    color: "rgba(255,255,255,0.85)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {p.name}
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{p.meta}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* midC — Activity */}
      <div
        style={{
          ...CARD,
          ...enter(5),
          gridColumn: "7 / span 3",
          gridRow: "3 / span 4",
          display: "flex",
          flexDirection: "column",
          padding: 16,
          overflow: "hidden",
        }}
      >
        <WidgetHeader
          title="Activity"
          iconPaths={[
            "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2",
          ]}
          right={
            <span
              style={{
                borderRadius: 99,
                border: "1px solid rgba(255,255,255,0.10)",
                background: "rgba(255,255,255,0.07)",
                padding: "3px 10px",
                fontSize: 10.5,
                fontWeight: 500,
                color: "rgba(255,255,255,0.7)",
              }}
            >
              {ACTIVITY.reduce((a, b) => a + b, 0)} this week
            </span>
          }
        />
        <div
          style={{
            marginTop: 12,
            flex: 1,
            minHeight: 0,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 8,
            padding: "0 4px 4px",
          }}
        >
          {ACTIVITY.map((count, i) => {
            const isToday = i === ACTIVITY.length - 1;
            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: 6,
                }}
              >
                <span style={{ fontSize: 9.5, color: "rgba(255,255,255,0.45)", fontVariantNumeric: "tabular-nums" }}>
                  {count || ""}
                </span>
                <div
                  style={{
                    width: "100%",
                    maxWidth: 16,
                    borderRadius: 99,
                    height: `${Math.max(8, (count / maxActivity) * 100)}%`,
                    background: isToday
                      ? "linear-gradient(to top, #3b82f6, #818cf8)"
                      : "rgba(255,255,255,0.25)",
                  }}
                />
                <span
                  style={{
                    fontSize: 9.5,
                    fontWeight: isToday ? 600 : 400,
                    color: isToday ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.4)",
                  }}
                >
                  {ACTIVITY_DAYS[i]}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* bottom — Updates */}
      <div
        style={{
          ...CARD,
          ...enter(6),
          gridColumn: "1 / span 9",
          gridRow: "7 / span 2",
          display: "flex",
          flexDirection: "column",
          padding: 16,
          overflow: "hidden",
        }}
      >
        <WidgetHeader
          title="Updates"
          iconPaths={[
            "M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2",
            "M18 14h-8",
            "M15 18h-5",
            "M10 6h8v4h-8V6Z",
          ]}
        />
        <div
          style={{
            marginTop: 8,
            flex: 1,
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 8,
          }}
        >
          {UPDATES.map((u) => (
            <div
              key={u.title}
              style={{
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.06)",
                background: "rgba(255,255,255,0.07)",
                padding: "10px 12px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                minWidth: 0,
              }}
            >
              <p
                style={{
                  margin: 0,
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: "rgba(255,255,255,0.9)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {u.title}
              </p>
              <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    borderRadius: 99,
                    background: "rgba(59,130,246,0.25)",
                    padding: "2px 8px",
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    color: "#93c5fd",
                  }}
                >
                  {u.tag}
                </span>
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{u.date}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

/** In-page traffic lights — Studio draws these in fullscreen (native ones hide). */
const TrafficLights: React.FC = () => (
  <div
    style={{
      position: "absolute",
      left: 12,
      top: 52,
      zIndex: 10,
      display: "flex",
      alignItems: "center",
      gap: 10,
    }}
  >
    {[
      { bg: "#ff5f57" },
      { bg: "#febc2e" },
      { bg: "#28c840" },
    ].map((d) => (
      <span
        key={d.bg}
        style={{
          width: 14,
          height: 14,
          borderRadius: 99,
          background: d.bg,
          border: "1px solid rgba(0,0,0,0.12)",
          boxShadow: "0 1px 2px rgba(0,0,0,0.18)",
        }}
      />
    ))}
  </div>
);

/** Full Studio glass chrome + Home — no animation. Drop into other comps.
 *  Defaults to fullscreen (edge-to-edge), matching Studio's fullscreen glass mode. */
export const StudioGlassHome: React.FC<{
  style?: React.CSSProperties;
  cardEnter?: number[];
  /** Dim the desktop behind the shell (0–1). */
  dim?: number;
  /** Fullscreen shell — fills the display (default true). */
  fullscreen?: boolean;
  /** Active nav tab — highlights rail + dock. */
  activeTab?: "home" | "chat" | "browser" | "projects" | "vault" | "calendar" | "settings";
  /** Replace the frost-stage body (e.g. Chat / Research UI). */
  main?: React.ReactNode;
}> = ({
  style,
  cardEnter,
  dim = 0,
  fullscreen = true,
  activeTab = "home",
  main,
}) => {
  const railItems = NAV.filter((n) => n.id !== "settings");
  const settings = NAV.find((n) => n.id === "settings")!;
  // Studio.jsx: fullscreen ? "px-2 pb-2 pt-11" : "px-5 pb-4 pt-4"
  const pad = fullscreen ? "44px 8px 8px" : "16px 20px 16px";
  const maxW = fullscreen ? undefined : CONTENT_W;
  const tabActive = (id: string) =>
    (activeTab === "home" && id === "home") || id === activeTab;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: pad,
        boxSizing: "border-box",
        fontFamily: SANS,
        color: "rgba(255,255,255,0.85)",
        ...style,
      }}
    >
      {dim > 0 ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background: `rgba(8,10,18,${0.22 * dim})`,
            pointerEvents: "none",
          }}
        />
      ) : null}

      {fullscreen ? <TrafficLights /> : null}

      {/* Top bar — hide welcome chrome when deep in a product tab? Keep it —
          matches Studio Home/Chat both showing the top row when not focused. */}
      <div
        style={{
          position: "relative",
          zIndex: 2,
          width: "100%",
          maxWidth: maxW,
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
          flexShrink: 0,
          paddingLeft: fullscreen ? 64 : undefined,
          boxSizing: "border-box",
          opacity: activeTab === "home" ? 1 : 0.92,
        }}
      >
        <div
          style={{
            ...BAR,
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderRadius: 99,
            padding: "6px 16px 6px 8px",
            flexShrink: 0,
          }}
        >
          <LyknMark size={32} />
          <span
            style={{
              fontFamily: SERIF,
              fontStyle: "italic",
              fontSize: 17,
              letterSpacing: "-0.02em",
              whiteSpace: "nowrap",
            }}
          >
            Welcome, {FIRST_NAME}
          </span>
        </div>

        <div
          style={{
            ...BAR,
            flex: 1,
            minWidth: 0,
            height: 40,
            borderRadius: 99,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 16px",
          }}
        >
          <Icon size={15} color="rgba(255,255,255,0.4)">
            <circle cx={11} cy={11} r={8} />
            <path d="m21 21-4.3-4.3" />
          </Icon>
          <span style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>
            Search Studio or the web…
          </span>
        </div>

        <div
          style={{
            ...BAR,
            display: "flex",
            alignItems: "center",
            borderRadius: 99,
            padding: 4,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              borderRadius: 99,
              padding: "6px 12px",
              fontSize: 11.5,
              fontWeight: 500,
              background: "#ffffff",
              color: "#000000",
              boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
            }}
          >
            Glass
          </div>
          <div
            style={{
              borderRadius: 99,
              padding: "6px 12px",
              fontSize: 11.5,
              fontWeight: 500,
              color: "rgba(255,255,255,0.6)",
            }}
          >
            Neutral
          </div>
        </div>

        <div
          style={{
            ...BAR,
            width: 40,
            height: 40,
            borderRadius: 99,
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
            color: "rgba(255,255,255,0.7)",
          }}
        >
          <Icon size={16} color="rgba(255,255,255,0.7)">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </Icon>
        </div>

        <div
          style={{
            ...BAR,
            height: 40,
            borderRadius: 99,
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "0 10px",
            flexShrink: 0,
          }}
        >
          <Kbd>⌘</Kbd>
          <Kbd>L</Kbd>
        </div>
      </div>

      {/* Rail + frost stage */}
      <div
        style={{
          position: "relative",
          zIndex: 2,
          width: "100%",
          maxWidth: maxW,
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "stretch",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div
            style={{
              ...BAR,
              width: 52,
              borderRadius: 26,
              padding: 6,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
            }}
          >
            {railItems.map((item) => (
              <CircleNav key={item.id} active={tabActive(item.id)} paths={item.paths} />
            ))}
            <div style={{ flex: 1, minHeight: 18 }} />
            <CircleNav active={tabActive("settings")} paths={settings.paths} />
          </div>
        </div>

        <div
          style={{
            ...FROST,
            position: "relative",
            flex: 1,
            minWidth: 0,
            borderRadius: 36,
            overflow: "hidden",
          }}
        >
          {main ?? <StudioHomeDashboard cardEnter={cardEnter} />}
        </div>
      </div>

      {/* Bottom dock */}
      <div
        style={{
          ...BAR,
          position: "relative",
          zIndex: 2,
          marginTop: 12,
          borderRadius: 99,
          padding: 6,
          display: "flex",
          alignItems: "center",
          gap: 4,
          flexShrink: 0,
        }}
      >
        {NAV.map((item) => {
          const active = tabActive(item.id);
          return (
            <div
              key={item.id}
              style={{
                borderRadius: 99,
                padding: "7px 16px",
                fontSize: 12,
                fontWeight: 500,
                whiteSpace: "nowrap",
                background: active ? "#ffffff" : "transparent",
                color: active ? "#000000" : "rgba(255,255,255,0.65)",
                boxShadow: active ? "0 4px 14px rgba(0,0,0,0.25)" : undefined,
              }}
            >
              {item.label}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export type StudioGlassStageProps = {
  /** 0 = off-screen below, 1 = settled. Defaults to 1. */
  pullProgress?: number;
  /** Staggered card entrances 0–1 per widget. Defaults to fully in. */
  cardEnter?: number[];
  wallpaper?: string;
  /** macOS menu bar behind the pull-up (hidden once fullscreen settles). */
  showMenuBar?: boolean;
  /** Edge-to-edge Studio fullscreen shell (default true). */
  fullscreen?: boolean;
  activeTab?: "home" | "chat" | "browser" | "projects" | "vault" | "calendar" | "settings";
  main?: React.ReactNode;
  children?: React.ReactNode;
};

/** Reusable stage: wallpaper + Studio glass home at a given pull progress. */
export const StudioGlassStage: React.FC<StudioGlassStageProps> = ({
  pullProgress = 1,
  cardEnter,
  wallpaper = "wallpaper-room.png",
  showMenuBar = true,
  fullscreen = true,
  activeTab = "home",
  main,
  children,
}) => {
  // Fullscreen: rise as a full display panel (no shrink). Windowed keeps a soft scale-in.
  const y = interpolate(pullProgress, [0, 1], [110, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = fullscreen
    ? 1
    : interpolate(pullProgress, [0, 1], [0.92, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
  const opacity = interpolate(pullProgress, [0, 0.28, 1], [0, 1, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const dim = interpolate(pullProgress, [0, 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // Desktop softens behind Studio as it rises (glass vibrancy).
  const bgBlur = interpolate(pullProgress, [0, 0.35, 1], [0, 12, 28], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const bgScale = interpolate(pullProgress, [0, 1], [1.02, 1.12], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // Menu bar fades as fullscreen Studio covers the display.
  const menuOpacity = fullscreen
    ? interpolate(pullProgress, [0, 0.55, 0.85], [1, 0.55, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : interpolate(pullProgress, [0, 0.5], [0.4, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });

  return (
    <AbsoluteFill style={{ background: "#0a0c12", overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          filter: bgBlur > 0.1 ? `blur(${bgBlur}px) saturate(1.15)` : undefined,
          transform: `scale(${bgScale})`,
          transformOrigin: "50% 50%",
        }}
      >
        <Img
          src={staticFile(wallpaper)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      </AbsoluteFill>

      {/* soft vignette + frost wash so the blurred desktop reads as glass */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(120% 90% at 50% 40%, rgba(8,10,18,0.18) 20%, rgba(6,8,14,0.55) 100%)",
          opacity: dim,
        }}
      />

      {showMenuBar ? (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 28,
            display: "flex",
            alignItems: "center",
            padding: "0 16px",
            gap: 18,
            fontSize: 12.5,
            color: "rgba(255,255,255,0.9)",
            background: "rgba(20,22,30,0.28)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            fontFamily: SANS,
            zIndex: 5,
            opacity: menuOpacity,
          }}
        >
          <span style={{ fontSize: 14 }}>{"\uF8FF"}</span>
          <span style={{ fontWeight: 700 }}>LYKN</span>
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <span>Window</span>
          <span style={{ flex: 1 }} />
          <span>Fri Aug 7</span>
          <span>5:08 PM</span>
        </div>
      ) : null}

      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity,
          transform: `translateY(${y}%) scale(${scale})`,
          transformOrigin: "50% 100%",
        }}
      >
        <StudioGlassHome
          cardEnter={cardEnter}
          dim={dim}
          fullscreen={fullscreen}
          activeTab={activeTab}
          main={main}
        />
      </div>

      {children}
    </AbsoluteFill>
  );
};

export const lyknStudioOpenDefaults = {
  wallpaper: "wallpaper-room.png" as string,
};

export const LyknStudioOpen: React.FC<{
  wallpaper?: string;
}> = ({ wallpaper = "wallpaper-room.png" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Shell springs up from below.
  const pull = spring({
    frame: frame - 4,
    fps,
    config: { damping: 18, stiffness: 90, mass: 0.9 },
  });
  // Slight overshoot settle via interpolate on a softer curve for the last bit.
  const pullProgress = interpolate(pull, [0, 1], [0, 1], {
    easing: EASE_OUT,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Dashboard cards stagger in after the shell is mostly up.
  const cardEnter = Array.from({ length: 7 }, (_, i) => {
    const start = 22 + i * 4;
    return spring({
      frame: frame - start,
      fps,
      config: { damping: 16, stiffness: 120, mass: 0.7 },
    });
  });

  return (
    <StudioGlassStage
      pullProgress={pullProgress}
      cardEnter={cardEnter}
      wallpaper={wallpaper}
      fullscreen
      showMenuBar
    />
  );
};
