// Throwaway sanity test for lykn_build_react_artifact's runner HTML.
// 1. Builds the runner from a realistic model-written component.
// 2. Re-applies the exact same source transformations the runner performs
//    in the browser, then compiles the result with esbuild (a stand-in for
//    Babel standalone) to prove the prepared source is syntactically valid.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildReactArtifact, buildReactRunnerHtml } from '../lib/exterior/capabilities/buildReactArtifact.js';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const SAMPLE = `import React, { useState, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { Check, TrendingUp } from "lucide-react";

const DATA = [
  { month: "Jan", value: 12 },
  { month: "Feb", value: 19 },
  { month: "Mar", value: 8 },
];

export default function App() {
  const [count, setCount] = useState(0);
  const total = useMemo(() => DATA.reduce((s, d) => s + d.value, 0), []);
  const { LineChart } = Recharts;
  const { Star } = LucideReact;
  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold flex items-center gap-2">
        <TrendingUp className="w-6 h-6" /> Quarterly Report
      </h1>
      <p className="text-gray-600 mt-2">Total: {total}</p>
      <button
        className="mt-4 px-4 py-2 rounded-lg bg-blue-600 text-white"
        onClick={() => setCount((c) => c + 1)}
      >
        <Check className="inline w-4 h-4" /> Clicked {count} times
      </button>
      <BarChart width={480} height={240} data={DATA} className="mt-6">
        <XAxis dataKey="month" />
        <YAxis />
        <Tooltip />
        <Bar dataKey="value" fill="#2563eb" />
      </BarChart>
    </div>
  );
}
`;

// ── 1. Handler-level checks (no auth ctx → no persist, but preview_html) ──
const res = await buildReactArtifact({ title: 'Quarterly Report', code: SAMPLE }, {});
if (!res.ok) { console.error('FAIL: handler returned', res); process.exit(1); }
if (!res.preview_html?.includes('lykn-artifact-source')) {
  console.error('FAIL: runner HTML missing source block'); process.exit(1);
}
console.log('handler ok — kind:', res.kind, 'filename:', res.filename);

// Rejections
const bad = await buildReactArtifact({ title: 'x', code: 'just some text with no component' }, {});
console.log('reject non-component:', bad.ok === false && bad.error === 'no_component_found' ? 'ok' : `FAIL ${JSON.stringify(bad)}`);

// ── 2. Verify the embedded transform regexes survived template escaping ──
const html = buildReactRunnerHtml({ title: 'T', code: SAMPLE });
const mustContain = [
  String.raw`/^[ \t]*import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]*['"];?[ \t]*$/gm`,
  String.raw`/^[ \t]*import\s[^\n]*$/gm`,
  'window.__lyknArtifactDefault = function ',
];
for (const frag of mustContain) {
  if (!html.includes(frag)) { console.error('FAIL: runner missing fragment:', frag); process.exit(1); }
}
console.log('runner regex fragments ok');

