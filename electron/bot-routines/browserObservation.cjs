"use strict";

/**
 * Cheap, model-free browser observation for Bot Routine monitors.
 *
 * AXI-inspired pieces reused from electron/browser-agent/browser/snapshot.cjs:
 *   - generation-scoped refs stay ephemeral (never a durable Routine target)
 *   - uid / loc (role+name, css id, href) survive a re-observation
 *   - compact semantic element state (role, label, disabled, value, checked)
 *
 * Every monitor tick:
 *   resolve the durable target → mint a fresh generation/ref → observe
 *
 * A stored `g42:17` is refused. That ref dies with its generation.
 */

const crypto = require("node:crypto");

const GENERATION_REF_RE = /^g\d+:/;
const LOGIN_URL_RE =
  /\/(login|log-in|signin|sign-in|sign_in|auth|sso|oauth)\b|accounts\.google\.|okta\.com|auth0\.com|login\.microsoftonline/i;
const LOGIN_TITLE_RE = /\b(sign in|log in|sign-in|log-in|authenticate)\b/i;

const TARGET_KINDS = Object.freeze(["page", "text", "role", "url", "title", "locator"]);
const BROWSER_EVENTS = Object.freeze([
  "changed",
  "equals",
  "contains",
  "enabled",
  "disabled",
  "appears",
  "disappears",
  "text_changed",
]);

function isEphemeralRef(value) {
  return GENERATION_REF_RE.test(String(value || "").trim());
}

function originOf(url) {
  try {
    return new URL(String(url || "").trim()).origin;
  } catch {
    return "";
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    u.hash = "";
    if (u.pathname === "/") u.pathname = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return String(url || "").trim().replace(/\/$/, "");
  }
}

function hostPath(url) {
  try {
    const u = new URL(String(url || "").trim());
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return String(url || "").trim();
  }
}

function normText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normKey(s) {
  return normText(s).toLowerCase();
}

/**
 * Does the live page still count as the page this Routine bound?
 *
 * Exact URL first, then origin+path, then origin when the trigger only stored
 * an origin. A different origin is NEVER the same target.
 */
function urlsMatch(observedUrl, targetUrl, targetOrigin) {
  const live = normalizeUrl(observedUrl);
  const wanted = normalizeUrl(targetUrl);
  const wantedOrigin = String(targetOrigin || originOf(wanted) || "").trim();
  if (!live) return false;
  if (wanted && live === wanted) return true;
  if (wanted && hostPath(live) === hostPath(wanted)) return true;
  if (wantedOrigin && originOf(live) === wantedOrigin) {
    // Origin-only bind: any path on that origin is the same site. A full URL
    // bind is stricter — navigating to a different path on the same origin
    // is "navigated away" unless the stored URL was origin-only (no path).
    if (!wanted) return true;
    try {
      const path = new URL(wanted).pathname;
      if (!path || path === "/") return true;
    } catch {
      return true;
    }
  }
  return false;
}

function looksLoggedOut(url, title, targetOrigin) {
  const liveOrigin = originOf(url);
  const expected = String(targetOrigin || "").trim();
  if (expected && liveOrigin && liveOrigin !== expected && LOGIN_URL_RE.test(String(url || ""))) {
    return true;
  }
  if (LOGIN_URL_RE.test(String(url || "")) && expected && liveOrigin !== expected) return true;
  if (LOGIN_TITLE_RE.test(String(title || "")) && expected && liveOrigin !== expected) return true;
  return false;
}

function titleMatches(title, pattern) {
  const pat = String(pattern || "").trim();
  if (!pat) return true;
  try {
    return new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(String(title || ""));
  } catch {
    return String(title || "").toLowerCase().includes(pat.toLowerCase());
  }
}

/** Drop generation-scoped refs. They are not a durable target. */
function sanitizeDurableTarget(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const kind = TARGET_KINDS.includes(String(input.kind || "").trim())
    ? String(input.kind).trim()
    : input.loc || input.role || input.name || input.text
      ? input.loc
        ? "locator"
        : input.role
          ? "role"
          : "text"
      : "page";
  const loc = String(input.loc || "").trim().slice(0, 160);
  if (isEphemeralRef(loc) || isEphemeralRef(input.ref) || isEphemeralRef(input.selector)) {
    throw new TypeError("Browser targets cannot store generation-scoped element refs");
  }
  const role = String(input.role || "").trim().slice(0, 40);
  const name = String(input.name || "").trim().slice(0, 120);
  const text = String(input.text || "").trim().slice(0, 120);
  const selector = String(input.selector || "").trim().slice(0, 160);
  if (isEphemeralRef(selector)) {
    throw new TypeError("Browser targets cannot store generation-scoped element refs");
  }
  const out = { kind };
  if (loc) out.loc = loc;
  else if (role && name) out.loc = `role:${role}|${name}`;
  if (role) out.role = role;
  if (name) out.name = name;
  if (text) out.text = text;
  if (selector && !selector.startsWith("g")) out.selector = selector;
  return out;
}

