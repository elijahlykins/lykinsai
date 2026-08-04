// LYKN Studio — the liquid-glass workspace.
//
// A visionOS-style glass panel — the app's primary shell. The Electron main
// window loads this route over HUD vibrancy (see createMainWindow). The
// Dashboard tab is a live widget grid; Chat / Projects / Vault / Settings
// mount the real product pages in-document (each inside its own MemoryRouter
// so internal navigation stays inside the panel while the window URL stays
// on /studio).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowUp,
  Bell,
  BellOff,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Clock,
  FolderKanban,
  Globe,
  Home,
  LayoutGrid,
  ListTodo,
  Lock,
  MapPin,
  Maximize2,
  MessageCircle,
  Minimize2,
  Minus,
  Newspaper,
  Paperclip,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Timer,
  X,
} from "lucide-react";
import lyknIconUrl from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-NEUTRAL-master.png";
import lyknIconBlueUrl from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-BLUE-master.png";
import lyknLogoUrl from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-NEUTRAL-web.png";
import lyknLogoBlueUrl from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-BLUE-web.png";
import LyknCalendarDialog from "@/components/calendar/LyknCalendarDialog";
import SettingsModal from "@/components/notes/SettingsModal";
import { useAuth } from "@/lib/SupabaseAuth";
import { supabase } from "@/lib/supabase";
import { listUserProjects } from "@/lib/userProjects";
import {
  fetchLyknChatsWithContext,
  searchLyknChatsByTitle,
} from "@/lib/lyknChat/fetchLyknChatsWithContext";
import { createNewChat } from "@/lib/chat/chatThreadsClient";
import { NEWS_POSTS } from "@/lib/newsPosts";
import { desktopHotkeyLabel, desktopModifierKey } from "@/lib/desktopHotkey";
import {
  MemoryRouter,
  Route,
  Routes,
  UNSAFE_LocationContext,
  UNSAFE_RouteContext,
} from "react-router-dom";
import LyknChat from "./LyknChat";
import VaultConnectionsShell from "./VaultConnectionsShell";
import ProjectsPage from "./ProjectsPage";
import ProjectDetailPage from "./ProjectDetailPage";
import SettingsPage from "./Settings";
import { subscribeLyknChatsChanged } from "@/lib/lyknChat/chatsChanged";
import { applyTheme, isDarkTheme, readSavedTheme } from "@/lib/theme";
import { isDesktopShell } from "@/lib/webAppAccess";
import ReactMarkdown from "react-markdown";
import {
  CHAT_REMARK_PLUGINS,
  CHAT_REHYPE_PLUGINS,
  normalizeMathDelimiters,
} from "@/lib/chat/chatMarkdown";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";

const THEME_STORAGE_KEY = "lykinsai_settings";

function persistTheme(theme) {
  try {
    const saved = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) || "{}");
    saved.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* preference still applies for this session */
  }
  applyTheme(theme);
}

const SECTIONS = [
  { id: "dashboard", label: "Dashboard", icon: Home },
  { id: "chat", label: "Chat", icon: MessageCircle, src: "/app" },
  { id: "projects", label: "Projects", icon: FolderKanban, src: "/projects" },
  { id: "vault", label: "Vault", icon: Lock, src: "/vault" },
  // Settings has no src: it opens as a dialog over the studio (its page is a
  // portaled modal that would escape a hidden surface wrapper and whose close
  // action navigates the surface away).
  { id: "settings", label: "Settings", icon: Settings },
];

// Left rail (icons) + bottom dock (words). "browser" docks the native agent
// browser into the center panel and "calendar" opens the Calendar / To-do
// dialog; the rest are embedded-page tabs.
const NAV_ITEMS = [
  { id: "dashboard", label: "Home", icon: Home, action: "tab" },
  { id: "chat", label: "Chat", icon: MessageCircle, action: "tab" },
  { id: "browser", label: "Browser", icon: Globe, action: "tab" },
  { id: "projects", label: "Projects", icon: FolderKanban, action: "tab" },
  { id: "vault", label: "Vault", icon: Lock, action: "tab" },
  { id: "calendar", label: "Calendar / To-do", icon: CalendarDays, action: "calendar" },
  { id: "settings", label: "Settings", icon: Settings, action: "tab" },
];

// Floating chrome (top bar pills, left rail, bottom dock). Glass (dark) =
// smoked frost over the window's vibrancy with light text; Neutral = the
// regular light UI: near-solid white surfaces with dark ink over the opaque
// backdrop. The rest of the shell's hardcoded white/NN utilities get
// remapped for Neutral in index.css ("STUDIO NEUTRAL").
const BAR =
  "border border-black/10 dark:border-white/10 " +
  "bg-white/80 dark:bg-black/40 backdrop-blur-2xl shadow-lg text-black/80 dark:text-white/85";

// The stage behind the dashboard cards — same surface family as the bars.
const FROST_PANEL =
  "border border-black/10 dark:border-white/10 bg-white/55 dark:bg-black/40";

// Widget cards: one step lighter than the stage so they lift off it.
const CARD =
  "rounded-[1.4rem] border border-black/10 dark:border-white/10 " +
  "bg-white/80 dark:bg-white/[0.08] backdrop-blur-xl " +
  "shadow-[0_8px_32px_rgba(0,0,0,0.1)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.25)] text-black/85 dark:text-white";

const DRAG = { WebkitAppRegion: "drag" };
const NO_DRAG = { WebkitAppRegion: "no-drag" };

/* ── In-document product surfaces ──────────────────────────────────────────
   Each tab hosts the REAL routed page inside its own MemoryRouter: internal
   navigation (opening a chat, drilling into a project) happens inside the
   panel while the window URL stays /studio. Every surface router carries all
   the product routes so cross-surface links keep working in place, exactly
   like the old same-origin iframes did. A new deep-link (`entry`) remounts
   the router at that path — same behavior as reloading an iframe src. */
