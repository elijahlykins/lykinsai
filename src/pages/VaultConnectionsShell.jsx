import { useLocation } from "react-router-dom";
import { useMemo } from "react";
import Vault from "./Vault";
import VaultAppDock from "@/components/connections/VaultAppDock";
import { useAuth } from "@/lib/SupabaseAuth";

// Shell for the Vault page. Connections used to live here too (a sibling
// route toggled in-place), but the connect surface now lives in
// Settings → Connections, so this only mounts the Vault.
//
// The bottom-center VaultAppDock is hoisted here (rather than inside
// VaultNew) so it keeps a single mount/data-fetch and stays visible as
// chrome around the Vault. It launches already-connected apps; its "+"
// routes to Settings → Connections.
//
// We hide the dock when Vault is rendered in iframe-embedded mode
// (?embedded=1) — that's the Omnia overlay use case, where the host
// page already provides chrome and a floating launcher would collide.
export default function VaultConnectionsShell() {
  const { search } = useLocation();
  const { user } = useAuth();
  const isEmbedded = useMemo(
    () => new URLSearchParams(search).get("embedded") === "1",
    [search],
  );

  return (
    <>
      <Vault />
      {!isEmbedded && <VaultAppDock user={user} />}
    </>
  );
}
