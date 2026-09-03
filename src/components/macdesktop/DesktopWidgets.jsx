import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  ArrowUpDown,
  Check,
  ChevronRight,
  Circle,
  Eye,
  EyeOff,
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
import { activeVaultBackend } from "@/lib/vault/repository";
import {
  AI_DRIVE_WIDGET_QUERY_KEY,
  listAiDriveImages,
} from "@/lib/vault/localAiDriveImages";
import { desktopHotkeyLabel } from "@/lib/desktopHotkey";
import { getActiveProjectId, listUserProjects } from "@/lib/userProjects";
import { relativeTime } from "@/components/projects/projectShared";
import { WIDGET_SURFACE, rowsForSize } from "@/components/macdesktop/widgets/shared";
import { readWidgetLayout, seedLayoutFromToggles } from "@/lib/desktopWidgets";
import { resolveDesktopPath } from "@/lib/macDesktopSync";
import {
  forgetLyknFolders,
  relocateLyknFolders,
  rememberLyknFolders,
} from "@/lib/lyknFolders";
import { queueVaultMacPaths } from "@/lib/homeChatFiles";
import { useDropZone } from "@/lib/drag/dragEngine";
import {
  useDesktopFilesMoved,
  useDesktopPlace,
  useFolderDropZone,
} from "@/components/macdesktop/fileDrop";
import { useDesktopIconDrag } from "@/components/macdesktop/desktopIconDrag";
import { arrangeDesktop } from "@/components/macdesktop/desktopArrange";
import {
  DESKTOP_ICON_ART_CLASS,
  desktopIconClass,
  desktopIconLabelClass,
  desktopRootOf,
  hitDesktopIcons,
  normalizeBox,
  useDesktopGroupMove,
  useDesktopSelect,
} from "@/components/macdesktop/desktopSelect";
import {
  desktopMetrics,
  isPlacement,
  pixelsOf,
  placementOf,
  savedPlacement,
  useDesktopLayer,
  useDesktopMetrics,
} from "@/components/macdesktop/desktopGrid";
import { useDesktopVisibility } from "@/components/macdesktop/desktopVisibility";

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
  {
    id: "vaultFolder",
    label: "Vault folder",
    description: "A desktop folder that opens your vault.",
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
 *  calendar reads). */
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
const DESKTOP_FOLDERS_EVENT = "lykn_desktop_folders_changed";
const DESKTOP_SORT_KEY = "lykn_desktop_sort";
const FILES_ICON_POS_KEY = "lykn_desktop_icon_files";
const VAULT_ICON_POS_KEY = "lykn_desktop_icon_vault";

/** Files and Vault park in the top slots until they're dragged somewhere, so
 *  arranged folders start below them and never land underneath one. */
export function firstFreeSlot() {
  const parked = (key) => {
    try {
      return !savedIconPos(key);
    } catch {
      return true;
    }
  };
  // A dragged icon vacates its slot, but only the trailing ones can be
  // reclaimed without shuffling everything else up.
  if (parked(VAULT_ICON_POS_KEY)) return 2;
  if (parked(FILES_ICON_POS_KEY)) return 1;
  return 0;
}

function savedIconPos(key) {
  const saved = JSON.parse(localStorage.getItem(key) || "null");
  if (isPlacement(saved)) return saved;
  // Written before positions were resolution-independent.
  return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
}

const SORT_KEYS = [
  { id: "kind", label: "Kind" },
  { id: "name", label: "Name" },
  { id: "date", label: "Date Modified" },
];

/** A folder moved to `placement`, with any pixel coordinates it still carries
 *  from an older build dropped rather than left to go stale. */
function placed(folder, placement) {
  const { x: _x, y: _y, ...rest } = folder;
  return { ...rest, col: placement.col, row: placement.row };
}

function loadDesktopFolders() {
  try {
    const saved = JSON.parse(localStorage.getItem(DESKTOP_FOLDERS_KEY) || "[]");
    if (Array.isArray(saved)) {
      return saved.filter(
        (f) =>
          f &&
          f.id &&
          (isPlacement(f) || (Number.isFinite(f.x) && Number.isFinite(f.y))),
      );
    }
  } catch {
    /* start empty */
  }
  return [];
}

