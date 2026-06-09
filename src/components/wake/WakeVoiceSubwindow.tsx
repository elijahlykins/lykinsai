import WakeVoiceTourPreview from "@/components/wake/WakeVoiceTourPreview";
import WakePreviewFit from "@/components/wake/WakePreviewFit";

interface WakeVoiceSubwindowProps {
  active: boolean;
  preload?: boolean;
}

export default function WakeVoiceSubwindow({
  active,
  preload = false,
}: WakeVoiceSubwindowProps) {
  const showPreview = preload || active;

  return (
    <div className="lykn-wake-subwindow pointer-events-auto">
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
          <WakePreviewFit designWidth={720}>
            <WakeVoiceTourPreview active={active} />
          </WakePreviewFit>
        ) : null}
      </div>
    </div>
  );
}
