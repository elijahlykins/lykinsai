/**
 * Compile an installed app's project into a single browser bundle.
 *
 * The chat preview transpiles JSX with Babel in the browser on every load,
 * which is fine for something you look at for a minute. An installed app is
 * opened daily, so it is compiled once at install time and the result is
 * cached in `app_files` under a reserved path.
 *
 * esbuild reads nothing from disk here: a virtual-filesystem plugin resolves
 * every import against the project's own files, and bare imports of the
 * vendored libraries resolve to shims that re-export the globals the runtime
 * HTML has already loaded. Nothing can reach the real filesystem, so a
 * generated `import fs from "fs"` fails at build time instead of at run time.
 */

/**
 * Loaded on first compile rather than at import.
 *
 * The protocol is registered before app-ready, so this module is reachable
 * during startup — and esbuild carries a native binary. Requiring it eagerly
 * would mean a missing or mismatched binary takes the whole app down at launch
 * instead of degrading to "apps cannot be built on this machine".
 */
let esbuild = null;
function loadEsbuild() {
  if (!esbuild) esbuild = require("esbuild");
  return esbuild;
}

/** Where the compiled output is cached inside the app's own file table. */
const BUNDLE_PATH = ".lykn/bundle.js";

/**
 * Bare specifiers that resolve to a vendored global rather than to app source.
 *
 * The named-export lists are explicit because ESM named imports are static:
 * `export const useState = R.useState` has to name every hook a generated app
 * might import, and a missing one is a build error the model can act on rather
 * than an undefined at run time.
 */
const REACT_EXPORTS = [
  "useState", "useEffect", "useMemo", "useCallback", "useRef", "useReducer",
  "useContext", "useLayoutEffect", "useId", "useTransition", "useDeferredValue",
  "useImperativeHandle", "useSyncExternalStore", "useDebugValue", "useInsertionEffect",
  "Fragment", "StrictMode", "Suspense", "Component", "PureComponent",
  "createContext", "createElement", "cloneElement", "isValidElement", "forwardRef",
  "memo", "lazy", "startTransition", "Children",
];

const REACT_DOM_EXPORTS = [
  "createPortal", "flushSync", "createRoot", "hydrateRoot", "findDOMNode", "render",
];

function shimModule(globalExpr, names, label) {
  return [
    `const __g = ${globalExpr};`,
    // A generated app importing a library the user never installed should say
    // so plainly, not fail later with "cannot read property of undefined".
    `if (!__g) throw new Error(${JSON.stringify(`${label} is not available in this app runtime`)});`,
    ...names.map((n) => `export const ${n} = __g.${n};`),
    `export default __g;`,
  ].join("\n");
}

/**
 * Export lists for the bundled libraries, recorded by the vendor script from
 * the exact builds on disk.
 *
 * Hardcoding these would mean listing ~1500 lucide icons and rewriting them on
 * every upgrade. Reading them keeps the shims and the globals in lockstep by
 * construction. A missing manifest simply means those libraries are not
 * offered — apps that avoid them still build.
 */
function loadVendorExports() {
  try {
    const manifest = require("./vendor/manifest.json");
    return manifest && typeof manifest.exports === "object" ? manifest.exports : {};
  } catch {
    return {};
  }
}

const VENDOR_EXPORTS = loadVendorExports();

/** Bundled library → the global its IIFE defines. */
const VENDOR_GLOBALS = {
  "lucide-react": "LucideReact",
  recharts: "Recharts",
  "framer-motion": "FramerMotion",
};

const VENDOR_SHIMS = {
  react: () => shimModule("globalThis.React", REACT_EXPORTS, "react"),
  "react-dom": () => shimModule("globalThis.ReactDOM", REACT_DOM_EXPORTS, "react-dom"),
  "react-dom/client": () => shimModule("globalThis.ReactDOM", ["createRoot", "hydrateRoot"], "react-dom/client"),
  // App source is compiled with the classic transform, so nothing here needs
  // the automatic runtime — but a generated file may import it explicitly, and
  // failing on that would be a confusing way to lose an otherwise fine app.
  "react/jsx-runtime": () =>
    [
      "const R = globalThis.React;",
      'if (!R) throw new Error("react is not available in this app runtime");',
      "function jsx(type, config, maybeKey) {",
      "  const props = {};",
      '  for (const k in config) { if (k !== "__self" && k !== "__source") props[k] = config[k]; }',
      "  if (maybeKey !== undefined) props.key = maybeKey;",
      "  return R.createElement(type, props);",
      "}",
      "export { jsx, jsx as jsxs, jsx as jsxDEV };",
      "export const Fragment = R.Fragment;",
      "export default { jsx, jsxs: jsx, Fragment: R.Fragment };",
    ].join("\n"),
};

for (const [pkg, globalName] of Object.entries(VENDOR_GLOBALS)) {
  const names = VENDOR_EXPORTS[pkg];
  if (!Array.isArray(names) || !names.length) continue;
  VENDOR_SHIMS[pkg] = () => shimModule(`globalThis.${globalName}`, names, pkg);
}

