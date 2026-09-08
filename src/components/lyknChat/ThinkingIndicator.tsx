import { useEffect, useRef, useState } from "react";
import {
  Circle,
  Code,
  FileText,
  Film,
  Folder,
  Globe,
  Image,
  LayoutTemplate,
  Lightbulb,
  Plug,
  Search,
} from "lucide-react";
import BotAvatar from "@/components/bots/BotAvatar";
import { classifyStatusLine, isTrailWorthyStatus, useThinkingStatus, useThinkingTrail } from "@/hooks/useThinkingStatus";
import { botSeed } from "@/lib/bots/botStore";
import {
  collapseThinkingSteps,
  thinkingHeaderLabel,
  type ThinkingActivityKind,
} from "@/lib/lyknChat/thinkingActivity";
import LyknOutlineSpinner from "./LyknOutlineSpinner";

export type ThinkingBotFace = {
  id?: string;
  face: string;
  eyes: string;
  color: string;
  seed?: number;
};

interface ThinkingIndicatorProps {
  /** Live status. Generic "Thinking…" / "Building…" rotate; specific lines show as-is. */
  status: string;
  /** When set, the live mark is this Bot doing its move — not the LYKN outline. */
  bot?: ThinkingBotFace | null;
  /** Compact variant for tight surfaces like the canvas side rail. */
  compact?: boolean;
  /**
   * 'brand' (default) draws the mark in LYKN blue on light backgrounds.
   * 'inherit' keeps the surrounding text color — for surfaces that are dark in
   * both themes, where the blue would sink into the glass.
   */
  tone?: "brand" | "inherit";
  /**
   * The run is parked on the user, not inferencing. Stops both the mark and the
   * label shimmer so the row reads as "your turn" rather than "hold on".
   */
  paused?: boolean;
  className?: string;
  /** Earlier activity lines. Generic think/build rotation is never stacked. */
  trail?: string[];
}

const STEP_ICONS: Record<ThinkingActivityKind, typeof Search> = {
  search: Search,
  read: Globe,
  research: Lightbulb,
  build: LayoutTemplate,
  image: Image,
  write: FileText,
  code: Code,
  files: Folder,
  video: Film,
  connect: Plug,
  other: Circle,
};

function StepIcon({ kind, size }: { kind: ThinkingActivityKind; size: number }) {
  const Icon = STEP_ICONS[kind] || Search;
  return <Icon size={size} strokeWidth={1.75} aria-hidden className="lykn-thinking__glyph" />;
}

function useElapsedSeconds(running: boolean) {
  const [seconds, setSeconds] = useState(0);
  const originRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) {
      originRef.current = null;
      setSeconds(0);
      return;
    }
    if (originRef.current == null) originRef.current = Date.now();
    const tick = () => {
      if (originRef.current == null) return;
      setSeconds(Math.floor((Date.now() - originRef.current) / 1000));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [running]);

  return seconds;
}

/**
 * LYKN (or a Bot) thinks at the top. Real work appears underneath as a
 * connected activity log — same language in chat, Build, Imagine, Research,
 * and Bot turns.
 */
export default function ThinkingIndicator({
  status,
  bot = null,
  compact = false,
  tone = "brand",
  paused = false,
  className = "",
  trail,
}: ThinkingIndicatorProps) {
  const classification = classifyStatusLine(status);
  const rotate =
    !paused &&
    (classification === "empty" ||
      classification === "generic-think" ||
      classification === "generic-build");
  const rotated = useThinkingStatus(rotate, status, classification === "generic-build");
  const text = (rotate ? rotated : status)?.trim() || "Thinking…";
  const localTrail = useThinkingTrail(status, !paused && trail == null);
  const lines = (trail ?? localTrail).filter(isTrailWorthyStatus);
  const liveStep = isTrailWorthyStatus(text) ? text : "";
  const steps = collapseThinkingSteps(lines, liveStep);
  const elapsed = useElapsedSeconds(!paused);
  const header = thinkingHeaderLabel({
    paused,
    stepCount: steps.length,
    elapsedSeconds: elapsed,
    fallback: text,
  });
  const timed = !paused && steps.length > 0;
  const mark = compact ? 16 : 24;
  const glyph = compact ? 12 : 14;
  const hasSteps = steps.length > 0;

  return (
    <div
      className={`lykn-thinking ${compact ? "lykn-thinking--compact" : ""} ${
        hasSteps ? "lykn-thinking--steps" : ""
      } ${tone === "inherit" ? "lykn-mark-inherit" : ""} ${className}`}
      aria-live="polite"
      aria-label={[header, ...steps.map((s) => s.label)].filter(Boolean).join(". ")}
    >
      <div className="lykn-thinking__row lykn-thinking__head">
        <span className="lykn-thinking__mark">
          {bot ? (
            <BotAvatar
              face={bot.face}
              eyes={bot.eyes}
              color={bot.color}
              size={mark}
              mood={paused ? "waiting" : "working"}
              seed={Number.isFinite(bot.seed) ? Number(bot.seed) : botSeed(bot.id)}
            />
          ) : (
            <LyknOutlineSpinner size={mark} paused={paused} />
          )}
        </span>
        <span
          className={`lykn-thinking__label lykn-thinking__label--head ${
            paused || timed ? "" : "lykn-chat-thinking-text"
          }`}
        >
          {header}
        </span>
      </div>
      {hasSteps ? (
        <ul className="lykn-thinking__steps" aria-label="What has been worked through">
          {steps.map((step, i) => (
            <li
              key={`${step.kind}-${i}`}
              className={`lykn-thinking__row lykn-thinking__step${
                step.live ? " lykn-thinking__step--live" : ""
              }`}
            >
              <span className="lykn-thinking__mark">
                <StepIcon kind={step.kind} size={glyph} />
              </span>
              <span className="lykn-thinking__label">{step.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}