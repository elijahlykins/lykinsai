import WakeChatTourPreview from "@/components/wake/WakeChatTourPreview";
import WakePreviewFit from "@/components/wake/WakePreviewFit";

interface WakeChatSubwindowProps {
  active: boolean;
  preload?: boolean;
}

export default function WakeChatSubwindow({
  active,
  preload = false,
}: WakeChatSubwindowProps) {
  const showPreview = preload || active;

  return (
    <div className="lykn-wake-subwindow pointer-events-auto">
      <div className="lykn-wake-subwindow-chrome">
        <div className="lykn-wake-subwindow-dots" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <span className="lykn-wake-subwindow-title">Chat</span>
      </div>
      <div className="lykn-wake-subwindow-body">
        {showPreview ? (
          <WakePreviewFit designWidth={720}>
            <WakeChatTourPreview active={active} />
          </WakePreviewFit>
        ) : null}
      </div>
    </div>
  );
}
