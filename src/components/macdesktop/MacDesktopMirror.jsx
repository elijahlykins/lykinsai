import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Folder } from "lucide-react";

import {
  firstFreeSlot,
  useDesktopFolderPaths,
} from "@/components/macdesktop/DesktopWidgets";
import { useDesktopVisibility } from "@/components/macdesktop/desktopVisibility";
import {
  gridRows,
  gridSlot,
  isPlacement,
  pixelsOf,
  placementOf,
  placementsOverlap,
  savedPlacement,
  useDesktopLayer,
} from "@/components/macdesktop/desktopGrid";
import {
  useDesktopFilesMoved,
  useDesktopPlace,
  useFolderDropZone,
} from "@/components/macdesktop/fileDrop";
import { useDesktopIconDrag } from "@/components/macdesktop/desktopIconDrag";
import { useSystemThumb } from "@/components/macfiles/FileThumb";
import { kindOf } from "@/components/macfiles/fileKinds";
import { canThumbnail, macFileUrl, previewKind } from "@/components/macfiles/preview";
import { openFileWindow } from "@/lib/files/fileWindows";
import { isLyknFolder, useLyknFolders } from "@/lib/lyknFolders";
import {
  DESKTOP_ICON_ART_CLASS,
  desktopIconClass,
  desktopIconLabelClass,
  useDesktopGroupMove,
  useDesktopSelect,
} from "@/components/macdesktop/desktopSelect";
import {
  FALLBACK_DESKTOP_PATH,
  askLyknAboutPath,
  forgetDesktopDrops,
  macFsBridge,
  shortenHome,
  useDesktopDrops,
  useDesktopSync,
} from "@/lib/macDesktopSync";

/**
 * The real files showing on the LYKN Home desktop. Two sources, kept separate
 * on purpose:
 *
 *  - Mirrored folders, everything inside them, opt-in through Settings →
 *    Display → "Sync my Desktop".
 *  - Dropped items, just the files the user dragged onto Home. These show
 *    with the mirror off, since dropping one file says nothing about wanting
 *    to see the rest of the folder it landed in.
 *
 * A view, not a copy: items are listed straight off disk through Local Mode
 * and open in the apps that own them. Nothing here moves, renames, or deletes
 * a real file — dragging an icon only remembers where the user parked it, and
 * "Remove from Desktop" forgets a drop without touching the file.
 */

// These sit on the Home drag surface — no-drag restores their clicks.
const NO_DRAG = { WebkitAppRegion: "no-drag" };

const POSITIONS_KEY = "lykn_desktop_mirror_pos";

/* A busy Desktop shouldn't march across the widgets, so the mirror stays in a
 * block of columns down the right edge. The rest still lives in Files. */
const MIRROR_COLUMNS = 3;
const MAX_ICONS = 60;

// How often the mirror re-lists the folders. There is no filesystem watcher in
// the shell, so Home also re-lists whenever the window regains focus.
const REFRESH_MS = 20_000;

// How long a just-dropped file has to show up in a listing before the spot
// reserved for it is given back. Two refreshes' worth.
const PENDING_MS = 45_000;

/** A leading dot is a hidden file, not an extension. */
function extOf(name) {
  const i = String(name || "").lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** The glyph and the Finder "Kind" for a mirrored item, from the shared table
 *  the Files browser reads — the desktop arranger sorts by that same Kind. */
function describe(item, isPackage) {
  return kindOf({ type: item.type, package: isPackage, ext: extOf(item.name) });
}

function loadPositions() {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITIONS_KEY) || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) return saved;
  } catch {
    /* icons fall back to the grid */
  }
  return {};
}

function persistPositions(positions) {
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  } catch {
    /* positions just won't survive a reload */
  }
}

function nextOpenSlot(start, taken, layer) {
  for (let i = start, n = 0; n < 200; i += 1, n += 1) {
    const slot = gridSlot(i, layer);
    if (!taken.some((p) => placementsOverlap(p, slot))) return { index: i, slot };
  }
  return { index: start, slot: gridSlot(start, layer) };
}

/**
 * Each icon keeps the slot it first landed in. Dragging one used to drop it
 * out of the flow, which packed every icon below it up a cell — the rest of
 * the desktop moved. New files still take the next empty slot.
 *
 * Placements come back rather than pixels, so the same arrangement resolves
 * against whatever display the desktop is currently on.
 */
