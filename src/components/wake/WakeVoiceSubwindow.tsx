import WakeVoiceTourPreview from "@/components/wake/WakeVoiceTourPreview";
import WakePreviewFit from "@/components/wake/WakePreviewFit";

interface WakeVoiceSubwindowProps {
  active: boolean;
  preload?: boolean;
  /** Proportionally scale the surface to fit the window on every viewport (not
      just phones), so the whole Voice Mode UI is visible inside a fixed frame. */
  fit?: boolean;
  /** Layout width (px) before scaling. Bigger = more "zoomed out". */
  designWidth?: number;
}

export default function WakeVoiceSubwindow({
  active,
  preload = false,
  fit = false,
  designWidth = 720,
}: WakeVoiceSubwindowProps) {
  const showPreview = preload || active;

  return (
    // Forced `dark` so the preview always renders the dark Voice Mode surface
    // (white dot sphere on near-black) regardless of the visitor's app theme.
    <div className="lykn-wake-subwindow pointer-events-auto dark">
      <div className="lykn-wake-subwindow-chrome">
        <div className="lykn-wake-subwindow-dots" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <span className="lykn-wake-subwindow-title">Voice Mode</span>
      </div>
      <div className="lykn-wake-subwindow-body">
        {showPreview ? (
          <WakePreviewFit designWidth={designWidth} always={fit}>
            <WakeVoiceTourPreview active={active} />
          </WakePreviewFit>
        ) : null}
      </div>
    </div>
  );
}
