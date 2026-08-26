// Studio app registry — which apps/sections exist in the Studio shell and how
// they open (floating window, stage tab, dock entry, split pane), plus the
// shared chrome constants the shell's surfaces are painted with.
import {
  Activity,
  CalendarDays,
  Folder,
  FolderKanban,
  Home,
  ListTodo,
  MessageCircle,
  Settings,
} from "lucide-react";
import { BotMark } from "@/components/bots/BotAvatar";
import BrowserMark from "@/components/macdesktop/BrowserMark";

// Pages that open as macOS-style floating windows over the Home desktop
// instead of taking over the studio stage. `src` is the MemoryRouter entry
// for the window's surface (a caller can deep-link, e.g. /calendar?new=…);
// `native` windows have no routed page at all — the main process docks real
// Electron views into the window's body instead.
export const WINDOW_APPS = {
  browser: {
    label: "Browser",
    icon: BrowserMark,
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
  // Wide enough for the card rail to show several projects at once, and for
  // the detail page's two-column body to stay two columns. The extra height
  // over Vault's clears the rail's paging arrows below the cards.
  projects: {
    label: "Projects",
    icon: FolderKanban,
    src: "/projects",
    width: 1120,
    height: 800,
  },
  // The vault is a folder you open, not a place you navigate to, so it gets a
  // real window like Calendar rather than swallowing the stage. It's also the
  // Mac file browser: its sidebar switches between the vault and folders on
  // disk, which is why there's no separate Files window. Wide enough that the
  // masonry grid still lands three or four columns next to that sidebar.
  vault: {
    label: "Vault",
    icon: Folder,
    src: "/vault",
    width: 1180,
    height: 760,
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
  // LYKN Bots — always-on agents you build once and message like coworkers.
  // Each Bot is a durable persona wrapped around a worker agent (with its own
  // browser tab) plus a task queue, so work dispatches the moment the
  // previous task finishes. First open lands on the build-your-first-Bot
  // screen.
  bots: {
    label: "Bots",
    icon: BotMark,
    src: "/bots",
    width: 960,
    height: 680,
  },
  // LYKN Activity — what every Bot is doing right now (with Stop), all
  // routines across Bots (pause / run now / delete), and recent routine
  // runs. Notification clicks land here or on the owning Bot.
  activity: {
    label: "Activity",
    icon: Activity,
    src: "/activity",
    width: 620,
    height: 700,
  },
};

export const SECTIONS = [
  { id: "dashboard", label: "Dashboard", icon: Home },
  { id: "chat", label: "Chat", icon: MessageCircle, src: "/app" },
  // No `src` on these: they open as floating windows (see WINDOW_APPS), so
  // they must not also mount into the stage card behind those windows.
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "vault", label: "Vault", icon: Folder },
  { id: "files", label: "Files", icon: Folder },
  { id: "browser", label: "Browser", icon: BrowserMark },
  { id: "bots", label: "Bots", icon: BotMark },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "todos", label: "To-dos", icon: ListTodo },
  { id: "settings", label: "Settings", icon: Settings },
];

// Sections of the settings dialog a caller can land on directly, e.g.
// openTab("settings", "appearance"). The trailing ids are the pre-rename
// names, which SettingsModal still maps to their current sections.
export const SETTINGS_VIEWS = [
  "account",
  "workspace",
  "assistant",
  "notifications",
  // Desktop-only panes: SettingsModal hides them in the browser, where they
  // land on Account like any other section it doesn't recognise.
  "localVault",
  "installedApps",
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

// Left rail (icons) + bottom dock (words). Every entry but Home pops up as an
// app window on the Home desktop (see WINDOW_APPS).
export const NAV_ITEMS = [
  // No Chat entry — Home IS the chat page: the desktop hosts the chat
  // surface and its rounded bar. Chats open there via openTab("chat", …).
  { id: "dashboard", label: "Home", icon: Home, action: "tab" },
  { id: "browser", label: "Browser", icon: BrowserMark, action: "tab" },
  { id: "bots", label: "Bots", icon: BotMark, action: "tab" },
  { id: "activity", label: "Activity", icon: Activity, action: "tab" },
  { id: "projects", label: "Projects", icon: FolderKanban, action: "tab" },
  { id: "vault", label: "Vault", icon: Folder, action: "tab" },
  { id: "files", label: "Files", icon: Folder, action: "tab" },
  { id: "calendar", label: "Calendar", icon: CalendarDays, action: "tab" },
  { id: "todos", label: "To-dos", icon: ListTodo, action: "tab" },
  { id: "settings", label: "Settings", icon: Settings, action: "tab" },
];

// Home is the default and lives on the LYKN icon's double-click. Files,
// Projects, Calendar, To-dos, and Settings are available from the Vault
// sidebar, so they stay reachable if they're pulled off the dock. Calendar
// and To-dos also render beside the user's custom apps in the dock.
export const DOCK_ITEMS = NAV_ITEMS.filter(
  (item) =>
    !["dashboard", "files", "projects", "settings", "calendar", "todos"].includes(item.id),
);
export const CUSTOM_APP_NEIGHBORS = NAV_ITEMS.filter((item) =>
  ["calendar", "todos"].includes(item.id),
);
export const STUDIO_DOCK_HIDEABLE = new Set(["calendar", "todos"]);
const STUDIO_DOCK_HIDDEN_KEY = "lykn_studio_dock_hidden";

export function loadHiddenDockIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(STUDIO_DOCK_HIDDEN_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((id) => STUDIO_DOCK_HIDEABLE.has(String(id)));
  } catch {
    return [];
  }
}

export function saveHiddenDockIds(ids) {
  try {
    localStorage.setItem(STUDIO_DOCK_HIDDEN_KEY, JSON.stringify(ids));
  } catch {
    /* stays for this session */
  }
}

export const SPLIT_APPS = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  ...NAV_ITEMS.filter((item) => item.id !== "dashboard").map((item) => ({
    id: item.id,
    label: item.label,
    icon: item.icon,
  })),
];

/** Drop a query key from a MemoryRouter entry like `/vault?pane=drive&pick=chat`. */
export function stripQueryParam(path, key) {
  const raw = String(path || "");
  const q = raw.indexOf("?");
  if (q < 0) return raw;
  const params = new URLSearchParams(raw.slice(q + 1));
  if (!params.has(key)) return raw;
  params.delete(key);
  const search = params.toString();
  return search ? `${raw.slice(0, q)}?${search}` : raw.slice(0, q);
}

// Floating chrome (left rail, bottom dock). Glass (dark) =
// smoked frost over the window's vibrancy with light text; Neutral = the
// regular light UI: near-solid white surfaces with dark ink over the opaque
// backdrop. The rest of the shell's hardcoded white/NN utilities get
// remapped for Neutral in index.css ("STUDIO NEUTRAL").
// Ink comes from the surface itself (--lg-text), which already flips with the
// Neutral/Glass theme, so the bars carry no color utility of their own.
export const BAR = "lg-desktop-surface";

// The stage behind the embedded pages — same surface family as the bars.
export const FROST_PANEL =
  "border border-black/10 dark:border-white/10 bg-white/55 dark:bg-black/40";

export const DRAG = { WebkitAppRegion: "drag" };
export const NO_DRAG = { WebkitAppRegion: "no-drag" };
