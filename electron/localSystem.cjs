/**
 * Local Mode capability layer — file + terminal access for LYKN agents.
 *
 * Everything here runs in the Electron main process. Tools are only reachable
 * when the user flips the Local switch in the Vault (persisted per-device in
 * userData/local-mode.json). Access is confined to approved roots: either
 * folders the user picked, or (if they explicitly share the whole home folder)
 * the home directory. Enabling Local Mode does not grant whole-home access
 * unless that switch is on.
 *
 * Reads, writes, and ordinary commands inside an approved root auto-run.
 * Deletes and downloads require explicit approval (`approved: true` on re-invoke).
 * Shell commands are still zsh -lc; they are guarded by cwd + path-token
 * checks, not an OS sandbox.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const buildWorkspace = require("./build-workspace/workspace.cjs");
const processManager = require("./build-workspace/processManager.cjs");
const distFiles = require("./build-workspace/distFiles.cjs");

const COMMAND_TIMEOUT_MS = 60_000;
// Commands may raise their own timeout (installs, builds), but must stay
// under the server's 5-minute local-tool wait. Anything longer belongs in a
// managed process (local_start_process + local_process_status polling).
const MAX_COMMAND_TIMEOUT_MS = 240_000;
const OUTPUT_CAP_BYTES = 50 * 1024;
const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 2000;
const READ_WINDOW_CHARS = 24_000;
const MAX_SEARCH_RESULTS = 80;
const MAX_LIST_ENTRIES = 500;
const SEARCH_TIME_MS = 8_000;
const SEARCH_FILE_BYTES = 256 * 1024;
const SKIP_SEARCH_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".ico", ".bmp",
  ".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a", ".aac",
  ".zip", ".gz", ".bz2", ".dmg", ".iso",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".bin", ".exe", ".dll", ".so", ".dylib", ".wasm",
  ".lock", ".map",
]);

// ---------------------------------------------------------------------------
// Local-mode setting (device-level)
// ---------------------------------------------------------------------------

function settingPath(userDataPath) {
  return path.join(String(userDataPath || ""), "local-mode.json");
}

// Main sets this once at startup so tool runs can load the synced-folders
// allowlist without every call site having to thread userDataPath through.
let defaultUserDataPath = "";
function configure(userDataPath) {
  defaultUserDataPath = String(userDataPath || "");
}

// Optional server fallback for document extraction (documentReader tries
// local parsers and macOS textutil first). Set once by the agent runtime,
// which holds the api base and the auth token; reads work without it, they
// just lose the last-resort extractor.
let extractionOpts = null;
function configureExtraction(opts = {}) {
  const { apiBase, getAuthToken, fetchImpl } = opts || {};
  extractionOpts =
    apiBase && typeof getAuthToken === "function"
      ? { apiBase, getAuthToken, fetchImpl: typeof fetchImpl === "function" ? fetchImpl : undefined }
      : null;
}

/** Documents local_read_file extracts to text instead of refusing as binary. */
const RICH_DOC_RE = /\.(pdf|docx?|rtf|xlsx|pptx|odt)$/i;
const MEDIA_READ_CAP_BYTES = 80 * 1024 * 1024;

function normalizeSyncedFolders(folders) {
  const out = [];
  for (const f of Array.isArray(folders) ? folders : []) {
    const abs = resolveUserPath(f);
    if (!abs) continue;
    if (!out.includes(abs)) out.push(abs);
  }
  return out.slice(0, 100);
}

function inferSyncAll(data) {
  if (!data || typeof data !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(data, "syncAll")) return data.syncAll !== false;
  // Legacy files written before the allowlist existed implied whole-home
  // only while Local Mode was already on. A disabled legacy file must not
  // inherit whole-home when the user later enables it.
  return data.enabled === true;
}

function readLocalMode(userDataPath) {
  try {
    const data = JSON.parse(fs.readFileSync(settingPath(userDataPath), "utf8"));
    return {
      enabled: data?.enabled === true,
      updatedAt: Number(data?.updatedAt) || 0,
      syncAll: inferSyncAll(data),
      syncedFolders: normalizeSyncedFolders(data?.syncedFolders),
      excludedFolders: normalizeSyncedFolders(data?.excludedFolders),
    };
  } catch {
    return {
      enabled: false,
      updatedAt: 0,
      syncAll: false,
      syncedFolders: [],
      excludedFolders: [],
    };
  }
}

function persistLocalMode(userDataPath, config) {
  try {
    fs.writeFileSync(settingPath(userDataPath), JSON.stringify(config, null, 2), "utf8");
  } catch (e) {
    console.error("[LYKN] failed to write local-mode setting:", e?.message);
  }
  return config;
}

function writeLocalMode(userDataPath, enabled) {
  const prev = readLocalMode(userDataPath);
  return persistLocalMode(userDataPath, {
    ...prev,
    enabled: enabled === true,
    updatedAt: Date.now(),
  });
}

/** Update the synced-folders allowlist (and/or the sync-all switch). */
function writeMacSync(userDataPath, { syncAll, syncedFolders, excludedFolders } = {}) {
  const prev = readLocalMode(userDataPath);
  return persistLocalMode(userDataPath, {
    ...prev,
    syncAll: typeof syncAll === "boolean" ? syncAll : prev.syncAll,
    syncedFolders:
      syncedFolders !== undefined ? normalizeSyncedFolders(syncedFolders) : prev.syncedFolders,
    excludedFolders:
      excludedFolders !== undefined
        ? normalizeSyncedFolders(excludedFolders)
        : prev.excludedFolders,
    updatedAt: Date.now(),
  });
}

/**
 * Turn one folder's sync on or off — the per-folder switch on each Mac folder
 * page in the Vault.
 *
 * Off is recorded as an exclusion rather than by editing the allowlist, because
 * a folder can be readable for two different reasons (the whole home folder is
 * shared, or this folder was picked) and only an explicit "not this one"
 * survives both. Keeping the folder in syncedFolders while it's excluded is
 * what lets the switch go back on to exactly where it was.
 */
function writeFolderSync(userDataPath, { folder, synced } = {}) {
  const abs = resolveUserPath(folder);
  const prev = readLocalMode(userDataPath);
  if (!abs) return prev;

  const others = prev.excludedFolders.filter((f) => path.resolve(f) !== abs);
  if (synced !== true) {
    return writeMacSync(userDataPath, { excludedFolders: [...others, abs] });
  }

  // Dropping the exclusion is enough when the folder was readable before it
  // was switched off. It isn't when a parent is excluded, or when the user
  // shares a hand-picked list this folder was never on — then turning it on
  // has to add it.
  const next = { ...prev, excludedFolders: others };
  if (isAllowedPath(abs, next)) {
    return writeMacSync(userDataPath, { excludedFolders: others });
  }
  return writeMacSync(userDataPath, {
    excludedFolders: others,
    syncedFolders: [...prev.syncedFolders, abs],
  });
}

// ---------------------------------------------------------------------------
// Tool definitions (names + schemas shared with the chat loop via mcp-tools)
// ---------------------------------------------------------------------------

const LOCAL_TOOL_NAMES = [
  "local_list_dir",
  "local_read_file",
  "local_search_files",
  "local_pull_file",
  "local_write_file",
  "local_edit_file",
  "local_run_command",
  "local_build_workspace",
  "local_start_process",
  "local_process_status",
  "local_stop_process",
  "local_install_app",
  "local_synced_folders",
  "local_running_apps",
  "local_read_app",
  "local_open_app",
  "local_open_path",
  "local_organize_desktop",
  "local_desktop_look",
  "local_desktop_act",
];

// local_pull_file ships the raw bytes to the renderer for upload, so the cap
// is generous — most photos/PDFs fit comfortably.
const PULL_CAP_BYTES = 25 * 1024 * 1024;

const PULL_EXT_TO_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

function isLocalToolName(name) {
  return LOCAL_TOOL_NAMES.includes(String(name || ""));
}

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

/**
 * Approval is only for delete and download. These patterns are matched
 * against the WHOLE command string, so a routine command chained with a
 * delete or download (`npm test && rm -rf dist`) still asks.
 *
 * Reads, writes, installs, git, process control, and other ordinary work
 * run without a pause once Local Mode is on.
 */
