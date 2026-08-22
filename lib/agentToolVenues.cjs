/**
 * External tool venues for Agent Mode.
 * Plain "create me a presentation" → LYKN artifact.
 * "create me a presentation in PowerPoint" → open that tool and work there.
 */

"use strict";

/** @typedef {{ id: string, name: string, labels: RegExp[], softLabels?: RegExp[], createUrl: string, urlMatch: RegExp, fill: 'sheets-tsv'|'docs-text'|'slides-outline'|'navigate-brief', contentHints: RegExp }} ToolVenue */

/** @type {ToolVenue[]} */
const TOOL_VENUES = [
  {
    id: "google-sheets",
    name: "Google Sheets",
    labels: [/\bgoogle\s*sheets?\b/i, /\bsheets\.google\b/i],
    softLabels: [/\bsheets?\b/i],
    createUrl: "https://docs.google.com/spreadsheets/create",
    urlMatch: /docs\.google\.com\/spreadsheets/i,
    fill: "sheets-tsv",
    contentHints:
      /\b(budget|tracker|planner|spreadsheet|worksheet|table|ledger|inventory|schedule|roster|expenses?|income|list|matrix|crm|pipeline|timesheet|invoice)\b/i,
  },
  {
    id: "excel",
    name: "Excel",
    labels: [/\bmicrosoft\s+excel\b/i, /\bexcel\s+online\b/i, /\bexcel\b/i],
    createUrl: "https://excel.cloud.microsoft/new/",
    urlMatch: /excel\.(cloud\.)?microsoft|office\.com\/.*excel|excel\.office/i,
    fill: "sheets-tsv",
    contentHints:
      /\b(budget|tracker|planner|spreadsheet|worksheet|table|ledger|inventory|schedule|roster|expenses?|income|list|matrix)\b/i,
  },
  {
    id: "google-slides",
    name: "Google Slides",
    labels: [/\bgoogle\s*slides?\b/i],
    createUrl: "https://docs.google.com/presentation/create",
    urlMatch: /docs\.google\.com\/presentation/i,
    fill: "slides-outline",
    contentHints:
      /\b(presentation|deck|slides?|slideshow|pitch|keynote)\b/i,
  },
  {
    id: "powerpoint",
    name: "PowerPoint",
    labels: [/\bpower\s*point\b/i, /\bpptx?\b/i, /\bmicrosoft\s+powerpoint\b/i],
    createUrl: "https://powerpoint.cloud.microsoft/new/",
    urlMatch: /powerpoint\.(cloud\.)?microsoft|powerpoint\.office|office\.com\/.*powerpoint/i,
    fill: "slides-outline",
    contentHints:
      /\b(presentation|deck|slides?|slideshow|pitch|keynote)\b/i,
  },
  {
    id: "google-docs",
    name: "Google Docs",
    labels: [/\bgoogle\s*docs?\b/i],
    softLabels: [/\bdocs?\b/i],
    createUrl: "https://docs.google.com/document/create",
    urlMatch: /docs\.google\.com\/document/i,
    fill: "docs-text",
    contentHints:
      /\b(doc|document|report|brief|essay|memo|letter|proposal|write-?up|article)\b/i,
  },
  {
    id: "canva",
    name: "Canva",
    labels: [/\bcanva\b/i],
    createUrl: "https://www.canva.com/",
    urlMatch: /canva\.com/i,
    fill: "navigate-brief",
    /** Browser automation is unreliable — offer a LYKN artifact instead. */
    complexUi: true,
    contentHints:
      /\b(resume|cv|presentation|deck|poster|flyer|logo|design|banner|thumbnail|social|instagram|story|infographic|invitation|menu)\b/i,
  },
  {
    id: "figma",
    name: "Figma",
    labels: [/\bfigma\b/i],
    createUrl: "https://www.figma.com/",
    urlMatch: /figma\.com/i,
    fill: "navigate-brief",
    complexUi: true,
    contentHints:
      /\b(design|prototype|mockup|wireframe|ui|interface|figma|component|frame)\b/i,
  },
  {
    id: "notion",
    name: "Notion",
    labels: [/\bnotion\b/i],
    // notion.so/new = official "new page" shortcut — lands straight in an
    // empty editor (no SERP hunt, no clicking through the sidebar).
    createUrl: "https://www.notion.so/new",
    urlMatch: /notion\.so/i,
    fill: "docs-text",
    complexUi: false,
    contentHints:
      /\b(page|doc|document|wiki|notes?|database|tracker|planner)\b/i,
  },
];

