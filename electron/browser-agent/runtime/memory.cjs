/**
 * Layered memory for the browser agent.
 *
 * - Durable user memory + preferences: seeded from agent/memory templates,
 *   with runtime additions stored under the app's userData directory (the
 *   packaged app directory is read-only).
 * - Website knowledge: one markdown note file per host with learned semantic
 *   knowledge (never credentials, never fragile selectors).
 *
 * Working memory lives in the task state, not here.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const instructions = require("./instructions.cjs");

function createMemoryStore({ userDataPath } = {}) {
  const baseDir = userDataPath
    ? path.join(userDataPath, "browser-agent-memory")
    : null;

  async function readUserFile(name) {
    if (!baseDir) return "";
    try {
      return (await fs.readFile(path.join(baseDir, name), "utf8")).trim();
    } catch {
      return "";
    }
  }

  async function appendUserFile(name, text) {
    if (!baseDir) return false;
    const filePath = path.join(baseDir, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const line = `- ${String(text).trim().replace(/\n+/g, " ")} (${new Date().toISOString().slice(0, 10)})\n`;
    await fs.appendFile(filePath, line, "utf8");
    return true;
  }

  /** Durable user memory + preferences, seeds merged with learned entries. */
  async function getUserMemory() {
    const parts = [];
    const seedUser = instructions.loadMemorySeed("user.md");
    const seedPrefs = instructions.loadMemorySeed("preferences.md");
    const learnedUser = await readUserFile("user.md");
    const learnedPrefs = await readUserFile("preferences.md");
    if (learnedUser) parts.push(`# User Memory\n${learnedUser}`);
    else if (seedUser && !/nothing stored yet/i.test(seedUser)) parts.push(seedUser);
    if (learnedPrefs) parts.push(`# Preferences\n${learnedPrefs}`);
    else if (seedPrefs && !/nothing stored yet/i.test(seedPrefs)) parts.push(seedPrefs);
    return parts.join("\n\n");
  }

  function hostFromUrl(url) {
    try {
      return new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  }

  /** Learned + seeded knowledge about the current site. */
  async function getWebsiteMemory(urlOrHost) {
    const host = urlOrHost?.includes?.("/") ? hostFromUrl(urlOrHost) : String(urlOrHost || "").toLowerCase();
    if (!host) return "";
    const seed = instructions.loadWebsiteSeed(host);
    const learned = await readUserFile(path.join("websites", `${host}.md`));
    const parts = [seed, learned].filter(Boolean);
    return parts.length ? `# Known about ${host}\n${parts.join("\n")}` : "";
  }

  const SECRET_RE = /password|passcode|\btoken\b|api[_ ]?key|secret|card number|\bcvv\b|\bcvc\b|\botp\b|one-time/i;

  /** Persist a semantic note about a website. Secrets are refused. */
  async function rememberWebsiteNote(urlOrHost, note) {
    const host = urlOrHost?.includes?.("/") ? hostFromUrl(urlOrHost) : String(urlOrHost || "").toLowerCase();
    const text = String(note || "").trim();
    if (!host || !text) return false;
    if (SECRET_RE.test(text)) return false;
    return appendUserFile(path.join("websites", `${host}.md`), text);
  }

  async function rememberUserFact(fact) {
    const text = String(fact || "").trim();
    if (!text || SECRET_RE.test(text)) return false;
    return appendUserFile("user.md", text);
  }

  return {
    getUserMemory,
    getWebsiteMemory,
    rememberWebsiteNote,
    rememberUserFact,
    hostFromUrl,
  };
}

module.exports = { createMemoryStore };
