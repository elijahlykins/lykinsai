import WakeSynthesisTourPreview from "@/components/wake/WakeSynthesisTourPreview";

interface WakeSynthesisSubwindowProps {
  active: boolean;
  preload?: boolean;
}

export default function WakeSynthesisSubwindow({
  active,
  preload = false,
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
        <span className="lykn-wake-subwindow-title">Synthesis Layer</span>
      </div>
      <div className="lykn-wake-subwindow-body">
        {showPreview ? <WakeSynthesisTourPreview active={active} /> : null}
      </div>
    </div>
  );
}
