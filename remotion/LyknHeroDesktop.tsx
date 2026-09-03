import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  ArrowUp,
  AudioLines,
  CalendarDays,
  ChevronDown,
  Code,
  Folder,
  FolderKanban,
  Globe,
  GraduationCap,
  ImagePlus,
  Layers,
  ListTodo,
  MessageCircle,
  Mic,
  Newspaper,
  Plus,
  Telescope,
  TrendingUp,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { ICON_PATH, ICON_VIEWBOX } from "./brand";
import {
  ORGANIZE_AFTER_SEND,
  ORGANIZE_BLANK,
  ORGANIZE_SEND_HOLD,
  ORGANIZE_SWIPE,
  OrganizeIcons,
  SwipeSeam,
  swipeLayer,
} from "./heroDesktopTidy";

// Landing hero desktop stage, then a camera push into the chat bar that
// tracks the caret as it types a single ask.

export type HeroDesktopMode = "chat" | "build" | "imagine" | "research";
type Mode = HeroDesktopMode;

const ASK_ORGANIZE = "can you organize my computer???";
const ASK_RESEARCH = "can you research the top productivity apps for me???";
const PREAMBLE_RESEARCH = "ok.....";
const CHARS_PER_FRAME = 2.2;
const PREAMBLE_HOLD = 18;

const MODES: { id: Mode; label: string; Icon: typeof MessageCircle }[] = [
  { id: "chat", label: "Chat", Icon: MessageCircle },
  { id: "build", label: "Build", Icon: Code },
  { id: "imagine", label: "Imagine", Icon: ImagePlus },
  { id: "research", label: "Research", Icon: Telescope },
];

const FOLDERS: { label: string; tint: "sky" | "white" }[] = [
  { label: "Files", tint: "sky" },
  { label: "Vault", tint: "white" },
  { label: "LYKN", tint: "sky" },
  { label: "Screenshots", tint: "sky" },
  { label: "Marketing", tint: "sky" },
  { label: "LYKN Landing", tint: "sky" },
];

const NOW = new Date(2026, 8, 1);
export const SANS =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
export const EASE_UP = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_CAM = Easing.bezier(0.4, 0, 0.2, 1);

export const HERO_DESKTOP_FPS = 30;
export const HERO_DESKTOP_WIDTH = 1920;
export const HERO_DESKTOP_HEIGHT = 1200;
export const ZOOM_CLOSE = 4.6;
/** Keep the world under Chrome's typical 8192px layer cap. */
export const HERO_SUPERSAMPLE = 4;
export const HERO_WORLD_WIDTH = HERO_DESKTOP_WIDTH * HERO_SUPERSAMPLE;
export const HERO_WORLD_HEIGHT = HERO_DESKTOP_HEIGHT * HERO_SUPERSAMPLE;
/** Screen-space wallpaper frost behind the chat bar. */
export const HERO_GLASS_BLUR_BASE = 96;

export const rem = HERO_WORLD_WIDTH / 54;

// Authored layout of the scaled chat bar in composition space (see ChatBar).
export const BAR_VISUAL_SCALE = 0.7;
export const BAR_LAYOUT_W = 27 * rem;
export const BAR_VISUAL_W = BAR_LAYOUT_W * BAR_VISUAL_SCALE;
export const BAR_LEFT = (HERO_WORLD_WIDTH - BAR_VISUAL_W) / 2;
const BAR_LAYOUT_H = 1.55 * rem + 0.56 * rem;
const GROUP_H = BAR_LAYOUT_H;
const GROUP_TOP = (HERO_WORLD_HEIGHT - GROUP_H) / 2;
export const BAR_TOP = GROUP_TOP;
export const BAR_CY = BAR_TOP + (BAR_LAYOUT_H * BAR_VISUAL_SCALE) / 2;
export const TEXT_START_X =
  BAR_LEFT +
  (0.4 + 0.35 + 19 / 16 + 0.15 + 0.75 + 0.25 + 0.2 + 1.55 + 0.2) *
    rem *
    BAR_VISUAL_SCALE;
const TEXT_END_X =
  BAR_LEFT +
  BAR_VISUAL_W -
  (0.2 + 1.55 + 0.2 + 1.55 + 0.2 + 1.55 + 0.28) * rem * BAR_VISUAL_SCALE;
export const CHAR_W = 0.72 * rem * BAR_VISUAL_SCALE * 0.5;
const ZOOM_MENU = 2.95;
const ZOOM_ITEM = 3.55;
export const SEND_CX =
  BAR_LEFT + BAR_VISUAL_W - (0.28 + 1.55 / 2) * rem * BAR_VISUAL_SCALE;
export const SEND_CY = BAR_CY;

