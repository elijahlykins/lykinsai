/**
 * AI Drive, drawn as a folder.
 *
 * The Vault page is a collage: big tiles, glass, variable heights, built for
 * browsing by eye. That's the right surface for a page of its own and the wrong
 * one for a pane sitting next to the Mac's own folders, where the same window
 * suddenly changes its mind about what a file looks like. So the Studio gets
 * this instead — the chrome and the tiles of `FilesBrowser`, filled with what
 * LYKN made rather than what's on disk.
 *
 * There is nothing to add here by hand: the drive holds the AI's output, and the
 * AI fills it. Anything a person saves themselves belongs to the Vault page, so
 * this has no upload button — one would only offer to put a file somewhere it
 * wouldn't then appear.
 *
 * Everything that makes an item an item — the data, the previews, selection,
 * deleting, tags — still belongs to the Vault. This draws it and reports the
 * clicks back.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronUp,
  Folder,
  FolderOpen,
  LayoutGrid,
  List,
  Loader2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Tag,
  X,
} from "lucide-react";
import { formatDate, formatSize } from "./fileKinds";
import { DRIVE_SORTS, sortDriveEntries } from "./driveKinds";

const PREFS_KEY = "lykn_drive_prefs";

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

function readPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    if (saved && typeof saved === "object") return saved;
  } catch {
    /* defaults below */
  }
  return {};
}

