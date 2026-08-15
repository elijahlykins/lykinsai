import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Link2,
  MessageCircle,
  Music,
  RefreshCw,
  Video,
} from "lucide-react";

/**
 * Mac Files — browse the folders the user synced with LYKN (Sync with Mac).
 * Files stay on disk: rows open natively, reveal in Finder, or hand the file
 * to LYKN AI (which reads it through the Local Mode tools).
 */

const ASK_STORAGE_KEY = "lykn_pending_local_file_ask";

function bridge() {
  const b = typeof window !== "undefined" ? window.lykn : null;
  return b && typeof b.macFsList === "function" ? b : null;
}

function shortenHome(p) {
  return String(p || "").replace(/^\/Users\/[^/]+/, "~");
}

function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDate(ms) {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

const EXT_ICONS = [
  [/^(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)$/i, ImageIcon],
  [/^(mp4|mov|webm|m4v|mkv)$/i, Video],
  [/^(mp3|wav|m4a|ogg|flac|aiff?)$/i, Music],
  [/^(txt|md|pdf|doc|docx|rtf|pages|csv|json)$/i, FileText],
];

function iconFor(entry) {
  if (entry.type === "dir") return Folder;
  if (entry.type === "symlink") return Link2;
  const ext = entry.name.split(".").pop() || "";
  for (const [re, Icon] of EXT_ICONS) if (re.test(ext)) return Icon;
  return File;
}

export default function MacFilesBrowser() {
  const api = useMemo(() => bridge(), []);
  const [searchParams] = useSearchParams();
  const requestedPath = searchParams.get("path") || "";
  const [sync, setSync] = useState(null); // { enabled, syncAll, syncedFolders }
  const [currentPath, setCurrentPath] = useState(null); // null = roots view
  const [listing, setListing] = useState({ entries: [], truncated: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refreshSync = useCallback(() => {
    if (!api) return;
    api
      .macSyncGet()
      .then((r) => {
        if (r?.ok) {
          setSync({
            enabled: r.enabled === true,
            syncAll: r.syncAll !== false,
            syncedFolders: r.syncedFolders || [],
          });
        }
      })
      .catch(() => {});
  }, [api]);

  useEffect(() => {
    refreshSync();
    if (!api) return;
    const offs = [
      api.onMacSyncChanged?.(() => refreshSync()),
      api.onLocalModeChanged?.(() => refreshSync()),
    ];
    return () => offs.forEach((off) => off?.());
  }, [api, refreshSync]);

  const loadDir = useCallback(
    async (path) => {
      if (!api) return;
      setLoading(true);
      setError("");
      try {
        const r = await api.macFsList(path);
        if (r?.ok) {
          setCurrentPath(r.path);
          setListing({ entries: r.entries || [], truncated: !!r.truncated });
        } else {
          setError(r?.error === "local_mode_off" ? "Local mode is off." : r?.error || "Could not open folder");
        }
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  // Roots: sync-all browses from home; folder picks land on the roots view
  // (or straight into the folder when there's only one). ?path= wins — that's
  // how a folder on the Home desktop opens here.
  useEffect(() => {
    if (!sync?.enabled) return;
    if (currentPath !== null) return;
    if (requestedPath) void loadDir(requestedPath);
    else if (sync.syncAll) void loadDir("~");
    else if (sync.syncedFolders.length === 1) void loadDir(sync.syncedFolders[0]);
  }, [sync, currentPath, loadDir, requestedPath]);

  const askAi = (fullPath) => {
    const prompt = `Read "${shortenHome(fullPath)}" on my Mac and give me a quick summary of what's in it.`;
    try {
      sessionStorage.setItem(ASK_STORAGE_KEY, prompt);
    } catch {
      /* chat falls back to the event payload */
    }
    window.dispatchEvent(new CustomEvent("lykn-local-file-ask", { detail: { text: prompt } }));
    window.dispatchEvent(new CustomEvent("lykn-studio-open-chat"));
  };

  const enableSyncAll = async () => {
    if (!api) return;
    try {
      await api.macSyncSet({ syncAll: true, syncedFolders: [] });
      await api.localModeSet(true);
    } catch {
      /* state broadcast refreshes the card */
    }
  };

  const chooseFolders = async () => {
    if (!api) return;
    try {
      const res = await api.macSyncPickFolder();
      if (!res?.ok || !res.folders?.length) return;
      const existing = sync?.syncedFolders || [];
      const merged = [...existing];
      for (const f of res.folders) if (!merged.includes(f)) merged.push(f);
      await api.macSyncSet({ syncAll: false, syncedFolders: merged });
      await api.localModeSet(true);
    } catch {
      /* state broadcast refreshes the card */
    }
  };

  if (!api) {
    return (
      <div className="flex h-full min-h-[60vh] w-full flex-col items-center justify-center gap-3 text-black/45 dark:text-white/45">
        <HardDrive className="h-9 w-9" />
        <p className="max-w-sm text-center text-sm">
          Mac Files is available in the LYKN desktop app.
        </p>
      </div>
    );
  }

  // Setup card — Local Mode off or nothing synced yet.
  const needsSetup = !sync?.enabled || (!sync.syncAll && sync.syncedFolders.length === 0);
  if (needsSetup) {
    return (
      <div className="flex h-full min-h-[60vh] w-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-3xl border border-black/10 bg-white/70 p-8 text-center shadow-xl backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.06]">
          <FolderOpen className="mx-auto mb-4 h-10 w-10 text-black/60 dark:text-white/70" />
          <h2 className="mb-2 text-lg font-semibold text-black/90 dark:text-white/95">
            Sync LYKN with your Mac
          </h2>
          <p className="mb-6 text-sm text-black/55 dark:text-white/60">
            Pick the folders LYKN can see. Files never leave your Mac &mdash;
            they open right here, and LYKN AI can read them when you ask.
          </p>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void chooseFolders()}
              className="rounded-xl bg-black px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 dark:bg-white dark:text-black"
            >
              Choose folders…
            </button>
            <button
              type="button"
              onClick={() => void enableSyncAll()}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-black/70 transition-colors hover:bg-black/[0.05] dark:text-white/75 dark:hover:bg-white/[0.08]"
            >
              Sync everything (home folder)
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Roots view — multiple synced folders, none opened yet.
  if (currentPath === null) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <h2 className="mb-4 text-lg font-semibold text-black/90 dark:text-white/95">Synced folders</h2>
        <div className="space-y-1.5">
          {sync.syncedFolders.map((folder) => (
            <button
              key={folder}
              type="button"
              onClick={() => void loadDir(folder)}
              className="flex w-full items-center gap-3 rounded-2xl border border-black/10 bg-white/60 px-4 py-3 text-left transition-colors hover:bg-white/85 dark:border-white/10 dark:bg-white/[0.06] dark:hover:bg-white/[0.1]"
            >
              <Folder className="h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-black/85 dark:text-white/90">
                  {folder.split("/").filter(Boolean).pop()}
                </span>
                <span className="block truncate text-xs text-black/45 dark:text-white/45">
                  {shortenHome(folder)}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-black/35 dark:text-white/35" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Directory view.
  const roots = sync.syncAll ? [] : sync.syncedFolders;
  const atRoot = sync.syncAll
    ? /^\/Users\/[^/]+$/.test(currentPath)
    : roots.includes(currentPath);
  const goUp = () => {
    if (atRoot) {
      if (!sync.syncAll && roots.length > 1) setCurrentPath(null);
      return;
    }
    void loadDir(currentPath.split("/").slice(0, -1).join("/") || "/");
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col p-6">
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={goUp}
          disabled={atRoot && (sync.syncAll || roots.length <= 1)}
          className="rounded-lg px-2 py-1 text-sm font-medium text-black/60 transition-colors hover:bg-black/[0.06] disabled:opacity-30 dark:text-white/65 dark:hover:bg-white/[0.08]"
        >
          &larr; Back
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-black/75 dark:text-white/80">
          {shortenHome(currentPath)}
        </span>
        <button
          type="button"
          onClick={() => void loadDir(currentPath)}
          title="Refresh"
          aria-label="Refresh"
          className="rounded-lg p-1.5 text-black/50 transition-colors hover:bg-black/[0.06] dark:text-white/55 dark:hover:bg-white/[0.08]"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <p className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-black/10 bg-white/55 dark:border-white/10 dark:bg-white/[0.04]">
        {listing.entries.map((entry) => {
          const Icon = iconFor(entry);
          const full = `${currentPath.replace(/\/$/, "")}/${entry.name}`;
          const isDir = entry.type === "dir";
          return (
            <div
              key={entry.name}
              className="group flex items-center gap-3 border-b border-black/[0.04] px-4 py-2 last:border-b-0 hover:bg-black/[0.03] dark:border-white/[0.05] dark:hover:bg-white/[0.05]"
            >
              <button
                type="button"
                onClick={() => (isDir ? void loadDir(full) : void api.macFsOpen(full))}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                title={isDir ? `Open ${entry.name}` : `Open ${entry.name} in its app`}
              >
                <Icon
                  className={`h-[1.1rem] w-[1.1rem] shrink-0 ${
                    isDir ? "text-sky-600 dark:text-sky-400" : "text-black/50 dark:text-white/55"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate text-[0.85rem] text-black/85 dark:text-white/90">
                  {entry.name}
                </span>
                <span className="hidden w-16 shrink-0 text-right text-xs text-black/40 dark:text-white/40 sm:block">
                  {formatSize(entry.size)}
                </span>
                <span className="hidden w-24 shrink-0 text-right text-xs text-black/40 dark:text-white/40 md:block">
                  {formatDate(entry.modifiedAt)}
                </span>
              </button>
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                {!isDir && (
                  <button
                    type="button"
                    onClick={() => askAi(full)}
                    title="Ask LYKN AI about this file"
                    aria-label={`Ask AI about ${entry.name}`}
                    className="rounded-md p-1.5 text-black/50 transition-colors hover:bg-black/[0.07] hover:text-black/85 dark:text-white/55 dark:hover:bg-white/[0.1] dark:hover:text-white/90"
                  >
                    <MessageCircle className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void api.macFsOpen(full, { reveal: true })}
                  title="Reveal in Finder"
                  aria-label={`Reveal ${entry.name} in Finder`}
                  className="rounded-md p-1.5 text-black/50 transition-colors hover:bg-black/[0.07] hover:text-black/85 dark:text-white/55 dark:hover:bg-white/[0.1] dark:hover:text-white/90"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          );
        })}
        {!loading && !listing.entries.length && !error && (
          <p className="px-4 py-8 text-center text-sm text-black/40 dark:text-white/40">
            This folder is empty.
          </p>
        )}
        {listing.truncated && (
          <p className="px-4 py-2 text-center text-xs text-black/40 dark:text-white/40">
            Showing the first {listing.entries.length} items.
          </p>
        )}
      </div>
    </div>
  );
}
