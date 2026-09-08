import TrafficLights from "@/components/macdesktop/TrafficLights";
import { applyStudioWindowAction } from "@/components/macdesktop/studioWindowChrome";
import { NO_DRAG } from "@/components/studio/studioAppRegistry";

/**
 * Fullscreen-only traffic lights. Simple fullscreen hides the native macOS
 * cluster, including on hover, so this in-page copy appears when the pointer
 * reaches the top of the display - the same gesture as a real fullscreen app.
 * Windowed Studio keeps the native hiddenInset buttons instead. Hidden while
 * a hosted app is filling the display so its own traffic lights are the only
 * cluster in that corner.
 */
export default function StudioWindowControls({ fullscreen = true }) {
  const lykn = typeof window !== "undefined" ? window.lykn : null;
  return (
    <div className="lykn-studio-fs-traffic" style={NO_DRAG}>
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
