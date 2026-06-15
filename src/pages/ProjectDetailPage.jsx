// /projects/:projectId — the full-page workspace for a single project.
//
// Where ProjectsPage is the index (list + create), this is the project itself:
// a dashboard that pulls together everything happening under it — the tasks
// and calendar deadlines linked to it (lykn_todos / lykn_events, scoped by
// project_id), the knowledge clustered into it (vault items + neurons), the
// AI working-memory pushes from connected clients, and charts that summarize
// the lot. Tasks/events can be added here with deadlines and they're instantly
// visible to every connected AI client (and vice-versa, live, via realtime).
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  LabelList,
} from "recharts";
import {
  ArrowDownToLine,
  ArrowLeft,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  Crosshair,
  Flag,
  FolderKanban,
  ListTodo,
  MapPin,
  Pause,
  Play,
  Library,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";
import { supabase } from "@/lib/supabase";
import {
  addNeuronsToProject,
  deleteUserProject,
  editProjectStateUpdate,
  getActiveProjectId,
  listProjectPushEvents,
  listProjectStateUpdates,
  listUserProjects,
  removeNeuronFromProject,
  setActiveProjectId,
  setUserProjectStatus,
} from "@/lib/userProjects";
import {
  createProjectEvent,
  updateProjectEvent,
  createProjectTodo,
  dateInputToIso,
  dateInputToText,
  deleteProjectEvent,
  deleteProjectTodo,
  listProjectEvents,
  listProjectTodos,
  setTodoDue,
  setTodoPriority,
  setTodoStatus,
  todoDueLabel,
} from "@/lib/projectWorkspace";
import {
  ActivityChart,
  ChartTooltip,
  CompositionChart,
  KIND_META,
  NeuronPicker,
  SectionLabel,
  UpdateCard,
  relativeTime,
  splitMembers,
} from "@/components/projects/projectShared";
import VaultPickerDialog from "@/components/vault/VaultPickerDialog";
import DatePickerPopover from "@/components/ui/DatePickerPopover";
import { fetchVaultNotesByIds } from "@/lib/vault/fetchVaultNotesByIds";
import { fetchVaultFileTypeCounts, VAULT_TYPE_META } from "@/lib/vault/fetchVaultFileTypeCounts";
import { useIsDark, chartSeries, chartSlice } from "@/lib/projectChartTheme";
import { PROJECTS_CHANGED_EVENT } from "@/lib/synthesis/projectLiveSync";

const DAY_MS = 24 * 60 * 60 * 1000;

// A ms timestamp → local "YYYY-MM-DD" for binding to an <input type="date">
// (toISOString would shift the day across timezones).
function msToDateInput(ms) {
  if (ms == null) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const LOCAL_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
})();

const PRIORITY_META = {
  high: { label: "High", dot: "bg-red-500", text: "text-red-500" },
  normal: { label: "Normal", dot: "bg-blue-500 dark:bg-blue-400", text: "text-blue-500 dark:text-blue-400" },
  low: { label: "Low", dot: "bg-black/25 dark:bg-white/30", text: "text-black/40 dark:text-white/40" },
};
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

