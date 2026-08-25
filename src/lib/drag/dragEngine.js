import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The one engine behind everything you can pick up in LYKN — desktop icons,
 * Files rows, folder tiles.
 *
 * It tracks the pointer instead of using HTML5 drag-and-drop. That API can't
 * tell a drop target what it's carrying until the drop has already happened,
 * fires dragleave every time the cursor crosses a child, hands out a drag
 * image the page can't restyle, and reports coordinates that are useless for
 * "put the icon down exactly here". Every one of those limits had grown its
 * own workaround, and the workarounds fought each other.
 *
 * A pointer drag has none of that: the payload is a plain object, the target
 * under the cursor is whatever `elementFromPoint` says, and a drop knows the
 * pixel it landed on. What it gives up is dragging to and from other apps —
 * which is fine, because Finder drops arrive as real files and are handled
 * separately, by the upload surfaces that want them.
 */

// Slack before a press becomes a drag, so a click can wobble a little.
const THRESHOLD = 4;
// Hovering a folder this long opens it mid-drag, the way Finder springs.
const SPRING_MS = 800;
// Band at a scroller's edge that pulls the list along under the pointer.
const SCROLL_EDGE = 56;
const SCROLL_MAX = 22;

/** Live drop targets, keyed by their element so hit-testing can walk up. */
const zones = new Map();
const watchers = new Set();

let armed = null; // press recorded, still under the threshold
let active = null; // a drag in flight
let ghost = null; // the thing following the cursor
let frame = 0;

const CAPTURE = { capture: true };

/* ── State broadcast ──────────────────────────────────────────────────── */

function state() {
  return { dragging: !!active, copy: !!active?.copy, payload: active?.payload || null };
}

function notify() {
  const next = state();
  for (const fn of [...watchers]) fn(next);
}

/**
 * `{ dragging, copy, payload }` — for surfaces that arm or explain themselves
 * mid-drag. It only changes when a drag starts, ends, or switches to a copy,
 * so reading it doesn't put a component on the pointer's render path.
 */
export function useDragState() {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    const fn = (next) => setSnapshot(next);
    watchers.add(fn);
    return () => {
      watchers.delete(fn);
    };
  }, []);
  return snapshot;
}

/** What's being dragged right now, or null. Read-only. */
export function peekDrag() {
  return active?.payload || null;
}

/* ── Drop zones ───────────────────────────────────────────────────────── */

/**
 * Register an element as somewhere a drag can land.
 *
 * `accept` decides, from the payload, whether this zone wants the drop —
 * a zone that says no is invisible to the drag, so the drop falls through to
 * whatever is behind it. That's how a folder tile can refuse itself and still
 * let the folder view underneath take the drop.
 *
 * `copies` marks a zone that takes a copy of what it's given rather than
 * moving it — the chat bar attaching a file, not a folder swallowing it. The
 * drag wears the same green "+" it wears for an Option-drag while such a zone
 * is under the cursor, so the badge means one thing everywhere: what you're
 * carrying stays where it is.
 *
 * `dwell` is how long the pointer must rest on the zone before it counts at
 * all — see `pickZone`. Zones whose drop changes something on disk ask for it;
 * zones that only rearrange pixels don't.
 *
 * @param {{
 *   accept?: (payload: any) => boolean,
 *   onDrop?: (payload: any) => void | Promise<void>,
 *   onHoverOpen?: () => void,
 *   copies?: boolean | ((payload: any) => boolean),
 *   disabled?: boolean,
 *   dwell?: number,
 * }} [spec]
 * @returns {{ ref: (el: any) => void, hot: boolean }}
 */
export function useDropZone({
  accept,
  onDrop,
  onHoverOpen,
  copies = false,
  disabled = false,
  dwell = 0,
} = {}) {
  const [hot, setHot] = useState(false);
  const spec = useRef(null);
  spec.current = { accept, onDrop, onHoverOpen, copies, disabled, dwell };
  const held = useRef(null);

  const ref = useCallback((el) => {
    if (held.current) {
      zones.delete(held.current);
      held.current = null;
    }
    if (!el) return;
    held.current = el;
    zones.set(el, {
      canDrop: (payload) => {
        const s = spec.current;
        if (s.disabled) return false;
        return s.accept ? s.accept(payload) === true : true;
      },
      springs: () => typeof spec.current.onHoverOpen === "function",
      dwell: () => Number(spec.current.dwell) || 0,
      copies: (payload) => {
        const flag = spec.current.copies;
        return typeof flag === "function" ? flag(payload) === true : flag === true;
      },
      hoverOpen: () => spec.current.onHoverOpen?.(),
      // A drop that throws must not take the drag's clean-up down with it —
      // by the time this runs the engine has already let go of everything.
      drop: (payload) => {
        try {
          Promise.resolve(spec.current.onDrop?.(payload)).catch((err) => {
            console.error("drop failed", err);
          });
        } catch (err) {
          console.error("drop failed", err);
        }
      },
      setHot,
    });
  }, []);

  useEffect(
    () => () => {
      if (held.current) zones.delete(held.current);
    },
    [],
  );

  return { ref, hot };
}

