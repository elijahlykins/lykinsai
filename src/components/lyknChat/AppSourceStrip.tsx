import React, { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";

/**
 * What the next message will edit.
 *
 * A chat opened from an installed app already sends that app's source with
 * every turn, but nothing on screen said so — it looked like an ordinary Build
 * chat that happened to have a preview in it, which left "add a dark mode"
 * feeling like a gamble on whether the model could see the code. Naming the
 * app and the files riding along makes the attachment visible, so a plain
 * request reads as an edit to these files rather than a new build.
 */
export type AppSourceStripState = {
  appName: string;
  paths: string[];
  loading?: boolean;
} | null;

const HOME_APP_EDIT_EVENT = "lykn-home-app-edit";
const DISMISS_APP_EDIT_EVENT = "lykn-dismiss-app-edit";

let lastHomeAppEdit: AppSourceStripState = null;

/** Chat surface → Home pill. Cached so a late-mounting bar still sees it. */
export function publishAppSourceStrip(next: AppSourceStripState): void {
  lastHomeAppEdit = next;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(HOME_APP_EDIT_EVENT, { detail: next }));
}

/** Home pill → chat surface: drop the app-edit attachment. */
export function requestDismissAppEdit(): void {
  publishAppSourceStrip(null);
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DISMISS_APP_EDIT_EVENT));
}

export function subscribeAppSourceStrip(cb: (next: AppSourceStripState) => void) {
  cb(lastHomeAppEdit);
  const on = (e: Event) => cb(((e as CustomEvent).detail as AppSourceStripState) ?? null);
  window.addEventListener(HOME_APP_EDIT_EVENT, on);
  return () => window.removeEventListener(HOME_APP_EDIT_EVENT, on);
}

export function subscribeDismissAppEdit(cb: () => void) {
  window.addEventListener(DISMISS_APP_EDIT_EVENT, cb);
  return () => window.removeEventListener(DISMISS_APP_EDIT_EVENT, cb);
}

export function useHomeAppSourceStrip(): AppSourceStripState {
  const [state, setState] = useState<AppSourceStripState>(lastHomeAppEdit);
  useEffect(() => subscribeAppSourceStrip(setState), []);
  return state;
}

const AppSourceStrip = React.memo(function AppSourceStrip({
  appName,
  paths,
  /** The source is still being read — same strip, so nothing jumps when it lands. */
  loading = false,
  /** Sit inside the composer / home pill instead of floating above it. */
  compact = false,
  onDismiss,
}: {
  appName: string;
  paths: string[];
  loading?: boolean;
  compact?: boolean;
  onDismiss?: () => void;
}) {
  if (!paths.length && !loading) return null;
  return (
    <div
      className={`lykn-app-source-strip group/app-edit flex flex-nowrap items-center gap-2 overflow-x-auto ${
        compact ? "px-2.5" : "mb-1 px-1"
      }`}
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-white">
        {loading ? (
          <Loader2 className="h-3 w-3 animate-spin text-white/70" />
        ) : null}
        {loading ? `Opening ${appName}…` : `Editing ${appName}`}
      </span>
      {paths.map((path) => (
        <span
          key={path}
          title={path}
          className="shrink-0 whitespace-nowrap font-mono text-[11px] text-white/55"
        >
          {path}
        </span>
      ))}
      {onDismiss ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDismiss();
          }}
          title="Stop editing this app"
          aria-label={`Stop editing ${appName}`}
          className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-white/45 opacity-0 transition-opacity hover:bg-white/15 hover:text-white group-hover/app-edit:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <X className="h-3 w-3" strokeWidth={2.25} />
        </button>
      ) : null}
    </div>
  );
});

export function SentAppEditChip({
  title,
  paths = [],
  kind = "app",
}: {
  title: string;
  paths?: string[];
  kind?: "app" | "artifact";
}) {
  const shown = paths.slice(0, 4);
  const extra = paths.length > shown.length ? paths.length - shown.length : 0;
  return (
    <div className="inline-flex max-w-full flex-wrap items-center justify-end gap-1.5 rounded-xl border border-black/10 bg-black/[0.04] px-2.5 py-1 dark:border-white/15 dark:bg-white/[0.06]">
      <span className="whitespace-nowrap text-[12px] font-medium text-black/80 dark:text-white/85">
        Editing {title}
      </span>
      {shown.map((path) => (
        <span
          key={path}
          title={path}
          className="max-w-[9rem] truncate font-mono text-[11px] text-black/45 dark:text-white/45"
        >
          {path}
        </span>
      ))}
      {extra ? (
        <span className="font-mono text-[11px] text-black/40 dark:text-white/40">+{extra}</span>
      ) : null}
      <span className="sr-only">
        {kind === "app" ? "Installed app source attached to this prompt" : "Build source attached to this prompt"}
      </span>
    </div>
  );
}

export default AppSourceStrip;
