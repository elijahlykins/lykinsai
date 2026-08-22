/**
 * Where a piece of work belongs, without knowing anything about the product.
 *
 * The agent used to carry a table of apps — Google Sheets, Docs, Slides,
 * PowerPoint, Canva, Figma, Notion — each with its own create URL, its own way
 * of recognising itself in a sentence, and its own strategy for getting content
 * onto the page. That works for eight products and no others: a user asking for
 * something in Linear, Coda, Airtable or their company's internal tool fell off
 * the end of the table and got nothing, and every new product meant new code.
 *
 * There is nothing about "create a document and write in it" that needs to know
 * which product it is. The agent can find an app it has been named, make a new
 * file the way that app makes files, and put text into an editor — those are
 * things it works out by looking, and what it learns is kept per site in its
 * own memory rather than hardcoded here.
 *
 * So all that survives is: what did the user call the place, and what shape
 * should the content take when it gets there.
 */

/**
 * Words that follow "in"/"on"/"to" without naming a place to work.
 *
 * Deliberately grammatical rather than a list of products: these are the
 * sentence patterns that would otherwise read as a destination, and they stay
 * the same however many apps exist.
 */
const NOT_A_DESTINATION = new Set([
  "a", "an", "the", "this", "that", "these", "those", "it", "them", "there", "here",
  "my", "our", "your", "his", "her", "their", "its",
  "and", "or", "but", "then", "so", "for", "with", "about", "into", "onto",
  "detail", "details", "depth", "full", "short", "brief", "summary", "order",
  "place", "case", "fact", "general", "particular", "advance", "time", "person",
  "mind", "line", "lines", "words", "bullet", "bullets", "point", "points",
  "front", "back", "half", "part", "parts", "total", "addition", "return",
  "english", "spanish", "french", "german", "chinese", "japanese",
  "me", "us", "him", "them", "myself", "everything", "something", "anything",
  // A pronoun starts the next clause: "in my google drive I have a folder…".
  "i", "we", "he", "she", "they", "who", "what", "which", "where", "when",
  "morning", "afternoon", "evening", "week", "month", "year", "day", "days",
  // "in the world today", "in the future", "in the meantime" — "the" followed
  // by one of these is a figure of speech, never a place to do work.
  "world", "future", "past", "meantime", "interim", "moment", "works",
  "process", "end", "beginning", "middle", "today", "tomorrow", "yesterday",
  // "go through my inbox", "go ahead", "go back" — a particle, not a place.
  "through", "ahead", "back", "over", "around", "again", "away", "down", "up",
]);

/** A destination named as an address rather than a product name. */
const URLISH_RE = /\b((?:[\w-]+\.)+(?:com|org|net|io|app|dev|co|ai|so|site|cloud|sh))\b/i;

/**
 * What the user called the place this work belongs.
 *
 * Returns the words they used — "notion", "google sheets", "our wiki",
 * "linear" — with no attempt to map them onto a product we know. The agent
 * finds the place from the name, the same way a person would.
 *
 * @returns {string} the destination as the user said it, or "" when the ask
 *   names none (in which case the work belongs wherever they already are).
 */