function matchElement(el, target) {
  if (!el || !target) return false;
  if (target.loc && el.loc === target.loc) return true;
  if (target.selector && String(el.raw?.selector || "") === target.selector) return true;
  if (target.role && target.name) {
    if (normKey(el.role) === normKey(target.role) && normKey(el.label) === normKey(target.name)) {
      return true;
    }
  }
  if (target.text) {
    const needle = normKey(target.text);
    if (needle && (normKey(el.label) === needle || normKey(el.value) === needle)) return true;
  }
  return false;
}

/**
 * Resolve a durable target against the CURRENT generation's snapshot.
 * Returns the live element (with a fresh gN:M ref) or null. The ref is for
 * this tick only — callers must not persist it.
 */
function resolveDurableTarget(snapshot, target) {
  const spec = target && typeof target === "object" ? target : {};
  if (spec.kind === "page" || spec.kind === "url" || spec.kind === "title") return null;
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  if (spec.loc) {
    const byLoc = elements.find((el) => el.loc === spec.loc);
    if (byLoc) return byLoc;
  }
  for (const el of elements) {
    if (matchElement(el, spec)) return el;
  }
  // Visible text target with no matching control: still a valid observation
  // when the condition is about page text, not a widget.
  return null;
}

function targetState(el, snapshot, spec) {
  if (el) {
    return {
      found: true,
      loc: el.loc || "",
      role: el.role || "",
      name: String(el.label || "").slice(0, 120),
      text: String(el.value || el.label || "").slice(0, 120),
      disabled: el.disabled === true,
      checked: el.checked === true,
      expanded: el.expanded,
      // Live ref for this generation only. Never persist.
      ref: el.ref || "",
      uid: el.uid || "",
    };
  }
  const visible = normText(snapshot?.visibleText || "").slice(0, 400);
  if (spec?.text && visible) {
    const found = normKey(visible).includes(normKey(spec.text));
    return {
      found,
      loc: "",
      role: "text",
      name: "",
      text: found ? spec.text : "",
      disabled: false,
      checked: false,
      expanded: null,
      ref: "",
      uid: "",
    };
  }
  return {
    found: false,
    loc: spec?.loc || "",
    role: spec?.role || "",
    name: spec?.name || "",
    text: "",
    disabled: false,
    checked: false,
    expanded: null,
    ref: "",
    uid: "",
  };
}

/**
 * Compact fingerprint of the RELEVANT state. Targeted monitors hash the
 * resolved control, not the whole document.
 */
function fingerprintObservation({ url, title, target, visibleTextHash } = {}) {
  const parts = [
    normalizeUrl(url),
    normText(title).slice(0, 80),
    target?.loc || "",
    target?.role || "",
    target?.name || "",
    target?.text || "",
    target?.found === true ? "1" : "0",
    target?.disabled === true ? "1" : "0",
    target?.checked === true ? "1" : "0",
    String(target?.expanded ?? ""),
    visibleTextHash || "",
  ];
  return crypto.createHash("sha1").update(parts.join("\t")).digest("hex");
}

function hashVisibleText(text) {
  const sliced = normText(text).slice(0, 2000);
  if (!sliced) return "";
  return crypto.createHash("sha1").update(sliced).digest("hex").slice(0, 16);
}

/**
 * Compact observation from a structured snapshot. No model call. No raw
 * catalog. Generation/ref are returned for this tick and must not be stored
 * as the Routine target.
 */
function compactObservation(snapshot, query = {}) {
  const spec = query.target && typeof query.target === "object" ? query.target : query;
  const el = resolveDurableTarget(snapshot, spec);
  const target = targetState(el, snapshot, spec);
  const wholePage = !spec || spec.kind === "page" || spec.kind === "url" || spec.kind === "title";
  const visibleTextHash = wholePage || spec.kind === "text" ? hashVisibleText(snapshot?.visibleText) : "";
  const url = String(snapshot?.url || "");
  const title = String(snapshot?.title || "");
  return {
    ok: true,
    status: "ok",
    url,
    origin: originOf(url),
    title,
    target,
    fingerprint: fingerprintObservation({ url, title, target, visibleTextHash }),
    generation: Number(snapshot?.generation) || 0,
    // Ephemeral. Callers may use it this tick; they must not persist it.
    ref: target.ref,
  };
}

function valueOf(obs) {
  const t = obs?.target;
  if (!t) return "";
  if (t.disabled === true) return `${t.text || t.name || ""} (disabled)`;
  if (t.found && t.text) return t.text;
  if (t.found && t.name) return t.name;
  return "";
}

/**
 * Deterministic condition check. Returns:
 *   { decidable: true, matched: bool, summary }
 *   { decidable: false }  when the condition needs semantic interpretation
 */
