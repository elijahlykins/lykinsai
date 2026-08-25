/**
 * Loads the Bot harness markdown corpus. Files live under
 * electron/bot-harness/ and are cached after the first read.
 *
 * The operating rules are deliberately few — AGENTS.md (identity + LYKN
 * context), core.md (reasoning and the loop), safety.md — and all of them are
 * always loaded. Tool documentation is NOT: the system prompt carries only a
 * one-line index per tool, and a tool's full doc is loaded into the task the
 * first time the model selects it (see toolRegistry.cjs). That keeps the
 * system prompt small and byte-stable, and it means the model reads a tool's
 * real contract right before its first use instead of skimming seven docs it
 * will never call.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.join(__dirname, "..");
const AGENT_DIR = path.join(ROOT_DIR, "agent");

const cache = new Map();

function readCached(filePath) {
  if (cache.has(filePath)) return cache.get(filePath);
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8").trim();
  } catch {
    text = "";
  }
  cache.set(filePath, text);
  return text;
}

/** Identity + LYKN company context. */
function loadAgentsMd() {
  return readCached(path.join(ROOT_DIR, "AGENTS.md"));
}

/** Reasoning, tool choice, asking vs acting, delivery. */
function loadCoreRules() {
  return readCached(path.join(AGENT_DIR, "core.md"));
}

/** Approvals, deliveries, credentials, money, data. */
function loadSafetyRules() {
  return readCached(path.join(AGENT_DIR, "safety.md"));
}

/** Full documentation for one tool, by registry name. */
function loadToolDoc(name) {
  const safe = String(name || "").replace(/[^a-z0-9_-]/gi, "");
  if (!safe) return "";
  return readCached(path.join(AGENT_DIR, "tools", `${safe}.md`));
}

module.exports = {
  AGENT_DIR,
  loadAgentsMd,
  loadCoreRules,
  loadSafetyRules,
  loadToolDoc,
};
