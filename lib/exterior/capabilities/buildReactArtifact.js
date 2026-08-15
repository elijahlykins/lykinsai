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
import {
  applyFileOps,
  applyProjectEdits,
  bundleCodeProject,
  filesMapToArray,
  normalizeProjectFiles,
  normalizeTodos,
  projectSourceForLibDetect,
  resolveEntry,
} from './codeProjectBundle.js';
import { parse as babelParse } from '@babel/parser';

const MAX_CODE_LEN = 220000;

/** Rough component sanity check — not a compile, just "is this a component". */
function looksLikeComponent(code) {
  return /export\s+default|function\s+[A-Z][A-Za-z0-9_]*\s*\(|const\s+[A-Z][A-Za-z0-9_]*\s*=/.test(code);
}

/**
 * Smoke-parse JSX/TS before we persist + show the preview. Catches syntax
 * errors the browser runner would otherwise surface to the user first.
 */
export function validateArtifactSource(code, label = 'artifact') {
  const src = String(code || '');
  if (!src.trim()) {
    return {
      ok: false,
      error: 'empty_source',
      hint: `${label} is empty — pass valid React source.`,
    };
  }
  try {
    babelParse(src, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      errorRecovery: false,
      plugins: [
        'jsx',
        'typescript',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'dynamicImport',
        'importMeta',
        'topLevelAwait',
      ],
    });
    return { ok: true };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 500);
    console.warn(`🧑‍💻 Artifact compile check failed (${label}):`, msg);
    return {
      ok: false,
      error: 'compile_error',
      compile_message: msg,
      hint:
        `JSX/TS compile failed in ${label}: ${msg}. ` +
        'Fix the syntax and call again with `edits` (or corrected `code`/`files`). ' +
        'Do not summarize as done until compile succeeds — the user must not see a broken preview.',
    };
  }
}

