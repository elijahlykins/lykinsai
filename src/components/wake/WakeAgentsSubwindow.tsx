import ModelBuilder from "@/pages/ModelBuilder";
import WakePreviewFit from "@/components/wake/WakePreviewFit";

interface WakeAgentsSubwindowProps {
  active: boolean;
  preload?: boolean;
}

export default function WakeAgentsSubwindow({
  active,
  preload = false,
}: WakeAgentsSubwindowProps) {
  const showPreview = preload || active;

  return (
    <div className="lykn-wake-subwindow pointer-events-auto">
      <div className="lykn-wake-subwindow-chrome">
        <div className="lykn-wake-subwindow-dots" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <span className="lykn-wake-subwindow-title">Model Builder</span>
      </div>
      <div className="lykn-wake-subwindow-body">
        {showPreview ? (
          <WakePreviewFit designWidth={900}>
            <ModelBuilder wakePreview />
          </WakePreviewFit>
        ) : null}
      </div>
    </div>
  );
}
