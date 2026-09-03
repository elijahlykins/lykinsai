"use strict";

/**
 * Glass overlay status/completion copy for agent turns.
 */
function createGlassStatus(host) {
  const agents = {
    get(id) {
      return host.agents.get(id);
    },
  };
  const openStageArtifact = (...a) => host.openStageArtifact?.(...a);
  const showBrowserWindow = (...a) => host.showBrowserWindow?.(...a);
  const shareableArtifactUrl = (...a) => host.shareableArtifactUrl(...a);
  const looksLikeSubstantialTextOutput = (...a) => host.looksLikeSubstantialTextOutput(...a);
  const sanitizeStepLabel = (...a) => host.sanitizeStepLabel(...a);
  /** Immediate "on it" acknowledgment for deliverable turns — shown in the
   *  response area before the work starts. Conversational skills return ""
   *  (their answer streams in directly, no ack needed). */
  function deliverableKickoffText(skill) {
    switch (skill) {
      case "research":
        return "On it. I'll research this and put a report together. It'll open in a subtab here when it's ready.";
      case "report-edit":
        return "On it. Updating the report now. The refreshed version will replace the open one.";
      case "build":
        return "On it. Building that for you now. It'll open in a subtab here when it's ready.";
      case "image":
        return "On it. Generating your image. It'll open in a subtab here in a moment.";
      case "tool-create":
      case "sheets-create":
        return "On it. Setting that up in the tool now.";
      case "sheets-fill":
        return "On it. Putting the research into Sheets now.";
      default:
        return "";
    }
  }

  /**
   * Headless (Bot) turns end in chat, not in a browser tab, so the reply must
   * BE the deliverable: images embed inline, artifacts link out, and text
   * lands in full — never "…is open in the browser".
   */
  function formatHeadlessCompletion(agent, skill, answer) {
    const text = String(answer || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (skill === "image" && agent.lastImage?.url) {
      const md = `![${agent.lastImage.title || "Generated image"}](${agent.lastImage.url})`;
      return text.includes(agent.lastImage.url) ? text : [text, md].filter(Boolean).join("\n\n");
    }
    if (skill === "build" && agent.lastArtifact?.code) {
      const url = shareableArtifactUrl(agent);
      const title = agent.lastArtifact.title || "the artifact";
      if (url && !text.includes(url)) {
        return [text, `Built **${title}**. [Open it here](${url}).`].filter(Boolean).join("\n\n");
      }
      return text || `Built **${title}**.`;
    }
    return text || "Done.";
  }

  function formatAgentGlassStatus({ skill, answer, agent, openedInBrowser, multi, stepCount }) {
    const name = agent?.title || "Agent";
    if (skill === "monitor") {
      return String(answer || "Monitoring started.").trim();
    }
    if (skill === "browse" || skill === "browse-summary") {
      const full = String(answer || "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 6000);
      return full || "Done.";
    }
    // The canned "…is open in the browser" lines only when that deliverable
    // actually exists on this agent. A skill label alone proves nothing — a
    // mis-resolved step once ended an email errand with "research report is
    // open in the browser" when no report existed anywhere. Without the
    // deliverable, fall through to the real answer at the bottom.
    if (skill === "build" && agent?.lastArtifact?.code) {
      const title = agent.lastArtifact.title || "artifact";
      return `Finished. **${title}** is open in the browser.`;
    }
    if (skill === "image" && agent?.lastImage?.url) {
      return `Finished. Image is open in the browser.`;
    }
    if ((skill === "research" || skill === "report-edit") && agent?.lastResearchReport) {
      return `Finished. Research report is open in the browser.`;
    }
    if (skill === "sheets-fill") {
      const short = String(answer || "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 420);
      return short || `Finished. Research report pasted into Google Sheets.`;
    }
    if (skill === "tool-create" || skill === "sheets-create") {
      const full = String(answer || "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 6000);
      return full || `Finished. Created in the requested tool.`;
    }
    if (multi && stepCount > 1) {
      return `Finished. ${stepCount} steps done. Outputs are in the browser.`;
    }
    if (openedInBrowser) {
      return `Finished. Output is open in the browser.`;
    }
    // Conversational answers render in full in the response area.
    const full = String(answer || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 6000);
    return full || `**${name}** finished.`;
  }

  function recordStepDeliverable(agent, { index, skill, label, summary }) {
    if (!Array.isArray(agent.stepDeliverables)) agent.stepDeliverables = [];
    const summaryText = String(summary || "").trim();
    const entry = {
      index,
      skill: skill || "general",
      label: String(label || "").slice(0, 160),
      summary: summaryText.slice(0, 4000),
      kind: "text",
      title: "",
      url: "",
      markdown: "",
      code: "",
    };
    if (skill === "research" || skill === "report-edit") {
      entry.kind = "report";
      entry.title = `${agent.title || "Research"} report`.slice(0, 48);
      entry.markdown = String(agent.lastResearchReport || summary || "").slice(0, 120000);
    } else if (skill === "general" && looksLikeSubstantialTextOutput(summary)) {
      entry.kind = "report";
      entry.title = `${agent.title || "Agent"} output`.slice(0, 48);
      entry.markdown = String(summary || "").slice(0, 120000);
    } else if (skill === "build" && agent.lastArtifact?.code) {
      entry.kind = "artifact";
      entry.title = String(agent.lastArtifact.title || "Presentation").slice(0, 48);
      entry.code = String(agent.lastArtifact.code || "").slice(0, 400000);
      entry.url = String(agent.lastArtifact.url || "");
    } else if (
      skill === "browse" ||
      skill === "browse-summary" ||
      skill === "tool-create" ||
      skill === "sheets-create" ||
      skill === "sheets-fill"
    ) {
      entry.kind = "browse";
      entry.title = String(label || "Browser").slice(0, 48);
      entry.url = String(agent.url || "").trim();
      // Keep the step summary openable even when there's no separate report tab.
      if (summaryText.length >= 40) {
        entry.markdown = summaryText.slice(0, 120000);
      }
    } else if (skill === "image" && agent.lastImage?.url) {
      entry.kind = "image";
      entry.title = String(agent.lastImage.title || "Image").slice(0, 48);
      entry.url = String(agent.lastImage.url || "");
    } else if (summaryText.length >= 40) {
      entry.kind = "report";
      entry.title = String(label || "Step").slice(0, 48);
      entry.markdown = summaryText.slice(0, 120000);
    }
    agent.stepDeliverables[index] = entry;
    return entry;
  }

  /** Clickable step boxes only — no progress prose, links, or summary. */
  function formatMultiStepGlassStatus(agent, steps, stepAnswers) {
    const total = steps.length;
    const done = stepAnswers.length;
    const lines = [];
    for (let i = 0; i < total; i += 1) {
      const ans = String(stepAnswers[i] || "").trim();
      const del = agent.stepDeliverables?.[i] || {};
      const kind =
        del.kind && del.kind !== "text"
          ? del.kind
          : ans
            ? "browse"
            : "text";
      const label = sanitizeStepLabel(steps[i] || del.label || `Step ${i + 1}`);
      const status = i < done ? "done" : i === done ? "live" : "pending";
      const suffix = status === "done" ? "" : `/${status}`;
      lines.push(`![lykn_step:${kind}:${label}](lykn-agent-step://${agent.id}/${i}${suffix})`);
    }
    return lines.join("\n\n");
  }

  /** Finished multi-step: same boxes, all completed steps done. */
  function formatMultiStepCompletion(agent, steps, stepAnswers) {
    const done = stepAnswers.length;
    const lines = [];
    for (let i = 0; i < steps.length; i += 1) {
      const ans = String(stepAnswers[i] || "").trim();
      const del = agent.stepDeliverables?.[i] || {};
      const kind =
        del.kind && del.kind !== "text"
          ? del.kind
          : ans
            ? "browse"
            : "text";
      const label = sanitizeStepLabel(steps[i] || del.label || `Step ${i + 1}`);
      const status = i < done ? "done" : "pending";
      const suffix = status === "done" ? "" : `/${status}`;
      lines.push(`![lykn_step:${kind}:${label}](lykn-agent-step://${agent.id}/${i}${suffix})`);
    }
    return lines.join("\n\n");
  }

  /** @deprecated alias — Glass no longer embeds full step bodies */
  function formatMultiStepAnswer(agent, steps, stepAnswers) {
    return formatMultiStepCompletion(agent, steps, stepAnswers);
  }

  function showStepDeliverable(agentId, stepIndex) {
    const agent = agents.get(agentId);
    if (!agent) return { ok: false, error: "not_found" };
    const del = agent.stepDeliverables?.[Number(stepIndex)];
    if (!del) return { ok: false, error: "no_step" };
    const id = agent.id;
    try {
      if (del.kind === "report" && del.markdown) {
        openStageArtifact?.({
          markdown: del.markdown,
          title: del.title || "Report",
          ownerAgentId: id,
          kind: "report",
          reuseAgentTab: true,
          show: true,
          focus: true,
          // A step click is the user asking to see it — front it regardless
          // of which tab family is visible.
          force: true,
        });
      } else if (del.kind === "artifact") {
        const artUrl = String(del.url || agent.lastArtifact?.url || "").trim();
        if (artUrl) {
          openStageArtifact?.({
            url: artUrl,
            title: del.title || "Artifact",
            ownerAgentId: id,
            kind: "artifact",
            reuseAgentTab: true,
            show: true,
            focus: true,
            // A step click is the user asking to see it — front it regardless
            // of which tab family is visible.
            force: true,
          });
        } else if (del.code || agent.lastArtifact?.code) {
          // Artifact is still on the agent tab — raise the stage even if URL wasn't cached.
          showBrowserWindow?.(id, { focus: true, label: del.title || "Artifact" });
        } else {
          return { ok: false, error: "no_artifact" };
        }
      } else if (del.kind === "browse") {
        // Prefer the step write-up when we have one; otherwise raise the live tab.
        if (del.markdown && String(del.markdown).trim().length >= 40) {
          openStageArtifact?.({
            markdown: del.markdown,
            title: del.title || del.label || `Step ${Number(stepIndex) + 1}`,
            ownerAgentId: id,
            kind: "report",
            reuseAgentTab: true,
            show: true,
            focus: true,
            // A step click is the user asking to see it — front it regardless
            // of which tab family is visible.
            force: true,
          });
        } else {
          showBrowserWindow?.(id, { focus: true, label: agent.title || "Agent" });
        }
      } else if (del.kind === "image" && del.url) {
        openStageArtifact?.({
          url: del.url,
          title: del.title || "Image",
          ownerAgentId: id,
          kind: "image",
          reuseAgentTab: true,
          show: true,
          focus: true,
          // A step click is the user asking to see it — front it regardless
          // of which tab family is visible.
          force: true,
        });
      } else {
        showBrowserWindow?.(id, { focus: true, label: agent.title || "Agent" });
      }
    } catch (e) {
      return { ok: false, error: e?.message || "show_failed" };
    }
    return { ok: true, kind: del.kind, index: Number(stepIndex) };
  }

  return {
    deliverableKickoffText,
    formatHeadlessCompletion,
    formatAgentGlassStatus,
    recordStepDeliverable,
    formatMultiStepGlassStatus,
    formatMultiStepCompletion,
    formatMultiStepAnswer,
    showStepDeliverable,
  };
}

module.exports = { createGlassStatus };
