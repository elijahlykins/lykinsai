import { useEffect, useRef, useState } from "react";
import aiDriveVault from "@/assets/ai-drive-vault.png";

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

const CAP_RESEARCH_VIDEO = "/videos/lykn-studio-demo.mp4";
// LyknStudioDemo: Research sequence starts at STUDIO_OPEN_DURATION - OVERLAP
// (120 - 24 = 96 frames @ 30fps). Skip the Studio-open lead-in.
const CAP_RESEARCH_START_SEC = 96 / 30;

/** Research capability demo: Remotion LyknStudioDemo from the Research
    handoff onward, looped once the card scrolls into view. */
export function CapResearchDemo() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      v.pause();
      v.currentTime = CAP_RESEARCH_START_SEC;
      return;
    }

    const startAtResearch = () => {
      if (v.currentTime < CAP_RESEARCH_START_SEC) {
        v.currentTime = CAP_RESEARCH_START_SEC;
      }
    };

    // Native `loop` restarts at 0 — jump back to the Research cut instead.
    const onTimeUpdate = () => {
      if (v.duration && v.currentTime >= v.duration - 0.08) {
        v.currentTime = CAP_RESEARCH_START_SEC;
      }
    };
    const onEnded = () => {
      v.currentTime = CAP_RESEARCH_START_SEC;
      void v.play().catch(() => {});
    };
    const onLoaded = () => {
      startAtResearch();
      if (seen) void v.play().catch(() => {});
    };

    v.addEventListener("loadedmetadata", onLoaded);
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("ended", onEnded);

    if (seen) {
      startAtResearch();
      void v.play().catch(() => {});
    } else {
      v.pause();
    }

    return () => {
      v.removeEventListener("loadedmetadata", onLoaded);
      v.removeEventListener("timeupdate", onTimeUpdate);
      v.removeEventListener("ended", onEnded);
    };
  }, [seen]);

  return (
    <div className="gl-cap-research" ref={ref} aria-hidden="true">
      <video
        ref={videoRef}
        className="gl-cap-video"
        src={CAP_RESEARCH_VIDEO}
        muted
        playsInline
        preload="metadata"
        aria-label="LYKN Studio Research mode building a market report"
      />
    </div>
  );
}

const CAP_BROWSER_VIDEO = "/videos/lykn-studio-browser.mp4";

/** Browser capability demo: Remotion LyknStudioBrowser mp4, looped once
    the card scrolls into view. */
export function CapBrowserDemo() {
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
    <div className="gl-cap-browser" ref={ref} aria-hidden="true">
      <video
        ref={videoRef}
        className="gl-cap-video"
        src={CAP_BROWSER_VIDEO}
        muted
        loop
        playsInline
        preload="metadata"
        aria-label="LYKN Studio Browser agent browsing and acting on the web"
      />
    </div>
  );
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

/** Drive (Vault) demo: vault collage fills the card as the visual. */
export function CapDriveDemo() {
  return (
    <div className="gl-cap-drive" aria-hidden="true">
      <img
        className="gl-cap-drive-bg"
        src={aiDriveVault}
        alt=""
        draggable={false}
      />
    </div>
  );
}
