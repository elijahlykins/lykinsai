/**
 * Local Mode capability layer — file + terminal access for LYKN agents.
 *
 * Everything here runs in the Electron main process. Tools are only reachable
 * when the user flips the Local switch in the Vault (persisted per-device in
 * userData/local-mode.json). Reads auto-run; writes/deletes and risky shell
 * commands require explicit approval (`approved: true` on re-invoke).
 */

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const COMMAND_TIMEOUT_MS = 60_000;
const OUTPUT_CAP_BYTES = 50 * 1024;
const READ_CAP_BYTES = 200 * 1024;
const MAX_SEARCH_RESULTS = 200;
const MAX_LIST_ENTRIES = 500;

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

function normalizeSyncedFolders(folders) {
  const out = [];
  for (const f of Array.isArray(folders) ? folders : []) {
    const abs = resolveUserPath(f);
    if (!abs) continue;
    if (!out.includes(abs)) out.push(abs);
  }
  return out.slice(0, 100);
}

function readLocalMode(userDataPath) {
  try {
    const data = JSON.parse(fs.readFileSync(settingPath(userDataPath), "utf8"));
    return {
      enabled: data?.enabled === true,
      updatedAt: Number(data?.updatedAt) || 0,
      // Missing key → true, so configs written before synced folders existed
      // keep their original whole-home behavior.
      syncAll: data?.syncAll !== false,
      syncedFolders: normalizeSyncedFolders(data?.syncedFolders),
      excludedFolders: normalizeSyncedFolders(data?.excludedFolders),
    };
  } catch {
    return {
      enabled: false,
      updatedAt: 0,
      syncAll: true,
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
  "local_run_command",
  "local_synced_folders",
  "local_running_apps",
  "local_read_app",
  "local_open_app",
  "local_open_path",
  "local_organize_desktop",
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

const RISKY_COMMAND_PATTERNS = [
  /\bsudo\b/i,
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bkill(all)?\b/i,
  /\bshutdown\b|\breboot\b/i,
  /\bdiskutil\b|\bmkfs\b|\bdd\b/i,
  /\blaunchctl\b|\bdefaults\s+write\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bnpm\s+(install|i|uninstall|publish)\b/i,
  /\byarn\s+(add|remove)\b/i,
  /\bpnpm\s+(add|install|remove)\b/i,
  /\bbrew\s+(install|uninstall|upgrade)\b/i,
  /\bpip3?\s+(install|uninstall)\b/i,
  /curl[^|;&]*\|\s*(ba|z)?sh/i,
  /wget[^|;&]*\|\s*(ba|z)?sh/i,
  /\bosascript\b/i,
  /(^|[^>])>{1,2}\s*\S/, // shell redirection writes a file
  /\btee\b/i,
  /\btruncate\b/i,
  /\bln\s+-s/i,
  /\bcrontab\b/i,
  /\bsecurity\b/i, // macOS keychain
];

const SAFE_COMMAND_PREFIXES = [
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df",
  "which", "whoami", "date", "uname", "echo", "printenv", "env",
  "grep", "rg", "find", "tree", "diff",
  "git status", "git log", "git diff", "git branch", "git show", "git remote",
  "npm ls", "npm view", "node --version", "npm --version", "python3 --version",
];

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
  const home = path.resolve(homeDir());
  const rel = path.relative(home, absPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isInsideFolder(absPath, folder) {
  const rel = path.relative(path.resolve(folder), absPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * How deeply a path is covered by a list of folders — the nesting depth of the
 * closest one that contains it, or -1 if none does. Depth is what lets two
 * lists disagree about the same path and still settle it.
 */
function coverDepth(absPath, folders) {
  let deepest = -1;
  for (const folder of Array.isArray(folders) ? folders : []) {
    const resolved = path.resolve(String(folder || ""));
    if (!resolved || !isInsideFolder(absPath, resolved)) continue;
    const depth = resolved.split(path.sep).length;
    if (depth > deepest) deepest = depth;
  }
  return deepest;
}

/**
 * Allowlist gate for the synced-folders model. With syncAll (default, matches
 * pre-allowlist installs) every path is allowed exactly as before; otherwise
 * the path must live inside one of the user's synced folders.
 *
 * A folder whose sync the user switched off is excluded either way. The more
 * specific rule wins when the two lists overlap, so switching off Home and then
 * switching Desktop back on reads the way it looks: everything but Desktop.
 */
function isAllowedPath(absPath, config) {
  if (!absPath) return false;
  if (!config) return true;
  const excluded = coverDepth(absPath, config.excludedFolders);
  if (excluded >= 0 && coverDepth(absPath, config.syncedFolders) <= excluded) return false;
  if (config.syncAll !== false) return true;
  return coverDepth(absPath, config.syncedFolders) >= 0;
}

/**
 * Which of a tool call's args are filesystem paths that the allowlist must
 * cover. Returns { allowed: boolean, blockedPath?: string }.
 */
function checkToolAccess(name, args = {}, config) {
  if (!config) return { allowed: true };
  // Nothing to enforce when the whole home folder is shared and no folder has
  // been switched off.
  if (config.syncAll !== false && !(config.excludedFolders || []).length) {
    return { allowed: true };
  }
  const paths = [];
  switch (name) {
    case "local_list_dir":
    case "local_search_files":
      paths.push(resolveUserPath(args.path || "~"));
      break;
    case "local_read_file":
    case "local_pull_file":
    case "local_write_file":
    case "local_open_path":
      paths.push(resolveUserPath(args.path));
      break;
    case "local_run_command":
      paths.push(args.cwd ? resolveUserPath(args.cwd) : homeDir());
      break;
    default:
      return { allowed: true };
  }
  for (const p of paths) {
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
    case "local_pull_file":
    case "local_synced_folders":
    case "local_running_apps":
    case "local_read_app":
    // Opening an app is what a dock click does — visible, non-destructive.
    case "local_open_app":
    // Opening a path mirrors a direct Files-window click.
    case "local_open_path":
    // Only moves icons around on LYKN's own desktop. Nothing on disk changes,
    // and the user can drag them back.
    case "local_organize_desktop":
      return { risky: false, summary: "" };
    case "local_write_file": {
      const target = resolveUserPath(args.path);
      const outside = target && !isInsideHome(target);
      return {
        risky: true,
        summary: `Write file: ${target || "(unknown path)"}${outside ? " (outside home folder)" : ""}`,
      };
    }
    case "local_run_command": {
      const cmd = String(args.command || "").trim();
      const lower = cmd.toLowerCase();
      const isSafePrefix = SAFE_COMMAND_PREFIXES.some(
        (p) => lower === p || lower.startsWith(p + " ")
      );
      const hasChaining = /[;&|]/.test(cmd) && !/^\s*(grep|rg|find)\b/.test(lower);
      const matchesRisky = RISKY_COMMAND_PATTERNS.some((re) => re.test(cmd));
      const cwd = args.cwd ? resolveUserPath(args.cwd) : homeDir();
      const outsideHome = !isInsideHome(cwd);
      const risky = matchesRisky || outsideHome || (!isSafePrefix && hasChaining) || !isSafePrefix;
      return {
        risky,
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
  if (st.size > 10 * 1024 * 1024) {
    return { ok: false, error: `File too large to read (${Math.round(st.size / 1024 / 1024)} MB)` };
  }
  const buf = await fsp.readFile(file);
  // Cheap binary sniff: NUL byte in the first 8KB.
  if (buf.subarray(0, 8192).includes(0)) {
    return { ok: false, error: `${file} looks like a binary file (${st.size} bytes)` };
  }
  const { text, truncated } = capText(buf.toString("utf8"), READ_CAP_BYTES);
  return { ok: true, path: file, size: st.size, content: text, truncated };
}

async function searchFiles(args = {}) {
  const root = resolveUserPath(args.path || "~");
  const namePattern = String(args.namePattern || "").trim();
  const query = String(args.query || "").trim();
  if (!namePattern && !query) {
    return { ok: false, error: "Provide namePattern (glob-ish) and/or query (text to find)" };
  }
  const nameRe = namePattern
    ? new RegExp(
        "^" +
          namePattern
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".") +
          "$",
        "i"
      )
    : null;
  const queryLower = query.toLowerCase();
  const skipDirs = new Set([
    "node_modules", ".git", "Library", ".Trash", ".cache", ".npm",
    "dist", "build", ".next", "venv", ".venv", "__pycache__",
  ]);
  const results = [];
  const stack = [{ dir: root, depth: 0 }];
  let scanned = 0;
  while (stack.length && results.length < MAX_SEARCH_RESULTS && scanned < 20_000) {
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
        if (depth < 8 && !skipDirs.has(ent.name) && !ent.name.startsWith(".")) {
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
      try {
        const st = await fsp.stat(full);
        if (st.size > 2 * 1024 * 1024) continue;
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
    truncated: results.length >= MAX_SEARCH_RESULTS,
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

function runCommand(args = {}) {
  const command = String(args.command || "").trim();
  if (!command) return Promise.resolve({ ok: false, error: "command is required" });
  const cwd = args.cwd ? resolveUserPath(args.cwd) : homeDir();
  return new Promise((resolve) => {
    let out = "";
    let outBytes = 0;
    let settled = false;
    const child = spawn("/bin/zsh", ["-lc", command], {
      cwd,
      env: { ...process.env, LYKN_LOCAL_MODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (chunk) => {
      if (outBytes >= OUTPUT_CAP_BYTES) return;
      const s = chunk.toString("utf8");
      outBytes += Buffer.byteLength(s, "utf8");
      out += s;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      settled = true;
      resolve({
        ok: false,
        command,
        cwd,
        error: `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s`,
        output: capText(out).text,
      });
    }, COMMAND_TIMEOUT_MS);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, command, cwd, error: err?.message || "spawn failed" });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const { text, truncated } = capText(out);
      resolve({ ok: code === 0, command, cwd, exitCode: code, output: text, truncated });
    });
  });
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
        ? "Everything under the home folder is synced."
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
async function run(name, args = {}, { approved = false, userDataPath = "" } = {}) {
  if (!isLocalToolName(name)) {
    return { ok: false, error: `Unknown local tool: ${name}` };
  }
  const config = readLocalMode(userDataPath || defaultUserDataPath);
  // Synced-folders allowlist: when the user picked specific folders, every
  // filesystem tool is confined to them.
  if (config.syncAll === false) {
    // Home-folder defaults would be blocked — root the call in the first
    // synced folder instead.
    if (name === "local_run_command" && !args.cwd) {
      args = { ...args, cwd: config.syncedFolders[0] || homeDir() };
    }
    if ((name === "local_list_dir" || name === "local_search_files") && !args.path) {
      args = { ...args, path: config.syncedFolders[0] || homeDir() };
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
    const folders = (config.syncedFolders || []).join(", ") || "(none)";
    return {
      ok: false,
      error:
        `Path not synced: ${access.blockedPath}. LYKN can only access the folders the user ` +
        `synced: ${folders}. Ask the user to add the folder in Local Mode settings if needed.`,
    };
  }
  const risk = classifyRisk(name, args);
  if (risk.risky && !approved) {
    return { needsApproval: true, summary: risk.summary, tool: name };
  }
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
      case "local_run_command":
        return await runCommand(args);
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
  configure,
  readLocalMode,
  writeLocalMode,
  writeMacSync,
  writeFolderSync,
  isAllowedPath,
  resolveUserPath,
  run,
};
