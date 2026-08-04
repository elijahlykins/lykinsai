'use strict';

/**
 * Split Agent Mode prompts into ordered steps so "do A, then B, then C"
 * runs sequentially instead of collapsing to one skill.
 */

const {
  looksLikeCreateInToolVenueAsk,
} = require("./agentToolVenues.cjs");

const ACTIONISH_RE =
  /\b(open|go|visit|browse|navigate|find|search|look\s*up|pull\s*up|show|watch|play|click|fill|compose|draft|write|send|build|create|make|generate|design|research|investigate|monitor|alert|summarize|edit|update|turn(?:ing)?|convert(?:ing)?|use|user|draw|image|report|email|gmail|youtube|pinterest|complete|finish|take|answer|submit|solve|work\s+through)\b/i;

function stripStepLead(s) {
  return String(s || "")
    .replace(/^\s+/, "")
    .replace(/^(?:step\s*)?\d+[\).\]]\s*/i, "")
    .replace(/^(?:[-*•]|\([a-z]\))\s+/i, "")
    .replace(/^(?:first|second|third|fourth|fifth|next|then|finally|also|please|and)\s*,?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeActionStep(s) {
  const t = String(s || "").trim();
  if (t.length < 4) return false;
  if (ACTIONISH_RE.test(t)) return true;
  // Short imperative remnants after stripping ("the latest mr beast video")
  return t.length >= 10 && /\b[a-z]{3,}\b/i.test(t);
}

/** Site half of "open SITE and search…" — name/domain only, not a whole clause. */
function looksLikeSiteToken(site) {
  const s = String(site || "").trim();
  if (!s || s.length > 40) return false;
  if (/[,;:]/.test(s)) return false;
  if (
    /\b(look|search|find|ideas?|presentation|recipe|video|email|draft|build|research|create|generate)\b/i.test(
      s,
    )
  ) {
    return false;
  }
  if (/^(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/\S*)?$/i.test(s)) return true;
  if (/^[a-z][a-z0-9-]{1,24}$/i.test(s)) return true;
  return false;
}

/**
 * Split a single clause that packs browse/find + build into two steps.
 * "go into pinterest, find blue inspo build me a presentation on the report"
 * → browse step, then build step.
 */
function splitCompoundSkillStep(step) {
  const raw = String(step || "").trim();
  if (!raw || raw.length < 16) return [raw];
  // Named external tool create/write stays one step (real Docs/Sheets/…, not artifact).
  if (looksLikeCreateInToolVenueAsk(raw)) return [raw];

  // Browse/find/check-my-account … then build/create / turn-into a deliverable.
  // "check my reddit ads account and create a report" → browse step + report step.
  const buildBoundary = raw.match(
    /^(.*?\b(?:go\s+into|go\s+to|open|visit|pull\s+up|browse|find|search|look\s+for|check|review|look\s+at|log\s*in(?:\s*to)?|sign\s*in(?:\s*to)?)\b[\s\S]+?)\s+(?=(?:and\s+)?(?:then\s+)?(?:(?:based\s+(?:off|on)\s+(?:of\s+)?(?:one\s+of\s+)?(?:those|that|this|the)\s+\w+\s+)?(?:build|create|make|write(?:\s+(?:up|me))?|generate|give)\s+(?:me\s+)?(?:up\s+)?(?:an?\s+)?(?:presentation|deck|slides?|slideshow|artifact|app|page|dashboard|report|summary|write-?up|overview|analysis|breakdown)|(?:use|user)\s+it\b|turn(?:ing)?\b[\s\S]{0,80}\binto\b))/i,
  );
  if (buildBoundary && buildBoundary[1]) {
    const first = stripStepLead(buildBoundary[1]).replace(/[.,;:\s]+$/g, "").trim();
    const rest = stripStepLead(raw.slice(buildBoundary[1].length)).trim();
    if (looksLikeActionStep(first) && looksLikeActionStep(rest) && first.length >= 8) {
      return [first, rest];
    }
  }

  // Research … then browse/open a site (comma/period without "then").
  // Require go-into / open-up / visit — not bare "open source".
  const researchBrowse = raw.match(
    /^(.*?\b(?:research|report|companies|analysis)\b[\s\S]*?)(?:[.,]\s+|\s+)(?=(?:go\s+into|go\s+to|visit|pull\s+up|open\s+up)\s+)/i,
  );
  if (researchBrowse && researchBrowse[1] && researchBrowse[1].length < raw.length - 8) {
    const first = stripStepLead(researchBrowse[1]).replace(/[.,;:\s]+$/g, "").trim();
    const rest = stripStepLead(raw.slice(researchBrowse[1].length)).trim();
    if (
      looksLikeActionStep(first) &&
      looksLikeActionStep(rest) &&
      /\b(research|report)\b/i.test(first) &&
      /\b(go\s+into|go\s+to|open|visit|pinterest|youtube)\b/i.test(rest)
    ) {
      return [first, rest];
    }
  }

  // "find a physics quiz and complete the entire thing" → find, then complete.
  const findThenDo = raw.match(
    /^(.*?\b(?:find|search|look\s+for|open|pull\s+up)\b[\s\S]+?)\s+and\s+(?=(?:complete|finish|do|take(?!\s+(?:a\s+|some\s+|quick\s+)?(?:new\s+)?notes?\b)|answer|submit|fill\s+(?:out|in)|solve|work\s+through)\b)/i,
  );
  if (findThenDo && findThenDo[1]) {
    const first = stripStepLead(findThenDo[1]).replace(/[.,;:\s]+$/g, "").trim();
    const rest = stripStepLead(raw.slice(findThenDo[1].length)).replace(/^and\s+/i, "").trim();
    if (looksLikeActionStep(first) && looksLikeActionStep(rest) && first.length >= 8) {
      return [first, rest];
    }
  }

  return [raw];
}

function expandCompoundSteps(steps) {
  const out = [];
  for (const s of steps) {
    const parts = splitCompoundSkillStep(s);
    for (const p of parts) {
      if (p && looksLikeActionStep(p)) out.push(p);
    }
  }
  return out.slice(0, 10);
}

/**
 * "open gmail, click the first email, then draft a response"
 * → open gmail → open that email → draft reply (keeps thread context).
 */
function splitGmailOpenEmailReplyPrompt(raw) {
  const s = String(raw || "").trim();
  if (!/\bgmail\b/i.test(s)) return null;
  const openEmail =
    /\b(click|open|read|pull\s+up|show)\b.{0,48}\b(first|second|third|top|\d+(?:st|nd|rd|th))\s+(email|message|one)\b/i.test(
      s,
    ) ||
    /\b(first|second|third|top)\s+(email|message)\b/i.test(s);
  if (!openEmail) return null;
  if (
    !/\b(draft|reply|respond|response)\b/i.test(s) &&
    !/\bwrite\s+(a\s+)?(reply|response)\b/i.test(s)
  ) {
    return null;
  }
  let which = "first";
  if (/\bsecond\b/i.test(s)) which = "second";
  else if (/\bthird\b/i.test(s)) which = "third";
  else {
    const nth = s.match(/\b(\d+)(st|nd|rd|th)\b/i);
    if (nth) which = `${nth[1]}${nth[2]}`;
  }
  return ["open gmail", `open the ${which} email`, "draft a response for that email"];
}

/**
 * @param {string} text
 * @returns {string[]} ordered steps (length 1 when not multi-step)
 */
function splitMultiStepPrompt(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  if (raw.length < 10) return [raw];

  // Gmail open → open email → reply must stay three steps (reply needs the thread).
  const gmailReplyFlow = splitGmailOpenEmailReplyPrompt(raw);
  if (gmailReplyFlow) return gmailReplyFlow;

  // Newline-numbered / bulleted lists
  const lines = raw
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const lineLeadRe = /^(?:(?:step\s*)?\d+[\).\]]|[-*•]|\([a-z]\))\s+/i;
  const led = lines.filter((l) => lineLeadRe.test(l));
  if (led.length >= 2 && led.length >= Math.ceil(lines.length * 0.55)) {
    const steps = lines.map(stripStepLead).filter(looksLikeActionStep);
    if (steps.length >= 2) return steps.slice(0, 10);
  }

  // Inline "1. foo 2. bar 3. baz"
  const inline = [];
  const inlineRe = /(?:^|\s)(?:(?:step\s*)?\d+[\).\]])\s+([\s\S]+?)(?=(?:\s+(?:(?:step\s*)?\d+[\).\]])\s+)|$)/gi;
  let m;
  while ((m = inlineRe.exec(raw)) !== null) {
    const part = stripStepLead(m[1]);
    if (part) inline.push(part);
  }
  if (inline.length >= 2 && inline.filter(looksLikeActionStep).length >= 2) {
    return inline.filter(looksLikeActionStep).slice(0, 10);
  }

  // "do X, then Y, then Z" / "after that" / "next," / "finally,"
  const thenParts = raw
    .split(/\s*(?:,\s*)?(?:\band\s+)?(?:then|after\s+that|afterwards|afterward|next|finally)\b\s*,?\s*/i)
    .map(stripStepLead)
    .filter(Boolean);
  if (thenParts.length >= 2 && thenParts.length <= 8) {
    const steps = expandCompoundSteps(thenParts.filter(looksLikeActionStep));
    if (steps.length >= 2) return steps;
  }

  // Sentence-separated actions: "go to khan academy. find a physics quiz and complete it"
  // (period/!? between imperative clauses — not a single prose paragraph).
  const sentenceParts = raw
    .split(/(?<=[.!?])\s+(?=[A-Za-z])/)
    .map((s) => stripStepLead(s.replace(/[.!?]+$/g, "")))
    .filter(Boolean);
  if (sentenceParts.length >= 2 && sentenceParts.length <= 8) {
    const actionSentences = sentenceParts.filter(looksLikeActionStep);
    if (
      actionSentences.length >= 2 &&
      actionSentences.length >= Math.ceil(sentenceParts.length * 0.7)
    ) {
      const steps = expandCompoundSteps(actionSentences);
      if (steps.length >= 2) return steps;
    }
  }

  // Semicolon-separated action list: "open gmail; draft email; send later"
  if ((raw.match(/;/g) || []).length >= 1) {
    const semis = expandCompoundSteps(
      raw
        .split(/\s*;\s*/)
        .map(stripStepLead)
        .filter(looksLikeActionStep),
    );
    if (semis.length >= 2 && semis.length <= 8) return semis;
  }

  // "open pinterest and search for food recipes" → open site, then search on it.
  // Also: "go to khan academy. find a physics quiz and complete…" (site may be
  // multi-word / misspelled; trailing complete/finish becomes a third step).
  // Do NOT match "pull up pinterest, look for X find one that is Y" — that is
  // one browse ask (site + composed query + pick), not two broken steps.
  const openSearch = raw.match(
    /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:(?:open|go\s+to|visit|pull\s+up|browse(?:\s+to)?|launch|load|navigate(?:\s+to)?)\s+(?:up\s+)?(?:(?:a|an|the|my)\s+)?)(.+?)(?:[.!]+\s*|\s+)(?:and\s+)?(?:then\s+)?(?:search|find|look\s*up)\s+(?:for\s+|up\s+)?(.+?)\s*$/i,
  );
  // Don't peel "open Google Docs and write…" into open + search — that's tool-create.
  if (openSearch && !looksLikeCreateInToolVenueAsk(raw)) {
    let site = stripStepLead(openSearch[1])
      .replace(/[.!]+$/g, "")
      .replace(/\s+(?:for\s+me|and|then)$/i, "")
      .trim();
    let query = stripStepLead(openSearch[2])
      .replace(/^(?:like\s+)?(?:me\s+)?(?:an?\s+|some\s+|any\s+)/i, "")
      .replace(/^me\s+/i, "")
      .trim();
    let completeStep = "";
    const completeSplit = query.match(
      /^(.*?)(?:\s+and\s+)((?:complete|finish|do|take|answer|submit|fill\s+(?:out|in)|solve|work\s+through)\b.*)$/i,
    );
    if (completeSplit) {
      query = stripStepLead(completeSplit[1]).trim();
      completeStep = stripStepLead(completeSplit[2]).trim();
    }
    // Multi-word educational sites: "khan academy", "kahn acadamy", etc.
    const siteOk =
      looksLikeSiteToken(site) ||
      /^(?:khan|kahn)\s+academ/i.test(site) ||
      /^[a-z][a-z0-9.-]{1,28}(?:\s+[a-z][a-z0-9.-]{1,20}){0,3}$/i.test(site);
    if (siteOk && query && query.length >= 2) {
      const isYoutube = /^(?:you\s*)?tube|yt$/i.test(site) || /youtube/i.test(site);
      // YouTube open+search must be ONE step — keep "on youtube" so routing
      // never falls through to Google after plan cleaning.
      if (isYoutube) {
        const steps = [`find ${query} on youtube`];
        if (completeStep) steps.push(completeStep);
        return steps;
      }
      const steps = [`open ${site}`, `search for ${query}`];
      if (completeStep) steps.push(completeStep);
      return steps;
    }
  }

  // Single paragraph with packed skill changes (no "then").
  const packed = expandCompoundSteps([raw]);
  if (packed.length >= 2) return packed;

  return [raw];
}