function layoutDesktopIcons(items, positions, layer, startSlot) {
  const taken = [];
  for (const item of items) {
    const saved = savedPlacement(positions[item.path], layer);
    if (saved) taken.push(saved);
  }

  const newlyAssigned = {};
  let cursor = startSlot;
  const placed = items.map((item) => {
    const saved = savedPlacement(positions[item.path], layer);
    if (saved) return { item, placement: saved };
    const open = nextOpenSlot(cursor, taken, layer);
    taken.push(open.slot);
    newlyAssigned[item.path] = open.slot;
    cursor = open.index + 1;
    return { item, placement: open.slot };
  });

  return { placed, newlyAssigned };
}

const MENU_ITEM_CLS =
  "lg-menu-row w-full rounded-[0.5rem] px-2.5 py-1 text-left text-[0.78rem] " +
  "text-black/85 dark:text-white/90";

function MirrorIcon({ item, pos, lyknMade, onOpen, onMenu }) {
  const iconId = `file:${item.path}`;
  const select = useDesktopSelect();
  const selected = select.isSelected(iconId);
  // An app is a directory, and the shell's listing doesn't mark packages, so
  // without this an app on the desktop draws as a blue folder.
  const isPackage = item.type === "dir" && /\.(app|pkg|bundle)$/i.test(item.name);
  const isFolder = item.type === "dir" && !isPackage;
  const { icon: Icon, label: kind } = describe(item, isPackage);
  // Photos Chromium can decode are drawn from disk so they keep their real
  // shape. QuickLook's thumbnail API stamps everything into a square, which
  // is what made landscape shots look stretched on Home.
  const filePreview = canThumbnail(item);
  const [fileFailed, setFileFailed] = useState(false);
  const art = useSystemThumb(
    isFolder || (filePreview && !fileFailed) ? null : { ...item, package: isPackage },
    160,
  );
  const src = filePreview && !fileFailed ? macFileUrl(item.path) : art;
  const drop = useFolderDropZone(isFolder ? item.path : null, {
    onHoverOpen: isFolder ? () => onOpen(item) : undefined,
  });
  const beginDrag = useDesktopIconDrag({ id: iconId, path: item.path });

  return (
    <button
      ref={drop.ref}
      type="button"
      data-desktop-icon={iconId}
      data-desktop-path={item.path}
      // Read by the desktop arranger — it works off the icons on screen rather
      // than the stores behind them, so what it sorts by has to be here.
      data-desktop-name={item.name}
      data-desktop-kind={kind}
      data-desktop-date={item.modifiedAt || item.createdAt || undefined}
      onPointerDown={beginDrag}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        if (select.selected.size > 1 && selected) {
          select.selectOnly(iconId);
          return;
        }
        onOpen(item);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!selected) select.selectOnly(iconId);
        onMenu(item, e.clientX, e.clientY);
      }}
      title={shortenHome(item.path)}
      style={{ ...NO_DRAG, left: pos.x, top: pos.y }}
      className={`${desktopIconClass(selected, { hot: drop.hot })} pointer-events-auto`}
    >
      {isFolder ? (
        // White if LYKN made it, Finder blue if the Mac did.
        <Folder
          className={`${DESKTOP_ICON_ART_CLASS} ${
            lyknMade ? "text-white" : "text-sky-500"
          } drop-shadow-[0_4px_10px_rgba(0,0,0,0.25)] transition-transform group-hover:scale-105 group-active:scale-95`}
          strokeWidth={1}
          fill="currentColor"
        />
      ) : (
        // The real preview macOS would draw — a PDF's first page, a frame from
        // a video, an app's icon. The white card behind it is what makes a
        // document read as a document; art that fills the tile (a photo, an
        // app icon) sheds it and stands on its own, the way Finder does.
        <span
          className={`flex ${DESKTOP_ICON_ART_CLASS} items-center justify-center transition-transform group-hover:scale-105 group-active:scale-95 ${
            src
              ? ""
              : "rounded-[0.6rem] bg-white/90 shadow-[0_4px_12px_rgba(0,0,0,0.28)] dark:bg-white/85"
          }`}
        >
          {src ? (
            <img
              src={src}
              alt=""
              draggable={false}
              onError={() => setFileFailed(true)}
              className="max-h-full max-w-full rounded-[0.35rem] object-contain drop-shadow-[0_4px_10px_rgba(0,0,0,0.35)]"
            />
          ) : (
            <Icon
              className="h-[calc(var(--desk-art)*0.44)] w-[calc(var(--desk-art)*0.44)] text-black/55"
              strokeWidth={1.6}
            />
          )}
        </span>
      )}
      <span className={desktopIconLabelClass(selected)}>
        {item.name}
      </span>
    </button>
  );
}

