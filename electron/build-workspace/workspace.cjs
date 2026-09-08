/**
 * Build workspace — the agent's own project area on disk.
 *
 * Root: ~/LYKN/Builds (override with LYKN_BUILDS_DIR, used by tests).
 * Projects the Build agent creates live here as ordinary folders the user can
 * open, back up, and reuse across conversations.
 *
 * Paths inside the workspace are ALWAYS accessible to the local tools,
 * independent of the Vault sync allowlist: this is LYKN's directory, created
 * by LYKN, holding work the user commissioned. Everything outside it stays
 * governed by the existing Local Mode rules.
 *
 * This module must stay Electron-free (plain Node) so localSystem and tests
 * can load it anywhere.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const MAX_PROJECTS_LISTED = 200;

function workspaceRoot() {
  const override = String(process.env.LYKN_BUILDS_DIR || "").trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), "LYKN", "Builds");
}

/**
 * Canonical form of a path for containment checks. Follows symlinks via the
 * NEAREST EXISTING ancestor so a link inside the workspace cannot escape, and
 * so /var vs /private/var on macOS compare as the same folder — including for
 * nested paths that do not exist yet (a/b/deep.txt about to be written).
 */
function canonicalPath(absPath) {
  const abs = path.resolve(String(absPath || ""));
  if (!abs) return "";
  let existing = abs;
  const trailing = [];
  // Walk up until something exists, then canonicalize that and rejoin.
  while (true) {
    try {
      return path.join(fs.realpathSync(existing), ...trailing);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return abs; // hit the filesystem root
      trailing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** True when absPath is the workspace root or lives inside it. */
function isWorkspacePath(absPath) {
  const target = canonicalPath(absPath);
  if (!target) return false;
  const root = canonicalPath(workspaceRoot());
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Create the workspace root (and its logs dir) if missing. Returns the root. */
function ensureWorkspaceRoot() {
  const root = workspaceRoot();
  fs.mkdirSync(path.join(root, ".lykn", "logs"), { recursive: true });
  return root;
}

/** Directory for full command/process logs (output overflow recovery). */
function logsDir() {
  const dir = path.join(workspaceRoot(), ".lykn", "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * List project folders under the workspace root, newest first.
 * A "project" is any direct subdirectory (dotfiles and .lykn excluded).
 */
async function listProjects() {
  const root = workspaceRoot();
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".")) continue;
    const full = path.join(root, ent.name);
    let modifiedAt = 0;
    try {
      modifiedAt = (await fsp.stat(full)).mtimeMs;
    } catch {
      /* raced deletion — skip stat */
    }
    projects.push({ name: ent.name, path: full, modifiedAt });
    if (projects.length >= MAX_PROJECTS_LISTED) break;
  }
  projects.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return projects;
}

module.exports = {
  workspaceRoot,
  ensureWorkspaceRoot,
  isWorkspacePath,
  canonicalPath,
  logsDir,
  listProjects,
};
