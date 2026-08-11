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

function readLocalMode(userDataPath) {
  try {
    const data = JSON.parse(fs.readFileSync(settingPath(userDataPath), "utf8"));
    return { enabled: data?.enabled === true, updatedAt: Number(data?.updatedAt) || 0 };
  } catch {
    return { enabled: false, updatedAt: 0 };
  }
}

function writeLocalMode(userDataPath, enabled) {
  const next = { enabled: enabled === true, updatedAt: Date.now() };
  try {
    fs.writeFileSync(settingPath(userDataPath), JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    console.error("[LYKN] failed to write local-mode setting:", e?.message);
  }
  return next;
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
        if (depth < 8 && !skipDirs.has(ent.name) && !ent.name.startsWith(".")) {
          stack.push({ dir: full, depth: depth + 1 });
        }
        continue;
      }
      if (!ent.isFile()) continue;
      if (nameRe && !nameRe.test(ent.name)) continue;
      if (!query) {
        results.push({ path: full });
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run a local tool. Returns either:
 *  - { needsApproval: true, summary } if the action is risky and not approved
 *  - a tool result object (always has ok: boolean)
 */
async function run(name, args = {}, { approved = false } = {}) {
  if (!isLocalToolName(name)) {
    return { ok: false, error: `Unknown local tool: ${name}` };
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
  readLocalMode,
  writeLocalMode,
  run,
};
