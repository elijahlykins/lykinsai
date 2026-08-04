/**
 * Glass Agent Mode runtime — parallel agents with per-agent streams,
 * skill routing (research / build / browse / monitor / general), and
 * LYKN-owned browser sessions.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const ownedBrowserAct = require("./ownedBrowserAct.cjs");
const artifactBuildIntent = require("../lib/artifactBuildIntent.cjs");
const {
  matchCreateInToolVenue,
  looksLikeCreateInToolVenueAsk,
  looksLikeEditCurrentInToolAsk,
  shouldOpenFreshVenueFile,
  toolStartUrlIsSpecific,
  toolVenueFromUrl,
  venueHasEditableSurface,
  resolveToolCreateStartUrl,
  venueLooksLikeWorkingSurface,
  buildToolDeepLinkSearchQuery,
  buildToolActAdaptiveGoal,
  stripShareSendTail,
  matchComplexSoftwareOffer,
  buildComplexSoftwareOfferMessage,
  complexSoftwareChoiceButtons,
  venueDeepLinkHost,
  extractToolCreateTopic,
} = require("../lib/agentToolVenues.cjs");
const {
  detectImageIntent,
  detectReferenceImageAsk,
} = require("../lib/imageGenIntent.cjs");
const { buildAgentPlan } = require("../lib/agentMultiStep.cjs");

/**
 * Compact Agent Mode doctrine — invent steps, use full chat + open app,
 * deep-link when possible, otherwise click through until the work is done.
 */
const AGENT_MODE_STEP_DOCTRINE =
  `Work the user's goal progressively: maintain a WORKING PLAN with DONE / NOW+CHECK / LATER. ` +
  `Only detail the NOW step from controls visible on the current screen; keep later phases as ` +
  `placeholders until those screens appear — never invent off-screen clicks. After each action, ` +
  `verify the CHECK, rewrite the plan from the new UI, then take the next NOW step. ` +
  `Use the ENTIRE chat plus the open tab/app as context: resolve "it/that/this/one", short asks ` +
  `("do it", "play it", "open that", "go ahead"), and continuations inside whatever software is open. ` +
  `For work in ANY external tool: (1) deep-link to the create/edit surface when you can, ` +
  `(2) if not, open the tool and click through menus/search until the right page, ` +
  `(3) actually do the ask, (4) report done or the blocker. Multi-step is expected. ` +
  `Prefer acting in the current app over Googling pronouns. Homepage/gallery alone is not done. ` +
  `Do not dismiss dialogs or click randomly. If stuck (login, paywall), say so clearly.`;

/** Worker agents (each owns a browser tab). Main orchestrator is extra.
 *  Keep in sync with MAX_AGENT_BROWSER_TABS in electron/main.cjs. */
const MAX_WORKER_AGENTS = 20;
/** Back-compat alias — total slots ≈ workers + pinned Main. */
const MAX_AGENTS = MAX_WORKER_AGENTS + 1;
const MAX_MONITOR_AGENTS = 3;
const MONITOR_POLL_MS = 15000;

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

/** Deliverable nouns for "turn this into a …" conversions. */
const ARTIFACT_CONVERT_NOUN =
  "artifact|webapp|app|page|dashboard|deck|presentation|slideshow|slides?|pitch(?:\\s*deck)?|interactive(?:\\s+(?:page|app|artifact|deck|presentation))?";

/** Content nouns for artifact budgets/trackers when NO external tool is named. */
const ARTIFACT_SHEETISH_NOUN_RE =
  /\b(budget|budgets|expenses?|income|ledger|tracker|planner|log|inventory|schedule|roster|timesheet|invoice|pipeline|crm|template|table|list|matrix|spreadsheet|worksheet)\b/i;

/**
 * Back-compat: Sheets-specific create (subset of tool-venue creates).
 * Prefer looksLikeCreateInToolVenueAsk / matchCreateInToolVenue for new code.
 */
