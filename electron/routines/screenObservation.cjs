"use strict";

/**
 * Cheap screen/window observation for Bot Routine monitors.
 *
 * Pixels are a fallback. Callers should try, in order:
 *   1. BrowserExecutor (if the target is a page)
 *   2. native window title / accessibility / app state
 *   3. process state
 *   4. filesystem state
 *   5. targeted window/region capture
 *
 * Change detection is a perceptual fingerprint (the same 32×32 quantized
 * grayscale used by liveWatch / browserAct.screenFingerprint) compared with
 * screenDiffRatio. Unchanged frames never reach a vision model.
 *
 * Privacy: captures live in memory for one tick. Fingerprints (a short list of
 * quantized luminance cells) may be persisted. Screenshots, OCR, and raw
 * screen contents must not be. Temporary captures are the caller's to drop
 * immediately after fingerprinting.
 */

const crypto = require("node:crypto");
const { screenDiffRatio } = require("../../lib/browserScreen.cjs");

/** Below this, treat as cursor / clock / anti-alias noise. */
const NOISE_THRESHOLD = 0.02;
/** At or above this, the frame is a meaningful visual difference. */
const MEANINGFUL_THRESHOLD = 0.04;

const SCREEN_EVENTS = Object.freeze(["changed", "appears"]);

const DONE_TITLE_RE = /\b(done|complete|completed|finished|ready|success|exported)\b/i;
const ERROR_TITLE_RE = /\b(error|failed|failure|failing|crash|couldn't|cannot)\b/i;

function normText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleMatches(title, pattern) {
  const pat = String(pattern || "").trim();
  if (!pat) return true;
  const live = String(title || "");
  if (live.toLowerCase().includes(pat.toLowerCase())) return true;
  try {
    return new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(live);
  } catch {
    return false;
  }
}

function appMatches(liveApp, wanted) {
  const a = normText(liveApp).toLowerCase();
  const b = normText(wanted).toLowerCase();
  if (!b) return true;
  if (!a) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Durable window identity. Transient window ids are hints, never the match.
 */
function windowIdentity(target = {}) {
  return {
    appName: String(target.appName || "").trim().slice(0, 80),
    titlePattern: String(target.titlePattern || "").trim().slice(0, 120),
    bundleId: String(target.bundleId || "").trim().slice(0, 120),
  };
}

function describeScreenTarget(trigger) {
  const app = String(trigger?.appName || "Window").trim() || "Window";
  const title = String(trigger?.titlePattern || "").trim();
  return title ? `${app} · ${title}` : app;
}

function describeScreenCondition(trigger) {
  const semantic = String(trigger?.condition?.semantic || trigger?.semanticPrompt || "").trim();
  if (semantic) return semantic;
  const event = String(trigger?.condition?.event || trigger?.event || "changed");
  return event === "appears" ? "Appears" : "Screen changes";
}

/**
 * Did native window state (title / running) already answer the condition?
 * Returns null when pixels are still required.
 */
function evaluateNativeWindowState({ previous, current, condition } = {}) {
  if (!current?.found) {
    if (previous?.found) {
      return {
        decidable: true,
        matched: false,
        status: "target_unavailable",
        summary: "Watched window is not open",
      };
    }
    return {
      decidable: true,
      matched: false,
      status: current?.appRunning === false ? "target_unavailable" : "waiting_for_target",
      summary: "Waiting for the watched window",
    };
  }
  const event = String(condition?.event || "changed").trim();
  const semantic = String(condition?.semantic || "").toLowerCase();
  const title = String(current.title || "");
  const prevTitle = String(previous?.title || "");

  const wantsDone = /\b(finish|finished|done|complete|export)\b/.test(semantic);
  const wantsError = /\b(error|fail|failed|abnormal)\b/.test(semantic);

  if (wantsDone && DONE_TITLE_RE.test(title) && !DONE_TITLE_RE.test(prevTitle)) {
    return {
      decidable: true,
      matched: true,
      summary: `Window title now reads "${title.slice(0, 80)}"`,
      from: prevTitle,
      to: title,
    };
  }
  if (wantsError && ERROR_TITLE_RE.test(title) && !ERROR_TITLE_RE.test(prevTitle)) {
    return {
      decidable: true,
      matched: true,
      summary: `Window title now reads "${title.slice(0, 80)}"`,
      from: prevTitle,
      to: title,
    };
  }
  if (event === "appears" && current.found && previous && !previous.found) {
    return {
      decidable: true,
      matched: true,
      summary: `${current.appName || "Window"} appeared`,
      from: "absent",
      to: title,
    };
  }
  if (previous?.title && title && title !== prevTitle && !condition?.semantic) {
    return {
      decidable: true,
      matched: event === "changed",
      summary: `Title: ${prevTitle.slice(0, 40)} → ${title.slice(0, 40)}`,
      from: prevTitle,
      to: title,
    };
  }
  return null;
}

/**
 * Compare two perceptual fingerprints. Unchanged / noisy frames are not
 * "changed" and must not escalate to vision.
 */
function evaluateScreenFingerprints(previousFp, currentFp, { threshold } = {}) {
  const noise = Number.isFinite(threshold) ? threshold : NOISE_THRESHOLD;
  const meaningful = Math.max(noise, MEANINGFUL_THRESHOLD);
  if (!currentFp) return { unchanged: true, ratio: 1, meaningful: false };
  if (!previousFp) return { unchanged: false, baseline: true, ratio: 1, meaningful: false };
  if (previousFp === currentFp) return { unchanged: true, ratio: 0, meaningful: false };
  const ratio = screenDiffRatio(previousFp, currentFp);
  if (ratio < noise) return { unchanged: true, ratio, meaningful: false };
  return { unchanged: false, ratio, meaningful: ratio >= meaningful };
}

function fingerprintCells(cells) {
  if (Array.isArray(cells) && cells.length) return cells.join(",");
  return String(cells || "");
}

/** Hash native titles so we can detect title change without storing the string. */
function fingerprintNative(current = {}) {
  const canonical = [
    current.found ? "1" : "0",
    String(current.appName || ""),
    String(current.title || ""),
    current.appRunning === false ? "0" : "1",
  ].join("\t");
  return crypto.createHash("sha1").update(canonical).digest("hex");
}

module.exports = {
  NOISE_THRESHOLD,
  MEANINGFUL_THRESHOLD,
  SCREEN_EVENTS,
  DONE_TITLE_RE,
  ERROR_TITLE_RE,
  titleMatches,
  appMatches,
  windowIdentity,
  describeScreenTarget,
  describeScreenCondition,
  evaluateNativeWindowState,
  evaluateScreenFingerprints,
  fingerprintCells,
  fingerprintNative,
};
