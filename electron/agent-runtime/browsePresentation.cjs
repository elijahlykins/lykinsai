"use strict";

const ownedBrowserAct = require("../ownedBrowserAct.cjs");
const { humanLabel, verbFor } = require("../../lib/browseWorkLog.cjs");
const { renderLiveStep } = require("./liveStepRender.cjs");

/**
 * Live step transcript and browse-result presentation for the agent host.
 * Routing still happens in agentRuntime; this module formats what the user sees.
 */
function createBrowsePresentation(host) {
  const sendToAgentChannels = (...a) => host.sendToAgentChannels(...a);
  const pauseForUserSignIn = (...a) => host.pauseForUserSignIn(...a);
  const needsLlmBrowseSummary = (...a) => host.needsLlmBrowseSummary(...a);
  function sanitizeStepLabel(raw) {
    return String(raw || "")
      .replace(/[\[\]]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 72);
  }

  /**
   * Reasoning arrives in pieces — why it acted, what it expected, what the page
   * did — and this is the seam the renderers break back into separate lines.
   */
  const STEP_DETAIL_SEP = " · ";

  function joinStepDetails(parts) {
    return (Array.isArray(parts) ? parts : [])
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(STEP_DETAIL_SEP);
  }

  /**
   * The reasoning behind a step, as it rides inside the step marker's markdown
   * title. Quotes would close the title early and parens would close the link,
   * so neither can survive; everything else is one flat line the renderers fold
   * into the step's dropdown.
   */
  function sanitizeStepDetail(raw) {
    return String(raw || "")
      .replace(/[\[\]"()]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 320);
  }

  /** Sentence-case a model fragment so a reason reads as prose in the dropdown. */
  function tidyStepDetail(raw) {
    const s = sanitizeStepDetail(raw);
    if (!s) return "";
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /**
   * A paragraph of narration, safe to sit between step markers. Anything the
   * transcript reads as structure is flattened out: a nested marker would be
   * parsed as another step, a horizontal rule would cut the transcript in half,
   * and a leading bullet or heading would end the previous block early.
   */
  function sanitizeStepNote(raw) {
    return String(raw || "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .split(/\r?\n/)
      .map((l) =>
        l
          .replace(/^\s*-{3,}\s*$/, "")
          .replace(/^\s*(?:[-*•]|\d+[.)]|#{1,6}|>)\s+/, ""),
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 600);
  }

  /**
   * The opening explanation: how the agent means to go about this, then the
   * plan it settled on. Bullets are newline-joined on purpose — a blank line
   * between them closes the list in both renderers and leaves orphan lines.
   */
  function buildBrowsePlanNote({ approach = "", plan = [] } = {}) {
    const blocks = [];
    const opening = sanitizeStepNote(approach);
    if (opening) blocks.push(opening);
    const steps = (Array.isArray(plan) ? plan : [])
      .map((s) => sanitizeStepNote(s))
      .filter(Boolean)
      .slice(0, 8);
    // One step is not a plan worth listing — it just repeats the goal.
    if (steps.length > 1) {
      blocks.push(["Here's how I'll work through it:", ...steps.map((s) => `- ${s}`)].join("\n"));
    }
    return blocks.join("\n\n");
  }

  function browseHistoryToStepLabels(history, { max = 8 } = {}) {
    const acts = (Array.isArray(history) ? history : []).filter((h) => h?.result?.ok);
    const labels = [];
    const seen = new Set();
    for (const entry of acts) {
      const verb = verbFor(entry?.action?.type);
      const label = humanLabel(entry);
      const line = label ? `${verb}: ${label}` : verb === "Opened" ? "Opened a page" : verb;
      const key = String(line || "").toLowerCase();
      if (!line || seen.has(key)) continue;
      seen.add(key);
      labels.push({
        label: sanitizeStepLabel(line),
        kind: "browse",
        status: "done",
        url: String(entry?.action?.url || entry?.url || ""),
      });
      if (labels.length >= max) break;
    }
    return labels;
  }

  function resetLiveOutputSteps(agent) {
    if (!agent) return;
    agent.liveOutputSteps = [];
  }

  function renderStepTranscript(agent, { allDone = false } = {}) {
    return renderLiveStep(agent?.id, agent?.liveOutputSteps, {
      allDone,
      sanitizeLabel: sanitizeStepLabel,
      sanitizeDetail: sanitizeStepDetail,
    });
  }

  function dropTransientOutputSteps(agent) {
    if (!Array.isArray(agent?.liveOutputSteps)) return;
    agent.liveOutputSteps = agent.liveOutputSteps.filter((s) => !s?.transient);
  }

  function syncBrowseActionDeliverables(agent) {
    const steps = Array.isArray(agent?.liveOutputSteps) ? agent.liveOutputSteps : [];
    if (!agent || !steps.length) return;
    if (!Array.isArray(agent.stepDeliverables)) agent.stepDeliverables = [];
    if (
      agent.stepDeliverables.some(
        (d) => d && (d.kind === "report" || d.kind === "artifact" || d.kind === "image"),
      )
    ) {
      return;
    }
    steps.forEach((s, i) => {
      const existing = agent.stepDeliverables[i];
      if (existing && existing.kind && existing.kind !== "browse" && existing.kind !== "text") {
        return;
      }
      agent.stepDeliverables[i] = {
        index: i,
        skill: "browse",
        label: sanitizeStepLabel(s.label),
        summary: sanitizeStepDetail(s.detail),
        kind: "browse",
        title: sanitizeStepLabel(s.label),
        url: String(s.url || agent.url || ""),
        markdown: "",
        code: "",
      };
    });
  }

  function emitStepTranscript(agent, { final = false, appendix = "" } = {}) {
    if (!agent) return "";
    if (final) dropTransientOutputSteps(agent);
    syncBrowseActionDeliverables(agent);
    const transcript = renderStepTranscript(agent, { allDone: final });
    // The closing summary (what was done + a next step) renders as ordinary
    // prose after the step boxes — the response area is where a finished
    // task's story belongs, not a subtab.
    const extra = String(appendix || "").trim();
    // A horizontal rule keeps the closing summary out of the last step's
    // note — the rail types notes, and without a seam the wrap-up would
    // be swallowed into the final explanation.
    const text = [transcript, extra].filter(Boolean).join("\n\n---\n\n");
    if (!text) return "";
    agent.partialText = text;
    sendToAgentChannels(agent.id, "lykn:agent-delta", { text, final });
    return text;
  }

  function setLiveOutputStep(
    agent,
    { label, kind = "browse", url = "", detail = "", note = "", transient = false } = {},
  ) {
    const title = sanitizeStepLabel(label);
    if (!agent || !title) return;
    if (!Array.isArray(agent.liveOutputSteps)) agent.liveOutputSteps = [];
    const steps = agent.liveOutputSteps;
    let last = steps[steps.length - 1];
    if (last && last.status === "live" && last.label.toLowerCase() === title.toLowerCase()) {
      if (url) last.url = url;
      if (detail) last.detail = sanitizeStepDetail(detail);
      if (note && !last.note) last.note = note;
      return;
    }
    // A newer thinking placeholder replaces the previous one. Otherwise each
    // decide-round stacks another "Thinking…" row above the live spinner.
    if (last && last.transient && transient) {
      last.label = title;
      if (url) last.url = url;
      if (detail) last.detail = sanitizeStepDetail(detail);
      if (note && !last.note) last.note = note;
      last.status = "live";
      return;
    }
    // A real step replaces the thinking placeholder it was decided behind
    // rather than following it — otherwise every round leaves a spent
    // "Thinking…" row above the thing it turned into.
    if (last && last.transient && !transient) {
      steps.pop();
      last = steps[steps.length - 1];
    }
    if (last && last.status === "live") last.status = "done";
    if (last && last.status === "done" && last.label.toLowerCase() === title.toLowerCase()) {
      // Same action again — one row, but it goes back to spinning. Leaving a
      // check on it while the agent repeats it means nothing on screen moves.
      if (!transient) last.status = "live";
      if (detail && !last.detail) last.detail = sanitizeStepDetail(detail);
      // A repeat has its own commentary, and it is usually the interesting one
      // ("that didn't take, so I'm trying it from the other menu").
      if (note) last.note = last.note ? `${last.note}\n\n${note}` : note;
      return;
    }
    steps.push({
      label: title,
      kind: kind || "browse",
      status: "live",
      url: url || agent.url || "",
      detail: sanitizeStepDetail(detail),
      note: String(note || ""),
      transient: !!transient,
    });
  }

  /**
   * Attach commentary to the step already on screen, without starting a new
   * one. The plan lands after the "looking at the task" step is already up, and
   * the user reads its explanation under that step rather than above it.
   */
  function setLiveOutputStepNote(agent, note) {
    const steps = Array.isArray(agent?.liveOutputSteps) ? agent.liveOutputSteps : [];
    const step = steps[steps.length - 1];
    const text = String(note || "").trim();
    if (!step || !text) return;
    if (step.note && step.note.includes(text)) return;
    step.note = step.note ? `${step.note}\n\n${text}` : text;
  }

  /**
   * Add to the reasoning of the step currently on screen. Used once the page has
   * answered back, so the finished step explains both why it acted and what
   * that actually did.
   */
  function appendLiveOutputStepDetail(agent, extra) {
    const steps = Array.isArray(agent?.liveOutputSteps) ? agent.liveOutputSteps : [];
    const step = steps[steps.length - 1];
    const addition = sanitizeStepDetail(extra);
    if (!step || step.transient || !addition) return;
    const have = sanitizeStepDetail(step.detail);
    if (have.toLowerCase().includes(addition.toLowerCase())) return;
    step.detail = sanitizeStepDetail(have ? `${have}${STEP_DETAIL_SEP}${addition}` : addition);
  }

  /** The page has confirmed the current step — stop spinning on it. */
  function completeLiveOutputStep(agent) {
    const steps = Array.isArray(agent?.liveOutputSteps) ? agent.liveOutputSteps : [];
    const step = steps[steps.length - 1];
    if (step && !step.transient && step.status === "live") step.status = "done";
  }

  function finalizeLiveOutputSteps(agent) {
    if (!Array.isArray(agent?.liveOutputSteps)) {
      if (agent) agent.liveOutputSteps = [];
      return;
    }
    dropTransientOutputSteps(agent);
    for (const s of agent.liveOutputSteps) s.status = "done";
  }

  function hydrateLiveOutputFromHistory(agent, history) {
    if (!agent) return;
    const fromHist = browseHistoryToStepLabels(history);
    if (!Array.isArray(agent.liveOutputSteps)) agent.liveOutputSteps = [];
    if (!agent.liveOutputSteps.length && fromHist.length) {
      agent.liveOutputSteps = fromHist;
      return;
    }
    finalizeLiveOutputSteps(agent);
  }

  function narrateBrowseProgress(
    agent,
    status,
    { url = "", history = null, detail = "", note = "", transient = false } = {},
  ) {
    const label = humanizeBrowseStatus(status) || String(status || "").trim();
    if (Array.isArray(history)) {
      const done = browseHistoryToStepLabels(history);
      agent.liveOutputSteps = done;
      if (label && !done.some((s) => s.label.toLowerCase() === label.toLowerCase())) {
        agent.liveOutputSteps.push({
          label: sanitizeStepLabel(label),
          kind: "browse",
          status: "live",
          url: url || agent.url || "",
          detail: sanitizeStepDetail(detail),
          note: String(note || ""),
          transient: !!transient,
        });
      }
    } else if (label) {
      setLiveOutputStep(agent, {
        label,
        kind: "browse",
        url: url || agent.url || "",
        detail,
        note,
        transient,
      });
    }
    return emitStepTranscript(agent);
  }

  /** User-facing status only — strip planner boilerplate. */
  function humanizeBrowseStatus(raw) {
    let s = String(raw || "").trim();
    if (!s) return "";
    if (
      /WORKING PLAN|rewrite after every|WHAT CHANGED|Final CHECK|DONE:\s*\(none|LATER:\s*\(mark each/i.test(
        s,
      )
    ) {
      const nowLine = (s.match(/\bNOW:\s*([^\n]+)/i) || [])[1] || "";
      const clean = nowLine
        .replace(/\(rewrite from[^)]*\)/gi, "")
        .replace(/CHECK:.*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
      if (clean && clean.length >= 8 && !/rewrite|WHAT CHANGED|one visible/i.test(clean)) {
        return clean.slice(0, 90);
      }
      return "Working on the page…";
    }
    // Drop leading "Step N:" noise when it's just planner echo.
    s = s.replace(/^Step\s+\d+:\s*/i, "").trim();
    if (/WORKING PLAN|DONE:|NOW:|LATER:/i.test(s)) return "Working on the page…";
    return s.slice(0, 100);
  }

  /**
   * One line naming the action that is about to run. Deliberately plain: the
   * step title is a chip in a narrow rail, so the model's reasoning — usually a
   * sentence or three — goes in the dropdown underneath rather than being
   * chopped off in the title, which is what it used to be.
   * Returns "" when the action type says nothing useful, so the caller can fall
   * back to the reason.
   */
  function describeBrowseAction(p) {
    const type = String(p?.action?.type || "");
    // click_coord has no element to name, so the model labels it in the action.
    const label = String(p?.targetLabel || p?.action?.label || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    const host = () => {
      try {
        return new URL(String(p?.action?.url || "")).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    };
    switch (type) {
      case "navigate":
      case "open_tab": {
        const h = host();
        return h ? `Opening ${h}` : "Opening a page";
      }
      case "click":
      case "tap":
      case "click_coord":
      case "tap_coord":
        return label ? `Clicking “${label}”` : "Clicking on the page";
      case "type":
      case "fill":
      case "write":
        return label ? `Typing into “${label}”` : "Filling in a field";
      case "paste_text":
        return "Pasting into the document";
      case "replace_text":
        return label ? `Editing “${label}”` : "Editing the text";
      case "select":
        return label ? `Choosing in “${label}”` : "Choosing an option";
      case "press_key":
        return p?.action?.key ? `Pressing ${String(p.action.key).slice(0, 20)}` : "Pressing a key";
      case "drag":
        return label ? `Dragging “${label}”` : "Dragging on the page";
      case "extract":
        return label ? `Reading “${label}”` : "Reading the page";
      case "scroll":
        return "Scrolling the page";
      case "screenshot":
        return "Looking at the page";
      case "wait":
        return "Waiting for the page";
      case "switch_tab":
        return "Switching tabs";
      case "go_back":
        return "Going back";
      case "go_forward":
        return "Going forward";
      default:
        return "";
    }
  }

  /**
   * Title of last resort, for action types describeBrowseAction has no phrasing
   * for. Takes the first clause of the model's reason rather than the first 64
   * characters, so the chip ends on a word instead of mid-sentence.
   */
  function clipBrowseReason(raw) {
    const s = String(raw || "").replace(/\s+/g, " ").trim();
    if (!s) return "Working on the page";
    const first = (s.split(/[.;]/)[0] || s).trim() || s;
    return first.length > 64 ? `${first.slice(0, 61)}…` : first;
  }

  /** Drop inline “Want me to…” blocks — follow-ups live above the chat bar. */
  function stripInlineWantMeSuggestions(text) {
    let t = String(text || "");
    if (!t.trim()) return t;
    t = t.replace(
      /\n*(?:#{1,3}\s*)?(?:\*{0,2})\s*Want me to[^\n]*\*{0,2}\s*\n+(?:(?:\s*[-*•]|\s*\d+[.)])\s+.+\n*)+/gi,
      "\n",
    );
    t = t.replace(/\n*(?:#{1,3}\s*)?(?:\*{0,2})\s*Want me to[^\n]*\*{0,2}\s*$/gim, "");
    t = t.replace(/\n+Want me to[^\n]*\?/gi, "");
    return t.replace(/\n{3,}/g, "\n\n").trim();
  }

  // The "## What I did / ## Link / ## Summary" report subtab that used to
  // open at the end of a browse run is gone: the completion summary is a
  // wrap-up, not a deliverable, and it now closes the response transcript
  // itself (see paintBrowseDone). Deliverable subtabs remain for the skills
  // whose OUTPUT is a document — research reports, builds, images.

  /** Label or prompt from a chip — chips are `{ label, prompt }`, not raw strings. */
  function suggestionText(tip) {
    if (tip == null) return "";
    if (typeof tip === "string") return tip.replace(/\s+/g, " ").trim();
    return String(tip.label || tip.prompt || "").replace(/\s+/g, " ").trim();
  }

  /** Short label for a follow-up chip (first-person ask, truncated). */
  function suggestionChipLabel(tip, maxLen = 56) {
    let t = suggestionText(tip);
    if (!t) return "";
    if (t.length > maxLen) {
      t = `${t.slice(0, Math.max(16, maxLen - 1)).replace(/\s+\S*$/, "")}…`;
    }
    return t;
  }

  /**
   * Concrete follow-ups for the finished turn — keyed off URL, goal, skill,
   * and answer so Studio can show custom chips instead of generic ones.
   */
  function suggestNextStepsForBrowse({
    goal = "",
    url = "",
    title = "",
    pageText = "",
    skill = "",
    answer = "",
  } = {}) {
    const u = String(url || "").toLowerCase();
    const g = String(goal || "").toLowerCase();
    const sk = String(skill || "").toLowerCase();
    const t = `${title}\n${pageText}`.toLowerCase();
    const a = String(answer || "").toLowerCase();
    const pageName = String(title || "").replace(/\s+/g, " ").trim().slice(0, 40);
    const tips = [];

    const pushUnique = (tip) => {
      const s = String(tip || "").replace(/\s+/g, " ").trim();
      if (!s) return;
      if (tips.some((x) => x.toLowerCase() === s.toLowerCase())) return;
      tips.push(s);
    };

    // Skill-specific next steps when we know the deliverable type.
    if (/^research/.test(sk) || /\bresearch report\b/.test(a)) {
      pushUnique("Turn this research into an interactive presentation");
      pushUnique("Dive deeper on the most important finding");
      pushUnique("Save the key points into a Google Doc");
    } else if (/^(build|tool-create|artifact)/.test(sk)) {
      pushUnique("Polish the design and interactions");
      pushUnique("Add another section or feature");
      pushUnique("Open this in a new Studio Build chat");
    } else if (/^image/.test(sk)) {
      pushUnique("Generate a variation with a different style");
      pushUnique("Make a matching set of images");
      pushUnique("Open the image and refine the prompt");
    } else if (/sheets/.test(sk) || /docs\.google\.com\/spreadsheets/.test(u)) {
      pushUnique("Add columns or clean the data");
      pushUnique("Build a quick chart from this sheet");
      pushUnique("Fill more rows from my research");
    } else if (/ads\.reddit\.com|ads\.google|adsmanager\.facebook|ads\.tiktok|ads\.x\.com|linkedin\.com\/campaignmanager/.test(u)) {
      pushUnique("Open a campaign and walk through its performance");
      pushUnique("Compare spend vs results for the last 7 days");
      pushUnique("Flag or pause an underperforming ad");
    } else if (/mail\.google\.com/.test(u)) {
      pushUnique("Open the first email that needs a reply");
      pushUnique("Draft a reply to this thread");
      pushUnique("Check drafts or starred");
    } else if (/docs\.google\.com\/document/.test(u)) {
      pushUnique("Edit or tighten the draft");
      pushUnique("Share it with someone");
      pushUnique("Add a short summary at the top");
    } else if (/youtube\.com\/watch/.test(u)) {
      pushUnique("Grab key points from this video");
      pushUnique("Search for a related clip");
      pushUnique("Open a different video on this topic");
    } else if (/notion\.(so|site)|figma\.com|canva\.com|slides\.google/.test(u)) {
      pushUnique("Edit what’s on screen");
      pushUnique("Create a new blank file here");
      pushUnique("Export or share this");
    } else if (/\b(sign[- ]?in|log[- ]?in)\b/.test(t) || /\bsign-in wall\b/.test(a)) {
      pushUnique("Continue after I sign in");
      pushUnique("Tell me which account to use");
    } else if (/\b(quiz|question|exercise|lesson)\b/.test(t) || /\b(quiz|complete|finish)\b/.test(g)) {
      pushUnique("Keep going through the next questions");
      pushUnique("Submit when you’re ready");
      pushUnique("Explain the last answer");
    }

    // Goal-aware tips when page heuristics didn't fill the list.
    if (tips.length < 3) {
      if (/\b(check|review|look|status|how|monitor)\b/.test(g)) {
        pushUnique(
          pageName
            ? `Go deeper on one item on ${pageName}`
            : "Go deeper on one item on this page",
        );
        pushUnique("Summarize what stands out here");
        pushUnique("Change a filter or date range");
      } else if (/\b(find|search|look up|research)\b/.test(g)) {
        pushUnique("Open the best result and dig in");
        pushUnique("Compare the top options");
        pushUnique("Summarize what you found");
      } else if (/\b(buy|price|order|shop|checkout)\b/.test(g)) {
        pushUnique("Compare prices on similar items");
        pushUnique("Check reviews before I decide");
        pushUnique("Add this to cart or checkout");
      } else if (/\b(email|inbox|gmail|reply)\b/.test(g)) {
        pushUnique("Open the next email that needs a reply");
        pushUnique("Draft a short reply");
        pushUnique("Archive or star this");
      } else if (/\b(write|draft|edit|create|make|build)\b/.test(g)) {
        pushUnique("Tighten the wording");
        pushUnique("Add more detail here");
        pushUnique("Share or export what we made");
      }
    }

    if (tips.length < 3) {
      if (pageName) {
        pushUnique(`Take the next useful step on ${pageName}`);
        pushUnique(`Check the result on ${pageName}`);
      }
      pushUnique("Keep going from here");
      pushUnique("Check the result on this page");
      pushUnique("Take the next useful step here");
    }

    return tips.slice(0, 3).map((tip) => {
      const label = suggestionChipLabel(tip);
      // Keep the chip short, but ground the send prompt in the open page/goal
      // so the agent continues instead of treating the tip literally.
      const ground = [];
      if (pageName) ground.push(`on “${pageName}”`);
      else if (u) {
        try {
          ground.push(`on ${new URL(String(url)).hostname.replace(/^www\./, "")}`);
        } catch {
          /* ignore */
        }
      }
      if (g && g.length > 8 && g.length < 120) {
        ground.push(`continuing from: ${String(goal).replace(/\s+/g, " ").trim().slice(0, 100)}`);
      }
      const prompt = ground.length
        ? `${tip} — ${ground.join("; ")}. Stay on the current tab and click through to do it.`
        : `${tip} — continue from the current browser tab and click through to do it.`;
      return { label, prompt };
    });
  }

  /**
   * Agents should explain what they did — not end on bare "Opened X. What next?".
   * Follow-up suggestions belong in the popup above the chat bar, not inline.
   */
  function ensureHelpfulAgentClose(msg, ctx = {}) {
    let text = stripInlineWantMeSuggestions(msg);
    if (!text) return text;
    const alreadyHelpful =
      text.length >= 120 &&
      (/\b##\s*(What I did|Summary|Link)\b/i.test(text) ||
        /\b(you(?:'re| are) on|here(?:'s| is) what|i (?:opened|found|checked|reviewed|looked)|this (?:page|tab|dashboard|shows))\b/i.test(
          text,
        )) &&
      !/\nWhat next\?\s*$/i.test(text);
    if (alreadyHelpful) return stripInlineWantMeSuggestions(text);

    text = text.replace(/\n*What next\?\s*$/i, "").trim();
    const title = String(ctx.title || "").trim();
    const url = String(ctx.url || "").trim();
    if (url && !text.includes(url) && !/\b##\s*Link\b/i.test(text)) {
      text += `\n\n## Link\n`;
      text += title ? `[${title.slice(0, 100)}](${url})` : url;
    } else if (
      title &&
      !new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 40), "i").test(text)
    ) {
      text += `\n\nYou're looking at **${title.slice(0, 100)}**.`;
    }
    return stripInlineWantMeSuggestions(text);
  }

  function extractReadablePageSnippets(pageText, { maxLines = 4, maxChars = 900 } = {}) {
    const skip =
      /^(inbox|starred|snoozed|sent|drafts|categories|compose|search mail|settings|google|gmail|menus?|primary|promotions|social|updates|forums)\b/i;
    const lines = String(pageText || "")
      .split(/\n+/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => l.length >= 28 && l.length <= 420 && !skip.test(l));
    const out = [];
    const seen = new Set();
    for (const line of lines) {
      const key = line.slice(0, 48).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
      if (out.length >= maxLines) break;
    }
    return out.join("\n\n").slice(0, maxChars);
  }

  function formatOpenedEmailAnswer({ label, pageText, url }) {
    const bits = String(label || "")
      .split(/\s+[—–\-]\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const sender = bits[0] || "";
    const subject = bits[1] || "";
    const time =
      bits.find((p) => /\d{1,2}:\d{2}|\b(am|pm)\b|yesterday|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(p)) ||
      bits[2] ||
      "";
    const body = extractReadablePageSnippets(pageText, { maxLines: 10, maxChars: 2800 });
    const title = subject || sender || "Opened email";
    let msg = `## ${title}\n\n`;
    if (sender) msg += `From **${sender}**`;
    if (time) msg += sender ? ` · ${time}` : time;
    if (sender || time) msg += ".\n\n";
    if (body) msg += body;
    return ensureHelpfulAgentClose(msg, {
      goal: "email",
      url,
      title: subject || sender || "Gmail",
      pageText,
    });
  }

  function formatInboxListAnswer(rows, goal) {
    const list = (Array.isArray(rows) ? rows : []).filter(Boolean).slice(0, 10);
    if (!list.length) return "";
    const lines = list.map((r, i) => `${i + 1}. ${r}`);
    const wantsUnanswered = /\b(unanswered|reply|respond|need to)\b/i.test(goal || "");
    const msg =
      `## Inbox\n\n` +
      `Here is what is waiting in this inbox:\n\n` +
      `${lines.join("\n")}\n\n` +
      (wantsUnanswered
        ? `These look like the ones most likely to need a reply. Say which number to open.`
        : `I can open any of these, draft a reply, or skim unread only.`);
    return ensureHelpfulAgentClose(msg, { goal, url: "https://mail.google.com", title: "Gmail" });
  }

  function formatQuickBrowseAnswer({ goal, page, url, history, label }) {
    const pageText = String(page?.text || "");
    const title = String(page?.title || "").trim();
    const rows = Array.isArray(page?.rows) ? page.rows : [];
    const ctx = { goal, url, title, pageText };
    if (label || ownedBrowserAct.looksLikeOpenMailItem?.(goal)) {
      return formatOpenedEmailAnswer({
        label: label || rows[0] || title,
        pageText,
        url,
      });
    }
    if (
      rows.length &&
      (ownedBrowserAct.looksLikeMailInboxReview(goal) ||
        ownedBrowserAct.looksLikeGmailOpenOrReview(goal)) &&
      !needsLlmBrowseSummary(goal)
    ) {
      return formatInboxListAnswer(rows, goal);
    }
    const okActs = (Array.isArray(history) ? history : []).filter((h) => h?.result?.ok);
    if (okActs.length && !needsLlmBrowseSummary(goal)) {
      const last = okActs[okActs.length - 1];
      // Same rule as the work log: an element reference is not a place, and
      // "I finished the step on **e11**." is what reading it raw produced.
      // Falling through to the page title is the better failure.
      const actLabel = humanLabel(last);
      const snippet = extractReadablePageSnippets(pageText, { maxLines: 3, maxChars: 700 });
      let msg = actLabel
        ? `I finished the step on **${actLabel.slice(0, 80)}**.`
        : title
          ? `I wrapped up on **${title.slice(0, 80)}**.`
          : `I finished the browser step.`;
      if (snippet) {
        msg += `\n\nHere’s what stands out on the page:\n\n${snippet}`;
      } else if (url) {
        msg += `\n\nThe tab is ready at ${url}.`;
      }
      return ensureHelpfulAgentClose(msg, ctx);
    }
    // Landed / opened with little history — still explain + suggest.
    if (title || url) {
      const snippet = extractReadablePageSnippets(pageText, { maxLines: 3, maxChars: 700 });
      let msg = title
        ? `Opened **${title.slice(0, 100)}** in this agent's browser.`
        : `Opened the page in this agent's browser.`;
      if (snippet) msg += `\n\n${snippet}`;
      return ensureHelpfulAgentClose(msg, ctx);
    }
    return "";
  }

  function paintBrowseDone(agent, msg, opts = {}) {
    if (Array.isArray(opts.history)) {
      hydrateLiveOutputFromHistory(agent, opts.history);
    }
    finalizeLiveOutputSteps(agent);
    if (!agent.liveOutputSteps?.length) {
      const raw = String(msg || "")
        .replace(/^#+\s+/gm, "")
        .replace(/^[-*]\s+/gm, "")
        .replace(/\*\*/g, "")
        .trim();
      const firstLine =
        raw
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !/^!\[/.test(l) && !/^##\s/.test(l)) || "";
      const label = sanitizeStepLabel(firstLine) || "Finished";
      agent.liveOutputSteps = [
        {
          label,
          kind: "browse",
          status: "done",
          url: opts.url || agent.url || "",
        },
      ];
    }
    // Suggestions are computed before the final paint so the closing summary
    // can name the first one inline as the next step.
    if (!opts.skipSuggestions) {
      agent.lastSuggestions = suggestNextStepsForBrowse({
        goal:
          opts.goal ||
          agent.lastIntent?.browseGoal ||
          agent.lastIntent?.understood ||
          "",
        url: opts.url || agent.url || "",
        title: opts.title || agent.lastBrowseTitle || "",
        pageText: String(opts.pageText || "").slice(0, 2000),
        skill: "browse",
        answer: String(msg || ""),
      });
    }
    // The agent's own final answer used to be dropped whenever step boxes
    // existed — the one piece of prose written FOR the user never reached
    // them (it only survived as a report subtab, when it survived at all).
    // It now closes the response: what was done, then one next step.
    let appendix = "";
    if (!opts.midStep) {
      let summary = stripInlineWantMeSuggestions(String(msg || "").trim())
        .replace(/\n{3,}/g, "\n\n")
        .slice(0, 16000)
        .trim();
      if (summary.length < 20) {
        const title = String(opts.title || agent.lastBrowseTitle || "").trim();
        summary = title
          ? `Done. Finished up on **${title.slice(0, 100)}**.`
          : "Done. The browser work for this ask is finished.";
      }
      const tip = suggestionText(
        Array.isArray(agent.lastSuggestions) ? agent.lastSuggestions[0] : "",
      );
      appendix = [summary, tip ? `**Next step:** ${tip}. Just say the word.` : ""]
        .filter(Boolean)
        .join("\n\n");
    }
    const text = emitStepTranscript(agent, { final: !opts.midStep, appendix });
    agent.lastDeliverableKind = "browse";
    if (opts.title) agent.lastBrowseTitle = String(opts.title).slice(0, 160);
    if (!opts.midStep) {
      sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Done" });
    }
    return text;
  }

  /**
   * Single browse exit — every open/click/land path should end here so the
   * user always gets finished step boxes + suggestion chips.
   */
  function finishBrowseTurn(agent, msg, opts = {}) {
    return paintBrowseDone(agent, msg, {
      goal: opts.goal || "",
      url: opts.url || agent.url || "",
      title: opts.title || "",
      pageText: opts.pageText || "",
      skipEnrich: !!opts.skipEnrich,
      midStep: !!opts.midStep || !!opts.suppressDone,
      skipSuggestions: !!opts.midStep || !!opts.suppressDone,
    });
  }

  async function finishBrowseResult(agent, text, gen, wc, opts = {}) {
    const page = opts.page || (await ownedBrowserAct.getPageContextRich(wc));
    const url = opts.url || page.url || wc.getURL?.() || agent.url || "";
    agent.url = url;

    // Never wrap up while the tab is still a login page — wait, then finish.
    if (
      wc &&
      !wc.isDestroyed?.() &&
      ownedBrowserAct.looksLikeSignInWall?.({
        url,
        text: page.text,
        title: page.title,
      })
    ) {
      const pause = await pauseForUserSignIn(agent, gen, wc, {
        context: "finishing this task",
      });
      if (pause.blocked && !pause.cleared) {
        return pause.message || "";
      }
      // Wall cleared — re-read the page for the real wrap-up.
      try {
        const fresh = await ownedBrowserAct.getPageContextRich(wc);
        if (fresh?.url) agent.url = fresh.url;
        opts = { ...opts, page: fresh, url: fresh?.url || agent.url };
      } catch {
        /* use prior page */
      }
    }

    const fromPlan = String(opts.planAnswer || "").trim();
    const hist = Array.isArray(opts.history) ? opts.history : [];
    hydrateLiveOutputFromHistory(agent, hist);
    const actedOk = hist.some(
      (h) =>
        h?.result?.ok &&
        /^(?:click|tap|press_click|click_coord|tap_coord|os_write|write|type|fill|press)$/i.test(
          String(h?.action?.type || ""),
        ),
    );
    const actionAsk =
      ownedBrowserAct.looksLikeShareCurrentPageAsk?.(text) ||
      /\b(share|invite|click|type|fill|send|submit|create|write)\b/i.test(String(text || ""));
    // Narrated plans ("I will click Share…") are NOT results. If we never acted
    // on an action ask, say so instead of painting the plan as Finished.
    if (
      actionAsk &&
      !actedOk &&
      fromPlan &&
      /\b(i will|i'll|going to|next i|plan:|step 1|click the share|then type)\b/i.test(fromPlan)
    ) {
      return paintBrowseDone(
        agent,
        "I mapped out the steps but didn't complete them on the page. Ask me to continue and I'll keep clicking through.",
      );
    }

    const pageForClose = opts.page || page;
    const urlForClose = opts.url || url;
    const paintCtx = {
      goal: text,
      url: urlForClose,
      title: pageForClose.title || "",
      pageText: String(pageForClose.text || "").slice(0, 2000),
      history: hist,
    };

    // Mid multi-step: leave the action boxes as done for this plan step.
    if (opts.suppressDone) {
      return paintBrowseDone(agent, fromPlan || opts.quickMessage || "", {
        ...paintCtx,
        skipEnrich: true,
        midStep: true,
        skipSuggestions: true,
      });
    }

    // The completion summary lives in the response area now (paintBrowseDone
    // closes the transcript with the agent's answer + a next step). A summary
    // is a wrap-up, not a deliverable — opening it as a report subtab buried
    // the one thing the user most wants to read at the end of a run.
    return paintBrowseDone(agent, fromPlan || opts.quickMessage || "", {
      ...paintCtx,
      skipEnrich: true,
    });
  }

  return {
    STEP_DETAIL_SEP,
    joinStepDetails,
    sanitizeStepLabel,
    sanitizeStepDetail,
    tidyStepDetail,
    sanitizeStepNote,
    buildBrowsePlanNote,
    browseHistoryToStepLabels,
    resetLiveOutputSteps,
    renderStepTranscript,
    dropTransientOutputSteps,
    syncBrowseActionDeliverables,
    emitStepTranscript,
    setLiveOutputStep,
    setLiveOutputStepNote,
    appendLiveOutputStepDetail,
    completeLiveOutputStep,
    finalizeLiveOutputSteps,
    hydrateLiveOutputFromHistory,
    narrateBrowseProgress,
    humanizeBrowseStatus,
    describeBrowseAction,
    clipBrowseReason,
    stripInlineWantMeSuggestions,
    suggestionText,
    suggestionChipLabel,
    suggestNextStepsForBrowse,
    ensureHelpfulAgentClose,
    extractReadablePageSnippets,
    formatOpenedEmailAnswer,
    formatInboxListAnswer,
    formatQuickBrowseAnswer,
    paintBrowseDone,
    finishBrowseTurn,
    finishBrowseResult,
  };
}

module.exports = { createBrowsePresentation };