function StudioSurface({ entry }) {
  // The app already renders inside a BrowserRouter, and react-router v6
  // refuses to mount a <Router> inside another one. Resetting the location
  // and route contexts makes this subtree a clean slate so the MemoryRouter
  // mounts as if it were the root router (the standard nested-router escape
  // hatch — the surfaces genuinely need independent navigation).
  return (
    <UNSAFE_RouteContext.Provider
      value={{ outlet: null, matches: [], isDataRoute: false }}
    >
      <UNSAFE_LocationContext.Provider value={null}>
        <MemoryRouter key={entry} initialEntries={[entry]}>
          <Routes>
            <Route path="/app" element={<LyknChat studioSurface />} />
            <Route path="/chat/:chatId" element={<LyknChat studioSurface />} />
            <Route path="/vault" element={<VaultConnectionsShell studioSurface />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={null} />
          </Routes>
        </MemoryRouter>
      </UNSAFE_LocationContext.Provider>
    </UNSAFE_RouteContext.Provider>
  );
}

/* ── Small helpers ─────────────────────────────────────────────────────── */

function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function relTime(ms) {
  const t = typeof ms === "string" ? new Date(ms).getTime() : Number(ms);
  if (!t || Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function startOfDayMs(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function eventDayLabel(iso) {
  const d = new Date(iso);
  const diffDays = Math.round((startOfDayMs(d) - startOfDayMs(new Date())) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

function eventTimeLabel(ev) {
  if (ev.all_day) return "All day";
  return new Date(ev.starts_at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function WidgetHeader({ icon: Icon, title, right, onOpen }) {
  return (
    <div className="flex flex-shrink-0 items-center justify-between">
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        style={NO_DRAG}
        className={`flex items-center gap-2 rounded-lg px-1 py-0.5 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-white/60 ${
          onOpen ? "hover:bg-white/10 transition-colors" : ""
        }`}
      >
        {Icon && <Icon className="h-3.5 w-3.5 text-white/45" />}
        {title}
      </button>
      {right}
    </div>
  );
}

function EmptyHint({ children }) {
  return (
    <p className="my-auto py-4 text-center text-[0.7rem] text-white/40">{children}</p>
  );
}

function SkeletonRows({ count = 3 }) {
  return (
    <div className="mt-3 space-y-2.5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-7 animate-pulse rounded-xl bg-white/[0.07]" />
      ))}
    </div>
  );
}

function CircleIconButton({ icon: Icon, active, label, onClick, expanded = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      style={NO_DRAG}
      className={`flex h-10 flex-shrink-0 items-center overflow-hidden rounded-full transition-all duration-200 ${
        expanded ? "w-full px-3" : "w-10 justify-center"
      } ${
        active
          ? "bg-black/85 text-white shadow-lg dark:bg-white dark:text-black"
          : "text-white/65 hover:bg-white/15"
      }`}
    >
      <Icon className="h-[1.05rem] w-[1.05rem] flex-shrink-0" />
      {/* Always mounted so the label slides/fades with the width animation
          instead of popping in mid-transition. */}
      <span
        className={`min-w-0 truncate text-[0.78rem] font-medium transition-all duration-150 ${
          expanded ? "ml-2.5 max-w-full opacity-100 delay-75" : "ml-0 max-w-0 opacity-0"
        }`}
      >
        {label}
      </span>
    </button>
  );
}

/* ── Data hooks ────────────────────────────────────────────────────────── */

/** Next 7 days of the user's calendar (lykn_events — same table the in-app
 *  calendar dialog reads, including synced Google/Apple events). Shared by
 *  the events column and the welcome counters; react-query dedupes it. */
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

function useUserProjects(userId, enabled = true) {
  return useQuery({
    queryKey: ["studio-projects", userId || "guest"],
    enabled: !!userId && enabled,
    staleTime: 60_000,
    queryFn: () => listUserProjects(userId),
  });
}

/* ── Dashboard widgets ─────────────────────────────────────────────────── */

/** Greeting + live daily counters (to-dos done today, events left today). */
function WelcomeCard({ userId, firstName, className }) {
  const { data: events = [] } = useWeekEvents(userId);
  const todayEnd = startOfDayMs(new Date()) + 86_400_000;
  const eventsLeft = events.filter((ev) => {
    const t = new Date(ev.starts_at).getTime();
    return t >= Date.now() - 3_600_000 && t < todayEnd;
  }).length;

  const { data: doneToday = 0 } = useQuery({
    queryKey: ["studio-done-today", userId || "guest"],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async () => {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const { count, error } = await supabase
        .from("lykn_todos")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "completed")
        .gte("completed_at", from.toISOString());
      if (error) throw error;
      return count || 0;
    },
  });

  return (
    <div className={`${CARD} ${className} flex items-center justify-between gap-4 p-5`}>
      <div className="min-w-0">
        <p className="truncate font-serif text-[1.5rem] italic tracking-tight text-white/95">
          {greeting()}, {firstName}
        </p>
        <p className="mt-1.5 text-[0.7rem] text-white/45">
          Here's what your day looks like.
        </p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2.5">
        <div className="rounded-2xl border border-white/10 bg-white/[0.07] px-4 py-2.5 text-center">
          <p className="text-[1.5rem] font-semibold leading-none">{doneToday}</p>
          <p className="mt-1.5 flex items-center gap-1 text-[0.6rem] text-white/50">
            <CheckCircle2 className="h-3 w-3 text-emerald-400" /> done today
          </p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.07] px-4 py-2.5 text-center">
          <p className="text-[1.5rem] font-semibold leading-none">{eventsLeft}</p>
          <p className="mt-1.5 flex items-center gap-1 text-[0.6rem] text-white/50">
            <CalendarDays className="h-3 w-3 text-blue-400" /> events left
          </p>
        </div>
      </div>
    </div>
  );
}

/** Big date + live clock. */
function DateCard({ className }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className={`${CARD} ${className} flex items-center justify-between p-5`}>
      <div>
        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-blue-400">
          {now.toLocaleDateString(undefined, { weekday: "long" })}
        </p>
        <p className="mt-1 text-[2.4rem] font-semibold leading-none tracking-tight">
          {now.getDate()}
        </p>
        <p className="mt-1 text-[0.7rem] text-white/50">
          {now.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </p>
      </div>
      <div className="text-right">
        <p className="text-[1.2rem] font-medium tabular-nums text-white/85">
          {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </p>
      </div>
    </div>
  );
}

/** Full-height events column for the next 7 days. */
function EventsColumn({ userId, onOpenCalendar, className }) {
  const { data: events = [], isLoading } = useWeekEvents(userId);
  return (
    <div className={`${CARD} ${className} flex flex-col p-4`}>
      <WidgetHeader
        icon={CalendarDays}
        title="Events"
        right={
          <button
            type="button"
            onClick={() => onOpenCalendar?.("calendar")}
            title="Open calendar"
            aria-label="Open calendar"
            style={NO_DRAG}
            className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-white/10 transition-colors"
          >
            <Plus className="h-3.5 w-3.5 text-white/50" />
          </button>
        }
      />
      {isLoading ? (
        <SkeletonRows count={5} />
      ) : events.length === 0 ? (
        <EmptyHint>Nothing scheduled this week</EmptyHint>
      ) : (
        <div className="mt-2.5 min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5 scrollbar-hide">
          {events.map((ev) => (
            <div
              key={ev.id}
              className="rounded-xl border border-white/[0.06] bg-white/[0.07] px-3 py-2.5"
              style={{ borderLeft: `3px solid ${ev.color || "#3b82f6"}` }}
            >
              <p className="truncate text-[0.76rem] font-medium text-white/90">
                {ev.title || "Untitled event"}
              </p>
              <div className="mt-1 flex items-center gap-2 text-[0.62rem] text-white/45">
                <span className="font-medium text-white/60">{eventDayLabel(ev.starts_at)}</span>
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" /> {eventTimeLabel(ev)}
                </span>
                {ev.location && (
                  <span className="flex min-w-0 items-center gap-1">
                    <MapPin className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{ev.location}</span>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Open to-dos (lykn_todos) with working check-off — same table and status
 *  semantics as the in-app to-do panel. */
function TodosWidget({ userId, onOpenCalendar, className }) {
  const queryClient = useQueryClient();
  const queryKey = ["studio-todos", userId || "guest"];
  const { data: todos = [], isLoading } = useQuery({
    queryKey,
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lykn_todos")
        .select("id, title, status, priority, due_at, due_at_text, created_at")
        .eq("user_id", userId)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return data || [];
    },
  });

  const toggle = async (todo) => {
    const nextStatus = todo.status === "completed" ? "open" : "completed";
    // Optimistic: flip in-place so the strikethrough lands immediately.
    queryClient.setQueryData(queryKey, (rows = []) =>
      rows.map((r) => (r.id === todo.id ? { ...r, status: nextStatus } : r)),
    );
    const { error } = await supabase
      .from("lykn_todos")
      .update({
        status: nextStatus,
        completed_at: nextStatus === "completed" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", todo.id)
      .eq("user_id", userId);
    if (error) {
      queryClient.setQueryData(queryKey, (rows = []) =>
        rows.map((r) => (r.id === todo.id ? { ...r, status: todo.status } : r)),
      );
    }
  };

  const openCount = todos.filter((t) => t.status === "open").length;
  return (
    <div className={`${CARD} ${className} flex flex-col p-4`}>
      <WidgetHeader
        icon={ListTodo}
        title="To-dos"
        right={
          <span className="flex items-center gap-1">
            <span className="rounded-full border border-white/10 bg-white/[0.07] px-2.5 py-1 text-[0.62rem] font-medium text-white/70">
              {openCount} open
            </span>
            <button
              type="button"
              onClick={() => onOpenCalendar?.("todos")}
              title="Open to-dos"
              aria-label="Open to-dos"
              style={NO_DRAG}
              className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-white/10 transition-colors"
            >
              <Plus className="h-3.5 w-3.5 text-white/50" />
            </button>
          </span>
        }
      />
      {isLoading ? (
        <SkeletonRows count={4} />
      ) : todos.length === 0 ? (
        <EmptyHint>All clear — nothing on the list</EmptyHint>
      ) : (
        <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5 scrollbar-hide">
          {todos.map((todo) => {
            const done = todo.status === "completed";
            return (
              <button
                key={todo.id}
                type="button"
                onClick={() => toggle(todo)}
                style={NO_DRAG}
                className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.08] transition-colors"
              >
                <span
                  className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors ${
                    done
                      ? "border-emerald-400 bg-emerald-400 text-black"
                      : "border-emerald-400/80"
                  }`}
                >
                  {done && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate text-[0.76rem] ${
                    done ? "text-white/35 line-through" : "text-white/85"
                  }`}
                >
                  {todo.title || "Untitled"}
                </span>
                {todo.due_at_text && !done && (
                  <span className="flex-shrink-0 rounded-md border border-white/10 bg-white/[0.07] px-1.5 py-0.5 text-[0.58rem] text-white/55">
                    {todo.due_at_text}
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

/** Active projects, most recently touched first. Clicking one deep-links the
 *  Projects tab straight to that project. */
function ProjectsWidget({ userId, onOpen, className }) {
  const { data: projects = [], isLoading } = useUserProjects(userId);
  const active = projects.filter((p) => p.status === "active").slice(0, 6);

  return (
    <div className={`${CARD} ${className} flex flex-col p-4`}>
      <WidgetHeader
        icon={FolderKanban}
        title="Projects"
        onOpen={() => onOpen?.("projects")}
        right={
          <button
            type="button"
            onClick={() => onOpen?.("projects")}
            title="All projects"
            aria-label="All projects"
            style={NO_DRAG}
            className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-white/10 transition-colors"
          >
            <ChevronRight className="h-3.5 w-3.5 text-white/40" />
          </button>
        }
      />
      {isLoading ? (
        <SkeletonRows count={4} />
      ) : active.length === 0 ? (
        <EmptyHint>No active projects yet</EmptyHint>
      ) : (
        <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5 scrollbar-hide">
          {active.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() =>
                onOpen?.("projects", `/projects/${encodeURIComponent(p.id)}`)
              }
              style={NO_DRAG}
              className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.08] transition-colors"
            >
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-[0.7rem] font-semibold text-white/85 shadow-sm backdrop-blur-sm">
                {(p.name || "?").charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.76rem] font-medium text-white/85">
                  {p.name || "Untitled project"}
                </span>
                <span className="block text-[0.6rem] text-white/40">
                  {p.isShared ? "Shared · " : ""}
                  {relTime(p.lastActiveAt)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Chats touched per day over the last 7 days, as a minimal bar graph. */
function ActivityWidget({ userId, className }) {
  const { data, isLoading } = useQuery({
    queryKey: ["studio-activity", userId || "guest"],
    enabled: !!userId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const from = new Date(startOfDayMs(new Date()) - 6 * 86_400_000);
      const { data: rows, error } = await supabase
        .from("lykn_chats")
        .select("updated_at")
        .eq("user_id", userId)
        .gte("updated_at", from.toISOString())
        .limit(500);
      if (error) throw error;
      const buckets = Array.from({ length: 7 }, (_, i) => {
        const day = new Date(from.getTime() + i * 86_400_000);
        return { day, count: 0 };
      });
      for (const row of rows || []) {
        const idx = Math.floor(
          (new Date(row.updated_at).getTime() - from.getTime()) / 86_400_000,
        );
        if (idx >= 0 && idx < 7) buckets[idx].count += 1;
      }
      return buckets;
    },
  });

  const buckets = data || [];
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const max = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div className={`${CARD} ${className} flex flex-col p-4`}>
      <WidgetHeader
        icon={Activity}
        title="Activity"
        right={
          <span className="rounded-full border border-white/10 bg-white/[0.07] px-2.5 py-1 text-[0.62rem] font-medium text-white/70">
            {total} this week
          </span>
        }
      />
      {isLoading ? (
        <SkeletonRows count={3} />
      ) : (
        <div className="mt-3 flex min-h-0 flex-1 items-end justify-between gap-2 px-1 pb-1">
          {buckets.map(({ day, count }, i) => {
            const isToday = i === buckets.length - 1;
            return (
              <div key={day.getTime()} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
                <span className="text-[0.58rem] tabular-nums text-white/45">{count || ""}</span>
                <div
                  className={`w-full max-w-[1.1rem] rounded-full ${
                    isToday
                      ? "bg-gradient-to-t from-blue-500 to-indigo-400"
                      : "bg-white/25"
                  }`}
                  style={{ height: `${Math.max(8, (count / max) * 100)}%` }}
                />
                <span className={`text-[0.58rem] ${isToday ? "font-semibold text-white/80" : "text-white/40"}`}>
                  {day.toLocaleDateString(undefined, { weekday: "narrow" })}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Latest LYKN updates (release notes / news posts). */
function UpdatesWidget({ className }) {
  const posts = NEWS_POSTS.slice(0, 3);
  const open = (slug) => {
    const url = `https://lykn.io/news/${slug}`;
    if (window.lykn?.openExternal) window.lykn.openExternal(url);
    else window.open(url, "_blank", "noopener");
  };
  return (
    <div className={`${CARD} ${className} flex flex-col p-4`}>
      <WidgetHeader icon={Newspaper} title="Updates" />
      <div className="mt-2 grid min-h-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
        {posts.map((post) => (
          <button
            key={post.slug}
            type="button"
            onClick={() => open(post.slug)}
            style={NO_DRAG}
            className="flex min-w-0 flex-col justify-between rounded-xl border border-white/[0.06] bg-white/[0.07] px-3 py-2.5 text-left hover:bg-white/[0.12] transition-colors"
          >
            <p className="truncate text-[0.74rem] font-medium text-white/90">{post.title}</p>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="rounded-full bg-blue-500/25 px-2 py-0.5 text-[0.56rem] font-semibold uppercase tracking-wide text-blue-300">
                {post.tag}
              </span>
              <span className="text-[0.6rem] text-white/40">{post.date}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Preset: most recent chats — clicking one deep-links the Chat tab. */
function RecentChatsWidget({ userId, onOpen, className }) {
  const { data: chats = [], isLoading } = useQuery({
    queryKey: ["studio-chats", userId || "guest"],
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: () => fetchLyknChatsWithContext(userId, 8),
  });
  return (
    <div className={`${CARD} ${className} flex flex-col p-4`}>
      <WidgetHeader icon={MessageCircle} title="Recent Chats" onOpen={() => onOpen?.("chat")} />
      {isLoading ? (
        <SkeletonRows count={4} />
      ) : chats.length === 0 ? (
        <EmptyHint>No chats yet — ask LYKN anything</EmptyHint>
      ) : (
        <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5 scrollbar-hide">
          {chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              onClick={() => onOpen?.("chat", `/chat/${encodeURIComponent(chat.id)}`)}
              style={NO_DRAG}
              className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.08] transition-colors"
            >
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-blue-500/20 text-blue-300">
                <MessageCircle className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.76rem] font-medium text-white/85">
                  {chat.title || "Untitled chat"}
                </span>
                <span className="block text-[0.6rem] text-white/40">{relTime(chat.updated_at)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Preset: quick vault search. */
function VaultSearchWidget({ onOpen, className }) {
  const [q, setQ] = useState("");
  return (
    <div className={`${CARD} ${className} flex flex-col justify-between p-4`}>
      <WidgetHeader icon={Search} title="Vault Search" onOpen={() => onOpen?.("vault")} />
      <div className="mt-2 flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.07] px-3 py-2">
        <Search className="h-3.5 w-3.5 flex-shrink-0 text-white/40" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onOpen?.("vault");
          }}
          placeholder="Search your vault…"
          className="w-full min-w-0 bg-transparent text-[0.78rem] text-white/85 outline-none placeholder:text-white/35"
          style={NO_DRAG}
        />
      </div>
      <p className="mt-2 text-[0.62rem] text-white/35">Press Enter to open the Vault</p>
    </div>
  );
}

/** Preset: launcher tiles for the main sections. */
function QuickAppsWidget({ onOpen, className }) {
  const tiles = [
    { id: "chat", label: "Chat", icon: MessageCircle, bg: "bg-gradient-to-br from-blue-500 to-blue-700" },
    { id: "vault", label: "Vault", icon: Lock, bg: "bg-gradient-to-br from-emerald-500 to-teal-700" },
    { id: "projects", label: "Projects", icon: FolderKanban, bg: "bg-gradient-to-br from-amber-500 to-orange-600" },
    { id: "settings", label: "Settings", icon: Settings, bg: "bg-gradient-to-br from-slate-500 to-slate-700" },
  ];
  return (
    <div className={`${CARD} ${className} flex flex-col p-4`}>
      <WidgetHeader icon={LayoutGrid} title="Quick Apps" />
      <div className="mt-2 flex min-h-0 flex-1 flex-wrap content-center items-center justify-center gap-2.5">
        {tiles.map(({ id, label, icon: Icon, bg }) => (
          <button
            key={id}
            type="button"
            onClick={() => onOpen?.(id)}
            title={label}
            style={NO_DRAG}
            className={`flex h-14 w-14 items-center justify-center rounded-[1rem] ${bg} text-white shadow-lg transition-transform hover:scale-[1.05]`}
          >
            <Icon className="h-6 w-6" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Preset: simple 25-minute focus timer. */
function FocusTimerWidget({ className }) {
  const TOTAL = 25 * 60;
  const [secondsLeft, setSecondsLeft] = useState(TOTAL);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (secondsLeft === 0) setRunning(false);
  }, [secondsLeft]);
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");
  return (
    <div className={`${CARD} ${className} flex flex-col p-4`}>
      <WidgetHeader icon={Timer} title="Focus" />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
        <p className="text-[2.2rem] font-semibold tabular-nums leading-none tracking-tight">
          {mm}:{ss}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setRunning((v) => !v)}
            style={NO_DRAG}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-black/85 text-white shadow transition-transform hover:scale-105 dark:bg-white dark:text-black"
            title={running ? "Pause" : "Start"}
          >
            {running ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => {
              setRunning(false);
              setSecondsLeft(TOTAL);
            }}
            style={NO_DRAG}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-white/[0.07] text-white/70 hover:bg-white/15 transition-colors"
            title="Reset"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Widget registry + layout slots ────────────────────────────────────── */

const WIDGETS = {
  welcome: { label: "Welcome", description: "Greeting with daily counters", icon: Sparkles, component: WelcomeCard },
  date: { label: "Date & Time", description: "Today's date with a live clock", icon: CalendarDays, component: DateCard },
  events: { label: "Events", description: "Your calendar for the next 7 days", icon: CalendarDays, component: EventsColumn },
  todos: { label: "To-dos", description: "Open tasks with working check-off", icon: ListTodo, component: TodosWidget },
  projects: { label: "Projects", description: "Active projects, recently touched first", icon: FolderKanban, component: ProjectsWidget },
  activity: { label: "Activity", description: "Chats per day over the last week", icon: Activity, component: ActivityWidget },
  updates: { label: "Updates", description: "Latest LYKN news and releases", icon: Newspaper, component: UpdatesWidget },
  recentChats: { label: "Recent Chats", description: "Jump back into a conversation", icon: MessageCircle, component: RecentChatsWidget },
  vaultSearch: { label: "Vault Search", description: "Quick search into your Vault", icon: Search, component: VaultSearchWidget },
  quickApps: { label: "Quick Apps", description: "Launcher tiles for every section", icon: LayoutGrid, component: QuickAppsWidget },
  focusTimer: { label: "Focus Timer", description: "A simple 25-minute timer", icon: Timer, component: FocusTimerWidget },
};

// Fixed grid slots (12 cols × 8 rows = 96 cells, exact fit). A widget adopts
// the size of whichever slot it's placed in.
const SLOTS = [
  { id: "hero", sizeLabel: "Wide", className: "col-span-12 sm:col-span-6 xl:col-span-6 xl:row-span-2" },
  { id: "side", sizeLabel: "Small", className: "col-span-12 sm:col-span-6 xl:col-span-3 xl:row-span-2" },
  { id: "tall", sizeLabel: "Tall column", className: "col-span-12 sm:col-span-6 xl:col-span-3 xl:row-span-8" },
  { id: "midA", sizeLabel: "Medium", className: "col-span-12 sm:col-span-6 xl:col-span-3 xl:row-span-4" },
  { id: "midB", sizeLabel: "Medium", className: "col-span-12 sm:col-span-6 xl:col-span-3 xl:row-span-4" },
  { id: "midC", sizeLabel: "Medium", className: "col-span-12 sm:col-span-6 xl:col-span-3 xl:row-span-4" },
  { id: "bottom", sizeLabel: "Wide strip", className: "col-span-12 xl:col-span-9 xl:row-span-2" },
];

const DEFAULT_LAYOUT = {
  hero: "welcome",
  side: "date",
  tall: "events",
  midA: "todos",
  midB: "projects",
  midC: "activity",
  bottom: "updates",
};

function DashboardGrid({ userId, firstName, onOpen, onOpenCalendar }) {
  const layout = DEFAULT_LAYOUT;
  return (
    <div className="grid h-full w-full grid-cols-12 xl:grid-rows-8 gap-3 overflow-y-auto p-4 scrollbar-hide">
      {SLOTS.map(({ id, className }) => {
        const widget = WIDGETS[layout[id]];
        if (!widget) return null;
        const W = widget.component;
        return (
          <W
            key={`${id}:${layout[id]}`}
            className={className}
            userId={userId}
            firstName={firstName}
            onOpen={onOpen}
            onOpenCalendar={onOpenCalendar}
          />
        );
      })}
    </div>
  );
}

/* ── Studio-wide search (top bar) ──────────────────────────────────────── */

function StudioSearch({ userId, onOpen }) {
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const needle = q.trim().toLowerCase();
  const debounced = useDebounced(needle);

  const { data: chatHits = [] } = useQuery({
    queryKey: ["studio-search-chats", userId || "guest", debounced],
    enabled: !!userId && debounced.length >= 2,
    staleTime: 30_000,
    queryFn: () => searchLyknChatsByTitle(userId, debounced, 5),
  });
  const { data: projects = [] } = useUserProjects(userId, needle.length >= 2);
  const projectHits =
    needle.length >= 2
      ? projects.filter((p) => (p.name || "").toLowerCase().includes(needle)).slice(0, 4)
      : [];
  const sectionHits = needle
    ? SECTIONS.filter((s) => s.label.toLowerCase().includes(needle))
    : [];

  const showResults = focused && needle.length >= 2;
  const hasResults = sectionHits.length > 0 || projectHits.length > 0 || chatHits.length > 0;

  const choose = (fn) => {
    fn();
    setQ("");
    setFocused(false);
  };

  const Row = ({ icon: Icon, primary, secondary, onPick }) => (
    <button
      type="button"
      onClick={() => choose(onPick)}
      className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-white/10 transition-colors"
    >
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-white/10 text-white/70">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[0.76rem] text-white/85">{primary}</span>
      {secondary && <span className="flex-shrink-0 text-[0.6rem] text-white/40">{secondary}</span>}
    </button>
  );

  return (
    <div className={`relative flex min-w-0 flex-1 items-center gap-2.5 rounded-full px-3 py-2 ${BAR}`}>
      <Search className="h-4 w-4 flex-shrink-0 text-white/45" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQ("");
            e.currentTarget.blur();
          }
        }}
        placeholder="Search LYKN Studio…"
        className="w-full min-w-0 bg-transparent text-[0.8rem] outline-none placeholder:text-white/40"
        style={NO_DRAG}
      />
      {showResults && (
        <div
          className={`absolute left-0 right-0 top-full z-[90] mt-2 max-h-[50vh] overflow-y-auto rounded-2xl p-2 scrollbar-hide ${BAR}`}
          style={NO_DRAG}
          onMouseDown={(e) => e.preventDefault()}
        >
          {!hasResults ? (
            <p className="px-2.5 py-3 text-center text-[0.7rem] text-white/40">
              No matches in Studio
            </p>
          ) : (
            <>
              {sectionHits.map((s) => (
                <Row
                  key={`section-${s.id}`}
                  icon={s.icon}
                  primary={s.label}
                  secondary="Section"
                  onPick={() => onOpen?.(s.id)}
                />
              ))}
              {projectHits.map((p) => (
                <Row
                  key={`project-${p.id}`}
                  icon={FolderKanban}
                  primary={p.name || "Untitled project"}
                  secondary="Project"
                  onPick={() =>
                    onOpen?.("projects", `/projects/${encodeURIComponent(p.id)}`)
                  }
                />
              ))}
              {chatHits.map((c) => (
                <Row
                  key={`chat-${c.id}`}
                  icon={MessageCircle}
                  primary={c.title || "Untitled chat"}
                  secondary="Chat"
                  onPick={() =>
                    onOpen?.("chat", `/chat/${encodeURIComponent(c.id)}`)
                  }
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

/* ── Browser tab: glass agent rail (agent list + chat bar) ─────────────── */

// The Glass overlay's glowing LYKN dot, for the rail's chat bar.
function GlassDot({ busy }) {
  return (
    <svg
      viewBox="0 0 204.29 204.29"
      fill="none"
      aria-hidden="true"
      className={`h-5 w-5 flex-none text-[#3b78ff] drop-shadow-[0_0_3px_rgba(59,120,255,0.85)] ${
        busy ? "animate-pulse" : ""
      }`}
    >
      <path
        d="M167.39,60.26l-.86-.39c-9.83-4.41-17.7-12.28-22.12-22.12l-.39-.86c-1.77-3.94-7.36-3.94-9.13,0l-.39.86c-4.41,9.83-12.28,17.71-22.12,22.12l-.86.39c-3.94,1.77-3.94,7.36,0,9.13l.86.39c9.83,4.41,17.7,12.28,22.12,22.12l.39.86c1.77,3.94,7.36,3.94,9.13,0l.39-.86c4.41-9.83,12.28-17.7,22.12-22.12l.86-.39c3.94-1.77,3.94-7.36,0-9.13ZM134.87,116.05c-14.73,2.8-17.97,18.72-32.73,18.72-8.11,0-12.75-4.81-17.72-9.61-1.8-1.73-3.56-3.5-5.29-5.29-4.8-4.98-9.62-9.61-9.62-17.73,0-14.76,15.93-18,18.72-32.73,2.66-14.03-7.74-27.55-21.99-28.38-13.8-.8-25.24,10.16-25.24,23.79,0,18.8,19.14,21.14,19.14,37.32s-19.14,18.52-19.14,37.32c0,13.16,10.67,23.83,23.83,23.83,18.8,0,21.14-19.14,37.32-19.14s18.52,19.14,37.32,19.14c13.63,0,24.58-11.44,23.78-25.24-.82-14.25-14.35-24.66-28.38-21.99Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function historySubLabel(h) {
  let host = "";
  try {
    host = h.url ? new URL(h.url).hostname.replace(/^www\./, "") : "";
  } catch {
    /* unparsable url */
  }
  let when = "";
  try {
    if (h.closedAt) {
      when = new Date(h.closedAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
    }
  } catch {
    /* bad timestamp */
  }
  if (host && when) return `${host} · ${when}`;
  return host || when || "agent";
}

function agentSubLabel(a) {
  const skill = String(a.skill || "").trim();
  const step = String(a.step || a.status || "idle").trim();
  if (skill && step && step !== skill) return `${skill} · ${step}`;
  return skill || step || "idle";
}

/**
 * Deliverable pill for `![lykn_step:kind:title](lykn-agent-step://agent/idx)`
 * markers in agent answers — click opens that step's report/artifact/image in
 * the agent's browser subtab (same behavior as the Glass overlay's step chips).
 */
function RailStepPill({ src, alt }) {
  const m = /^lykn-agent-step:\/\/([^/]+)\/(\d+)/i.exec(String(src || ""));
  const agentId = m?.[1] || "";
  const stepIndex = m ? Number(m[2]) : null;
  let kind = "text";
  let title = String(alt || "").replace(/^lykn[-_]step\s*:/i, "").trim();
  const kt = String(alt || "").match(/^lykn[-_]step\s*:([^:]+):(.+)$/i);
  if (kt) {
    kind = String(kt[1] || "text").trim().toLowerCase();
    title = String(kt[2] || title).trim();
  }
  const kindLabel =
    kind === "report"
      ? "Report"
      : kind === "artifact"
        ? "Presentation"
        : kind === "browse"
          ? "Browser"
          : kind === "image"
            ? "Image"
            : "Step";
  const stepNum = /^\s*step\s+(\d+)/i.exec(title)?.[1] || "";
  const shortTitle =
    title.replace(/^\s*step\s+\d+\s*[—–\-·:]\s*/i, "").trim() || kindLabel;
  return (
    <button
      type="button"
      title="Open in the browser"
      onClick={() => {
        if (stepIndex == null) return;
        void window.lykn?.agentShowStep?.(agentId, stepIndex);
      }}
      className="my-1 flex w-full max-w-full items-center gap-2 rounded-full border border-white/20 bg-white/[0.08] px-2.5 py-1.5 text-left text-[0.72rem] text-white/85 transition hover:bg-white/[0.14]"
    >
      {stepNum ? (
        <span className="flex h-4 w-4 flex-none items-center justify-center rounded-full bg-white/15 text-[0.6rem] font-semibold text-white/80">
          {stepNum}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate font-medium text-white/90">{shortTitle}</span>
      <span className="flex-none text-[0.62rem] uppercase tracking-wide text-white/50">
        {kindLabel}
      </span>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="h-3 w-3 flex-none text-white/60"
        aria-hidden="true"
      >
        <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

// Markdown for the agent rail — same remark/rehype pipeline as the main chat,
// with components sized for the narrow dark-glass thread.
const RAIL_MD_COMPONENTS = {
  img: ({ src, alt }) => {
    const s = String(src || "");
    const a = String(alt || "");
    // Deliverable step markers render as clickable "open" pills, not images.
    if (/^lykn-agent-step:\/\//i.test(s) || /^lykn[-_]step\s*:/i.test(a)) {
      return <RailStepPill src={s} alt={a} />;
    }
    if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) {
      return (
        <img
          src={s}
          alt={a}
          className="my-1.5 h-auto max-h-44 w-auto max-w-full rounded-lg border border-white/15"
        />
      );
    }
    // Unknown lykn-* markers: never show a broken-image glyph.
    return null;
  },
  p: (props) => <p className="mb-1.5 last:mb-0" {...props} />,
  ul: (props) => <ul className="mb-1.5 list-disc space-y-0.5 pl-4 last:mb-0" {...props} />,
  ol: (props) => <ol className="mb-1.5 list-decimal space-y-0.5 pl-4 last:mb-0" {...props} />,
  li: (props) => <li className="leading-relaxed" {...props} />,
  h1: (props) => <p className="mb-1 mt-2 text-[0.82rem] font-bold text-white first:mt-0" {...props} />,
  h2: (props) => <p className="mb-1 mt-2 text-[0.8rem] font-bold text-white first:mt-0" {...props} />,
  h3: (props) => <p className="mb-1 mt-1.5 text-[0.78rem] font-semibold text-white first:mt-0" {...props} />,
  h4: (props) => <p className="mb-1 mt-1.5 text-[0.78rem] font-semibold text-white/90 first:mt-0" {...props} />,
  strong: (props) => <strong className="font-semibold text-white" {...props} />,
  a: ({ children, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noreferrer"
      className="text-sky-300 underline underline-offset-2 hover:text-sky-200"
    >
      {children}
    </a>
  ),
  blockquote: (props) => (
    <blockquote className="mb-1.5 border-l-2 border-white/25 pl-2 text-white/70" {...props} />
  ),
  hr: () => <div className="my-2 border-t border-white/15" />,
  code: (props) => (
    <code
      className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.7rem] text-white/90"
      {...props}
    />
  ),
  pre: (props) => (
    <pre
      className="mb-1.5 overflow-x-auto rounded-lg bg-black/40 p-2 text-[0.7rem] leading-relaxed last:mb-0 [&>code]:bg-transparent [&>code]:p-0"
      {...props}
    />
  ),
  table: (props) => (
    <div className="mb-1.5 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-[0.7rem]" {...props} />
    </div>
  ),
  th: (props) => (
    <th className="border border-white/15 bg-white/[0.06] px-1.5 py-1 text-left font-semibold" {...props} />
  ),
  td: (props) => <td className="border border-white/15 px-1.5 py-1 align-top" {...props} />,
};

function RailMarkdown({ children }) {
  return (
    <ReactMarkdown
      remarkPlugins={CHAT_REMARK_PLUGINS}
      rehypePlugins={CHAT_REHYPE_PLUGINS}
      components={RAIL_MD_COMPONENTS}
    >
      {normalizeMathDelimiters(String(children || ""))}
    </ReactMarkdown>
  );
}

// Agent icon color: grey idle → blue while working → green when finished.
function agentToneClass(a) {
  if (a.status === "running" || a.status === "waiting" || a.busy) {
    return "animate-pulse text-[#3b78ff]";
  }
  if (a.status === "error") return "text-red-400";
  const step = String(a.step || "").trim().toLowerCase();
  // A worker that has run leaves a step behind ("Done", "Stopped", last action).
  if (step && step !== "orchestrator" && step !== "idle") return "text-emerald-400";
  return "text-white/40";
}

function StudioAgentRail({ desktop }) {
  const [open, setOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [agents, setAgents] = useState([]);
  // Closed tabs/agents, newest first — the "History" list under Agents.
  const [history, setHistory] = useState([]);
  const [activeId, setActiveId] = useState(null);
  // Active agent's conversation: prompts + finished answers, plus the
  // in-flight streaming draft and a live status line while it works.
  const [thread, setThread] = useState([]);
  const [draft, setDraft] = useState("");
  const [liveStep, setLiveStep] = useState("");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState([]);
  const taRef = useRef(null);
  const threadRef = useRef(null);
  const activeIdRef = useRef(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Live agent list + thread — same feeds as Glass and the floating sidebar.
  useEffect(() => {
    if (!desktop || !window.lykn?.agentList) return;
    let dead = false;
    const apply = (p) => {
      if (dead || !p) return;
      setAgents(Array.isArray(p.agents) ? p.agents : []);
      setActiveId(p.activeAgentId || null);
    };
    window.lykn
      .agentList()
      .then(apply)
      .catch(() => {});
    const offList = window.lykn.onAgentList?.(apply);
    const offProgress = window.lykn.onAgentProgress?.((p) => {
      if (dead || !p?.agentId) return;
      setAgents((prev) => prev.map((a) => (a.id === p.agentId ? { ...a, ...p } : a)));
      if (p.agentId === activeIdRef.current && p.step && p.status === "running") {
        setLiveStep(String(p.step));
      }
    });
    const offSwitched = window.lykn.onAgentSwitched?.((p) => {
      if (dead) return;
      setActiveId(p?.agentId || null);
      setThread(Array.isArray(p?.history) ? p.history : []);
      setDraft(String(p?.partialText || ""));
      setLiveStep(p?.busy ? String(p?.step || "Working…") : "");
    });
    const offDelta = window.lykn.onAgentDelta?.((p) => {
      if (dead || (p?.agentId && p.agentId !== activeIdRef.current)) return;
      const t = String(p?.text || "").trim();
      if (p?.writing) {
        const n = Number(p.chars) || t.length || 0;
        setLiveStep(
          n > 0 ? `Writing output… (${n.toLocaleString()} chars)` : "Writing output…",
        );
        // Stream the growing summary into the draft — don't leave a bare spinner.
        if (t) setDraft(t);
        return;
      }
      if (p?.status && !t) {
        setLiveStep(String(p.status));
        return;
      }
      if (!t) {
        if (p?.status) setLiveStep(String(p.status));
        return;
      }
      // Show whatever the agent streams, rendered as markdown — including
      // clickable step chips (`lykn-agent-step://…`).
      setDraft(t);
      if (p?.final) setLiveStep("");
      else if (p?.status) setLiveStep(String(p.status));
    });
    const offDone = window.lykn.onAgentDone?.((p) => {
      if (dead || (p?.agentId && p.agentId !== activeIdRef.current)) return;
      const finalText = String(p?.text || "").trim();
      setLiveStep("");
      setDraft("");
      if (!finalText) return;
      setThread((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.content === finalText) return prev;
        return [
          ...prev,
          { role: "assistant", content: finalText, at: new Date().toISOString() },
        ];
      });
    });
    return () => {
      dead = true;
      offList?.();
      offProgress?.();
      offSwitched?.();
      offDelta?.();
      offDone?.();
    };
  }, [desktop]);

  // Browser history feed — closed tabs/agents land here (Chrome-style).
  useEffect(() => {
    if (!desktop || !window.lykn?.agentBrowserHistoryList) return;
    let dead = false;
    const apply = (p) => {
      if (dead || !p) return;
      setHistory(Array.isArray(p.items) ? p.items : []);
    };
    window.lykn
      .agentBrowserHistoryList()
      .then(apply)
      .catch(() => {});
    const off = window.lykn.onAgentBrowserHistory?.(apply);
    return () => {
      dead = true;
      off?.();
    };
  }, [desktop]);

  // Load the thread when the rail mounts or the active agent changes.
  useEffect(() => {
    if (!desktop || !activeId || !window.lykn?.agentHistory) return;
    let dead = false;
    window.lykn
      .agentHistory(activeId)
      .then((snap) => {
        if (dead || !snap) return;
        setThread(Array.isArray(snap.history) ? snap.history : []);
        setDraft(String(snap.partialText || ""));
        setLiveStep(snap.busy ? String(snap.step || "Working…") : "");
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [desktop, activeId]);

  // Pin the thread to the newest message as answers stream in.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, draft, liveStep, open]);

  const autoGrow = (el) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(120, el.scrollHeight)}px`;
  };

  const send = async () => {
    const goal = text.trim();
    if ((!goal && !attachments.length) || !window.lykn?.studioAgentSend) return;
    // Only the ACTIVE agent being mid-run blocks a send — other agents run
    // in parallel, so switching to an idle agent always lets you prompt it.
    const target = agents.find((a) => a.id === activeIdRef.current);
    if (target && (target.busy || target.status === "running")) return;
    const targetId = activeIdRef.current;
    const atts = attachments;
    setText("");
    setAttachments([]);
    if (taRef.current) taRef.current.style.height = "auto";
    // Show the prompt immediately — the runtime's switch/seed events follow.
    setThread((prev) => [
      ...prev,
      {
        role: "user",
        content: goal || `(${atts.length} attachment${atts.length === 1 ? "" : "s"})`,
        at: new Date().toISOString(),
      },
    ]);
    setLiveStep("Starting…");
    // Fire and forget: the promise resolves only when the whole run finishes,
    // and awaiting it would freeze the composer for every other agent.
    // Progress/done events stream the run into whichever agent is viewed.
    window.lykn.studioAgentSend(goal, atts, targetId).catch(() => {
      if (activeIdRef.current === targetId) setLiveStep("");
    });
  };

  const attach = async () => {
    try {
      const picked = await window.lykn?.pickFiles?.();
      if (Array.isArray(picked) && picked.length) {
        setAttachments((prev) => [...prev, ...picked]);
      }
    } catch {
      /* cancelled */
    }
  };

  const selectAgent = (a) => {
    void window.lykn?.agentSwitch?.(a.id);
    void window.lykn?.agentShowBrowser?.(a.id);
  };

  const anyRunning = agents.some((a) => a.status === "running");
  const canSend = !!(text.trim() || attachments.length);
  const active = agents.find((a) => a.id === activeId) || null;
  // Composer only locks for the agent you're looking at — not the whole rail.
  const activeBusy = !!(active && (active.busy || active.status === "running"));

  return (
    <>
    {/* Response rail — sits on the studio glass, split off by a hairline. */}
    <div
      className={`relative flex h-full flex-none flex-col overflow-hidden border-l border-white/15 text-white/85 transition-all duration-300 ease-out animate-in fade-in-0 slide-in-from-right-4 ${
        open ? "w-[330px]" : "w-11"
      }`}
      style={NO_DRAG}
    >
      {open ? (
        <>
          <div className="flex flex-shrink-0 items-center gap-1 px-3 pb-1.5 pt-3">
            <span className="min-w-0 truncate text-[0.66rem] font-bold uppercase tracking-[0.09em] text-white/50">
              {active?.title || "LYKN Agent"}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => window.lykn?.agentCreate?.({ title: "New agent" })}
              title="New agent"
              className="flex h-6 w-6 items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white"
            >
              <SquarePen className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              title="Collapse response panel"
              className="flex h-6 w-6 items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Thread — the active agent's prompts + answers, streaming live. */}
          <div
            ref={threadRef}
            className="mt-1 min-h-0 flex-1 space-y-2.5 overflow-y-auto border-t border-white/15 px-3 py-2.5"
          >
            {thread.length === 0 && !draft && !liveStep && (
              <p className="px-2 pt-10 text-center text-xs leading-relaxed text-white/40">
                {agents.length === 0 ? (
                  <>
                    No agents yet.
                    <br />
                    Send a goal below to put LYKN to work.
                  </>
                ) : (
                  "Your conversation with this agent shows here."
                )}
              </p>
            )}
            {thread.map((m, i) => {
              const body = String(m?.content || "").trim();
              if (!body) return null;
              if (m.role === "user") {
                return (
                  <div key={`${m.at || i}-u`} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-white px-3 py-1.5 text-[0.78rem] leading-relaxed text-black shadow-[0_4px_14px_rgba(0,0,0,0.25)]">
                      {body}
                    </div>
                  </div>
                );
              }
              if (m.role !== "assistant") return null;
              return (
                <div
                  key={`${m.at || i}-a`}
                  className="lykn-rail-md break-words text-[0.78rem] leading-relaxed text-white/85"
                >
                  <RailMarkdown>{body}</RailMarkdown>
                </div>
              );
            })}
            {draft && (
              <div className="lykn-rail-md break-words text-[0.78rem] leading-relaxed text-white/85">
                <RailMarkdown>{draft}</RailMarkdown>
              </div>
            )}
            {liveStep && (
              // Same thinking animation as the main app chat — LYKN outline
              // spinner + shimmering status text (ThinkingIndicator).
              <div className="min-w-0 text-[0.72rem] text-white/70">
                <ThinkingIndicator status={liveStep} compact />
              </div>
            )}
          </div>

          {/* Chat bar — same glass as the thread, split by a hairline. */}
          <div className="flex-shrink-0 border-t border-white/15 px-3 pb-2.5 pt-2">
            {attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {attachments.map((att, i) => (
                  <span
                    key={`${att.name || "att"}-${i}`}
                    className="flex max-w-[150px] items-center gap-1 rounded-full border border-white/15 bg-white/[0.08] py-0.5 pl-2.5 pr-1.5 text-[0.62rem] text-white/75"
                  >
                    <span className="truncate">
                      {att.name || (att.kind === "image" ? "Image" : "File")}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setAttachments((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-white/45 hover:bg-white/15 hover:text-white"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div>
              <textarea
                ref={taRef}
                value={text}
                rows={1}
                placeholder="Message the agent — chat, or give it a goal…"
                onChange={(e) => {
                  setText(e.target.value);
                  autoGrow(e.target);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                className="max-h-[120px] w-full resize-none bg-transparent text-[0.78rem] leading-relaxed text-white/90 outline-none placeholder:text-white/35"
              />
              <div className="flex items-center gap-1 pt-1">
                <GlassDot busy={anyRunning} />
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={attach}
                  title="Add photos & files"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={send}
                  disabled={activeBusy || !canSend}
                  title="Send"
                  className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                    canSend && !activeBusy
                      ? "bg-white text-black hover:bg-white/90"
                      : "bg-white/15 text-white/45"
                  }`}
                >
                  {activeBusy ? (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  ) : (
                    <ArrowUp className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="flex h-full flex-col items-center py-2.5">
          <button
            type="button"
            onClick={() => setOpen(true)}
            title="Show responses"
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <Bot className="mt-3 h-4 w-4 flex-none text-white/40" />
          {anyRunning && (
            <span className="mt-2 h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-emerald-400" />
          )}
        </div>
      )}
    </div>

    {/* Agent strip — a closed sidebar of agents; expands to show titles. */}
    <div
      className={`relative flex h-full flex-none flex-col overflow-hidden border-l border-white/15 text-white/85 transition-all duration-300 ease-out animate-in fade-in-0 slide-in-from-right-2 ${
        agentsOpen ? "w-[220px]" : "w-11"
      }`}
      style={NO_DRAG}
    >
      {agentsOpen ? (
        <>
          <div className="flex flex-shrink-0 items-center gap-1 px-3 pb-1.5 pt-3">
            <span className="text-[0.66rem] font-bold uppercase tracking-[0.09em] text-white/50">
              Agents
            </span>
            <span className="text-[0.66rem] font-semibold text-white/35">
              {agents.length}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => window.lykn?.agentCreate?.({ title: "New agent" })}
              title="Add agent"
              className="flex h-6 w-6 items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-1">
            {agents.length === 0 && (
              <p className="px-2 pt-8 text-center text-xs leading-relaxed text-white/40">
                No agents yet. Press + to add one.
              </p>
            )}
            {agents.map((a) => (
              <div
                key={a.id}
                role="button"
                tabIndex={0}
                onClick={() => selectAgent(a)}
                onKeyDown={(e) => e.key === "Enter" && selectAgent(a)}
                className={`group flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors ${
                  a.id === activeId
                    ? "bg-white/[0.14]"
                    : "hover:bg-white/[0.08]"
                }`}
              >
                <Globe className={`h-4 w-4 flex-none ${agentToneClass(a)}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.76rem] font-medium text-white/90">
                    {a.title || "Agent"}
                  </span>
                  <span className="block truncate text-[0.63rem] text-white/45">
                    {agentSubLabel(a)}
                  </span>
                </span>
                <button
                  type="button"
                  title="Delete agent"
                  onClick={(e) => {
                    e.stopPropagation();
                    void window.lykn?.agentClose?.(a.id);
                  }}
                  className="flex h-5 w-5 flex-none items-center justify-center rounded-md text-white/40 opacity-0 transition-all hover:bg-white/15 hover:text-white group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          {/* History — closed tabs & agents, newest first. Click to reopen
              the page in a fresh agent tab; × removes the entry. */}
          {history.length > 0 && (
            <div className="flex max-h-[38%] flex-none flex-col border-t border-white/10">
              <div className="flex flex-shrink-0 items-center gap-1 px-3 pb-1 pt-2.5">
                <span className="text-[0.66rem] font-bold uppercase tracking-[0.09em] text-white/50">
                  History
                </span>
                <span className="text-[0.66rem] font-semibold text-white/35">
                  {history.length}
                </span>
              </div>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-1">
                {history.map((h) => (
                  <div
                    key={h.id}
                    role="button"
                    tabIndex={0}
                    title={h.url || h.title}
                    onClick={() => window.lykn?.agentBrowserHistoryOpen?.(h.id)}
                    onKeyDown={(e) =>
                      e.key === "Enter" && window.lykn?.agentBrowserHistoryOpen?.(h.id)
                    }
                    className="group flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/[0.08]"
                  >
                    <Clock className="h-3.5 w-3.5 flex-none text-white/35" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.72rem] font-medium text-white/75">
                        {h.pageTitle || h.title}
                      </span>
                      <span className="block truncate text-[0.6rem] text-white/40">
                        {historySubLabel(h)}
                      </span>
                    </span>
                    <button
                      type="button"
                      title="Remove from history"
                      onClick={(e) => {
                        e.stopPropagation();
                        void window.lykn?.agentBrowserHistoryRemove?.(h.id);
                      }}
                      className="flex h-5 w-5 flex-none items-center justify-center rounded-md text-white/40 opacity-0 transition-all hover:bg-white/15 hover:text-white group-hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Toggle lives at the bottom in both states. */}
          <div className="flex flex-shrink-0 justify-center py-2.5">
            <button
              type="button"
              onClick={() => setAgentsOpen(false)}
              title="Collapse agents"
              className="flex h-7 w-7 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </>
      ) : (
        <div className="flex h-full flex-col items-center gap-1.5 overflow-y-auto py-2.5">
          <button
            type="button"
            onClick={() => window.lykn?.agentCreate?.({ title: "New agent" })}
            title="Add agent"
            className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Plus className="h-4 w-4" />
          </button>
          <span className="my-0.5 h-px w-5 flex-none bg-white/15" />
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              title={`${a.title || "Agent"} — ${agentSubLabel(a)}`}
              onClick={() => selectAgent(a)}
              className={`flex h-7 w-7 flex-none items-center justify-center rounded-full transition-colors hover:bg-white/10 ${
                a.id === activeId ? "bg-white/[0.14] ring-1 ring-white/30" : ""
              }`}
            >
              <Globe className={`h-4 w-4 ${agentToneClass(a)}`} />
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setAgentsOpen(true)}
            title="Show agents"
            className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
    </>
  );
}

export default function Studio() {
  const { user } = useAuth();
  const desktop = isDesktopShell();
  // Desktop shell IS the vibrancy Studio window now (main window loads
  // /studio?glass=1). Keep treating desktop as glass even if a client-side
  // nav drops the query param. On the web we only go transparent with ?glass=1.
  const glassWindow = useMemo(() => {
    if (desktop) return true;
    try {
      return new URLSearchParams(window.location.search).get("glass") === "1";
    } catch {
      return false;
    }
  }, [desktop]);

  const [tab, setTab] = useState("dashboard");
  // Embedded frames mount on first visit and stay warm after that. A widget
  // can deep-link a section (e.g. a specific chat or project) via frameSrc.
  const [visited, setVisited] = useState({});
  const [frameSrc, setFrameSrc] = useState({});
  const [dark, setDark] = useState(() => isDarkTheme(readSavedTheme()));
  const [notifMuted, setNotifMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarPanel, setCalendarPanel] = useState("calendar"); // "calendar" | "todos"
  const [settingsOpen, setSettingsOpen] = useState(false);
  // While a page (chat/projects/…) is open the studio chrome tucks away and
  // the rail becomes the single full-height sidebar. The tiny toggle in the
  // panel's top-right corner pulls the chrome back in.
  const [chromeShown, setChromeShown] = useState(false);
  // Focused-mode sidebar expansion — the LYKN icon opens the rail into a
  // full app-style sidebar with chat history.
  const [railOpen, setRailOpen] = useState(false);
  const [railSearch, setRailSearch] = useState("");
  const queryClient = useQueryClient();

  // The glass window shows native macOS traffic lights in its top-left
  // corner; the top bar shifts right so the welcome pill doesn't hide
  // underneath them.
  const macTrafficLights =
    glassWindow && /Mac/i.test(navigator.platform || navigator.userAgent || "");

  const onPage = tab !== "dashboard";
  const focused = onPage && !chromeShown;

  useEffect(() => {
    if (!focused) {
      setRailOpen(false);
      setRailSearch("");
    }
  }, [focused]);

  const { data: railChats = [] } = useQuery({
    queryKey: ["studio-rail-chats", user?.id || "guest"],
    // Prefetch as soon as a page is focused so the list is already there
    // when the sidebar expands.
    enabled: !!user?.id && focused,
    staleTime: 30_000,
    queryFn: () => fetchLyknChatsWithContext(user.id, 30),
  });

  // Chats save inside the embedded chat iframe (a sibling document), so the
  // rail and Recent Chats lists refresh off the cross-document chats-changed
  // signal — every send/auto-name/rename in Chat, Build, Imagine or Research
  // lands in the sidebar as soon as it's saved.
  useEffect(() => {
    return subscribeLyknChatsChanged(() => {
      queryClient.invalidateQueries({ queryKey: ["studio-rail-chats"] });
      queryClient.invalidateQueries({ queryKey: ["studio-chats"] });
      queryClient.invalidateQueries({ queryKey: ["studio-search-chats"] });
    });
  }, [queryClient]);

  const railNeedle = railSearch.trim().toLowerCase();
  const visibleRailChats = railNeedle
    ? railChats.filter((c) => (c.title || "").toLowerCase().includes(railNeedle))
    : railChats;

  // Same behavior as the in-app sidebar's New chat: create the chat row
  // immediately, then open it (here: deep-link the embedded chat frame).
  const startNewChat = async () => {
    if (!user?.id) return;
    try {
      const { chatId } = await createNewChat(user.id);
      queryClient.invalidateQueries({ queryKey: ["studio-rail-chats"] });
      openTab("chat", `/chat/${encodeURIComponent(chatId)}`);
    } catch {
      // Fall back to the fresh-composer state if creation fails.
      openTab("chat", `/app?nc=${Date.now()}`);
    }
  };

  const firstName = useMemo(() => {
    const meta = user?.user_metadata || {};
    const name = String(meta.full_name || meta.name || "").trim();
    if (name) return name.split(/\s+/)[0];
    const email = String(user?.email || "").trim();
    if (!email) return "there";
    const prefix = email.split("@")[0];
    return prefix.charAt(0).toUpperCase() + prefix.slice(1);
  }, [user]);

  useEffect(() => {
    document.documentElement.classList.add("lykn-studio-mode");
    document.body.classList.add("lykn-studio-mode");
    const prevTitle = document.title;
    document.title = "LYKN Studio";
    return () => {
      document.documentElement.classList.remove("lykn-studio-mode");
      document.body.classList.remove("lykn-studio-mode");
      document.title = prevTitle;
    };
  }, []);

  // Global notifications mute lives in the Electron main process so it can
  // gate OS notifications; mirror it here for the bell button state.
  useEffect(() => {
    let cancelled = false;
    window.lykn
      ?.getNotificationsMuted?.()
      .then((res) => {
        if (!cancelled) setNotifMuted(!!res?.muted);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleNotifications = () => {
    const next = !notifMuted;
    setNotifMuted(next);
    window.lykn?.setNotificationsMuted?.(next);
  };

  // Fullscreen — Studio will take over the whole UI, so the glass window can
  // fill the screen. Desktop drives the native Electron window; the web
  // preview falls back to browser fullscreen. State follows the window (the
  // app menu / OS can also toggle it), so the button never goes stale.
  useEffect(() => {
    if (window.lykn?.onStudioFullscreen) {
      let cancelled = false;
      window.lykn
        .getStudioFullscreen?.()
        .then((res) => {
          if (!cancelled) setFullscreen(!!res?.fullscreen);
        })
        .catch(() => {});
      const off = window.lykn.onStudioFullscreen((p) => setFullscreen(!!p?.fullscreen));
      return () => {
        cancelled = true;
        off?.();
      };
    }
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    if (window.lykn?.setStudioFullscreen) {
      window.lykn.setStudioFullscreen(!fullscreen);
      return;
    }
    if (fullscreen) void document.exitFullscreen?.();
    else void document.documentElement.requestFullscreen?.();
  };

  // Fullscreen traffic lights reveal in step with the auto-hidden macOS menu
  // bar: that bar drops only after the cursor rests against the very top
  // edge for a beat, so we use the same trigger — edge contact plus a short
  // dwell — then stay up while the cursor remains near the top.
  const [lightsRevealed, setLightsRevealed] = useState(false);
  useEffect(() => {
    if (!(macTrafficLights && fullscreen)) {
      setLightsRevealed(false);
      return undefined;
    }
    let shown = false;
    let dwellTimer = null;
    const cancelDwell = () => {
      if (dwellTimer) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
      }
    };
    const onMove = (e) => {
      if (shown) {
        if (e.clientY > 110) {
          shown = false;
          setLightsRevealed(false);
        }
        return;
      }
      if (e.clientY <= 2) {
        if (!dwellTimer) {
          dwellTimer = setTimeout(() => {
            dwellTimer = null;
            shown = true;
            setLightsRevealed(true);
          }, 250);
        }
      } else {
        cancelDwell();
      }
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      cancelDwell();
      window.removeEventListener("mousemove", onMove);
    };
  }, [macTrafficLights, fullscreen]);

  // Browser tab: the agent browser is native Electron views, not a web page,
  // so the main process docks them over the browser card (left of the agent
  // rail). Report the card's window-relative rect and keep it fresh while
  // chrome animates / the rail collapses / the window resizes.
  const browserHostRef = useRef(null);
  useEffect(() => {
    if (tab !== "browser" || !window.lykn?.setStudioBrowser) return;
    const el = browserHostRef.current;
    if (!el) return;
    const send = () => {
      const r = el.getBoundingClientRect();
      window.lykn.setStudioBrowser({
        open: true,
        bounds: {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
      });
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    window.addEventListener("resize", send);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", send);
      window.lykn.setStudioBrowser({ open: false });
    };
  }, [tab]);

  // Artifact "Open" inside a Studio chat surface routes the URL into the
  // Studio browser (lykn:studio-open-url) and fires this event so the
  // Studio switches to its Browser tab, where the new tab is docked.
  useEffect(() => {
    const onShowBrowser = () => setTab("browser");
    window.addEventListener("lykn-studio-show-browser", onShowBrowser);
    return () => window.removeEventListener("lykn-studio-show-browser", onShowBrowser);
  }, []);

  const openTab = (id, src) => {
    // Settings is a dialog over the studio, not a tab — the current tab
    // stays where it is underneath.
    if (id === "settings") {
      setSettingsOpen(true);
      return;
    }
    setTab(id);
    setChromeShown(false); // every page entry starts in clean focused mode
    if (id === "dashboard") return;
    setVisited((v) => (v[id] ? v : { ...v, [id]: true }));
    if (src) setFrameSrc((f) => (f[id] === src ? f : { ...f, [id]: src }));
  };

  const openCalendar = (panel = "calendar") => {
    setCalendarPanel(panel);
    setCalendarOpen(true);
  };

  const handleNavItem = (item) => {
    if (item.action === "calendar") {
      openCalendar("calendar");
      return;
    }
    openTab(item.id);
  };

  const navActive = (item) => {
    if (item.id === "settings") return settingsOpen;
    return item.action === "tab" ? tab === item.id : item.action === "calendar" && calendarOpen;
  };

  const setTheme = (nextDark) => {
    setDark(nextDark);
    persistTheme(nextDark ? "dark" : "light");
  };

  return (
    <div className="fixed inset-0 overflow-hidden font-sans text-black/85 dark:text-white/85 select-none">
      {/* Backdrop. Glass (dark) in the vibrancy window stays transparent so
          the desktop blurs through; everywhere else — including Neutral,
          which is the regular opaque UI with no glass at all — we paint our
          own solid backdrop. */}
      {(!glassWindow || !dark) && (
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            // Neutral is the regular app background — flat, no glass.
            background: dark
              ? "radial-gradient(120% 90% at 20% 0%, #2a2d36 0%, #17181d 55%, #0c0d10 100%)"
              : "#ececeb",
          }}
        />
      )}

      <div
        // Padding snaps with the window resize — animating it against
        // macOS simple-fullscreen makes chrome lag behind the frame.
        className={`relative z-10 flex h-full flex-col items-center ${
          // Fullscreen covers the whole display, so the top row must clear
          // the camera notch / menu-bar strip (~38px on notched MacBooks).
          fullscreen ? "px-2 pb-2 pt-11" : "px-5 pb-4 pt-4"
        }`}
      >
        {/* ── Top bar (drag region) — tucks away upward in focused mode; the
            welcome pill collapses leftward, "merging" into the rail, whose
            LYKN icon fades in to take its place. ── */}
        <div
          // max-width snaps (never transition): `none` doesn't interpolate, so
          // transition-all made the stage sit at 1240px then jump late.
          // Focused-mode tuck still animates height/opacity only.
          //
          // Important: do NOT put WebkitAppRegion:drag on this outer row —
          // paddingLeft still counts as a drag hit-target and steals clicks
          // from the native macOS traffic lights (close / minimize).
          className={`flex w-full flex-shrink-0 items-center gap-3 transition-[max-height,opacity,margin,transform] duration-500 ease-out ${
            fullscreen ? "max-w-full" : "max-w-[1240px]"
          } ${
            focused
              ? "mb-0 max-h-0 opacity-0 pointer-events-none"
              : "mb-3 max-h-14 opacity-100 delay-200"
          }`}
          style={{
            // Clear the native macOS traffic lights in the window's top-left.
            paddingLeft: macTrafficLights ? (fullscreen ? 64 : 56) : undefined,
          }}
        >
          <div
            className="flex min-w-0 flex-1 items-center gap-3"
            style={DRAG}
          >
          <div
            className={`flex items-center gap-2.5 rounded-full px-2 py-1.5 pr-4 transition-[transform,opacity] duration-500 ease-out ${BAR} ${
              focused ? "-translate-x-12 scale-90 opacity-0" : "translate-x-0 scale-100 opacity-100 delay-200"
            }`}
          >
            <img
              src={dark ? lyknIconUrl : lyknIconBlueUrl}
              alt="LYKN"
              className="h-8 w-8 flex-shrink-0 object-contain"
              draggable={false}
            />
            <span className="whitespace-nowrap font-serif text-[1.05rem] italic tracking-tight">
              Welcome, {firstName}
            </span>
          </div>

          {/* Everything except the welcome pill exits upward. */}
          <div
            className={`flex min-w-0 flex-1 items-center gap-3 transition-[transform,opacity] duration-500 ease-out ${
              focused ? "-translate-y-10 opacity-0" : "translate-y-0 opacity-100 delay-200"
            }`}
          >
            <StudioSearch userId={user?.id} onOpen={openTab} />

            <div
              className={`flex flex-shrink-0 items-center rounded-full p-1 ${BAR}`}
              style={NO_DRAG}
            >
              <button
                type="button"
                onClick={() => setTheme(true)}
                className={`rounded-full px-3 py-1.5 text-[0.7rem] font-medium transition-all ${
                  dark ? "bg-white text-black shadow" : "text-white/60"
                }`}
              >
                Glass
              </button>
              <button
                type="button"
                onClick={() => setTheme(false)}
                className={`rounded-full px-3 py-1.5 text-[0.7rem] font-medium transition-all ${
                  !dark ? "bg-black/85 text-white shadow" : "text-white/60"
                }`}
              >
                Neutral
              </button>
            </div>

            <button
              type="button"
              onClick={toggleNotifications}
              title={notifMuted ? "Notifications are off — click to turn on" : "Notifications are on — click to turn off"}
              aria-label="Toggle notifications"
              aria-pressed={!notifMuted}
              style={NO_DRAG}
              className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full transition-colors ${BAR} ${
                notifMuted ? "!text-white/35" : "!text-white/70 hover:bg-white/15"
              }`}
            >
              {notifMuted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
            </button>

            {/* macOS has native traffic lights for this; only Windows and the
                web preview need an in-page fullscreen control. */}
            {!macTrafficLights && (
              <button
                type="button"
                onClick={toggleFullscreen}
                title={fullscreen ? "Exit full screen" : "Enter full screen"}
                aria-label={fullscreen ? "Exit full screen" : "Enter full screen"}
                aria-pressed={fullscreen}
                style={NO_DRAG}
                className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full !text-white/70 transition-colors hover:bg-white/15 ${BAR}`}
              >
                {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
            )}

            <div
              title={`Press ${desktopHotkeyLabel("spaced")} anywhere to summon LYKN`}
              className={`flex h-10 flex-shrink-0 items-center gap-1 rounded-full px-2.5 ${BAR}`}
            >
              <kbd className="flex h-6 min-w-6 items-center justify-center rounded-md border border-white/15 bg-white/10 px-1.5 font-sans text-[0.7rem] font-medium text-white/80">
                {desktopModifierKey()}
              </kbd>
              <kbd className="flex h-6 min-w-6 items-center justify-center rounded-md border border-white/15 bg-white/10 px-1.5 font-sans text-[0.7rem] font-medium text-white/80">
                L
              </kbd>
            </div>
          </div>
          </div>
        </div>

        {/* ── Rail + main glass panel ── */}
        <div
          className={`flex w-full flex-1 min-h-0 items-stretch gap-3 ${
            fullscreen ? "max-w-full" : "max-w-[1240px]"
          }`}
        >
          <div className="flex flex-col justify-center">
            {/* Focused: the rail nudges to the side, then stretches to full
                height (flex-grow is animatable), becoming the app sidebar.
                The LYKN icon expands it into a full sidebar with chat
                history, like the actual app. */}
            <div
              className={`flex flex-col items-stretch gap-1.5 overflow-hidden p-1.5 ${BAR} ${
                focused ? "grow -translate-x-2" : "grow-0 translate-x-0"
              } ${
                railOpen && focused
                  ? "w-64 rounded-[1.6rem]"
                  : "w-[3.25rem] rounded-[1.625rem]"
              }`}
              style={{
                // Pad past traffic lights on the outer shell WITHOUT drag —
                // drag on that padding steals native close/minimize clicks.
                paddingTop: macTrafficLights && focused ? 40 : undefined,
                transition: focused
                  ? "transform 300ms ease, flex-grow 500ms cubic-bezier(0.22,1,0.36,1) 260ms, width 190ms cubic-bezier(0.3,0.9,0.4,1), border-radius 190ms ease"
                  : "flex-grow 450ms cubic-bezier(0.22,1,0.36,1), transform 300ms ease 380ms, width 190ms cubic-bezier(0.3,0.9,0.4,1), border-radius 190ms ease",
                ...(macTrafficLights && focused ? undefined : DRAG),
              }}
            >
              <div
                className={
                  macTrafficLights && focused
                    ? "flex min-h-0 flex-1 flex-col items-stretch gap-1.5"
                    : "contents"
                }
                style={macTrafficLights && focused ? DRAG : undefined}
              >
              {/* The welcome pill's icon lands here — opens/collapses the
                  full sidebar. Collapsed shows the icon; open cross-fades to
                  the full wordmark, just like the in-app sidebar. */}
              <button
                type="button"
                onClick={() => setRailOpen((v) => !v)}
                title={railOpen ? "Collapse sidebar" : "Open sidebar"}
                aria-label={railOpen ? "Collapse sidebar" : "Open sidebar"}
                aria-expanded={railOpen}
                style={NO_DRAG}
                className={`relative flex w-full flex-shrink-0 items-center overflow-hidden rounded-full transition-all duration-300 ease-out hover:bg-white/15 ${
                  focused ? "mb-1 h-10 opacity-100 delay-500" : "mb-0 h-0 opacity-0"
                }`}
              >
                <span
                  className={`grid h-10 w-10 flex-none place-items-center transition-opacity duration-150 ${
                    railOpen ? "opacity-0" : "opacity-100"
                  }`}
                  aria-hidden={railOpen}
                >
                  <img
                    src={dark ? lyknIconUrl : lyknIconBlueUrl}
                    alt=""
                    className="h-8 w-8 object-contain"
                    draggable={false}
                  />
                </span>
                <img
                  src={dark ? lyknLogoUrl : lyknLogoBlueUrl}
                  alt=""
                  aria-hidden={!railOpen}
                  draggable={false}
                  className={`absolute left-1.5 top-1/2 h-8 w-auto max-w-none -translate-y-1/2 object-contain transition-opacity duration-200 ${
                    railOpen ? "opacity-100 delay-100" : "pointer-events-none opacity-0"
                  }`}
                />
              </button>
              {NAV_ITEMS.filter((item) => item.id !== "settings").map((item) => (
                <CircleIconButton
                  key={item.id}
                  icon={item.icon}
                  label={item.label}
                  active={navActive(item)}
                  onClick={() => handleNavItem(item)}
                  expanded={railOpen && focused}
                />
              ))}

              {/* Expanded sidebar: chat history, like the actual app. Fades
                  in after the width animation so rows never reflow mid-open. */}
              {railOpen && focused && (
                <div
                  className="mt-2 flex min-h-0 flex-[999] basis-0 flex-col animate-in fade-in-0 duration-200"
                  style={{ ...NO_DRAG, animationDelay: "90ms", animationFillMode: "backwards" }}
                >
                  {/* Search + New chat — same row layout as the in-app sidebar. */}
                  <div className="flex items-center gap-1 overflow-hidden whitespace-nowrap px-1">
                    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-white/55">
                      <Search className="h-3.5 w-3.5 flex-shrink-0" />
                      <input
                        value={railSearch}
                        onChange={(e) => setRailSearch(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setRailSearch("");
                            e.currentTarget.blur();
                          }
                        }}
                        placeholder="Search"
                        className="w-full min-w-0 bg-transparent text-[0.72rem] text-white/85 outline-none placeholder:text-white/35"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={startNewChat}
                      title="New chat"
                      aria-label="New chat"
                      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-white/55 hover:bg-white/15 hover:text-white transition-colors"
                    >
                      <SquarePen className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-1.5 overflow-hidden whitespace-nowrap px-3">
                    <span className="text-[0.6rem] font-semibold uppercase tracking-widest text-white/40">
                      Recent chats
                    </span>
                  </div>
                  <div className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5 scrollbar-hide">
                    {visibleRailChats.length === 0 ? (
                      <p className="px-3 py-2 text-[0.68rem] text-white/35">
                        {railNeedle ? "No matches" : "No chats yet"}
                      </p>
                    ) : (
                      visibleRailChats.map((chat) => (
                        <button
                          key={chat.id}
                          type="button"
                          onClick={() =>
                            openTab("chat", `/chat/${encodeURIComponent(chat.id)}`)
                          }
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left hover:bg-white/[0.08] transition-colors"
                        >
                          <MessageCircle className="h-3.5 w-3.5 flex-shrink-0 text-white/35" />
                          <span className="min-w-0 flex-1 truncate text-[0.74rem] text-white/80">
                            {chat.title || "Untitled chat"}
                          </span>
                          <span className="flex-shrink-0 text-[0.58rem] text-white/30">
                            {relTime(chat.updated_at)}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* Growing spacer rides the rail extension so Settings ends at
                  the bottom, like a real app sidebar. It keeps grow=1 while
                  the sidebar is open (the chat list's grow-[999] swallows the
                  space instead), so toggling the sidebar never makes Settings
                  jump. */}
              <div
                aria-hidden
                className={`my-[-3px] ${focused ? "grow" : "grow-0"}`}
                style={{
                  transition: focused
                    ? "flex-grow 500ms cubic-bezier(0.22,1,0.36,1) 260ms"
                    : "flex-grow 450ms cubic-bezier(0.22,1,0.36,1)",
                }}
              />
              {NAV_ITEMS.filter((item) => item.id === "settings").map((item) => (
                <CircleIconButton
                  key={item.id}
                  icon={item.icon}
                  label={item.label}
                  active={navActive(item)}
                  onClick={() => handleNavItem(item)}
                  expanded={railOpen && focused}
                />
              ))}
              </div>
            </div>
          </div>

          {/* Center panel — dark frost behind the dashboard cards. Embedded
              section frames paint their own opaque app background instead. */}
          <div
            className={`relative flex-1 min-w-0 overflow-hidden rounded-[2.2rem] shadow-[0_24px_80px_rgba(0,0,0,0.28)] ${FROST_PANEL}`}
          >
            <div className={tab === "dashboard" ? "h-full w-full" : "hidden"}>
              <DashboardGrid
                userId={user?.id}
                firstName={firstName}
                onOpen={openTab}
                onOpenCalendar={openCalendar}
              />
            </div>
            {/* Browser tab — a rounded browser card (the native agent-browser
                views dock over browserHostRef) with the glass agent rail
                beside it: agent list + chat bar for driving the agents. */}
            {tab === "browser" && (
              <div className="flex h-full w-full p-3 [&>*:first-child]:mr-3">
                <div
                  ref={browserHostRef}
                  className="relative min-w-0 flex-1 overflow-hidden rounded-[24px]"
                >
                  {/* Light underlay so the dock loads in light mode; shows
                      while the views attach, and in the web preview. */}
                  <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#ececeb] text-black/45">
                    <Globe className="h-9 w-9" />
                    <p className="max-w-sm text-center text-sm">
                      {desktop
                        ? "Your agent browser tabs appear here. Press + in the browser bar above to open one."
                        : "The LYKN browser is available in the desktop app."}
                    </p>
                  </div>
                </div>
                <StudioAgentRail desktop={desktop} />
              </div>
            )}
            {SECTIONS.filter((s) => s.src && visited[s.id]).map(({ id, src }) => (
              <div
                key={id}
                className={`absolute inset-0 h-full w-full ${
                  // Chat manages its own internal scrolling; document-style
                  // pages (vault / projects / settings) scroll in the panel.
                  id === "chat" ? "overflow-hidden" : "overflow-y-auto"
                } ${
                  // `invisible` (visibility:hidden) fully removes warm hidden
                  // tabs from hit-testing — pointer-events-none alone isn't
                  // enough because page innards re-enable pointer-events-auto
                  // and would silently eat clicks meant for the studio chrome.
                  tab === id ? "" : "pointer-events-none opacity-0 invisible"
                }`}
                // The transform makes this wrapper the containing block for
                // position:fixed INSIDE the page (toolbars, docks, overlays),
                // so they anchor to the panel exactly like the old iframe
                // viewport instead of floating over the studio rail/chrome.
                style={{ transform: "translateZ(0)" }}
              >
                <StudioSurface entry={frameSrc[id] || src} />
              </div>
            ))}

          </div>
        </div>

        {/* ── Bottom dock — slides away downward in focused mode ── */}
        <div
          className={`flex flex-shrink-0 items-center gap-1 rounded-full p-1.5 transition-[max-height,opacity,margin,transform] duration-500 ease-out ${BAR} ${
            focused
              ? "mt-0 max-h-0 translate-y-6 opacity-0 pointer-events-none"
              : "mt-3 max-h-14 translate-y-0 opacity-100 delay-200"
          }`}
        >
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => handleNavItem(item)}
              className={`whitespace-nowrap rounded-full px-4 py-1.5 text-[0.72rem] font-medium transition-all ${
                navActive(item)
                  ? "bg-black/85 text-white shadow dark:bg-white dark:text-black"
                  : "text-white/65 hover:bg-white/15"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* In-page traffic lights while fullscreen — macOS simple fullscreen
          strips the native title-bar buttons, so we draw our own in the same
          spot: close (hide), minimize, and exit fullscreen. */}
      {macTrafficLights && fullscreen && (
        <div
          // Below the strip the auto-hidden menu bar occupies when it drops
          // down (~25px, ~38px on notched displays) so the system banner can
          // never cover the buttons, and vertically centered on the top bar
          // row, which starts at 44px in fullscreen.
          className={`group absolute left-3 top-[52px] z-[200] flex items-center gap-2.5 transition-all duration-200 ease-out ${
            lightsRevealed
              ? "translate-y-0 opacity-100"
              : "pointer-events-none -translate-y-3 opacity-0"
          }`}
          style={NO_DRAG}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              window.lykn?.closeStudio?.();
            }}
            title="Close"
            aria-label="Close"
            className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-black/[0.12] bg-[#ff5f57] text-black/60"
          >
            <X className="h-2 w-2 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={4} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              window.lykn?.minimizeStudio?.();
            }}
            title="Minimize"
            aria-label="Minimize"
            className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-black/[0.12] bg-[#febc2e] text-black/60"
          >
            <Minus className="h-2 w-2 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={4} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleFullscreen();
            }}
            title="Exit full screen"
            aria-label="Exit full screen"
            className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-black/[0.12] bg-[#28c840] text-black/60"
          >
            <Minimize2 className="h-2 w-2 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={4} />
          </button>
        </div>
      )}

      {/* Tiny chrome toggle — pinned to the window's top-right corner, over
          the studio background itself. */}
      {onPage && (
        <button
          type="button"
          onClick={() => setChromeShown((v) => !v)}
          title={focused ? "Show studio controls" : "Hide studio controls"}
          aria-label={focused ? "Show studio controls" : "Hide studio controls"}
          style={NO_DRAG}
          className={`absolute right-1.5 top-1.5 z-40 flex h-6 w-6 items-center justify-center transition-colors ${
            dark ? "text-white/80 hover:text-white" : "text-black/70 hover:text-black"
          }`}
        >
          {focused ? <ChevronsDown className="h-3.5 w-3.5" /> : <ChevronsUp className="h-3.5 w-3.5" />}
        </button>
      )}

      <LyknCalendarDialog
        open={calendarOpen}
        onOpenChange={setCalendarOpen}
        initialPanel={calendarPanel}
      />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
