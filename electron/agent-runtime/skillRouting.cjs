"use strict";

const ownedBrowserAct = require("../ownedBrowserAct.cjs");
const artifactBuildIntent = require("../../lib/artifactBuildIntent.cjs");
const workDestination = require("../../lib/agentWorkDestination.cjs");
const { looksLikeWrittenDocumentAsk } = require("../../lib/basicDocument.cjs");
const {
  detectImageIntent,
  detectReferenceImageAsk,
} = require("../../lib/imageGenIntent.cjs");

/** Deliverable nouns for "turn this into a …" conversions. */
const ARTIFACT_CONVERT_NOUN =
  "artifact|webapp|app|page|dashboard|deck|presentation|slideshow|slides?|pitch(?:\\s*deck)?|interactive(?:\\s+(?:page|app|artifact|deck|presentation))?";

/** Content nouns for artifact budgets/trackers when NO external tool is named. */
const ARTIFACT_SHEETISH_NOUN_RE =
  /\b(budget|budgets|expenses?|income|ledger|tracker|planner|log|inventory|schedule|roster|timesheet|invoice|pipeline|crm|template|table|list|matrix|spreadsheet|worksheet)\b/i;

/**
 * Back-compat: the ask is to make a spreadsheet-shaped thing somewhere.
 * Prefer workDestination.looksLikeWorkInApp for new code — it does not care
 * what the spreadsheet tool is called.
 */
function looksLikeCreateInGoogleSheetsAsk(text, opts = {}) {
  if (looksLikePasteReportIntoSheets(text)) return false;
  if (ownedBrowserAct.looksLikeOrganizeSheetAsk?.(text)) return false;
  if (!workDestination.looksLikeWorkInApp(text, opts)) return false;
  const said = `${text || ""} ${workDestination.destinationFromAsk(text)}`;
  return /\b(sheet|sheets|spreadsheet|excel|grid|workbook|budget|tracker|table)\b/i.test(
    said,
  );
}

/** Model refused drafting and told the user to arm Glass Build/Create instead. */
function looksLikeBuildModeRefusal(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  return (
    /\bswitch\s+to\s+\*?\*?build\*?\*?\b/i.test(t) ||
    /\b(?:build|create)\s+mode\b/i.test(t) ||
    /\bfrom\s+the\s+[“"]?\+[”"]?\s*menu\b/i.test(t) ||
    /\bresend\s+this\b/i.test(t) ||
    /\btap\s+[“"]?\+[”"]?\b/i.test(t)
  );
}