const CONSEQUENTIAL_COMMAND_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bshred\b|\bsrm\b/i,
  /\bunlink\b/i,
  /\btrash\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\baria2c?\b/i,
  /\b(scp|sftp)\b/i,
  /\bgit\s+clone\b/i,
];

/**
 * True when a shell command is fully scoped to the Build workspace: its cwd
 * and every filesystem path it names live under the workspace root. Such
 * commands are normal development work — deletes, downloads, and clones run
 * without a human pause (the always-confirm list above still applies).
 */
function commandScopedToWorkspace(command, cwd) {
  const root = cwd ? resolveUserPath(cwd) : homeDir();
  if (!buildWorkspace.isWorkspacePath(root)) return false;
  for (const target of commandPathTargets(String(command || ""), root)) {
    if (!buildWorkspace.isWorkspacePath(target)) return false;
  }
  return true;
}

/**
 * Read-only command prefixes: what `local.shell.read` may run, and what a
 * task with no shell capability can never be tricked into exceeding.
 */
const SAFE_COMMAND_PREFIXES = [
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df",
  "which", "whoami", "date", "uname", "echo", "printenv", "env",
  "grep", "rg", "find", "tree", "diff",
  "git status", "git log", "git diff", "git branch", "git show", "git remote",
  "npm ls", "npm view", "node --version", "npm --version", "python3 --version",
];

/**
 * Classify one shell command by CONSEQUENCE, independent of capability.
 *
 * @returns {{ tier: "routine"|"consequential", readOnly: boolean, reason: string }}
 *   routine       - ordinary work: run without a human pause when the
 *                   task's capabilities license the command.
 *   consequential - delete or download: always requires live approval,
 *                   standing authorization or not.
 */
function classifyCommandConsequence(command, cwd) {
  const cmd = String(command || "").trim();
  const lower = cmd.toLowerCase();
  const readOnly = SAFE_COMMAND_PREFIXES.some((p) => lower === p || lower.startsWith(p + " "));
  const matched = CONSEQUENTIAL_COMMAND_PATTERNS.find((re) => re.test(cmd));
  if (matched) {
    // Deletes/downloads/clones fully inside the Build workspace are routine
    // development work, not consequential actions on the user's own files.
    if (commandScopedToWorkspace(cmd, cwd)) {
      return { tier: "routine", readOnly: false, reason: "" };
    }
    return { tier: "consequential", readOnly: false, reason: `matches ${matched}` };
  }
  return { tier: "routine", readOnly, reason: "" };
}

function homeDir() {
  return os.homedir();
}

function resolveUserPath(p) {
  let raw = String(p || "").trim();
  if (!raw) return "";
  if (raw === "~") raw = homeDir();
  else if (raw.startsWith("~/")) raw = path.join(homeDir(), raw.slice(2));
  if (!path.isAbsolute(raw)) raw = path.join(homeDir(), raw);
  return path.resolve(raw);
}

function isInsideHome(absPath) {
  const home = canonicalPath(homeDir());
  const target = canonicalPath(absPath);
  const rel = path.relative(home, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isInsideFolder(absPath, folder) {
  const rel = path.relative(path.resolve(folder), absPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Canonical form of a path for allowlist checks. Follows symlinks when the
 * target or its parent exists so a link inside an approved root cannot
 * escape, and so /var vs /private/var on macOS compare as the same folder.
 */
function canonicalPath(absPath) {
  const abs = path.resolve(String(absPath || ""));
  if (!abs) return "";
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

/**
 * How deeply a path is covered by a list of folders — the nesting depth of the
 * closest one that contains it, or -1 if none does. Depth is what lets two
 * lists disagree about the same path and still settle it.
 */
function coverDepth(absPath, folders) {
  const target = canonicalPath(absPath);
  let deepest = -1;
  for (const folder of Array.isArray(folders) ? folders : []) {
    const resolved = canonicalPath(folder);
    if (!resolved || !isInsideFolder(target, resolved)) continue;
    const depth = resolved.split(path.sep).length;
    if (depth > deepest) deepest = depth;
  }
  return deepest;
}

/**
 * Allowlist gate for approved local roots.
 *
 * - syncAll: the home directory is approved (not the rest of the disk).
 *   Extra syncedFolders still count, so a volume outside home can be added.
 * - otherwise: the path must live inside one of the user's synced folders.
 *
 * A folder whose sync the user switched off is excluded either way. The more
 * specific rule wins when the two lists overlap, so switching off Home and then
 * switching Desktop back on reads the way it looks: everything but Desktop.
 */
function isAllowedPath(absPath, config) {
  if (!absPath) return false;
  // The Build workspace (~/LYKN/Builds) is LYKN's own directory and is always
  // accessible, independent of the user's Vault sync allowlist.
  if (buildWorkspace.isWorkspacePath(absPath)) return true;
  if (!config) return true;
  const target = canonicalPath(absPath);
  const excluded = coverDepth(target, config.excludedFolders);
  if (excluded >= 0 && coverDepth(target, config.syncedFolders) <= excluded) return false;
  if (config.syncAll !== false) {
    if (isInsideHome(target)) return true;
    return coverDepth(target, config.syncedFolders) >= 0;
  }
  return coverDepth(target, config.syncedFolders) >= 0;
}

function isDevicePath(absPath) {
  const p = String(absPath || "");
  return (
    p === "/dev/null" ||
    p === "/dev/stdin" ||
    p === "/dev/stdout" ||
    p === "/dev/stderr" ||
    p === "/dev/tty" ||
    p.startsWith("/dev/fd/") ||
    // bash/zsh virtual TCP redirections (exec 3<>/dev/tcp/host/port) —
    // network sockets, not files.
    p.startsWith("/dev/tcp/") ||
    p.startsWith("/dev/udp/") ||
    p === "/dev/random" ||
    p === "/dev/urandom"
  );
}

function tokenizeShell(command) {
  const tokens = [];
  const re = /"([^"\\]|\\.)*"|'([^']*)'|[^\s]+/g;
  const text = String(command || "");
  let m;
  while ((m = re.exec(text))) {
    let t = m[0];
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
      t = t.slice(1, -1).replace(/\\"/g, '"');
    } else if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
      t = t.slice(1, -1);
    }
    if (t) tokens.push(t);
  }
  return tokens;
}

function stripPathPunct(raw) {
  return String(raw || "").replace(/[),.;]+$/g, "");
}

function looksLikeUserPath(tok) {
  const s = stripPathPunct(tok);
  if (!s || s === "-" || s.startsWith("-")) return false;
  if (/^(https?:|git@|ssh:|file:)/i.test(s)) return false;
  if (s === "~" || s.startsWith("~/") || s.startsWith("/") || s === ".." || s.startsWith("../") || s.startsWith("./")) {
    return true;
  }
  return s.includes("/");
}

function resolveCommandPath(raw, cwd) {
  const s = stripPathPunct(raw);
  if (!s) return "";
  if (/^(https?:|git@|ssh:|file:)/i.test(s)) return "";
  if (s === "~" || s.startsWith("~/")) return resolveUserPath(s);
  if (s.startsWith("/")) return path.resolve(s);
  return path.resolve(String(cwd || homeDir()), s);
}

/**
 * Filesystem targets a shell command string is trying to name.
 * This is a guardrail, not an OS sandbox: constructed paths inside
 * interpreters can still bypass it.
 */
function commandPathTargets(command, cwd) {
  const root = path.resolve(String(cwd || homeDir()));
  const out = [];
  const seen = new Set();
  const add = (abs) => {
    if (!abs || isDevicePath(abs) || seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };
  for (const tok of tokenizeShell(command)) {
    if (looksLikeUserPath(tok)) add(resolveCommandPath(tok, root));
    // URLs are network targets, not filesystem paths — their path portion
    // (http://localhost:8000/index.html → /index.html) must never be treated
    // as a local absolute path. Strip them before extracting inner pieces.
    const cleaned = String(tok).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`;|&<>)]+/gi, " ");
    const inner = cleaned.match(/(?:~|\/|\.\.\/|\.\/)[^\s"'`;|&<>)]+/g) || [];
    for (const piece of inner) {
      if (/^(https?:|git@|ssh:|file:)/i.test(piece)) continue;
      add(resolveCommandPath(piece, root));
    }
    if (!looksLikeUserPath(tok) && tok !== "." && !tok.startsWith("-")) {
      const candidate = path.resolve(root, tok);
      try {
        if (fs.lstatSync(candidate).isSymbolicLink()) add(canonicalPath(candidate));
      } catch {
        /* not on disk */
      }
    }
  }
  return out;
}

