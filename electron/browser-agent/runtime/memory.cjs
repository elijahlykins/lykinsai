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

  /** Loose equality so a re-learned note does not accumulate near-duplicates. */
  function noteKey(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\(\d{4}-\d{2}-\d{2}\)\s*$/, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Only so much site memory can be injected into a prompt, so an unbounded
   * file would let stale notes crowd out what was just learned. Keep the most
   * recent entries and drop the rest.
   */
  const MAX_NOTES_PER_SITE = 24;

  async function appendNotesDeduped(name, notes) {
    if (!baseDir) return 0;
    const filePath = path.join(baseDir, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const existing = await readUserFile(name);
    const lines = existing ? existing.split("\n").filter((l) => l.trim()) : [];
    const seen = new Set(lines.map(noteKey));
    let added = 0;
    const today = new Date().toISOString().slice(0, 10);
    for (const note of notes) {
      const text = String(note || "").trim().replace(/\n+/g, " ");
      if (!text) continue;
      const key = noteKey(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${text} (${today})`);
      added += 1;
    }
    if (!added) return 0;
    const kept = lines.slice(-MAX_NOTES_PER_SITE);
    await fs.writeFile(filePath, `${kept.join("\n")}\n`, "utf8");
    return added;
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

  /**
   * The host plus its parent domains, most specific first.
   *
   * Big products shard their app across regional hosts —
   * `us21.admin.mailchimp.com` today, `us14.` for the next account. Knowledge
   * about the product belongs to `mailchimp.com` and has to reach every one of
   * them, or a hand-written playbook never loads for anybody.
   */
  function hostLookupChain(host) {
    const labels = String(host || "").split(".").filter(Boolean);
    const chain = [];
    for (let i = 0; i + 2 <= labels.length; i += 1) {
      chain.push(labels.slice(i).join("."));
    }
    return chain;
  }

  /** Learned + seeded knowledge about the current site. */
  async function getWebsiteMemory(urlOrHost) {
    const host = urlOrHost?.includes?.("/") ? hostFromUrl(urlOrHost) : String(urlOrHost || "").toLowerCase();
    if (!host) return "";
    const parts = [];
    const seen = new Set();
    for (const candidate of hostLookupChain(host)) {
      const seed = instructions.loadWebsiteSeed(candidate);
      // Notes are written per exact host, so only that file is read back; the
      // parent domains contribute hand-written product knowledge.
      const learned = candidate === host ? await readUserFile(path.join("websites", `${host}.md`)) : "";
      for (const text of [seed, learned]) {
        if (text && !seen.has(text)) {
          seen.add(text);
          parts.push(text);
        }
      }
    }
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

  /**
   * Persist several notes about a site at once, skipping anything already
   * known. This is what turns a finished run into a head start on the next one.
   */
  async function rememberWebsiteNotes(urlOrHost, notes) {
    const host = urlOrHost?.includes?.("/") ? hostFromUrl(urlOrHost) : String(urlOrHost || "").toLowerCase();
    if (!host) return 0;
    const safe = (Array.isArray(notes) ? notes : [])
      .map((n) => String(n || "").trim())
      .filter((n) => n && n.length >= 12 && n.length <= 300 && !SECRET_RE.test(n));
    if (!safe.length) return 0;
    try {
      return await appendNotesDeduped(path.join("websites", `${host}.md`), safe);
    } catch {
      return 0;
    }
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
    rememberWebsiteNotes,
    rememberUserFact,
    hostFromUrl,
  };
}

module.exports = { createMemoryStore };
