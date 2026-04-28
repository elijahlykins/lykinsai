import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Star, ArrowRight, MousePointer2 } from "lucide-react";

/**
 * BookmarkletDialog
 *
 * Shows a draggable "Save to LYKN" bookmarklet that the user can drop onto
 * their bookmarks bar. When clicked from any page, it opens
 *   {origin}/share?url=<current URL>&title=<page title>
 * in a new tab — reusing the same `/share` receiver as the PWA share
 * target and the browser extension. No tokens, no install, no infra.
 */
export default function BookmarkletDialog({ open, onOpenChange }) {
  // Build the bookmarklet href against the current origin so it works in
  // local dev (http://localhost:5173) and in prod without configuration.
  const { href, origin } = useMemo(() => {
    if (typeof window === "undefined") {
      return { href: "#", origin: "" };
    }
    const o = window.location.origin;
    // Single-line javascript: URL. Opens a tiny popup so it doesn't take
    // over the user's current tab; falls back to a normal new tab if
    // popups are blocked.
    const code = `javascript:(function(){var u=encodeURIComponent(location.href),t=encodeURIComponent(document.title||''),w=window.open('${o}/share?url='+u+'&title='+t,'lyknSave','width=520,height=620');if(!w){location.href='${o}/share?url='+u+'&title='+t;}})();`;
    return { href: code, origin: o };
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg bg-white dark:bg-zinc-950 border border-black/10 dark:border-white/10">
        <DialogHeader>
          <DialogTitle className="text-[18px] font-semibold tracking-tight">
            Save to LYKN — Bookmarklet
          </DialogTitle>
          <DialogDescription className="text-[12.5px] leading-relaxed text-black/60 dark:text-white/60">
            Drag the button below onto your browser's bookmarks bar. Then,
            from any webpage, click it to instantly save the page to your
            Vault. No install, no extension, no permissions.
          </DialogDescription>
        </DialogHeader>

        {/* ── Drag target ─────────────────────────────────── */}
        <div className="rounded-2xl border border-dashed border-black/15 dark:border-white/15 bg-black/[0.02] dark:bg-white/[0.04] p-6 flex flex-col items-center gap-3">
          <a
            href={href}
            draggable
            onClick={(e) => {
              // Don't actually navigate when clicked inside the dialog —
              // dragging is the intent. Test runs from the button below.
              e.preventDefault();
            }}
            className="inline-flex items-center gap-2 rounded-full bg-black text-white dark:bg-white dark:text-black px-4 py-2 text-[13px] font-semibold cursor-grab active:cursor-grabbing select-none shadow-sm hover:opacity-90 transition-opacity"
            title="Drag me to your bookmarks bar"
          >
            <Star className="h-3.5 w-3.5" />
            Save to LYKN
          </a>
          <div className="flex items-center gap-1.5 text-[11px] text-black/55 dark:text-white/55">
            <MousePointer2 className="h-3 w-3" />
            Drag → bookmarks bar
          </div>
        </div>

        {/* ── How to use ───────────────────────────────────── */}
        <div className="space-y-3">
          <Step
            number={1}
            title="Show your bookmarks bar"
            body={
              <>
                Press{" "}
                <Kbd>Ctrl</Kbd>
                <span className="opacity-50"> + </span>
                <Kbd>Shift</Kbd>
                <span className="opacity-50"> + </span>
                <Kbd>B</Kbd>
                <span className="text-black/45 dark:text-white/45 ml-1">
                  (Mac:{" "}
                  <Kbd>⌘</Kbd>
                  <span className="opacity-50"> + </span>
                  <Kbd>Shift</Kbd>
                  <span className="opacity-50"> + </span>
                  <Kbd>B</Kbd>)
                </span>
              </>
            }
          />
          <Step
            number={2}
            title="Drag the button onto the bar"
            body={<>It becomes a regular bookmark labeled "Save to LYKN".</>}
          />
          <Step
            number={3}
            title="Click it from any page you want to save"
            body={
              <>
                Opens a small window that drops the page into your Vault and
                closes itself. Sign in to LYKN once at{" "}
                <code className="rounded bg-black/[0.06] dark:bg-white/[0.08] px-1 py-[1px] text-[11px]">
                  {origin}
                </code>{" "}
                in this browser and it just works after that.
              </>
            }
          />
        </div>

        {/* ── Why a bookmarklet? ───────────────────────────── */}
        <div className="rounded-xl border border-black/[0.06] dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] p-3 text-[11.5px] leading-relaxed text-black/55 dark:text-white/55">
          <span className="font-medium text-black/75 dark:text-white/85">
            Why a bookmarklet?
          </span>{" "}
          Browsers don't let any web app put a "Save" button on other sites
          like Instagram or Notion. A bookmarklet is the lightest workaround
          — no install, no permissions, no auto-updates, just a draggable
          shortcut that runs a tiny script.
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Step({ number, title, body }) {
  return (
    <div className="flex items-start gap-3">
      <div className="h-5 w-5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] text-[10px] font-semibold text-black/60 dark:text-white/70 flex items-center justify-center flex-shrink-0">
        {number}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-black/85 dark:text-white/90">
          {title}
        </div>
        <div className="mt-0.5 text-[11.5px] leading-snug text-black/55 dark:text-white/55">
          {body}
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded border border-black/15 dark:border-white/20 bg-white dark:bg-white/10 text-[10.5px] font-medium text-black/75 dark:text-white/85 align-middle">
      {children}
    </kbd>
  );
}
