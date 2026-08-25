/**
 * The Browser product mark — a static ringed planet, sized and stroked
 * like the lucide glyphs around it in the dock.
 */
export default function BrowserMark({ className = "", ...props }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      {...props}
    >
      <circle cx="12" cy="12" r="6" />
      <ellipse cx="12" cy="12" rx="10.5" ry="3.8" transform="rotate(-25 12 12)" />
    </svg>
  );
}
