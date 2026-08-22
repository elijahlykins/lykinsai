import { useLocation } from "react-router-dom";
import { useCallback, useEffect, useMemo, useState } from "react";
import Vault from "./Vault";
import VaultAppDock from "@/components/connections/VaultAppDock";
import FilesSidebar from "@/components/macfiles/FilesSidebar";
import FilesBrowser from "@/components/macfiles/FilesBrowser";
import { useAuth } from "@/lib/SupabaseAuth";
import { useDropZone } from "@/lib/drag/dragEngine";
import { attachMacPathsToHomeChat, queueVaultMacPaths } from "@/lib/homeChatFiles";
import {
  VAULT_PICK_PATHS_EVENT,
  closeVaultPicker,
  deliverVaultPick,
  pickTargetFromParams,
} from "@/lib/vault/vaultPicker";

// Shell for the Vault — LYKN's file manager. Connections used to live here too
// (a sibling route toggled in-place), but the connect surface now lives in
// Settings → Connections.
//
// In the Studio this is a two-pane window with a Finder-style source list. AI
// Drive, everything LYKN has saved, is the first place in it; below that are
// real folders on this Mac. One window covers both, so there's no separate
// files app to switch to — picking a location in the sidebar swaps the
// right-hand pane, exactly like changing volumes in a Finder window.
//
// AI Drive stays mounted while you're off browsing the disk. It's an expensive
// surface to build, and unmounting it would refetch everything each time you
// glanced at a folder.
//
// The bottom-center VaultAppDock is hoisted here (rather than inside Vault) so
// it keeps a single mount/data-fetch. It's hidden in iframe-embedded mode
// (?embedded=1, the Omnia overlay) and in the Studio, both of which draw their
// own chrome.

function desktopBridge() {
  const b = typeof window !== "undefined" ? window.lykn : null;
  return b && b.files && typeof b.files.list === "function" ? b : null;
}

export default function VaultConnectionsShell({ studioSurface = false }) {
  const { search } = useLocation();
  const { user } = useAuth();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const isEmbedded = params.get("embedded") === "1";
  const initialOpenPath = params.get("open");
  const api = useMemo(desktopBridge, []);

  // null until we've worked out where to land — see the effect below.
  const [pane, setPane] = useState(null);
  const [rootPath, setRootPath] = useState(null);
  const [currentPath, setCurrentPath] = useState(null);

  /* AI Drive isn't a folder on disk, so a file dropped on it is uploaded and
   * the original stays where it is. The queue is what the vault's upload
   * surface is already listening to. */
  const driveDrop = useDropZone({
    disabled: pane !== "drive",
    accept: (payload) => payload.paths.length > 0,
    onDrop: (payload) => queueVaultMacPaths(payload.paths),
  });

  // Opening the Vault lands on the home folder, the way opening Finder does.
  // `?loc=/some/folder` overrides that (it's how a folder on the Home desktop
  // gets here).
  //
  // Asking for the sidebar roots rather than just the home path settles two
  // things at once: whether the disk is reachable at all, and which place to
  // land on if it isn't home. Someone who shared only ~/Projects should land
  // there, and someone with Local Mode off should land on AI Drive rather
  // than staring at a permission prompt.
  useEffect(() => {
    // No bridge to the disk — there are no folders to land on, so the vault is
    // AI Drive and nothing else.
    if (!api) {
      setPane("drive");
      return;
    }
    if (params.get("pane") === "drive") {
      setPane("drive");
      return;
    }
    const loc = params.get("loc");
    if (loc) {
      setRootPath(loc);
      setPane("files");
      return;
    }
    api
      .files.roots()
      .then((r) => {
        // Favorites now include folders whose sync is off, and landing on one of
        // those would open the Vault on a switch rather than on files.
        const places = r?.ok ? [...(r.favorites || []), ...(r.synced || [])] : [];
        const first = (places.find((p) => p.synced !== false) || places[0])?.path || null;
        if (!first) {
          setPane("drive");
          return;
        }
        setRootPath(first);
        setPane("files");
      })
      .catch(() => setPane("drive"));
  }, [api, params]);

  // AI Drive is expensive to build, so it isn't mounted until it's been asked
  // for. Once it has, it stays mounted behind the file panes so coming back to
  // it doesn't refetch everything.
  const [driveVisited, setDriveVisited] = useState(false);
  useEffect(() => {
    if (pane === "drive") setDriveVisited(true);
  }, [pane]);

  const selectPath = useCallback((next) => {
    setRootPath(next);
    setCurrentPath(next);
    setPane("files");
  }, []);

  // Who opened this as a picker, and so where a choice has to go back to. Null
  // means it was opened to browse.
  const pickTarget = useMemo(() => pickTargetFromParams(params), [params]);

  // Projects pick saved items, which are AI Drive rows rather than files on
  // disk, so the disk browser stays in plain browsing mode for them.
  const pickPathsEnabled = pickTarget === "home" || pickTarget === "thread";

  /**
   * A pick from a real folder on the Mac. AI Drive items go back as vault
   * payloads; these are paths, so they take the same route "Ask LYKN about
   * this" uses and land as the chips a drag onto the bar leaves. Either way
   * the window steps aside afterwards, leaving the attachment and a place to
   * type.
   */
  const pickPathsForChat = useCallback(
    (paths) => {
      if (pickTarget === "thread") {
        deliverVaultPick(VAULT_PICK_PATHS_EVENT, { paths });
      } else {
        attachMacPathsToHomeChat(paths);
      }
      closeVaultPicker();
    },
    [pickTarget],
  );

  // One shape everywhere. The Vault used to fall back to a masonry page of
  // everything the user owned whenever this wasn't the Studio or the disk
  // wasn't reachable, which is how a picker opened from a chat or a project
  // still showed the surface the Finder replaced. Without a disk there is
  // simply nothing under AI Drive in the source list.
  return (
    <>
      <div className="flex h-full min-h-0 w-full">
        <FilesSidebar
          pane={pane}
          rootPath={rootPath}
          currentPath={currentPath}
          onSelectDrive={() => setPane("drive")}
          onSelectPath={selectPath}
        />
        <div
          ref={driveDrop.ref}
          className="relative min-w-0 flex-1"
          data-vault-drop-scope={pane === "drive" ? "active" : "inactive"}
        >
          {driveDrop.hot && (
            <div className="pointer-events-none absolute inset-1 z-[100] flex items-center justify-center rounded-xl border-2 border-dashed border-blue-500 bg-blue-500/15">
              <span className="rounded-full bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-lg">
                Add to AI Drive
              </span>
            </div>
          )}
          {driveVisited && (
            <div className={pane === "drive" ? "h-full min-h-0" : "hidden"}>
              <Vault studioSurface pickTarget={pickTarget} />
            </div>
          )}
          {pane === "files" && rootPath && (
            <FilesBrowser
              key={rootPath}
              initialPath={rootPath}
              initialOpenPath={initialOpenPath}
              onLocationChange={setCurrentPath}
              pickMode={pickPathsEnabled}
              onPick={pickPathsForChat}
              onPickCancel={closeVaultPicker}
            />
          )}
        </div>
      </div>
      {!isEmbedded && !studioSurface && <VaultAppDock user={user} />}
    </>
  );
}