/** Design / 3D / pro creative apps where owned-browser automation is a poor fit. */
const COMPLEX_SOFTWARE_NAME_RE =
  /\b(canva|figma|blender|cinema\s*4d|c4d|maya|3ds\s*max|photoshop|illustrator|after\s*effects|premiere(?:\s*pro)?|unity|unreal(?:\s*engine)?|sketchup|autocad|solidworks|procreate|substance|zbrush|houdini|nuke|davinci|final\s*cut(?:\s*pro)?|adobe\s*xd|invision)\b/i;

const CREATE_VERB_RE =
  /\b(create|make|build|draft|generate|design|compose|set\s+up|whip\s+up|put\s+together|start|write|type|author|pen|jot|take\s+(?:a\s+|some\s+|quick\s+)?(?:new\s+)?notes?|note\s+down|jot\s+down)\b/i;
const OPEN_VERB_RE =
  /\b(go\s+to|go\s+into|open|pull\s+up|visit|launch|navigate(?:\s+to)?|take\s+me\s+to|bring\s+up)\b/i;
const VENUE_PREP_RE =
  /\b(in|on|inside|into|using|via|with|through|within)\b/i;

/**
 * User wants to change the open file/tab — not start a brand-new one.
 * "add a column", "edit this budget", "organize the sheet", "fix this doc".
 * With liveUrl on an editable Docs/Sheets/Notion page, also catches bare
 * follow-ups: "make it shorter", "add a conclusion", "rewrite the intro".
 *
 * @param {string} text
 * @param {{ liveUrl?: string }} [opts]
 */