// Script-tag safety: a </script> inside the code must not escape the JSON block
const evil = await buildReactArtifact({ title: 'x', code: 'export default function App(){ return <div>{"</scr" + "ipt>"}</div>; }\n// literal </script> here' }, {});
const block = evil.preview_html.match(/<script id="lykn-artifact-source"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '';
if (block.includes('</script>')) { console.error('FAIL: unescaped </script> in source block'); process.exit(1); }
JSON.parse(block); // must round-trip
console.log('script-tag escaping ok');

// ── 3. Replicate the browser-side transform, compile with esbuild ─────────
function destructureFrom(globalName) {
  return (_m, names) => `var {${names.replace(/\s+as\s+/g, ': ')}} = ${globalName};`;
}
function prepare(src) {
  return String(src)
    .replace(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]react['"];?/g, destructureFrom('React'))
    .replace(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]react-dom(?:\/client)?['"];?/g, destructureFrom('ReactDOM'))
    .replace(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]recharts['"];?/g, destructureFrom('Recharts'))
    .replace(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]lucide-react['"];?/g, destructureFrom('LucideReact'))
    .replace(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"](?:framer-motion|motion\/react|motion)['"];?/g, destructureFrom('window.Motion'))
    .replace(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]d3['"];?/g, destructureFrom('window.d3'))
    .replace(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]three['"];?/g, destructureFrom('window.THREE'))
    .replace(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]lodash(?:-es)?['"];?/g, destructureFrom('window._'))
    .replace(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]mathjs['"];?/g, destructureFrom('window.math'))
    .replace(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]papaparse['"];?/g, destructureFrom('window.Papa'))
    .replace(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]marked['"];?/g, destructureFrom('window.marked'))
    .replace(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]tone['"];?/g, destructureFrom('window.Tone'))
    .replace(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]jspdf['"];?/g, destructureFrom('window.jspdf'))
    .replace(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]d3['"];?/g, 'var $1 = window.d3;')
    .replace(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]three['"];?/g, 'var $1 = window.THREE;')
    .replace(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]tone['"];?/g, 'var $1 = window.Tone;')
    .replace(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]mathjs['"];?/g, 'var $1 = window.math;')
    .replace(/import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]lodash(?:-es)?['"];?/g, 'var $1 = window._;')
    .replace(/import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]dayjs['"];?/g, 'var $1 = window.dayjs;')
    .replace(/import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]papaparse['"];?/g, 'var $1 = window.Papa;')
    .replace(/import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]canvas-confetti['"];?/g, 'var $1 = window.confetti;')
    .replace(/import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]html2canvas['"];?/g, 'var $1 = window.html2canvas;')
    .replace(/^[ \t]*import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]*['"];?[ \t]*$/gm, '')
    .replace(/^[ \t]*import\s[^\n]*$/gm, '')
    .replace(/^[ \t]*(?:const|let)\s*(\{[^}]*\})\s*=\s*React\s*;?[ \t]*$/gm, 'var $1 = React;')
    .replace(/^[ \t]*(?:const|let)\s*(\{[^}]*\})\s*=\s*(?:window\.)?Recharts\s*;?[ \t]*$/gm, 'var $1 = Recharts;')
    .replace(/^[ \t]*(?:const|let)\s*(\{[^}]*\})\s*=\s*(?:window\.)?LucideReact\s*;?[ \t]*$/gm, 'var $1 = LucideReact;')
    .replace(/^([ \t]*)(?:const|let)(\s*(?:\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(?:window\.)?(?:React|ReactDOM|Motion|FramerMotion|Recharts|LucideReact|lucideReact|THREE|d3|Tone|math|Papa|marked|dayjs|confetti|html2canvas|jspdf)\b[^\n]*)$/gm, '$1var$2')
    .replace(/export\s+default\s+function\s+/g, 'window.__lyknArtifactDefault = function ')
    .replace(/export\s+default\s+class\s+/g, 'window.__lyknArtifactDefault = class ')
    .replace(/export\s+default\s+/g, 'window.__lyknArtifactDefault = ')
    .replace(/^[ \t]*export\s+\{[^}]*\}\s*;?[ \t]*$/gm, '')
    .replace(/^([ \t]*)export\s+(const|let|var|function|class)\s+/gm, '$1$2 ');
}
const prepared = prepare(SAMPLE);

if (/^\s*import\s/m.test(prepared)) { console.error('FAIL: import lines survived:\n' + prepared.slice(0, 400)); process.exit(1); }
if (!prepared.includes('window.__lyknArtifactDefault = function App')) {
  console.error('FAIL: export default not rewritten'); process.exit(1);
}
if (!prepared.includes('} = Recharts;') || !prepared.includes('} = LucideReact;')) {
  console.error('FAIL: named imports not rewired to globals:\n' + prepared.slice(0, 500)); process.exit(1);
}

const prelude = [
  'var { useState, useEffect, useMemo, useCallback, useRef, useReducer,',
  '  useContext, useLayoutEffect, useId, useTransition, useDeferredValue,',
  '  useImperativeHandle, useSyncExternalStore, Fragment, StrictMode,',
  '  createContext, forwardRef, memo } = React;',
  // Mirrors the runner's __lyknSafeLib proxy: unknown CAPITALIZED lookups on
  // the icon/chart globals return a fallback component instead of undefined.
  'function __lyknSafeLib(raw, label, fallback) {',
  '  if (typeof Proxy !== "function") return raw;',
  '  return new Proxy(raw, { get: function (t, k) {',
  '    var v = t[k];',
  '    if (v === undefined && typeof k === "string" && /^[A-Z]/.test(k)) return fallback;',
  '    return v;',
  '  } });',
  '}',
  'var __lyknRawLucide = window.LucideReact || window.lucideReact || {};',
  'var LucideReact = __lyknSafeLib(__lyknRawLucide, "lucide icon",',
  '  __lyknRawLucide.Circle || __lyknRawLucide.HelpCircle || function () { return null; });',
  'var Recharts = __lyknSafeLib(window.Recharts || {}, "recharts", function () { return null; });',
  'var FramerMotion = window.Motion || {};',
  'var motion = FramerMotion.motion;',
  'var AnimatePresence = FramerMotion.AnimatePresence;',
  'var jsPDF = (window.jspdf || {}).jsPDF;',
  '',
].join('\n');
const epilogue = [
  '',
  ';window.__lyknArtifactDefault = window.__lyknArtifactDefault ||',
  '  (typeof App !== "undefined" ? App : null);',
].join('\n');

// Mirror the runner: model code lives in its own block scope so its
// const/let declarations shadow the prelude vars instead of colliding.
// After esbuild transpiles the JSX, `new Function` makes V8 apply the real
// redeclaration rules — exactly what the browser does with Babel's output.
function compileLikeRunner(preparedSrc, label) {
  try {
    const out = esbuild.transformSync(prelude + '{\n' + preparedSrc + epilogue + '\n}', { loader: 'tsx' });
    new Function(out.code); // syntax/scope check only — never executed
    console.log(`esbuild compile of ${label} ok —`, out.code.length, 'bytes');
  } catch (e) {
    console.error(`FAIL: ${label} does not compile:`, e.message);
    process.exit(1);
  }
}
compileLikeRunner(prepared, 'prepared source');

// ── 3b. Expanded-stack sample: framer-motion / d3 / three / lodash / dayjs /
//        marked / jspdf / confetti imports must all rewire to CDN globals. ──
const SAMPLE_LIBS = `import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as d3 from "d3";
import * as THREE from "three";
import _ from "lodash";
import dayjs from "dayjs";
import { marked } from "marked";
import { jsPDF } from "jspdf";
import confetti from "canvas-confetti";
import Papa from "papaparse";

export default function App() {
  const [open, setOpen] = useState(true);
  const mountRef = useRef(null);
  useEffect(() => {
    const scene = new THREE.Scene();
    const scale = d3.scaleLinear().domain([0, 10]).range([0, 100]);
    void scene; void scale;
  }, []);
  const today = dayjs().format("MMM D, YYYY");
  const summary = _.capitalize("hello world");
  const html = marked.parse("# Title");
  const exportPdf = () => { const doc = new jsPDF(); doc.text("hi", 10, 10); doc.save("out.pdf"); };
  const csv = Papa.unparse([{ a: 1 }]);
  return (
    <div ref={mountRef} className="p-8" onClick={() => confetti()}>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {today} — {summary} — {csv}
            <div dangerouslySetInnerHTML={{ __html: html }} />
            <button onClick={exportPdf}>Export</button>
            <button onClick={() => setOpen(false)}>Close</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
`;
const preparedLibs = prepare(SAMPLE_LIBS);
if (/^\s*import\s/m.test(preparedLibs)) {
  console.error('FAIL: expanded-stack import lines survived:\n' + preparedLibs.slice(0, 600)); process.exit(1);
}
for (const frag of [
  '} = window.Motion;',
  'var d3 = window.d3;',
  'var THREE = window.THREE;',
  'var _ = window._;',
  'var dayjs = window.dayjs;',
  '} = window.marked;',
  '} = window.jspdf;',
  'var confetti = window.confetti;',
  'var Papa = window.Papa;',
]) {
  if (!preparedLibs.includes(frag)) {
    console.error('FAIL: expanded-stack import not rewired, missing:', frag); process.exit(1);
  }
}
compileLikeRunner(preparedLibs, 'expanded-stack source');

// ── 3c. Regression: model-written top-level `const { motion, AnimatePresence }`
//        must SHADOW the prelude's var bindings, not throw "Identifier
//        'motion' has already been declared" (real artifact failure). ──
const SAMPLE_SHADOW = `const { motion, AnimatePresence } = window.Motion || { motion: "div", AnimatePresence: ({ children }) => children };
const Lucide = window.LucideReact || {};
const { Sparkles } = Lucide;
const jsPDF = (window.jspdf || {}).jsPDF;
const dayjs = window.dayjs;

export default function App() {
  const [on, setOn] = React.useState(true);
  return (
    <AnimatePresence>
      {on && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <Sparkles className="w-4 h-4" />
          <button onClick={() => setOn(false)}>{String(Boolean(jsPDF))} {dayjs ? "d" : ""}</button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
`;
compileLikeRunner(prepare(SAMPLE_SHADOW), 'prelude-shadowing source');

// ── 3d. Regression: "Cannot access 'motion' before initialization". If the
//        model uses a CDN global at the TOP LEVEL (JSX in a data array) and
//        ALSO declares its own `const { motion } = window.Motion` LATER, the
//        late const puts the whole block in a temporal dead zone. prepare()
//        must rewrite those aliases to `var` so they merge with the prelude.
//        This one must actually EXECUTE — TDZ is a runtime error. ──
const SAMPLE_TDZ = `const NAV = [
  { label: "Home", icon: <motion.div animate={{ opacity: 1 }} /> },
  { label: "Docs", icon: <Sparkles /> },
];

const { motion, AnimatePresence } = window.Motion || {};
const { Sparkles } = window.LucideReact || {};
const jsPDF = window.jspdf.jsPDF;

export default function App() {
  return (
    <AnimatePresence>
      <motion.div>{NAV.map((n) => n.label).join(", ")}</motion.div>
    </AnimatePresence>
  );
}
`;
{
  const preparedTdz = prepare(SAMPLE_TDZ);
  if (/^\s*(?:const|let)\s*\{\s*motion/m.test(preparedTdz)) {
    console.error('FAIL: late `const { motion } = window.Motion` not rewritten to var:\n' + preparedTdz.slice(0, 500));
    process.exit(1);
  }
  const out = esbuild.transformSync(prelude + '{\n' + preparedTdz + epilogue + '\n}', { loader: 'tsx' });
  // Execute with stub globals, exactly like the browser runner does.
  const motionStub = new Proxy(function () {}, { get: () => 'div' });
  const windowStub = {
    Motion: { motion: motionStub, AnimatePresence: ({ children }) => children },
    LucideReact: { Sparkles: () => null },
    Recharts: {},
    jspdf: { jsPDF: function () {} },
  };
  const reactStub = {
    createElement: () => null,
    useState: () => [null, () => {}], useEffect: () => {}, useMemo: (f) => f(),
    useCallback: (f) => f, useRef: () => ({}), useReducer: () => [null, () => {}],
    useContext: () => null, useLayoutEffect: () => {}, useId: () => 'id',
    useTransition: () => [false, (f) => f()], useDeferredValue: (v) => v,
    useImperativeHandle: () => {}, useSyncExternalStore: () => null,
    Fragment: 'Fragment', StrictMode: 'StrictMode',
    createContext: () => ({}), forwardRef: (f) => f, memo: (f) => f,
  };
  try {
    new Function('window', 'React', out.code)(windowStub, reactStub);
  } catch (e) {
    console.error('FAIL: TDZ regression — block threw at runtime:', e.message);
    process.exit(1);
  }
  if (typeof windowStub.__lyknArtifactDefault !== 'function') {
    console.error('FAIL: TDZ regression — no default export captured');
    process.exit(1);
  }
  console.log('TDZ regression (top-level use before late const alias) ok');
}

// ── 3e. Regression: hallucinated lucide icon (React error #130). A model
//        importing an icon that doesn't exist in the loaded lucide UMD used
//        to destructure `undefined` and crash the whole artifact at render.
//        The __lyknSafeLib proxy must hand back a fallback component. ──
const SAMPLE_BAD_ICON = `import { Check, TotallyMadeUpIcon } from "lucide-react";
const { AlsoNotReal } = LucideReact;

export default function App() {
  return (
    <div>
      <Check /> <TotallyMadeUpIcon className="w-4 h-4" /> <AlsoNotReal />
    </div>
  );
}
`;
{
  const preparedIcon = prepare(SAMPLE_BAD_ICON);
  const out = esbuild.transformSync(prelude + '{\n' + preparedIcon + epilogue + '\n}', { loader: 'tsx' });
  const rendered = [];
  const windowStub = {
    LucideReact: { Check: function Check() { return null; }, Circle: function Circle() { return null; } },
    Recharts: {},
  };
  const reactStub = {
    createElement: (type) => { rendered.push(type); return null; },
    Fragment: 'Fragment', StrictMode: 'StrictMode',
    useState: () => [null, () => {}], useEffect: () => {}, useMemo: (f) => f(),
    useCallback: (f) => f, useRef: () => ({}), useReducer: () => [null, () => {}],
    useContext: () => null, useLayoutEffect: () => {}, useId: () => 'id',
    useTransition: () => [false, (f) => f()], useDeferredValue: (v) => v,
    useImperativeHandle: () => {}, useSyncExternalStore: () => null,
    createContext: () => ({}), forwardRef: (f) => f, memo: (f) => f,
  };
  new Function('window', 'React', out.code)(windowStub, reactStub);
  const App = windowStub.__lyknArtifactDefault;
  if (typeof App !== 'function') { console.error('FAIL: bad-icon sample lost its default export'); process.exit(1); }
  App({});
  const bad = rendered.filter((t) => t === undefined);
  if (bad.length) {
    console.error(`FAIL: hallucinated icons rendered as undefined (${bad.length}) — React #130 regression`);
    process.exit(1);
  }
  console.log('hallucinated-icon fallback (React #130 guard) ok — rendered types:', rendered.map((t) => (typeof t === 'function' ? t.name || 'fn' : String(t))).join(', '));
}

// The runner HTML must ship every CDN dependency + the styling layer.
const depHtml = buildReactRunnerHtml({ title: 'deps', code: SAMPLE_LIBS });
for (const dep of [
  'framer-motion@', 'd3@', 'three@', 'lodash@', 'dayjs@', 'mathjs@',
  'papaparse@', 'marked@', 'tone@', 'canvas-confetti@', 'html2canvas@', 'jspdf@',
  // Styling layer
  'fonts.googleapis.com/css2?family=Inter',
  'daisyui@',
  'animate.css@',
  'cdn.tailwindcss.com?plugins=forms,typography,aspect-ratio,line-clamp',
  'tailwind.config',
  'Space Grotesk',
  'data-theme="light"',
]) {
  if (!depHtml.includes(dep)) { console.error('FAIL: runner missing CDN dep:', dep); process.exit(1); }
}
console.log('runner CDN dependency + styling tags ok');

// ── 4. Write the runner somewhere inspectable ────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'lykn-react-artifact-'));
const file = join(dir, 'runner.html');
writeFileSync(file, html);
console.log('runner written to', file);
console.log('ALL CHECKS PASSED');