/**
 * Which of a tool call's args are filesystem paths that the allowlist must
 * cover. Returns { allowed: boolean, blockedPath?: string }.
 */
function checkToolAccess(name, args = {}, config) {
  if (!config) return { allowed: true };
  const paths = [];
  switch (name) {
    case "local_list_dir":
    case "local_search_files":
      paths.push(resolveUserPath(args.path || "~"));
      break;
    case "local_read_file":
    case "local_pull_file":
    case "local_write_file":
    case "local_edit_file":
    case "local_open_path":
    case "local_install_app":
      paths.push(resolveUserPath(args.path));
      break;
    case "local_run_command":
    case "local_start_process": {
      const cwd = args.cwd ? resolveUserPath(args.cwd) : homeDir();
      paths.push(cwd);
      for (const p of commandPathTargets(String(args.command || ""), cwd)) {
        paths.push(p);
      }
      break;
    }
    default:
      return { allowed: true };
  }
  for (const p of paths) {
    if (!p) return { allowed: false, blockedPath: p };
    if (!isAllowedPath(p, config)) return { allowed: false, blockedPath: p };
  }
  return { allowed: true };
}

/**
 * Classify a tool invocation. Returns { risky: boolean, summary: string }.
 * Risky invocations require `approved: true` to execute.
 */
function classifyRisk(name, args = {}) {
  switch (name) {
    case "local_list_dir":
    case "local_read_file":
    case "local_search_files":
    case "local_write_file":
    case "local_edit_file":
    case "local_synced_folders":
    case "local_running_apps":
    case "local_read_app":
    // Opening an app is what a dock click does - visible, non-destructive.
    case "local_open_app":
    // Opening a path mirrors a direct Files-window click.
    case "local_open_path":
    // Only moves icons around on LYKN's own desktop. Nothing on disk changes,
    // and the user can drag them back.
    case "local_organize_desktop":
    // Workspace info + process status/stop are reads and cleanup of the
    // agent's OWN managed processes — never a pause.
    case "local_build_workspace":
    case "local_process_status":
    case "local_stop_process":
    // Installing a workspace build into LYKN's own app store — the whole
    // point is one-click delivery, and the user can uninstall from Settings.
    case "local_install_app":
    // A screenshot observes; it changes nothing.
    case "local_desktop_look":
      return { risky: false, summary: "" };
    // Physical mouse/keyboard control: ONE approval arms the whole session —
    // a 30-click task cannot ask 30 times, and per-click consent teaches the
    // user to click "allow" without reading. The user can still watch every
    // action happen on screen.
    case "local_desktop_act": {
      const control = require("./desktop-agent/desktopControl.cjs");
      if (control.sessionArmed()) return { risky: false, summary: "" };
      return {
        risky: true,
        summary: "Let LYKN control this Mac's mouse and keyboard for this session",
      };
    }
    case "local_pull_file": {
      const target = resolveUserPath(args.path);
      return {
        risky: true,
        summary: `Download ${target || "(unknown path)"} into this chat`,
      };
    }
    case "local_run_command":
    case "local_start_process": {
      const cmd = String(args.command || "").trim();
      const consequence = classifyCommandConsequence(cmd, args.cwd);
      const risky = consequence.tier === "consequential";
      return {
        risky,
        readOnly: consequence.readOnly,
        tier: consequence.tier,
        summary: risky ? `Run command: ${cmd.slice(0, 300)}` : "",
      };
    }
    default:
      return { risky: true, summary: `Unknown local tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function capText(text, cap = OUTPUT_CAP_BYTES) {
  const s = String(text || "");
  if (Buffer.byteLength(s, "utf8") <= cap) return { text: s, truncated: false };
  const buf = Buffer.from(s, "utf8").subarray(0, cap);
  return { text: buf.toString("utf8") + "\n…[output truncated]", truncated: true };
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

/**
 * Page a text file the way a coding agent does: a line window plus a
 * nextOffset so the caller can keep reading instead of guessing from a stub.
 */
function sliceTextWindow(text, args = {}) {
  const raw = String(text ?? "");
  const lines = raw.split("\n");
  const totalLines = lines.length;
  if (totalLines === 0) {
    return { content: "", startLine: 1, endLine: 0, totalLines: 0, truncated: false };
  }
  const startLine = Math.min(parsePositiveInt(args.offset) || 1, totalLines);
  const lineLimit = Math.min(parsePositiveInt(args.limit) || DEFAULT_READ_LINES, MAX_READ_LINES);
  const slice = [];
  let chars = 0;
  let endLine = startLine - 1;
  for (let i = startLine - 1; i < totalLines && slice.length < lineLimit; i++) {
    const line = lines[i];
    const add = (slice.length ? 1 : 0) + line.length;
    if (slice.length > 0 && chars + add > READ_WINDOW_CHARS) break;
    if (slice.length === 0 && line.length > READ_WINDOW_CHARS) {
      return {
        content: line.slice(0, READ_WINDOW_CHARS),
        startLine,
        endLine: startLine,
        totalLines,
        truncated: true,
        nextOffset: startLine + 1,
      };
    }
    slice.push(line);
    chars += add;
    endLine = i + 1;
  }
  const truncated = endLine < totalLines;
  return {
    content: slice.join("\n"),
    startLine,
    endLine,
    totalLines,
    truncated,
    ...(truncated ? { nextOffset: endLine + 1 } : {}),
  };
}

function withReadWindow(base, args) {
  const window = sliceTextWindow(base.content, args);
  const hint = window.truncated
    ? `Read lines ${window.startLine}-${window.endLine} of ${window.totalLines}. Call again with offset: ${window.nextOffset} to continue.`
    : undefined;
  return {
    ...base,
    ...window,
    ...(hint ? { hint } : {}),
  };
}

async function listDir(args = {}) {
  const dir = resolveUserPath(args.path || "~");
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const ent of entries.slice(0, MAX_LIST_ENTRIES)) {
    let size = null;
    let mtime = null;
    try {
      const st = await fsp.stat(path.join(dir, ent.name));
      size = st.isFile() ? st.size : null;
      mtime = st.mtimeMs;
    } catch {
      /* permission or broken symlink — still list the name */
    }
    items.push({
      name: ent.name,
      type: ent.isDirectory() ? "dir" : ent.isSymbolicLink() ? "symlink" : "file",
      size,
      modifiedAt: mtime,
    });
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return {
    ok: true,
    path: dir,
    entries: items,
    truncated: entries.length > MAX_LIST_ENTRIES,
  };
}

async function readFileTool(args = {}) {
  const file = resolveUserPath(args.path);
  if (!file) return { ok: false, error: "path is required" };
  const st = await fsp.stat(file);
  if (st.isDirectory()) return { ok: false, error: `${file} is a directory — use local_list_dir` };
  const mediaReader = require("./mediaReader.cjs");
  const isMedia = mediaReader.isReadableMediaPath(file);
  let engineering = null;
  try {
    engineering = await import("../lib/engineering/readEngineeringFile.js");
  } catch {
    engineering = null;
  }
  const isEngineering = !!engineering?.isEngineeringPath?.(file);
  const sizeCap = isMedia ? MEDIA_READ_CAP_BYTES : isEngineering ? 32 * 1024 * 1024 : 10 * 1024 * 1024;
  if (st.size > sizeCap) {
    return { ok: false, error: `File too large to read (${Math.round(st.size / 1024 / 1024)} MB)` };
  }
  // Rich documents (PDF, Word, Excel, PowerPoint, ODT) extract to text — the
  // same reader the overlay uses for the frontmost document. Before this they
  // hit the binary sniff below and the agent was told to give up.
  if (RICH_DOC_RE.test(file)) {
    const out = await readDocumentFile(file, st);
    if (!out.ok) return out;
    return withReadWindow(out, args);
  }
  // Images and recordings go through vision the same way documents go through
  // text extraction. Refusing them as binary left every agent blind.
  if (isMedia) {
    return readMediaFile(file, st, mediaReader);
  }
  const buf = await fsp.readFile(file);
  if (isEngineering && engineering?.summarizeEngineeringBuffer) {
    const slice = buf.byteLength > 8 * 1024 * 1024 ? buf.subarray(0, 8 * 1024 * 1024) : buf;
    const content = engineering.summarizeEngineeringBuffer(slice, file);
    return withReadWindow({ ok: true, path: file, size: st.size, content }, args);
  }
  // Cheap binary sniff: NUL byte in the first 8KB.
  if (buf.subarray(0, 8192).includes(0)) {
    return { ok: false, error: `${file} looks like a binary file (${st.size} bytes)` };
  }
  const text = buf.toString("utf8");
  return withReadWindow({ ok: true, path: file, size: st.size, content: text }, args);
}

async function readDocumentFile(file, st) {
  const documentReader = require("./documentReader.cjs");
  let opts = {};
  if (extractionOpts) {
    const token = await extractionOpts.getAuthToken().catch(() => null);
    if (token) opts = { apiBase: extractionOpts.apiBase, token };
  }
  const out = await documentReader.extractDocumentFile(file, opts);
  if (!out.ok) {
    const why =
      out.error === "file_too_large"
        ? `Document too large to extract (${Math.round(st.size / 1024 / 1024)} MB)`
        : `Could not extract text from this ${path.extname(file).slice(1) || "document"} file`;
    return {
      ok: false,
      error: `${why}. Use local_pull_file to hand the file itself to the user's chat instead.`,
    };
  }
  return {
    ok: true,
    path: file,
    size: st.size,
    format: out.format || path.extname(file).slice(1).toLowerCase(),
    pageCount: out.pageCount ?? undefined,
    content: out.text,
    truncated: out.truncated === true,
  };
}

