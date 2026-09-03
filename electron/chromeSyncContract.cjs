"use strict";

/**
 * Shared Chrome/Chromium sync contract for the real browser chrome and the
 * welcome walkthrough. Both surfaces call the same IPC (`lykn:chrome-sync-run`)
 * with the same option names and interpret the same warning keys.
 */
const SYNC_WARN_TEXT = {
  keychain_denied: "Keychain access was denied. Logins weren't imported.",
  automation_denied:
    "Allow LYKN to control your browser in System Settings › Privacy › Automation to import open tabs.",
  db_read_failed: "Couldn't read the cookie database.",
  cookie_read_failed: "Couldn't read logins.",
  cookie_import_failed: "Couldn't import logins.",
  tab_read_failed: "Couldn't read open tabs (is the browser running?).",
  history_read_failed: "Couldn't read your history.",
  history_empty: "No history found to learn from.",
  cookies_kept_existing_login:
    "Some logins couldn't be read safely. Your existing sign-ins were kept as they are.",
  unsupported_platform: "Browser sync is not available on this OS.",
  applescript_failed: "Couldn't read open tabs.",
};

const BLOCKER_RE =
  /^(keychain_denied|db_read_failed|cookie_read_failed|cookie_import_failed|automation_denied|applescript_failed|tab_read_failed|history_read_failed|unsupported_platform)/;

function parseProfileValue(val) {
  const raw = String(val || "");
  const idx = raw.indexOf("::");
  if (idx < 0) {
    return { browserId: raw.trim(), profileDir: "" };
  }
  return {
    browserId: raw.slice(0, idx).trim(),
    profileDir: raw.slice(idx + 2).trim(),
  };
}

function encodeProfileValue(browserId, profileDir) {
  return `${String(browserId || "").trim()}::${String(profileDir || "").trim()}`;
}

function runOptions(input) {
  const src = input && typeof input === "object" ? input : {};
  return {
    browserId: String(src.browserId || "").trim(),
    profileDir: String(src.profileDir || "").trim(),
    importCookies: src.importCookies !== false,
    importTabs: src.importTabs !== false,
    importHistory: src.importHistory !== false,
  };
}

function humaniseWarning(w) {
  const key = String(w || "").split(":")[0].trim();
  if (SYNC_WARN_TEXT[key]) return SYNC_WARN_TEXT[key];
  if (key.startsWith("tab_cap_")) return "Reached the 20-tab limit. Some tabs weren't opened.";
  return "";
}

function blockerWarnings(warnings) {
  return (Array.isArray(warnings) ? warnings : []).filter((w) =>
    BLOCKER_RE.test(String(w || "")),
  );
}

function isBlockerWarning(w) {
  return BLOCKER_RE.test(String(w || ""));
}

function logSyncFailure(scope, err) {
  const message =
    err && typeof err === "object" && "message" in err
      ? String(err.message || "sync_failed")
      : String(err || "sync_failed");
  try {
    console.warn(`[${scope}] chrome sync failed:`, message.slice(0, 180));
  } catch (_) {}
}

const api = {
  SYNC_WARN_TEXT,
  parseProfileValue,
  encodeProfileValue,
  runOptions,
  humaniseWarning,
  blockerWarnings,
  isBlockerWarning,
  logSyncFailure,
};

if (typeof module === "object" && module.exports) {
  module.exports = api;
}
const root = typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null;
if (root) root.lyknChromeSyncContract = api;
