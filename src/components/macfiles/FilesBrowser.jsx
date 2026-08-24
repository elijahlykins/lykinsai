/**
 * The Finder-equivalent half of the Vault window: browse, rearrange and edit
 * what's actually on this Mac.
 *
 * Two things are worth knowing about how it stays honest. Sorting and hidden
 * files are resolved in the main process, not here, so what you see is a real
 * directory read rather than a sorted slice of a stale cache. And the folder
 * on screen is watched, so a change made in Finder (or by any other app)
 * relists this view within a moment instead of waiting for a refresh.
 *
 * Each location — Desktop, Documents, a mounted volume — also carries its own
 * sync switch in the toolbar. Turning it off doesn't touch the files; it takes
 * the folder out of what LYKN and its AI are allowed to read, which is why the
 * folder then shows the switch instead of a listing.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronUp,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  FolderPlus,
  FolderSync,
  HardDrive,
  LayoutGrid,
  List,
  MessageCircle,
  PenLine,
  RefreshCw,
  Search,
  ClipboardPaste,
  Scissors,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { breadcrumbsFor, formatDate, formatSize, kindOf } from "./fileKinds";
import { canThumbnail, macFileUrl, previewKind } from "./preview";
import { openFileWindow } from "@/lib/files/fileWindows";
import FileThumb from "./FileThumb";
import { canDropIntoFolder, FOLDER_DWELL_MS, startFilesDrag } from "./filesDrag";
import { moveFilesInto } from "@/components/macdesktop/fileDrop";
import { useDropZone } from "@/lib/drag/dragEngine";
import { LOCAL_MODE_OFF, NOT_SYNCED, describeFilesError } from "./errors";
import {
  copyLyknFolders,
  forgetLyknFolders,
  isLyknFolder,
  relocateLyknFolders,
  rememberLyknFolder,
  transferredPairs,
  useLyknFolders,
} from "@/lib/lyknFolders";
import { setFolderSynced } from "@/lib/macSync";
import { attachMacPathsToHomeChat } from "@/lib/homeChatFiles";

const PREFS_KEY = "lykn_files_prefs";

/**
 * `position: fixed` is anchored to the Vault window, not the viewport: the
 * window's transform (and backdrop-filter) make it the containing block.
 * clientX/Y are still viewport coordinates, so using them raw drops the menu
 * a window-origin away from the click.
 */
function fixedContainingBlock(node) {
  let el = node instanceof Element ? node.parentElement : null;
  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    if (
      (style.transform && style.transform !== "none") ||
      (style.filter && style.filter !== "none") ||
      (style.backdropFilter && style.backdropFilter !== "none") ||
      (style.webkitBackdropFilter && style.webkitBackdropFilter !== "none") ||
      (style.perspective && style.perspective !== "none") ||
      (style.contain && /(paint|layout|strict)/.test(style.contain))
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

function eventToFixedPoint(event) {
  const { clientX, clientY } = event;
  const block = fixedContainingBlock(event.currentTarget);
  if (!block) return { x: clientX, y: clientY };
  const rect = block.getBoundingClientRect();
  const scaleX = rect.width / (block.offsetWidth || rect.width) || 1;
  const scaleY = rect.height / (block.offsetHeight || rect.height) || 1;
  return {
    x: (clientX - rect.left) / scaleX,
    y: (clientY - rect.top) / scaleY,
  };
}

const SORTS = [
  { id: "name", label: "Name" },
  { id: "kind", label: "Kind" },
  { id: "size", label: "Size" },
  { id: "modified", label: "Date Modified" },
  { id: "created", label: "Date Added" },
];

function bridge() {
  const b = typeof window !== "undefined" ? window.lykn : null;
  return b && b.files && typeof b.files.list === "function" ? b : null;
}

function shortenHome(p) {
  return String(p || "").replace(/^\/Users\/[^/]+/, "~");
}

function folderName(p) {
  return String(p || "").split("/").filter(Boolean).pop() || String(p || "");
}

/** The location this folder belongs to, deepest first — Desktop, not Home. */
function enclosingRoot(roots, target) {
  const places = [
    ...(roots?.favorites || []),
    ...(roots?.synced || []),
    ...(roots?.volumes || []),
  ];
  return (
    places
      .filter((r) => target === r.path || String(target || "").startsWith(r.path + "/"))
      .sort((a, b) => b.path.length - a.path.length)[0] || null
  );
}

function readPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    if (saved && typeof saved === "object") return saved;
  } catch {
    /* defaults below */
  }
  return {};
}

