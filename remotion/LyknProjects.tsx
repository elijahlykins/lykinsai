import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";

// ---------------------------------------------------------------------------
// LYKN Projects — the actual /projects + /projects/:id UI (dark theme) in a
// preview-card window on the blue gradient. A user creates a project, enters
// it, and watches cloud agents fill out tasks (and complete them), calendar
// events, and AI updates — calendar, to-dos, tasks, and activity in one place.
// ---------------------------------------------------------------------------

const EASE = Easing.inOut(Easing.cubic);
const APP_BG = "#1e1e1e";
const TXT = "rgba(255,255,255,0.92)";
const TXT_90 = "rgba(255,255,255,0.9)";
const TXT_70 = "rgba(255,255,255,0.7)";
const TXT_55 = "rgba(255,255,255,0.55)";
const TXT_45 = "rgba(255,255,255,0.45)";
const TXT_35 = "rgba(255,255,255,0.35)";
const BLUE_400 = "#60a5fa";
const BLUE_500_10 = "rgba(59,130,246,0.10)";
const GREEN_400 = "#4ade80";
const TEAL = "#14b8a6";
const AMBER = "#f59e0b";

// Preview-card window (matches .lykn-wake-subwindow).
const BODY_W = 1680;
const BODY_H = 945;
const CHROME_H = 46;
const WIN_W = BODY_W;
const WIN_H = BODY_H + CHROME_H;
const WIN_LEFT = (1920 - WIN_W) / 2;
const WIN_TOP = (1080 - WIN_H) / 2;
const WIN_SCALE = BODY_W / 1920;

const RAIL_W = 72;
const MAIN_X = RAIL_W;
const MAIN_W = 1920 - RAIL_W;
const MAXSCROLL = 300;

const PROJECT_NAME = "Q3 Product Launch";

const CARD: React.CSSProperties = {
  borderRadius: 26,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.04)",
  boxShadow:
    "0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 32px -16px rgba(0,0,0,0.6)",
};

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

const Icon: React.FC<{
  size?: number;
  color?: string;
  sw?: number;
  fill?: string;
  children: React.ReactNode;
}> = ({ size = 16, color = TXT_60(), sw = 2, fill = "none", children }) => (
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
function TXT_60() {
  return "rgba(255,255,255,0.6)";
}

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
  arrowLeft: (
    <>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </>
  ),
  listTodo: (
    <>
      <rect x={3} y={5} width={6} height={6} rx={1} />
      <path d="m3 17 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </>
  ),
  clock: (
    <>
      <circle cx={12} cy={12} r={10} />
      <path d="M12 6v6l4 2" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  checkCircle: (
    <>
      <path d="M21.8 10A10 10 0 1 1 17 3.34" />
      <path d="m9 11 3 3L22 4" />
    </>
  ),
  circle: <circle cx={12} cy={12} r={10} />,
  calendarPlus: (
    <>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8" />
      <path d="M3 10h18" />
      <path d="M16 19h6" />
      <path d="M19 16v6" />
    </>
  ),
  crosshair: (
    <>
      <circle cx={12} cy={12} r={10} />
      <line x1={22} x2={18} y1={12} y2={12} />
      <line x1={6} x2={2} y1={12} y2={12} />
      <line x1={12} x2={12} y1={6} y2={2} />
      <line x1={12} x2={12} y1={22} y2={18} />
    </>
  ),
  library: (
    <>
      <path d="m16 6 4 14" />
      <path d="M12 6v14" />
      <path d="M8 8v12" />
      <path d="M4 4v16" />
    </>
  ),
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  pause: (
    <>
      <rect x={14} y={4} width={4} height={16} rx={1} />
      <rect x={6} y={4} width={4} height={16} rx={1} />
    </>
  ),
  inbox: (
    <>
      <path d="M12 17V3" />
      <path d="m6 11 6 6 6-6" />
      <path d="M19 21H5" />
    </>
  ),
  mapPin: (
    <>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx={12} cy={10} r={3} />
    </>
  ),
};

const LyknMark: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox={ICON_VIEWBOX} style={{ flexShrink: 0 }}>
    <path d={ICON_PATH} fill="#f2f2f2" />
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

const Badge: React.FC<{ bg: string; color: string; children: React.ReactNode }> = ({
  bg,
  color,
  children,
}) => (
  <span
    style={{
      fontSize: 12,
      padding: "2px 9px",
      borderRadius: 99,
      background: bg,
      color,
      fontWeight: 500,
    }}
  >
    {children}
  </span>
);

const ActionBtn: React.FC<{
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}> = ({ icon, label, active }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      fontSize: 13,
      padding: "8px 11px",
      borderRadius: 9,
      background: active ? "rgba(59,130,246,0.15)" : "rgba(255,255,255,0.06)",
      color: active ? BLUE_400 : TXT_70,
    }}
  >
    <Icon size={14} color={active ? BLUE_400 : TXT_70}>
      {icon}
    </Icon>
    {label}
  </div>
);