function destinationFromAsk(text) {
  // An email address carries a domain that is not a destination: "send it to
  // sam@example.com" is about a person, not about example.com.
  const raw = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, " ")
    .trim();
  if (!raw) return "";
  const url = URLISH_RE.exec(raw);
  if (url) return url[1].toLowerCase();
  // "in Notion", "on Linear", "using Airtable". A name is the CONTIGUOUS run of
  // words after the preposition — "in powerpoint about Q3" names powerpoint,
  // and the run ends at "about". Each preposition is examined in turn, because
  // the first one in a sentence is usually part of the instruction rather than
  // the destination ("I need you to write out in notion…").
  const words = raw.split(/\s+/);
  // "in"/"into"/"using" point at a place. "on" and "to" mostly do not — "a
  // report ON climate change", "write TO sam" — so "on" is accepted only for a
  // one-word name and never straight after a word naming a piece of content,
  // and "to" is left out entirely.
  const PREPOSITION = /^(?:in|into|onto|using|via)$/i;
  const WEAK_PREPOSITION = /^on$/i;
  // "go to Notion and…", "open Airtable" — a movement verb names a place as
  // plainly as "in" does, and "to" is only safe to read that way right after
  // one of these. These words have other lives, though — "the top OPEN source
  // models", "I don't want to GO over 5 grand" — so they only count as an
  // instruction where an instruction can begin.
  const GOES_TO = /^(?:go|goto|head|navigate|open|launch|visit|pull|bring|load|jump|switch|hop)$/i;
  const STARTS_A_CLAUSE = /^(?:and|then|also|now|first|next|please|you|,|-)$/i;
  // Nouns for the thing being written. What follows them is its subject.
  const CONTENT_NOUN =
    /^(?:report|reports|article|articles|essay|essays|post|posts|piece|pieces|deck|decks|doc|docs|document|documents|summary|analysis|brief|briefs|note|notes|page|pages|thread|paper|papers|story|stories|blog|memo|memos|section|chapter|book|guide|overview|outline|plan|plans)$/i;
  // Words that end a name: they belong to the sentence, not to the product.
  // Two kinds — the verb that says what to do once we are there, and the noun
  // that says what to make. Either way the name stopped at the word before.
  const ENDS_NAME = new RegExp(
    "^(?:" +
      // what to do
      "write|writing|create|creating|make|making|draft|drafting|put|putting|" +
      "add|adding|replicate|duplicate|copy|clone|build|building|set|start|" +
      "send|sending|schedule|publish|post|share|find|check|update|edit|" +
      "review|fill|search|look|get|pull|reply|open|delete|remove|rename|" +
      "download|upload|export|import|change|move|" +
      // what to make
      "about|for|and|or|then|page|doc|document|file|sheet|spreadsheet|deck|" +
      "slides?|note|notes|list|table|campaign|email|message|post|report" +
      ")$",
    "i",
  );
  // Keep the dots inside "notion.so" but drop the one that ends a sentence.
  const clean = (w) =>
    w.toLowerCase().replace(/[^\w'&.-]/g, "").replace(/[.,-]+$/, "");
  for (let i = 0; i < words.length - 1; i += 1) {
    const prep = clean(words[i]);
    const weak = WEAK_PREPOSITION.test(prep);
    // "go to X" / "open X": the verb itself introduces the place.
    const opensClause = (k) =>
      k === 0 ||
      STARTS_A_CLAUSE.test(clean(words[k - 1] || "")) ||
      /[,;.:]$/.test(words[k - 1] || "");
    const movement =
      (GOES_TO.test(prep) && opensClause(i)) ||
      (prep === "to" && GOES_TO.test(clean(words[i - 1] || "")) && opensClause(i - 1));
    if (!PREPOSITION.test(prep) && !weak && !movement) continue;
    // "…report on climate change" is a subject, not a destination.
    if (weak && CONTENT_NOUN.test(clean(words[i - 1] || ""))) continue;
    const run = [];
    // "in our team wiki" — a possessive introduces the name rather than ending
    // it, so step over one before reading the run. A bare article does NOT get
    // the same treatment: "in the snow", "in the world today", "in the
    // meantime" are far more common than "in the <product>", and reading them
    // as places is how an image prompt ends up being filed in an app.
    let start = i + 1;
    // "open UP mail chimp", "pull UP notion" — the particle belongs to the
    // verb, not to the name that follows it.
    if (movement && /^(?:to|up)$/i.test(clean(words[start] || ""))) start += 1;
    if (/^(?:my|our|your|their)$/i.test(clean(words[start] || ""))) start += 1;
    for (let j = start; j < words.length && run.length < 3; j += 1) {
      const w = clean(words[j]);
      if (!w || NOT_A_DESTINATION.has(w) || ENDS_NAME.test(w)) break;
      run.push(w);
    }
    // A weak preposition only ever introduces a single-word name.
    if (weak && run.length > 1) continue;
    const name = run.join(" ").trim();
    // "in 2026", "in 3 days" — a number is a when, not a where.
    if (!name || /^[\d.,/-]+$/.test(name)) continue;
    if (name.length <= 40) return name;
  }
  return "";
}

/**
 * Is this URL a place you START work, rather than a file you are already in?
 *
 * An app's home or file list is a launcher: standing there and saying "create
 * a budget" means create it here. A URL that points at one particular document
 * is not — someone inside a deck who says "build me a slide deck on material
 * science, 11 slides, neutral colours" is commissioning a new thing, not asking
 * for that file to be overwritten.
 *
 * Told apart by shape, not by product: a link to a specific file carries an
 * opaque id, and usually an /edit or /d/ segment with it.
 */
/**
 * A page you pass through rather than work in: a search engine, a blank tab.
 *
 * Matched on the host and its search path, not on the word "google" anywhere in
 * the URL — docs.google.com is somewhere you work, google.com/search is not.
 */
function isPassThroughPage(url) {
  const raw = String(url || "").trim();
  if (!raw || /^(?:about:|chrome:|edge:|data:)/i.test(raw)) return true;
  let host = "";
  let path = "";
  try {
    const u = new URL(raw);
    host = (u.hostname || "").replace(/^www\./i, "");
    path = u.pathname || "/";
  } catch {
    return true;
  }
  if (!/^(?:google|bing|duckduckgo|search\.brave|ecosia|startpage)\.[a-z.]+$/i.test(host)) {
    return false;
  }
  return path === "/" || /^\/(?:search|imghp|maps)?\/?$/i.test(path);
}

function standingInAppHome(url) {
  const raw = String(url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  let path = "";
  try {
    const u = new URL(raw);
    path = u.pathname || "";
    if (u.search && /[?&](?:id|doc|file|key)=/i.test(u.search)) return false;
  } catch {
    return false;
  }
  if (/\/(?:d|edit|view|preview|file|document)(?:\/|$)/i.test(path)) return false;
  // An opaque id — a long segment mixing cases, digits or dashes — names one
  // particular thing.
  return !path
    .split("/")
    .some((seg) => seg.length >= 12 && /\d|[A-Z]/.test(seg) && /[a-z]/i.test(seg));
}

/** Does this ask want something CREATED or WRITTEN somewhere? */
function asksToCreateSomething(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  return (
    /\b(write|draft|create|make|build|put together|add|start|set up|fill|type|compose|outline|list out|jot|replicate|duplicate|clone|schedule|publish|post|rename|sketch|mock\s*up|wireframe|lay\s*out|assemble|prepare|put|save|paste|drop|file|record|enter|log)\b/.test(
      t,
    ) ||
    // "design" is a noun as often as a verb — "UI design ideas" is browsing,
    // "design me a login screen" is work. Only the verb reading counts, and
    // what marks it is an article or a pronoun straight after.
    /\bdesign(?:\s+(?:me|us))?\s+(?:a|an|the|my|our|some|this)\b/.test(t)
  );
}

/**
 * The work is a document in some app, and the user said which.
 *
 * This is the whole trigger that used to require a product table: they asked
 * for something to be written, and they named where.
 */
function looksLikeWorkInNamedApp(text) {
  return !!destinationFromAsk(text) && asksToCreateSomething(text);
}

/**
 * The ask is to START something, not to act on what is already there.
 *
 * Narrower than {@link asksToCreateSomething} on purpose. "Add this to my
 * list", "post it", "schedule that" are all creation of a kind, but they are
 * things you do while browsing; only the verbs below mean a new piece of work
 * that needs somewhere to live.
 */
function asksToStartSomethingNew(text) {
  return /\b(create|make|write|draft|build|start|compose|put\s+together|set\s+up)\b/i.test(
    String(text || ""),
  );
}

/**
 * The work belongs in an app — said in words, or said by standing there.
 *
 * The full test the runtime asks at a call site that knows the open tab. A
 * destination can be named ("in Notion") or implied by having the app's own
 * home or file list on screen; either way the answer is the same, and neither
 * needs to know which product it is.
 */
function looksLikeWorkInApp(text, opts = {}) {
  if (looksLikeWorkInNamedApp(text)) return true;
  const live = String(opts.liveUrl || "").trim();
  if (!live || !standingInAppHome(live) || isPassThroughPage(live)) return false;
  return asksToCreateSomething(text) && !looksLikeEditCurrentInToolAsk(text, opts);
}

/**
 * What shape the content should take when it lands.
 *
 * Not a per-product strategy — a description of the destination, handed to the
 * model so it can decide. A spreadsheet wants rows, a slide deck wants an
 * outline, a document wants prose, and a model reading "google sheets" knows
 * that as well as any table we could maintain.
 */
function buildContentDraftPrompt({ ask, destination }) {
  const where = String(destination || "").trim();
  return [
    `The user wants this written${where ? ` in ${where}` : ""}, and it will be pasted straight into the editor there.`,
    "",
    "Return ONLY the content itself — no preamble, no commentary, no code fences.",
    "Match the shape of the destination:",
    "- a spreadsheet or table tool: tab-separated rows, a header row first",
    "- a slide tool: one line per slide, title then indented bullets",
    "- anything else: plain prose (light markdown is fine), the first line a short title, then a blank line, then the body",
    "",
    `User ask:\n${String(ask || "").trim()}`,
  ].join("\n");
}

/**
 * The goal handed to the agent loop.
 *
 * Says what to achieve and where, and nothing about how: no create URL, no
 * menu path, no per-product steps. The agent finds the app, makes a new file
 * the way that app makes one, and puts the content in — reading the page and
 * remembering what it learns for next time.
 */
function buildAppWorkGoal({ ask, destination, draft = "" }) {
  const where = String(destination || "").trim();
  const body = String(draft || "").trim();
  return [
    `Carry out the user's ask${where ? `, with the finished work in ${where}` : ""}.`,
    "",
    `User ask: ${String(ask || "").trim()}`,
    "",
    "How to get there:",
    where
      ? `- If the browser is not already in ${where}, go there. Navigate straight to it if you know the address; otherwise search for it and follow the result.`
      : "- Work in the app that is already open.",
    "- If the task needs a new document, page, sheet or file, create one the way this app creates them — its own New / Create / + control, or the keyboard shortcut it advertises.",
    "- Make sure you are on an editable surface before writing. A list, a dashboard or a template gallery is not one.",
    body
      ? "- The content is below. Put ALL of it in with one `paste_text` — do not retype it, and do not go hunting for the writing area first; the paste finds the editor itself."
      : "- Write the content the ask calls for.",
    "- Read the page back afterwards. The content should be there.",
    body ? `\nCONTENT TO PLACE:\n${body.slice(0, 12000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * User wants to change the open file/tab — not start a brand-new one.
 * "add a column", "edit this budget", "organize the sheet", "fix this doc".
 * With liveUrl on a page that is one particular document, also catches bare
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
  // "Already in an editable file" told apart by the shape of the URL rather
  // than by recognising the product: a link to one particular document is a
  // thing you can edit, a launcher or file list is not.
  if (live && !standingInAppHome(live)) {
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

module.exports = {
  destinationFromAsk,
  standingInAppHome,
  isPassThroughPage,
  asksToStartSomethingNew,
  looksLikeEditCurrentInToolAsk,
  asksToCreateSomething,
  looksLikeWorkInNamedApp,
  looksLikeWorkInApp,
  buildContentDraftPrompt,
  buildAppWorkGoal,
};
