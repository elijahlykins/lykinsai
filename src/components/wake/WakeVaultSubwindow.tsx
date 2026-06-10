import { useEffect, useState } from "react";
import { X } from "lucide-react";
import VaultNew from "@/pages/new/VaultNew";
import ConnectionsAppGrid from "@/components/connections/ConnectionsAppGrid";
import WakePreviewFit from "@/components/wake/WakePreviewFit";
import { useAuth } from "@/lib/SupabaseAuth";

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
  const { user } = useAuth();
  // The Vault preview's blue "Connect apps" button flips this to "connections".
  // Mirroring production (where the button routes to Settings → Connections,
  // which opens as a dialog), we keep the Vault visible and float the connection
  // selector on top as a pop-up rather than swapping the whole panel.
  const [panel, setPanel] = useState<WakeVaultPanel>("vault");

  useEffect(() => {
    if (!active) setPanel("vault");
  }, [active]);

  const showConnectModal = showPreview && panel === "connections";

  return (
    <div className="lykn-wake-subwindow pointer-events-auto">
      <div className="lykn-wake-subwindow-chrome">
        <div className="lykn-wake-subwindow-dots" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <span className="lykn-wake-subwindow-title">Vault</span>
      </div>
      <div className="lykn-wake-subwindow-body">
        {showPreview ? (
          <WakePreviewFit designWidth={640}>
            {/* The modal is rendered INSIDE the scaler so it scales with the
                preview and stays centered within the subwindow — a `fixed`
                overlay would anchor to the walkthrough's transformed carousel
                track and render shifted "sideways". */}
            <div className="relative h-full">
              <VaultNew wakePreview onWakePreviewTabChange={setPanel} />
              {showConnectModal && (
                <div className="absolute inset-0 z-[500] flex items-center justify-center p-5">
                  <div
                    className="absolute inset-0 bg-black/55 backdrop-blur-sm"
                    onClick={() => setPanel("vault")}
                  />
                  <div className="relative w-full max-w-2xl max-h-[88%] flex flex-col rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl overflow-hidden">
                    <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-white/10">
                      <h2 className="text-[15px] font-semibold text-white/90 min-w-0">Connect apps</h2>
                      <button
                        type="button"
                        onClick={() => setPanel("vault")}
                        aria-label="Close"
                        className="flex-shrink-0 p-1.5 rounded-md text-white/45 hover:text-white/80 hover:bg-white/10 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="connections-preview-shell flex-1 min-h-0 overflow-y-auto px-5 py-4 scrollbar-hide">
                      <ConnectionsAppGrid user={user} embedded />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </WakePreviewFit>
        ) : null}
      </div>
    </div>
  );
}
