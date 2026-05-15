import { useLocation } from "react-router-dom";
import VaultNew from "./new/VaultNew";
import Connections from "./Connections";

// Keeps both `/vault` and `/connections` mounted simultaneously so the
// in-page toggle between them feels instant. Without this, navigating
// from Vault → Connections (and back) tore down VaultNew completely —
// dropping notes/collage state and re-running every fetch.
//
// Both routes render this same component, so React Router reuses the
// instance across the path change. We just flip `display: none` on the
// non-matching child. The Vault's `fixed top-3` chrome (including its
// own copy of the toggle) belongs to the Vault subtree, so hiding the
// subtree also hides that chrome — and the Connections subtree carries
// its own fixed toggle strip, so they never collide.
export default function VaultConnectionsShell() {
  const { pathname } = useLocation();
  const showConnections = pathname.startsWith("/connections");

  return (
    <>
      <div
        style={{ display: showConnections ? "none" : "contents" }}
        aria-hidden={showConnections}
      >
        <VaultNew />
      </div>
      <div
        style={{ display: showConnections ? "contents" : "none" }}
        aria-hidden={!showConnections}
      >
        <Connections />
      </div>
    </>
  );
}
