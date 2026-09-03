import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderKanban,
  ListTodo,
  Mic,
  Plus,
  RotateCw,
  Search,
  X,
} from "lucide-react";
import { BotMark } from "@/components/bots/BotAvatar";
import BrowserMark from "@/components/macdesktop/BrowserMark";
import lyknIconLight from "@/assets/FINAL/LYKN-ICON-B-Open/SVG/LYKN-Icon-B-Open-NEUTRAL.svg";
import lyknIconBlue from "@/assets/FINAL/LYKN-ICON-B-Open/SVG/LYKN-Icon-B-Open-BLUE.svg";
import waveWall from "@/assets/hero-wave-blue.jpg";
import { LyknWordmark } from "@/components/landing/LyknWordmark";
import DesktopChatBar, {
  DesktopModePills,
  type DesktopChatMode,
} from "@/components/landing/DesktopChatBar";
import {
  CalendarTile,
  MonthTile,
} from "@/components/landing/DesktopHomePreview";

const DOCK = [
  { id: "browser", label: "Browser", icon: BrowserMark },
  { id: "bots", label: "Bots", icon: BotMark },
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "vault", label: "Vault", icon: Folder },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "todos", label: "To-dos", icon: ListTodo },
] as const;

const FOLDERS = [
  { label: "Files", tint: "sky" },
  { label: "Vault", tint: "white" },
  { label: "LYKN", tint: "sky" },
  { label: "Screenshots", tint: "sky" },
  { label: "Marketing", tint: "sky" },
  { label: "LYKN Landing", tint: "sky" },
] as const;

function FakeFolder({
  label,
  tint,
}: {
  label: string;
  tint: "sky" | "white";
}) {
  return (
    <div className="gl-hero-desk-icon">
      <span className={`gl-hero-desk-icon-art is-${tint}`}>
        <Folder strokeWidth={1} fill="currentColor" />
      </span>
      <span className="gl-hero-desk-icon-label">{label}</span>
    </div>
  );
}

/** The LYKN browser pulled up over the desktop: mac window chrome with a
    New-tab tab, nav toolbar, and the glowing new-tab page with AI search. */
function BrowserWindow() {
  return (
    <div className="gl-hero-browser">
      <div className="gl-hero-browser-top">
        <span className="gl-hero-browser-lights">
          <i />
          <i />
          <i />
        </span>
        <span className="gl-hero-browser-tab">
          <img src={lyknIconBlue} alt="" draggable={false} />
          New tab
          <X />
        </span>
        <Plus className="gl-hero-browser-newtab" />
      </div>
      <div className="gl-hero-browser-nav">
        <ChevronLeft />
        <ChevronRight />
        <RotateCw />
        <ArrowDownToLine />
        <span className="gl-hero-browser-url">Search or type a URL</span>
        <span className="gl-hero-browser-ask">
          Ask
          <img src={lyknIconLight} alt="" draggable={false} />
        </span>
      </div>
      <div className="gl-hero-browser-body">
        <img
          className="gl-hero-browser-logo"
          src={lyknIconBlue}
          alt=""
          draggable={false}
        />
        <div className="gl-hero-browser-search">
          <Search />
          <span className="gl-hero-browser-search-hint">Search the web</span>
          <Mic />
          <span className="gl-hero-browser-aimode">
            <img src={lyknIconLight} alt="" draggable={false} />
            AI Mode
          </span>
        </div>
      </div>
    </div>
  );
}

/** The hero's screen: the blue wave wallpaper with a frosted glass card of
    the LYKN desktop UI (widgets, folders, chat bar, dock) floating on it.
    Pass `mode` and `prompt` to pin the bar to one scene (e.g. Build mode
    with a fixed ask) instead of the cycling hero prompts, `cycleModes` to
    auto-rotate the active mode pill while the ask stays put, or
    `appWindow` to pull an app window up over the desktop. */
export default function HeroDesktopStage({
  mode: initialMode = "chat",
  prompt,
  typePrompt = false,
  cycleModes,
  appWindow,
}: {
  mode?: DesktopChatMode;
  prompt?: string;
  /** Type `prompt` out once on mount instead of showing it whole. */
  typePrompt?: boolean;
  cycleModes?: readonly DesktopChatMode[];
  appWindow?: "browser";
} = {}) {
  const [mode, setMode] = useState<DesktopChatMode>(
    cycleModes?.[0] ?? initialMode,
  );

  useEffect(() => {
    if (!cycleModes?.length) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let i = 0;
    const timer = window.setInterval(() => {
      i = (i + 1) % cycleModes.length;
      setMode(cycleModes[i]);
    }, 1900);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="gl-hero-stage" data-header-tone="dark" aria-hidden="true">
      <div className="gl-hero-page-body">
        <img
          className="gl-hero-page-wall"
          src={waveWall}
          alt=""
          draggable={false}
        />

        <div className="gl-hero-glass">
          <div className="gl-hero-desk-widgets">
            <CalendarTile />
            <MonthTile />
          </div>

          <div className="gl-hero-desk-modes">
            <DesktopModePills mode={mode} onChange={setMode} />
          </div>

          <div className="gl-hero-desk-icons">
            {FOLDERS.map((folder) => (
              <FakeFolder key={folder.label} {...folder} />
            ))}
          </div>

          {appWindow == null ? (
            <div className="gl-hero-desk-center">
              <p className="gl-hero-desk-welcome">
                Welcome to <LyknWordmark decorative />
              </p>
              <DesktopChatBar
                className="gl-hero-desk-homebar"
                showModes={false}
                mode={mode}
                onModeChange={setMode}
                cyclePrompts={prompt == null}
                staticPrompt={prompt}
                typeStaticPrompt={typePrompt}
              />
            </div>
          ) : (
            <BrowserWindow />
          )}

          <div className="gl-hero-desk-dock">
            <div className="gl-hero-desk-dock-pill">
              <span className="gl-hero-desk-dock-lykn">
                <img src={lyknIconLight} alt="" draggable={false} />
              </span>
              {DOCK.map(({ id, label, icon: Icon }) => (
                <span key={id} className="gl-hero-desk-dock-btn" title={label}>
                  <Icon className="h-[1.05rem] w-[1.05rem]" />
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
