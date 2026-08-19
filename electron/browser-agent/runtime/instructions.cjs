/**
 * Loads the agent's markdown instruction files. Files live under
 * electron/browser-agent/agent/ and are cached after the first read.
 *
 * The operating rules are three files — core, browser, safety — and all three
 * are always loaded. They used to be nine, routed in per round by a heuristic
 * that guessed which ones the situation called for. That guessing cost more
 * than it saved: the navigation rules were routed out on every round after the
 * first click (leaving the agent with three "stay where you were told" rules
 * and nothing about when moving on is correct), and the download rules were
 * unreachable by any combination of inputs at all. The whole corpus is ~24KB;
 * the snapshot it sits next to is bigger. Load it and be done.
 *
 * Skills stay routed — they are genuinely task-specific, and there is no
 * situation where all five apply at once.
 */

const fs = require("node:fs");
const path = require("node:path");

const AGENT_DIR = path.join(__dirname, "..", "agent");
const ROOT_AGENTS_MD = path.join(__dirname, "..", "AGENTS.md");

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

function loadAgentsMd() {
  return readCached(ROOT_AGENTS_MD);
}

/** Identity, reasoning, the loop, and the priority order. */
function loadCoreInstructions() {
  return readCached(path.join(AGENT_DIR, "core.md"));
}

/** Observation, navigation, interaction, forms, editing, builders, tabs,
 * downloads and recovery. */
function loadBrowserRules() {
  return readCached(path.join(AGENT_DIR, "browser.md"));
}

/** Permissions, purchases, destructive actions and credentials. */
function loadSafetyRules() {
  return readCached(path.join(AGENT_DIR, "safety.md"));
}

function listSkills() {
  try {
    return fs
      .readdirSync(path.join(AGENT_DIR, "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => readCached(path.join(AGENT_DIR, "skills", name, "SKILL.md")));
  } catch {
    return [];
  }
}

function loadSkill(name) {
  const safe = String(name || "").replace(/[^a-z0-9_-]/gi, "");
  if (!safe) return "";
  return readCached(path.join(AGENT_DIR, "skills", safe, "SKILL.md"));
}

function loadMemorySeed(file) {
  return readCached(path.join(AGENT_DIR, "memory", file));
}

function loadWebsiteSeed(host) {
  const safe = String(host || "").replace(/[^a-z0-9.-]/gi, "");
  if (!safe) return "";
  return readCached(path.join(AGENT_DIR, "memory", "websites", `${safe}.md`));
}

module.exports = {
  AGENT_DIR,
  loadAgentsMd,
  loadCoreInstructions,
  loadBrowserRules,
  loadSafetyRules,
  listSkills,
  loadSkill,
  loadMemorySeed,
  loadWebsiteSeed,
};
