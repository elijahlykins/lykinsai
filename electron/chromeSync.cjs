/**
 * Chrome / Chromium session + tab sync (macOS).
 *
 * Polar-style "bring your browser with you": pull the user's existing logins
 * (cookies) and currently-open tabs out of their everyday Chromium browser and
 * into LYKN's agent browser, so the AI lands already signed in and looking at
 * what the user was looking at.
 *
 * Everything here is strictly opt-in and local:
 *   • Cookies are read from the browser's own SQLite DB (a temp copy — the live
 *     file is often locked) and decrypted with the "… Safe Storage" key from the
 *     login Keychain. Reading that key triggers the standard macOS Keychain
 *     permission prompt, which is the user's explicit consent.
 *   • Open tabs are read via AppleScript, which triggers the macOS Automation
 *     permission prompt the first time.
 *
 * macOS Chromium v10/v11 cookie scheme (see Chromium os_crypt_mac.mm):
 *   key = PBKDF2-HMAC-SHA1(keychainPassword, "saltysalt", 1003, 16)
 *   value = AES-128-CBC(key, iv = 16×0x20) of the "v10"-prefixed blob
 *   Chrome ≥ M122 (Cookies DB version ≥ 24) prepends a 32-byte SHA-256 domain
 *   integrity hash to the plaintext that must be stripped.
 *
 * Non-macOS platforms return empty results (Windows v20 App-Bound Encryption
 * can't be decrypted out-of-process; Linux isn't a target here).
 */
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const execFileAsync = promisify(execFile);
const IS_MAC = process.platform === "darwin";

/** Supported Chromium browsers and where their profile data / Keychain key live. */
const SUPPORTED_BROWSERS = [
  {
    id: "chrome",
    name: "Google Chrome",
    dir: "Google/Chrome",
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
    appName: "Google Chrome",
  },
  {
    id: "brave",
    name: "Brave",
    dir: "BraveSoftware/Brave-Browser",
    keychainService: "Brave Safe Storage",
    keychainAccount: "Brave",
    appName: "Brave Browser",
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    dir: "Microsoft Edge",
    keychainService: "Microsoft Edge Safe Storage",
    keychainAccount: "Microsoft Edge",
    appName: "Microsoft Edge",
  },
];

function appSupportRoot() {
  return path.join(os.homedir(), "Library", "Application Support");
}

function browserRoot(browser) {
  return path.join(appSupportRoot(), browser.dir);
}

/** Browsers actually installed (their profile directory exists). */
function detectBrowsers() {
  if (!IS_MAC) return [];
  return SUPPORTED_BROWSERS.filter((b) => {
    try {
      return fs.existsSync(browserRoot(b));
    } catch {
      return false;
    }
  });
}

/** Profiles inside a browser root, resolved to human names via Local State. */
function listProfiles(browser) {
  const root = browserRoot(browser);
  let nameByDir = {};
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(root, "Local State"), "utf8"));
    const cache = localState?.profile?.info_cache || {};
    for (const [dir, info] of Object.entries(cache)) {
      nameByDir[dir] = info?.name || dir;
    }
  } catch {
    /* fall back to directory scan */
  }
  const profiles = [];
  const seen = new Set();
  const consider = (dir) => {
    if (seen.has(dir)) return;
    const cookiesPath = path.join(root, dir, "Cookies");
    if (!fs.existsSync(cookiesPath)) return;
    seen.add(dir);
    profiles.push({ dir, name: nameByDir[dir] || dir, cookiesPath });
  };
  // Prefer the order Local State lists them (Default first, then Profile N).
  for (const dir of Object.keys(nameByDir)) consider(dir);
  consider("Default");
  try {
    for (const entry of fs.readdirSync(root)) {
      if (/^Profile \d+$/.test(entry)) consider(entry);
    }
  } catch {
    /* root not readable */
  }
  return profiles;
}

/** Read the "… Safe Storage" Keychain password (prompts the user on first use).
 *  Async so the Electron main event loop isn't blocked while the user decides
 *  on the Keychain prompt. */