const StatTile: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: number | string;
  tone?: "default" | "accent" | "danger";
}> = ({ icon, label, value, tone = "default" }) => {
  const color = tone === "accent" ? BLUE_400 : tone === "danger" ? "#f87171" : TXT_90;
  return (
    <div
      style={{
        borderRadius: 18,
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.04)",
        padding: "14px 18px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, color: TXT_45 }}>
        <Icon size={15} color={TXT_45}>
          {icon}
        </Icon>
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          {label}
        </span>
      </div>
      <div style={{ marginTop: 6, fontSize: 30, fontWeight: 600, color }}>{value}</div>
    </div>
  );
};

// ── Task row ──
const TaskRow: React.FC<{
  frame: number;
  start: number;
  title: string;
  due?: string;
  priority?: "high" | "normal" | "low";
  completeAt?: number;
}> = ({ frame, start, title, due, priority = "normal", completeAt }) => {
  const done = completeAt != null && frame >= completeAt;
  const priColor = priority === "high" ? "#ef4444" : priority === "low" ? "rgba(255,255,255,0.3)" : BLUE_400;
  return (
    <div
      style={{
        ...reveal(frame, start, 16, 12),
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "9px 10px",
        borderRadius: 16,
      }}
    >
      {done ? (
        <Icon size={21} color={GREEN_400}>
          {ICONS.checkCircle}
        </Icon>
      ) : (
        <Icon size={21} color="rgba(255,255,255,0.3)">
          {ICONS.circle}
        </Icon>
      )}
      {!done && priority !== "normal" ? (
        <span style={{ width: 6, height: 6, borderRadius: 99, background: priColor, flexShrink: 0 }} />
      ) : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 16,
            color: done ? TXT_35 : TXT_90,
            textDecoration: done ? "line-through" : "none",
          }}
        >
          {title}
        </div>
      </div>
      {due ? (
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.02em",
            padding: "2px 9px",
            borderRadius: 99,
            background: done ? "transparent" : "rgba(245,158,11,0.10)",
            color: done ? TXT_35 : AMBER,
          }}
        >
          {due}
        </span>
      ) : null}
    </div>
  );
};

// ── Event row ──
const EventRow: React.FC<{
  frame: number;
  start: number;
  day: number;
  weekday: string;
  title: string;
  when: string;
  status: { label: string; bg: string; color: string };
  location?: string;
}> = ({ frame, start, day, weekday, title, when, status, location }) => (
  <div
    style={{
      ...reveal(frame, start, 16, 12),
      display: "flex",
      gap: 12,
      padding: 10,
      borderRadius: 16,
      border: "1px solid rgba(255,255,255,0.06)",
      background: "rgba(255,255,255,0.02)",
    }}
  >
    <div
      style={{
        width: 46,
        borderRadius: 12,
        background: "rgba(255,255,255,0.06)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "6px 0",
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 20, fontWeight: 600, color: TXT_90, lineHeight: 1 }}>{day}</span>
      <span style={{ marginTop: 3, fontSize: 9.5, fontWeight: 500, color: TXT_45 }}>{weekday}</span>
    </div>
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ fontSize: 16, fontWeight: 500, color: TXT_90 }}>{title}</div>
      <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 500, padding: "2px 9px", borderRadius: 99, background: status.bg, color: status.color }}>
          {status.label}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: TXT_45 }}>
          <Icon size={13} color={TXT_45}>
            {ICONS.calendar}
          </Icon>
          {when}
        </span>
        {location ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: TXT_45 }}>
            <Icon size={13} color={TXT_45}>
              {ICONS.mapPin}
            </Icon>
            {location}
          </span>
        ) : null}
      </div>
    </div>
  </div>
);

const SectionTitle: React.FC<{ children: React.ReactNode; right?: React.ReactNode }> = ({
  children,
  right,
}) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
    <h2 style={{ fontSize: 19, fontWeight: 600, color: TXT_90, margin: 0, letterSpacing: "-0.01em" }}>{children}</h2>
    {right ? <div style={{ marginLeft: "auto" }}>{right}</div> : null}
  </div>
);

