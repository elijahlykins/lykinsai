/*
 * LYKN injected runtime.
 *
 * Installed at document start into an ISOLATED WKContentWorld, in every frame
 * (`forMainFrameOnly: false`). Everything the agent knows about a page, and
 * every JS-synthetic action it performs, goes through this file.
 *
 * Ported from the script builders in electron/ownedBrowserAct.cjs
 * (COLLECT_INTERACTABLES_JS, EXTRACT_PAGE_CONTEXT_JS, COLLECT_FRAME_RECTS_JS,
 * buildResolvePointJs, buildActionJs, buildScrollElementJs, buildHtml5DragJs)
 * plus the replace_text script from browser/controller.cjs.
 *
 * Two things are new, and both are things the Electron build could not do:
 *
 *   1. Native references are captured before any page script runs, so a page
 *      that overwrites Array.prototype.map or getBoundingClientRect cannot
 *      corrupt the agent's view of itself. Electron's executeJavaScript ran in
 *      the page world and had no such protection.
 *   2. The frame handshake. WebKit exposes no way to enumerate a page's frames
 *      (no framesInSubtree, no Page.getFrameTree), so each frame announces
 *      itself here with a minted token and the native side caches the
 *      WKFrameInfo against it.
 */
"use strict";

(function () {
  if (globalThis.__lykn && globalThis.__lykn.__installed) return;

  // ── Tamper-proof natives ──────────────────────────────────────────────────
  // Captured now, while the document is still empty and no page script has
  // run. Every helper below uses these rather than the live globals.
  var N = {
    Object: Object,
    Array: Array,
    JSON: JSON,
    Math: Math,
    String: String,
    Number: Number,
    Set: Set,
    Map: Map,
    Date: Date,
    Promise: Promise,
    getBoundingClientRect: Element.prototype.getBoundingClientRect,
    // MUST be bound. Captured bare, `this` becomes this object rather than the
    // window and WebKit throws "Can only call Window.getComputedStyle on
    // instances of Window" — which silently emptied every catalog until a live
    // run caught it. The Element/Document prototype methods below are fine
    // unbound because they are always invoked with an explicit `.call(node)`.
    getComputedStyle: window.getComputedStyle.bind(window),
    querySelector: Document.prototype.querySelector,
    querySelectorAll: Document.prototype.querySelectorAll,
    elQuerySelector: Element.prototype.querySelector,
    elQuerySelectorAll: Element.prototype.querySelectorAll,
    getAttribute: Element.prototype.getAttribute,
    elementFromPoint: Document.prototype.elementFromPoint,
    closest: Element.prototype.closest,
    contains: Node.prototype.contains,
    dispatchEvent: EventTarget.prototype.dispatchEvent,
    addEventListener: EventTarget.prototype.addEventListener,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    rAF: (window.requestAnimationFrame || function (f) { return window.setTimeout(f, 16); }).bind(window),
    now: (window.performance && window.performance.now
      ? window.performance.now.bind(window.performance)
      : function () { return Date.now(); })
  };

  function rect(el) { return N.getBoundingClientRect.call(el); }
  function style(el) { return N.getComputedStyle(el); }
  function attr(el, name) { try { return N.getAttribute.call(el, name); } catch (e) { return null; } }
  function qsa(root, sel) {
    try {
      return (root === document ? N.querySelectorAll : N.elQuerySelectorAll).call(root, sel);
    } catch (e) { return []; }
  }
  function qs(root, sel) {
    try {
      return (root === document ? N.querySelector : N.elQuerySelector).call(root, sel);
    } catch (e) { return null; }
  }

  var VIEW_W = function () { return window.innerWidth || 1200; };
  var VIEW_H = function () { return window.innerHeight || 800; };

  // ── Frame identity ────────────────────────────────────────────────────────
  // WebKit hands WKFrameInfo to the native side only through delegate and
  // message callbacks, and those objects are snapshots rather than stable
  // handles. Each frame therefore mints a token here and announces it; the
  // native FrameRegistry caches the accompanying WKFrameInfo against it and
  // re-keys on every navigation, because a stale WKFrameInfo errors the
  // evaluation rather than silently missing.
  var FRAME_TOKEN =
    "f" +
    N.Math.random().toString(36).slice(2, 10) +
    N.Date.now().toString(36);

  var isMainFrame = false;
  try { isMainFrame = window.top === window; } catch (e) { isMainFrame = false; }

  function post(handler, payload) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers[handler]) {
        window.webkit.messageHandlers[handler].postMessage(payload);
      }
    } catch (e) { /* handler not installed on this world */ }
  }

  function announceFrame() {
    post("lyknFrame", {
      token: FRAME_TOKEN,
      url: location.href,
      isMain: isMainFrame,
      at: N.Date.now()
    });
  }

  // ── Shared element helpers ────────────────────────────────────────────────

  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    var r = rect(el);
    if (r.width < 2 || r.height < 2) return false;
    var st = style(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  function clickable(el) {
    if (!visible(el)) return false;
    return style(el).pointerEvents !== "none";
  }

  function labelOf(el) {
    var raw =
      attr(el, "aria-label") ||
      attr(el, "alt") ||
      attr(el, "title") ||
      el.innerText ||
      el.placeholder ||
      el.name ||
      el.id ||
      "";
    return ("" + raw).replace(/\s+/g, " ").trim();
  }

  /**
   * Topmost element at a viewport point, descending through open shadow roots.
   *
   * The synthetic backend bypasses the compositor, so it has to do its own hit
   * testing or it will happily "click" something an overlay covers.
   * document.elementFromPoint stops at a shadow host, so recurse.
   */
  function topmostAt(x, y) {
    var el = null;
    try { el = N.elementFromPoint.call(document, x, y); } catch (e) { return null; }
    var guard = 0;
    while (el && el.shadowRoot && guard++ < 12) {
      var inner = null;
      try { inner = el.shadowRoot.elementFromPoint(x, y); } catch (e) { inner = null; }
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  /** Does a hit at (x,y) land on `el`, its subtree, or its shadow content? */
  function hitTest(el, x, y) {
    var hit = topmostAt(x, y);
    if (!hit) return false;
    if (hit === el) return true;
    try { if (N.contains.call(el, hit)) return true; } catch (e) {}
    try { if (N.contains.call(hit, el)) return true; } catch (e) {}
    // Shadow content reports its host as the composed target.
    try {
      var host = hit.getRootNode && hit.getRootNode().host;
      if (host && (host === el || N.contains.call(el, host))) return true;
    } catch (e) {}
    return false;
  }

  /** Stable-ish CSS path, capped at 6 levels. Ported verbatim in behavior. */
  function selectorPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + CSS.escape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      var tag = node.nodeName.toLowerCase();
      if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
      var sib = node;
      var index = 1;
      while ((sib = sib.previousElementSibling)) {
        if (sib.nodeName === node.nodeName) index++;
      }
      parts.unshift(tag + (index > 1 ? ":nth-of-type(" + index + ")" : ""));
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  // ── Catalog ───────────────────────────────────────────────────────────────

  var CATALOG_QUERY =
    "input,textarea,select,button,a[href],img[alt],img[title],picture,canvas," +
    "[contenteditable=true],[role=button],[role=link],[role=searchbox],[role=combobox]," +
    "[role=radio],[role=option],[role=tab],[role=img],[role=row],[role=listitem]," +
    "[role=gridcell],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]," +
    "[role=treeitem],[role=checkbox],[role=switch],[role=textbox],tr,li,figure,label," +
    "input[type=radio],input[type=checkbox],[tabindex],[onclick]";

  var MAX_ITEMS = 170;
  var MAX_ROWISH = 60;

  /**
   * Collection order matters: open dialogs/popovers first (their controls are
   * what the user is interacting with — e.g. Gmail's compose window sits at
   * the END of the DOM and used to fall past the item cap behind 200+ inbox
   * rows), then the rest of the page with repetitive rows capped so long lists
   * can't crowd real controls out of the catalog.
   */
  function collectInteractables() {
    var items = [];
    var seen = new N.Set();
    var vw = VIEW_W();
    var vh = VIEW_H();

    function add(el, inDialog) {
      if (items.length >= MAX_ITEMS || seen.has(el)) return false;
      var r = rect(el);
      if (r.width < 2 || r.height < 2) return false;
      var st = style(el);
      if (st.visibility === "hidden" || st.display === "none" || st.pointerEvents === "none") {
        return false;
      }
      var ti = attr(el, "tabindex");
      if (ti !== null && parseInt(ti, 10) < 0) return false;
      // Anything nested INSIDE a rich-text editor is document content, not UI —
      // and a nested editable region duplicates its parent editor in the
      // catalog (Gmail's body produced two "Message Body" refs; typing went in
      // twice).
      try {
        if (el.parentElement && N.closest.call(el.parentElement, '[contenteditable=true]')) {
          return false;
        }
      } catch (e) {}

      var tag = el.tagName.toLowerCase();
      var type = attr(el, "type") || "";
      var role = attr(el, "role") || "";
      var label = labelOf(el).slice(0, 120);
      if (!label && tag === "img") label = "image";
      if (
        !label &&
        tag !== "input" &&
        tag !== "textarea" &&
        role !== "searchbox" &&
        role !== "textbox" &&
        tag !== "img" &&
        tag !== "canvas" &&
        attr(el, "contenteditable") !== "true"
      ) {
        return false;
      }

      var inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      // Rich-text editors (contenteditable) have no .value — surface their text
      // so the agent can SEE what it already wrote instead of retyping it.
      var value = el.value != null ? el.value : (el.isContentEditable ? (el.innerText || "") : "");
      // A disabled control reads as a normal button; clicking it changes
      // nothing and the agent scores that as its own failure. Say it up front.
      var disabled =
        el.disabled === true ||
        attr(el, "aria-disabled") === "true" ||
        attr(el, "disabled") !== null;
      // Panels, palettes and lists that scroll internally — window.scrollBy
      // does nothing for these, so the agent has to scroll the container.
      var scrollable = false;
      try {
        scrollable =
          (el.scrollHeight - el.clientHeight > 24 || el.scrollWidth - el.clientWidth > 24) &&
          /auto|scroll/.test(st.overflowY + " " + st.overflowX);
      } catch (e) {}

      seen.add(el);
      items.push({
        id: "el" + items.length,
        tag: tag,
        type: type,
        role: role,
        selector: selectorPath(el),
        label: label,
        value: ("" + value).slice(0, 80),
        checked: el.checked === true,
        disabled: disabled,
        scrollable: scrollable,
        href: (el.href || "").slice(0, 200),
        clientX: N.Math.round(r.left + r.width / 2),
        clientY: N.Math.round(r.top + r.height / 2),
        inView: inView,
        inDialog: !!inDialog
      });
      return true;
    }

    var dialogs = qsa(document, "[role=dialog],[role=alertdialog],[aria-modal=true]");
    for (var d = 0; d < dialogs.length; d++) {
      var dels = qsa(dialogs[d], CATALOG_QUERY);
      for (var j = 0; j < dels.length && j < 400; j++) add(dels[j], true);
    }

    var rows = 0;
    var all = qsa(document, CATALOG_QUERY);
    for (var i = 0; i < all.length && i <= 2000; i++) {
      var el = all[i];
      var t2 = el.tagName.toLowerCase();
      var r2 = attr(el, "role") || "";
      var rowish =
        t2 === "tr" || t2 === "li" || r2 === "row" || r2 === "listitem" ||
        r2 === "option" || r2 === "gridcell";
      if (rowish && rows >= MAX_ROWISH) continue;
      if (add(el, false) && rowish) rows++;
    }

    return { url: location.href, title: document.title, items: items, frameToken: FRAME_TOKEN };
  }

  // ── Page text ─────────────────────────────────────────────────────────────

  /**
   * Reads the WHOLE document (not just the viewport) so dashboards, tables and
   * below-the-fold data all land in the scrape. Rendered-but-offscreen content
   * counts; only display:none / visibility:hidden are skipped.
   */
  function extractPageContext() {
    var sp = / +/g;
    function shown(el) {
      if (!el) return false;
      var st = style(el);
      return st.visibility !== "hidden" && st.display !== "none";
    }
    function text(el) {
      return ((attr(el, "aria-label") || el.innerText || el.textContent || "") + "")
        .replace(sp, " ")
        .trim();
    }
    var seen = new N.Set();
    var parts = [];
    var root = qs(document, "main") || qs(document, "[role=main]") || document.body;
    if (!root) return { url: location.href, title: document.title, text: "" };
    var nodes = qsa(
      root,
      "h1,h2,h3,h4,p,li,th,td,dt,dd,label,button,[role=radio],[role=button],[role=heading]," +
        "[role=option],[role=gridcell],[role=cell],[role=columnheader],[role=rowheader],span,div"
    );
    for (var i = 0; i < nodes.length && parts.length < 400; i++) {
      var n = nodes[i];
      if (!shown(n)) continue;
      var t = text(n);
      if (!t || t.length < 2 || seen.has(t)) continue;
      if (t.length > 400 && n.children.length > 2) continue;
      seen.add(t);
      parts.push(t);
    }
    var out = ((document.title || "") + "\n" + parts.join("\n")).replace(sp, " ").trim();
    if (out.length < 600) {
      var raw = ((document.body && document.body.innerText) || "").replace(sp, " ").trim();
      if (raw.length > out.length) out = ((document.title || "") + "\n" + raw).trim();
    }
    return { url: location.href, title: document.title, text: out.slice(0, 16000) };
  }

  /** Lightweight text grab for sub-frames. */
  function extractFrameText() {
    try {
      var t = ((document.body && document.body.innerText) || "").replace(/ +/g, " ").trim();
      return t.slice(0, 8000);
    } catch (e) {
      return "";
    }
  }

  /**
   * A frame can't know where it sits in the top-level viewport (cross-origin
   * blocks walking up to window.parent), but its PARENT can measure the
   * <iframe> element. Run this in each parent to get the rects, then match them
   * to child frames by URL so element coordinates can be offset into page
   * space — that is what makes real input-event clicks land inside embedded
   * editors.
   */
  function collectFrameRects() {
    var out = [];
    try {
      var els = qsa(document, "iframe,frame");
      for (var i = 0; i < els.length && i < 40; i++) {
        var el = els[i];
        var r = rect(el);
        if (r.width < 8 || r.height < 8) continue;
        var st = style(el);
        if (st.visibility === "hidden" || st.display === "none") continue;
        out.push({
          src: (el.src || "") + "",
          name: (attr(el, "name") || "") + "",
          x: N.Math.round(r.left),
          y: N.Math.round(r.top),
          w: N.Math.round(r.width),
          h: N.Math.round(r.height)
        });
      }
    } catch (e) {}
    return out;
  }

  function viewportMetrics() {
    return {
      w: window.innerWidth || 1200,
      h: window.innerHeight || 800,
      cw: (document.documentElement && document.documentElement.clientWidth) || window.innerWidth || 1200,
      ch: (document.documentElement && document.documentElement.clientHeight) || window.innerHeight || 800,
      dpr: window.devicePixelRatio || 1,
      ox: (window.visualViewport && window.visualViewport.offsetLeft) || 0,
      oy: (window.visualViewport && window.visualViewport.offsetTop) || 0
    };
  }

  // ── Point resolution ──────────────────────────────────────────────────────

  var RESOLVE_QUERY =
    "a,button,input,select,textarea,tr,li,img,[role=button],[role=link],[role=row]," +
    "[role=listitem],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio]," +
    "[role=combobox],[role=switch],label,div.zA,tr.zA,[tabindex],[onclick]";

  function pointFor(el) {
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
    var r = rect(el);
    var x = N.Math.round(r.left + r.width / 2);
    var y = N.Math.round(r.top + N.Math.min(r.height / 2, 120));
    x = N.Math.max(1, N.Math.min(x, VIEW_W() - 1));
    y = N.Math.max(1, N.Math.min(y, VIEW_H() - 1));
    return { x: x, y: y, hit: hitTest(el, x, y) };
  }

  /**
   * Re-resolve an element's LIVE position from its selector or label.
   *
   * Catalog coordinates go stale the moment the page scrolls or re-renders, so
   * every action re-resolves before it acts. Snapshot selectors are
   * nth-of-type paths — after an SPA re-render the same path can address a
   * DIFFERENT element, so when we know what label the agent expects, the
   * selector match must still carry it; otherwise fall through to the label
   * search instead of clicking a stranger.
   */
  function resolvePoint(a) {
    a = a || {};
    var want = ("" + (a.label || "")).toLowerCase().replace(/\s+/g, " ").trim();
    var el = a.selector ? qs(document, a.selector) : null;
    if (el && !visible(el)) el = null;

    if (el && want) {
      var lw = labelOf(el).toLowerCase().slice(0, 200);
      if (!lw || !(lw.indexOf(want.slice(0, 60)) > -1 || want.indexOf(lw) > -1)) el = null;
    }
    if (el) {
      var pp = pointFor(el);
      pp.label = labelOf(el).slice(0, 80);
      pp.via = "selector";
      return pp;
    }
    if (!want) return null;

    var nodes = qsa(document, RESOLVE_QUERY);
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var lab = labelOf(n).toLowerCase();
      if (!lab || !visible(n)) continue;
      var score = 0;
      if (lab === want) score = 100;
      else if (lab.indexOf(want) === 0) score = 80;
      else if (lab.indexOf(want) > -1) score = 60 - N.Math.min(40, N.Math.abs(lab.length - want.length));
      else if (want.indexOf(lab) > -1 && lab.length >= 4) score = 40;
      if (score > bestScore) {
        bestScore = score;
        best = n;
        if (score >= 100) break;
      }
    }
    // minLabelScore (strict callers): weak fuzzy matches click unrelated
    // elements — better to fail and let the agent re-observe.
    if (best && bestScore >= (N.Number(a.minLabelScore) || 1)) {
      var pb = pointFor(best);
      pb.label = labelOf(best).slice(0, 80);
      pb.via = "label";
      pb.score = bestScore;
      return pb;
    }
    return null;
  }

  /** Resolve, then report whether the point is obscured — strict-target check. */
  function resolveStrict(a) {
    var pt = resolvePoint(a);
    if (!pt) return { ok: false, error: "element_not_relocated" };
    if (a && a.strictTarget && pt.hit === false) {
      return { ok: false, error: "element_obscured", x: pt.x, y: pt.y, label: pt.label };
    }
    return { ok: true, x: pt.x, y: pt.y, hit: pt.hit !== false, label: pt.label || "", via: pt.via || "" };
  }

  // ── Synthetic input ───────────────────────────────────────────────────────
  //
  // The full sequence a real pointer produces. WebKit's own compositor is
  // bypassed, so anything missing here is simply a thing the page never sees:
  // hover states, focus transfer, and the pointer/mouse pairing that component
  // libraries key off. `isTrusted` is false regardless — see the migration
  // doc §2 for what that costs and NativeEventBackend for the macOS answer.

  var POINTER_ID = 1;

  function mouseInit(x, y, extra) {
    var base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: (window.screenX || 0) + x,
      screenY: (window.screenY || 0) + y,
      button: 0,
      buttons: 0,
      detail: 1
    };
    if (extra) for (var k in extra) if (N.Object.prototype.hasOwnProperty.call(extra, k)) base[k] = extra[k];
    return base;
  }

  function pointerInit(x, y, extra) {
    var init = mouseInit(x, y, extra);
    init.pointerId = POINTER_ID;
    init.pointerType = "mouse";
    init.isPrimary = true;
    init.width = 1;
    init.height = 1;
    init.pressure = init.buttons ? 0.5 : 0;
    return init;
  }

  function fire(el, Ctor, name, init) {
    try {
      var ev = new Ctor(name, init);
      N.dispatchEvent.call(el, ev);
      return ev;
    } catch (e) {
      return null;
    }
  }

  var PointerEventCtor = window.PointerEvent || window.MouseEvent;

  /**
   * A full synthetic click at a viewport point.
   *
   * Hit-tests first: the compositor is not involved, so without this the
   * "click" would land on an element an overlay covers.
   */
  function syntheticClickAt(x, y, opts) {
    opts = opts || {};
    var el = topmostAt(x, y);
    if (!el) return { ok: false, error: "no_element_at_point", x: x, y: y };

    // Hover chain first — component libraries open menus on pointerover and
    // would otherwise never render the thing being clicked.
    fire(el, PointerEventCtor, "pointerover", pointerInit(x, y));
    fire(el, MouseEvent, "mouseover", mouseInit(x, y));
    fire(el, PointerEventCtor, "pointerenter", pointerInit(x, y, { bubbles: false }));
    fire(el, MouseEvent, "mouseenter", mouseInit(x, y, { bubbles: false }));
    fire(el, PointerEventCtor, "pointermove", pointerInit(x, y));
    fire(el, MouseEvent, "mousemove", mouseInit(x, y));

    fire(el, PointerEventCtor, "pointerdown", pointerInit(x, y, { buttons: 1 }));
    fire(el, MouseEvent, "mousedown", mouseInit(x, y, { buttons: 1 }));

    // Focus transfer is part of a real mousedown and several editors depend on
    // it before they will accept input.
    try {
      var focusTarget = el.closest ? N.closest.call(el, "input,textarea,select,[contenteditable=true],[tabindex]") : null;
      (focusTarget || el).focus({ preventScroll: true });
    } catch (e) {}

    fire(el, PointerEventCtor, "pointerup", pointerInit(x, y));
    fire(el, MouseEvent, "mouseup", mouseInit(x, y));
    var clickEv = fire(el, MouseEvent, "click", mouseInit(x, y));

    // Native activation behavior (form submit, link navigation, label
    // forwarding) does not run off a synthetic `click` event, so invoke it —
    // unless a listener already called preventDefault.
    if (!opts.eventsOnly && clickEv && !clickEv.defaultPrevented) {
      try { if (typeof el.click === "function") el.click(); } catch (e) {}
    }

    return {
      ok: true,
      x: x,
      y: y,
      via: "js_synthetic",
      label: labelOf(el).slice(0, 80),
      tag: el.tagName ? el.tagName.toLowerCase() : ""
    };
  }

  /** Pointer-driven drag: press, eased steps, release. */
  function syntheticDrag(x1, y1, x2, y2, steps) {
    var start = topmostAt(x1, y1);
    if (!start) return { ok: false, error: "no_element_at_point" };
    var count = N.Math.max(4, N.Math.min(N.Number(steps) || 20, 60));

    fire(start, PointerEventCtor, "pointermove", pointerInit(x1, y1));
    fire(start, MouseEvent, "mousemove", mouseInit(x1, y1));
    fire(start, PointerEventCtor, "pointerdown", pointerInit(x1, y1, { buttons: 1 }));
    fire(start, MouseEvent, "mousedown", mouseInit(x1, y1, { buttons: 1 }));

    // Stepping exists because single-jump synthetic drags never trigger the
    // pointermove handlers these UIs use to choose a drop slot.
    for (var i = 1; i <= count; i++) {
      var t = i / count;
      // Ease out so the pointer lingers near the drop target, giving the UI
      // time to compute and show the insertion point.
      var eased = 1 - (1 - t) * (1 - t);
      var mx = N.Math.round(x1 + (x2 - x1) * eased);
      var my = N.Math.round(y1 + (y2 - y1) * eased);
      var over = topmostAt(mx, my) || start;
      fire(over, PointerEventCtor, "pointermove", pointerInit(mx, my, { buttons: 1 }));
      fire(over, MouseEvent, "mousemove", mouseInit(mx, my, { buttons: 1 }));
    }

    var end = topmostAt(x2, y2) || start;
    fire(end, PointerEventCtor, "pointerup", pointerInit(x2, y2));
    fire(end, MouseEvent, "mouseup", mouseInit(x2, y2));
    return { ok: true, type: "drag", via: "js_synthetic", from: { x: x1, y: y1 }, to: { x: x2, y: y2 } };
  }

  /**
   * HTML5 drag-and-drop via a shared DataTransfer. The browser's own drag
   * controller does not pick up synthetic pointer drags, so anything using
   * `draggable="true"` needs the event sequence dispatched directly.
   */
  function html5Drag(fromSelector, toSelector) {
    try {
      var src = qs(document, fromSelector);
      var dst = qs(document, toSelector);
      if (!src) return { ok: false, error: "drag_source_not_found" };
      if (!dst) return { ok: false, error: "drop_target_not_found" };
      var dt = new DataTransfer();
      function dfire(el, name) {
        var r = rect(el);
        var ev = new DragEvent(name, {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer: dt,
          clientX: N.Math.round(r.left + r.width / 2),
          clientY: N.Math.round(r.top + r.height / 2)
        });
        N.dispatchEvent.call(el, ev);
        return ev;
      }
      dfire(src, "pointerdown");
      dfire(src, "mousedown");
      dfire(src, "dragstart");
      dfire(dst, "dragenter");
      dfire(dst, "dragover");
      var drop = dfire(dst, "drop");
      dfire(src, "dragend");
      return { ok: true, dropped: drop.defaultPrevented !== false };
    } catch (e) {
      return { ok: false, error: "" + (e && e.message || e) };
    }
  }

  function usesHtml5Drag(selector) {
    try {
      var el = qs(document, selector);
      if (!el) return false;
      if (el.draggable === true || attr(el, "draggable") === "true") return true;
      return !!N.closest.call(el, '[draggable="true"]');
    } catch (e) {
      return false;
    }
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  function keyInit(key, code, modifiers) {
    var mods = modifiers || [];
    function has(name) { return mods.indexOf(name) > -1; }
    var legacy = key.length === 1 ? key.toUpperCase().charCodeAt(0) : KEYCODES[key] || 0;
    return {
      key: key,
      code: code || codeFor(key),
      keyCode: legacy,
      which: legacy,
      charCode: 0,
      location: 0,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: has("control"),
      metaKey: has("meta"),
      shiftKey: has("shift"),
      altKey: has("alt")
    };
  }

  var KEYCODES = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, " ": 32,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34
  };

  function codeFor(key) {
    if (key.length === 1) {
      if (/[a-zA-Z]/.test(key)) return "Key" + key.toUpperCase();
      if (/[0-9]/.test(key)) return "Digit" + key;
      if (key === " ") return "Space";
      return "";
    }
    return key;
  }

  /**
   * Synthetic keydown NEVER inserts text — that is an engine behavior, not an
   * event behavior. So a key press that should produce a character is paired
   * with an explicit insert. Shortcut keys (with modifiers) and navigation
   * keys dispatch events only, which is what page-level handlers listen for.
   */
  function pressKey(key, modifiers) {
    var target = document.activeElement || document.body;
    if (!target) return { ok: false, error: "no_focus_target" };
    var init = keyInit(key, null, modifiers);
    var down = fire(target, KeyboardEvent, "keydown", init);
    var inserted = false;
    var hasModifier = (modifiers || []).some(function (m) {
      return m === "meta" || m === "control" || m === "alt";
    });
    if (!hasModifier && key.length === 1 && down && !down.defaultPrevented) {
      inserted = insertTextIntoActive(key);
    }
    fire(target, KeyboardEvent, "keyup", init);
    return {
      ok: true,
      type: "press",
      key: key,
      via: "js_synthetic",
      inserted: inserted,
      // No JS path reaches engine-native key handling (form submit on Enter,
      // caret motion, IME). The agent is told so rather than being let believe
      // an Enter keydown submitted a form.
      unverified: !inserted
    };
  }

  // ── Typing ────────────────────────────────────────────────────────────────
  //
  // The replacement ladder for webContents.insertText, which has no WKWebView
  // equivalent. Order matters — see the migration doc §2 `type`.

  /** Defeats React's value tracker, which ignores a plain `.value =`. */
  function setNativeValue(el, value) {
    var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = N.Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function insertTextIntoActive(text) {
    var el = document.activeElement;
    if (!el) return false;
    return insertTextInto(el, text, "append") !== false;
  }

  /**
   * @param mode "append" appends at the caret / end; "replace" overwrites.
   */
  function insertTextInto(el, text, mode) {
    if (!el) return false;
    var tag = (el.tagName || "").toUpperCase();

    if (tag === "INPUT" || tag === "TEXTAREA") {
      var before = el.value || "";
      var next = mode === "replace" ? text : before + text;
      // (2) setRangeText for caret-respecting partial edits when there is a
      // real selection to honor.
      if (mode !== "replace" && typeof el.setRangeText === "function" &&
          el.selectionStart != null && el.selectionStart !== before.length) {
        try {
          el.setRangeText(text, el.selectionStart, el.selectionEnd, "end");
          el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
          return true;
        } catch (e) {}
      }
      // (1) Native value setter + events — the workhorse for controlled inputs.
      setNativeValue(el, next);
      try {
        el.dispatchEvent(new InputEvent("input", {
          bubbles: true, composed: true, inputType: "insertText", data: text
        }));
      } catch (e) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return (el.value || "") === next;
    }

    var editable = el.isContentEditable ? el : qs(el, '[contenteditable="true"]');
    if (editable) {
      try { editable.focus({ preventScroll: true }); } catch (e) {}
      if (mode === "replace") {
        try {
          var sel = window.getSelection();
          var range = document.createRange();
          range.selectNodeContents(editable);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (e) {}
      }
      // (3) execCommand('insertText') is deprecated but the ONLY JS path that
      // produces a proper beforeinput/input pair with native undo-stack
      // integration — which is what ProseMirror, Slate, Quill, Lexical and
      // CodeMirror 6 actually want. Prefer it for contenteditable.
      try {
        if (document.execCommand("insertText", false, text)) return true;
      } catch (e) {}
      // Fallback: place the text directly and fabricate the input event.
      try {
        var selection = window.getSelection();
        if (selection && selection.rangeCount) {
          var r = selection.getRangeAt(0);
          r.deleteContents();
          r.insertNode(document.createTextNode(text));
          r.collapse(false);
        } else {
          editable.appendChild(document.createTextNode(text));
        }
        editable.dispatchEvent(new InputEvent("input", {
          bubbles: true, composed: true, inputType: "insertText", data: text
        }));
        return true;
      } catch (e) {}
      return false;
    }
    return false;
  }

  /**
   * (4) Per-character KeyboardEvent synthesis for editors that intercept keys
   * (CodeMirror, Monaco, terminals). Paired with an insert, because synthetic
   * keydown never inserts on its own.
   */
  function typeByKeyEvents(el, text) {
    try { el.focus({ preventScroll: true }); } catch (e) {}
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var init = keyInit(ch, null, []);
      var down = fire(el, KeyboardEvent, "keydown", init);
      if (!down || !down.defaultPrevented) insertTextInto(el, ch, "append");
      fire(el, KeyboardEvent, "keyup", init);
    }
    return true;
  }

  function readValue(el) {
    if (!el) return null;
    try {
      return ((el.value != null ? el.value : (el.innerText || "")) + "").slice(0, 2000);
    } catch (e) {
      return null;
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function findElement(a) {
    var el = a.selector ? qs(document, a.selector) : null;
    if (el && clickable(el)) return el;
    var want = ("" + (a.label || "")).toLowerCase().trim();
    if (!want) return null;
    var nodes = qsa(document, RESOLVE_QUERY);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var lab = labelOf(n).toLowerCase();
      if (lab && (lab.indexOf(want) > -1 || want.indexOf(lab.slice(0, 40)) > -1) && clickable(n)) {
        return n;
      }
    }
    return null;
  }

  /** Set a <select>'s value. WebKit renders these menus natively and no amount
   * of event synthesis opens one — setting .value IS the only strategy that
   * works, which is fortunate because it is what the Electron build already
   * did. */
  function selectOption(a) {
    var el = findElement(a);
    if (!el) return { ok: false, error: "element_not_found" };
    var wanted = ("" + (a.value || a.text || "")).trim();
    var sel = el.tagName === "SELECT" ? el : qs(el, "select");
    if (!sel) return { ok: false, error: "not_a_select" };
    var hit = -1;
    var lower = wanted.toLowerCase();
    for (var j = 0; j < sel.options.length; j++) {
      var o = sel.options[j];
      var ot = ((o.textContent || "") + "").trim().toLowerCase();
      if (o.value === wanted || ot === lower || (lower && ot.indexOf(lower) > -1)) { hit = j; break; }
    }
    if (hit < 0) return { ok: false, error: "option_not_found" };
    sel.selectedIndex = hit;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, type: "select", value: sel.value };
  }

  /** Scroll a specific container — window scrolling does nothing in a panel. */
  function scrollElement(selector, dy, dx) {
    try {
      var el = qs(document, selector);
      if (!el) return { ok: false, error: "element_not_found" };
      // The named element is often a child of the thing that actually scrolls.
      var box = el;
      var guard = 0;
      while (box && guard++ < 8) {
        var st = style(box);
        if (
          (box.scrollHeight - box.clientHeight > 8 && /auto|scroll/.test(st.overflowY)) ||
          (box.scrollWidth - box.clientWidth > 8 && /auto|scroll/.test(st.overflowX))
        ) break;
        box = box.parentElement;
      }
      if (!box) return { ok: false, error: "no_scrollable_container" };
      var before = box.scrollTop;
      var beforeX = box.scrollLeft;
      box.scrollTop = before + N.Number(dy || 0);
      box.scrollLeft = beforeX + N.Number(dx || 0);
      return {
        ok: true,
        scrolled: box.scrollTop - before,
        scrolledX: box.scrollLeft - beforeX,
        atEnd: box.scrollTop + box.clientHeight >= box.scrollHeight - 2
      };
    } catch (e) {
      return { ok: false, error: "" + (e && e.message || e) };
    }
  }

  function scrollWindow(dy) {
    window.scrollBy(0, N.Number(dy) || 400);
    return { ok: true, type: "scroll" };
  }

  /**
   * In-place find-and-replace. Inputs/textareas replace inside .value via the
   * prototype setter (frameworks see a real input event). Contenteditable
   * replaces within the text node containing the match, with a cross-node path
   * for passages that span line breaks.
   */
  function replaceText(selector, find, rep) {
    try {
      var el = qs(document, selector);
      if (!el) return { ok: false, error: "element_not_found" };

      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        var v = el.value || "";
        var i = v.indexOf(find);
        if (i < 0) return { ok: false, error: "text_not_found" };
        var nv = v.slice(0, i) + rep + v.slice(i + find.length);
        setNativeValue(el, nv);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return {
          ok: true, replaced: true, valueLen: nv.length,
          preview: nv.slice(N.Math.max(0, i - 40), i + rep.length + 40)
        };
      }

      var root = el.isContentEditable ? el : (qs(el, '[contenteditable="true"]') || el);
      if (!root || !(root.isContentEditable || attr(root, "contenteditable") === "true")) {
        return { ok: false, error: "not_editable" };
      }

      // Fast path: match within a single text node (preserves formatting).
      var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      var n;
      while ((n = w.nextNode())) {
        var idx = n.nodeValue.indexOf(find);
        if (idx > -1) {
          n.nodeValue = n.nodeValue.slice(0, idx) + rep + n.nodeValue.slice(idx + find.length);
          root.dispatchEvent(new Event("input", { bubbles: true }));
          return {
            ok: true, replaced: true,
            preview: n.nodeValue.slice(N.Math.max(0, idx - 40), idx + rep.length + 40)
          };
        }
      }

      // Cross-node path: editors split lines into separate elements (Gmail's
      // body is one <div> per line), so any passage crossing a line break never
      // sits in one text node. Match with whitespace collapsed across ALL text
      // nodes (a virtual break separates adjacent nodes), then delete the exact
      // range and insert the replacement (newlines → <br>).
      var tnodes = [];
      var w2 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      var t;
      while ((t = w2.nextNode())) tnodes.push(t);

      var chars = [];
      var raw = [];
      for (var k = 0; k < tnodes.length; k++) {
        if (k) { chars.push("\n"); raw.push(null); }
        var val = tnodes[k].nodeValue;
        for (var c = 0; c < val.length; c++) { chars.push(val[c]); raw.push({ k: k, off: c }); }
      }

      var ns = "";
      var nmap = [];
      for (var q = 0; q < chars.length; q++) {
        var ch = chars[q];
        if (/\s/.test(ch)) {
          if (ns && ns[ns.length - 1] === " ") continue;
          ns += " "; nmap.push(q);
        } else { ns += ch; nmap.push(q); }
      }

      var needle = ("" + find).replace(/\s+/g, " ").trim();
      if (!needle) return { ok: false, error: "text_not_found" };
      var pos = ns.indexOf(needle);
      if (pos < 0) {
        return {
          ok: false, error: "text_not_found",
          hint: "That exact passage is not in the field — re-read the content and copy the snippet verbatim."
        };
      }

      var si = nmap[pos];
      var ei = nmap[pos + needle.length - 1];
      while (si < raw.length && raw[si] == null) si++;
      while (ei >= 0 && raw[ei] == null) ei--;
      if (si >= raw.length || ei < 0 || si > ei) return { ok: false, error: "text_not_found" };

      var st2 = raw[si];
      var en = raw[ei];
      var range = document.createRange();
      range.setStart(tnodes[st2.k], st2.off);
      range.setEnd(tnodes[en.k], en.off + 1);
      range.deleteContents();
      if (rep) {
        var frag = document.createDocumentFragment();
        var parts = ("" + rep).split("\n");
        for (var q2 = 0; q2 < parts.length; q2++) {
          if (q2) frag.appendChild(document.createElement("br"));
          if (parts[q2]) frag.appendChild(document.createTextNode(parts[q2]));
        }
        range.insertNode(frag);
      }
      root.dispatchEvent(new Event("input", { bubbles: true }));
      return { ok: true, replaced: true, crossNode: true, preview: ("" + (rep || "")).slice(0, 80) };
    } catch (e) {
      return { ok: false, error: "" + (e && e.message || e) };
    }
  }

  function extract(selector) {
    var el = qs(document, selector);
    if (!el) return null;
    return {
      value: ((el.value != null ? el.value : (el.innerText || "")) + "").slice(0, 2000),
      checked: el.checked === true
    };
  }

  /**
   * Type into an element resolved by selector/label. Returns whether the text
   * could be read back — editors that never expose their value report
   * `unverified` rather than failure, because calling that a failure is what
   * makes the agent retype and duplicate content.
   */
  function typeInto(a) {
    var el = findElement(a);
    if (!el) return { ok: false, error: "element_not_found" };
    var text = "" + (a.text != null ? a.text : (a.value || ""));
    var mode = a.mode === "replace" ? "replace" : "append";

    try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) {}
    var r = rect(el);
    var cx = N.Math.round(r.left + r.width / 2);
    var cy = N.Math.round(r.top + N.Math.min(r.height / 2, 120));
    // Focus the way a click would: several editors mount their real input only
    // after a pointer sequence.
    syntheticClickAt(cx, cy, { eventsOnly: false });

    var target = document.activeElement && document.activeElement !== document.body
      ? document.activeElement
      : el;
    var landed = insertTextInto(target, text, mode);
    if (!landed) {
      // (4) Editors that intercept keys need per-character synthesis.
      typeByKeyEvents(target, text);
    }

    var readBack = readValue(target);
    var norm = function (s) { return ("" + (s || "")).replace(/\s+/g, " ").trim().toLowerCase(); };
    var needle = norm(text).slice(0, 48);
    var verified = !!needle && norm(readBack).indexOf(needle) > -1;

    return {
      ok: true,
      type: "click_type",
      via: "js_ladder",
      chars: text.length,
      clientX: cx,
      clientY: cy,
      verified: verified,
      // Canvas and code editors never expose their value back — that is not
      // the same as the typing having failed.
      unverified: !verified
    };
  }

  /** Overwrite a plain input's whole value deterministically. */
  function fillInto(a) {
    var el = findElement(a);
    if (!el) return { ok: false, error: "element_not_found" };
    var text = "" + (a.text != null ? a.text : (a.value || ""));
    var before = readValue(el);
    var ok = insertTextInto(el, text, "replace");
    var after = readValue(el);
    return {
      ok: true,
      type: "fill",
      changed: after !== before,
      valueLen: (after || "").length,
      verified: ok && ("" + after) === text,
      unverified: !(ok && ("" + after) === text)
    };
  }

  // ── Settle detection ──────────────────────────────────────────────────────
  //
  // There is no WebKit equivalent of CDP's Page.lifecycleEvent / network-idle,
  // so quiescence is observed from inside: DOM mutations stop, and no
  // page-initiated request has been in flight for a beat. fetch/XHR are
  // wrapped in the PAGE world by the companion shim, which reports counts here
  // through a shared marker on document.

  var mutationCount = 0;
  try {
    var observer = new MutationObserver(function (records) { mutationCount += records.length; });
    var startObserving = function () {
      if (document.documentElement) {
        observer.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true, characterData: true
        });
      }
    };
    if (document.documentElement) startObserving();
    else N.addEventListener.call(document, "readystatechange", startObserving, { once: true });
  } catch (e) {}

  function inflightRequests() {
    try {
      var marker = document.documentElement && document.documentElement.dataset
        ? document.documentElement.dataset.lyknInflight
        : null;
      var n = parseInt(marker || "0", 10);
      return isNaN(n) ? 0 : n;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Resolve once the DOM has stopped changing and nothing is in flight, or the
   * budget runs out. Double-rAF at the end so a settled result is also a
   * painted one.
   */
  function domSettle(budgetMs) {
    var budget = N.Number(budgetMs) || 3500;
    var quietFor = 250;
    return new N.Promise(function (resolve) {
      var deadline = N.now() + budget;
      var lastCount = -1;
      var quietSince = N.now();

      function tick() {
        var now = N.now();
        if (mutationCount !== lastCount || inflightRequests() > 0) {
          lastCount = mutationCount;
          quietSince = now;
        }
        if (now - quietSince >= quietFor || now >= deadline) {
          N.rAF(function () {
            N.rAF(function () {
              resolve({
                ok: true,
                settled: now < deadline,
                mutations: mutationCount,
                inflight: inflightRequests()
              });
            });
          });
          return;
        }
        N.setTimeout(tick, 50);
      }
      tick();
    });
  }

  // ── Install ───────────────────────────────────────────────────────────────

  globalThis.__lykn = {
    __installed: true,
    frameToken: FRAME_TOKEN,
    isMainFrame: isMainFrame,

    collectInteractables: collectInteractables,
    extractPageContext: extractPageContext,
    extractFrameText: extractFrameText,
    collectFrameRects: collectFrameRects,
    viewportMetrics: viewportMetrics,

    resolvePoint: resolvePoint,
    resolveStrict: resolveStrict,
    topmostLabelAt: function (x, y) {
      var el = topmostAt(x, y);
      return el ? { label: labelOf(el).slice(0, 80), tag: (el.tagName || "").toLowerCase() } : null;
    },

    clickAt: syntheticClickAt,
    dragAt: syntheticDrag,
    html5Drag: html5Drag,
    usesHtml5Drag: usesHtml5Drag,
    pressKey: pressKey,

    typeInto: typeInto,
    fillInto: fillInto,
    selectOption: selectOption,
    replaceText: replaceText,
    extract: extract,

    scrollElement: scrollElement,
    scrollWindow: scrollWindow,

    domSettle: domSettle,
    announceFrame: announceFrame
  };

  announceFrame();
  // Re-announce on SPA navigations: the native cache is keyed on a
  // WKFrameInfo that a same-document navigation can invalidate.
  try {
    N.addEventListener.call(window, "pageshow", announceFrame);
    N.addEventListener.call(window, "popstate", announceFrame);
  } catch (e) {}
})();
