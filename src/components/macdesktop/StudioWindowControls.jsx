import { useEffect, useState } from "react";
import TrafficLights from "@/components/macdesktop/TrafficLights";
import { applyStudioWindowAction } from "@/components/macdesktop/studioWindowChrome";
import { NO_DRAG } from "@/components/studio/studioAppRegistry";

/** Pixels read off the --lykn-display-top-inset var (camera-notch strip). */
function displayTopInset() {
  if (typeof document === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    "--lykn-display-top-inset"
  );
  const px = parseFloat(raw);
  return Number.isFinite(px) ? px : 0;
}

/**
 * Fullscreen-only traffic lights. Simple fullscreen hides the native macOS
 * cluster, including on hover, so this in-page copy appears when the pointer
 * is pushed to the very top of the display - anywhere along the edge, the
 * same gesture as a real fullscreen app - and stays while the pointer remains
 * in the top strip. Windowed Studio keeps the native hiddenInset buttons
 * instead. Hidden while a hosted app is filling the display so its own
 * traffic lights are the only cluster in that corner.
 */
export default function StudioWindowControls({ fullscreen = true }) {
  const lykn = typeof window !== "undefined" ? window.lykn : null;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onMove = (e) => {
      const inset = displayTopInset();
      // Open only at the very top edge; once open, stay until the pointer
      // leaves the cluster strip so the buttons are actually clickable.
      setOpen((o) =>
        o ? e.clientY <= inset + 56 : e.clientY <= inset + 8
      );
    };
    const onLeave = () => setOpen(false);
    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <div
      className={
        "lykn-studio-fs-traffic" + (open ? " is-open" : "")
      }
      style={NO_DRAG}
    >
      <div className="lykn-studio-fs-traffic-edge" />
      <div className="lykn-studio-fs-traffic-cluster">
        <TrafficLights
          title="LYKN Studio"
          zoomed={fullscreen}
          closeLabel="Close LYKN Studio"
          minLabel="Minimize LYKN Studio"
          zoomLabel="LYKN Studio"
          onClose={() => applyStudioWindowAction(lykn, "close")}
          onMinimize={() => applyStudioWindowAction(lykn, "minimize")}
          onZoom={() => applyStudioWindowAction(lykn, "zoom", { fullscreen })}
        />
      </div>
    </div>
  );
}
