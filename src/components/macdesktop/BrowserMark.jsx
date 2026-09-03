/**
 * The Browser product mark — a ringed planet with a sparkle. Drawn in
 * currentColor so it sits with the lucide glyphs around it in the dock.
 */
import { useId } from "react";

export default function BrowserMark({ className = "", ...props }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fillId = `bm-fill-${uid}`;
  const backId = `bm-back-${uid}`;
  const frontId = `bm-front-${uid}`;

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden
      {...props}
    >
      <defs>
        <linearGradient
          id={fillId}
          x1="17.5"
          y1="4.5"
          x2="6.5"
          y2="19.5"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="currentColor" stopOpacity="0.5" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.94" />
        </linearGradient>
        <mask id={backId}>
          <rect width="24" height="24" fill="#fff" />
          <circle cx="12" cy="12" r="7.35" fill="#000" />
        </mask>
        <clipPath id={frontId}>
          <rect
            x="-4"
            y="12.15"
            width="32"
            height="16"
            transform="rotate(-16 12 12.15)"
          />
        </clipPath>
      </defs>

      <g mask={`url(#${backId})`}>
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

      <circle cx="12" cy="12" r="7.35" fill={`url(#${fillId})`} />

      <path
        d="M8.95 5.55 A 7.35 7.35 0 0 0 6.85 16.85"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <g clipPath={`url(#${frontId})`}>
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
