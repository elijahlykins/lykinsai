import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Minus, Plus, Search } from "lucide-react";

import {
  GRID_PAD,
  GRID_PITCH,
  SIZE_ORDER,
  WIDGET_SIZES,
  addWidget,
  cellToPx,
  collides,
  gridCapacity,
  pxToCell,
  readWidgetLayout,
  removeWidget,
  resizeWidget,
  sizeBox,
  subscribeWidgetLayout,
  updateWidget,
} from "@/lib/desktopWidgets";
import { hasMacApps, useMacApps } from "@/lib/macApps";

import { WIDGET_TYPES, resolveSize, widgetType } from "./widgetCatalog";

/**
 * The Home desktop's widget surface: what's on it, where the user put it, and
 * the edit mode that lets them move things around.
 *
 * Widgets are interactive by default — a click on the calendar opens the
 * calendar. Holding one for a moment lifts it into edit mode, which is where
 * dragging, resizing, removing and adding happen, the same bargain macOS
 * makes. Without that split, every drag would be a misfired click.
 */

// Auto-placement stays clear of the desktop icon column on the right and the
// chat bar along the bottom. Dragging is not restricted this way — if you want
// a widget behind the Files icon, that's your desktop.
const RIGHT_RESERVE = 128;
const BOTTOM_RESERVE = 132;
const LIFT_MS = 450;

/** The cell nearest `col,row` that this widget actually fits in. */
function nearestFreeCell(item, col, row, items, capacity) {
  const span = WIDGET_SIZES[item.size] || WIDGET_SIZES.small;
  const maxCol = Math.max(0, capacity.cols - span.cols);
  const maxRow = Math.max(0, capacity.rows - span.rows);
  const want = { col: Math.min(col, maxCol), row: Math.min(row, maxRow) };
  const others = items.filter((i) => i.id !== item.id);
  if (!collides({ ...item, ...want }, others)) return want;

  let best = null;
  for (let r = 0; r <= maxRow; r += 1) {
    for (let c = 0; c <= maxCol; c += 1) {
      if (collides({ ...item, col: c, row: r }, others)) continue;
      const dist = Math.abs(c - want.col) + Math.abs(r - want.row);
      if (!best || dist < best.dist) best = { col: c, row: r, dist };
    }
  }
  return best ? { col: best.col, row: best.row } : { col: item.col, row: item.row };
}

/* ── One widget on the canvas ──────────────────────────────────────────── */

