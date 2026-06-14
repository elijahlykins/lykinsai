import WakeChatTourPreview from "@/components/wake/WakeChatTourPreview";
import WakePreviewFit from "@/components/wake/WakePreviewFit";

interface WakeChatSubwindowProps {
  active: boolean;
  preload?: boolean;
  /** Render the preview as a white/light surface. The model menu stays open
      (styled for light via `.lkn-chat-light`) to show the available models. */
  lightMode?: boolean;
}

export default function WakeChatSubwindow({
  active,
  preload = false,
  lightMode = false,
}: WakeChatSubwindowProps) {
  const showPreview = preload || active;

  return (
    <div className={`lykn-wake-subwindow pointer-events-auto ${lightMode ? "lkn-chat-light" : ""}`}>
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
            <WakeChatTourPreview active={active} showModelMenu lightModelMenu={lightMode} />
          </WakePreviewFit>
        ) : null}
      </div>
    </div>
  );
}
