import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  File,
  FileText,
  Folder,
  Image as ImageIcon,
  Link2,
  Music,
  Video,
} from "lucide-react";

import {
  ICON_CELL_H,
  ICON_CELL_W,
  ICON_GRID_PAD,
  gridSlot,
  useDesktopIconDrag,
} from "@/components/macdesktop/DesktopWidgets";
import {
  FALLBACK_DESKTOP_PATH,
  askLyknAboutPath,
  macFsBridge,
  shortenHome,
  useDesktopSync,
} from "@/lib/macDesktopSync";

/**
 * The user's real Mac desktop, mirrored onto the LYKN Home desktop
 * (Settings → Display → "Sync my Desktop").
 *
 * A mirror, not a copy: items are listed straight off disk through Local Mode
 * and open in the apps that own them. Nothing here moves, renames, or deletes
 * a real file — dragging an icon only remembers where the user parked it.
 */

// These sit on the Home drag surface — no-drag restores their clicks.
const NO_DRAG = { WebkitAppRegion: "no-drag" };

const POSITIONS_KEY = "lykn_desktop_mirror_pos";

/* A busy Desktop shouldn't march across the widgets, so the mirror stays in a
 * block of columns down the right edge — anything past that is one click away
 * in the Files tab. */
const MIRROR_COLUMNS = 3;
const MAX_ICONS = 60;

// How often the mirror re-lists the folders. There is no filesystem watcher in
// the shell, so Home also re-lists whenever the window regains focus.
const REFRESH_MS = 20_000;

const EXT_ICONS = [
  [/^(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|tiff?)$/i, ImageIcon],
  [/^(mp4|mov|webm|m4v|mkv|avi)$/i, Video],
  [/^(mp3|wav|m4a|ogg|flac|aiff?)$/i, Music],
  [/^(txt|md|pdf|doc|docx|rtf|pages|numbers|key|csv|json|xlsx?)$/i, FileText],
];

function iconFor(entry) {
  if (entry.type === "dir") return Folder;
  if (entry.type === "symlink") return Link2;
  const ext = entry.name.split(".").pop() || "";
  for (const [re, Icon] of EXT_ICONS) if (re.test(ext)) return Icon;
  return File;
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

const MENU_ITEM_CLS =
  "lg-menu-row w-full rounded-[0.5rem] px-2.5 py-1 text-left text-[0.78rem] " +
  "text-black/85 dark:text-white/90";

function MirrorIcon({ item, pos, onMove, onCommitMove, onOpen, onMenu }) {
  const Icon = iconFor(item);
  const drag = useDesktopIconDrag({
    setPos: (p) => onMove(item.path, p),
    onDragEnd: (p) => onCommitMove(item.path, p),
    onClick: () => onOpen(item),
  });

  return (
    <button
      ref={drag.ref}
      type="button"
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(item, e.clientX, e.clientY);
      }}
      title={shortenHome(item.path)}
      style={{ ...NO_DRAG, left: pos.x, top: pos.y }}
      className="group pointer-events-auto absolute flex w-24 touch-none flex-col items-center gap-1 rounded-2xl p-2 transition-colors hover:bg-white/10"
    >
      {item.type === "dir" ? (
        <Folder
          className="h-16 w-16 text-sky-500 drop-shadow-[0_4px_10px_rgba(0,0,0,0.25)] transition-transform group-hover:scale-105 group-active:scale-95"
          strokeWidth={1}
          fill="currentColor"
        />
      ) : (
        <span className="flex h-16 w-14 items-center justify-center rounded-[0.6rem] bg-white/90 shadow-[0_4px_12px_rgba(0,0,0,0.28)] transition-transform group-hover:scale-105 group-active:scale-95 dark:bg-white/85">
          <Icon className="h-7 w-7 text-black/55" strokeWidth={1.6} />
        </span>
      )}
      <span className="max-w-full truncate text-[0.72rem] font-medium text-white/90 [text-shadow:0_1px_3px_rgba(0,0,0,0.45)]">
        {item.name}
      </span>
    </button>
  );
}

