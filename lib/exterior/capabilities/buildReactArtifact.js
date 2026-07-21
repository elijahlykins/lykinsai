// ============================================================================
// buildReactArtifact — claude.ai-style React artifacts.
//
// The model writes a complete single-file React component (JSX). We wrap it
// in a self-contained "runner" HTML document that loads a full library stack
// from CDN — React 18, ReactDOM, Recharts, lucide-react, Tailwind (forms/
// typography/aspect-ratio/line-clamp plugins + Inter/Space Grotesk/JetBrains
// Mono fonts), daisyUI component classes, animate.css, framer-motion, d3,
// three.js, lodash, dayjs, mathjs, PapaParse, marked, Tone.js,
// canvas-confetti, html2canvas, jsPDF — transpiles the JSX with Babel
// standalone in the browser, and mounts the default export. The runner is
// persisted to storage and served through the branded file proxy, so the
// chat panel renders it in the same sandboxed cross-origin iframe as every
// other HTML artifact.
//
// The raw JSX is NOT echoed in the tool result (the model already has it in
// its tool-call args, and the client reads it from there for the edit
// round-trip); only the runner HTML + URLs come back.
// ============================================================================

import {
  persistCapabilityArtifact,
} from '../capabilityStorage.js';

const MAX_CODE_LEN = 120000;

