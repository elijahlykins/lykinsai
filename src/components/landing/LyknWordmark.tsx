import type { ReactNode } from "react";

const WORDMARK_PATH =
  "M113.42,136.31h-39.19c-2.23,0-4.05-1.82-4.05-4.05V39.72c0-.45-.36-.81-.81-.81h-29.64c-.45,0-.81.36-.81.81v86.71c0,20.57,11.2,29.2,27.65,29.2h46.86c.45,0,.81-.36.81-.81v-17.69c0-.45-.36-.81-.81-.81ZM403.29,36.25c-15.94,0-26.62,7.59-32.83,15.64-1.48,1.92-2.75,1.47-2.75-.96v-11.21c0-.45-.36-.81-.81-.81h-27.94c-.45,0-.81.36-.81.81v115.09c0,.45.36.81.81.81h29.57c.45,0,.81-.36.81-.81v-62.28c0-24.75,10.56-34.37,22.16-34.37s18.66,7.86,18.66,22.14v74.51c0,.45.36.81.81.81h29.57c.45,0,.81-.36.81-.81v-79.75c0-25.52-16.91-38.81-38.08-38.81ZM285.84,84.42c-.54-.9-.4-2.28.31-3.05l37.57-41.1c.48-.52.11-1.36-.6-1.36h-26.05c-.48,0-.93.21-1.24.57l-43.12,50.89c-1.5,1.77-2.72,1.32-2.72-1v-49.65c0-.45-.36-.81-.81-.81h-29.64c-.45,0-.81.36-.81.81v115.09c0,.45.36.81.81.81h29.64c.45,0,.81-.36.81-.81v-31.5c0-1.32.73-3.19,1.61-4.16l10.7-11.72c.79-.86,1.91-.74,2.48.28l26.64,47.09c.29.51.83.82,1.41.82h34.13c.63,0,1.02-.69.7-1.23l-41.83-69.98ZM210.32,38.91h-23.32c-.61,0-1.17.34-1.45.89l-23.86,47.1c-.77,1.51-2.01,1.51-2.76-.01l-23.23-47.07c-.27-.55-.84-.91-1.46-.91h-33.97c-.62,0-1.01.66-.71,1.2l39.62,72.63v42.08c0,.45.36.81.81.81h29.64c.45,0,.81-.36.81-.81v-42.4l40.57-72.29c.3-.54-.09-1.21-.71-1.21Z";

/** Inline LYKN wordmark that inherits the surrounding text color. */
export function LyknWordmark({
  className = "",
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <svg
      className={`lx-wordmark ${className}`.trim()}
      viewBox="36 34 438 124"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": "LYKN" })}
    >
      <path d={WORDMARK_PATH} />
    </svg>
  );
}

/** Swap every "LYKN" in a string for the wordmark. */
export function markLykn(text: string): ReactNode {
  const parts = text.split("LYKN");
  if (parts.length === 1) return text;
  const nodes: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (i > 0) nodes.push(<LyknWordmark key={`wm-${i}`} />);
    if (part) nodes.push(part);
  });
  return nodes;
}