async function readMediaFile(file, st, mediaReader) {
  let opts = {};
  if (extractionOpts) {
    const token = await extractionOpts.getAuthToken().catch(() => null);
    if (token) {
      opts = {
        apiBase: extractionOpts.apiBase,
        token,
        fetchImpl: extractionOpts.fetchImpl,
      };
    }
  }
  const out = await mediaReader.describeMediaFile(file, opts);
  if (!out.ok) {
    const why =
      out.error === "file_too_large"
        ? out.detail || `File too large to look at (${Math.round(st.size / 1024 / 1024)} MB)`
        : `Could not look at this ${path.extname(file).slice(1) || "media"} file`;
    return {
      ok: false,
      error: `${why}. Use local_pull_file to hand the file itself to the user's chat instead.`,
    };
  }
  return {
    ok: true,
    path: file,
    size: st.size,
    kind: out.kind,
    mime: out.mime,
    format: out.format || path.extname(file).slice(1).toLowerCase(),
    content: out.content,
    imageDataUrl: out.imageDataUrl,
    vision: out.vision === true,
  };
}

const SEARCH_SKIP_DIRS = new Set([
  "node_modules", ".git", "Library", ".Trash", ".cache", ".npm",
  "dist", "build", ".next", "venv", ".venv", "__pycache__",
  "Applications", "Movies", "Pictures", "Music",
]);

function globToNameRe(namePattern) {
  if (!namePattern) return null;
  return new RegExp(
    "^" +
      namePattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
    "i",
  );
}

function searchEnv() {
  const extra = "/opt/homebrew/bin:/usr/local/bin";
  return { ...process.env, PATH: `${process.env.PATH || ""}:${extra}` };
}

function parseRgJsonLine(line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return null;
  }
  if (evt?.type !== "match" || !evt.data) return null;
  const filePath = evt.data.path?.text;
  const lineNo = evt.data.line_number;
  const match = String(evt.data.lines?.text || "").replace(/\n$/, "").slice(0, 300);
  if (!filePath || !lineNo) return null;
  return { path: filePath, line: lineNo, match };
}

function searchContentWithRg(root, namePattern, query, deadline) {
  return new Promise((resolve) => {
    const args = [
      "--json",
      "--max-count", "8",
      "--max-filesize", "512K",
      "-g", "!node_modules",
      "-g", "!.git",
      "-g", "!Library",
      "-g", "!dist",
      "-g", "!build",
      "-g", "!.next",
      "-g", "!venv",
      "-g", "!.venv",
    ];
    if (namePattern) args.push("-g", namePattern);
    args.push("--", query, root);
    let child;
    try {
      child = spawn("rg", args, { env: searchEnv() });
    } catch {
      resolve(null);
      return;
    }
    let buf = "";
    let settled = false;
    let timer = null;
    const results = [];
    const finish = (out) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve(out);
    };
    timer = setTimeout(
      () => finish({ results, truncated: true, engine: "rg" }),
      Math.max(50, deadline - Date.now()),
    );
    child.on("error", () => finish(null));
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const hit = parseRgJsonLine(line);
        if (!hit) continue;
        results.push(hit);
        if (results.length >= MAX_SEARCH_RESULTS) {
          finish({ results, truncated: true, engine: "rg" });
          return;
        }
      }
    });
    child.on("close", () => {
      if (settled) return;
      const hit = parseRgJsonLine(buf);
      if (hit && results.length < MAX_SEARCH_RESULTS) results.push(hit);
      finish({ results, truncated: results.length >= MAX_SEARCH_RESULTS, engine: "rg" });
    });
  });
}

async function searchFiles(args = {}) {
  const root = resolveUserPath(args.path || "~");
  const namePattern = String(args.namePattern || "").trim();
  const query = String(args.query || "").trim();
  if (!namePattern && !query) {
    return { ok: false, error: "Provide namePattern (glob-ish) and/or query (text to find)" };
  }
  const deadline = Date.now() + SEARCH_TIME_MS;
  if (query) {
    const rg = await searchContentWithRg(root, namePattern, query, deadline);
    if (rg) {
      return {
        ok: true,
        root,
        results: rg.results,
        truncated: rg.truncated === true,
      };
    }
  }
  const nameRe = globToNameRe(namePattern);
  const queryLower = query.toLowerCase();
  const results = [];
  const stack = [{ dir: root, depth: 0 }];
  let scanned = 0;
  while (stack.length && results.length < MAX_SEARCH_RESULTS && scanned < 8_000) {
    if (Date.now() > deadline) break;
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      scanned += 1;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (nameRe && !query && nameRe.test(ent.name)) {
          results.push({ path: full, type: "dir" });
          if (results.length >= MAX_SEARCH_RESULTS) break;
        }
        if (depth < 8 && !SEARCH_SKIP_DIRS.has(ent.name) && !ent.name.startsWith(".")) {
          stack.push({ dir: full, depth: depth + 1 });
        }
        continue;
      }
      if (!ent.isFile()) continue;
      if (nameRe && !nameRe.test(ent.name)) continue;
      if (!query) {
        results.push({ path: full, type: "file" });
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      if (SKIP_SEARCH_EXT.has(ext)) continue;
      try {
        const st = await fsp.stat(full);
        if (st.size > SEARCH_FILE_BYTES) continue;
        const buf = await fsp.readFile(full);
        if (buf.subarray(0, 8192).includes(0)) continue;
        const text = buf.toString("utf8");
        const idx = text.toLowerCase().indexOf(queryLower);
        if (idx === -1) continue;
        const lineStart = text.lastIndexOf("\n", idx) + 1;
        const lineEnd = text.indexOf("\n", idx);
        const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).slice(0, 300);
        const lineNo = text.slice(0, idx).split("\n").length;
        results.push({ path: full, line: lineNo, match: line });
      } catch {
        /* unreadable file — skip */
      }
    }
  }
  return {
    ok: true,
    root,
    results,
    truncated: results.length >= MAX_SEARCH_RESULTS || Date.now() > deadline,
  };
}