/** The zones at or above `el` that want what's being dragged, innermost first. */
function zoneChain(el) {
  const chain = [];
  let node = el;
  while (node) {
    const zone = zones.get(node);
    if (zone && zone.canDrop(active.payload)) chain.push(zone);
    node = node.parentElement;
  }
  return chain;
}

/**
 * Which zone in `chain` (innermost first) a release at `now` belongs to,
 * given that the innermost one has been under the pointer since `since`.
 *
 * Normally it's simply the innermost. A zone can ask to be dwelled on first,
 * though, and until the pointer has actually rested there the drop belongs to
 * the first zone behind it that doesn't ask.
 *
 * That gate is what separates "carry these somewhere" from "put these inside
 * that". Dragging a group of icons across the desktop sweeps the pointer over
 * whatever folders lie between here and there, and without it, letting go a
 * frame too early over one of them files the whole selection away instead of
 * rearranging it. Only the innermost zone can be waited out, so a folder
 * buried under the cursor can never arm on a dwell the user spent elsewhere.
 */
export function pickZone(chain, since, now) {
  const top = chain[0] || null;
  for (const zone of chain) {
    const dwell = zone.dwell();
    if (!dwell) return zone;
    if (zone === top && now - since >= dwell) return zone;
  }
  return null;
}

/**
 * Where a release right this instant would land. The dwell clock restarts
 * whenever the innermost zone changes, so crossing a folder never accumulates
 * toward arming it.
 */
function resolveZone(under) {
  const chain = zoneChain(under);
  const top = chain[0] || null;
  if (top !== active.candidate) {
    active.candidate = top;
    active.candidateAt = performance.now();
  }
  return pickZone(chain, active.candidateAt, performance.now());
}

/* ── Starting a drag ──────────────────────────────────────────────────── */

/**
 * Arm a press. Nothing happens until the pointer actually moves, so a plain
 * click still reaches the element's own onClick / onDoubleClick.
 *
 * `make()` runs at that moment rather than now, so it can measure where the
 * icons are once the user has committed to dragging them. It returns:
 *   paths     absolute paths being carried
 *   iconIds   desktop icons riding along, if the drag started on the desktop
 *   bases     those icons' positions at pick-up, for a rearrange drop
 *   elements  what to draw under the cursor
 *   source    a label for drop targets that care where this came from
 *   sourceDir the folder the items were sitting in
 */
export function armDrag(event, make) {
  if (active) return;
  if (event.button != null && event.button !== 0) return;
  if (typeof event.pointerId !== "number") return;
  armed = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    make,
  };
  bind();
}

function begin(event) {
  const spec = armed.make?.(event);
  const paths = (spec?.paths || []).filter(Boolean);
  const iconIds = spec?.iconIds || [];
  if (!paths.length && !iconIds.length) return false;

  const elements = (spec.elements || []).filter((el) => el?.isConnected);
  active = {
    pointerId: armed.pointerId,
    x: event.clientX,
    y: event.clientY,
    copy: !!event.altKey,
    altCopy: !!event.altKey,
    zoneCopy: false,
    offX: 0,
    offY: 0,
    zone: null,
    candidate: null,
    candidateAt: 0,
    hotAt: 0,
    sprung: false,
    sources: elements,
    payload: {
      paths,
      iconIds,
      bases: spec.bases || null,
      grabX: armed.startX,
      grabY: armed.startY,
      source: spec.source || "",
      sourceDir: spec.sourceDir || null,
    },
  };
  armed = null;

  // Same wedge-proofing as tick(): a throw while standing the drag up (say,
  // cloning an element HMR just detached) must not leave `active` set with
  // no frame loop behind it.
  try {
    buildGhost(elements, Math.max(paths.length, iconIds.length));
    for (const el of elements) el.setAttribute("data-drag-source", "");
    document.body.classList.add("lykn-dragging");
    frame = requestAnimationFrame(tick);
    notify();
  } catch {
    teardown();
    return false;
  }
  return true;
}

/** Abandon the drag without dropping — Escape, or a cancelled pointer. */
export function cancelDrag() {
  if (active) teardown();
}

