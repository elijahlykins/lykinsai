/**
 * The Vault's source list.
 *
 * The Vault is the file manager; AI Drive is a place inside it, holding
 * everything LYKN saved. It sits above the Mac's own folders for the same
 * reason iCloud Drive does in Finder — a drive that isn't a physical volume,
 * listed alongside the ones that are.
 *
 * Which Mac locations exist is decided in the main process. Each is listed
 * whether or not it's synced — dimmed and marked when it isn't, because that
 * location's own page holds the switch that turns it back on.
 */

import { useCallback, useEffect, useState } from "react";
import {
  CalendarDays,
  HardDrive,
  Home,
  Monitor,
  Music,
  Image as ImageIcon,
  Film,
  Download,
  FileText,
  Folder,
  FolderKanban,
  LayoutGrid,
  ListTodo,
  Settings,
  Sparkles,
} from "lucide-react";
import { openStudioTab } from "@/lib/studioTabs";
import { useFolderDropZone } from "@/components/macdesktop/fileDrop";
import { useDropZone } from "@/lib/drag/dragEngine";
import { queueVaultMacPaths } from "@/lib/homeChatFiles";

const FAVORITE_ICONS = {
  home: Home,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: ImageIcon,
  music: Music,
  movies: Film,
  applications: LayoutGrid,
};

function bridge() {
  const b = typeof window !== "undefined" ? window.lykn : null;
  return b && b.files && typeof b.files.roots === "function" ? b : null;
}

function Section({ title, children }) {
  return (
    <div className="mb-4">
      <div className="px-1.5 pb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-black/35 dark:text-white/35">
        {title}
      </div>
      {children}
    </div>
  );
}

/**
 * A place in the source list. A real folder takes a move; AI Drive isn't on
 * disk, so dropping there uploads a copy and leaves the original alone.
 */
function Item({ icon: Icon, label, active, muted, badge, onClick, dropPath, onDropPaths }) {
  const folderDrop = useFolderDropZone(onDropPaths ? null : dropPath);
  const uploadDrop = useDropZone({
    disabled: !onDropPaths,
    accept: (payload) => payload.paths.length > 0,
    onDrop: (payload) => onDropPaths(payload.paths),
  });
  const drop = onDropPaths ? uploadDrop : folderDrop;

  return (
    <button
      ref={drop.ref}
      type="button"
      onClick={onClick}
      title={label}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.8rem] transition-colors ${
        active
          ? "bg-black/10 font-medium text-black dark:bg-white/15 dark:text-white"
          : "text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10"
      } ${muted ? "opacity-45" : ""} ${drop.hot ? "ring-2 ring-blue-400/80" : ""}`}
    >
      <Icon className="h-4 w-4 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge ? (
        <span className="shrink-0 text-[0.6rem] font-medium uppercase tracking-wide">{badge}</span>
      ) : null}
    </button>
  );
}

export default function FilesSidebar({ pane, rootPath, currentPath, onSelectDrive, onSelectPath }) {
  const [roots, setRoots] = useState(null);

  const load = useCallback(() => {
    const api = bridge();
    if (!api) return;
    api.files
      .roots()
      .then((r) => setRoots(r?.ok ? r : null))
      .catch(() => setRoots(null));
  }, []);

  useEffect(() => {
    load();
    const api = bridge();
    if (!api) return undefined;
    // Turning Local Mode on, or changing which folders are shared, changes
    // what belongs in this list.
    const offMode = api.onLocalModeChanged?.(load);
    const offSync = api.onMacSyncChanged?.(load);
    return () => {
      offMode?.();
      offSync?.();
    };
  }, [load]);

  // A location is "current" when the browser is inside it. Deepest match wins,
  // so sitting in ~/Desktop/x highlights Desktop rather than Home.
  const activePath = (() => {
    if (pane !== "files") return null;
    const candidates = [
      ...(roots?.favorites || []),
      ...(roots?.volumes || []),
      ...(roots?.synced || []),
    ]
      .map((r) => r.path)
      .filter((p) => currentPath === p || String(currentPath || "").startsWith(p + "/"));
    if (!candidates.length) return rootPath;
    return candidates.sort((a, b) => b.length - a.length)[0];
  })();

  return (
    <nav className="h-full w-48 shrink-0 overflow-y-auto border-r border-black/10 px-2.5 py-3 dark:border-white/10">
      <Section title="Favorites">
        {(roots?.favorites || []).map((fav) => (
          <Item
            key={fav.id}
            icon={FAVORITE_ICONS[fav.id] || Folder}
            label={fav.label}
            active={activePath === fav.path}
            // A folder with sync off is still listed, dimmed: its page is where
            // the switch to turn it back on lives.
            muted={fav.synced === false}
            badge={fav.synced === false ? "Off" : ""}
            onClick={() => onSelectPath(fav.path)}
            dropPath={fav.synced === false ? null : fav.path}
          />
        ))}
        {/* One more place among the rest, after the Mac's own folders rather
            than pinned above them. */}
        <Item
          icon={Sparkles}
          label="AI Drive"
          active={pane === "drive"}
          onClick={onSelectDrive}
          onDropPaths={(paths) => {
            queueVaultMacPaths(paths);
            onSelectDrive();
          }}
        />
      </Section>

      <Section title="LYKN">
        <Item
          icon={FolderKanban}
          label="Projects"
          onClick={() => openStudioTab("projects", "/projects")}
        />
        <Item
          icon={CalendarDays}
          label="Calendar"
          onClick={() => openStudioTab("calendar", "/calendar")}
        />
        <Item
          icon={ListTodo}
          label="To-dos"
          onClick={() => openStudioTab("todos", "/todos")}
        />
        <Item
          icon={Settings}
          label="Settings"
          onClick={() => openStudioTab("settings")}
        />
      </Section>

      {roots?.synced?.length ? (
        <Section title="Shared with LYKN">
          {roots.synced.map((folder) => (
            <Item
              key={folder.id}
              icon={Folder}
              label={folder.label}
              active={activePath === folder.path}
              muted={folder.synced === false}
              badge={folder.synced === false ? "Off" : ""}
              onClick={() => onSelectPath(folder.path)}
              dropPath={folder.synced === false ? null : folder.path}
            />
          ))}
        </Section>
      ) : null}

      {roots?.volumes?.length ? (
        <Section title="Locations">
          {roots.volumes.map((volume) => (
            <Item
              key={volume.id}
              icon={HardDrive}
              label={volume.label}
              active={activePath === volume.path}
              muted={volume.synced === false}
              badge={volume.synced === false ? "Off" : ""}
              onClick={() => onSelectPath(volume.path)}
              dropPath={volume.synced === false ? null : volume.path}
            />
          ))}
        </Section>
      ) : null}
    </nav>
  );
}