export default function DriveListing({
  entries,
  loading = false,
  folder = null,
  onExitFolder,
  onEnterFolder,
  query = "",
  onQueryChange,
  onQuerySubmit,
  searching = false,
  onClearSearch,
  tags = [],
  selectedTags = [],
  onToggleTag,
  onClearTags,
  selectedIds,
  onSelect,
  onOpen,
  onMenu,
  onClearSelection,
  onSelectAll,
  onRefresh,
  registerRef,
  hasMore = false,
  onLoadMore,
  error = "",
  pickMode = false,
  onPickAdd,
  onPickCancel,
}) {
  const prefs = useMemo(readPrefs, []);
  const [view, setView] = useState(prefs.view === "list" ? "list" : "icons");
  const [sort, setSort] = useState(prefs.sort || "added");
  const [order, setOrder] = useState(prefs.order === "asc" ? "asc" : "desc");
  const [sortMenu, setSortMenu] = useState(false);
  const [tagMenu, setTagMenu] = useState(false);
  const [folderMenu, setFolderMenu] = useState(null);
  // The Vault's selection is for acting on things, so it only ever holds items
  // that can be deleted — a connector folder can't. Clicking one still has to
  // light up, or the first click of the double-click that opens it looks like
  // nothing happened.
  const [focused, setFocused] = useState(null);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ view, sort, order }));
    } catch {
      /* preferences just won't persist */
    }
  }, [view, sort, order]);

  // Name sorts read best A→Z; dates and sizes read best biggest-first, which is
  // also what "Date Added" means to someone looking for what they just saved.
  const chooseSort = (id) => {
    if (sort === id) setOrder((o) => (o === "asc" ? "desc" : "asc"));
    else {
      setSort(id);
      setOrder(id === "name" || id === "kind" ? "asc" : "desc");
    }
    setSortMenu(false);
  };

  const sorted = useMemo(() => sortDriveEntries(entries, sort, order), [entries, sort, order]);
  const orderedIds = useMemo(() => sorted.map((e) => e.id), [sorted]);
  const selectedCount = useMemo(
    () => sorted.reduce((n, e) => (selectedIds?.has(e.id) ? n + 1 : n), 0),
    [sorted, selectedIds],
  );

  // Paging happens as you approach the end of the list, so the count in the
  // status bar keeps climbing instead of stopping at the first page.
  const sentinelRef = useRef(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || !onLoadMore || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (rows) => {
        if (rows.some((row) => row.isIntersecting)) onLoadMore();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore, sorted.length]);

  const onKeyDown = useCallback(
    (event) => {
      const target = event.target;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key === "a") {
        event.preventDefault();
        onSelectAll?.(orderedIds);
      } else if (meta && event.key === "ArrowUp") {
        event.preventDefault();
        if (folder) onExitFolder?.();
      } else if (event.key === "Escape" && pickMode) {
        event.preventDefault();
        onPickCancel?.();
      } else if (event.key === " " || event.key === "Enter") {
        if (pickMode && event.key === "Enter") {
          event.preventDefault();
          onPickAdd?.();
          return;
        }
        const entry = sorted.find((e) => e.id === focused) || sorted.find((e) => selectedIds?.has(e.id));
        if (!entry) return;
        event.preventDefault();
        if (entry.isFolder) onEnterFolder?.(entry);
        else onOpen?.(entry);
      }
    },
    [focused, folder, onEnterFolder, onExitFolder, onOpen, onPickAdd, onPickCancel, onSelectAll, orderedIds, pickMode, selectedIds, sorted],
  );

  const iconButton =
    "rounded-lg p-1.5 text-black/60 transition-colors hover:bg-black/[0.06] disabled:opacity-30 dark:text-white/60 dark:hover:bg-white/[0.08]";
  const activeIconButton =
    "rounded-lg p-1.5 bg-blue-500/15 text-blue-600 transition-colors dark:bg-blue-400/20 dark:text-blue-400";

  return (
    <div className="flex h-full min-h-0 w-full flex-col outline-none" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="flex items-center gap-1 border-b border-black/10 px-3 py-2 dark:border-white/10">
        <button
          type="button"
          onClick={() => onExitFolder?.()}
          disabled={!folder}
          className={iconButton}
          title="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        {/* Forward is here because its absence is louder than its uselessness:
            a toolbar missing a button the folder pane next door has reads as
            broken. AI Drive is one level deep, so it never lights up. */}
        <button type="button" disabled className={iconButton} title="Forward">
          <ArrowRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onExitFolder?.()}
          disabled={!folder}
          className={iconButton}
          title="Enclosing folder"
        >
          <ChevronUp className="h-4 w-4" />
        </button>

        <div className="mx-1 flex min-w-0 flex-1 items-center gap-1 truncate text-[0.8rem]">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-black/40 dark:text-white/40" />
          <button
            type="button"
            onClick={() => onExitFolder?.()}
            className={`rounded px-0.5 hover:underline ${
              folder ? "text-black/50 dark:text-white/50" : "font-medium text-black/85 dark:text-white/85"
            }`}
          >
            AI Drive
          </button>
          {folder && (
            <>
              <span className="px-1 text-black/25 dark:text-white/25">/</span>
              <span className="truncate font-medium text-black/85 dark:text-white/85">{folder.name}</span>
            </>
          )}
        </div>

        <form
          className="relative"
          onSubmit={(event) => {
            event.preventDefault();
            onQuerySubmit?.(query);
          }}
        >
          {searching ? (
            <Loader2 className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-blue-500" />
          ) : (
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-black/35 dark:text-white/35" />
          )}
          <input
            value={query}
            onChange={(e) => onQueryChange?.(e.target.value)}
            placeholder="Search AI Drive"
            title="Type to filter by name, press Enter to search by meaning"
            className="w-44 rounded-lg border border-black/10 bg-black/[0.03] py-1 pl-7 pr-6 text-[0.75rem] outline-none placeholder:text-black/35 focus:border-black/25 dark:border-white/10 dark:bg-white/[0.05] dark:placeholder:text-white/35 dark:focus:border-white/25"
          />
          {query && (
            <button
              type="button"
              onClick={() => onClearSearch?.()}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-black/35 hover:text-black/70 dark:text-white/35 dark:hover:text-white/70"
              title="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </form>

            {tags.length > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setTagMenu((v) => !v)}
              className={selectedTags.length > 0 ? activeIconButton : iconButton}
              title={selectedTags.length > 0 ? `${selectedTags.length} tag filters` : "Filter by tag"}
            >
              <Tag className="h-4 w-4" />
            </button>
            {tagMenu && (
              <>
                <button
                  type="button"
                  aria-label="Close tag menu"
                  data-no-tip
                  className="fixed inset-0 z-40 cursor-default"
                  onClick={() => setTagMenu(false)}
                />
                <div className="lg-menu absolute right-0 z-50 mt-1 max-h-72 w-52 overflow-y-auto p-1">
                  {selectedTags.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        onClearTags?.();
                        setTagMenu(false);
                      }}
                      className="mb-1 flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[0.75rem] text-blue-600 hover:bg-black/[0.06] dark:text-blue-400 dark:hover:bg-white/[0.08]"
                    >
                      Clear filters
                    </button>
                  )}
                  {tags.map((tag) => (
                    <button
                      key={tag.name}
                      type="button"
                      onClick={() => onToggleTag?.(tag.name)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.78rem] hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
                    >
                      <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                      {selectedTags.includes(tag.name) ? (
                        <span className="text-blue-600 dark:text-blue-400">✓</span>
                      ) : (
                        <span className="text-black/30 dark:text-white/30">{tag.count}</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => setView((v) => (v === "icons" ? "list" : "icons"))}
          className={iconButton}
          title={view === "icons" ? "As list" : "As icons"}
        >
          {view === "icons" ? <List className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
        </button>

        <div className="relative">
          <button type="button" onClick={() => setSortMenu((v) => !v)} className={iconButton} title="Sort">
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
                {DRIVE_SORTS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => chooseSort(option.id)}
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

        <button type="button" onClick={() => onRefresh?.()} className={iconButton} title="Refresh">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[0.75rem] text-amber-700 dark:text-amber-300">
          {error}
        </div>
      )}

      <div
        className="min-h-0 flex-1 overflow-y-auto p-3"
        onClick={() => {
          setFocused(null);
          onClearSelection?.();
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
            {sorted.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center text-sm text-black/40 dark:text-white/40">
                {loading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : query || selectedTags.length > 0 ? (
                  <p>Nothing matches that.</p>
                ) : (
                  <>
                    <p>
                      {folder?.id === "images"
                        ? "No generated images yet."
                        : folder?.id === "docs"
                          ? "No documents yet."
                          : "Nothing here yet."}
                    </p>
                    <p className="text-[0.75rem]">
                      {folder?.id === "images"
                        ? "Images you make in chat land here once you save them."
                        : folder?.id === "docs"
                          ? "Letters, memos, and write-outs land here."
                          : "Artifacts you save from chat land here."}
                    </p>
                  </>
                )}
              </div>
            ) : view === "icons" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(116px,1fr))] gap-1">
            {/* Columns are sized for a 64px preview plus its name: a document
                preview only starts telling you which document it is at about
                that size. */}
            {sorted.map((entry) => (
              <DriveTile
                key={entry.id}
                entry={entry}
                selected={!!selectedIds?.has(entry.id) || focused === entry.id}
                orderedIds={orderedIds}
                onFocus={setFocused}
                onSelect={onSelect}
                onOpen={onOpen}
                onEnterFolder={onEnterFolder}
                onMenu={onMenu}
                onFolderMenu={setFolderMenu}
                registerRef={registerRef}
                pickMode={pickMode}
                onPickAdd={onPickAdd}
              />
            ))}
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-3 border-b border-black/10 px-2 pb-1 text-[0.68rem] font-medium uppercase tracking-wide text-black/40 dark:border-white/10 dark:text-white/40">
              <span className="min-w-0 flex-1">Name</span>
              <span className="hidden w-24 text-right sm:block">Size</span>
              <span className="hidden w-28 md:block">Kind</span>
              <span className="hidden w-32 lg:block">Date Added</span>
            </div>
            {sorted.map((entry) => (
              <DriveRow
                key={entry.id}
                entry={entry}
                selected={!!selectedIds?.has(entry.id) || focused === entry.id}
                orderedIds={orderedIds}
                onFocus={setFocused}
                onSelect={onSelect}
                onOpen={onOpen}
                onEnterFolder={onEnterFolder}
                onMenu={onMenu}
                onFolderMenu={setFolderMenu}
                registerRef={registerRef}
                pickMode={pickMode}
                onPickAdd={onPickAdd}
              />
            ))}
          </div>
        )}
        <div ref={sentinelRef} className="h-6" />
      </div>

      <div className="flex items-center gap-2 border-t border-black/10 px-3 py-2 dark:border-white/10">
        {pickMode ? (
          <>
            <span className="min-w-0 flex-1 truncate text-[0.7rem] text-black/40 dark:text-white/40">
              {selectedCount > 0
                ? `${selectedCount} selected`
                : "Select an item to add"}
            </span>
            <button
              type="button"
              onClick={onPickCancel}
              className="rounded-lg px-3 py-1.5 text-[0.75rem] font-medium text-black/70 transition-colors hover:bg-black/[0.06] dark:text-white/75 dark:hover:bg-white/[0.08]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onPickAdd}
              disabled={selectedCount === 0}
              className="rounded-lg bg-black px-3 py-1.5 text-[0.75rem] font-medium text-white transition-opacity disabled:opacity-35 dark:bg-white dark:text-black"
            >
              Add
            </button>
          </>
        ) : selectedCount > 0 ? (
          <span className="flex-1 text-center text-[0.7rem] text-black/40 dark:text-white/40">
            {`${selectedCount} of ${sorted.length} selected`}
          </span>
        ) : (
          <span className="flex-1 text-center text-[0.7rem] text-black/40 dark:text-white/40">
            {`${sorted.length}${hasMore ? "+" : ""} item${sorted.length === 1 ? "" : "s"}`}
          </span>
        )}
      </div>

      {folderMenu && (
        <DriveFolderContextMenu
          menu={folderMenu}
          onClose={() => setFolderMenu(null)}
          onOpen={() => onEnterFolder?.(folderMenu.entry)}
        />
      )}
    </div>
  );
}