/**
 * Read any file (binary included) and return its bytes as base64 so the
 * renderer can upload it into the chat's file storage. Read-only — the file
 * itself is never modified.
 */
async function pullFile(args = {}) {
  const file = resolveUserPath(args.path);
  if (!file) return { ok: false, error: "path is required" };
  const st = await fsp.stat(file);
  if (st.isDirectory()) return { ok: false, error: `${file} is a directory — use local_list_dir` };
  if (st.size > PULL_CAP_BYTES) {
    return {
      ok: false,
      error: `File too large to pull into the chat (${Math.round(st.size / 1024 / 1024)} MB, cap ${PULL_CAP_BYTES / 1024 / 1024} MB)`,
    };
  }
  const buf = await fsp.readFile(file);
  const name = path.basename(file);
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const mime = PULL_EXT_TO_MIME[ext] || "application/octet-stream";
  const kind = mime.startsWith("image/")
    ? "image"
    : mime.startsWith("video/")
      ? "video"
      : mime.startsWith("audio/")
        ? "audio"
        : "file";
  return { ok: true, path: file, name, mime, kind, size: st.size, dataBase64: buf.toString("base64") };
}

async function writeFileTool(args = {}) {
  const file = resolveUserPath(args.path);
  if (!file) return { ok: false, error: "path is required" };
  const content = String(args.content ?? "");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, "utf8");
  return { ok: true, path: file, bytes: Buffer.byteLength(content, "utf8") };
}

/**
 * local_edit_file — replace an exact snippet inside an existing text file.
 * Surgical alternative to local_write_file: the rest of the file survives
 * even when the model never read (or has a stale copy of) the whole thing.
 */
async function editFileTool(args = {}) {
  const file = resolveUserPath(args.path);
  if (!file) return { ok: false, error: "path is required" };
  const oldText = String(args.oldText ?? "");
  const newText = String(args.newText ?? "");
  if (!oldText) {
    return { ok: false, error: "oldText is required — to create a new file, use local_write_file" };
  }
  if (oldText === newText) {
    return { ok: false, error: "oldText and newText are identical — nothing to change" };
  }
  // Rich documents route to the document editor: xlsx cells edit in place,
  // PDF/Word/RTF/ODT regenerate through extracted text. Defaults to a sibling
  // "(edited)" file so a lossy regeneration can never destroy the original.
  const documentEditor = require("./documentEditor.cjs");
  if (documentEditor.isEditableDocumentPath(file)) {
    return documentEditor.editDocumentFile(file, {
      oldText,
      newText,
      replaceAll: args.replaceAll === true,
      overwrite: args.overwrite === true,
    });
  }
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return { ok: false, error: `${file} does not exist — use local_write_file to create a new file` };
  }
  if (st.isDirectory()) return { ok: false, error: `${file} is a directory` };
  if (st.size > 10 * 1024 * 1024) {
    return { ok: false, error: `File too large to edit (${Math.round(st.size / 1024 / 1024)} MB)` };
  }
  const buf = await fsp.readFile(file);
  if (buf.subarray(0, 8192).includes(0)) {
    return { ok: false, error: `${file} looks like a binary file — only text files can be edited` };
  }
  const text = buf.toString("utf8");
  const occurrences = text.split(oldText).length - 1;
  if (occurrences === 0) {
    return {
      ok: false,
      error:
        `oldText was not found in ${file}. It must match the file EXACTLY, including whitespace ` +
        "and indentation — read the file with local_read_file and copy the snippet verbatim.",
    };
  }
  if (occurrences > 1 && args.replaceAll !== true) {
    return {
      ok: false,
      error:
        `oldText appears ${occurrences} times in ${file}. Include more surrounding lines so it ` +
        "matches exactly once, or pass replaceAll: true to change every occurrence.",
    };
  }
  const next =
    args.replaceAll === true ? text.split(oldText).join(newText) : text.replace(oldText, newText);
  await fsp.writeFile(file, next, "utf8");
  return {
    ok: true,
    path: file,
    replacements: args.replaceAll === true ? occurrences : 1,
    bytes: Buffer.byteLength(next, "utf8"),
  };
}

/**
 * When command output overflows the in-context cap, persist the FULL output
 * to a log file under the workspace so the agent can grep/tail the rest
 * instead of losing it. Best-effort — failures just skip the file.
 */
function writeOverflowLog(command, fullOutput) {
  try {
    const dir = buildWorkspace.logsDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `cmd-${stamp}.log`);
    fs.writeFileSync(file, `# ${command}\n${fullOutput}`);
    return file;
  } catch {
    return null;
  }
}

function commandTimeoutMs(args) {
  const sec = Number(args?.timeoutSec);
  if (!Number.isFinite(sec) || sec <= 0) return COMMAND_TIMEOUT_MS;
  return Math.min(Math.floor(sec) * 1000, MAX_COMMAND_TIMEOUT_MS);
}

function runCommand(args = {}, { signal } = {}) {
  const command = String(args.command || "").trim();
  if (!command) return Promise.resolve({ ok: false, error: "command is required" });
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, command, error: "aborted", aborted: true });
  }
  const cwd = args.cwd ? resolveUserPath(args.cwd) : homeDir();
  const timeoutMs = commandTimeoutMs(args);
  return new Promise((resolve) => {
    let out = "";
    let fullOut = "";
    let fullBytes = 0;
    let outBytes = 0;
    let settled = false;
    const child = spawn("/bin/zsh", ["-lc", command], {
      cwd,
      env: {
        ...process.env,
        LYKN_LOCAL_MODE: "1",
        // Dev tools commonly live in Homebrew paths that a non-login shell
        // misses; zsh -lc usually fixes this, but be deterministic.
        PATH: `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin`,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const killTree = () => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          /* fall through to the zsh handle */
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    };
    // Keep the full output (capped at 4 MB) alongside the in-context window
    // so a truncated result can still be recovered from a log file.
    const FULL_OUT_CAP = 4 * 1024 * 1024;
    const append = (chunk) => {
      const s = chunk.toString("utf8");
      if (fullBytes < FULL_OUT_CAP) {
        fullBytes += Buffer.byteLength(s, "utf8");
        fullOut += s;
      }
      if (outBytes >= OUTPUT_CAP_BYTES) return;
      outBytes += Buffer.byteLength(s, "utf8");
      out += s;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        signal?.removeEventListener?.("abort", onAbort);
      } catch {
        /* ignore */
      }
      resolve(payload);
    };
    const onAbort = () => {
      killTree();
      finish({
        ok: false,
        command,
        cwd,
        error: "aborted",
        aborted: true,
        output: capText(out).text,
      });
    };
    const timer = setTimeout(() => {
      killTree();
      finish({
        ok: false,
        command,
        cwd,
        error:
          `Command timed out after ${timeoutMs / 1000}s. For servers/watchers use ` +
          "local_start_process; for slow one-shot commands pass a larger timeoutSec (max 240).",
        output: capText(out).text,
      });
    }, timeoutMs);
    try {
      signal?.addEventListener?.("abort", onAbort, { once: true });
    } catch {
      /* no signal */
    }
    child.on("error", (err) => {
      finish({ ok: false, command, cwd, error: err?.message || "spawn failed" });
    });
    child.on("close", (code) => {
      if (signal?.aborted) {
        finish({
          ok: false,
          command,
          cwd,
          error: "aborted",
          aborted: true,
          output: capText(out).text,
        });
        return;
      }
      const { text, truncated } = capText(out);
      const result = { ok: code === 0, command, cwd, exitCode: code, output: text, truncated };
      if (truncated) {
        const logFile = writeOverflowLog(command, fullOut);
        if (logFile) {
          result.fullOutputPath = logFile;
          result.hint =
            `Output was truncated. The complete output is in ${logFile} — ` +
            "grep or tail it with local_run_command if you need the rest.";
        }
      }
      finish(result);
    });
  });
}

/**
 * local_build_workspace — anchor the Build agent: where its workspace lives
 * and which projects already exist there. Creates the root on first use.
 */
