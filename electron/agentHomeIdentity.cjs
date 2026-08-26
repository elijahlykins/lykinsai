/**
 * Exact identity of the trusted agent-browser home/welcome documents.
 *
 * The `agent-browser-preload.cjs` bridge (openAiMode, ensureMic, transcribe,
 * pickFiles, welcome-send) is injected into EVERY agent tab, so the main-side
 * handlers must independently confirm the caller really is our bundled home
 * document before acting. The previous check matched a URL substring/path
 * suffix (`…agent-browser-home.html`), which an attacker-controlled page could
 * satisfy — e.g. `https://evil.example/agent-browser-home.html`.
 *
 * This module matches the EXACT packaged document identity instead:
 *   - the `file://` URL of the bundled agent-browser-home.html / -welcome.html
 *     (compared by protocol + pathname, ignoring query/hash), or
 *   - the app-controlled `lykn://new-tab` scheme, which a remote origin can
 *     never be served under.
 *
 * A remote `https://` page is rejected on protocol alone, regardless of its
 * path — closing the spoof without changing the loose
 * `isAgentBrowserHomeDocument` used elsewhere for UI/placeholder detection.
 */

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const HOME_FILES = ["agent-browser-home.html", "agent-browser-welcome.html"];

/** file:// hrefs of the packaged home documents living in `dir`. */
function trustedHomeUrls(dir) {
  const set = new Set();
  for (const file of HOME_FILES) {
    try {
      set.add(pathToFileURL(path.join(dir, file)).href);
    } catch {
      /* skip — a malformed base dir just yields no trusted file url */
    }
  }
  return set;
}

/**
 * @param {string} [dir] directory holding the packaged home documents.
 *   Defaults to this module's own directory (the electron/ folder), which is
 *   where the html files ship — so production callers pass nothing.
 */
function createAgentHomeIdentity(dir = __dirname) {
  const trusted = trustedHomeUrls(dir);

  /** Strict: only the exact packaged home/welcome document, or lykn://new-tab. */
  function isTrustedAgentBrowserHomeUrl(url) {
    const raw = String(url || "");
    // App-controlled new-tab scheme. A remote site cannot be served here.
    if (/^lykn:\/\/new-tab(?:[/?#]|$)/i.test(raw)) return true;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return false;
    }
    // Only local packaged files qualify — a remote https page whose path merely
    // ends in the filename is rejected here on protocol alone.
    if (parsed.protocol !== "file:") return false;
    const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    return trusted.has(base);
  }

  return { isTrustedAgentBrowserHomeUrl, trustedHomeUrls: () => new Set(trusted) };
}

module.exports = { createAgentHomeIdentity, trustedHomeUrls, HOME_FILES };