/* ── Entry rendering ──────────────────────────────────────────────────────── */

function pressHandlers({
  entry,
  orderedIds,
  selected,
  onFocus,
  onSelect,
  onOpen,
  onEnterFolder,
  onMenu,
  onFolderMenu,
  pickMode,
  onPickAdd,
}) {
  return {
    onClick: (event) => {
      event.stopPropagation();
      onFocus?.(entry.id);
      onSelect?.(event, entry, orderedIds);
      if (pickMode) return;
      if (!entry.isFolder && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        onOpen?.(entry);
      }
    },
    onDoubleClick: (event) => {
      event.stopPropagation();
      if (entry.isFolder) onEnterFolder?.(entry);
      else if (pickMode) onPickAdd?.();
      else onOpen?.(entry);
    },
    onContextMenu: (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Right-clicking one of five selected items shouldn't collapse the
      // selection to that one — the menu is about all of them.
      if (!selected) {
        onFocus?.(entry.id);
        onSelect?.(event, entry, orderedIds);
      }
      if (entry.isFolder) {
        onFolderMenu?.({ ...eventToFixedPoint(event), entry });
      } else {
        onMenu?.(entry, event.currentTarget);
      }
    },
  };
}

/** A connector folder carries its app icon; AI Drive's fixed folders stay plain. */
function FolderGlyph({ entry, size = "h-16 w-16" }) {
  const Badge = entry.badgeIcon;
  const isDriveFolder = entry.card?.kind === "drive-folder";
  return (
    <span className={`relative flex ${size} items-center justify-center`}>
      <Folder
        className={`h-full w-full ${
          isDriveFolder
            ? "text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.28)]"
            : "text-sky-500"
        }`}
        strokeWidth={1}
        fill="currentColor"
      />
      {entry.favicon ? (
        <img
          src={entry.favicon}
          alt=""
          draggable={false}
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
          className="absolute bottom-0 right-0 h-1/3 w-1/3 rounded-[2px] bg-white object-contain shadow-sm"
        />
      ) : (
        Badge && <Badge className="absolute inset-0 m-auto h-1/2 w-1/2 text-white/90" strokeWidth={2} />
      )}
    </span>
  );
}