function lyknFiles() {
  const b = typeof window !== "undefined" ? window.lykn : null;
  return b && typeof b.files?.mkdir === "function" ? b : null;
}

/** Reuse a folder already on the Desktop, otherwise make one. */
async function attachOrCreateFolder(api, parent, name) {
  try {
    const listing = await api.files.list({ path: parent });
    if (listing?.ok) {
      const hit = (listing.entries || []).find(
        (e) => e.type === "dir" && !e.package && e.name === name,
      );
      if (hit?.path) return { path: hit.path, name: hit.name };
    }
  } catch {
    /* mkdir below */
  }
  try {
    const created = await api.files.mkdir({ path: parent, name });
    if (created?.ok && created.path) return { path: created.path, name: created.name };
  } catch {
    /* folder stays a Home icon until disk is reachable */
  }
  return null;
}

/** Paths of folders the user made on Home, so the desktop mirror doesn't draw them twice. */
export function readDesktopFolderPaths() {
  return loadDesktopFolders()
    .map((f) => f.path)
    .filter((p) => typeof p === "string" && p);
}

export function useDesktopFolderPaths() {
  const [paths, setPaths] = useState(readDesktopFolderPaths);
  useEffect(() => {
    const sync = () => setPaths(readDesktopFolderPaths());
    window.addEventListener(DESKTOP_FOLDERS_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(DESKTOP_FOLDERS_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return paths;
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
 *  desktop's right edge it flips, since the Studio panel clips past that, and
 *  near the bottom it rises to stay fully inside the desktop. */
function MenuSubmenu({ icon, label, open, onHover, children }) {
  const rowRef = useRef(null);
  const panelRef = useRef(null);
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

  // The height isn't known until the panel is in the DOM, so measure it and
  // slide it back up rather than letting a submenu opened near the bottom of
  // the desktop run off the edge. Runs before paint, so nothing jumps.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!panel || !el) return;
    const layer = panel.layer.getBoundingClientRect();
    const top = Math.max(
      8,
      Math.min(panel.top, layer.height - el.offsetHeight - 8),
    );
    if (Math.abs(top - panel.top) > 0.5) {
      setPanel((prev) => (prev ? { ...prev, top } : prev));
    }
  }, [panel]);

  return (
    <div ref={rowRef} className="relative" onMouseEnter={onHover}>
      <MenuRow icon={icon} label={label} submenu active={open} />
      {open && panel
        ? createPortal(
            // Carries data-desktop-menu so clicking a submenu row doesn't read
            // as an outside click and tear the menu down mid-press.
            <div
              ref={panelRef}
              data-desktop-menu
              style={{ left: panel.left, top: panel.top }}
              className={`absolute z-[60] w-44 ${MENU_PANEL}`}
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
  pos,
  renaming,
  onMenu,
  onRename,
  onOpen,
  onMoveStart,
}) {
  const iconId = `folder:${folder.id}`;
  const select = useDesktopSelect();
  const selected = select.isSelected(iconId);
  const [draft, setDraft] = useState(folder.name);
  const drop = useFolderDropZone(folder.path, {
    disabled: renaming,
    onHoverOpen: folder.path ? () => onOpen?.(folder) : undefined,
  });
  const beginDrag = useDesktopIconDrag({
    id: iconId,
    path: folder.path,
    onMoveStart,
  });

  useEffect(() => {
    if (renaming) setDraft(folder.name);
  }, [renaming, folder.name]);

  return (
    <div
      ref={drop.ref}
      data-desktop-icon={iconId}
      data-desktop-path={folder.path || undefined}
      // What the desktop arranger sorts by — it reads the icons on screen
      // rather than the stores behind them.
      data-desktop-name={folder.name}
      data-desktop-kind="Folder"
      data-desktop-date={folder.createdAt || undefined}
      onPointerDown={renaming ? undefined : beginDrag}
      onClick={
        renaming
          ? undefined
          : (e) => {
              if (e.metaKey || e.ctrlKey) return;
              if (select.selected.size > 1 && selected) {
                select.selectOnly(iconId);
                return;
              }
              onOpen?.(folder);
            }
      }
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!selected) select.selectOnly(iconId);
        onMenu(folder.id, e.clientX, e.clientY);
      }}
      style={{ ...NO_DRAG, left: pos.x, top: pos.y }}
      className={`${desktopIconClass(selected, { hot: drop.hot })} cursor-pointer`}
    >
      {/* White, like AI Drive's folders: this one was made in LYKN. The blue
          ones on this desktop are the Mac's, mirrored in from the Finder. */}
      <Folder
        className={`${DESKTOP_ICON_ART_CLASS} text-white drop-shadow-[0_4px_10px_rgba(0,0,0,0.25)]`}
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
          className="w-full rounded-md bg-white/90 px-1 py-0.5 text-center text-[length:var(--desk-label)] text-black outline-none ring-2 ring-sky-500 dark:bg-black/70 dark:text-white"
        />
      ) : (
        <span className={desktopIconLabelClass(selected)}>{folder.name}</span>
      )}
    </div>
  );
}

