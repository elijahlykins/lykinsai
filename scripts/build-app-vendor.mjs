/**
 * Vendor the runtime that installed apps load.
 *
 * Installed apps run from `lykn-app://` with no network, so every library they
 * rely on has to be on disk. React and ReactDOM ship UMD builds inside their
 * own packages, so those are a copy. Tailwind's Play CDN is a JIT compiler that
 * is only distributed over HTTP, so it is fetched once and cached here.
 *
 * Output lands in electron/appRuntime/vendor/, which electron-builder already
 * ships via its `electron/**` allowlist — no packaging change needed.
 *
 * Run: node scripts/build-app-vendor.mjs
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "electron", "appRuntime", "vendor");

fs.mkdirSync(outDir, { recursive: true });

/** Copy a file that lives inside an installed package. */
function copyFromPackage(pkg, relative, outName) {
  const entry = require.resolve(`${pkg}/package.json`);
  const src = path.join(path.dirname(entry), relative);
  if (!fs.existsSync(src)) throw new Error(`missing ${src} — run npm install first`);
  const dest = path.join(outDir, outName);
  fs.copyFileSync(src, dest);
  const kb = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`  copied  ${outName}  (${kb} KB)`);
}

/**
 * Fetch a library that is only published over HTTP. Kept non-fatal: a build
 * without network still produces a working runtime, it just falls back to the
 * CDN at run time for this one file.
 */
async function fetchInto(url, outName) {
  const dest = path.join(outDir, outName);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
    console.log(`  cached  ${outName}`);
    return true;
  }
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length < 1024) throw new Error("suspiciously small response");
    fs.writeFileSync(dest, body);
    console.log(`  fetched ${outName}  (${(body.length / 1024).toFixed(0)} KB)`);
    return true;
  } catch (err) {
    console.warn(`  SKIPPED ${outName} — ${err.message}`);
    console.warn(`          apps will fall back to the CDN for this file.`);
    return false;
  }
}

/**
 * Bundle a package that ships only ESM/CJS into a browser global.
 *
 * Installed apps get the same icon set and chart library the chat preview
 * has — otherwise the model's habitual `import { Check } from "lucide-react"`
 * would compile in preview and fail on install, which reads as the Install
 * button being broken.
 *
 * React is marked external: these bundles load after react.js and must share
 * its instance, not carry a second copy (two Reacts means hooks throw).
 */
/** Export names per vendored package, recorded for the compiler's shims. */
const exportNames = {};

/**
 * Resolves the externals inside a vendored bundle to the globals already on the
 * page, so these libraries share the one React instance rather than carrying
 * their own (two Reacts on a page makes every hook throw).
 *
 * `react/jsx-runtime` needs a real implementation, not just a lookup: these
 * packages are compiled with the automatic JSX transform, and React 18's UMD
 * build does not expose the runtime as a global. It is rebuilt here on top of
 * `createElement`, which is what the classic transform would have produced.
 */
const REQUIRE_SHIM = `
var __lyknJsxRuntime = (function () {
  function jsx(type, config, maybeKey) {
    var props = {};
    for (var k in config) {
      if (k !== "__self" && k !== "__source") props[k] = config[k];
    }
    if (maybeKey !== undefined) props.key = maybeKey;
    return window.React.createElement(type, props);
  }
  return { jsx: jsx, jsxs: jsx, jsxDEV: jsx, Fragment: window.React.Fragment };
})();
var require = function (m) {
  if (m === "react") return window.React;
  if (m === "react-dom" || m === "react-dom/client") return window.ReactDOM;
  if (m === "react/jsx-runtime" || m === "react/jsx-dev-runtime") return __lyknJsxRuntime;
  throw new Error("unexpected require in vendored bundle: " + m);
};
`.trim();

async function bundleGlobal(entry, globalName, outName) {
  const dest = path.join(outDir, outName);

  // The compiler has to emit a real named export for every import an app might
  // write (`import { Check } from "lucide-react"` needs a static binding). The
  // list is captured here, from the exact build being vendored, so it can never
  // drift from what the global actually has.
  const ns = await import(entry);
  exportNames[entry] = Object.keys(ns)
    .filter((k) => k !== "default" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k))
    .sort();

  await esbuild.build({
    stdin: {
      // Namespace re-export only: these packages do not all have a default
      // export, and the IIFE global ends up being the namespace object either
      // way — which is exactly what `LucideReact.Check` needs.
      contents: `export * from "${entry}";`,
      resolveDir: root,
      loader: "js",
    },
    bundle: true,
    format: "iife",
    globalName,
    outfile: dest,
    platform: "browser",
    target: ["chrome110"],
    minify: true,
    legalComments: "none",
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
    define: { "process.env.NODE_ENV": '"production"' },
    banner: { js: REQUIRE_SHIM },
  });
  const kb = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`  bundled ${outName}  (${kb} KB, ${exportNames[entry].length} exports)`);
}

console.log("Vendoring the installed-app runtime…");

copyFromPackage("react", "umd/react.production.min.js", "react.js");
copyFromPackage("react-dom", "umd/react-dom.production.min.js", "react-dom.js");

await bundleGlobal("lucide-react", "LucideReact", "lucide-react.js");
await bundleGlobal("recharts", "Recharts", "recharts.js");
await bundleGlobal("framer-motion", "FramerMotion", "framer-motion.js");

// Tailwind's browser JIT. Pinned so a rebuild cannot silently change how every
// installed app renders.
await fetchInto("https://cdn.tailwindcss.com/3.4.16", "tailwind.js");

const manifest = fs
  .readdirSync(outDir)
  .filter((f) => f.endsWith(".js"))
  .sort();
fs.writeFileSync(
  path.join(outDir, "manifest.json"),
  `${JSON.stringify({ files: manifest, exports: exportNames, builtAt: new Date().toISOString() }, null, 2)}\n`,
);

console.log(`Done — ${manifest.length} file(s) in electron/appRuntime/vendor/`);