async function getSafeStoragePassword(browser) {
  const args = ["find-generic-password", "-w", "-s", browser.keychainService];
  if (browser.keychainAccount) args.push("-a", browser.keychainAccount);
  const { stdout } = await execFileAsync("/usr/bin/security", args, {
    encoding: "utf8",
    timeout: 120000, // user may sit on the Keychain prompt
  });
  return String(stdout).replace(/\n$/, "");
}

function deriveKey(password) {
  return crypto.pbkdf2Sync(Buffer.from(password, "utf8"), "saltysalt", 1003, 16, "sha1");
}

function hasNonPrintable(buf) {
  for (const byte of buf) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) return true;
  }
  return false;
}

/** Decrypt one v10/v11 macOS cookie value; returns "" if not decryptable. */
function decryptCookieValue(encryptedHex, key, dbVersion) {
  if (!encryptedHex) return "";
  const buf = Buffer.from(encryptedHex, "hex");
  if (buf.length <= 3) return buf.toString("utf8");
  const prefix = buf.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") {
    // Unencrypted legacy value (rare on macOS) or unsupported scheme.
    return /^v\d\d$/.test(prefix) ? "" : buf.toString("utf8");
  }
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    decipher.setAutoPadding(true);
    let plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
    // M122+ (DB v≥24) prepend a 32-byte SHA-256 integrity hash. Strip it when
    // the version says so, or when the first 32 bytes look binary (heuristic
    // for mixed DBs).
    const stripPrefix =
      plain.length > 32 && (dbVersion >= 24 || hasNonPrintable(plain.subarray(0, 32)));
    if (stripPrefix) plain = plain.subarray(32);
    return plain.toString("utf8");
  } catch {
    return "";
  }
}

/** sqlite3 CLI → JSON rows, reading a locked DB via an immutable temp copy. */
async function readCookieRows(cookiesPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-cksync-"));
  const tmpDb = path.join(tmpDir, "Cookies");
  try {
    fs.copyFileSync(cookiesPath, tmpDb);
    for (const suffix of ["-wal", "-shm"]) {
      const side = cookiesPath + suffix;
      if (fs.existsSync(side)) {
        try {
          fs.copyFileSync(side, tmpDb + suffix);
        } catch {
          /* side files are best-effort */
        }
      }
    }
    let dbVersion = 0;
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/sqlite3",
        [tmpDb, "SELECT value FROM meta WHERE key='version';"],
        { encoding: "utf8" },
      );
      dbVersion = parseInt(String(stdout).trim(), 10) || 0;
    } catch {
      /* version optional */
    }
    const { stdout: json } = await execFileAsync(
      "/usr/bin/sqlite3",
      [
        "-json",
        tmpDb,
        "SELECT host_key, name, path, is_secure, is_httponly, expires_utc, samesite, value AS plain, hex(encrypted_value) AS ev FROM cookies;",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const rows = String(json).trim() ? JSON.parse(json) : [];
    return { rows, dbVersion };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* temp cleanup best-effort */
    }
  }
}