function evaluateBrowserCondition({ previous, current, condition } = {}) {
  const event = String(condition?.event || "changed").trim();
  const expected = String(condition?.value || "").trim();
  const prevVal = previous?.target ? valueOf(previous) : previous?.value;
  const curVal = current?.target ? valueOf(current) : current?.value;
  const prevFound = previous?.target?.found;
  const curFound = current?.target?.found;

  if (event === "equals") {
    const matched = expected ? normKey(curVal) === normKey(expected) : !!curVal;
    const was = previous ? (expected ? normKey(prevVal) === normKey(expected) : !!prevVal) : false;
    return {
      decidable: true,
      matched: matched && !was,
      summary: matched
        ? `${curVal || "value"} matches "${expected}"`
        : `${curVal || "(empty)"} is not "${expected}"`,
      from: prevVal || "",
      to: curVal || "",
    };
  }
  if (event === "contains") {
    const needle = normKey(expected || condition?.text || "");
    const matched = needle ? normKey(curVal).includes(needle) || normKey(current?.title).includes(needle) : false;
    const was = previous
      ? needle && (normKey(prevVal).includes(needle) || normKey(previous?.title).includes(needle))
      : false;
    return {
      decidable: true,
      matched: matched && !was,
      summary: matched ? `Now contains "${expected}"` : `Does not contain "${expected}"`,
      from: prevVal || "",
      to: curVal || "",
    };
  }
  if (event === "enabled") {
    const nowOn = current?.target?.found === true && current.target.disabled !== true;
    const wasOff = previous?.target?.found === true && previous.target.disabled === true;
    return {
      decidable: true,
      matched: nowOn && wasOff,
      summary: nowOn ? `${current.target.name || "control"} is enabled` : "Still disabled",
      from: wasOff ? "disabled" : previous?.target?.found ? "enabled" : "absent",
      to: nowOn ? "enabled" : "disabled",
    };
  }
  if (event === "disabled") {
    const nowOff = current?.target?.found === true && current.target.disabled === true;
    const wasOff = previous?.target?.disabled === true;
    return {
      decidable: true,
      matched: nowOff && previous && !wasOff,
      summary: nowOff ? `${current.target.name || "control"} is disabled` : "Not disabled",
      from: wasOff ? "disabled" : "enabled",
      to: nowOff ? "disabled" : "enabled",
    };
  }
  if (event === "appears") {
    return {
      decidable: true,
      matched: curFound === true && prevFound === false,
      summary: curFound ? `${curVal || "target"} appeared` : "Target not present",
      from: prevFound ? "present" : "absent",
      to: curFound ? "present" : "absent",
    };
  }
  if (event === "disappears") {
    return {
      decidable: true,
      matched: curFound === false && prevFound === true,
      summary: !curFound ? `${prevVal || "target"} disappeared` : "Target still present",
      from: prevFound ? "present" : "absent",
      to: curFound ? "present" : "absent",
    };
  }
  // changed / text_changed
  const changed =
    (previous?.fingerprint && current?.fingerprint && previous.fingerprint !== current.fingerprint) ||
    (prevVal !== undefined && curVal !== prevVal);
  if (condition?.semantic === true && changed) {
    return { decidable: false, changed: true, from: prevVal || "", to: curVal || "" };
  }
  return {
    decidable: true,
    matched: !!changed,
    summary: changed
      ? `${prevVal || previous?.title || "state"} → ${curVal || current?.title || "changed"}`
      : "Unchanged",
    from: prevVal || "",
    to: curVal || "",
  };
}

function describeBrowserTarget(trigger) {
  const url = String(trigger?.url || trigger?.origin || "").trim();
  const host = hostPath(url) || originOf(url) || url || "a page";
  const app = String(trigger?.appName || "Browser");
  return `${app} · ${host}`;
}

function describeBrowserCondition(trigger) {
  const event = String(trigger?.condition?.event || trigger?.event || "changed");
  const value = String(trigger?.condition?.value || "").trim();
  const name = String(trigger?.target?.name || trigger?.target?.text || "").trim();
  if (event === "enabled") return name ? `"${name}" becomes enabled` : "A control becomes enabled";
  if (event === "disabled") return name ? `"${name}" becomes disabled` : "A control becomes disabled";
  if (event === "equals" && value) return `${name || "Status"} becomes ${value}`;
  if (event === "contains" && value) return `Appears: ${value}`;
  if (event === "appears") return `${name || "Target"} appears`;
  if (event === "disappears") return `${name || "Target"} disappears`;
  if (value) return `Changes to ${value}`;
  return name ? `${name} changes` : "Page changes";
}

module.exports = {
  TARGET_KINDS,
  BROWSER_EVENTS,
  GENERATION_REF_RE,
  isEphemeralRef,
  originOf,
  normalizeUrl,
  hostPath,
  urlsMatch,
  looksLoggedOut,
  titleMatches,
  sanitizeDurableTarget,
  resolveDurableTarget,
  compactObservation,
  fingerprintObservation,
  hashVisibleText,
  evaluateBrowserCondition,
  describeBrowserTarget,
  describeBrowserCondition,
  valueOf,
};