const AddNewPill: React.FC = () => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      fontSize: 13,
      fontWeight: 500,
      padding: "6px 13px",
      borderRadius: 99,
      background: "#ffffff",
      color: "#000000",
    }}
  >
    <Icon size={14} color="#000000">
      {ICONS.plus}
    </Icon>
    Add new
  </span>
);

// Mini month calendar with build-on dots.
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const FIRST_WEEKDAY = 2; // month starts Tuesday
const DAYS_IN_MONTH = 31;
const TODAY = 12;
// dayNumber -> { event?: appearFrame, task?: appearFrame }
const CAL_MARKS: Record<number, { event?: number; task?: number }> = {
  12: { event: 312 },
  14: { event: 330, task: 360 },
  15: { task: 372 },
  16: { task: 384 },
  18: { event: 348 },
};

const MiniCalendar: React.FC<{ frame: number }> = ({ frame }) => {
  const cells: ({ day: number } | null)[] = [];
  for (let i = 0; i < FIRST_WEEKDAY; i++) cells.push(null);
  for (let d = 1; d <= DAYS_IN_MONTH; d++) cells.push({ day: d });
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div style={{ ...CARD, padding: 22 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h2 style={{ fontSize: 19, fontWeight: 600, color: TXT_90, margin: 0 }}>August 2026</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Icon size={16} color={TXT_45}>{ICONS.chevronLeft}</Icon>
          <span style={{ fontSize: 12, color: TXT_55, padding: "0 6px" }}>Today</span>
          <Icon size={16} color={TXT_45}>{ICONS.chevronRight}</Icon>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", rowGap: 2, textAlign: "center" }}>
        {WEEKDAYS.map((w) => (
          <div key={w} style={{ fontSize: 10.5, fontWeight: 500, color: TXT_35, paddingBottom: 4 }}>
            {w}
          </div>
        ))}
        {cells.map((c, i) => {
          if (!c) return <div key={i} />;
          const isToday = c.day === TODAY;
          const mark = CAL_MARKS[c.day];
          return (
            <div key={i} style={{ display: "flex", justifyContent: "center", padding: "3px 0" }}>
              <div
                style={{
                  position: "relative",
                  width: 38,
                  height: 38,
                  borderRadius: 99,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  fontWeight: isToday ? 600 : 400,
                  background: isToday ? "#ffffff" : "transparent",
                  color: isToday ? "#000000" : TXT_70,
                }}
              >
                {c.day}
                {mark ? (
                  <span style={{ position: "absolute", bottom: 4, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 2 }}>
                    {mark.event != null ? (
                      <span
                        style={{
                          width: 4,
                          height: 4,
                          borderRadius: 99,
                          background: isToday ? "rgba(0,0,0,0.8)" : "#3b82f6",
                          opacity: interpolate(frame, [mark.event, mark.event + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
                        }}
                      />
                    ) : null}
                    {mark.task != null ? (
                      <span
                        style={{
                          width: 4,
                          height: 4,
                          borderRadius: 99,
                          background: isToday ? "rgba(0,0,0,0.8)" : TEAL,
                          opacity: interpolate(frame, [mark.task, mark.task + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
                        }}
                      />
                    ) : null}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 14, display: "flex", justifyContent: "center", gap: 18, fontSize: 11, color: TXT_45 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: "#3b82f6" }} /> Events
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: TEAL }} /> Deadlines
        </span>
      </div>
    </div>
  );
};

const UpdateRow: React.FC<{
  frame: number;
  start: number;
  title: string;
  meta: string;
}> = ({ frame, start, title, meta }) => (
  <div
    style={{
      ...reveal(frame, start, 16, 12),
      borderRadius: 14,
      border: "1px solid rgba(59,130,246,0.18)",
      background: "rgba(59,130,246,0.06)",
      padding: "11px 14px",
    }}
  >
    <div style={{ fontSize: 15, color: TXT_90 }}>{title}</div>
    <div style={{ marginTop: 4, fontSize: 12.5, color: TXT_45 }}>{meta}</div>
  </div>
);

export const LyknProjects: React.FC = () => {
  const frame = useCurrentFrame();

  // Index → detail crossfade.
  const indexOpacity = interpolate(frame, [0, 14, 108, 126], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const detailOpacity = interpolate(frame, [120, 140], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const showIndex = frame < 130;
  const showDetail = frame >= 116;

  // Typewriter for the new project name (index).
  const typed = Math.round(
    interpolate(frame, [30, 78], [0, PROJECT_NAME.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const typedText = PROJECT_NAME.slice(0, typed);
  const cursorOn = frame >= 26 && frame < 92 && Math.floor(frame / 8) % 2 === 0;
  const createPress = interpolate(frame, [92, 98, 104], [1, 0.94, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Detail scroll pan.
  const scrollY = interpolate(frame, [200, 300, 380, 520], [0, 70, 200, MAXSCROLL], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  // Ticking stats.
  const openTasks = Math.round(
    interpolate(frame, [300, 396], [0, 5], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  );
  const doneTasks = frame >= 470 ? 2 : frame >= 430 ? 1 : 0;
  const eventCount = Math.round(
    interpolate(frame, [300, 360], [0, 3], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  );

  const DETAIL_COL = 1180;
  const DETAIL_LEFT = (MAIN_W - DETAIL_COL) / 2;
  const colHalf = (DETAIL_COL - 22) / 2;

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(135% 135% at 50% 0%, #357bff 0%, #1c47c0 42%, #0a205f 100%)",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
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
            background: "rgba(255,255,255,0.03)",
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
                  background: "#292929",
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
                  <RailBtn><Icon size={19} color={TXT_60()}>{ICONS.edit}</Icon></RailBtn>
                  <RailBtn><Icon size={19} color={TXT_60()}>{ICONS.message}</Icon></RailBtn>
                  <RailBtn><Icon size={19} color={TXT_60()}>{ICONS.plug}</Icon></RailBtn>
                  <RailBtn><Icon size={19} color={TXT_60()}>{ICONS.calendar}</Icon></RailBtn>
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

              {/* scroll viewport */}
              <div style={{ position: "absolute", left: MAIN_X, top: 0, width: MAIN_W, height: 1080, overflow: "hidden" }}>
                {/* ── INDEX page ── */}
                {showIndex && (
                  <div style={{ position: "absolute", inset: 0, opacity: indexOpacity }}>
                    <div style={{ position: "absolute", left: (MAIN_W - 640) / 2, top: 150, width: 640 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                        <Icon size={22} color={TXT_60()}>{ICONS.folder}</Icon>
                        <span style={{ fontSize: 26, fontWeight: 600, color: TXT_90, letterSpacing: "-0.01em" }}>Projects</span>
                      </div>
                      <p style={{ fontSize: 14, color: TXT_45, lineHeight: 1.5, margin: "0 0 26px" }}>
                        Your synthesis-layer projects and the tasks, deadlines, vault items, and concepts
                        inside them. Every connected AI client sees these too.
                      </p>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 26, transform: `scale(${createPress})`, transformOrigin: "right center" }}>
                        <div
                          style={{
                            flex: 1,
                            fontSize: 15,
                            padding: "11px 14px",
                            borderRadius: 12,
                            border: `1px solid ${typedText ? "rgba(59,130,246,0.4)" : "rgba(255,255,255,0.1)"}`,
                            background: "rgba(255,255,255,0.04)",
                            color: typedText ? TXT : TXT_35,
                          }}
                        >
                          {typedText || "New project name"}
                          {cursorOn ? <span style={{ color: BLUE_400 }}>|</span> : null}
                        </div>
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 7,
                            fontSize: 14,
                            padding: "11px 16px",
                            borderRadius: 12,
                            background: BLUE_500_10,
                            color: BLUE_400,
                          }}
                        >
                          <Icon size={15} color={BLUE_400}>{ICONS.plus}</Icon>
                          Create
                        </div>
                      </div>
                      {/* existing project rows */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {["Brand refresh", "Investor update"].map((n) => (
                          <div
                            key={n}
                            style={{
                              borderRadius: 18,
                              border: "1px solid rgba(255,255,255,0.06)",
                              background: "rgba(255,255,255,0.02)",
                              padding: "14px 16px",
                              opacity: 0.6,
                            }}
                          >
                            <div style={{ fontSize: 15, fontWeight: 500, color: TXT_90 }}>{n}</div>
                            <div style={{ marginTop: 5, fontSize: 12, color: TXT_45 }}>8 vault items · 3 concepts · 12 AI pushes · used 2d ago</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* ── DETAIL page ── */}
                {showDetail && (
                  <div style={{ position: "absolute", inset: 0, opacity: detailOpacity }}>
                    <div style={{ position: "absolute", left: DETAIL_LEFT, top: 0, width: DETAIL_COL, transform: `translateY(${-scrollY}px)` }}>
                      <div style={{ paddingTop: 40 }}>
                        {/* back link */}
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, color: TXT_45, marginBottom: 18 }}>
                          <Icon size={14} color={TXT_45}>{ICONS.arrowLeft}</Icon>
                          All projects
                        </div>

                        {/* header */}
                        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                          <Icon size={24} color={TXT_55}>{ICONS.folder}</Icon>
                          <span style={{ fontSize: 32, fontWeight: 600, color: TXT, letterSpacing: "-0.02em" }}>{PROJECT_NAME}</span>
                          <Badge bg="rgba(34,197,94,0.10)" color={GREEN_400}>Active</Badge>
                          <span style={{ ...reveal(frame, 250, 16), display: "inline-block" }}>
                            <Badge bg={BLUE_500_10} color={BLUE_400}>AI focus</Badge>
                          </span>
                        </div>
                        <p style={{ fontSize: 14, color: TXT_45, margin: "8px 0 0" }}>
                          Bringing the Q3 release to market.{" "}
                          <span style={{ color: TXT_35 }}>· used just now · {frame >= 460 ? 4 : frame >= 360 ? 2 : 0} AI pushes · {openTasks + eventCount} items</span>
                        </p>

                        {/* action bar */}
                        <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 8 }}>
                          <ActionBtn icon={ICONS.library} label="Add from vault" />
                          <ActionBtn icon={ICONS.plus} label="Add neurons" />
                          <div style={{ flex: 1 }} />
                          <ActionBtn icon={ICONS.crosshair} label="AI focus ✓" active />
                          <ActionBtn icon={ICONS.pause} label="Deactivate" />
                        </div>

                        {/* stat tiles */}
                        <div style={{ marginTop: 20, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
                          <StatTile icon={ICONS.listTodo} label="Open tasks" value={openTasks} />
                          <StatTile icon={ICONS.clock} label="Overdue" value={0} />
                          <StatTile icon={ICONS.checkCircle} label="Done · 7d" value={doneTasks} />
                          <StatTile icon={ICONS.calendarPlus} label="Events · 7d" value={eventCount} tone="accent" />
                        </div>

                        {/* calendar + events */}
                        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
                          <MiniCalendar frame={frame} />
                          <div style={{ ...CARD, padding: 22 }}>
                            <SectionTitle right={<AddNewPill />}>Your events</SectionTitle>
                            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                              <EventRow frame={frame} start={306} day={12} weekday="WED" title="Launch kickoff" when="Wed, Aug 12 · 9:00 AM" status={{ label: "Upcoming", bg: BLUE_500_10, color: BLUE_400 }} location="Zoom" />
                              <EventRow frame={frame} start={326} day={14} weekday="FRI" title="Beta feedback review" when="Fri, Aug 14 · 2:00 PM" status={{ label: "Upcoming", bg: BLUE_500_10, color: BLUE_400 }} />
                              <EventRow frame={frame} start={346} day={18} weekday="TUE" title="Press embargo lifts" when="Tue, Aug 18 · All day" status={{ label: "Upcoming", bg: BLUE_500_10, color: BLUE_400 }} />
                            </div>
                          </div>
                        </div>

                        {/* AI updates + tasks */}
                        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start", paddingBottom: 60 }}>
                          <div style={{ ...CARD, padding: 22 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
                              <Icon size={17} color={TXT_45}>{ICONS.inbox}</Icon>
                              <h2 style={{ fontSize: 19, fontWeight: 600, color: TXT_90, margin: 0 }}>Messages &amp; AI updates</h2>
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                              <UpdateRow frame={frame} start={410} title="Cloud agent pushed “landing page scaffold” to the project." meta="Cursor · just now" />
                              <UpdateRow frame={frame} start={444} title="Drafted the launch announcement and 3 follow-up emails." meta="Agent · 1m ago" />
                            </div>
                          </div>
                          <div style={{ ...CARD, padding: 22 }}>
                            <SectionTitle right={<AddNewPill />}>
                              Todo list{" "}
                              <span style={{ fontSize: 13, fontWeight: 400, color: TXT_45 }}>{openTasks - doneTasks} open</span>
                            </SectionTitle>
                            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                              <TaskRow frame={frame} start={306} title="Draft launch announcement" priority="high" due="AUG 14" completeAt={470} />
                              <TaskRow frame={frame} start={324} title="Set up landing page A/B test" due="AUG 16" />
                              <TaskRow frame={frame} start={342} title="Email beta list invites" due="AUG 15" completeAt={430} />
                              <TaskRow frame={frame} start={360} title="Finalize pricing page" priority="high" />
                              <TaskRow frame={frame} start={378} title="Schedule press outreach" priority="low" />
                            </div>
                          </div>
                        </div>
                      </div>
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
