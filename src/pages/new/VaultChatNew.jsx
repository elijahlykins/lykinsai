import React from "react";
import { Navigate, useLocation } from "react-router-dom";

// `/vaultchat` and `/vault-chat` predate the unified Vault surface — the
// real chat panel now lives inside `VaultNew` (rendered at `/vault` by
// `VaultConnectionsShell`). Until/unless we ship a dedicated standalone
// chat URL again, route both legacy paths there so bookmarks, sidebar
// links, and onboarding deep-links don't dead-end on a placeholder.
//
// `replace` so back-button doesn't bounce the user back into the
// redirect. We preserve `search` + `hash` in case anything passes
// query state (e.g. `?prompt=…`) that VaultNew can pick up later.
export default function VaultChatNew() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: "/vault", search, hash }} replace />;
}