export default function FilesBrowser({
  initialPath,
  initialOpenPath,
  onLocationChange,
  // Chat-bar "+" → Vault: browsing is unchanged, but a click picks instead of
  // opening and the status bar becomes Cancel / Add. Every folder on the Mac
  // is reachable this way, not just AI Drive.
  pickMode = false,
  onPick,
  onPickCancel,
}) {
  const api = useMemo(() => bridge(), []);
  const prefs = useMemo(readPrefs, []);

  const [history, setHistory] = useState(() => [initialPath]);
  const [cursor, setCursor] = useState(0);
  const path = history[cursor];

  const [listing, setListing] = useState({ entries: [], total: 0, truncated: false, parent: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [view, setView] = useState(prefs.view === "list" ? "list" : "icons");
  const [sort, setSort] = useState(prefs.sort || "name");
  const [order, setOrder] = useState(prefs.order === "desc" ? "desc" : "asc");
  const [showHidden, setShowHidden] = useState(prefs.showHidden === true);
  const [sortMenu, setSortMenu] = useState(false);

  const [selected, setSelected] = useState(() => new Set());
  const [renaming, setRenaming] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(null);

  // Folders made in LYKN are drawn white here, the Mac's own stay Finder blue.
  const lyknMade = useLyknFolders();

  const surfaceRef = useRef(null);
  const lastClickedRef = useRef(null);
  const openedInitialRef = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ view, sort, order, showHidden }));
    } catch {
      /* preferences just won't persist */
    }
  }, [view, sort, order, showHidden]);

  useEffect(() => {
    onLocationChange?.(path);
  }, [path, onLocationChange]);

  const load = useCallback(
    async (target, { quiet = false } = {}) => {
      if (!api || !target) return;
      if (!quiet) setLoading(true);
      try {
        const r = await api.files.list({ path: target, sort, order, showHidden });
        if (r?.ok) {
          setListing({
            entries: r.entries || [],
            total: r.total || 0,
            truncated: !!r.truncated,
            parent: r.parent || null,
          });
          setError("");
        } else {
          setListing({ entries: [], total: 0, truncated: false, parent: null });
          setError(describeFilesError(r?.error));
        }
      } finally {
        setLoading(false);
      }
    },
    [api, sort, order, showHidden],
  );

  useEffect(() => {
    setSelected(new Set());
    setRenaming(null);
    setQuery("");
    void load(path);
  }, [path, load]);

  // The sidebar's locations, which is where per-folder sync lives: each one is a
  // place on this Mac the user can share with LYKN or keep to themselves.
  const [roots, setRoots] = useState(null);

  const loadRoots = useCallback(() => {
    if (!api) return;
    api.files
      .roots()
      .then((r) => setRoots(r?.ok ? r : null))
      .catch(() => setRoots(null));
  }, [api]);

  useEffect(() => {
    loadRoots();
  }, [loadRoots]);

  // Sync changed somewhere else — another window, or Settings. Both what the
  // toolbar switch should read and what this folder is allowed to show depend
  // on it.
  useEffect(() => {
    if (!api) return undefined;
    const relist = () => {
      loadRoots();
      void load(path);
    };
    const offMode = api.onLocalModeChanged?.(relist);
    const offSync = api.onMacSyncChanged?.(relist);
    return () => {
      offMode?.();
      offSync?.();
    };
  }, [api, loadRoots, load, path]);

  // Track the folder on screen so edits made elsewhere show up here.
  useEffect(() => {
    if (!api || !path) return undefined;
    void api.files.watch(path);
    const off = api.files.onChanged(({ path: changed }) => {
      if (changed === path) void load(path, { quiet: true });
    });
    return () => {
      off?.();
      void api.files.unwatch(path);
    };
  }, [api, path, load]);

  const navigate = useCallback(
    (to) => {
      if (!to || to === path) return;
      setHistory((h) => [...h.slice(0, cursor + 1), to]);
      setCursor((c) => c + 1);
    },
    [cursor, path],
  );

  const goBack = () => setCursor((c) => Math.max(0, c - 1));
  const goForward = () => setCursor((c) => Math.min(history.length - 1, c + 1));
  const goUp = () => navigate(listing.parent);

  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return listing.entries;
    return listing.entries.filter((e) => e.name.toLowerCase().includes(needle));
  }, [listing.entries, query]);

  const selectedPaths = useMemo(() => [...selected], [selected]);

  // Sync is switched per location, so the button belongs on a location's own
  // page rather than on every folder inside one.
  const syncRoot = useMemo(
    () =>
      [...(roots?.favorites || []), ...(roots?.synced || []), ...(roots?.volumes || [])].find(
        (r) => r.path === path,
      ) || null,
    [roots, path],
  );

  const openExternally = useCallback((entry) => void api?.macFsOpen(entry.path), [api]);

  // Quick Look opens the same floating window every other file in LYKN opens
  // into, so a document from this Mac and one LYKN made sit side by side in
  // frames that behave identically.
  const showFile = useCallback((entry) => {
    if (!entry) return;
    openFileWindow({ path: entry.path, name: entry.name, size: entry.size });
  }, []);

  const open = useCallback(
    (entry) => {
      // Packages are documents as far as the user is concerned: an .app should
      // launch, not reveal its Contents folder.
      if (entry.type === "dir" && !entry.package) {
        navigate(entry.path);
        return;
      }
      // Show it here when we can. Handing every double-click to macOS was the
      // old behaviour and it meant you never actually saw anything in LYKN.
      if (previewKind(entry)) showFile(entry);
      else openExternally(entry);
    },
    [navigate, openExternally, showFile],
  );

  // AI/deep-link opens should look exactly like a user double-click: select the
  // item, then preview it in LYKN when possible or hand it to its normal app.
  useEffect(() => {
    if (openedInitialRef.current || !initialOpenPath) return;
    const entry = listing.entries.find((item) => item.path === initialOpenPath);
    if (!entry) return;
    openedInitialRef.current = true;
    setSelected(new Set([entry.path]));
    open(entry);
  }, [initialOpenPath, listing.entries, open]);

  const cancelRename = () => setRenaming(null);

  const clickEntry = (event, entry, index) => {
    event.stopPropagation();
    const paths = entries.map((e) => e.path);
    if (event.shiftKey && lastClickedRef.current != null) {
      const [from, to] = [lastClickedRef.current, index].sort((a, b) => a - b);
      setSelected(new Set(paths.slice(from, to + 1)));
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      lastClickedRef.current = index;
      return;
    }
    setSelected(new Set([entry.path]));
    lastClickedRef.current = index;
  };

  /** Run a mutation, surface its error, and let the watcher do the relisting. */
  const mutate = useCallback(
    async (work) => {
      if (!api) return null;
      const result = await work(api.files);
      if (result && result.ok === false) {
        setError(describeFilesError(result));
      } else {
        setError("");
      }
      // fs.watch is reliable for local volumes but not for every network
      // mount, so relist rather than trusting the event to arrive.
      void load(path, { quiet: true });
      return result;
    },
    [api, load, path],
  );

  const newFolder = async () => {
    const result = await mutate((files) => files.mkdir({ path }));
    if (result?.ok && result.path) {
      rememberLyknFolder(result.path);
      // Land in rename mode on the new folder, like Finder does.
      setSelected(new Set([result.path]));
      setRenaming(result.path);
      setRenameDraft(result.name);
    }
  };

  const commitRename = async (entry) => {
    const name = renameDraft.trim();
    setRenaming(null);
    if (!name || name === entry.name) return;
    const result = await mutate((files) => files.rename({ path: entry.path, name }));
    if (result?.ok && result.path) relocateLyknFolders([[entry.path, result.path]]);
  };

  const trashSelection = async () => {
    if (!selectedPaths.length) return;
    const result = await mutate((files) => files.trash({ paths: selectedPaths }));
    forgetLyknFolders(result?.paths || []);
    setSelected(new Set());
  };

  const duplicateSelection = async () => {
    if (!selectedPaths.length) return;
    const result = await mutate((files) => files.duplicate({ paths: selectedPaths }));
    copyLyknFolders(transferredPairs(selectedPaths, result));
  };

  // Copy/cut/paste, so moving something somewhere else doesn't require holding
  // a drag across two folders. Paths only — the bytes never leave disk, and
  // the paste is the same guarded move/copy a drag would run.
  const [clipboard, setClipboard] = useState(null); // { paths, mode }

  const cutPaths = useMemo(
    () => (clipboard?.mode === "cut" ? new Set(clipboard.paths) : null),
    [clipboard],
  );

  const clip = (mode) => {
    if (!selectedPaths.length) return;
    setClipboard({ paths: selectedPaths, mode });
  };

  const paste = async (destination) => {
    if (!clipboard?.paths.length) return;
    const { paths, mode } = clipboard;
    const result = await mutate((files) =>
      mode === "cut" ? files.move({ paths, dest: destination }) : files.copy({ paths, dest: destination }),
    );
    const pairs = transferredPairs(paths, result);
    if (mode === "cut") relocateLyknFolders(pairs);
    else copyLyknFolders(pairs);
    // A cut is spent once it lands; a copy stays put so it can be pasted again.
    if (mode === "cut" && result?.ok !== false) setClipboard(null);
  };

  /**
   * Turn this location's sync on or off. Off doesn't move or hide anything on
   * disk — it's LYKN that stops being able to look.
   */
  const toggleSync = async (folder, next) => {
    if (!folder) return;
    await setFolderSynced(api, folder, next);
    loadRoots();
    void load(path);
  };

  /**
   * Hand the file to the desktop chat bar and get this window out of the way,
   * so what's left on screen is the attachment and a place to type. Nothing is
   * sent: the question is the user's to write, not ours to guess.
   */
  const askAi = (entry) => {
    if (!entry) return;
    attachMacPathsToHomeChat(selected.has(entry.path) ? selectedPaths : [entry.path]);
    window.dispatchEvent(
      new CustomEvent("lykn-studio-close-app", { detail: { id: "vault" } }),
    );
  };

  /**
   * Confirm a pick. Acting on an item outside the selection takes just that
   * one — right-clicking or double-clicking an unselected file shouldn't quietly
   * add the five things you'd selected somewhere else.
   */
  const confirmPick = (entry) => {
    const paths = entry && !selected.has(entry.path) ? [entry.path] : selectedPaths;
    if (!paths.length) return;
    onPick?.(paths);
  };

  /**
   * What a double-click means. Folders always open — that's how the user gets
   * to the folder they're after — but while picking, a file is a choice rather
   * than something to preview.
   */
  const activate = (entry) => {
    const isFolder = entry.type === "dir" && !entry.package;
    if (pickMode && !isFolder) confirmPick(entry);
    else open(entry);
  };

  const onKeyDown = (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (renaming) return;

    if (event.key === " " && !meta) {
      // Quick Look. The preview closes itself on Space, so this only opens.
      event.preventDefault();
      const entry = entries.find((e) => e.path === selectedPaths[0]);
      if (entry && entry.type !== "dir") showFile(entry);
    } else if (meta && event.key === "o") {
      event.preventDefault();
      const entry = entries.find((e) => e.path === selectedPaths[0]);
      if (entry) openExternally(entry);
    } else if (meta && event.key === "a") {
      event.preventDefault();
      setSelected(new Set(entries.map((e) => e.path)));
    } else if (meta && event.key === "c") {
      event.preventDefault();
      clip("copy");
    } else if (meta && event.key === "x") {
      event.preventDefault();
      clip("cut");
    } else if (meta && event.key === "v") {
      event.preventDefault();
      void paste(path);
    } else if (meta && event.key === "Backspace") {
      event.preventDefault();
      void trashSelection();
    } else if (meta && event.shiftKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      void newFolder();
    } else if (meta && event.key === "ArrowUp") {
      event.preventDefault();
      goUp();
    } else if (meta && event.key === "ArrowDown") {
      event.preventDefault();
      const entry = entries.find((e) => selected.has(e.path));
      if (entry) open(entry);
    } else if (meta && event.key === ".") {
      event.preventDefault();
      setShowHidden((v) => !v);
    } else if (pickMode && event.key === "Enter") {
      // Picking, so Enter confirms rather than starting a rename.
      event.preventDefault();
      confirmPick(null);
    } else if (event.key === "Enter" && selectedPaths.length === 1) {
      event.preventDefault();
      const entry = entries.find((e) => e.path === selectedPaths[0]);
      if (entry) {
        setRenaming(entry.path);
        setRenameDraft(entry.name);
      }
    } else if (event.key === "Escape") {
      // One Escape drops the selection; a second one backs out of the pick, so
      // a stray keystroke can't throw away the window you were choosing in.
      if (pickMode && !selectedPaths.length && !menu) {
        onPickCancel?.();
        return;
      }
      setSelected(new Set());
      setMenu(null);
    }
  };

  /**
   * Pick up a row. Pressing an item that isn't selected selects it first, the
   * way Finder does, so the drag carries what the user thinks they grabbed.
   * Shift and Cmd are for building a selection, not starting a drag, so they
   * fall through to the click.
   */
  const beginDrag = (event, entry) => {
    if (event.button !== 0 || renaming) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey) return;
    const paths = selected.has(entry.path) ? selectedPaths : [entry.path];
    if (!selected.has(entry.path)) setSelected(new Set([entry.path]));
    startFilesDrag(event, () => {
      const root = surfaceRef.current;
      const want = new Set(paths);
      const elements = root
        ? [...root.querySelectorAll("[data-entry-path]")].filter((el) =>
            want.has(el.getAttribute("data-entry-path")),
          )
        : [];
      return { source: "files", sourceDir: path, paths, elements };
    });
  };

  const dropInto = (payload, destination) =>
    mutate(() => moveFilesInto(payload.paths, destination, { copy: payload.copy }));

  // The folder on screen. Tiles are children, so a drop on a subfolder is
  // resolved there first and never reaches this.
  const paneDrop = useDropZone({
    accept: (payload) => canDropIntoFolder(payload, path),
    onDrop: (payload) => void dropInto(payload, path),
  });

  // --- Gates ---------------------------------------------------------------

  if (!api) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-black/45 dark:text-white/45">
        <HardDrive className="h-9 w-9" />
        <p className="max-w-sm text-center text-sm">
          Browsing your Mac needs the LYKN desktop app.
        </p>
      </div>
    );
  }

  if (error === LOCAL_MODE_OFF) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-3xl border border-black/10 bg-white/70 p-8 text-center dark:border-white/10 dark:bg-white/[0.06]">
          <FolderOpen className="mx-auto mb-4 h-10 w-10 text-black/60 dark:text-white/70" />
          <h2 className="mb-2 text-lg font-semibold">Let LYKN see your Mac</h2>
          <p className="mb-6 text-sm text-black/55 dark:text-white/60">
            Turn on Local Mode to browse your files here. They never leave this
            machine.
          </p>
          <button
            type="button"
            onClick={() => void api.localModeSet(true).then(() => load(path))}
            className="rounded-xl bg-black px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 dark:bg-white dark:text-black"
          >
            Turn on Local Mode
          </button>
        </div>
      </div>
    );
  }

  if (error === NOT_SYNCED) {
    // Whatever covers this folder is what has to come back on. Failing that,
    // the folder itself — someone sent here by a link can share it from here.
    const target = enclosingRoot(roots, path) || { label: folderName(path), path };
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-3xl border border-black/10 bg-white/70 p-8 text-center dark:border-white/10 dark:bg-white/[0.06]">
          <FolderSync className="mx-auto mb-4 h-10 w-10 text-black/60 dark:text-white/70" />
          <h2 className="mb-2 text-lg font-semibold">Sync is off for {target.label}</h2>
          <p className="mb-6 text-sm text-black/55 dark:text-white/60">
            Nothing has moved — LYKN just can&apos;t see inside {shortenHome(target.path)} while
            sync is off. Turn it back on to browse it here.
          </p>
          <button
            type="button"
            onClick={() => void toggleSync(target.path, true)}
            className="rounded-xl bg-black px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 dark:bg-white dark:text-black"
          >
            Turn on sync
          </button>
        </div>
      </div>
    );
  }

  // --- Chrome --------------------------------------------------------------

  const crumbs = breadcrumbsFor(path);
  const iconButton =
    "rounded-lg p-1.5 text-black/60 transition-colors hover:bg-black/[0.06] disabled:opacity-30 dark:text-white/60 dark:hover:bg-white/[0.08]";

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      ref={surfaceRef}
    >
      <div className="flex items-center gap-1 border-b border-black/10 px-3 py-2 dark:border-white/10">
        <button type="button" onClick={goBack} disabled={cursor === 0} className={iconButton} title="Back">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={goForward}
          disabled={cursor >= history.length - 1}
          className={iconButton}
          title="Forward"
        >
          <ArrowRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={goUp}
          disabled={!listing.parent}
          className={iconButton}
          title="Enclosing folder"
        >
          <ChevronUp className="h-4 w-4" />
        </button>

        <div className="mx-1 min-w-0 flex-1 truncate text-[0.8rem]">
          {crumbs.map((crumb, i) => (
            <span key={crumb.path}>
              {i > 0 && <span className="px-1 text-black/25 dark:text-white/25">/</span>}
              <Crumb
                crumb={crumb}
                current={i === crumbs.length - 1}
                onNavigate={navigate}
                onDropInto={dropInto}
              />
            </span>
          ))}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-black/35 dark:text-white/35" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this folder"
            className="w-44 rounded-lg border border-black/10 bg-black/[0.03] py-1 pl-7 pr-2 text-[0.75rem] outline-none placeholder:text-black/35 focus:border-black/25 dark:border-white/10 dark:bg-white/[0.05] dark:placeholder:text-white/35 dark:focus:border-white/25"
          />
        </div>

        {syncRoot && (
          <button
            type="button"
            onClick={() => void toggleSync(syncRoot.path, !syncRoot.synced)}
            title={
              syncRoot.synced
                ? `Stop syncing ${syncRoot.label} with LYKN`
                : `Sync ${syncRoot.label} with LYKN`
            }
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[0.72rem] font-medium transition-colors ${
              syncRoot.synced
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:border-emerald-400/30 dark:text-emerald-300"
                : "border-black/10 bg-black/[0.03] text-black/45 hover:bg-black/[0.07] dark:border-white/10 dark:bg-white/[0.05] dark:text-white/45 dark:hover:bg-white/[0.09]"
            }`}
          >
            <FolderSync className="h-3.5 w-3.5" />
            {syncRoot.synced ? "Sync on" : "Sync off"}
          </button>
        )}

        <button type="button" onClick={() => void newFolder()} className={iconButton} title="New folder">
          <FolderPlus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setShowHidden((v) => !v)}
          className={iconButton}
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
        >
          {showHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={() => setView((v) => (v === "icons" ? "list" : "icons"))}
          className={iconButton}
          title={view === "icons" ? "As list" : "As icons"}
        >
          {view === "icons" ? <List className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={() => setSortMenu((v) => !v)}
            className={iconButton}
            title="Sort"
          >
            <SlidersHorizontal className="h-4 w-4" />
          </button>
          {sortMenu && (
            <>
              <button
                type="button"
                aria-label="Close sort menu"
                data-no-tip
                className="fixed inset-0 z-40 cursor-default"
                onClick={() => setSortMenu(false)}
              />
              <div className="lg-menu absolute right-0 z-50 mt-1 w-44 p-1">
                {SORTS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      if (sort === option.id) setOrder((o) => (o === "asc" ? "desc" : "asc"));
                      else setSort(option.id);
                      setSortMenu(false);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[0.78rem] hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
                  >
                    {option.label}
                    {sort === option.id && <span>{order === "asc" ? "↑" : "↓"}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => void load(path)}
          className={iconButton}
          title="Refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[0.75rem] text-amber-700 dark:text-amber-300">
          {error}
        </div>
      )}

      <div
        ref={paneDrop.ref}
        className={`min-h-0 flex-1 overflow-y-auto p-3 ${
          paneDrop.hot ? "bg-blue-500/10 ring-2 ring-inset ring-blue-500/50" : ""
        }`}
        onClick={() => setSelected(new Set())}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ ...eventToFixedPoint(e), entry: null });
        }}
      >
        {entries.length === 0 && !loading ? (
          <div className="flex h-full items-center justify-center text-sm text-black/40 dark:text-white/40">
            {query ? "Nothing matches that." : "This folder is empty."}
          </div>
        ) : view === "icons" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1">
            {entries.map((entry, index) => (
              <EntryTile
                key={entry.path}
                entry={entry}
                index={index}
                selected={selected.has(entry.path)}
                cut={!!cutPaths?.has(entry.path)}
                lyknMade={isLyknFolder(lyknMade, entry.path)}
                renaming={renaming === entry.path}
                renameDraft={renameDraft}
                setRenameDraft={setRenameDraft}
                onCommitRename={commitRename}
                onCancelRename={cancelRename}
                onClick={clickEntry}
                onOpen={activate}
                onMenu={setMenu}
                onBeginDrag={beginDrag}
                onDropInto={dropInto}
                onSpringOpen={navigate}
              />
            ))}
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-3 border-b border-black/10 px-2 pb-1 text-[0.68rem] font-medium uppercase tracking-wide text-black/40 dark:border-white/10 dark:text-white/40">
              <span className="min-w-0 flex-1">Name</span>
              <span className="hidden w-24 text-right sm:block">Size</span>
              <span className="hidden w-28 md:block">Kind</span>
              <span className="hidden w-32 lg:block">Date Modified</span>
            </div>
            {entries.map((entry, index) => (
              <EntryRow
                key={entry.path}
                entry={entry}
                index={index}
                selected={selected.has(entry.path)}
                cut={!!cutPaths?.has(entry.path)}
                lyknMade={isLyknFolder(lyknMade, entry.path)}
                renaming={renaming === entry.path}
                renameDraft={renameDraft}
                setRenameDraft={setRenameDraft}
                onCommitRename={commitRename}
                onCancelRename={cancelRename}
                onClick={clickEntry}
                onOpen={activate}
                onMenu={setMenu}
                onBeginDrag={beginDrag}
                onDropInto={dropInto}
                onSpringOpen={navigate}
              />
            ))}
          </div>
        )}

        {listing.truncated && (
          <p className="px-2 py-3 text-center text-[0.72rem] text-black/40 dark:text-white/40">
            Showing the first {entries.length} of {listing.total} items.
          </p>
        )}
      </div>

      {pickMode ? (
        <div className="flex items-center gap-2 border-t border-black/10 px-3 py-2 dark:border-white/10">
          <span className="min-w-0 flex-1 truncate text-[0.7rem] text-black/40 dark:text-white/40">
            {selectedPaths.length > 0
              ? `${selectedPaths.length} selected`
              : "Select an item to add"}
          </span>
          <button
            type="button"
            onClick={() => onPickCancel?.()}
            className="rounded-lg px-3 py-1.5 text-[0.75rem] font-medium text-black/70 transition-colors hover:bg-black/[0.06] dark:text-white/75 dark:hover:bg-white/[0.08]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => confirmPick(null)}
            disabled={selectedPaths.length === 0}
            className="rounded-lg bg-black px-3 py-1.5 text-[0.75rem] font-medium text-white transition-opacity disabled:opacity-35 dark:bg-white dark:text-black"
          >
            Add
          </button>
        </div>
      ) : (
        <div className="border-t border-black/10 px-3 py-1 text-center text-[0.7rem] text-black/40 dark:border-white/10 dark:text-white/40">
          {selectedPaths.length > 0
            ? `${selectedPaths.length} of ${listing.total} selected`
            : `${listing.total} item${listing.total === 1 ? "" : "s"}`}
        </div>
      )}

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          selectionCount={selectedPaths.length}
          onOpen={() => menu.entry && open(menu.entry)}
          onQuickLook={() => menu.entry && showFile(menu.entry)}
          onOpenExternally={() => menu.entry && openExternally(menu.entry)}
          onReveal={() => void api.macFsOpen(menu.entry?.path || path, { reveal: true })}
          onRename={() => {
            if (!menu.entry) return;
            setRenaming(menu.entry.path);
            setRenameDraft(menu.entry.name);
          }}
          onDuplicate={() => void duplicateSelection()}
          onTrash={() => void trashSelection()}
          onNewFolder={() => void newFolder()}
          onAskAi={() => askAi(menu.entry)}
          clipboard={clipboard}
          onCopy={() => clip("copy")}
          onCut={() => clip("cut")}
          // Right-clicking a folder pastes into it; anywhere else pastes into
          // the folder being viewed, the way Finder reads the click.
          onPaste={() =>
            void paste(
              menu.entry && menu.entry.type === "dir" && !menu.entry.package
                ? menu.entry.path
                : path,
            )
          }
        />
      )}
    </div>
  );
}

/* ── Entry rendering ──────────────────────────────────────────────────────── */

/** A folder in the path bar — click to go there, or drop something into it. */
function Crumb({ crumb, current, onNavigate, onDropInto }) {
  const drop = useDropZone({
    accept: (payload) => canDropIntoFolder(payload, crumb.path),
    dwell: FOLDER_DWELL_MS,
    onDrop: (payload) => void onDropInto(payload, crumb.path),
  });
  return (
    <button
      ref={drop.ref}
      type="button"
      onClick={() => onNavigate(crumb.path)}
      className={`rounded px-0.5 hover:underline ${
        drop.hot
          ? "bg-blue-500/30 text-black dark:text-white"
          : current
            ? "font-medium text-black/85 dark:text-white/85"
            : "text-black/50 dark:text-white/50"
      }`}
    >
      {crumb.name}
    </button>
  );
}

/**
 * Every listed item is a drop target when it's a folder. Settling on one lights
 * it up; holding a drag there opens it, so a file can be carried several
 * folders deep in one go the way Finder's spring-loaded folders work. A drag
 * that only passes over a row falls through to the pane behind it.
 */
function useEntryDrop(entry, renaming, onDropInto, onSpringOpen) {
  const isFolder = entry.type === "dir" && !entry.package;
  return useDropZone({
    disabled: !isFolder || renaming,
    accept: (payload) => canDropIntoFolder(payload, entry.path),
    dwell: FOLDER_DWELL_MS,
    onHoverOpen: () => onSpringOpen(entry.path),
    onDrop: (payload) => void onDropInto(payload, entry.path),
  });
}

function RenameField({ value, onChange, onCommit, onCancel, className }) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={onCommit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onCommit();
        if (e.key === "Escape") onCancel();
      }}
      className={`rounded border border-blue-500 bg-white px-1 text-[0.72rem] outline-none dark:bg-neutral-900 ${className}`}
    />
  );
}

/**
 * Right-click has to open the menu without disturbing an existing multi-
 * selection — collapsing five selected files to one because you asked for
 * their context menu would be maddening.
 */
function menuHandler({ entry, index, selected, onClick, onMenu }) {
  return (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selected) onClick(event, entry, index);
    onMenu({ ...eventToFixedPoint(event), entry });
  };
}

/**
 * What a file looks like, in three tiers.
 *
 * Web-decodable images are drawn straight off disk over `lykn-mac://` — no
 * round trip, full resolution, and the browser's own lazy loading. Everything
 * else asks macOS for a QuickLook preview, which is where PDF pages, video
 * frames, app icons, and HEIC photos come from. Whatever has neither keeps its
 * kind icon.
 */
/**
 * A folder made in LYKN is white, matching AI Drive's own folders. The Mac's
 * folders keep Finder's blue, so the grid says at a glance which of the two
 * made what it lists. White needs the shadow to hold an edge on a light pane.
 */
function folderTint(lyknMade) {
  return lyknMade ? "text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.28)]" : "text-sky-500";
}

function Thumbnail({ entry, lyknMade }) {
  const [failed, setFailed] = useState(false);
  const { icon: Icon } = kindOf(entry);
  const isFolder = entry.type === "dir" && !entry.package;

  const icon = (
    <Icon
      className={`h-11 w-11 ${
        isFolder ? folderTint(lyknMade) : "text-black/45 dark:text-white/55"
      } ${entry.hidden ? "opacity-45" : ""}`}
      strokeWidth={isFolder ? 1 : 1.4}
      fill={isFolder ? "currentColor" : "none"}
    />
  );
  if (isFolder) return icon;

  const art = "max-h-11 max-w-11 rounded object-contain shadow-sm";
  return (
    <span className="flex h-11 w-11 items-center justify-center">
      {canThumbnail(entry) && !failed ? (
        <img
          src={macFileUrl(entry.path)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          // A corrupt file shouldn't leave a broken-image glyph behind.
          onError={() => setFailed(true)}
          className={art}
        />
      ) : (
        // 128 rather than 44: the tile has to stay sharp on a Retina display.
        <FileThumb entry={entry} size={128} className={art} fallback={icon} />
      )}
    </span>
  );
}

function EntryTile({
  entry,
  index,
  selected,
  cut,
  lyknMade,
  renaming,
  renameDraft,
  setRenameDraft,
  onCommitRename,
  onCancelRename,
  onClick,
  onOpen,
  onMenu,
  onBeginDrag,
  onDropInto,
  onSpringOpen,
}) {
  const drop = useEntryDrop(entry, renaming, onDropInto, onSpringOpen);
  return (
    <button
      ref={drop.ref}
      type="button"
      data-entry-path={entry.path}
      onPointerDown={(e) => onBeginDrag(e, entry)}
      onClick={(e) => onClick(e, entry, index)}
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={menuHandler({ entry, index, selected, onClick, onMenu })}
      className={`flex flex-col items-center gap-1 rounded-xl p-2 text-center transition-colors ${
        drop.hot
          ? "bg-blue-500/25"
          : selected
            ? "bg-blue-500/20"
            : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      } ${cut ? "opacity-45" : ""}`}
    >
      <Thumbnail entry={entry} lyknMade={lyknMade} />
      {renaming ? (
        <RenameField
          value={renameDraft}
          onChange={setRenameDraft}
          onCommit={() => onCommitRename(entry)}
          onCancel={onCancelRename}
          className="w-full text-center"
        />
      ) : (
        <span
          className={`line-clamp-2 w-full break-words text-[0.7rem] leading-tight ${
            entry.hidden ? "opacity-55" : ""
          }`}
        >
          {entry.name}
        </span>
      )}
    </button>
  );
}

function EntryRow({
  entry,
  index,
  selected,
  cut,
  lyknMade,
  renaming,
  renameDraft,
  setRenameDraft,
  onCommitRename,
  onCancelRename,
  onClick,
  onOpen,
  onMenu,
  onBeginDrag,
  onDropInto,
  onSpringOpen,
}) {
  const { icon: Icon, label } = kindOf(entry);
  const isFolder = entry.type === "dir" && !entry.package;
  const drop = useEntryDrop(entry, renaming, onDropInto, onSpringOpen);
  return (
    <button
      ref={drop.ref}
      type="button"
      data-entry-path={entry.path}
      onPointerDown={(e) => onBeginDrag(e, entry)}
      onClick={(e) => onClick(e, entry, index)}
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={menuHandler({ entry, index, selected, onClick, onMenu })}
      className={`flex w-full items-center gap-3 rounded-lg px-2 py-1 text-left text-[0.78rem] transition-colors ${
        drop.hot
          ? "bg-blue-500/25"
          : selected
            ? "bg-blue-500/20"
            : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      } ${entry.hidden || cut ? "opacity-55" : ""}`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <FileThumb
          entry={entry}
          size={64}
          className="max-h-4 max-w-4 rounded-[2px] object-contain"
          fallback={
            isFolder ? (
              // Solid, like the tile and like Finder's own list rows — an
              // outlined white folder has nothing to read against on a light pane.
              <Icon className={`h-4 w-4 ${folderTint(lyknMade)}`} strokeWidth={1} fill="currentColor" />
            ) : (
              <Icon className="h-4 w-4 text-black/45 dark:text-white/55" />
            )
          }
        />
      </span>
      {renaming ? (
        <RenameField
          value={renameDraft}
          onChange={setRenameDraft}
          onCommit={() => onCommitRename(entry)}
          onCancel={onCancelRename}
          className="min-w-0 flex-1"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      )}
      <span className="hidden w-24 text-right text-black/45 dark:text-white/45 sm:block">
        {isFolder ? "--" : formatSize(entry.size)}
      </span>
      <span className="hidden w-28 truncate text-black/45 dark:text-white/45 md:block">{label}</span>
      <span className="hidden w-32 truncate text-black/45 dark:text-white/45 lg:block">
        {formatDate(entry.modifiedAt)}
      </span>
    </button>
  );
}

function ContextMenu({
  menu,
  onClose,
  selectionCount,
  onOpen,
  onQuickLook,
  onOpenExternally,
  onReveal,
  onRename,
  onDuplicate,
  onTrash,
  onNewFolder,
  onAskAi,
  clipboard,
  onCopy,
  onCut,
  onPaste,
}) {
  const menuRef = useRef(null);
  const has = !!menu.entry;
  const intoFolder = has && menu.entry.type === "dir" && !menu.entry.package;
  const pending = clipboard?.paths.length || 0;

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const block = fixedContainingBlock(el);
    const bounds = block
      ? block.getBoundingClientRect()
      : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let dx = 0;
    let dy = 0;
    if (rect.right > bounds.right - pad) dx -= rect.right - (bounds.right - pad);
    if (rect.bottom > bounds.bottom - pad) dy -= rect.bottom - (bounds.bottom - pad);
    if (rect.left + dx < bounds.left + pad) dx += bounds.left + pad - (rect.left + dx);
    if (rect.top + dy < bounds.top + pad) dy += bounds.top + pad - (rect.top + dy);
    if (!dx && !dy) return;
    const scaleX = block && bounds.width ? bounds.width / (block.offsetWidth || bounds.width) : 1;
    const scaleY = block && bounds.height ? bounds.height / (block.offsetHeight || bounds.height) : 1;
    el.style.left = `${menu.x + dx / (scaleX || 1)}px`;
    el.style.top = `${menu.y + dy / (scaleY || 1)}px`;
  }, [menu.x, menu.y]);

  const pasteLabel = () => {
    const what = pending > 1 ? `${pending} items` : "item";
    const verb = clipboard.mode === "cut" ? "Move" : "Paste";
    return intoFolder ? `${verb} ${what} into "${menu.entry.name}"` : `${verb} ${what} here`;
  };
  const item = (label, Icon, action, danger) => (
    <button
      type="button"
      onClick={() => {
        action();
        onClose();
      }}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.78rem] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] ${
        danger ? "text-red-600 dark:text-red-400" : ""
      }`}
    >
      <Icon className="h-3.5 w-3.5 opacity-70" />
      {label}
    </button>
  );

  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        data-no-tip
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className="lg-menu fixed z-50 w-52 p-1"
        style={{ left: menu.x, top: menu.y }}
      >
        {has && item("Open", FolderOpen, onOpen)}
        {has && menu.entry.type !== "dir" && item("Quick Look", Eye, onQuickLook)}
        {has && menu.entry.type !== "dir" && item("Open in default app", ExternalLink, onOpenExternally)}
        {has && item("Rename", PenLine, onRename)}
        {has && item(selectionCount > 1 ? "Duplicate items" : "Duplicate", Copy, onDuplicate)}
        {(has || pending > 0) && <div className="my-1 h-px bg-black/10 dark:bg-white/10" />}
        {has && item(selectionCount > 1 ? "Copy items" : "Copy", Copy, onCopy)}
        {has && item(selectionCount > 1 ? "Cut items" : "Cut", Scissors, onCut)}
        {pending > 0 && item(pasteLabel(), ClipboardPaste, onPaste)}
        {(has || pending > 0) && <div className="my-1 h-px bg-black/10 dark:bg-white/10" />}
        {has &&
          item(
            selectionCount > 1 ? "Ask LYKN about these" : "Ask LYKN about this",
            MessageCircle,
            onAskAi,
          )}
        {item("New folder", FolderPlus, onNewFolder)}
        {item("Reveal in Finder", FolderOpen, onReveal)}
        {has && (
          <>
            <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
            {item(selectionCount > 1 ? "Move to Trash" : "Move to Trash", Trash2, onTrash, true)}
          </>
        )}
      </div>
    </>
  );
}