/* ── The drag itself ──────────────────────────────────────────────────── */

function tick() {
  frame = 0;
  if (!active) return;
  // A throw anywhere in the frame (a zone callback whose component was just
  // hot-swapped, a hover-open handler crashing) must tear the drag down, not
  // strand `active` set forever — armDrag refuses to start while a drag is
  // "in flight", so a stranded one silently kills every future drag until
  // the page reloads.
  try {
    moveGhost();
    // One hit test a frame, shared: what's under the cursor decides both the
    // drop target and which list should scroll.
    const under = document.elementFromPoint(active.x, active.y);
    hitTest(under);
    spring();
    autoScroll(under);
  } catch {
    teardown();
    return;
  }
  frame = requestAnimationFrame(tick);
}

function hitTest(under) {
  const zone = resolveZone(under);
  if (zone === active.zone) return;
  active.zone?.setHot(false);
  active.zone = zone;
  // Spring counts from when the pointer arrived rather than from when the zone
  // armed, so waiting out a dwell isn't also charged against the hover-open.
  active.hotAt = zone?.springs()
    ? zone === active.candidate
      ? active.candidateAt
      : performance.now()
    : 0;
  active.sprung = false;
  zone?.setHot(true);
  setZoneCopy(zone?.copies?.(active.payload) === true);
}

function spring() {
  if (!active.hotAt || active.sprung) return;
  if (performance.now() - active.hotAt < SPRING_MS) return;
  active.sprung = true;
  active.zone?.hoverOpen();
}

function scrollerFrom(el) {
  let node = el;
  while (node && node !== document.body) {
    if (node.scrollHeight > node.clientHeight + 2) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === "auto" || overflow === "scroll") return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** Dragging to the edge of a list pulls it along, so a long folder is reachable. */
function autoScroll(under) {
  const el = scrollerFrom(under);
  if (!el) return;
  const box = el.getBoundingClientRect();
  const fromTop = active.y - box.top;
  const fromBottom = box.bottom - active.y;
  if (fromTop < SCROLL_EDGE) {
    el.scrollTop -= Math.ceil(((SCROLL_EDGE - fromTop) / SCROLL_EDGE) * SCROLL_MAX);
  } else if (fromBottom < SCROLL_EDGE) {
    el.scrollTop += Math.ceil(((SCROLL_EDGE - fromBottom) / SCROLL_EDGE) * SCROLL_MAX);
  }
}

/**
 * Two things can make a drag a copy — the Option key, and a zone that adds
 * rather than moves — so each is tracked on its own and the badge reflects
 * either. Releasing Option over the chat bar still attaches a copy.
 */
function syncCopy() {
  const next = active.altCopy || active.zoneCopy;
  if (active.copy === next) return;
  active.copy = next;
  ghost?.classList.toggle("is-copy", next);
  notify();
}

function setAltCopy(next) {
  if (active.altCopy === next) return;
  active.altCopy = next;
  syncCopy();
}

function setZoneCopy(next) {
  if (active.zoneCopy === next) return;
  active.zoneCopy = next;
  syncCopy();
}

/* ── What follows the cursor ──────────────────────────────────────────── */

/**
 * A clone still carries the attributes the rest of the app searches the
 * document by, and a duplicate would answer those queries as if it were the
 * real thing. Strip them so the ghost is only ever a picture.
 */
const CLONE_ATTRS = ["id", "data-desktop-icon", "data-desktop-path", "data-entry-path", "data-drag-source"];

function scrub(el) {
  for (const attr of CLONE_ATTRS) el.removeAttribute?.(attr);
  for (const child of el.querySelectorAll?.(CLONE_ATTRS.map((a) => `[${a}]`).join(",")) || []) {
    for (const attr of CLONE_ATTRS) child.removeAttribute(attr);
  }
}

function buildGhost(elements, count) {
  ghost = document.createElement("div");
  ghost.className = "lykn-drag-ghost";
  ghost.setAttribute("aria-hidden", "true");

  const primary = elements[0];
  if (primary) {
    const anchor = primary.getBoundingClientRect();
    // Keep the grab point: the thing stays where the fingers landed on it, and
    // a drop that has to place an icon can put it exactly where the ghost was.
    active.offX = anchor.left - active.payload.grabX;
    active.offY = anchor.top - active.payload.grabY;
    active.payload.offsetX = active.offX;
    active.payload.offsetY = active.offY;

    // Up to three, back of the stack first, fanned like a Finder drag.
    const stack = elements.slice(0, 3);
    for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
      const box = stack[depth].getBoundingClientRect();
      const clone = stack[depth].cloneNode(true);
      scrub(clone);
      clone.style.setProperty("position", "absolute");
      clone.style.setProperty("left", `${depth * 7}px`);
      clone.style.setProperty("top", `${depth * 7}px`);
      clone.style.setProperty("width", `${box.width}px`);
      clone.style.setProperty("height", `${box.height}px`);
      clone.style.setProperty("margin", "0");
      clone.style.setProperty("transform", "none");
      clone.style.setProperty("opacity", "1");
      ghost.appendChild(clone);
    }
  }

  if (count > 1) {
    const badge = document.createElement("span");
    badge.className = "lykn-drag-ghost-count";
    badge.textContent = String(count);
    ghost.appendChild(badge);
  }

  const plus = document.createElement("span");
  plus.className = "lykn-drag-ghost-copy";
  plus.textContent = "+";
  ghost.appendChild(plus);

  ghost.classList.toggle("is-copy", active.copy);
  document.body.appendChild(ghost);
  moveGhost();
}