function chromeSameSiteToElectron(v) {
  switch (Number(v)) {
    case 0:
      return "no_restriction";
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
}

/** Chrome expires_utc (µs since 1601-01-01) → unix seconds, or null if session. */
function chromeTimeToUnix(expiresUtc) {
  const n = Number(expiresUtc);
  if (!n) return null;
  const unix = n / 1e6 - 11644473600;
  return unix > 0 ? Math.floor(unix) : null;
}

/** Rough registrable domain (eTLD+1-ish) for grouping cookies into families. */
function cookieFamily(host) {
  const h = String(host || "").replace(/^\./, "").toLowerCase();
  const parts = h.split(".").filter(Boolean);
  if (parts.length <= 2) return h;
  // Handle common two-part public suffixes (co.uk, com.au, …).
  const twoPartTld = /^(?:co|com|net|org|gov|ac|edu)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
  return parts.slice(twoPartTld ? -3 : -2).join(".");
}

/**
 * Read + decrypt all cookies for a browser profile into Electron-ready shapes.
 * Returns { ok, cookies, dbVersion, corruptDomains, error }.
 * `corruptDomains` lists families where at least one encrypted cookie failed
 * to decrypt — importing a PARTIAL auth-cookie family (Google especially)
 * corrupts an otherwise-working login, so callers should skip those wholesale.
 */
async function readProfileCookies(browser, profile) {
  if (!IS_MAC) return { ok: false, cookies: [], error: "unsupported_platform" };
  let key;
  try {
    key = deriveKey(await getSafeStoragePassword(browser));
  } catch (e) {
    return { ok: false, cookies: [], error: `keychain_denied: ${e?.message || e}` };
  }
  let rows;
  let dbVersion;
  try {
    ({ rows, dbVersion } = await readCookieRows(profile.cookiesPath));
  } catch (e) {
    return { ok: false, cookies: [], error: `db_read_failed: ${e?.message || e}` };
  }
  const cookies = [];
  const corrupt = new Set();
  const nowSec = Date.now() / 1000;
  for (const r of rows) {
    const host = String(r.host_key || "");
    if (!host) continue;
    // Plaintext `value` column is the fallback for unencrypted rows.
    let value = decryptCookieValue(r.ev, key, dbVersion);
    if (!value && r.plain) value = String(r.plain);
    if (!value) {
      // Real encrypted payload that would not decrypt — mark the family.
      if (r.ev && String(r.ev).length > 8) corrupt.add(cookieFamily(host));
      continue;
    }
    const expirationDate = chromeTimeToUnix(r.expires_utc);
    // Never import stale cookies: overwriting a live cookie in the destination
    // session with an expired one silently kills that login.
    if (expirationDate && expirationDate <= nowSec) continue;
    const secure = !!r.is_secure;
    const cookiePath = r.path || "/";
    const bareHost = host.replace(/^\./, "");
    const url = `${secure ? "https" : "http"}://${bareHost}${cookiePath}`;
    const cookie = {
      url,
      name: r.name || "",
      value,
      path: cookiePath,
      secure,
      httpOnly: !!r.is_httponly,
      sameSite: chromeSameSiteToElectron(r.samesite),
    };
    // Host-prefixed domains (".example.com") are domain cookies; bare hosts are
    // host-only and must NOT carry a domain field.
    if (host.startsWith(".")) cookie.domain = host;
    if (expirationDate) cookie.expirationDate = expirationDate;
    cookies.push(cookie);
  }
  return { ok: true, cookies, dbVersion, corruptDomains: [...corrupt] };
}

/** Google's auth spans one cookie *family* — half-replacing it logs the user out. */
const GOOGLE_FAMILIES = ["google.com", "youtube.com"];
const GOOGLE_AUTH_COOKIES = /^(SID|HSID|SSID|__Secure-1PSID|__Secure-3PSID)$/;

/** True when the session already holds a live (unexpired) Google login. */
async function sessionHasLiveGoogleLogin(session) {
  try {
    const existing = await session.cookies.get({ domain: "google.com" });
    const now = Date.now() / 1000;
    return existing.some(
      (c) =>
        GOOGLE_AUTH_COOKIES.test(c.name) &&
        (!c.expirationDate || c.expirationDate > now),
    );
  } catch {
    return false;
  }
}

/**
 * Inject cookies into an Electron session; returns { imported, failed, skipped }.
 * - `skipDomains`: cookie families to leave completely untouched (e.g. families
 *   with partial decrypt failures — importing half an auth set breaks it).
 * - The Google family is auto-protected: if the destination session already
 *   has a live Google login, Chrome's Google cookies are NOT imported, so a
 *   working signed-in state is never clobbered.
 */
async function importCookiesToSession(session, cookies, { skipDomains = [] } = {}) {
  const skip = new Set(
    (Array.isArray(skipDomains) ? skipDomains : []).map((d) => String(d).toLowerCase()),
  );
  if (await sessionHasLiveGoogleLogin(session)) {
    for (const fam of GOOGLE_FAMILIES) skip.add(fam);
  }
  let imported = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of cookies) {
    let fam = "";
    try {
      fam = cookieFamily(c.domain || new URL(c.url).hostname);
    } catch {
      /* keep empty */
    }
    if (fam && skip.has(fam)) {
      skipped += 1;
      continue;
    }
    try {
      await session.cookies.set(c);
      imported += 1;
    } catch {
      // Electron rejects some edge cases (e.g. __Host- prefix with a domain);
      // retry once as a host-only cookie before giving up.
      if (c.domain) {
        try {
          const { domain, ...hostOnly } = c;
          await session.cookies.set(hostOnly);
          imported += 1;
          continue;
        } catch {
          /* fall through to failed */
        }
      }
      failed += 1;
    }
  }
  return { imported, failed, skipped };
}

