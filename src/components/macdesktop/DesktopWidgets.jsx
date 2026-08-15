import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  ArrowUpDown,
  Check,
  ChevronRight,
  Circle,
  File,
  FileText,
  Folder,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  Grid2x2,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  Link2,
  Lock,
  Music,
  Pencil,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Video,
  Wallpaper,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { desktopHotkeyLabel } from "@/lib/desktopHotkey";
import { getActiveProjectId, listUserProjects } from "@/lib/userProjects";
import { relativeTime } from "@/components/projects/projectShared";
import { WIDGET_SURFACE, rowsForSize } from "@/components/macdesktop/widgets/shared";
import { readWidgetLayout, seedLayoutFromToggles } from "@/lib/desktopWidgets";

/**
 * macOS-style desktop pieces for the Studio Home tab, sitting on the blank
 * desktop like Sonoma widgets. Calendar mirrors the system Calendar widget
 * (red weekday, big day number, upcoming events) with a + to add an event;
 * To-dos and Projects are optional Home widgets (Settings → Display); Files
 * is a big desktop icon that opens the Files tab.
 */

// These sit on the Home drag surface — no-drag restores their clicks.
const NO_DRAG = { WebkitAppRegion: "no-drag" };

/* Widgets fill the box the canvas gives them — the size the user picked in the
 * widget's own menu — so nothing below sets a width or a height. */
const WIDGET = `${WIDGET_SURFACE} h-full w-full overflow-hidden`;

/* Home widgets (Settings → Display, and the welcome walkthrough). Calendar /
 * Vault / Files stay on by default; To-dos and Projects are opt-in. Stored on
 * the same lykinsai_settings blob as theme so one persist path covers both. */
const SETTINGS_KEY = "lykinsai_settings";
/* The picks the walkthrough and Settings both offer, in desktop order. */
export const HOME_WIDGETS = [
  {
    id: "calendar",
    label: "Calendar",
    description: "Today's date and your next events.",
    defaultOn: true,
  },
  {
    id: "monthCalendar",
    label: "Month",
    description: "A mini month grid, macOS style.",
    defaultOn: true,
  },
  {
    id: "clock",
    label: "Clock",
    description: "The time and today's date, at a glance.",
    defaultOn: false,
  },
  {
    id: "todos",
    label: "To-dos",
    description: "Show open tasks on the Home desktop.",
    defaultOn: false,
  },
  {
    id: "vault",
    label: "Vault",
    description: "A strip of everything you've saved.",
    defaultOn: true,
  },
  {
    id: "projects",
    label: "Projects",
    description: "Show recent projects on the Home desktop.",
    defaultOn: false,
  },
  {
    id: "files",
    label: "Files",
    description: "A desktop icon for your Mac files.",
    defaultOn: true,
  },
];
export const HOME_WIDGET_DEFAULTS = Object.fromEntries(
  HOME_WIDGETS.map((w) => [w.id, w.defaultOn]),
);
/* Stamp of the walkthrough picks this browser profile has already taken, so
 * they land once and don't stomp later Settings edits. */
const WELCOME_WIDGETS_STAMP_KEY = "lykn_home_widgets_stamp";

function readHomeWidgets() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (saved.homeWidgets && typeof saved.homeWidgets === "object") {
      return saved.homeWidgets;
    }
  } catch {
    /* defaults */
  }
  return {};
}

export function isHomeWidgetOn(id) {
  const saved = readHomeWidgets();
  if (typeof saved[id] === "boolean") return saved[id];
  return HOME_WIDGET_DEFAULTS[id] ?? true;
}

function writeHomeWidgets(widgets) {
  let settings = {};
  try {
    settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    /* start from an empty settings blob */
  }
  const next = {
    ...settings,
    homeWidgets: { ...(settings.homeWidgets || {}), ...widgets },
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* picks just won't survive a reload */
  }
  window.dispatchEvent(new Event("lykinsai_settings_changed"));
}

/** Pull the welcome walkthrough's widget picks into settings (desktop app
 *  only). The studio loads behind the walkthrough, so this both listens for
 *  the live pick and reads whatever was stored before it mounted. */
export function useWelcomeWidgetSync() {
  useEffect(() => {
    const apply = (payload) => {
      const stamp = Number(payload?.stamp) || 0;
      if (!stamp || !payload?.widgets) return;
      let applied = 0;
      try {
        applied = Number(localStorage.getItem(WELCOME_WIDGETS_STAMP_KEY)) || 0;
        if (applied >= stamp) return;
        localStorage.setItem(WELCOME_WIDGETS_STAMP_KEY, String(stamp));
      } catch {
        return; // no storage, no way to keep this one-shot — skip it
      }
      writeHomeWidgets(payload.widgets);
      // The walkthrough speaks in on/off picks; turn them into actual widgets
      // on the desktop, laid out for the user to rearrange later.
      seedLayoutFromToggles(payload.widgets);
    };
    window.lykn?.homeWidgetsGet?.().then(apply).catch(() => {});
    return window.lykn?.onHomeWidgetsChanged?.(apply);
  }, []);
}

