/**
 * Cross-mode ask detection for the Studio's sticky mode pages (Build /
 * Imagine / Research). Each page force-routes every send down its own
 * pipeline, so a clearly out-of-lane ask ("generate an image of a dog" on
 * the Research page) must be caught BEFORE dispatch — otherwise the wrong
 * pipeline runs to completion (e.g. a full research report about a dog)
 * before the model can say anything. Phrase lists are trimmed-down mirrors
 * of lib/imageGenIntent.cjs and lib/artifactBuildIntent.cjs.
 */

export type StudioStickyMode = "build" | "imagine" | "research";

const COMMISSION_VERB_RE =
  /\b(?:make|build|create|generate|design|draft|produce|prepare|compose|put together|whip up|mock up|draw up|draw|give|need|want|do)\b(?:\s+(?:me|us))?\s+(?:a|an|the|some|my|another|one)\s+/gi;

const IMAGE_NOUN = String.raw`(?:images?|pictures?|photos?|photographs?|pics?|logos?|illustrations?|icons?|wallpapers?|art ?works?|drawings?|sketch(?:es)?|portraits?|avatars?|thumbnails?|stickers?|posters?|banners?|memes?|graphics?|visuals?|collages?)`;
const IMAGE_NOUN_RE = new RegExp(String.raw`^(?:${IMAGE_NOUN})\b`, "i");
/** "an image of a dog" / "picture of ..." with no commissioning verb. */
const IMAGE_NOUN_LEAD_RE = new RegExp(
  String.raw`\b${IMAGE_NOUN}\s+(?:of|for|with|showing|depicting)\b`,
  "i",
);

const BUILD_NOUN = String.raw`(?:web ?apps?|web ?sites?|sites?|landing ?pages?|dashboards?|apps?|mini[- ]?apps?|games?(?! ?plan)|tools?|calculators?|prototypes?|widgets?|quiz(?:zes)?|quiz|trackers?|forms?|simulators?|pitch ?decks?|slide ?decks?|slide ?shows?|slides?|presentations?|keynotes?|power ?points?|spread ?sheets?|flow ?charts?|diagrams?|charts?|study ?guides?|work ?sheets?|flash ?cards?|interactive\s+(?:page|app|tool|demo))`;
const BUILD_NOUN_RE = new RegExp(String.raw`^(?:${BUILD_NOUN})\b`, "i");
const BUILD_NOUN_ANYWHERE_RE = new RegExp(String.raw`\b${BUILD_NOUN}\b`, "i");

/**
 * Art verbs commission an image regardless of the object noun ("draw a cat").
 * "draw up" (documents) is excluded, and only indefinite articles count so
 * UI edits like "paint the header blue" never register.
 */
const ART_VERB_ASK_RE =
  /\b(?:draw|sketch|paint|illustrate)(?!\s+up)\b(?:\s+(?:me|us))?\s+(?:a|an|some)\s+/i;

const RESEARCH_NOUN = String.raw`(?:research ?(?:report|paper)s?|reports?|white ?papers?|deep ?dives?|literature ?reviews?|market ?(?:research|analysis)|competitive ?analysis)`;
const RESEARCH_NOUN_RE = new RegExp(String.raw`^(?:${RESEARCH_NOUN})\b`, "i");
const RESEARCH_PHRASE_RE =
  /\b(?:deep\s+research|research\s+(?:report|paper)|literature\s+review|market\s+research|research\s+(?:on|about|into)\s)\b/i;

/** True when a commissioning verb's direct object matches `nounRe`. */
function commissioned(text: string, nounRe: RegExp): boolean {
  const re = new RegExp(COMMISSION_VERB_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (nounRe.test(tail)) return true;
  }
  return false;
}

export function detectImageAsk(text: string): boolean {
  if (commissioned(text, IMAGE_NOUN_RE) || IMAGE_NOUN_LEAD_RE.test(text)) return true;
  return ART_VERB_ASK_RE.test(text) && !BUILD_NOUN_ANYWHERE_RE.test(text);
}

export function detectBuildAsk(text: string): boolean {
  return commissioned(text, BUILD_NOUN_RE);
}

export function detectResearchAsk(text: string): boolean {
  return commissioned(text, RESEARCH_NOUN_RE) || RESEARCH_PHRASE_RE.test(text);
}

/**
 * Given the active sticky mode and the typed message, decide whether the ask
 * clearly belongs to a DIFFERENT mode. Conservative by design: any in-lane
 * signal wins (no redirect), so ambiguous asks keep today's behavior.
 */
export function detectStudioModeRedirect(
  text: string,
  mode: StudioStickyMode,
): { target: StudioStickyMode; label: string } | null {
  const t = String(text || "").trim();
  if (!t || t.length > 600) return null;

  const wantsImage = detectImageAsk(t);
  const wantsBuild = detectBuildAsk(t);
  const wantsResearch = detectResearchAsk(t);

  if (mode === "imagine") {
    if (wantsImage) return null;
    if (wantsBuild) return { target: "build", label: "Build" };
    if (wantsResearch) return { target: "research", label: "Research" };
    return null;
  }
  if (mode === "research") {
    if (wantsResearch) return null;
    if (wantsImage) return { target: "imagine", label: "Imagine" };
    if (wantsBuild) return { target: "build", label: "Build" };
    return null;
  }
  // build — Build also produces documents/reports as artifacts, so only an
  // explicit research mention redirects out of it.
  if (wantsBuild) return null;
  if (wantsImage) return { target: "imagine", label: "Imagine" };
  if (/\bresearch\b/i.test(t) && wantsResearch) {
    return { target: "research", label: "Research" };
  }
  return null;
}