/**
 * Mounts its child only while it's on screen. Embedded previews are documents
 * with their own layout and scripts, so a listing that mounted every one of
 * them at once would pay for a page it isn't showing.
 */
function WhenVisible({ children, className }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (rows) => setVisible(rows.some((row) => row.isIntersecting)),
      { rootMargin: "100px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <span ref={ref} className={className}>
      {visible ? children : null}
    </span>
  );
}

/**
 * The frame every document preview sits in: a small white page with ruled lines
 * standing in for the text.
 *
 * The cover is drawn at thumbnail size rather than scaled down from a page,
 * because at this size scaled text is a grey smudge where a few rules still read
 * as a page of writing. It sits underneath whatever live preview is loading, so
 * a frame that's blocked or slow leaves a cover behind rather than an empty
 * white square.
 *
 * Web artifacts are laid out wide, so they get a landscape page; text and PDFs
 * get a portrait one.
 */
// Sized so both shapes come out 64px tall — a page ratio for documents, 4:3 for
// web artifacts — and sit on the same baseline as an image thumbnail.
//
// A rendered page is laid out at 900px and scaled down hard, rather than laid out
// at thumbnail width: a generated page at 320px hits its own mobile breakpoints
// and previews as a column of stacked blocks that looks nothing like the thing
// you opened.
const PAGE_LANDSCAPE = { box: 64, width: 900, height: 675 };
const PAGE_PORTRAIT = { box: 46, width: 320, height: 445 };