export function useHomeWidgetOn(id) {
  const [on, setOn] = useState(() => isHomeWidgetOn(id));
  useEffect(() => {
    const sync = () => setOn(isHomeWidgetOn(id));
    window.addEventListener("lykinsai_settings_changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("lykinsai_settings_changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, [id]);
  return on;
}

/* ── Calendar ──────────────────────────────────────────────────────────── */

function eventTimeLabel(ev) {
  if (ev.all_day) return "All day";
  return new Date(ev.starts_at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function eventDayLabel(iso) {
  const d = new Date(iso);
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  if (diffDays === 0) return "";
  if (diffDays === 1) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

/** Next 7 days of the user's calendar (lykn_events — same table the in-app
 *  calendar reads, including synced Google/Apple events). */
function useWeekEvents(userId) {
  return useQuery({
    queryKey: ["studio-events", userId || "guest"],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async () => {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const to = new Date(from.getTime() + 7 * 86_400_000);
      const { data, error } = await supabase
        .from("lykn_events")
        .select("id, title, starts_at, ends_at, all_day, location, color, status")
        .eq("user_id", userId)
        .neq("status", "cancelled")
        .gte("starts_at", from.toISOString())
        .lte("starts_at", to.toISOString())
        .order("starts_at", { ascending: true })
        .limit(12);
      if (error) throw error;
      return data || [];
    },
  });
}

export function CalendarWidget({ userId, size = "small", onOpen }) {
  const { data: events = [] } = useWeekEvents(userId);
  const now = new Date();
  // Skip events that already ended; the widget looks forward, like macOS's.
  const upcoming = events
    .filter((ev) => {
      const end = new Date(ev.ends_at || ev.starts_at).getTime();
      return ev.all_day || end >= Date.now() - 60_000;
    })
    .slice(0, rowsForSize(size, { small: 2, medium: 2, large: 7 }));

  // Small red +, jumping straight into the calendar's new-event form.
  const addButton = (
    <button
      type="button"
      onClick={() => onOpen?.("calendar", `/calendar?new=${Date.now()}`)}
      title="Add event"
      aria-label="Add event"
      className="flex flex-shrink-0 items-center justify-center text-black/70 transition-transform hover:scale-110 active:scale-95 dark:text-white"
    >
      <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
    </button>
  );

  return (
    <div style={NO_DRAG} className={`${WIDGET} flex flex-col p-3.5`}>
      <button
        type="button"
        onClick={() => onOpen?.("calendar", "/calendar")}
        title="Open Calendar"
        className="flex flex-shrink-0 flex-col text-left"
      >
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.08em] text-red-500">
          {now.toLocaleDateString(undefined, { weekday: "long" })}
        </p>
        <p className="text-[1.7rem] font-semibold leading-tight tracking-tight text-black/90 dark:text-white/95">
          {now.getDate()}
        </p>
      </button>
      <div className="mt-1.5 min-h-0 flex-1 space-y-1 overflow-hidden">
        {upcoming.length === 0 ? (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[0.68rem] text-black/40 dark:text-white/40">
              No upcoming events
            </span>
            {addButton}
          </div>
        ) : (
          <>
            {upcoming.map((ev) => (
              <button
                key={ev.id}
                type="button"
                onClick={() => onOpen?.("calendar", "/calendar")}
                title="Open Calendar"
                className="block w-full rounded-md py-0.5 pl-2 pr-1 text-left"
                style={{ borderLeft: `3px solid ${ev.color || "#3b82f6"}` }}
              >
                <p className="truncate text-[0.68rem] font-medium leading-tight text-black/85 dark:text-white/90">
                  {ev.title || "Untitled event"}
                </p>
                <p className="truncate text-[0.6rem] leading-tight text-black/45 dark:text-white/45">
                  {[eventDayLabel(ev.starts_at), eventTimeLabel(ev)]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </button>
            ))}
            <div className="flex items-center pt-0.5">{addButton}</div>
          </>
        )}
      </div>
    </div>
  );
}

/** Month-view calendar widget — the macOS mini month grid: month name, weekday
 *  initials, day numbers with today circled in red. Opens the calendar. */
export function MonthCalendarWidget({ size = "small", onOpen }) {
  const big = size === "large";
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Leading blanks + the month's days, chunked into weeks.
  const cells = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const weekdayInitials = Array.from({ length: 7 }, (_, i) =>
    new Date(2023, 0, i + 1) // Jan 1 2023 was a Sunday.
      .toLocaleDateString(undefined, { weekday: "narrow" }),
  );

  return (
    <button
      type="button"
      onClick={() => onOpen?.("calendar", "/calendar")}
      title="Open Calendar"
      style={NO_DRAG}
      /* items-stretch: buttons default to align-items:flex-start in the UA
         sheet, which shrinks the rows below to their content width. */
      className={`${WIDGET} flex flex-col items-stretch p-3 text-left transition-transform active:scale-[0.98]`}
    >
      <p className="px-0.5 text-[0.62rem] font-bold uppercase tracking-[0.08em] text-red-500">
        {now.toLocaleDateString(undefined, { month: "long" })}
      </p>
      <div className="mt-1 grid flex-shrink-0 grid-cols-7 text-center">
        {weekdayInitials.map((d, i) => (
          <span
            key={i}
            className={`font-semibold text-black/35 dark:text-white/35 ${
              big ? "text-[0.72rem]" : "text-[0.52rem]"
            }`}
          >
            {d}
          </span>
        ))}
      </div>
      <div className="mt-0.5 grid min-h-0 flex-1 grid-cols-7 text-center">
        {cells.map((day, i) => {
          const isToday = day === now.getDate();
          const px = big ? 30 : 18;
          return (
            <span key={i} className="flex items-center justify-center">
              {day !== null && (
                <span className="relative block" style={{ width: px, height: px }}>
                  {isToday && (
                    <span aria-hidden className="absolute inset-0 translate-x-[0.5px] translate-y-px rounded-full bg-red-500" />
                  )}
                  <span
                    className={`absolute inset-0 flex items-center justify-center tabular-nums ${
                      isToday
                        ? "font-semibold text-white"
                        : "text-black/75 dark:text-white/80"
                    }`}
                    style={{
                      fontSize: big ? 13 : 9,
                      lineHeight: 1,
                      textAlign: "center",
                    }}
                  >
                    {day}
                  </span>
                </span>
              )}
            </span>
          );
        })}
      </div>
    </button>
  );
}

/* ── Clock ─────────────────────────────────────────────────────────────── */

/** Time-of-day widget, macOS style: big time, weekday and date under it.
 *  Ticks on the minute boundary rather than every second so it doesn't
 *  re-render the desktop 60 times a minute. */
export function ClockWidget({ size = "small", onOpen }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer;
    const tick = () => {
      const d = new Date();
      setNow(d);
      timer = window.setTimeout(tick, 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()));
    };
    tick();
    return () => window.clearTimeout(timer);
  }, []);

  const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <button
      type="button"
      onClick={() => onOpen?.("calendar", "/calendar")}
      title="Open Calendar"
      style={NO_DRAG}
      className={`${WIDGET} flex flex-col justify-center p-3.5 text-left transition-transform active:scale-[0.98]`}
    >
      <p
        className={`font-semibold leading-none tracking-tight tabular-nums text-black/90 dark:text-white/95 ${
          size === "small" ? "text-[2.1rem]" : "text-[3.2rem]"
        }`}
      >
        {time}
      </p>
      <p className="mt-2 text-[0.7rem] font-medium text-black/55 dark:text-white/55">
        {now.toLocaleDateString(undefined, { weekday: "long" })}
      </p>
      <p className="text-[0.7rem] text-black/40 dark:text-white/40">
        {now.toLocaleDateString(undefined, { month: "long", day: "numeric" })}
      </p>
    </button>
  );
}

/* ── To-dos ────────────────────────────────────────────────────────────── */

function todoDueLabel(todo) {
  if (todo.due_at_text) return todo.due_at_text;
  if (!todo.due_at) return "";
  const d = new Date(todo.due_at);
  if (Number.isNaN(d.getTime())) return "";
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function useOpenTodos(userId) {
  return useQuery({
    queryKey: ["studio-todos-open", userId || "guest"],
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lykn_todos")
        .select("id, title, due_at, due_at_text, priority, status")
        .eq("user_id", userId)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(8);
      if (error) throw error;
      return data || [];
    },
  });
}

/** Reminders-style list widget — open tasks, tap to open the to-do popup. */
export function TodosWidget({ userId, size = "small", onOpen }) {
  const { data: todos = [] } = useOpenTodos(userId);
  const visible = todos.slice(0, rowsForSize(size, { small: 4, medium: 4, large: 8 }));
  const addButton = (
    <button
      type="button"
      onClick={() => onOpen?.("todos", "/todos")}
      title="Add a task"
      aria-label="Add a task"
      className="flex flex-shrink-0 items-center justify-center text-black/70 transition-transform hover:scale-110 active:scale-95 dark:text-white"
    >
      <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
    </button>
  );

  return (
    <div style={NO_DRAG} className={`${WIDGET} flex flex-col p-3.5`}>
      <div className="flex flex-shrink-0 items-center justify-between">
        <button
          type="button"
          onClick={() => onOpen?.("todos", "/todos")}
          title="Open To-dos"
          className="text-left"
        >
          <p className="text-[0.62rem] font-bold uppercase tracking-[0.08em] text-orange-500">
            To-dos
          </p>
        </button>
        {addButton}
      </div>
      <div className="mt-1.5 min-h-0 flex-1 space-y-0.5 overflow-hidden">
        {visible.length === 0 ? (
          <button
            type="button"
            onClick={() => onOpen?.("todos", "/todos")}
            className="pt-1 text-left text-[0.68rem] text-black/40 dark:text-white/40"
          >
            Nothing on your list
          </button>
        ) : (
          visible.map((t) => {
            const due = todoDueLabel(t);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onOpen?.("todos", "/todos")}
                title="Open To-dos"
                className="flex w-full items-start gap-1.5 rounded-md py-0.5 text-left"
              >
                <Circle className="mt-0.5 h-3 w-3 flex-shrink-0 text-black/30 dark:text-white/35" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.68rem] font-medium leading-tight text-black/85 dark:text-white/90">
                    {t.title || "Untitled"}
                  </span>
                  {due ? (
                    <span className="block truncate text-[0.58rem] leading-tight text-black/40 dark:text-white/40">
                      {due}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ── Desktop folders + right-click menu ────────────────────────────────── */

const DESKTOP_FOLDERS_KEY = "lykn_desktop_folders";
const DESKTOP_SORT_KEY = "lykn_desktop_sort";
const FILES_ICON_POS_KEY = "lykn_desktop_icon_files";

/* The desktop icon grid. macOS fills columns from the top-right corner, so
 * Clean Up / Sort By snap icons into these slots. */
export const ICON_CELL_W = 104;
export const ICON_CELL_H = 112;
export const ICON_GRID_PAD = 16;

export function gridSlot(index, layer) {
  const width = layer.w || 1200;
  const height = layer.h || 720;
  const rows = Math.max(1, Math.floor((height - ICON_GRID_PAD * 2) / ICON_CELL_H));
  const col = Math.floor(index / rows);
  const row = index % rows;
  return {
    x: Math.max(ICON_GRID_PAD, width - ICON_GRID_PAD - ICON_CELL_W * (col + 1)),
    y: ICON_GRID_PAD + row * ICON_CELL_H,
  };
}

/** The Files icon parks in the first slot until it's dragged somewhere, so
 *  arranged folders start below it and never land underneath it. */
function firstFreeSlot() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILES_ICON_POS_KEY) || "null");
    return saved && Number.isFinite(saved.x) ? 0 : 1;
  } catch {
    return 1;
  }
}

const SORT_KEYS = [
  { id: "name", label: "Name" },
  { id: "dateAdded", label: "Date Added" },
];

function loadDesktopSort() {
  try {
    const saved = localStorage.getItem(DESKTOP_SORT_KEY) || "none";
    if (SORT_KEYS.some((s) => s.id === saved)) return saved;
  } catch {
    /* unsorted */
  }
  return "none";
}

function sortedFolders(list, key) {
  const items = [...list];
  if (key === "name") {
    items.sort((a, b) =>
      String(a.name).localeCompare(String(b.name), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  } else if (key === "dateAdded") {
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  return items;
}

/** Grid reading order (down the rightmost column first) so a plain Clean Up
 *  keeps icons roughly where the user already put them. */
function cleanUpOrder(list) {
  const col = (f) => Math.round(f.x / ICON_CELL_W);
  return [...list].sort((a, b) => col(b) - col(a) || a.y - b.y);
}

function loadDesktopFolders() {
  try {
    const saved = JSON.parse(localStorage.getItem(DESKTOP_FOLDERS_KEY) || "[]");
    if (Array.isArray(saved)) {
      return saved.filter(
        (f) => f && f.id && Number.isFinite(f.x) && Number.isFinite(f.y),
      );
    }
  } catch {
    /* start empty */
  }
  return [];
}

function nextUntitledName(folders) {
  const base = "untitled folder";
  if (!folders.some((f) => f.name === base)) return base;
  let n = 2;
  while (folders.some((f) => f.name === `${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

// The frosted panel every menu (and its submenus) is drawn on — the same
// glass as the Home chat bar, since both sit on the bare wallpaper.
const MENU_PANEL = "lg-desktop-surface rounded-[14px] p-1";

const MENU_ITEM_CLS =
  "lg-menu-row group flex w-full items-center gap-2 rounded-[0.5rem] px-1.5 py-[0.3rem] " +
  "text-left text-[0.8rem] text-black/85 dark:text-white/90";

const SUBMENU_W = 176; // w-44, for edge-flip math

// Hairline between menu groups, like macOS's context-menu separators.
const MENU_SEPARATOR = (
  <div className="mx-1.5 my-1 h-px bg-black/[0.08] dark:bg-white/[0.1]" />
);

// The Studio pages the desktop menu can open, mirroring the dock's tabs.
const MENU_PAGES = [
  { id: "browser", label: "Browser" },
  { id: "projects", label: "Projects" },
  { id: "vault", label: "Vault" },
  { id: "files", label: "Files" },
  { id: "calendar", label: "Calendar" },
  { id: "todos", label: "To-dos" },
  { id: "settings", label: "Settings" },
];

/** One menu row: icon gutter (or a checkmark), label, then an optional
 *  shortcut / submenu chevron on the right — the macOS row layout. */
function MenuRow({
  icon: Icon,
  label,
  shortcut,
  checked,
  submenu,
  active,
  disabled,
  onClick,
  onMouseEnter,
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-active={active || undefined}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`${MENU_ITEM_CLS} ${disabled ? "cursor-default opacity-40" : ""}`}
    >
      <span className="flex w-4 flex-shrink-0 items-center justify-center">
        {checked ? (
          <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
        ) : Icon ? (
          <Icon className="h-3.5 w-3.5 opacity-65 group-hover:opacity-100" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? (
        <span className="flex-shrink-0 text-[0.68rem] text-black/40 dark:text-white/40">
          {shortcut}
        </span>
      ) : null}
      {submenu ? <ChevronRight className="h-3 w-3 flex-shrink-0 opacity-60" /> : null}
    </button>
  );
}

/** A context-menu row that fans out a nested submenu on hover (macOS style).
 *  The submenu is drawn into the desktop layer rather than inside the menu:
 *  the menu blurs its own backdrop, which makes it a backdrop root, and a
 *  child hanging off its side would have nothing left to blur. Near the
 *  desktop's right edge it flips, since the Studio panel clips past that. */
function MenuSubmenu({ icon, label, open, onHover, children }) {
  const rowRef = useRef(null);
  const [panel, setPanel] = useState(null); // { layer, left, top }

  useLayoutEffect(() => {
    if (!open) {
      setPanel(null);
      return;
    }
    const layerEl = rowRef.current?.closest("[data-desktop-layer]");
    const row = rowRef.current?.getBoundingClientRect();
    const layer = layerEl?.getBoundingClientRect();
    if (!row || !layer) return;
    const flip = row.right + SUBMENU_W + 8 > layer.right;
    setPanel({
      layer: layerEl,
      top: row.top - layer.top,
      left: flip
        ? row.left - layer.left - SUBMENU_W + 4
        : row.right - layer.left - 4,
    });
  }, [open]);

  return (
    <div ref={rowRef} className="relative" onMouseEnter={onHover}>
      <MenuRow icon={icon} label={label} submenu active={open} />
      {open && panel
        ? createPortal(
            // Carries data-desktop-menu so clicking a submenu row doesn't read
            // as an outside click and tear the menu down mid-press.
            <div
              data-desktop-menu
              style={{ left: panel.left, top: panel.top }}
              className={`absolute z-[60] max-h-64 w-44 overflow-y-auto ${MENU_PANEL}`}
            >
              {children}
            </div>,
            panel.layer,
          )
        : null}
    </div>
  );
}

/** A floating menu/panel anchored at the click, nudged back inside the
 *  desktop when it would hang off an edge. */
function DesktopMenu({ x, y, width = "13.5rem", children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent;
    if (!el || !parent) return;
    setPos({
      left: Math.max(8, Math.min(x, parent.clientWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, parent.clientHeight - el.offsetHeight - 8)),
    });
  }, [x, y]);

  return (
    <div
      ref={ref}
      data-desktop-menu
      style={{ left: pos.left, top: pos.top, width }}
      className={`absolute z-50 ${MENU_PANEL}`}
    >
      {children}
    </div>
  );
}

function DesktopFolderIcon({
  folder,
  renaming,
  locked,
  onMove,
  onCommitMove,
  onMenu,
  onRename,
}) {
  const [draft, setDraft] = useState(folder.name);
  const drag = useDesktopIconDrag({
    setPos: (p) => onMove(folder.id, p),
    onDragEnd: (p) => onCommitMove(folder.id, p),
  });

  useEffect(() => {
    if (renaming) setDraft(folder.name);
  }, [renaming, folder.name]);

  return (
    <div
      ref={drag.ref}
      onPointerDown={renaming || locked ? undefined : drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(folder.id, e.clientX, e.clientY);
      }}
      style={{ ...NO_DRAG, left: folder.x, top: folder.y }}
      className="group absolute flex w-24 touch-none flex-col items-center gap-1 rounded-2xl p-2 transition-colors hover:bg-white/10"
    >
      <Folder
        className="h-16 w-16 text-sky-500 drop-shadow-[0_4px_10px_rgba(0,0,0,0.25)]"
        strokeWidth={1}
        fill="currentColor"
      />
      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => onRename(folder.id, draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRename(folder.id, draft);
            if (e.key === "Escape") onRename(folder.id, folder.name);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="w-full rounded-md bg-white/90 px-1 py-0.5 text-center text-[0.72rem] text-black outline-none ring-2 ring-sky-500 dark:bg-black/70 dark:text-white"
        />
      ) : (
        <span className="max-w-full truncate text-[0.72rem] font-medium text-white/90 [text-shadow:0_1px_3px_rgba(0,0,0,0.45)]">
          {folder.name}
        </span>
      )}
    </div>
  );
}

/** The Home desktop layer: user-created folders (drag to arrange, right-click
 *  a folder to open/rename/delete) plus the macOS desktop context menu — New
 *  Folder, Get Info, Change Wallpaper, Edit Widgets, Sort By / Clean Up, the
 *  LYKN extras (Glass, Open Folder / Open Page) and Show View Options.
 *  Covers the whole desktop behind the widgets to catch right-clicks. */
export function DesktopFolders({ onOpen, onEmptyClick, onEditWidgets }) {
  const layerRef = useRef(null);
  const [folders, setFolders] = useState(loadDesktopFolders);
  const [sortKey, setSortKey] = useState(loadDesktopSort);
  const [menu, setMenu] = useState(null); // { x, y, folderId | null }
  const [info, setInfo] = useState(null); // { x, y, wallpaper }
  const [submenu, setSubmenu] = useState(null); // "sort" | "cleanup" | "folder" | "page"
  const [renamingId, setRenamingId] = useState(null);
  const [layer, setLayer] = useState({ w: 0, h: 0 });

  const persist = (next) => {
    setFolders(next);
    try {
      localStorage.setItem(DESKTOP_FOLDERS_KEY, JSON.stringify(next));
    } catch {
      /* folders just won't survive a reload */
    }
  };

  // Fresh menus always open with their submenus collapsed.
  useEffect(() => setSubmenu(null), [menu]);

  // The grid depends on how tall the desktop is, so keep it measured.
  useEffect(() => {
    const el = layerRef.current;
    if (!el) return undefined;
    const measure = () => setLayer({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Any click outside / Escape dismisses the menu, like a real context menu.
  useEffect(() => {
    if (!menu && !info) return undefined;
    const dismiss = () => {
      setMenu(null);
      setInfo(null);
    };
    const onDown = (e) => {
      if (!e.target.closest?.("[data-desktop-menu]")) dismiss();
    };
    const onKey = (e) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, info]);

  // While a sort is on, positions come from the grid and icons stay put —
  // exactly how macOS treats a sorted desktop.
  const arranged = useMemo(() => {
    if (sortKey === "none") return folders;
    const base = firstFreeSlot();
    return sortedFolders(folders, sortKey).map((f, i) => ({
      ...f,
      ...gridSlot(i + base, layer),
    }));
  }, [folders, sortKey, layer]);

  const layerPoint = (clientX, clientY) => {
    const r = layerRef.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left, y: clientY - r.top } : { x: 0, y: 0 };
  };

  const createFolder = () => {
    const at = menu ? { x: menu.x, y: menu.y } : { x: 24, y: 24 };
    const folder = {
      id: (crypto.randomUUID?.() || String(Date.now())),
      name: nextUntitledName(folders),
      createdAt: Date.now(),
      x: at.x - 48, // center the icon on the click
      y: at.y - 40,
    };
    persist([...folders, folder]);
    setRenamingId(folder.id);
    setMenu(null);
  };

  const moveFolder = (id, p) =>
    setFolders((cur) => cur.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const commitMove = (id, p) =>
    persist(folders.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const renameFolder = (id, rawName) => {
    const name = rawName.trim() || "untitled folder";
    persist(folders.map((f) => (f.id === id ? { ...f, name } : f)));
    setRenamingId(null);
  };
  const deleteFolder = (id) => {
    persist(folders.filter((f) => f.id !== id));
    setMenu(null);
  };

  const chooseSort = (key) => {
    setSortKey(key);
    try {
      localStorage.setItem(DESKTOP_SORT_KEY, key);
    } catch {
      /* sorting just won't survive a reload */
    }
    setMenu(null);
  };

  // One-shot arrange: `key` sorts first (Clean Up By), otherwise icons keep
  // their current order and only snap onto the grid (Clean Up).
  const cleanUp = (key) => {
    const order = key ? sortedFolders(folders, key) : cleanUpOrder(folders);
    const base = firstFreeSlot();
    const slots = new Map(order.map((f, i) => [f.id, gridSlot(i + base, layer)]));
    persist(folders.map((f) => ({ ...f, ...(slots.get(f.id) || {}) })));
    setMenu(null);
  };

  const openPage = (id, src) => {
    onOpen?.(id, src);
    setMenu(null);
  };

  // Summon the always-on-top Glass bar (⌘/Ctrl+L) — desktop app only.
  const canOpenGlass = typeof window !== "undefined" && !!window.lykn?.openGlass;
  const openGlass = () => {
    window.lykn?.openGlass?.();
    setMenu(null);
  };

  const showInfo = async () => {
    const at = { x: menu.x, y: menu.y };
    setMenu(null);
    // Whatever the desktop is actually painting: the wallpaper picked in
    // Settings › Appearance, else the app's built-in backdrop.
    let wallpaper = "Default";
    try {
      const bg = await window.lykn?.backgroundGet?.();
      if (bg?.dataUrl) wallpaper = "My photo";
    } catch {
      /* fall back to Default */
    }
    setInfo({ ...at, wallpaper });
  };

  const infoRows = () => {
    const placed = readWidgetLayout().length;
    return [
      ["Items", `${folders.length} folder${folders.length === 1 ? "" : "s"}`],
      ["Sorted by", SORT_KEYS.find((s) => s.id === sortKey)?.label || "None"],
      ["Wallpaper", info?.wallpaper || "Default"],
      ["Widgets", placed ? `${placed} on the desktop` : "None"],
    ];
  };

  const collapseSubmenus = () => setSubmenu(null);

  return (
    <div
      ref={layerRef}
      data-desktop-layer
      style={NO_DRAG}
      onContextMenu={(e) => {
        e.preventDefault();
        setInfo(null);
        setMenu({ ...layerPoint(e.clientX, e.clientY), folderId: null });
      }}
      onClick={(e) => {
        // Only the bare wallpaper counts — a click that landed on a folder
        // icon, or one that was just dismissing a menu, isn't "empty space".
        if (e.target !== layerRef.current) return;
        if (menu || info) return;
        onEmptyClick?.();
      }}
      className="absolute inset-0"
    >
      {arranged.map((folder) => (
        <DesktopFolderIcon
          key={folder.id}
          folder={folder}
          renaming={renamingId === folder.id}
          locked={sortKey !== "none"}
          onMove={moveFolder}
          onCommitMove={commitMove}
          onRename={renameFolder}
          onMenu={(id, cx, cy) => {
            setInfo(null);
            setMenu({ ...layerPoint(cx, cy), folderId: id });
          }}
        />
      ))}

      {menu && (
        <DesktopMenu x={menu.x} y={menu.y}>
          {menu.folderId ? (
            <>
              <MenuRow
                icon={FolderOpen}
                label="Open"
                onClick={() => openPage("files")}
              />
              {MENU_SEPARATOR}
              <MenuRow
                icon={Pencil}
                label="Rename"
                onClick={() => {
                  setRenamingId(menu.folderId);
                  setMenu(null);
                }}
              />
              <MenuRow
                icon={Trash2}
                label="Delete"
                onClick={() => deleteFolder(menu.folderId)}
              />
            </>
          ) : (
            <>
              <MenuRow
                icon={FolderPlus}
                label="New Folder"
                onMouseEnter={collapseSubmenus}
                onClick={createFolder}
              />
              {MENU_SEPARATOR}
              <MenuRow
                icon={Info}
                label="Get Info"
                onMouseEnter={collapseSubmenus}
                onClick={showInfo}
              />
              {/* macOS opens System Settings › Wallpaper here; ours opens the
                  Appearance pane, which holds the presets, the photo picker
                  and the dim/blur knobs. */}
              <MenuRow
                icon={Wallpaper}
                label="Change Wallpaper…"
                onMouseEnter={collapseSubmenus}
                onClick={() => openPage("settings", "appearance")}
              />
              {/* Arranging happens on the desktop itself — the menu drops you
                  into edit mode rather than into a settings pane. */}
              <MenuRow
                icon={LayoutGrid}
                label="Edit Widgets…"
                onMouseEnter={collapseSubmenus}
                onClick={() => {
                  setMenu(null);
                  if (onEditWidgets) onEditWidgets();
                  else openPage("settings", "display");
                }}
              />
              {MENU_SEPARATOR}
              <MenuSubmenu
                icon={ArrowUpDown}
                label="Sort By"
                open={submenu === "sort"}
                onHover={() => setSubmenu("sort")}
              >
                <MenuRow
                  label="None"
                  checked={sortKey === "none"}
                  onClick={() => chooseSort("none")}
                />
                {MENU_SEPARATOR}
                {SORT_KEYS.map((s) => (
                  <MenuRow
                    key={s.id}
                    label={s.label}
                    checked={sortKey === s.id}
                    onClick={() => chooseSort(s.id)}
                  />
                ))}
              </MenuSubmenu>
              <MenuRow
                icon={Grid2x2}
                label="Clean Up"
                disabled={sortKey !== "none"}
                onMouseEnter={collapseSubmenus}
                onClick={() => cleanUp(null)}
              />
              {sortKey === "none" ? (
                <MenuSubmenu
                  icon={Grid2x2}
                  label="Clean Up By"
                  open={submenu === "cleanup"}
                  onHover={() => setSubmenu("cleanup")}
                >
                  {SORT_KEYS.map((s) => (
                    <MenuRow key={s.id} label={s.label} onClick={() => cleanUp(s.id)} />
                  ))}
                </MenuSubmenu>
              ) : (
                <MenuRow icon={Grid2x2} label="Clean Up By" submenu disabled />
              )}
              {MENU_SEPARATOR}
              {canOpenGlass && (
                <MenuRow
                  icon={Sparkles}
                  label="Open LYKN Glass"
                  shortcut={desktopHotkeyLabel("spaced")}
                  onMouseEnter={collapseSubmenus}
                  onClick={openGlass}
                />
              )}
              <MenuSubmenu
                icon={Folder}
                label="Open Folder"
                open={submenu === "folder"}
                onHover={() => setSubmenu("folder")}
              >
                <MenuRow label="Files" onClick={() => openPage("files")} />
                {folders.map((f) => (
                  <MenuRow key={f.id} label={f.name} onClick={() => openPage("files")} />
                ))}
              </MenuSubmenu>
              <MenuSubmenu
                icon={AppWindow}
                label="Open Page"
                open={submenu === "page"}
                onHover={() => setSubmenu("page")}
              >
                {MENU_PAGES.map((p) => (
                  <MenuRow key={p.id} label={p.label} onClick={() => openPage(p.id)} />
                ))}
              </MenuSubmenu>
              {MENU_SEPARATOR}
              <MenuRow
                icon={SlidersHorizontal}
                label="Show View Options"
                onMouseEnter={collapseSubmenus}
                onClick={() => openPage("settings", "display")}
              />
            </>
          )}
        </DesktopMenu>
      )}

      {info && (
        <DesktopMenu x={info.x} y={info.y} width="14rem">
          <div className="px-1.5 py-1">
            <p className="text-[0.82rem] font-semibold text-black/90 dark:text-white/95">
              Desktop
            </p>
            <p className="mt-0.5 text-[0.66rem] text-black/45 dark:text-white/45">
              Home · LYKN Studio
            </p>
            <div className="mt-2 space-y-1">
              {infoRows().map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-baseline justify-between gap-3 text-[0.7rem]"
                >
                  <span className="flex-shrink-0 text-black/45 dark:text-white/45">
                    {label}
                  </span>
                  <span className="min-w-0 truncate text-right text-black/80 dark:text-white/85">
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </DesktopMenu>
      )}
    </div>
  );
}

/* ── Vault ─────────────────────────────────────────────────────────────── */

const VAULT_TYPE_ICONS = {
  note: FileText,
  link: Link2,
  social: Link2,
  youtube: Video,
  image: ImageIcon,
  video: Video,
  audio: Music,
  pdf: FileText,
  file: File,
};

function youtubeThumb(url) {
  const m = String(url || "").match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{6,})/i,
  );
  return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : "";
}

/** Recent vault items with a display thumbnail resolved where possible
 *  (signed storage variant, preview image, or YouTube poster). */
function useVaultPreviewItems(userId, limit = 18) {
  return useQuery({
    queryKey: ["studio-vault-widget", userId || "guest"],
    enabled: !!userId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vault_items")
        .select(
          "id, title, att_type, url, storage_path, storage_bucket, mime_type, variant_thumb_path, attachment_preview, created_at",
        )
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;

      return Promise.all(
        (data || []).map(async (item) => {
          let thumb = "";
          const preview = item.attachment_preview || {};
          const storageThumb =
            item.variant_thumb_path ||
            (item.att_type === "image" ? item.storage_path : "");
          if (storageThumb) {
            try {
              const { data: signed } = await supabase.storage
                .from(item.storage_bucket || "user-files")
                .createSignedUrl(storageThumb, 60 * 60);
              thumb = signed?.signedUrl || "";
            } catch {
              /* falls through to the icon tile */
            }
          }
          if (!thumb) {
            thumb =
              String(preview.image || preview.thumbnail_url || "") ||
              youtubeThumb(item.url);
          }
          return { ...item, thumb };
        }),
      );
    },
  });
}

/** Vault widget — Apple-Photos style: a long strip that rotates through the
 *  vault's contents, three tiles at a time. */
export function VaultWidget({ userId, size = "medium", onOpen }) {
  const { data: items = [] } = useVaultPreviewItems(userId);
  const [page, setPage] = useState(0);
  // Tiles per turn: one on a small tile, a row of three on a wide one, two
  // rows of three on the big one.
  const perPage = size === "small" ? 1 : size === "large" ? 6 : 3;

  // Rotate the window every few seconds, Photos-widget style.
  useEffect(() => {
    if (items.length <= perPage) return undefined;
    const t = setInterval(() => setPage((p) => p + 1), 5000);
    return () => clearInterval(t);
  }, [items.length, perPage]);

  const visible =
    items.length <= perPage
      ? items
      : Array.from(
          { length: perPage },
          (_, i) => items[(page * perPage + i) % items.length],
        );

  return (
    <div style={NO_DRAG} className={`${WIDGET} p-2`}>
      {items.length === 0 ? (
        <button
          type="button"
          onClick={() => onOpen?.("vault")}
          title="Open Vault"
          className="flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-[1rem] text-black/40 dark:text-white/40"
        >
          <Lock className="h-5 w-5" />
          <span className="text-[0.68rem]">Your vault is empty</span>
        </button>
      ) : (
        <div
          key={page}
          className={`grid h-full gap-2 animate-in fade-in-0 duration-500 ${
            size === "small" ? "grid-cols-1" : "grid-cols-3"
          }`}
        >
          {visible.map((item, i) => {
            const Icon = VAULT_TYPE_ICONS[item.att_type] || FileText;
            return (
              <button
                key={`${item.id}:${i}`}
                type="button"
                onClick={() => onOpen?.("vault")}
                title={item.title || "Open Vault"}
                className="relative overflow-hidden rounded-[1rem] bg-black/[0.05] text-left transition-transform hover:scale-[1.02] active:scale-[0.98] dark:bg-white/[0.07]"
              >
                {item.thumb ? (
                  <img
                    src={item.thumb}
                    alt=""
                    draggable={false}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 p-2">
                    <Icon className="h-5 w-5 text-black/45 dark:text-white/50" />
                    <span className="line-clamp-2 max-w-full text-center text-[0.62rem] leading-tight text-black/60 dark:text-white/65">
                      {item.title || "Untitled"}
                    </span>
                  </span>
                )}
                {/* Title scrim over image tiles, like Photos' date label. */}
                {item.thumb && item.title && (
                  <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/55 to-transparent px-2 pb-1 pt-3 text-[0.6rem] text-white">
                    {item.title}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Projects ──────────────────────────────────────────────────────────── */

function projectInitials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "P";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function useStudioProjects(userId) {
  return useQuery({
    queryKey: ["lykn_projects", userId || "guest"],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: () => listUserProjects(userId),
  });
}

/** Projects widget — a tall list of recent workspaces, matching the
 *  calendar + vault column. Click a row to open that project; + starts a
 *  new one. */
export function ProjectsWidget({ userId, size = "large", onOpen }) {
  const { data: projects = [] } = useStudioProjects(userId);
  const { data: focusId = null } = useQuery({
    queryKey: ["lykn_active_project", userId || "guest"],
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: () => getActiveProjectId(userId),
  });

  const visible = projects.slice(0, rowsForSize(size, { small: 2, medium: 2, large: 6 }));

  const addButton = (
    <button
      type="button"
      onClick={() => onOpen?.("projects", `/projects?new=${Date.now()}`)}
      title="New project"
      aria-label="New project"
      className="flex flex-shrink-0 items-center justify-center text-black/70 transition-transform hover:scale-110 active:scale-95 dark:text-white"
    >
      <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
    </button>
  );

  return (
    <div style={NO_DRAG} className={`${WIDGET} flex flex-col p-3.5`}>
      <div className="flex flex-shrink-0 items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onOpen?.("projects", "/projects")}
          title="Open Projects"
          className="text-left"
        >
          <p className="text-[0.62rem] font-bold uppercase tracking-[0.08em] text-teal-500">
            Projects
          </p>
        </button>
        {addButton}
      </div>
      <div className="mt-2 min-h-0 flex-1 space-y-0.5 overflow-hidden">
        {visible.length === 0 ? (
          <button
            type="button"
            onClick={() => onOpen?.("projects", `/projects?new=${Date.now()}`)}
            title="New project"
            className="flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-[1rem] text-black/40 dark:text-white/40"
          >
            <FolderKanban className="h-5 w-5" />
            <span className="text-[0.68rem]">No projects yet</span>
          </button>
        ) : (
          visible.map((p) => {
            const isFocus = focusId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() =>
                  onOpen?.("projects", `/projects/${encodeURIComponent(p.id)}`)
                }
                title={p.name || "Open project"}
                className="flex w-full items-center gap-2 rounded-xl px-1 py-1.5 text-left transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
              >
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[0.55rem] bg-black/10 text-[0.62rem] font-semibold tracking-wide text-black/70 dark:bg-white/15 dark:text-white/80">
                  {projectInitials(p.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.72rem] font-medium leading-tight text-black/85 dark:text-white/90">
                    {p.name || "Untitled project"}
                  </span>
                  <span className="block truncate text-[0.6rem] leading-tight text-black/40 dark:text-white/40">
                    {isFocus
                      ? "AI focus"
                      : p.isShared
                        ? `Shared · ${relativeTime(p.lastActiveAt)}`
                        : relativeTime(p.lastActiveAt)}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ── Files ─────────────────────────────────────────────────────────────── */

/** Pointer-drag for a desktop icon: absolute-positioned against its
 *  offsetParent, clamped inside it. A plain click (barely any movement)
 *  falls through to `onClick`; a real drag commits via `onDragEnd`. */
export function useDesktopIconDrag({ onClick, onDragEnd, setPos }) {
  const ref = useRef(null);
  const dragRef = useRef(null);

  const onPointerDown = (e) => {
    if (e.button !== 0) return; // right-click belongs to the context menu
    const el = ref.current;
    const parent = el?.offsetParent;
    if (!el || !parent) return;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: rect.left - parentRect.left,
      baseY: rect.top - parentRect.top,
      maxX: parent.clientWidth - rect.width,
      maxY: parent.clientHeight - rect.height,
      moved: false,
      last: null,
    };
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    // A few px of slack keeps ordinary clicks from becoming micro-drags.
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    d.last = {
      x: Math.min(Math.max(d.baseX + dx, 4), Math.max(d.maxX - 4, 4)),
      y: Math.min(Math.max(d.baseY + dy, 4), Math.max(d.maxY - 4, 4)),
    };
    setPos(d.last);
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return; // e.g. a right-click release — the menu owns that
    if (d.moved && d.last) onDragEnd?.(d.last);
    else onClick?.();
  };

  return { ref, onPointerDown, onPointerMove, onPointerUp };
}

/** A big desktop icon, macOS style: blue folder + label. Opens Files on
 *  click and can be dragged anywhere on the desktop (position persists). */
export function FilesWidget({ onOpen }) {
  // null = the default anchored spot (top-right); {x,y} once dragged.
  const [pos, setPos] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(FILES_ICON_POS_KEY) || "null");
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
    } catch {
      /* default spot */
    }
    return null;
  });

  const drag = useDesktopIconDrag({
    setPos,
    onClick: () => onOpen?.("files"),
    onDragEnd: (last) => {
      try {
        localStorage.setItem(FILES_ICON_POS_KEY, JSON.stringify(last));
      } catch {
        /* position just won't persist */
      }
    },
  });

  return (
    <button
      ref={drag.ref}
      type="button"
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      title="Open Files"
      style={{ ...NO_DRAG, ...(pos ? { left: pos.x, top: pos.y } : undefined) }}
      className={`group absolute flex w-24 touch-none flex-col items-center gap-1 rounded-2xl p-2 transition-colors hover:bg-white/10 ${
        pos ? "" : "right-6 top-6"
      }`}
    >
      <Folder
        className="h-16 w-16 text-sky-500 drop-shadow-[0_4px_10px_rgba(0,0,0,0.25)] transition-transform group-hover:scale-105 group-active:scale-95"
        strokeWidth={1}
        fill="currentColor"
      />
      <span className="text-[0.72rem] font-medium text-white/90 [text-shadow:0_1px_3px_rgba(0,0,0,0.45)]">
        Files
      </span>
    </button>
  );
}