function fmtEventWhen(ev) {
  const start = new Date(ev.startsAt);
  if (Number.isNaN(start.getTime())) return "";
  const dayStr = start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (ev.allDay) return `${dayStr} · All day`;
  const timeStr = start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${dayStr} · ${timeStr}`;
}

// Shared "panel" surface — a bright, soft-shadowed rounded card matching the
// dashboard reference. One constant keeps every section visually consistent.
const CARD =
  "rounded-[1.75rem] border border-black/[0.05] dark:border-white/[0.08] bg-white dark:bg-white/[0.04] shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.08)] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_12px_32px_-16px_rgba(0,0,0,0.6)]";

// A small black pill "Add new" button, like the reference dashboard.
function AddNewButton({ onClick, active = false, label = "Add new" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-black text-white hover:bg-black/85 dark:bg-white dark:text-black dark:hover:bg-white/85 transition-colors"
    >
      {active ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
      {active ? "Cancel" : label}
    </button>
  );
}

// Local "YYYY-M-D" key for grouping/marking calendar days.
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// Status pill metadata for an event — mirrors the reference's coloured tags.
function eventStatusMeta(ev, now) {
  if (ev.status === "cancelled") {
    return { label: "Cancelled", cls: "bg-red-500/10 text-red-600 dark:text-red-400" };
  }
  const end = ev.endsAt ?? ev.startsAt;
  if (end < now) {
    return { label: "Completed", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
  }
  if (ev.startsAt <= now && end >= now) {
    return { label: "In progress", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-500" };
  }
  return { label: "Upcoming", cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400" };
}

// ---------------------------------------------------------------------------
// Month calendar — an overview grid of the project's events + task deadlines.
// Today is highlighted; days with anything scheduled get a dot. Selecting a
// day filters the events list beside it.
// ---------------------------------------------------------------------------
const WEEKDAY_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function MonthCalendar({ events, todos, selectedKey, onSelectDay }) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const todayKey = useMemo(() => dayKey(Date.now()), []);

  const marks = useMemo(() => {
    const m = new Map();
    const bump = (ms, kind) => {
      const k = dayKey(ms);
      const cur = m.get(k) || { event: false, task: false };
      cur[kind] = true;
      m.set(k, cur);
    };
    for (const e of events) if (e.startsAt != null) bump(e.startsAt, "event");
    for (const t of todos) if (t.status === "open" && t.dueAt != null) bump(t.dueAt, "task");
    return m;
  }, [events, todos]);

  const cells = useMemo(() => {
    const { year, month } = cursor;
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();
    const out = [];
    for (let i = firstWeekday - 1; i >= 0; i--) {
      const day = prevMonthDays - i;
      out.push({ day, ms: new Date(year, month - 1, day).getTime(), muted: true });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      out.push({ day: d, ms: new Date(year, month, d).getTime(), muted: false });
    }
    let trail = 1;
    while (out.length % 7 !== 0 || out.length < 42) {
      out.push({ day: trail, ms: new Date(year, month + 1, trail).getTime(), muted: true });
      trail += 1;
      if (out.length >= 42) break;
    }
    return out;
  }, [cursor]);

  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const step = (dir) => {
    setCursor((c) => {
      const m = c.month + dir;
      const year = c.year + Math.floor(m / 12);
      const month = ((m % 12) + 12) % 12;
      return { year, month };
    });
  };

  return (
    <div className={`${CARD} p-4 sm:p-5`}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold tracking-tight text-black/90 dark:text-white/90">
          {monthLabel}
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => step(-1)}
            className="w-7 h-7 inline-flex items-center justify-center rounded-full text-black/50 dark:text-white/50 hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
            title="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setCursor(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; })}
            className="text-[0.6875rem] px-2 py-1 rounded-full text-black/55 dark:text-white/55 hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
            title="Jump to today"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            className="w-7 h-7 inline-flex items-center justify-center rounded-full text-black/50 dark:text-white/50 hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
            title="Next month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-y-1 text-center">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="text-[0.625rem] font-medium tracking-wide text-black/35 dark:text-white/35 pb-1">
            {w}
          </div>
        ))}
        {cells.map((cell, i) => {
          const k = dayKey(cell.ms);
          const isToday = k === todayKey;
          const isSelected = k === selectedKey;
          const mark = marks.get(k);
          return (
            <div key={i} className="flex items-center justify-center py-0.5">
              <button
                type="button"
                onClick={() => onSelectDay(isSelected ? null : { key: k, ms: cell.ms })}
                className={`relative w-9 h-9 inline-flex items-center justify-center rounded-full text-[0.8125rem] transition-colors ${
                  isToday
                    ? "bg-black text-white dark:bg-white dark:text-black font-semibold"
                    : isSelected
                      ? "bg-blue-500/15 text-blue-600 dark:text-blue-400 font-medium"
                      : cell.muted
                        ? "text-black/25 dark:text-white/20 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                        : "text-black/70 dark:text-white/70 hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                }`}
              >
                {cell.day}
                {mark && (
                  <span className="absolute bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-0.5">
                    {mark.event && (
                      <span className={`w-1 h-1 rounded-full ${isToday ? "bg-white/90 dark:bg-black/80" : "bg-blue-500"}`} />
                    )}
                    {mark.task && (
                      <span className={`w-1 h-1 rounded-full ${isToday ? "bg-white/90 dark:bg-black/80" : "bg-teal-500"}`} />
                    )}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-center gap-4 text-[0.625rem] text-black/45 dark:text-white/45">
        <span className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500" /> Events
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-teal-500" /> Deadlines
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard summary — stat tiles + a "deadlines this week" chart.
// ---------------------------------------------------------------------------
function StatTile({ icon: Icon, label, value, tone = "default" }) {
  const toneCls =
    tone === "danger"
      ? "text-red-600 dark:text-red-400"
      : tone === "accent"
        ? "text-blue-600 dark:text-blue-400"
        : "text-black/85 dark:text-white/90";
  return (
    <div className="rounded-2xl border border-black/[0.05] dark:border-white/[0.08] bg-white dark:bg-white/[0.04] px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)] dark:shadow-none">
      <div className="flex items-center gap-1.5 text-black/45 dark:text-white/45">
        <Icon className="w-3.5 h-3.5" />
        <span className="text-[0.625rem] font-semibold uppercase tracking-wider">{label}</span>
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneCls}`}>{value}</div>
    </div>
  );
}

// Tasks + event deadlines binned into the next 7 days, so the user can see the
// shape of what's coming up at a glance.
function DeadlinesChart({ todos, events }) {
  const dark = useIsDark();
  const c = chartSeries(dark);
  const data = useMemo(() => {
    const days = [];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    for (let i = 0; i < 7; i++) {
      const dayStart = start.getTime() + i * DAY_MS;
      const dayEnd = dayStart + DAY_MS;
      const taskCount = todos.filter(
        (t) => t.status === "open" && t.dueAt != null && t.dueAt >= dayStart && t.dueAt < dayEnd,
      ).length;
      const eventCount = events.filter(
        (e) => e.startsAt >= dayStart && e.startsAt < dayEnd,
      ).length;
      days.push({
        name: new Date(dayStart).toLocaleDateString("en-US", { weekday: "short" }),
        tasks: taskCount,
        events: eventCount,
        total: taskCount + eventCount,
      });
    }
    return days;
  }, [todos, events]);

  const hasAny = data.some((d) => d.total > 0);
  if (!hasAny) {
    return (
      <p className="text-xs text-black/35 dark:text-white/35 h-28 flex items-center justify-center">
        Nothing due in the next 7 days.
      </p>
    );
  }
  return (
    <>
      <ResponsiveContainer width="100%" height={112}>
        <BarChart data={data} margin={{ top: 14, right: 4, left: 4, bottom: 0 }}>
          <XAxis
            dataKey="name"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 9, fill: "currentColor", opacity: 0.45 }}
          />
          <YAxis hide allowDecimals={false} />
          <Tooltip content={<DeadlinesTooltip />} cursor={{ fill: "currentColor", fillOpacity: 0.05 }} />
          {/* Thin separators between each stacked unit make individual
              tasks/events countable even when they share a color. */}
          <Bar dataKey="tasks" stackId="d" fill={c.tasks} fillOpacity={0.9} maxBarSize={26} stroke="#ffffff" strokeOpacity={dark ? 0.18 : 0.6} strokeWidth={1} />
          <Bar dataKey="events" stackId="d" fill={c.events} fillOpacity={0.9} radius={[4, 4, 0, 0]} maxBarSize={26} stroke="#ffffff" strokeOpacity={dark ? 0.18 : 0.6} strokeWidth={1}>
            <LabelList
              dataKey="total"
              position="top"
              formatter={(v) => (v > 0 ? v : "")}
              style={{ fontSize: 10, fontWeight: 600, fill: "currentColor", opacity: 0.55 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-1 flex items-center justify-center gap-3 text-[0.625rem] text-black/45 dark:text-white/45">
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: c.tasks }} /> Tasks
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: c.events }} /> Events
        </span>
      </div>
    </>
  );
}

