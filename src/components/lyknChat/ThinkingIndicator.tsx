import LyknOutlineSpinner from "./LyknOutlineSpinner";

interface ThinkingIndicatorProps {
  /** The status text to display (already resolved by useThinkingStatus). */
  status: string;
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
}

/**
 * "Thinking" indicator: the LYKN icon outline drawing on/off in a loop
 * alongside a status label with a subtle monochrome shimmer. The phrase
 * swaps in place as it rotates (no fade/crossfade) so a long wait reads as
 * calm, alive motion.
 */
export default function ThinkingIndicator({
  status,
  compact = false,
  tone = "brand",
  paused = false,
  className = "",
}: ThinkingIndicatorProps) {
  const text = status && status.trim() ? status : "Thinking…";
  const gapClass = compact ? "gap-2" : "gap-3";

  return (
    <div
      className={`flex items-center ${gapClass} ${
        tone === "inherit" ? "lykn-mark-inherit" : ""
      } ${className}`}
      aria-live="polite"
    >
      <LyknOutlineSpinner size={compact ? 16 : 24} paused={paused} />
      <span className={paused ? "" : "lykn-chat-thinking-text"}>{text}</span>
    </div>
  );
}
