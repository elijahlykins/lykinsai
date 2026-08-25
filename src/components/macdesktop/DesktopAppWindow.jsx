import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  APP_CLOSE_MS,
  APP_EASE_IN,
  APP_EASE_OUT,
  APP_OPEN_MS,
  prefersReducedMotion,
} from "@/components/macdesktop/StudioPop";
import TrafficLights from "@/components/macdesktop/TrafficLights";

// ────────────────────────────────────────────────────────────────────────
// DesktopAppWindow — a macOS-style floating window for a LYKN page that
// pops up over the Home desktop (Browser, Calendar, To-dos) instead of taking
// the whole studio stage. Drag by the title bar, resize from any edge or
// corner, zoom to fill the desktop; the geometry sticks per window.
//
// It positions itself against its offsetParent, so the host layer must be
// positioned (the Studio renders these inside an absolute desktop layer).
// ────────────────────────────────────────────────────────────────────────

const NO_DRAG = { WebkitAppRegion: "no-drag" };

const EDGE = 8; // breathing room a zoomed window leaves at the desktop edges
// The bottom dock owns this strip, and a zoomed window stays clear of it —
// except a window that can actually paint over it (see `zoomCoversDock`).
const DOCK_CLEAR = 104;

function zoomedGeom(box, coversDock) {
  // Covering windows go edge-to-edge so they can swallow the dock. Everyone
  // else keeps the usual inset and clears the strip.
  const inset = coversDock ? 0 : EDGE;
  return {
    x: inset,
    y: inset,
    w: box.w - inset * 2,
    h: box.h - inset - (coversDock ? 0 : DOCK_CLEAR),
  };
}
const MIN_W = 380;
const MIN_H = 320;
// Dragging runs to the edges and past them, macOS style — the only rule is
// that the window stays grabbable: this much of it left on the desktop
// sideways, and its title bar never tucked under the dock, which paints above
// the windows and would swallow the clicks needed to drag it back out.
const KEEP_VISIBLE = 96;
// Split-snap only after the window is actually at the desktop edge — not
// merely near it — and has been held there. Brushing a side while moving
// a window around shouldn't light the preview or tile on drop.
const SNAP_HOLD_MS = 1000;

function snapZoneFor(last, box) {
  if (last.x <= 0) return "left";
  if (last.x + last.w >= box.w) return "right";
  return null;
}

// ── Motion. Windows pop in from slightly small, shrink away as they close,
// and drop toward the dock when minimized. MOVE_MS also times the wallpaper-
// peek slide, since both ride the frame's one transform transition.
const MOVE_MS = APP_OPEN_MS;
const CLOSE_MS = APP_CLOSE_MS;
const MIN_MS = 220;
const PEEK_MS = MOVE_MS;

// scale/lift are the transform the frame rests at in each stage; `open` is the
// window at its true geometry, so everything animates toward and away from it.
const STAGES = {
  entering: { scale: 0.86, lift: 18, opacity: 0, ms: MOVE_MS, ease: APP_EASE_OUT },
  open: { scale: 1, lift: 0, opacity: 1, ms: MOVE_MS, ease: APP_EASE_OUT },
  closing: { scale: 0.92, lift: 10, opacity: 0, ms: CLOSE_MS, ease: APP_EASE_IN },
  minimized: { scale: 0.84, lift: 36, opacity: 0, ms: MIN_MS, ease: APP_EASE_IN },
};

function readGeom(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (saved && [saved.x, saved.y, saved.w, saved.h].every(Number.isFinite)) {
      return saved;
    }
  } catch {
    /* fall back to the default spot */
  }
  return null;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

function clampGeom(g, box) {
  const w = Math.min(Math.max(g.w, MIN_W), Math.max(box.w, MIN_W));
  const h = Math.min(Math.max(g.h, MIN_H), Math.max(box.h, MIN_H));
  return {
    w,
    h,
    // The body may hang off either side and run past the bottom of the
    // desktop; only the title bar is held back, at the top of the dock strip.
    x: clamp(g.x, KEEP_VISIBLE - w, box.w - KEEP_VISIBLE),
    y: clamp(g.y, 0, box.h - DOCK_CLEAR),
  };
}