function isMultiStepPrompt(text) {
  return splitMultiStepPrompt(text).length >= 2;
}

/**
 * Strip chat filler so plan steps / search topics stay accurate.
 * "food recipes for me please now" → "food recipes"
 */
function stripPlanFiller(text) {
  let s = String(text || "").trim();
  if (!s) return "";
  s = s
    .replace(
      /^(?:hey\s+|ok(?:ay)?[,.]?\s+|please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|i\s+need\s+you\s+to\s+|i\s+want\s+you\s+to\s+)*/i,
      "",
    )
    .replace(/^(?:a|an|the|some|any|my|me)\s+/i, "")
    .replace(
      /\s+(?:please|thanks|thank\s+you|thx|for\s+me|for\s+us|now|right\s+now|asap|real\s*quick|quickly|today|tonight|just|really|somehow|kinda|kind\s+of|sort\s+of|lol)\s*[.!?]?\s*$/i,
      "",
    )
    .replace(
      /\b(?:please|thanks|thank\s+you|for\s+me|for\s+us|right\s+now|asap|real\s*quick|quickly|somehow|kinda|kind\s+of|sort\s+of)\b/gi,
      " ",
    )
    .replace(/\s+\b(?:now|just|really)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^(?:a|an|the|some|any|my|me)\s+/i, "").trim();
  return s;
}

