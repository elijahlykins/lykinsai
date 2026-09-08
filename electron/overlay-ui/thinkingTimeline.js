// Overlay thinking timeline: LYKN mark on top, tool/activity steps underneath.
// Voice and typed chat share this so tool calls animate in the same language.

import { GENERIC_BUILD_RE, GENERIC_THINK_RE, isRotationPhrase as defaultIsRotationPhrase } from "./statusRotation.js";
import {
  activityKindFromLine,
  collapseThinkingSteps,
  formatWorkingFor,
  trailFamilyKey,
} from "./thinkingActivity.js";

const GLYPH_INNER = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  read: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  research: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  build: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  write: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  files: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  video: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20"/><path d="M17 2v20"/><path d="M2 12h20"/><path d="M2 7h5"/><path d="M2 17h5"/><path d="M17 17h5"/><path d="M17 7h5"/>',
  connect: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  other: '<circle cx="12" cy="12" r="3"/>',
};

function glyphSvg(kind) {
  const inner = GLYPH_INNER[kind] || GLYPH_INNER.other;
  return (
    '<svg class="thinking-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    inner +
    "</svg>"
  );
}

export function thinkingMarkup(spinnerPath) {
  return (
    '<div class="thinking">' +
    '<div class="thinking-head">' +
    '<span class="thinking-mark">' +
    '<svg class="lykn-outline-spinner" width="24" height="24" viewBox="0 0 204.29 204.29" ' +
    'fill="none" role="img" aria-label="Loading">' +
    '<path d="' + spinnerPath + '" pathLength="1" fill="currentColor" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />' +
    "</svg>" +
    "</span>" +
    '<span class="thinking-text"></span>' +
    "</div>" +
    '<ul class="thinking-steps" hidden></ul>' +
    "</div>"
  );
}

export function isTrailWorthyStatus(text, rotationPhrase) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (typeof rotationPhrase === "function" && rotationPhrase(t)) return false;
  if (GENERIC_THINK_RE.test(t)) return false;
  if (GENERIC_BUILD_RE.test(t)) return false;
  return true;
}

export function createThinkingTimeline({ isRotationPhrase = defaultIsRotationPhrase, onPaint } = {}) {
  let trail = [];
  let live = "";
  let startedAt = 0;
  let timer = null;
  let lastRoot = null;
  let lastStepKey = "";

  function elapsedSeconds() {
    if (!startedAt) return 0;
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  }

  function snapshot() {
    return collapseThinkingSteps(trail, live);
  }

  function hasSteps() {
    return snapshot().length > 0;
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function ensureTimer() {
    if (timer) return;
    timer = setInterval(() => {
      if (!lastRoot || !hasSteps()) return;
      const headerEl = lastRoot.querySelector(".thinking.has-steps .thinking-text");
      if (headerEl) headerEl.textContent = formatWorkingFor(elapsedSeconds());
    }, 1000);
    if (typeof timer.unref === "function") timer.unref();
  }

  function reset() {
    trail = [];
    live = "";
    startedAt = 0;
    lastStepKey = "";
    stopTimer();
    lastRoot = null;
  }

  function ingest(text) {
    const t = String(text || "").trim();
    if (!isTrailWorthyStatus(t, isRotationPhrase)) return;
    if (live && trailFamilyKey(live) !== trailFamilyKey(t)) {
      trail = [...trail, live].slice(-8);
    }
    live = t;
    if (!startedAt) startedAt = Date.now();
    ensureTimer();
  }

  function paint(root) {
    if (!root) return;
    lastRoot = root;
    const thinking = root.querySelector(".thinking");
    if (!thinking) return;
    const headerEl = thinking.querySelector(".thinking-text");
    const stepsEl = thinking.querySelector(".thinking-steps");
    const steps = snapshot();
    if (!steps.length) {
      thinking.classList.remove("has-steps");
      lastStepKey = "";
      if (stepsEl) {
        stepsEl.hidden = true;
        stepsEl.innerHTML = "";
      }
      if (typeof onPaint === "function") onPaint({ steps: 0 });
      return;
    }
    thinking.classList.add("has-steps");
    if (headerEl) headerEl.textContent = formatWorkingFor(elapsedSeconds());
    if (stepsEl) {
      stepsEl.hidden = false;
      const stepKey = steps
        .map((step) => `${step.kind}:${step.live ? 1 : 0}:${step.label}`)
        .join("|");
      if (stepKey !== lastStepKey) {
        lastStepKey = stepKey;
        stepsEl.innerHTML = steps
          .map((step) => {
            const kind = step.kind || activityKindFromLine(step.label);
            const liveClass = step.live ? " is-live" : "";
            return (
              '<li class="thinking-step' + liveClass + '">' +
              '<span class="thinking-mark">' + glyphSvg(kind) + "</span>" +
              '<span class="thinking-step-label"></span>' +
              "</li>"
            );
          })
          .join("");
        [...stepsEl.querySelectorAll(".thinking-step-label")].forEach((el, i) => {
          el.textContent = steps[i].label;
        });
      }
    }
    if (typeof onPaint === "function") onPaint({ steps: steps.length });
  }

  return {
    ingest,
    paint,
    reset,
    hasSteps,
    snapshot,
    elapsedSeconds,
  };
}