/** Validate every JS/TS source file in a multi-file project. */
export function validateProjectSources(files) {
  const map = files instanceof Map ? files : null;
  if (!map || !map.size) return { ok: true };
  for (const [path, content] of map) {
    if (!/\.(jsx?|tsx?)$/i.test(path)) continue;
    const check = validateArtifactSource(content, path);
    if (!check.ok) return check;
  }
  return { ok: true };
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
 * Detect which optional CDN libs the component actually uses so the runner
 * doesn't block first paint on three.js / Tone / daisyUI / etc. for a simple
 * counter. Always-on path stays React + ReactDOM + Babel + Tailwind.
 */
export function detectArtifactLibs(code) {
  const c = String(code || '');
  const has = (re) => re.test(c);
  return {
    recharts: has(/recharts|Recharts|ResponsiveContainer|LineChart|BarChart|AreaChart|PieChart|ScatterChart|RadarChart|ComposedChart|\bXAxis\b|\bYAxis\b|\bCartesianGrid\b/),
    // Icons: import path, LucideReact global, or JSX tags that models commonly
    // use without importing (prelude proxy only helps when the UMD is loaded).
    lucide: has(/lucide-react|LucideReact|lucideReact/) ||
      has(/<\s*(?:Check|X|Plus|Minus|Search|Home|Settings|User|Users|Star|Heart|Mail|Phone|Calendar|Clock|Arrow(?:Left|Right|Up|Down)|Chevron(?:Left|Right|Up|Down)|Menu|Trash(?:2)?|Edit(?:2)?|Copy|Download|Upload|ExternalLink|Image|File|Folder|Play|Pause|Sparkles|TrendingUp|TrendingDown|Info|Alert(?:Circle|Triangle)|Loader(?:2)?|Refresh(?:Cw)?|Eye|EyeOff|Lock|Unlock|Bell|Bookmark|Share(?:2)?|Link|Globe|Map(?:Pin)?|Camera|Mic|Volume2|Zap|Target|Layers|Layout|Grid|List|Filter|Sliders|MoreHorizontal|MoreVertical)\b/),
    motion: has(/framer-motion|motion\/react|AnimatePresence|\bmotion\./),
    d3: has(/from\s*['"]d3['"]|\bwindow\.d3\b|\bd3\./),
    three: has(/from\s*['"]three['"]|\bTHREE\./),
    lodash: has(/from\s*['"]lodash|\bwindow\._\b|\blodash\b/),
    dayjs: has(/dayjs/),
    mathjs: has(/from\s*['"]mathjs['"]|\bwindow\.math\b/),
    papa: has(/papaparse|PapaParse|\bPapa\./),
    marked: has(/from\s*['"]marked['"]|\bmarked\./),
    tone: has(/from\s*['"]tone['"]|\bTone\./),
    confetti: has(/canvas-confetti|\bconfetti\s*\(/),
    html2canvas: has(/html2canvas/),
    jspdf: has(/jspdf|jsPDF/),
    // Only when daisy classes appear in className/class — bare English words
    // like "alert" / "progress" must not pull the full daisyUI CSS.
    daisy: has(/(?:className|class)\s*=\s*["'`][^"'`]*\b(?:btn|modal|drawer|navbar|dropdown|badge|alert|card-title|tabs-boxed|swap|collapse|stat|progress|radial-progress|tooltip|form-control|input-bordered|select-bordered)\b/),
    animate: has(/animate__|\banimate\.css\b/),
  };
}

function scriptTag(src) {
  return `<script crossorigin src="${src}"><\/script>`;
}

function styleTag(href) {
  return `<link rel="stylesheet" href="${href}" />`;
}

/**
 * Build the self-contained runner document. Critical path is lean (React +
 * Babel + Tailwind); optional libs are included only when the source uses them.
 * A boot overlay covers the white canvas until mount succeeds or errors.
 */
export function buildReactRunnerHtml({ title, code, libDetectSource }) {
  const safeTitle = escapeHtml(String(title || 'Interactive artifact').slice(0, 160));
  const sourceJson = jsonForScriptTag(code);
  const libs = detectArtifactLibs(libDetectSource || code);

  const optionalScripts = [];
  // lucide-react UMD reads lowercase `react` / `react-dom` globals.
  if (libs.lucide || libs.recharts || libs.motion) {
    optionalScripts.push(
      '<script>window.react=window.React;window["react-dom"]=window.ReactDOM;</script>',
    );
  }
  if (libs.recharts) {
    optionalScripts.push(scriptTag('https://unpkg.com/prop-types@15/prop-types.min.js'));
    optionalScripts.push(scriptTag('https://unpkg.com/recharts@2.15.0/umd/Recharts.js'));
  }
  if (libs.lucide) {
    optionalScripts.push(scriptTag('https://unpkg.com/lucide-react@0.454.0/dist/umd/lucide-react.min.js'));
  }
  if (libs.motion) {
    optionalScripts.push(scriptTag('https://unpkg.com/framer-motion@11.11.17/dist/framer-motion.js'));
  }
  if (libs.d3) optionalScripts.push(scriptTag('https://unpkg.com/d3@7.9.0/dist/d3.min.js'));
  if (libs.three) optionalScripts.push(scriptTag('https://unpkg.com/three@0.160.1/build/three.min.js'));
  if (libs.lodash) optionalScripts.push(scriptTag('https://unpkg.com/lodash@4.17.21/lodash.min.js'));
  if (libs.dayjs) optionalScripts.push(scriptTag('https://unpkg.com/dayjs@1.11.13/dayjs.min.js'));
  if (libs.mathjs) optionalScripts.push(scriptTag('https://unpkg.com/mathjs@12.4.3/lib/browser/math.js'));
  if (libs.papa) optionalScripts.push(scriptTag('https://unpkg.com/papaparse@5.4.1/papaparse.min.js'));
  if (libs.marked) optionalScripts.push(scriptTag('https://unpkg.com/marked@12.0.2/marked.min.js'));
  if (libs.tone) optionalScripts.push(scriptTag('https://unpkg.com/tone@14.8.49/build/Tone.js'));
  if (libs.confetti) optionalScripts.push(scriptTag('https://unpkg.com/canvas-confetti@1.9.3/dist/confetti.browser.js'));
  if (libs.html2canvas) optionalScripts.push(scriptTag('https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js'));
  if (libs.jspdf) optionalScripts.push(scriptTag('https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js'));

  const optionalStyles = [];
  if (libs.daisy) optionalStyles.push(styleTag('https://cdn.jsdelivr.net/npm/daisyui@4.12.24/dist/full.min.css'));
  if (libs.animate) optionalStyles.push(styleTag('https://unpkg.com/animate.css@4.1.1/animate.min.css'));

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script>
${optionalScripts.join('\n')}
<script crossorigin src="https://unpkg.com/@babel/standalone@7/babel.min.js"><\/script>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" />
${optionalStyles.join('\n')}
<script src="https://cdn.tailwindcss.com?plugins=forms,typography,aspect-ratio,line-clamp"><\/script>
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
    margin: 0; background: #fafafa; -webkit-font-smoothing: antialiased;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  #lykn-boot {
    position: fixed; inset: 0; z-index: 99998; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 10px;
    background: #fafafa; color: #64748b;
    font: 13.5px/1.45 Inter, ui-sans-serif, system-ui, sans-serif;
  }
  #lykn-boot[hidden] { display: none !important; }
  #lykn-boot-dot {
    width: 28px; height: 28px; border-radius: 999px;
    border: 2.5px solid #cbd5e1; border-top-color: #334155;
    animation: lykn-spin .7s linear infinite;
  }
  @keyframes lykn-spin { to { transform: rotate(360deg); } }
  #lykn-artifact-error {
    display: none; position: fixed; inset: 12px 12px auto 12px; z-index: 99999;
    background: #7f1d1d; color: #fecaca; border-radius: 10px; padding: 12px 14px;
    font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap; word-break: break-word; max-height: 45vh; overflow: auto;
    box-shadow: 0 8px 30px rgba(0,0,0,.35);
  }
  @media print {
    #lykn-boot, #lykn-artifact-error { display: none !important; }
    body { background: #fff !important; }
  }
</style>
</head>
<body>
<div id="lykn-boot" aria-live="polite"><div id="lykn-boot-dot"></div><div>Loading preview…</div></div>
<div id="root"></div>
<div id="lykn-artifact-error" role="alert"></div>
<script id="lykn-artifact-source" type="application/json">${sourceJson}</script>
<script>
(function () {
  var errEl = document.getElementById("lykn-artifact-error");
  var bootEl = document.getElementById("lykn-boot");
  function hideBoot() {
    try { if (bootEl) bootEl.hidden = true; } catch (_) {}
  }
  // Production React throws opaque "Minified React error #NNN" messages —
  // decode the ones artifacts actually hit so the overlay (and the model,
  // when the user pastes the error back for a fix) says what went wrong.
  var REACT_ERR_DECODER = {
    "130": "a rendered component is undefined — usually a misspelled or non-existent icon/chart/library component name",
    "31": "a plain object was rendered as JSX content (render a field of it instead, e.g. {item.label} not {item})",
    "321": "invalid hook call — hooks (useState/useEffect/…) must be called at the top level of the component function",
    "310": "more hooks rendered than the previous render — hooks must not be called inside conditions or loops",
  };
  function reportToParent(payload) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: "lykn-artifact", ...payload }, "*");
      }
    } catch (_) {}
  }
  function showError(msg, kind) {
    msg = String(msg || "unknown error");
    var m = msg.match(/Minified React error #(\\d+)/);
    if (m && REACT_ERR_DECODER[m[1]]) {
      msg = "React #" + m[1] + ": " + REACT_ERR_DECODER[m[1]] + " — " + msg;
    }
    try {
      hideBoot();
      errEl.textContent = "Artifact error: " + msg;
      errEl.style.display = "block";
    } catch (_) {}
    reportToParent({ type: "runtime_error", message: msg, kind: kind || "error", at: Date.now() });
  }
  window.addEventListener("error", function (e) { showError(e && e.message, "error"); });
  window.addEventListener("unhandledrejection", function (e) {
    showError(e && e.reason && (e.reason.message || e.reason), "unhandledrejection");
  });
  // Mirror console.error so the agent can see soft failures (missing assets, etc.).
  try {
    var __origErr = console.error.bind(console);
    console.error = function () {
      try {
        var args = Array.prototype.slice.call(arguments).map(function (a) {
          if (a && a.stack) return String(a.stack);
          try { return typeof a === "string" ? a : JSON.stringify(a); } catch (_) { return String(a); }
        });
        reportToParent({ type: "console_error", message: args.join(" ").slice(0, 2000), at: Date.now() });
      } catch (_) {}
      return __origErr.apply(console, arguments);
    };
  } catch (_) {}
  reportToParent({ type: "ready", at: Date.now() });

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
    hideBoot();
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
          'Re-check the source in [ARTIFACT_OPEN] and retry with a corrected `find` snippet. ' +
          'Do NOT fall back to full `code` or full_rewrite.',
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
// Tight enough that "fix one handler" can't sneak in a quiet restyle.
const UNSCOPED_REWRITE_RATIO = 0.18;

/** Pull a THEME / theme token object literal from artifact source (best-effort). */
function extractThemeBlock(src) {
  const m = String(src).match(/\b(?:const|let|var)\s+THEME\s*=\s*\{[\s\S]*?\n\};?/);
  return m ? m[0].replace(/\s+/g, ' ').trim() : '';
}

/** Stable signature of colors + fonts so silent restyles are rejected. */
function extractStyleSignature(src) {
  const s = String(src || '');
  const colors = new Set();
  for (const m of s.matchAll(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g)) {
    colors.add(m[0].toLowerCase());
  }
  for (const m of s.matchAll(
    /\b(?:bg|text|border|from|to|via|ring|fill|stroke|outline|divide|accent|decoration|caret|shadow)-(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black|transparent|current|inherit)(?:-\d{2,3})?(?:\/\d{1,3})?\b/g,
  )) {
    colors.add(m[0]);
  }
  for (const m of s.matchAll(/\brgba?\([^)]+\)/gi)) colors.add(m[0].replace(/\s+/g, ''));
  const fonts = new Set();
  for (const m of s.matchAll(/\bfont-(?:sans|serif|mono|display|\[([^\]]+)\])/g)) {
    fonts.add(m[0]);
  }
  for (const m of s.matchAll(/fontFamily\s*:\s*['"][^'"]+['"]/g)) fonts.add(m[0]);
  return {
    colors: [...colors].sort().join('|'),
    fonts: [...fonts].sort().join('|'),
  };
}

/**
 * Validate the model's React code, wrap it in the runner, persist both the
 * runner HTML and the raw JSX, and return the artifact record.
 *
 * Entry modes:
 *   • `code`  — single-file component (fresh builds and big rewrites).
 *   • `files` — multi-file project [{path, content}] with relative imports.
 *   • `edits` — targeted find/replace patches (optional `path` per edit).
 *   • `file_ops` — write/delete files in an open multi-file project.
 *   • `todos` — coding plan checklist persisted on the artifact.
 *   • `assets` — [{name|path, url}] injected as window.__lyknAssets.
 */
export async function buildReactArtifact(args = {}, ctx = {}) {
  const title = String(args.title || ctx.activeArtifactTitle || '').trim().slice(0, 160) || 'Interactive artifact';
  let code = String(args.code ?? '');
  const edits = Array.isArray(args.edits) ? args.edits.filter((e) => e && typeof e === 'object') : [];
  const fileOps = Array.isArray(args.file_ops) ? args.file_ops.filter((e) => e && typeof e === 'object') : [];
  let editedInPlace = false;
  let projectFiles = null; // Map | null — set when multi-file
  let entry = null;
  let opsApplied = 0;

  const activeBase = String(ctx.activeArtifactCode ?? '');
  const activeFilesRaw = ctx.activeArtifactFiles;
  const activeFilesNorm = normalizeProjectFiles(activeFilesRaw);
  const hasActiveProject = activeFilesNorm.ok && activeFilesNorm.files.size > 0;
  const allowFullRewrite = ctx.allowFullRewrite === true;

  // Seed from open multi-file project when refining.
  if (hasActiveProject) {
    projectFiles = new Map(activeFilesNorm.files);
    entry = resolveEntry(projectFiles, args.entry || ctx.activeArtifactEntry);
  }

  // Fresh multi-file create / authorized full rewrite with `files`.
  const incomingFiles = args.files != null ? normalizeProjectFiles(args.files) : null;
  if (incomingFiles && !incomingFiles.ok) return incomingFiles;
  // When redesign is authorized, accept a full code/files dump even if the
  // model forgot full_rewrite: true (same failure mode as template restyles).
  const shippingFullDump =
    allowFullRewrite &&
    !edits.length &&
    !fileOps.length &&
    (Boolean(String(args.code ?? '').trim()) ||
      Boolean(incomingFiles && incomingFiles.files.size > 0));
  const wantsFullRewrite =
    allowFullRewrite && (args.full_rewrite === true || shippingFullDump);
  if (incomingFiles && incomingFiles.files.size > 0) {
    if (hasActiveProject && !allowFullRewrite && !edits.length && !fileOps.length) {
      // Full files dump over an open project without rewrite intent → bounce.
      console.warn('🧑‍💻 Artifact scope guard: open multi-file project requires edits/file_ops');
      return {
        ok: false,
        error: 'edits_required',
        hint:
          'A multi-file project is already open. Use `edits` ({path, find, replace}) and/or `file_ops` ' +
          '({op:"write"|"delete", path, content?}). Do not resubmit the full `files` array unless the user ' +
          'asked to rebuild (then set full_rewrite: true).',
      };
    }
    if (!hasActiveProject || wantsFullRewrite || allowFullRewrite) {
      projectFiles = incomingFiles.files;
      entry = resolveEntry(projectFiles, args.entry);
    }
  }

  // file_ops against open (or just-created) project.
  if (fileOps.length > 0) {
    if (!projectFiles || !projectFiles.size) {
      return {
        ok: false,
        error: 'no_project_to_edit',
        hint:
          '`file_ops` requires an open multi-file project (or pass `files` in the same call to create one).',
      };
    }
    const applied = applyFileOps(projectFiles, fileOps);
    if (!applied.ok) return applied;
    projectFiles = applied.files;
    opsApplied = applied.ops_applied;
    editedInPlace = true;
    entry = resolveEntry(projectFiles, args.entry || entry);
  }

  // Prefer `edits` whenever an open artifact exists.
  if (edits.length > 0 && !(wantsFullRewrite && (code.trim() || (incomingFiles && incomingFiles.files.size)))) {
    if (projectFiles && projectFiles.size) {
      const patched = applyProjectEdits(projectFiles, edits, entry);
      if (!patched.ok) return patched;
      projectFiles = patched.files;
      editedInPlace = true;
      entry = resolveEntry(projectFiles, entry);
    } else {
      if (!activeBase.trim()) {
        return {
          ok: false,
          error: 'no_artifact_to_edit',
          hint:
            '`edits` only works while an existing artifact is open in the preview popup. ' +
            'Call the tool again with the complete component source in `code` (or `files` for multi-file) instead.',
        };
      }
      const patched = applyArtifactEdits(activeBase, edits);
      if (!patched.ok) return patched;
      code = patched.code;
      editedInPlace = true;
    }
  }

  // Model claimed full_rewrite without a redesign ask.
  if (args.full_rewrite === true && (activeBase.trim() || hasActiveProject) && !allowFullRewrite && !editedInPlace) {
    console.warn('🧑‍💻 Artifact scope guard: full_rewrite ignored (no redesign intent)');
    return {
      ok: false,
      error: 'edits_required',
      hint:
        'An artifact is already open and the user did not ask to redesign/rebuild. ' +
        'Call again with `edits` ONLY — {find, replace} patches (add `path` for multi-file). ' +
        'Do not set full_rewrite. Do not change THEME, colors, fonts, or layout.',
    };
  }

  // HARD RULE — open artifact + no authorized full_rewrite ⇒ patches only.
  // Exception: todos-only / assets-only updates rebuild the open project as-is.
  const openSingle = Boolean(activeBase.trim()) && !hasActiveProject;
  const openMulti = hasActiveProject;
  const todosOnlyUpdate =
    args.todos != null &&
    !String(args.code ?? '').trim() &&
    !(incomingFiles && incomingFiles.files.size) &&
    !edits.length &&
    !fileOps.length;
  const assetsOnlyUpdate =
    Array.isArray(args.assets) &&
    args.assets.length > 0 &&
    !String(args.code ?? '').trim() &&
    !(incomingFiles && incomingFiles.files.size) &&
    !edits.length &&
    !fileOps.length &&
    args.todos == null;

  if (
    !editedInPlace &&
    (openSingle || openMulti) &&
    !allowFullRewrite &&
    !todosOnlyUpdate &&
    !assetsOnlyUpdate
  ) {
    console.warn('🧑‍💻 Artifact scope guard: open artifact requires edits — bouncing full code');
    return {
      ok: false,
      error: 'edits_required',
      hint:
        'An artifact is already open. Call again with `edits` ONLY — {find, replace} patches ' +
        (openMulti ? '(include `path` for the file to patch) and/or `file_ops` ' : '') +
        'copied EXACTLY from [ARTIFACT_OPEN]. Leave every other line untouched. ' +
        'Do not pass full `code`/`files`. Do not set full_rewrite.',
    };
  }

  // Todos/assets-only: keep open project/source and rebuild preview.
  if ((todosOnlyUpdate || assetsOnlyUpdate) && openSingle && !projectFiles) {
    code = activeBase;
  }

  // Bundle multi-file → runner code.
  let libDetectSource = null;
  if (projectFiles && projectFiles.size > 0) {
    // Inject assets map file when provided.
    const assets = normalizeAssets(args.assets);
    if (assets.length) {
      const assetsSrc =
        `export const ASSETS = ${JSON.stringify(Object.fromEntries(assets.map((a) => [a.name, a.url])), null, 2)};\n` +
        `export default ASSETS;\n` +
        `if (typeof window !== 'undefined') window.__lyknAssets = ASSETS;\n`;
      projectFiles.set('assets.js', assetsSrc);
    }

    const bundled = bundleCodeProject(projectFiles, entry || args.entry);
    if (!bundled.ok) return bundled;
    code = bundled.code;
    entry = bundled.entry;
    libDetectSource = projectSourceForLibDetect(projectFiles);
  }

  // After patches, reject silent visual redesigns on content-only asks.
  const allowStyleChange = ctx.allowStyleChange === true || allowFullRewrite;
  const styleCompareBase = hasActiveProject
    ? projectSourceForLibDetect(activeFilesNorm.files)
    : activeBase;
  const styleCompareNext = projectFiles && projectFiles.size
    ? projectSourceForLibDetect(projectFiles)
    : code;
  if ((activeBase.trim() || hasActiveProject) && styleCompareNext.trim() && !allowStyleChange && editedInPlace) {
    const prevTheme = extractThemeBlock(styleCompareBase);
    const nextTheme = extractThemeBlock(styleCompareNext);
    const themeChurned = Boolean(prevTheme && nextTheme && prevTheme !== nextTheme);
    const prevStyle = extractStyleSignature(styleCompareBase);
    const nextStyle = extractStyleSignature(styleCompareNext);
    const styleChurned =
      (prevStyle.colors && nextStyle.colors && prevStyle.colors !== nextStyle.colors) ||
      (prevStyle.fonts && nextStyle.fonts && prevStyle.fonts !== nextStyle.fonts);
    if (themeChurned || styleChurned) {
      console.warn('🧑‍💻 Artifact scope guard: style/theme churn on refine — bouncing');
      return {
        ok: false,
        error: themeChurned ? 'theme_rewrite' : 'style_rewrite',
        hint:
          'Your change altered THEME/colors/fonts, but the user only asked for a targeted content/logic edit. ' +
          'Retry with smaller `edits` that leave every color, font, THEME token, and className untouched.',
      };
    }
  }

  if (!code.trim()) {
    return {
      ok: false,
      error: 'code_required',
      hint:
        'You must WRITE the React component yourself — pass `code` (single file) or `files` ' +
        '([{path, content}] multi-file with App.jsx entry and relative imports). ' +
        'For complex games/apps prefer `files` so logic can be split across modules.',
    };
  }
  if (code.length > MAX_CODE_LEN) {
    return { ok: false, error: 'code_too_long', max_chars: MAX_CODE_LEN };
  }
  const isBundle = code.includes('__lyknRequire') && code.includes('__lyknMod');
  if (!isBundle && !looksLikeComponent(code)) {
    return {
      ok: false,
      error: 'no_component_found',
      hint: 'Pass a complete React component with `export default` (or a top-level `App`), or a multi-file `files` project.',
    };
  }

  // Compile-check BEFORE persist/preview so the user never sees a syntax-broken ship.
  if (projectFiles && projectFiles.size > 0) {
    const projectCheck = validateProjectSources(projectFiles);
    if (!projectCheck.ok) return projectCheck;
  } else if (!isBundle) {
    const sourceCheck = validateArtifactSource(code, 'code');
    if (!sourceCheck.ok) return sourceCheck;
  }

  const todos = normalizeTodos(
    args.todos != null ? args.todos : ctx.activeArtifactTodos,
  );

  const base = slugify(title);
  const html = buildReactRunnerHtml({ title, code, libDetectSource });

  let result = {
    ok: true,
    kind: 'react',
    title,
    filename: `${base}.html`,
    char_count: code.length,
    preview_html: html,
    usage_hint:
      'The artifact is ALREADY rendering live in the preview popup. Reply with a 1-2 sentence summary of ' +
      'what you built — do NOT paste the code, the HTML, or any URL into the chat. ' +
      'If you set `todos`, keep updating them as you finish steps on later turns.',
  };
  // Echo source for refine round-trips. For multi-file, `artifact_code` is the
  // entry file (edit surface) and `artifact_files` is the full project.
  if (projectFiles && projectFiles.size > 0) {
    const arr = filesMapToArray(projectFiles);
    result.artifact_files = arr;
    result.entry = entry || resolveEntry(projectFiles, null);
    result.file_count = arr.length;
    result.artifact_code = String(projectFiles.get(result.entry) || code);
    result.multi_file = true;
  } else {
    result.artifact_code = code;
  }
  if (todos.length) result.todos = todos;
  if (editedInPlace) {
    const n = edits.length + opsApplied;
    result.edits_applied = edits.length || undefined;
    result.file_ops_applied = opsApplied || undefined;
    result.usage_hint =
      `Applied ${n} change${n === 1 ? '' : 's'} to the existing artifact — it is already ` +
      'refreshed in the preview popup. Reply with a 1-2 sentence summary of what changed; do NOT paste code or URLs.';
  }
  if (projectFiles && projectFiles.size > 1) {
    result.usage_hint +=
      ` Project has ${projectFiles.size} files (entry ${result.entry}). Prefer path-scoped edits / file_ops next.`;
  }

  // Surface runtime errors from the previous preview load so the model can fix.
  const runtimeErrors = Array.isArray(ctx.activeArtifactRuntimeErrors)
    ? ctx.activeArtifactRuntimeErrors.slice(0, 20)
    : [];
  if (runtimeErrors.length) {
    result.prior_runtime_errors = runtimeErrors.map((e) => ({
      message: String(e?.message || e).slice(0, 500),
      kind: e?.kind,
    }));
    result.usage_hint +=
      ' NOTE: the previous preview reported runtime errors (see prior_runtime_errors) — fix them if still relevant.';
  }

  // Compact file listing for the model (full sources are client-only / ARTIFACT_OPEN).
  if (projectFiles && projectFiles.size) {
    result.file_tree = filesMapToArray(projectFiles).map((f) => ({
      path: f.path,
      chars: f.content.length,
    }));
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
      const sourcePayload = projectFiles && projectFiles.size
        ? JSON.stringify({ entry: result.entry, files: filesMapToArray(projectFiles) }, null, 2)
        : code;
      const sourceName = projectFiles && projectFiles.size ? `${base}.project.json` : `${base}.jsx`;
      const codeStored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
        buffer: Buffer.from(sourcePayload, 'utf8'),
        filename: sourceName,
        mimeType: projectFiles && projectFiles.size
          ? 'application/json; charset=utf-8'
          : 'text/plain; charset=utf-8',
        category: 'react',
      });
      if (codeStored.ok) {
        result.download_links.push({
          format: projectFiles && projectFiles.size ? 'json' : 'jsx',
          url: codeStored.file_url,
          filename: codeStored.filename,
        });
        result.code_storage_path = codeStored.storage_path;
      }
    } else {
      result.persisted = false;
      result.persistence_warning = stored.error;
    }
  }

  return result;
}

function normalizeAssets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, 40)) {
    if (!a || typeof a !== 'object') continue;
    const url = String(a.url || a.file_url || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const name = String(a.name || a.path || `asset_${out.length + 1}`)
      .replace(/[^A-Za-z0-9_\-./]/g, '_')
      .slice(0, 120);
    if (!name) continue;
    out.push({ name, url: url.slice(0, 2000) });
  }
  return out;
}