// Tooltip for the deadlines chart — shows the per-day task/event breakdown so
// a day's count is readable even though tasks share one color.
function DeadlinesTooltip({ active = false, payload = null, label = "" }) {
  const dark = useIsDark();
  const c = chartSeries(dark);
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload || {};
  const tasks = row.tasks || 0;
  const events = row.events || 0;
  return (
    <div className="rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-800 px-2.5 py-1.5 text-[0.6875rem] text-black/75 dark:text-white/80 shadow-md">
      <div className="font-semibold mb-0.5">{label}</div>
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: c.tasks }} />
        {tasks} {tasks === 1 ? "task" : "tasks"}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: c.events }} />
        {events} {events === 1 ? "event" : "events"}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks — the project's lykn_todos, with add (title + priority + deadline),
// complete/reopen, priority cycle, deadline edit, and delete.
// ---------------------------------------------------------------------------
function TasksPanel({ userId, projectId, todos, onChanged }) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("normal");
  const [due, setDue] = useState("");
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const now = Date.now();

  const { openTodos, doneTodos } = useMemo(() => {
    const open = [];
    const done = [];
    for (const t of todos) {
      if (t.status === "completed") done.push(t);
      else open.push(t);
    }
    open.sort((a, b) => {
      const ra = PRIORITY_RANK[a.priority] ?? 1;
      const rb = PRIORITY_RANK[b.priority] ?? 1;
      if (ra !== rb) return ra - rb;
      const da = a.dueAt ?? Infinity;
      const db = b.dueAt ?? Infinity;
      if (da !== db) return da - db;
      return b.createdAt - a.createdAt;
    });
    done.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    return { openTodos: open, doneTodos: done };
  }, [todos]);

  const handleAdd = useCallback(async () => {
    const t = title.trim();
    if (!t || adding) return;
    setAdding(true);
    await createProjectTodo(userId, projectId, {
      title: t,
      priority,
      dueIso: dateInputToIso(due),
      dueText: dateInputToText(due),
    });
    setTitle("");
    setPriority("normal");
    setDue("");
    setAdding(false);
    setShowAdd(false);
    onChanged();
  }, [title, priority, due, adding, userId, projectId, onChanged]);

  const toggleDone = async (todo) => {
    setBusyId(todo.id);
    await setTodoStatus(userId, todo.id, todo.status === "completed" ? "open" : "completed");
    setBusyId(null);
    onChanged();
  };

  const cyclePriority = async (todo) => {
    const order = ["normal", "high", "low"];
    const next = order[(order.indexOf(todo.priority) + 1) % order.length] || "normal";
    await setTodoPriority(userId, todo.id, next);
    onChanged();
  };

  const handleDueChange = async (todo, value) => {
    if (!value) {
      await setTodoDue(userId, todo.id, null, null);
    } else {
      const iso = dateInputToIso(value);
      if (!iso) return;
      await setTodoDue(userId, todo.id, iso, dateInputToText(value));
    }
    onChanged();
  };

  const remove = async (todo) => {
    setBusyId(todo.id);
    await deleteProjectTodo(userId, todo.id);
    setBusyId(null);
    onChanged();
  };

  const renderRow = (todo) => {
    const done = todo.status === "completed";
    const overdue = !done && todo.dueAt != null && todo.dueAt <= now;
    const pri = PRIORITY_META[todo.priority] || PRIORITY_META.normal;
    const isBusy = busyId === todo.id;
    const dueDate = todo.dueAt != null ? new Date(todo.dueAt) : null;
    const hasDue = dueDate && !Number.isNaN(dueDate.getTime());
    return (
      <div
        key={todo.id}
        className="group flex items-center gap-2.5 px-2.5 py-2 rounded-2xl hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
      >
        <button
          type="button"
          disabled={isBusy}
          onClick={() => toggleDone(todo)}
          className="shrink-0 text-black/30 dark:text-white/30 hover:text-emerald-500 transition-colors disabled:opacity-50"
          title={done ? "Mark as not done" : "Mark done"}
        >
          {done ? (
            <CheckCircle2 className="w-[1.35rem] h-[1.35rem] text-emerald-500 dark:text-emerald-400" />
          ) : (
            <Circle className="w-[1.35rem] h-[1.35rem]" />
          )}
        </button>
        {!done && todo.priority !== "normal" ? (
          <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${pri.dot}`} title={`${pri.label} priority`} />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className={`text-sm leading-snug break-words ${done ? "line-through text-black/35 dark:text-white/35" : "text-black/90 dark:text-white/90"}`}>
            {todo.title}
          </div>
        </div>
        <DatePickerPopover
          value={msToDateInput(todo.dueAt)}
          onChange={(v) => handleDueChange(todo, v)}
          align="end"
          trigger={
            <button
              type="button"
              className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold tracking-wide tabular-nums transition-colors ${
                hasDue
                  ? overdue
                    ? "bg-red-500/10 text-red-600 dark:text-red-400"
                    : "bg-amber-500/10 text-amber-600 dark:text-amber-500"
                  : "text-black/30 dark:text-white/30 hover:bg-black/[0.05] dark:hover:bg-white/[0.06] opacity-0 group-hover:opacity-100"
              }`}
              title="Set / change deadline"
            >
              {hasDue ? (
                `${MONTH_ABBR[dueDate.getMonth()]} ${String(dueDate.getDate()).padStart(2, "0")}`
              ) : (
                <>
                  <CalendarClock className="w-3 h-3" />
                  Date
                </>
              )}
            </button>
          }
        />
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {!done && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => cyclePriority(todo)}
              className="p-1 rounded-md text-black/35 dark:text-white/35 hover:text-black/80 dark:hover:text-white/80 hover:bg-black/10 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
              title={`Priority: ${pri.label} (click to change)`}
            >
              <Flag className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            disabled={isBusy}
            onClick={() => remove(todo)}
            className="p-1 rounded-md text-black/35 dark:text-white/35 hover:text-red-500 hover:bg-black/10 dark:hover:bg-white/10 transition-colors disabled:opacity-50"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className={`${CARD} p-4 sm:p-5`}>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-base font-semibold tracking-tight text-black/90 dark:text-white/90">Todo list</h2>
        <span className="text-[0.6875rem] text-black/40 dark:text-white/40">
          {openTodos.length} open
        </span>
        <div className="ml-auto">
          <AddNewButton
            active={showAdd}
            onClick={() => setShowAdd((v) => !v)}
          />
        </div>
      </div>

      {showAdd && (
      <div className="flex flex-col gap-2 pb-3 mb-1 border-b border-black/[0.06] dark:border-white/[0.07]">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleAdd();
            }
          }}
          placeholder="Add a task to this project…"
          className="w-full text-sm px-3 py-2 rounded-xl border border-black/10 dark:border-white/10 bg-white/70 dark:bg-white/[0.04] outline-none focus:border-blue-500/40 placeholder:text-black/35 dark:placeholder:text-white/35"
        />
        <div className="flex items-center gap-2">
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="text-[0.75rem] px-2 py-1.5 rounded-lg border border-black/10 dark:border-white/10 bg-white/60 dark:bg-zinc-800 text-black/70 dark:text-white/70 outline-none focus:border-blue-500/40 cursor-pointer"
            title="Priority"
          >
            <option value="low">Low priority</option>
            <option value="normal">Normal priority</option>
            <option value="high">High priority</option>
          </select>
          <DatePickerPopover
            value={due}
            onChange={setDue}
            trigger={
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 text-[0.75rem] px-2.5 py-1.5 rounded-lg border transition-colors ${
                  due
                    ? "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                    : "border-black/10 dark:border-white/10 bg-white/60 dark:bg-zinc-800 text-black/55 dark:text-white/55 hover:border-blue-500/40"
                }`}
                title="Optional deadline"
              >
                <CalendarClock className="w-3.5 h-3.5" />
                {due ? dateInputToText(due) : "Deadline"}
              </button>
            }
          />
          <button
            type="button"
            disabled={!title.trim() || adding}
            onClick={() => handleAdd()}
            className="ml-auto inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>
      </div>
      )}

      <div className="mt-2 max-h-[24rem] overflow-y-auto scrollbar-hide -mx-1 px-1">
        {openTodos.length === 0 && doneTodos.length === 0 ? (
          <p className="text-xs text-black/40 dark:text-white/40 py-6 text-center">
            No tasks yet. Hit "Add new", or ask LYKN to file a task under this project.
          </p>
        ) : (
          <>
            {openTodos.length === 0 ? (
              <p className="text-xs text-black/35 dark:text-white/35 py-4 text-center">All caught up.</p>
            ) : (
              openTodos.map(renderRow)
            )}
            {doneTodos.length > 0 && (
              <div className="mt-2 pt-2 border-t border-black/[0.06] dark:border-white/[0.07]">
                <div className="px-2 pb-1 text-[0.625rem] uppercase tracking-wide text-black/30 dark:text-white/30">
                  Completed
                </div>
                {doneTodos.map(renderRow)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar — the project's lykn_events. Add (title + date + time/all-day +
// location), edit dates, delete. Read-only synced rows are shown but locked.
// ---------------------------------------------------------------------------
const EMPTY_EVENT = {
  id: null,
  title: "",
  date: "",
  allDay: false,
  startTime: "09:00",
  endTime: "10:00",
  location: "",
};

function EventsPanel({ userId, projectId, events, onChanged, filterDay = null, onClearFilter }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_EVENT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const now = Date.now();

  const { upcoming, past } = useMemo(() => {
    const up = [];
    const pa = [];
    for (const ev of events) {
      const ref = ev.endsAt ?? ev.startsAt;
      if (ref >= now - DAY_MS) up.push(ev);
      else pa.push(ev);
    }
    pa.sort((a, b) => b.startsAt - a.startsAt);
    return { upcoming: up, past: pa };
  }, [events, now]);

  // When a calendar day is selected, the list narrows to that day's events.
  const dayEvents = useMemo(() => {
    if (!filterDay) return null;
    return events
      .filter((ev) => dayKey(ev.startsAt) === filterDay.key)
      .sort((a, b) => a.startsAt - b.startsAt);
  }, [events, filterDay]);

  const resetForm = () => {
    setForm(EMPTY_EVENT);
    setError("");
    setShowForm(false);
  };

  // Open the form pre-filled to edit an existing event. Synced (read-only)
  // events can't be edited here.
  const openEdit = (ev) => {
    if (ev.readOnly) return;
    const pad = (n) => String(n).padStart(2, "0");
    const d = new Date(ev.startsAt);
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const startTime = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    let endTime = "";
    if (ev.endsAt) {
      const e = new Date(ev.endsAt);
      endTime = `${pad(e.getHours())}:${pad(e.getMinutes())}`;
    }
    setForm({
      id: ev.id,
      title: ev.title || "",
      date: dateStr,
      allDay: Boolean(ev.allDay),
      startTime: ev.allDay ? "09:00" : startTime || "09:00",
      endTime: ev.allDay ? "10:00" : endTime,
      location: ev.location || "",
    });
    setError("");
    setShowForm(true);
  };

  const handleSave = async () => {
    const title = form.title.trim();
    if (!title) {
      setError("Give the event a name.");
      return;
    }
    if (!form.date) {
      setError("Pick a date.");
      return;
    }
    let startsAt;
    let endsAt = null;
    if (form.allDay) {
      const [y, m, d] = form.date.split("-").map((n) => parseInt(n, 10));
      startsAt = new Date(y, m - 1, d, 0, 0, 0, 0);
    } else {
      startsAt = new Date(`${form.date}T${form.startTime || "09:00"}`);
      if (form.endTime) {
        endsAt = new Date(`${form.date}T${form.endTime}`);
        if (endsAt.getTime() < startsAt.getTime()) {
          setError("End time is before the start time.");
          return;
        }
      }
    }
    if (Number.isNaN(startsAt.getTime())) {
      setError("That date/time didn't parse.");
      return;
    }
    setSaving(true);
    let ok;
    if (form.id) {
      ok = await updateProjectEvent(userId, form.id, {
        title,
        startsIso: startsAt.toISOString(),
        endsIso: endsAt ? endsAt.toISOString() : null,
        allDay: form.allDay,
        location: form.location,
      });
    } else {
      ok = Boolean(
        await createProjectEvent(userId, projectId, {
          title,
          startsIso: startsAt.toISOString(),
          endsIso: endsAt ? endsAt.toISOString() : null,
          allDay: form.allDay,
          location: form.location,
          timezone: LOCAL_TZ,
        }),
      );
    }
    setSaving(false);
    if (!ok) {
      setError("Could not save the event.");
      return;
    }
    resetForm();
    onChanged();
  };

  const remove = async (ev) => {
    if (!window.confirm("Delete this event?")) return;
    setBusyId(ev.id);
    await deleteProjectEvent(userId, ev.id);
    setBusyId(null);
    onChanged();
  };

  const renderRow = (ev) => {
    const isBusy = busyId === ev.id;
    const status = eventStatusMeta(ev, now);
    const start = new Date(ev.startsAt);
    const dayNum = Number.isNaN(start.getTime()) ? "–" : start.getDate();
    const weekday = Number.isNaN(start.getTime())
      ? ""
      : start.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
    return (
      <button
        key={ev.id}
        type="button"
        onClick={() => openEdit(ev)}
        disabled={ev.readOnly}
        title={ev.readOnly ? undefined : "Edit event"}
        className={`group w-full text-left flex items-stretch gap-3 p-2.5 rounded-2xl border border-black/[0.05] dark:border-white/[0.06] bg-black/[0.01] dark:bg-white/[0.02] hover:border-black/[0.1] dark:hover:border-white/[0.12] hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors ${
          ev.readOnly ? "cursor-default" : "cursor-pointer"
        }`}
      >
        <div
          className="flex-shrink-0 w-11 rounded-xl flex flex-col items-center justify-center py-1.5 bg-black/[0.04] dark:bg-white/[0.06]"
          style={ev.color ? { backgroundColor: `${ev.color}1f` } : undefined}
        >
          <span
            className="text-lg font-semibold leading-none text-black/85 dark:text-white/90"
            style={ev.color ? { color: ev.color } : undefined}
          >
            {dayNum}
          </span>
          <span className="mt-0.5 text-[0.5625rem] font-medium tracking-wide text-black/40 dark:text-white/40">
            {weekday}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-black/90 dark:text-white/90 truncate">
              {ev.title}
            </span>
            {ev.readOnly && (
              <span className="flex-shrink-0 rounded-full bg-black/5 dark:bg-white/10 px-1.5 py-px text-[0.5625rem] font-medium uppercase tracking-wide text-black/45 dark:text-white/45">
                {ev.externalProvider || "Synced"}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${status.cls}`}>
              {status.label}
            </span>
            <span className="inline-flex items-center gap-1 text-[0.6875rem] text-black/45 dark:text-white/40">
              <CalendarClock className="w-3 h-3 flex-shrink-0" />
              {fmtEventWhen(ev)}
            </span>
            {ev.location && (
              <span className="inline-flex items-center gap-1 text-[0.6875rem] text-black/45 dark:text-white/40 min-w-0">
                <MapPin className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{ev.location}</span>
              </span>
            )}
          </div>
        </div>
        {!ev.readOnly && (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              if (!isBusy) remove(ev);
            }}
            className="self-start p-1 rounded-md text-black/30 dark:text-white/30 hover:text-red-500 hover:bg-black/10 dark:hover:bg-white/10 transition-colors opacity-0 group-hover:opacity-100"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </span>
        )}
      </button>
    );
  };

  const inputCls =
    "w-full text-sm px-3 py-2 rounded-xl border border-black/10 dark:border-white/10 bg-white/70 dark:bg-white/[0.04] outline-none focus:border-blue-500/40 placeholder:text-black/35 dark:placeholder:text-white/35";

  return (
    <div className={`${CARD} p-4 sm:p-5`}>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-base font-semibold tracking-tight text-black/90 dark:text-white/90">Your events</h2>
        {filterDay && (
          <button
            type="button"
            onClick={onClearFilter}
            className="inline-flex items-center gap-1 text-[0.6875rem] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 transition-colors"
            title="Show all events"
          >
            {new Date(filterDay.ms).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            <X className="w-3 h-3" />
          </button>
        )}
        <div className="ml-auto">
          <AddNewButton
            active={showForm}
            onClick={() => (showForm ? resetForm() : setShowForm(true))}
          />
        </div>
      </div>

      {showForm && (
        <div className="flex flex-col gap-2 pb-3 mb-2 border-b border-black/[0.06] dark:border-white/[0.07]">
          <input
            autoFocus
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="Event name"
            className={inputCls}
          />
          <label className="flex items-center gap-2 text-xs text-black/60 dark:text-white/60 select-none">
            <input
              type="checkbox"
              checked={form.allDay}
              onChange={(e) => setForm((f) => ({ ...f, allDay: e.target.checked }))}
            />
            All day
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              className="text-[0.75rem] px-2 py-1.5 rounded-lg border border-black/10 dark:border-white/10 bg-white/60 dark:bg-zinc-800 text-black/70 dark:text-white/70 outline-none focus:border-blue-500/40"
            />
            {!form.allDay && (
              <>
                <input
                  type="time"
                  value={form.startTime}
                  onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
                  className="text-[0.75rem] px-2 py-1.5 rounded-lg border border-black/10 dark:border-white/10 bg-white/60 dark:bg-zinc-800 text-black/70 dark:text-white/70 outline-none focus:border-blue-500/40"
                />
                <input
                  type="time"
                  value={form.endTime}
                  onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
                  className="text-[0.75rem] px-2 py-1.5 rounded-lg border border-black/10 dark:border-white/10 bg-white/60 dark:bg-zinc-800 text-black/70 dark:text-white/70 outline-none focus:border-blue-500/40"
                />
              </>
            )}
          </div>
          <input
            value={form.location}
            onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
            placeholder="Location or link (optional)"
            className={inputCls}
          />
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex items-center justify-between">
            <span className="text-[0.625rem] text-black/40 dark:text-white/40 inline-flex items-center gap-1">
              <Clock className="w-3 h-3" /> {LOCAL_TZ || "local time"}
            </span>
            <button
              type="button"
              disabled={saving || !form.title.trim()}
              onClick={handleSave}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-blue-500/90 hover:bg-blue-500 text-white disabled:opacity-40 transition-colors"
            >
              {form.id ? "Save changes" : "Add event"}
            </button>
          </div>
        </div>
      )}

      <div className="max-h-[24rem] overflow-y-auto scrollbar-hide -mx-1 px-1">
        {dayEvents ? (
          dayEvents.length === 0 ? (
            <p className="text-xs text-black/40 dark:text-white/40 py-6 text-center">
              Nothing scheduled on {new Date(filterDay.ms).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">{dayEvents.map(renderRow)}</div>
          )
        ) : upcoming.length === 0 && past.length === 0 ? (
          <p className="text-xs text-black/40 dark:text-white/40 py-6 text-center">
            No events yet. Add one, or ask LYKN to put something on the calendar for this project.
          </p>
        ) : (
          <>
            <div className="px-1 pb-1.5 text-[0.625rem] uppercase tracking-wide text-black/30 dark:text-white/30">
              Upcoming
            </div>
            {upcoming.length === 0 ? (
              <p className="text-xs text-black/35 dark:text-white/35 py-3 text-center">Nothing upcoming.</p>
            ) : (
              <div className="flex flex-col gap-1.5">{upcoming.map(renderRow)}</div>
            )}
            {past.length > 0 && (
              <div className="mt-3 pt-3 border-t border-black/[0.06] dark:border-white/[0.07]">
                <div className="px-1 pb-1.5 text-[0.625rem] uppercase tracking-wide text-black/30 dark:text-white/30">
                  Past
                </div>
                <div className="flex flex-col gap-1.5">{past.map(renderRow)}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function ProjectDetailPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;
  const [showNeuronPicker, setShowNeuronPicker] = useState(false);
  const [vaultPanelOpen, setVaultPanelOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedDay, setSelectedDay] = useState(null);
  const dark = useIsDark();

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["lykn_projects", userId || "guest"],
    queryFn: () => listUserProjects(userId),
    staleTime: 60 * 1000,
  });
  const project = useMemo(
    () => projects.find((p) => p.id === projectId) || null,
    [projects, projectId],
  );

  const { data: focusProjectId = null } = useQuery({
    queryKey: ["lykn_active_project", userId || "guest"],
    queryFn: () => getActiveProjectId(userId),
    enabled: !!userId,
    staleTime: 30 * 1000,
  });

  const { data: updates = [], isLoading: updatesLoading } = useQuery({
    queryKey: ["lykn_project_updates", userId || "guest", projectId],
    queryFn: () => listProjectStateUpdates(userId, projectId),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });

  const { data: pushEvents = [] } = useQuery({
    queryKey: ["lykn_project_pushes", userId || "guest", projectId],
    queryFn: () => listProjectPushEvents(userId, projectId),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });

  const { data: todos = [] } = useQuery({
    queryKey: ["lykn_project_todos", userId || "guest", projectId],
    queryFn: () => listProjectTodos(userId, projectId),
    enabled: !!userId && !!projectId,
    staleTime: 15 * 1000,
  });

  const { data: events = [] } = useQuery({
    queryKey: ["lykn_project_events", userId || "guest", projectId],
    queryFn: () => listProjectEvents(userId, projectId),
    enabled: !!userId && !!projectId,
    staleTime: 15 * 1000,
  });

  // Vault note ids in this project (members stored as `vault_<id>`), used to
  // tally the "What's inside" wheel by file type.
  const vaultNoteIds = useMemo(() => {
    if (!project) return [];
    return project.members
      .map((m) => m.nodeId)
      .filter((id) => id.startsWith("vault_"))
      .map((id) => id.slice("vault_".length));
  }, [project]);

  const { data: vaultTypeCounts = null } = useQuery({
    queryKey: ["lykn_project_vault_types", userId || "guest", projectId, vaultNoteIds.join(",")],
    queryFn: () => fetchVaultFileTypeCounts(userId, vaultNoteIds),
    enabled: !!userId && vaultNoteIds.length > 0,
    staleTime: 60 * 1000,
  });

  // The donut data: file-type slices from vault items, plus synthesis-kind
  // slices (concepts/beliefs/facts/…) so everything inside the project shows.
  const compositionData = useMemo(() => {
    if (!project) return [];
    const groups = splitMembers(project.members);
    const out = [];
    const counts = vaultTypeCounts || {};
    for (const [key, meta] of Object.entries(VAULT_TYPE_META)) {
      const n = counts[key] || 0;
      if (n > 0) out.push({ name: meta.label, count: n, color: chartSlice(dark, key) });
    }
    // Vault counts still loading: show one provisional slice so it isn't empty.
    const vaultTotal = Object.values(counts).reduce((s, n) => s + n, 0);
    if (vaultTotal === 0 && groups.vault.length > 0) {
      out.push({ name: KIND_META.vault.title, count: groups.vault.length, color: chartSlice(dark, "vault") });
    }
    for (const key of ["concept", "belief", "fact", "rule", "other"]) {
      const n = groups[key].length;
      if (n > 0) out.push({ name: KIND_META[key].title, count: n, color: chartSlice(dark, key) });
    }
    return out;
  }, [project, vaultTypeCounts, dark]);

  const refetchProjects = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["lykn_projects"] });
    queryClient.invalidateQueries({ queryKey: ["lykn_project_updates"] });
    queryClient.invalidateQueries({ queryKey: ["lykn_project_pushes"] });
    queryClient.invalidateQueries({ queryKey: ["lykn_active_project", userId || "guest"] });
  }, [queryClient, userId]);

  const refetchTodos = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["lykn_project_todos", userId || "guest", projectId] }),
    [queryClient, userId, projectId],
  );
  const refetchEvents = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["lykn_project_events", userId || "guest", projectId] }),
    [queryClient, userId, projectId],
  );

  // Live sync — reflect AI/voice writes to tasks, events, and project state
  // without a manual refresh (mirrors LyknTodosPanel / LyknCalendarDialog).
  useEffect(() => {
    if (!userId) return undefined;
    const channel = supabase
      .channel(`project-workspace:${userId}:${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lykn_todos", filter: `user_id=eq.${userId}` },
        () => refetchTodos(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lykn_events", filter: `user_id=eq.${userId}` },
        () => refetchEvents(),
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [userId, projectId, refetchTodos, refetchEvents]);

  useEffect(() => {
    const onChange = () => refetchProjects();
    window.addEventListener(PROJECTS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, onChange);
  }, [refetchProjects]);

  // Derived dashboard numbers.
  const now = Date.now();
  const stats = useMemo(() => {
    const open = todos.filter((t) => t.status === "open");
    const overdue = open.filter((t) => t.dueAt != null && t.dueAt <= now).length;
    const doneThisWeek = todos.filter(
      (t) => t.status === "completed" && t.completedAt != null && t.completedAt >= now - 7 * DAY_MS,
    ).length;
    const upcomingEvents = events.filter((e) => e.startsAt >= now && e.startsAt <= now + 7 * DAY_MS).length;
    return { open: open.length, overdue, doneThisWeek, upcomingEvents };
  }, [todos, events, now]);

  const handleAddMember = async (member) => {
    setAdding(true);
    try {
      await addNeuronsToProject(userId, projectId, [member]);
      refetchProjects();
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveMember = async (nodeId) => {
    await removeNeuronFromProject(userId, projectId, nodeId);
    refetchProjects();
  };

  // The vault side panel returns the full selected set (baseline + new) as raw
  // note ids. We add only the ones not already clustered, resolving titles so
  // each lands with a readable label (members are stored as `vault_<noteId>`).
  const handleAddVaultFiles = async (noteIds) => {
    if (!project || !Array.isArray(noteIds) || noteIds.length === 0) return;
    const existing = new Set(
      project.members
        .map((m) => m.nodeId)
        .filter((id) => id.startsWith("vault_"))
        .map((id) => id.slice("vault_".length)),
    );
    const newIds = noteIds.map((id) => String(id).trim()).filter((id) => id && !existing.has(id));
    if (newIds.length === 0) return;
    setAdding(true);
    try {
      let titleById = new Map();
      try {
        const notes = await fetchVaultNotesByIds(userId, newIds);
        titleById = new Map(notes.map((n) => [String(n.id), n.title]));
      } catch {
        /* fall back to a generic label if the title lookup fails */
      }
      const members = newIds.map((id) => ({
        nodeId: `vault_${id}`,
        label: titleById.get(id) || "Vault item",
        kind: "vault",
      }));
      await addNeuronsToProject(userId, projectId, members);
      refetchProjects();
    } finally {
      setAdding(false);
    }
  };

  const handleEditUpdate = async (update, newValue) => {
    await editProjectStateUpdate(userId, projectId, update, newValue);
    refetchProjects();
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-black/40 dark:text-white/40">
        Loading project…
      </div>
    );
  }

  if (!project) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-center px-6">
        <FolderKanban className="w-8 h-8 text-black/30 dark:text-white/30" />
        <p className="text-sm text-black/60 dark:text-white/60">This project doesn't exist or was deleted.</p>
        <button
          type="button"
          onClick={() => navigate("/projects")}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to projects
        </button>
      </div>
    );
  }

  const isActive = project.status === "active";
  const isFocus = focusProjectId === project.id;
  const groups = splitMembers(project.members);
  const existingNodeIds = new Set(project.members.map((m) => m.nodeId));
  // Vault note ids already in the project (members are stored `vault_<id>`),
  // so the vault picker opens with them pre-selected.
  const committedVaultNoteIds = project.members
    .map((m) => m.nodeId)
    .filter((id) => id.startsWith("vault_"))
    .map((id) => id.slice("vault_".length));

  const handleToggleStatus = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await setUserProjectStatus(userId, project.id, isActive ? "archived" : "active");
      if (isActive && isFocus) await setActiveProjectId(userId, null);
      refetchProjects();
    } finally {
      setBusy(false);
    }
  };

  const handleToggleFocus = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await setActiveProjectId(userId, isFocus ? null : project.id);
      refetchProjects();
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${project.name}"? This cannot be undone.`)) return;
    await deleteUserProject(userId, project.id);
    refetchProjects();
    navigate("/projects");
  };

  const actionBtn = (active) =>
    `inline-flex items-center gap-1.5 text-[0.6875rem] px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${
      active
        ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
        : "bg-black/[0.04] dark:bg-white/[0.06] text-black/65 dark:text-white/70 hover:bg-blue-500/10 hover:text-blue-600 dark:hover:text-blue-400"
    }`;

  return (
    <div className="min-h-screen bg-transparent text-black dark:text-white">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Top bar */}
        <button
          type="button"
          onClick={() => navigate("/projects")}
          className="inline-flex items-center gap-1.5 text-xs text-black/50 dark:text-white/50 hover:text-black/80 dark:hover:text-white/80 transition-colors mb-4"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          All projects
        </button>

        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FolderKanban className="w-5 h-5 flex-shrink-0 text-black/55 dark:text-white/55" />
              <h1 className="text-2xl font-semibold tracking-tight text-black/90 dark:text-white truncate">
                {project.name}
              </h1>
              <span
                className={`text-[0.625rem] px-1.5 py-0.5 rounded-full ${
                  isActive
                    ? "bg-green-500/10 text-green-600 dark:text-green-400"
                    : "bg-black/[0.06] dark:bg-white/[0.08] text-black/50 dark:text-white/50"
                }`}
              >
                {isActive ? "Active" : "Deactivated"}
              </span>
              {isFocus && (
                <span className="text-[0.625rem] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400">
                  AI focus
                </span>
              )}
            </div>
            <p className="text-xs text-black/45 dark:text-white/50 mt-1">
              {project.description || "No description."}{" "}
              <span className="text-black/35 dark:text-white/35">
                · used {relativeTime(project.lastActiveAt)} · {project.pushCount} AI push
                {project.pushCount === 1 ? "" : "es"} · {project.members.length} item
                {project.members.length === 1 ? "" : "s"}
              </span>
            </p>
          </div>
        </div>

        {/* Action bar */}
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setShowNeuronPicker(false);
              setVaultPanelOpen(true);
            }}
            className={actionBtn(vaultPanelOpen)}
          >
            <Library className="w-3 h-3" />
            Add from vault
          </button>
          <button
            type="button"
            onClick={() => setShowNeuronPicker((v) => !v)}
            className={actionBtn(showNeuronPicker)}
          >
            <Plus className="w-3 h-3" />
            Add neurons
          </button>
          <div className="flex-1" />
          <button
            type="button"
            disabled={busy || !isActive}
            onClick={handleToggleFocus}
            title={isFocus ? "Stop pointing AI clients at this project" : "Make this the project AI clients pick up first"}
            className={actionBtn(isFocus)}
          >
            <Crosshair className="w-3 h-3" />
            {isFocus ? "AI focus ✓" : "Set AI focus"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleToggleStatus}
            title={isActive ? "Archive — hides it from AI context" : "Reactivate this project"}
            className={actionBtn(false)}
          >
            {isActive ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            {isActive ? "Deactivate" : "Activate"}
          </button>
        </div>

        {showNeuronPicker && (
          <NeuronPicker userId={userId} existingNodeIds={existingNodeIds} onAdd={handleAddMember} adding={adding} />
        )}

        {/* Stat tiles */}
        <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile icon={ListTodo} label="Open tasks" value={stats.open} />
          <StatTile icon={CalendarClock} label="Overdue" value={stats.overdue} tone={stats.overdue > 0 ? "danger" : "default"} />
          <StatTile icon={CheckCircle2} label="Done · 7d" value={stats.doneThisWeek} />
          <StatTile icon={CalendarPlus} label="Events · 7d" value={stats.upcomingEvents} tone="accent" />
        </div>

        {/* Charts — graphs up top */}
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className={`${CARD} p-4`}>
            <SectionLabel>Due next 7 days</SectionLabel>
            <div className="mt-1 text-black/70 dark:text-white/70">
              <DeadlinesChart todos={todos} events={events} />
            </div>
          </div>
          <div className={`${CARD} p-4`}>
            <SectionLabel>What's inside</SectionLabel>
            <div className="mt-1 text-black/70 dark:text-white/70">
              <CompositionChart data={compositionData} />
            </div>
          </div>
          <div className={`${CARD} p-4`}>
            <SectionLabel>AI pushes · last 8 weeks</SectionLabel>
            <div className="mt-1 text-black/70 dark:text-white/70">
              <ActivityChart pushEvents={pushEvents} />
            </div>
          </div>
        </div>

        {/* Calendar + events */}
        <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
          <MonthCalendar
            events={events}
            todos={todos}
            selectedKey={selectedDay?.key || null}
            onSelectDay={setSelectedDay}
          />
          <EventsPanel
            userId={userId}
            projectId={projectId}
            events={events}
            onChanged={refetchEvents}
            filterDay={selectedDay}
            onClearFilter={() => setSelectedDay(null)}
          />
        </div>

        {/* Messages / AI updates + Todo list */}
        <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
          <div className={`${CARD} p-4 sm:p-5`}>
            <div className="flex items-center gap-2 mb-3">
              <ArrowDownToLine className="w-4 h-4 text-black/45 dark:text-white/45" />
              <h2 className="text-base font-semibold tracking-tight text-black/90 dark:text-white/90">
                Messages &amp; AI updates
              </h2>
            </div>
            {updatesLoading ? (
              <p className="text-xs text-black/40 dark:text-white/40">Loading updates…</p>
            ) : updates.length === 0 ? (
              <p className="text-xs text-black/40 dark:text-white/40">
                No updates yet. Connected AI clients push their working memory here as you work.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5 max-h-[24rem] overflow-y-auto scrollbar-hide -mx-1 px-1">
                {updates.map((u) => (
                  <UpdateCard key={u.id} update={u} onSave={handleEditUpdate} />
                ))}
              </div>
            )}
          </div>
          <TasksPanel userId={userId} projectId={projectId} todos={todos} onChanged={refetchTodos} />
        </div>

        {/* Knowledge / members */}
        <div className={`mt-3 ${CARD} p-4 sm:p-5`}>
          <SectionLabel>Knowledge in this project</SectionLabel>
          {project.members.length === 0 ? (
            <p className="text-xs text-black/40 dark:text-white/40 mt-2">
              Nothing saved into this project yet — add vault items or neurons above.
            </p>
          ) : (
            <div className="mt-2">
              {Object.entries(KIND_META).map(([key, { title, icon: Icon }]) => {
                const items = groups[key];
                if (items.length === 0) return null;
                return (
                  <div key={key} className="mb-3">
                    <SectionLabel>{title}</SectionLabel>
                    <div className="mt-1 flex flex-col gap-0.5">
                      {items.map((m) => (
                        <div
                          key={m.nodeId}
                          className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-blue-500/[0.06] transition-colors"
                        >
                          <Icon className="w-3.5 h-3.5 flex-shrink-0 text-black/40 dark:text-white/40" />
                          <span className="flex-1 min-w-0 truncate text-xs text-black/70 dark:text-white/70">
                            {m.label || m.nodeId}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRemoveMember(m.nodeId)}
                            className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-black/40 dark:text-white/40 hover:text-red-500 transition-all"
                            title="Remove from project"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={handleDelete}
            className="inline-flex items-center gap-1.5 text-[0.6875rem] px-2 py-1 rounded-md text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            Delete project
          </button>
        </div>
      </div>

      {/* Vault picker pop-up — a centered modal (like the chat page's vault)
          that embeds the real /vault page so the user browses and multi-selects
          their files, then adds the new ones to the project. */}
      <VaultPickerDialog
        open={vaultPanelOpen}
        onClose={() => setVaultPanelOpen(false)}
        committedNoteIds={committedVaultNoteIds}
        onAddFiles={handleAddVaultFiles}
      />
    </div>
  );
}