/**
 * Most-visited sites from a profile's History DB (unencrypted SQLite).
 * Returns { ok, items:[{url,title,visits}], domains:[{domain,visits,sites}] }.
 */
async function readHistory(browser, profile, { limit = 40 } = {}) {
  if (!IS_MAC) return { ok: false, items: [], domains: [], error: "unsupported_platform" };
  const historyPath = path.join(path.dirname(profile.cookiesPath), "History");
  if (!fs.existsSync(historyPath)) return { ok: false, items: [], domains: [], error: "no_history" };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-hist-"));
  const tmpDb = path.join(tmpDir, "History");
  try {
    fs.copyFileSync(historyPath, tmpDb);
    for (const suffix of ["-wal", "-shm"]) {
      const side = historyPath + suffix;
      if (fs.existsSync(side)) {
        try {
          fs.copyFileSync(side, tmpDb + suffix);
        } catch {
          /* best effort */
        }
      }
    }
    const { stdout } = await execFileAsync(
      "/usr/bin/sqlite3",
      [
        "-json",
        tmpDb,
        `SELECT url, title, visit_count AS visits FROM urls WHERE hidden = 0 AND visit_count > 0 ORDER BY visit_count DESC LIMIT ${Math.max(1, Math.min(200, limit))};`,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const rows = String(stdout).trim() ? JSON.parse(stdout) : [];
    const items = rows.map((r) => ({
      url: r.url || "",
      title: r.title || "",
      visits: Number(r.visits) || 0,
    }));
    // Roll up by domain so the report can describe habits, not raw URLs.
    const byDomain = new Map();
    for (const it of items) {
      let host = "";
      try {
        host = new URL(it.url).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      if (!host) continue;
      const d = byDomain.get(host) || { domain: host, visits: 0, sites: 0 };
      d.visits += it.visits;
      d.sites += 1;
      byDomain.set(host, d);
    }
    const domains = [...byDomain.values()].sort((a, b) => b.visits - a.visits);
    return { ok: true, items, domains };
  } catch (e) {
    return { ok: false, items: [], domains: [], error: `history_read_failed: ${e?.message || e}` };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Currently-open tab URLs from a running Chromium browser (AppleScript). */
async function getOpenTabs(browser) {
  if (!IS_MAC) return { ok: false, tabs: [], error: "unsupported_platform" };
  const script = [
    `tell application "${browser.appName}"`,
    "  set outText to \"\"",
    "  repeat with w in windows",
    "    repeat with t in tabs of w",
    '      set outText to outText & (URL of t) & "\\n"',
    "    end repeat",
    "  end repeat",
    "  return outText",
    "end tell",
  ];
  const args = [];
  for (const line of script) args.push("-e", line);
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", args, {
      encoding: "utf8",
      timeout: 120000, // user may sit on the Automation prompt
    });
    const tabs = String(stdout)
      .split("\n")
      .map((s) => s.trim())
      .filter((u) => /^https?:\/\//i.test(u));
    return { ok: true, tabs };
  } catch (e) {
    // -600 = app not running; -1743 = Automation permission not granted.
    const msg = String(e?.message || e);
    const denied = /-1743|not authori[sz]ed|Not allowed/i.test(msg);
    return { ok: false, tabs: [], error: denied ? "automation_denied" : `applescript_failed: ${msg}` };
  }
}

module.exports = {
  IS_MAC,
  SUPPORTED_BROWSERS,
  detectBrowsers,
  listProfiles,
  readProfileCookies,
  importCookiesToSession,
  getOpenTabs,
  readHistory,
};