export default function MacDesktopMirror({ onOpen }) {
  const api = useMemo(() => macFsBridge(), []);
  const { enabled, folders } = useDesktopSync();
  const [{ hideFolders, hideFiles }, setVisibility] = useDesktopVisibility();
  const layerRef = useRef(null);
  const layer = useDesktopLayer();
  const [positions, setPositions] = useState(loadPositions);
  const [menu, setMenu] = useState(null); // { x, y, item }

  // Render-synced mirror of `positions` so drag handlers always build the next
  // map from the latest one, mid-drag included.
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  /* Spots claimed for files that were only just dropped here, by when they
   * were claimed. The move finishes before the re-list that proves the file
   * arrived, and without this the tidy-up below would read the gap as "deleted
   * in Finder" and throw the spot away — so the icon would appear in a grid
   * slot instead of under the cursor. A claim that never turns into a file
   * (something dropped that this layer doesn't draw) expires. */
  const pendingRef = useRef(new Map());
  const savePositions = useCallback((next) => {
    positionsRef.current = next;
    setPositions(next);
    persistPositions(next);
  }, []);
  // Drags and drops report pixels; they become placements against whichever
  // desktop they landed on.
  const layerSizeRef = useRef(layer);
  layerSizeRef.current = layer;

  useDesktopGroupMove(({ positions, commit }) => {
    const next = { ...positionsRef.current };
    let changed = false;
    for (const [id, pos] of Object.entries(positions || {})) {
      if (!id.startsWith("file:")) continue;
      if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) continue;
      next[id.slice(5)] = placementOf(pos, layerSizeRef.current);
      changed = true;
    }
    if (!changed) return;
    if (commit) savePositions(next);
    else {
      positionsRef.current = next;
      setPositions(next);
    }
  });

  const drops = useDesktopDrops();
  const homeFolderPaths = useDesktopFolderPaths();
  // Folders made in LYKN — through the Files browser, say — are white here too.
  const lyknMade = useLyknFolders();
  const targets = useMemo(
    () => (enabled ? (folders.length ? folders : [FALLBACK_DESKTOP_PATH]) : []),
    [enabled, folders],
  );
  // The folders a dropped item could be sitting in — listed so the drops can
  // be resolved to real entries, without mirroring everything else in them.
  const dropParents = useMemo(
    () => [...new Set(drops.map((p) => p.replace(/\/[^/]*$/, "") || "/"))].sort(),
    [drops],
  );
  const watched = useMemo(
    () => [...new Set([...targets, ...dropParents])],
    [targets, dropParents],
  );
  const active = !!api && (enabled || drops.length > 0);

  const { data, refetch } = useQuery({
    queryKey: ["mac-desktop-mirror", targets.join("|"), drops.join("|")],
    enabled: active,
    staleTime: REFRESH_MS / 2,
    refetchInterval: REFRESH_MS,
    // Adding a folder shouldn't blank the icons already on screen.
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const list = async (folder) => {
        try {
          const listing = await api.macFsList(folder);
          return listing?.ok ? listing : null;
        } catch {
          return null; // one unreadable folder shouldn't blank the desktop
        }
      };

      const seen = new Set();
      const out = [];
      for (const folder of targets) {
        const listing = await list(folder);
        if (!listing) continue;
        for (const entry of listing.entries || []) {
          // Dotfiles are hidden on the real desktop too.
          if (!entry?.name || entry.name.startsWith(".")) continue;
          const path = `${listing.path.replace(/\/+$/, "")}/${entry.name}`;
          if (seen.has(path)) continue;
          seen.add(path);
          out.push({ ...entry, path });
        }
      }

      // Dropped items, pulled one by one out of their folder. A drop inside a
      // folder that's already mirrored is a duplicate, so it's skipped.
      const live = [];
      for (const parent of dropParents) {
        const listing = await list(parent);
        // Unreadable folder: leave those drops alone rather than treating an
        // unknown as a deletion and forgetting them.
        if (!listing) {
          live.push(...drops.filter((p) => p.startsWith(`${parent}/`)));
          continue;
        }
        const base = listing.path.replace(/\/+$/, "");
        for (const entry of listing.entries || []) {
          const path = `${base}/${entry?.name}`;
          if (!entry?.name || !drops.includes(path)) continue;
          live.push(path);
          if (seen.has(path)) continue; // already on Home via its folder
          seen.add(path);
          out.push({ ...entry, path, dropped: true });
        }
      }
      return { items: out, checked: drops, live };
    },
  });

  const items = useMemo(() => {
    const all = data?.items || [];
    if (!homeFolderPaths.length) return all;
    const skip = new Set(homeFolderPaths);
    return all.filter((i) => !skip.has(i.path));
  }, [data, homeFolderPaths]);

  // A dropped item the user has since deleted or moved in Finder shouldn't
  // keep a slot on Home. Judged against the drops this result actually looked
  // at, never the current list: a fresh drop arrives before the refetch that
  // confirms it, and while that's in flight `data` is still the previous
  // result — which would read as "not on disk" and forget it on the spot.
  useEffect(() => {
    if (!data) return;
    const live = new Set(data.live);
    const gone = data.checked.filter((p) => !live.has(p));
    if (gone.length) forgetDesktopDrops(gone);
  }, [data]);

  // Local Mode or the synced folders changing means a different view of disk.
  useEffect(() => {
    if (!active) return undefined;
    const offs = [
      api.onLocalModeChanged?.(() => void refetch()),
      api.onMacSyncChanged?.(() => void refetch()),
    ];
    return () => offs.forEach((off) => off?.());
  }, [active, api, refetch]);

  // Watch the mirrored folders so the desktop keeps up with the real one
  // without waiting out the poll — dropping a file here should show it
  // landing, not eventually.
  useEffect(() => {
    if (!active || !api.files) return undefined;
    let cancelled = false;
    // Compare against the paths the watcher reports rather than the configured
    // ones, which may still be in "~/Desktop" form.
    const watching = new Set();
    for (const folder of watched) {
      void api.files.watch(folder).then((r) => {
        if (!cancelled && r?.ok) watching.add(r.path);
      });
    }
    const off = api.files.onChanged(({ path: changed }) => {
      if (watching.has(changed)) void refetch();
    });
    return () => {
      cancelled = true;
      off?.();
      for (const folder of watched) void api.files.unwatch(folder);
    };
  }, [active, api, watched, refetch]);

  // Drop remembered positions for items that left the real desktop.
  useEffect(() => {
    if (!items.length) return;
    const live = new Set(items.map((i) => i.path));
    const cutoff = Date.now() - PENDING_MS;
    for (const [p, claimed] of [...pendingRef.current]) {
      if (live.has(p) || claimed < cutoff) pendingRef.current.delete(p);
    }
    const stale = Object.keys(positionsRef.current).filter(
      (p) => !live.has(p) && !pendingRef.current.has(p),
    );
    if (!stale.length) return;
    const next = { ...positionsRef.current };
    for (const p of stale) delete next[p];
    savePositions(next);
  }, [items, savePositions]);

  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e) => {
      if (!e.target.closest?.("[data-mirror-menu]")) setMenu(null);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const onPlace = useCallback(
    ({ paths, x, y }) => {
      if (!paths?.length) return;
      const next = { ...positionsRef.current };
      paths.forEach((p, i) => {
        // Cascade a multi-item drop the way Finder does, so six files don't
        // land as one icon.
        next[p] = placementOf(
          { x: x + i * 16, y: y + i * 16 },
          layerSizeRef.current,
        );
        pendingRef.current.set(p, Date.now());
      });
      savePositions(next);
      if (hideFiles) setVisibility({ hideFiles: false });
    },
    [hideFiles, savePositions, setVisibility],
  );
  useDesktopPlace(onPlace);
  const onFilesMoved = useCallback(() => {
    void refetch();
  }, [refetch]);
  useDesktopFilesMoved(onFilesMoved);

  const openItem = useCallback(
    (item) => {
      setMenu(null);
      if (item.type === "dir") {
        // Folders open in LYKN's own Files browser, still on disk.
        onOpen?.("files", `/files?path=${encodeURIComponent(item.path)}`);
        return;
      }
      // A file opens in LYKN's own window when LYKN can show it, and only
      // falls through to whichever app macOS would launch when it can't.
      if (previewKind(item)) {
        openFileWindow({ path: item.path, name: item.name, size: item.size });
        return;
      }
      void api?.macFsOpen?.(item.path);
    },
    [api, onOpen],
  );

  const revealItem = (item) => {
    setMenu(null);
    void api?.macFsOpen?.(item.path, { reveal: true });
  };

  // Into the real Trash, recoverable from Finder — the same thing the file
  // browser's delete does, so the desktop isn't the one place you can see a
  // file but not get rid of it.
  const trashItem = (item) => {
    setMenu(null);
    if (!api?.files?.trash) return;
    void api.files.trash({ paths: [item.path] }).then((r) => {
      if (r?.ok !== false) forgetDesktopDrops([item.path]);
      void refetch();
    });
  };

  // Same row math gridSlot uses, minus the top slots where the Files and
  // Vault icons park.
  const rows = gridRows(layer);
  const startSlot = firstFreeSlot();
  const capacity = Math.max(
    1,
    Math.min(MAX_ICONS, rows * MIRROR_COLUMNS - startSlot),
  );
  const visible = items.length <= capacity ? items : items.slice(0, capacity);

  const { placed, newlyAssigned } = layoutDesktopIcons(
    visible,
    positions,
    layer,
    startSlot,
  );

  // Pin auto-assigned slots once the desktop has a real size, so a later
  // drag doesn't pack everyone else into the hole. Positions saved as raw
  // pixels by an older build are rewritten here too, read against the display
  // they were parked on, so they stop drifting on the next monitor change.
  useLayoutEffect(() => {
    if (!layer.w || !layer.h) return;
    const next = { ...positionsRef.current };
    let changed = false;
    for (const [path, slot] of Object.entries(newlyAssigned)) {
      if (savedPlacement(next[path], layer)) continue;
      next[path] = slot;
      changed = true;
    }
    for (const [path, saved] of Object.entries(next)) {
      if (isPlacement(saved)) continue;
      const migrated = savedPlacement(saved, layer);
      if (!migrated) continue;
      next[path] = migrated;
      changed = true;
    }
    if (changed) savePositions(next);
  }, [layer, newlyAssigned, savePositions]);

  if (!active) return null;

  const layerPoint = (clientX, clientY) => {
    const r = layerRef.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left, y: clientY - r.top } : { x: 0, y: 0 };
  };

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0">
      {placed.map(({ item, placement }) => {
        const isPackage = item.type === "dir" && /\.(app|pkg|bundle)$/i.test(item.name);
        const isFolder = item.type === "dir" && !isPackage;
        if (hideFolders && isFolder) return null;
        if (hideFiles && !isFolder) return null;
        return (
          <MirrorIcon
            key={item.path}
            item={item}
            pos={pixelsOf(placement, layer)}
            lyknMade={isLyknFolder(lyknMade, item.path)}
            onOpen={openItem}
            onMenu={(target, cx, cy) =>
              setMenu({ ...layerPoint(cx, cy), item: target })
            }
          />
        );
      })}

      {menu && (
        <div
          data-mirror-menu
          style={{ left: menu.x, top: menu.y }}
          className="lg-desktop-surface pointer-events-auto absolute z-50 w-48 rounded-[14px] p-1"
        >
          <button type="button" className={MENU_ITEM_CLS} onClick={() => openItem(menu.item)}>
            Open
          </button>
          <button type="button" className={MENU_ITEM_CLS} onClick={() => revealItem(menu.item)}>
            Show in Finder
          </button>
          <div className="mx-2 my-1 h-px bg-black/[0.08] dark:bg-white/[0.1]" />
          <button
            type="button"
            className={MENU_ITEM_CLS}
            onClick={() => {
              setMenu(null);
              askLyknAboutPath(menu.item.path);
            }}
          >
            Ask LYKN about this
          </button>
          {/* Only for items dropped here by hand — takes the icon off Home and
              leaves the file where it is. Mirrored items have no such switch;
              they follow the folder. */}
          {menu.item.dropped && (
            <button
              type="button"
              className={MENU_ITEM_CLS}
              onClick={() => {
                setMenu(null);
                forgetDesktopDrops([menu.item.path]);
              }}
            >
              Remove from Desktop
            </button>
          )}
          <div className="mx-2 my-1 h-px bg-black/[0.08] dark:bg-white/[0.1]" />
          <button
            type="button"
            className={`${MENU_ITEM_CLS} !text-red-600 dark:!text-red-400`}
            onClick={() => trashItem(menu.item)}
          >
            Move to Trash
          </button>
        </div>
      )}
    </div>
  );
}
