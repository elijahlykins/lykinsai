"use strict";

/**
 * Desktop MCP launch policy — CJS twin of lib/mcp/stdio/parseLocalCommand.js
 * + lib/mcp/stdio/commandPolicy.js for the Electron main process, which the
 * packaged app cannot import as ESM. Behavior parity is enforced by
 * electron/mcp/localCommandPolicy.parity.test.mjs; change both sides together.
 *
 * Spawn argv directly. Never shell=true. Never store a raw shell string.
 */

const path = require("node:path");
const os = require("node:os");

const WRAPPERS = new Set([
  "npx",
  "npm",
  "node",
  "nodejs",
  "python",
  "python3",
  "uvx",
  "uv",
  "bunx",
  "bun",
  "deno",
]);

const SHELL_META = /[|&;<>$`\n\r]|&&|\|\|/;

const FORBIDDEN_COMMANDS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "pwsh",
  "eval",
  "open",
]);

const DANGEROUS_FLAGS = new Set(["-c", "/c", "-Command", "-EncodedCommand"]);

function tokenizeCommandLine(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "missing_command" };
  if (text.length > 500) return { ok: false, error: "command_too_long" };
  const parts = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) return { ok: false, error: "unbalanced_quotes" };
  if (current) parts.push(current);
  if (!parts.length) return { ok: false, error: "missing_command" };
  return { ok: true, parts };
}

function parseLocalCommand(input) {
  if (input && typeof input === "object" && (input.command || Array.isArray(input.args))) {
    const command = String(input.command || "").trim();
    const args = Array.isArray(input.args) ? input.args.map((part) => String(part)) : [];
    if (!command) return { ok: false, error: "missing_command" };
    return { ok: true, command, args, confirmInstall: !!input.confirmInstall };
  }
  const parsed = tokenizeCommandLine(input);
  if (!parsed.ok) return parsed;
  const [command, ...args] = parsed.parts;
  return { ok: true, command, args, confirmInstall: false };
}

function isWrapperCommand(command) {
  const base = String(command || "").split(/[/\\]/).pop() || "";
  return WRAPPERS.has(base.toLowerCase());
}

function hasShellMetacharacters(value) {
  return SHELL_META.test(String(value || ""));
}

function canonicalizeWrapperArgs(base, args, confirmInstall) {
  if (base === "npx" && confirmInstall && !args.includes("-y") && !args.includes("--yes")) {
    return ["-y", ...args];
  }
  return args;
}

function assertLocalCommandSafe({ command, args = [], confirmInstall = false } = {}) {
  const cmd = String(command || "").trim();
  if (!cmd) return { ok: false, error: "missing_command" };
  if (cmd.length > 240) return { ok: false, error: "command_too_long" };
  if (/[|&;<>$`\n\r]/.test(cmd)) return { ok: false, error: "unsafe_command" };

  const base = path.basename(cmd).toLowerCase();
  if (FORBIDDEN_COMMANDS.has(base)) return { ok: false, error: "forbidden_command" };

  const argv = Array.isArray(args) ? args.map((part) => String(part)) : [];
  if (argv.length > 32) return { ok: false, error: "too_many_args" };
  for (const arg of argv) {
    if (arg.length > 400) return { ok: false, error: "arg_too_long" };
    if (arg.includes("\0")) return { ok: false, error: "unsafe_arg" };
  }
  if (argv.some((arg) => DANGEROUS_FLAGS.has(arg))) {
    return { ok: false, error: "shell_invocation_rejected" };
  }

  const wrapper = isWrapperCommand(cmd);
  if (!wrapper && !path.isAbsolute(cmd) && cmd.includes(path.sep)) {
    return { ok: false, error: "relative_path_rejected" };
  }
  if (!wrapper && !path.isAbsolute(cmd) && !WRAPPERS.has(base)) {
    return { ok: false, error: "unknown_command" };
  }

  const needsInstall = wrapper && /^(npx|uvx|bunx)$/i.test(base);
  if (needsInstall && !confirmInstall) {
    return { ok: false, error: "install_confirmation_required", command: cmd, args: argv };
  }

  return {
    ok: true,
    command: cmd,
    args: canonicalizeWrapperArgs(base, argv, confirmInstall),
    wrapper,
  };
}

function assertWorkingDirectorySafe(cwd) {
  if (!cwd) return { ok: true, cwd: null };
  const text = String(cwd).trim();
  if (!text) return { ok: true, cwd: null };
  if (!path.isAbsolute(text)) return { ok: false, error: "cwd_must_be_absolute" };
  if (/[|&;<>$`\n\r]/.test(text)) return { ok: false, error: "unsafe_cwd" };
  const resolved = path.resolve(text);
  const home = os.homedir();
  const allowedRoots = [home, "/tmp", os.tmpdir(), process.cwd()].filter(Boolean);
  const ok = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );
  if (!ok) return { ok: false, error: "cwd_outside_allowed_roots" };
  return { ok: true, cwd: resolved };
}

/**
 * Child env for a desktop MCP server: a sanitized copy of the parent env,
 * PATH widened with the common user-tool locations a GUI-launched Electron
 * app does not inherit (Homebrew, ~/.local/bin for uv, npm globals), plus
 * the user's own explicit vars. Desktop-only: these processes run on the
 * user's machine as the user, so their vars are theirs to set.
 */
const SAFE_PARENT_ENV = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NVM_DIR",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "ComSpec",
  "SYSTEMROOT",
];

const EXTRA_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), ".cargo", "bin"),
];

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

function desktopChildEnv(userEnv = {}, parentEnv = process.env) {
  const out = {};
  for (const key of SAFE_PARENT_ENV) {
    if (parentEnv[key]) out[key] = parentEnv[key];
  }
  const parts = String(out.PATH || "/usr/bin:/bin:/usr/sbin:/sbin").split(path.delimiter);
  for (const dir of EXTRA_PATH_DIRS) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  out.PATH = parts.join(path.delimiter);
  if (userEnv && typeof userEnv === "object" && !Array.isArray(userEnv)) {
    for (const [key, value] of Object.entries(userEnv)) {
      const name = String(key || "").trim();
      if (!ENV_NAME_RE.test(name)) continue;
      if (typeof value !== "string" || value.length > 400) continue;
      out[name] = value;
    }
  }
  return out;
}

module.exports = {
  WRAPPERS,
  tokenizeCommandLine,
  parseLocalCommand,
  isWrapperCommand,
  hasShellMetacharacters,
  assertLocalCommandSafe,
  assertWorkingDirectorySafe,
  desktopChildEnv,
};