/**
 * Tighten a single plan step for accurate execution.
 * Keeps the action verb; drops politeness / "for me" / search fluff.
 */
function cleanPlanStep(step) {
  let s = String(step || "")
    .replace(/\buser\s+it\b/gi, "use it")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";

  // Leading politeness before the real action.
  s = s
    .replace(
      /^(?:please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|hey[,.]?\s+)/i,
      "",
    )
    .trim();

  // Tool-venue asks ("take a new note in notion and write…") run as one
  // tool-create step — rewriting the verbs breaks venue matching downstream.
  if (looksLikeCreateInToolVenueAsk(s)) return s;

  // "go into pinterest, find blue presentation inspo" → open + search (one browse step)
  const siteFind = s.match(
    /^(?:open(?:\s+up)?|go\s+(?:to|into)|visit|pull\s+up|browse(?:\s+to)?)\s+([^,]+?)\s*[,]\s*(?:and\s+)?(?:then\s+)?(?:search|find|look\s+(?:for|up))\s+(?:for\s+|up\s+|me\s+)?(.+)$/i,
  );
  if (siteFind) {
    const site = stripPlanFiller(siteFind[1])
      .replace(/[.!]+$/g, "")
      .trim();
    let topic = String(siteFind[2] || "")
      .replace(
        /\s+(?:look\s+for\s+one|find\s+(?:me\s+)?one|pick\s+one|choose\s+one|one\s+you\s+like|based\s+(?:off|on)\b)[\s\S]*$/i,
        "",
      )
      .trim();
    topic = stripPlanFiller(topic).replace(/[.!]+$/g, "").trim();
    if (
      site &&
      topic &&
      site.length <= 40 &&
      !/\b(search|find|look\s+for|build|create|research)\b/i.test(site)
    ) {
      return `open ${site} and search for ${topic}`;
    }
  }

  // open up SITE / go to SITE → open SITE
  const openM = s.match(
    /^(?:open(?:\s+up)?|go\s+(?:to|into)|visit|pull\s+up|browse(?:\s+to)?|launch|load|navigate(?:\s+to)?)\s+(.+)$/i,
  );
  if (openM) {
    let site = stripPlanFiller(openM[1])
      .replace(/[.!]+$/g, "")
      .replace(/\s+(?:and|then)$/i, "")
      .trim();
    // Don't collapse browse+query into a bare open.
    if (
      site &&
      site.length <= 48 &&
      !/\b(search|find|look\s+for|build|create|research|complete)\b/i.test(site)
    ) {
      return `open ${site}`;
    }
  }

  // search / find / look up TOPIC → search for TOPIC
  // Video asks keep a find/play verb so the browser auto-opens a watch page
  // (plain "search for X video" used to stop on the results list).
  const searchM = s.match(
    /^(?:search(?:\s+(?:for|up))?|find(?:\s+me)?|look\s+(?:for|up)|pull\s+up|watch|play)\s+(.+)$/i,
  );
  if (searchM) {
    let topic = String(searchM[1] || "")
      .replace(
        /\s+(?:look\s+for\s+one|find\s+(?:me\s+)?one|pick\s+one|choose\s+one|one\s+you\s+like|that\s+is|which\s+is)\b[\s\S]*$/i,
        "",
      )
      .replace(
        /\s+and\s+(?:complete|finish|do|take|answer|submit|solve|work\s+through|play|watch|summarize|summarise|research|explain|describe|tell\s+me)\b[\s\S]*$/i,
        "",
      )
      .trim();
    topic = stripPlanFiller(topic).replace(/[.!]+$/g, "").trim();
    if (topic && topic.length >= 2) {
      topic = topic
        .replace(/^(?:like\s+)?(?:me\s+)?(?:an?\s+|some\s+|any\s+)/i, "")
        .replace(/^me\s+/i, "")
        .trim();
      const onYoutube = /\bon\s+youtube\b/i.test(topic) || /\bon\s+youtube\b/i.test(s);
      topic = topic.replace(/\bon\s+youtube\b/gi, " ").replace(/\s+/g, " ").trim();
      // "vid" / "video" / youtube asks keep find so browse routes to YouTube.
      if (
        /\b(video|videos|vids?|clip|clips|youtube|shorts?)\b/i.test(topic) ||
        /\b(video|videos|vids?|clip)\b/i.test(s) ||
        onYoutube
      ) {
        return onYoutube ? `find ${topic} on youtube` : `find ${topic}`;
      }
      return `search for ${topic}`;
    }
  }

  // research wrappers → research TOPIC
  const researchM = s.match(
    /^(?:do\s+(?:a\s+|some\s+)?|write\s+(?:a\s+|me\s+a\s+)?|make\s+(?:a\s+|me\s+a\s+)?)?(?:deep\s+)?research(?:\s+report)?(?:\s+for\s+me)?(?:\s+(?:on|about|into|regarding))?\s+(.+)$/i,
  );
  if (researchM && researchM[1] && !/^(?:report|and)\b/i.test(researchM[1])) {
    const topic = stripPlanFiller(researchM[1]).replace(/[.!]+$/g, "").trim();
    if (topic && topic.length >= 4) return `research ${topic}`;
  }

  // build/create me a … → build a … (keep a/an; drop "me" / filler only)
  const buildM = s.match(
    /^(?:(?:based\s+(?:off|on)\s+(?:of\s+)?(?:one\s+of\s+)?(?:those|that|this|the)\s+\w+\s+)?)?(?:and\s+)?(?:then\s+)?(?:(?:use|user)\s+it\s+(?:as\s+(?:the\s+)?base\s+(?:for\s+)?)?)?(?:build|create|make)\s+(?:me\s+)?(.+)$/i,
  );
  if (buildM && buildM[1]) {
    let rest = String(buildM[1] || "")
      .replace(
        /\s+(?:please|thanks|thank\s+you|for\s+me|for\s+us|now|right\s+now|asap)\s*[.!?]?\s*$/i,
        "",
      )
      .replace(/[.!]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    // "an actual presentation on the research report" keeps substance
    if (rest && /\b(presentation|deck|slides?|slideshow|artifact|app|page|dashboard|report)\b/i.test(rest)) {
      rest = rest.replace(/^(?:an?\s+)?actual\s+/i, (m) => (/^an\b/i.test(m) ? "an " : "a ")).trim();
      // If we stripped "actual", ensure article remains: "presentation" → "a presentation"
      if (/^(?:presentation|deck|slides?|slideshow|artifact|app|page|dashboard|report)\b/i.test(rest)) {
        rest = `a ${rest}`;
      }
      return `build ${rest}`;
    }
  }

  // generate / create image …
  const imageM = s.match(
    /^(?:generate|create|make|draw)\s+(?:me\s+)?(?:an?\s+)?(image|picture|illustration|cover(?:\s+image)?)\b(.*)$/i,
  );
  if (imageM) {
    const rest = stripPlanFiller(imageM[2] || "").replace(/^[,:.\s]+/, "").trim();
    return rest ? `generate image ${rest}` : "generate image";
  }

  // complete / finish the entire thing → complete it
  // ("take a note…" is content creation, not quiz completion — leave it alone.)
  if (
    /^(?:complete|finish|do|take|answer|submit|solve|work\s+through)\b/i.test(s) &&
    !/^take\s+(?:a\s+|some\s+|quick\s+)?(?:new\s+)?notes?\b/i.test(s)
  ) {
    const rest = stripPlanFiller(
      s
        .replace(/^(?:complete|finish|do|take|answer|submit|solve|work\s+through)\s+/i, "")
        .replace(/\b(?:the\s+)?(?:entire|whole|full)\s+(?:thing|quiz|exercise|lesson|page)\b/i, "it")
        .trim(),
    );
    if (!rest || /^(?:it|this|that|the\s+quiz|the\s+exercise)\b/i.test(rest)) {
      return "complete it";
    }
    return `complete ${rest}`;
  }

  return stripPlanFiller(s).replace(/[.!]+$/g, "").trim() || s;
}

/**
 * Dissect a user prompt into an executable plan.
 * Splits multi-step asks, then cleans each step (filler-free search topics, etc.).
 *
 * @param {string} text
 * @returns {{
 *   multi: boolean,
 *   steps: Array<{ index: number, raw: string, text: string }>,
 *   texts: string[],
 *   planLines: string,
 *   summary: string,
 * }}
 */
function buildAgentPlan(text) {
  const rawInput = String(text || "").trim();
  if (!rawInput) {
    return { multi: false, steps: [], texts: [], planLines: "", summary: "" };
  }

  const rawSteps = splitMultiStepPrompt(rawInput);
  const steps = [];
  const seen = new Set();
  for (const raw of rawSteps) {
    const cleaned = cleanPlanStep(raw);
    const textStep = cleaned || String(raw || "").trim();
    if (!textStep) continue;
    const key = textStep.toLowerCase();
    // Drop exact duplicates after cleaning ("search for X" twice).
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push({
      index: steps.length,
      raw: String(raw || "").trim(),
      text: textStep,
    });
  }

  // Safety net: "open youtube" + "find/search …" → one YouTube find step.
  if (
    steps.length === 2 &&
    /^open\s+(?:you\s*)?tube\b/i.test(steps[0].text) &&
    /^(?:find|search\s+for)\b/i.test(steps[1].text)
  ) {
    let findText = /^find\b/i.test(steps[1].text)
      ? steps[1].text
      : `find ${steps[1].text.replace(/^search\s+for\s+/i, "")}`;
    if (!/\bon\s+youtube\b/i.test(findText)) {
      findText = `${findText.replace(/\s+$/g, "")} on youtube`;
    }
    steps.splice(0, 2, {
      index: 0,
      raw: `${steps[0].raw} + ${steps[1].raw}`,
      text: findText,
    });
  }

  if (!steps.length) {
    steps.push({ index: 0, raw: rawInput, text: cleanPlanStep(rawInput) || rawInput });
  }

  const multi = steps.length >= 2;
  const texts = steps.map((s) => s.text);
  const planLines = texts.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const summary = multi
    ? `Plan (${steps.length} steps):\n${planLines}`
    : texts[0] || rawInput;

  return { multi, steps, texts, planLines, summary };
}

module.exports = {
  splitMultiStepPrompt,
  isMultiStepPrompt,
  looksLikeActionStep,
  looksLikeSiteToken,
  splitCompoundSkillStep,
  splitGmailOpenEmailReplyPrompt,
  stripStepLead,
  stripPlanFiller,
  cleanPlanStep,
  buildAgentPlan,
};
