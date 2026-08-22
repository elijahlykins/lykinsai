import { forwardRef, useEffect, useState } from "react";

// Shared open/close motion for Studio surfaces — floating windows, stage
// apps, chat, dock popovers. Light pop from the dock, not a bounce.
export const APP_OPEN_MS = 300;
export const APP_CLOSE_MS = 180;
export const APP_EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
export const APP_EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";

export function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Mounts children in the "shut" pose for one frame, then pops them open so
 * CSS can actually transition. On close it holds the tree until the shrink
 * finishes, unless `stay` — then the children keep their state (Projects,
 * a live chat) while sitting invisible on the desktop.
 */
const StudioPop = forwardRef(function StudioPop(
  {
    open,
    stay = false,
    origin = "50% 88%",
    hit = true,
    className = "",
    style,
    children,
    ...rest
  },
  ref,
) {
  const [reduce] = useState(prefersReducedMotion);
  const [shown, setShown] = useState(() => reduce && !!open);
  const [mounted, setMounted] = useState(() => !!open || stay);

  useEffect(() => {
    if (open) {
      setMounted(true);
      if (reduce) {
        setShown(true);
        return undefined;
      }
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setShown(false);
    if (stay) return undefined;
    if (reduce) {
      setMounted(false);
      return undefined;
    }
    const t = setTimeout(() => setMounted(false), APP_CLOSE_MS);
    return () => clearTimeout(t);
  }, [open, stay, reduce]);

  if (!mounted) return null;

  return (
    <div
      ref={ref}
      {...rest}
      className={`lykn-app-pop ${shown ? "is-open" : ""} ${
        hit ? "lykn-app-pop-hit" : ""
      } ${className}`}
      style={{ transformOrigin: origin, ...style }}
      aria-hidden={!shown}
    >
      {children}
    </div>
  );
});

StudioPop.displayName = "StudioPop";

export default StudioPop;
