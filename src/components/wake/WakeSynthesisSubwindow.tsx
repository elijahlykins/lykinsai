import WakeSynthesisTourPreview from "@/components/wake/WakeSynthesisTourPreview";
import WakePreviewFit from "@/components/wake/WakePreviewFit";

interface WakeSynthesisSubwindowProps {
  active: boolean;
  preload?: boolean;
  /** Proportionally scale the surface to fit the window on every viewport (not
      just phones), so the whole intelligence layer is visible in a fixed frame. */
  fit?: boolean;
  /** Layout width (px) before scaling. Bigger = more "zoomed out". */
  designWidth?: number;
}

export default function WakeSynthesisSubwindow({
  active,
  preload = false,
  fit = false,
  designWidth = 720,
}: WakeSynthesisSubwindowProps) {
  const showPreview = preload || active;

  return (
    <div className="lykn-wake-subwindow pointer-events-auto">
      <div className="lykn-wake-subwindow-chrome">
        <div className="lykn-wake-subwindow-dots" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <span className="lykn-wake-subwindow-title">Intelligence Layer</span>
      </div>
      <div className="lykn-wake-subwindow-body">
        {showPreview ? (
          fit ? (
            <WakePreviewFit designWidth={designWidth} always>
              <WakeSynthesisTourPreview active={active} />
            </WakePreviewFit>
          ) : (
            <WakeSynthesisTourPreview active={active} />
          )
        ) : null}
      </div>
    </div>
  );
}
