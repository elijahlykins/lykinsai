"use strict";

/**
 * Capability enforcement for local-computer tasks — in code, not in prompt.
 *
 * A canonical Task carries capability strings; this module turns them into the
 * set of localSystem tool names the run may invoke. The set is enforced twice:
 *
 *   1. The local decision schema's tool enum is filtered to it, so a compliant
 *      model cannot even express a disallowed tool.
 *   2. The local loop refuses anything outside it before localSystem.run, and
 *      shell commands receive a second command-shape check so files.move /
 *      files.delete never become a general shell grant.
 *
 * Capability grammar (small hierarchy, grounded in tools that already exist):
 *   "local" / "local_computer" — legacy blanket: every currently supported tool.
 *   "files.read"               — list, read, search, pull, synced-folder inspect.
 *   "files.write"              — write and exact-snippet edit. Not delete.
 *   "files.move"               — constrained shell: mv / cp only (no native tool).
 *   "files.delete"             — constrained shell: rm / rmdir only (no native tool).
 *   "local.apps.read"          — running apps, app content.
 *   "local.apps.interact"      — open app, open path, organize desktop.
 *   "local.shell.read"         — local_run_command only when classifyRisk is not risky.
 *   "local.shell.execute"      — local_run_command (still approval-gated when risky).
 *
 * files.move / files.delete do not invent new filesystem APIs. They only license
 * the shell shapes those operations already used. They never grant full shell.
 */

const FILES_READ_TOOLS = [
  "local_list_dir",
  "local_read_file",
  "local_search_files",
  "local_pull_file",
  "local_synced_folders",
];
const FILES_WRITE_TOOLS = ["local_write_file", "local_edit_file"];
const APPS_READ_TOOLS = ["local_running_apps", "local_read_app"];
const APPS_INTERACT_TOOLS = ["local_open_app", "local_open_path", "local_organize_desktop"];
const SHELL_TOOLS = ["local_run_command"];

const ALL_LOCAL_TOOLS = [
  ...FILES_READ_TOOLS,
  ...FILES_WRITE_TOOLS,
  ...APPS_READ_TOOLS,
  ...APPS_INTERACT_TOOLS,
  ...SHELL_TOOLS,
];

const BLANKET = new Set(["local", "local_computer"]);

function capList(capabilities) {
  return Array.isArray(capabilities) ? capabilities.map(String).filter(Boolean) : [];
}

function hasAny(capabilities, names) {
  const caps = new Set(capList(capabilities));
  return names.some((name) => caps.has(name));
}

function hasBlanket(capabilities) {
  return hasAny(capabilities, [...BLANKET]);
}

function hasLocalCapability(capabilities) {
  const caps = capList(capabilities);
  if (!caps.length) return false;
  if (hasBlanket(caps)) return true;
  return caps.some(
    (cap) =>
      cap === "files.read" ||
      cap === "files.write" ||
      cap === "files.move" ||
      cap === "files.delete" ||
      cap === "local.apps.read" ||
      cap === "local.apps.interact" ||
      cap === "local.shell.read" ||
      cap === "local.shell.execute",
  );
}

/**
 * Tool names a task's capabilities license.
 *
 * @param {string[]} capabilities
 * @returns {Set<string>|null} allowed tool names, or null when the task holds
 *   no local capability at all (the executor must refuse to run it).
 */
function allowedToolNames(capabilities) {
  const caps = capList(capabilities);
  if (!hasLocalCapability(caps)) return null;
  if (hasBlanket(caps)) return new Set(ALL_LOCAL_TOOLS);

  const allowed = new Set();
  if (hasAny(caps, ["files.read"])) {
    for (const tool of FILES_READ_TOOLS) allowed.add(tool);
  }
  if (hasAny(caps, ["files.write"])) {
    for (const tool of FILES_WRITE_TOOLS) allowed.add(tool);
  }
  if (hasAny(caps, ["local.apps.read"])) {
    for (const tool of APPS_READ_TOOLS) allowed.add(tool);
  }
  if (hasAny(caps, ["local.apps.interact"])) {
    for (const tool of APPS_INTERACT_TOOLS) allowed.add(tool);
  }
  if (
    hasAny(caps, ["local.shell.read", "local.shell.execute", "files.move", "files.delete"])
  ) {
    for (const tool of SHELL_TOOLS) allowed.add(tool);
  }
  return allowed;
}

const MOVE_COMMAND = /^(mv|cp)\b/i;
const DELETE_COMMAND = /^(rm|rmdir)\b/i;

/**
 * Whether this shell command is licensed. local_run_command must still pass
 * classifyRisk / approval; this only answers "is the capability present".
 *
 * @param {string} command
 * @param {string[]} capabilities
 * @param {{ risky?: boolean }} [risk]
 */
function commandPermitted(command, capabilities, risk = {}) {
  const caps = capList(capabilities);
  if (hasBlanket(caps) || hasAny(caps, ["local.shell.execute"])) return true;
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  if (hasAny(caps, ["local.shell.read"]) && risk.risky !== true) return true;
  if (hasAny(caps, ["files.move"]) && MOVE_COMMAND.test(cmd)) return true;
  if (hasAny(caps, ["files.delete"]) && DELETE_COMMAND.test(cmd)) return true;
  return false;
}

/**
 * Derive a tight capability set from an already-known local objective.
 * Deterministic and conservative: read-only asks do not gain write, delete,
 * or shell. Explicit caller lists win.
 */
function compileLocalCapabilities(objective, { explicit } = {}) {
  const listed = Array.isArray(explicit)
    ? explicit.map(String).filter(Boolean)
    : [];
  if (listed.length) return listed;

  const t = String(objective || "").toLowerCase();
  const caps = new Set(["files.read"]);

  if (
    /\b(write|edit|create|save|overwrite|update|append|make\s+a\s+file|new\s+file)\b/.test(t)
  ) {
    caps.add("files.write");
  }
  if (/\b(move|copy|rename)\b/.test(t)) {
    caps.add("files.move");
  }
  if (
    /\b(delete|remove|trash|erase)\b/.test(t) &&
    /\b(file|files|folder|folders|directory|directories)\b/.test(t)
  ) {
    caps.add("files.delete");
  }
  if (
    /\b(app|apps|application|spotify|safari|chrome|finder|notes|messages|mail|calendar|slack|discord|figma|cursor|terminal)\b/.test(
      t,
    ) ||
    /\b(what('| i)?s|whats)\s+(playing|open)\b/.test(t) ||
    /\b(now playing|what song|which app)\b/.test(t)
  ) {
    caps.add("local.apps.read");
    if (/\b(open|launch|start|pull up|bring up|switch to)\b/.test(t)) {
      caps.add("local.apps.interact");
    }
  }
  if (
    /\b(terminal|shell|command line|run\s+(the\s+)?command|zsh|bash)\b/.test(t) ||
    /\b(npm|yarn|pnpm|pip3?|brew|git)\s+(run|install|uninstall|status|commit|clone|pull|push|add|remove)\b/.test(
      t,
    )
  ) {
    caps.add("local.shell.execute");
  }
  return [...caps];
}

module.exports = {
  ALL_LOCAL_TOOLS,
  FILES_READ_TOOLS,
  FILES_WRITE_TOOLS,
  APPS_READ_TOOLS,
  APPS_INTERACT_TOOLS,
  SHELL_TOOLS,
  allowedToolNames,
  commandPermitted,
  compileLocalCapabilities,
  hasLocalCapability,
  hasBlanket,
};
