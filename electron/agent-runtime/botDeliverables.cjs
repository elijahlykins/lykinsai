"use strict";

/**
 * Deliverable collection for Bot harness capability tools.
 *
 * A Bot's final chat message is the deliver answer the harness returns — a
 * short close, not the work itself. The work (a research report, a built
 * artifact, a generated image) must survive that replacement, so each
 * capability executor attaches a structured `deliverable` to its result.
 * The harness records verified deliverables on the task, TaskRuntime carries
 * them on the completion event, and the chat row renders one persistent
 * artifact card per deliverable next to the closing message.
 *
 * This module owns turning a capability result into that deliverable; the
 * harness owns when one is recorded (only after verification passes).
 */

const { assembleDocument } = require("../../lib/basicDocument.cjs");

// One deliverable rides IPC once and lives in renderer memory — bound it so
// a runaway build can't flood the event channel.
const HTML_MAX = 400_000;
const CODE_MAX = 400_000;

/** A research report, restyled as the standalone HTML document card. */
function reportDeliverable(markdown) {
  const doc = assembleDocument({ content: String(markdown || "") });
  if (!doc.ok) return null;
  return {
    kind: "html",
    title: doc.title,
    html: String(doc.html || "").slice(0, HTML_MAX),
    filename: doc.filename,
  };
}

/**
 * Wrap the report pipelines (research_report / edit_report): remember the
 * markdown on the agent — that is what lets a later build_artifact call turn
 * THIS report into the presentation instead of re-researching — and attach
 * the styled document as the card the user keeps.
 */
function reportExecutor(agent, run) {
  return async (input) => {
    const res = await run(input);
    if (res?.ok && res.output) {
      agent.lastResearchReport = res.output;
      agent.lastDeliverableKind = "report";
      const deliverable = reportDeliverable(res.output);
      if (deliverable) res.deliverable = deliverable;
    }
    return res;
  };
}

/**
 * Wrap the build pipeline: the stream host stores the built artifact on
 * `agent.lastArtifact` (onAgentDeliverable). A NEW artifact after this call
 * is this call's deliverable.
 */
function buildExecutor(agent, run) {
  return async (input) => {
    const before = agent.lastArtifact;
    const res = await run(input);
    const art = agent.lastArtifact;
    if (res?.ok && art && art !== before && (art.url || art.code)) {
      res.deliverable = {
        kind: "artifact",
        title: String(art.title || "Interactive artifact"),
        url: String(art.url || ""),
        code: String(art.code || "").slice(0, CODE_MAX),
      };
    }
    return res;
  };
}

/** Wrap image generation: `agent.lastImage` set during the call is the card. */
function imageExecutor(agent, run) {
  return async (input) => {
    const before = agent.lastImage;
    const res = await run(input);
    const img = agent.lastImage;
    if (res?.ok && img?.url && img !== before) {
      res.deliverable = {
        kind: "image",
        title: String(img.title || "Generated image"),
        url: String(img.url),
      };
    }
    return res;
  };
}

/** Attach the written document as a card to a write_document result. */
function documentDeliverable(result) {
  if (!result || result.ok === false || !result.html) return null;
  return {
    kind: "html",
    title: String(result.title || "Document"),
    html: String(result.html).slice(0, HTML_MAX),
    filename: String(result.filename || ""),
  };
}

module.exports = {
  reportExecutor,
  buildExecutor,
  imageExecutor,
  reportDeliverable,
  documentDeliverable,
};