// HomeChatBar research Sources chip + menu (w-52, h-8, All sources / Web / ...).
const SOURCE_CHIP_W = 6.85;
const SOURCE_MENU_W = 13;
const SOURCE_MENU_PAD = 0.375;
const SOURCE_ITEM_H = 1.625;
const SOURCE_MENU_GAP = 0.35;
const SOURCE_PICK_INDEX = 1;
const SOURCE_OPTIONS: {
  value: string;
  label: string;
  shortLabel: string;
  Icon: LucideIcon;
}[] = [
  { value: "all", label: "All sources", shortLabel: "All sources", Icon: Layers },
  { value: "web", label: "Web", shortLabel: "Web", Icon: Globe },
  { value: "academic", label: "Academic", shortLabel: "Academic", Icon: GraduationCap },
  { value: "news", label: "News", shortLabel: "News", Icon: Newspaper },
  { value: "social", label: "Social", shortLabel: "Social", Icon: Users },
  { value: "finance", label: "Markets & finance", shortLabel: "Markets", Icon: TrendingUp },
];
const SOURCE_PICK = SOURCE_OPTIONS[SOURCE_PICK_INDEX];
const SOURCE_MENU_H =
  SOURCE_MENU_PAD * 2 + SOURCE_OPTIONS.length * SOURCE_ITEM_H;
const SOURCE_RIGHT_CLUSTER =
  0.28 + 1.55 + 0.2 + 1.55 + 0.2 + 1.55 + 0.2;
const SOURCES_CX =
  BAR_LEFT +
  BAR_VISUAL_W -
  (SOURCE_RIGHT_CLUSTER + SOURCE_CHIP_W / 2) * rem * BAR_VISUAL_SCALE;
const SOURCES_CY = BAR_CY;
const MENU_CX =
  SOURCES_CX +
  (SOURCE_CHIP_W / 2 - SOURCE_MENU_W / 2) * rem * BAR_VISUAL_SCALE;
const barLocalY = (unscaledRem: number) =>
  BAR_TOP + unscaledRem * rem * BAR_VISUAL_SCALE;
const MENU_MID_CY = barLocalY(-SOURCE_MENU_GAP - SOURCE_MENU_H / 2);
const MENU_OVERVIEW_CY = (SOURCES_CY + MENU_MID_CY) / 2;
const MENU_WEB_CY = barLocalY(
  -SOURCE_MENU_GAP -
    SOURCE_MENU_H +
    SOURCE_MENU_PAD +
    SOURCE_PICK_INDEX * SOURCE_ITEM_H +
    SOURCE_ITEM_H / 2,
);

const GLASS_FILL = "rgba(8,16,32,0.42)";
const GLASS_LINE = "1px solid rgba(255,255,255,0.16)";
const GLASS_SHEEN =
  "inset 0 1px 0 rgba(255,255,255,0.22), 0 10px 28px rgba(8,16,36,0.12)";
const GLASS_BLUR = "blur(18px) saturate(1.45)";
const BAR_GLASS_FILL = "rgba(8,16,32,0.48)";
export const HERO_DOCK_BOTTOM_PAD = 16 * HERO_SUPERSAMPLE;
const AFTER_TYPE_TO_TARGET = 24;
const SOURCE_PAN = 8;
const SOURCE_MENU_HOLD = 12;
const SOURCE_ITEM_HOLD = 8;
const SOURCE_TO_SEND = 8;
const SEND_PAN = 8;
const END_HOLD = 18;

export const T_ZOOM_IN = 3;
export const T_ZOOM_OUT = 15;
export const T_TYPE = 16;

export type LyknHeroDesktopProps = {
  ask: string;
  preamble?: string;
  /** Frames per typed character. Lower is faster. */
  typeRate?: number;
  mode?: Mode;
  /** After typing, open the Research Sources menu and pick one option. */
  pickSource?: boolean;
};

export const lyknHeroDesktopDefaults: LyknHeroDesktopProps = {
  ask: ASK_ORGANIZE,
  mode: "chat",
};

export function fieldEndX(showSources: boolean) {
  const extra = showSources ? SOURCE_CHIP_W + 0.2 : 0;
  return TEXT_END_X - extra * rem * BAR_VISUAL_SCALE;
}

function afterTypeFrames(pickSource: boolean) {
  if (!pickSource) {
    return AFTER_TYPE_TO_TARGET + SEND_PAN + ORGANIZE_AFTER_SEND;
  }
  return (
    AFTER_TYPE_TO_TARGET +
    SOURCE_PAN +
    SOURCE_MENU_HOLD +
    SOURCE_ITEM_HOLD +
    SOURCE_TO_SEND +
    SEND_PAN +
    END_HOLD
  );
}

function deleteRate(typeRate: number) {
  return Math.max(0.55, typeRate * 0.48);
}

function preambleFrames(preamble: string | undefined, typeRate: number) {
  if (!preamble) return 0;
  return (
    preamble.length * typeRate + PREAMBLE_HOLD + preamble.length * deleteRate(typeRate)
  );
}

export function heroDesktopDuration(
  ask: string,
  preamble?: string,
  typeRate = CHARS_PER_FRAME,
  pickSource = false,
) {
  const typeEnd = T_TYPE + preambleFrames(preamble, typeRate) + ask.length * typeRate;
  return Math.round(typeEnd + afterTypeFrames(pickSource));
}