/** The Home desktop layer: user-created folders (drag to arrange, right-click
 *  a folder to open/rename/delete) plus the macOS desktop context menu — New
 *  Folder, Get Info, Change Wallpaper, Edit Widgets, Hide All Folders /
 *  Hide All Files / Hide All Widgets, Sort By / Clean Up, the LYKN extras
 *  (Glass, Open Folder / Open Page) and Show View Options.
 *  Covers the whole desktop behind the widgets to catch right-clicks. */
export function DesktopFolders({ onOpen, onEmptyClick, onEditWidgets }) {
  const layerRef = useRef(null);
  const select = useDesktopSelect();
  const [folders, setFolders] = useState(loadDesktopFolders);
  const [visibility, setVisibility] = useDesktopVisibility();
  const [sortKey, setSortKey] = useState("none");
  const [menu, setMenu] = useState(null); // { x, y, folderId | null }
  const [info, setInfo] = useState(null); // { x, y, wallpaper }
  const [submenu, setSubmenu] = useState(null); // "sort" | "cleanup" | "folder" | "page"
  const [renamingId, setRenamingId] = useState(null);
  const layer = useDesktopLayer();
  const [marquee, setMarquee] = useState(null); // { x, y, w, h }
  const marqueeRef = useRef(null);

  const unlockManualPlacement = useCallback(() => {
    setSortKey((current) => {
      if (current === "none") return current;
      try {
        localStorage.setItem(DESKTOP_SORT_KEY, "none");
      } catch {
        /* sorting still unlocks for this session */
      }
      return "none";
    });
  }, []);

  const persist = (next) => {
    setFolders(next);
    try {
      localStorage.setItem(DESKTOP_FOLDERS_KEY, JSON.stringify(next));
    } catch {
      /* folders just won't survive a reload */
    }
    window.dispatchEvent(new Event(DESKTOP_FOLDERS_EVENT));
  };

  const persistRef = useRef(persist);
  persistRef.current = persist;
  const foldersRef = useRef(folders);
  foldersRef.current = folders;

  // A folder on Home is LYKN's, so the Files browser draws it white too. Kept
  // in step with the list rather than recorded at the moment one is made, which
  // also picks up the folders that were here before any of this was written.
  useEffect(() => {
    rememberLyknFolders(folders.map((f) => f.path).filter(Boolean));
  }, [folders]);
  // Drops and drags arrive in pixels and have to be turned into placements
  // against the desktop they landed on, from callbacks that outlive a render.
  const layerSizeRef = useRef(layer);
  layerSizeRef.current = layer;

  useDesktopGroupMove(({ positions, commit }) => {
    const patch = {};
    for (const [id, pos] of Object.entries(positions || {})) {
      if (!id.startsWith("folder:")) continue;
      if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) continue;
      patch[id.slice(7)] = placementOf(pos, layerSizeRef.current);
    }
    if (!Object.keys(patch).length) return;
    const next = foldersRef.current.map((f) =>
      patch[f.id] ? placed(f, patch[f.id]) : f,
    );
    foldersRef.current = next;
    if (commit) persistRef.current(next);
    else setFolders(next);
  });

  const onPlace = useCallback(({ paths, x, y }) => {
    if (!paths?.length) return;
    persistRef.current(
      loadDesktopFolders().map((f) => {
        const i = paths.indexOf(f.path);
        if (i < 0) return f;
        // Cascade a multi-item drop the way Finder does.
        return placed(f, placementOf({ x: x + i * 16, y: y + i * 16 }, layerSizeRef.current));
      }),
    );
  }, []);
  useDesktopPlace(onPlace);

  const onMoved = useCallback((paths) => {
    if (!paths?.length) return;
    const gone = new Set(paths);
    persistRef.current(loadDesktopFolders().filter((f) => !gone.has(f.path)));
  }, []);
  useDesktopFilesMoved(onMoved);

  // Fresh menus always open with their submenus collapsed.
  useEffect(() => setSubmenu(null), [menu]);

  // Folders made before they lived on disk get a real directory the next time
  // Home loads, so clicking one can open Files into it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const api = lyknFiles();
      if (!api) return;
      const current = loadDesktopFolders();
      const missing = current.filter((f) => !f.path);
      if (!missing.length) return;
      const parent = await resolveDesktopPath(api);
      const next = [...current];
      let changed = false;
      for (const folder of missing) {
        const attached = await attachOrCreateFolder(api, parent, folder.name);
        if (cancelled || !attached) continue;
        const i = next.findIndex((f) => f.id === folder.id);
        if (i < 0) continue;
        next[i] = { ...next[i], path: attached.path, name: attached.name };
        changed = true;
      }
      if (!cancelled && changed) persist(next);
    })();
    return () => {
      cancelled = true;
    };
    // Mount only — existing icons, not every rename.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Folders parked by an older build hold raw pixels, which only mean anything
   * on the display they were parked on. Read them against this desktop once it
   * has a size and rewrite them as placements — after that they follow the
   * screen like everything else. */
  useLayoutEffect(() => {
    if (!layer.w || !layer.h) return;
    const current = foldersRef.current;
    if (current.every(isPlacement)) return;
    persistRef.current(
      current.map((f) =>
        isPlacement(f) ? f : placed(f, placementOf({ x: f.x, y: f.y }, layer)),
      ),
    );
  }, [layer]);

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

  // Sort and Clean Up arrange once. They no longer own the live coordinates,
  // so a regular desktop folder always follows the next manual drag.
  const arranged = folders;

  const layerPoint = (clientX, clientY) => {
    const r = layerRef.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left, y: clientY - r.top } : { x: 0, y: 0 };
  };

  const createFolder = async () => {
    const at = menu ? { x: menu.x, y: menu.y } : { x: 24, y: 24 };
    setMenu(null);
    if (visibility.hideFolders) setVisibility({ hideFolders: false });
    const name = nextUntitledName(folders);
    const api = lyknFiles();
    let path = null;
    let realName = name;
    if (api) {
      const parent = await resolveDesktopPath(api);
      const attached = await attachOrCreateFolder(api, parent, name);
      if (attached) {
        path = attached.path;
        realName = attached.name;
      }
    }
    const metrics = desktopMetrics(layer);
    const folder = placed(
      {
        id: crypto.randomUUID?.() || String(Date.now()),
        name: realName,
        path,
        createdAt: Date.now(),
      },
      // Centre the icon on the click.
      placementOf(
        { x: at.x - metrics.tile / 2, y: at.y - metrics.art / 2 },
        layer,
      ),
    );
    persist([...folders, folder]);
    setRenamingId(folder.id);
  };

  const openFolder = async (folder) => {
    setMenu(null);
    let path = folder.path;
    if (!path) {
      const api = lyknFiles();
      if (api) {
        const parent = await resolveDesktopPath(api);
        const attached = await attachOrCreateFolder(api, parent, folder.name);
        if (attached) {
          path = attached.path;
          persist(
            folders.map((f) =>
              f.id === folder.id ? { ...f, path: attached.path, name: attached.name } : f,
            ),
          );
        }
      }
    }
    if (path) onOpen?.("files", `/files?path=${encodeURIComponent(path)}`);
    else onOpen?.("files");
  };

  const renameFolder = async (id, rawName) => {
    const name = rawName.trim() || "untitled folder";
    const folder = folders.find((f) => f.id === id);
    let path = folder?.path || null;
    let finalName = name;
    const api = lyknFiles();
    if (folder?.path && api) {
      try {
        const result = await api.files.rename({ path: folder.path, name });
        if (result?.ok) {
          path = result.path;
          finalName = result.name;
          relocateLyknFolders([[folder.path, result.path]]);
        }
      } catch {
        /* keep the Home name even if disk refused */
      }
    }
    persist(folders.map((f) => (f.id === id ? { ...f, name: finalName, path } : f)));
    setRenamingId(null);
  };
  const deleteFolder = (id) => {
    const folder = folders.find((f) => f.id === id);
    const api = lyknFiles();
    if (folder?.path && api?.files?.trash) {
      void api.files.trash({ paths: [folder.path] });
      forgetLyknFolders([folder.path]);
    }
    persist(folders.filter((f) => f.id !== id));
    setMenu(null);
  };

  /* Sort By and Clean Up both hand the whole desktop to the arranger, not just
   * the folders this component owns — mirrored files and the pinned shortcuts
   * are desktop icons too, and tidying around them isn't tidying. */
  const arrange = (key) => {
    arrangeDesktop({ by: key });
    setSortKey("none");
    try {
      localStorage.setItem(DESKTOP_SORT_KEY, "none");
    } catch {
      /* sorting just won't survive a reload */
    }
    setMenu(null);
  };

  const chooseSort = (key) => arrange(key === "none" ? null : key);

  // One-shot arrange: `key` sorts first (Clean Up By), otherwise icons keep
  // their current order and only snap onto the grid (Clean Up).
  const cleanUp = (key) => arrange(key || null);

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

  const onMarqueeDown = (e) => {
    if (e.button !== 0) return;
    if (e.target !== layerRef.current) return;
    if (menu || info) return;
    const at = layerPoint(e.clientX, e.clientY);
    const additive = e.metaKey || e.ctrlKey;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture just keeps the marquee alive over icons */
    }
    marqueeRef.current = {
      x0: at.x,
      y0: at.y,
      additive,
      origin: additive ? new Set(select.selectedRef.current) : new Set(),
      had: select.selectedRef.current.size > 0,
      moved: false,
    };
    if (!additive) select.clear();
  };

  const onMarqueeMove = (e) => {
    const m = marqueeRef.current;
    if (!m) return;
    const at = layerPoint(e.clientX, e.clientY);
    if (!m.moved && Math.hypot(at.x - m.x0, at.y - m.y0) < 4) return;
    m.moved = true;
    const box = normalizeBox(m.x0, m.y0, at.x, at.y);
    setMarquee(box);
    const root = desktopRootOf(layerRef.current);
    const hits = hitDesktopIcons(root, box);
    if (m.additive) {
      select.selectIds([...m.origin, ...hits]);
    } else {
      select.selectIds(hits);
    }
  };

  const onMarqueeUp = (e) => {
    const m = marqueeRef.current;
    marqueeRef.current = null;
    if (!m) return;
    setMarquee(null);
    if (m.moved) return;
    // A click on the wallpaper, not a drag. Cmd-click leaves the selection.
    if (m.additive) return;
    if (!m.had && !menu && !info && e.target === layerRef.current) {
      onEmptyClick?.();
    }
  };

  return (
    <div
      ref={layerRef}
      data-desktop-layer
      style={NO_DRAG}
      onPointerDown={onMarqueeDown}
      onPointerMove={onMarqueeMove}
      onPointerUp={onMarqueeUp}
      onPointerCancel={() => {
        marqueeRef.current = null;
        setMarquee(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (e.target === layerRef.current) select.clear();
        setInfo(null);
        setMenu({ ...layerPoint(e.clientX, e.clientY), folderId: null });
      }}
      className="absolute inset-0"
    >
      {!visibility.hideFolders &&
        arranged.map((folder) => (
          <DesktopFolderIcon
            key={folder.id}
            folder={folder}
            pos={pixelsOf(savedPlacement(folder, layer) || { col: 0, row: 0 }, layer)}
            renaming={renamingId === folder.id}
            onMoveStart={unlockManualPlacement}
            onRename={renameFolder}
            onOpen={(target) => void openFolder(target)}
            onMenu={(id, cx, cy) => {
              setInfo(null);
              setMenu({ ...layerPoint(cx, cy), folderId: id });
            }}
          />
        ))}

      {marquee && marquee.w + marquee.h > 0 &&
        layerRef.current &&
        createPortal(
          <div
            aria-hidden
            className="lykn-desktop-marquee pointer-events-none absolute z-[45]"
            style={{
              left: marquee.x,
              top: marquee.y,
              width: marquee.w,
              height: marquee.h,
            }}
          />,
          desktopRootOf(layerRef.current) || layerRef.current,
        )}

      {menu && (
        <DesktopMenu x={menu.x} y={menu.y}>
          {menu.folderId ? (
            <>
              <MenuRow
                icon={FolderOpen}
                label="Open"
                onClick={() => {
                  const folder = folders.find((f) => f.id === menu.folderId);
                  if (folder) void openFolder(folder);
                  else setMenu(null);
                }}
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
                onClick={() => void createFolder()}
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
                  if (visibility.hideWidgets) setVisibility({ hideWidgets: false });
                  if (onEditWidgets) onEditWidgets();
                  else openPage("settings", "display");
                }}
              />
              <MenuRow
                icon={visibility.hideFolders ? Eye : EyeOff}
                label={visibility.hideFolders ? "Show All Folders" : "Hide All Folders"}
                onMouseEnter={collapseSubmenus}
                onClick={() => {
                  setVisibility({ hideFolders: !visibility.hideFolders });
                  setMenu(null);
                }}
              />
              <MenuRow
                icon={visibility.hideFiles ? Eye : EyeOff}
                label={visibility.hideFiles ? "Show All Files" : "Hide All Files"}
                onMouseEnter={collapseSubmenus}
                onClick={() => {
                  setVisibility({ hideFiles: !visibility.hideFiles });
                  setMenu(null);
                }}
              />
              <MenuRow
                icon={visibility.hideWidgets ? Eye : EyeOff}
                label={visibility.hideWidgets ? "Show All Widgets" : "Hide All Widgets"}
                onMouseEnter={collapseSubmenus}
                onClick={() => {
                  setVisibility({ hideWidgets: !visibility.hideWidgets });
                  setMenu(null);
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
                  <MenuRow key={f.id} label={f.name} onClick={() => void openFolder(f)} />
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

/** Recent Image Gen tiles from the same vault AI Drive uses. */
function useVaultPreviewItems(userId, limit = 18) {
  return useQuery({
    queryKey: [AI_DRIVE_WIDGET_QUERY_KEY, "ai-drive-images", userId || "guest", activeVaultBackend()],
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: () => listAiDriveImages(userId, limit),
  });
}

/**
 * The vault takes a copy rather than moving anything: dropping a file here
 * uploads it and leaves the original on disk, which is why this doesn't go
 * through the folder drop path.
 */
function useVaultDesktopDrop(onOpen) {
  return useDropZone({
    accept: (payload) => payload.paths.length > 0,
    onDrop: (payload) => {
      queueVaultMacPaths(payload.paths);
      onOpen?.("vault", "/vault?pane=drive&folder=images");
    },
  });
}

/** Vault widget — Apple-Photos style: a strip that rotates through Image Gen
 *  in AI Drive, three tiles at a time. */
export function VaultWidget({ userId, size = "medium", onOpen }) {
  const { data: items = [], isLoading } = useVaultPreviewItems(userId);
  const [page, setPage] = useState(0);
  const vaultDrop = useVaultDesktopDrop(onOpen);
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
    <div
      ref={vaultDrop.ref}
      style={NO_DRAG}
      className={`${WIDGET} p-2 ${vaultDrop.hot ? "ring-2 ring-blue-400/80" : ""}`}
    >
      {items.length === 0 ? (
        <button
          type="button"
          onClick={() => onOpen?.("vault", "/vault?pane=drive&folder=images")}
          title="Open Image Gen"
          className="flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-[1rem] text-black/40 dark:text-white/40"
        >
          <Lock className="h-5 w-5" />
          <span className="text-[0.68rem]">
            {isLoading ? "Loading images…" : "No generated images yet"}
          </span>
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
                onClick={() =>
                  onOpen?.(
                    "vault",
                    `/vault?pane=drive&folder=images${item.id ? `&note=${encodeURIComponent(item.id)}` : ""}`,
                  )
                }
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

/**
 * One of the folders LYKN puts on the desktop itself (Files, Vault) rather
 * than one the user made. Same macOS look: a folder with a label under it,
 * click to open, drag to move, and where you drop it is remembered.
 *
 * Until it has been dragged it sits in its default slot, anchored from the
 * top-right the way the Finder fills a desktop. `slot` is that resting place
 * as a row index, so two parked icons can't land on top of each other.
 */
function PinnedFolderIcon({
  iconId,
  storageKey,
  slot = 0,
  label,
  title,
  tint = "text-sky-500",
  onOpen,
  dropTarget,
}) {
  const select = useDesktopSelect();
  const selected = select.isSelected(iconId);
  const layer = useDesktopLayer();
  const metrics = useDesktopMetrics();
  // null = the default anchored spot; a placement once dragged.
  const [saved, setSaved] = useState(() => {
    try {
      return savedIconPos(storageKey);
    } catch {
      return null; // default spot
    }
  });

  useDesktopGroupMove(({ positions, commit }) => {
    const next = positions?.[iconId];
    if (!next || !Number.isFinite(next.x) || !Number.isFinite(next.y)) return;
    const placement = placementOf(next, layer);
    setSaved(placement);
    if (!commit) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(placement));
    } catch {
      /* position just won't persist */
    }
  });

  const beginDrag = useDesktopIconDrag({ id: iconId });

  const placement = savedPlacement(saved, layer);
  const parked = placement ? pixelsOf(placement, layer) : null;
  const resting = parked
    ? { left: parked.x, top: parked.y }
    : { right: metrics.pad + 8, top: metrics.pad + 8 + slot * metrics.cellH };

  return (
    <button
      ref={dropTarget?.ref}
      type="button"
      data-desktop-icon={iconId}
      data-desktop-name={label}
      data-desktop-kind="Folder"
      onPointerDown={beginDrag}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        if (select.selected.size > 1 && selected) {
          select.selectOnly(iconId);
          return;
        }
        onOpen?.();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!selected) select.selectOnly(iconId);
      }}
      title={title}
      style={{ ...NO_DRAG, ...resting }}
      className={`${desktopIconClass(selected)} ${
        dropTarget?.hot ? "rounded-xl ring-2 ring-blue-400/90" : ""
      }`}
    >
      <Folder
        className={`${DESKTOP_ICON_ART_CLASS} ${tint} drop-shadow-[0_4px_10px_rgba(0,0,0,0.25)] transition-transform group-hover:scale-105 group-active:scale-95`}
        strokeWidth={1}
        fill="currentColor"
      />
      <span className={desktopIconLabelClass(selected)}>{label}</span>
    </button>
  );
}

export function FilesWidget({ onOpen }) {
  return (
    <PinnedFolderIcon
      iconId="pinned:files"
      storageKey={FILES_ICON_POS_KEY}
      slot={0}
      label="Files"
      title="Open Files"
      onOpen={() => onOpen?.("files")}
    />
  );
}

/** The vault as a folder you open, sitting on the desktop under Files. */
export function VaultFolderWidget({ onOpen }) {
  const vaultDrop = useVaultDesktopDrop(onOpen);
  return (
    <PinnedFolderIcon
      iconId="pinned:vault"
      storageKey={VAULT_ICON_POS_KEY}
      slot={1}
      label="Vault"
      title="Open Vault"
      tint="text-white"
      onOpen={() => onOpen?.("vault")}
      dropTarget={vaultDrop}
    />
  );
}