function looksLikeEditCurrentInToolAsk(text, opts = {}) {
  const t = String(text || "").trim();
  const lower = t.toLowerCase();
  if (!lower) return false;

  // Explicit "new / another / blank file" → create, not edit.
  if (
    /\b(new|another|fresh|blank|different|second|brand[- ]?new)\b/.test(lower) &&
    /\b(doc|document|sheet|spreadsheet|deck|presentation|page|file|essay|report)\b/.test(
      lower,
    ) &&
    /\b(create|make|start|open|write|draft)\b/.test(lower)
  ) {
    return false;
  }

  // Must point at the OPEN thing — not the product name ("google docs").
  const pointsAtOpen =
    /\b(this|that|these|those|the\s+open|the\s+current|here|in\s+here|on\s+this|it)\b/i.test(
      lower,
    ) ||
    /\bthe\s+(sheet|spreadsheet|doc|document|deck|presentation|slides?|table|grid|file|design|page|essay|draft)\b/i.test(
      lower,
    ) ||
    // Parts of the open document ("rewrite the opening paragraph", "fix the
    // intro"). A position word alone counts so a typoed "the" still matches.
    /\b(?:(?:opening|closing|first|last|second|final)\s+|(?:the|this|that|my|its|our)\s+)(paragraph|sentence|intro|introduction|conclusion|heading|title|section|bullet)s?\b/i.test(
      lower,
    );

  // Structural edits to a workbook/doc/deck.
  if (
    /\b(add|remove|delete|insert|append|rename|move|merge|split|sort|filter|format|reorganize|organise|organize|clean\s*up|tidy)\b/i.test(
      lower,
    ) &&
    /\b(column|columns|row|rows|cell|cells|tab|sheet|section|heading|title|slide|slides|page|field|formula|chart|header|paragraph|conclusion|introduction|intro)\b/i.test(
      lower,
    )
  ) {
    return true;
  }

  // Edit/fix / fill the open thing (including "make this…" which also matches create verbs).
  if (
    /\b(edit|change|update|tweak|adjust|modify|revise|improve|fix|restyle|rewrite|reword|replace|paste|put|enter|fill|shorten|expand|tighten|punchier)\b/i.test(
      lower,
    ) &&
    pointsAtOpen
  ) {
    return true;
  }

  // "make this …" / "make it …" while in a tool = edit, not new file.
  if (/\bmake\s+(this|that|it|the\s+\w+)\b/i.test(lower)) {
    return true;
  }

  // Length / tone tweaks that imply the open draft.
  if (
    /\b(shorter|longer|punchier|tighter|clearer|simpler|more\s+formal|less\s+formal|more\s+casual)\b/i.test(
      lower,
    ) &&
    (pointsAtOpen ||
      /\b(make|rewrite|revise|edit|change|update|tone|intro|conclusion|essay|doc|document|draft)\b/i.test(
        lower,
      ))
  ) {
    return true;
  }

  // Organize / format the open sheet (ownedBrowserAct has a richer detector; this is the venue gate).
  if (
    /\b(organize|organise|format|structure|clean\s*up|tidy)\b/i.test(lower) &&
    /\b(sheet|sheets|spreadsheet|table|grid|doc|document|deck|slides?)\b/i.test(lower)
  ) {
    return true;
  }

  // Already in an editable file — revision follow-ups don't need "this/that".
  const live = String(opts.liveUrl || "").trim();
  const venue = live ? toolVenueFromUrl(live) : null;
  if (venue && venueHasEditableSurface(venue, live)) {
    if (
      /\b(edit|change|update|tweak|adjust|modify|revise|improve|fix|rewrite|reword|replace|shorten|expand|tighten|add|include|insert|remove|delete|append|title|rename|bold|italic|format)\b/i.test(
        lower,
      )
    ) {
      return true;
    }
    if (
      /\b(shorter|longer|punchier|tighter|clearer|conclusion|introduction|intro|paragraph|section|heading)\b/i.test(
        lower,
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Create/make flows should open a brand-new file in the tool.
 * Edit-current asks stay on the open surface.
 */
function shouldOpenFreshVenueFile(text, venue, url) {
  if (!venue) return false;
  if (looksLikeEditCurrentInToolAsk(text, { liveUrl: url })) return false;
  const u = String(url || "");
  // Already mid /create → /d/ redirect — don't restart.
  if (/\/(?:spreadsheets|document|presentation)\/create\b/i.test(u)) return false;
  if (/\/(?:new)\/?$/i.test(u) && (venue.id === "excel" || venue.id === "powerpoint")) {
    return false;
  }
  // Already in a real editor:
  // - explicit create/make/write → brand-new file (Sheets/Docs/Canva/…)
  // - short continuations ("do it", "keep going") stay on the open surface
  if (venueLooksLikeWorkingSurface(venue, u)) {
    if (CREATE_VERB_RE.test(String(text || ""))) return true;
    return /\b(new|another|fresh|blank|different|second|one\s+more)\b/i.test(
      String(text || ""),
    );
  }
  // Any create/make/build in a tool venue → new file (even if an old listing is open).
  return true;
}

/**
 * Known start URL is specific enough to skip a Google SERP hunt
 * (category create/templates path, not bare marketing home).
 */
function toolStartUrlIsSpecific(url, venue) {
  const raw = String(url || "").trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return false;
  try {
    const u = new URL(raw);
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    if (path === "/") return false;
    const home = String(venue?.createUrl || "").replace(/\/+$/, "");
    if (home && raw.replace(/\/+$/, "") === home) return false;
    const parts = path.split("/").filter(Boolean);
    if (parts.length >= 2) return true;
    return /\/(create|new|templates?|design|edit|compose|docs?)\b/i.test(path);
  } catch {
    return false;
  }
}

function venueNamedInText(venue, lower) {
  for (const re of venue.labels || []) {
    if (re.test(lower)) return true;
  }
  // Soft labels ("sheets", "docs") only with open/go or in/on prep.
  for (const re of venue.softLabels || []) {
    if (!re.test(lower)) continue;
    if (OPEN_VERB_RE.test(lower) || VENUE_PREP_RE.test(lower)) return true;
  }
  return false;
}

function venueMatchesLiveUrl(venue, liveUrl) {
  if (!liveUrl || !venue.urlMatch) return false;
  return venue.urlMatch.test(String(liveUrl));
}

/**
 * True when the tab is an editable file we can paste into — not the product home/listing.
 * Sheets home (`/spreadsheets/u/0/`) matches urlMatch but has no grid.
 */
function venueHasEditableSurface(venue, url) {
  const u = String(url || "");
  if (!venue || !u) return false;
  switch (venue.id) {
    case "google-sheets":
      return /docs\.google\.com\/spreadsheets\/(?:d\/[\w-]+|create\b)/i.test(u);
    case "google-docs":
      return /docs\.google\.com\/document\/(?:d\/[\w-]+|create\b)/i.test(u);
    case "google-slides":
      return /docs\.google\.com\/presentation\/(?:d\/[\w-]+|create\b)/i.test(u);
    case "excel":
      return (
        /excel\.(cloud\.)?microsoft\/new/i.test(u) ||
        /excel\.(cloud\.)?microsoft\/.*(edit|workbook|w\/)/i.test(u) ||
        /office\.com\/.*excel.*(edit|new)/i.test(u)
      );
    case "powerpoint":
      return (
        /powerpoint\.(cloud\.)?microsoft\/new/i.test(u) ||
        /powerpoint\.(cloud\.)?microsoft\/.*(edit|p\/)/i.test(u) ||
        /office\.com\/.*powerpoint.*(edit|new)/i.test(u)
      );
    case "notion":
      // A real page (uuid slug) — /new is still redirecting, home/login aren't editors.
      return (
        /notion\.(so|site)\/.+/i.test(u) &&
        !/notion\.so\/(?:$|new\b|login|signup|onboarding)/i.test(u)
      );
    default:
      return venue.urlMatch.test(u);
  }
}

/** Home / recent-files listing — must open createUrl before paste. */
function venueIsListingOrHome(venue, url) {
  const u = String(url || "");
  if (!venue || !u || !venue.urlMatch.test(u)) return false;
  return !venueHasEditableSurface(venue, u);
}

/**
 * If the user named an external tool as the place to create something,
 * return that venue. Otherwise null (→ LYKN artifact / normal skill).
 *
 * @param {string} text
 * @param {{ liveUrl?: string }} [opts]
 * @returns {ToolVenue | null}
 */
function matchCreateInToolVenue(text, opts = {}) {
  const t = String(text || "").trim();
  const lower = t.toLowerCase();
  if (!t) return null;
  // "edit this sheet" / "add a column" → stay on the open file (not tool-create).
  if (looksLikeEditCurrentInToolAsk(t, opts)) return null;
  // "figma-like tool" / "blender replica" / "how hard to make…" — not create-in-tool.
  if (looksLikeSoftwareMentionNotInsideAsk(t)) return null;

  // Prefer longer / more specific label matches (PowerPoint before ppt).
  const ranked = [...TOOL_VENUES].sort((a, b) => {
    const al = (a.labels[0] || "").toString().length;
    const bl = (b.labels[0] || "").toString().length;
    return bl - al;
  });

  for (const venue of ranked) {
    const named = venueNamedInText(venue, lower);
    const live = venueMatchesLiveUrl(venue, opts.liveUrl);
    if (!named && !live) continue;

    // "go to powerpoint and create a presentation"
    if (
      named &&
      OPEN_VERB_RE.test(lower) &&
      CREATE_VERB_RE.test(lower)
    ) {
      return venue;
    }

    // "create a presentation in powerpoint" / "make a budget using excel"
    // Require a real venue prep (in/on/using…) — contentHints alone is too loose
    // ("make a figma like tool" used to match because "figma" is in contentHints).
    if (
      named &&
      CREATE_VERB_RE.test(lower) &&
      (VENUE_PREP_RE.test(lower) || /\b(for|about)\b/.test(lower)) &&
      (venue.contentHints.test(lower) ||
        /\b(in|on|inside|into|using|via|with|through|within)\s+\S+/i.test(lower))
    ) {
      return venue;
    }

    // Already in the tool: "create a budget" / "make me a presentation"
    // EXCEPT fresh deck/presentation builds: "build me a slide deck on X" is a
    // LYKN artifact even when a Slides/PowerPoint tab happens to be open — the
    // user must name the tool ("in google slides") to build there.
    const freshDeckBuild =
      venue.fill === "slides-outline" &&
      /\b(build|create|make|design|put\s+together|generate)\b.{0,48}\b(me\s+)?(an?\s+)?(presentation|slide\s*deck|deck|slides?|slideshow)\b/i.test(
        lower,
      );
    if (
      live &&
      CREATE_VERB_RE.test(lower) &&
      (venue.contentHints.test(lower) || named) &&
      !/\b(lykn\s+)?artifact\b/i.test(lower) &&
      !(freshDeckBuild && !named)
    ) {
      return venue;
    }
  }
  return null;
}

function looksLikeCreateInToolVenueAsk(text, opts = {}) {
  return !!matchCreateInToolVenue(text, opts);
}

/**
 * The text explicitly names an external tool ("google slides", "in sheets",
 * "powerpoint"). Used to keep live-URL/context venue inference from hijacking
 * asks where the user never asked for a specific tool.
 */
function toolVenueExplicitlyNamed(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower.trim()) return false;
  return TOOL_VENUES.some((venue) => venueNamedInText(venue, lower));
}

function getToolVenueById(id) {
  return TOOL_VENUES.find((v) => v.id === id) || null;
}

function toolVenueFromUrl(url) {
  const u = String(url || "");
  if (!u) return null;
  return TOOL_VENUES.find((v) => v.urlMatch.test(u)) || null;
}

/** Topic words from "create me a resume in canva" → "resume". */
function extractToolCreateTopic(text, venue) {
  let s = String(text || "");
  if (!s.trim()) return "";
  if (venue?.labels) {
    for (const re of venue.labels) {
      try {
        s = s.replace(re, " ");
      } catch {
        /* ignore */
      }
    }
  }
  if (venue?.softLabels) {
    for (const re of venue.softLabels) {
      try {
        s = s.replace(re, " ");
      } catch {
        /* ignore */
      }
    }
  }
  s = s
    .replace(
      /\b(go\s+(?:to|into)|open|pull\s+up|visit|launch|navigate(?:\s+to)?|bring\s+up|take\s+me\s+to)\b/gi,
      " ",
    )
    .replace(
      /\b(create|make|build|draft|generate|design|compose|write|type|start|set\s+up|whip\s+up|put\s+together)\b/gi,
      " ",
    )
    .replace(/\b(me|us|my|our|a|an|the|some|new|blank|fresh|empty)\b/gi, " ")
    .replace(/\b(in|on|inside|into|using|via|with|through|within|for|about|and|then|please)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, 80);
}

/** Hostname preference for deep-link picking (canva.com, figma.com, …). */
function venueDeepLinkHost(venue) {
  if (!venue) return "";
  try {
    return new URL(venue.createUrl || "https://example.com").hostname
      .replace(/^www\./i, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Silent Google query used to find a create/edit deep link for ANY tool.
 * Prefer blank/create/new surfaces; only bias to "templates" when the user asks.
 */
function buildToolDeepLinkSearchQuery(venue, text) {
  if (!venue) return "";
  const topic = extractToolCreateTopic(text, venue);
  const host = venueDeepLinkHost(venue);
  const name = String(venue.name || "").trim() || host;
  const lower = String(text || "").toLowerCase();
  const wantsTemplates = /\btemplates?\b/i.test(lower);
  const bits = [name];
  if (topic) bits.push(topic);
  if (wantsTemplates) {
    bits.push("templates");
  } else if (venue.fill === "navigate-brief") {
    // Deep-link hunt: create/blank/new — not a templates gallery loop.
    bits.push("create", "blank", "new");
  }
  let q = bits.join(" ").replace(/\s+/g, " ").trim();
  if (host) q += ` site:${host}`;
  return q.slice(0, 160);
}

/**
 * Best first URL when creating in a complex web tool.
 * Known deep links beat marketing homes; adaptive click-through finishes the rest.
 */
function resolveToolCreateStartUrl(venue, text) {
  if (!venue) return "";
  const lower = String(text || "").toLowerCase();
  const wantTemplates = /\btemplates?\b/i.test(lower);
  if (venue.id === "canva") {
    // Prefer create hubs (closer to blank/editor) unless they asked for templates.
    if (/\b(resume|cv|curriculum\s+vitae)\b/i.test(lower)) {
      return wantTemplates
        ? "https://www.canva.com/resumes/templates/"
        : "https://www.canva.com/create/resumes/";
    }
    if (/\b(presentation|deck|slides?|pitch)\b/i.test(lower)) {
      return wantTemplates
        ? "https://www.canva.com/presentations/templates/"
        : "https://www.canva.com/create/presentations/";
    }
    if (/\b(poster|flyer)\b/i.test(lower)) {
      return wantTemplates
        ? "https://www.canva.com/posters/templates/"
        : "https://www.canva.com/create/posters/";
    }
    if (/\blogo\b/i.test(lower)) {
      return wantTemplates
        ? "https://www.canva.com/logos/templates/"
        : "https://www.canva.com/create/logos/";
    }
    if (/\b(instagram|social|story|post)\b/i.test(lower)) {
      return wantTemplates
        ? "https://www.canva.com/instagram-posts/templates/"
        : "https://www.canva.com/create/instagram-posts/";
    }
    if (/\b(banner|youtube\s*banner|channel\s*art)\b/i.test(lower)) {
      return wantTemplates
        ? "https://www.canva.com/youtube-banners/templates/"
        : "https://www.canva.com/create/youtube-banners/";
    }
    if (/\binfographic\b/i.test(lower)) {
      return wantTemplates
        ? "https://www.canva.com/infographics/templates/"
        : "https://www.canva.com/create/infographics/";
    }
    return "https://www.canva.com/create/";
  }
  if (venue.id === "figma") {
    if (/\b(design|file|frame|mockup|new)\b/i.test(lower)) {
      return "https://www.figma.com/files/recent";
    }
    return venue.createUrl || "https://www.figma.com/";
  }
  if (venue.id === "notion") {
    return venue.createUrl || "https://www.notion.so/";
  }
  return venue.createUrl || "";
}

/** True when this venue is a poor fit for click-automation (offer artifact instead). */
function isComplexUiToolVenue(venue) {
  return !!(venue && venue.complexUi === true);
}

/**
 * Strip the external tool name so the same ask can become a LYKN artifact build.
 * "go into canva and write me a resume" → "write me a resume"
 */
function stripToolVenueForArtifactAsk(text, venue) {
  let s = String(text || "");
  if (!s.trim()) return "Create this as a custom LYKN artifact";
  if (venue?.labels) {
    for (const re of venue.labels) {
      try {
        s = s.replace(re, " ");
      } catch {
        /* ignore */
      }
    }
  }
  s = s
    .replace(COMPLEX_SOFTWARE_NAME_RE, " ")
    .replace(
      /\b(go\s+(?:to|into)|open|pull\s+up|visit|launch|navigate(?:\s+to)?|bring\s+up|take\s+me\s+to)\b/gi,
      " ",
    )
    .replace(/\b(in|on|inside|into|using|via|with|through|within)\b/gi, " ")
    .replace(/\b(can|could|would|will)\s+you\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:and|then|please|just|,)+\s+/i, "")
    .replace(/\s+(?:and|then|please|just|,)+$/i, "")
    .trim();
  if (!s || s.length < 3) {
    const topic = cleanComplexDeliverableLabel(extractToolCreateTopic(text, venue));
    s = topic ? `Create a ${topic}` : "Create this as a custom LYKN artifact";
  } else if (!CREATE_VERB_RE.test(s)) {
    const topic = cleanComplexDeliverableLabel(extractToolCreateTopic(text, venue));
    s = topic ? `Create a ${topic}` : `Create ${s}`;
  }
  return s.slice(0, 500);
}

/** Clean topic crumbs like "can you 3d model" → "3d model". */
function cleanComplexDeliverableLabel(topic) {
  return String(topic || "")
    .replace(/\b(can|could|would|will)\s+you\b/gi, " ")
    .replace(
      /\b(go\s+(?:to|into)|open|pull\s+up|visit|launch|navigate(?:\s+to)?)\b/gi,
      " ",
    )
    .replace(/^(?:and|then|please|just|me|a|an|the|how|hard|easy|difficult)\s+/i, "")
    .replace(/\b(how hard|how easy|how difficult|would it be|for you to)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * True when the software name is the *subject* to build/discuss (a replica,
 * clone, "like Blender" app) — not a request to work inside that software.
 */
function looksLikeSoftwareMentionNotInsideAsk(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  // "blender replica", "figma clone", "canva alternative", "like photoshop"
  if (
    /\b(replica|clone|knock[- ]?off|alternative|recreation|remake|emulator|copycat)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(like|similar\s+to|inspired\s+by|based\s+on|version\s+of|copy\s+of)\b.{0,40}\b(?:canva|figma|blender|photoshop|illustrator|unity|unreal)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(?:canva|figma|blender|photoshop|illustrator|unity|unreal)\b.{0,24}\b(like|style|inspired|replica|clone|alternative|software|app|tool)\b/i.test(
      t,
    ) &&
    !OPEN_VERB_RE.test(t) &&
    !/\b(in|on|inside|into|using|via|with|through|within)\s+(?:canva|figma|blender|photoshop)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  // Meta / hypothetical without navigating into the app.
  if (
    /\b(how hard|how (?:easy|difficult)|is it possible|what would it take)\b/i.test(t) &&
    !OPEN_VERB_RE.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * User wants to operate INSIDE the complex app (open it / create in it),
 * not merely mention it while asking for a LYKN artifact.
 */
function looksLikeWorkInsideComplexSoftware(text) {
  const t = String(text || "").trim();
  const lower = t.toLowerCase();
  if (!t || !COMPLEX_SOFTWARE_NAME_RE.test(lower)) return false;
  if (looksLikeSoftwareMentionNotInsideAsk(t)) return false;

  // "go into blender and build…", "open canva and write…"
  if (OPEN_VERB_RE.test(lower) && CREATE_VERB_RE.test(lower)) return true;

  // "create a logo in canva" / "make a model using blender"
  if (
    CREATE_VERB_RE.test(lower) &&
    /\b(in|on|inside|into|using|via|with|through|within)\s+(?:the\s+)?(?:canva|figma|blender|cinema\s*4d|c4d|maya|photoshop|illustrator|after\s*effects|premiere|unity|unreal|sketchup|autocad|solidworks|procreate|zbrush|houdini|nuke|davinci|final\s*cut|adobe\s*xd|invision)\b/i.test(
      lower,
    )
  ) {
    return true;
  }

  // Catalogued tool-create already implies work-inside.
  if (matchCreateInToolVenue(t)) return true;

  return false;
}

/**
 * When LYKN shouldn't drive complex software UI, offer a custom artifact instead.
 * Only when they want to work *inside* that software — not when they mention it
 * ("blender replica", "how hard to build a figma-like app").
 * @returns {{ softwareName: string, deliverableLabel: string, artifactAsk: string, venue: object|null } | null}
 */
function matchComplexSoftwareOffer(text, opts = {}) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (looksLikeEditCurrentInToolAsk(t, opts)) return null;
  if (looksLikeSoftwareMentionNotInsideAsk(t)) return null;
  if (!looksLikeWorkInsideComplexSoftware(t)) return null;

  const venue = matchCreateInToolVenue(t, opts);
  if (isComplexUiToolVenue(venue)) {
    const topic = cleanComplexDeliverableLabel(extractToolCreateTopic(t, venue));
    return {
      venue,
      softwareName: venue.name,
      deliverableLabel: topic || "what you asked for",
      artifactAsk: stripToolVenueForArtifactAsk(t, venue),
    };
  }

  // Named complex app + work-inside intent, even if not in TOOL_VENUES yet.
  const named = t.match(COMPLEX_SOFTWARE_NAME_RE);
  if (!named || !CREATE_VERB_RE.test(t)) return null;
  const softwareName = named[0].replace(/\s+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const fakeVenue = venue || {
    id: "complex-software",
    name: softwareName,
    labels: [COMPLEX_SOFTWARE_NAME_RE],
    fill: "navigate-brief",
    complexUi: true,
  };
  const topic = cleanComplexDeliverableLabel(extractToolCreateTopic(t, fakeVenue));
  return {
    venue: fakeVenue,
    softwareName,
    deliverableLabel: topic || "what you asked for",
    artifactAsk: stripToolVenueForArtifactAsk(t, fakeVenue),
  };
}

function buildComplexSoftwareOfferMessage(offer) {
  const software = String(offer?.softwareName || "that software").trim();
  const thing = String(offer?.deliverableLabel || "what you asked for").trim();
  const thingBit =
    thing && thing.toLowerCase() !== "what you asked for"
      ? `**${thing}**`
      : "what you asked for";
  return (
    `LYKN doesn't perform well inside really complex software like **${software}**.\n\n` +
    `If you need ${thingBit} built, it's better to use a custom LYKN artifact — I can build that here.\n\n` +
    `Choose an option below:`
  );
}

function complexSoftwareChoiceButtons() {
  return [
    { id: "use-artifact", label: "Use custom artifact", primary: true },
    { id: "stop", label: "No, just stop here", primary: false },
  ];
}

/**
 * Multi-step doctrine for finishing work inside ANY external tool.
 * Deep link when possible → click through the real UI → do the work → report.
 */
function looksLikeShareSendTail(ask) {
  const t = String(ask || "").toLowerCase();
  return (
    /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/.test(t) &&
    /\b(?:send|share|email|forward|invite)\b/.test(t)
  );
}

/** Strip "then send/share it to email@…" so topic/draft stay write-only. */
function stripShareSendTail(ask) {
  return String(ask || "")
    .replace(
      /\s*[,;.]?\s*(?:and\s+)?(?:then\s+)?(?:please\s+)?(?:share|send|email|forward|invite)\s+(?:it|this|that|the\s+(?:doc|document|file|sheet|deck|essay|paper|report))?\s*(?:out\s+)?(?:to|with)\s+[\w.+-]+@[\w.-]+(?:\.\w+)*\s*[.!]?\s*/gi,
      " ",
    )
    .replace(
      /\s*[,;.]?\s*(?:and\s+)?(?:then\s+)?(?:please\s+)?(?:share|send|email)\s+(?:to|with)\s+[\w.+-]+@[\w.-]+(?:\.\w+)*\s*[.!]?\s*/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function buildToolActAdaptiveGoal(venue, ask, { draft = "" } = {}) {
  const name = String(venue?.name || "the tool").trim();
  const rawAsk = String(ask || "").trim();
  const writeAsk = stripShareSendTail(rawAsk) || rawAsk;
  const shareSend = looksLikeShareSendTail(rawAsk);
  const emails = (rawAsk.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).slice(0, 3);
  const topic = extractToolCreateTopic(writeAsk, venue);
  const cleanDraft = String(draft || "")
    .trim()
    .replace(
      /\n+\s*[^\n]*(?:then\s+)?(?:send|share|email)\s+(?:it|this|that)\s+to\s+[\w.+-]+@[\w.-]+[^\n]*$/i,
      "",
    )
    .replace(
      /\s*(?:then\s+)?(?:send|share)\s+it\s+to\s+[\w.+-]+@[\w.-]+(?:\.\w+)*\s*$/i,
      "",
    )
    .trim();
  const draftBit = cleanDraft
    ? `\n\nDRAFTED CONTENT TO PLACE IN THE TOOL — click into the writing surface, then put ALL of it in with one \`paste_text\` (do not retype it):\n${cleanDraft.slice(0, 12000)}\n`
    : "";
  const shareBit = shareSend
    ? `\n\nSHARE STEP (required after content is in the doc — do NOT skip):\n` +
      `After the drafted content is in the document body, click Share (or File → Share), ` +
      `add ${emails[0] || "the recipient email"} in Add people, then click Send.\n` +
      `NEVER type "send it to …" / "share it with …" into the document body — that is NOT sharing.\n` +
      `Writing alone is NOT done while share/send is still unfinished.\n`
    : "";
  return (
    `FINISH the user's ask INSIDE the open ${name} tab (not a LYKN artifact, not Google).\n` +
    `User ask: ${rawAsk}\n` +
    (writeAsk !== rawAsk ? `Write portion (content only): ${writeAsk}\n` : "") +
    (topic ? `Topic: ${topic}\n` : "") +
    `\nFollow this pattern until done (multi-step is expected):\n` +
    `1) DEEP LINK / SURFACE: If you are on home, marketing, gallery, or the wrong page, get to the ` +
    `right create/edit surface INSIDE ${name} — use in-app Create/New/Blank/Search, menus, or the ` +
    `first free matching item. Prefer a blank/new document when they asked to write/create. ` +
    `Do not leave ${name} to Google.\n` +
    `2) WORKING PAGE: Keep clicking until you are on the real editor/doc/canvas/file — not a listing.\n` +
    `3) DO THE WORK: Write/fill using drafted content only (the paper/essay body). ` +
    `Do not paste share/send instructions into the file.\n` +
    (shareSend
      ? `4) SHARE: Use the Share dialog to invite the email — never by typing the instruction into the doc.\n` +
        `5) REPORT: Only set done when write AND share are finished, OR you hit login/paywall — ` +
        `then name the blocker.\n`
      : `4) REPORT: Only set done when the ask is actually finished, OR you hit login/paywall/a missing control — ` +
        `then name the blocker and the next click for the user.\n`) +
    `Homepage / templates gallery / create hub alone is NEVER done.` +
    draftBit +
    shareBit
  ).slice(0, 4800);
}

/** True when the tab looks like a real working surface (editor), not home/templates listing. */
function venueLooksLikeWorkingSurface(venue, url) {
  const u = String(url || "");
  if (!venue || !u) return false;
  switch (venue.id) {
    case "canva":
      // In-editor design, not templates gallery / create hub / marketing.
      return /canva\.com\/design\//i.test(u);
    case "figma":
      return /figma\.com\/(file|design|proto|board)\//i.test(u);
    case "notion":
      return /notion\.(so|site)\/.+/i.test(u) && !/notion\.so\/?$/i.test(u);
    case "google-docs":
    case "google-sheets":
    case "google-slides":
    case "excel":
    case "powerpoint":
      return venueHasEditableSurface(venue, u);
    default:
      return venue.urlMatch.test(u) && !venueIsListingOrHome(venue, u);
  }
}

module.exports = {
  TOOL_VENUES,
  matchCreateInToolVenue,
  looksLikeCreateInToolVenueAsk,
  toolVenueExplicitlyNamed,
  looksLikeEditCurrentInToolAsk,
  shouldOpenFreshVenueFile,
  toolStartUrlIsSpecific,
  getToolVenueById,
  toolVenueFromUrl,
  extractToolCreateTopic,
  venueDeepLinkHost,
  buildToolDeepLinkSearchQuery,
  resolveToolCreateStartUrl,
  buildToolActAdaptiveGoal,
  stripShareSendTail,
  looksLikeShareSendTail,
  isComplexUiToolVenue,
  stripToolVenueForArtifactAsk,
  matchComplexSoftwareOffer,
  looksLikeWorkInsideComplexSoftware,
  looksLikeSoftwareMentionNotInsideAsk,
  buildComplexSoftwareOfferMessage,
  complexSoftwareChoiceButtons,
  COMPLEX_SOFTWARE_NAME_RE,
  venueLooksLikeWorkingSurface,
  venueNamedInText,
  venueMatchesLiveUrl,
  venueHasEditableSurface,
  venueIsListingOrHome,
  CREATE_VERB_RE,
};