const RESEARCH_TYPE_RATE = 1.35;

export const HERO_DESKTOP_DURATION = heroDesktopDuration(ASK_ORGANIZE);
export const HERO_DESKTOP_RESEARCH_DURATION = heroDesktopDuration(
  ASK_RESEARCH,
  PREAMBLE_RESEARCH,
  RESEARCH_TYPE_RATE,
  true,
);
export const HERO_DESKTOP_RESEARCH_PROPS: LyknHeroDesktopProps = {
  ask: ASK_RESEARCH,
  preamble: PREAMBLE_RESEARCH,
  typeRate: RESEARCH_TYPE_RATE,
  mode: "research",
  pickSource: true,
};

export function typingState(
  frame: number,
  ask: string,
  preamble: string,
  typeRate: number,
) {
  const delRate = deleteRate(typeRate);
  const typeEnd = T_TYPE + preambleFrames(preamble, typeRate) + ask.length * typeRate;
  let t = frame - T_TYPE;
  if (t <= 0) return { typed: "", chars: 0, typeEnd };

  if (preamble) {
    const typeDur = preamble.length * typeRate;
    if (t < typeDur) {
      const chars = t / typeRate;
      return {
        typed: preamble.slice(0, Math.floor(chars + 1e-6)),
        chars,
        typeEnd,
      };
    }
    t -= typeDur;
    if (t < PREAMBLE_HOLD) {
      return { typed: preamble, chars: preamble.length, typeEnd };
    }
    t -= PREAMBLE_HOLD;
    const delDur = preamble.length * delRate;
    if (t < delDur) {
      const chars = Math.max(0, preamble.length - t / delRate);
      return {
        typed: preamble.slice(0, Math.floor(chars + 1e-6)),
        chars,
        typeEnd,
      };
    }
    t -= delDur;
  }

  const askDur = ask.length * typeRate;
  if (t < askDur) {
    const chars = t / typeRate;
    return {
      typed: ask.slice(0, Math.floor(chars + 1e-6)),
      chars,
      typeEnd,
    };
  }
  return { typed: ask, chars: ask.length, typeEnd };
}

export function clickPulse(frame: number, at: number, hold = 5, release = 8) {
  return interpolate(
    frame,
    [at, at + 2, at + hold, at + hold + release],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
}

function LyknIcon({
  size,
  fill = "#1a4ee2",
  filter,
}: {
  size: number;
  fill?: string;
  filter?: string;
}) {
  return (
    <svg
      viewBox={ICON_VIEWBOX}
      width={size}
      height={size}
      style={{ display: "block", filter }}
    >
      <path d={ICON_PATH} fill={fill} />
    </svg>
  );
}

function BotMark({ size, maskId }: { size: number; maskId: string }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} style={{ display: "block" }}>
      <defs>
        <mask id={maskId}>
          <circle cx="24" cy="24" r="20" fill="#fff" />
          <ellipse cx="18.5" cy="24" rx="2.9" ry="4" fill="#000" />
          <ellipse cx="29.5" cy="24" rx="2.9" ry="4" fill="#000" />
        </mask>
      </defs>
      <circle cx="24" cy="24" r="20" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}

function BrowserMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none">
      <defs>
        <linearGradient id="hero-bm-fill" x1="17.5" y1="4.5" x2="6.5" y2="19.5">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.5" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.94" />
        </linearGradient>
        <mask id="hero-bm-back">
          <rect width="24" height="24" fill="#fff" />
          <circle cx="12" cy="12" r="7.35" fill="#000" />
        </mask>
        <clipPath id="hero-bm-front">
          <rect x="-4" y="12.15" width="32" height="16" transform="rotate(-16 12 12.15)" />
        </clipPath>
      </defs>
      <g mask="url(#hero-bm-back)">
        <ellipse
          cx="12"
          cy="12.15"
          rx="10.6"
          ry="3.55"
          transform="rotate(-16 12 12.15)"
          stroke="currentColor"
          strokeWidth="1.8"
        />
      </g>
      <circle cx="12" cy="12" r="7.35" fill="url(#hero-bm-fill)" />
      <path
        d="M8.95 5.55 A 7.35 7.35 0 0 0 6.85 16.85"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <g clipPath="url(#hero-bm-front)">
        <ellipse
          cx="12"
          cy="12.15"
          rx="10.6"
          ry="3.55"
          transform="rotate(-16 12 12.15)"
          stroke="currentColor"
          strokeWidth="1.8"
        />
      </g>
      <path
        d="M16.15 6.6 16.55 7.98 17.93 8.38 16.55 8.78 16.15 10.16 15.75 8.78 14.37 8.38 15.75 7.98 Z"
        fill="currentColor"
      />
    </svg>
  );
}