/** Rough component sanity check — not a compile, just "is this a component". */
function looksLikeComponent(code) {
  return /export\s+default|function\s+[A-Z][A-Za-z0-9_]*\s*\(|const\s+[A-Z][A-Za-z0-9_]*\s*=/.test(code);
}

function slugify(title) {
  const base = String(title || 'artifact')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'artifact';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Embed arbitrary source text safely inside a <script> element: JSON-encode
 * it and escape `</` so a literal "</script>" in the code can't terminate
 * the element early. `<\/` is a valid JSON escape that parses back to `</`.
 */
function jsonForScriptTag(text) {
  return JSON.stringify(String(text)).replace(/<\//g, '<\\/');
}

/**
 * Build the self-contained runner document. Everything the component needs
 * ships in this one file: CDN runtimes, Babel transpile, error overlay.
 */
export function buildReactRunnerHtml({ title, code }) {
  const safeTitle = escapeHtml(String(title || 'Interactive artifact').slice(0, 160));
  const sourceJson = jsonForScriptTag(code);

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script crossorigin src="https://unpkg.com/prop-types@15/prop-types.min.js"></script>
<script>
  /* lucide-react's UMD factory reads the lowercase \`react\` global; alias it
     (and react-dom for good measure) before those bundles load. */
  window.react = window.React;
  window["react-dom"] = window.ReactDOM;
</script>
<script crossorigin src="https://unpkg.com/recharts@2.15.0/umd/Recharts.js"></script>
<script crossorigin src="https://unpkg.com/lucide-react@0.454.0/dist/umd/lucide-react.min.js"></script>
<script crossorigin src="https://unpkg.com/framer-motion@11.11.17/dist/framer-motion.js"></script>
<script crossorigin src="https://unpkg.com/d3@7.9.0/dist/d3.min.js"></script>
<script crossorigin src="https://unpkg.com/three@0.160.1/build/three.min.js"></script>
<script crossorigin src="https://unpkg.com/lodash@4.17.21/lodash.min.js"></script>
<script crossorigin src="https://unpkg.com/dayjs@1.11.13/dayjs.min.js"></script>
<script crossorigin src="https://unpkg.com/mathjs@12.4.3/lib/browser/math.js"></script>
<script crossorigin src="https://unpkg.com/papaparse@5.4.1/papaparse.min.js"></script>
<script crossorigin src="https://unpkg.com/marked@12.0.2/marked.min.js"></script>
<script crossorigin src="https://unpkg.com/tone@14.8.49/build/Tone.js"></script>
<script crossorigin src="https://unpkg.com/canvas-confetti@1.9.3/dist/confetti.browser.js"></script>
<script crossorigin src="https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
<script crossorigin src="https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js"></script>
<script crossorigin src="https://unpkg.com/@babel/standalone@7/babel.min.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/daisyui@4.12.24/dist/full.min.css" />
<link rel="stylesheet" href="https://unpkg.com/animate.css@4.1.1/animate.min.css" />
<script src="https://cdn.tailwindcss.com?plugins=forms,typography,aspect-ratio,line-clamp"></script>
<script>
  /* Design tokens for the Play CDN: Inter as the default sans, Space Grotesk
     for display headings (font-display), JetBrains Mono for code. */
  tailwind.config = {
    theme: {
      extend: {
        fontFamily: {
          sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
          display: ["Space Grotesk", "Inter", "ui-sans-serif", "sans-serif"],
          mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
        },
        boxShadow: {
          soft: "0 2px 8px rgba(0,0,0,.05), 0 8px 32px rgba(0,0,0,.06)",
        },
      },
    },
  };
</script>
<style>
  html, body, #root { min-height: 100%; }
  body {
    margin: 0; background: #ffffff; -webkit-font-smoothing: antialiased;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  #lykn-artifact-error {
    display: none; position: fixed; inset: auto 12px 12px 12px; z-index: 99999;
    background: #7f1d1d; color: #fecaca; border-radius: 10px; padding: 12px 14px;
    font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap; word-break: break-word; max-height: 45vh; overflow: auto;
    box-shadow: 0 8px 30px rgba(0,0,0,.35);
  }
  @media print {
    #lykn-artifact-error { display: none !important; }
    body { background: #fff !important; }
  }
</style>
</head>
<body>
<div id="root"></div>
<div id="lykn-artifact-error" role="alert"></div>
<script id="lykn-artifact-source" type="application/json">${sourceJson}</script>
<script>
(function () {
  var errEl = document.getElementById("lykn-artifact-error");
  // Production React throws opaque "Minified React error #NNN" messages —
  // decode the ones artifacts actually hit so the overlay (and the model,
  // when the user pastes the error back for a fix) says what went wrong.
  var REACT_ERR_DECODER = {
    "130": "a rendered component is undefined — usually a misspelled or non-existent icon/chart/library component name",
    "31": "a plain object was rendered as JSX content (render a field of it instead, e.g. {item.label} not {item})",
    "321": "invalid hook call — hooks (useState/useEffect/…) must be called at the top level of the component function",
    "310": "more hooks rendered than the previous render — hooks must not be called inside conditions or loops",
  };
  function showError(msg) {
    msg = String(msg || "unknown error");
    var m = msg.match(/Minified React error #(\\d+)/);
    if (m && REACT_ERR_DECODER[m[1]]) {
      msg = "React #" + m[1] + ": " + REACT_ERR_DECODER[m[1]] + " — " + msg;
    }
    try {
      errEl.textContent = "Artifact error: " + msg;
      errEl.style.display = "block";
    } catch (_) {}
  }
  window.addEventListener("error", function (e) { showError(e && e.message); });
  window.addEventListener("unhandledrejection", function (e) {
    showError(e && e.reason && (e.reason.message || e.reason));
  });

  var src;
  try {
    src = JSON.parse(document.getElementById("lykn-artifact-source").textContent);
  } catch (e) {
    showError("Could not read artifact source.");
    return;
  }

  // The runner provides React & friends as globals — bare imports would fail
  // in the browser. Named imports from the KNOWN packages are rewritten into
  // \`var {…} = Global\` destructures (so the imported identifiers stay bound),
  // every other import line is dropped, and export syntax becomes assignments
  // the bootstrap below can pick up. \`var\` throughout because duplicates are
  // legal — the prelude and the model's own destructures must not collide
  // into a const SyntaxError.
  function destructureFrom(globalName) {
    return function (_m, names) {
      return "var {" + names.replace(/\\s+as\\s+/g, ": ") + "} = " + globalName + ";";
    };
  }
  var prepared = String(src)
    .replace(/import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]react['"];?/g, destructureFrom("React"))
    .replace(/import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]react-dom(?:\\/client)?['"];?/g, destructureFrom("ReactDOM"))
    .replace(/import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]recharts['"];?/g, destructureFrom("Recharts"))
    .replace(/import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]lucide-react['"];?/g, destructureFrom("LucideReact"))
    /* window-qualified RHS so an imported name that equals the global
       (e.g. \`import { marked } from 'marked'\`) can't shadow itself. */
    .replace(/import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"](?:framer-motion|motion\\/react|motion)['"];?/g, destructureFrom("window.Motion"))
    .replace(/import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]d3['"];?/g, destructureFrom("window.d3"))
    .replace(/import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]three['"];?/g, destructureFrom("window.THREE"))
    .replace(/import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]lodash(?:-es)?['"];?/g, destructureFrom("window._"))
    .replace(/import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]mathjs['"];?/g, destructureFrom("window.math"))
    .replace(/import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]papaparse['"];?/g, destructureFrom("window.Papa"))
    .replace(/import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]marked['"];?/g, destructureFrom("window.marked"))
    .replace(/import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]tone['"];?/g, destructureFrom("window.Tone"))
    .replace(/import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]jspdf['"];?/g, destructureFrom("window.jspdf"))
    /* Namespace + default imports of the CDN globals just alias the global
       under whatever local name the model chose. Everything left after
       these (unknown packages) is dropped by the catch-alls below. */
    .replace(/import\\s*\\*\\s*as\\s+([A-Za-z_$][\\w$]*)\\s*from\\s*['"]d3['"];?/g, "var $1 = window.d3;")
    .replace(/import\\s*\\*\\s*as\\s+([A-Za-z_$][\\w$]*)\\s*from\\s*['"]three['"];?/g, "var $1 = window.THREE;")
    .replace(/import\\s*\\*\\s*as\\s+([A-Za-z_$][\\w$]*)\\s*from\\s*['"]tone['"];?/g, "var $1 = window.Tone;")
    .replace(/import\\s*\\*\\s*as\\s+([A-Za-z_$][\\w$]*)\\s*from\\s*['"]mathjs['"];?/g, "var $1 = window.math;")
    .replace(/import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['"]lodash(?:-es)?['"];?/g, "var $1 = window._;")
    .replace(/import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['"]dayjs['"];?/g, "var $1 = window.dayjs;")
    .replace(/import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['"]papaparse['"];?/g, "var $1 = window.Papa;")
    .replace(/import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['"]canvas-confetti['"];?/g, "var $1 = window.confetti;")
    .replace(/import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['"]html2canvas['"];?/g, "var $1 = window.html2canvas;")
    .replace(/^[ \\t]*import\\s*\\{[\\s\\S]*?\\}\\s*from\\s*['"][^'"]*['"];?[ \\t]*$/gm, "")
    .replace(/^[ \\t]*import\\s[^\\n]*$/gm, "")
    .replace(/^[ \\t]*(?:const|let)\\s*(\\{[^}]*\\})\\s*=\\s*React\\s*;?[ \\t]*$/gm, "var $1 = React;")
    .replace(/^[ \\t]*(?:const|let)\\s*(\\{[^}]*\\})\\s*=\\s*(?:window\\.)?Recharts\\s*;?[ \\t]*$/gm, "var $1 = Recharts;")
    .replace(/^[ \\t]*(?:const|let)\\s*(\\{[^}]*\\})\\s*=\\s*(?:window\\.)?LucideReact\\s*;?[ \\t]*$/gm, "var $1 = LucideReact;")
    /* Any const/let alias of a KNOWN CDN global (e.g. \`const { motion,
       AnimatePresence } = window.Motion || {}\` or \`const jsPDF =
       window.jspdf.jsPDF\`) becomes \`var\`. A late const like that puts the
       WHOLE model block in its temporal dead zone — any earlier top-level
       use (a data array holding <motion.div> JSX is the classic case)
       throws "Cannot access 'motion' before initialization". As \`var\` it
       merges with the prelude's already-initialized binding instead. */
    .replace(/^([ \\t]*)(?:const|let)(\\s*(?:\\{[^}]*\\}|[A-Za-z_$][\\w$]*)\\s*=\\s*(?:window\\.)?(?:React|ReactDOM|Motion|FramerMotion|Recharts|LucideReact|lucideReact|THREE|d3|Tone|math|Papa|marked|dayjs|confetti|html2canvas|jspdf)\\b[^\\n]*)$/gm, "$1var$2")
    .replace(/export\\s+default\\s+function\\s+/g, "window.__lyknArtifactDefault = function ")
    .replace(/export\\s+default\\s+class\\s+/g, "window.__lyknArtifactDefault = class ")
    .replace(/export\\s+default\\s+/g, "window.__lyknArtifactDefault = ")
    .replace(/^[ \\t]*export\\s+\\{[^}]*\\}\\s*;?[ \\t]*$/gm, "")
    .replace(/^([ \\t]*)export\\s+(const|let|var|function|class)\\s+/gm, "$1$2 ");

  var prelude = [
    "var { useState, useEffect, useMemo, useCallback, useRef, useReducer,",
    "  useContext, useLayoutEffect, useId, useTransition, useDeferredValue,",
    "  useImperativeHandle, useSyncExternalStore, Fragment, StrictMode,",
    "  createContext, forwardRef, memo } = React;",
    // Models hallucinate icon/chart component names (an icon from a newer
    // lucide release, a Recharts part that never existed). Destructured from
    // a plain object those come back undefined, and rendering an undefined
    // component kills the WHOLE artifact with React error #130. Proxy the
    // two globals models pick names from so an unknown CAPITALIZED key
    // degrades gracefully instead: icons fall back to a generic icon,
    // chart parts to an empty component. console.warn keeps it debuggable.
    "function __lyknSafeLib(raw, label, fallback) {",
    "  if (typeof Proxy !== \\"function\\") return raw;",
    "  return new Proxy(raw, { get: function (t, k) {",
    "    var v = t[k];",
    "    if (v === undefined && typeof k === \\"string\\" && /^[A-Z]/.test(k)) {",
    "      try { console.warn(\\"[lykn-artifact] unknown \\" + label + \\" component: \\" + k); } catch (_) {}",
    "      return fallback;",
    "    }",
    "    return v;",
    "  } });",
    "}",
    "var __lyknRawLucide = window.LucideReact || window.lucideReact || {};",
    "var LucideReact = __lyknSafeLib(__lyknRawLucide, \\"lucide icon\\",",
    "  __lyknRawLucide.Circle || __lyknRawLucide.HelpCircle || function () { return null; });",
    "var Recharts = __lyknSafeLib(window.Recharts || {}, \\"recharts\\", function () { return null; });",
    "var FramerMotion = window.Motion || {};",
    "var motion = FramerMotion.motion;",
    "var AnimatePresence = FramerMotion.AnimatePresence;",
    "var jsPDF = (window.jspdf || {}).jsPDF;",
    "",
  ].join("\\n");

  // If the component never used \`export default\`, fall back to the last
  // capitalized function/const in scope named App (the documented contract).
  // Lives INSIDE the model-code block below so it can see block-scoped App.
  var epilogue = [
    "",
    ";window.__lyknArtifactDefault = window.__lyknArtifactDefault ||",
    "  (typeof App !== \\"undefined\\" ? App : null);",
  ].join("\\n");

  // The model's code runs in its OWN block scope. The prelude's convenience
  // bindings (motion, AnimatePresence, jsPDF, …) are \`var\`s in the outer
  // scope, so when the model declares its own \`const { motion } =
  // window.Motion || …\` it legally SHADOWS the prelude instead of throwing
  // "Identifier 'motion' has already been declared".
  var compiled;
  try {
    compiled = Babel.transform(prelude + "{\\n" + prepared + epilogue + "\\n}", {
      filename: "artifact.tsx",
      presets: [
        ["typescript", { isTSX: true, allExtensions: true }],
        ["react", { runtime: "classic" }],
      ],
    }).code;
  } catch (e) {
    showError((e && e.message) || "Could not compile the artifact.");
    return;
  }

  try {
    new Function(compiled)();
  } catch (e) {
    showError((e && e.message) || "Artifact crashed while loading.");
    return;
  }

  var Component = window.__lyknArtifactDefault;
  if (typeof Component !== "function") {
    showError("No React component found — the artifact must \`export default\` a component (or define \`App\`).");
    return;
  }

  try {
    var root = ReactDOM.createRoot(document.getElementById("root"));
    root.render(React.createElement(Component));
  } catch (e) {
    showError((e && e.message) || "Artifact crashed while rendering.");
  }
})();
</script>
</body>
</html>`;
}

/**
 * Apply targeted find/replace edits to the current artifact source.
 * Each edit's `find` must match EXACTLY ONE location in the code (same
 * contract as editor patch tools): zero matches or multiple matches are
 * errors with a hint the model can act on, so a mis-aimed patch never
 * silently corrupts the artifact.
 */
export function applyArtifactEdits(baseCode, edits) {
  let code = String(baseCode);
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] || {};
    const find = String(e.find ?? '');
    const replace = String(e.replace ?? '');
    if (!find) {
      return { ok: false, error: 'edit_missing_find', hint: `edits[${i}] has an empty \`find\`. Every edit needs the exact existing code snippet to replace.` };
    }
    const firstIdx = code.indexOf(find);
    if (firstIdx === -1) {
      return {
        ok: false,
        error: 'edit_target_not_found',
        hint:
          `edits[${i}]: \`find\` did not match the current artifact source (it must be an EXACT copy, ` +
          `including whitespace/indentation). Failed snippet starts with: ${JSON.stringify(find.slice(0, 120))}. ` +
          'Re-check the source in [ARTIFACT_OPEN] and retry, or pass the full corrected `code` instead.',
      };
    }
    if (code.indexOf(find, firstIdx + 1) !== -1) {
      return {
        ok: false,
        error: 'edit_target_ambiguous',
        hint:
          `edits[${i}]: \`find\` matches more than one place in the artifact. ` +
          'Include more surrounding lines so the snippet is unique, then retry.',
      };
    }
    code = code.slice(0, firstIdx) + replace + code.slice(firstIdx + find.length);
  }
  return { ok: true, code };
}

/**
 * Line-level change ratio between two sources: 0 = identical, 1 = nothing in
 * common. Multiset intersection of trimmed non-empty lines — order-blind,
 * which is exactly right for a "how much did you actually touch" heuristic
 * (moving a block ranks as unchanged; rewriting/reformatting it ranks as
 * changed).
 */
export function codeChangeRatio(before, after) {
  const countLines = (src) => {
    const map = new Map();
    for (const raw of String(src).split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      map.set(line, (map.get(line) || 0) + 1);
    }
    return map;
  };
  const a = countLines(before);
  const b = countLines(after);
  let totalA = 0;
  for (const n of a.values()) totalA += n;
  let totalB = 0;
  for (const n of b.values()) totalB += n;
  if (totalA + totalB === 0) return 0;
  let common = 0;
  for (const [line, n] of a) common += Math.min(n, b.get(line) || 0);
  return 1 - (2 * common) / (totalA + totalB);
}

// Full-code submissions over an open artifact that touch more than this share
// of lines get bounced back to the `edits` path (unless full_rewrite: true).
// Tuned below 0.4 so a mid-size content expand that also quietly restyles
// still gets caught; pure list growth via full code rarely stays under this
// without also rewriting THEME/layout (which the theme guard catches too).
const UNSCOPED_REWRITE_RATIO = 0.28;

/** Pull a THEME / theme token object literal from artifact source (best-effort). */
function extractThemeBlock(src) {
  const m = String(src).match(/\b(?:const|let|var)\s+THEME\s*=\s*\{[\s\S]*?\n\};?/);
  return m ? m[0].replace(/\s+/g, ' ').trim() : '';
}

/**
 * Validate the model's React code, wrap it in the runner, persist both the
 * runner HTML and the raw JSX, and return the artifact record.
 *
 * Two entry modes:
 *   • `code`  — full component source (fresh builds and big rewrites).
 *   • `edits` — targeted find/replace patches against the artifact currently
 *     open in the panel (ctx.activeArtifactCode, threaded from the request).
 *     The server merges them and rebuilds, so a small change doesn't require
 *     the model to re-emit thousands of lines it isn't touching.
 */
export async function buildReactArtifact(args = {}, ctx = {}) {
  const title = String(args.title || '').trim().slice(0, 160) || 'Interactive artifact';
  let code = String(args.code ?? '');
  const edits = Array.isArray(args.edits) ? args.edits.filter((e) => e && typeof e === 'object') : [];
  let editedInPlace = false;
  const activeBase = String(ctx.activeArtifactCode ?? '');
  const wantsFullRewrite = args.full_rewrite === true;

  // Prefer `edits` whenever an open artifact exists — even if the model also
  // sent a full `code` body. That dual-submit pattern is how "add 10 hooks"
  // used to become a whole new look: the model rewrote everything and the
  // edits were ignored because `code` was non-empty.
  if (edits.length > 0 && !(wantsFullRewrite && code.trim())) {
    if (!activeBase.trim()) {
      return {
        ok: false,
        error: 'no_artifact_to_edit',
        hint:
          '`edits` only works while an existing artifact is open in the panel. ' +
          'Call the tool again with the complete component source in `code` instead.',
      };
    }
    const patched = applyArtifactEdits(activeBase, edits);
    if (!patched.ok) return patched;
    code = patched.code;
    editedInPlace = true;
  }

  // SCOPE GUARD — the #1 edit-turn failure: the user asks for one small
  // change and the model re-emits the whole component "improved" (reformatted,
  // recolored, sections rewritten). When an artifact is open and the model
  // sends full `code` WITHOUT declaring full_rewrite, measure how much of the
  // existing source actually changed; a sweeping rewrite gets bounced back
  // once with instructions to use targeted `edits` (or to declare the rewrite
  // deliberately when the user truly asked for one).
  if (!editedInPlace && code.trim() && activeBase.trim() && !wantsFullRewrite) {
    const ratio = codeChangeRatio(activeBase, code);
    const prevTheme = extractThemeBlock(activeBase);
    const nextTheme = extractThemeBlock(code);
    const themeChurned = Boolean(prevTheme && nextTheme && prevTheme !== nextTheme);
    if (ratio > UNSCOPED_REWRITE_RATIO || themeChurned) {
      const why = themeChurned && ratio <= UNSCOPED_REWRITE_RATIO
        ? 'changed the THEME tokens (a visual redesign) without full_rewrite'
        : `changed ~${Math.round(ratio * 100)}% of the open artifact without full_rewrite`;
      console.warn(`🧑‍💻 Artifact scope guard: full-code submission ${why} — bouncing to edits`);
      return {
        ok: false,
        error: themeChurned && ratio <= UNSCOPED_REWRITE_RATIO ? 'theme_rewrite' : 'unscoped_rewrite',
        changed_ratio: Math.round(ratio * 100) / 100,
        hint:
          `Your code ${why}, but they asked for a targeted change. Call the tool again with \`edits\` ONLY — ` +
          '{find, replace} patches copied EXACTLY from the current source in [ARTIFACT_OPEN] — that implement ' +
          'ONLY what the user requested, leaving every other line untouched (THEME, classNames, layout, fonts). ' +
          'Do not reformat, rename, restyle, or "improve" anything they did not ask about. Expanding ' +
          'lists/hooks/copy is an edits job. ONLY if the user explicitly asked for a sweeping ' +
          'restyle/rebuild/restructure, retry with the complete `code` plus `full_rewrite: true`.',
      };
    }
  }

  if (!code.trim()) {
    return {
      ok: false,
      error: 'code_required',
      hint:
        'You must WRITE the React component yourself and pass its full source in the `code` argument — ' +
        'do not ask the user for code. Call this tool again now with `title` and the complete component (export default, Tailwind classes).',
    };
  }
  if (code.length > MAX_CODE_LEN) {
    return { ok: false, error: 'code_too_long', max_chars: MAX_CODE_LEN };
  }
  if (!looksLikeComponent(code)) {
    return {
      ok: false,
      error: 'no_component_found',
      hint: 'Pass a complete single-file React component with `export default` (or a top-level `App`).',
    };
  }

  const base = slugify(title);
  const html = buildReactRunnerHtml({ title, code });

  let result = {
    ok: true,
    kind: 'react',
    title,
    filename: `${base}.html`,
    char_count: code.length,
    // Client-only (stripped from the model's tool-result context, like every
    // preview_html): the offline srcDoc fallback for the artifact card.
    preview_html: html,
    usage_hint:
      'The artifact is ALREADY rendering live in the side panel. Reply with a 1-2 sentence summary of ' +
      'what you built — do NOT paste the code, the HTML, or any URL into the chat.',
  };
  if (editedInPlace) {
    result.edits_applied = edits.length;
    // Client-only (stripped like preview_html): on the edits path the merged
    // source isn't in the tool-call args, so the client needs it echoed here
    // to keep the NEXT edit round-trip working.
    result.artifact_code = code;
    result.usage_hint =
      `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to the existing artifact — it is already ` +
      'refreshed in the side panel. Reply with a 1-2 sentence summary of what changed; do NOT paste code or URLs.';
  }

  if (ctx.supabaseAdmin && ctx.userId) {
    const stored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
      buffer: Buffer.from(html, 'utf8'),
      filename: `${base}.html`,
      mimeType: 'text/html; charset=utf-8',
      category: 'react',
    });
    if (stored.ok) {
      result = {
        ...result,
        persisted: true,
        file_url: stored.file_url,
        storage_path: stored.storage_path,
        expires_in_sec: stored.expires_in_sec,
        download_links: [{ format: 'html', url: stored.file_url, filename: stored.filename }],
      };
      // The raw component source as a second download (also what `action=load`
      // style flows or the user's own tooling would want).
      const codeStored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
        buffer: Buffer.from(code, 'utf8'),
        filename: `${base}.jsx`,
        mimeType: 'text/plain; charset=utf-8',
        category: 'react',
      });
      if (codeStored.ok) {
        result.download_links.push({ format: 'jsx', url: codeStored.file_url, filename: codeStored.filename });
        result.code_storage_path = codeStored.storage_path;
      }
    } else {
      result.persisted = false;
      result.persistence_warning = stored.error;
    }
  }

  return result;
}