export default function MacDesktopMirror({ onOpen }) {
  const api = useMemo(() => macFsBridge(), []);
  const { enabled, folders } = useDesktopSync();
  const layerRef = useRef(null);
  const [layer, setLayer] = useState({ w: 0, h: 0 });
  const [positions, setPositions] = useState(loadPositions);
  const [menu, setMenu] = useState(null); // { x, y, item }

  // Render-synced mirror of `positions` so drag handlers always build the next
  // map from the latest one, mid-drag included.
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const savePositions = useCallback((next) => {
    positionsRef.current = next;
    setPositions(next);
    persistPositions(next);
  }, []);

  const targets = useMemo(
    () => (folders.length ? folders : [FALLBACK_DESKTOP_PATH]),
    [folders],
  );
  const active = !!api && enabled;

  const { data: items = [], refetch } = useQuery({
    queryKey: ["mac-desktop-mirror", targets.join("|")],
    enabled: active,
    staleTime: REFRESH_MS / 2,
    refetchInterval: REFRESH_MS,
    // Adding a folder shouldn't blank the icons already on screen.
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const seen = new Set();
      const out = [];
      for (const folder of targets) {
        let listing = null;
        try {
          listing = await api.macFsList(folder);
        } catch {
          continue; // one unreadable folder shouldn't blank the desktop
        }
        if (!listing?.ok) continue;
        for (const entry of listing.entries || []) {
          // Dotfiles are hidden on the real desktop too.
          if (!entry?.name || entry.name.startsWith(".")) continue;
          const path = `${listing.path.replace(/\/+$/, "")}/${entry.name}`;
          if (seen.has(path)) continue;
          seen.add(path);
          out.push({ ...entry, path });
        }
      }
      return out;
    },
  });

  // Local Mode or the synced folders changing means a different view of disk.
  useEffect(() => {
    if (!active) return undefined;
    const offs = [
      api.onLocalModeChanged?.(() => void refetch()),
      api.onMacSyncChanged?.(() => void refetch()),
    ];
    return () => offs.forEach((off) => off?.());
  }, [active, api, refetch]);

  // Icons flow into the grid against the layer's real size.
  useLayoutEffect(() => {
    const el = layerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => setLayer({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);

  // Drop remembered positions for items that left the real desktop.
  useEffect(() => {
    if (!items.length) return;
    const live = new Set(items.map((i) => i.path));
    const stale = Object.keys(positionsRef.current).filter((p) => !live.has(p));
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

  const move = useCallback((path, p) => {
    positionsRef.current = { ...positionsRef.current, [path]: p };
    setPositions(positionsRef.current);
  }, []);
  const commitMove = useCallback(
    (path, p) => savePositions({ ...positionsRef.current, [path]: p }),
    [savePositions],
  );

  const openItem = useCallback(
    (item) => {
      setMenu(null);
      if (item.type === "dir") {
        // Folders open in LYKN's own Files browser, still on disk.
        onOpen?.("files", `/files?path=${encodeURIComponent(item.path)}`);
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

  if (!active) return null;

  // Same row math gridSlot uses, minus slot 0 where the Files icon parks.
  const rows = Math.max(
    1,
    Math.floor(((layer.h || 720) - ICON_GRID_PAD * 2) / ICON_CELL_H),
  );
  const capacity = Math.max(1, Math.min(MAX_ICONS, rows * MIRROR_COLUMNS - 1));
  const visible =
    items.length <= capacity ? items : items.slice(0, Math.max(capacity - 1, 1));
  const overflow = items.length - visible.length;

  // Slot 0 is where the Files icon parks, so the mirror starts one below it.
  let flowIndex = 1;
  const placed = visible.map((item) => {
    const saved = positions[item.path];
    const pos =
      saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
        ? saved
        : gridSlot(flowIndex++, layer);
    return { item, pos };
  });
  const overflowPos = gridSlot(flowIndex, layer);

  const layerPoint = (clientX, clientY) => {
    const r = layerRef.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left, y: clientY - r.top } : { x: 0, y: 0 };
  };

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0">
      {placed.map(({ item, pos }) => (
        <MirrorIcon
          key={item.path}
          item={item}
          pos={pos}
          onMove={move}
          onCommitMove={commitMove}
          onOpen={openItem}
          onMenu={(target, cx, cy) =>
            setMenu({ ...layerPoint(cx, cy), item: target })
          }
        />
      ))}

      {overflow > 0 && (
        <button
          type="button"
          onClick={() => onOpen?.("files", `/files?path=${encodeURIComponent(targets[0])}`)}
          title="Open the rest in Files"
          style={{ ...NO_DRAG, left: overflowPos.x, top: overflowPos.y }}
          className="pointer-events-auto absolute flex w-24 flex-col items-center gap-1 rounded-2xl p-2 transition-colors hover:bg-white/10"
        >
          <span
            className="flex items-center justify-center rounded-[0.6rem] border border-dashed border-white/45 text-[0.9rem] font-medium text-white/80"
            style={{ width: ICON_CELL_W - 48, height: ICON_CELL_H - 48 }}
          >
            +{overflow}
          </span>
          <span className="max-w-full truncate text-[0.72rem] font-medium text-white/90 [text-shadow:0_1px_3px_rgba(0,0,0,0.45)]">
            More
          </span>
        </button>
      )}

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
        </div>
      )}
    </div>
  );
}