function looksLikeCreateInGoogleSheetsAsk(text, opts = {}) {
  if (looksLikePasteReportIntoSheets(text)) return false;
  if (ownedBrowserAct.looksLikeOrganizeSheetAsk?.(text)) return false;
  const venue = matchCreateInToolVenue(text, opts);
  return !!(venue && (venue.id === "google-sheets" || venue.id === "excel"));
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
  if (
    /\b(another version|try again|regenerate|different (version|look|style|layout|theme))\b/.test(
      lower,
    )
  ) {
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
  if (looksLikeDeliverableEdit(text)) return true;
  const hasOpen =
    !!opts.hasArtifact || !!opts.hasReport || !!opts.hasImage || !!opts.deliverableKind;
  return hasOpen && looksLikeOpenDeliverableFollowUp(text);
}

function classifyAgentSkill(text, opts = {}) {
  const t = String(text || "").trim();
  const lower = t.toLowerCase();
  if (
    /\b(monitor|watch for|alert me|notify me when|keep an eye|tell me when)\b/.test(lower)
  ) {
    return "monitor";
  }
  // Must win over "research report" / "make a presentation" artifact matches.
  if (looksLikePasteReportIntoSheets(t)) {
    return "sheets-fill";
  }
  // Named tool venue ("in PowerPoint", "in Google Sheets") beats LYKN artifacts.
  // Edit-the-open-file asks are excluded inside looksLikeCreateInToolVenueAsk.
  if (
    !ownedBrowserAct.looksLikeOrganizeSheetAsk?.(t) &&
    !looksLikeEditCurrentInToolAsk(t) &&
    looksLikeCreateInToolVenueAsk(t, opts)
  ) {
    return "tool-create";
  }
  if (looksLikeArtifactConversion(t)) {
    return "build";
  }
  // "build me a presentation on the research report" is BUILD, not a new research crawl.
  // (Research regex matches build+…+report too eagerly.) Skip edit-style asks.
  if (
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
    /\b(deep research|research report|investigate thoroughly|multi-?source analysis)\b/.test(
      lower,
    ) ||
    (/^\s*research\b/.test(lower) && lower.length > 12) ||
    // "create a report on X" / "report comparing open-source models" — do it in Agent Mode
    /\b(create|write|produce|draft|prepare|give me|make me|build)\b.{0,48}\b(report|brief|analysis|comparison|overview|landscape)\b/.test(
      lower,
    ) ||
    /\b(report|brief|analysis|comparison|overview|landscape)\b.{0,40}\b(on|about|of|comparing|for)\b/.test(
      lower,
    )
  ) {
    return "research";
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
    !looksLikeCreateInToolVenueAsk(t, opts)
  ) {
    return "build";
  }
  // Image: "make me an ad like this" (esp. with a cropped reference).
  if (
    detectImageIntent(t, { hasAttachedImage: !!opts.hasAttachedImage }) ||
    detectReferenceImageAsk(t, !!opts.hasAttachedImage)
  ) {
    return "image";
  }
  if (
    /\b(generate|create|make|draw)\b.{0,40}\b(image|picture|photo|illustration|logo|poster|wallpaper|avatar|meme|ad|flyer|banner|thumbnail)\b/.test(
      lower,
    ) ||
    /\b(image of|picture of|photo of)\b/.test(lower)
  ) {
    return "image";
  }
  if (
    !looksLikeCreateInToolVenueAsk(t, opts) &&
    (/\b(build|create|make|scaffold|code)\b.{0,40}\b(app|page|dashboard|deck|artifact|landing|tool|spreadsheet|worksheet|site|webapp|presentation|slideshow|slides?|calculator|quiz|tracker|form|widget|portal|simulator)\b/.test(
      lower,
    ) ||
      /\b(build me|code me)\b/.test(lower))
  ) {
    return "build";
  }
  // "create me a budget" (no external tool named) → LYKN artifact.
  if (
    !looksLikeCreateInToolVenueAsk(t, opts) &&
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
  // Live tab + informational ask → scrape the page and answer. Do NOT start a
  // click/plan loop for "what's my spend?", "summarize this", "check my metrics".
  // Mail inbox/drafts keep the specialized browse scrape path.
  const pageQuestionOnLiveTab =
    !!opts.hasLiveTab &&
    !!ownedBrowserAct.looksLikePageQuestionAsk?.(t) &&
    !ownedBrowserAct.looksLikeBrowseActAsk?.(t) &&
    !ownedBrowserAct.looksLikeMailInboxReview?.(t) &&
    !ownedBrowserAct.looksLikeMailDraftsReview?.(t) &&
    !ownedBrowserAct.looksLikeOpenMailItem?.(t) &&
    !ownedBrowserAct.looksLikeMailComposeTask?.(t) &&
    !ownedBrowserAct.looksLikeMailReplyTask?.(t);
  if (pageQuestionOnLiveTab) {
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
  if (
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
  // Follow-ups on an already-open owned tab ("here", inbox review, "do it", click a result…).
  if (
    opts.hasLiveTab &&
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
  if (/\b(?:this|current|the|open)\s+(?:page|screen|site|tab|website|article|window)\b/.test(t)) {
    return true;
  }
  if (/\bwhat\s+i\s*(?:'|’)?m\s+(?:on|looking\s+at|viewing|reading)\b/.test(t)) return true;
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

function createAgentRuntime(deps) {
  const {
    userDataPath,
    apiBase,
    getAuthToken,
    readStreamResponse,
    emit,
    ensureBrowserWindow,
    destroyBrowserWindow,
    showBrowserWindow,
    hideBrowserWindow,
    hideAllBrowserWindows,
    browserWindowExists,
    getBrowserWebContents,
    planOwnedBrowserNext,
    isContentProtectionEnabled,
    openStageArtifact,
    destroyOwnedArtifactTabs,
    focusOverlayComposer,
    notifyAgentFinished,
    // Optional: returns a short, private summary of the user's browsing habits
    // (from Chrome sync) to fold into agent prompts. Never shown to the user.
    getBrowsingContext,
  } = deps;

  /** @type {Map<string, any>} */
  const agents = new Map();
  let activeAgentId = null;
  let agentModeOn = false;
  let persistTimer = null;

  function agentsPath() {
    return path.join(userDataPath, "overlay-agents.json");
  }

  function publicAgent(a) {
    if (!a) return null;
    const role = a.role === "main" ? "main" : "worker";
    return {
      id: a.id,
      title: a.title,
      status: a.status,
      skill: a.skill || "general",
      url: a.url || "",
      step: a.step || "",
      partialText: a.partialText || "",
      updatedAt: a.updatedAt,
      createdAt: a.createdAt,
      busy: !!a.busy,
      error: a.error || "",
      role,
      pinned: role === "main" || !!a.pinned,
    };
  }

  function isMainAgent(a) {
    return !!(a && a.role === "main");
  }

  function getMainAgent() {
    for (const a of agents.values()) {
      if (isMainAgent(a)) return a;
    }
    return null;
  }

  function workerAgents() {
    return [...agents.values()].filter((a) => !isMainAgent(a));
  }

  function workerCount() {
    return workerAgents().length;
  }

  /** Browser tab the Main chat is currently watching (may differ from activeAgentId). */
  let mainLinkedBrowserId = "";

  function setMainLinkedBrowser(agentId) {
    const id = String(agentId || "").trim();
    if (id && agents.has(id) && !isMainAgent(agents.get(id))) {
      mainLinkedBrowserId = id;
    } else if (!id) {
      mainLinkedBrowserId = "";
    }
    return mainLinkedBrowserId;
  }

  function formatRosterForMain() {
    const workers = workerAgents();
    if (!workers.length) {
      return "No sub-agents yet. The user can click + New (or + on the browser) to add one.";
    }
    return workers
      .map((w, i) => {
        const liveUrl = (() => {
          try {
            return getBrowserWebContents?.(w.id)?.getURL?.() || w.url || "";
          } catch {
            return w.url || "";
          }
        })();
        const bits = [
          `${i + 1}. “${w.title}” (id:${w.id.slice(0, 8)})`,
          `status=${w.status}${w.busy ? "/busy" : ""}`,
          w.skill ? `skill=${w.skill}` : "",
          w.step ? `step=${String(w.step).slice(0, 60)}` : "",
          liveUrl ? `url=${liveUrl}` : "url=(empty tab)",
          w.lastDeliverableKind ? `deliverable=${w.lastDeliverableKind}` : "",
          String(w.lastResearchReport || "").trim().length > 40 ? "has_report=yes" : "",
          ownedBrowserAct.looksLikeGoogleSheetsUrl?.(liveUrl) ? "sheets=yes" : "",
        ].filter(Boolean);
        return bits.join(" · ");
      })
      .join("\n");
  }

  function getWorkerResearchMarkdown(worker) {
    if (!worker) return "";
    const direct = String(worker.lastResearchReport || "").trim();
    if (direct.length > 40) return direct;
    const dels = Array.isArray(worker.stepDeliverables) ? worker.stepDeliverables : [];
    for (let i = dels.length - 1; i >= 0; i--) {
      const md = String(dels[i]?.markdown || "").trim();
      const kind = String(dels[i]?.kind || dels[i]?.skill || "");
      if (md.length > 40 && (/report|research/i.test(kind) || md.length > 200)) {
        return md;
      }
    }
    const hist = Array.isArray(worker.history) ? worker.history : [];
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i]?.role !== "assistant") continue;
      // Prefer full content over Glass status line.
      const body = String(hist[i].content || "").trim();
      const glass = String(hist[i].glass || "").trim();
      if (body.length > 120 && body !== glass && !/^Finished —/i.test(body)) {
        return body;
      }
    }
    return "";
  }

  function findWorkerWithResearchReport() {
    const workers = workerAgents();
    const scored = [];
    for (const w of workers) {
      const md = getWorkerResearchMarkdown(w);
      if (!md) continue;
      scored.push({
        worker: w,
        md,
        at: String(w.updatedAt || w.createdAt || ""),
        linked: w.id === mainLinkedBrowserId,
        kindReport: w.lastDeliverableKind === "report",
      });
    }
    scored.sort((a, b) => {
      if (a.linked !== b.linked) return a.linked ? -1 : 1;
      if (a.kindReport !== b.kindReport) return a.kindReport ? -1 : 1;
      return b.at.localeCompare(a.at);
    });
    return scored[0] || null;
  }

  function findWorkerWithSheetsTab() {
    const workers = workerAgents();
    const hit = [];
    for (const w of workers) {
      let url = String(w.url || "");
      try {
        const live = getBrowserWebContents?.(w.id)?.getURL?.() || "";
        if (live) url = live;
      } catch {
        /* ignore */
      }
      if (!ownedBrowserAct.looksLikeGoogleSheetsUrl?.(url)) continue;
      hit.push({
        worker: w,
        url,
        at: String(w.updatedAt || w.createdAt || ""),
        linked: w.id === mainLinkedBrowserId,
        blank: /\/create\b|spreadsheets\/u\/\d+\/?$/i.test(url),
      });
    }
    hit.sort((a, b) => {
      if (a.linked !== b.linked) return a.linked ? -1 : 1;
      if (a.blank !== b.blank) return a.blank ? -1 : 1;
      return b.at.localeCompare(a.at);
    });
    return hit[0] || null;
  }

  /**
   * Combine sibling agents: paste an existing research report into an open Google Sheet.
   * Never re-runs deep research.
   */
  async function runCombineReportIntoSheets(hostAgent, text) {
    const reportHit = findWorkerWithResearchReport();
    if (!reportHit?.md) {
      const msg =
        "I couldn't find a finished research report on any sub-agent.\n\n" +
        "Run research first (or click that agent's tab), then ask me to put it into the sheet.";
      return { ok: false, error: "no_report", message: msg };
    }

    let sheetsHit = findWorkerWithSheetsTab();
    // No Sheets tab yet — open a blank sheet on the report agent only if it isn't
    // already holding a non-Sheets live page we shouldn't clobber… prefer a free worker.
    if (!sheetsHit) {
      let target =
        workerAgents().find(
          (w) =>
            w.id !== reportHit.worker.id &&
            !w.busy &&
            (!w.url || ownedBrowserAct.isPlaceholderAgentUrl(w.url)),
        ) || reportHit.worker;
      const createUrl =
        ownedBrowserAct.resolveNewBlankWorkspaceUrl?.("open a blank sheet") ||
        "https://docs.google.com/spreadsheets/create";
      ensureBrowserWindow?.(target.id, { show: false });
      const wc0 = getBrowserWebContents?.(target.id);
      if (!wc0) {
        return {
          ok: false,
          error: "no_browser",
          message: "Couldn't open a browser tab for Google Sheets.",
        };
      }
      showBrowserWindow?.(target.id, {
        focus: false,
        label: target.title || "Agent",
      });
      const nav = await ownedBrowserAct.navigate(wc0, createUrl);
      if (!nav?.ok) {
        return {
          ok: false,
          error: nav?.error || "nav_failed",
          message: "Couldn't open a blank Google Sheet.",
        };
      }
      target.url = nav.url || createUrl;
      target.lastBrowseUrl = target.url;
      sheetsHit = { worker: target, url: target.url, blank: true };
    }

    const sheetsWorker = sheetsHit.worker;
    setMainLinkedBrowser(sheetsWorker.id);
    ensureBrowserWindow?.(sheetsWorker.id, { show: true });
    const wc = getBrowserWebContents?.(sheetsWorker.id);
    if (!wc) {
      return {
        ok: false,
        error: "no_browser",
        message: "Couldn't reach the Google Sheets tab.",
      };
    }

    showBrowserWindow?.(sheetsWorker.id, {
      focus: true,
      label: sheetsWorker.title || "Sheets",
    });
    try {
      syncAgentBrowserTabs({ focusId: sheetsWorker.id, activate: true });
    } catch {
      /* ignore */
    }

    // Stay on / return to a Sheets URL (create → real doc after redirect).
    let url = sheetsHit.url;
    try {
      url = wc.getURL?.() || url;
    } catch {
      /* ignore */
    }
    if (!ownedBrowserAct.looksLikeGoogleSheetsUrl?.(url)) {
      const createUrl =
        ownedBrowserAct.resolveNewBlankWorkspaceUrl?.("open a blank sheet") ||
        "https://docs.google.com/spreadsheets/create";
      const nav = await ownedBrowserAct.navigate(wc, createUrl);
      if (!nav?.ok) {
        return {
          ok: false,
          error: "not_sheets",
          message: "That tab isn't Google Sheets — open a sheet, then ask again.",
        };
      }
      sheetsWorker.url = nav.url || createUrl;
    }

    await ownedBrowserAct.waitForLoad?.(wc, 12000).catch(() => {});
    await ownedBrowserAct.waitForDomSettle?.(wc, 1200).catch(() => {});

    const reportTitle = `${reportHit.worker.title || "Research"} report`;
    const filled = await ownedBrowserAct.fillGoogleSheetFromText(wc, {
      text: reportHit.md,
      title: reportTitle,
    });
    if (!filled?.ok) {
      return {
        ok: false,
        error: filled?.error || "fill_failed",
        message:
          `I found **${reportHit.worker.title}**'s research report and the Sheets tab, ` +
          `but couldn't paste into the grid (${filled?.error || "paste failed"}).\n\n` +
          `Click inside cell A1 in that sheet and ask me to try again.`,
      };
    }

    try {
      sheetsWorker.url = wc.getURL?.() || sheetsWorker.url;
    } catch {
      /* ignore */
    }
    // Remember pasted body — Sheets canvas scrapes look blank later ("organize the sheet").
    sheetsWorker.lastSheetText = String(filled.text || reportHit.md || "").slice(0, 120000);
    sheetsWorker.lastSheetSource = reportHit.worker.title || "research report";
    sheetsWorker.lastDeliverableKind = "sheets";
    sheetsWorker.updatedAt = new Date().toISOString();
    sheetsWorker.step = "Filled sheet from research report";
    sheetsWorker.status = "idle";

    const msg =
      `Filled the Google Sheet from **${reportHit.worker.title}**'s research report` +
      (sheetsWorker.id !== reportHit.worker.id
        ? ` (into **${sheetsWorker.title}**'s tab)`
        : "") +
      `.\n\n` +
      `Pasted ~${filled.lines || "?"} lines into the sheet — tweak formatting there if you want.`;
    return {
      ok: true,
      message: msg,
      reportAgentId: reportHit.worker.id,
      sheetsAgentId: sheetsWorker.id,
      lines: filled.lines,
    };
  }

  function getKnownSheetText(agent) {
    const direct = String(agent?.lastSheetText || "").trim();
    if (direct.length > 20) return direct;
    // Sibling research report (combine may have pasted into this tab without updating memory yet).
    const hit = findWorkerWithResearchReport();
    if (hit?.md && hit.worker?.id !== agent?.id) return String(hit.md).trim();
    if (hit?.md && hit.worker?.id === agent?.id) return String(hit.md).trim();
    return "";
  }

  /**
   * Re-structure known sheet contents and paste back — Sheets DOM scrapes are blank.
   */
  async function runOrganizeSheet(agent, text, gen) {
    ensureBrowserWindow?.(agent.id, { show: true });
    const wc = getBrowserWebContents?.(agent.id);
    if (!wc) {
      return paintBrowseDone(
        agent,
        "I couldn't reach this agent's browser tab to organize the sheet.",
      );
    }

    let url = getLiveTabUrl(agent, wc) || agent.url || "";
    if (!ownedBrowserAct.looksLikeGoogleSheetsUrl?.(url)) {
      const sheetsHit = findWorkerWithSheetsTab();
      if (sheetsHit?.worker) {
        return runOrganizeSheet(sheetsHit.worker, text, gen);
      }
      return paintBrowseDone(
        agent,
        "Open a Google Sheet in this agent's browser first, then ask me to organize it.",
      );
    }

    let content = getKnownSheetText(agent);
    if (!content) {
      const hit = findWorkerWithResearchReport();
      if (hit?.md) content = hit.md;
    }
    if (!content || content.length < 20) {
      return paintBrowseDone(
        agent,
        "Google Sheets doesn't expose cell values to the page scrape, and I don't have " +
          "the pasted research text remembered for this tab yet.\n\n" +
          "Ask Main to put the research report into the sheet again, then say “organize the sheet”.",
      );
    }

    showBrowserWindow?.(agent.id, { focus: true, label: agent.title || "Sheets" });
    try {
      syncAgentBrowserTabs({ focusId: agent.id, activate: true });
    } catch {
      /* ignore */
    }
    emitProgress(agent.id, {
      status: "running",
      step: "Organizing sheet…",
      url,
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Organizing sheet…" });

    const organizePrompt =
      `Reorganize the following Google Sheet contents into a clean spreadsheet layout.\n` +
      `Return ONLY tab-separated values (TSV): first row = headers, then data rows.\n` +
      `Use columns like Section | Detail (add more columns if useful: Source, Status, Notes).\n` +
      `No markdown fences, no commentary — TSV only.\n\n` +
      `User ask: ${String(text || "").trim()}\n\n` +
      `SHEET CONTENTS (already in the tab — do not claim blank):\n` +
      content.slice(0, 12000);

    let organized = "";
    try {
      organized = await streamChat(agent, organizePrompt, [], "browse-summary", gen, {
        suppressDone: true,
      });
    } catch (e) {
      return paintBrowseDone(
        agent,
        `Couldn't organize the sheet: ${e?.message || "model error"}`,
      );
    }

    let tsv = String(organized || "")
      .replace(/^```(?:tsv|csv|text)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    // If the model still wrapped with prose, keep lines that look like rows.
    if (!tsv.includes("\t") && tsv.includes(",")) {
      tsv = tsv
        .split("\n")
        .map((line) => line.replace(/,/g, "\t"))
        .join("\n");
    }
    if (tsv.length < 8) {
      return paintBrowseDone(
        agent,
        "I still have the sheet data, but couldn't produce a clean organized layout. Try “organize into columns: topic, summary”.",
      );
    }

    await ownedBrowserAct.waitForDomSettle?.(wc, 600).catch(() => {});
    const filled = await ownedBrowserAct.fillGoogleSheetFromText(wc, {
      text: tsv,
      replaceAll: true,
    });
    if (!filled?.ok) {
      return paintBrowseDone(
        agent,
        `I organized the data but couldn't paste it back (${filled?.error || "paste failed"}).\n\n` +
          `Click cell A1 and ask me to try again.`,
      );
    }

    agent.lastSheetText = String(filled.text || tsv).slice(0, 120000);
    agent.lastDeliverableKind = "sheets";
    agent.url = wc.getURL?.() || url;
    agent.updatedAt = new Date().toISOString();
    return paintBrowseDone(
      agent,
      `Reorganized the sheet into a cleaner table (~${filled.lines || "?"} rows) and pasted it back into Google Sheets.\n\n` +
        `What next — filters, more columns, or a chart?`,
    );
  }

  function stripModelFences(raw) {
    return String(raw || "")
      .replace(/^```(?:tsv|csv|text|markdown|md)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
  }

  /**
   * Draft plain text/TSV for an already-open external tool.
   * Uses toolDraft so the API never redirects to Glass Build/Create.
   */
  async function draftToolPlainText(agent, genPrompt, gen, venueName) {
    const first = stripModelFences(
      await streamChat(agent, genPrompt, [], "browse-summary", gen, {
        suppressDone: true,
        toolDraft: true,
        toolDraftVenue: venueName || "",
      }),
    );
    if (!looksLikeBuildModeRefusal(first) && first.length >= 20) return first;
    const retryPrompt =
      `${genPrompt}\n\n` +
      `[CRITICAL — previous reply wrongly told the user to switch Build/Create modes. ` +
      `${venueName || "The tool"} is ALREADY open in Agent Mode. ` +
      `Output ONLY the requested document/table/outline body now. ` +
      `No menus, no modes, no preamble, no "resend".]`;
    return stripModelFences(
      await streamChat(agent, retryPrompt, [], "browse-summary", gen, {
        suppressDone: true,
        toolDraft: true,
        toolDraftVenue: venueName || "",
      }),
    );
  }

  /**
   * Land on the best start URL for a tool create:
   * 1) known deep link when we already have a specific create/edit URL
   * 2) else silent Google hunt for a deep link on that host
   * 3) else tool home / known fallback — adaptive click-through finishes inside the app
   * User never sees the SERP ("Opening {Tool}…").
   */
  async function discoverSilentToolStartUrl(agent, venue, text, gen, wc) {
    const fallback =
      resolveToolCreateStartUrl(venue, text) || venue.createUrl || "";
    const host = venueDeepLinkHost(venue);
    const topic = extractToolCreateTopic(text, venue);
    const query = buildToolDeepLinkSearchQuery(venue, text);
    const openLabel = `Opening ${venue.name}…`;

    // Skip Google when we already have a category create/edit deep link.
    const shouldSearch =
      !!query &&
      !!host &&
      !toolStartUrlIsSpecific(fallback, venue) &&
      (venue.fill === "navigate-brief" || !fallback);

    async function landOn(url, via) {
      const target = url || fallback || (host ? `https://${host}` : "");
      if (!target) return { url: "", via: "failed", error: "no_start_url" };
      emitProgress(agent.id, {
        status: "running",
        step: openLabel,
        url: "",
        skill: "tool-create",
      });
      const land = await ownedBrowserAct.navigate(wc, target);
      if (!land?.ok) {
        if (target !== fallback && fallback) {
          const retry = await ownedBrowserAct.navigate(wc, fallback);
          if (retry?.ok) {
            return { url: retry.url || fallback, via: "known-fallback" };
          }
        }
        return { url: "", via: "failed", error: land?.error || "navigation failed" };
      }
      return { url: land.url || target, via };
    }

    if (!shouldSearch) {
      return landOn(fallback, "known");
    }

    emitProgress(agent.id, {
      status: "running",
      step: openLabel,
      url: "", // hide Google SERP from the UI chrome
      skill: "tool-create",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", { status: openLabel });
    showBrowserWindow?.(agent.id, { focus: false, label: agent.title || venue.name });

    const serpUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const serpNav = await ownedBrowserAct.navigate(wc, serpUrl);
    if (!serpNav?.ok) {
      return landOn(fallback, "known-fallback");
    }

    await ownedBrowserAct
      .waitForSearchResultsReady?.(wc, {
        hint: topic || venue.name,
        timeoutMs: 2200,
        pollMs: 160,
      })
      .catch(() => null);

    if (gen !== agent.generation) return { url: "", via: "aborted" };

    // Prefer create/blank/edit paths from the topic — not a templates-gallery bias.
    const preferPath =
      String(topic || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .trim()
        .split(/\s+/)[0] || "create";

    const peek = await ownedBrowserAct
      .peekVenueDeepLinkFromSerp?.(wc, {
        hostIncludes: host,
        hint: `${topic} create blank new ${preferPath}`.trim(),
        preferPath,
      })
      .catch(() => null);

    const deep =
      peek?.ok && peek.href && /^https?:\/\//i.test(peek.href) ? peek.href : "";

    let chosen = fallback;
    let via = "known";
    if (deep) {
      try {
        const pathName = new URL(deep).pathname || "/";
        const deepOk =
          pathName.length > 2 &&
          !/\/(login|signup|pricing|pro)(\/|$)/i.test(pathName) &&
          (peek.score >= 2 ||
            /create|blank|new|design|edit|template|doc|file/i.test(deep));
        if (deepOk) {
          chosen = deep;
          via = "silent-search";
        }
      } catch {
        /* keep fallback */
      }
    }

    return landOn(chosen, via);
  }

  /**
   * Complex software (Canva, Figma, 3D, …): pause and let the user pick
   * "Use custom artifact" or "No, just stop here" instead of a bad click-through.
   */
  function offerComplexSoftwareChoice(agent, text, offer) {
    const choiceId = newId();
    const msg = buildComplexSoftwareOfferMessage(offer);
    const buttons = complexSoftwareChoiceButtons();
    agent.pendingChoice = {
      id: choiceId,
      type: "complex-tool",
      originalAsk: String(text || "").trim(),
      artifactAsk: String(offer?.artifactAsk || "").trim(),
      venueId: offer?.venue?.id || "",
      softwareName: offer?.softwareName || "",
      deliverableLabel: offer?.deliverableLabel || "",
      buttons,
      at: new Date().toISOString(),
    };
    agent.partialText = msg;
    agent.status = "waiting";
    agent.step = "Waiting for your choice…";
    agent.skill = "complex-offer";
    agent.lastDeliverableKind = "";
    sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg, final: true });
    sendToAgentChannels(agent.id, "lykn:agent-choice", {
      choiceId,
      type: "complex-tool",
      message: msg,
      buttons,
      softwareName: offer?.softwareName || "",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", {
      status: "Waiting for your choice…",
    });
    emitProgress(agent.id, {
      status: "waiting",
      step: "Waiting for your choice…",
      skill: "complex-offer",
    });
    return msg;
  }

  /**
   * Create inside a named external tool (PowerPoint, Sheets, Canva, …) — not a LYKN artifact.
   * "create me a presentation in powerpoint" / "go to google sheets and create a budget"
   */
  async function runCreateInToolVenue(agent, text, gen) {
    const liveUrl =
      getLiveTabUrl(agent, getBrowserWebContents?.(agent.id)) || agent.url || "";
    const complexOffer = matchComplexSoftwareOffer(text, { liveUrl });
    if (complexOffer && !agent.skipComplexGateOnce) {
      return offerComplexSoftwareChoice(agent, text, complexOffer);
    }
    if (agent.skipComplexGateOnce) agent.skipComplexGateOnce = false;

    const venue =
      matchCreateInToolVenue(text, { liveUrl }) ||
      toolVenueFromUrl(agent.url) ||
      matchCreateInToolVenue(text, {});
    if (!venue) {
      return paintBrowseDone(
        agent,
        "Tell me which tool to use (PowerPoint, Google Sheets, Canva, …) or ask without a tool name for a LYKN artifact.",
      );
    }

    ensureBrowserWindow?.(agent.id, { show: true });
    const wc = getBrowserWebContents?.(agent.id);
    if (!wc) {
      return paintBrowseDone(agent, `Couldn't open a browser tab for ${venue.name}.`);
    }

    let url = getLiveTabUrl(agent, wc) || agent.url || "";
    // Rule: in a tool, CREATE always opens a brand-new file. EDIT the open thing
    // never reaches here (matchCreateInToolVenue returns null for edit asks).
    const openFresh = shouldOpenFreshVenueFile(text, venue, url);
    const knownStart =
      resolveToolCreateStartUrl(venue, text) || venue.createUrl || "";
    const needsCreateNav =
      openFresh ||
      !venue.urlMatch.test(url || "") ||
      (venue.fill === "navigate-brief" && !venueLooksLikeWorkingSurface(venue, url));
    if (needsCreateNav) {
      const openLabel = openFresh
        ? `Opening a new ${venue.name}…`
        : `Opening ${venue.name}…`;
      emitProgress(agent.id, {
        status: "running",
        step: openLabel,
        url: "",
        skill: "tool-create",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", {
        status: openLabel,
      });
      showBrowserWindow?.(agent.id, { focus: false, label: agent.title || venue.name });

      // Magic: silently find a deep link (Google → venue templates/create), then land.
      // Paste venues (Docs/Sheets) keep their known /create URLs — no SERP needed.
      let landed = "";
      if (
        venue.fill === "navigate-brief" ||
        (!venueHasEditableSurface(venue, knownStart) &&
          !/\/(?:document|spreadsheets|presentation)\/create\b/i.test(knownStart))
      ) {
        const discovered = await discoverSilentToolStartUrl(agent, venue, text, gen, wc);
        if (gen !== agent.generation) return "";
        if (discovered?.error && !discovered.url) {
          return paintBrowseDone(
            agent,
            `Couldn't open ${venue.name} (${discovered.error}).`,
          );
        }
        landed = discovered?.url || knownStart;
      } else {
        const nav = await ownedBrowserAct.navigate(wc, knownStart);
        if (!nav?.ok) {
          return paintBrowseDone(
            agent,
            `Couldn't open ${venue.name} (${nav?.error || "navigation failed"}).`,
          );
        }
        landed = nav.url || knownStart;
      }

      agent.url = landed || knownStart;
      url = agent.url;
      await ownedBrowserAct.waitForLoad?.(wc, 14000).catch(() => {});
      // /create redirects into /d/…/edit — wait for a real editable surface before paste.
      if (
        venue.fill === "sheets-tsv" ||
        venue.fill === "docs-text" ||
        venue.fill === "slides-outline"
      ) {
        const start = Date.now();
        while (Date.now() - start < 12000) {
          const live = wc.getURL?.() || "";
          if (venueHasEditableSurface(venue, live) && !/\/(?:create|new)\b/i.test(live)) {
            agent.url = live;
            url = live;
            break;
          }
          await new Promise((r) => setTimeout(r, 280));
        }
      }
      await ownedBrowserAct.waitForDomSettle?.(wc, 900).catch(() => {});
      url = wc.getURL?.() || agent.url || url;
      agent.url = url;
      emitProgress(agent.id, {
        status: "running",
        step: openLabel,
        url: agent.url,
        skill: "tool-create",
      });
    }

    showBrowserWindow?.(agent.id, { focus: true, label: agent.title || venue.name });
    try {
      syncAgentBrowserTabs({ focusId: agent.id, activate: true });
      setMainLinkedBrowser(agent.id);
    } catch {
      /* ignore */
    }

    // Pause if sign-in wall (Office / Google / Canva).
    {
      const pause = await pauseForUserSignIn(agent, gen, wc, {
        context: `opening ${venue.name}`,
      });
      if (pause.blocked && !pause.cleared) {
        return pause.message || "";
      }
    }

    // Paywall / upgrade gate — tell the user clearly (don't silently thrash).
    {
      let page = { url: agent.url, text: "", title: "" };
      try {
        page = await ownedBrowserAct.getPageContext(wc);
      } catch {
        /* ignore */
      }
      const pageUrl = page.url || wc.getURL?.() || agent.url || "";
      if (
        ownedBrowserAct.looksLikePaywall?.({
          url: pageUrl,
          text: page.text,
          title: page.title || wc.getTitle?.() || "",
        })
      ) {
        agent.url = pageUrl;
        const link = formatToolVenueOpenLink(pageUrl, venue.name);
        return paintBrowseDone(
          agent,
          `I opened **${venue.name}** for your ask, but hit a **paywall / upgrade screen**.\n\n` +
            `**Ask:** ${String(text || "").trim()}\n\n` +
            `Sign in / upgrade in the agent browser if you want, then tell me to continue — or pick a free template and I’ll keep going.\n\n` +
            `${link || pageUrl}`,
        );
      }
    }

    emitProgress(agent.id, {
      status: "running",
      step: `Building in ${venue.name}…`,
      url: agent.url || url,
      skill: "tool-create",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", {
      status: `Building in ${venue.name}…`,
    });

    const ask = String(text || "").trim();

    if (venue.fill === "sheets-tsv") {
      const genPrompt =
        `The user wants this built INSIDE ${venue.name} (not a LYKN artifact / webapp).\n` +
        `${venue.name} is already open in Agent Mode — draft the content to paste now.\n` +
        `Produce a practical spreadsheet as TSV (tab-separated values) only.\n` +
        `First row = column headers. Then realistic starter rows the user can edit.\n` +
        `Include formulas as plain text where helpful (e.g. =SUM(B2:B20)).\n` +
        `No markdown fences, no commentary, no Build/Create mode instructions — TSV only.\n\n` +
        `User ask:\n${ask}`;
      let tsv = "";
      try {
        tsv = await draftToolPlainText(agent, genPrompt, gen, venue.name);
      } catch (e) {
        return paintBrowseDone(
          agent,
          `Opened ${venue.name} but couldn't generate the table: ${e?.message || "error"}`,
        );
      }
      if (looksLikeBuildModeRefusal(tsv)) {
        return paintBrowseDone(
          agent,
          `Opened ${venue.name}, but drafting failed. Ask me again to fill the sheet.`,
        );
      }
      if (!tsv.includes("\t") && tsv.includes(",")) {
        tsv = tsv
          .split("\n")
          .map((line) => line.replace(/,/g, "\t"))
          .join("\n");
      }
      if (tsv.length < 8) {
        return paintBrowseDone(
          agent,
          `Opened ${venue.name}, but I couldn't produce a usable table. Try being more specific about columns.`,
        );
      }
      emitProgress(agent.id, {
        status: "running",
        step: `Pasting into ${venue.name}…`,
        url: agent.url || url,
        skill: "tool-create",
      });
      const filled =
        venue.id === "excel"
          ? await ownedBrowserAct.pasteTextIntoPage(wc, { text: tsv, replaceAll: true })
          : await ownedBrowserAct.fillGoogleSheetFromText(wc, {
              text: tsv,
              replaceAll: true,
            });
      if (!filled?.ok) {
        agent.lastSheetText = tsv.slice(0, 120000);
        agent.lastDeliverableKind = "sheets";
        return paintBrowseDone(
          agent,
          `Built the table for ${venue.name} but couldn't paste (${filled?.error || "paste failed"}).\n\n` +
            `Click the grid and ask me to paste again.`,
        );
      }
      agent.lastSheetText = String(filled.text || tsv).slice(0, 120000);
      agent.lastSheetSource = `created in ${venue.name}`;
      agent.lastDeliverableKind = "sheets";
      agent.url = wc.getURL?.() || agent.url || url;
      const sheetLink = formatToolVenueOpenLink(agent.url, venue.name);
      return paintBrowseDone(
        agent,
        `Created it in **${venue.name}** (~${filled.lines || "?"} rows) and pasted into the grid.\n\n` +
          `${sheetLink || agent.url || ""}\n\nWhat next?`,
      );
    }

    if (venue.fill === "docs-text") {
      const genPrompt =
        `The user wants this written INSIDE ${venue.name} (already open in Agent Mode).\n` +
        `Return the FULL document body as plain text (light markdown ok).\n` +
        `First line = a short document title, then a blank line, then the body.\n` +
        `Do NOT mention Build mode, Create mode, Glass, menus, or resending.\n` +
        `No code fences. No preamble. No meta commentary — essay/doc text only.\n\n` +
        `User ask:\n${ask}`;
      let body = "";
      try {
        body = await draftToolPlainText(agent, genPrompt, gen, venue.name);
      } catch (e) {
        return paintBrowseDone(
          agent,
          `Opened ${venue.name} but couldn't draft the doc: ${e?.message || "error"}`,
        );
      }
      if (body.length < 20 || looksLikeBuildModeRefusal(body)) {
        return paintBrowseDone(
          agent,
          `Opened ${venue.name}, but the draft came back empty. Ask me again to write it in the doc.`,
        );
      }
      emitProgress(agent.id, {
        status: "running",
        step: `Pasting into ${venue.name}…`,
        url: agent.url || url,
        skill: "tool-create",
      });
      // Wait for Docs editor chrome (kix) before the first paste attempt.
      await ownedBrowserAct.waitForDomSettle?.(wc, 1600).catch(() => {});
      let filled = await ownedBrowserAct.pasteTextIntoPage(wc, {
        text: body,
        replaceAll: true,
      });
      if (!filled?.ok) {
        // Slow editors may not have the surface ready yet — settle and retry.
        await ownedBrowserAct.waitForDomSettle?.(wc, 2500).catch(() => {});
        await ownedBrowserAct.focusPageEditor?.(wc).catch(() => {});
        filled = await ownedBrowserAct.pasteTextIntoPage(wc, {
          text: body,
          replaceAll: true,
        });
      }
      agent.lastSheetText = body.slice(0, 120000);
      agent.lastSheetSource = `created in ${venue.name}`;
      agent.lastDeliverableKind = "sheets";
      agent.url = wc.getURL?.() || agent.url || url;
      const docLink = formatToolVenueOpenLink(agent.url, venue.name);
      if (!filled?.ok) {
        // Last resort: adaptive click into the body with the draft in-goal.
        emitProgress(agent.id, {
          status: "running",
          step: `Clicking into ${venue.name} to write…`,
          url: agent.url,
          skill: "tool-create",
        });
        try {
          const adaptiveGoal = buildToolActAdaptiveGoal(venue, ask, { draft: body });
          const browseResult = await runAdaptiveBrowse(agent, adaptiveGoal, gen, wc, {
            suppressDone: true,
            maxRounds: 10,
            returnRaw: true,
            adaptiveGoal,
            conversationHistory: historyForPlanner(agent),
          });
          agent.url = wc.getURL?.() || agent.url;
          if (!browseResult?.stuck) {
            // Try paste again after adaptive focused the body.
            filled = await ownedBrowserAct.pasteTextIntoPage(wc, {
              text: body,
              replaceAll: true,
            });
          }
        } catch {
          /* keep filled failure */
        }
      }
      if (!filled?.ok) {
        return paintBrowseDone(
          agent,
          `Drafted the doc for ${venue.name} but couldn't paste into the document body (${filled?.error || "paste failed"}).\n\n` +
            `Click in the document body (not the title) and ask me to paste again.\n\n` +
            `${docLink || ""}`,
        );
      }
      return paintBrowseDone(
        agent,
        `Wrote your draft in **${venue.name}**.\n\n${docLink || agent.url || ""}\n\nWant edits or formatting?`,
      );
    }

    if (venue.fill === "slides-outline") {
      const genPrompt =
        `The user wants a presentation built INSIDE ${venue.name} (already open in Agent Mode).\n` +
        `Return a slide-by-slide outline ready to paste:\n` +
        `Slide 1: Title\nSubtitle\n\nSlide 2: …\n- bullet\n\n` +
        `Keep it concrete and complete. No code fences. No preamble. No Build/Create mode instructions.\n\n` +
        `User ask:\n${ask}`;
      let outline = "";
      try {
        outline = await draftToolPlainText(agent, genPrompt, gen, venue.name);
      } catch (e) {
        return paintBrowseDone(
          agent,
          `Opened ${venue.name} but couldn't draft slides: ${e?.message || "error"}`,
        );
      }
      if (looksLikeBuildModeRefusal(outline)) {
        return paintBrowseDone(
          agent,
          `Opened ${venue.name}, but drafting failed. Ask me again to fill the deck.`,
        );
      }
      if (outline.length < 20) {
        return paintBrowseDone(
          agent,
          `Opened ${venue.name}, but the slide outline came back empty.`,
        );
      }
      emitProgress(agent.id, {
        status: "running",
        step: `Pasting into ${venue.name}…`,
        url: agent.url || url,
        skill: "tool-create",
      });
      const filled = await ownedBrowserAct.pasteTextIntoPage(wc, {
        text: outline,
        replaceAll: false,
      });
      agent.lastSheetText = outline.slice(0, 120000);
      agent.lastSheetSource = `created in ${venue.name}`;
      agent.lastDeliverableKind = "sheets";
      agent.url = wc.getURL?.() || agent.url || url;
      if (!filled?.ok) {
        return paintBrowseDone(
          agent,
          `Opened **${venue.name}** with your slide outline ready, but paste missed.\n\n` +
            `Click the title box and ask me to paste the outline.\n\n` +
            `Outline preview:\n\n${outline.slice(0, 1200)}`,
        );
      }
      const slidesLink = formatToolVenueOpenLink(agent.url, venue.name);
      return paintBrowseDone(
        agent,
        `Opened **${venue.name}** and pasted your slide outline into the deck so you can split it across slides.\n\n` +
          `${slidesLink || agent.url || ""}\n\n` +
          `I can keep editing in ${venue.name} — say what to change.`,
      );
    }

    // navigate-brief: ANY complex web tool — deep link when possible, else click
    // through the real UI, do the work, report. Multi-step; do not stop on galleries.
    agent.url = wc.getURL?.() || agent.url || url;
    emitProgress(agent.id, {
      status: "running",
      step: `Working in ${venue.name}…`,
      url: agent.url,
      skill: "tool-create",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", {
      status: `Working in ${venue.name}…`,
    });

    // Draft content up front for write/create asks so the UI agent can fill once in-editor.
    // Strip "then send it to email@…" so the model doesn't draft that as body text.
    const writeAsk =
      ownedBrowserAct.stripShareSendInstructions?.(ask) ||
      stripShareSendTail(ask) ||
      ask;
    const needsDocShare =
      ownedBrowserAct.isShareInviteGoal?.(ask) ||
      ownedBrowserAct.looksLikeShareCurrentPageAsk?.(ask);
    let draft = "";
    if (/\b(write|draft|create|make|build|compose|type|author|pen|generate|paper|essay)\b/i.test(ask)) {
      emitProgress(agent.id, {
        status: "running",
        step: `Drafting content for ${venue.name}…`,
        url: agent.url,
        skill: "tool-create",
      });
      try {
        draft = await draftToolPlainText(
          agent,
          `The user wants this done INSIDE ${venue.name} (already open / opening in Agent Mode).\n` +
            `Draft ONLY the document body they asked for (essay/paper/copy).\n` +
            `Plain text only. No markdown fences. No Build/Create mode instructions. No meta commentary.\n` +
            `Do NOT include any "send it to …", "share with …", email addresses, or sharing instructions in the draft — sharing is a separate UI step.\n\n` +
            `Content ask:\n${writeAsk}`,
          gen,
          venue.name,
        );
        draft =
          ownedBrowserAct.sanitizeDraftedDocBody?.(draft) ||
          String(draft || "").trim();
        if (looksLikeBuildModeRefusal(draft) || String(draft || "").trim().length < 40) {
          draft = "";
        }
      } catch {
        draft = "";
      }
    }

    // When share/send is a separate step (same turn or later plan step), the
    // adaptive pass is WRITE-ONLY — share runs once afterward. Stops rewrite loops.
    const adaptiveSourceAsk = needsDocShare ? writeAsk || ask : ask;
    const adaptiveGoal = buildToolActAdaptiveGoal(venue, adaptiveSourceAsk, {
      draft,
    });

    let browseResult = null;
    try {
      browseResult = await runAdaptiveBrowse(agent, adaptiveGoal, gen, wc, {
        suppressDone: true,
        maxRounds: needsDocShare ? 12 : 18,
        returnRaw: true,
        adaptiveGoal,
        conversationHistory: historyForPlanner(agent),
      });
    } catch (e) {
      const link = formatToolVenueOpenLink(agent.url || url, venue.name);
      return paintBrowseDone(
        agent,
        `I opened **${venue.name}** but got stuck while finishing your ask.\n\n` +
          `**Ask:** ${ask}\n\n` +
          `**Blocker:** ${e?.message || "browse stopped"}\n\n` +
          `Take the next click in the browser tab (or tell me exactly what to click), then I can continue.\n\n` +
          `${link || agent.url || ""}`,
      );
    }

    agent.url = wc.getURL?.() || agent.url || url;
    // Re-check login/paywall after click-through.
    {
      let page = { url: agent.url, text: "", title: "" };
      try {
        page = await ownedBrowserAct.getPageContext(wc);
      } catch {
        /* ignore */
      }
      const pageUrl = page.url || agent.url || "";
      agent.url = pageUrl || agent.url;
      if (
        ownedBrowserAct.looksLikeSignInWall?.({
          url: pageUrl,
          text: page.text,
          title: page.title || "",
        })
      ) {
        const pause = await pauseForUserSignIn(agent, gen, wc, {
          context: `working in ${venue.name}`,
        });
        if (pause.blocked && !pause.cleared) return pause.message || "";
      }
      if (
        ownedBrowserAct.looksLikePaywall?.({
          url: pageUrl,
          text: page.text,
          title: page.title || "",
        })
      ) {
        const link = formatToolVenueOpenLink(pageUrl, venue.name);
        return paintBrowseDone(
          agent,
          `I hit a **paywall / upgrade screen** in **${venue.name}** while working on your ask.\n\n` +
            `**Ask:** ${ask}\n\n` +
            `Upgrade or pick a free option in the browser tab, then tell me to continue.\n\n` +
            `${link || pageUrl}`,
        );
      }
    }

    // Still on a listing/gallery — one more push to enter the working surface + do the work.
    if (!venueLooksLikeWorkingSurface(venue, agent.url) && gen === agent.generation) {
      emitProgress(agent.id, {
        status: "running",
        step: `Clicking into ${venue.name}…`,
        url: agent.url,
        skill: "tool-create",
      });
      try {
        browseResult = await runAdaptiveBrowse(
          agent,
          buildToolActAdaptiveGoal(venue, adaptiveSourceAsk, { draft }) +
            `\n\nYou are STILL on a home/gallery/listing page. Click Create/New/Blank or the first free matching item NOW, enter the editor, then place the drafted content once.`,
          gen,
          wc,
          {
            suppressDone: true,
            maxRounds: 10,
            returnRaw: true,
            conversationHistory: historyForPlanner(agent),
          },
        );
        agent.url = wc.getURL?.() || agent.url;
      } catch {
        /* keep prior result */
      }
    }

    // In editor with drafted content but little typing yet — try a direct paste, then continue.
    if (
      draft &&
      venueLooksLikeWorkingSurface(venue, agent.url) &&
      gen === agent.generation
    ) {
      try {
        await ownedBrowserAct.pasteTextIntoPage?.(wc, {
          text: draft,
          replaceAll: false,
        });
      } catch {
        /* adaptive may have typed already */
      }
    }

    // Write done → Share dialog for "send/share it to email@…". Never leave
    // that as leftover text in the document body. Skip if a later plan step
    // will handle share, or we already shared this turn.
    let shareAns = "";
    const deferShareToLaterStep =
      !!agent._deferDocShare || !!agent.docShareDone;
    if (
      needsDocShare &&
      !deferShareToLaterStep &&
      venueLooksLikeWorkingSurface(venue, agent.url) &&
      gen === agent.generation &&
      ownedBrowserAct.sharePageWithEmail
    ) {
      emitProgress(agent.id, {
        status: "running",
        step: "Sharing the doc…",
        url: agent.url,
        skill: "tool-create",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", {
        status: "Sharing the doc…",
      });
      try {
        const shared = await ownedBrowserAct.sharePageWithEmail(wc, { ask });
        agent.url = wc.getURL?.() || agent.url;
        if (shared?.ok && shared?.verified && !shared.stuck) {
          shareAns = shared.message || `Shared with the recipient.`;
          agent.docShareDone = true;
        } else if (shared?.message) {
          // Deterministic path incomplete — only chase the share remainder.
          const progCtx = {
            url: agent.url || "",
            pageText: "",
            history: agent.lastAdaptiveHistory || [],
          };
          try {
            const pageNow = await ownedBrowserAct.getPageContext(wc);
            progCtx.url = pageNow?.url || progCtx.url;
            progCtx.pageText = pageNow?.text || "";
            progCtx.title = pageNow?.title || "";
          } catch {
            /* ignore */
          }
          const shareGoal =
            ownedBrowserAct.remainingAskGoal?.(ask, progCtx) ||
            `ONLY share the open document. Click Share, add the email, Send. Do NOT rewrite the doc.\nAsk: ${ask}`;
          const shareBrowse = await runAdaptiveBrowse(agent, shareGoal, gen, wc, {
            suppressDone: true,
            maxRounds: 10,
            returnRaw: true,
            adaptiveGoal: shareGoal,
            conversationHistory: historyForPlanner(agent),
          });
          agent.url = wc.getURL?.() || agent.url;
          if (Array.isArray(shareBrowse?.history) && shareBrowse.history.length) {
            agent.lastAdaptiveHistory = [
              ...(agent.lastAdaptiveHistory || []),
              ...shareBrowse.history,
            ];
          }
          shareAns = String(shareBrowse?.answer || shared.message || "").trim();
          if (!/stuck|couldn't|could not|incomplete/i.test(shareAns)) {
            agent.docShareDone = true;
          }
        }
      } catch (e) {
        shareAns = `Couldn't finish sharing (${e?.message || "error"}).`;
      }
    }

    const working = venueLooksLikeWorkingSurface(venue, agent.url);
    const link = formatToolVenueOpenLink(agent.url, venue.name);
    const planAns = String(
      (browseResult && browseResult.answer) ||
        (typeof browseResult === "string" ? browseResult : "") ||
        "",
    ).trim();
    if (Array.isArray(browseResult?.history) && browseResult.history.length) {
      agent.lastAdaptiveHistory = [
        ...(agent.lastAdaptiveHistory || []),
        ...browseResult.history,
      ];
    }
    // Re-check share gaps with a live page scrape when share was requested.
    let shareGaps = [];
    if (needsDocShare && working) {
      try {
        const pageShare = await ownedBrowserAct.getPageContext(wc);
        shareGaps =
          ownedBrowserAct.unmetBrowseAskRequirements?.(ask, {
            url: pageShare?.url || agent.url || "",
            pageText: pageShare?.text || "",
            title: pageShare?.title || "",
            history: agent.lastAdaptiveHistory || [],
          }) || [];
      } catch {
        shareGaps = ["share/send the doc to the recipient"];
      }
    }
    const stuck =
      !!browseResult?.stuck ||
      !working ||
      (needsDocShare && shareGaps.some((g) => /share|send/i.test(g))) ||
      /\b(stuck|can't|cannot|unable|paywall|sign\s*in|log\s*in|need you|help me)\b/i.test(
        planAns,
      );

    if (working && !stuck) {
      return paintBrowseDone(
        agent,
        `Finished getting your ask into **${venue.name}**` +
          (needsDocShare && shareAns ? ` and shared it` : "") +
          `.\n\n` +
          `${link || agent.url || ""}\n\n` +
          (shareAns && shareAns.length < 400 ? `${shareAns}\n\n` : "") +
          (planAns && planAns.length < 400 && planAns !== shareAns
            ? `${planAns}\n\n`
            : "") +
          `Tell me what to change next, or keep editing in the tab.`,
      );
    }

    const where = working
      ? "in the working page but couldn't finish every part of the ask"
      : /templates|\/create\/?/i.test(agent.url || "")
        ? "still on a create/gallery page (not in the editor yet)"
        : "in the tool but not on the editable working page yet";
    return paintBrowseDone(
      agent,
      `I got stuck in **${venue.name}** — ${where}.\n\n` +
        `**Ask:** ${ask}\n\n` +
        (planAns
          ? `**What I hit:** ${planAns.slice(0, 500)}\n\n`
          : `**What I hit:** I couldn't finish the click-through / fill from here.\n\n`) +
        `**What you can do:** Take the next click in the agent browser (Create/Blank/open the right page), then tell me “continue”.\n\n` +
        `${link || agent.url || ""}`,
    );
  }

  /** @deprecated use runCreateInToolVenue */
  async function runCreateInSheets(agent, text, gen) {
    return runCreateInToolVenue(agent, text, gen);
  }

  function resolveWorkerRef(ref) {
    const raw = String(ref || "").trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (/^(this|that|the)\s+(browser|tab|agent|one)$/i.test(lower) || lower === "this") {
      if (mainLinkedBrowserId && agents.has(mainLinkedBrowserId)) {
        return agents.get(mainLinkedBrowserId);
      }
    }
    for (const w of workerAgents()) {
      if (w.id === raw || w.id.startsWith(raw)) return w;
      if (String(w.title || "").toLowerCase() === lower) return w;
    }
    for (const w of workerAgents()) {
      const t = String(w.title || "").toLowerCase();
      if (t && (t.includes(lower) || lower.includes(t))) return w;
    }
    // "agent 1" / "agent1"
    const num = lower.match(/^agent\s*(\d+)$/);
    if (num) {
      const n = Number(num[1]);
      const workers = workerAgents().sort((a, b) =>
        String(a.createdAt).localeCompare(String(b.createdAt)),
      );
      if (n >= 1 && n <= workers.length) return workers[n - 1];
    }
    return null;
  }

  /**
   * User asks Main to send work to a sub-agent.
   * "have Agent 1 search pinterest for icons"
   * "delegate to Research bot: write a report on X"
   * "ask this browser to open youtube"
   */
  function parseUserDelegateIntent(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    let m =
      t.match(
        /^\s*(?:please\s+)?delegate\s+to\s+([^:]+?)\s*:\s*([\s\S]+)$/i,
      ) ||
      t.match(
        /^\s*(?:please\s+)?(?:tell|ask|have)\s+(.+?)\s+to\s+([\s\S]+)$/i,
      ) ||
      t.match(
        /^\s*(?:please\s+)?(?:send|route)\s+(?:this\s+)?(?:to\s+)?(.+?)\s*:\s*([\s\S]+)$/i,
      );
    if (!m) {
      // "have this browser/tab search for …"
      m = t.match(
        /^\s*(?:please\s+)?(?:have|ask|tell)\s+(this|that|the)\s+(browser|tab|agent)\s+to\s+([\s\S]+)$/i,
      );
      if (m) {
        return {
          worker: resolveWorkerRef("this browser"),
          prompt: String(m[3] || "").trim(),
        };
      }
      return null;
    }
    const worker = resolveWorkerRef(m[1]);
    const prompt = String(m[2] || "").trim();
    if (!worker || !prompt) return null;
    return { worker, prompt };
  }

  /** Model emits [[lykn_delegate:Agent 1|search pinterest for icons]] */
  function parseAssistantDelegates(text) {
    const out = [];
    const re = /\[\[lykn_delegate:\s*([^|\]]+?)\s*\|\s*([\s\S]+?)\]\]/gi;
    let m;
    while ((m = re.exec(String(text || ""))) !== null) {
      const worker = resolveWorkerRef(m[1]);
      const prompt = String(m[2] || "").trim();
      if (worker && prompt) out.push({ worker, prompt });
    }
    return out;
  }

  function stripDelegateMarkers(text) {
    return String(text || "")
      .replace(/\[\[lykn_delegate:\s*[^|\]]+?\s*\|\s*[\s\S]+?\]\]/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /** User-facing kickoff so Main always reports that a sub-agent was started. */
  function formatDelegateKickoff(worker, prompt) {
    const title = String(worker?.title || "Agent").trim() || "Agent";
    const task = String(prompt || "").trim().replace(/\s+/g, " ");
    const short = task.length > 220 ? `${task.slice(0, 217)}…` : task;
    return (
      `Started **${title}** — it's working on that now.\n\n` +
      `**Task:** ${short}\n\n` +
      `I'll stay on Main and report back when it finishes. ` +
      `You can also switch to **${title}** in the sidebar to watch its browser.`
    );
  }

  function paintMainAssistant(content, { force = false } = {}) {
    const main = getMainAgent();
    if (!main) return;
    const text = String(content || "").trim();
    if (!text) return;
    if (force || (activeAgentId === main.id && !main.busy)) {
      try {
        sendToAgentChannels(main.id, "lykn:agent-status", { status: "Started sub-agent…" });
        sendToAgentChannels(main.id, "lykn:agent-delta", { text });
        sendToAgentChannels(main.id, "lykn:agent-done", { text });
      } catch {
        /* ignore */
      }
    }
  }

  function postNoteToMain(note, { paint = true } = {}) {
    const main = getMainAgent();
    if (!main) return;
    const content = String(note || "").trim();
    if (!content) return;
    main.history.push({
      role: "assistant",
      content,
      at: new Date().toISOString(),
    });
    main.updatedAt = new Date().toISOString();
    schedulePersist();
    if (paint) paintMainAssistant(content);
    emitList();
  }

  async function delegateToWorker(
    worker,
    prompt,
    { fromMain = true, paintKickoff = true, attachments } = {},
  ) {
    if (!worker || isMainAgent(worker)) {
      return { ok: false, error: "bad_worker" };
    }
    const q = String(prompt || "").trim();
    if (!q && !(attachments && attachments.length)) {
      return { ok: false, error: "empty" };
    }
    const kickoff = formatDelegateKickoff(worker, q || "New task");
    if (fromMain) {
      const main = getMainAgent();
      if (main) {
        // Avoid duplicate kickoff lines if Main's reply already included one.
        const last = main.history[main.history.length - 1];
        const alreadyNoted =
          last?.role === "assistant" &&
          /Started\s+\*\*/i.test(String(last.content || "")) &&
          String(last.content || "").includes(worker.title);
        if (!alreadyNoted) {
          main.history.push({
            role: "assistant",
            content: kickoff,
            at: new Date().toISOString(),
          });
          schedulePersist();
        }
        if (paintKickoff) {
          // Early delegate path: Main isn't streaming — paint the kickoff as the turn.
          // Marker path sets paintKickoff:false and folds kickoff into Main's reply.
          paintMainAssistant(kickoff, { force: activeAgentId === main.id });
        }
      }
      setMainLinkedBrowser(worker.id);
      try {
        showBrowserWindow?.(worker.id, { focus: false, label: worker.title || "Agent" });
      } catch {
        /* ignore */
      }
    }
    // Fire-and-forget worker run; completion posts back to Main.
    void send(worker.id, { text: q, attachments }).then((res) => {
      if (!fromMain) return;
      if (res?.ok === false) {
        postNoteToMain(
          `**${worker.title}** could not start: ${res.error || "error"}`,
        );
        return;
      }
      // Final answer also arrives via notifyAgentFinished → reportWorkerToMain
    });
    return { ok: true, workerId: worker.id, title: worker.title, kickoff };
  }

  function reportWorkerToMain(worker, { text, ok, error, skill } = {}) {
    if (!worker || isMainAgent(worker)) return;
    const main = getMainAgent();
    if (!main) return;
    if (!ok) {
      const body = String(error || "failed").trim().slice(0, 500);
      if (!body) return;
      postNoteToMain(`**${worker.title}** failed: ${body}`, {
        paint: activeAgentId === main.id && !main.busy,
      });
      return;
    }
    // Main gets a status ping — full output lives in the worker's browser tab.
    const skillKey = skill || worker.skill || "task";
    postNoteToMain(
      `**${worker.title}** finished (${skillKey}). Output is open in its browser tab.`,
      { paint: activeAgentId === main.id && !main.busy },
    );
  }

  /** Glass shows status copy; full report bodies live in the agent browser. */
  function historyForGlass(history) {
    return (Array.isArray(history) ? history : []).map((m) => {
      let content = m.content;
      if (m.role === "assistant" && m.glass != null && String(m.glass).trim()) {
        const glass = String(m.glass).trim();
        const full = String(m.content || "").replace(/\n{3,}/g, "\n\n").trim();
        // Legacy entries clipped the real answer into `glass` (an exact prefix
        // of the full text) — show the full answer for those. A genuine status
        // replacement ("Finished — … open in the browser.") is not a prefix.
        content = full.startsWith(glass) ? m.content : glass;
      }
      return { role: m.role, content, at: m.at };
    });
  }

  /** Snapshot for Glass when switching agents (includes in-flight turn). */
  function switchPayload(a) {
    if (!a) return { agentId: null, agent: null, history: [] };
    return {
      agentId: a.id,
      agent: publicAgent(a),
      history: historyForGlass(a.history),
      // Don't dump streaming report markdown into Glass — status only.
      partialText: "",
      step: a.step || "",
      busy: !!a.busy,
    };
  }

  function listPublic() {
    return [...agents.values()]
      .sort((x, y) => {
        const xm = isMainAgent(x) ? 0 : 1;
        const ym = isMainAgent(y) ? 0 : 1;
        if (xm !== ym) return xm - ym;
        return String(y.updatedAt || "").localeCompare(String(x.updatedAt || ""));
      })
      .map(publicAgent);
  }

  function emitList() {
    emit("lykn:agent-list", {
      agents: listPublic(),
      activeAgentId,
      agentModeOn,
    });
  }

  function emitProgress(agentId, patch) {
    const a = agents.get(agentId);
    if (!a) return;
    if (patch.status) a.status = patch.status;
    if (patch.step != null) a.step = patch.step;
    if (patch.url != null) a.url = patch.url;
    if (patch.skill) a.skill = patch.skill;
    a.updatedAt = new Date().toISOString();
    emit("lykn:agent-progress", {
      agentId,
      ...publicAgent(a),
      ...(patch.message ? { message: patch.message } : {}),
    });
    emitList();
  }

  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void persist();
    }, 400);
  }

  async function persist() {
    const payload = {
      activeAgentId,
      agents: [...agents.values()].map((a) => ({
        id: a.id,
        title: a.title,
        role: a.role === "main" ? "main" : "worker",
        pinned: a.role === "main" || !!a.pinned,
        status: a.status === "running" ? "idle" : a.status,
        skill: a.skill,
        url: a.url,
        step: a.step,
        history: Array.isArray(a.history) ? a.history.slice(-80) : [],
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        lastDeliverableKind: a.lastDeliverableKind || "",
        lastResearchReport: String(a.lastResearchReport || "").slice(0, 120000),
        lastSheetText: String(a.lastSheetText || "").slice(0, 120000),
        lastSheetSource: String(a.lastSheetSource || "").slice(0, 120),
        lastArtifact:
          a.lastArtifact?.code
            ? {
                toolName: a.lastArtifact.toolName || "lykn_build_react_artifact",
                title: a.lastArtifact.title || "Artifact",
                code: String(a.lastArtifact.code).slice(0, 400000),
              }
            : null,
        lastImage: a.lastImage?.url
          ? { url: a.lastImage.url, title: a.lastImage.title || "Generated image" }
          : null,
      })),
      mainLinkedBrowserId: mainLinkedBrowserId || "",
    };
    try {
      await fs.writeFile(agentsPath(), JSON.stringify(payload, null, 2), "utf8");
    } catch (e) {
      console.warn("[agent-runtime] persist failed:", e?.message);
    }
  }

  async function load() {
    try {
      const raw = await fs.readFile(agentsPath(), "utf8");
      const data = JSON.parse(raw);
      agents.clear();
      for (const row of Array.isArray(data.agents) ? data.agents : []) {
        if (!row?.id) continue;
        // Main is retired — drop any persisted Main from older versions.
        if (row.role === "main") continue;
        const role = "worker";
        agents.set(row.id, {
          id: row.id,
          title: row.title || "Agent",
          role,
          pinned: false,
          status: row.status || "idle",
          skill: row.skill || "general",
          url: row.url || "",
          step: row.step || "",
          history: Array.isArray(row.history) ? row.history : [],
          createdAt: row.createdAt || new Date().toISOString(),
          updatedAt: row.updatedAt || new Date().toISOString(),
          busy: false,
          generation: 0,
          abort: null,
          monitorTimer: null,
          error: "",
          lastMonitorText: "",
          partialText: "",
          lastDeliverableKind: row.lastDeliverableKind || "",
          lastResearchReport: row.lastResearchReport || "",
          lastSheetText: row.lastSheetText || "",
          lastSheetSource: row.lastSheetSource || "",
          lastArtifact:
            row.lastArtifact?.code
              ? {
                  toolName: row.lastArtifact.toolName || "lykn_build_react_artifact",
                  title: row.lastArtifact.title || "Artifact",
                  code: row.lastArtifact.code,
                }
              : null,
          lastImage: row.lastImage?.url
            ? { url: row.lastImage.url, title: row.lastImage.title || "Generated image" }
            : null,
          lastBrowseQuery: "",
          stepDeliverables: [],
        });
      }
      mainLinkedBrowserId =
        data.mainLinkedBrowserId && agents.has(data.mainLinkedBrowserId)
          ? data.mainLinkedBrowserId
          : "";
      activeAgentId =
        data.activeAgentId && agents.has(data.activeAgentId)
          ? data.activeAgentId
          : agents.size
            ? [...agents.keys()][0]
            : null;
    } catch {
      /* fresh */
    }
  }

  // The Main orchestrator is retired: agents and browser tabs are strictly
  // one-to-one, so there is no pinned tab-less Main. This never creates one.
  function ensureMainAgent() {
    return { ok: false, error: "no_main" };
  }

  function stopMonitor(agent) {
    if (agent?.monitorTimer) {
      clearInterval(agent.monitorTimer);
      agent.monitorTimer = null;
    }
  }

  function abortAgent(agent, reason = "stopped") {
    if (!agent) return;
    stopMonitor(agent);
    agent.generation += 1;
    if (agent.abort) {
      try {
        agent.abort.abort();
      } catch {
        /* ignore */
      }
      agent.abort = null;
    }
    agent.busy = false;
    if (agent.status === "running") agent.status = reason === "error" ? "error" : "idle";
  }

  function createAgent({ title, goal, silent, role, activate, history } = {}) {
    const wantMain = role === "main";
    if (wantMain) {
      const existing = getMainAgent();
      if (existing) {
        return { ok: true, agentId: existing.id, agent: publicAgent(existing) };
      }
    } else if (workerCount() >= MAX_WORKER_AGENTS) {
      return { ok: false, error: `max_agents_${MAX_WORKER_AGENTS}` };
    }
    const id = newId();
    const now = new Date().toISOString();
    const workerN = workerCount() + (wantMain ? 0 : 1);
    const agent = {
      id,
      title: wantMain
        ? "Main"
        : title || titleFromGoal(goal) || `Agent ${workerN}`,
      role: wantMain ? "main" : "worker",
      pinned: wantMain,
      status: "idle",
      skill: "general",
      url: "",
      step: "",
      history: [],
      createdAt: now,
      updatedAt: now,
      busy: false,
      generation: 0,
      abort: null,
      monitorTimer: null,
      error: "",
      lastMonitorText: "",
      partialText: "",
      lastDeliverableKind: "",
      lastResearchReport: "",
      lastSheetText: "",
      lastSheetSource: "",
      lastArtifact: null,
      lastImage: null,
      lastBrowseQuery: "",
      stepDeliverables: [],
    };
    // Restore a prior conversation (used when reopening a tab from History).
    if (Array.isArray(history) && history.length) {
      agent.history = history
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
        .slice(-40)
        .map((m) => ({
          role: m.role,
          content: String(m.content).slice(0, 8000),
          at: m.at || now,
        }));
    }
    agents.set(id, agent);
    // Tabs and agents are strictly paired: every worker agent gets a browser
    // tab the moment it exists (fresh new-tab page until it navigates).
    if (!wantMain) {
      const surface = !silent && activate !== false;
      try {
        ensureBrowserWindow?.(id, {
          show: surface,
          focus: surface,
          label: agent.title || "Agent",
        });
      } catch {
        /* tab creation is best-effort; sync will retry */
      }
    }
    // Main: only become active when nothing else is. Workers: activate unless opted out.
    if (wantMain) {
      if (!activeAgentId) activeAgentId = id;
    } else if (activate !== false) {
      activeAgentId = id;
    }
    schedulePersist();
    emitList();
    if (!silent && (wantMain || activate !== false)) {
      emit("lykn:agent-switched", switchPayload(agent));
    }
    return { ok: true, agentId: id, agent: publicAgent(agent) };
  }

  /** Short greetings Main can answer itself without spawning a worker. */
  function isTrivialMainChat(text, attachments) {
    const t = String(text || "").trim();
    // Attachments alone are real work — never keep them on Main.
    if (!t) return !(attachments && attachments.length);
    if (t.length > 48) return false;
    return /^(hi|hello|hey|thanks|thank you|thx|ok|okay|yo|sup|good\s+(morning|afternoon|evening)|howdy)[\s!.?]*$/i.test(
      t,
    );
  }

  /** Idle worker with no chat yet — the standby tab created when Agent Mode opens. */
  function findUnusedWorker() {
    return workerAgents().find(
      (w) =>
        w &&
        !w.busy &&
        w.status !== "running" &&
        (!Array.isArray(w.history) || w.history.length === 0),
    );
  }

  function activateWorkerForMainTask(worker, prompt, { seedUser } = {}) {
    if (!worker || isMainAgent(worker)) {
      return { ok: false, error: "bad_worker" };
    }
    const q = String(prompt || "").trim();
    const title = titleFromGoal(q);
    if (title && (!worker.title || /^Agent \d+$/i.test(worker.title) || worker.title === "New agent")) {
      worker.title = title;
    }
    const userLine = String(seedUser || q || "").trim();
    if (userLine) {
      const last = worker.history[worker.history.length - 1];
      if (!(last?.role === "user" && String(last.content || "") === userLine)) {
        worker.history.push({
          role: "user",
          content: userLine,
          at: new Date().toISOString(),
        });
      }
      worker.updatedAt = new Date().toISOString();
    }
    activeAgentId = worker.id;
    setMainLinkedBrowser(worker.id);
    try {
      showBrowserWindow?.(worker.id, {
        focus: false,
        label: worker.title || "Agent",
      });
    } catch {
      /* ignore */
    }
    try {
      focusOverlayComposer?.();
    } catch {
      /* ignore */
    }
    emitList();
    emit("lykn:agent-switched", switchPayload(worker));
    return { ok: true, worker, agentId: worker.id };
  }

  /** True when the ask names a clearly different website than the open tab. */
  function askNamesDifferentSite(text, currentUrl) {
    const t = String(text || "").trim();
    const live = String(currentUrl || "").trim();
    if (!t || !live || ownedBrowserAct.isPlaceholderAgentUrl(live)) return false;
    if (!ownedBrowserAct.looksLikeOpenDestinationAsk?.(t)) return false;
    // Blank/new workspace follow-ups stay on Docs/Sheets even if they say "doc".
    const ctx = { currentUrl: live };
    if (ownedBrowserAct.looksLikeNewBlankWorkspaceAsk?.(t, ctx)) return false;
    const dest =
      ownedBrowserAct.resolveOpenDestinationUrl?.(t, ctx) ||
      ownedBrowserAct.resolveBrowseTargetUrl?.(t, ctx) ||
      "";
    if (!dest || /google\.com\/search/i.test(dest)) return false;
    try {
      const a = new URL(dest).hostname.replace(/^www\./i, "").toLowerCase();
      const b = new URL(live).hostname.replace(/^www\./i, "").toLowerCase();
      if (!a || !b) return false;
      // Google Workspace family counts as the same "place".
      const aDocs = /docs\.google\.com|drive\.google\.com|sheets\.google/i.test(dest);
      const bDocs = /docs\.google\.com|drive\.google\.com|sheets\.google/i.test(live);
      if (aDocs && bDocs) return false;
      if (a === b) return false;
      if (a.endsWith(b) || b.endsWith(a)) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Follow-ups should keep using the browser tab Main is already watching
   * ("open a blank doc" after Docs — not a fresh agent that Google-searches "doc").
   */
  function shouldContinueOnLinkedWorker(text, linked) {
    if (!linked || isMainAgent(linked)) return false;
    if (linked.busy || linked.status === "running") return false;
    if (!agentHasBrowserSurface(linked)) return false;
    const t = String(text || "").trim();
    if (!t) return false;
    const liveUrl = String(linked.url || "").trim();
    const ctx = {
      currentUrl: liveUrl,
      priorUrl: linked.lastBrowseUrl || "",
      priorGoal: priorUserGoalBeforeLatest(linked) || "",
      priorAssistant: priorAssistantText(linked) || "",
      recentUserGoals: recentUserGoals(linked, 6),
    };
    if (askNamesDifferentSite(t, liveUrl)) return false;
    // "that's not right" after an open — same browser tab, re-search without auto-click.
    if (ownedBrowserAct.looksLikeWrongOpenDestinationAsk?.(t)) return true;
    if (ownedBrowserAct.looksLikeNewBlankWorkspaceAsk?.(t, ctx)) return true;
    if (ownedBrowserAct.looksLikeOrganizeSheetAsk?.(t)) return true;
    if (ownedBrowserAct.looksLikeDeicticFollowUp?.(t)) return true;
    if (ownedBrowserAct.looksLikeInPageAction?.(t)) return true;
    if (ownedBrowserAct.looksLikeCurrentTabTask?.(t)) return true;
    if (ownedBrowserAct.looksLikeSameTabSearch?.(t)) return true;
    if (ownedBrowserAct.looksLikeMailComposeTask?.(t) || ownedBrowserAct.looksLikeMailReplyTask?.(t)) {
      return true;
    }
    if (looksLikePasteReportIntoSheets(t) || looksLikeCreateInToolVenueAsk(t, { liveUrl })) {
      return true;
    }
    if (looksLikeDeliverableEdit(t) || looksLikeOpenDeliverableFollowUp(t)) return true;
    // Short follow-up that doesn't open a different site → same tab.
    if (t.length <= 160 && !askNamesDifferentSite(t, liveUrl)) {
      // Explicit "new agent" / parallel research escapes.
      if (/\b(new agent|another agent|separate agent|in parallel|meanwhile)\b/i.test(t)) {
        return false;
      }
      if (
        ownedBrowserAct.looksLikeOpenDestinationAsk?.(t) &&
        !ownedBrowserAct.looksLikeNewBlankWorkspaceAsk?.(t, ctx)
      ) {
        // "open X" for the same Workspace app / current host → continue.
        const dest =
          ownedBrowserAct.resolveOpenDestinationUrl?.(t, ctx) ||
          ownedBrowserAct.resolveBrowseTargetUrl?.(t, ctx) ||
          "";
        if (dest && !/google\.com\/search/i.test(dest)) {
          try {
            const a = new URL(dest).hostname.replace(/^www\./i, "");
            const b = new URL(liveUrl).hostname.replace(/^www\./i, "");
            if (a && b && (a === b || a.endsWith(b) || b.endsWith(a))) return true;
            if (/docs\.google\.com/i.test(dest) && /docs\.google\.com/i.test(liveUrl)) {
              return true;
            }
          } catch {
            /* fall through */
          }
          return false;
        }
      }
      return true;
    }
    return false;
  }

  /**
   * Claim the linked tab for follow-ups, else standby / spawn.
   * Main never executes the task itself.
   */
  function claimWorkerForMainTask(prompt, { seedUser } = {}) {
    const q = String(prompt || "").trim();
    const linked =
      (mainLinkedBrowserId && agents.get(mainLinkedBrowserId)) ||
      workerAgents().find((w) => agentHasBrowserSurface(w) && !w.busy) ||
      null;
    if (linked && shouldContinueOnLinkedWorker(q, linked)) {
      return activateWorkerForMainTask(linked, prompt, { seedUser });
    }
    const unused = findUnusedWorker();
    if (unused) {
      return activateWorkerForMainTask(unused, prompt, { seedUser });
    }
    const created = createAgent({
      goal: q,
      title: titleFromGoal(q) || `Agent ${workerCount() + 1}`,
      silent: true,
      activate: true,
    });
    if (!created?.ok || !created.agentId) {
      return { ok: false, error: created?.error || "spawn_failed" };
    }
    const worker = agents.get(created.agentId);
    if (!worker) return { ok: false, error: "spawn_failed" };
    return activateWorkerForMainTask(worker, prompt, { seedUser });
  }

  function agentHasBrowserSurface(a) {
    const url = String(a?.url || "").trim();
    if (!url || ownedBrowserAct.isPlaceholderAgentUrl(url)) return false;
    return true;
  }

  /**
   * Keep every agent's page loaded in the shared stage.
   * activate:true only when the user switches agents — background work must
   * not yank focus to the browser (completion uses a desktop notification).
   */
  function syncAgentBrowserTabs({ focusId, activate = false } = {}) {
    try {
      for (const ag of agents.values()) {
        if (isMainAgent(ag)) continue; // Main uses worker browsers, not its own tab.
        // Every worker agent keeps a tab (agents restored from disk get theirs
        // recreated here) — tabs and agents always exist in pairs.
        ensureBrowserWindow?.(ag.id, {
          show: false,
          focus: false,
          label: ag.title || "Agent",
        });
      }
      const focusAg = focusId ? agents.get(focusId) : null;
      if (focusAg && !isMainAgent(focusAg)) {
        // Explicit switch / finish-popup click: always show that worker's tab
        // (including empty welcome tabs with no navigated URL yet).
        if (activate) {
          showBrowserWindow?.(focusId, {
            focus: true,
            label: focusAg.title || "Agent",
          });
        } else if (agentHasBrowserSurface(focusAg) || browserWindowExists?.(focusId)) {
          ensureBrowserWindow?.(focusId, {
            show: false,
            focus: false,
            label: focusAg.title || "Agent",
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  function switchAgent(agentId) {
    const a = agents.get(agentId);
    if (!a) return { ok: false, error: "not_found" };
    activeAgentId = agentId;
    // Main has no private browser — show the linked worker tab (or first worker).
    const browserFocusId = isMainAgent(a)
      ? mainLinkedBrowserId && agents.has(mainLinkedBrowserId)
        ? mainLinkedBrowserId
        : workerAgents()[0]?.id || ""
      : agentId;
    if (browserFocusId) {
      if (isMainAgent(a)) setMainLinkedBrowser(browserFocusId);
      syncAgentBrowserTabs({ focusId: browserFocusId, activate: true });
    } else {
      syncAgentBrowserTabs({ focusId: agentId, activate: false });
    }
    schedulePersist();
    emitList();
    const payload = switchPayload(a);
    emit("lykn:agent-switched", payload);
    return { ok: true, ...payload, linkedBrowserId: mainLinkedBrowserId || "" };
  }

  function stopAgent(agentId) {
    const a = agents.get(agentId || activeAgentId);
    if (!a) return { ok: false, error: "not_found" };
    abortAgent(a, "stopped");
    a.step = "Stopped";
    a.updatedAt = new Date().toISOString();
    schedulePersist();
    emitProgress(a.id, { status: "idle", step: "Stopped" });
    emit("lykn:agent-done", { agentId: a.id, text: "", stopped: true });
    return { ok: true, agent: publicAgent(a) };
  }

  function closeAgent(agentId) {
    const id = agentId || activeAgentId;
    const a = agents.get(id);
    if (!a) return { ok: false, error: "not_found" };
    if (isMainAgent(a)) {
      return { ok: false, error: "main_pinned" };
    }
    abortAgent(a, "closed");
    try {
      destroyBrowserWindow?.(id);
    } catch {
      /* ignore */
    }
    try {
      destroyOwnedArtifactTabs?.(id);
    } catch {
      /* ignore */
    }
    agents.delete(id);
    if (mainLinkedBrowserId === id) mainLinkedBrowserId = "";
    if (activeAgentId === id) {
      const main = getMainAgent();
      activeAgentId = main?.id || (agents.size ? [...agents.keys()][0] : null);
      if (activeAgentId) {
        const next = agents.get(activeAgentId);
        syncAgentBrowserTabs({ focusId: activeAgentId });
        emit("lykn:agent-switched", switchPayload(next));
      } else {
        emit("lykn:agent-switched", switchPayload(null));
      }
    }
    schedulePersist();
    emitList();
    return { ok: true, activeAgentId };
  }

  /** Main is retired — "new chat" simply creates a fresh agent + paired tab. */
  function resetMainChat() {
    const res = createAgent({ title: "New agent" });
    if (!res?.ok || !res.agentId) return res || { ok: false, error: "create_failed" };
    return { ok: true, agentId: res.agentId, agent: res.agent };
  }

  function setAgentMode(on) {
    agentModeOn = !!on;
    if (agentModeOn) {
      // One agent per tab, no Main orchestrator: entering Agent Mode just
      // guarantees at least one agent (with its paired tab) and lands on it.
      if (workerCount() === 0) {
        createAgent({ silent: true });
      }
      if (!activeAgentId || !agents.has(activeAgentId)) {
        activeAgentId = workerAgents()[0]?.id || null;
      }
      emitList();
      const act = activeAgentId ? agents.get(activeAgentId) : null;
      if (act) emit("lykn:agent-switched", switchPayload(act));
    } else {
      emitList();
      try {
        hideAllBrowserWindows?.();
      } catch {
        /* ignore */
      }
    }
    return {
      ok: true,
      agentModeOn,
      activeAgentId,
      agents: listPublic(),
      mainAgentId: getMainAgent()?.id || null,
      linkedBrowserId: mainLinkedBrowserId || "",
    };
  }

  function sendToAgentChannels(agentId, channel, payload) {
    emit(channel, { agentId, ...payload });
  }

  function resolveSkillForPrompt(agent, text, attachments) {
    const q = normalizeAgentStepText(text);
    const atts = Array.isArray(attachments) ? attachments : [];
    const hasAttachedImage = atts.some((a) => a && a.kind === "image" && a.dataUrl);
    let liveTabUrl = "";
    try {
      const wc = getBrowserWebContents?.(agent.id);
      liveTabUrl = getLiveTabUrl(agent, wc) || getLiveTabUrl(agent, null);
    } catch {
      liveTabUrl = getLiveTabUrl(agent, null);
    }
    if (!liveTabUrl && agent.url && !ownedBrowserAct.isPlaceholderAgentUrl(agent.url)) {
      liveTabUrl = agent.url;
    }
    const pendingBrowseClarify = ownedBrowserAct.priorAskedForSiteClarification(
      priorAssistantText(agent),
    );
    let skill = classifyAgentSkill(q, {
      hasLiveTab: !!liveTabUrl,
      liveUrl: liveTabUrl,
      hasMailDraft: !!agent.lastMailDraft,
      hasArtifact: !!(agent.lastArtifact && agent.lastArtifact.code),
      hasReport: !!agent.lastResearchReport,
      hasImage: !!(agent.lastImage && agent.lastImage.url),
      hasAttachedImage,
      deliverableKind: agent.lastDeliverableKind || "",
      pendingBrowseClarify,
    });
    if (
      skill === "general" &&
      (ownedBrowserAct.looksLikeBrowseSiteClarification(q) ||
        (pendingBrowseClarify &&
          (ownedBrowserAct.resolveSiteClarificationUrl(q) ||
            ownedBrowserAct.extractUrlFromText(q))))
    ) {
      skill = "browse";
    }
    if (
      skill === "general" &&
      liveTabUrl &&
      (ownedBrowserAct.looksLikeInPageAction(q) || ownedBrowserAct.looksLikeOpenSearchResult(q)) &&
      // Don't upgrade scrape-and-answer questions into a click plan.
      !(
        ownedBrowserAct.looksLikePageQuestionAsk?.(q) &&
        !ownedBrowserAct.looksLikeBrowseActAsk?.(q) &&
        !ownedBrowserAct.looksLikeMailInboxReview?.(q) &&
        !ownedBrowserAct.looksLikeMailDraftsReview?.(q)
      )
    ) {
      skill = "browse";
    }
    if (
      (skill === "general" || skill === "research") &&
      looksLikeArtifactConversion(q) &&
      (agent.lastResearchReport || agent.lastDeliverableKind === "report" || agent.lastArtifact?.code)
    ) {
      skill = "build";
    }
    if (skill === "general" && artifactBuildIntent.isTypedNewDeliverableAsk(q)) {
      skill = "build";
    }
    if (
      skill === "general" &&
      (detectImageIntent(q, { hasAttachedImage }) ||
        detectReferenceImageAsk(q, hasAttachedImage))
    ) {
      skill = "image";
    }
    return skill;
  }

  async function runOneSkill(agent, stepText, attachments, skill, gen, stepMeta = null) {
    const rawStep = String(stepText || "").trim();
    const multiActive = !!(stepMeta && stepMeta.total > 1);
    // "go into Google Docs and write…" must NOT take the generic browse path —
    // that burns click loops on the canvas editor. Prefer tool-create first.
    if (
      skill === "tool-create" ||
      skill === "sheets-create" ||
      looksLikeCreateInToolVenueAsk(rawStep, { liveUrl: agent.url || "" })
    ) {
      // Complex design/3D software → offer artifact vs stop BEFORE tool-create.
      if (!agent.skipComplexGateOnce) {
        const complexOffer = matchComplexSoftwareOffer(rawStep, {
          liveUrl: agent.url || "",
        });
        if (complexOffer) {
          return offerComplexSoftwareChoice(agent, rawStep, complexOffer);
        }
      }
      const fullAsk = String(stepMeta?.fullAsk || "").trim();
      // Multi-step write then "send it to…" — share on the later step, not twice.
      agent._deferDocShare = !!(
        multiActive &&
        fullAsk &&
        ownedBrowserAct.isShareInviteGoal?.(fullAsk) &&
        !ownedBrowserAct.isShareInviteGoal?.(rawStep)
      );
      try {
        return await runCreateInToolVenue(agent, rawStep, gen);
      } finally {
        agent._deferDocShare = false;
      }
    }
    // Browse: run the current step. Residual unfinished parts are handled by
    // remainingAskGoal rechecks — not by re-feeding the entire original ask.
    if (skill === "browse") {
      return runBrowse(agent, rawStep, gen, {
        suppressDone: multiActive,
        fullAsk: rawStep,
        preferredUrl: agent.preferredBrowseUrl || "",
      });
    }
    if (skill === "monitor") {
      return runMonitor(agent, rawStep, gen);
    }
    // Paste an existing sibling research report into Google Sheets (no re-research).
    if (skill === "sheets-fill" || looksLikePasteReportIntoSheets(rawStep)) {
      emitProgress(agent.id, {
        status: "running",
        step: "Putting research into Sheets…",
        skill: "sheets-fill",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", {
        status: "Putting research into Sheets…",
      });
      const result = await runCombineReportIntoSheets(agent, rawStep);
      const msg = result?.message || "Done.";
      if (!multiActive) {
        return paintBrowseDone(agent, msg);
      }
      agent.partialText = msg;
      sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg });
      return msg;
    }
    // Complex design/3D software → offer artifact vs stop BEFORE artifact build.
    if (!agent.skipComplexGateOnce) {
      const complexOffer = matchComplexSoftwareOffer(rawStep, {
        liveUrl: agent.url || "",
      });
      if (complexOffer) {
        return offerComplexSoftwareChoice(agent, rawStep, complexOffer);
      }
    }
    if (ownedBrowserAct.looksLikeOrganizeSheetAsk?.(rawStep)) {
      return runOrganizeSheet(agent, rawStep, gen);
    }
    let effective = rawStep;
    if (multiActive) {
      effective =
        `[Multi-step plan — execute ONLY this step now (${stepMeta.index + 1}/${stepMeta.total}). ` +
        `Do not skip ahead. Prior steps are already done.]\n` +
        `Full plan:\n${stepMeta.planLines}\n\n` +
        `Current step: ${rawStep}`;
    }
    const answer = await streamChat(agent, effective, attachments, skill, gen, {
      suppressDone: multiActive,
      // Deliverable steps following a browse step source from the live tab.
      forceScreenSourced: multiActive && !!stepMeta?.afterBrowse,
    });
    if (answer && gen === agent.generation) {
      maybeOpenTextOutputInBrowser(agent, answer, skill);
    }
    return answer;
  }

  async function streamChat(agent, text, attachments, skill, gen, opts = {}) {
    const token = await getAuthToken().catch(() => null);
    if (!token) {
      throw new Error("Sign in to LYKN first. Open the main LYKN window and log in, then try again.");
    }
    // browse-summary must not reuse prior "please sign in" turns — they override the scrape.
    const history = skill === "browse-summary" ? [] : agent.history.slice(-12);
    const textLimit =
      skill === "browse-summary" || skill === "build" || skill === "report-edit" ? 14000 : 4000;
    let effectiveText = String(text || "");

    // Live page awareness. Conversational turns always get the open page as
    // context. Deliverable turns (report/artifact/image) get it as SOURCE
    // MATERIAL when the ask references the current screen ("based on this
    // page", "report on what I'm looking at"). Best-effort; never blocks.
    let livePageBlock = "";
    const deliverableSkill =
      skill === "build" || skill === "research" || skill === "report-edit" || skill === "image";
    const screenSourced =
      deliverableSkill &&
      // Multi-step plans: a deliverable step right after a browse step is
      // always about what the browse landed on ("check my ads → create a report").
      (!!opts.forceScreenSourced ||
        referencesCurrentScreen(text, {
          hasPriorDeliverable: !!(agent.lastResearchReport || agent.lastArtifact?.code),
        }) ||
        askMentionsLiveSiteHost(text, agent.url));
    // A live tab in this chat is the DEFAULT source for report/artifact asks —
    // the user should not have to say "based on this page" for a report to use
    // the data on their screen. Explicit references just make it primary.
    // (Edits/conversions of an existing deliverable and image gen are excluded —
    // those already have their own source.)
    const livePageDefault =
      !screenSourced &&
      (skill === "research" || skill === "build") &&
      !(skill === "build" && (agent.lastArtifact?.code || agent.lastResearchReport));
    if ((skill === "general" || screenSourced || livePageDefault) && !isMainAgent(agent)) {
      try {
        const wc = getBrowserWebContents?.(agent.id);
        if (wc && !wc.isDestroyed?.()) {
          const page = await ownedBrowserAct.getPageContext(wc);
          const url = String(page?.url || "");
          if (url && !ownedBrowserAct.isPlaceholderAgentUrl(url)) {
            const pageTitle = String(page?.title || "").slice(0, 160);
            const pageQuestionAsk =
              skill === "general" && !!ownedBrowserAct.looksLikePageQuestionAsk?.(text);
            const pageText = String(page?.text || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(
                0,
                screenSourced ? 12000 : livePageDefault || pageQuestionAsk ? 10000 : 2500,
              );
            livePageBlock = [
              screenSourced
                ? "The user's request is based on the page open in your browser tab. Use this page as the PRIMARY source material for the deliverable — do not ignore it or research something else instead:"
                : livePageDefault
                  ? "The agent has this page OPEN in its browser tab in this chat. DEFAULT SOURCE RULE: if the user's request could plausibly be about this page or its data (a report/summary/analysis of 'the data', 'the numbers', 'sales', 'metrics', the account, etc.), build the deliverable FROM THIS PAGE'S CONTENT below — do NOT run generic web research on the topic instead, and do NOT claim you lack access to the data. Only disregard this page when the request clearly names an unrelated topic:"
                  : pageQuestionAsk
                    ? "The user is asking about the page open in your browser tab. Answer from the page content below — quote the relevant numbers/facts. Do not start browsing or clicking; do not invent metrics that aren't on the page:"
                    : "The user is currently on this page in your browser tab — use it as context when answering:",
              `URL: ${url}`,
              pageTitle ? `Title: ${pageTitle}` : "",
              pageText ? `Page content (excerpt):\n${pageText}` : "",
            ]
              .filter(Boolean)
              .join("\n");
          }
        }
      } catch {
        /* page context is best-effort */
      }
    }
    const redesignOpenArtifact =
      skill === "build" &&
      !!agent.lastArtifact?.code &&
      artifactBuildIntent.isRedesignAsk(text);
    const refiningArtifact =
      skill === "build" &&
      !!agent.lastArtifact?.code &&
      !redesignOpenArtifact &&
      !looksLikeArtifactConversion(text) &&
      !artifactBuildIntent.isTypedNewDeliverableAsk(text) &&
      (looksLikeDeliverableEdit(text) || agent.lastDeliverableKind === "artifact");

    if (skill === "report-edit" && agent.lastResearchReport) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[Prior research report OPEN in this agent's tab — apply the user's edits and return the FULL updated report in markdown. ` +
        `Do NOT start a new deep-research crawl. Do NOT tell the user you cannot edit it.]\n\n` +
        String(agent.lastResearchReport).slice(0, 11000);
    } else if (skill === "build" && redesignOpenArtifact) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[An interactive artifact is OPEN — the user asked for a FULL visual/palette restyle or redesign. ` +
        `Rewrite the artifact completely (full_rewrite) to match their ask. Keep the same content/structure where possible, ` +
        `but replace the entire color system / look. Do NOT do a tiny surgical patch. Do NOT say the refine guard blocked you.]\n`;
    } else if (skill === "build" && refiningArtifact) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[An interactive artifact is OPEN in this agent's tab. Apply the user's edits to THAT artifact via the refine/build tool. ` +
        `Do NOT start unrelated research. Do NOT say you cannot edit it.]\n`;
    } else if (skill === "build" && agent.lastResearchReport && !screenSourced) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[Prior research report from THIS agent — convert THIS content into an interactive artifact/webapp. ` +
        `Do NOT run new deep research. Do NOT write another markdown report. ` +
        `You MUST call the React artifact / Create tool and produce a live presentation UI now.]\n\n` +
        String(agent.lastResearchReport).slice(0, 11000);
      if (agent.url || agent.lastBrowseQuery) {
        effectiveText +=
          `\n\n[Visual inspo from the previous browse step` +
          (agent.url ? `: ${agent.url}` : "") +
          (agent.lastBrowseQuery ? ` (searched “${agent.lastBrowseQuery}”)` : "") +
          `. Match that aesthetic (colors, layout cues) in the presentation.]`;
      }
    } else if (skill === "build" && looksLikeArtifactConversion(text) && !screenSourced) {
      const prior = priorAssistantText(agent);
      if (prior && prior.length > 200) {
        effectiveText =
          `${effectiveText}\n\n` +
          `[Prior assistant content from THIS agent — convert into an interactive artifact/webapp. ` +
          `Do NOT run new deep research.]\n\n` +
          prior.slice(0, 11000);
      }
    } else if (skill === "image" && agent.lastImage?.url) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[Prior generated image in this agent: ${agent.lastImage.url}. Regenerate/edit with lykn_generate_image; keep continuity with that image when asked.]\n`;
    } else if (skill === "research" && livePageBlock) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[When the open page's data is the source: write a complete, well-structured markdown report from THAT data — ` +
        `clear headings, key figures, and GitHub-flavored markdown tables where numbers exist. ` +
        `Each table MUST be multiline (header row, then a |---| separator row, then one data row per line) — ` +
        `never smash an entire table onto one line. Prefer a simple Metric | Result table for KPIs so a chart can render. ` +
        `Never invent numbers: use only figures visible in the page content, and note explicitly when something ` +
        `the user asked about is not shown on screen.]`;
    }

    // Sheets canvas scrapes look empty — always attach remembered grid contents.
    const knownSheet =
      String(agent.lastSheetText || "").trim() ||
      (ownedBrowserAct.looksLikeGoogleSheetsUrl?.(agent.url)
        ? getKnownSheetText(agent)
        : "");
    if (
      knownSheet.length > 20 &&
      (ownedBrowserAct.looksLikeGoogleSheetsUrl?.(agent.url) ||
        ownedBrowserAct.looksLikeOrganizeSheetAsk?.(text) ||
        ownedBrowserAct.looksLikePasteIntoSheets?.(text) ||
        agent.lastDeliverableKind === "sheets")
    ) {
      effectiveText =
        `${effectiveText}\n\n` +
        `[IMPORTANT: This agent's Google Sheet ALREADY has data` +
        (agent.lastSheetSource ? ` (from ${agent.lastSheetSource})` : "") +
        `. Sheets is canvas-based so page scrapes often look blank — ` +
        `NEVER say the sheet is empty/blank. Organize/edit using this content:]\n\n` +
        knownSheet.slice(0, 10000);
    }

    const clipped = effectiveText.slice(0, textLimit);
    const openKind = String(agent.lastDeliverableKind || "").trim();
    const hasOpenDeliverable =
      (openKind === "artifact" && !!agent.lastArtifact?.code) ||
      (openKind === "report" && !!agent.lastResearchReport) ||
      (openKind === "image" && !!agent.lastImage?.url) ||
      !!agent.lastArtifact?.code ||
      !!agent.lastResearchReport ||
      !!agent.lastImage?.url;
    const openLabel =
      openKind === "artifact" || (!openKind && agent.lastArtifact?.code)
        ? `artifact${agent.lastArtifact?.title ? ` (“${agent.lastArtifact.title}”)` : ""}`
        : openKind === "report" || (!openKind && agent.lastResearchReport)
          ? "research report"
          : openKind === "image" || (!openKind && agent.lastImage?.url)
            ? "generated image"
            : "artifact, report, or image";
    const editCapabilityNote = hasOpenDeliverable
      ? `This agent's tab currently has an open ${openLabel}. You have full edit capability on it — ` +
        `apply changes in place (tools / rewrite) and reload that same tab. ` +
        `Never claim you cannot edit it, and never ask them to switch Create/Build/Research modes.\n`
      : "";

    const toolDraft = !!opts.toolDraft;
    const toolDraftVenue = String(opts.toolDraftVenue || "").trim();
    const body = {
      model: "lykn",
      intent: "ask",
      text: clipped,
      prompt: toolDraft
        ? `You are LYKN Agent Mode drafting plain text to paste into ${toolDraftVenue || "an already-open external tool"}.\n` +
          `The tool is ALREADY open. Output ONLY the requested body (essay, table TSV, outline, brief).\n` +
          `Never mention Build mode, Create mode, Glass, the + menu, or asking the user to resend.\n` +
          `No preamble. No code fences. No meta commentary.\n\n` +
          `Request:\n${clipped}`
        : skill === "browse-summary"
          ? `You are LYKN Agent Mode — a helpful coworker wrapping up browser work.\n` +
            `${AGENT_MODE_STEP_DOCTRINE}\n` +
            `Use ONLY the page content in the user message. Ignore any instinct to ask for sign-in ` +
            `unless that message explicitly says the tab is a login form with no inbox data.\n` +
            `Always explain what you found in plain language (don't dump raw UI chrome). ` +
            `Actively teach: what the page/dashboard means, what matters, and what is optional. ` +
            `End every reply with 2–3 concrete “Want me to…” suggestions the user can say next. ` +
            `Never finish with only “What next?” or a one-line “Opened X”.\n\n` +
            `User:\n${clipped}`
          : isMainAgent(agent)
            ? `You are LYKN’s pinned Main agent — the orchestrator for Agent Mode.\n` +
              `${AGENT_MODE_STEP_DOCTRINE}\n` +
              `You manage sub-agents. Each sub-agent owns its own browser tab and runs research/build/browse work.\n` +
              `Live roster:\n${formatRosterForMain()}\n` +
              (mainLinkedBrowserId
                ? `Currently watching browser/tab for sub-agent id ${mainLinkedBrowserId.slice(0, 8)}.\n`
                : `No browser linked yet — the user can click a sub-agent browser tab while chatting with you.\n`) +
              `When the user wants work done in a browser/tab, DELEGATE to that sub-agent. Do not pretend you browsed yourself.\n` +
              `When they want an EXISTING research report put into an open Google Sheet, that is a combine action ` +
              `(has_report + sheets on the roster) — never start a new research crawl for that.\n` +
              `When they name an external tool as the venue (“in PowerPoint”, “in Google Sheets”, “in Canva”), ` +
              `create inside that tool — not as a LYKN artifact. Plain “create me a presentation/budget” with no tool name → artifact.\n` +
              `To delegate, include exactly one marker on its own line:\n` +
              `[[lykn_delegate:SUB_AGENT_TITLE_OR_ID|clear instructions for that agent]]\n` +
              `Example: [[lykn_delegate:Agent 1|search pinterest for good incognito icons]]\n` +
              `You may also say “this browser” / “this tab” when a linked browser is set.\n` +
              `After the marker, tell the user you STARTED that sub-agent and what it is doing now ` +
              `(e.g. "Started Agent 1 — it's searching Pinterest for icons. I'll report back when it finishes."). ` +
              `Never stay silent after delegating.\n` +
              `You are ALREADY in Agent Mode — never tell them to switch modes.\n\n` +
              `User: ${clipped}`
            : `You are LYKN Agent Mode — a desktop cowork agent that researches, builds, browses, and edits deliverables.\n` +
              `Skill: ${skill}.\n` +
              `${AGENT_MODE_STEP_DOCTRINE}\n` +
              `You are ALREADY in Agent Mode. Never tell the user to switch modes, open Create/Build/Research, ` +
              `use a + menu, or resend in another composer mode — those UI paths are not available here. ` +
              `Just complete the task now (use tools / deep research / image gen when needed).\n` +
              `When you finish, explain what you did and what it means, then offer 2–3 concrete next-step suggestions ` +
              `(“Want me to…”). Be a helpful teammate — not a silent tool that only says “Done”.\n` +
              editCapabilityNote +
              (skill === "build" && redesignOpenArtifact
                ? `FULL RESTYLE the open React artifact now (neutral/grayscale/palette swap = full_rewrite). Do not say a refine guard blocked you.\n`
                : "") +
              (skill === "build" && refiningArtifact
                ? `Refine the open React artifact surgically (or full rewrite if they ask for a redesign).\n`
                : "") +
              (skill === "build" && !refiningArtifact && !redesignOpenArtifact
                ? `Build what they asked for now with the React artifact / Create tool (app, page, deck, presentation, dashboard, calculator, quiz, tracker, form, interactive tool, etc.). ` +
                  `Produce a live UI deliverable — not an essay about how to build it, and never tell them to switch to Build/Create.\n`
                : "") +
              (skill === "report-edit"
                ? `Return the full updated markdown report only — it will replace the open report tab.\n`
                : "") +
              (skill === "image"
                ? `Use the image generation tool now. Never tell the user to switch to image mode. ` +
                  `After the image is generated, give a short confirmation only — do NOT search or dump Vault notes.\n`
                : "") +
              `\nUser: ${clipped}`,
      useTools: skill !== "browse-summary" && skill !== "report-edit" && !toolDraft,
      overlayAsk: true,
      agentMode: true,
      ...(toolDraft ? { toolDraft: true } : {}),
      ...(Array.isArray(history) && history.length ? { conversation: history } : {}),
      ...(skill === "research"
        ? screenSourced && livePageBlock
          ? {
              // Screen-sourced report: write from the open page's data — a web
              // crawl would sideline the user's actual numbers.
              composerMode: "research",
              deepResearch: false,
              skipWebSearch: true,
              forceWebSearch: false,
              useTools: false,
            }
          : livePageDefault && livePageBlock
            ? {
                // Live tab attached as the default source — allow search as a
                // supplement, but don't force a crawl over the page data.
                composerMode: "research",
                deepResearch: false,
                skipWebSearch: false,
                forceWebSearch: false,
              }
            : {
                composerMode: "research",
                deepResearch: true,
                skipWebSearch: false,
                forceWebSearch: true,
              }
        : skill === "build"
          ? refiningArtifact || redesignOpenArtifact
            ? {
                composerMode: "create:webapp",
                // Surgical refine OR explicit palette/redesign (server treats redesign asks as full_rewrite).
                skipWebSearch: true,
                forceWebSearch: false,
                deepResearch: false,
                useTools: true,
                activeArtifact: {
                  toolName: agent.lastArtifact.toolName || "lykn_build_react_artifact",
                  title: agent.lastArtifact.title || "Artifact",
                  code: agent.lastArtifact.code,
                },
              }
            : {
                composerMode: "create:webapp",
                forceArtifact: true,
                artifactType: "webapp",
                skipWebSearch: true,
                forceWebSearch: false,
                deepResearch: false,
              }
          : skill === "report-edit"
            ? {
                skipWebSearch: true,
                forceWebSearch: false,
                deepResearch: false,
                useTools: false,
              }
            : skill === "image"
              ? {
                  forceImage: true,
                  useTools: true,
                  skipWebSearch: true,
                  forceWebSearch: false,
                  deepResearch: false,
                }
          : skill === "browse-summary"
            ? {
                // Owned-tab summary only — no Serper "sources" that look like a fake browse.
                skipWebSearch: true,
                forceWebSearch: false,
                useTools: false,
              }
            : {
                skipWebSearch: false,
                forceWebSearch: /\b(search|latest|news|research|find)\b/i.test(text),
              }),
    };

    // Private browsing-habits context (from Chrome sync). Folded into the
    // system side of the prompt so the agent is *aware* of what the user
    // usually does — never surfaced to the user as a report/turn.
    try {
      const bc = typeof getBrowsingContext === "function" ? getBrowsingContext() : "";
      if (bc && typeof body.prompt === "string") {
        body.prompt =
          `Private background on this user (from their browser history — for your awareness only; ` +
          `do NOT repeat it back, list it, or write a report about it unless they explicitly ask):\n${bc}\n\n` +
          body.prompt;
      }
    } catch {
      /* context is best-effort */
    }
    // Prepend live page context so it's the freshest thing the model sees.
    if (livePageBlock && typeof body.prompt === "string") {
      body.prompt = `${livePageBlock}\n\n${body.prompt}`;
    }

    const atts = Array.isArray(attachments) ? attachments : [];
    const imageUrls = atts.filter((a) => a?.kind === "image" && a.dataUrl).map((a) => a.dataUrl);
    if (imageUrls.length) body.imageUrls = imageUrls;

    const send = (channel, payload) => {
      if (gen !== agent.generation) return;
      sendToAgentChannels(agent.id, channel, payload);
    };

    emitProgress(agent.id, {
      status: "running",
      step:
        skill === "report-edit"
          ? "Editing report…"
          : redesignOpenArtifact
            ? "Restyling artifact…"
            : refiningArtifact
              ? "Editing artifact…"
              : skill === "image"
                ? "Editing image…"
                : "Thinking…",
      skill,
    });
    send("lykn:agent-status", {
      status:
        skill === "report-edit"
          ? "Editing report…"
          : redesignOpenArtifact
            ? "Restyling artifact…"
            : refiningArtifact
              ? "Editing artifact…"
              : skill === "image"
                ? "Editing image…"
                : "Thinking…",
    });

    const res = await fetch(`${apiBase}/api/ai/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: agent.abort?.signal,
    });

    const suppressDone = !!opts.suppressDone;
    const mapSend = (channel, payload) => {
      // Remap overlay stream channels → agent channels. Always stash partial
      // text/status on the agent so switching back can restore the in-flight turn.
      if (channel === "lykn:answer-delta") {
        // Stream the growing summary into Glass so wrap-up never looks frozen
        // on a bare "Writing output…" spinner with no text.
        const text = String(payload?.text || "");
        agent.partialText = text;
        const n = text.length;
        const status =
          n > 80
            ? `Writing output… (${n.toLocaleString()} chars)`
            : String(agent.step || "Working…").trim() || "Working…";
        agent.step = status;
        send("lykn:agent-status", { status });
        send("lykn:agent-delta", {
          text,
          status,
          writing: true,
          chars: n,
        });
      } else if (channel === "lykn:answer-status") {
        const status = String(payload?.status || "").trim();
        if (status) agent.step = status;
        send("lykn:agent-status", payload);
      } else if (channel === "lykn:answer-sources") send("lykn:agent-sources", payload);
      else if (channel === "lykn:answer-error") send("lykn:agent-error", payload);
      else if (channel === "lykn:answer-done") {
        // Multi-step runs must NOT finalize the Glass turn between steps —
        // that looked like a finished reply + a duplicate user prompt.
        if (suppressDone) {
          const status = String(agent.step || "Working on next step…").trim();
          send("lykn:agent-status", { status });
        } else {
          // Land the streamed summary immediately so Glass isn't stuck on
          // "Writing output…" until the outer agent-done event.
          const text = String(agent.partialText || "").trim();
          if (text) {
            send("lykn:agent-delta", { text, final: true });
          }
          send("lykn:agent-status", {
            status: String(agent.step || "Finishing…").trim() || "Finishing…",
          });
        }
      } else send(channel, payload);
    };

    const accumulated = await readStreamResponse(res, mapSend, {
      // Image/build turns must not surface random vault cards after the deliverable.
      allowVaultSurface:
        skill !== "image" &&
        skill !== "build" &&
        skill !== "browse-summary" &&
        skill !== "report-edit" &&
        /\b(?:vault|saved|what\s+(?:have|did)\s+i\s+save|from\s+my\s+(?:notes?|vault))\b/i.test(
          String(text || ""),
        ),
      agentMode: true,
      agentId: agent.id,
      onAgentDeliverable: (d) => {
        if (gen !== agent.generation || !d) return;
        if (d.kind === "artifact" && d.code) {
          agent.lastArtifact = {
            toolName: d.toolName || "lykn_build_react_artifact",
            title: d.title || "Artifact",
            code: d.code,
            url: d.url || agent.lastArtifact?.url || "",
          };
          agent.lastDeliverableKind = "artifact";
        } else if (d.kind === "image" && d.url) {
          agent.lastImage = { url: d.url, title: d.title || "Generated image" };
          agent.lastDeliverableKind = "image";
        }
      },
    });
    if (gen !== agent.generation) return "";
    return accumulated;
  }

  function openResearchReportTab(agent, markdown) {
    openTextOutputInBrowser(agent, markdown, {
      title: `${agent.title || "Research"} report`,
      kind: "report",
      rememberAsReport: true,
    });
  }

  /** Skills whose answer body should land as formatted text in the browser. */
  function skillWantsTextBrowserOutput(skill) {
    // "general" is deliberately absent: conversational answers stay in the
    // rail's response area and never open a browser tab.
    return skill === "research" || skill === "report-edit" || skill === "browse-summary";
  }

  function looksLikeSubstantialTextOutput(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (t.length >= 120) return true;
    if (/^#{1,6}\s+/m.test(t)) return true;
    if (t.split("\n").filter(Boolean).length >= 3) return true;
    if (/\*\*[^*]+\*\*/.test(t) && t.length >= 60) return true;
    return false;
  }

  function openTextOutputInBrowser(
    agent,
    markdown,
    { title, kind = "report", rememberAsReport = false, show = true } = {},
  ) {
    if (typeof openStageArtifact !== "function") return false;
    const body = String(markdown || "").trim();
    if (!body) return false;
    // Deliverables open in their own subtab, so the live page (YouTube or
    // anything else) is never replaced — no need to suppress the report.
    if (rememberAsReport || kind === "report") {
      agent.lastResearchReport = body;
      agent.lastDeliverableKind = "report";
    } else {
      agent.lastDeliverableKind = agent.lastDeliverableKind || "report";
    }
    const label = String(title || `${agent.title || "Agent"} output`)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 48);
    try {
      const res = openStageArtifact({
        markdown: body,
        title: label,
        ownerAgentId: agent.id,
        kind: "report",
        reuseAgentTab: true,
        show: show !== false,
        focus: false,
      });
      return !!(res && res.ok !== false);
    } catch {
      return false;
    }
  }

  function maybeOpenTextOutputInBrowser(agent, answer, skill) {
    if (isMainAgent(agent)) return false;
    if (!skillWantsTextBrowserOutput(skill)) return false;
    const body = String(answer || "").trim();
    if (!body) return false;
    if (skill === "research" || skill === "report-edit") {
      return openTextOutputInBrowser(agent, body, {
        title: `${agent.title || "Research"} report`,
        kind: "report",
        rememberAsReport: true,
      });
    }
    if (skill === "browse-summary") {
      // Keep the live page; only open a summary doc when it's a real write-up.
      if (!looksLikeSubstantialTextOutput(body)) return false;
      return openTextOutputInBrowser(agent, body, {
        title: `${agent.title || "Agent"} summary`,
        kind: "report",
        rememberAsReport: false,
      });
    }
    // general — conversational chat. Keep the answer in the rail's response
    // area; never spawn a browser tab for it. (Real deliverable asks are
    // reclassified to build/research/image upstream and open tabs there.)
    return false;
  }

  /** Browse asks that still need a model write-up (not a one-line "opened X"). */
  function needsLlmBrowseSummary(text) {
    const t = String(text || "").toLowerCase();
    return /\b(summarize|summarise|summary|review|unanswered|analyze|analyse|explain|go through|flag|which ones|what (does|do|is|are)|tell me (about|what)|compare|draft a|write (a|me)|check|look\s+at|how (is|are|much)|status|performance|ads?|campaigns?|inbox|emails?)\b/.test(
      t,
    );
  }

  /** User asked for a keepable written deliverable (summary/report/write-up). */
  function wantsWrittenBrowseOutput(text) {
    const t = String(text || "").toLowerCase();
    return /\b(summarize|summarise|summary|write[- ]?up|write[- ]up|write (a|me|up|one)|draft (a|me)|report|brief|analysis|analyze|analyse|key (points|findings|takeaways)|takeaways?|recap|rundown|go through|walk me through|explain (what|this|it)|review (this|the|my|it))\b/.test(
      t,
    );
  }

  /** Compact action log from adaptive browse history. */
  function formatBrowseWorkLog(history, { max = 8 } = {}) {
    const acts = (Array.isArray(history) ? history : []).filter((h) => h?.result?.ok);
    const lines = [];
    const seen = new Set();
    for (const h of acts) {
      const type = String(h?.action?.type || "act").replace(/_/g, " ");
      const label = String(h?.action?.label || h?.result?.label || h?.action?.value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 72);
      const line = label ? `${type}: ${label}` : type;
      const key = line.toLowerCase();
      if (!line || seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${line}`);
      if (lines.length >= max) break;
    }
    return lines.join("\n");
  }

  /** Live Glass narrative while the browser agent is still clicking. */
  function formatBrowseWorkingNarrative({ history, status, taskPlan, url } = {}) {
    const parts = ["**Working through it…**"];
    const plan = String(taskPlan || "").trim();
    if (plan) {
      const clipped = plan
        .split("\n")
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .slice(0, 14)
        .join("\n")
        .slice(0, 1200);
      if (clipped) parts.push(clipped);
    }
    const log = formatBrowseWorkLog(history, { max: 6 });
    if (log) parts.push(`**Done so far**\n${log}`);
    const now = String(status || "").trim();
    if (now) parts.push(`_Now: ${now}_`);
    else if (url) parts.push(`_On: ${String(url).slice(0, 120)}_`);
    return parts.join("\n\n").slice(0, 4500);
  }

  /** Structured local close when we skip another LLM round. */
  function formatBrowseCompletionSummary({
    goal = "",
    history = [],
    page = {},
    url = "",
    planAnswer = "",
    label = "",
  } = {}) {
    const title = String(page?.title || "").trim();
    const pageText = String(page?.text || "");
    const work = formatBrowseWorkLog(history);
    const snippet = extractReadablePageSnippets(pageText, { maxLines: 5, maxChars: 1100 });
    const fromPlan = String(planAnswer || "").trim();
    const parts = [];
    parts.push("## What I did");
    if (work) parts.push(work);
    else if (label) parts.push(`- Opened **${String(label).slice(0, 100)}**`);
    else if (title) parts.push(`- Wrapped up on **${title.slice(0, 100)}**`);
    else parts.push("- Finished the browser steps for your ask.");

    parts.push("## Summary");
    if (fromPlan.length >= 40 && !/\b(i will|i'll|going to|next i|plan:)\b/i.test(fromPlan)) {
      parts.push(fromPlan.slice(0, 2500));
    } else if (snippet) {
      parts.push(snippet);
    } else if (title || url) {
      parts.push(
        title
          ? `You're on **${title.slice(0, 100)}**${url ? ` (${url})` : ""}.`
          : `The tab is ready${url ? ` at ${url}` : ""}.`,
      );
    } else {
      parts.push("The browser work for this ask is done.");
    }

    return ensureHelpfulAgentClose(parts.join("\n\n"), {
      goal,
      url,
      title,
      pageText,
    });
  }

  function maybeOpenBrowseWrittenOutput(agent, answer, ask) {
    if (isMainAgent(agent)) return false;
    if (!wantsWrittenBrowseOutput(ask)) return false;
    const body = String(answer || "").trim();
    if (!looksLikeSubstantialTextOutput(body)) return false;
    return openTextOutputInBrowser(agent, body, {
      title: `${agent.title || "Agent"} summary`,
      kind: "report",
      rememberAsReport: true,
    });
  }

  /** Concrete follow-ups based on where the agent landed. */
  function suggestNextStepsForBrowse({ goal = "", url = "", title = "", pageText = "" } = {}) {
    const u = String(url || "").toLowerCase();
    const g = String(goal || "").toLowerCase();
    const t = `${title}\n${pageText}`.toLowerCase();
    const tips = [];
    if (/ads\.reddit\.com|ads\.google|adsmanager\.facebook|ads\.tiktok|ads\.x\.com|linkedin\.com\/campaignmanager/.test(u)) {
      tips.push(
        "Open a campaign and walk through its performance",
        "Compare spend vs results for the last 7 days",
        "Flag or pause an underperforming ad",
      );
    } else if (/mail\.google\.com/.test(u)) {
      tips.push("Open the first email", "Draft a reply", "Check drafts or starred");
    } else if (/docs\.google\.com\/document/.test(u)) {
      tips.push("Edit or tighten the draft", "Share it with someone", "Add a short summary at the top");
    } else if (/docs\.google\.com\/spreadsheets/.test(u)) {
      tips.push("Add columns or clean the data", "Build a quick chart", "Paste more rows in");
    } else if (/youtube\.com\/watch/.test(u)) {
      tips.push("Open a different video", "Grab key points from this one", "Search for a related clip");
    } else if (/notion\.(so|site)|figma\.com|canva\.com/.test(u)) {
      tips.push("Edit what’s on screen", "Create a new blank file here", "Export or share this");
    } else if (/\b(sign[- ]?in|log[- ]?in)\b/.test(t)) {
      tips.push("Sign in in this tab, then say “continue”", "Tell me which account to use");
    } else if (/\b(quiz|question|exercise|lesson)\b/.test(t) || /\b(quiz|complete|finish)\b/.test(g)) {
      tips.push("Keep going through the next questions", "Submit when you’re ready", "Explain the last answer");
    }
    if (!tips.length) {
      if (/\b(check|review|look|status|how)\b/.test(g)) {
        tips.push(
          "Go deeper on one item on this page",
          "Summarize what stands out here",
          "Change a filter or date range",
        );
      } else {
        tips.push(
          "Tell me the next click or change you want",
          "Have me summarize this page",
          "Continue with another step here",
        );
      }
    }
    return tips.slice(0, 3);
  }

  /**
   * Agents should explain + suggest — not end on bare "Opened X. What next?".
   * Skips doubling up when the message already teaches / offers options.
   */
  function ensureHelpfulAgentClose(msg, ctx = {}) {
    let text = String(msg || "").trim();
    if (!text) return text;
    const alreadyHelpful =
      text.length >= 160 &&
      /\b(you(?:'re| are) on|here(?:'s| is) what|i (?:opened|found|checked|reviewed|looked)|this (?:page|tab|dashboard|shows)|want me to|you can|next i can|try asking|suggestions?)\b/i.test(
        text,
      ) &&
      !/\nWhat next\?\s*$/i.test(text);
    if (alreadyHelpful) return text;

    text = text.replace(/\n*What next\?\s*$/i, "").trim();
    const title = String(ctx.title || "").trim();
    const url = String(ctx.url || "").trim();
    if (
      title &&
      !new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 40), "i").test(text)
    ) {
      text += `\n\nYou're looking at **${title.slice(0, 100)}**`;
      if (url && !text.includes(url)) text += ` — open in this agent's browser`;
      text += `.`;
    }

    const tips = suggestNextStepsForBrowse(ctx);
    const tipBlock = tips.map((t, i) => `${i + 1}. ${t}`).join("\n");
    text += `\n\n**Want me to…**\n${tipBlock}`;
    return text;
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
    const body = extractReadablePageSnippets(pageText, { maxLines: 5, maxChars: 1100 });
    let msg = "Opened Gmail";
    if (sender) msg += `. The email is from **${sender}**`;
    if (subject) msg += `: “${subject}”`;
    if (time) msg += ` (${time})`;
    msg += ".";
    if (body) msg += `\n\n${body}`;
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
      `Here are the top emails in this agent's Gmail inbox:\n\n` +
      `${lines.join("\n")}\n\n` +
      (wantsUnanswered
        ? `These look like the ones most likely to need a reply — say which number to open.`
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
      const actLabel = String(last?.action?.label || last?.result?.label || "").trim();
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
    const raw = String(msg || "").trim();
    if (!raw) return "";
    const text = opts.skipEnrich
      ? raw
      : ensureHelpfulAgentClose(raw, {
          goal:
            opts.goal ||
            agent.lastIntent?.browseGoal ||
            agent.lastIntent?.understood ||
            "",
          url: opts.url || agent.url || "",
          title: opts.title || "",
          pageText: opts.pageText || "",
        });
    agent.partialText = text;
    agent.lastDeliverableKind = "browse";
    sendToAgentChannels(agent.id, "lykn:agent-delta", { text, final: true });
    sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Done" });
    return text;
  }

  async function finishBrowseResult(agent, text, gen, wc, opts = {}) {
    const page = opts.page || (await ownedBrowserAct.getPageContextRich(wc));
    const url = opts.url || page.url || wc.getURL?.() || agent.url || "";
    agent.url = url;
    const fromPlan = String(opts.planAnswer || "").trim();
    const hist = Array.isArray(opts.history) ? opts.history : [];
    const mustSummarize =
      needsLlmBrowseSummary(text) || wantsWrittenBrowseOutput(text);
    const wantsWrite = wantsWrittenBrowseOutput(text);
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

    const paintCtx = {
      goal: text,
      url,
      title: page.title || "",
      pageText: String(page.text || "").slice(0, 2000),
    };

    const structuredLocal = formatBrowseCompletionSummary({
      goal: text,
      history: hist,
      page,
      url,
      planAnswer: fromPlan,
      label: opts.label,
    });

    // Mid multi-step: never block the next step on a summary LLM call.
    if (opts.suppressDone) {
      const mid =
        fromPlan ||
        opts.quickMessage ||
        `Step done — ${page.title || url || "page ready"}.`;
      return paintBrowseDone(agent, mid, { ...paintCtx, skipEnrich: true });
    }

    const finishLocal = (msg, enrichOpts = {}) => {
      const out = paintBrowseDone(agent, msg, { ...paintCtx, ...enrichOpts });
      maybeOpenBrowseWrittenOutput(agent, out, text);
      return out;
    };

    // Action-only asks: land a structured What I did / Summary close immediately.
    // Summary / write-up asks always get a real wrap-up (LLM when possible).
    if (!mustSummarize) {
      if (
        structuredLocal.length >= 80 &&
        !/\b(cannot|can't|unable to click|sign in first)\b/i.test(structuredLocal)
      ) {
        return finishLocal(structuredLocal, { skipEnrich: true });
      }
      const quick =
        opts.quickMessage ||
        formatQuickBrowseAnswer({
          goal: text,
          page,
          url,
          history: hist,
          label: opts.label,
        });
      if (quick) return finishLocal(quick, { skipEnrich: true });
      if (fromPlan.length >= 20) return finishLocal(fromPlan);
    }

    emitProgress(agent.id, {
      status: "running",
      step: wantsWrite ? "Writing summary…" : "Wrapping up…",
      url,
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", {
      status: wantsWrite ? "Writing summary…" : "Wrapping up…",
    });
    // Show the working log immediately so Glass isn't blank while the model writes.
    if (structuredLocal.length >= 40) {
      agent.partialText = structuredLocal;
      sendToAgentChannels(agent.id, "lykn:agent-delta", {
        text: structuredLocal,
        final: false,
      });
    }

    const signedInMail = ownedBrowserAct.looksLikeSignedInMailUrl(url);
    const looksSignIn = ownedBrowserAct.looksLikeSignInWall({
      url,
      text: page.text,
      title: page.title,
    });
    const workLog = formatBrowseWorkLog(hist);
    const summaryPrompt =
      `${text}\n\n[Agent browsed ${url} in the LYKN Agent Browser]\nPage title: ${page.title || ""}\n` +
      (signedInMail && !looksSignIn
        ? `NOTE: Authenticated mail inbox — do not claim the user still needs to sign in.\n`
        : "") +
      (agent.lastIntent?.understood
        ? `What we understood the user wanted: ${agent.lastIntent.understood}\n`
        : "") +
      (workLog ? `Actions already taken:\n${workLog}\n\n` : "") +
      `Visible text:\n${String(page.text || "").slice(0, 8000)}\n\n` +
      (hist.length
        ? `Browse step log (raw): ${JSON.stringify(hist.slice(-10))}\n\n`
        : "") +
      (wantsWrite
        ? `The user asked for a written summary/report. Write a complete standalone markdown document they can keep.\n`
        : `Write a helpful closing reply for the user using ONLY the page content and actions above.\n`) +
      `Structure (use these headings):\n` +
      `## What I did\n` +
      `- Brief bullets of the browser work already completed (do not invent clicks).\n` +
      `## Summary\n` +
      `- The main findings / answer — thorough if they asked to summarize, review, analyze, or write anything up.\n` +
      `## Want me to…\n` +
      `- 2–3 concrete next steps the user can ask for.\n` +
      `Do not invent sources or claim you searched the web. ` +
      `Do not tell the user to open the page themselves — it is already open. ` +
      `Never say you cannot click or control the browser — this agent owns the tab and already acted. ` +
      `Never end with only “What next?” — always teach + suggest.`;

    let summary = "";
    try {
      summary = await streamChat(agent, summaryPrompt, [], "browse-summary", gen, {
        suppressDone: false,
      });
    } catch {
      summary = "";
    }
    if (!String(summary || "").trim() || String(summary).trim().length < 40) {
      return finishLocal(structuredLocal || fromPlan || "Finished the browse task.", {
        skipEnrich: true,
      });
    }
    maybeOpenBrowseWrittenOutput(agent, summary, text);
    return summary;
  }

  /** Immediate "on it" acknowledgment for deliverable turns — shown in the
   *  response area before the work starts. Conversational skills return ""
   *  (their answer streams in directly, no ack needed). */
  function deliverableKickoffText(skill) {
    switch (skill) {
      case "research":
        return "On it — I'll research this and put a report together. It'll open in a subtab here when it's ready.";
      case "report-edit":
        return "On it — updating the report now. The refreshed version will replace the open one.";
      case "build":
        return "On it — building that for you now. It'll open in a subtab here when it's ready.";
      case "image":
        return "On it — generating your image. It'll open in a subtab here in a moment.";
      case "tool-create":
      case "sheets-create":
        return "On it — setting that up in the tool now.";
      case "sheets-fill":
        return "On it — putting the research into Sheets now.";
      default:
        return "";
    }
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
      if (/\b(couldn't|could not|stuck|incomplete|not finish|couldn't finish|still open)\b/i.test(full)) {
        return full;
      }
      return full || `Done${agent?.url ? ` — ${agent.url}` : ""}.`;
    }
    if (skill === "build") {
      const title = agent?.lastArtifact?.title || "artifact";
      return `Finished — **${title}** is open in the browser.`;
    }
    if (skill === "image") {
      return `Finished — image is open in the browser.`;
    }
    if (skill === "research" || skill === "report-edit") {
      return `Finished — research report is open in the browser.`;
    }
    if (skill === "sheets-fill") {
      const short = String(answer || "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 420);
      return short || `Finished — research report pasted into Google Sheets.`;
    }
    if (skill === "tool-create" || skill === "sheets-create") {
      const full = String(answer || "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 6000);
      return full || `Finished — created in the requested tool.`;
    }
    if (multi && stepCount > 1) {
      return `Finished — ${stepCount} steps done. Outputs are in the browser.`;
    }
    if (openedInBrowser) {
      return `Finished — output is open in the browser.`;
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

  /** Glass multi-step summary — each step is a clickable chip with its result. */
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
      const label = String(steps[i] || del.label || "Step")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 72);
      const marker = `![lykn_step:${kind}:Step ${i + 1} · ${label}](lykn-agent-step://${agent.id}/${i})`;
      const status =
        i < done ? "done" : i === done ? "in progress" : "pending";
      const body = (ans || String(del.summary || "").trim())
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 1200);
      lines.push(
        `${marker}\n**Step ${i + 1}/${total}** · ${label} — ${status}.` +
          (body && i < done ? `\n\n${body}` : ""),
      );
    }
    const head =
      done >= total
        ? `All ${total} steps finished. Tap a step to open it in the browser.\n\n`
        : `Progress: ${done}/${total} steps finished. Tap a finished step to open it.\n\n`;
    return head + lines.join("\n\n---\n\n");
  }

  /** @deprecated alias — Glass no longer embeds full step bodies */
  function formatMultiStepAnswer(agent, steps, stepAnswers) {
    return formatMultiStepGlassStatus(agent, steps, stepAnswers);
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
          });
        } else {
          showBrowserWindow?.(id, { focus: true, label: agent.title || "Agent" });
          const wc = getBrowserWebContents?.(id);
          if (wc && del.url) {
            void ownedBrowserAct.navigate(wc, del.url).catch(() => {});
          }
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
        });
      } else {
        showBrowserWindow?.(id, { focus: true, label: agent.title || "Agent" });
      }
    } catch (e) {
      return { ok: false, error: e?.message || "show_failed" };
    }
    return { ok: true, kind: del.kind, index: Number(stepIndex) };
  }

  function isSimpleOpenBrowseGoal(text, url) {
    if (!url) return false;
    if (ownedBrowserAct.askStillNeedsAdaptiveWork?.(text)) return false;
    const cleaned = String(text || "")
      .trim()
      .toLowerCase()
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/\bwww\.\S+/gi, " ")
      .replace(/\b[a-z0-9][a-z0-9-]*\.[a-z]{2,}(?:\/[^\s]*)?/gi, " ")
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return true;
    const allow = new Set([
      "please",
      "can",
      "you",
      "could",
      "hey",
      "open",
      "up",
      "a",
      "an",
      "the",
      "my",
      "browser",
      "page",
      "site",
      "tab",
      "website",
      "visit",
      "go",
      "to",
      "launch",
      "load",
      "browse",
      "take",
      "me",
      "for",
      "now",
      "just",
      "there",
    ]);
    return cleaned.split(" ").every((w) => allow.has(w));
  }

  /**
   * Prefer the current step text. Forcing the FULL ask on every adaptive pass
   * made the agent rewrite/re-open work it had already finished.
   * Residual work is handled via remainingAskGoal at recheck points.
   */
  function browseAskForAdaptive(text, opts = {}) {
    const full = String(opts.fullAsk || "").trim();
    const step = String(text || "").trim();
    return step || full;
  }

  /** Snapshot live page + history for progress checks. */
  async function askProgressContext(agent) {
    const empty = {
      url: agent.url || "",
      pageText: "",
      title: "",
      history: agent.lastAdaptiveHistory || [],
    };
    try {
      const wc = getBrowserWebContents?.(agent.id);
      if (!wc || wc.isDestroyed?.()) return empty;
      const page = await ownedBrowserAct.getPageContext(wc);
      return {
        url: page?.url || agent.url || "",
        pageText: page?.text || "",
        title: page?.title || "",
        history: agent.lastAdaptiveHistory || [],
      };
    } catch {
      return empty;
    }
  }

  function getLiveTabUrl(agent, wc) {
    try {
      const fromWc = wc?.getURL?.() || "";
      if (!ownedBrowserAct.isPlaceholderAgentUrl(fromWc)) return fromWc;
    } catch {
      /* ignore */
    }
    const stored = String(agent?.url || "");
    return ownedBrowserAct.isPlaceholderAgentUrl(stored) ? "" : stored;
  }

  /**
   * If the owned tab is behind a sign-in wall, tell the user, raise the
   * browser, wait for them to sign in, then continue. Returns:
   *   { blocked:false } — no wall
   *   { blocked:true, cleared:true } — waited and wall cleared
   *   { blocked:true, cleared:false, message } — timeout/abort; stop the step
   */
  async function pauseForUserSignIn(agent, gen, wc, { context } = {}) {
    if (!wc || wc.isDestroyed?.()) return { blocked: false };
    let page = { url: "", text: "", title: "" };
    const quickUrl = wc.getURL?.() || agent.url || "";
    // Non-auth destinations: don't burn settle + scrape between multi-step tasks.
    if (
      quickUrl &&
      !ownedBrowserAct.isPlaceholderAgentUrl?.(quickUrl) &&
      ownedBrowserAct.urlMaybeNeedsAuthCheck &&
      !ownedBrowserAct.urlMaybeNeedsAuthCheck(quickUrl)
    ) {
      return { blocked: false };
    }
    // Already on a signed-in mail URL — skip the long settle; a quick scrape is enough.
    const quickSignedInMail =
      ownedBrowserAct.looksLikeSignedInMailUrl(quickUrl) &&
      !/accounts\.google|ServiceLogin|signin/i.test(quickUrl);
    try {
      await ownedBrowserAct.waitForDomSettle(wc, quickSignedInMail ? 120 : 320);
      page = await ownedBrowserAct.getPageContext(wc);
    } catch {
      /* ignore */
    }
    const pageUrl = page.url || quickUrl;
    const pageTitle = page.title || wc.getTitle?.() || "";
    // URL can still look like #inbox while Google is showing the public landing
    // page — never skip the wall check based on URL alone.
    const gmailNeedsAuth = ownedBrowserAct.looksLikeGmailNeedsSignIn({
      url: pageUrl,
      text: page.text,
      title: pageTitle,
    });
    if (
      !gmailNeedsAuth &&
      ownedBrowserAct.looksLikeSignedInMailUrl(pageUrl) &&
      !/accounts\.google|ServiceLogin|signin/i.test(pageUrl)
    ) {
      return { blocked: false };
    }
    if (
      !ownedBrowserAct.looksLikeSignInWall({
        url: pageUrl,
        text: page.text,
        title: pageTitle,
      })
    ) {
      return { blocked: false };
    }
    // Stuck on marketing Gmail — force the real login URL before waiting.
    if (
      gmailNeedsAuth &&
      !/accounts\.google\.com/i.test(pageUrl) &&
      ownedBrowserAct.gmailSignInUrl
    ) {
      try {
        const login = ownedBrowserAct.gmailSignInUrl();
        const loginNav = await ownedBrowserAct.navigate(wc, login);
        if (loginNav.ok) {
          agent.url = loginNav.url || login;
          page.url = agent.url;
        }
      } catch {
        /* ignore */
      }
    }

    let host = "this site";
    try {
      host = new URL(pageUrl).hostname.replace(/^www\./i, "") || host;
    } catch {
      /* ignore */
    }
    const where = context ? ` · ${context}` : "";
    // Same channel as other browse status lines (thinking spinner), not a chat delta.
    const waitStatus =
      `Sign-in wall on ${host}${where} — sign in in the agent browser, then I'll continue`;
    const resumeStatus = `Signed in on ${host} — continuing…`;

    // Raise the stage so the user can find the tab quickly.
    try {
      showBrowserWindow?.(agent.id, { focus: true, label: agent.title || "Agent" });
    } catch {
      /* ignore */
    }

    agent.step = waitStatus;
    agent.status = "waiting";
    agent.partialText = "";
    agent.url = pageUrl || agent.url;
    emitProgress(agent.id, {
      status: "waiting",
      step: waitStatus,
      url: agent.url,
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", { status: waitStatus });
    schedulePersist();

    const waited = await ownedBrowserAct.waitForSignInClear(wc, {
      signal: agent.abort?.signal,
      timeoutMs: 5 * 60 * 1000,
      pollMs: 1600,
      onTick: () => {
        if (gen !== agent.generation) return;
        emitProgress(agent.id, {
          status: "waiting",
          step: waitStatus,
          url: wc.getURL?.() || agent.url,
          skill: "browse",
        });
        sendToAgentChannels(agent.id, "lykn:agent-status", { status: waitStatus });
      },
    });

    if (gen !== agent.generation) {
      return { blocked: true, cleared: false, superseded: true, message: "" };
    }

    if (!waited?.ok) {
      const timeoutStatus =
        waited?.error === "aborted"
          ? "Stopped while waiting for sign-in"
          : `Still signed out on ${host} — sign in in the agent browser, then ask me to continue`;
      agent.status = "idle";
      agent.step = "Needs sign-in";
      agent.partialText = "";
      emitProgress(agent.id, {
        status: "idle",
        step: timeoutStatus,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", { status: timeoutStatus });
      // Terminal note for history / multi-step stop — keep it short like a status line.
      return { blocked: true, cleared: false, message: timeoutStatus };
    }

    agent.status = "running";
    agent.step = resumeStatus;
    agent.url = waited.url || wc.getURL?.() || agent.url;
    agent.partialText = "";
    emitProgress(agent.id, {
      status: "running",
      step: resumeStatus,
      url: agent.url,
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", { status: resumeStatus });
    syncAgentBrowserTabs({ focusId: agent.id });
    return { blocked: true, cleared: true, message: "" };
  }

  async function summarizeCurrentTab(agent, text, gen, wc) {
    const currentUrl = getLiveTabUrl(agent, wc);
    agent.url = currentUrl;
    showBrowserWindow?.(agent.id, { focus: false, label: agent.title || "Agent" });
    syncAgentBrowserTabs({ focusId: agent.id });
    emitProgress(agent.id, {
      status: "running",
      step: "Reading current tab…",
      url: currentUrl,
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Reading current tab…" });
    sendToAgentChannels(agent.id, "lykn:agent-browser", {
      url: currentUrl,
      title: wc.getTitle?.() || "",
    });

    // Prefer the inbox hash so we scrape the list, not account chrome / marketing.
    if (
      (ownedBrowserAct.looksLikeSignedInMailUrl(currentUrl) ||
        ownedBrowserAct.looksLikeGmailPublicPage(currentUrl) ||
        /mail\.google\.com|google\.com\/gmail|\.gmail\.com/i.test(currentUrl)) &&
      /\b(emails?|inbox|messages?|mail|gmail|reply|respond|top|unanswered)\b/i.test(text) &&
      (!/#inbox\b/i.test(currentUrl) || ownedBrowserAct.looksLikeGmailPublicPage(currentUrl))
    ) {
      try {
        const inboxUrl = ownedBrowserAct.gmailInboxUrl();
        emitProgress(agent.id, {
          status: "running",
          step: "Opening inbox…",
          url: inboxUrl,
          skill: "browse",
        });
        const nav = await ownedBrowserAct.navigate(wc, inboxUrl);
        if (nav.ok) {
          agent.url = nav.url || inboxUrl;
          syncAgentBrowserTabs({ focusId: agent.id });
        }
      } catch {
        /* keep current */
      }
    }

    if (
      ownedBrowserAct.looksLikeSignedInMailUrl(currentUrl) ||
      /mail\.google\.com/i.test(currentUrl || "")
    ) {
      emitProgress(agent.id, {
        status: "running",
        step: "Reading inbox…",
        url: currentUrl,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Reading inbox…" });
      const ready = await ownedBrowserAct.waitForMailReady?.(wc, { timeoutMs: 4000 });
      if (ready?.ok || ready?.rows?.length) {
        /* use ready below */
      } else {
        await ownedBrowserAct.waitForDomSettle(wc, 400);
      }
    } else {
      await ownedBrowserAct.waitForDomSettle(wc, 700);
    }
    let page = await ownedBrowserAct.getPageContextRich(wc);
    const pageUrl = page.url || currentUrl;
    if (ownedBrowserAct.looksLikeSignedInMailUrl(pageUrl) || page.inboxTitle) {
      for (let i = 0; i < 2; i++) {
        const hasRows = Array.isArray(page.rows) && page.rows.length > 0;
        if (hasRows) break;
        await ownedBrowserAct.waitForDomSettle(wc, 450);
        page = await ownedBrowserAct.getPageContextRich(wc);
      }
    }

    agent.url = page.url || currentUrl || agent.url;
    if (ownedBrowserAct.isPlaceholderAgentUrl(agent.url)) {
      throw new Error("This agent tab is still blank — open a site first, then ask again.");
    }

    const mailRows = Array.isArray(page.rows) ? page.rows.filter(Boolean) : [];
    const hasMailRows = mailRows.length > 0;
    const signedInMail =
      hasMailRows ||
      page.inboxTitle ||
      ownedBrowserAct.looksLikeSignedInMailUrl(agent.url) ||
      /\binbox\b/i.test(page.title || "");
    // Gmail chrome often contains a literal "Sign in" control — ignore that when we have rows/inbox.
    let looksSignIn =
      !hasMailRows &&
      !page.inboxTitle &&
      ownedBrowserAct.looksLikeSignInWall({
        url: agent.url,
        text: page.text,
        title: page.title,
      });

    if (looksSignIn && !hasMailRows) {
      const pause = await pauseForUserSignIn(agent, gen, wc, {
        context: "reading this tab",
      });
      if (pause.blocked && !pause.cleared) {
        return pause.message || "";
      }
      if (pause.cleared) {
        page = await ownedBrowserAct.getPageContextRich(wc);
        agent.url = page.url || agent.url;
        looksSignIn = ownedBrowserAct.looksLikeSignInWall({
          url: agent.url,
          text: page.text,
          title: page.title,
        });
      }
    }

    const mailRowsAfter = Array.isArray(page.rows) ? page.rows.filter(Boolean) : [];
    const hasMailRowsAfter = mailRowsAfter.length > 0;
    const isSheetsTab = ownedBrowserAct.looksLikeGoogleSheetsUrl?.(agent.url);
    if (isSheetsTab && ownedBrowserAct.looksLikeOrganizeSheetAsk?.(text)) {
      return runOrganizeSheet(agent, text, gen);
    }
    const knownSheet = isSheetsTab ? getKnownSheetText(agent) : "";
    const mailBlock = hasMailRowsAfter
      ? `Top visible emails (from the open inbox — user IS signed in):\n` +
        mailRowsAfter
          .slice(0, 10)
          .map((r, i) => `${i + 1}. ${r}`)
          .join("\n")
      : isSheetsTab && knownSheet
        ? `Known Google Sheet contents (canvas scrape is unreliable — use THIS, never call the sheet blank):\n${knownSheet.slice(0, 8000)}`
        : `Visible text:\n${String(page.text || "").slice(0, 8000)}`;

    const summaryPrompt =
      `${text}\n\n` +
      `[ALREADY OPEN tab — do not ask the user to open Gmail.]\n` +
      `Current URL: ${agent.url}\nPage title: ${page.title || ""}\n` +
      (hasMailRowsAfter || (signedInMail && !looksSignIn)
        ? `NOTE: User is signed in. Review the emails below. NEVER say they need to sign in.\n`
        : "") +
      (isSheetsTab
        ? `NOTE: Google Sheets is canvas-based. Page scrapes often look empty even when the sheet has data. ` +
          (knownSheet
            ? `The sheet HAS data (shown below). NEVER say it is blank.\n`
            : `If no remembered contents are listed, say you cannot read cell values from the scrape — do not invent that the sheet is empty if the user says it has data.\n`)
        : "") +
      (looksSignIn
        ? `NOTE: Still looks like a login form — tell the user sign-in is still needed.\n`
        : "") +
      `${mailBlock}\n\n` +
      (hasMailRowsAfter
        ? `List these top emails and flag which ones likely need a reply. Use ONLY the list above — do not invent messages.\n`
        : isSheetsTab
          ? `Answer about this sheet using the known contents above. Do not claim the sheet is blank.\n`
          : `Answer from this page only. If you cannot see email rows, say the inbox list was not readable yet — do not invent emails.\n`);

    // Simple inbox list — finish from the scrape, don't wait on another model call.
    if (hasMailRowsAfter && !needsLlmBrowseSummary(text)) {
      const quick = formatInboxListAnswer(mailRowsAfter, text);
      if (quick) return paintBrowseDone(agent, quick);
    }
    emitProgress(agent.id, {
      status: "running",
      step: "Wrapping up…",
      url: agent.url,
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Wrapping up…" });
    return streamChat(agent, summaryPrompt, [], "browse-summary", gen);
  }

  async function runAdaptiveBrowse(agent, text, gen, wc, opts = {}) {
    let result = null;
    const goalForRounds = String(opts.adaptiveGoal || text || "");
    const multiStepBrowse =
      /\b(then|after that|and then|complete|finish|solve|quiz|exercise|lesson|practice|work\s+through|fill|submit|all|every|entire|share|invite)\b/i.test(
        goalForRounds,
      );
    const maxRounds = Math.max(
      4,
      Math.min(30, Number(opts.maxRounds) || (multiStepBrowse ? 22 : 14)),
    );
    const convHistory =
      (Array.isArray(opts.conversationHistory) && opts.conversationHistory.length
        ? opts.conversationHistory
        : null) || historyForPlanner(agent);
    const browseGoal = String(opts.adaptiveGoal || text || "").trim() || String(text || "").trim();
    emitProgress(agent.id, {
      status: "running",
      step: "Working on this page…",
      url: wc.getURL?.() || agent.url,
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Working on this page…" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (gen !== agent.generation) return opts.returnRaw ? { ok: false, error: "aborted" } : "";
      const pause = await pauseForUserSignIn(agent, gen, wc, {
        context: "working on this page",
      });
      if (pause.blocked && !pause.cleared) {
        if (opts.returnRaw) {
          return {
            ok: false,
            stuck: true,
            error: "sign_in_required",
            answer: pause.message || "Sign-in needed.",
            url: agent.url,
          };
        }
        return pause.message || "";
      }

      emitProgress(agent.id, {
        status: "running",
        step: "Clicking around…",
        url: wc.getURL?.() || agent.url,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Clicking around…" });

      result = await ownedBrowserAct.executeOwnedAdaptiveTask({
        webContents: wc,
        goal: browseGoal,
        conversationHistory: convHistory,
        signal: agent.abort?.signal,
        maxRounds,
        onProgress: (p) => {
          if (gen !== agent.generation) return;
          const status = p.status || "Browsing…";
          agent.step = status;
          if (Array.isArray(p.history)) agent.lastAdaptiveHistory = p.history;
          emitProgress(agent.id, {
            status: "running",
            step: status,
            url: p.url || wc.getURL(),
            skill: "browse",
          });
          sendToAgentChannels(agent.id, "lykn:agent-status", { status });
          sendToAgentChannels(agent.id, "lykn:agent-browser", {
            url: p.url || wc.getURL(),
            title: wc.getTitle?.() || "",
          });
          // Paint the working-through logic in Glass while clicks continue.
          const narrative = formatBrowseWorkingNarrative({
            history: Array.isArray(p.history)
              ? p.history
              : agent.lastAdaptiveHistory || [],
            status,
            taskPlan: p.taskPlan || "",
            url: p.url || wc.getURL?.() || agent.url || "",
          });
          if (narrative.length >= 24) {
            agent.partialText = narrative;
            sendToAgentChannels(agent.id, "lykn:agent-delta", {
              text: narrative,
              final: false,
            });
          }
        },
        planNext: async (ctx) => {
          // Fresh screenshot each round: lets the planner SEE the page and use
          // click_coord on icons/canvases/iframe content the DOM catalog misses.
          let imageUrl = "";
          try {
            imageUrl =
              (await ownedBrowserAct.screenshotDataUrl(wc, {
                maxWidth: 1200,
                jpegQuality: 70,
              })) || "";
          } catch {
            /* screenshot is best-effort */
          }
          return planOwnedBrowserNext({
            ...ctx,
            imageUrl,
            conversationHistory: ctx.conversationHistory || convHistory,
          });
        },
      });

      agent.url = result.url || wc.getURL() || agent.url;
      if (Array.isArray(result?.history) && result.history.length) {
        agent.lastAdaptiveHistory = result.history;
      }
      if (!result.ok && result.error === "aborted") {
        return opts.returnRaw ? result : "";
      }
      if (!result.ok && result.error === "sign_in_required") {
        // Loop: pauseForUserSignIn at the top of the next attempt.
        continue;
      }
      if (!result.ok) throw new Error(result.error || "Browse failed");
      break;
    }

    if (!result?.ok) {
      if (result?.error === "sign_in_required") {
        const pause = await pauseForUserSignIn(agent, gen, wc, {
          context: "finishing this browse task",
        });
        if (pause.blocked && !pause.cleared) {
          if (opts.returnRaw) {
            return {
              ok: false,
              stuck: true,
              error: "sign_in_required",
              answer: pause.message || "Sign-in needed.",
              url: agent.url,
            };
          }
          return pause.message || "";
        }
      } else {
        throw new Error(result?.error || "Browse failed");
      }
    }
    if (ownedBrowserAct.isPlaceholderAgentUrl(agent.url)) {
      throw new Error("Browser stayed on a blank page — could not complete the browse task.");
    }

    if (opts.returnRaw) {
      return {
        ok: true,
        stuck: !!result?.stuck,
        answer: result?.answer || "",
        history: result?.history || [],
        url: agent.url,
        satisfiedEarly: !!result?.satisfiedEarly,
      };
    }

    // Browser work is done — finish from scrape / plan answer; LLM only when needed.
    return finishBrowseResult(agent, text, gen, wc, {
      planAnswer: result?.answer,
      history: result?.history,
      suppressDone: !!opts.suppressDone,
      forceQuick: !!result?.satisfiedEarly,
    });
  }

  function priorAssistantText(agent) {
    const hist = Array.isArray(agent?.history) ? agent.history : [];
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i]?.role === "assistant" && String(hist[i].content || "").trim()) {
        return String(hist[i].content);
      }
    }
    return "";
  }

  /** User goal before the latest user turn (used after clarification is pushed). */
  function priorUserGoalBeforeLatest(agent) {
    const hist = Array.isArray(agent?.history) ? agent.history : [];
    let seenLatest = false;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i]?.role !== "user") continue;
      if (!seenLatest) {
        seenLatest = true;
        continue;
      }
      return String(hist[i].content || "").trim();
    }
    return "";
  }

  /** Recent user turns (excluding the latest) for browse follow-up context. */
  function recentUserGoals(agent, limit = 6) {
    const hist = Array.isArray(agent?.history) ? agent.history : [];
    const out = [];
    let seenLatest = false;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i]?.role !== "user") continue;
      const content = String(hist[i].content || "").trim();
      if (!content) continue;
      if (!seenLatest) {
        seenLatest = true;
        continue;
      }
      out.push(content);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Chat turns for the click planner — blend Main + worker so short follow-ups
   * ("do it", "play it") see the whole Agent Mode conversation.
   */
  function historyForPlanner(agent) {
    const own = Array.isArray(agent?.history) ? agent.history : [];
    const main = getMainAgent();
    const mainHist =
      main && main.id !== agent?.id && Array.isArray(main.history) ? main.history : [];
    const blended = [];
    const seen = new Set();
    for (const m of [...mainHist.slice(-6), ...own.slice(-8)]) {
      const role = m?.role === "assistant" ? "assistant" : "user";
      const content = String(m?.content || "").replace(/\s+/g, " ").trim().slice(0, 700);
      if (!content) continue;
      const key = `${role}:${content.slice(0, 100)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      blended.push({ role, content });
    }
    return blended.slice(-8);
  }

  function parseJsonMailDraft(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced?.[1] || s).trim();
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const obj = JSON.parse(candidate.slice(start, end + 1));
      if (!obj || typeof obj !== "object") return null;
      const body = String(obj.body || "").trim();
      if (!body) return null;
      return {
        to: String(obj.to || "").trim(),
        subject: String(obj.subject || "").trim(),
        body,
        sender: String(obj.sender || "").trim(),
      };
    } catch {
      return null;
    }
  }

  /** Silent LLM rewrite so tone edits land in Gmail, not only in chat. */
  async function llmMailDraft(agent, userText, prior, gen, opts = {}) {
    const token = await getAuthToken().catch(() => null);
    if (!token) return null;
    const replyTo = opts.replyTo && typeof opts.replyTo === "object" ? opts.replyTo : null;
    const isReply = !!opts.isReply && !!replyTo;
    const openedBlock = replyTo
      ? `\nOpened email to reply to:\n` +
        `From: ${replyTo.from || replyTo.sender || "unknown"}` +
        (replyTo.email ? ` <${replyTo.email}>` : "") +
        `\nSubject: ${replyTo.subject || "(no subject)"}\n` +
        `Body:\n${String(replyTo.body || "").slice(0, 3500)}\n`
      : "";
    const prompt = isReply
      ? `You write Gmail REPLY drafts for LYKN Agent Mode.\n` +
        `Return ONLY valid JSON (no markdown) with keys: to, subject, body, sender.\n` +
        `This is a reply to the opened email below — address their points specifically.\n` +
        `to = the original sender's email; subject = Re: <original subject> (keep existing Re:);\n` +
        `body = the reply only (greeting + response + sign-off). Do NOT invent a new cold email.\n` +
        `Do not say you will send it.\n` +
        openedBlock +
        `\nPrior draft:\n${JSON.stringify(prior || {})}\n\n` +
        `User request:\n${String(userText || "").slice(0, 2500)}`
      : `You write Gmail drafts for LYKN Agent Mode.\n` +
        `Return ONLY valid JSON (no markdown) with keys: to, subject, body, sender.\n` +
        `body must be the full email (greeting + paragraphs + sign-off).\n` +
        `Apply the user's tone/style instructions exactly (humorous, less serious, formal, shorter, etc.).\n` +
        `Keep the same recipient unless the user changes it. Do not say you will send it.\n` +
        openedBlock +
        `\nPrior draft:\n${JSON.stringify(prior || {})}\n\n` +
        `User request:\n${String(userText || "").slice(0, 2500)}`;
    try {
      const res = await fetch(`${apiBase}/api/ai/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: "lykn",
          intent: "ask",
          text: prompt.slice(0, 6000),
          prompt,
          useTools: false,
          overlayAsk: true,
          agentMode: true,
          skipWebSearch: true,
          forceWebSearch: false,
        }),
        signal: agent.abort?.signal,
      });
      if (gen !== agent.generation) return null;
      let acc = "";
      await readStreamResponse(
        res,
        (channel, payload) => {
          if (channel === "lykn:answer-delta" && payload?.text != null) {
            acc = String(payload.text);
          }
        },
        { allowVaultSurface: false, agentMode: true, agentId: agent.id },
      );
      if (gen !== agent.generation) return null;
      return parseJsonMailDraft(acc);
    } catch {
      return null;
    }
  }

  function rememberOpenedMail(agent, patch = {}) {
    const prev = agent.lastOpenedMail && typeof agent.lastOpenedMail === "object"
      ? agent.lastOpenedMail
      : {};
    agent.lastOpenedMail = {
      ...prev,
      ...patch,
      at: new Date().toISOString(),
    };
    return agent.lastOpenedMail;
  }

  /**
   * Open Gmail compose and fill To/Subject/Body in the form (not just chat).
   * Reply asks stay on the open thread and use Reply — not a blank compose.
   */
  async function runMailCompose(agent, text, gen, wc) {
    const isPaste = ownedBrowserAct.looksLikePasteIntoCompose(text);
    const fromHistory = ownedBrowserAct.parseMailDraftFromText(priorAssistantText(agent));
    const prior = agent.lastMailDraft || fromHistory;
    let liveUrl = getLiveTabUrl(agent, wc);
    const isRevision = ownedBrowserAct.looksLikeMailDraftRevision(text, {
      hasMailDraft: !!(prior || agent.lastMailDraft),
      onMail:
        ownedBrowserAct.looksLikeSignedInMailUrl(liveUrl) ||
        !!ownedBrowserAct.isGmailComposeUrl?.(liveUrl),
    });
    const alreadyCompose = ownedBrowserAct.isGmailComposeUrl(liveUrl);
    const replyAll = /\breply\s*all\b/i.test(text);
    let opened = agent.lastOpenedMail || null;

    const isReply =
      ownedBrowserAct.looksLikeMailReplyTask?.(text) ||
      (!!opened &&
        /\b(that|this|the)\s+(email|message|one|thread)\b/i.test(text) &&
        /\b(draft|write|compose|reply|respond|response)\b/i.test(text));

    // Reply with no open thread → open the first email first (common multi-step miss).
    if (isReply && !isRevision && !isPaste) {
      const onThread = isGmailThreadUrl(liveUrl) || isGmailThreadUrl(opened?.url || "");
      const hasContext = !!(opened?.email || opened?.subject || (opened?.body && opened.body.length > 40));
      if (!onThread || !hasContext) {
        emitProgress(agent.id, {
          status: "running",
          step: "Opening the email to reply to…",
          url: liveUrl,
          skill: "browse",
        });
        sendToAgentChannels(agent.id, "lykn:agent-status", {
          status: "Opening the email to reply to…",
        });
        await openMailItemOnTab(agent, "open the first email", gen, wc, {
          suppressDone: true,
          silent: true,
        });
        liveUrl = getLiveTabUrl(agent, wc);
        opened = agent.lastOpenedMail || opened;
      }
    }

    // Prefer a fresh scrape of the open thread so multi-step "draft a response
    // for that email" keeps real sender/subject/body context.
    if (
      ownedBrowserAct.looksLikeSignedInMailUrl(liveUrl) ||
      /mail\.google\.com/i.test(liveUrl || "")
    ) {
      try {
        const scraped = await ownedBrowserAct.extractOpenMailThread?.(wc);
        if (scraped?.ok && (scraped.subject || scraped.body || scraped.from || scraped.email)) {
          opened = rememberOpenedMail(agent, {
            from: scraped.from || opened?.from || "",
            sender: scraped.from || opened?.sender || "",
            email:
              scraped.email ||
              opened?.email ||
              ownedBrowserAct.extractEmailAddress?.(scraped.body || "") ||
              "",
            subject: scraped.subject || opened?.subject || "",
            body: scraped.body || opened?.body || "",
            url: scraped.url || liveUrl || opened?.url || "",
            label: opened?.label || "",
          });
        }
      } catch {
        /* keep prior */
      }
    }

    let draft;
    if (isPaste && !isRevision && prior) {
      draft = {
        to: prior.to || ownedBrowserAct.extractEmailAddress(text) || "",
        subject: prior.subject || "",
        body: prior.body || "",
        sender: prior.sender || "",
      };
    } else {
      emitProgress(agent.id, {
        status: "running",
        step: isRevision
          ? "Rewriting draft…"
          : isReply
            ? "Writing reply…"
            : "Writing draft…",
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", {
        status: isRevision
          ? "Rewriting draft…"
          : isReply
            ? "Writing reply…"
            : "Writing draft…",
      });
      const llmDraft = await llmMailDraft(agent, text, prior, gen, {
        replyTo: opened,
        isReply,
      });
      draft = llmDraft || ownedBrowserAct.synthesizeMailDraft(text, prior);
      // Keep recipient across rewrites unless user named a new one.
      if (prior?.to && !ownedBrowserAct.extractEmailAddress(text)) {
        draft.to = prior.to;
      }
      if (prior?.sender && !draft.sender) draft.sender = prior.sender;
      // Reply: force to/subject from the opened email when the model omits them.
      if (isReply && opened) {
        if (!draft.to) {
          draft.to =
            opened.email ||
            ownedBrowserAct.extractEmailAddress?.(opened.body || "") ||
            ownedBrowserAct.extractEmailAddress?.(opened.label || "") ||
            "";
        }
        if (!draft.subject && opened.subject) {
          draft.subject = /^re\s*:/i.test(opened.subject)
            ? opened.subject
            : `Re: ${opened.subject}`;
        }
        if (!draft.sender && opened.from) draft.sender = opened.from;
      }
    }

    if (!String(draft.body || "").trim()) {
      const msg =
        "I couldn't build the email body. Try again with the recipient and the tone you want.";
      agent.partialText = msg;
      sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg });
      return msg;
    }

    // Never open a blank To: on a reply — block and recover context instead.
    if (isReply && !String(draft.to || "").trim()) {
      emitProgress(agent.id, {
        status: "running",
        step: "Finding recipient…",
        skill: "browse",
      });
      await openMailItemOnTab(agent, "open the first email", gen, wc, {
        suppressDone: true,
        silent: true,
      });
      opened = agent.lastOpenedMail || opened;
      draft.to =
        opened?.email ||
        ownedBrowserAct.extractEmailAddress?.(opened?.body || "") ||
        draft.to ||
        "";
      if (!draft.subject && opened?.subject) {
        draft.subject = /^re\s*:/i.test(opened.subject)
          ? opened.subject
          : `Re: ${opened.subject}`;
      }
    }

    agent.lastMailDraft = draft;
    const composeUrl = ownedBrowserAct.resolveGmailComposeUrl(text, draft);

    emitProgress(agent.id, {
      status: "running",
      step: isRevision
        ? "Updating Gmail draft…"
        : isReply
          ? "Filling reply…"
          : "Filling Gmail compose…",
      url: liveUrl || composeUrl,
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", {
      status: isRevision
        ? "Updating Gmail draft…"
        : isReply
          ? "Filling reply…"
          : "Filling Gmail compose…",
    });
    showBrowserWindow?.(agent.id, { focus: false, label: agent.title || "Agent" });

    // Reply path: stay on the open thread, click Reply, fill the reply box.
    if (isReply && !isRevision) {
      const threadUrl = opened?.url || liveUrl;
      if (
        threadUrl &&
        /mail\.google\.com/i.test(threadUrl) &&
        !ownedBrowserAct.isGmailComposeUrl(liveUrl)
      ) {
        // If we left the thread (or never opened it), go back before Reply.
        const onThread =
          /(?:#|\/)(?:inbox|all|sent|drafts|label\/[^/]+)\/[A-Za-z0-9]+/i.test(liveUrl || "");
        if (!onThread && /(?:#|\/)(?:inbox|all|sent|drafts|label\/[^/]+)\/[A-Za-z0-9]+/i.test(threadUrl)) {
          try {
            const nav = await ownedBrowserAct.navigate(wc, threadUrl);
            if (nav.ok) {
              agent.url = nav.url || threadUrl;
              syncAgentBrowserTabs({ focusId: agent.id });
              await ownedBrowserAct.waitForDomSettle(wc, 700);
            }
          } catch {
            /* keep */
          }
        }
      }
      const replied = await ownedBrowserAct.clickGmailReply?.(wc, { replyAll });
      if (replied?.ok) {
        await ownedBrowserAct.waitForDomSettle(wc, 700);
        agent.url = wc.getURL?.() || agent.url;
        syncAgentBrowserTabs({ focusId: agent.id });
        // Fill body; also set To when we know the address (Reply sometimes leaves it blank).
        let filled = await ownedBrowserAct.fillGmailComposeDraft(wc, {
          to: draft.to || "",
          subject: "",
          body: draft.body,
        });
        if (!filled?.body) {
          await ownedBrowserAct.waitForDomSettle(wc, 900);
          filled = await ownedBrowserAct.fillGmailComposeDraft(wc, {
            to: draft.to || "",
            subject: draft.subject || "",
            body: draft.body,
          });
        }
        const who = draft.to || opened?.from || opened?.email || "them";
        const subj = draft.subject || opened?.subject || "";
        const msg =
          `Drafted a **reply**` +
          (who ? ` to **${who}**` : "") +
          (subj ? ` — “${subj}”` : "") +
          ` in this agent's Gmail (not sent).\n\n` +
          `${String(draft.body).slice(0, 1200)}` +
          `\n\nWant changes, or should I leave it here?`;
        agent.partialText = msg;
        sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg, final: true });
        return msg;
      }
      // Reply button missed — fall through to compose deep-link WITH to= filled.
      if (!draft.to) {
        const msg =
          "I opened the email but couldn't start a Reply (no recipient address found). Open the message and ask me to draft a reply again.";
        return paintBrowseDone(agent, msg);
      }
    }

    // Revisions: fill the open compose window in place when possible.
    if (!alreadyCompose || (!isRevision && !isPaste)) {
      const nav = await ownedBrowserAct.navigate(wc, composeUrl);
      if (!nav.ok) throw new Error(nav.error || "Could not open Gmail compose.");
      agent.url = nav.url || composeUrl;
      syncAgentBrowserTabs({ focusId: agent.id });
      await ownedBrowserAct.waitForDomSettle(wc, 1800);
    } else {
      syncAgentBrowserTabs({ focusId: agent.id });
      await ownedBrowserAct.waitForDomSettle(wc, 600);
    }

    let filled = await ownedBrowserAct.fillGmailComposeDraft(wc, draft);
    if (!filled?.body || !filled?.subject) {
      await ownedBrowserAct.waitForDomSettle(wc, 1400);
      filled = await ownedBrowserAct.fillGmailComposeDraft(wc, draft);
    }
    // Last resort: reload compose deep-link with su/body then fill again.
    if (!filled?.body) {
      const nav2 = await ownedBrowserAct.navigate(wc, composeUrl);
      if (nav2.ok) {
        agent.url = nav2.url || composeUrl;
        await ownedBrowserAct.waitForDomSettle(wc, 1800);
        filled = await ownedBrowserAct.fillGmailComposeDraft(wc, draft);
      }
    }

    // Return keyboard to the glass bar — Gmail fill focuses the agent stage.
    try {
      focusOverlayComposer?.();
    } catch {
      /* ignore */
    }

    const okBody = !!filled?.body;
    const okSubject = !!filled?.subject;
    const msg = okBody
      ? `${isRevision ? "Updated" : "Filled"} the **Gmail compose** draft (not sent).\n\n` +
        `**To:** ${draft.to || "—"}\n` +
        `**Subject:** ${draft.subject || "—"}\n\n` +
        `It's in the compose window now — ask for more edits anytime (funnier, shorter, different subject, etc.). I won't send unless you ask.`
      : `I wrote the draft but couldn't fully reach Gmail's message body field` +
        (okSubject ? " (subject was updated)" : "") +
        `. Trying the text here too:\n\n` +
        `**To:** ${draft.to || "—"}\n` +
        `**Subject:** ${draft.subject || "—"}\n\n` +
        `${draft.body}\n\n` +
        `Say “paste that into the email” and I'll retry filling the body.`;

    agent.partialText = msg;
    sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg });
    return msg;
  }

  function isGmailThreadUrl(url) {
    return /mail\.google\.com/i.test(String(url || "")) &&
      /(?:#|\/)(?:inbox|all|sent|drafts|starred|label\/[^/]+)\/[A-Za-z0-9]+/i.test(
        String(url || ""),
      );
  }

  async function waitForGmailThread(wc, timeoutMs = 3500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const u = wc.getURL?.() || "";
      if (isGmailThreadUrl(u)) return u;
      await ownedBrowserAct.waitForDomSettle(wc, 280);
    }
    return wc.getURL?.() || "";
  }

  async function openMailItemOnTab(agent, text, gen, wc, opts = {}) {
    emitProgress(agent.id, {
      status: "running",
      step: "Opening email…",
      url: agent.url || wc.getURL?.() || "",
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Opening email…" });
    // Ensure inbox is showing (not already a random page).
    const live = getLiveTabUrl(agent, wc) || "";
    if (!/mail\.google\.com/i.test(live) || ownedBrowserAct.looksLikeGmailPublicPage(live)) {
      try {
        const inbox = ownedBrowserAct.gmailInboxUrl();
        await ownedBrowserAct.navigate(wc, inbox);
        agent.url = wc.getURL?.() || inbox;
        syncAgentBrowserTabs({ focusId: agent.id });
      } catch {
        /* keep */
      }
    }
    const ready = await ownedBrowserAct.waitForMailReady?.(wc, { timeoutMs: 5000 });
    if (ready?.error === "sign_in_required") {
      const pause = await pauseForUserSignIn(agent, gen, wc, { context: "opening an email" });
      if (pause.blocked && !pause.cleared) return pause.message || "";
    }
    const idx = ownedBrowserAct.extractMailOpenIndex?.(text) ?? 0;
    const hint =
      ownedBrowserAct.extractQuotedTitle(text) ||
      (String(text || "").match(/\bfrom\s+([A-Za-z][\w.-]{1,40})/i) || [])[1] ||
      "";
    let clicked = await ownedBrowserAct.clickGmailInboxRow?.(wc, { index: idx, hint });
    if (!clicked?.ok) {
      await ownedBrowserAct.waitForDomSettle(wc, 500);
      clicked = await ownedBrowserAct.clickGmailInboxRow?.(wc, { index: idx, hint });
    }
    // Confirm the thread actually opened — a no-op click used to leave us on inbox.
    let threadUrl = await waitForGmailThread(wc, 3200);
    if (!isGmailThreadUrl(threadUrl)) {
      emitProgress(agent.id, {
        status: "running",
        step: "Retrying email open…",
        url: agent.url,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Retrying email open…" });
      clicked = await ownedBrowserAct.clickGmailInboxRow?.(wc, { index: idx, hint });
      threadUrl = await waitForGmailThread(wc, 3200);
    }
    if (!clicked?.ok && !isGmailThreadUrl(threadUrl)) {
      // Fall back to adaptive click loop.
      return runAdaptiveBrowse(agent, text, gen, wc, opts || {});
    }
    await ownedBrowserAct.waitForDomSettle(wc, 450);
    agent.url = threadUrl || wc.getURL?.() || agent.url;
    syncAgentBrowserTabs({ focusId: agent.id });
    const page = await ownedBrowserAct.getPageContextRich(wc);
    const label = clicked?.label || page.rows?.[idx] || "email";
    // Persist thread context for later steps ("draft a response for that email").
    try {
      const thread = await ownedBrowserAct.extractOpenMailThread?.(wc);
      const labelBits = String(label || "")
        .split(/\s+[—–\-]\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const email =
        thread?.email ||
        ownedBrowserAct.extractEmailAddress?.(thread?.body || "") ||
        ownedBrowserAct.extractEmailAddress?.(label) ||
        "";
      rememberOpenedMail(agent, {
        label,
        from: thread?.from || labelBits[0] || "",
        sender: thread?.from || labelBits[0] || "",
        email,
        subject: thread?.subject || labelBits[1] || "",
        body: thread?.body || "",
        url: thread?.url || agent.url || "",
      });
    } catch {
      rememberOpenedMail(agent, { label, url: agent.url || "" });
    }
    if (!isGmailThreadUrl(agent.url) && !agent.lastOpenedMail?.subject) {
      const msg =
        "I opened Gmail but couldn't get into the email thread. Ask me to open the first email again.";
      if (opts.silent) return msg;
      return paintBrowseDone(agent, msg);
    }
    // Sub-step for reply drafting — keep context, don't paint a finished Glass turn.
    if (opts.silent) {
      return `Opened email${label ? `: ${label}` : ""}`;
    }
    // Finish from the scrape immediately — don't wait on a summary model call.
    return finishBrowseResult(agent, text, gen, wc, {
      page,
      url: agent.url,
      label,
      forceQuick: true,
      suppressDone: !!opts.suppressDone,
    });
  }

  async function actOnCurrentTab(agent, text, gen, wc, inPageUrl, opts = {}) {
    const currentUrl = getLiveTabUrl(agent, wc);
    agent.url = currentUrl;
    showBrowserWindow?.(agent.id, { focus: false, label: agent.title || "Agent" });
    syncAgentBrowserTabs({ focusId: agent.id });

    // Share-the-open-page asks stay on this tab (Share dialog), never Gmail compose.
    const sharesCurrentPage =
      !ownedBrowserAct.looksLikeSignedInMailUrl(currentUrl) &&
      !/mail\.google\.com/i.test(currentUrl || "") &&
      ownedBrowserAct.looksLikeShareCurrentPageAsk?.(text);
    const onMailTab =
      ownedBrowserAct.looksLikeSignedInMailUrl(currentUrl) ||
      /mail\.google\.com/i.test(currentUrl || "") ||
      !!ownedBrowserAct.isGmailComposeUrl?.(currentUrl);
    const mailRevisionHere = ownedBrowserAct.looksLikeMailDraftRevision(text, {
      hasMailDraft: !!agent.lastMailDraft,
      onMail: onMailTab,
    });
    if (
      !sharesCurrentPage &&
      (ownedBrowserAct.looksLikeMailComposeTask(text) ||
        ownedBrowserAct.looksLikePasteIntoCompose(text) ||
        (mailRevisionHere && (onMailTab || !!agent.lastMailDraft)))
    ) {
      return runMailCompose(agent, text, gen, wc);
    }

    // Open first / Nth email on the live Gmail tab — no slow LLM click loop.
    if (
      ownedBrowserAct.looksLikeOpenMailItem?.(text) &&
      (ownedBrowserAct.looksLikeSignedInMailUrl(currentUrl) ||
        /mail\.google\.com/i.test(currentUrl || ""))
    ) {
      return openMailItemOnTab(agent, text, gen, wc, opts);
    }

    // "click that link" / "open the subscribe button" on the current page.
    if (
      /\b(click|open|tap|press|follow)\b.{0,48}\b(link|button|here|that|this|it)\b/i.test(text) &&
      currentUrl &&
      !ownedBrowserAct.looksLikeOpenSearchResult(text)
    ) {
      const hint =
        ownedBrowserAct.extractQuotedTitle(text) ||
        (String(text || "").match(
          /\b(?:click|open|tap|press|follow)\s+(?:on\s+|the\s+)?["“]?(.+?)["”]?\s*$/i,
        ) || [])[1] ||
        "";
      if (hint || /\b(first|top)\s+link\b/i.test(text)) {
        emitProgress(agent.id, {
          status: "running",
          step: hint ? `Clicking “${String(hint).slice(0, 40)}”…` : "Clicking link…",
          url: currentUrl,
          skill: "browse",
        });
        sendToAgentChannels(agent.id, "lykn:agent-status", {
          status: hint ? `Clicking “${String(hint).slice(0, 40)}”…` : "Clicking link…",
        });
        const clicked = await ownedBrowserAct.clickInPageByHint?.(wc, {
          hint: hint || "",
          index: 0,
        });
        if (clicked?.ok) {
          await ownedBrowserAct.waitForDomSettle(wc, 500);
          agent.url = wc.getURL?.() || clicked.href || agent.url;
          syncAgentBrowserTabs({ focusId: agent.id });
          const page = await ownedBrowserAct.getPageContext(wc);
          const msg =
            `Clicked **${clicked.label || hint || "link"}**` +
            (agent.url ? `\n\n${agent.url}` : "") +
            `\n\nPage title: ${page.title || "page"}\n\nWhat next?`;
          agent.partialText = msg;
          sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg, final: true });
          return msg;
        }
      }
    }

    // "check my drafts" on Gmail → open the Drafts label, then summarize.
    if (ownedBrowserAct.looksLikeMailDraftsReview?.(text)) {
      const draftsUrl =
        ownedBrowserAct.resolveInPageTargetUrl(text, currentUrl) ||
        ownedBrowserAct.gmailDraftsUrl?.() ||
        "https://mail.google.com/mail/u/0/#drafts";
      emitProgress(agent.id, {
        status: "running",
        step: "Opening drafts…",
        url: draftsUrl,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Opening drafts…" });
      try {
        const nav = await ownedBrowserAct.navigate(wc, draftsUrl);
        if (nav.ok) {
          agent.url = nav.url || draftsUrl;
          syncAgentBrowserTabs({ focusId: agent.id });
        }
      } catch {
        /* keep current */
      }
      return summarizeCurrentTab(agent, text, gen, wc);
    }

    // YouTube (etc.) results: click the named / first video instead of chat-refusing.
    if (
      currentUrl &&
      ownedBrowserAct.looksLikeOpenSearchResult(text) &&
      (/youtube\.com|youtu\.be/i.test(currentUrl) || /[?&]search_query=|\/results\?/i.test(currentUrl))
    ) {
      const prior = priorAssistantText(agent);
      const hint =
        ownedBrowserAct.extractQuotedTitle(text) ||
        ownedBrowserAct.extractQuotedTitle(prior) ||
        "";
      const wantFirst =
        /\b(first|one of these|any|a video|top)\b/i.test(text) ||
        /\bclick on one\b/i.test(text);
      emitProgress(agent.id, {
        status: "running",
        step: hint ? `Opening “${hint.slice(0, 40)}”…` : "Opening a result…",
        url: currentUrl,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", {
        status: hint ? `Opening “${hint.slice(0, 40)}”…` : "Opening a result…",
      });
      const clicked = await ownedBrowserAct.clickSearchResultOnPage(wc, {
        hint,
        index: wantFirst || !hint ? 0 : 0,
      });
      if (clicked?.ok) {
        await ownedBrowserAct.waitForDomSettle(wc, 1600);
        agent.url = wc.getURL?.() || clicked.href || agent.url;
        syncAgentBrowserTabs({ focusId: agent.id });
        const title = clicked.title || hint || "video";
        const msg =
          `Opened **${title}** in this agent's browser` +
          (agent.url ? `\n\n${agent.url}` : "") +
          `\n\nWant me to pause, skip, or find another one?`;
        agent.partialText = msg;
        sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg });
        return msg;
      }
      // Fall through to adaptive browse if DOM click missed.
    }

    if (inPageUrl) {
      emitProgress(agent.id, {
        status: "running",
        step: "Opening page on this site…",
        url: inPageUrl,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", {
        status: "Opening page on this site…",
      });
      const nav = await ownedBrowserAct.navigate(wc, inPageUrl);
      if (nav.ok) {
        agent.url = nav.url || inPageUrl;
        syncAgentBrowserTabs({ focusId: agent.id });
        // "go to the sign in page" — deep link is enough; don't burn a click loop.
        if (
          /\b(sign[- ]?in|log[- ]?in|login|sign[- ]?up|register)\b/i.test(text) &&
          !/\b(click|fill|type|submit|enter|password|email)\b/i.test(text)
        ) {
          await ownedBrowserAct.waitForDomSettle(wc, 1000);
          const page = await ownedBrowserAct.getPageContext(wc);
          const title = page.title || wc.getTitle?.() || "page";
          const opened = agent.url || inPageUrl;
          const msg =
            `Opened **${opened}** in this agent tab.\n\n` +
            `Page title: ${title}\n\n` +
            `You can sign in here — tell me when you're done or what to do next.`;
          agent.partialText = msg;
          sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg });
          return msg;
        }
      }
      // Fall through to adaptive click if deep-link nav failed.
    }

    // Share asks: click Share → type email → Send with a deterministic path
    // first. Vision planners keep narrating this without landing the clicks.
    if (sharesCurrentPage && ownedBrowserAct.sharePageWithEmail) {
      emitProgress(agent.id, {
        status: "running",
        step: "Opening Share…",
        url: agent.url || currentUrl,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Opening Share…" });
      const shared = await ownedBrowserAct.sharePageWithEmail(wc, { ask: text });
      if (gen !== agent.generation) return "";
      agent.url = wc.getURL?.() || agent.url || currentUrl;
      // Only finish when the invite is verified. Partial / stuck results must
      // keep working (adaptive) — never paint "done" after merely opening Share.
      if (shared?.ok && shared?.verified && !shared.stuck) {
        return paintBrowseDone(agent, shared.message || `Shared with ${shared.email}.`);
      }
      emitProgress(agent.id, {
        status: "running",
        step: "Finishing share — entering email and sending…",
        url: agent.url,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", {
        status: "Finishing share — entering email and sending…",
      });
    }

    emitProgress(agent.id, {
      status: "running",
      step: "Working on this page…",
      url: agent.url || currentUrl,
      skill: "browse",
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", { status: "Working on this page…" });
    const tabCtx = {
      priorGoal: priorUserGoalBeforeLatest(agent),
      priorAssistant: priorAssistantText(agent),
      recentUserGoals: recentUserGoals(agent, 6),
      lastBrowseQuery: agent.lastBrowseQuery || "",
      currentUrl: currentUrl || agent.url || "",
      priorUrl: agent.lastBrowseUrl || "",
    };
    let adaptiveGoal =
      ownedBrowserAct.composeAdaptiveBrowseGoal?.(text, tabCtx) ||
      ownedBrowserAct.expandDeicticFollowUp?.(text, tabCtx) ||
      text;
    if (sharesCurrentPage) {
      const recipients = (String(text || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).join(", ");
      adaptiveGoal =
        `Share the OPEN document with ${recipients || "the person the user named"} via this page's Share dialog. ` +
        `VERIFY each step: (1) Share dialog open, (2) type ${recipients || "their email"} into Add people until the chip shows, ` +
        `(3) click the dialog's blue Send / Send invite button ONLY, (4) confirm invitation-sent text. ` +
        `CRITICAL: After the email chip appears, NEVER click Cancel, Close, Done, Discard, the X, or outside the dialog — ` +
        `that discards the invite. NEVER re-click the top toolbar Share button (it closes the dialog). ` +
        `Only Send inside the dialog finishes the task. ` +
        `Ask: ${String(text || "").trim().slice(0, 180)}`;
    }
    const result = await runAdaptiveBrowse(agent, text, gen, wc, {
      ...(opts || {}),
      adaptiveGoal,
      conversationHistory: historyForPlanner(agent),
      returnRaw: !!sharesCurrentPage,
      maxRounds: sharesCurrentPage ? 22 : opts?.maxRounds,
    });
    if (sharesCurrentPage && result && typeof result === "object") {
      const recipients = (String(text || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []);
      let pageText = "";
      try {
        const page = await ownedBrowserAct.getPageContext(wc);
        pageText = `${page.title || ""}\n${page.text || ""}`;
      } catch {
        /* ignore */
      }
      const pageComplete = recipients.length
        ? recipients.every((e) =>
            ownedBrowserAct.pageShowsShareInviteComplete?.(pageText, e),
          )
        : ownedBrowserAct.pageShowsShareInviteComplete?.(pageText);
      const historyComplete = ownedBrowserAct.historyShowsShareSendDone?.(
        result.history || [],
        recipients,
      );
      const dialogStillOpen = ownedBrowserAct.pageShowsShareDialogOpen?.(pageText);
      // Success if page shows invite-sent / post-send UI, OR we already typed+Sent
      // and the invite dialog is gone (a follow-up screen is fine).
      const verifiedShare =
        result.ok &&
        (pageComplete ||
          result.satisfiedEarly ||
          (historyComplete && !dialogStillOpen) ||
          (historyComplete && pageComplete));
      if (verifiedShare) {
        return paintBrowseDone(
          agent,
          result.answer ||
            `Shared with **${recipients[0] || "the recipient"}** from this page.`,
        );
      }
      // Incomplete — honest stuck message, never "Share step finished."
      // But if the adaptive loop already produced a success answer, prefer that.
      if (
        result.ok &&
        !result.stuck &&
        /\bshared with\b/i.test(String(result.answer || ""))
      ) {
        return paintBrowseDone(agent, result.answer);
      }
      return paintBrowseDone(
        agent,
        result.answer ||
          `I couldn't finish sharing${recipients[0] ? ` with **${recipients[0]}**` : ""} — ` +
            `the invite is not confirmed yet. The Share dialog may still be open in the tab. ` +
            `Tell me to continue and I'll keep going.`,
      );
    }
    return result;
  }

  /** Keep starred agent-browser links in sync before "open X" resolution. */
  function refreshSavedLinkAliases() {
    try {
      const bookmarks = require("./agentBookmarks.cjs");
      const store = bookmarks.readBookmarks(userDataPath);
      ownedBrowserAct.setUserSiteAliases(bookmarks.buildAliasMap(store));
    } catch {
      /* ignore */
    }
  }

  async function runBrowse(agent, text, gen, opts = {}) {
    // Clarifications like "youtube.com" after "which site?" must actually navigate.
    // Merge with the prior misspelled goal so search/chart intent is preserved.
    let browseText = String(text || "").trim();
    const fullAsk = String(opts.fullAsk || text || "").trim();
    const workAsk = browseAskForAdaptive(browseText, { fullAsk });
    const stillNeedsWork = !!ownedBrowserAct.askStillNeedsAdaptiveWork?.(workAsk);
    // Starred links first — refresh aliases so "open my …" hits saved bookmarks.
    if (
      ownedBrowserAct.looksLikeOpenDestinationAsk?.(browseText) ||
      ownedBrowserAct.looksLikeWrongOpenDestinationAsk?.(browseText)
    ) {
      refreshSavedLinkAliases();
    }
    const clarifyUrl = ownedBrowserAct.resolveSiteClarificationUrl(browseText);
    const priorGoal = priorUserGoalBeforeLatest(agent);
    const priorAsk = priorAssistantText(agent);
    const priorGoals = recentUserGoals(agent, 6);
    const retargetToSite = ownedBrowserAct.looksLikeRetargetSearchToSite(browseText);
    const namedSiteUrl =
      clarifyUrl ||
      ownedBrowserAct.extractUrlFromText(browseText) ||
      ownedBrowserAct.extractUrlFromText(text);
    const isClarifyFollowUp =
      !!clarifyUrl ||
      ownedBrowserAct.priorAskedForSiteClarification(priorAsk) ||
      (priorGoal && ownedBrowserAct.looksLikeBrowseSiteClarification(browseText)) ||
      retargetToSite;
    if (isClarifyFollowUp && namedSiteUrl && (priorGoal || agent.lastBrowseQuery)) {
      // "no pull it up in youtube" + prior "find mr beast" → youtube search, not blank home.
      browseText = `${namedSiteUrl} ${priorGoal || agent.lastBrowseQuery || ""}`.trim();
    } else if (isClarifyFollowUp && clarifyUrl) {
      browseText = clarifyUrl;
    }

    const browseCtx = {
      priorGoal,
      priorAssistant: priorAsk,
      recentUserGoals: priorGoals,
      lastBrowseQuery: agent.lastBrowseQuery || "",
      currentUrl:
        (agent.url && !ownedBrowserAct.isPlaceholderAgentUrl(agent.url) ? agent.url : "") || "",
      priorUrl: agent.lastBrowseUrl || "",
    };

    // Short follow-ups ("ok play it", "do it", "open that") — expand from chat + open app.
    if (
      ownedBrowserAct.looksLikeDeicticFollowUp?.(text) ||
      ownedBrowserAct.looksLikePlayMediaFollowUp?.(text)
    ) {
      const expanded =
        ownedBrowserAct.expandDeicticFollowUp?.(text, browseCtx) || "";
      if (expanded) browseText = expanded;
    }

    const videoIntent =
      ownedBrowserAct.looksLikeVideoBrowseIntent(browseText) ||
      ownedBrowserAct.looksLikeVideoBrowseIntent(text) ||
      ownedBrowserAct.looksLikeVideoBrowseIntent(priorGoal);
    const playMediaAsk =
      ownedBrowserAct.looksLikePlayMediaAsk?.(browseText) ||
      ownedBrowserAct.looksLikePlayMediaAsk?.(text) ||
      ownedBrowserAct.looksLikePlayMediaFollowUp?.(text);
    const wantLatestVideo =
      ownedBrowserAct.wantsLatestVideo(browseText) ||
      ownedBrowserAct.wantsLatestVideo(text) ||
      ownedBrowserAct.wantsLatestVideo(priorGoal);
    // "that's not right" after an auto-open → re-search prior destination, do NOT click.
    const wrongOpenAsk = ownedBrowserAct.looksLikeWrongOpenDestinationAsk?.(text);
    const wrongOpenTopic = wrongOpenAsk
      ? String(
          agent.lastOpenDestination ||
            agent.lastOpenDestQuery ||
            ownedBrowserAct.extractOpenDestinationName?.(priorGoal) ||
            "",
        )
          .trim()
          .slice(0, 80)
      : "";

    let openDestAsk =
      !wrongOpenAsk &&
      !playMediaAsk &&
      (ownedBrowserAct.looksLikeOpenDestinationAsk?.(browseText) ||
        ownedBrowserAct.looksLikeOpenDestinationAsk?.(text) ||
        ownedBrowserAct.looksLikeNewBlankWorkspaceAsk?.(browseText, browseCtx) ||
        ownedBrowserAct.looksLikeNewBlankWorkspaceAsk?.(text, browseCtx));
    let openDestName =
      (openDestAsk &&
        (ownedBrowserAct.extractOpenDestinationName?.(browseText) ||
          ownedBrowserAct.extractOpenDestinationName?.(text))) ||
      wrongOpenTopic ||
      "";

    let searchQuery =
      (videoIntent
        ? ownedBrowserAct.extractVideoSearchQuery(browseText) ||
          ownedBrowserAct.extractVideoSearchQuery(text) ||
          ownedBrowserAct.extractVideoSearchQuery(priorGoal)
        : "") ||
      ownedBrowserAct.extractSearchQuery(browseText) ||
      ownedBrowserAct.extractSearchQuery(text) ||
      ownedBrowserAct.extractSearchQuery(priorGoal) ||
      (retargetToSite || isClarifyFollowUp ? String(agent.lastBrowseQuery || "").trim() : "");

    // Intent breakdown may have already deduced the real dashboard URL.
    const preferredUrl = String(opts.preferredUrl || agent.preferredBrowseUrl || "").trim();
    let url =
      (/^https?:\/\//i.test(preferredUrl) && !/google\.com\/search/i.test(preferredUrl)
        ? preferredUrl
        : "") ||
      ownedBrowserAct.resolveBrowseTargetUrl(browseText, browseCtx) ||
      ownedBrowserAct.resolveBrowseTargetUrl(text, browseCtx) ||
      namedSiteUrl ||
      clarifyUrl;

    // Saved/starred links always win for "open X" (checked inside resolve*).
    // Correction follow-up: force a Google search for the last open target — no auto-click.
    let skipAutoOpenResult = false;
    if (wrongOpenAsk && wrongOpenTopic) {
      url = `https://www.google.com/search?q=${encodeURIComponent(wrongOpenTopic)}`;
      searchQuery = wrongOpenTopic;
      openDestAsk = false;
      skipAutoOpenResult = true;
      agent.lastOpenDestManual = true;
    }

    // "open X" / blank-sheet create — don't treat the destination as a search query.
    if (openDestAsk && url) {
      if (/google\.com\/search/i.test(url)) {
        try {
          searchQuery = new URL(url).searchParams.get("q") || openDestName || searchQuery;
        } catch {
          searchQuery = openDestName || searchQuery;
        }
        agent.lastOpenDestination = openDestName || searchQuery || "";
        agent.lastOpenDestQuery = searchQuery || openDestName || "";
      } else {
        searchQuery = "";
        // Direct / starred deep link — remember name for "that's not right" corrections.
        if (openDestName) {
          agent.lastOpenDestination = openDestName;
          agent.lastOpenDestQuery = openDestName;
        }
      }
    }

    // Cold-start vague video ask with no site named → YouTube, never quiz the user.
    if (videoIntent && searchQuery && (!url || /google\.com\/search/i.test(url))) {
      url = ownedBrowserAct.youtubeSearchUrl(searchQuery, { sortByDate: wantLatestVideo });
    }

    // Create the owned tab only when browsing; show it once we have a real URL
    // (or when the active agent needs a visible surface for click-through work).
    ensureBrowserWindow?.(agent.id, { show: false });
    const wc = getBrowserWebContents?.(agent.id);
    if (!wc) throw new Error("Could not open agent browser session.");

    const currentUrl = getLiveTabUrl(agent, wc);
    // Organize/format the open sheet — use remembered paste (canvas scrape looks blank).
    if (
      ownedBrowserAct.looksLikeOrganizeSheetAsk?.(text) ||
      ownedBrowserAct.looksLikeOrganizeSheetAsk?.(browseText)
    ) {
      return runOrganizeSheet(agent, text, gen);
    }
    // Re-resolve with the live tab — follow-ups like "blank sheet" need Sheets context.
    browseCtx.currentUrl = currentUrl || browseCtx.currentUrl || "";
    if (
      (!url || /google\.com\/search/i.test(url)) &&
      (ownedBrowserAct.looksLikeNewBlankWorkspaceAsk?.(text, browseCtx) ||
        ownedBrowserAct.looksLikeNewBlankWorkspaceAsk?.(browseText, browseCtx))
    ) {
      const contextual =
        ownedBrowserAct.resolveBrowseTargetUrl(browseText, browseCtx) ||
        ownedBrowserAct.resolveBrowseTargetUrl(text, browseCtx);
      if (contextual && !/google\.com\/search/i.test(contextual)) {
        url = contextual;
        searchQuery = "";
      }
    }
    const contextUrl =
      currentUrl ||
      (agent.url && !ownedBrowserAct.isPlaceholderAgentUrl(agent.url) ? agent.url : "");
    const currentTabTask = ownedBrowserAct.looksLikeCurrentTabTask(text);
    const signInNav = ownedBrowserAct.looksLikeSignInNavigation(text);
    const inPageAction =
      ownedBrowserAct.looksLikeInPageAction(text) ||
      ownedBrowserAct.looksLikeInPageAction(browseText) ||
      ownedBrowserAct.looksLikeDeicticFollowUp?.(text) ||
      ownedBrowserAct.looksLikeOpenSearchResult(text) ||
      signInNav;
    const mailCompose = ownedBrowserAct.looksLikeMailComposeTask(text);
    const pasteCompose = ownedBrowserAct.looksLikePasteIntoCompose(text);
    const currentIsMail =
      !!contextUrl &&
      (ownedBrowserAct.looksLikeSignedInMailUrl(contextUrl) ||
        /mail\.google\.com|google\.com\/gmail|\.gmail\.com/i.test(contextUrl) ||
        !!ownedBrowserAct.isGmailComposeUrl?.(contextUrl));
    const mailRevision = ownedBrowserAct.looksLikeMailDraftRevision(text, {
      hasMailDraft: !!agent.lastMailDraft,
      onMail: currentIsMail,
    });
    let inPageUrl = contextUrl
      ? ownedBrowserAct.resolveInPageTargetUrl(text, contextUrl) ||
        ownedBrowserAct.resolveSignInUrl(text, contextUrl)
      : signInNav
        ? ownedBrowserAct.resolveSignInUrl(text, "") || ownedBrowserAct.gmailSignInUrl()
        : "";

    // Sign-in page asks must never become a Google search of the phrase.
    if (signInNav) {
      const signUrl =
        inPageUrl ||
        ownedBrowserAct.resolveSignInUrl(text, contextUrl) ||
        ownedBrowserAct.gmailSignInUrl();
      if (signUrl) {
        url = signUrl;
        searchQuery = "";
        inPageUrl = signUrl;
      }
    } else if (url && /google\.com\/search/i.test(url) && inPageUrl) {
      // Weak Google fallback loses to a concrete in-page auth deep-link.
      url = inPageUrl;
      searchQuery = "";
    }

    // "Share this / email this doc to X" on a non-mail tab → use the PAGE's own
    // share feature (Docs/Sheets/Notion invite dialog), not a Gmail compose.
    if (
      contextUrl &&
      !currentIsMail &&
      ownedBrowserAct.looksLikeShareCurrentPageAsk?.(text)
    ) {
      return actOnCurrentTab(agent, text, gen, wc, "", opts);
    }

    // Compose / paste: always update Gmail fields. Tone revisions only when
    // already on mail or we have a prior mail draft — never steal Docs edits.
    if (mailCompose || pasteCompose) {
      return runMailCompose(agent, text, gen, wc);
    }
    if (mailRevision && (currentIsMail || agent.lastMailDraft)) {
      return runMailCompose(agent, text, gen, wc);
    }

    // Already on YouTube/etc. + "find me a mr beast video" → search THIS tab, not Google.
    if (
      currentUrl &&
      ownedBrowserAct.looksLikeSameTabSearch(text) &&
      !retargetToSite
    ) {
      const q =
        searchQuery ||
        (videoIntent ? ownedBrowserAct.extractVideoSearchQuery(text) : "") ||
        ownedBrowserAct.extractSearchQuery(text) ||
        ownedBrowserAct.cleanBrowseQuery(text);
      const onTab = q
        ? ownedBrowserAct.searchDeepLinkForUrl(currentUrl, q, {
            sortByDate: wantLatestVideo,
          })
        : "";
      if (onTab) {
        url = onTab;
        searchQuery = q;
      }
    }

    // Resolved to Google only as a fallback, but a live searchable tab is open —
    // and the user didn't ask for Google → keep the search on the open site.
    // Video asks prefer YouTube even when another tab is open.
    if (
      currentUrl &&
      url &&
      /google\.com\/search/i.test(url) &&
      !/\bgoogle\b/i.test(text) &&
      (ownedBrowserAct.looksLikeSameTabSearch(text) || videoIntent)
    ) {
      const q =
        searchQuery ||
        (() => {
          try {
            return new URL(url).searchParams.get("q") || "";
          } catch {
            return "";
          }
        })();
      if (videoIntent && q) {
        url = ownedBrowserAct.youtubeSearchUrl(q, { sortByDate: wantLatestVideo });
        searchQuery = q;
      } else {
        const onTab = q
          ? ownedBrowserAct.searchDeepLinkForUrl(currentUrl, q, {
              sortByDate: wantLatestVideo,
            })
          : "";
        if (onTab) {
          url = onTab;
          searchQuery = q;
        }
      }
    }

    // Retarget: "pull it up on youtube" with a remembered query.
    if (retargetToSite && namedSiteUrl && searchQuery) {
      const onSite = ownedBrowserAct.searchDeepLinkForUrl(namedSiteUrl, searchQuery, {
        sortByDate: wantLatestVideo,
      });
      if (onSite) url = onSite;
    }

    // No named site in the prompt — stay on the live tab (read or act).
    if (contextUrl && !url) {
      if (inPageAction || inPageUrl) {
        return actOnCurrentTab(agent, text, gen, wc, inPageUrl, opts);
      }
      return summarizeCurrentTab(agent, text, gen, wc);
    }

    // Sign-in / in-page actions beat a weakly extracted Google search URL.
    if (
      contextUrl &&
      inPageAction &&
      inPageUrl &&
      (signInNav || !url || /google\.com\/search/i.test(url) || currentIsMail)
    ) {
      return actOnCurrentTab(agent, text, gen, wc, inPageUrl, opts);
    }
    if (contextUrl && inPageAction && (inPageUrl || !url || currentIsMail)) {
      return actOnCurrentTab(agent, text, gen, wc, inPageUrl, opts);
    }
    // SCREEN FIRST: chat context lives on the open tab. "open the LYKN ad"
    // while Drive is open means the item with that NAME on this screen — if
    // the name is visible on the current page (and isn't a site/app name),
    // act here instead of Googling the phrase and wandering off to YouTube.
    if (
      contextUrl &&
      !inPageUrl &&
      /\b(?:open|click|pull\s+up|play|select|show)\b/i.test(text) &&
      (!url ||
        /google\.com\/search|bing\.com\/search|youtube\.com\/results/i.test(url))
    ) {
      const targetName = ownedBrowserAct.extractOpenTargetName?.(text) || "";
      if (
        targetName &&
        !ownedBrowserAct.isKnownSiteName?.(targetName) &&
        (await ownedBrowserAct.findNameOnPage?.(wc, targetName))
      ) {
        return actOnCurrentTab(agent, text, gen, wc, "", opts);
      }
    }
    // Cold / lost tab: still open the real Gmail login when asked.
    if (signInNav && url && /accounts\.google\.com/i.test(url)) {
      // fall through to navigate(url) below
    } else if (signInNav && !url) {
      url = ownedBrowserAct.gmailSignInUrl();
    }

    // Inbox / "here" review even if a site name also appears.
    if (currentUrl && currentTabTask && !inPageAction) {
      return summarizeCurrentTab(agent, text, gen, wc);
    }

    if (!url) {
      // Prefer searching the open tab before dumping the user on Google.
      if (currentUrl && searchQuery) {
        url = ownedBrowserAct.searchDeepLinkForUrl(currentUrl, searchQuery) || "";
      }
      if (!url) {
        url =
          ownedBrowserAct.assumeBrowseSearchUrl(text) ||
          `https://www.google.com/search?q=${encodeURIComponent(String(text || "").trim().slice(0, 160))}`;
      }
    }

    if (searchQuery) agent.lastBrowseQuery = searchQuery;

    const openDestViaSearch =
      openDestAsk && !!url && /google\.com\/search/i.test(url);
    const creatingWorkspace = /docs\.google\.com\/(?:spreadsheets|document|presentation|forms)\/create/i.test(
      url || "",
    );
    const openingLabel = creatingWorkspace
      ? /spreadsheets/i.test(url)
        ? "Opening a blank sheet…"
        : /document/i.test(url)
          ? "Opening a blank doc…"
          : /presentation/i.test(url)
            ? "Opening a blank deck…"
            : "Opening a blank file…"
      : openDestAsk
        ? `Opening ${openDestName || "that"}…`
        : searchQuery
          ? `Searching for ${searchQuery}…`
          : /mail\.google|accounts\.google/i.test(url)
            ? "Opening Gmail…"
            : "Opening page…";
    emitProgress(agent.id, {
      status: "running",
      step: openingLabel,
      // Hide Google SERP URL while we resolve "open X" in the background.
      url: openDestViaSearch ? "" : url,
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", {
      status: openingLabel,
    });
    // Load THIS agent's tab without stealing OS focus — finish notifies instead.
    showBrowserWindow?.(agent.id, { focus: false, label: agent.title || "Agent" });
    const nav = await ownedBrowserAct.navigate(wc, url);
    if (!nav.ok) throw new Error(nav.error || "Navigation failed");
    agent.url = nav.url || url;
    if (agent.url && !ownedBrowserAct.isPlaceholderAgentUrl(agent.url)) {
      agent.lastBrowseUrl = agent.url;
    }
    if (ownedBrowserAct.isPlaceholderAgentUrl(agent.url)) {
      throw new Error("Browser stayed on a blank page — navigation did not complete.");
    }
    // Keep sibling tabs loaded; do not activate the stage window.
    syncAgentBrowserTabs({ focusId: agent.id });

    // Flip status as soon as the tab has a real URL — don't keep "Opening…" through waits.
    emitProgress(agent.id, {
      status: "running",
      step: /mail\.google/i.test(agent.url) ? "Gmail loaded…" : "Page loaded…",
      url: agent.url,
    });
    sendToAgentChannels(agent.id, "lykn:agent-status", {
      status: /mail\.google/i.test(agent.url) ? "Gmail loaded…" : "Page loaded…",
    });

    const wantsMailInbox =
      ownedBrowserAct.looksLikeGmailOpenOrReview(text) ||
      ownedBrowserAct.looksLikeMailInboxReview(text) ||
      ownedBrowserAct.looksLikeOpenMailItem?.(text) ||
      /\b(gmail|inbox)\b/i.test(text) ||
      /mail\.google\.com|accounts\.google\.com/i.test(url);

    // Fast path: page already landed for a simple open / blank workspace —
    // skip settle + auth scrape so the next multi-step task can start immediately.
    // NEVER early-exit on a Google/Bing SERP — "open adobe" must click the result.
    const landedNow = wc.getURL?.() || agent.url || url;
    const landedOnSerp =
      /google\.com\/search/i.test(landedNow) ||
      /bing\.com\/search/i.test(landedNow) ||
      /duckduckgo\.com\/\?/i.test(landedNow) ||
      /youtube\.com\/results/i.test(landedNow);
    const simpleLandedOpen =
      !stillNeedsWork &&
      !wantsMailInbox &&
      !landedOnSerp &&
      !openDestViaSearch &&
      !!landedNow &&
      !ownedBrowserAct.isPlaceholderAgentUrl(landedNow) &&
      !(ownedBrowserAct.urlMaybeNeedsAuthCheck?.(landedNow)) &&
      (creatingWorkspace ||
        (openDestAsk && !openDestViaSearch) ||
        isSimpleOpenBrowseGoal(text, namedSiteUrl || url) ||
        (ownedBrowserAct.looksLikeBareOpenBrowseGoal?.(text) && !openDestAsk));
    if (simpleLandedOpen) {
      agent.url = landedNow;
      syncAgentBrowserTabs({ focusId: agent.id });
      const label =
        openDestName ||
        wc.getTitle?.() ||
        (creatingWorkspace
          ? /spreadsheets/i.test(landedNow)
            ? "blank sheet"
            : /document/i.test(landedNow)
              ? "blank doc"
              : /presentation/i.test(landedNow)
                ? "blank deck"
                : "blank file"
          : "page");
      const msg =
        `Opened **${label}** in this agent's browser.\n\n` +
        `${landedNow}\n\n` +
        `What next?`;
      return paintBrowseDone(agent, msg);
    }

    // Re-read after redirects settle (inbox → marketing about page is common).
    // Mail: poll for inbox rows instead of a fixed multi-second sleep.
    let settledPage = { url: agent.url, text: "", title: "" };
    try {
      if (wantsMailInbox || /mail\.google\.com/i.test(agent.url)) {
        emitProgress(agent.id, {
          status: "running",
          step: "Waiting for inbox…",
          url: agent.url,
        });
        sendToAgentChannels(agent.id, "lykn:agent-status", {
          status: "Waiting for inbox…",
        });
        const ready = await ownedBrowserAct.waitForMailReady?.(wc, {
          timeoutMs: 3200,
          pollMs: 280,
        });
        settledPage = ready || (await ownedBrowserAct.getPageContext(wc));
        if (settledPage?.url) agent.url = settledPage.url;
      } else {
        await ownedBrowserAct.waitForUrlStable?.(wc, {
          stableMs: stillNeedsWork ? 800 : 600,
          timeoutMs: stillNeedsWork ? 4000 : 2500,
        }).catch(() => null);
        await ownedBrowserAct.waitForDomSettle(wc, stillNeedsWork ? 700 : 500);
        const settled = wc.getURL?.() || agent.url;
        if (settled && !ownedBrowserAct.isPlaceholderAgentUrl(settled)) {
          agent.url = settled;
        }
        settledPage = await ownedBrowserAct.getPageContext(wc);
        if (settledPage?.url) agent.url = settledPage.url;
      }
    } catch {
      /* ignore */
    }

    // Public / signed-out Gmail (by URL or page copy) → force login→inbox.
    if (
      wantsMailInbox &&
      ownedBrowserAct.looksLikeGmailNeedsSignIn({
        url: agent.url,
        text: settledPage.text,
        title: settledPage.title,
      })
    ) {
      const login = ownedBrowserAct.gmailSignInUrl();
      emitProgress(agent.id, {
        status: "running",
        step: "Opening Gmail sign-in…",
        url: login,
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", {
        status: "Opening Gmail sign-in…",
      });
      try {
        const loginNav = await ownedBrowserAct.navigate(wc, login);
        if (loginNav.ok) {
          agent.url = loginNav.url || login;
          syncAgentBrowserTabs({ focusId: agent.id });
          await ownedBrowserAct.waitForDomSettle(wc, 1000);
          settledPage = await ownedBrowserAct.getPageContext(wc).catch(() => settledPage);
          if (settledPage?.url) agent.url = settledPage.url;
        }
      } catch {
        /* keep current */
      }
    }

    // Auth walls (incl. Gmail marketing page) — pause for the user, then resume.
    {
      const pause = await pauseForUserSignIn(agent, gen, wc, {
        context: searchQuery
          ? `searching for “${searchQuery}”`
          : wantsMailInbox
            ? "opening Gmail"
            : "opening this page",
      });
      if (pause.blocked && !pause.cleared) {
        return pause.message || "";
      }
    }

    // After auth wait, re-check — never summarize the public Gmail landing page.
    try {
      settledPage = await ownedBrowserAct.getPageContext(wc);
      if (settledPage?.url) agent.url = settledPage.url;
    } catch {
      /* ignore */
    }
    if (
      wantsMailInbox &&
      ownedBrowserAct.looksLikeGmailNeedsSignIn({
        url: agent.url,
        text: settledPage.text,
        title: settledPage.title,
      })
    ) {
      const msg =
        "Gmail still needs you signed in in this agent browser.\n\n" +
        "I opened the Google sign-in page for mail — sign in there, then ask me again to check your emails.";
      agent.partialText = msg;
      agent.step = "Needs sign-in";
      sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg });
      return msg;
    }

    // "go to gmail and open the first email" — click row once inbox rows are ready.
    {
      const urlNow = agent.url || wc.getURL?.() || "";
      const hasMailRows = Array.isArray(settledPage.rows) && settledPage.rows.length > 0;
      const mailAppReady =
        ownedBrowserAct.looksLikeSignedInMailUrl(urlNow) ||
        (/mail\.google\.com/i.test(urlNow) && hasMailRows);
      if (
        ownedBrowserAct.looksLikeOpenMailItem?.(text) &&
        mailAppReady &&
        !ownedBrowserAct.looksLikeGmailPublicContent(settledPage.text, settledPage.title)
      ) {
        return openMailItemOnTab(agent, text, gen, wc, opts);
      }
    }

    // Bare "open/pull up gmail" — don't burn an adaptive loop; inbox is enough.
    if (
      !stillNeedsWork &&
      (/^open\s+gmail\b/i.test(String(text || "").trim()) ||
        ownedBrowserAct.looksLikeBareOpenBrowseGoal?.(text)) &&
      !ownedBrowserAct.looksLikeOpenMailItem?.(text) &&
      !ownedBrowserAct.looksLikeMailInboxReview(text) &&
      !ownedBrowserAct.looksLikeMailReplyTask?.(text) &&
      ownedBrowserAct.looksLikeSignedInMailUrl(agent.url || wc.getURL?.() || "")
    ) {
      return paintBrowseDone(
        agent,
        `Opened **Gmail** inbox in this agent's browser.\n\nWhat next?`,
      );
    }

    // Bare "open/pull up X" on any other page — once we're past the auth
    // checks, the landed page IS the deliverable. Report done immediately
    // instead of running adaptive/LLM browse rounds.
    if (
      !stillNeedsWork &&
      !wantsMailInbox &&
      !searchQuery &&
      !openDestViaSearch &&
      ownedBrowserAct.looksLikeBareOpenBrowseGoal?.(text) &&
      agent.url &&
      !ownedBrowserAct.isPlaceholderAgentUrl(agent.url)
    ) {
      let label = wc.getTitle?.() || "";
      if (!label) {
        try {
          label = new URL(agent.url).hostname.replace(/^www\./i, "");
        } catch {
          label = "page";
        }
      }
      return paintBrowseDone(
        agent,
        `Opened **${label}** in this agent's browser.\n\n${agent.url}\n\nWhat next?`,
      );
    }

    // Drafts / inbox review asks: scrape the list once we're past auth.
    if (
      (ownedBrowserAct.looksLikeMailDraftsReview?.(text) ||
        ownedBrowserAct.looksLikeMailInboxReview(text)) &&
      ownedBrowserAct.looksLikeSignedInMailUrl(agent.url || wc.getURL?.() || "") &&
      !ownedBrowserAct.looksLikeGmailPublicContent(settledPage.text, settledPage.title)
    ) {
      return summarizeCurrentTab(agent, text, gen, wc);
    }

    const liveUrl = agent.url || wc.getURL?.() || url;
    const isSpotifySearch = /open\.spotify\.com\/search\//i.test(liveUrl);
    const isSearchDeepLink =
      (!!searchQuery || openDestViaSearch || playMediaAsk || isSpotifySearch) &&
      (/[?&]search_query=/i.test(liveUrl) ||
        /[?&]q=/i.test(liveUrl) ||
        /\/results\?/i.test(liveUrl) ||
        /google\.com\/search/i.test(liveUrl) ||
        isSpotifySearch);
    const isStockDeepLink =
      /finance\.yahoo\.com\/quote\//i.test(liveUrl) ||
      /tradingview\.com\/symbols\//i.test(liveUrl) ||
      /finviz\.com\/quote/i.test(liveUrl) ||
      /google\.com\/finance\//i.test(liveUrl);
    const isYoutubeResults =
      /youtube\.com\/results/i.test(liveUrl) ||
      (/youtube\.com/i.test(liveUrl) && /[?&]search_query=/i.test(liveUrl));
    const pickOne = ownedBrowserAct.looksLikePickOneBrowseIntent(text);
    // Any video ask on YouTube results should open a watch page — including
    // cleaned plan steps like "search for mr beast video" (not only "find/play").
    // Spotify "play thunderstruck" / "play it" → open the top track from search.
    // "open X" via Google search → silently open the top organic result.
    // Corrections ("that's not right") stay on the SERP for the user to pick.
    const shouldAutoOpenResult =
      !skipAutoOpenResult &&
      ((videoIntent && isYoutubeResults) ||
        (playMediaAsk && isSpotifySearch) ||
        (pickOne && !!searchQuery && isSearchDeepLink) ||
        (openDestViaSearch && isSearchDeepLink));

    // Direct search / stock deep-link — confirm from the owned tab (no fake sources).
    // When the ask still needs work after auto-open, skip "Opened/Searched" returns
    // and fall through to adaptive with the full ask.
    let landedForAdaptive = false;
    if (isSearchDeepLink || isStockDeepLink) {
      if (shouldAutoOpenResult) {
        const openLabel = openDestAsk
          ? `Opening ${openDestName || "that"}…`
          : playMediaAsk && isSpotifySearch
            ? "Playing the top match…"
            : videoIntent
              ? wantLatestVideo
                ? "Opening the latest video…"
                : "Opening a video…"
              : "Opening a matching result…";
        emitProgress(agent.id, {
          status: "running",
          step: openLabel,
          url: openDestAsk ? "" : liveUrl,
        });
        sendToAgentChannels(agent.id, "lykn:agent-status", { status: openLabel });
        const clickHint =
          searchQuery ||
          openDestName ||
          ownedBrowserAct.composeBrowseSearchQuery?.(text) ||
          "";
        // Poll for result links instead of a fixed multi-second settle.
        let peekReady = null;
        if (ownedBrowserAct.waitForSearchResultsReady) {
          peekReady = await ownedBrowserAct
            .waitForSearchResultsReady(wc, {
              hint: clickHint,
              youtube: !!videoIntent && isYoutubeResults,
              spotify: !!isSpotifySearch,
              timeoutMs: openDestAsk || videoIntent || playMediaAsk ? 2200 : 1200,
              pollMs: 160,
            })
            .catch(() => null);
        } else {
          await ownedBrowserAct.waitForDomSettle?.(wc, 400).catch(() => {});
        }
        let clicked = { ok: false };
        // Prefer a hard navigation — SPA clicks (YouTube / Google / Spotify) often no-op.
        if (videoIntent || openDestAsk || (playMediaAsk && isSpotifySearch)) {
          const unwrap = ownedBrowserAct.unwrapGoogleRedirect || ((h) => h);
          const peek =
            (peekReady?.ok && peekReady.href ? peekReady : null) ||
            (isSpotifySearch
              ? await ownedBrowserAct
                  .peekSpotifyResultHref?.(wc, {
                    hint: clickHint,
                    index: 0,
                  })
                  .catch(() => null)
              : videoIntent
                ? await ownedBrowserAct
                    .peekYoutubeResultHref?.(wc, {
                      hint: clickHint,
                      index: 0,
                    })
                    .catch(() => null)
                : await ownedBrowserAct
                    .peekSearchResultHref?.(wc, {
                      hint: clickHint,
                      index: 0,
                    })
                    .catch(() => null));
          if (peek?.ok && peek.href) {
            try {
              const dest = unwrap(peek.href);
              const navWatch = await ownedBrowserAct.navigate(wc, dest);
              if (navWatch.ok) {
                clicked = {
                  ok: true,
                  href: navWatch.url || dest,
                  title: peek.title || openDestName || clickHint,
                };
              }
            } catch {
              /* fall through to click */
            }
          }
        }
        if (!clicked?.ok) {
          clicked = await ownedBrowserAct.clickSearchResultOnPage(wc, {
            hint: clickHint,
            index: 0,
          });
          // Retry once if the results DOM wasn't ready.
          if (!clicked?.ok && (videoIntent || openDestAsk || playMediaAsk)) {
            await ownedBrowserAct.waitForDomSettle?.(wc, 500).catch(() => {});
            clicked = await ownedBrowserAct.clickSearchResultOnPage(wc, {
              hint: clickHint,
              index: 0,
            });
          }
        }
        if (clicked?.ok) {
          await ownedBrowserAct.waitForLoad?.(wc, 10000).catch(() => {});
          await ownedBrowserAct.waitForUrlStable?.(wc, {
            stableMs: stillNeedsWork ? 800 : 500,
            timeoutMs: 3500,
          }).catch(() => null);
          await ownedBrowserAct.waitForDomSettle?.(wc, stillNeedsWork ? 700 : 280).catch(() => {});
          // Don't treat YouTube's chrome "Sign in" as a wall after opening a watch page.
          const watchUrl = clicked.href || wc.getURL?.() || agent.url || url;
          if (
            !/youtube\.com\/watch|youtu\.be\//i.test(watchUrl) &&
            ownedBrowserAct.urlMaybeNeedsAuthCheck?.(watchUrl)
          ) {
            const pause = await pauseForUserSignIn(agent, gen, wc, {
              context: openDestAsk
                ? `opening ${openDestName || "that"}`
                : "opening a result",
            });
            if (pause.blocked && !pause.cleared) {
              return pause.message || "";
            }
          }
          const page = await ownedBrowserAct.getPageContext(wc);
          const openTitle =
            clicked.title ||
            page.title ||
            openDestName ||
            (videoIntent ? "video" : "result");
          const openUrl = wc.getURL?.() || clicked.href || agent.url || url;
          agent.url = openUrl;
          agent.lastBrowseQuery = openDestAsk
            ? ""
            : searchQuery || agent.lastBrowseQuery || "";
          agent.lastDeliverableKind = "browse";
          syncAgentBrowserTabs({ focusId: agent.id });
          if (openDestAsk || openDestName) {
            agent.lastOpenDestination = openDestName || openTitle || clickHint || "";
            agent.lastOpenDestQuery = searchQuery || openDestName || "";
            agent.lastOpenDestManual = false;
          }
          // Auto-open is only the landing — continue adaptive when the ask has more work.
          if (stillNeedsWork) {
            landedForAdaptive = true;
          } else {
            const msg = openDestAsk
              ? `Opened **${openDestName || openTitle}** in this agent's browser.\n\n` +
                `${openUrl}\n\n` +
                `What next?` +
                `\n\n(If that's the wrong site, say "that's not right" and I'll search again without auto-opening.)`
              : `Opened **${openTitle}**` +
                (wantLatestVideo ? " (latest / top result)" : "") +
                ` in this agent's browser.\n\n` +
                `${openUrl}\n\n` +
                (videoIntent
                  ? `Playing here — want a different video, or something else on the page?`
                  : `Want a different result, or something else on the page?`);
            agent.partialText = msg;
            sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg });
            // Stop here — do not adaptive-browse or open a research report over the video.
            return msg;
          }
        }
      }

      if (!landedForAdaptive) {
        // Video ask but click missed — stay on results; don't "research" the topic in-tab.
        if (videoIntent && isYoutubeResults) {
          const topic =
            searchQuery ||
            ownedBrowserAct.extractVideoSearchQuery?.(text) ||
            ownedBrowserAct.cleanBrowseQuery?.(text) ||
            "that";
          const msg =
            `Searched YouTube for **${topic}** in this agent's browser.\n\n` +
            `I couldn't auto-open a result — tell me which video to play (or say "open the first one").`;
          agent.partialText = msg;
          agent.url = wc.getURL?.() || url;
          sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg });
          return msg;
        }

        // "open X" search resolved but click missed — stay quiet, ask once.
        if (openDestAsk && isSearchDeepLink) {
          const topic = openDestName || searchQuery || "that";
          const msg =
            `I searched for **${topic}** but couldn't auto-open a result.\n\n` +
            `Tell me which link to open, or try a more specific name.`;
          agent.partialText = msg;
          agent.url = wc.getURL?.() || url;
          sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg });
          return msg;
        }

        // Correction / manual pick — leave results on screen for the user.
        if (skipAutoOpenResult && isSearchDeepLink) {
          const topic = wrongOpenTopic || searchQuery || openDestName || "that";
          const msg =
            `I searched again for **${topic}** — I won't auto-open this time.\n\n` +
            `Click the right result in the agent browser, or tell me which link to open.`;
          agent.partialText = msg;
          agent.url = wc.getURL?.() || url;
          agent.lastDeliverableKind = "browse";
          sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg, final: true });
          return paintBrowseDone(agent, msg);
        }

        // Stock views / plain search: stop unless the ask still needs in-page work.
        if (!stillNeedsWork || isStockDeepLink) {
          const page = await ownedBrowserAct.getPageContext(wc);
          const title = page.title || wc.getTitle?.() || "page";
          const snippet = String(page.text || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 500);
          const company =
            (String(text || "").match(
              /\b(tesla|apple|microsoft|amazon|nvidia|google|alphabet|meta|facebook|netflix|amd|intel|disney|nike|starbucks|costco|berkshire)\b/i,
            ) || [])[1] || "";
          const topic =
            searchQuery ||
            ownedBrowserAct.composeBrowseSearchQuery?.(text) ||
            (videoIntent && searchQuery) ||
            ownedBrowserAct.cleanBrowseQuery?.(text) ||
            "that";
          const msg = isStockDeepLink
            ? `Pulled up a live ${company ? `${company} ` : ""}stock view in this agent's browser` +
              (title ? ` (**${title}**)` : "") +
              `.` +
              (snippet ? `\n\n${snippet}` : "") +
              `\n\nWant a different timeframe, another company, or a click on the page?`
            : `Searched for **${topic}** in this agent's browser` +
              (title ? ` (**${title}**)` : "") +
              `.\n\nTell me which result to open or what to do next.`;
          agent.partialText = msg;
          sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg });
          return msg;
        }
        // stillNeedsWork on a SERP → continue to adaptive (click result + finish ask).
      }
    }

    // "open google sheets" / "open figma" — landed on the product; confirm, no click loop.
    if (
      !stillNeedsWork &&
      openDestAsk &&
      !/google\.com\/search/i.test(liveUrl) &&
      !/youtube\.com\/results/i.test(liveUrl)
    ) {
      const page = await ownedBrowserAct.getPageContext(wc);
      const title = page.title || wc.getTitle?.() || openDestName || "page";
      const opened = agent.url || liveUrl;
      const label = openDestName || title;
      const msg =
        `Opened **${label}** in this agent's browser.\n\n` +
        `${opened}\n\n` +
        `What next?`;
      agent.partialText = msg;
      sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg });
      return msg;
    }

    // "Open lykn.io" — navigate + confirm, don't burn a long click loop.
    if (!stillNeedsWork && isSimpleOpenBrowseGoal(text, namedSiteUrl || url)) {
      const page = await ownedBrowserAct.getPageContext(wc);
      const title = page.title || wc.getTitle?.() || "page";
      const opened = agent.url || url;
      const msg =
        `Opened **${opened}** in the LYKN Agent Browser.\n\n` +
        `Page title: ${title}\n\n` +
        `I can click around, fill forms, or keep watching this page — just say what to do next.`;
      agent.partialText = msg;
      sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg });
      return msg;
    }

    // When the ask still has work, adapt against the FULL ask — not a plan fragment.
    const adaptiveSource = stillNeedsWork ? workAsk : browseText;
    const adaptiveGoal =
      ownedBrowserAct.composeAdaptiveBrowseGoal?.(adaptiveSource, {
        ...browseCtx,
        currentUrl: currentUrl || browseCtx.currentUrl || agent.url || "",
      }) || adaptiveSource;
    return runAdaptiveBrowse(agent, stillNeedsWork ? workAsk : text, gen, wc, {
      ...opts,
      adaptiveGoal,
      conversationHistory: historyForPlanner(agent),
    });
  }

  async function runMonitor(agent, text, gen) {
    const monitoringCount = [...agents.values()].filter((x) => x.monitorTimer).length;
    if (monitoringCount >= MAX_MONITOR_AGENTS && !agent.monitorTimer) {
      throw new Error(`At most ${MAX_MONITOR_AGENTS} monitors can run at once.`);
    }
    ensureBrowserWindow?.(agent.id, { show: false });
    const wc = getBrowserWebContents?.(agent.id);
    if (!wc) throw new Error("Could not open agent browser session.");

    const url =
      ownedBrowserAct.resolveBrowseTargetUrl(text) || ownedBrowserAct.extractUrlFromText(text);
    if (url) {
      showBrowserWindow?.(agent.id, { focus: false, label: agent.title || "Agent" });
      const nav = await ownedBrowserAct.navigate(wc, url);
      if (!nav.ok) throw new Error(nav.error || "Navigation failed");
      agent.url = nav.url || url;
      syncAgentBrowserTabs({ focusId: agent.id });
    }
    agent.skill = "monitor";
    agent.status = "running";
    agent.step = "Monitoring…";
    emitProgress(agent.id, { status: "running", step: "Monitoring…", skill: "monitor" });

    const rule = String(text || "").trim();
    stopMonitor(agent);

    const tick = async () => {
      if (gen !== agent.generation) return;
      try {
        const page = await ownedBrowserAct.getPageContext(wc);
        const snippet = String(page.text || "").slice(0, 4000);
        agent.url = page.url || agent.url;
        if (snippet && snippet !== agent.lastMonitorText) {
          const changed = !!agent.lastMonitorText;
          agent.lastMonitorText = snippet;
          if (changed) {
            emitProgress(agent.id, {
              status: "running",
              step: "Page changed — checking…",
              url: agent.url,
            });
            const checkPrompt =
              `You are monitoring a page for this rule:\n${rule}\n\n` +
              `Current page (${agent.url}) text:\n${snippet}\n\n` +
              `If the rule is triggered, reply with ALERT: and a short reason. ` +
              `Otherwise reply OK: and one short status line.`;
            const answer = await streamChat(agent, checkPrompt, [], "general", gen);
            if (gen !== agent.generation) return;
            if (/^\s*ALERT:/i.test(answer || "")) {
              agent.history.push({
                role: "assistant",
                content: answer,
                at: new Date().toISOString(),
              });
              sendToAgentChannels(agent.id, "lykn:agent-delta", { text: answer });
              sendToAgentChannels(agent.id, "lykn:agent-done", { text: answer, alert: true });
              emitProgress(agent.id, { status: "running", step: "Alert", url: agent.url });
              try {
                notifyAgentFinished?.({
                  agentId: agent.id,
                  title: agent.title,
                  skill: "monitor",
                  text: answer,
                  ok: true,
                  alert: true,
                  prompt: String(rule || agent.title || "Monitor").slice(0, 90),
                });
              } catch {
                /* ignore */
              }
            } else {
              emitProgress(agent.id, {
                status: "running",
                step: String(answer || "OK").replace(/^\s*OK:\s*/i, "").slice(0, 60),
                url: agent.url,
              });
            }
          }
        } else {
          emitProgress(agent.id, { status: "running", step: "Watching…", url: agent.url });
        }
      } catch (e) {
        emitProgress(agent.id, {
          status: "running",
          step: e?.message || "Monitor error",
          url: agent.url,
        });
      }
    };

    await tick();
    agent.monitorTimer = setInterval(() => void tick(), MONITOR_POLL_MS);
    // Keep agent "busy" false so user can send more, but status running.
    agent.busy = false;
    const kickoff = `Monitoring started${agent.url ? ` on ${agent.url}` : ""}.\nRule: ${rule}`;
    agent.history.push({
      role: "assistant",
      content: kickoff,
      at: new Date().toISOString(),
    });
    sendToAgentChannels(agent.id, "lykn:agent-delta", { text: kickoff });
    sendToAgentChannels(agent.id, "lykn:agent-done", { text: kickoff, monitoring: true });
    return kickoff;
  }

  function resolveAgent(agentId) {
    if (agentId && agents.has(agentId)) return agents.get(agentId);
    if (activeAgentId && agents.has(activeAgentId)) return agents.get(activeAgentId);
    if (agents.size) {
      const first = agents.values().next().value;
      activeAgentId = first.id;
      return first;
    }
    return null;
  }

  async function resolveChoice(agentId, { choiceId, buttonId } = {}) {
    const agent = agents.get(agentId);
    if (!agent) return { ok: false, error: "not_found" };
    const pending = agent.pendingChoice;
    if (!pending || pending.type !== "complex-tool") {
      return { ok: false, error: "no_pending_choice" };
    }
    if (choiceId && pending.id !== choiceId) {
      return { ok: false, error: "stale_choice" };
    }
    const btn = String(buttonId || "").trim();
    agent.pendingChoice = null;

    if (btn === "stop") {
      const soft = pending.softwareName || "that software";
      const msg = `Okay — stopped. I won't drive **${soft}** from here.`;
      agent.busy = false;
      agent.status = "idle";
      agent.step = "Stopped";
      agent.skill = "complex-offer";
      agent.partialText = msg;
      agent.updatedAt = new Date().toISOString();
      agent.history.push({
        role: "assistant",
        content: msg,
        at: new Date().toISOString(),
      });
      sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg, final: true });
      sendToAgentChannels(agent.id, "lykn:agent-done", {
        text: msg,
        final: true,
        choiceResolved: "stop",
      });
      emitProgress(agent.id, {
        status: "idle",
        step: "Stopped",
        skill: "complex-offer",
      });
      schedulePersist();
      return {
        ok: true,
        agentId: agent.id,
        skill: "complex-offer",
        text: msg,
        stopped: true,
      };
    }

    if (btn === "use-artifact") {
      const ask =
        String(pending.artifactAsk || "").trim() ||
        String(pending.originalAsk || "").trim() ||
        "Create a custom artifact";
      return send(agent.id, {
        text: ask,
        forceBuild: true,
        skipComplexGate: true,
      });
    }

    return { ok: false, error: "unknown_button" };
  }

  /**
   * Vague / product / account asks that should be interpreted before navigating.
   * Heuristics alone often Google "reddit ads thing" instead of ads.reddit.com.
   */
  function needsAgentIntentBreakdown(text) {
    const t = String(text || "").trim();
    if (!t || t.length < 8) return false;
    if (ownedBrowserAct.isPlaceholderAgentUrl?.(t)) return false;
    // Already a concrete URL — no need to reinterpret.
    if (/^https?:\/\//i.test(t) && t.length < 180) return false;
    const lower = t.toLowerCase();
    if (
      /\b(thing|stuff|whatsit|whatchamacallit|dealio|whatever|you know|my\s+\w[\w\s]{0,24}\s+(?:ads?|advertising|dashboard|account|admin|console|portal|manager))\b/i.test(
        lower,
      )
    ) {
      return true;
    }
    const url = ownedBrowserAct.resolveBrowseTargetUrl?.(t) || "";
    const openUrl = ownedBrowserAct.resolveOpenDestinationUrl?.(t) || "";
    if (/google\.com\/search/i.test(url) || /google\.com\/search/i.test(openUrl)) {
      return true;
    }
    // Open/check/go + follow-on work — deduce destination + remaining steps first.
    if (
      /\b(open|pull\s+up|go\s+to|check|review|look\s+at|log\s*in|sign\s*in)\b/i.test(lower) &&
      (ownedBrowserAct.askStillNeedsAdaptiveWork?.(t) ||
        ownedBrowserAct.looksLikeOpenDestinationAsk?.(t))
    ) {
      return true;
    }
    return false;
  }

  async function interpretAgentIntent(prompt, opts = {}) {
    const token = await getAuthToken().catch(() => null);
    if (!token) return null;
    const heuristicUrl =
      String(opts.heuristicUrl || "").trim() ||
      ownedBrowserAct.resolveBrowseTargetUrl?.(prompt) ||
      "";
    let browsingContext = "";
    try {
      browsingContext = String((await getBrowsingContext?.()) || "").slice(0, 1500);
    } catch {
      browsingContext = "";
    }
    try {
      const res = await fetch(`${apiBase}/api/desktop/agent-intent`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: String(prompt || "").slice(0, 2000),
          heuristicUrl: heuristicUrl.slice(0, 500),
          browsingContext,
          conversationHistory: Array.isArray(opts.conversationHistory)
            ? opts.conversationHistory.slice(-6)
            : [],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const destinationUrl = String(data?.destinationUrl || "").trim();
      const browseGoal = String(data?.browseGoal || data?.understood || "").trim();
      if (!destinationUrl && !browseGoal) return null;
      return {
        understood: String(data?.understood || browseGoal || "").trim().slice(0, 400),
        destinationUrl: /^https?:\/\//i.test(destinationUrl) ? destinationUrl.slice(0, 500) : "",
        browseGoal: browseGoal.slice(0, 800),
        steps: Array.isArray(data?.steps)
          ? data.steps.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 8)
          : [],
        skill: String(data?.skill || "browse"),
        confidence: Math.max(0, Math.min(1, Number(data?.confidence) || 0)),
      };
    } catch {
      return null;
    }
  }

  /** Apply interpreted intent into a concrete working prompt the rest of Agent Mode can execute. */
  function applyAgentIntent(original, intent) {
    const q = String(original || "").trim();
    if (!intent) return { workingQ: q, steps: null, preferredUrl: "" };
    const url = String(intent.destinationUrl || "").trim();
    const goal = String(intent.browseGoal || intent.understood || "").trim();
    let workingQ = q;
    if (url && goal) {
      // Lead with the URL so resolveBrowseTargetUrl / extractUrlFromText can't miss it.
      workingQ = `Go to ${url} and ${goal.replace(/^\s*(go\s+to|open|visit|pull\s+up)\s+\S+/i, "").trim() || goal}`;
      workingQ = workingQ.replace(/\s+/g, " ").trim();
    } else if (goal) {
      workingQ = goal;
    } else if (url) {
      workingQ = `Go to ${url} and ${q}`;
    }
    const steps =
      Array.isArray(intent.steps) && intent.steps.length >= 2 ? intent.steps.slice() : null;
    return { workingQ, steps, preferredUrl: url };
  }

  async function send(
    agentId,
    { text, attachments, forceBuild, skipComplexGate, presetSteps } = {},
  ) {
    let agent = resolveAgent(agentId);
    // Glass can hold a stale id after restart / close — recreate instead of not_found.
    if (!agent) {
      const created = createAgent({ goal: String(text || "").trim(), silent: true });
      if (!created?.ok || !created.agentId) {
        return { ok: false, error: created?.error || "not_found" };
      }
      agent = agents.get(created.agentId);
    }
    if (!agent) return { ok: false, error: "not_found" };
    if (agents.size > MAX_AGENTS) return { ok: false, error: `max_agents_${MAX_AGENTS}` };

    let q = String(text || "").trim();
    if (!q && !(attachments && attachments.length)) {
      return { ok: false, error: "empty" };
    }

    activeAgentId = agent.id;

    // Typed reply while a complex-software choice is pending.
    if (agent.pendingChoice?.type === "complex-tool") {
      const lower = q.toLowerCase();
      if (
        /\buse custom artifact\b|\bcustom artifact\b|\bartifact instead\b|\bbuild (it|that) as (an? )?artifact\b/i.test(
          lower,
        )
      ) {
        return resolveChoice(agent.id, {
          buttonId: "use-artifact",
          choiceId: agent.pendingChoice.id,
        });
      }
      if (
        /^(no\b|stop\b)|just stop|stop here|never ?mind|cancel\b/i.test(lower)
      ) {
        return resolveChoice(agent.id, {
          buttonId: "stop",
          choiceId: agent.pendingChoice.id,
        });
      }
      // Different ask — drop the offer and continue.
      agent.pendingChoice = null;
    }

    // Plan paused on a sign-in wall: "done" / "signed in" / "continue" resumes
    // the remaining steps. Any other ask drops the paused plan.
    if (!presetSteps && agent.pendingPlan?.steps?.length) {
      const resumish =
        /^(?:ok(?:ay)?[,.!\s]*)?(?:i(?:'m|m|\s+am)?\s+)?(?:done|signed\s*in|logged\s*in|in|ready|continue|go(?:\s+ahead)?|resume|keep\s+going|proceed|try\s+again|finished)[.!\s]*$/i.test(
          q,
        );
      const pending = agent.pendingPlan;
      agent.pendingPlan = null;
      if (resumish) {
        return send(agent.id, {
          text: pending.ask || pending.steps.join(", then "),
          presetSteps: pending.steps,
        });
      }
    }

    if (forceBuild || skipComplexGate) {
      agent.skipComplexGateOnce = true;
    }

    // Main orchestrator: never do the work when there are no sub-agents yet —
    // spawn one (panel chat + browser tab) and start it on this prompt.
    if (isMainAgent(agent)) {
      // Combine sibling deliverables (research → open Sheets) — do not spawn research.
      if (looksLikePasteReportIntoSheets(q)) {
        agent.history.push({
          role: "user",
          content: q,
          at: new Date().toISOString(),
        });
        agent.busy = true;
        agent.status = "running";
        agent.step = "Putting research into Sheets…";
        agent.updatedAt = new Date().toISOString();
        schedulePersist();
        emitProgress(agent.id, {
          status: "running",
          step: agent.step,
          skill: "sheets-fill",
        });
        sendToAgentChannels(agent.id, "lykn:agent-status", {
          status: "Putting research into Sheets…",
        });
        let result;
        try {
          result = await runCombineReportIntoSheets(agent, q);
        } catch (e) {
          result = {
            ok: false,
            error: e?.message || "combine_failed",
            message: e?.message || "Couldn't put the report into Sheets.",
          };
        }
        const msg = result?.message || (result?.ok ? "Done." : "Couldn't complete that.");
        agent.busy = false;
        agent.status = "idle";
        agent.step = result?.ok ? "Filled sheet from research" : "Needs a report or sheet";
        agent.updatedAt = new Date().toISOString();
        agent.history.push({
          role: "assistant",
          content: msg,
          at: new Date().toISOString(),
        });
        try {
          sendToAgentChannels(agent.id, "lykn:agent-status", {
            status: result?.ok ? "Filled sheet" : "Couldn't fill sheet",
          });
          sendToAgentChannels(agent.id, "lykn:agent-delta", { text: msg, final: true });
          sendToAgentChannels(agent.id, "lykn:agent-done", { text: msg, final: true });
        } catch {
          /* ignore */
        }
        emitProgress(agent.id, {
          status: "idle",
          step: agent.step,
          skill: "sheets-fill",
        });
        schedulePersist();
        return {
          ok: !!result?.ok,
          agentId: agent.id,
          skill: "sheets-fill",
          text: msg,
          combined: result,
        };
      }

      const intent = parseUserDelegateIntent(q);
      if (intent?.worker && intent.prompt) {
        agent.history.push({
          role: "user",
          content: q,
          at: new Date().toISOString(),
        });
        agent.updatedAt = new Date().toISOString();
        schedulePersist();
        emitProgress(agent.id, {
          status: "idle",
          step: `Started ${intent.worker.title}`,
          skill: "delegate",
        });
        const del = await delegateToWorker(intent.worker, intent.prompt, {
          fromMain: true,
          paintKickoff: true,
        });
        const kickoff =
          del?.kickoff || formatDelegateKickoff(intent.worker, intent.prompt);
        paintMainAssistant(kickoff, { force: true });
        return {
          ok: true,
          agentId: agent.id,
          skill: "delegate",
          text: kickoff,
          delegated: del,
        };
      }

      // Real work from Main always goes to a sub-agent (standby tab or new one).
      if (!isTrivialMainChat(q, attachments)) {
        const taskPrompt = q || "New task";
        const userContent = q || "(attachment)";
        agent.history.push({
          role: "user",
          content: userContent,
          at: new Date().toISOString(),
        });
        const claimed = claimWorkerForMainTask(taskPrompt, {
          seedUser: taskPrompt,
        });
        if (!claimed.ok || !claimed.worker) {
          agent.history.push({
            role: "assistant",
            content: `Couldn't start a sub-agent: ${claimed.error || "error"}`,
            at: new Date().toISOString(),
          });
          schedulePersist();
          return { ok: false, error: claimed.error || "spawn_failed", agentId: agent.id };
        }
        const worker = claimed.worker;
        const kickoff = formatDelegateKickoff(worker, taskPrompt);
        agent.history.push({
          role: "assistant",
          content: kickoff,
          at: new Date().toISOString(),
        });
        agent.updatedAt = new Date().toISOString();
        agent.step = `Started ${worker.title}`;
        schedulePersist();
        emitProgress(agent.id, {
          status: "idle",
          step: agent.step,
          skill: "delegate",
        });
        const del = await delegateToWorker(worker, taskPrompt, {
          fromMain: true,
          paintKickoff: false,
          attachments,
        });
        return {
          ok: true,
          agentId: worker.id,
          skill: "delegate",
          text: "",
          spawned: true,
          delegated: del,
        };
      }
    }

    // Stop prior run for this agent only (not other agents).
    abortAgent(agent, "restart");
    const gen = (agent.generation += 1);
    agent.abort = new AbortController();
    agent.busy = true;
    agent.error = "";
    agent.status = "running";

    const originalAsk = q;
    // Spawn-from-Main may have already seeded this user turn for Glass switch.
    const lastHist = agent.history[agent.history.length - 1];
    if (!(lastHist?.role === "user" && String(lastHist.content || "") === originalAsk)) {
      agent.history.push({
        role: "user",
        content: originalAsk,
        at: new Date().toISOString(),
      });
    }

    // Deduce destination + task BEFORE navigating — vague asks like
    // "open my reddit ads thing" must not Google the filler phrase.
    const preset =
      Array.isArray(presetSteps) && presetSteps.length ? presetSteps : null;
    let intentSteps = null;
    agent.preferredBrowseUrl = "";
    agent.lastIntent = null;
    let liveTabForIntent = "";
    try {
      const wcIntent = getBrowserWebContents?.(agent.id);
      liveTabForIntent =
        getLiveTabUrl(agent, wcIntent) || getLiveTabUrl(agent, null) || "";
    } catch {
      liveTabForIntent = getLiveTabUrl(agent, null) || "";
    }
    if (
      !liveTabForIntent &&
      agent.url &&
      !ownedBrowserAct.isPlaceholderAgentUrl(agent.url)
    ) {
      liveTabForIntent = agent.url;
    }
    // Already on a page + informational ask → answer from scrape; don't reinterpret
    // into a multi-step browse plan ("check my spend" ≠ open + click around).
    const skipIntentForPageAnswer =
      !!liveTabForIntent &&
      !!ownedBrowserAct.looksLikePageQuestionAsk?.(originalAsk) &&
      !ownedBrowserAct.looksLikeBrowseActAsk?.(originalAsk) &&
      !ownedBrowserAct.looksLikeMailInboxReview?.(originalAsk) &&
      !ownedBrowserAct.looksLikeMailDraftsReview?.(originalAsk);
    if (!preset && !skipIntentForPageAnswer && needsAgentIntentBreakdown(originalAsk)) {
      emitProgress(agent.id, {
        status: "running",
        step: "Understanding your ask…",
        skill: "browse",
      });
      sendToAgentChannels(agent.id, "lykn:agent-status", {
        status: "Understanding your ask…",
      });
      const intent = await interpretAgentIntent(originalAsk, {
        heuristicUrl: ownedBrowserAct.resolveBrowseTargetUrl?.(originalAsk) || "",
        conversationHistory: historyForPlanner(agent),
      });
      if (intent && (intent.confidence >= 0.45 || intent.destinationUrl || intent.browseGoal)) {
        const applied = applyAgentIntent(originalAsk, intent);
        q = applied.workingQ || q;
        intentSteps = applied.steps;
        agent.preferredBrowseUrl = applied.preferredUrl || intent.destinationUrl || "";
        agent.lastIntent = intent;
        if (intent.understood) {
          sendToAgentChannels(agent.id, "lykn:agent-status", {
            status: `Got it — ${intent.understood.slice(0, 80)}`,
          });
        }
      }
    }

    // Dissect → plan (filler-stripped search/actions) → execute.
    // presetSteps = resuming a plan parked at a sign-in wall (skip re-planning).
    const plan = preset ? null : intentSteps ? null : buildAgentPlan(q);
    const steps = (
      preset ||
      intentSteps ||
      (plan?.texts?.length ? plan.texts : [q])
    ).map(normalizeAgentStepText);
    const multi = steps.length >= 2;
    const planLines = multi
      ? (intentSteps
          ? intentSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")
          : plan?.planLines || steps.map((s, i) => `${i + 1}. ${s}`).join("\n"))
      : "";
    let skill = forceBuild
      ? "build"
      : resolveSkillForPrompt(agent, multi ? steps[0] : q, attachments);
    if (
      !forceBuild &&
      agent.lastIntent?.skill === "browse" &&
      skill === "general" &&
      agent.preferredBrowseUrl &&
      // Don't override scrape-and-answer when intent ran on a different turn.
      !(
        ownedBrowserAct.looksLikePageQuestionAsk?.(q) &&
        !ownedBrowserAct.looksLikeBrowseActAsk?.(q)
      )
    ) {
      skill = "browse";
    }
    agent.skill = skill;
    agent.plan = multi
      ? { lines: planLines, steps: steps.slice(), createdAt: new Date().toISOString() }
      : null;
    if (!agent.title || agent.title === "New agent" || /^Agent \d+$/.test(agent.title)) {
      agent.title = titleFromGoal(originalAsk);
    }
    agent.partialText = "";
    agent.stepDeliverables = [];
    agent.updatedAt = new Date().toISOString();
    emitProgress(agent.id, {
      status: "running",
      step: multi ? `Planning ${steps.length} steps…` : "Starting…",
      skill,
    });
    // Show the plan in Glass before any step runs.
    if (multi) {
      sendToAgentChannels(agent.id, "lykn:agent-status", {
        status: `Plan · ${steps.length} steps`,
      });
      sendToAgentChannels(agent.id, "lykn:agent-delta", {
        text: "",
        status: `**Plan**\n${planLines}\n\nStarting step 1…`,
      });
    } else {
      // Deliverable turns: acknowledge in the response area BEFORE the work
      // starts, so the user isn't staring at a bare spinner.
      const kickoff = deliverableKickoffText(skill);
      if (kickoff) {
        agent.partialText = kickoff;
        sendToAgentChannels(agent.id, "lykn:agent-delta", { text: kickoff });
      }
    }
    schedulePersist();

    try {
      const stepAnswers = [];
      let monitoring = false;
      let lastSkill = skill;
      // A browse step earlier in the plan makes later deliverable steps
      // screen-sourced (report/artifact built from what the browse landed on).
      let browsedInPlan = false;
      // "open SITE + search QUERY" plans: first browse uses the full original ask
      // so we deep-link on-site (Pinterest/YouTube/…) instead of homepage → Google.
      const openThenDeepLink =
        multi && steps.length === 2
          ? ownedBrowserAct.resolveBrowseTargetUrl(q)
          : "";
      const openThenSearch =
        !!openThenDeepLink &&
        /^open\s+\S+/i.test(steps[0] || "") &&
        (/^search\s+for\s+/i.test(steps[1] || "") || /^find\b/i.test(steps[1] || "")) &&
        !/google\.com\/search/i.test(openThenDeepLink);
      // If step 0 already deep-linked to results, skip the redundant second search.
      const openThenSearchSatisfied =
        openThenSearch &&
        (/[?&]search_query=/i.test(openThenDeepLink) ||
          /\/results\?/i.test(openThenDeepLink) ||
          /pinterest\.com\/search/i.test(openThenDeepLink) ||
          /[?&]q=/i.test(openThenDeepLink));

      for (let i = 0; i < steps.length; i += 1) {
        if (gen !== agent.generation) return { ok: false, error: "superseded" };
        if (openThenSearchSatisfied && i === 1) {
          // Step 0 already searched (and likely opened) on-site — don't search again.
          continue;
        }
        const stepText = normalizeAgentStepText(steps[i]);
        let stepSkill = forceBuild
          ? "build"
          : resolveSkillForPrompt(
              agent,
              stepText,
              i === 0 ? attachments : [],
            );
        // Don't start a long-running monitor until later steps finish.
        if (stepSkill === "monitor" && i < steps.length - 1) {
          stepSkill = "browse";
        }
        lastSkill = stepSkill;
        agent.skill = stepSkill;
        emitProgress(agent.id, {
          status: "running",
          step: multi
            ? `Step ${i + 1}/${steps.length}: ${stepText.slice(0, 48)}`
            : "Working…",
          skill: stepSkill,
        });
        sendToAgentChannels(agent.id, "lykn:agent-status", {
          status: multi
            ? `Step ${i + 1}/${steps.length}: ${stepText.slice(0, 60)}`
            : "Working…",
        });

        const stepMeta = multi
          ? {
              index: i,
              total: steps.length,
              planLines,
              afterBrowse: browsedInPlan,
              fullAsk: q,
            }
          : null;
        // Only attach files on the first step.
        const stepAttachments = i === 0 ? attachments : [];
        // Skip plan steps whose work is already visible on the page.
        if (multi && ownedBrowserAct.planStepAlreadySatisfied) {
          try {
            const progCtx = await askProgressContext(agent);
            if (
              ownedBrowserAct.planStepAlreadySatisfied(
                stepText,
                originalAsk || q,
                progCtx,
              )
            ) {
              sendToAgentChannels(agent.id, "lykn:agent-status", {
                status: `Already done — skipping: ${stepText.slice(0, 48)}`,
              });
              continue;
            }
          } catch {
            /* run the step */
          }
        }

        // Run the current step only. Don't re-feed the entire original ask —
        // that caused rewrite/re-share loops. Residual gaps are handled below.
        const runText =
          openThenSearch && i === 0 && stepSkill === "browse" ? q : stepText;
        let part = await runOneSkill(
          agent,
          runText,
          stepAttachments,
          stepSkill,
          gen,
          stepMeta,
        );
        if (stepSkill === "browse" || stepSkill === "tool-create") {
          browsedInPlan = true;
        }

        // Bare land/open while later work remains — continue with REMAINING
        // parts only (never re-execute the whole prompt).
        if (
          multi &&
          (stepSkill === "browse" || stepSkill === "tool-create") &&
          ownedBrowserAct.askStillNeedsAdaptiveWork?.(q) &&
          /^(Opened|I opened|Step done|Finished getting)\b/i.test(
            String(part || "").trim(),
          )
        ) {
          const wcRetry = getBrowserWebContents?.(agent.id);
          if (wcRetry && !wcRetry.isDestroyed?.()) {
            const progCtx = await askProgressContext(agent);
            const remain =
              ownedBrowserAct.remainingAskGoal?.(originalAsk || q, progCtx) || "";
            if (remain) {
              const retry = await runAdaptiveBrowse(
                agent,
                remain,
                gen,
                wcRetry,
                {
                  adaptiveGoal: remain,
                  suppressDone: true,
                  conversationHistory: historyForPlanner(agent),
                  maxRounds: 12,
                },
              );
              if (retry) part = retry;
            }
          }
        }

        if (stepSkill === "monitor") {
          monitoring = true;
          if (gen === agent.generation) {
            agent.busy = false;
            agent.partialText = "";
            schedulePersist();
            emitList();
          }
          try {
            notifyAgentFinished?.({
              agentId: agent.id,
              title: agent.title,
              skill: "monitor",
              text: part,
              ok: true,
              prompt: originalAsk,
            });
          } catch {
            /* ignore */
          }
          return { ok: true, agentId: agent.id, skill: "monitor", monitoring: true };
        }

        if (part) stepAnswers.push(String(part).trim());
        if (gen === agent.generation) {
          recordStepDeliverable(agent, {
            index: i,
            skill: stepSkill,
            label: stepText,
            summary: part,
          });
        }

        // Between plan steps: re-check the ORIGINAL user ask. Only skip later
        // steps when EVERY part of the ask has evidence (not just the first).
        if (
          multi &&
          i < steps.length - 1 &&
          (stepSkill === "browse" || browsedInPlan) &&
          ownedBrowserAct.unmetBrowseAskRequirements
        ) {
          try {
            const wcCheck = getBrowserWebContents?.(agent.id);
            if (wcCheck && !wcCheck.isDestroyed?.()) {
              const pageCheck = await ownedBrowserAct.getPageContext(wcCheck);
              const gaps = ownedBrowserAct.unmetBrowseAskRequirements(
                originalAsk || q,
                {
                  url: pageCheck?.url || agent.url || "",
                  pageText: pageCheck?.text || "",
                  title: pageCheck?.title || "",
                  history: agent.lastAdaptiveHistory || [],
                },
              );
              if (!gaps.length) {
                sendToAgentChannels(agent.id, "lykn:agent-status", {
                  status: "Ask complete — skipping remaining steps",
                });
                break;
              }
            }
          } catch {
            /* ignore */
          }
        }

        // Paint step progress in Glass body (clickable chips) while work continues.
        if (multi && part && gen === agent.generation) {
          const progressive = formatMultiStepGlassStatus(agent, steps, stepAnswers);
          agent.partialText = progressive;
          sendToAgentChannels(agent.id, "lykn:agent-status", {
            status: `Step ${i + 1}/${steps.length} done`,
          });
          sendToAgentChannels(agent.id, "lykn:agent-delta", {
            text: progressive,
            final: false,
          });
          if (i < steps.length - 1) {
            sendToAgentChannels(agent.id, "lykn:agent-status", {
              status: `Step ${i + 2}/${steps.length}: ${String(steps[i + 1] || "")
                .slice(0, 60)}`,
            });
          }
          schedulePersist();
        }
        // Sign-in wall timed out — park the rest of the plan and tell the user
        // exactly how to continue. "done" / "signed in" resumes from this step.
        if (agent.step === "Needs sign-in") {
          const remaining = steps.slice(i);
          if (remaining.length) {
            agent.pendingPlan = {
              steps: remaining,
              ask: q,
              createdAt: new Date().toISOString(),
            };
            const resumeMsg =
              `I'm paused on a sign-in wall — sign in in the agent browser tab, ` +
              `then tell me **"done"** and I'll pick up right here:\n` +
              remaining.map((s, n) => `${n + 1}. ${s}`).join("\n");
            stepAnswers.push(resumeMsg);
          }
          break;
        }
      }

      if (gen !== agent.generation) return { ok: false, error: "superseded" };

      // Finish only what is still unmet — never re-run the whole original ask.
      if (
        (lastSkill === "browse" ||
          lastSkill === "tool-create" ||
          browsedInPlan) &&
        ownedBrowserAct.askStillNeedsAdaptiveWork?.(originalAsk || q) &&
        agent.step !== "Needs sign-in"
      ) {
        try {
          const wcFinal = getBrowserWebContents?.(agent.id);
          if (wcFinal && !wcFinal.isDestroyed?.()) {
            const progCtx = await askProgressContext(agent);
            const finalGaps =
              ownedBrowserAct.unmetBrowseAskRequirements?.(
                originalAsk || q,
                progCtx,
              ) || [];
            if (finalGaps.length) {
              const gapLine = finalGaps.slice(0, 4).join("; ");
              const remainGoal =
                ownedBrowserAct.remainingAskGoal?.(originalAsk || q, progCtx) ||
                "";
              sendToAgentChannels(agent.id, "lykn:agent-status", {
                status: `Finishing: ${gapLine.slice(0, 72)}`,
              });
              emitProgress(agent.id, {
                status: "running",
                step: `Finishing remaining — ${gapLine.slice(0, 40)}`,
                skill: "browse",
              });
              const onlyShareLeft =
                finalGaps.every((g) => /share|send/i.test(g)) &&
                ownedBrowserAct.sharePageWithEmail;
              let retryFinal = "";
              if (onlyShareLeft) {
                const shared = await ownedBrowserAct.sharePageWithEmail(wcFinal, {
                  ask: originalAsk || q,
                });
                agent.url = wcFinal.getURL?.() || agent.url;
                if (shared?.ok && shared?.verified && !shared.stuck) {
                  retryFinal = shared.message || "Shared with the recipient.";
                  agent.docShareDone = true;
                } else if (remainGoal) {
                  retryFinal = await runAdaptiveBrowse(
                    agent,
                    remainGoal,
                    gen,
                    wcFinal,
                    {
                      adaptiveGoal: remainGoal,
                      suppressDone: true,
                      conversationHistory: historyForPlanner(agent),
                      maxRounds: 10,
                    },
                  );
                }
              } else if (remainGoal) {
                retryFinal = await runAdaptiveBrowse(
                  agent,
                  remainGoal,
                  gen,
                  wcFinal,
                  {
                    adaptiveGoal: remainGoal,
                    suppressDone: true,
                    conversationHistory: historyForPlanner(agent),
                    maxRounds: 12,
                  },
                );
              }
              if (retryFinal) {
                stepAnswers.push(String(retryFinal).trim());
                lastSkill = "browse";
              }
            }
          }
        } catch {
          /* ignore — still return whatever we finished */
        }
      }

      // Full model answer (for history / context). Glass gets a short status.
      let answer = multi ? stepAnswers.filter(Boolean).join("\n\n---\n\n") : stepAnswers[0] || "";
      // Browse finishes should teach + suggest — never leave a mute "Done".
      if (
        answer &&
        (lastSkill === "browse" ||
          lastSkill === "browse-summary" ||
          browsedInPlan)
      ) {
        answer = ensureHelpfulAgentClose(answer, {
          goal: originalAsk || q,
          url: agent.url || "",
          title: "",
        });
      }

      // Main orchestrator may emit [[lykn_delegate:…|…]] markers to assign work.
      let pendingDelegates = [];
      if (isMainAgent(agent) && answer) {
        pendingDelegates = parseAssistantDelegates(answer);
        answer = stripDelegateMarkers(answer) || answer;
      }
      // Fold kickoff into Main's reply so the user always sees "I started X…"
      // without a second agent-done overwriting the answer.
      if (pendingDelegates.length) {
        const kickoffBlock = pendingDelegates
          .map((d) => formatDelegateKickoff(d.worker, d.prompt))
          .join("\n\n");
        answer = answer
          ? `${answer.trim()}\n\n---\n\n${kickoffBlock}`
          : kickoffBlock;
      }

      const openedInBrowser =
        !isMainAgent(agent) &&
        (agent.lastDeliverableKind === "report" ||
          agent.lastDeliverableKind === "artifact" ||
          agent.lastDeliverableKind === "image" ||
          !!agent.lastResearchReport ||
          !!agent.lastArtifact?.code ||
          !!agent.lastImage?.url);

      // Preserve "waiting" when we offered a complex-software choice.
      const waitingChoice = !!(
        agent.pendingChoice && agent.pendingChoice.type === "complex-tool"
      );

      let glassText = waitingChoice
        ? String(answer || "").trim()
        : isMainAgent(agent)
          ? String(answer || "").trim()
          : multi
            ? formatMultiStepGlassStatus(agent, steps, stepAnswers)
            : formatAgentGlassStatus({
                skill: lastSkill,
                answer,
                agent,
                // Conversational turns always show the answer itself — a
                // deliverable from an earlier turn must not hijack the reply.
                openedInBrowser:
                  lastSkill === "general"
                    ? false
                    : openedInBrowser ||
                      (skillWantsTextBrowserOutput(lastSkill) &&
                        looksLikeSubstantialTextOutput(answer)),
                multi,
                stepCount: steps.length,
              });

      agent.partialText = "";
      // Mark idle before glass done so list/progress never re-opens a "running" turn.
      agent.busy = false;
      agent.status = waitingChoice ? "waiting" : "idle";
      agent.step = waitingChoice
        ? "Waiting for your choice…"
        : pendingDelegates.length
          ? `Started ${pendingDelegates.map((d) => d.worker.title).join(", ")}`
          : "Done";
      agent.skill = waitingChoice ? "complex-offer" : lastSkill;
      agent.updatedAt = new Date().toISOString();
      const choiceOut = waitingChoice
        ? {
            choiceId: agent.pendingChoice.id,
            type: agent.pendingChoice.type,
            buttons:
              agent.pendingChoice.buttons || complexSoftwareChoiceButtons(),
            softwareName: agent.pendingChoice.softwareName || "",
          }
        : null;
      // Show the full summary in Glass for chat/browse/tool work. Multi-step
      // uses clickable step chips (glassText). Heavy deliverables (research/
      // build/image) keep a short status because the body lives in a tab.
      const showFullInGlass =
        !multi &&
        (lastSkill === "general" ||
          lastSkill === "browse" ||
          lastSkill === "browse-summary" ||
          lastSkill === "monitor" ||
          lastSkill === "tool-create" ||
          lastSkill === "sheets-create" ||
          lastSkill === "sheets-fill");
      const doneText = multi
        ? glassText
        : showFullInGlass
          ? String(answer || glassText || "").trim()
          : glassText;
      if (answer) {
        agent.history.push({
          role: "assistant",
          content: answer,
          ...(showFullInGlass || multi ? { glass: doneText } : { glass: glassText }),
          at: new Date().toISOString(),
        });
        sendToAgentChannels(agent.id, "lykn:agent-done", {
          text: doneText,
          final: true,
          ...(choiceOut ? { choice: choiceOut, waitingChoice: true } : {}),
        });
      } else {
        sendToAgentChannels(agent.id, "lykn:agent-done", {
          text: "",
          final: true,
          ...(choiceOut ? { choice: choiceOut, waitingChoice: true } : {}),
        });
      }
      schedulePersist();
      emitProgress(agent.id, {
        status: agent.status,
        step: agent.step,
        skill: agent.skill,
      });
      for (const d of pendingDelegates) {
        try {
          await delegateToWorker(d.worker, d.prompt, {
            fromMain: true,
            // Kickoff already folded into Main's answer above.
            paintKickoff: false,
          });
        } catch {
          /* ignore */
        }
      }
      if (!waitingChoice) {
        try {
          notifyAgentFinished?.({
            agentId: agent.id,
            title: agent.title,
            skill: lastSkill,
            text: answer,
            ok: true,
            prompt: originalAsk,
          });
        } catch {
          /* ignore */
        }
      }
      if (!isMainAgent(agent)) {
        try {
          reportWorkerToMain(agent, {
            text: answer,
            ok: true,
            skill: lastSkill,
          });
        } catch {
          /* ignore */
        }
      }
      return {
        ok: true,
        agentId: agent.id,
        skill: waitingChoice ? "complex-offer" : lastSkill,
        text: answer,
        steps: multi ? steps.length : 1,
        monitoring,
        delegated: pendingDelegates.length,
        ...(choiceOut
          ? { waitingChoice: true, choice: choiceOut }
          : {}),
      };
    } catch (e) {
      if (gen !== agent.generation) return { ok: false, error: "superseded" };
      const message = e?.name === "AbortError" ? "Stopped." : e?.message || String(e);
      agent.busy = false;
      agent.partialText = "";
      agent.status = e?.name === "AbortError" ? "idle" : "error";
      agent.error = message;
      agent.step = message.slice(0, 80);
      agent.history.push({
        role: "assistant",
        content: message,
        at: new Date().toISOString(),
      });
      sendToAgentChannels(agent.id, "lykn:agent-error", { message });
      schedulePersist();
      emitProgress(agent.id, { status: agent.status, step: agent.step });
      if (e?.name !== "AbortError") {
        try {
          notifyAgentFinished?.({
            agentId: agent.id,
            title: agent.title,
            skill: agent.skill,
            ok: false,
            error: message,
            prompt: originalAsk,
          });
        } catch {
          /* ignore */
        }
        if (!isMainAgent(agent)) {
          try {
            reportWorkerToMain(agent, {
              ok: false,
              error: message,
              skill: agent.skill,
            });
          } catch {
            /* ignore */
          }
        }
      }
      return { ok: false, error: message };
    }
  }

  function getActive() {
    return activeAgentId ? publicAgent(agents.get(activeAgentId)) : null;
  }

  function getHistory(agentId) {
    const a = agents.get(agentId || activeAgentId);
    return a ? a.history.slice() : [];
  }

  function getSwitchSnapshot(agentId) {
    return switchPayload(agents.get(agentId || activeAgentId) || null);
  }

  function setAgentUrl(agentId, url) {
    const a = agents.get(agentId);
    if (!a) return { ok: false };
    const next = String(url || "").trim();
    a.url = ownedBrowserAct.isPlaceholderAgentUrl(next) ? "" : next;
    a.updatedAt = new Date().toISOString();
    schedulePersist();
    emitList();
    return { ok: true, url: a.url };
  }

  function clearBrowserSurface(agentId) {
    return setAgentUrl(agentId, "");
  }

  function disposeAll() {
    for (const a of agents.values()) abortAgent(a, "closed");
  }

  return {
    MAX_AGENTS,
    MAX_WORKER_AGENTS,
    load,
    persist,
    createAgent,
    ensureMainAgent,
    getMainAgent,
    switchAgent,
    stopAgent,
    closeAgent,
    resetMainChat,
    setAgentMode,
    send,
    resolveChoice,
    delegateToWorker,
    setMainLinkedBrowser,
    getMainLinkedBrowser: () => mainLinkedBrowserId || "",
    listPublic,
    getActive,
    getActiveId: () => activeAgentId,
    getHistory,
    getSwitchSnapshot,
    setAgentUrl,
    clearBrowserSurface,
    showStepDeliverable,
    emitList,
    // Recreate the tab for every worker agent (used when the Studio browser
    // docks, so restored agents never sit in the rail without a tab).
    ensureAgentTabs: () => syncAgentBrowserTabs({ focusId: activeAgentId }),
    isAgentModeOn: () => agentModeOn,
    isMainAgent,
    classifyAgentSkill,
    disposeAll,
    publicAgent,
  };
}

module.exports = {
  createAgentRuntime,
  classifyAgentSkill,
  looksLikePasteReportIntoSheets,
  looksLikeCreateInGoogleSheetsAsk,
  looksLikeCreateInToolVenueAsk,
  matchCreateInToolVenue,
  looksLikeDeliverableEdit,
  looksLikeOpenDeliverableFollowUp,
  MAX_AGENTS,
};