/** Extensions tried when an import omits one, in resolution order. */
const EXTENSIONS = ["", ".jsx", ".js", ".tsx", ".ts", ".json"];

function loaderFor(path) {
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  return "jsx";
}

/** Resolve `./util` against `lib/App.jsx` the way a bundler would. */
function resolveRelative(fromPath, spec, files) {
  const baseDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const segments = `${baseDir ? `${baseDir}/` : ""}${spec}`.split("/");
  const stack = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  const joined = stack.join("/");

  for (const ext of EXTENSIONS) {
    if (files.has(joined + ext)) return joined + ext;
  }
  for (const ext of EXTENSIONS.slice(1)) {
    if (files.has(`${joined}/index${ext}`)) return `${joined}/index${ext}`;
  }
  return null;
}

/**
 * Bundle a project.
 *
 * @param {{path: string, content: string}[]} fileList
 * @param {string} entry
 * @returns {Promise<{ok: true, code: string, bytes: number} | {ok: false, error: string, hint: string}>}
 */
async function compileApp(fileList = [], entry = "App.jsx") {
  const files = new Map(
    (Array.isArray(fileList) ? fileList : [])
      .filter((f) => f && typeof f.path === "string")
      .map((f) => [String(f.path), String(f.content ?? "")]),
  );

  if (!files.size) {
    return { ok: false, error: "empty_project", hint: "The app has no source files to compile." };
  }

  let entryPath = String(entry || "App.jsx");
  if (!files.has(entryPath)) {
    const fallback = ["App.jsx", "App.tsx", "index.jsx", "index.tsx", "main.jsx"].find((p) => files.has(p));
    if (!fallback) {
      return {
        ok: false,
        error: "entry_not_found",
        hint: `Entry ${entryPath} is not in the project. Files: ${[...files.keys()].join(", ")}`,
      };
    }
    entryPath = fallback;
  }

  const virtualFs = {
    name: "lykn-app-fs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;

        // The entry has no importer and is not written as a relative path, so
        // it would otherwise fall through to the bare-import rejection below.
        if (args.kind === "entry-point") {
          return { path: spec, namespace: "lykn-app" };
        }

        if (VENDOR_SHIMS[spec]) return { path: spec, namespace: "lykn-vendor" };

        if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
          const from = args.importer && args.namespace === "lykn-app" ? args.importer : "";
          const resolved = resolveRelative(from, spec.replace(/^\//, ""), files);
          if (!resolved) {
            return {
              errors: [{ text: `Cannot resolve "${spec}" from "${args.importer || entryPath}"` }],
            };
          }
          return { path: resolved, namespace: "lykn-app" };
        }

        // Any other bare import is a package we do not ship. Fail loudly at
        // build time so the model gets a fixable error instead of shipping an
        // app that white-screens on the user's machine.
        return {
          errors: [
            {
              text:
                `"${spec}" is not available to installed apps. ` +
                `Available: ${Object.keys(VENDOR_SHIMS).join(", ")}. ` +
                `Write the functionality directly or use lykn.db for storage.`,
            },
          ],
        };
      });

      build.onLoad({ filter: /.*/, namespace: "lykn-vendor" }, (args) => ({
        contents: VENDOR_SHIMS[args.path](),
        loader: "js",
      }));

      build.onLoad({ filter: /.*/, namespace: "lykn-app" }, (args) => ({
        contents: files.get(args.path) ?? "",
        loader: loaderFor(args.path),
      }));
    },
  };

  let build;
  try {
    build = loadEsbuild().build;
  } catch (err) {
    return {
      ok: false,
      error: "compiler_unavailable",
      hint: `The app compiler could not start on this machine: ${err?.message || err}`,
    };
  }

  try {
    const result = await build({
      entryPoints: [entryPath],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "__lyknApp",
      platform: "browser",
      target: ["chrome110"],
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
      minify: true,
      legalComments: "none",
      logLevel: "silent",
      plugins: [virtualFs],
      // The entry is itself virtual; without this esbuild tries the real cwd.
      absWorkingDir: "/",
      define: { "process.env.NODE_ENV": '"production"' },
    });

    const code = result.outputFiles?.[0]?.text || "";
    if (!code.trim()) {
      return { ok: false, error: "empty_output", hint: "The compiler produced no output." };
    }
    return { ok: true, code, bytes: Buffer.byteLength(code, "utf8") };
  } catch (err) {
    const messages = Array.isArray(err?.errors) && err.errors.length
      ? err.errors.map((e) => `${e.location?.file || ""}${e.location ? `:${e.location.line}` : ""} ${e.text}`).join("; ")
      : String(err?.message || err);
    return {
      ok: false,
      error: "compile_error",
      hint: `Compile failed: ${messages.slice(0, 900)}`,
    };
  }
}

module.exports = { compileApp, BUNDLE_PATH, VENDOR_SHIMS };