/** Drag one or two edges of `base` by (dx, dy), leaving the opposite edges
 *  pinned — so pulling the left edge grows the window leftward instead of
 *  sliding it. `mode` is a compass string ("n", "se", …); the letters it
 *  contains are the edges being dragged.
 *
 *  An edge can be pulled outward as far as the desktop's matching edge — dock
 *  strip included — and always inward to the window's minimum. A window that
 *  was dragged off the desktop keeps whatever overhang it already has, so
 *  grabbing that edge nudges it rather than snapping it back on screen. */
function resizeGeom(base, mode, dx, dy, box) {
  let left = base.x;
  let top = base.y;
  let right = base.x + base.w;
  let bottom = base.y + base.h;

  if (mode.includes("e")) right = clamp(right + dx, left + MIN_W, Math.max(box.w, right));
  if (mode.includes("w")) left = clamp(left + dx, Math.min(0, left), right - MIN_W);
  if (mode.includes("s")) bottom = clamp(bottom + dy, top + MIN_H, Math.max(box.h, bottom));
  if (mode.includes("n")) top = clamp(top + dy, Math.min(0, top), bottom - MIN_H);

  return { x: left, y: top, w: right - left, h: bottom - top };
}

export default function DesktopAppWindow({
  title,
  icon: Icon,
  storageKey,
  width = 720,
  height = 620,
  // Nth simultaneously-open window: staggers the default spot, macOS style.
  cascade = 0,
  active = true,
  // Off on another studio tab: gone at once, with no motion to play to an
  // audience that isn't looking at the desktop.
  hidden = false,
  // Sent to the dock: drops away, and rises back when it's picked up again.
  minimized = false,
  // The wallpaper was clicked: slide out of the way and let the desktop
  // through, holding position so the next click can bring the window back.
  peeked = false,
  // No title bar: the hosted page draws its own top row (the Browser's tab
  // strip), traffic lights and all, and drives the window through `controls`.
  chromeless = false,
  // Ref handed the window's title-bar actions, for a chromeless page that
  // can't reach them any other way (native views paint above the renderer).
  controls,
  // Zoom runs to the desktop's bottom edge, dock strip included. Used by the
  // Browser (native views already paint above the dock) and by installed apps
  // (the host raises this window above the dock while it's zoomed).
  zoomCoversDock = false,
  // Fired with true/false as the window zooms and restores (and false on
  // unmount). The Studio uses it to hide the dock while the Browser is
  // full-screen — the native page covers the strip, but the React parts of
  // the window (the agent rail) sit under the dock's z-30 and had it poking
  // through them. Installed apps / file windows use the same hook to lift
  // the window layer over the strip.
  onZoomChange,
  // Exit Split View by filling this window — zoom it to the desktop as soon
  // as it's shown again.
  fill = false,
  onFillEnd,
  z = 1,
  onFocus,
  onClose,
  onMinimize,
  onTile,
  onSnapHint,
  // Fired after every geometry change (drag, resize, zoom, reclamp). The
  // Browser window uses it to move its native Electron views with the frame.
  onGeometry,
  // True while an open/close/minimize animation is playing. Native views
  // can't be scaled by CSS, so the Browser window undocks its own for the
  // duration and docks them again once the frame is at rest.
  onAnimating,
  children,
}) {
  const winRef = useRef(null);
  const gestureRef = useRef(null);
  const snapHintRef = useRef(null);
  const snapZoneRef = useRef(null);
  const snapHoldTimer = useRef(0);
  const onSnapHintRef = useRef(onSnapHint);
  onSnapHintRef.current = onSnapHint;
  const [geom, setGeom] = useState(null);
  const [zoomed, setZoomed] = useState(false);
  // Desktop width, for working out which side is nearer to slide off toward.
  const [parentW, setParentW] = useState(0);
  const restoreRef = useRef(null);
  const [skipMotion] = useState(prefersReducedMotion);
  const [entered, setEntered] = useState(skipMotion);
  const [closing, setClosing] = useState(false);
  const [settling, setSettling] = useState(false);
  const closeTimer = useRef(0);

  const parentBox = () => {
    const p = winRef.current?.offsetParent;
    return p ? { w: p.clientWidth, h: p.clientHeight } : null;
  };

  const persist = (g) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(g));
    } catch {
      /* geometry just won't persist */
    }
  };

  // Before paint: an unplaced frame sits at the desktop's top-left corner, and
  // anything anchored to it (the Browser's native views) would flash there.
  useLayoutEffect(() => {
    const box = parentBox();
    if (!box) return;
    const saved = readGeom(storageKey);
    const base =
      saved || {
        w: width,
        h: height,
        x: Math.round((box.w - width) / 2) + cascade * 30,
        y: Math.round((box.h - DOCK_CLEAR - height) / 2) + cascade * 30,
      };
    setParentW(box.w);
    setGeom(clampGeom(base, box));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Anything anchored to the frame from outside the DOM (native views) has to
  // be told where it moved, after the browser has laid the new geometry out.
  useEffect(() => {
    if (geom) onGeometry?.(geom);
  }, [geom, hidden, onGeometry]);

  // The peek slide is a CSS transition, so `geom` never changes and nothing
  // anchored from outside the DOM hears about it. Walk those views along the
  // animation by hand, otherwise the Browser's page snaps in a frame late.
  useEffect(() => {
    if (!onGeometry || !geom) return undefined;
    let raf = 0;
    const until = performance.now() + PEEK_MS + 60;
    const tick = () => {
      onGeometry(geom);
      if (performance.now() < until) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peeked]);

  const zoomedRef = useRef(zoomed);
  zoomedRef.current = zoomed;
  const coversRef = useRef(zoomCoversDock);
  coversRef.current = zoomCoversDock;

  // Keep the window inside the desktop when the studio window resizes or
  // goes full screen.
  useEffect(() => {
    const p = winRef.current?.offsetParent;
    if (!p || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const box = { w: p.clientWidth, h: p.clientHeight };
      setParentW(p.clientWidth);
      setGeom((g) => {
        if (!g) return g;
        if (zoomedRef.current) return zoomedGeom(box, coversRef.current);
        return clampGeom(g, box);
      });
    });
    ro.observe(p);
    return () => ro.disconnect();
  }, []);

  // ── Open / close / minimize motion ──────────────────────────────────────
  // `geom` lands before the first paint, so the frame is already in the right
  // place when it starts its way in; the entry stage holds it small and clear
  // for one painted frame, then hands over to the transition.
  const gone = hidden || !geom;
  const stage = closing
    ? "closing"
    : !geom || !entered
      ? "entering"
      : minimized
        ? "minimized"
        : "open";
  const motion = STAGES[stage];
  const ms = skipMotion || gone ? 0 : motion.ms;

  useLayoutEffect(() => {
    if (skipMotion) return undefined;
    // Paint the entry pose, force a layout so the transition has a from-state,
    // then flip to `open` on the next frames.
    void winRef.current?.offsetWidth;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [skipMotion]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!hidden) return undefined;
    clearTimeout(closeTimer.current);
    setClosing(false);
    return undefined;
  }, [hidden]);

  useLayoutEffect(() => {
    if (!fill || hidden || !geom) return;
    const box = parentBox();
    if (!box) return;
    if (!zoomed) {
      restoreRef.current = geom;
      setZoomed(true);
    }
    const next = zoomedGeom(box, zoomCoversDock);
    setGeom((g) =>
      g && g.x === next.x && g.y === next.y && g.w === next.w && g.h === next.h ? g : next,
    );
  }, [fill, hidden, zoomCoversDock, geom, zoomed]);

  // The close click plays the exit first and only then tells the desktop to
  // drop the window — unmounting on the click would cut the animation off.
  const requestClose = () => {
    if (closing) return;
    if (skipMotion) {
      onClose?.();
      return;
    }
    setClosing(true);
    closeTimer.current = setTimeout(() => onClose?.(), CLOSE_MS);
  };

  // A stage change starts a transition; the window is settled once it has run
  // its course. Only the stage may start the clock — a trip to another studio
  // tab and back changes the timings but plays no animation.
  const msRef = useRef(ms);
  msRef.current = ms;
  // The clock has to start during the render the stage changed in, not in the
  // effect below. `busy` is read while rendering, so an effect leaves one whole
  // render of it saying "at rest" at the exact moment a transition begins —
  // and coming back from minimized that render is the first one, because the
  // previous stage finished settling long ago. Whatever the desktop anchors to
  // this frame acted on it: the Browser docked its native views on screen at
  // full opacity, undocked them a frame later for the animation that had only
  // just started, then docked them again at the end of it.
  const [settleStage, setSettleStage] = useState(stage);
  if (settleStage !== stage) {
    setSettleStage(stage);
    setSettling(ms > 0);
  }
  useEffect(() => {
    const wait = msRef.current;
    if (!wait) {
      setSettling(false);
      return undefined;
    }
    setSettling(true);
    const t = setTimeout(() => setSettling(false), wait);
    return () => clearTimeout(t);
  }, [stage]);

  // Zoom state is this component's own; anything outside that reacts to it
  // (the dock hiding under a full-screen Browser) hears about it here — and
  // hears "restored" when the window unmounts, so a close while zoomed can
  // never leave the dock hidden.
  const zoomChangeRef = useRef(onZoomChange);
  zoomChangeRef.current = onZoomChange;
  useEffect(() => {
    zoomChangeRef.current?.(zoomed);
  }, [zoomed]);
  useEffect(() => () => zoomChangeRef.current?.(false), []);

  // Anything the desktop anchors to this frame from outside the DOM has to sit
  // the animation out: a CSS scale doesn't carry native views with it, and the
  // rect they'd measure mid-flight is the wrong one.
  const animatingRef = useRef(onAnimating);
  animatingRef.current = onAnimating;
  const busy = stage !== "open" || settling;
  useEffect(() => {
    animatingRef.current?.(busy);
  }, [busy]);
  useEffect(() => () => animatingRef.current?.(false), []);

  const zoomCbRef = useRef(onZoomChange);
  zoomCbRef.current = onZoomChange;
  const covering =
    zoomCoversDock && zoomed && !hidden && !minimized && !closing && !peeked;
  useEffect(() => {
    zoomCbRef.current?.(covering);
  }, [covering]);
  useEffect(() => () => zoomCbRef.current?.(false), []);

  const clearSnapHold = () => {
    clearTimeout(snapHoldTimer.current);
    snapHoldTimer.current = 0;
  };

  const publishSnapHint = (hint) => {
    if (snapHintRef.current === hint) return;
    snapHintRef.current = hint;
    onSnapHintRef.current?.(hint);
  };

  const updateSnapFromGesture = (g) => {
    if (g.mode !== "move") return;
    const zone = snapZoneFor(g.last, g.box);
    if (zone === snapZoneRef.current) return;
    snapZoneRef.current = zone;
    clearSnapHold();
    publishSnapHint(null);
    if (!zone) return;
    snapHoldTimer.current = setTimeout(() => {
      if (snapZoneRef.current === zone) publishSnapHint(zone);
    }, SNAP_HOLD_MS);
  };

  useEffect(
    () => () => {
      clearTimeout(snapHoldTimer.current);
      onSnapHintRef.current?.(null);
    },
    [],
  );

  const startGesture = (mode) => (e) => {
    if (e.button !== 0 || zoomed || !geom) return;
    const box = parentBox();
    if (!box) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    gestureRef.current = {
      mode,
      box,
      base: geom,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      last: null,
    };
  };

  const moveGesture = (e) => {
    const g = gestureRef.current;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) < 3) return;
    g.moved = true;
    const b = g.base;
    g.last =
      g.mode === "move"
        ? clampGeom({ ...b, x: b.x + dx, y: b.y + dy }, g.box)
        : resizeGeom(b, g.mode, dx, dy, g.box);
    setGeom(g.last);
    updateSnapFromGesture(g);
  };

  const endGesture = () => {
    const g = gestureRef.current;
    gestureRef.current = null;
    const armed = snapHintRef.current;
    clearSnapHold();
    snapZoneRef.current = null;
    publishSnapHint(null);
    if (!g?.last) return;
    if (g.mode === "move" && onTile && (armed === "left" || armed === "right")) {
      onTile(armed);
      return;
    }
    persist(g.last);
  };

  const toggleZoom = () => {
    const box = parentBox();
    if (!box) return;
    onFocus?.(); // the traffic lights swallow the frame's own focus click

    if (zoomed) {
      const back = restoreRef.current;
      setZoomed(false);
      onFillEnd?.();
      if (back) setGeom(clampGeom(back, box));
      return;
    }
    restoreRef.current = geom;
    setZoomed(true);
    setGeom(zoomedGeom(box, zoomCoversDock));
  };

  // A chromeless page draws its own title bar out in a native view, where the
  // pointer never reaches React — hand it the actions the traffic lights and
  // the drag handle would have run. Rebuilt each render so the closures it
  // holds see the current geometry.
  useEffect(() => {
    if (!controls) return undefined;
    controls.current = {
      close: requestClose,
      minimize: () => onMinimize?.(),
      zoom: toggleZoom,
      tileLeft: () => onTile?.("left"),
      tileRight: () => onTile?.("right"),
      tileQuad: () => onTile?.("quad"),
      dragStart: () => {
        const box = parentBox();
        if (zoomed || !geom || !box) return;
        gestureRef.current = { mode: "move", box, base: geom, moved: true, last: null };
      },
      dragBy: (dx, dy) => {
        const g = gestureRef.current;
        if (!g) return;
        g.last = clampGeom({ ...g.base, x: g.base.x + dx, y: g.base.y + dy }, g.box);
        setGeom(g.last);
        updateSnapFromGesture(g);
      },
      dragEnd: endGesture,
    };
    return () => {
      controls.current = null;
    };
  });

  // Peeked windows slide clear off whichever edge they're nearer, the way
  // macOS sweeps them aside to reveal the wallpaper. Position stays in `geom`,
  // so letting the transform go puts every window back exactly where it was.
  const peekShift = (() => {
    if (!peeked || !geom || !parentW) return 0;
    const offLeft = -(geom.x + geom.w + 24);
    const offRight = parentW - geom.x + 24;
    return geom.x + geom.w / 2 < parentW / 2 ? offLeft : offRight;
  })();

  return (
    <div
      ref={winRef}
      role="dialog"
      aria-label={title}
      onPointerDown={() => onFocus?.()}
      style={{
        ...NO_DRAG,
        left: geom?.x ?? 0,
        top: geom?.y ?? 0,
        width: geom?.w ?? width,
        height: geom?.h ?? height,
        zIndex: z,
        // Anchors position:fixed inside the hosted page to the window frame.
        transform: `translateZ(0) translateX(${peekShift}px) translateY(${
          motion.lift
        }px) scale(${motion.scale})`,
        transformOrigin: "50% 82%",
        opacity: motion.opacity,
        // A window on another tab is hidden outright rather than faded, so it
        // comes back the instant the desktop does. Minimized ones fall away
        // first and only then leave the paint, holding the delay below.
        visibility: gone || stage === "minimized" ? "hidden" : "visible",
        transition: ms
          ? `transform ${ms}ms ${motion.ease}, opacity ${Math.round(
              ms * 0.8,
            )}ms ${motion.ease}, visibility 0s linear ${
              stage === "minimized" ? ms : 0
            }ms`
          : "none",
      }}
      className={`group/win absolute flex flex-col overflow-hidden bg-white/85 backdrop-blur-2xl dark:bg-black/55 ${
        zoomed && zoomCoversDock
          ? "rounded-none border-0"
          : "rounded-[1.25rem] border border-black/10 dark:border-white/10"
      } ${
        zoomed && zoomCoversDock
          ? ""
          : active
            ? "shadow-[0_30px_90px_rgba(0,0,0,0.42)]"
            : "shadow-[0_14px_44px_rgba(0,0,0,0.28)]"
      } ${
        gone || peeked || closing || minimized
          ? "pointer-events-none"
          : "pointer-events-auto"
      }`}
    >
      {/* Title bar — traffic lights + centered title, drag handle. Kept short:
          the page below brings its own header, and two tall bars stacked read
          as wasted space. A chromeless page has no bar at all — its own top
          row carries the lights (see `controls`). */}
      {!chromeless && (
        <div
          onPointerDown={startGesture("move")}
          onPointerMove={moveGesture}
          onPointerUp={endGesture}
          onDoubleClick={toggleZoom}
          className="relative flex h-7 flex-shrink-0 touch-none select-none items-center gap-2 px-2.5"
        >
          <TrafficLights
            title={title}
            zoomed={zoomed}
            onClose={requestClose}
            onMinimize={onMinimize}
            onZoom={toggleZoom}
            onTileLeft={onTile ? () => onTile("left") : undefined}
            onTileRight={onTile ? () => onTile("right") : undefined}
            onTileQuad={onTile ? () => onTile("quad") : undefined}
          />
          <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-1.5">
            {Icon && <Icon className="h-3 w-3 text-black/40 dark:text-white/40" />}
            <span className="text-[0.68rem] font-medium text-black/55 dark:text-white/55">
              {title}
            </span>
          </div>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>

      {/* Resize grips: every edge and corner, like a real window. They sit
          last so they take the pointer ahead of the title bar's move handler
          and the page underneath. */}
      {!zoomed &&
        RESIZE_GRIPS.map(({ mode, className }) => (
          <Grip
            key={mode}
            onDown={startGesture(mode)}
            onMove={moveGesture}
            onUp={endGesture}
            className={className}
          />
        ))}
    </div>
  );
}

/* Edges are 6px bands hugging the frame; corners are 14px squares laid over
 * them. The Browser window insets its native views by the same 6px so these
 * stay grabbable — native views paint above the page and would swallow the
 * pointer otherwise. */
const RESIZE_GRIPS = [
  { mode: "n", className: "top-0 left-3.5 right-3.5 h-1.5 cursor-ns-resize" },
  { mode: "s", className: "bottom-0 left-3.5 right-3.5 h-1.5 cursor-ns-resize" },
  { mode: "w", className: "left-0 top-3.5 bottom-3.5 w-1.5 cursor-ew-resize" },
  { mode: "e", className: "right-0 top-3.5 bottom-3.5 w-1.5 cursor-ew-resize" },
  { mode: "nw", className: "left-0 top-0 h-3.5 w-3.5 cursor-nwse-resize" },
  { mode: "ne", className: "right-0 top-0 h-3.5 w-3.5 cursor-nesw-resize" },
  { mode: "sw", className: "left-0 bottom-0 h-3.5 w-3.5 cursor-nesw-resize" },
  { mode: "se", className: "right-0 bottom-0 h-3.5 w-3.5 cursor-nwse-resize" },
];

function Grip({ onDown, onMove, onUp, className }) {
  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      className={`absolute touch-none ${className}`}
    />
  );
}
