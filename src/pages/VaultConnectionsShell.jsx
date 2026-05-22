import { useLocation } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import VaultNew from "./new/VaultNew";
import Connections from "./Connections";
import VaultAppDock from "@/components/connections/VaultAppDock";
import { useAuth } from "@/lib/SupabaseAuth";
import {
  isWalkthroughLockActive,
  PROTOTYPE_STEP_EVENT,
  readPrototypeStep,
} from "@/lib/prototypeHandoff";

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
//
// The bottom-center VaultAppDock used to live inside VaultNew, which
// meant it disappeared the moment the user toggled to /connections —
// exactly when the launcher is most useful (you're browsing apps to
// connect, you want quick access to the ones you've already wired up).
// Hoisting it to the shell renders one instance across both routes
// from a single mount. The dock's data fetch (connections + tokens)
// is the same one ConnectionsAppGrid runs, so a single shared dock
// also avoids two parallel polling loops on /connections.
//
// We hide the dock when Vault is rendered in iframe-embedded mode
// (?embedded=1) — that's the Omnia overlay use case, where the host
// page already provides chrome and a floating launcher would collide.
export default function VaultConnectionsShell() {
  const { pathname, search } = useLocation();
  const { user } = useAuth();
  const showConnections = pathname.startsWith("/connections");
  const isEmbedded = useMemo(
    () => new URLSearchParams(search).get("embedded") === "1",
    [search],
  );

  // Walkthrough lockdown mirrors the AppShell's chrome-hiding: while a
  // guest is mid-tour, the bottom dock and any other roaming chrome
  // mounted by this shell stays hidden. The cards' arrows are the
  // only forward affordance, and signing in is the only way out.
  const [walkStep, setWalkStep] = useState(() =>
    typeof window === "undefined" ? null : readPrototypeStep(),
  );
  useEffect(() => {
    const sync = () => setWalkStep(readPrototypeStep());
    window.addEventListener(PROTOTYPE_STEP_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PROTOTYPE_STEP_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const isWalkthroughLocked = isWalkthroughLockActive(user?.id ?? null, walkStep);

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
      {!isEmbedded && !isWalkthroughLocked && <VaultAppDock user={user} />}
    </>
  );
}
