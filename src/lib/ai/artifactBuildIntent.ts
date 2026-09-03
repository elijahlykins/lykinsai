/**
 * Mirrored from lib/artifactBuildIntent.cjs — keep phrase lists in sync.
 * Client send path uses these so an open panel cannot swallow a typed new build.
 */

export const REDESIGN_INTENT_RE =
  /\b(?:redesign|restyle|rebrand|rebuild|overhaul|from scratch|start over|new look|new theme|new palette|rewrite (?:the )?(?:whole|entire|all)|full\s+rewrite|exact(?:ly)?\s+clone|identical(?:\s+look)?|clone\s+(?:this|that|it)|full\s+(?:palette|colou?r)\s+(?:swap|restyle|rewrite)|palette\s+swap|swap\s+(?:the\s+)?palette)\b/i;

/** Whole-UI palette / monochrome asks — full theme rewrite, not surgical refine. */
export const PALETTE_OVERHAUL_INTENT_RE =
  /\b(?:all\s+neutral|neutral\s+(?:colou?rs?|palette|theme|tones?|look)|neutral[- ]colou?red|gr[ae]yscale|monochrome|black\s*(?:and|&)\s*white|desaturat(?:e|ed)|no\s+colou?rs?|remove\s+(?:the\s+)?colou?rs?|everything\s+(?:gray|grey|neutral)|(?:gray|grey|neutral)\s+only|make\s+(?:it|this|that|everything)\s+(?:all\s+)?(?:neutral|gr[ae]yscale|monochrome|gray|grey)|(?:all|entire|whole)\s+(?:neutral|gr[ae]yscale|monochrome))\b/i;

export const VISUAL_OVERHAUL_INTENT_RE =
  /\b(?:look(?:s)?\s+(?:just\s+)?like|make\s+(?:it|this|that)\s+look\s+like|just\s+like\s+the\s+actual|in\s+the\s+style\s+of|same\s+(?:look|style|art)\s+as|match(?:es)?\s+the\s+(?:look|style|art)|(?:art|visual|graphic)\s+style|hand[- ]?painted\s+(?:look|style|hills?)|thick\s+outlines|chunky\s+(?:cartoon|knights?)|comic\s+ui|follow(?:ing)?\s+this\s+style|like\s+this\s+style|in\s+this\s+style|match(?:es)?\s+this\s+style|same\s+style\s+as|style\s+here|this\s+(?:exact\s+)?style|based\s+on\s+this\s+style)\b/i;

export const INSIST_FRESH_BUILD_RE =
  /\b(?:you\s+didn'?t\s+build|did\s+not\s+build|nothing\s+(?:was\s+)?built|never\s+built|actually\s+build|build\s+it\s+(?:this\s+time|for\s+real|now|please)|still\s+nothing|no(?:thing)?\s+(?:in\s+)?(?:the\s+)?(?:panel|side\s*panel)|where(?:'?s|\s+is)\s+(?:the\s+|my\s+)?(?:deck|build|artifact|slides?))\b/i;

const TYPED_BUILD_VERB_RE =
  /\b(?:make|build|create|generate|design|draft|produce|prepare|compose|put together|whip up|mock up|draw up|draw|write|give|need|want|turn (?:this|that|it) into)\b(?:\s+(?:me|us))?\s+(?:a|an|the|some|my|another|one)\s+/i;

const TYPED_BUILD_NOUN_RE =
  /\b(?:pitch\s?deck|slide\s?deck|slide\s?show|slides?|presentation|keynote|power\s?point|ppt|study\s?guide|work\s?sheet|flash\s?cards?|spread\s?sheet|documents?|\bdocs?\b|report|essay|memo|white\s?paper|web\s?apps?|web\s?sites?|landing\s?pages?|dashboards?|games?(?! ?plan)|apps?|mini[- ]?apps?|prototypes?|flow\s?charts?|diagrams?|charts?|calculators?|quizzes?|quiz|trackers?|forms?|widgets?|portals?|simulators?|interactive\s+(?:page|app|tool|demo|artifact)|(?:ui|interface)|tools?(?!\s+for\s+(?:thinking|me\b))|mp4|videos?(?! ?game))\b/i;

