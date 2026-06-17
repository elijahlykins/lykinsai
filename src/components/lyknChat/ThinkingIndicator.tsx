import LyknOutlineSpinner from "./LyknOutlineSpinner";

interface ThinkingIndicatorProps {
  /** The status text to display (already resolved by useThinkingStatus). */
  status: string;
  /** Compact variant for tight surfaces like the canvas side rail. */
  compact?: boolean;
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
  className = "",
}: ThinkingIndicatorProps) {
  const text = status && status.trim() ? status : "Thinking…";
  const gapClass = compact ? "gap-2" : "gap-3";

  return (
    <div className={`flex items-center ${gapClass} ${className}`} aria-live="polite">
      <LyknOutlineSpinner size={compact ? 16 : 24} />
      <span className="lykn-chat-thinking-text">{text}</span>
    </div>
  );
}
