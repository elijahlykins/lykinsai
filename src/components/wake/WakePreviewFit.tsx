import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// Matches the phone breakpoint used by the wake walkthrough CSS
// (@media (max-width: 767px)). We scale the previews only at that width so
// desktop keeps rendering the surfaces at full size.
const WAKE_PHONE_QUERY = "(max-width: 767px)";

function useWakePhoneViewport(): boolean {
  const [isPhone, setIsPhone] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(WAKE_PHONE_QUERY);
    const update = () => setIsPhone(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return isPhone;
}

interface WakePreviewFitProps {
  /**
   * Width (in px) the children are laid out at *before* scaling. We render the
   * surface at this desktop-ish width so it uses its real multi-column / full
   * layout, then uniformly scale the whole thing down to fit the phone preview
   * window. Bigger value = more "zoomed out" / smaller elements.
   */
  designWidth: number;
  children: ReactNode;
  /**
   * Force proportional scaling on every viewport (not just phones). Used when
   * the surface is embedded in a fixed-size frame on desktop too — e.g. the
   * voice screen inside the hero phone mockup.
   */
  always?: boolean;
}

/**
 * Proportionally scales an embedded surface to fill the preview window on
 * phones. Instead of squishing the surface into a narrow frame (which just
 * shrinks things horizontally and leaves oversized chrome like the chat bar),
 * we render it at a fixed desktop width and apply a single CSS transform so
 * every element scales together — a true miniature of the real page.
 *
 * On desktop (viewport wider than the phone breakpoint) it renders children
 * untouched so the existing full-size previews are unchanged.
 */
export default function WakePreviewFit({ designWidth, children, always = false }: WakePreviewFitProps) {
  const isPhone = useWakePhoneViewport();
  const shouldFit = always || isPhone;
  const outerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    if (!shouldFit) return;
    const el = outerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setBox({ w, h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shouldFit]);

  if (!shouldFit) return <>{children}</>;

  const scale = box.w > 0 ? box.w / designWidth : 0;
  // Give the scaled content enough design-space height to fill the frame after
  // scaling (frameHeight / scale), so the surface isn't letterboxed.
  const innerHeight = scale > 0 ? box.h / scale : 0;

  return (
    <div ref={outerRef} className="lykn-wake-preview-fit">
      {scale > 0 && (
        <div
          className="lykn-wake-preview-fit-inner"
          style={{
            width: `${designWidth}px`,
            height: `${innerHeight}px`,
            transform: `scale(${scale})`,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
