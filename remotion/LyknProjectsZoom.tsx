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
// LYKN Projects — camera edition. The full project detail page sits in the
// preview-card window on the blue gradient. A cinematic camera zooms into the
// todo list while tasks get typed in and checked off, then glides over the
// stat tiles and the calendar before pulling back out to the full page.
// ---------------------------------------------------------------------------

// Global playback speed. 2 = twice as fast. Keep Root.tsx durationInFrames in
// sync: it should be Math.ceil(540 / SPEED).
export const PROJECTS_ZOOM_SPEED = 4;
export const PROJECTS_ZOOM_DURATION = Math.ceil(540 / PROJECTS_ZOOM_SPEED);

const EASE = Easing.inOut(Easing.cubic);
const APP_BG = "#1e1e1e";
const TXT = "rgba(255,255,255,0.92)";
const TXT_90 = "rgba(255,255,255,0.9)";
const TXT_70 = "rgba(255,255,255,0.7)";
const TXT_60 = "rgba(255,255,255,0.6)";
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
const COL_W = 1180;
const COL_X = RAIL_W + (1920 - RAIL_W - COL_W) / 2; // 406
const LEFT_W = 580;
const RIGHT_X = COL_X + LEFT_W + 20; // 1006

const PROJECT_NAME = "Q3 Product Launch";

// ── fake task data ──
type Priority = "high" | "normal" | "low";
const BASE_TASKS: { title: string; due?: string; priority?: Priority }[] = [
  { title: "Draft launch announcement", due: "AUG 14", priority: "high" },
  { title: "Book venue for launch event", due: "AUG 20" },
];
const TYPED_TASKS: {
  title: string;
  due?: string;
  priority?: Priority;
  typeStart: number;
  typeEnd: number;
  commit: number;
  calDay?: number;
}[] = [
  { title: "Send invites to beta users", due: "AUG 15", typeStart: 96, typeEnd: 144, commit: 152, calDay: 15 },
  { title: "Finalize pricing page", due: "AUG 16", priority: "high", typeStart: 172, typeEnd: 216, commit: 226, calDay: 16 },
  { title: "Record product demo video", due: "AUG 18", typeStart: 244, typeEnd: 282, commit: 290, calDay: 18 },
];
const CHECK_OFF_AT = 302; // "Draft launch announcement" gets completed

export const CARD: React.CSSProperties = {
  borderRadius: 26,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.04)",
  boxShadow:
    "0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 32px -16px rgba(0,0,0,0.6)",
  boxSizing: "border-box",
};

// ── camera ──
// Scene coords: the 1920x1080 frame. Inner app coords get mapped through the
// preview window (scaled by WIN_SCALE, offset by the window position + chrome).
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

const FULL = { cx: 960, cy: 540, z: 1 };
const SHOT_TASKS_A = focusOn({ x: RIGHT_X - 14, y: 278, w: LEFT_W + 28, h: 570 });
const SHOT_TASKS_B = focusOn({ x: RIGHT_X - 14, y: 340, w: LEFT_W + 28, h: 570 });
const SHOT_STATS = focusOn({ x: COL_X, y: 128, w: COL_W, h: 170 }, 1.18);
const SHOT_CAL = focusOn({ x: COL_X - 14, y: 278, w: LEFT_W + 28, h: 470 }, 1.2);

// keyframe times            settle      → tasks    hold/pan   → stats    hold  → calendar  hold  → full
const CAM_T = [0, 44, 60, 92, 300, 336, 386, 420, 462, 504];
const CAM_CX = [960, 960, 960, SHOT_TASKS_A.cx, SHOT_TASKS_B.cx, SHOT_STATS.cx, SHOT_STATS.cx, SHOT_CAL.cx, SHOT_CAL.cx, FULL.cx];
const CAM_CY = [540, 540, 540, SHOT_TASKS_A.cy, SHOT_TASKS_B.cy, SHOT_STATS.cy, SHOT_STATS.cy, SHOT_CAL.cy, SHOT_CAL.cy, FULL.cy];
const CAM_Z = [1.045, 1, 1, SHOT_TASKS_A.z, SHOT_TASKS_A.z * 1.04, SHOT_STATS.z, SHOT_STATS.z * 1.03, SHOT_CAL.z, SHOT_CAL.z * 1.03, 1];

// ── small helpers ──
export const Icon: React.FC<{
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

export const ICONS = {
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
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  mapPin: (
    <>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx={12} cy={10} r={3} />
    </>
  ),
};

export const LyknMark: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox={ICON_VIEWBOX} style={{ flexShrink: 0 }}>
    <path d={ICON_PATH} fill="#f2f2f2" />
  </svg>
);

