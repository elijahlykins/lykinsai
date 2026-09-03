import { useEffect, useState } from "react";
import { CalendarDays, Folder, FolderKanban, ListTodo } from "lucide-react";
import { BotMark } from "@/components/bots/BotAvatar";
import BrowserMark from "@/components/macdesktop/BrowserMark";
import lyknIconBlue from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-BLUE-master.png";
import imagineClouds from "@/assets/imagine-clouds.png";
import deskTexture from "@/assets/hero-desk-texture.jpg";
import { LyknWordmark } from "@/components/landing/LyknWordmark";
import DesktopChatBar from "@/components/landing/DesktopChatBar";

const WIDGET = "gl-desk-widget";

const DOCK = [
  { id: "browser", label: "Browser", icon: BrowserMark },
  { id: "bots", label: "Bots", icon: BotMark },
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "vault", label: "Vault", icon: Folder },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "todos", label: "To-dos", icon: ListTodo },
] as const;

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      const d = new Date();
      setNow(d);
      timer = window.setTimeout(
        tick,
        60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()),
      );
    };
    tick();
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className={`${WIDGET} gl-desk-clock`}>
      <p className="gl-desk-clock-time">
        {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
      </p>
      <p className="gl-desk-clock-day">
        {now.toLocaleDateString(undefined, { weekday: "long" })}
      </p>
      <p className="gl-desk-clock-date">
        {now.toLocaleDateString(undefined, { month: "long", day: "numeric" })}
      </p>
    </div>
  );
}

export function CalendarTile() {
  const now = new Date();
  return (
    <div className={`${WIDGET} gl-desk-cal`}>
      <p className="gl-desk-cal-weekday">
        {now.toLocaleDateString(undefined, { weekday: "long" })}
      </p>
      <p className="gl-desk-cal-num">{now.getDate()}</p>
      <div className="gl-desk-cal-event">
        <p>Design review</p>
        <p>Today · 2:00 PM</p>
      </div>
    </div>
  );
}

export function MonthTile() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [
    ...Array.from({ length: firstWeekday }, () => null as number | null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const initials = Array.from({ length: 7 }, (_, i) =>
    new Date(2023, 0, i + 1).toLocaleDateString(undefined, { weekday: "narrow" }),
  );

  return (
    <div className={`${WIDGET} gl-desk-month`}>
      <p className="gl-desk-cal-weekday">
        {now.toLocaleDateString(undefined, { month: "long" })}
      </p>
      <div className="gl-desk-month-week">
        {initials.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="gl-desk-month-grid">
        {cells.map((day, i) => (
          <span
            key={i}
            className={day === now.getDate() ? "is-today" : undefined}
          >
            {day ?? ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function DeskIcon({
  label,
  tint,
  badge,
}: {
  label: string;
  tint: string;
  badge?: string;
}) {
  return (
    <div className="gl-desk-icon">
      <span className="gl-desk-icon-art">
        <Folder className={tint} strokeWidth={1} fill="currentColor" />
        {badge ? <span className="gl-desk-icon-badge">{badge}</span> : null}
      </span>
      <span className="gl-desk-icon-label">{label}</span>
    </div>
  );
}

/**
 * Marketing replica of Studio Home: wallpaper, widgets, Mac-synced folders,
 * the real chat bar, and the bottom dock.
 */
export default function DesktopHomePreview({
  variant = "stage",
  wallpaper,
  onActivate,
}: {
  variant?: "compact" | "stage" | "wide" | "hero";
  wallpaper?: "clouds" | "steel";
  onActivate?: () => void;
}) {
  const surface = wallpaper ?? (variant === "hero" ? "steel" : "clouds");
  return (
    <div
      className={`gl-desk gl-desk--${variant} gl-desk--${surface}`}
      aria-hidden="true"
    >
      <img
        className="gl-desk-wall"
        src={surface === "steel" ? deskTexture : imagineClouds}
        alt=""
        draggable={false}
      />
      <div className="gl-desk-scrim" />

      <div className="gl-desk-widgets">
        <CalendarTile />
        <MonthTile />
        <LiveClock />
      </div>

      <div className="gl-desk-icons">
        <DeskIcon label="Desktop" tint="text-sky-400" badge="Mac" />
        <DeskIcon label="Files" tint="text-amber-400" />
        <DeskIcon label="Vault" tint="text-blue-500" />
      </div>

      <div className="gl-desk-center">
        <p className="gl-desk-welcome">
          Welcome to <LyknWordmark decorative />
        </p>
        <DesktopChatBar
          className="gl-desk-homebar"
          onActivate={onActivate}
          showModes={variant !== "compact"}
        />
      </div>

      <div className="gl-desk-dock">
        <div className="lg-desktop-surface gl-desk-dock-pill">
          <span className="gl-desk-dock-lykn">
            <img src={lyknIconBlue} alt="" draggable={false} />
          </span>
          {DOCK.map(({ id, label, icon: Icon }) => (
            <span key={id} className="gl-desk-dock-btn" title={label}>
              <Icon className="h-[1.05rem] w-[1.05rem]" />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