function CanvasWidget({
  item,
  spec,
  editing,
  dragging,
  offset,
  userId,
  onOpen,
  onBeginDrag,
  onDragMove,
  onDragEnd,
  onMenu,
  onRemove,
  onResize,
  onChangeProps,
}) {
  const press = useRef(null);
  const suppressClick = useRef(false);
  const box = sizeBox(item.size);

  useEffect(() => () => clearTimeout(press.current?.timer), []);

  const beginPress = (e) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const { pointerId } = e;
    // Capturing the pointer also retargets the compatibility mouse events, so
    // it can only happen once the widget has actually been lifted — capture on
    // every press would send each click to this wrapper instead of the button
    // inside the widget that the user aimed at.
    const capture = () => el.setPointerCapture?.(pointerId);
    press.current = { x: e.clientX, y: e.clientY, lifted: false, timer: null };
    if (editing) {
      press.current.lifted = true;
      capture();
      onBeginDrag(item.id);
      return;
    }
    // Outside edit mode a widget is a control, so it takes a deliberate hold
    // to pick one up.
    press.current.timer = setTimeout(() => {
      if (!press.current) return;
      press.current.lifted = true;
      suppressClick.current = true;
      capture();
      onBeginDrag(item.id, { enterEdit: true });
    }, LIFT_MS);
  };

  const movePress = (e) => {
    const p = press.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.lifted) {
      // Moving before the hold lands means this was a scroll or a sloppy
      // click, not a pick-up.
      if (Math.hypot(dx, dy) > 6) {
        clearTimeout(p.timer);
        press.current = null;
      }
      return;
    }
    if (Math.hypot(dx, dy) > 3) suppressClick.current = true;
    onDragMove(dx, dy);
  };

  const endPress = () => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    clearTimeout(p.timer);
    if (p.lifted) onDragEnd();
  };

  const ctx = {
    id: item.id,
    size: item.size,
    props: item.props,
    userId,
    onOpen,
    onChangeProps: (patch) => onChangeProps(item.id, patch),
  };

  return (
    <div
      style={{
        left: cellToPx(item.col),
        top: cellToPx(item.row),
        width: box.w,
        height: box.h,
        transform: dragging ? `translate3d(${offset.dx}px, ${offset.dy}px, 0)` : undefined,
        zIndex: dragging ? 40 : 10,
      }}
      className={`pointer-events-auto absolute touch-none ${
        dragging
          ? "scale-[1.03] cursor-grabbing drop-shadow-[0_18px_40px_rgba(0,0,0,0.35)]"
          : editing
            ? "cursor-grab transition-transform duration-150"
            : "transition-[left,top] duration-200 ease-out"
      }`}
      onPointerDown={beginPress}
      onPointerMove={movePress}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onClickCapture={(e) => {
        // A hold or a drag must not also count as a click on whatever button
        // happened to be under the finger.
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(item.id, e.clientX, e.clientY);
      }}
    >
      {/* In edit mode the widget is cargo, not a control. */}
      <div className={`h-full w-full ${editing ? "pointer-events-none select-none" : ""}`}>
        {spec.render(ctx)}
      </div>

      {editing && (
        <>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onRemove(item.id)}
            title={`Remove ${spec.label}`}
            aria-label={`Remove ${spec.label}`}
            className="absolute -left-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-black/80 text-white shadow-[0_2px_8px_rgba(0,0,0,0.35)] transition-transform hover:scale-110 dark:bg-white dark:text-black"
          >
            <Minus className="h-3 w-3" strokeWidth={3} />
          </button>
          {spec.sizes.length > 1 && (
            <div
              onPointerDown={(e) => e.stopPropagation()}
              className="lg-desktop-surface absolute bottom-1.5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full p-0.5"
            >
              {SIZE_ORDER.filter((s) => spec.sizes.includes(s)).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onResize(item.id, s)}
                  title={`${WIDGET_SIZES[s].label} ${spec.label}`}
                  className={`rounded-full px-2 py-[0.1rem] text-[0.6rem] font-semibold transition-colors ${
                    item.size === s
                      ? "bg-black/85 text-white dark:bg-white dark:text-black"
                      : "text-black/55 hover:bg-black/10 dark:text-white/60 dark:hover:bg-white/15"
                  }`}
                >
                  {WIDGET_SIZES[s].label[0]}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── Add-widget gallery ────────────────────────────────────────────────── */

function AppPicker({ onPick, onBack }) {
  const { apps } = useMacApps();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filtered = (needle ? apps.filter((a) => a.name.toLowerCase().includes(needle)) : apps).slice(
    0,
    120,
  );

  return (
    <>
      <div className="mb-2 flex items-center gap-2 rounded-xl bg-black/[0.05] px-2.5 py-1.5 dark:bg-white/[0.08]">
        <Search className="h-3.5 w-3.5 shrink-0 text-black/45 dark:text-white/45" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your apps…"
          className="w-full bg-transparent text-[0.8rem] text-black/85 outline-none placeholder:text-black/40 dark:text-white/90 dark:placeholder:text-white/40"
        />
      </div>
      <div className="grid max-h-[19rem] grid-cols-2 gap-1 overflow-y-auto scrollbar-hide sm:grid-cols-3">
        {filtered.map((app) => (
          <button
            key={app.path}
            type="button"
            onClick={() => onPick(app)}
            className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            {app.icon ? (
              <img src={app.icon} alt="" draggable={false} className="h-6 w-6 rounded-[22%]" />
            ) : (
              <span className="flex h-6 w-6 items-center justify-center rounded-[22%] bg-black/10 text-[0.65rem] font-semibold dark:bg-white/20">
                {app.name.slice(0, 1)}
              </span>
            )}
            <span className="truncate text-[0.78rem] text-black/85 dark:text-white/90">
              {app.name}
            </span>
          </button>
        ))}
        {!filtered.length && (
          <p className="col-span-full px-2 py-6 text-center text-[0.78rem] text-black/45 dark:text-white/45">
            No apps match &ldquo;{query}&rdquo;
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onBack}
        className="mt-2 text-[0.75rem] text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/80"
      >
        ← All widgets
      </button>
    </>
  );
}

function Gallery({ step, counts, onAddType, onAddApp, onStep, onClose }) {
  const macApps = hasMacApps();

  return (
    <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-black/25 backdrop-blur-[2px]"
        aria-hidden
        onPointerDown={onClose}
      />
      <div className="lg-desktop-surface relative w-full max-w-[34rem] rounded-[18px] p-3.5">
        <div className="mb-2.5 flex items-baseline justify-between gap-3">
          <h2 className="text-[0.95rem] font-semibold text-black/90 dark:text-white/95">
            {step === "apps" ? "Pick an app" : "Add a widget"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[0.75rem] text-black/50 hover:text-black/85 dark:text-white/50 dark:hover:text-white/85"
          >
            Done
          </button>
        </div>

        {step === "apps" ? (
          <AppPicker onPick={onAddApp} onBack={() => onStep("types")} />
        ) : (
          <div className="grid max-h-[22rem] grid-cols-2 gap-1.5 overflow-y-auto scrollbar-hide sm:grid-cols-3">
            {WIDGET_TYPES.filter((spec) => !spec.desktopOnly || macApps).map((spec) => {
              const count = counts[spec.type] || 0;
              const disabled = count > 0 && !spec.repeatable;
              return (
                <button
                  key={spec.type}
                  type="button"
                  disabled={disabled}
                  onClick={() => (spec.pickApp ? onStep("apps") : onAddType(spec))}
                  title={disabled ? `${spec.label} is already on the desktop` : spec.description}
                  className={`flex flex-col gap-1 rounded-[14px] border p-2.5 text-left transition-colors ${
                    disabled
                      ? "cursor-default border-black/[0.06] opacity-45 dark:border-white/[0.08]"
                      : "border-black/[0.08] hover:bg-black/[0.04] dark:border-white/[0.1] dark:hover:bg-white/[0.06]"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <spec.icon className={`h-4 w-4 flex-shrink-0 ${spec.tone}`} strokeWidth={1.9} />
                    <span className="truncate text-[0.8rem] font-medium text-black/85 dark:text-white/90">
                      {spec.label}
                    </span>
                    {count > 0 && (
                      <span className="ml-auto flex-shrink-0 text-[0.65rem] text-black/40 dark:text-white/40">
                        {spec.repeatable ? count : <Check className="h-3 w-3" strokeWidth={2.5} />}
                      </span>
                    )}
                  </span>
                  <span className="text-[0.66rem] leading-snug text-black/45 dark:text-white/45">
                    {spec.description}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── The canvas ────────────────────────────────────────────────────────── */

export default function WidgetCanvas({ userId, onOpen, editing = false, onEditingChange }) {
  const layerRef = useRef(null);
  const [layer, setLayer] = useState({ w: 0, h: 0 });
  const [items, setItems] = useState(readWidgetLayout);
  const [drag, setDrag] = useState(null); // { id, dx, dy, col, row }
  const [menu, setMenu] = useState(null); // { x, y, id }
  const [gallery, setGallery] = useState(null); // null | "types" | "apps"
  const dragRef = useRef(null);

  useEffect(() => subscribeWidgetLayout(setItems), []);

  useLayoutEffect(() => {
    const el = layerRef.current;
    if (!el) return undefined;
    const measure = () => setLayer({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Leaving edit mode closes everything it opened.
  useEffect(() => {
    if (editing) return;
    setGallery(null);
    setMenu(null);
  }, [editing]);

  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e) => {
      if (!e.target.closest?.("[data-widget-menu]")) setMenu(null);
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

  useEffect(() => {
    if (!editing || gallery) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onEditingChange?.(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing, gallery, onEditingChange]);

  const dragCapacity = useMemo(
    () => gridCapacity({ w: layer.w || 1200, h: layer.h || 720 }),
    [layer.w, layer.h],
  );
  const placeCapacity = useMemo(
    () =>
      gridCapacity({
        w: Math.max(GRID_PITCH + GRID_PAD, (layer.w || 1200) - RIGHT_RESERVE),
        h: Math.max(GRID_PITCH + GRID_PAD, (layer.h || 720) - BOTTOM_RESERVE),
      }),
    [layer.w, layer.h],
  );

  // A widget type that's been retired (or comes from a newer build) shouldn't
  // leave a hole on the desktop — it's simply not drawn.
  const placed = useMemo(
    () =>
      items
        .map((item) => ({ item: { ...item, size: resolveSize(item.type, item.size) }, spec: widgetType(item.type) }))
        .filter((entry) => entry.spec),
    [items],
  );

  const counts = useMemo(() => {
    const out = {};
    for (const { item } of placed) out[item.type] = (out[item.type] || 0) + 1;
    return out;
  }, [placed]);

  const beginDrag = useCallback(
    (id, opts) => {
      if (opts?.enterEdit) onEditingChange?.(true);
      setMenu(null);
      const item = items.find((i) => i.id === id);
      if (!item) return;
      dragRef.current = { id, col: item.col, row: item.row };
      setDrag({ id, dx: 0, dy: 0, col: item.col, row: item.row });
    },
    [items, onEditingChange],
  );

  const moveDrag = useCallback(
    (dx, dy) => {
      const d = dragRef.current;
      if (!d) return;
      const entry = placed.find((p) => p.item.id === d.id);
      if (!entry) return;
      const wanted = {
        col: pxToCell(cellToPx(d.col) + dx),
        row: pxToCell(cellToPx(d.row) + dy),
      };
      const target = nearestFreeCell(
        entry.item,
        wanted.col,
        wanted.row,
        placed.map((p) => p.item),
        dragCapacity,
      );
      d.target = target;
      setDrag({ id: d.id, dx, dy, ...target });
    },
    [placed, dragCapacity],
  );

  const endDrag = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d?.target) return;
    if (d.target.col === d.col && d.target.row === d.row) return;
    updateWidget(d.id, { col: d.target.col, row: d.target.row });
  }, []);

  const changeProps = useCallback((id, patch) => {
    const current = readWidgetLayout().find((i) => i.id === id);
    updateWidget(id, { props: { ...(current?.props || {}), ...patch } });
  }, []);

  const addType = useCallback(
    (spec) => {
      addWidget(spec.type, { size: spec.defaultSize, capacity: placeCapacity });
      setGallery(null);
      onEditingChange?.(true);
    },
    [placeCapacity, onEditingChange],
  );

  const addApp = useCallback(
    (app) => {
      addWidget("appLauncher", {
        size: "small",
        capacity: placeCapacity,
        props: { appPath: app.path, appName: app.name, appIcon: app.icon || "" },
      });
      setGallery(null);
      onEditingChange?.(true);
    },
    [placeCapacity, onEditingChange],
  );

  const menuItem = menu ? placed.find((p) => p.item.id === menu.id) : null;
  const dragBox = drag ? sizeBox(placed.find((p) => p.item.id === drag.id)?.item.size) : null;

  return (
    <div
      ref={layerRef}
      // Out of edit mode this layer is invisible to the pointer, so a
      // right-click between widgets still reaches the desktop menu underneath.
      className={`absolute inset-0 ${editing ? "pointer-events-auto" : "pointer-events-none"}`}
      onPointerDown={(e) => {
        if (editing && e.target === e.currentTarget) onEditingChange?.(false);
      }}
      onContextMenu={(e) => {
        if (editing) e.preventDefault();
      }}
    >
      {editing && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.16]"
          style={{
            backgroundImage: "radial-gradient(currentColor 1px, transparent 1px)",
            backgroundSize: `${GRID_PITCH}px ${GRID_PITCH}px`,
            backgroundPosition: `${GRID_PAD - 1}px ${GRID_PAD - 1}px`,
          }}
        />
      )}

      {/* Where the widget will land when it's let go. */}
      {drag && dragBox && (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-[1.35rem] border-2 border-dashed border-white/45 bg-white/[0.06]"
          style={{
            left: cellToPx(drag.col),
            top: cellToPx(drag.row),
            width: dragBox.w,
            height: dragBox.h,
            zIndex: 5,
          }}
        />
      )}

      {placed.map(({ item, spec }) => (
        <CanvasWidget
          key={item.id}
          item={item}
          spec={spec}
          editing={editing}
          dragging={drag?.id === item.id}
          offset={drag?.id === item.id ? drag : { dx: 0, dy: 0 }}
          userId={userId}
          onOpen={onOpen}
          onBeginDrag={beginDrag}
          onDragMove={moveDrag}
          onDragEnd={endDrag}
          onMenu={(id, cx, cy) => {
            const r = layerRef.current?.getBoundingClientRect();
            setMenu({ id, x: cx - (r?.left || 0), y: cy - (r?.top || 0) });
          }}
          onRemove={removeWidget}
          onResize={(id, size) => resizeWidget(id, size, placeCapacity)}
          onChangeProps={changeProps}
        />
      ))}

      {menu && menuItem && (
        <div
          data-widget-menu
          style={{
            left: Math.min(menu.x, Math.max(8, (layer.w || 0) - 190)),
            top: Math.min(menu.y, Math.max(8, (layer.h || 0) - 210)),
          }}
          className="lg-desktop-surface pointer-events-auto absolute z-[60] w-44 rounded-[14px] p-1"
        >
          <p className="px-2 pb-1 pt-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.06em] text-black/40 dark:text-white/40">
            {menuItem.spec.subtitle?.(menuItem.item) || menuItem.spec.label}
          </p>
          {menuItem.spec.sizes.length > 1 &&
            SIZE_ORDER.filter((s) => menuItem.spec.sizes.includes(s)).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  resizeWidget(menuItem.item.id, s, placeCapacity);
                  setMenu(null);
                }}
                className="lg-menu-row flex w-full items-center gap-2 rounded-[0.5rem] px-1.5 py-[0.3rem] text-left text-[0.8rem] text-black/85 dark:text-white/90"
              >
                <span className="flex w-4 flex-shrink-0 items-center justify-center">
                  {menuItem.item.size === s ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : null}
                </span>
                {WIDGET_SIZES[s].label}
              </button>
            ))}
          <div className="mx-1.5 my-1 h-px bg-black/[0.08] dark:bg-white/[0.1]" />
          <button
            type="button"
            onClick={() => {
              setMenu(null);
              onEditingChange?.(true);
            }}
            className="lg-menu-row flex w-full items-center gap-2 rounded-[0.5rem] px-1.5 py-[0.3rem] text-left text-[0.8rem] text-black/85 dark:text-white/90"
          >
            <span className="w-4" />
            Edit Widgets
          </button>
          <button
            type="button"
            onClick={() => {
              removeWidget(menuItem.item.id);
              setMenu(null);
            }}
            className="lg-menu-row flex w-full items-center gap-2 rounded-[0.5rem] px-1.5 py-[0.3rem] text-left text-[0.8rem] text-black/85 dark:text-white/90"
          >
            <span className="w-4" />
            Remove Widget
          </button>
        </div>
      )}

      {editing && !gallery && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 z-[55] flex justify-center">
          <div className="lg-desktop-surface pointer-events-auto flex items-center gap-1 rounded-full p-1 pl-1.5">
            <button
              type="button"
              onClick={() => setGallery("types")}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[0.8rem] font-medium text-black/80 transition-colors hover:bg-black/[0.06] dark:text-white/85 dark:hover:bg-white/[0.08]"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
              Add Widget
            </button>
            <span className="h-4 w-px bg-black/10 dark:bg-white/15" aria-hidden />
            <button
              type="button"
              onClick={() => onEditingChange?.(false)}
              className="rounded-full bg-black/85 px-3.5 py-1.5 text-[0.8rem] font-semibold text-white transition-transform hover:scale-[1.03] dark:bg-white dark:text-black"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {gallery && (
        <Gallery
          step={gallery}
          counts={counts}
          onAddType={addType}
          onAddApp={addApp}
          onStep={setGallery}
          onClose={() => setGallery(null)}
        />
      )}
    </div>
  );
}
