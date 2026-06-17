// Lightweight loading spinner that draws the LYKN icon outline on a loop.
// This is the same stroke-draw effect as the Remotion `LyknIconOutline`
// composition, reimplemented as a self-contained SVG so it stays crisp at
// any size, follows the text color (light/dark), and costs nothing to run.
// The actual animation lives in index.css (`.lykn-outline-spinner`).

const ICON_VIEWBOX = "0 0 204.29 204.29";
const ICON_PATH =
  "M167.39,60.26l-.86-.39c-9.83-4.41-17.7-12.28-22.12-22.12l-.39-.86c-1.77-3.94-7.36-3.94-9.13,0l-.39.86c-4.41,9.83-12.28,17.71-22.12,22.12l-.86.39c-3.94,1.77-3.94,7.36,0,9.13l.86.39c9.83,4.41,17.7,12.28,22.12,22.12l.39.86c1.77,3.94,7.36,3.94,9.13,0l.39-.86c4.41-9.83,12.28-17.7,22.12-22.12l.86-.39c3.94-1.77,3.94-7.36,0-9.13ZM134.87,116.05c-14.73,2.8-17.97,18.72-32.73,18.72-8.11,0-12.75-4.81-17.72-9.61-1.8-1.73-3.56-3.5-5.29-5.29-4.8-4.98-9.62-9.61-9.62-17.73,0-14.76,15.93-18,18.72-32.73,2.66-14.03-7.74-27.55-21.99-28.38-13.8-.8-25.24,10.16-25.24,23.79,0,18.8,19.14,21.14,19.14,37.32s-19.14,18.52-19.14,37.32c0,13.16,10.67,23.83,23.83,23.83,18.8,0,21.14-19.14,37.32-19.14s18.52,19.14,37.32,19.14c13.63,0,24.58-11.44,23.78-25.24-.82-14.25-14.35-24.66-28.38-21.99Z";

interface LyknOutlineSpinnerProps {
  /** Rendered width/height in px. */
  size?: number;
  /** Stroke thickness in screen px (non-scaling). */
  strokeWidth?: number;
  className?: string;
}

export default function LyknOutlineSpinner({
  size = 24,
  strokeWidth = 1.75,
  className = "",
}: LyknOutlineSpinnerProps) {
  return (
    <svg
      className={`lykn-outline-spinner ${className}`}
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      role="img"
      aria-label="Loading"
      style={{ flexShrink: 0 }}
    >
      <path
        d={ICON_PATH}
        pathLength={1}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