/**
 * The same commissioning verbs, but restricted to INDEFINITE articles.
 * "make me a quiz app" commissions something new; "make the app darker" /
 * "update my app" names a build that already exists. With an artifact open
 * for editing, only the indefinite phrasing may start a fresh build.
 */
const TYPED_BUILD_VERB_INDEFINITE_RE =
  /\b(?:make|build|create|generate|design|draft|produce|prepare|compose|put together|whip up|mock up|draw up|draw|write|give|need|want|turn (?:this|that|it) into)\b(?:\s+(?:me|us))?\s+(?:a|an|some|another|one)\s+/i;

/**
 * Definite reference to the build already open / attached for editing —
 * "the app", "this game", "my site". Such asks mutate THAT build; on their
 * own they never commission a new one.
 */
const OPEN_ARTIFACT_REFERENCE_RE =
  /\b(?:the|this|that|my|our|its)\s+(?:current\s+|existing\s+|whole\s+|entire\s+)?(?:apps?|applications?|games?(?! ?plan)|web\s?apps?|web\s?sites?|sites?|pages?|dashboards?|tools?|ui|builds?|artifacts?|projects?)\b/i;

/**
 * Explicitly commissioning ANOTHER app-like deliverable while one is open —
 * the only wording that turns an installed-app edit chat into a fresh build.
 * The lookahead keeps "new app icon" / "new game mode" as edits.
 */
const EXPLICIT_NEW_APP_RE =
  /\b(?:an?other|different|separate|second|extra|additional|brand[- ]?new|entirely\s+new|whole\s+new|completely\s+new|new)\s+(?:apps?|applications?|games?(?! ?plan)|web\s?apps?|web\s?sites?|sites?|projects?)\b(?!\s*(?:icons?|names?|titles?|logos?|store|modes?|ids?)\b)/i;

export function isOpenArtifactReferenceAsk(text: string): boolean {
  return OPEN_ARTIFACT_REFERENCE_RE.test(String(text || ""));
}

export function isExplicitNewAppAsk(text: string): boolean {
  return EXPLICIT_NEW_APP_RE.test(String(text || ""));
}

const BRAINSTORM_LEAD_RE =
  /^(?:(?:ok|okay|so|now|hey|also)[,\s]+)*(?:we(?:'re| are)|i(?:'m| am)|just)\s+(?:also\s+)?(?:thinking|brainstorming|considering|exploring|talking|discussing)\b/i;

const WORKFLOW_BRAINSTORM_RE =
  /\b(?:working like|treat(?:ing)? each|multiple tabs|parallel|cowork|command center|orchestrat|this incorporates|product (?:idea|vision|concept)|what if we|imagine (?:if|we)|the idea (?:is|would)|basically i can)\b/i;

const EXAMPLE_BUILD_PREFIX_RE =
  /\b(?:something like|stuff like|things like|for example|e\.g\.|eg\.|such as|say|or whatever|like)\s+$/i;

const ARTIFACT_KIND_SIGNAL_RES = [
  /\b(?:pitch\s?deck|slide\s?deck|slide\s?show|presentation|keynote|power\s?point|\bppt\b)\b/i,
  /\b(?:landing\s?pages?|web\s?sites?|web\s?apps?|dashboards?|mini[- ]?apps?)\b/i,
  /\b(?:spread\s?sheet|excel|xlsx)\b/i,
  /\b(?:study\s?guide|work\s?sheet|flash\s?cards?)\b/i,
  /\b(?:flow\s?charts?|diagrams?|mind\s?maps?)\b/i,
  /\b(?:games?(?! ?plan)|minecraft|simulators?)\b/i,
  /\b(?:documents?|\breports?\b|white\s?papers?|essays?)\b/i,
];

function countArtifactKindSignals(text: string): number {
  const t = String(text || "");
  let n = 0;
  for (const re of ARTIFACT_KIND_SIGNAL_RES) {
    if (re.test(t)) n += 1;
  }
  return n;
}

