import { useEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";

import { useAuth } from "@/lib/SupabaseAuth";
import { readEmbeddedPreviewParams } from "@/lib/embeddedPreview";
import ConnectionsAppGrid from "@/components/connections/ConnectionsAppGrid";
import CustomAgentsSection from "@/components/connections/CustomAgentsSection";
import VaultConnectionsToggle from "@/components/connections/VaultConnectionsToggle";

// Connections page is the "app store" for LYKN — one unified grid of
// every connectable thing (AI tools + input tools) with a filter
// dropdown at the top, mirroring the Vault page's toolbar. Click any
// tile to connect / manage that app.
//
// The Vault ↔ Connections toggle is rendered as fixed chrome in the
// top-right corner so it stays anchored to the same screen position
// when toggling between /vault and /connections.
export default function Connections({
  wakePreview = false,
  onWakePreviewTabChange,
} = {}) {
  const { user } = useAuth();
  const { search } = useLocation();
  const { isEmbedded: isEmbeddedMode } = useMemo(
    () => readEmbeddedPreviewParams(search),
    [search],
  );

  useEffect(() => {
    if (isEmbeddedMode) {
      document.documentElement.classList.add("embedded-transparent");
      return () => document.documentElement.classList.remove("embedded-transparent");
    }
  }, [isEmbeddedMode]);

  if (wakePreview) {
    return (
      <div className="lykn-wake-connections-live-preview h-full min-h-0 relative">
        <main className="connections-preview-shell relative z-20 mx-auto w-full h-full overflow-y-auto px-4 sm:px-6 pt-4 pb-12 scrollbar-hide">
          <ConnectionsAppGrid
            user={user}
            wakePreview
            onWakePreviewTabChange={onWakePreviewTabChange}
          />
        </main>
      </div>
    );
  }

  return (
    <>
      {!isEmbeddedMode && (
        <div className="fixed top-3 left-0 right-0 z-[70] px-3 hidden md:flex items-center justify-end pointer-events-none">
          <div className="pointer-events-auto">
            <VaultConnectionsToggle active="connections" />
          </div>
        </div>
      )}
      <main
        className="connections-preview-shell relative z-20 mx-auto w-full px-4 sm:px-6 lg:px-8 pt-16 pb-16"
        style={{ maxWidth: "1560px" }}
      >
        <ConnectionsAppGrid user={user} />
        {!isEmbeddedMode && <CustomAgentsSection user={user} />}
      </main>
    </>
  );
}