function PageFrame({ shape, children }) {
  const scale = shape.box / shape.width;
  const height = Math.round(shape.height * scale);
  const rule = "block h-[2px] shrink-0 rounded-full bg-black/10";
  return (
    <span
      className="relative block overflow-hidden rounded-[3px] bg-white shadow-sm ring-1 ring-black/10 dark:ring-white/15"
      style={{ width: shape.box, height }}
    >
      <span aria-hidden="true" className="absolute inset-0 flex flex-col gap-[3px] px-[5px] py-[6px]">
        <span className="block h-[3px] w-3/4 shrink-0 rounded-full bg-black/20" />
        <span className={`${rule} w-full`} />
        <span className={`${rule} w-full`} />
        <span className={`${rule} w-5/6`} />
        <span className={`${rule} w-full`} />
        <span className={`${rule} w-full`} />
        <span className={`${rule} w-4/5`} />
        <span className={`${rule} w-full`} />
        <span className={`${rule} w-2/3`} />
      </span>
      {children && (
        <span className="pointer-events-none absolute inset-0 block overflow-hidden">
          <span
            className="block origin-top-left"
            style={{ width: shape.width, height: shape.height, transform: `scale(${scale})` }}
          >
            {children}
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * Scripts may run — a generated React page is a shell that renders itself, so
 * without this every artifact previews as an empty document. There's no
 * `allow-same-origin`, so the frame gets an opaque origin and can't reach this
 * app's storage, cookies or session.
 */
const SRCDOC_SANDBOX = "allow-scripts";

/**
 * A preview of a generated page, drawn by rendering it. It's small, so what
 * survives is the shape and colour of the thing — which is enough to tell one
 * artifact from another at a glance, and more than a generic glyph says.
 *
 * `markup` renders the page inline; `url` frames it from wherever it's hosted.
 * Inline is preferred for artifacts — a hosted page can refuse to be framed.
 */
function EmbedPreview({ url, markup, sandbox, portrait = false }) {
  return (
    <PageFrame shape={portrait ? PAGE_PORTRAIT : PAGE_LANDSCAPE}>
      <iframe
        title=""
        src={markup ? undefined : url}
        srcDoc={markup || undefined}
        sandbox={markup ? SRCDOC_SANDBOX : sandbox}
        referrerPolicy="no-referrer"
        loading="lazy"
        scrolling="no"
        tabIndex={-1}
        aria-hidden="true"
        draggable={false}
        style={{ pointerEvents: "none" }}
        onLoad={(event) => {
          event.currentTarget.style.opacity = "1";
        }}
        // Hidden until it loads, so a frame that's refused (an expired link, an
        // origin the file proxy won't be embedded by) reveals the cover rather
        // than covering it with a blank page.
        className="h-full w-full border-0 bg-white opacity-0 transition-opacity duration-150"
      />
    </PageFrame>
  );
}

/**
 * A preview of a document that can't be framed — a React source file, a CSV, a
 * note — drawn from its own first page of text. Same idea a Finder icon has when
 * it shows you the top of the file: you recognise which one it is by reading it,
 * not by its extension.
 *
 * Only the head of the file is kept. If the bytes can't be fetched (expired
 * signature, a store that isn't reachable) the page stays blank, which is still
 * a page.
 */
function TextPreview({ url }) {
  const [text, setText] = useState("");

  useEffect(() => {
    let alive = true;
    setText("");
    // No Range header on purpose: it isn't CORS-safelisted, so asking for one
    // would add a preflight to every tile for bytes we're about to truncate.
    fetch(url)
      .then((res) => (res.ok ? res.text() : ""))
      .then((raw) => {
        if (alive) setText(String(raw || "").slice(0, 1200));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);

  // Nothing fetched yet (or nothing fetchable): leave the cover showing.
  if (!text) return <PageFrame shape={PAGE_PORTRAIT} />;

  return (
    <PageFrame shape={PAGE_PORTRAIT}>
      {/* Type is deliberately oversized for the page it's on: shrunk to 46px,
          11px source would be grey mush, where this still reads as words. */}
      <span className="block h-full w-full whitespace-pre-wrap break-words bg-white px-5 pb-6 pt-6 font-mono text-[20px] leading-[1.45] text-black/70">
        {text}
      </span>
    </PageFrame>
  );
}

/**
 * What an item looks like before you open it, in the order of how much it tells
 * you: its own image, its own rendered page, its own first lines, an empty page
 * of the right kind, and only then a glyph.
 */
function DriveThumb({ entry, registerRef }) {
  const [failed, setFailed] = useState(false);
  const Icon = entry.icon;

  if (entry.isFolder) return <FolderGlyph entry={entry} />;

  const centered = "flex h-16 w-16 items-center justify-center";

  return (
    <span
      // The Vault resolves signed URLs for whatever scrolls into view, keyed off
      // this attribute — without it the thumbnails never load.
      data-card-id={entry.id}
      ref={(el) => registerRef?.(entry.id, el)}
      className={centered}
    >
      {entry.thumb && !failed ? (
        <img
          src={entry.thumb}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="max-h-16 max-w-16 rounded object-contain shadow-sm"
        />
      ) : entry.srcDoc || entry.embed ? (
        <WhenVisible className={centered}>
          <EmbedPreview
            url={entry.embed}
            markup={entry.srcDoc}
            sandbox={entry.sandbox}
            portrait={entry.portrait}
          />
        </WhenVisible>
      ) : entry.textUrl ? (
        <WhenVisible className={centered}>
          <TextPreview url={entry.textUrl} />
        </WhenVisible>
      ) : entry.paper ? (
        <span className={centered}>
          <PageFrame shape={PAGE_PORTRAIT} />
        </span>
      ) : (
        Icon && <Icon className="h-14 w-14 text-black/45 dark:text-white/55" strokeWidth={1.4} />
      )}
    </span>
  );
}

function DriveTile(props) {
  const { entry, selected, registerRef } = props;
  return (
    <button
      type="button"
      {...pressHandlers(props)}
      className={`flex flex-col items-center gap-1 rounded-xl p-2 text-center transition-colors ${
        selected ? "bg-blue-500/20" : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      }`}
    >
      <DriveThumb entry={entry} registerRef={registerRef} />
      <span className="line-clamp-2 w-full break-words text-[0.7rem] leading-tight">{entry.name}</span>
    </button>
  );
}

function DriveRow(props) {
  const { entry, selected, registerRef } = props;
  const Icon = entry.icon;
  return (
    <button
      type="button"
      {...pressHandlers(props)}
      className={`flex w-full items-center gap-3 rounded-lg px-2 py-1 text-left text-[0.78rem] transition-colors ${
        selected ? "bg-blue-500/20" : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {entry.isFolder ? (
          <FolderGlyph entry={entry} size="h-4 w-4" />
        ) : entry.thumb ? (
          <img
            src={entry.thumb}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            data-card-id={entry.id}
            ref={(el) => registerRef?.(entry.id, el)}
            className="max-h-4 max-w-4 rounded-[2px] object-contain"
          />
        ) : (
          <span data-card-id={entry.id} ref={(el) => registerRef?.(entry.id, el)}>
            {Icon && <Icon className="h-4 w-4 text-black/45 dark:text-white/55" />}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      <span className="hidden w-24 text-right text-black/45 dark:text-white/45 sm:block">
        {entry.isFolder ? (entry.count ? `${entry.count} items` : "--") : formatSize(entry.size)}
      </span>
      <span className="hidden w-28 truncate text-black/45 dark:text-white/45 md:block">{entry.kindLabel}</span>
      <span className="hidden w-32 truncate text-black/45 dark:text-white/45 lg:block">
        {formatDate(entry.dateMs)}
      </span>
    </button>
  );
}

function DriveFolderContextMenu({ menu, onClose, onOpen }) {
  const menuRef = useRef(null);

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

  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        data-no-tip
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className="lg-menu fixed z-50 w-52 p-1"
        style={{ left: menu.x, top: menu.y }}
      >
        <button
          type="button"
          onClick={() => {
            onOpen();
            onClose();
          }}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.78rem] hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
        >
          <FolderOpen className="h-3.5 w-3.5 opacity-70" />
          Open
        </button>
      </div>
    </>
  );
}
