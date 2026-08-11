/**
 * Loads the agent's markdown instruction modules (progressive disclosure).
 * Files live under electron/browser-agent/agent/ and are cached after the
 * first read.
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

/** Core identity + reasoning + loop + priorities — always loaded. */
function loadCoreInstructions() {
  return ["identity.md", "reasoning.md", "loop.md", "priorities.md"]
    .map((f) => readCached(path.join(AGENT_DIR, "core", f)))
    .filter(Boolean)
    .join("\n\n");
}

const BROWSER_MODULES = [
  "navigation",
  "observation",
  "interaction",
  "editing",
  "tabs",
  "forms",
  "downloads",
  "recovery",
];

function loadBrowserModules(names = []) {
  const wanted = names.filter((n) => BROWSER_MODULES.includes(n));
  return wanted
    .map((n) => readCached(path.join(AGENT_DIR, "browser", `${n}.md`)))
    .filter(Boolean)
    .join("\n\n");
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

const SAFETY_MODULES = ["permissions", "destructive-actions", "purchases", "credentials"];

function loadSafetyModules(names = SAFETY_MODULES) {
  return names
    .filter((n) => SAFETY_MODULES.includes(n))
    .map((n) => readCached(path.join(AGENT_DIR, "safety", `${n}.md`)))
    .filter(Boolean)
    .join("\n\n");
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
  BROWSER_MODULES,
  SAFETY_MODULES,
  loadAgentsMd,
  loadCoreInstructions,
  loadBrowserModules,
  listSkills,
  loadSkill,
  loadSafetyModules,
  loadMemorySeed,
  loadWebsiteSeed,
};