function monthCells() {
  const year = NOW.getFullYear();
  const month = NOW.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function CalendarTile() {
  return (
    <div
      style={{
        width: 7.6 * rem,
        padding: `${0.75 * rem}px ${0.8 * rem}px ${0.7 * rem}px`,
        borderRadius: 1.15 * rem,
        border: "1px solid rgba(255,255,255,0.16)",
        background: "rgba(8,16,32,0.38)",
        color: "#f8fafc",
        boxSizing: "border-box",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 0.58 * rem,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#ef4444",
        }}
      >
        {NOW.toLocaleDateString("en-US", { weekday: "long" })}
      </p>
      <p
        style={{
          margin: `${0.05 * rem}px 0 0`,
          fontSize: 1.65 * rem,
          fontWeight: 650,
          letterSpacing: "-0.04em",
          lineHeight: 1.05,
        }}
      >
        {NOW.getDate()}
      </p>
      <div
        style={{
          marginTop: 0.45 * rem,
          paddingLeft: 0.45 * rem,
          borderLeft: "3px solid #3b82f6",
        }}
      >
        <p style={{ margin: 0, fontSize: 0.68 * rem, fontWeight: 600, lineHeight: 1.2 }}>
          Design review
        </p>
        <p
          style={{
            margin: 0,
            fontSize: 0.58 * rem,
            lineHeight: 1.2,
            color: "rgba(248,250,252,0.55)",
          }}
        >
          Today · 2:00 PM
        </p>
      </div>
    </div>
  );
}

function MonthTile() {
  const today = NOW.getDate();
  return (
    <div
      style={{
        width: 8.6 * rem,
        padding: `${0.65 * rem}px ${0.6 * rem}px ${0.55 * rem}px`,
        borderRadius: 1.15 * rem,
        border: "1px solid rgba(255,255,255,0.16)",
        background: "rgba(8,16,32,0.38)",
        color: "#f8fafc",
        boxSizing: "border-box",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 0.58 * rem,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#ef4444",
        }}
      >
        {NOW.toLocaleDateString("en-US", { month: "long" })}
      </p>
      <div
        style={{
          marginTop: 0.35 * rem,
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          textAlign: "center",
          fontSize: 0.5 * rem,
          fontWeight: 650,
          color: "rgba(248,250,252,0.55)",
        }}
      >
        {WEEKDAYS.map((d, i) => (
          <span key={`${d}-${i}`}>{d}</span>
        ))}
      </div>
      <div
        style={{
          marginTop: 0.15 * rem,
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
        }}
      >
        {monthCells().map((day, i) => (
          <span
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: 1.05 * rem,
              fontSize: 0.52 * rem,
              fontVariantNumeric: "tabular-nums",
              color: day === today ? "#ffffff" : "rgba(248,250,252,0.55)",
              borderRadius: 999,
              background: day === today ? "#ef4444" : "transparent",
              fontWeight: day === today ? 650 : 400,
            }}
          >
            {day ?? ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function ModePills({ mode }: { mode: Mode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 0.15 * rem,
        padding: 0.22 * rem,
        borderRadius: 999,
        border: "1px solid rgba(255,255,255,0.16)",
        background: "rgba(8,16,32,0.42)",
      }}
    >
      {MODES.map(({ id, label, Icon }) => {
        const on = id === mode;
        return (
          <span
            key={id}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 0.28 * rem,
              padding: `${0.26 * rem}px ${0.55 * rem}px`,
              borderRadius: 999,
              fontSize: 0.66 * rem,
              fontWeight: 600,
              background: on ? "rgba(248,250,252,0.92)" : "transparent",
              color: on ? "#0f172a" : "rgba(248,250,252,0.62)",
            }}
          >
            <Icon width={0.875 * rem} height={0.875 * rem} strokeWidth={2} />
            {label}
          </span>
        );
      })}
    </div>
  );
}

function SourceMenu({
  sourcePicked,
  sourceHighlight,
  itemPress,
}: {
  sourcePicked: boolean;
  sourceHighlight: number;
  itemPress: number;
}) {
  const s = BAR_VISUAL_SCALE;
  return (
    <div
      style={{
        position: "absolute",
        left:
          BAR_LEFT +
          BAR_VISUAL_W -
          (SOURCE_RIGHT_CLUSTER + SOURCE_MENU_W) * rem * s,
        top: BAR_TOP - (SOURCE_MENU_GAP + SOURCE_MENU_H) * rem * s,
        zIndex: 40,
        width: SOURCE_MENU_W * rem * s,
        boxSizing: "border-box",
        borderRadius: 14 * s,
        padding: SOURCE_MENU_PAD * rem * s,
        background: GLASS_FILL,
        border: GLASS_LINE,
        boxShadow: GLASS_SHEEN,
        backdropFilter: GLASS_BLUR,
        WebkitBackdropFilter: GLASS_BLUR,
        color: "rgba(248,250,252,0.88)",
      }}
    >
      {SOURCE_OPTIONS.map((opt, i) => {
        const on = sourcePicked
          ? opt.value === SOURCE_PICK.value
          : opt.value === "all";
        const hover = sourceHighlight === i;
        const press = hover ? itemPress : 0;
        const RowIcon = opt.Icon;
        return (
          <div
            key={opt.value}
            style={{
              display: "flex",
              width: "100%",
              alignItems: "center",
              gap: 0.5 * rem * s,
              borderRadius: 0.5 * rem * s,
              padding: `${0.375 * rem * s}px ${0.625 * rem * s}px`,
              fontSize: 0.75 * rem * s,
              fontWeight: on ? 600 : 400,
              textAlign: "left",
              color: on ? "rgba(248,250,252,0.95)" : "rgba(248,250,252,0.75)",
              background: hover ? "rgba(255,255,255,0.12)" : "transparent",
              transform: `scale(${1 - press * 0.04})`,
              boxSizing: "border-box",
            }}
          >
            <RowIcon
              width={0.875 * rem * s}
              height={0.875 * rem * s}
              strokeWidth={2}
              opacity={0.7}
              style={{ flexShrink: 0 }}
            />
            {opt.label}
          </div>
        );
      })}
    </div>
  );
}

export function ChatBar({
  typed,
  caretOn,
  sendPress,
  textShift,
  showSources,
  sourcesOpen,
  sourcePicked,
  sourcePress,
  hideSend = false,
}: {
  typed: string;
  caretOn: boolean;
  sendPress: number;
  textShift: number;
  showSources: boolean;
  sourcesOpen: boolean;
  sourcePicked: boolean;
  sourcePress: number;
  hideSend?: boolean;
}) {
  const u = rem * BAR_VISUAL_SCALE;
  const icon = 1.55 * u;
  const glyph = u;
  const sourceOpt = sourcePicked ? SOURCE_PICK : SOURCE_OPTIONS[0];
  const SourceIcon = sourceOpt.Icon;
  return (
    <div
      style={{
        position: "relative",
        overflow: "visible",
        display: "flex",
        width: "100%",
        alignItems: "center",
        gap: 0.2 * u,
        borderRadius: 999,
        padding: `${0.28 * u}px ${0.28 * u}px ${0.28 * u}px ${0.4 * u}px`,
        background: BAR_GLASS_FILL,
        border: GLASS_LINE,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)",
        boxSizing: "border-box",
        color: "rgba(248,250,252,0.88)",
      }}
    >
      <span
        style={{
          display: "flex",
          height: icon,
          flexShrink: 0,
          alignItems: "center",
          gap: 0.15 * u,
          padding: `0 ${0.25 * u}px 0 ${0.35 * u}px`,
        }}
      >
        <BotMark size={(19 / 16) * u} maskId="hero-bot-bar" />
        <ChevronDown width={0.75 * u} height={0.75 * u} opacity={0.4} />
      </span>
      <span
        style={{
          display: "grid",
          height: icon,
          width: icon,
          placeItems: "center",
          flexShrink: 0,
        }}
      >
        <Plus width={glyph} height={glyph} />
      </span>
      <div
        style={{
          minWidth: 0,
          flex: 1,
          display: "flex",
          alignItems: "center",
          fontSize: 0.72 * u,
          lineHeight: 1.3,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            transform: `translateX(${-textShift}px)`,
            whiteSpace: "nowrap",
          }}
        >
          {typed}
          <span
            style={{
              display: "inline-block",
              width: 0.08 * u,
              height: "0.92em",
              marginLeft: 0.06 * u,
              borderRadius: 1,
              background: "rgba(248,250,252,0.92)",
              opacity: caretOn ? 1 : 0,
              flexShrink: 0,
            }}
          />
        </span>
      </div>
      {showSources ? (
        <span
          style={{
            position: "relative",
            display: "inline-flex",
            height: icon,
            maxWidth: 8.25 * u,
            flexShrink: 0,
            alignItems: "center",
            gap: 0.25 * u,
            padding: `0 ${0.5 * u}px`,
            borderRadius: 999,
            fontSize: 0.68 * u,
            fontWeight: 500,
            color: sourcesOpen
              ? "rgba(248,250,252,0.9)"
              : "rgba(248,250,252,0.65)",
            background: sourcesOpen ? "rgba(255,255,255,0.15)" : "transparent",
            transform: `scale(${1 - sourcePress * 0.12})`,
            boxSizing: "border-box",
          }}
        >
          <SourceIcon
            width={0.875 * u}
            height={0.875 * u}
            strokeWidth={2}
            opacity={0.7}
            style={{ flexShrink: 0 }}
          />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sourceOpt.shortLabel}
          </span>
          <ChevronDown
            width={0.75 * u}
            height={0.75 * u}
            opacity={0.4}
            style={{ flexShrink: 0 }}
          />
        </span>
      ) : null}
      <span style={{ display: "grid", height: icon, width: icon, placeItems: "center" }}>
        <Mic width={glyph} height={glyph} />
      </span>
      <span style={{ display: "grid", height: icon, width: icon, placeItems: "center" }}>
        <AudioLines width={glyph} height={glyph} />
      </span>
      <span
        style={{
          display: "flex",
          height: icon,
          width: icon,
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 999,
          background: hideSend
            ? "rgba(255,255,255,0.08)"
            : "rgba(248,250,252,0.92)",
          color: "#0f172a",
          border: hideSend ? "1px solid rgba(255,255,255,0.16)" : undefined,
          transform: `scale(${1 - sendPress * 0.14})`,
        }}
      >
        {hideSend ? null : <ArrowUp width={glyph} height={glyph} />}
      </span>
    </div>
  );
}