export const RailBtn: React.FC<{ active?: boolean; children: React.ReactNode }> = ({
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

export const Badge: React.FC<{ bg: string; color: string; children: React.ReactNode }> = ({
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

// quick scale pop when a number changes
export function popAt(frame: number, at: number | null) {
  if (at == null || frame < at) return 1;
  return interpolate(frame, [at, at + 5, at + 14], [1, 1.22, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

export const StatTile: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: number | string;
  pop?: number;
  tone?: "default" | "accent";
}> = ({ icon, label, value, pop = 1, tone = "default" }) => (
  <div
    style={{
      borderRadius: 18,
      border: "1px solid rgba(255,255,255,0.08)",
      background: "rgba(255,255,255,0.04)",
      padding: "16px 18px",
      boxSizing: "border-box",
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
    <div
      style={{
        marginTop: 6,
        fontSize: 30,
        fontWeight: 600,
        color: tone === "accent" ? BLUE_400 : TXT_90,
        transform: `scale(${pop})`,
        transformOrigin: "left center",
      }}
    >
      {value}
    </div>
  </div>
);

export const SectionTitle: React.FC<{ children: React.ReactNode; right?: React.ReactNode }> = ({
  children,
  right,
}) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
    <h2 style={{ fontSize: 19, fontWeight: 600, color: TXT_90, margin: 0, letterSpacing: "-0.01em" }}>{children}</h2>
    {right ? <div style={{ marginLeft: "auto" }}>{right}</div> : null}
  </div>
);

export const AddNewPill: React.FC = () => (
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

// ── task row ──
export const TaskRow: React.FC<{
  title: string;
  due?: string;
  priority?: Priority;
  done?: boolean;
  doneProgress?: number; // 0..1 for the check-off transition
  enter?: number; // 0..1 spring for newly committed rows
}> = ({ title, due, priority = "normal", done, doneProgress = done ? 1 : 0, enter = 1 }) => {
  const priColor =
    priority === "high" ? "#ef4444" : priority === "low" ? "rgba(255,255,255,0.3)" : BLUE_400;
  const isDone = doneProgress > 0.5;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "10px 10px",
        borderRadius: 16,
        opacity: Math.min(1, enter * 1.2),
        transform: `translateY(${(1 - enter) * 14}px) scale(${0.96 + enter * 0.04})`,
        background: enter < 0.9 ? "rgba(96,165,250,0.07)" : "transparent",
      }}
    >
      {isDone ? (
        <Icon size={21} color={GREEN_400}>
          {ICONS.checkCircle}
        </Icon>
      ) : (
        <Icon size={21} color="rgba(255,255,255,0.3)">
          {ICONS.circle}
        </Icon>
      )}
      {!isDone && priority !== "normal" ? (
        <span style={{ width: 6, height: 6, borderRadius: 99, background: priColor, flexShrink: 0 }} />
      ) : null}
      <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
        <div style={{ fontSize: 16, color: isDone ? TXT_35 : TXT_90 }}>{title}</div>
        {/* animated strike-through */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: "50%",
            height: 1.5,
            width: `${doneProgress * 100}%`,
            background: TXT_35,
          }}
        />
      </div>
      {due ? (
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.02em",
            padding: "2px 9px",
            borderRadius: 99,
            background: isDone ? "transparent" : "rgba(245,158,11,0.10)",
            color: isDone ? TXT_35 : AMBER,
          }}
        >
          {due}
        </span>
      ) : null}
    </div>
  );
};

// ── event row ──
export const EventRow: React.FC<{
  day: number;
  weekday: string;
  title: string;
  when: string;
  location?: string;
}> = ({ day, weekday, title, when, location }) => (
  <div
    style={{
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
        <span style={{ fontSize: 12, fontWeight: 500, padding: "2px 9px", borderRadius: 99, background: BLUE_500_10, color: BLUE_400 }}>
          Upcoming
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

// ── mini calendar ──
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const FIRST_WEEKDAY = 6; // August 2026 starts Saturday
const DAYS_IN_MONTH = 31;
const TODAY = 12;

export type CalendarMarks = Record<
  number,
  { event?: boolean; taskAppear?: number; task?: boolean }
>;

export const MiniCalendar: React.FC<{
  frame: number;
  pulse: number;
  marks?: CalendarMarks;
}> = ({ frame, pulse, marks: marksProp }) => {
  const cells: ({ day: number } | null)[] = [];
  for (let i = 0; i < FIRST_WEEKDAY; i++) cells.push(null);
  for (let d = 1; d <= DAYS_IN_MONTH; d++) cells.push({ day: d });
  while (cells.length % 7 !== 0) cells.push(null);

  // dayNumber -> { event?: static, taskAppear?: frame }
  let marks: CalendarMarks = marksProp ?? {
    12: { event: true },
    14: { event: true, task: true },
    20: { task: true },
  };
  if (!marksProp) {
    marks = { ...marks };
    for (const t of TYPED_TASKS) {
      if (t.calDay != null) marks[t.calDay] = { ...(marks[t.calDay] ?? {}), taskAppear: t.commit };
    }
  }

  return (
    <div style={{ ...CARD, padding: 20, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <h2 style={{ fontSize: 19, fontWeight: 600, color: TXT_90, margin: 0 }}>August 2026</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Icon size={16} color={TXT_45}>{ICONS.chevronLeft}</Icon>
          <span style={{ fontSize: 12, color: TXT_55, padding: "0 6px" }}>Today</span>
          <Icon size={16} color={TXT_45}>{ICONS.chevronRight}</Icon>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", rowGap: 0, textAlign: "center" }}>
        {WEEKDAYS.map((w) => (
          <div key={w} style={{ fontSize: 10.5, fontWeight: 500, color: TXT_35, paddingBottom: 3 }}>
            {w}
          </div>
        ))}
        {cells.map((c, i) => {
          if (!c) return <div key={i} />;
          const isToday = c.day === TODAY;
          const mark = marks[c.day];
          const taskOpacity =
            mark?.task
              ? 1
              : mark?.taskAppear != null
                ? interpolate(frame, [mark.taskAppear, mark.taskAppear + 12], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  })
                : 0;
          return (
            <div key={i} style={{ display: "flex", justifyContent: "center", padding: "2px 0" }}>
              <div
                style={{
                  position: "relative",
                  width: 37,
                  height: 37,
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
                {isToday && pulse > 0 ? (
                  <span
                    style={{
                      position: "absolute",
                      inset: -3,
                      borderRadius: 99,
                      border: "1.5px solid rgba(255,255,255,0.85)",
                      transform: `scale(${1 + pulse * 0.35})`,
                      opacity: (1 - pulse) * 0.9,
                    }}
                  />
                ) : null}
                {c.day}
                {mark ? (
                  <span style={{ position: "absolute", bottom: 3, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 2 }}>
                    {mark.event ? (
                      <span style={{ width: 4, height: 4, borderRadius: 99, background: isToday ? "rgba(0,0,0,0.8)" : "#3b82f6" }} />
                    ) : null}
                    {(mark.task || mark.taskAppear != null) ? (
                      <span style={{ width: 4, height: 4, borderRadius: 99, background: isToday ? "rgba(0,0,0,0.8)" : TEAL, opacity: taskOpacity }} />
                    ) : null}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10, display: "flex", justifyContent: "center", gap: 18, fontSize: 11, color: TXT_45 }}>
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

export const LyknProjectsZoom: React.FC<{ black?: boolean }> = ({ black = false }) => {
  // Scale the clock so the whole timeline plays back PROJECTS_ZOOM_SPEED× faster.
  const frame = useCurrentFrame() * PROJECTS_ZOOM_SPEED;
  const { fps } = useVideoConfig();

  // ── camera ──
  const camOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE } as const;
  const cx = interpolate(frame, CAM_T, CAM_CX, camOpts);
  const cy = interpolate(frame, CAM_T, CAM_CY, camOpts);
  const z = interpolate(frame, CAM_T, CAM_Z, camOpts);

  // ── typing state ──
  const activeTyped = TYPED_TASKS.find((t) => frame >= t.typeStart && frame < t.commit);
  const typedText = activeTyped
    ? activeTyped.title.slice(
        0,
        Math.round(
          interpolate(frame, [activeTyped.typeStart, activeTyped.typeEnd], [0, activeTyped.title.length], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        )
      )
    : "";
  const caretOn = activeTyped != null && Math.floor(frame / 8) % 2 === 0;
  const inputActive = activeTyped != null;

  // committed rows spring in
  const committed = TYPED_TASKS.filter((t) => frame >= t.commit);

  // check-off transition on the first base task
  const doneProgress = interpolate(frame, [CHECK_OFF_AT, CHECK_OFF_AT + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  // ── stats ──
  const doneCount = frame >= CHECK_OFF_AT ? 1 : 0;
  const openCount = BASE_TASKS.length + committed.length - doneCount;
  const statChanges = [...TYPED_TASKS.map((t) => t.commit), CHECK_OFF_AT].filter((f) => frame >= f);
  const lastStatChange = statChanges.length ? Math.max(...statChanges) : null;
  const openPop = popAt(frame, lastStatChange);
  const donePop = popAt(frame, frame >= CHECK_OFF_AT ? CHECK_OFF_AT : null);

  // calendar today-pulse while the camera sits on the calendar (f 420–462)
  const pulse =
    frame >= 424 && frame <= 466 ? ((frame - 424) % 22) / 22 : 0;

  return (
    <AbsoluteFill
      style={{
        background: black ? "#000000" : "#161616",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      {/* backdrop stays fixed while the camera zooms */}
      {!black ? <SceneBackground /> : null}
      {/* camera rig: transforms the whole scene (window) */}
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

                {/* ── header ── */}
                <div style={{ position: "absolute", left: COL_X, top: 32, width: COL_W }}>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, color: TXT_45, marginBottom: 12 }}>
                    <Icon size={14} color={TXT_45}>{ICONS.arrowLeft}</Icon>
                    All projects
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                    <Icon size={24} color={TXT_55}>{ICONS.folder}</Icon>
                    <span style={{ fontSize: 32, fontWeight: 600, color: TXT, letterSpacing: "-0.02em" }}>{PROJECT_NAME}</span>
                    <Badge bg="rgba(34,197,94,0.10)" color={GREEN_400}>Active</Badge>
                    <Badge bg={BLUE_500_10} color={BLUE_400}>AI focus</Badge>
                    <div style={{ flex: 1 }} />
                    <span style={{ fontSize: 13, color: TXT_35 }}>used just now · {openCount + doneCount + 2} items</span>
                  </div>
                </div>

                {/* ── stat tiles ── */}
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
                  <StatTile icon={ICONS.listTodo} label="Open tasks" value={openCount} pop={openPop} />
                  <StatTile icon={ICONS.clock} label="Overdue" value={0} />
                  <StatTile icon={ICONS.checkCircle} label="Done · 7d" value={doneCount} pop={donePop} />
                  <StatTile icon={ICONS.calendarPlus} label="Events · 7d" value={2} tone="accent" />
                </div>

                {/* ── left: calendar ── */}
                <div style={{ position: "absolute", left: COL_X, top: 290, width: LEFT_W, height: 446 }}>
                  <MiniCalendar frame={frame} pulse={pulse} />
                </div>

                {/* ── left: events ── */}
                <div style={{ position: "absolute", left: COL_X, top: 754, width: LEFT_W, height: 286, ...CARD, padding: 20 }}>
                  <SectionTitle right={<AddNewPill />}>Your events</SectionTitle>
                  <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                    <EventRow day={12} weekday="WED" title="Launch kickoff" when="Wed, Aug 12 · 9:00 AM" location="Zoom" />
                    <EventRow day={14} weekday="FRI" title="Beta feedback review" when="Fri, Aug 14 · 2:00 PM" />
                  </div>
                </div>

                {/* ── right: todo list ── */}
                <div style={{ position: "absolute", left: RIGHT_X, top: 290, width: LEFT_W, height: 750, ...CARD, padding: 22 }}>
                  <SectionTitle right={<AddNewPill />}>
                    Todo list{" "}
                    <span style={{ fontSize: 13, fontWeight: 400, color: TXT_45 }}>{openCount} open</span>
                  </SectionTitle>

                  {/* add-task input */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      fontSize: 15,
                      padding: "11px 14px",
                      borderRadius: 12,
                      border: `1px solid ${inputActive ? "rgba(59,130,246,0.45)" : "rgba(255,255,255,0.1)"}`,
                      background: inputActive ? "rgba(59,130,246,0.05)" : "rgba(255,255,255,0.03)",
                      boxShadow: inputActive ? "0 0 0 3px rgba(59,130,246,0.12)" : "none",
                      marginBottom: 12,
                    }}
                  >
                    <Icon size={15} color={inputActive ? BLUE_400 : TXT_35}>{ICONS.plus}</Icon>
                    <span style={{ color: typedText ? TXT : TXT_35 }}>
                      {typedText || "Add a task…"}
                      {caretOn ? <span style={{ color: BLUE_400 }}>|</span> : null}
                    </span>
                  </div>

                  {/* rows */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <TaskRow
                      title={BASE_TASKS[0].title}
                      due={BASE_TASKS[0].due}
                      priority={BASE_TASKS[0].priority}
                      doneProgress={doneProgress}
                    />
                    <TaskRow title={BASE_TASKS[1].title} due={BASE_TASKS[1].due} priority={BASE_TASKS[1].priority} />
                    {committed.map((t) => {
                      const enter = spring({
                        frame: frame - t.commit,
                        fps,
                        config: { damping: 15, stiffness: 160 },
                      });
                      return (
                        <TaskRow
                          key={t.title}
                          title={t.title}
                          due={t.due}
                          priority={t.priority}
                          enter={enter}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