async function buildWorkspaceTool() {
  const root = buildWorkspace.ensureWorkspaceRoot();
  const projects = await buildWorkspace.listProjects();
  return {
    ok: true,
    root,
    projects: projects.map((p) => ({ name: p.name, path: p.path })),
    note:
      `Your build workspace is ${root}. Create each project in its own subfolder ` +
      `(e.g. ${path.join(root, "my-project")}). Everything inside the workspace is fully ` +
      "accessible: reads, writes, deletes, git clone, curl, and package installs run " +
      "without approval prompts. Existing projects above can be reopened and continued.",
  };
}

/**
 * local_start_process — spawn a managed background process (dev server,
 * watcher, long install) inside the workspace/allowed roots.
 */
async function startProcessTool(args = {}) {
  const cwd = args.cwd ? resolveUserPath(args.cwd) : buildWorkspace.ensureWorkspaceRoot();
  let logFile = null;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    logFile = path.join(buildWorkspace.logsDir(), `proc-${stamp}.log`);
  } catch {
    /* log file is best-effort */
  }
  return processManager.startProcess({
    command: args.command,
    cwd,
    name: args.name,
    waitMs: args.waitMs,
    logFile,
  });
}

/**
 * local_install_app — put a finished Build-workspace project in the user's
 * dock as a real installed app.
 *
 * Takes the project's production build output (dist/build/out, or a root
 * index.html for plain sites) and installs it into the app host as a static
 * app: its own lykn-app:// origin, an icon in the dock, opens in its own
 * window with no dev server. `.lykn-app.json` in the project ties the folder
 * to the installed app id, so rebuilding and reinstalling updates in place
 * and keeps everything the user saved inside the app.
 */
async function installAppTool(args = {}) {
  const projectPath = buildWorkspace.canonicalPath(resolveUserPath(String(args.path || "")));
  if (!projectPath || !buildWorkspace.isWorkspacePath(projectPath)) {
    return {
      ok: false,
      error:
        "path must be a project folder inside the Build workspace (~/LYKN/Builds). " +
        "Only workspace projects can be installed as apps.",
    };
  }

  const distDir = distFiles.findDistDir(projectPath);
  if (!distDir) {
    return {
      ok: false,
      error: "no_build_output",
      hint:
        "No index.html found in dist/, build/, out/, or the project root. Run the " +
        "project's production build first (e.g. `npm run build`), then install again.",
    };
  }

  const collected = distFiles.collectDistFiles(distDir);
  if (!collected.ok) return collected;

  // The app host needs the Electron runtime and its open local store. The
  // check is on the runtime, not the require: the `electron` npm package
  // resolves in plain Node too, it just exports nothing usable.
  if (!process.versions.electron) {
    return { ok: false, error: "App install is only available in the desktop app." };
  }
  const appHost = require("./appHost.cjs");

  const fallbackName = path
    .basename(projectPath)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const name = String(args.name || "").trim() || fallbackName;

  const existingId = distFiles.readInstalledAppId(projectPath);
  const res = appHost.installStaticApp({
    id: existingId,
    title: name,
    files: collected.files,
    icon: args.icon || null,
    description: args.description || null,
  });
  if (!res.ok) return res;

  distFiles.writeInstalledAppId(projectPath, res.app.id);
  const updated = Boolean(existingId && existingId === res.app.id);
  return {
    ok: true,
    appId: res.app.id,
    name: res.app.name,
    files: collected.files.length,
    updated,
    note: updated
      ? `Updated "${res.app.name}" in the user's LYKN dock. Everything they saved in the app is preserved.`
      : `Installed "${res.app.name}" to the user's LYKN dock. It now opens from the dock ` +
        "like any app — no dev server or terminal needed. Tell the user to look for it in their dock.",
  };
}

function syncedFoldersTool(config) {
  const excluded = config.excludedFolders || [];
  return {
    ok: true,
    syncAll: config.syncAll !== false,
    folders:
      config.syncAll !== false
        ? [homeDir()]
        : (config.syncedFolders || []),
    excludedFolders: excluded,
    note:
      (config.syncAll !== false
        ? "The home folder is synced. Paths outside it are blocked unless also on the folder list."
        : "Only these folders are synced — reads and writes outside them are blocked.") +
      (excluded.length
        ? ` The user switched sync off for these, so they are blocked too: ${excluded.join(", ")}.`
        : ""),
  };
}

async function runningAppsTool() {
  // App/process awareness lives in appDock.cjs; required lazily so this
  // module stays loadable in contexts without Electron.
  const appDock = require("./appDock.cjs");
  return appDock.getRunningAppsResult();
}

/** Raw { ok, frontmost, running } reader for the desktop-control frame guard. */
async function desktopRunningApps() {
  const appDock = require("./appDock.cjs");
  return appDock.getRunningApps();
}

// ---------------------------------------------------------------------------
// local_open_app — launch a Mac app as a normal window
// ---------------------------------------------------------------------------

async function openAppTool(args = {}) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "local_open_app is only available on macOS." };
  }
  const query = String(args.app || "").trim().replace(/\.app$/i, "");
  if (!query) {
    return { ok: false, error: 'app is required, e.g. { app: "Spotify" }' };
  }
  const appDock = require("./appDock.cjs");
  const apps = await appDock.listInstalledApps();
  const lower = query.toLowerCase();
  const target =
    apps.find((a) => a.name.toLowerCase() === lower) ||
    apps.find((a) => a.name.toLowerCase().startsWith(lower)) ||
    apps.find((a) => a.name.toLowerCase().includes(lower));
  if (!target) {
    const sample = apps.slice(0, 40).map((a) => a.name).join(", ");
    return {
      ok: false,
      error:
        `No installed app matching "${query}". Installed apps include: ${sample}` +
        (apps.length > 40 ? ", …" : "") + ".",
    };
  }

  const launched = await appDock.launchApp(target.path);
  if (launched && launched.ok) {
    return {
      ok: true,
      app: target.name,
      note: `${target.name} is now open on the user's screen.`,
    };
  }
  return launched || { ok: false, error: `Could not open ${target.name}.` };
}

// ---------------------------------------------------------------------------
// local_open_path — validate a file/folder before the renderer opens it
// ---------------------------------------------------------------------------

async function openPathTool(args = {}) {
  const target = resolveUserPath(args.path);
  if (!target) {
    return { ok: false, error: 'path is required, e.g. { path: "~/Desktop" }' };
  }
  const stat = await fsp.stat(target);
  const type = stat.isDirectory() ? "dir" : "file";
  return {
    ok: true,
    path: target,
    type,
    parent: type === "file" ? path.dirname(target) : target,
    note:
      type === "dir"
        ? `${target} is now open in LYKN Files.`
        : `${target} is now open on the user's screen.`,
  };
}

const ARRANGE_KEYS = ["kind", "name", "date"];

/**
 * local_organize_desktop — tidy the icons on LYKN's own Home desktop.
 *
 * Nothing to do down here: the desktop is a React surface in the renderer, so
 * this only settles what was asked for and the client does the arranging when
 * the result comes back (the same split local_open_path uses). It still goes
 * through the tool path rather than straight to the renderer so the model's
 * call is gated, logged, and answered like every other local tool.
 */
function organizeDesktopTool(args = {}) {
  const raw = String(args.by || "").trim().toLowerCase();
  const by = ARRANGE_KEYS.includes(raw) ? raw : null;
  return {
    ok: true,
    by,
    note: by
      ? `The user's desktop icons are now arranged by ${by}.`
      : "The user's desktop icons are now lined up on a grid.",
  };
}

// ---------------------------------------------------------------------------
// local_read_app — read what's showing inside a Mac app WITHOUT a screenshot
// ---------------------------------------------------------------------------
// Three layers, best first:
//   1. The app's AppleScript dictionary (Spotify → exact track + playback,
//      browsers → active tab). Structured and precise when it exists.
//   2. The macOS Accessibility tree: on-screen text read the way VoiceOver
//      reads it. Works for native apps; Electron apps need the
//      AXManualAccessibility nudge and may still expose little.
//   3. Window titles — nearly free and often informative ("Track — Artist").

