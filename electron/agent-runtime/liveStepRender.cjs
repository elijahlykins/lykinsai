"use strict";

/**
 * The line or two under the step pill.
 *
 * Each step keeps its own note in the stack, so the explanation has to stay
 * readable at a glance. A repeated step accumulates commentary from each
 * attempt, and a model occasionally writes a paragraph, so keep the two most
 * recent sentences and drop the rest.
 */
function trimStepNote(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  // Two sentences is the budget \u2014 that is what "a line or two" means in a
  // narrow rail. A step retried several times accumulates a sentence per
  // attempt, and eight short ones are as unreadable as one long one, so the
  // count matters more than the character total.
  const sentences = (text.match(/[^.!?]+[.!?]*/g) || [text]).map((s) => s.trim()).filter(Boolean);
  const kept = sentences.length > 2 ? sentences.slice(-2).join(" ") : text;
  if (kept.length <= 220) return kept;
  return `${kept.slice(0, 220).replace(/\s+\S*$/, "")}\u2026`;
}

/**
 * One step pill plus the agent's line or two about it.
 *
 * The index is load-bearing: it is the click target for that step's
 * deliverable, so later steps stacking underneath must not renumber it.
 */
function renderOneLiveStep(agentId, step, index, { sanitizeLabel, sanitizeDetail } = {}) {
  const label0 = (v) => (sanitizeLabel ? sanitizeLabel(v) : String(v || "").trim());
  const detail0 = (v) => (sanitizeDetail ? sanitizeDetail(v) : String(v || "").trim());
  const status = String(step?.status || "done");
  const kind = String(step?.kind || "browse").replace(/[^a-z0-9_-]/gi, "") || "browse";
  const label = label0(step?.label) || `Step ${index + 1}`;
  const suffix = status === "done" ? "" : `/${status}`;
  // Two layers, deliberately. The title carries the mechanical detail —
  // reason, expectation, evidence — which stays folded away in the step's
  // dropdown. `note` is the agent talking to the user, and it renders as
  // ordinary prose under the pill.
  const detail = detail0(step?.detail);
  const title = detail ? ` "${detail}"` : "";
  const blocks = [`![lykn_step:${kind}:${label}](lykn-agent-step://${agentId}/${index}${suffix}${title})`];
  const note = trimStepNote(step?.note);
  if (note) blocks.push(note);
  return blocks.join("\n\n");
}

/**
 * What the user watches while the agent works: every step so far, each with
 * the agent's own line or two about it, newest underneath.
 *
 * A finished run keeps the stack — the closing summary is appended after it
 * (see emitStepTranscript / paintBrowseDone). `allDone` is accepted for
 * callers that still pass it; hiding the work log on finish is what made
 * a long run look like it had only ever done the last thing.
 */
function renderLiveStep(agentId, liveSteps, { allDone: _allDone = false, sanitizeLabel, sanitizeDetail } = {}) {
  const steps = Array.isArray(liveSteps) ? liveSteps : [];
  if (!steps.length) return "";
  return steps
    .map((step, index) => renderOneLiveStep(agentId, step, index, { sanitizeLabel, sanitizeDetail }))
    .filter(Boolean)
    .join("\n\n");
}

module.exports = { trimStepNote, renderOneLiveStep, renderLiveStep };
