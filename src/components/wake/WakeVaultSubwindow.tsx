import { useEffect, useState } from "react";
import VaultNew from "@/pages/new/VaultNew";
import Connections from "@/pages/Connections";
import WakePreviewFit from "@/components/wake/WakePreviewFit";

type WakeVaultPanel = "vault" | "connections";

interface WakeVaultSubwindowProps {
  active: boolean;
  preload?: boolean;
}

export default function WakeVaultSubwindow({
  active,
  preload = false,
}: WakeVaultSubwindowProps) {
  const showPreview = preload || active;
  const [panel, setPanel] = useState<WakeVaultPanel>("vault");

  useEffect(() => {
    if (!active) setPanel("vault");
  }, [active]);

  return (
    <div className="lykn-wake-subwindow pointer-events-auto">
      <div className="lykn-wake-subwindow-chrome">
        <div className="lykn-wake-subwindow-dots" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <span className="lykn-wake-subwindow-title">
          {panel === "vault" ? "Vault" : "Connections"}
        </span>
      </div>
      <div className="lykn-wake-subwindow-body">
        {showPreview && panel === "vault" ? (
          <WakePreviewFit designWidth={1000}>
            <VaultNew wakePreview onWakePreviewTabChange={setPanel} />
          </WakePreviewFit>
        ) : null}
        {showPreview && panel === "connections" ? (
          <WakePreviewFit designWidth={1000}>
            <Connections wakePreview onWakePreviewTabChange={setPanel} />
          </WakePreviewFit>
        ) : null}
      </div>
    </div>
  );
}