function formatToolVenueOpenLink(url, venueName) {
  const u = String(url || "").trim();
  if (!u || !/^https?:\/\//i.test(u)) return "";
  const label = venueName ? `Open in ${venueName}` : "Open document";
  return `[${label}](${u})`;
}

/**
 * "put that research report into the blank sheet" — transfer existing report,
 * do NOT start a new research crawl (research regex matches "research report").
 */
function looksLikePasteReportIntoSheets(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;
  const hasSheets =
    /\b(google\s*)?sheets?\b/.test(lower) ||
    /\bspreadsheets?\b/.test(lower) ||
    /\bblank\s+sheet\b/.test(lower) ||
    /\bthe\s+sheet\b/.test(lower) ||
    /\bopen\s+sheet\b/.test(lower);
  const hasReport =
    /\b(research\s*)?report\b/.test(lower) ||
    /\bresearch\b/.test(lower) ||
    /\b(that|the|this)\s+(info|information|findings?|analysis|brief)\b/.test(lower);
  const transfer =
    /\b(put|paste|enter|fill|drop|write|add|copy|dump|transfer|move|load|insert)\b/.test(
      lower,
    ) ||
    /\b(into|in|onto|to)\b.{0,24}\b(the\s+)?(blank\s+)?(sheet|sheets|spreadsheet)\b/.test(
      lower,
    );
  if (hasSheets && hasReport && transfer) return true;
  // "I need the info of that research report in the blank sheet"
  if (
    hasSheets &&
    hasReport &&
    /\b(need|want|get|have)\b.{0,40}\b(in|into|on)\b.{0,24}\b(sheet|sheets|spreadsheet)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  return false;
}

/** "turn that research report into an artifact/presentation" — build, don't re-research. */
function looksLikeArtifactConversion(text) {
  const lower = String(text || "")
    .toLowerCase()
    // Common dictation/typo: "user it as the base" → "use it as the base"
    .replace(/\buser\s+it\b/g, "use it");
  return (
    new RegExp(
      `\\b(turn(?:ing)?|convert(?:ing)?|transform(?:ing)?|make|rebuild)\\b[\\s\\S]{0,140}\\b(into|as)\\s+(an?\\s+)?(?:actual\\s+|real\\s+|live\\s+)?(${ARTIFACT_CONVERT_NOUN})\\b`,
    ).test(lower) ||
    new RegExp(
      `\\b(into|as)\\s+(an?\\s+)?(?:actual\\s+|real\\s+|live\\s+)?(${ARTIFACT_CONVERT_NOUN})\\b`,
    ).test(lower) ||
    /\b(make|build)\b.{0,48}\b(this|that|the)\b.{0,48}\b(report|research)\b.{0,48}\b(artifact|interactive|webapp|deck|presentation|slides?)\b/.test(
      lower,
    ) ||
    /\b(artifact|deck|presentation|slideshow)\b.{0,48}\b(from|based on|out of|base for)\b.{0,48}\b(this|that|the|report|research)\b/.test(
      lower,
    ) ||
    // "use it as the base for turning that report into a presentation"
    /\b(use|using)\s+it\b[\s\S]{0,100}\b(base|inspo|inspiration|template)\b[\s\S]{0,120}\b(presentation|deck|slides?|artifact)\b/.test(
      lower,
    ) ||
    // "turn this into a neutral colored presentation"
    /\b(turn(?:ing)?|convert(?:ing)?|make)\b.{0,40}\b(this|that|it|the report)\b.{0,60}\b(presentation|deck|slides?|slideshow)\b/.test(
      lower,
    )
  );
}

function normalizeAgentStepText(text) {
  return String(text || "")
    .replace(/\buser\s+it\b/gi, "use it")
    .replace(/\s+/g, " ")
    .trim();
}

/** Edit the open artifact / report / image in this agent's tab. */
function looksLikeDeliverableEdit(text) {
  const lower = String(text || "").toLowerCase();
  if (
    /\b(edit|change|update|tweak|adjust|modify|revise|improve|fix|restyle|redesign|rebuild|recolou?r|tighten|expand|shorten|lengthen|punch up|cut down)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  if (/\b(make it|make this|make that|make the)\b/.test(lower)) return true;
  if (
    /\b(add|remove|delete|rename|swap|replace)\b.{0,48}\b(section|title|heading|button|colou?r|theme|chart|image|column|row|card|panel|table|mode|toggle|nav|menu|footer|header|hero)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  if (
    /\b(darker|lighter|bigger|smaller|shorter|longer|wider|narrower|simpler|cleaner|bolder)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  if (/\b(another version|different (version|look|style|layout|theme))\b/.test(lower)) {
    return true;
  }
  return false;
}

/**
 * The user wants the last job done again, not a tweak of its leftover output.
 * "Try again" / "do that again" / "research X again" must not become a
 * report-edit just because a prior report is still sitting on the agent.
 */
function looksLikeRerunAsk(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (/^\s*(?:please\s+)?(?:try|do|run|check)\s+(?:it|that|this)?\s*again\b/i.test(t)) return true;
  if (/^\s*(?:again|same(?:\s+thing|\s+task|\s+ask)?|one\s+more\s+time|once\s+more)[.!?]*\s*$/i.test(t)) {
    return true;
  }
  if (/\b(?:re-?run|do\s+(?:it|that|this)\s+again|run\s+(?:it|that|this)\s+again|once\s+more|one\s+more\s+time)\b/i.test(lower)) {
    return true;
  }
  if (/\bagain\b/.test(lower) && !looksLikeDeliverableEdit(t.replace(/\bagain\b/gi, " "))) {
    return true;
  }
  return false;
}

/** Short follow-ups while a deliverable is open in this agent's tab. */
function looksLikeOpenDeliverableFollowUp(text) {
  const t = String(text || "").trim();
  const lower = t.toLowerCase();
  if (!t || t.length > 280) return false;
  if (looksLikeArtifactConversion(t)) return false;
  if (
    /\b(deep research|research report|monitor|watch for|alert me|notify me when)\b/.test(lower)
  ) {
    return false;
  }
  if (
    /\b(go to|navigate|browse|visit|open up|click)\b/.test(lower) &&
    !/\b(artifact|report|image|this|it|that|here)\b/.test(lower)
  ) {
    return false;
  }
  if (/\b(compose|email|gmail|draft|inbox|send (an? )?email)\b/.test(lower)) return false;
  if (/^\s*(what|why|how come|who|where|when)\b/.test(lower) && /\?/.test(t)) return false;
  if (
    /\b(add|remove|include|drop|use|set|put|move|switch|turn on|turn off|enable|disable|hide|show|rename|resize)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  if (
    /\b(dark mode|light mode|pricing|hero|footer|sidebar|navbar|header|animation|font|colou?r|theme|layout|spacing|padding|margin|button|chart|table|card|section|title|headline|copy)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  return false;
}

function shouldRouteDeliverableEdit(text, opts = {}) {
  if (looksLikeRerunAsk(text)) return false;
  if (looksLikeDeliverableEdit(text)) return true;
  const hasOpen =
    !!opts.hasArtifact || !!opts.hasReport || !!opts.hasImage || !!opts.deliverableKind;
  return hasOpen && looksLikeOpenDeliverableFollowUp(text);
}
/**
 * Does this ask require finding or checking something before anything can be
 * sent?
 *
 * "Verify I have a folder called final and send it to sam@example.com" names
 * its subject but not its address: which link goes in the email is only known
 * once the folder has been found. Treating the open tab as the answer sends
 * whatever happened to be on screen — in one run, google.com.
 */
function askNeedsFindingFirst(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  return (
    /\b(?:find|locate|search for|look (?:for|up)|check (?:if|whether|that)|verify|confirm|make sure|see if)\b/.test(t) ||
    // Uncertainty about the thing itself — the user does not know where it is
    // or what it is called, so neither do we until we look.
    /\bi think i (?:have|had|made|saved)\b/.test(t) ||
    /\b(?:called|named) (?:like|something like)\b/.test(t) ||
    /\bsomething like that\b/.test(t)
  );
}

function classifyAgentSkill(text, opts = {}) {
  const t = String(text || "").trim();
  const lower = t.toLowerCase();
  // Where the user said the work happens, in their own words — any app, no
  // table of products. The deliverable words sitting next to a destination —
  // "newsletter", "flyer", "landing page", "report" — say what to make once we
  // are there; they are not a reason to make it somewhere else instead.
  // Without this, "log into Klaviyo and make a flyer" reads as an image
  // commission and the user gets a picture in the chat rather than a flyer in
  // Klaviyo, which is both the wrong artifact and the wrong place.
  const namedWorkVenue = workDestination.looksLikeWorkInNamedApp(t)
    ? workDestination.destinationFromAsk(t)
    : "";
  // A destination can also be named by standing in it. Someone looking at an
  // app who says "create a budget" means here, and said so by having it open —
  // the same signal the named case gets from a word. It holds inside an open
  // file too: an explicit create while editing means a new one, not this one.
  //
  // Three things keep it from swallowing ordinary browsing. The page must be
  // somewhere you work rather than pass through; the ask must be to start
  // something rather than to act on what is on screen; and a fully specified
  // commission — "a slide deck on material science, 11 slides, neutral
  // colours" — is a LYKN artifact whatever happens to be open behind it.
  const liveUrl = String(opts.liveUrl || "");
  const standingInAnApp =
    !!opts.hasLiveTab &&
    /^https?:\/\//i.test(liveUrl) &&
    !workDestination.isPassThroughPage(liveUrl) &&
    !namedWorkVenue &&
    workDestination.asksToStartSomethingNew(t) &&
    !artifactBuildIntent.isTypedNewDeliverableAsk(t);
  if (
    /\b(monitor|watch for|alert me|notify me when|keep an eye|tell me when)\b/.test(lower)
  ) {
    return "monitor";
  }
  // Must win over "research report" / "make a presentation" artifact matches.
  if (looksLikePasteReportIntoSheets(t)) {
    return "sheets-fill";
  }
  // The user named where the work belongs — "in Notion", "in Google Sheets",
  // "in Linear", "in our team wiki". Any app: this asks whether a destination
  // was named and whether something is being created, not whether the product
  // appears in a list we maintain. It beats a LYKN artifact, because they said
  // where they want it.
  if (
    !ownedBrowserAct.looksLikeOrganizeSheetAsk?.(t) &&
    !workDestination.looksLikeEditCurrentInToolAsk(t, opts) &&
    (workDestination.looksLikeWorkInNamedApp(t) || standingInAnApp)
  ) {
    return "tool-create";
  }
  if (looksLikeArtifactConversion(t)) {
    return "build";
  }
  // "build me a presentation on the research report" is BUILD, not a new research crawl.
  // (Research regex matches build+…+report too eagerly.) Skip edit-style asks.
  if (
    !namedWorkVenue &&
    !/\b(edit|change|update|tweak|adjust|modify|revise|improve|fix|shorter|longer|expand|tighten|punchier)\b/.test(
      lower,
    ) &&
    /\b(build|create|make)\b.{0,48}\b(me\s+)?(an?\s+)?(presentation|deck|slides?|slideshow)\b/.test(
      lower,
    )
  ) {
    return "build";
  }
  // Edit whatever is open in this agent's tab (artifact / report / image).
  if (shouldRouteDeliverableEdit(t, opts)) {
    const kind = String(opts.deliverableKind || "");
    if (kind === "artifact" || (opts.hasArtifact && kind !== "report" && kind !== "image")) {
      return "build";
    }
    if (
      kind === "image" ||
      (opts.hasImage && /\b(image|picture|photo|illustration|render)\b/.test(lower))
    ) {
      return "image";
    }
    if (kind === "report" || (opts.hasReport && kind !== "artifact")) {
      // Brand-new report commissions still go to research below.
      if (
        !/\b(create|write|produce|prepare|give me|make me)\b.{0,24}\b(new\s+)?(report|brief|analysis)\b.{0,24}\b(on|about|of)\b/.test(
          lower,
        )
      ) {
        return "report-edit";
      }
    }
    if (opts.hasArtifact) return "build";
    if (opts.hasImage) return "image";
    if (opts.hasReport) return "report-edit";
  }
  if (
    !namedWorkVenue &&
    (/\b(deep research|research report|investigate thoroughly|multi-?source analysis)\b/.test(
      lower,
    ) ||
    (/^\s*research\b/.test(lower) && lower.length > 12) ||
    // "create a report on X" / "report comparing open-source models" — do it in Agent Mode
    /\b(create|write|produce|draft|prepare|give me|make me|build)\b.{0,48}\b(report|brief|analysis|comparison|overview|landscape)\b/.test(
      lower,
    ) ||
    /\b(report|brief|analysis|comparison|overview|landscape)\b.{0,40}\b(on|about|of|comparing|for)\b/.test(
      lower,
    ))
  ) {
    return "research";
  }
  if (!namedWorkVenue && looksLikeWrittenDocumentAsk(t)) {
    return "write-document";
  }
  // Asking ABOUT the current screen/tab ("what's on my screen?", "what am I
  // looking at?", "summarize this page") must answer from the live tab — never
  // spin a browse loop that types the question into the site's search box.
  // Checked BEFORE the browse detectors so "video"/"search"/site-name words in
  // the question can't hijack it.
  if (
    !!opts.hasLiveTab &&
    referencesCurrentScreen(t) &&
    !ownedBrowserAct.looksLikeBrowseActAsk?.(t) &&
    !ownedBrowserAct.looksLikeInPageAction?.(t) &&
    !ownedBrowserAct.looksLikeMailInboxReview?.(t) &&
    !ownedBrowserAct.looksLikeMailDraftsReview?.(t) &&
    !ownedBrowserAct.looksLikeOpenMailItem?.(t) &&
    !ownedBrowserAct.looksLikeMailComposeTask?.(t) &&
    !ownedBrowserAct.looksLikeMailReplyTask?.(t) &&
    (!!ownedBrowserAct.looksLikePageQuestionAsk?.(t) ||
      !!ownedBrowserAct.looksLikeCasualConversation?.(t) ||
      /\b(what|summar|explain|describe|tell me|read|see)\b/.test(lower))
  ) {
    return "general";
  }
  // Price/product comparison against a named target ("compare the prices to
  // adidas") is real browser work — go check the other site, don't answer from
  // memory. Comparisons about the current screen stay page-answers above.
  if (
    !!opts.hasLiveTab &&
    /\b(?:compare|comparison|versus|vs\.?|price[- ]?match|cheaper\s+than|more\s+expensive\s+than|better\s+deal)\b/.test(
      lower,
    ) &&
    /\b(?:price|prices|pricing|cost|costs|cheaper|deals?|shipping)\b/.test(lower) &&
    !referencesCurrentScreen(t)
  ) {
    return "browse";
  }
  const browseTarget = ownedBrowserAct.resolveBrowseTargetUrl(t);
  const extractedUrl = ownedBrowserAct.extractUrlFromText(t);
  const siteClarifyUrl = ownedBrowserAct.resolveSiteClarificationUrl(t);
  // Browse-to-look beats Create: "…want the LYKN browser… look at UI ideas on
  // pinterest" used to false-fire typed build ("want the" + distant "UI").
  if (ownedBrowserAct.looksLikeVideoBrowseIntent(t)) {
    return "browse";
  }
  if (ownedBrowserAct.looksLikeInspoBrowseIntent?.(t)) {
    const commissioningBuild =
      /\b(build|create|make|generate)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)/i.test(t) ||
      (artifactBuildIntent.isTypedNewDeliverableAsk(t) &&
        !/\b(pinterest|dribbble|behance)\b/i.test(t) &&
        !/\blook(?:ing)?\s+at\b/i.test(t));
    if (!commissioningBuild) return "browse";
  }
  if (
    extractedUrl &&
    /\b(look(?:ing)?\s+at|look(?:ing)?\s+for|search(?:ing)?|find(?:ing)?|browse|check\s+out|show(?:\s+me)?)\b/.test(
      lower,
    ) &&
    !/\b(build|create|make|generate)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)/i.test(t)
  ) {
    return "browse";
  }
  // Typed artifact commissions (spreadsheet, deck, app…) beat image inference.
  // Skip when the user named an external tool as the venue (handled above).
  if (
    artifactBuildIntent.isTypedNewDeliverableAsk(t) &&
    !namedWorkVenue &&
    !standingInAnApp
  ) {
    return "build";
  }
  // Image: "make me an ad like this" (esp. with a cropped reference).
  if (
    !namedWorkVenue &&
    (detectImageIntent(t, { hasAttachedImage: !!opts.hasAttachedImage }) ||
      detectReferenceImageAsk(t, !!opts.hasAttachedImage))
  ) {
    return "image";
  }
  if (
    !namedWorkVenue &&
    (/\b(generate|create|make|draw)\b.{0,40}\b(image|picture|photo|illustration|logo|poster|wallpaper|avatar|meme|ad|flyer|banner|thumbnail)\b/.test(
      lower,
    ) ||
      /\b(image of|picture of|photo of)\b/.test(lower))
  ) {
    return "image";
  }
  if (
    !namedWorkVenue &&
    !standingInAnApp &&
    (/\b(build|create|make|scaffold|code)\b.{0,40}\b(app|page|dashboard|deck|artifact|landing|tool|spreadsheet|worksheet|site|webapp|presentation|slideshow|slides?|calculator|quiz|tracker|form|widget|portal|simulator)\b/.test(
      lower,
    ) ||
      /\b(build me|code me)\b/.test(lower))
  ) {
    return "build";
  }
  // "create me a budget" (no external tool named) → LYKN artifact.
  if (
    !namedWorkVenue &&
    !standingInAnApp &&
    /\b(create|make|build|draft|generate|whip\s+up|put\s+together)\b(?:\s+(?:for\s+)?(?:me|us))?(?:\s+(?:a|an|my|the|some))\b/.test(
      lower,
    ) &&
    ARTIFACT_SHEETISH_NOUN_RE.test(lower)
  ) {
    return "build";
  }
  // Stock quote / live chart goals even without a full domain ("tesla stock chart").
  if (browseTarget && ownedBrowserAct.isStockBrowseIntent(t)) {
    return "browse";
  }
  // Live tab + informational / conversational ask → scrape the page and answer.
  // Do NOT start a click/plan loop for "what's my spend?", "thoughts on this?",
  // "summarize this", casual chat, etc. Mail inbox/drafts keep the specialized browse path.
  const conversationalOnLiveTab =
    !!opts.hasLiveTab &&
    !ownedBrowserAct.looksLikeBrowseActAsk?.(t) &&
    !ownedBrowserAct.looksLikeInPageAction?.(t) &&
    !ownedBrowserAct.looksLikeMailInboxReview?.(t) &&
    !ownedBrowserAct.looksLikeMailDraftsReview?.(t) &&
    !ownedBrowserAct.looksLikeOpenMailItem?.(t) &&
    !ownedBrowserAct.looksLikeMailComposeTask?.(t) &&
    !ownedBrowserAct.looksLikeMailReplyTask?.(t) &&
    (!!ownedBrowserAct.looksLikePageQuestionAsk?.(t) ||
      !!ownedBrowserAct.looksLikeCasualConversation?.(t));
  if (conversationalOnLiveTab) {
    return "general";
  }
  // Casual chat with no live-tab work either — stay in conversation, not browse.
  if (
    !!ownedBrowserAct.looksLikeCasualConversation?.(t) &&
    !ownedBrowserAct.looksLikeBrowseActAsk?.(t) &&
    !extractedUrl &&
    !browseTarget
  ) {
    return "general";
  }
  // "youtube.com" / "i meant youtube" after a clarify ask — must navigate, not chat.
  if (
    siteClarifyUrl ||
    (opts.pendingBrowseClarify && (siteClarifyUrl || extractedUrl || browseTarget))
  ) {
    return "browse";
  }
  // "search pinterest for …" — named site + search verb → agent browser (not chat links).
  const namedSiteSearch =
    !!extractedUrl &&
    /\b(search|find(?:\s+me)?|look(?:\s+(?:for|up))?)\b/.test(lower);
  // The user named the product AND asked for work to happen in it. Say so
  // directly rather than hoping one of the verb patterns below happens to
  // match — an unfamiliar product ("in Klaviyo") resolves no browse target, so
  // the generic rules would drop it back into chat.
  const namedVenueWork =
    !!namedWorkVenue &&
    /\b(open|go|visit|launch|load|pull\s*up|head|navigate|log\s*in(?:to)?|sign\s*in(?:to)?|use|using|in|on|over)\b/.test(
      lower,
    );
  if (
    namedVenueWork ||
    !!ownedBrowserAct.looksLikeBrowseActAsk?.(t) ||
    /\b(click|navigate|browse|fill (out|in)|go to|visit|open up)\b/.test(lower) ||
    /\bopen\b.{0,40}\b(browser|page|site|tab|url|link|website|chart|diagram|graph)\b/.test(
      lower,
    ) ||
    /\b(open|visit|launch|load|pull up|show me|find|search)\b.{0,40}\bhttps?:\/\//i.test(t) ||
    /^https?:\/\//i.test(t) ||
    namedSiteSearch ||
    // "open lykn.io" / "go to lykn.io" / bare URL-ish goals
    (extractedUrl &&
      /\b(open|visit|go|check|look|find|search|click|fill|submit|browse|navigate|load|launch|take me|pull up|show)\b/.test(
        lower,
      )) ||
    (browseTarget &&
      /\b(open|visit|go|find|search|show|pull up|look|check|navigate|browse|launch|log\s*in(?:to)?|sign\s*in(?:to)?|review)\b/.test(
        lower,
      )) ||
    (extractedUrl && /^(https?:\/\/|www\.)/i.test(t.trim())) ||
    // Bare domain reply: "lykn.io" / "https://example.com"
    (extractedUrl && t.length <= 80)
  ) {
    return "browse";
  }
  if (extractedUrl && /\b(on that|this page|the site)\b/.test(lower)) {
    return "browse";
  }
  // Follow-ups that need UI work on an already-open owned tab.
  // Conversational page talk is handled above — don't force browse for "this page".
  if (
    opts.hasLiveTab &&
    !ownedBrowserAct.looksLikePageQuestionAsk?.(t) &&
    !ownedBrowserAct.looksLikeCasualConversation?.(t) &&
    (ownedBrowserAct.looksLikeCurrentTabTask(t) ||
      ownedBrowserAct.looksLikeInPageAction(t) ||
      ownedBrowserAct.looksLikeDeicticFollowUp?.(t) ||
      ownedBrowserAct.looksLikeOpenSearchResult(t))
  ) {
    return "browse";
  }
  // Already on mail — any email/inbox ask should scrape that tab, not chat generally.
  if (
    opts.hasLiveTab &&
    ownedBrowserAct.looksLikeSignedInMailUrl(opts.liveUrl) &&
    /\b(emails?|inbox|messages?|mail|gmail|reply|respond)\b/.test(lower)
  ) {
    return "browse";
  }
  // Edit / rewrite an existing draft through LYKN (even without saying "compose").
  {
    const onMail =
      !!opts.hasMailDraft ||
      ownedBrowserAct.looksLikeSignedInMailUrl(opts.liveUrl) ||
      !!ownedBrowserAct.isGmailComposeUrl?.(opts.liveUrl);
    if (
      onMail &&
      ownedBrowserAct.looksLikeMailDraftRevision(t, {
        hasMailDraft: !!opts.hasMailDraft,
        onMail,
      })
    ) {
      return "browse";
    }
  }
  return "general";
}

function titleFromGoal(goal) {
  const s = String(goal || "").trim().replace(/\s+/g, " ");
  if (!s) return "New agent";
  return s.slice(0, 48) + (s.length > 48 ? "…" : "");
}

/**
 * Does the ask refer to the screen/page the user is currently on?
 * ("make a report on this page", "write me a report on it" right after
 * pulling a site up, "build an artifact off what I'm looking at")
 * Bare pronouns ("it/this/that") only count when the agent has no prior
 * deliverable the pronoun could mean instead (report→artifact conversion
 * keeps priority).
 */
function referencesCurrentScreen(text, { hasPriorDeliverable = false } = {}) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  if (/\b(?:this|current|the|open|my)\s+(?:page|screen|site|tab|website|article|window)\b/.test(t)) {
    return true;
  }
  if (/\bwhat\s+i\s*(?:'|’)?m\s+(?:on|looking\s+at|viewing|reading)\b/.test(t)) return true;
  if (/\bwhat\s+am\s+i\s+(?:on|looking\s+at|viewing|reading)\b/.test(t)) return true;
  if (/\bon\s+(?:my|the)\s+screen\b/.test(t)) return true;
  if (/\bwhat\s+do\s+you\s+see\b/.test(t)) return true;
  if (/\bscreen\s+i\s*(?:'|’)?m\s+(?:in|on)\b/.test(t)) return true;
  if (/\bbased\s+(?:on|off)\s+(?:of\s+)?(?:this|it|that|my\s+screen|the\s+(?:page|screen|tab|site))\b/.test(t)) {
    return true;
  }
  if (!hasPriorDeliverable) {
    // Deliverable noun followed by a bare pronoun: "report on it",
    // "presentation about this", "summary of that".
    if (
      /\b(?:report|summary|write[- ]?up|analysis|artifact|presentation|deck|slides?|image|picture|graphic|webapp|app|website|dashboard|chart|infographic)\s+(?:based\s+)?(?:on|of|about|from|off)\s+(?:of\s+)?(?:this|it|that)\b/.test(
        t,
      )
    ) {
      return true;
    }
    if (/\b(?:turn|make|convert)\s+(?:this|it|that)\s+into\b/.test(t)) return true;
    if (/\b(?:on|of|about|from|off)\s+this\b/.test(t)) return true;
  }
  return false;
}

/**
 * Work a specialist (coding bot, research bot) uniquely owns. Main / LYKN
 * should still do the rest itself.
 */
const SPECIALIST_WORK_RE =
  /\b(?:implement|refactor|debug|rewrite|ship|deploy|open\s+a\s+pr|pull\s+request|write\s+(?:the\s+)?(?:code|tests?|pr)|fix\s+(?:the|this|that|a)?\s*(?:bug|issue|error|code)|codebase)\b/i;

const INSPECT_ASK_RE =
  /\b(?:what(?:'s|s|\s+is)\s+in(?:\s+(?:this|that|the|here|these))?(?:\s+folders?)?|what(?:'s|s|\s+is)\s+(?:this|that|the)\s+folder|what(?:'s|s|\s+is)\s+here|what(?:'s|s|\s+is)\s+inside|list\s+(?:the\s+)?(?:files?|contents?|folder)|just\s+list(?:\s+what(?:'s|s)\s+inside)?|summarize\s+(?:this|the|that)\s+folder|take\s+a\s+look\s+at\s+(?:this|the|that)\s+folder)\b/i;

const BARE_THIS_ASK_RE = /^what(?:'s|s|\s+is)\s+(?:this|that|it)\??$/i;

function looksLikeSpecialistWork(text) {
  return SPECIALIST_WORK_RE.test(String(text || ""));
}

/** "What's in this folder?" - Main can answer from a listing it already has. */
function looksLikeInspectAsk(text) {
  const t = String(text || "").trim();
  if (!t || looksLikeSpecialistWork(t)) return false;
  return INSPECT_ASK_RE.test(t) || BARE_THIS_ASK_RE.test(t);
}

/**
 * Does the ask name the site the agent's tab is on? ("write me a report on
 * stripe" while the tab is dashboard.stripe.com). Matches hostname tokens
 * (4+ chars, minus www/tld noise) as whole words in the ask.
 */
function askMentionsLiveSiteHost(text, url) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  let host = "";
  try {
    host = new URL(String(url || "")).hostname.replace(/^www\./i, "");
  } catch {
    return false;
  }
  const tokens = host
    .split(".")
    .filter((p) => p.length >= 4 && !/^(?:www\d?|com|net|org|info|co)$/i.test(p));
  return tokens.some((tok) =>
    new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t),
  );
}

module.exports = {
  looksLikeCreateInGoogleSheetsAsk,
  looksLikeBuildModeRefusal,
  formatToolVenueOpenLink,
  looksLikePasteReportIntoSheets,
  looksLikeArtifactConversion,
  normalizeAgentStepText,
  looksLikeDeliverableEdit,
  looksLikeRerunAsk,
  looksLikeOpenDeliverableFollowUp,
  shouldRouteDeliverableEdit,
  askNeedsFindingFirst,
  classifyAgentSkill,
  titleFromGoal,
  referencesCurrentScreen,
  looksLikeSpecialistWork,
  looksLikeInspectAsk,
  askMentionsLiveSiteHost,
};
