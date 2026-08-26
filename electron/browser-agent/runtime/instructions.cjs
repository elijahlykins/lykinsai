/**
 * Loads the agent's markdown instruction files. Files live under
 * electron/browser-agent/agent/ and are cached after the first read.
 *
 * The operating rules are tiered by the task's CAPABILITIES, never by a
 * per-round heuristic. History matters here: the rules were once nine files
 * routed in per round by a guess about what the situation called for, and the
 * guess was wrong in both directions (navigation rules vanished after the
 * first click; the download rules were unreachable entirely). Capability
 * tiering is different in kind — it is decided by what the task's action
 * schema CONTAINS, in code, and is fixed for the life of the task:
 *
 *   - core.md            — always: identity, reasoning, the loop, priorities.
 *   - browser-read.md    — always: observation, navigation, overlays, tabs,
 *                          downloads, recovery, batching.
 *   - browser-interact.md — only when the task can click/type: interaction,
 *                          forms, editing.
 *   - safety-actions.md  — only when the task can click/type: permissions,
 *                          deliveries, purchases, destructive actions. A
 *                          read-only task cannot express those actions in its
 *                          schema, so instructions about them are dead weight.
 *   - safety-core.md     — always: credentials, sign-in handovers, and the
 *                          never-ask-permission rules.
 *
 * Skills stay routed — they are genuinely task-specific, and there is no
 * situation where all of them apply at once. (The builders/visual-editor
 * rules, which are surface-specific HOW knowledge, live as a skill now.)
 *
 * The identity file (identity.md) is the former runtime AGENTS.md, relocated
 * so the name no longer collides with developer-facing AGENTS.md files. It is
 * loaded for PLANNING only: its content overlaps core.md almost entirely, and
 * paying for the overlap on every decision round bought nothing.
 */

const fs = require("node:fs");
const path = require("node:path");

const AGENT_DIR = path.join(__dirname, "..", "agent");

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

/** The agent's identity charter (the former runtime AGENTS.md). */
function loadIdentity() {
  return readCached(path.join(AGENT_DIR, "identity.md"));
}

/** Identity, reasoning, the loop, and the priority order. */
function loadCoreInstructions() {
  return readCached(path.join(AGENT_DIR, "core.md"));
}

/** Observation, navigation, overlays, tabs, downloads, recovery, batching. */
function loadBrowserReadRules() {
  return readCached(path.join(AGENT_DIR, "browser-read.md"));
}

/** Interaction, forms and editing — only for tasks that can click and type. */
function loadBrowserInteractRules() {
  return readCached(path.join(AGENT_DIR, "browser-interact.md"));
}

/** Permissions, deliveries, purchases, destructive actions. */
function loadSafetyActionRules() {
  return readCached(path.join(AGENT_DIR, "safety-actions.md"));
}

/** Credentials, sign-in handovers, never-ask-permission. Always loaded. */
function loadSafetyCoreRules() {
  return readCached(path.join(AGENT_DIR, "safety-core.md"));
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
  loadIdentity,
  loadCoreInstructions,
  loadBrowserReadRules,
  loadBrowserInteractRules,
  loadSafetyActionRules,
  loadSafetyCoreRules,
  listSkills,
  loadSkill,
  loadMemorySeed,
  loadWebsiteSeed,
};
