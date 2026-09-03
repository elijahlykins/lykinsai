import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import StudioPop from "@/components/macdesktop/StudioPop";

/**
 * The Imagine preview overlay — frosted veil, centered media, pill chrome.
 * Every file, image, artifact, and download inside LYKN opens through this
 * so there's one pop, not a mix of windows, lightboxes, and floating cards.
 */

export const MEDIA_POP_PANEL =
  "border border-black/10 bg-white/80 text-black/85 shadow-none backdrop-blur-2xl " +
  "dark:border-white/12 dark:bg-black/45 dark:text-white/90";

export const MEDIA_POP_FRAME =
  "max-h-[min(68vh,720px)] w-auto max-w-[min(92vw,920px)] select-none rounded-2xl object-contain shadow-none ring-1 ring-black/10 dark:ring-white/12";

const PILL_BTN = `flex h-9 w-9 items-center justify-center rounded-full ${MEDIA_POP_PANEL}`;

export type LyknMediaPopProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  hint?: ReactNode;
  onPrev?: () => void;
  onNext?: () => void;
  topBar?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  zIndex?: number;
};

export default function LyknMediaPop({
  open,
  onClose,
  title,
  hint,
  onPrev,
  onNext,
  topBar,
  footer,
  children,
  zIndex = 10000,
}: LyknMediaPopProps) {
  const held = useRef<ReactNode>(null);
  if (open && children) held.current = children;
  const [seen, setSeen] = useState(open);
  useEffect(() => {
    if (open) setSeen(true);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      const tag = el?.tagName;
      // Empty remarks stay focused after open — still flip images. Once the
      // user is typing an edit, left/right move the cursor instead.
      if ((tag === "TEXTAREA" || tag === "INPUT") && String(el?.value || "").length > 0) {
        return;
      }
      if (e.key === "ArrowRight") {
        if (!onNext) return;
        e.preventDefault();
        onNext();
        return;
      }
      if (!onPrev) return;
      e.preventDefault();
      onPrev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, onPrev, onNext]);

  if (typeof document === "undefined") return null;
  if (!open && !seen) return null;

  return createPortal(
    <StudioPop
      open={open}
      origin="50% 50%"
      className="fixed inset-0"
      style={{ zIndex }}
    >
      <div
        className="flex h-full flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={title || "Preview"}
        onClick={onClose}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[#e8e8e6]/95 backdrop-blur-3xl dark:bg-black/90 dark:backdrop-blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/20 dark:from-black/40 dark:via-black/20 dark:to-black/50"
        />

        <div
          className="relative z-40 flex shrink-0 items-center justify-between gap-3 overflow-visible px-4 pb-2 pt-4 pointer-events-auto sm:px-6"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex min-w-0 items-center gap-2">
            {hint ? (
              <div className={`flex min-w-0 items-center gap-2 rounded-full px-3 py-1.5 ${MEDIA_POP_PANEL}`}>
                {typeof hint === "string" ? (
                  <span className="truncate text-[11px] font-medium text-black/55 dark:text-white/60">
                    {hint}
                  </span>
                ) : (
                  hint
                )}
              </div>
            ) : title ? (
              <div className={`max-w-[min(60vw,28rem)] truncate rounded-full px-3 py-1.5 text-[11px] font-medium ${MEDIA_POP_PANEL}`}>
                {title}
              </div>
            ) : (
              <span />
            )}
          </div>
          <div className="flex items-center gap-2">
            {topBar}
            {onPrev ? (
              <button type="button" onClick={onPrev} className={PILL_BTN} title="Previous" aria-label="Previous">
                <ChevronLeft className="h-4 w-4" />
              </button>
            ) : null}
            {onNext ? (
              <button type="button" onClick={onNext} className={PILL_BTN} title="Next" aria-label="Next">
                <ChevronRight className="h-4 w-4" />
              </button>
            ) : null}
            <button type="button" onClick={onClose} className={PILL_BTN} title="Close" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div
          className="relative z-20 flex min-h-0 flex-1 flex-col items-center justify-center px-4 py-2 sm:px-8"
          onClick={(e) => e.stopPropagation()}
        >
          {open ? children : held.current}
        </div>

        {footer ? (
          <div
            className="relative z-20 mx-auto w-full max-w-2xl shrink-0 px-4 pb-5 pt-1 pointer-events-auto sm:px-6"
            onClick={(e) => e.stopPropagation()}
          >
            {footer}
          </div>
        ) : (
          <div className="relative z-20 shrink-0 pb-5" />
        )}
      </div>
    </StudioPop>,
    document.body,
  );
}

/** Thumbnail that opens the shared Imagine-style pop. */
export function ChatPopImage({
  src,
  alt,
  className,
}: {
  src?: string;
  alt?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!src) return null;
  return (
    <>
      <button type="button" className="block cursor-zoom-in" onClick={() => setOpen(true)} title="Open">
        <img src={src} alt={alt || ""} className={className} draggable={false} />
      </button>
      <LyknMediaPop open={open} onClose={() => setOpen(false)} title={alt || "Image"}>
        <img src={src} alt={alt || ""} className={MEDIA_POP_FRAME} />
      </LyknMediaPop>
    </>
  );
}
