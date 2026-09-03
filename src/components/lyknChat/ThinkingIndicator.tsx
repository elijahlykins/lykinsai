import BotAvatar from "@/components/bots/BotAvatar";
import { classifyStatusLine, useThinkingStatus } from "@/hooks/useThinkingStatus";
import { botSeed } from "@/lib/bots/botStore";
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
  /** Earlier build thoughts shown above the live line. Plan-echo and
   *  generic think lines are never stacked here. */
  trail?: string[];
}

function priorThoughts(trail: string[] | undefined, live: string) {
  return (trail || [])
    .map((line) => String(line || "").trim())
    .filter((line) => {
      if (!line || line === live) return false;
      const kind = classifyStatusLine(line);
      return kind === "live-build";
    })
    .slice(-3);
}

/**
 * A live mark beside the working-through line. LYKN uses the outline spinner;
 * a Bot turn uses that Bot's face. Both write the current thought next to
 * the mark, with earlier thoughts faded above it.
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
  const gapClass = compact ? "gap-2" : "gap-3";
  const prior = priorThoughts(trail, text);
  const mark = compact ? 16 : 24;

  return (
    <div
      className={`flex flex-col ${compact ? "gap-1" : "gap-1.5"} ${
        tone === "inherit" ? "lykn-mark-inherit" : ""
      } ${className}`}
      aria-live="polite"
      aria-label={text}
    >
      {prior.length > 0 ? (
        <ul className="space-y-0.5 pl-0.5" aria-label="What has been worked through">
          {prior.map((line) => (
            <li
              key={line}
              className={`leading-snug ${
                compact ? "text-[11px]" : "text-[12px]"
              } ${
                tone === "inherit"
                  ? "opacity-50"
                  : "text-black/40 dark:text-white/35"
              }`}
            >
              {line.replace(/[.…]+$/g, "")}
            </li>
          ))}
        </ul>
      ) : null}
      <div className={`flex items-start ${gapClass}`}>
        <span className="mt-0.5 shrink-0 translate-x-[3px] -translate-y-[2px]">
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
          className={`min-w-0 break-words leading-snug ${
            paused ? "" : "lykn-chat-thinking-text"
          }`}
        >
          {text}
        </span>
      </div>
    </div>
  );
}
