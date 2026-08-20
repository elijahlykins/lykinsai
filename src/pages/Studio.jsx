// LYKN Studio — the liquid-glass workspace.
//
// A visionOS-style glass panel — the app's primary shell. The Electron main
// window loads this route over HUD vibrancy (see createMainWindow). The
// Home tab is a blank macOS-style desktop (just the sidebar over the
// wallpaper); Chat / Projects / Vault mount the real product pages
// in-document (each inside its own MemoryRouter so internal navigation
// stays inside the panel while the window URL stays on /studio). Browser /
// Calendar / To-dos / Settings pop up as floating windows on Home.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Bell,
  BellOff,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Folder,
  FolderKanban,
  Globe,
  Home,
  ListTodo,
  Lock,
  Maximize2,
  MessageCircle,
  Minimize2,
  Newspaper,
  Paperclip,
  Plus,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Telescope,
  Link as LinkIcon,
  X,
} from "lucide-react";
import lyknIconUrl from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-NEUTRAL-master.png";
import lyknIconBlueUrl from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-BLUE-master.png";
import LyknCalendarPage from "@/components/calendar/LyknCalendarPage";
import LyknTodosPage from "@/components/todos/LyknTodosPage";
import SettingsModal from "@/components/notes/SettingsModal";
import { useAuth } from "@/lib/SupabaseAuth";
import { listUserProjects } from "@/lib/userProjects";
import {
  fetchLyknChatsWithContext,
  searchLyknChatsByTitle,
} from "@/lib/lyknChat/fetchLyknChatsWithContext";
import { createNewChat } from "@/lib/chat/chatThreadsClient";
import { openBrief } from "@/lib/brief";
import { STUDIO_OPEN_TAB_EVENT } from "@/lib/studioTabs";
import { agentWaitingRow } from "@/lib/agentWaitingRow";
import { agentChoiceRow } from "@/lib/agentChoiceRow";
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
import { readAppearance, subscribeAppearance } from "@/lib/appearance";
import { isDesktopShell } from "@/lib/webAppAccess";
import ReactMarkdown from "react-markdown";
import {
  CHAT_REMARK_PLUGINS,
  CHAT_REHYPE_PLUGINS,
  normalizeMathDelimiters,
} from "@/lib/chat/chatMarkdown";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";
import StudioHoverTips from "@/components/StudioHoverTips";
import MacAppDock from "@/components/macdock/MacAppDock";
import MacFilesBrowser from "@/components/macfiles/MacFilesBrowser";
import {
  DesktopFolders,
  FilesWidget,
  useHomeWidgetOn,
  useWelcomeWidgetSync,
} from "@/components/macdesktop/DesktopWidgets";
import DesktopAppWindow from "@/components/macdesktop/DesktopAppWindow";
import HomeChatBar from "@/components/macdesktop/HomeChatBar";
import MacDesktopMirror from "@/components/macdesktop/MacDesktopMirror";
import WidgetCanvas from "@/components/macdesktop/WidgetCanvas";

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

// Pages that open as macOS-style floating windows over the Home desktop
// instead of taking over the studio stage. `src` is the MemoryRouter entry
// for the window's surface (a caller can deep-link, e.g. /calendar?new=…);
// `native` windows have no routed page at all — the main process docks real
// Electron views into the window's body instead.
const WINDOW_APPS = {
  browser: {
    label: "Browser",
    icon: Globe,
    native: true,
    width: 1040,
    height: 700,
  },
  calendar: {
    label: "Calendar",
    icon: CalendarDays,
    src: "/calendar",
    width: 720,
    height: 640,
  },
  todos: {
    label: "To-dos",
    icon: ListTodo,
    src: "/todos",
    width: 480,
    height: 600,
  },
  settings: {
    label: "Settings",
    icon: Settings,
    // Own traffic lights in the sidebar, like System Settings — the frame
    // stays chromeless and those lights drive close / minimize / zoom.
    chromeless: true,
    width: 940,
    height: 620,
  },
};

const SECTIONS = [
  { id: "dashboard", label: "Dashboard", icon: Home },
  { id: "chat", label: "Chat", icon: MessageCircle, src: "/app" },
  { id: "projects", label: "Projects", icon: FolderKanban, src: "/projects" },
  { id: "vault", label: "Vault", icon: Lock, src: "/vault" },
  { id: "files", label: "Files", icon: Folder, src: "/files" },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "todos", label: "To-dos", icon: ListTodo },
  { id: "settings", label: "Settings", icon: Settings },
];

// Sections of the settings dialog a caller can land on directly, e.g.
// openTab("settings", "appearance"). The trailing ids are the pre-rename
// names, which SettingsModal still maps to their current sections.
const SETTINGS_VIEWS = [
  "account",
  "workspace",
  "assistant",
  "notifications",
  "privacy",
  "appearance",
  "integrations",
  "billing",
  "keyboard",
  "advanced",
  "display",
  "aiPersonalization",
  "connections",
  "payment",
];

// Left rail (icons) + bottom dock (words). Browser / Calendar / To-dos /
// Settings pop up as app windows on the Home desktop (see WINDOW_APPS); the
// rest are embedded-page tabs that take over the studio stage.
const NAV_ITEMS = [
  // No Chat entry — Home IS the chat page: the desktop hosts the chat
  // surface and its rounded bar. Chats open there via openTab("chat", …).
  { id: "dashboard", label: "Home", icon: Home, action: "tab" },
  { id: "browser", label: "Browser", icon: Globe, action: "tab" },
  { id: "projects", label: "Projects", icon: FolderKanban, action: "tab" },
  { id: "vault", label: "Vault", icon: Lock, action: "tab" },
  { id: "files", label: "Files", icon: Folder, action: "tab" },
  { id: "calendar", label: "Calendar", icon: CalendarDays, action: "tab" },
  { id: "todos", label: "To-dos", icon: ListTodo, action: "tab" },
  { id: "settings", label: "Settings", icon: Settings, action: "tab" },
];

// Floating chrome (top bar pills, left rail, bottom dock). Glass (dark) =
// smoked frost over the window's vibrancy with light text; Neutral = the
// regular light UI: near-solid white surfaces with dark ink over the opaque
// backdrop. The rest of the shell's hardcoded white/NN utilities get
// remapped for Neutral in index.css ("STUDIO NEUTRAL").
// Ink comes from the surface itself (--lg-text), which already flips with the
// Neutral/Glass theme, so the bars carry no color utility of their own.
const BAR = "lg-desktop-surface";

// The stage behind the embedded pages — same surface family as the bars.
const FROST_PANEL =
  "border border-black/10 dark:border-white/10 bg-white/55 dark:bg-black/40";

const DRAG = { WebkitAppRegion: "drag" };
const NO_DRAG = { WebkitAppRegion: "no-drag" };

/* ── In-document product surfaces ──────────────────────────────────────────
   Each tab hosts the REAL routed page inside its own MemoryRouter: internal
   navigation (opening a chat, drilling into a project) happens inside the
   panel while the window URL stays /studio. Every surface router carries all
   the product routes so cross-surface links keep working in place, exactly
   like the old same-origin iframes did. A new deep-link (`entry`) remounts
   the router at that path — same behavior as reloading an iframe src. */