function moveGhost() {
  if (!ghost) return;
  ghost.style.transform = `translate3d(${active.x + active.offX}px, ${active.y + active.offY}px, 0)`;
}

/* ── Pointer plumbing ─────────────────────────────────────────────────── */

function bind() {
  window.addEventListener("pointermove", onMove, CAPTURE);
  window.addEventListener("pointerup", onUp, CAPTURE);
  window.addEventListener("pointercancel", onAbort, CAPTURE);
  window.addEventListener("keydown", onKey, CAPTURE);
  window.addEventListener("keyup", onKey, CAPTURE);
}

function unbind() {
  window.removeEventListener("pointermove", onMove, CAPTURE);
  window.removeEventListener("pointerup", onUp, CAPTURE);
  window.removeEventListener("pointercancel", onAbort, CAPTURE);
  window.removeEventListener("keydown", onKey, CAPTURE);
  window.removeEventListener("keyup", onKey, CAPTURE);
}

function onMove(event) {
  if (active) {
    if (event.pointerId !== active.pointerId) return;
    active.x = event.clientX;
    active.y = event.clientY;
    setAltCopy(!!event.altKey);
    event.preventDefault();
    return;
  }
  if (!armed || event.pointerId !== armed.pointerId) return;
  const far =
    Math.hypot(event.clientX - armed.startX, event.clientY - armed.startY) >= THRESHOLD;
  if (!far) return;
  if (!begin(event)) {
    armed = null;
    unbind();
    return;
  }
  event.preventDefault();
}

function onUp(event) {
  if (!active) {
    if (armed && event.pointerId !== armed.pointerId) return;
    armed = null;
    unbind();
    return;
  }
  if (event.pointerId !== active.pointerId) return;
  active.x = event.clientX;
  active.y = event.clientY;
  setAltCopy(!!event.altKey);
  // The pointer can have moved since the last frame, so settle on the target
  // under the release rather than the one the last tick saw. If the hit test
  // blows up (zone owner unmounted this instant), fall back to the last
  // target the frame loop saw rather than losing the whole release.
  try {
    hitTest(document.elementFromPoint(active.x, active.y));
  } catch {
    /* keep active.zone as the last frame left it */
  }

  const zone = active.zone;
  const payload = { ...active.payload, x: active.x, y: active.y, copy: active.copy };
  teardown();
  // The browser still delivers a click for the press that started this drag.
  swallowClick();
  zone?.drop(payload);
}

function onAbort(event) {
  if (active && event.pointerId !== active.pointerId) return;
  if (!active) {
    armed = null;
    unbind();
    return;
  }
  teardown();
}

function onKey(event) {
  if (!active) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    teardown();
    return;
  }
  if (event.key === "Alt" || event.altKey !== active.altCopy) setAltCopy(!!event.altKey);
}

/**
 * One click, eaten, so a drag never also counts as opening the thing. The
 * browser delivers it in the same batch as the pointerup that ended the drag,
 * which is what the timeout is timed against — a real click a moment later
 * still gets through.
 */
function swallowClick() {
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.removeEventListener("click", stop, CAPTURE);
  };
  window.addEventListener("click", stop, CAPTURE);
  setTimeout(() => window.removeEventListener("click", stop, CAPTURE), 0);
}

function teardown() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  active?.zone?.setHot(false);
  for (const el of active?.sources || []) el.removeAttribute?.("data-drag-source");
  ghost?.remove();
  ghost = null;
  active = null;
  armed = null;
  document.body.classList.remove("lykn-dragging");
  unbind();
  notify();
}
