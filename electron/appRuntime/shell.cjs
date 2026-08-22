/**
 * The document an installed app boots from.
 *
 * Deliberately thin compared to the chat preview's runner: there is no Babel,
 * no import rewriting, and no CDN. The project was already compiled to a plain
 * IIFE at install time, and every library it needs is served from the same
 * origin, so the app works with the machine offline.
 *
 * Errors are posted to the opener as well as shown inline, which is what lets
 * the build agent watch a real run and fix what actually broke.
 */

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @param {object} app         The app row (name, id).
 * @param {object} [opts]
 * @param {boolean} [opts.hasTailwind]  Vendored Tailwind is on disk.
 * @param {string[]} [opts.libraries]   Extra vendored library filenames to load.
 */
function buildAppShellHtml(app = {}, opts = {}) {
  const title = escapeHtml(String(app.name || "App").slice(0, 160));
  // Without the vendored copy the app still styles correctly when the machine
  // is online; it just is not offline-clean. Better than shipping unstyled.
  const tailwind = opts.hasTailwind
    ? `<script src="/vendor/tailwind.js"></script>`
    : `<script src="https://cdn.tailwindcss.com"></script>`;

  // Loaded after React because each expects it on the global. Only whatever is
  // actually vendored is listed, so a trimmed build degrades to "that library
  // is unavailable" at compile time rather than a 404 at run time.
  const libraries = (opts.libraries || [])
    .map((file) => `<script src="/vendor/${file}"></script>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<script src="/vendor/react.js"></script>
<script src="/vendor/react-dom.js"></script>
${libraries}
${tailwind}
<style>
  html, body, #root { height: 100%; margin: 0; }
  body {
    background: #fafafa; -webkit-font-smoothing: antialiased;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  #lykn-boot {
    position: fixed; inset: 0; z-index: 99998; display: flex;
    align-items: center; justify-content: center; gap: 10px;
    background: #fafafa; color: #64748b; font-size: 13.5px;
  }
  #lykn-boot[hidden] { display: none !important; }
  #lykn-boot-dot {
    width: 26px; height: 26px; border-radius: 999px;
    border: 2.5px solid #cbd5e1; border-top-color: #334155;
    animation: lykn-spin .7s linear infinite;
  }
  @keyframes lykn-spin { to { transform: rotate(360deg); } }
  #lykn-error {
    display: none; position: fixed; inset: 12px 12px auto 12px; z-index: 99999;
    background: #7f1d1d; color: #fecaca; border-radius: 10px; padding: 12px 14px;
    font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap; word-break: break-word; max-height: 45vh; overflow: auto;
  }
</style>
</head>
<body>
<div id="lykn-boot"><div id="lykn-boot-dot"></div><div>Opening ${title}…</div></div>
<div id="root"></div>
<div id="lykn-error" role="alert"></div>
<script>
(function () {
  var errEl = document.getElementById("lykn-error");
  var bootEl = document.getElementById("lykn-boot");
  function hideBoot() { try { if (bootEl) bootEl.hidden = true; } catch (_) {} }

  // The verify pass and the artifact panel both listen for these. Posting to
  // the opener as well as the parent covers the app being opened in its own
  // window rather than embedded in a frame.
  function report(payload) {
    var msg = Object.assign({ source: "lykn-app", appId: ${JSON.stringify(String(app.id || ""))} }, payload);
    try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, "*"); } catch (_) {}
    try { if (window.opener) window.opener.postMessage(msg, "*"); } catch (_) {}
    try { if (window.lykn && window.lykn.__report) window.lykn.__report(msg); } catch (_) {}
  }

  function showError(message, kind) {
    message = String(message || "unknown error");
    try {
      hideBoot();
      errEl.textContent = "App error: " + message;
      errEl.style.display = "block";
    } catch (_) {}
    report({ type: "runtime_error", message: message, kind: kind || "error", at: Date.now() });
  }

  window.addEventListener("error", function (e) { showError(e && e.message, "error"); });
  window.addEventListener("unhandledrejection", function (e) {
    showError(e && e.reason && (e.reason.message || e.reason), "unhandledrejection");
  });
  try {
    var origErr = console.error.bind(console);
    console.error = function () {
      try {
        var args = Array.prototype.slice.call(arguments).map(function (a) {
          if (a && a.stack) return String(a.stack);
          try { return typeof a === "string" ? a : JSON.stringify(a); } catch (_) { return String(a); }
        });
        report({ type: "console_error", message: args.join(" ").slice(0, 2000), at: Date.now() });
      } catch (_) {}
      return origErr.apply(console, arguments);
    };
  } catch (_) {}

  // Point the Storage API at the app's own database. localStorage genuinely
  // works on this origin, but data left there is invisible to the backup, to
  // the storage readout, and to uninstall — so it is redirected rather than
  // forbidden. Runs before the bundle so the app never sees the native one.
  try {
    var s = window.lykn && window.lykn.__storage;
    if (s) {
      var shim = {
        getItem: function (k) { return s.getItem(k); },
        setItem: function (k, v) { return s.setItem(k, v); },
        removeItem: function (k) { return s.removeItem(k); },
        clear: function () { return s.clear(); },
        key: function (i) { return s.key(i); },
      };
      Object.defineProperty(shim, "length", { get: function () { return s.size(); } });
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get: function () { return shim; },
      });
    }
  } catch (_) {
    /* the native implementation still works; it just is not backed up */
  }

  var script = document.createElement("script");
  script.src = "/app.js";
  script.onerror = function () { showError("Could not load the app bundle."); };
  script.onload = function () {
    try {
      var mod = window.__lyknApp || {};
      var Component = mod.default || mod;
      if (typeof Component !== "function") {
        showError("The app did not export a React component as its default export.");
        return;
      }
      // "Ready" has to mean the app actually rendered, not that render was
      // scheduled. createRoot().render() returns before React commits, so
      // reporting here would call a component that throws on mount a success —
      // and the build agent would stop iterating on a broken app. This sentinel
      // renders as a sibling, so its effect only runs once the tree committed.
      function Ready() {
        React.useEffect(function () {
          hideBoot();
          report({ type: "ready", at: Date.now() });
        }, []);
        return null;
      }

      var root = ReactDOM.createRoot(document.getElementById("root"));
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Component),
          React.createElement(Ready)
        )
      );
    } catch (e) {
      showError((e && e.message) || "The app crashed while rendering.");
    }
  };
  document.body.appendChild(script);
})();
</script>
</body>
</html>`;
}

module.exports = { buildAppShellHtml };