function StudioSurface({ entry, windowed = false }) {
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
            <Route path="/files" element={<MacFilesBrowser />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
            {/* In a floating window the frame supplies the card chrome, so
                these render bare (no centered frost card of their own). */}
            <Route path="/calendar" element={<LyknCalendarPage windowed={windowed} />} />
            <Route path="/todos" element={<LyknTodosPage windowed={windowed} />} />
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

function CircleIconButton({ icon: Icon, active, label, onClick, expanded = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={expanded ? undefined : label}
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
        aria-hidden={!expanded}
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

function useUserProjects(userId, enabled = true) {
  return useQuery({
    queryKey: ["studio-projects", userId || "guest"],
    enabled: !!userId && enabled,
    staleTime: 60_000,
    queryFn: () => listUserProjects(userId),
  });
}

/* ── Studio-wide search (top bar) ──────────────────────────────────────── */

const SEARCH_INPUT_CLS =
  "w-full min-w-0 bg-transparent text-[0.8rem] text-inherit outline-none " +
  "ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 " +
  "placeholder:text-white/40 caret-white/80";

/** Google-style link guess: "nike" → "nike.com". */
function studioLinkGuess(raw) {
  const q = String(raw || "").trim();
  if (!q || /\s/.test(q) || /^https?:\/\//i.test(q)) return null;
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(q)) return null;
  if (/^[a-z0-9-]+$/i.test(q)) {
    return {
      host: `${q}.com`,
      complete: `${q}.com`,
      url: `https://${q.toLowerCase()}.com/`,
    };
  }
  const m = q.match(/^([a-z0-9-]+)\.(com?)?$/i);
  if (m && (!m[2] || m[2].toLowerCase() !== "com")) {
    return {
      host: `${m[1]}.com`,
      complete: `${m[1]}.com`,
      url: `https://${m[1].toLowerCase()}.com/`,
    };
  }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(q)) {
    return {
      host: q.replace(/\/$/, ""),
      complete: q,
      url: `https://${q.toLowerCase().replace(/^www\./, "")}`,
    };
  }
  return null;
}

function openStudioLink(url) {
  const u = String(url || "").trim();
  if (!u) return;
  try {
    if (window.lykn?.studioOpenUrl) {
      window.lykn.studioOpenUrl(u);
      return;
    }
  } catch {
    /* fall through */
  }
  if (window.lykn?.openExternal) window.lykn.openExternal(u);
  else window.open(u, "_blank", "noopener");
}

/** Product icons for Google hosts — S2 returns the same "G" for every *.google.com. */
const STUDIO_BRAND_ICON_BY_HOST = {
  "mail.google.com":
    "https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png",
  "calendar.google.com":
    "https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png",
  "drive.google.com":
    "https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
  "docs.google.com":
    "https://www.gstatic.com/images/branding/product/2x/docs_2020q4_48dp.png",
  "sheets.google.com":
    "https://www.gstatic.com/images/branding/product/2x/sheets_2020q4_48dp.png",
  "slides.google.com":
    "https://www.gstatic.com/images/branding/product/2x/slides_2020q4_48dp.png",
  "keep.google.com":
    "https://www.gstatic.com/images/branding/product/2x/keep_2020q4_48dp.png",
  "youtube.com":
    "https://www.gstatic.com/images/branding/product/2x/youtube_48dp.png",
  "music.youtube.com":
    "https://www.gstatic.com/images/branding/product/2x/youtube_music_2020q4_48dp.png",
};

function studioBrandIconFor(url) {
  try {
    const raw = String(url || "");
    const host = new URL(raw).hostname.replace(/^www\./i, "");
    if (host === "docs.google.com") {
      if (raw.includes("/document/")) return STUDIO_BRAND_ICON_BY_HOST["docs.google.com"];
      if (raw.includes("/spreadsheets/")) return STUDIO_BRAND_ICON_BY_HOST["sheets.google.com"];
      if (raw.includes("/presentation/")) return STUDIO_BRAND_ICON_BY_HOST["slides.google.com"];
    }
    if (host === "google.com" && raw.includes("/calendar/")) {
      return STUDIO_BRAND_ICON_BY_HOST["calendar.google.com"];
    }
    return STUDIO_BRAND_ICON_BY_HOST[host] || "";
  } catch {
    return "";
  }
}

/** Site favicon URL. Google products use gstatic brand icons; others use S2. */
function studioFaviconUrl(url) {
  const brand = studioBrandIconFor(url);
  if (brand) return brand;
  try {
    const host = new URL(String(url || "")).hostname.replace(/^www\./i, "");
    if (!host) return "";
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  } catch {
    return "";
  }
}

/** Site favicon with Lucide fallback (browser tabs, search, agent rail, history). */
function PageFavicon({ url, fallback: Fallback = Globe, className = "h-4 w-4" }) {
  const [failed, setFailed] = useState(false);
  const src = studioFaviconUrl(url);
  if (!src || failed) {
    return <Fallback className={`flex-none shrink-0 ${className}`} strokeWidth={1.75} />;
  }
  return (
    <img
      src={src}
      alt=""
      className={`flex-none shrink-0 rounded-[3px] object-contain ${className}`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function StudioSearch({ userId, onOpen }) {
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const needle = q.trim().toLowerCase();
  const debounced = useDebounced(needle);
  const linkGuess = useMemo(() => studioLinkGuess(q), [q]);

  const { data: recentChats = [] } = useQuery({
    queryKey: ["studio-search-recent", userId || "guest"],
    enabled: !!userId && focused,
    staleTime: 30_000,
    queryFn: () => fetchLyknChatsWithContext(userId, 6),
  });
  const { data: chatHits = [] } = useQuery({
    queryKey: ["studio-search-chats", userId || "guest", debounced],
    enabled: !!userId && debounced.length >= 1,
    staleTime: 30_000,
    queryFn: () => searchLyknChatsByTitle(userId, debounced, 5),
  });
  const { data: projects = [] } = useUserProjects(userId, focused);
  const projectHits = needle
    ? projects.filter((p) => (p.name || "").toLowerCase().includes(needle)).slice(0, 4)
    : projects.slice(0, 3);

  const suggestions = useMemo(() => {
    const rows = [];
    const push = (row) => {
      if (!rows.some((r) => r.key === row.key)) rows.push(row);
    };

    // Link autofill first — "nike" → open nike.com in the LYKN browser.
    if (linkGuess) {
      push({
        key: `link-${linkGuess.host}`,
        icon: Globe,
        faviconUrl: linkGuess.url,
        primary: linkGuess.host,
        secondary: "Link",
        complete: linkGuess.complete,
        onPick: () => {
          onOpen?.("browser");
          openStudioLink(linkGuess.url);
        },
      });
    }

    const sections = needle
      ? SECTIONS.filter((s) => s.label.toLowerCase().includes(needle))
      : SECTIONS;
    for (const s of sections) {
      push({
        key: `section-${s.id}`,
        icon: s.icon,
        primary: s.label,
        secondary: "Section",
        complete: s.label,
        onPick: () => onOpen?.(s.id),
      });
    }
    for (const p of projectHits) {
      const name = p.name || "Untitled project";
      if (needle && !name.toLowerCase().includes(needle)) continue;
      push({
        key: `project-${p.id}`,
        icon: FolderKanban,
        primary: name,
        secondary: "Project",
        complete: name,
        onPick: () => onOpen?.("projects", `/projects/${encodeURIComponent(p.id)}`),
      });
    }
    const chats = needle.length >= 1 ? chatHits : recentChats;
    for (const c of chats) {
      const title = c.title || "Untitled chat";
      push({
        key: `chat-${c.id}`,
        icon: MessageCircle,
        primary: title,
        secondary: "Chat",
        complete: title,
        onPick: () => onOpen?.("chat", `/chat/${encodeURIComponent(c.id)}`),
      });
    }
    return rows.slice(0, 10);
  }, [needle, projectHits, chatHits, recentChats, onOpen, linkGuess]);

  const choose = (fn) => {
    fn();
    setQ("");
    setFocused(false);
  };

  const Row = ({ icon: Icon, faviconUrl, primary, secondary, onPick }) => (
    <button
      type="button"
      onClick={() => choose(onPick)}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
    >
      {faviconUrl ? (
        <PageFavicon
          url={faviconUrl}
          fallback={Icon || Globe}
          className="h-[18px] w-[18px] text-black/40 dark:text-white/45"
        />
      ) : (
        <Icon className="h-[18px] w-[18px] shrink-0 text-black/40 dark:text-white/45" strokeWidth={1.75} />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-normal leading-snug text-black/90 dark:text-white/90">
          {primary}
        </span>
        {secondary ? (
          <span className="mt-0.5 block truncate text-[12px] font-normal leading-snug text-black/45 dark:text-white/45">
            {secondary}
          </span>
        ) : null}
      </span>
    </button>
  );

  return (
    <div
      className={`relative flex min-w-0 flex-1 items-center gap-2.5 rounded-full px-3 py-2 ${BAR} ${
        focused ? "ring-0" : ""
      }`}
    >
      <Search className="h-4 w-4 flex-shrink-0 text-white/45" />
      <div className="relative min-w-0 flex-1">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 140)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQ("");
              e.currentTarget.blur();
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              if (suggestions[0]) choose(suggestions[0].onPick);
              else if (linkGuess) {
                choose(() => {
                  onOpen?.("browser");
                  openStudioLink(linkGuess.url);
                });
              }
            }
          }}
          placeholder="Search LYKN Studio…"
          className={SEARCH_INPUT_CLS}
          style={NO_DRAG}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {focused && (
        <div
          className="lykn-studio-search-menu lg-menu absolute left-0 right-0 top-[calc(100%+6px)] z-[90] max-h-[min(220px,32vh)] overflow-y-auto overscroll-contain py-1.5"
          style={NO_DRAG}
          onMouseDown={(e) => e.preventDefault()}
        >
          {suggestions.length === 0 ? (
            <p className="px-4 py-3 text-center text-[12px] text-black/40 dark:text-white/40">
              No matches in Studio
            </p>
          ) : (
            suggestions.map((s) => (
              <Row
                key={s.key}
                icon={s.icon}
                faviconUrl={s.faviconUrl}
                primary={s.primary}
                secondary={s.secondary}
                onPick={s.onPick}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

/* The window frame is rounded 1.25rem (20px) and the views below are inset by
 * one 6px resize grip, so their corners have to curve that much tighter to sit
 * concentric with the frame's. Reported to the main process, which wears it on
 * the native views. */
const BROWSER_VIEW_RADIUS = 14;

/** Body of the floating Browser window: the surface the main process docks
 *  the native agent-browser views onto (tab strip, toolbar and page all
 *  render inside `hostRef`'s rect), with the agent rail beside it. The window
 *  frame supplies the card, so this fills it edge to edge. */
function StudioBrowserBody({ hostRef, desktop, shot }) {
  return (
    // The native views paint above the page and would swallow the pointer, so
    // they're inset by the width of the frame's resize grips (6px) all round —
    // the tab strip runs to the top edge here, with no title bar above it.
    <div className="flex h-full w-full p-1.5">
      <div
        ref={hostRef}
        // Matching the native views' own rounding, so the frame's background
        // (not the underlay) shows through the curve of all four corners.
        className="relative min-w-0 flex-1 overflow-hidden"
        style={{ borderRadius: BROWSER_VIEW_RADIUS }}
      >
        {/* Light underlay so the dock loads in light mode; shows while the
            views attach, and in the web preview where there are none. */}
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#ececeb] text-black/45">
          <Globe className="h-9 w-9" />
          <p className="max-w-sm text-center text-sm">
            {desktop
              ? "Your agent browser tabs appear here. Press + in the browser bar above to open one."
              : "The LYKN browser is available in the desktop app."}
          </p>
        </div>
        {/* The browser as it last looked, standing in for the native views
            while the window opens, closes, minimizes or slides out of the way —
            they can't be scaled or faded, so they leave and this animates in
            their place. Once they're back they paint over it, so it can simply
            stay: there is no swap to time and nothing flashes between the two.
            The seam matches the layout's, chrome height and all. */}
        {shot && (shot.chrome || shot.page) && (
          <div
            aria-hidden
            className="absolute inset-0 flex flex-col overflow-hidden bg-[#ececeb]"
          >
            {shot.chrome && (
              <img
                src={shot.chrome}
                alt=""
                draggable={false}
                style={{ height: shot.chromeHeight }}
                className="w-full flex-none object-cover object-top"
              />
            )}
            {shot.page && (
              <img
                src={shot.page}
                alt=""
                draggable={false}
                className="min-h-0 w-full flex-1 object-cover object-top"
              />
            )}
          </div>
        )}
      </div>
      <StudioAgentRail desktop={desktop} />
    </div>
  );
}

/* ── Browser window: glass agent rail (agent list + chat bar) ──────────── */

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

/** Short topic phrase for post-agent suggestion labels. */
function agentSuggestionTopic(raw, maxLen = 42) {
  let t = String(raw || "").replace(/\s+/g, " ").trim();
  t = t
    .replace(
      /^(please\s+)?(?:can you\s+)?(?:go\s+)?(?:and\s+)?(?:please\s+)?(?:open|browse|visit|research|find|look up|search|check|monitor|build|create|make|write|do)\s+(?:me\s+)?(?:an?\s+)?/i,
      "",
    )
    .replace(/[.?!]+$/, "")
    .trim();
  if (!t) return "this";
  if (t.length > maxLen) {
    t = `${t.slice(0, Math.max(12, maxLen - 1)).replace(/\s+\S*$/, "")}…`;
  }
  return t;
}

/** One-tap next steps after an agent turn finishes — same role as Build / Research. */
function agentFollowUpItems(topic) {
  const blank = agentSuggestionTopic(topic, 36);
  const fullTopic = agentSuggestionTopic(topic, 160);
  return [
    {
      key: "continue",
      label: "Keep going",
      prompt:
        "Keep going from here — take the next useful steps and finish anything still open",
      icon: Sparkles,
    },
    {
      key: "deeper",
      label: `Dig deeper into ${blank}`,
      prompt: `Dig deeper into ${fullTopic}: open related pages, pull more detail, and report what matters`,
      icon: Telescope,
    },
    {
      key: "next",
      label: "What's the best next step?",
      prompt: "Based on what you just did, what's the best next step — and do it",
      icon: MessageCircle,
    },
  ];
}

const AGENT_SUGGEST_ICONS = [Sparkles, Telescope, MessageCircle];

/** Map runtime / LLM follow-up strings into rail chip objects. */
function mapAgentSuggestionChips(items) {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((raw, i) => {
      if (raw == null) return null;
      if (typeof raw === "string") {
        const prompt = raw.replace(/\s+/g, " ").trim();
        if (!prompt) return null;
        return {
          key: `custom-${i}`,
          label: prompt.length > 56 ? `${prompt.slice(0, 55).replace(/\s+\S*$/, "")}…` : prompt,
          prompt,
          icon: AGENT_SUGGEST_ICONS[i % AGENT_SUGGEST_ICONS.length],
        };
      }
      const prompt = String(raw.prompt || raw.label || "").replace(/\s+/g, " ").trim();
      if (!prompt) return null;
      const label = String(raw.label || prompt).replace(/\s+/g, " ").trim();
      return {
        key: String(raw.key || `custom-${i}`),
        label: label.length > 56 ? `${label.slice(0, 55).replace(/\s+\S*$/, "")}…` : label,
        prompt,
        icon: AGENT_SUGGEST_ICONS[i % AGENT_SUGGEST_ICONS.length],
      };
    })
    .filter(Boolean)
    .slice(0, 3);
}

/** Source links from /api/ai/suggest — open in the Studio browser. */
function mapAgentSourceLinks(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw) continue;
    const url = String(raw.url || raw.href || "").trim();
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }
    const title = String(raw.title || host || url).replace(/\s+/g, " ").trim();
    out.push({
      key: `src-${out.length}`,
      title: title.length > 56 ? `${title.slice(0, 55).replace(/\s+\S*$/, "")}…` : title,
      host,
      url,
    });
    if (out.length >= 4) break;
  }
  return out;
}

/** Pull http(s) URLs out of a finished agent answer (## Link, markdown, bare). */
function extractSourceLinksFromAnswer(text) {
  const raw = String(text || "");
  if (!raw.trim()) return [];
  const found = [];
  const seen = new Set();
  const push = (url, title) => {
    const u = String(url || "").trim().replace(/[),.;]+$/, "");
    if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) return;
    if (/lykn-agent-step:\/\//i.test(u)) return;
    seen.add(u);
    let host = "";
    try {
      host = new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return;
    }
    const label = String(title || host || u).replace(/\s+/g, " ").trim();
    found.push({
      key: `ans-${found.length}`,
      title: label.length > 56 ? `${label.slice(0, 55).replace(/\s+\S*$/, "")}…` : label,
      host,
      url: u,
    });
  };
  const md = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;
  let m;
  while ((m = md.exec(raw)) !== null) push(m[2], m[1]);
  const bare = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
  while ((m = bare.exec(raw)) !== null) push(m[0], "");
  return found.slice(0, 4);
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
  a: ({ children, href, ...props }) => (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1 text-sky-300 underline underline-offset-2 hover:text-sky-200"
      onClick={(e) => {
        const u = String(href || "").trim();
        if (!u || !/^https?:\/\//i.test(u)) return;
        e.preventDefault();
        openStudioLink(u);
      }}
    >
      <LinkIcon className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
      <span className="min-w-0 truncate">{children}</span>
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
  if (a.status === "running" || a.busy) {
    return "animate-pulse text-[#3b78ff]";
  }
  // Parked on the user: brand blue, but at rest. Same "this agent is live"
  // signal without the pulse that means "working, wait".
  if (a.status === "waiting") return "text-[#3b78ff]";
  if (a.status === "error") return "text-red-400";
  const step = String(a.step || "").trim().toLowerCase();
  // A worker that has run leaves a step behind ("Done", "Stopped", last action).
  if (step && step !== "orchestrator" && step !== "idle") return "text-emerald-400";
  return "text-white/40";
}

const AGENT_CHAT_WIDTH_KEY = "lykn-studio-agent-chat-width";
const AGENT_CHAT_WIDTH_DEFAULT = 330;
const AGENT_CHAT_WIDTH_MIN = 260;
const AGENT_CHAT_WIDTH_MAX = 640;

function readAgentChatWidth() {
  try {
    const n = Number(localStorage.getItem(AGENT_CHAT_WIDTH_KEY));
    if (Number.isFinite(n) && n >= AGENT_CHAT_WIDTH_MIN && n <= AGENT_CHAT_WIDTH_MAX) {
      return Math.round(n);
    }
  } catch {
    /* ignore */
  }
  return AGENT_CHAT_WIDTH_DEFAULT;
}

function StudioAgentRail({ desktop }) {
  const [open, setOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [agents, setAgents] = useState([]);
  // Closed tabs/agents, newest first — the "History" list under Agents.
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [activeId, setActiveId] = useState(null);
  // Active agent's conversation: prompts + finished answers, plus the
  // in-flight streaming draft and a live status line while it works.
  const [thread, setThread] = useState([]);
  const [draft, setDraft] = useState("");
  const [liveStep, setLiveStep] = useState("");
  const [agentWaiting, setAgentWaiting] = useState(null);
  // Live choice offered by the running agent. Event-sourced only: the
  // runtime holds `pendingChoice` in memory and never persists it, so a row
  // rebuilt from restored state would resolve to "no_pending_choice".
  const [agentChoice, setAgentChoice] = useState(null);
  const [choiceBusy, setChoiceBusy] = useState(false);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState([]);
  // Custom post-finish chips for the active agent (runtime + LLM). Cleared on send.
  const [customSuggestions, setCustomSuggestions] = useState([]);
  const [sourceLinks, setSourceLinks] = useState([]);
  const suggestGenRef = useRef(0);
  const [chatWidth, setChatWidth] = useState(readAgentChatWidth);
  const [resizingChat, setResizingChat] = useState(false);
  const taRef = useRef(null);
  const threadRef = useRef(null);
  const activeIdRef = useRef(null);
  const chatWidthRef = useRef(chatWidth);
  const threadSnapshotRef = useRef([]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    chatWidthRef.current = chatWidth;
  }, [chatWidth]);
  useEffect(() => {
    threadSnapshotRef.current = thread;
  }, [thread]);

  // Chrome-style: chat stays hidden until "Use LYKN" in the browser is clicked.
  useEffect(() => {
    if (!desktop || !window.lykn?.onAgentChatVisibility) return;
    let dead = false;
    window.lykn
      .agentChatGet?.()
      .then((p) => {
        if (dead) return;
        if (typeof p?.open === "boolean") setOpen(!!p.open);
        if (p?.agentId) setActiveId(String(p.agentId));
      })
      .catch(() => {});
    const off = window.lykn.onAgentChatVisibility((p) => {
      if (typeof p?.open === "boolean") setOpen(!!p.open);
      // A browser task includes its paired agent id, so this sidebar loads
      // the exact center-thread conversation rather than whichever agent was
      // selected previously.
      if (p?.agentId) setActiveId(String(p.agentId));
    });
    return () => {
      dead = true;
      try {
        off?.();
      } catch {
        /* ignore */
      }
    };
  }, [desktop]);

  const setChatOpen = (next) => {
    const value = !!next;
    setOpen(value);
    try {
      window.lykn?.agentChatSet?.({ open: value });
    } catch {
      /* ignore */
    }
  };

  const beginChatResize = (e) => {
    if (!open) return;
    e.preventDefault();
    e.stopPropagation();
    setResizingChat(true);
    const startX = e.clientX;
    const startW = chatWidthRef.current;
    const onMove = (ev) => {
      // Left-edge drag: pull left to widen, right to narrow.
      const next = Math.min(
        AGENT_CHAT_WIDTH_MAX,
        Math.max(AGENT_CHAT_WIDTH_MIN, Math.round(startW + (startX - ev.clientX))),
      );
      chatWidthRef.current = next;
      setChatWidth(next);
    };
    const onUp = () => {
      setResizingChat(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem(AGENT_CHAT_WIDTH_KEY, String(chatWidthRef.current));
      } catch {
        /* ignore */
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

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
      // The event-carried row belongs to the agent we just left. Drop it and
      // let the newly active agent's own state say whether it is waiting.
      setAgentWaiting(null);
      // Same for the choice: it was raised against the previous agent's
      // pendingChoice, which this agent does not share.
      setAgentChoice(null);
      setChoiceBusy(false);
      const chips = mapAgentSuggestionChips(p?.suggestions);
      setCustomSuggestions(chips.length && !p?.busy ? chips : []);
      setSourceLinks([]);
      suggestGenRef.current += 1;
    });
    const offDelta = window.lykn.onAgentDelta?.((p) => {
      if (dead || (p?.agentId && p.agentId !== activeIdRef.current)) return;
      const t = String(p?.text || "").trim();
      if (p?.writing) {
        const n = Number(p.chars) || t.length || 0;
        // Stream the growing summary into the draft — don't leave a bare spinner.
        if (t) setDraft(t);
        // Once the wrap-up is marked final, drop the writing animation
        // immediately so it doesn't keep looping under a finished reply.
        setLiveStep(
          p?.final
            ? ""
            : n > 0
              ? `Writing output… (${n.toLocaleString()} chars)`
              : "Writing output…",
        );
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
      else setLiveStep("");
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
      // Skip follow-ups while parked on sign-in / monitoring / mid-choice.
      if (p?.waitingSignIn || p?.monitoring || p?.waitingChoice || p?.choice) {
        setCustomSuggestions([]);
        setSourceLinks([]);
        return;
      }
      const fromRuntime = mapAgentSuggestionChips(p?.suggestions);
      setCustomSuggestions(fromRuntime);
      // Answer links first (## Link / markdown) — always show with the links icon.
      setSourceLinks(extractSourceLinksFromAnswer(finalText));
      // Upgrade with LLM follow-ups tailored to this finished turn (Glass parity).
      const gen = ++suggestGenRef.current;
      void (async () => {
        try {
          if (!window.lykn?.suggest) return;
          const hist = threadSnapshotRef.current || [];
          let question = "";
          for (let i = hist.length - 1; i >= 0; i--) {
            if (hist[i]?.role === "user") {
              question = String(hist[i].content || "").trim();
              break;
            }
          }
          const data = await window.lykn.suggest(question, finalText, {
            mode: "agent_browser",
          });
          if (dead || gen !== suggestGenRef.current) return;
          const fromLlm = mapAgentSuggestionChips(data?.followups);
          if (fromLlm.length) setCustomSuggestions(fromLlm);
          const fromSuggest = mapAgentSourceLinks(data?.links);
          if (fromSuggest.length) {
            // Prefer answer links, then fill with suggest sources.
            setSourceLinks((prev) => {
              const seen = new Set(prev.map((l) => l.url));
              const merged = [...prev];
              for (const l of fromSuggest) {
                if (seen.has(l.url)) continue;
                seen.add(l.url);
                merged.push(l);
                if (merged.length >= 4) break;
              }
              return merged;
            });
          }
        } catch {
          /* keep runtime tips */
        }
      })();
    });
    // Parked runs (sign-in wall, manual step) end the turn but keep watching
    // the tab, so this state has to outlive onAgentDone.
    const offWaiting = window.lykn.onAgentWaiting?.((p) => {
      if (dead || (p?.agentId && p.agentId !== activeIdRef.current)) return;
      if (!p?.waiting) {
        setAgentWaiting(null);
        return;
      }
      const host = String(p.host || "").trim();
      const fallback =
        p.kind === "signin"
          ? `Waiting for you to sign in${host ? ` to ${host}` : ""}`
          : p.kind === "approval"
            ? "Waiting for your go-ahead"
            : "Waiting for you";
      setAgentWaiting({
        label: String(p.label || "").trim() || fallback,
        detail: String(p.detail || "").trim(),
      });
    });
    // A question with buttons. Deliberately NOT cleared on agent-done:
    // offerSendApprovalChoice ends the turn and still expects an answer.
    const offChoice = window.lykn.onAgentChoice?.((p) => {
      if (dead || (p?.agentId && p.agentId !== activeIdRef.current)) return;
      const row = agentChoiceRow(p, activeIdRef.current);
      if (!row) return;
      setAgentChoice(row);
      setChoiceBusy(false);
    });
    return () => {
      dead = true;
      offList?.();
      offProgress?.();
      offSwitched?.();
      offDelta?.();
      offDone?.();
      offWaiting?.();
      offChoice?.();
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
    setCustomSuggestions([]);
    setSourceLinks([]);
    suggestGenRef.current += 1;
    window.lykn
      .agentHistory(activeId)
      .then((snap) => {
        if (dead || !snap) return;
        setThread(Array.isArray(snap.history) ? snap.history : []);
        setDraft(String(snap.partialText || ""));
        setLiveStep(snap.busy ? String(snap.step || "Working…") : "");
        const chips = mapAgentSuggestionChips(snap.suggestions || snap.lastSuggestions);
        if (chips.length && !snap.busy) setCustomSuggestions(chips);
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
    const next = Math.min(120, el.scrollHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > 120 ? "auto" : "hidden";
  };

  const send = async (overrideText, opts = {}) => {
    const goal = String(overrideText ?? text).trim();
    const atts = overrideText != null ? [] : attachments;
    if ((!goal && !atts.length) || !window.lykn?.studioAgentSend) return;
    // Only the ACTIVE agent being mid-run blocks a send — other agents run
    // in parallel, so switching to an idle agent always lets you prompt it.
    const target = agents.find((a) => a.id === activeIdRef.current);
    if (target && (target.busy || target.status === "running")) return;
    // The runtime treats a new message while a choice is open as declining it,
    // so the buttons must not linger and imply they are still answerable.
    setAgentChoice(null);
    setChoiceBusy(false);
    const targetId = activeIdRef.current;
    const fromSuggestion = !!opts?.fromSuggestion;
    // Thread shows the short chip label; runtime still gets the grounded prompt.
    const display = fromSuggestion
      ? String(opts?.label || goal).trim() || goal
      : goal || `(${atts.length} attachment${atts.length === 1 ? "" : "s"})`;
    setText("");
    setAttachments([]);
    if (taRef.current) {
      taRef.current.style.height = "auto";
      taRef.current.style.overflowY = "hidden";
    }
    // Show the prompt immediately — the runtime's switch/seed events follow.
    setThread((prev) => [
      ...prev,
      {
        role: "user",
        content: display,
        at: new Date().toISOString(),
      },
    ]);
    setCustomSuggestions([]);
    setSourceLinks([]);
    suggestGenRef.current += 1;
    setLiveStep("Starting…");
    // Fire and forget: the promise resolves only when the whole run finishes,
    // and awaiting it would freeze the composer for every other agent.
    // Progress/done events stream the run into whichever agent is viewed.
    window.lykn
      .studioAgentSend(goal, atts, targetId, { fromSuggestion })
      .catch(() => {
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
  // A paused run has to look paused even when this rail never caught the
  // agent-waiting event — mounted late, reloaded, or was on another tab.
  const waitingRow = agentWaitingRow(active, agentWaiting);
  // Only ever the active agent's own live question.
  const choiceRow =
    agentChoice && active?.id === agentChoice.agentId ? agentChoice : null;

  const resolveAgentChoice = useCallback(
    async (buttonId) => {
      if (!choiceRow || !buttonId || choiceBusy) return;
      setChoiceBusy(true);
      try {
        await window.lykn?.agentChoiceResolve?.(
          choiceRow.agentId,
          choiceRow.choiceId,
          buttonId,
        );
      } catch {
        /* fall through — the question closes either way */
      }
      // Whatever came back, this question is over: it either resolved, or the
      // run had already moved on (no_pending_choice / stale_choice) and these
      // buttons were never going to work. Leaving them up would be the lie.
      setAgentChoice(null);
      setChoiceBusy(false);
    },
    [choiceRow, choiceBusy],
  );
  // Topic + visibility for post-finish suggestions (mirrors Build / Research).
  const latestAgentTopic = (() => {
    for (let i = thread.length - 1; i >= 0; i--) {
      const m = thread[i];
      if (m?.role === "user") {
        const content = String(m.content || "").trim();
        if (content) return content;
      }
    }
    return active?.title || "this task";
  })();
  // Suggestions panel temporarily disabled for Agent Mode.
  const showAgentSuggestions = false;
  const agentSuggestions = showAgentSuggestions
    ? customSuggestions.length
      ? customSuggestions
      : agentFollowUpItems(latestAgentTopic)
    : [];
  const agentSourceLinks = showAgentSuggestions ? sourceLinks : [];

  return (
    <>
    {/* Response rail — hidden until Use LYKN is clicked in the browser. */}
    {open ? (
    <div
      className={`relative flex h-full flex-none flex-col overflow-hidden border-l border-white/15 text-white/85 animate-in fade-in-0 slide-in-from-right-4 ${
        resizingChat ? "" : "transition-[width] duration-300 ease-out"
      }`}
      style={{
        ...NO_DRAG,
        width: chatWidth,
      }}
    >
          {/* Drag the left edge to widen / narrow the chat panel. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize agent chat"
            title="Drag to resize"
            onMouseDown={beginChatResize}
            className={`absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize touch-none ${
              resizingChat ? "bg-white/35" : "bg-transparent hover:bg-white/25"
            }`}
          />
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
              onClick={() => setChatOpen(false)}
              title="Close LYKN chat"
              className="flex h-6 w-6 items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Thread — the active agent's prompts + answers, streaming live. */}
          <div
            ref={threadRef}
            className="mt-1 min-h-0 flex-1 space-y-2.5 overflow-y-auto border-t border-white/15 px-3 py-2.5 scrollbar-hide"
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
            {liveStep && !waitingRow && (
              // Same thinking animation as the main app chat — LYKN outline
              // spinner + shimmering status text (ThinkingIndicator).
              <div className="min-w-0 text-[0.72rem] text-white/70">
                <ThinkingIndicator status={liveStep} compact tone="inherit" />
              </div>
            )}
            {waitingRow && (
              // Parked on the user: the mark rests on its solid frame and the
              // label stops shimmering. Motion here would read as "still
              // inferencing" and rush the person we are waiting on — the agent
              // is holding the task, and the next move is theirs.
              <div className="min-w-0 text-[0.72rem] text-white/70">
                <ThinkingIndicator status={waitingRow.label} compact tone="inherit" paused />
                {waitingRow.detail && (
                  <p className="mt-1 break-words pl-6 text-[0.68rem] leading-snug text-white/55">
                    {waitingRow.detail}
                  </p>
                )}
              </div>
            )}
            {choiceRow && (
              // The affordance the pause was missing: until now Studio could
              // show the question but had no way to answer it, because preload
              // never bridged "lykn:agent-choice-resolve".
              <div className="mt-2 flex flex-wrap gap-2 pl-6">
                {choiceRow.buttons.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    disabled={choiceBusy}
                    onClick={() => void resolveAgentChoice(b.id)}
                    className={`rounded-full px-3 py-1 text-[0.7rem] font-medium transition disabled:opacity-40 ${
                      b.primary
                        ? "bg-[#3b78ff] text-white hover:bg-[#5b8fff]"
                        : "border border-white/20 text-white/75 hover:bg-white/10"
                    }`}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Chat bar — same glass as the thread, split by a hairline. */}
          <div className="flex-shrink-0 border-t border-white/15 px-3 pb-2.5 pt-2">
            {(agentSuggestions.length > 0 || agentSourceLinks.length > 0) && (
              <div className="mb-2 rounded-2xl border border-white/15 bg-white/[0.06] px-2.5 py-2">
                {agentSourceLinks.length > 0 && (
                  <div className={agentSuggestions.length > 0 ? "mb-2" : ""}>
                    <p className="mb-1.5 px-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-white/40">
                      Sources
                    </p>
                    <div className="flex flex-col gap-1">
                      {agentSourceLinks.map(({ key, title, host, url }) => (
                        <button
                          key={key}
                          type="button"
                          title={url}
                          onClick={() => openStudioLink(url)}
                          className="flex min-w-0 items-center gap-2 rounded-xl border border-white/12 bg-white/[0.06] px-2.5 py-1.5 text-left text-[0.72rem] font-medium leading-snug text-white/75 transition-colors hover:bg-white/[0.12] hover:text-white"
                        >
                          <LinkIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
                          <span className="min-w-0 flex-1 truncate">{title}</span>
                          {host ? (
                            <span className="max-w-[40%] shrink-0 truncate text-[0.62rem] font-normal text-white/40">
                              {host}
                            </span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {agentSuggestions.length > 0 && (
                  <>
                    <p className="mb-1.5 px-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-white/40">
                      Suggestions
                    </p>
                    <div className="flex flex-col gap-1">
                      {agentSuggestions.map(({ key, label, prompt, icon: Icon }) => (
                        <button
                          key={key}
                          type="button"
                          disabled={activeBusy}
                          onClick={() =>
                            void send(prompt, { fromSuggestion: true, label })
                          }
                          className="flex min-w-0 items-center gap-2 rounded-xl border border-white/12 bg-white/[0.06] px-2.5 py-1.5 text-left text-[0.72rem] font-medium leading-snug text-white/75 transition-colors hover:bg-white/[0.12] hover:text-white disabled:pointer-events-none disabled:opacity-40"
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0 opacity-60" />
                          <span className="min-w-0 truncate">{label}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
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
                placeholder="Message the agent…"
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
                className="max-h-[120px] w-full resize-none overflow-hidden bg-transparent text-[0.78rem] leading-relaxed text-white/90 outline-none placeholder:text-white/35 scrollbar-hide"
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
                  onClick={() => void send()}
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
    </div>
    ) : null}

    {/* Agent strip — only with chat (Use LYKN). */}
    {open ? (
    <div
      className={`relative flex h-full flex-none flex-col overflow-hidden border-l border-white/15 text-white/85 transition-all duration-300 ease-out animate-in fade-in-0 slide-in-from-right-2 ${
        agentsOpen ? "w-[220px]" : "w-11"
      }`}
      style={NO_DRAG}
    >
      {agentsOpen ? (
        <>
          <div className="flex flex-shrink-0 items-center gap-1 px-3 pb-1.5 pt-3">
            <button
              type="button"
              onClick={() => setAgentsOpen(false)}
              title="Collapse agents"
              className="flex h-6 w-6 flex-none items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
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
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-1 scrollbar-hide">
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
                <span className={agentToneClass(a)}>
                  <PageFavicon url={a.url} className="h-4 w-4" />
                </span>
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
            <div
              className={`flex flex-none flex-col border-t border-white/10 ${
                historyOpen ? "max-h-[38%] min-h-0" : ""
              }`}
            >
              <div className="flex flex-shrink-0 items-center gap-1 px-2 pb-1 pt-2.5">
                <button
                  type="button"
                  onClick={() => setHistoryOpen((v) => !v)}
                  title={historyOpen ? "Hide history" : "Show history"}
                  aria-expanded={historyOpen}
                  className="flex min-w-0 flex-1 items-center gap-1 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-white/[0.06]"
                >
                  <span className="text-[0.66rem] font-bold uppercase tracking-[0.09em] text-white/50">
                    History
                  </span>
                  <span className="text-[0.66rem] font-semibold text-white/35">
                    {history.length}
                  </span>
                  <span className="flex-1" />
                  <ChevronDown
                    className={`h-3.5 w-3.5 flex-none text-white/45 transition-transform ${
                      historyOpen ? "" : "-rotate-90"
                    }`}
                  />
                </button>
              </div>
              {historyOpen ? (
                <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-1 scrollbar-hide">
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
                      <PageFavicon
                        url={h.url}
                        fallback={Clock}
                        className="h-3.5 w-3.5 text-white/35"
                      />
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
              ) : null}
            </div>
          )}
        </>
      ) : (
        <div className="flex h-full flex-col items-center gap-1.5 overflow-y-auto py-2.5 scrollbar-hide">
          <button
            type="button"
            onClick={() => setAgentsOpen(true)}
            title="Show agents"
            className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
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
              <span className={agentToneClass(a)}>
                <PageFavicon url={a.url} className="h-4 w-4" />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
    ) : null}
  </>
  );
}

export default function Studio() {
  const { user } = useAuth();
  const desktop = isDesktopShell();
  const studioRootRef = useRef(null);
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
  // Home doubles as the chat page: sending from the desktop chat bar layers
  // the warm chat surface over the wallpaper. Leaving Home and coming back
  // restores that conversation. Clicking Home while already on Home dismisses
  // it to the clean desktop.
  const [homeChat, setHomeChat] = useState(false);
  // Voice overlay state, broadcast by the chat surface — the rounded home
  // bar hides while the full-screen voice UI is up.
  const [homeVoice, setHomeVoice] = useState(false);
  // Whether the surfaced conversation actually has content (chat turns /
  // Imagine batches) — the rounded bar stays centered on fresh mode pages
  // and only docks to the bottom once this flips on.
  const [homeChatLive, setHomeChatLive] = useState(false);
  // Which mode page the chat surface is on — Imagine brings its own full
  // prompt bar (aspect ratios, reference images), so the rounded home bar
  // steps aside while it's up.
  const [homeView, setHomeView] = useState("chat");
  // The desktop's widgets live in their own layout (position and size per
  // widget); the walkthrough's picks are seeded into it on first run. Only the
  // Files desktop icon is still a plain on/off, because it's an icon.
  useWelcomeWidgetSync();
  const showFilesWidget = useHomeWidgetOn("files");
  // Edit mode: widgets lift off the desktop to be moved, resized and added.
  const [widgetsEditing, setWidgetsEditing] = useState(false);
  useEffect(() => {
    const onVoice = (e) => setHomeVoice(!!e?.detail?.on);
    const onActivity = (e) => setHomeChatLive(!!e?.detail?.active);
    const onViewChanged = (e) => setHomeView(String(e?.detail?.view || "chat"));
    window.addEventListener("lykn-voice-mode-changed", onVoice);
    window.addEventListener("lykn-chat-activity-changed", onActivity);
    window.addEventListener("lykn-studio-view-changed", onViewChanged);
    window.addEventListener("lykn-home-view", onViewChanged);
    return () => {
      window.removeEventListener("lykn-voice-mode-changed", onVoice);
      window.removeEventListener("lykn-chat-activity-changed", onActivity);
      window.removeEventListener("lykn-studio-view-changed", onViewChanged);
      window.removeEventListener("lykn-home-view", onViewChanged);
    };
  }, []);
  // Embedded frames mount on first visit and stay warm after that. A widget
  // can deep-link a section (e.g. a specific chat or project) via frameSrc.
  const [visited, setVisited] = useState({});
  const [frameSrc, setFrameSrc] = useState({});
  // Floating Home windows (Browser / Calendar / To-dos), back to front: the
  // last id is the focused one. Minimized windows stay in the list (and stay
  // mounted, so their state survives) and come back from the dock or their
  // widget.
  const [appWins, setAppWins] = useState([]);
  const [minimized, setMinimized] = useState({});
  // Clicking the bare wallpaper sweeps every window off the sides to reveal the
  // desktop, macOS style; clicking it again brings them all back.
  const [desktopPeek, setDesktopPeek] = useState(false);
  // Seeded from the saved preference, then kept in step with the document's
  // own `dark` class — Settings › Appearance and the OS (theme "system") flip
  // the theme without going through the toggle below.
  const [dark, setDark] = useState(() => isDarkTheme(readSavedTheme()));
  // Custom Studio backdrop (data URL) — synced from the Mac in the welcome
  // flow ("use my wallpaper" / any image). Empty = default gradient.
  const [bgImage, setBgImage] = useState("");
  // Wallpaper choice + dim/blur from Settings › Appearance.
  const [appearance, setAppearance] = useState(readAppearance);
  const [notifMuted, setNotifMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [settingsView, setSettingsView] = useState("account");
  const settingsControls = useRef(null);
  // The top bar stays tucked away by default (Home is a clean desktop); the
  // tiny toggle in the window's top-right corner pulls it back in. The bottom
  // dock is always visible.
  const [chromeShown, setChromeShown] = useState(false);
  // Dock chats popover — the LYKN icon in the bottom dock opens a panel with
  // search + recent chats, like the in-app sidebar.
  const [chatsOpen, setChatsOpen] = useState(false);
  const [chatsSearch, setChatsSearch] = useState("");
  const dockRef = useRef(null);
  const queryClient = useQueryClient();

  // The glass window shows native macOS traffic lights in its top-left
  // corner; the top bar shifts right so the welcome pill doesn't hide
  // underneath them.
  const macTrafficLights =
    glassWindow && /Mac/i.test(navigator.platform || navigator.userAgent || "");

  // Home is a blank macOS-style desktop: the top bar tucks away there too,
  // leaving just the bottom dock over the wallpaper. The tiny top-right
  // chevron pulls the full chrome (top bar) back on any tab.
  const focused = !chromeShown;

  useEffect(() => {
    document.documentElement.classList.toggle("lykn-studio-focused", focused);
    return () => document.documentElement.classList.remove("lykn-studio-focused");
  }, [focused]);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // Close the dock's chats popover on outside click / Escape.
  useEffect(() => {
    if (!chatsOpen) return;
    const onDown = (e) => {
      if (dockRef.current && !dockRef.current.contains(e.target)) setChatsOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setChatsOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [chatsOpen]);

  const { data: railChats = [] } = useQuery({
    queryKey: ["studio-rail-chats", user?.id || "guest"],
    // Prefetch so the list is already there when the dock popover opens.
    enabled: !!user?.id,
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

  const chatsNeedle = chatsSearch.trim().toLowerCase();
  const visibleRailChats = chatsNeedle
    ? railChats.filter((c) => (c.title || "").toLowerCase().includes(chatsNeedle))
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

  // The agent browser is native Electron views, not a web page, so the main
  // process docks them over the body of the floating Browser window (left of
  // the agent rail). Report that body's window-relative rect and keep it fresh
  // as the window is dragged, resized, zoomed, or the rail collapses.
  const browserHostRef = useRef(null);
  const sendBrowserBounds = useRef(null);
  // Stable so the window frame's geometry effect doesn't re-fire every render.
  const reportBrowserBounds = useCallback(() => sendBrowserBounds.current?.(), []);
  // Native views paint above the whole renderer, so they may only be on screen
  // while the window itself is: Home tab, open, not minimized, not mid-
  // animation, and not swept aside by a desktop peek (a CSS transform can't
  // carry them off with the frame, so they undock for the duration instead).
  const [browserAnimating, setBrowserAnimating] = useState(false);
  const browserDocked =
    tab === "dashboard" &&
    appWins.includes("browser") &&
    !minimized.browser &&
    !browserAnimating &&
    !desktopPeek;
  useEffect(() => {
    if (!browserDocked || !window.lykn?.setStudioBrowser) return undefined;
    const el = browserHostRef.current;
    if (!el) return undefined;
    const send = () => {
      const r = el.getBoundingClientRect();
      // Mid-open the window hasn't been measured yet; a zero rect would park
      // the views off-stage and blank the browser.
      if (r.width < 1 || r.height < 1) return;
      window.lykn.setStudioBrowser({
        open: true,
        radius: BROWSER_VIEW_RADIUS,
        bounds: {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
      });
    };
    // Dragging the window moves the host without resizing it, so the window
    // frame reports its geometry here too (see onGeometry below).
    sendBrowserBounds.current = send;
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    window.addEventListener("resize", send);
    return () => {
      sendBrowserBounds.current = null;
      ro.disconnect();
      window.removeEventListener("resize", send);
      window.lykn.setStudioBrowser({ open: false });
    };
  }, [browserDocked]);

  // The picture the window animates over while its native views are away (see
  // StudioBrowserBody). Main refreshes it as the browser changes and keeps the
  // last one after the views leave, so closing has something to fly out with
  // and the next open something to fly back in.
  const [browserShot, setBrowserShot] = useState(null);
  useEffect(() => {
    if (!window.lykn?.onStudioBrowserShot) return undefined;
    return window.lykn.onStudioBrowserShot((p) => {
      if (p?.ok) setBrowserShot(p);
    });
  }, []);

  // The Browser window has no React title bar: its tab strip is the title bar,
  // and it lives in a native view that paints above the renderer. The traffic
  // lights and the drag there run in that view and come back through the main
  // process as window controls for the frame.
  const browserControls = useRef(null);
  useEffect(() => {
    if (!window.lykn?.onStudioWindowControl) return undefined;
    return window.lykn.onStudioWindowControl(({ action, dx, dy } = {}) => {
      const c = browserControls.current;
      if (!c) return;
      if (action === "close") c.close();
      else if (action === "minimize") c.minimize();
      else if (action === "zoom") c.zoom();
      else if (action === "drag-start") {
        focusAppWindow("browser");
        c.dragStart();
      } else if (action === "drag-move") c.dragBy(Number(dx) || 0, Number(dy) || 0);
      else if (action === "drag-end") c.dragEnd();
    });
  }, []);

  // Artifact "Open" inside a Studio chat surface routes the URL into the
  // Studio browser (lykn:studio-open-url) and fires this event so the
  // Studio pops the Browser window up over Home, where the new tab is docked.
  useEffect(() => {
    const onShowBrowser = () => {
      setTab("dashboard");
      focusAppWindow("browser");
    };
    window.addEventListener("lykn-studio-show-browser", onShowBrowser);
    // "Ask AI" in the Mac Files surface hands the prompt to the chat surface
    // and fires this so the Studio flips to the Chat tab.
    const onOpenChat = () => {
      // Chat lives on Home now — surface the conversation over the desktop.
      setTab("dashboard");
      setHomeChat(true);
      setVisited((v) => (v.chat ? v : { ...v, chat: true }));
    };
    window.addEventListener("lykn-studio-open-chat", onOpenChat);
    return () => {
      window.removeEventListener("lykn-studio-show-browser", onShowBrowser);
      window.removeEventListener("lykn-studio-open-chat", onOpenChat);
    };
  }, []);

  // Custom backdrop — load once, then follow live changes (welcome flow or
  // settings can swap it while the studio is open).
  useEffect(() => {
    const b = typeof window !== "undefined" ? window.lykn : null;
    if (!b?.backgroundGet) return;
    let cancelled = false;
    b.backgroundGet()
      .then((r) => {
        if (!cancelled && r?.ok) setBgImage(r.dataUrl || "");
      })
      .catch(() => {});
    const off = b.onBackgroundChanged?.((p) => setBgImage(p?.dataUrl || ""));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  useEffect(() => subscribeAppearance(setAppearance), []);

  // Bring a floating window to the front (opening it if it isn't up yet).
  const focusAppWindow = (id) => {
    setAppWins((w) => (w[w.length - 1] === id ? w : [...w.filter((x) => x !== id), id]));
    setMinimized((m) => (m[id] ? { ...m, [id]: false } : m));
    // Reaching for a window ends the desktop peek — otherwise it would open
    // swept off-screen with nothing to show for the click.
    setDesktopPeek(false);
  };

  const closeAppWindow = (id) => {
    setAppWins((w) => w.filter((x) => x !== id));
    setMinimized((m) => (m[id] ? { ...m, [id]: false } : m));
    // Drop the deep link so the next open starts on the page's own entry.
    setFrameSrc((f) => (f[id] ? { ...f, [id]: undefined } : f));
  };

  const openTab = (id, src) => {
    setChatsOpen(false);
    // Calendar / To-dos / Settings / Browser are app windows on the desktop:
    // land on Home and pop the window up over it rather than swapping the
    // whole stage. Settings `src` names a section to land on (the desktop
    // menu's Edit Widgets / Show View Options open Display).
    if (WINDOW_APPS[id]) {
      setTab("dashboard");
      if (id === "settings") {
        if (SETTINGS_VIEWS.includes(src)) setSettingsView(src);
        else if (!appWins.includes("settings")) setSettingsView("account");
      } else if (src) {
        setFrameSrc((f) => (f[id] === src ? f : { ...f, [id]: src }));
      }
      focusAppWindow(id);
      return;
    }
    // The old Chat page is gone — every chat open (dock popover, search,
    // widgets, the home bar itself) lands on Home with the chat surface
    // layered over the desktop.
    if (id === "chat") {
      setTab("dashboard");
      setChromeShown(false);
      setHomeChat(true);
      setVisited((v) => (v.chat ? v : { ...v, chat: true }));
      if (src) setFrameSrc((f) => (f.chat === src ? f : { ...f, chat: src }));
      return;
    }
    setTab(id);
    setChromeShown(false); // every page entry starts in clean focused mode
    if (id === "dashboard") {
      // Already on Home: dismiss the conversation to the clean desktop.
      // Coming back from another tab keeps the chat where you left it.
      if (tab === "dashboard") setHomeChat(false);
      return;
    }
    setVisited((v) => (v[id] ? v : { ...v, [id]: true }));
    if (src) setFrameSrc((f) => (f[id] === src ? f : { ...f, [id]: src }));
  };

  // Surfaces outside the studio tree (the brief popup, mounted app-wide) ask
  // for a tab by name rather than routing to it. Through a ref so the listener
  // can be installed once and still see the current openTab.
  const openTabRef = useRef(openTab);
  openTabRef.current = openTab;
  useEffect(() => {
    const onOpenTab = (e) => {
      const { id, src } = e.detail || {};
      if (!id) return;
      e.preventDefault(); // tells the caller not to fall back to a route
      openTabRef.current(id, src);
    };
    window.addEventListener(STUDIO_OPEN_TAB_EVENT, onOpenTab);
    return () => window.removeEventListener(STUDIO_OPEN_TAB_EVENT, onOpenTab);
  }, []);

  const handleNavItem = (item) => {
    // The dock toggles an app window: clicking the front one tucks it away.
    const front = appWins[appWins.length - 1] === item.id && !minimized[item.id];
    if (WINDOW_APPS[item.id] && front && tab === "dashboard") {
      setMinimized((m) => ({ ...m, [item.id]: true }));
      return;
    }
    openTab(item.id);
  };

  const navActive = (item) => {
    if (WINDOW_APPS[item.id]) {
      return tab === "dashboard" && appWins.includes(item.id) && !minimized[item.id];
    }
    return item.action === "tab" && tab === item.id;
  };

  const setTheme = (nextDark) => {
    setDark(nextDark);
    persistTheme(nextDark ? "dark" : "light");
  };

  const wallpaperDim = appearance.wallpaperDim / 100;
  const wallpaperBlur = appearance.wallpaperBlur;

  return (
    <div
      ref={studioRootRef}
      className="fixed inset-0 overflow-hidden font-sans text-black/85 dark:text-white/85"
    >
      <StudioHoverTips rootRef={studioRootRef} />
      {/* Backdrop: the wallpaper picked in Settings › Appearance — one of
          Apple's, or any photo — else the app's own. A wallpaper carries a
          scrim (Appearance › Dim) so the chrome stays readable, and an optional
          blur. Otherwise: Glass (dark) in the vibrancy window stays transparent
          so the desktop blurs through; everywhere else — including Neutral,
          which is the regular opaque UI with no glass at all — we paint our own
          solid backdrop. */}
      {bgImage ? (
        <div aria-hidden className="absolute inset-0 overflow-hidden">
          <img
            src={bgImage}
            alt=""
            draggable={false}
            className="h-full w-full object-cover"
            style={{
              filter: wallpaperBlur ? `blur(${wallpaperBlur}px)` : undefined,
              // Blur samples past the edges; scale up so it can't feather into
              // a pale border around the desktop.
              transform: wallpaperBlur ? "scale(1.06)" : undefined,
            }}
          />
          <div
            className="absolute inset-0"
            style={{
              background: dark
                ? `rgba(10,11,14,${wallpaperDim})`
                : `rgba(236,236,235,${wallpaperDim * 0.67})`,
            }}
          />
        </div>
      ) : (
        (!glassWindow || !dark) && (
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
        )
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
          // relative z-30: search suggestions hang below this row and must
          // paint above the main frost panel (next sibling in the column).
          className={`relative z-30 flex w-full flex-shrink-0 items-center gap-3 select-none transition-[max-height,opacity,margin,transform] duration-500 ease-out ${
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
                title="Glass theme"
                aria-label="Glass theme"
                aria-pressed={dark}
                className={`rounded-full px-3 py-1.5 text-[0.7rem] font-medium transition-all ${
                  dark ? "bg-white text-black shadow" : "text-white/60"
                }`}
              >
                Glass
              </button>
              <button
                type="button"
                onClick={() => setTheme(false)}
                title="Neutral theme"
                aria-label="Neutral theme"
                aria-pressed={!dark}
                className={`rounded-full px-3 py-1.5 text-[0.7rem] font-medium transition-all ${
                  !dark ? "bg-black/85 text-white shadow" : "text-white/60"
                }`}
              >
                Neutral
              </button>
            </div>

            {/* The day's brief on demand — the same popup the startup card
                opens, whether or not that switch is on. */}
            <button
              type="button"
              onClick={openBrief}
              title="Show my brief"
              aria-label="Show my brief"
              style={NO_DRAG}
              className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full !text-white/70 transition-colors hover:bg-white/15 ${BAR}`}
            >
              <Newspaper className="h-4 w-4" />
            </button>

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
          </div>
          </div>
        </div>

        {/* ── Main glass panel ── */}
        <div
          className={`flex w-full flex-1 min-h-0 items-stretch ${
            fullscreen ? "max-w-full" : "max-w-[1240px]"
          }`}
        >
          {/* Center panel. On Home it's fully transparent — a blank macOS-style
              desktop where only the wallpaper shows through. Every other tab
              gets the frost card; embedded section frames paint their own
              opaque app background inside it. */}
          <div
            className={`relative flex-1 min-w-0 overflow-hidden ${
              tab === "dashboard"
                ? ""
                : `rounded-[2.2rem] shadow-[0_24px_80px_rgba(0,0,0,0.28)] ${FROST_PANEL}`
            }`}
          >
            {/* Home desktop widgets — macOS style, sitting on the wallpaper.
                They stay put during a home conversation (homeChat) — the
                transparent chat surface simply layers over them. */}
            {tab === "dashboard" && (
              <>
                {/* Behind the widgets: right-click for the desktop context
                    menu (New Folder, Open LYKN Glass, open a folder/page);
                    folders drag around like real desktop icons. */}
                <DesktopFolders
                  onOpen={openTab}
                  onEmptyClick={() => setDesktopPeek((p) => !p)}
                  onEditWidgets={() => setWidgetsEditing(true)}
                />
                {/* The real Mac desktop, mirrored on top of the folder layer
                    when Settings → Display → Sync my Desktop is on. */}
                <MacDesktopMirror onOpen={openTab} />
                {/* Widgets: each one wherever the user parked it, at the size
                    they chose. Hold one (or right-click → Edit Widgets) to
                    rearrange. */}
                <WidgetCanvas
                  userId={user?.id}
                  onOpen={openTab}
                  editing={widgetsEditing}
                  onEditingChange={setWidgetsEditing}
                />
                {/* Free-floating desktop icon — drag it anywhere; the spot
                    sticks. It positions against this panel (offsetParent). */}
                {showFilesWidget && <FilesWidget onOpen={openTab} />}
              </>
            )}
            {/* Chat is NOT in this list — it's hosted full-bleed over the
                whole desktop (below, outside this inset panel) so no panel
                edges/corners ever show around a home conversation. */}
            {SECTIONS.filter((s) => s.src && s.id !== "chat" && visited[s.id]).map(({ id, src }) => (
              <div
                key={id}
                className={`absolute inset-0 h-full w-full overflow-y-auto scrollbar-hide ${
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

        {/* ── Home chat layer — the chat surface hosted full-bleed over the
            entire desktop (window-anchored, NOT inside the inset panel, so
            no panel edges or corners show). Warm once visited; hidden on
            other tabs and on the idle desktop. --mobile-tabbar-clear lifts
            the chat's content above the dock + rounded bar. ── */}
        {visited.chat && (
          <div
            className={`absolute inset-0 z-20 overflow-hidden ${
              tab === "dashboard" && homeChat
                ? "lykn-home-chat-host"
                : "pointer-events-none opacity-0 invisible"
            }`}
            // translateZ makes this the containing block for position:fixed
            // inside the chat page, anchoring its overlays to the window.
            // no-drag punches the live chat out of the desktop's window-drag
            // region — otherwise its buttons (mode pill etc.) lose clicks to
            // the drag region. Only while live, so the idle desktop still
            // drags the window by the wallpaper.
            style={{
              transform: "translateZ(0)",
              WebkitAppRegion:
                tab === "dashboard" && homeChat ? "no-drag" : undefined,
              "--mobile-tabbar-clear": "8.75rem",
            }}
          >
            <StudioSurface entry={frameSrc.chat || "/app"} />
          </div>
        )}
        {/* ── Home app windows — Browser / Calendar / To-dos / Settings as
            floating macOS-style windows over the desktop (and over a live
            conversation).
            Window-anchored like the chat layer, over the home chat bar / mode
            pill / welcome headline (z-22) but under the top bar and dock
            (both z-30) so the chrome always stays clickable. The layer itself
            is click-through; only the windows take pointer events. Windows
            stay mounted on other tabs so their state (and any open form)
            survives a trip to Projects and back. ── */}
        {appWins.length > 0 && (
          <div className="pointer-events-none absolute inset-0 z-[25]">
            {appWins.map((id, i) => {
              const app = WINDOW_APPS[id];
              return (
                <DesktopAppWindow
                  key={id}
                  title={app.label}
                  icon={app.icon}
                  storageKey={`lykn_app_window:${id}`}
                  width={app.width}
                  height={app.height}
                  cascade={i}
                  z={i + 1}
                  active={i === appWins.length - 1}
                  hidden={tab !== "dashboard"}
                  minimized={!!minimized[id]}
                  peeked={desktopPeek}
                  onFocus={() => focusAppWindow(id)}
                  onMinimize={() => setMinimized((m) => ({ ...m, [id]: true }))}
                  onClose={() => closeAppWindow(id)}
                  // Browser tab strip and Settings sidebar each draw their
                  // own traffic lights and drag the frame through `controls`.
                  chromeless={!!(app.native || app.chromeless)}
                  controls={
                    app.native
                      ? browserControls
                      : id === "settings"
                        ? settingsControls
                        : undefined
                  }
                  // Zoomed, the Browser fills the desktop over the dock: its
                  // native page paints above every React layer, so stopping
                  // short of the bottom just leaves a dead strip.
                  zoomCoversDock={app.native}
                  // Dragging moves the native browser views with the frame.
                  onGeometry={app.native ? reportBrowserBounds : undefined}
                  // …and the frame's open/close/minimize animations park them
                  // until it settles (CSS can't scale a native view).
                  onAnimating={app.native ? setBrowserAnimating : undefined}
                >
                  {app.native ? (
                    <StudioBrowserBody
                      hostRef={browserHostRef}
                      desktop={desktop}
                      shot={browserShot}
                    />
                  ) : id === "settings" ? (
                    <SettingsModal
                      embedded
                      isOpen
                      initialView={settingsView}
                      onClose={() => closeAppWindow("settings")}
                      windowControls={settingsControls}
                    />
                  ) : (
                    <StudioSurface entry={frameSrc[id] || app.src} windowed />
                  )}
                </DesktopAppWindow>
              );
            })}
          </div>
        )}
        {/* Rounded chat bar + idle mode pill — window-anchored siblings of
            the chat layer so idle and live states line up exactly. Hidden
            while the full-screen voice overlay is up, and on the Imagine
            page (its own full prompt bar takes over there). */}
        {tab === "dashboard" && !homeVoice && !(homeChat && homeView === "imagine") && (
          <HomeChatBar
            active={homeChat}
            live={homeChatLive}
            surfaceView={homeView}
            onOpen={openTab}
            name={user ? firstName : ""}
          />
        )}

        {/* ── Bottom dock — the studio sidebar, macOS style. Always visible:
            LYKN chats popover, section icons, then the user's Mac apps with
            running indicators (Sync with Mac). ── */}
        <div ref={dockRef} className="relative z-30 mt-3 flex-shrink-0 select-none">
          {/* Chats popover — search + new chat + recent chats, like the
              in-app sidebar. Hangs above the dock, macOS-Dock style. */}
          {chatsOpen && (
            <div
              className={`absolute bottom-full left-0 mb-3 flex max-h-[24rem] w-80 flex-col rounded-[1.6rem] p-2 ${BAR}`}
            >
              <div className="flex flex-shrink-0 items-center gap-1 whitespace-nowrap px-1">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-white/55">
                  <Search className="h-3.5 w-3.5 flex-shrink-0" />
                  <input
                    autoFocus
                    value={chatsSearch}
                    onChange={(e) => setChatsSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setChatsSearch("");
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder="Search chats"
                    autoComplete="off"
                    className="w-full min-w-0 bg-transparent text-[0.72rem] text-white/85 outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 placeholder:text-white/35"
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
              <div className="mt-1.5 flex-shrink-0 whitespace-nowrap px-3">
                <span className="text-[0.6rem] font-semibold uppercase tracking-widest text-white/40">
                  Recent chats
                </span>
              </div>
              <div className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5 scrollbar-hide">
                {visibleRailChats.length === 0 ? (
                  <p className="px-3 py-2 text-[0.68rem] text-white/35">
                    {chatsNeedle ? "No matches" : "No chats yet"}
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

          {/* The pill itself is a window drag surface; every control inside
              opts out with no-drag so clicks land normally. */}
          <div className={`flex items-center gap-1 rounded-full p-1.5 ${BAR}`} style={DRAG}>
            {/* LYKN icon — recent chats, like the app sidebar's header. */}
            <button
              type="button"
              onClick={() => setChatsOpen((v) => !v)}
              title={chatsOpen ? "Close chats" : "Recent chats"}
              aria-label={chatsOpen ? "Close chats" : "Recent chats"}
              aria-expanded={chatsOpen}
              style={NO_DRAG}
              className={`grid h-10 w-10 flex-shrink-0 place-items-center rounded-full transition-colors ${
                chatsOpen ? "bg-white/15" : "hover:bg-white/15"
              }`}
            >
              <img
                src={dark ? lyknIconUrl : lyknIconBlueUrl}
                alt=""
                className="h-8 w-8 object-contain"
                draggable={false}
              />
            </button>
            {NAV_ITEMS.map((item) => (
              <CircleIconButton
                key={item.id}
                icon={item.icon}
                label={item.label}
                active={navActive(item)}
                onClick={() => handleNavItem(item)}
              />
            ))}
            {/* The user's Mac apps — launchable from inside LYKN, with
                running indicators (Sync with Mac). */}
            {desktop && (
              <div style={NO_DRAG} className="flex items-center">
                <MacAppDock />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tiny chrome toggle — pinned to the window's top-right corner, over
          the studio background itself. */}
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
        {focused ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
