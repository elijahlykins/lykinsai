/*
 * LYKN page-world shim.
 *
 * Runs at document start in the PAGE world, in every frame — deliberately not
 * in the isolated world, because both things it does are only possible from
 * inside the page's own globals:
 *
 *   1. Closed shadow roots. Isolated worlds do NOT help here — WebKit honors
 *      closed-ness across content worlds. The only workaround is to patch
 *      Element.prototype.attachShadow before any page code runs, so roots the
 *      page intends to close are stashed where the collector can reach them.
 *      (Migration doc §5.5.)
 *
 *   2. Network quiescence. There is no Page.lifecycleEvent and no network-idle
 *      signal in WebKit, so page-initiated fetch/XHR are counted here and the
 *      count published on a data attribute the isolated-world runtime reads.
 *      This covers only page-initiated traffic — subresources and navigations
 *      are invisible to it, which is a documented limit of the port, not a bug.
 *
 * Everything here is deliberately small and defensive: it executes inside a
 * hostile global, before any page script, and a throw would break the page.
 */
"use strict";

(function () {
  if (window.__lyknPageShim) return;
  window.__lyknPageShim = true;

  // ── Closed shadow roots ───────────────────────────────────────────────────
  //
  // Forcing `mode: "open"` is the whole mechanism, and it has to be this
  // rather than the tidier-looking alternative of stashing roots in a WeakMap
  // here: content worlds share the DOM but NOT globals or DOM-object expandos,
  // so a WeakMap (or any property) held in the page world is unreachable from
  // the isolated world where the collector runs. `element.shadowRoot` is a
  // real DOM property, visible in every world — so opening the root is the
  // only channel that actually delivers the contents.
  //
  // The cost, stated plainly: page code that treats `this.shadowRoot === null`
  // as proof its root is closed will observe a non-null value. That is a real
  // behavior change for the page, accepted because the alternative is an agent
  // that cannot see inside any closed component at all.
  try {
    var nativeAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      var options = init || {};
      if (options.mode === "closed") {
        var forced = {};
        for (var k in options) {
          if (Object.prototype.hasOwnProperty.call(options, k)) forced[k] = options[k];
        }
        forced.mode = "open";
        return nativeAttachShadow.call(this, forced);
      }
      return nativeAttachShadow.call(this, options);
    };
  } catch (e) {
    /* a page that froze Element.prototype keeps its closed roots — accepted */
  }

  // ── In-flight request counter ─────────────────────────────────────────────
  try {
    var inflight = 0;

    function publish() {
      try {
        if (document.documentElement) {
          document.documentElement.dataset.lyknInflight = String(inflight);
        }
      } catch (e) {}
    }

    function opened() { inflight++; publish(); }
    function closed() { inflight = Math.max(0, inflight - 1); publish(); }

    var nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
      window.fetch = function () {
        opened();
        var done = false;
        function settle() { if (!done) { done = true; closed(); } }
        try {
          return nativeFetch.apply(this, arguments).then(
            function (r) { settle(); return r; },
            function (e) { settle(); throw e; }
          );
        } catch (e) {
          settle();
          throw e;
        }
      };
    }

    var NativeXHR = window.XMLHttpRequest;
    if (typeof NativeXHR === "function") {
      var nativeSend = NativeXHR.prototype.send;
      NativeXHR.prototype.send = function () {
        var self = this;
        var done = false;
        function settle() { if (!done) { done = true; closed(); } }
        opened();
        try {
          self.addEventListener("loadend", settle, { once: true });
        } catch (e) {
          settle();
        }
        try {
          return nativeSend.apply(this, arguments);
        } catch (e) {
          settle();
          throw e;
        }
      };
    }

    publish();
  } catch (e) {
    /* settle detection degrades to mutation-only — still useful */
  }
})();