const OSA_READ_TIMEOUT_MS = 15_000;
const APP_TEXT_CAP = 12_000;

function runOsa(script, argv = [], timeoutMs = OSA_READ_TIMEOUT_MS, lang = "AppleScript") {
  return new Promise((resolve) => {
    let child;
    try {
      const langArgs = lang === "JavaScript" ? ["-l", "JavaScript"] : [];
      child = spawn("osascript", [...langArgs, "-e", script, ...argv.map(String)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: -1, out: "", err: e?.message || "spawn failed" });
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: String(out).trim(), err: String(err).trim() });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: "", err: e?.message || "osascript failed" });
    });
  });
}

// Dictionary scripts must embed the app name LITERALLY — AppleScript
// resolves app-specific terms (`player state`, `active tab`) at compile
// time, so `tell application someVariable` is a guaranteed syntax error.
function osaQuote(s) {
  return `"${String(s).replace(/[\\"]/g, "\\$&")}"`;
}

// Player-style dictionary (Spotify and Music share the shape). Variable
// names are deliberately verbose — short ones can collide with dictionary
// terms (Spotify reserves `st`, which breaks the parse with a baffling
// "Expected expression" error).
function playerScript(appName) {
  return `
tell application ${osaQuote(appName)}
  set theState to (player state as text)
  set theOut to "state: " & theState
  try
    set theTrack to current track
    set theOut to theOut & linefeed & "track: " & (name of theTrack)
    set theOut to theOut & linefeed & "artist: " & (artist of theTrack)
    set theOut to theOut & linefeed & "album: " & (album of theTrack)
    try
      set theOut to theOut & linefeed & "position: " & (round (player position)) & "s"
    end try
  end try
  return theOut
end tell`;
}

const SAFARI_SCRIPT = `
tell application "Safari"
  set theDoc to front document
  return "tab: " & (name of theDoc) & linefeed & "url: " & (URL of theDoc)
end tell`;

function chromiumScript(appName) {
  return `
tell application ${osaQuote(appName)}
  set theTab to active tab of front window
  return "tab: " & (title of theTab) & linefeed & "url: " & (URL of theTab)
end tell`;
}

// On-screen text via the Accessibility tree. Element property reads are one
// Apple Event each, so the walk is capped — enough for "what's on screen",
// cheap enough to return in a few seconds.
// On-screen text via the C-level Accessibility API through JXA. This walks
// thousands of elements in ~1s — an AppleScript/System Events walk is one
// Apple Event PER PROPERTY READ and takes minutes on Electron-sized trees.
// The AXManualAccessibility nudge wakes Chromium/Electron apps, which only
// populate their tree a beat later — hence the delayed second pass.
const AX_TEXT_JXA = `
ObjC.import("Cocoa");
ObjC.import("ApplicationServices");

function run(argv) {
  const appName = String(argv[0] || "");
  const running = $.NSWorkspace.sharedWorkspace.runningApplications;
  let pid = -1;
  for (let i = 0; i < running.count; i++) {
    const a = running.objectAtIndex(i);
    const n = ObjC.unwrap(a.localizedName) || "";
    if (n === appName || n.toLowerCase() === appName.toLowerCase()) {
      pid = a.processIdentifier;
      break;
    }
  }
  if (pid < 0) return "";

  const axApp = $.AXUIElementCreateApplication(pid);
  $.AXUIElementSetAttributeValue(axApp, $("AXManualAccessibility"), $.kCFBooleanTrue);

  function copyAttr(el, attr) {
    const ref = Ref();
    const err = $.AXUIElementCopyAttributeValue(el, $(attr), ref);
    if (err !== 0) return null;
    return ref[0];
  }
  function toJS(v) {
    try {
      return ObjC.deepUnwrap(ObjC.castRefToObject(v));
    } catch (e) {
      return null;
    }
  }
  function childRefs(cfArr) {
    if (!cfArr) return null;
    const arr = ObjC.castRefToObject(cfArr);
    if (!arr || !arr.count) return null;
    const out = [];
    for (let i = 0; i < arr.count; i++) out.push(arr.objectAtIndex(i));
    return out;
  }

  const TEXT_ROLES = { AXStaticText: 1, AXLink: 1, AXHeading: 1, AXTextField: 1, AXTextArea: 1 };

  function walk() {
    const windows = childRefs(copyAttr(axApp, "AXWindows"));
    if (!windows || !windows.length) return [];
    const lines = [];
    let visited = 0;
    const stack = [windows[0]];
    while (stack.length && visited < 6000 && lines.length < 800) {
      const el = stack.pop();
      visited++;
      const role = toJS(copyAttr(el, "AXRole"));
      if (role && TEXT_ROLES[role]) {
        let v = toJS(copyAttr(el, "AXValue"));
        if (!v || typeof v !== "string" || !v.trim()) v = toJS(copyAttr(el, "AXTitle"));
        if (v && typeof v === "string" && v.trim()) lines.push(v.trim());
      }
      const kids = childRefs(copyAttr(el, "AXChildren"));
      if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return lines;
  }

  let lines = walk();
  if (!lines.length) {
    // Electron tree still building after the nudge — one delayed retry.
    $.NSThread.sleepForTimeInterval(0.9);
    lines = walk();
  }
  return lines.join("\\n");
}`;

const WINDOW_TITLES_SCRIPT = `
on run argv
  set procName to item 1 of argv
  tell application "System Events"
    return name of windows of process procName
  end tell
end run`;

async function readAppViaDictionary(procName) {
  const lower = procName.toLowerCase();
  if (lower === "spotify" || lower === "music" || lower === "itunes") {
    const r = await runOsa(playerScript(procName), [], 6000);
    return r.out || "";
  }
  if (lower === "safari") {
    const r = await runOsa(SAFARI_SCRIPT, [], 6000);
    return r.out || "";
  }
  if (
    ["google chrome", "brave browser", "microsoft edge", "arc", "vivaldi", "opera"].includes(lower)
  ) {
    const r = await runOsa(chromiumScript(procName), [], 6000);
    return r.out || "";
  }
  return "";
}

async function readAppTool(args = {}) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "local_read_app is only available on macOS." };
  }

  let target = String(args.app || "").trim();
  if (!target) {
    const fm = await runOsa(
      `tell application "System Events" to get name of first application process whose frontmost is true`,
      [],
      6000
    );
    target = fm.out;
    if (!target) {
      return {
        ok: false,
        error:
          "No app specified, and the frontmost app couldn't be determined. " +
          "Pass an app name, e.g. { app: \"Spotify\" }.",
      };
    }
  }

  // Resolve to the exact running process name (System Events is case-exact).
  const list = await runOsa(
    `tell application "System Events" to get name of every application process whose background only is false`,
    [],
    6000
  );
  const running = list.out ? list.out.split(", ") : [];
  const lower = target.toLowerCase();
  const proc =
    running.find((n) => n.toLowerCase() === lower) ||
    running.find((n) => n.toLowerCase().includes(lower)) ||
    "";
  if (!proc) {
    return {
      ok: false,
      error: `${target} doesn't appear to be running. Use local_running_apps to see open apps.`,
    };
  }

  const result = { ok: true, app: proc };

  // Cheap and always useful — titles often carry state ("Track — Artist").
  const titles = await runOsa(WINDOW_TITLES_SCRIPT, [proc], 6000);
  if (titles.out) result.windowTitles = titles.out.slice(0, 500);

  // Structured data beats everything when the app is scriptable.
  const dict = await readAppViaDictionary(proc);
  if (dict) {
    result.method = "app-script";
    result.content = dict.slice(0, APP_TEXT_CAP);
    return result;
  }

  // Fall back to reading the window's on-screen text via Accessibility.
  const ax = await runOsa(AX_TEXT_JXA, [proc], OSA_READ_TIMEOUT_MS, "JavaScript");
  const axText = (ax.out || "").replace(/\n{3,}/g, "\n\n").trim();
  if (axText) {
    result.method = "accessibility";
    result.content = axText.slice(0, APP_TEXT_CAP);
    return result;
  }

  result.method = "window-titles";
  result.content = "";
  result.note =
    `${proc} exposes no readable text through its scripting dictionary or the Accessibility ` +
    "tree (common for Electron/game/canvas apps). Only the window titles above are available — " +
    "answer from those, or ask the user to describe what they see.";
  return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run a local tool. Returns either:
 *  - { needsApproval: true, summary } if the action is risky and not approved
 *  - a tool result object (always has ok: boolean)
 */
