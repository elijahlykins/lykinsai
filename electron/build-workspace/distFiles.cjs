"use strict";

/**
 * Collect a Build-workspace project's production bundle for installation as a
 * static app.
 *
 * The install target is the app host's file table (TEXT column), so every file
 * comes back as { path, content, encoding }: text formats verbatim, binary
 * assets base64-encoded. Plain Node — no Electron imports — so localSystem and
 * tests can load it anywhere.
 */

const fs = require("node:fs");
const path = require("node:path");

/** Build-output folders, in the order build tools actually use them. */
const DIST_DIRS = ["dist", "build", "out"];

/** Formats stored as text; everything else rides as base64. */
const TEXT_EXTS = new Set([
  "html", "htm", "js", "mjs", "cjs", "css", "json", "svg", "txt", "md",
  "map", "webmanifest", "xml",
]);

/** Never part of a runnable bundle, whatever directory we're walking. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

const MAX_FILES = 800;
const MAX_TOTAL_BYTES = 30_000_000;

/**
 * Where the servable build lives. A tool-built project has a dist/build/out
 * folder with an index.html; a plain hand-rolled site has index.html at the
 * project root. Null when neither exists — meaning nobody has run a build.
 */
function findDistDir(projectPath) {
  const root = String(projectPath || "");
  for (const dir of DIST_DIRS) {
    const candidate = path.join(root, dir);
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  if (fs.existsSync(path.join(root, "index.html"))) return root;
  return null;
}

function isTextFile(filePath) {
  const ext = String(filePath).split(".").pop()?.toLowerCase() || "";
  return TEXT_EXTS.has(ext);
}

/**
 * Read every file under the dist dir as install-ready entries.
 * @returns {{ok: true, files: {path: string, content: string, encoding: string|null}[]}
 *          |{ok: false, error: string, hint?: string}}
 */
function collectDistFiles(distDir) {
  const rootAbs = path.resolve(String(distDir || ""));
  const files = [];
  let totalBytes = 0;

  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;

      if (files.length >= MAX_FILES) {
        throw Object.assign(new Error("too_many_files"), {
          hint: `The build output has more than ${MAX_FILES} files — that is not a production bundle.`,
        });
      }
      const bytes = fs.readFileSync(abs);
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw Object.assign(new Error("too_large"), {
          hint: `The build output exceeds ${Math.round(MAX_TOTAL_BYTES / 1e6)} MB. Trim large assets and rebuild.`,
        });
      }

      const rel = path.relative(rootAbs, abs).split(path.sep).join("/");
      if (isTextFile(rel)) {
        files.push({ path: rel, content: bytes.toString("utf8"), encoding: null });
      } else {
        files.push({ path: rel, content: bytes.toString("base64"), encoding: "base64" });
      }
    }
  };

  try {
    walk(rootAbs);
  } catch (err) {
    return { ok: false, error: err?.message || "collect failed", hint: err?.hint };
  }

  if (!files.some((f) => f.path === "index.html")) {
    return {
      ok: false,
      error: "no_entry",
      hint: "No index.html at the root of the build output.",
    };
  }
  return { ok: true, files };
}

// ---------------------------------------------------------------------------
// Project ↔ installed-app identity
// ---------------------------------------------------------------------------

/**
 * The marker that ties a project folder to the app it installed as. The app
 * id is the app's origin, so reinstalling under the same id is what preserves
 * everything the user typed into the app.
 */
const APP_MARKER = ".lykn-app.json";

function readInstalledAppId(projectPath) {
  try {
    const raw = fs.readFileSync(path.join(String(projectPath), APP_MARKER), "utf8");
    const parsed = JSON.parse(raw);
    const id = String(parsed?.appId || "").trim();
    return id || null;
  } catch {
    return null;
  }
}

function writeInstalledAppId(projectPath, appId) {
  try {
    fs.writeFileSync(
      path.join(String(projectPath), APP_MARKER),
      JSON.stringify({ appId: String(appId), installedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DIST_DIRS,
  APP_MARKER,
  findDistDir,
  collectDistFiles,
  readInstalledAppId,
  writeInstalledAppId,
};
