import { useEffect, useRef, useState } from "react";

/** Fires once when the element scrolls into view. */
function useSeen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.2, rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return { ref, seen };
}

const GLASS_OVERLAY_VIDEO = "/videos/lykn-glass-overlay.mp4";

/** Glass capability demo: the Remotion LyknGlassOverlay composition, rendered
    to mp4 and looped in the card once it scrolls into view. */
export function CapGlassDemo() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      v.pause();
      v.currentTime = 0;
      return;
    }
    if (seen) {
      void v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [seen]);

  return (
    <div className="gl-cap-glass" ref={ref} aria-hidden="true">
      <video
        ref={videoRef}
        className="gl-cap-video"
        src={GLASS_OVERLAY_VIDEO}
        muted
        loop
        playsInline
        preload="metadata"
        aria-label="LYKN Glass overlay appearing over a screen and answering about it"
      />
    </div>
  );
}