export const SEND_SIZE = 1.55 * rem * BAR_VISUAL_SCALE;

export function HeroCamera({
  z,
  cx,
  cy,
  supersample = HERO_SUPERSAMPLE,
  children,
  style,
}: {
  z: number;
  cx: number;
  cy: number;
  supersample?: number;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const s = supersample;
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: HERO_DESKTOP_WIDTH * s,
        height: HERO_DESKTOP_HEIGHT * s,
        transformOrigin: "0 0",
        WebkitFontSmoothing: "antialiased",
        textRendering: "geometricPrecision",
        transform: `translate(${HERO_DESKTOP_WIDTH / 2}px, ${HERO_DESKTOP_HEIGHT / 2}px) scale(${Math.min(z, s) / s}) translate(${-cx}px, ${-cy}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function HeroDesktopShell({
  mode,
  glassBlur,
  bar,
  barOpacity = 1,
  stageChildren,
  dockInsert,
  showWidgets = true,
  showFolders = true,
  showModes = true,
}: {
  mode: Mode;
  glassBlur: number;
  bar: ReactNode;
  barOpacity?: number;
  stageChildren?: ReactNode;
  dockInsert?: { open: number; icon: ReactNode };
  showWidgets?: boolean;
  showFolders?: boolean;
  showModes?: boolean;
}) {
  const dockIcon = 1.05 * rem;
  return (
    <>
      <Img
        src={staticFile("hero-wave-blue.jpg")}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "155%",
          objectFit: "cover",
          objectPosition: "center top",
          transform: "scale(1.18)",
          transformOrigin: "center top",
          filter: `blur(${glassBlur}px)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "155%",
          background: "rgba(8, 18, 36, 0.28)",
          border: "1px solid rgba(255,255,255,0.18)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)",
          backdropFilter: `blur(${glassBlur}px) saturate(1.45)`,
          WebkitBackdropFilter: `blur(${glassBlur}px) saturate(1.45)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          overflow: "visible",
          color: "#f8fafc",
        }}
      >
        {showWidgets ? (
        <div
          style={{
            position: "absolute",
            top: "7%",
            left: "4%",
            display: "flex",
            alignItems: "stretch",
            gap: 0.5 * rem,
            transform: "scale(0.5)",
            transformOrigin: "top left",
          }}
        >
          <CalendarTile />
          <MonthTile />
        </div>
        ) : null}

        {showModes ? (
        <div
          style={{
            position: "absolute",
            top: "6%",
            left: "50%",
            zIndex: 2,
            transform: "translateX(-50%) scale(0.68)",
            transformOrigin: "top center",
          }}
        >
          <ModePills mode={mode} />
        </div>
        ) : null}

        {showFolders ? (
        <div
          style={{
            position: "absolute",
            top: "7.5%",
            right: "3.5%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 0.4 * rem,
            transform: "scale(0.78)",
            transformOrigin: "top right",
          }}
        >
          {FOLDERS.map((folder) => (
            <div
              key={folder.label}
              style={{
                display: "flex",
                width: 4.2 * rem,
                flexDirection: "column",
                alignItems: "center",
                gap: 0.12 * rem,
              }}
            >
              <span
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 2.35 * rem,
                  height: 2.35 * rem,
                  color: folder.tint === "sky" ? "#38bdf8" : "#f8fafc",
                  filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.28))",
                }}
              >
                <Folder width="100%" height="100%" strokeWidth={1} fill="currentColor" />
              </span>
              <span
                style={{
                  maxWidth: "100%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 0.58 * rem,
                  fontWeight: 600,
                  color: "#ffffff",
                  textShadow: "0 1px 8px rgba(8,16,36,0.55)",
                }}
              >
                {folder.label}
              </span>
            </div>
          ))}
        </div>
        ) : null}

        {barOpacity > 0.001 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 4,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 10%",
            opacity: barOpacity,
          }}
        >
          <div
            style={{
              width: BAR_VISUAL_W,
              overflow: "visible",
            }}
          >
            {bar}
          </div>
        </div>
        ) : null}

        {stageChildren}

        <div
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            left: 0,
            zIndex: 3,
            display: "flex",
            justifyContent: "center",
            paddingBottom: HERO_DOCK_BOTTOM_PAD,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 0.12 * rem,
              padding: `${0.22 * rem}px ${0.28 * rem}px`,
              borderRadius: 999,
              background: BAR_GLASS_FILL,
              border: GLASS_LINE,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)",
              color: "rgba(248,250,252,0.78)",
              transform: "scale(0.84)",
              transformOrigin: "bottom center",
            }}
          >
            <span
              style={{
                display: "grid",
                height: 1.65 * rem,
                width: 1.65 * rem,
                placeItems: "center",
              }}
            >
              <LyknIcon size={1.2 * rem} fill="#ffffff" />
            </span>
            {dockInsert && dockInsert.open > 0.001 ? (
              <span
                style={{
                  display: "grid",
                  height: 1.85 * rem,
                  width: dockInsert.open * 1.85 * rem,
                  placeItems: "center",
                  overflow: "hidden",
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    display: "grid",
                    placeItems: "center",
                    transform: `scale(${0.2 + dockInsert.open * 0.8})`,
                    filter: "drop-shadow(0 4px 10px rgba(37,99,235,0.45))",
                  }}
                >
                  {dockInsert.icon}
                </span>
              </span>
            ) : null}
            {[
              <BrowserMark key="browser" size={dockIcon} />,
              <BotMark key="bots" size={dockIcon} maskId="hero-bot-dock" />,
              <FolderKanban key="projects" width={dockIcon} height={dockIcon} />,
              <Folder key="vault" width={dockIcon} height={dockIcon} />,
              <CalendarDays key="calendar" width={dockIcon} height={dockIcon} />,
              <ListTodo key="todos" width={dockIcon} height={dockIcon} />,
            ].map((icon, i) => (
              <span
                key={i}
                style={{
                  display: "grid",
                  height: 1.85 * rem,
                  width: 1.85 * rem,
                  placeItems: "center",
                }}
              >
                {icon}
              </span>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export const LyknHeroDesktop: React.FC<LyknHeroDesktopProps> = ({
  ask = ASK_ORGANIZE,
  preamble = "",
  typeRate = CHARS_PER_FRAME,
  mode = "chat",
  pickSource = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };
  const showSources = mode === "research" || pickSource;
  const organize = !pickSource;
  const { typed, chars: typedChars, typeEnd: T_TYPE_END } = typingState(
    frame,
    ask,
    preamble,
    typeRate,
  );
  const T_TOSOURCE = T_TYPE_END + AFTER_TYPE_TO_TARGET;
  const T_SOURCE_CLICK = T_TOSOURCE + SOURCE_PAN;
  const T_SOURCE_HOVER = T_SOURCE_CLICK + SOURCE_MENU_HOLD;
  const T_SOURCE_PICK = T_SOURCE_HOVER + SOURCE_ITEM_HOLD;
  const T_TOSEND = pickSource
    ? T_SOURCE_PICK + SOURCE_TO_SEND
    : T_TYPE_END + AFTER_TYPE_TO_TARGET;
  const T_SEND = T_TOSEND + SEND_PAN;
  const T_SWIPE = T_SEND + ORGANIZE_SEND_HOLD;
  const T_BLANK = T_SWIPE + ORGANIZE_SWIPE;
  const fade = interpolate(frame, [0, 8], [0, 1], {
    ...clamp,
    easing: EASE_UP,
  });

  const caretOn =
    frame >= T_ZOOM_OUT &&
    frame < T_SEND &&
    (frame < T_TYPE_END || Math.floor(frame / 8) % 2 === 0);
  const sendPress = clickPulse(frame, T_SEND, 5, 8);
  const sourcePress = pickSource ? clickPulse(frame, T_SOURCE_CLICK, 5, 8) : 0;
  const itemPress = pickSource ? clickPulse(frame, T_SOURCE_PICK, 5, 8) : 0;
  const sourcesOpen =
    pickSource && frame >= T_SOURCE_CLICK && frame < T_SOURCE_PICK + 5;
  const sourcePicked = pickSource && frame >= T_SOURCE_PICK;
  const sourceHighlight =
    pickSource && sourcesOpen && frame >= T_SOURCE_HOVER
      ? SOURCE_PICK_INDEX
      : -1;

  const fieldW = fieldEndX(showSources) - TEXT_START_X;
  const typedWidth = typedChars * CHAR_W;
  const scroll = Math.max(0, typedWidth - fieldW + CHAR_W * 1.5);
  const caretX = TEXT_START_X + typedWidth - scroll;
  const zoomMix = interpolate(frame, [T_ZOOM_IN, T_ZOOM_OUT], [0, 1], {
    ...clamp,
    easing: EASE_CAM,
  });
  const zFollow = interpolate(frame, [T_ZOOM_IN, T_ZOOM_OUT], [1, ZOOM_CLOSE], {
    ...clamp,
    easing: EASE_CAM,
  });
  const viewW = HERO_WORLD_WIDTH / zFollow;
  const cxWide = HERO_WORLD_WIDTH / 2;
  const cyWide = HERO_WORLD_HEIGHT / 2;
  const cxClose = caretX - 0.16 * viewW;
  const cyClose = BAR_CY;
  const cxCaret = cxWide + (cxClose - cxWide) * zoomMix;
  const cyCaret = cyWide + (cyClose - cyWide) * zoomMix;

  let z = zFollow;
  let cx = cxCaret;
  let cy = cyCaret;
  if (pickSource && frame >= T_TYPE_END) {
    const camEase = { ...clamp, easing: EASE_CAM };
    cx = interpolate(
      frame,
      [
        T_TYPE_END,
        T_TOSOURCE,
        T_SOURCE_CLICK,
        T_SOURCE_CLICK + 4,
        T_SOURCE_HOVER,
        T_SOURCE_PICK,
        T_TOSEND,
        T_SEND,
      ],
      [
        cxCaret,
        SOURCES_CX,
        SOURCES_CX,
        MENU_CX,
        MENU_CX,
        MENU_CX,
        SEND_CX,
        SEND_CX,
      ],
      camEase,
    );
    cy = interpolate(
      frame,
      [
        T_TYPE_END,
        T_TOSOURCE,
        T_SOURCE_CLICK,
        T_SOURCE_CLICK + 4,
        T_SOURCE_HOVER,
        T_SOURCE_PICK,
        T_TOSEND,
        T_SEND,
      ],
      [
        cyCaret,
        SOURCES_CY,
        SOURCES_CY,
        MENU_OVERVIEW_CY,
        MENU_WEB_CY,
        MENU_WEB_CY,
        SEND_CY,
        SEND_CY,
      ],
      camEase,
    );
    z = interpolate(
      frame,
      [
        T_TYPE_END,
        T_TOSOURCE,
        T_SOURCE_CLICK,
        T_SOURCE_CLICK + 4,
        T_SOURCE_HOVER,
        T_SOURCE_PICK,
        T_TOSEND,
        T_SEND,
      ],
      [
        ZOOM_CLOSE,
        ZOOM_CLOSE,
        ZOOM_CLOSE,
        ZOOM_MENU,
        ZOOM_ITEM,
        ZOOM_ITEM,
        ZOOM_CLOSE,
        ZOOM_CLOSE * 1.18,
      ],
      camEase,
    );
  } else if (!pickSource) {
    const sendMix = interpolate(frame, [T_TOSEND, T_SEND], [0, 1], {
      ...clamp,
      easing: EASE_CAM,
    });
    cx = cxCaret + (SEND_CX - cxCaret) * sendMix;
    cy = cyCaret + (SEND_CY - cyCaret) * sendMix;
    z = interpolate(
      frame,
      [T_ZOOM_IN, T_ZOOM_OUT, T_TOSEND, T_SEND],
      [1, ZOOM_CLOSE, ZOOM_CLOSE, ZOOM_CLOSE * 1.18],
      { ...clamp, easing: EASE_CAM },
    );
    if (organize && frame >= T_SEND) {
      const pull = interpolate(frame, [T_SEND, T_SWIPE + ORGANIZE_SWIPE], [0, 1], {
        ...clamp,
        easing: EASE_CAM,
      });
      cx = SEND_CX + (cxWide - SEND_CX) * pull;
      cy = SEND_CY + (cyWide - SEND_CY) * pull;
      z = interpolate(pull, [0, 1], [ZOOM_CLOSE * 1.18, 1]);
    }
  }
  const glassBlur = (HERO_GLASS_BLUR_BASE * HERO_SUPERSAMPLE) / Math.max(z, 1);
  const swipe = organize
    ? interpolate(frame, [T_SWIPE, T_BLANK], [0, 1], {
        ...clamp,
        easing: EASE_CAM,
      })
    : 0;
  const wideBlur = HERO_GLASS_BLUR_BASE * HERO_SUPERSAMPLE;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0b1c33",
        fontFamily: SANS,
        WebkitFontSmoothing: "antialiased",
        overflow: "hidden",
      }}
    >
      {(swipe < 0.999) ? (
      <div style={swipeLayer(swipe, false)}>
      <HeroCamera z={z} cx={cx} cy={cy} style={{ opacity: fade }}>
      <HeroDesktopShell
        mode={mode}
        glassBlur={glassBlur}
        bar={
          <ChatBar
            typed={typed}
            caretOn={caretOn}
            sendPress={sendPress}
            textShift={scroll}
            showSources={showSources}
            sourcesOpen={sourcesOpen}
            sourcePicked={sourcePicked}
            sourcePress={sourcePress}
          />
        }
      />
      {showSources && sourcesOpen ? (
        <SourceMenu
          sourcePicked={sourcePicked}
          sourceHighlight={sourceHighlight}
          itemPress={itemPress}
        />
      ) : null}
      </HeroCamera>
      </div>
      ) : null}
      {organize && swipe > 0.001 ? (
        <div style={swipeLayer(swipe, true)}>
          <HeroCamera
            z={1}
            cx={HERO_WORLD_WIDTH / 2}
            cy={HERO_WORLD_HEIGHT / 2}
          >
            <HeroDesktopShell
              mode={mode}
              glassBlur={wideBlur}
              bar={<div />}
              barOpacity={0}
              showWidgets={false}
              showFolders={false}
              showModes={false}
              stageChildren={
                <OrganizeIcons
                  local={frame - T_BLANK}
                  fps={fps}
                  rem={rem}
                />
              }
            />
          </HeroCamera>
        </div>
      ) : null}
      {organize ? <SwipeSeam swipe={swipe} rem={rem} /> : null}
    </AbsoluteFill>
  );
};
