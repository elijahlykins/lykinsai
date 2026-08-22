import * as Icons from "lucide-react";
import { AppWindow } from "lucide-react";

/**
 * Icons for the apps LYKN builds.
 *
 * An app's icon can come from three places, in order: the user's own pick, the
 * `icon` field the model wrote into `app.json`, and — when neither says
 * anything — a deterministic pick from the palette below. That last step is
 * what stops a dock full of apps from being a row of identical squares.
 */

/**
 * Is this a thing React can render?
 *
 * lucide builds every icon with `forwardRef`, which React exposes as an object
 * rather than a function — so a `typeof === "function"` check here would reject
 * the entire library and quietly send every app to the fallback.
 */
function isComponent(value) {
  if (typeof value === "function") return true;
  return typeof value === "object" && value !== null && "$$typeof" in value;
}

function pascalCase(name) {
  return String(name || "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
}

/**
 * The lucide export an icon string names, or null.
 *
 * Canonical because the same icon arrives spelled several ways — the model
 * writes `notebook-pen` in a manifest, the picker stores `NotebookPen` — and
 * the two have to compare equal or the grid highlights nothing.
 */
export function canonicalIconName(name) {
  const key = pascalCase(name);
  return key && isComponent(Icons[key]) ? key : null;
}

/** The lucide component for a name, or null if there isn't one. */
export function resolveAppIcon(name) {
  const key = canonicalIconName(name);
  return key ? Icons[key] : null;
}

/**
 * The picker's shelf: a spread wide enough that most apps have an obviously
 * right icon, short enough to scan without searching. Anything else in lucide
 * is still reachable through `searchAppIcons`.
 */
export const APP_ICON_CHOICES = [
  "LayoutDashboard", "AppWindow", "Notebook", "NotebookPen", "StickyNote", "FileText",
  "ListTodo", "ClipboardList", "CheckCheck", "Kanban", "Table", "Layers",
  "Calendar", "CalendarDays", "Clock", "Timer", "AlarmClock", "Hourglass",
  "Target", "Trophy", "Flame", "Sparkles", "Star", "Heart",
  "Gamepad2", "Dices", "Puzzle", "Swords", "PartyPopper", "Smile",
  "Rocket", "Compass", "Map", "MapPin", "Plane", "Car",
  "Dumbbell", "Activity", "HeartPulse", "Footprints", "Bed", "Pill",
  "Salad", "UtensilsCrossed", "ChefHat", "Coffee", "Wine", "Cake",
  "ShoppingCart", "ShoppingBag", "Store", "Receipt", "Wallet", "PiggyBank",
  "CreditCard", "DollarSign", "TrendingUp", "BarChart3", "PieChart", "Calculator",
  "Briefcase", "Building2", "Users", "UserRound", "Contact", "Handshake",
  "MessageCircle", "Mail", "Send", "Phone", "Bell", "Megaphone",
  "Camera", "Image", "Film", "Music", "Headphones", "Mic",
  "BookOpen", "GraduationCap", "Library", "Languages", "PenTool", "Palette",
  "Brush", "Scissors", "Wrench", "Hammer", "Ruler", "Settings",
  "Cpu", "Database", "Code", "Terminal", "Globe", "Cloud",
  "Wifi", "Lock", "Key", "Shield", "Search", "Filter",
  "Folder", "Archive", "Package", "Truck", "Tag", "Bookmark",
  "Leaf", "TreePine", "Flower2", "Sun", "Moon", "CloudRain",
  "Droplet", "Zap", "Lightbulb", "Battery", "Thermometer", "Gift",
  "Dog", "Cat", "Bird", "Fish", "Baby", "House",
];

/**
 * Defaults for apps that never named an icon. A subset of the shelf rather than
 * all of it: every icon here has to read as "an app" on its own, which the
 * more literal ones (a pill, a fish) do not.
 */
const FALLBACK_PALETTE = [
  "LayoutDashboard", "Notebook", "ListTodo", "Calendar", "Timer", "Target",
  "Sparkles", "Compass", "Rocket", "Gamepad2", "Wallet", "BarChart3",
  "BookOpen", "Palette", "Music", "Boxes", "Zap", "Leaf",
  "Lightbulb", "Puzzle", "Layers", "Star", "Flame", "Bookmark",
];

/** FNV-1a. Small, stable across sessions, and good enough to spread ids evenly. */
function hash(seed) {
  let h = 0x811c9dc5;
  const s = String(seed);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The icon an unnamed app gets. Keyed by the app's id so it is the same icon
 * every time the dock renders, and different from the app installed next to it.
 */
export function defaultAppIcon(seed) {
  if (!seed) return AppWindow;
  const name = FALLBACK_PALETTE[hash(seed) % FALLBACK_PALETTE.length];
  return resolveAppIcon(name) || AppWindow;
}

/**
 * Resolve an app's icon to a lucide component.
 *
 * The name is written by a language model or picked by the user, so an unknown
 * one is expected rather than exceptional — fall back instead of returning
 * undefined, which React would throw on and take the whole dock down with it.
 */
export function appIconFor(name, seed) {
  return resolveAppIcon(name) || defaultAppIcon(seed);
}

let allNames = null;

/**
 * Every icon lucide ships, for the picker's search box.
 *
 * The module exports each icon several times over (`Pencil`, `PencilIcon`,
 * `LucidePencil`), so the aliases are dropped — otherwise the grid shows the
 * same picture three times in a row.
 */
function iconNames() {
  if (allNames) return allNames;
  allNames = Object.keys(Icons)
    .filter(
      (n) =>
        /^[A-Z]/.test(n) &&
        !n.startsWith("Lucide") &&
        !n.endsWith("Icon") &&
        isComponent(Icons[n]),
    )
    .sort();
  return allNames;
}

/** Icon names matching a query, curated shelf first. */
export function searchAppIcons(query, limit = 120) {
  const q = String(query || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!q) return APP_ICON_CHOICES.slice(0, limit);

  const matches = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(q);
  const curated = APP_ICON_CHOICES.filter(matches);
  const seen = new Set(curated);
  const rest = iconNames().filter((n) => matches(n) && !seen.has(n));
  return [...curated, ...rest].slice(0, limit);
}

/** Readable label for an icon name: `NotebookPen` → `Notebook pen`. */
export function appIconLabel(name) {
  const words = String(name || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

export default appIconFor;