export function isHypotheticalOrBrainstormBuildMention(text: string): boolean {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const t = raw.length > 900 ? raw.slice(0, 900) : raw;

  if (BRAINSTORM_LEAD_RE.test(t)) return true;
  if (WORKFLOW_BRAINSTORM_RE.test(t) && countArtifactKindSignals(t) >= 2) return true;
  if (WORKFLOW_BRAINSTORM_RE.test(t) && TYPED_BUILD_VERB_RE.test(t)) return true;

  const verbRe = new RegExp(TYPED_BUILD_VERB_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = verbRe.exec(t)) !== null) {
    const before = t.slice(Math.max(0, m.index - 48), m.index);
    if (EXAMPLE_BUILD_PREFIX_RE.test(before)) return true;
  }

  if (
    /\b(?:another tab|one tab|each tab|multiple tabs|in parallel)\b/i.test(t) &&
    countArtifactKindSignals(t) >= 2
  ) {
    return true;
  }

  return false;
}

export function isRedesignAsk(text: string): boolean {
  const t = String(text || "");
  return (
    REDESIGN_INTENT_RE.test(t) ||
    PALETTE_OVERHAUL_INTENT_RE.test(t) ||
    VISUAL_OVERHAUL_INTENT_RE.test(t)
  );
}

export function isInsistFreshBuildAsk(text: string): boolean {
  return INSIST_FRESH_BUILD_RE.test(String(text || ""));
}

const VAGUE_BUILD_OBJECT_RE =
  /\b(?:something|anything|whatever|stuff|a thing|some stuff|a surprise|anything you want|whatever you want)\b/i;

const BARE_BUILD_RE =
  /^(?:(?:hey|hi|ok(?:ay)?|please|so|um+|uh)\s+)*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:just\s+)?(?:build|make|create|whip up|put together)(?:\s+(?:me|us))?(?:\s+(?:something|anything|whatever))?[.!?…]*$/i;

/** "Build me something" — they asked to build, but not what. Ask first. */
export function isVagueBuildAsk(text: string): boolean {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return false;
  if (raw.length > 240) return false;
  if (TYPED_BUILD_NOUN_RE.test(raw)) return false;
  if (isHypotheticalOrBrainstormBuildMention(raw)) return false;
  if (
    /\b(?:something|anything|whatever)\s+(?:for|about|on)\s+(?:(?:my|our|the|a|an|this|that)\s+)?[a-z][a-z0-9-]{2,}/i.test(
      raw,
    )
  ) {
    return false;
  }
  if (/^surprise me[.!?…]*$/i.test(raw)) return true;
  if (BARE_BUILD_RE.test(raw)) return true;
  return (
    /\b(?:build|make|create|whip up|put together|design)\b/i.test(raw) &&
    VAGUE_BUILD_OBJECT_RE.test(raw)
  );
}

/**
 * opts.excludeDefiniteReferences: with an artifact open for editing in the
 * same chat, definite-article asks ("make the app darker", "update my game")
 * refer to THAT build and are edits — only indefinite phrasing ("build me a
 * quiz app") still commissions something new.
 */
export function isTypedNewDeliverableAsk(
  text: string,
  opts: { excludeDefiniteReferences?: boolean } = {},
): boolean {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (isHypotheticalOrBrainstormBuildMention(raw)) return false;
  const t = raw.length > 600 ? raw.slice(0, 600) : raw;
  // Looking / searching on a visual site is browse, not Create.
  if (
    /\b(?:look(?:ing)?\s+at|look(?:ing)?\s+for|search(?:ing)?|find(?:ing)?|browse|check\s+out|show(?:ing)?(?:\s+me)?)\b[\s\S]{0,120}\b(?:on\s+)?(?:pinterest|dribbble|behance)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  const verbSource = opts.excludeDefiniteReferences
    ? TYPED_BUILD_VERB_INDEFINITE_RE.source
    : TYPED_BUILD_VERB_RE.source;
  const verbRe = new RegExp(verbSource, "gi");
  let m: RegExpExecArray | null;
  while ((m = verbRe.exec(t)) !== null) {
    // Noun should sit in the commissioning clause, not later in the paragraph.
    const window = t.slice(m.index, Math.min(t.length, m.index + m[0].length + 72));
    if (TYPED_BUILD_NOUN_RE.test(window)) return true;
  }
  return false;
}