async function run(
  name,
  args = {},
  { approved = false, userDataPath = "", signal = null, workspaceOnly = false } = {},
) {
  if (!isLocalToolName(name)) {
    return { ok: false, error: `Unknown local tool: ${name}` };
  }
  // Build-workspace-only sessions (Local Mode off): every tool is confined to
  // ~/LYKN/Builds. Filesystem defaults point there, the allowlist is exactly
  // the workspace, and Mac-wide tools (apps, desktop) are refused.
  if (workspaceOnly) {
    return runWorkspaceOnly(name, args, { approved, signal });
  }
  const config = readLocalMode(userDataPath || defaultUserDataPath);
  const approvedRoot = (config.syncedFolders || [])[0] || "";
  const needsApprovedRoot = [
    "local_list_dir",
    "local_read_file",
    "local_search_files",
    "local_pull_file",
    "local_write_file",
    "local_edit_file",
    "local_run_command",
    "local_open_path",
  ].includes(name);
  if (config.syncAll === false && !approvedRoot && needsApprovedRoot) {
    return {
      ok: false,
      code: "local_mode_no_roots",
      error:
        "Local Mode is on, but no folders are approved. Ask the user to pick a folder in Local Mode settings. Enabling Local Mode does not grant the whole home folder.",
    };
  }
  // When the user picked specific folders, default filesystem tools into the
  // first approved root instead of $HOME (which would then be blocked).
  if (config.syncAll === false && approvedRoot) {
    if (name === "local_run_command" && !args.cwd) {
      args = { ...args, cwd: approvedRoot };
    }
    if ((name === "local_list_dir" || name === "local_search_files") && !args.path) {
      args = { ...args, path: approvedRoot };
    }
  }
  const access = checkToolAccess(name, args, config);
  if (!access.allowed) {
    const switchedOff = (config.excludedFolders || []).find((f) =>
      isInsideFolder(access.blockedPath, f)
    );
    if (switchedOff) {
      return {
        ok: false,
        error:
          `Path not synced: ${access.blockedPath}. The user switched sync off for ${switchedOff}, ` +
          "so nothing inside it can be read. They can switch it back on from that folder in the Vault.",
      };
    }
    const folders =
      config.syncAll !== false
        ? `home (${homeDir()})`
        : (config.syncedFolders || []).join(", ") || "(none)";
    return {
      ok: false,
      code: "local_mode_path_denied",
      error:
        `Path not synced: ${access.blockedPath}. LYKN can only access the folders the user ` +
        `approved: ${folders}. Ask the user to add the folder in Local Mode settings if needed.`,
    };
  }
  const risk = classifyRisk(name, args);
  if (risk.risky && !approved) {
    return { needsApproval: true, summary: risk.summary, tool: name };
  }
  return dispatchTool(name, args, { signal, config });
}

/**
 * Workspace-only execution: Local Mode is off, but the Build agent may work
 * inside ~/LYKN/Builds. Access checks run against a synthetic config whose
 * only root is the workspace; risk classification is unchanged (workspace-
 * scoped commands are routine, the always-confirm list still holds).
 */
async function runWorkspaceOnly(name, args = {}, { approved = false, signal = null } = {}) {
  const WORKSPACE_BLOCKED = new Set([
    "local_running_apps",
    "local_read_app",
    "local_open_app",
    "local_organize_desktop",
    "local_synced_folders",
    "local_pull_file",
    // Physical control of the Mac needs full Local Mode consent, not the
    // implicit workspace grant.
    "local_desktop_look",
    "local_desktop_act",
  ]);
  if (WORKSPACE_BLOCKED.has(name)) {
    return {
      ok: false,
      error:
        `${name} is not available in this session — only the Build workspace is accessible. ` +
        "It becomes available when the user enables Local Mode in the Vault.",
    };
  }
  const root = buildWorkspace.ensureWorkspaceRoot();
  const config = { syncAll: false, syncedFolders: [root], excludedFolders: [] };
  let scoped = args;
  if (
    (name === "local_run_command" || name === "local_start_process") &&
    !args.cwd
  ) {
    scoped = { ...args, cwd: root };
  }
  if ((name === "local_list_dir" || name === "local_search_files") && !args.path) {
    scoped = { ...args, path: root };
  }
  // Relative paths mean "inside the workspace" here, not "inside ~". A model
  // writing `my-app/index.html` on its first call must land in the workspace,
  // not bounce off the allowlist because ~ resolved outside it.
  const rebase = (p) => {
    const raw = String(p || "").trim();
    if (!raw || raw === "~" || raw.startsWith("~/") || path.isAbsolute(raw)) return p;
    return path.join(root, raw);
  };
  if (typeof scoped.path === "string") scoped = { ...scoped, path: rebase(scoped.path) };
  if (typeof scoped.cwd === "string") scoped = { ...scoped, cwd: rebase(scoped.cwd) };
  const access = checkToolAccess(name, scoped, config);
  if (!access.allowed) {
    return {
      ok: false,
      code: "workspace_path_denied",
      error:
        `Path outside the Build workspace: ${access.blockedPath}. This session can only ` +
        `access ${root}. Ask the user to enable Local Mode (Vault → Local) for broader access.`,
    };
  }
  const risk = classifyRisk(name, scoped);
  if (risk.risky && !approved) {
    return { needsApproval: true, summary: risk.summary, tool: name };
  }
  return dispatchTool(name, scoped, { signal, config });
}

async function dispatchTool(name, args, { signal, config }) {
  try {
    switch (name) {
      case "local_list_dir":
        return await listDir(args);
      case "local_read_file":
        return await readFileTool(args);
      case "local_search_files":
        return await searchFiles(args);
      case "local_pull_file":
        return await pullFile(args);
      case "local_write_file":
        return await writeFileTool(args);
      case "local_edit_file":
        return await editFileTool(args);
      case "local_run_command":
        return await runCommand(args, { signal });
      case "local_build_workspace":
        return await buildWorkspaceTool();
      case "local_start_process":
        return await startProcessTool(args);
      case "local_process_status":
        return processManager.processStatus(args);
      case "local_stop_process":
        return await processManager.stopProcess(args);
      case "local_install_app":
        return await installAppTool(args);
      case "local_synced_folders":
        return syncedFoldersTool(config);
      case "local_running_apps":
        return await runningAppsTool();
      case "local_read_app":
        return await readAppTool(args);
      case "local_open_app":
        return await openAppTool(args);
      case "local_open_path":
        return await openPathTool(args);
      case "local_organize_desktop":
        return organizeDesktopTool(args);
      case "local_desktop_look": {
        const control = require("./desktop-agent/desktopControl.cjs");
        return await control.getDesktopControl({ getRunningApps: desktopRunningApps }).look(args);
      }
      case "local_desktop_act": {
        const control = require("./desktop-agent/desktopControl.cjs");
        // Reaching dispatch means the approval gate passed (or the session was
        // already armed) — remember it so the next act flows without a pause.
        control.armSession();
        return await control.getDesktopControl({ getRunningApps: desktopRunningApps }).act(args);
      }
      default:
        return { ok: false, error: `Unknown local tool: ${name}` };
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

module.exports = {
  LOCAL_TOOL_NAMES,
  isLocalToolName,
  classifyRisk,
  classifyCommandConsequence,
  commandScopedToWorkspace,
  configure,
  configureExtraction,
  readLocalMode,
  writeLocalMode,
  writeMacSync,
  writeFolderSync,
  isAllowedPath,
  resolveUserPath,
  run,
  checkToolAccess,
  commandPathTargets,
  inferSyncAll,
  stopAllManagedProcesses: processManager.stopAll,
};
