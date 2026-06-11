interface ThinkingIndicatorProps {
  /** The status text to display (already resolved by useThinkingStatus). */
  status: string;
  /** Compact variant for tight surfaces like the canvas side rail. */
  compact?: boolean;
  className?: string;
}

/**
 * "Thinking" indicator: a 3D brick spinner alongside a status label with a
 * subtle monochrome shimmer. The phrase swaps in place as it rotates (no
 * fade/crossfade) so a long wait reads as calm, alive motion.
 */
export default function ThinkingIndicator({
  status,
  compact = false,
  className = "",
}: ThinkingIndicatorProps) {
  const text = status && status.trim() ? status : "Thinking…";
  const spinnerStyle = compact ? { width: 14, height: 14 } : undefined;
  const gapClass = compact ? "gap-2" : "gap-3";

  return (
    <div className={`flex items-center ${gapClass} ${className}`} aria-live="polite">
      <div className="brick-spinner" style={spinnerStyle} />
      <span className="omnia-thinking-text">{text}</span>
    </div>
  );
}
