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

/* -------------------------------------------------------------------- */
/*  Shared turn-shape vocabulary                                         */
/*                                                                       */
/*  These used to live as inline literals in BOTH                        */
/*  src/lib/ai/artifactSendPlan.ts and server/ai/chatStream.routes.js,   */
/*  behind "keep in sync" comments — and had already drifted (the server */
/*  verb list had `dimmer`/`muted`, the client's didn't; the server's    */
/*  different-deliverable nouns had `deck|site|page`, the client's       */
/*  didn't). Both consumers now call these instead of carrying their own */
/*  copy. artifactBuildIntent.parity.test.mjs fails if the two physical  */
/*  homes ever diverge again.                                            */
/* -------------------------------------------------------------------- */

/** Add/fix/change verbs — the surface of a surgical tweak, not a rebuild. */
export const SURGICAL_TWEAK_VERB_RE =
  /\b(?:fix|change|update|tweak|adjust|add|make|rename|remove|delete|patch|bug|typo|font|colou?r|theme|move|replace|swap|hide|show|enable|disable|increase|decrease|darken|brighten|dim|dimmer|mute|muted|darker|lighter|brighter|edit|improve|polish|wire|connect|implement|insert|extend|expand|shorten|widen|narrow|resize|restyle|reword|rewrite|correct|repair)\b/i;

/** Length cap above which a message reads as a brief, not a tweak. */
export const SURGICAL_TWEAK_MAX_CHARS = 400;

/**
 * Raw "this looks like a small change" signal. Callers layer their own
 * negations on top (the client excludes redesign/new-deliverable asks, the
 * server also excludes regular-chat build asks) — those differ legitimately,
 * the vocabulary does not.
 */
export function isSurgicalTweakAsk(text: string): boolean {
  const t = String(text || '').trim();
  return t.length < SURGICAL_TWEAK_MAX_CHARS && SURGICAL_TWEAK_VERB_RE.test(t);
}

/** "build me a DIFFERENT app" — an explicit request for another deliverable. */
export const DIFFERENT_DELIVERABLE_RE =
  /\b(?:different|brand[- ]?new|entirely new|fresh|whole new|completely new)\s+(?:game|app|build|artifact|world|deck|site|page)\b/i;

export function isDifferentDeliverableAsk(text: string): boolean {
  return DIFFERENT_DELIVERABLE_RE.test(String(text || ''));
}

/** "like this" / "based on this" — the ask points at an attachment or screen. */
export const REFERENCE_PHRASE_RE =
  /\b(?:like this|like that|from this|based on this|from the (?:image|screenshot|picture|reference)|as shown|in the (?:image|screenshot|picture))\b/i;

export function isReferencePhraseAsk(text: string): boolean {
  return REFERENCE_PHRASE_RE.test(String(text || ''));
}

/** "exact clone" / "1:1" / "recreate" — a full rebuild against a reference. */
export const REFERENCE_REBUILD_RE =
  /\b(?:exact(?:ly)?\s+clone|identical|1\s*:\s*1|recreate|clone\s+(?:this|that|it)|(?:look|make)\s+(?:it\s+)?(?:just\s+)?like\s+this|full\s+rewrite)\b/i;

export function isReferenceRebuildAsk(text: string): boolean {
  return REFERENCE_REBUILD_RE.test(String(text || ''));
}

/** Font / colour / theme wording — allows signature churn on a refine. */
export const STYLE_CHANGE_RE =
  /\b(?:font|typeface|typography|colou?r|theme|accent|palette|recolou?r|background|neutral|gr[ae]yscale|monochrome|dark\s*mode|light\s*mode|darken|brighten|dim(?:mer)?|muted?|opacity|red|orange|yellow|green|blue|purple|pink|black|white|gray|grey|amber|mustard)\b/i;

export function isStyleChangeAsk(text: string): boolean {
  return STYLE_CHANGE_RE.test(String(text || ''));
}

/* ---- Fresh-webapp signals (client mirror of isFreshWebappBuildAsk) ---- */

export const MAKING_VERB_RE =
  /\b(?:make|build|create|generate|design|code|write|whip up|mock up|put together)\b/i;

export const WEBAPP_NOUN_RE =
  /\b(?:games?(?! ?plan)|apps?|web ?apps?|mini[- ]?apps?|sandbox(?:es)?|simulators?|minecraft|voxel|platformers?|shooters?|rpg|first[- ]?person|\b3d\b|three\.?js)\b/i;

export const COPY_OF_WEBAPP_RE =
  /\bcopy of\b[^.!?\n]{0,80}\b(?:minecraft|games?(?! ?plan)|apps?|sandbox(?:es)?|voxel|platformers?|world)\b/i;

export function isMakingVerbAsk(text: string): boolean {
  return MAKING_VERB_RE.test(String(text || ''));
}

export function mentionsWebappNoun(text: string): boolean {
  return WEBAPP_NOUN_RE.test(String(text || ''));
}

export function isCopyOfWebappAsk(text: string): boolean {
  return COPY_OF_WEBAPP_RE.test(String(text || ''));
}

/* ---- Studio sticky-mode turn shapes (Build / Imagine pages) ---- */

/** Opens with a question word — discussion, never an automatic build. */
export const DISCUSSION_QUESTION_RE =
  /^(?:what|why|how|when|where|who|which|should|would|could|can|is|are|do|does|did|has|have|tell\s+me|explain|describe|discuss|help\s+me\s+understand|give\s+me\s+advice|make\s+sense)\b/i;

export function isDiscussionQuestion(text: string): boolean {
  return DISCUSSION_QUESTION_RE.test(String(text || '').trim());
}

/** "can you make …" — phrased as a question but asking for the deliverable. */
export const DIRECT_CREATE_QUESTION_RE =
  /^(?:can|could|would|will)\s+(?:you|we)\s+(?:please\s+)?(?:make|build|create|generate|design|draw|add|apply|give|put|change|update|edit|fix|format|style|organize|reorder|group|align|center|bold|italicize|underline|highlight|adjust|tweak|dim|darken|brighten|remove|replace|redesign|rebuild|restyle|turn|set)\b/i;

export function isDirectCreateQuestion(text: string): boolean {
  return DIRECT_CREATE_QUESTION_RE.test(String(text || '').trim());
}

/** Bare imperative — "add a dark mode", "ok now make the header sticky". */
export const IMPERATIVE_MODE_ACTION_RE =
  /^(?:(?:ok|okay|now|then|also|please|and|let['’]s)\s*[,—-]?\s*)*(?:make|build|create|generate|design|draw|add|apply|give|put|change|update|edit|fix|format|style|organize|reorder|group|align|center|bold|italicize|underline|highlight|adjust|tweak|dim|darken|brighten|remove|replace|redesign|rebuild|restyle|turn|set|redo|reimagine|render)\b/i;

export function isImperativeModeAction(text: string): boolean {
  return IMPERATIVE_MODE_ACTION_RE.test(String(text || '').trim());
}

/**
 * Edits phrased as a desired end state rather than an imperative:
 * "every note should have a heading", "I want the sidebar darker".
 */
export const DESIRED_STATE_RE =
  /\b(?:should|needs? to|must)\s+(?:be|have|show|use|include|display|look|feel|read|say|contain)\b/i;

export const WANT_STATE_RE = /\b(?:i want|i need|i(?:'|’)d like|i would like)\b/i;

export function isDesiredStateAsk(text: string): boolean {
  const t = String(text || '').trim();
  return DESIRED_STATE_RE.test(t) || WANT_STATE_RE.test(t);
}

/** A bare noun brief — "a landing page", "dashboard", "pitch deck". */
export const BARE_BUILD_BRIEF_RE =
  /^(?:(?:an?|the|my|another|new)\s+)?(?:web ?app|web ?site|site|landing ?page|dashboard|app|game|tool|calculator|prototype|widget|quiz|tracker|form|simulator|pitch ?deck|slide ?deck|presentation|spread ?sheet|flow ?chart|diagram|chart|study ?guide|work ?sheet)\b/i;

export function isBareBuildBrief(text: string): boolean {
  return BARE_BUILD_BRIEF_RE.test(String(text || '').trim());
}

/** "same but darker", "another one", "try again" — refines a prior output. */
export const IMAGE_REFINEMENT_RE =
  /^(?:(?:ok|okay|now|then|also|and)\s*[,—-]?\s*)*(?:same\b|another\b|again\b|darker\b|lighter\b|brighter\b|more\b|less\b|try\b|redo\b)/i;

export function isImageRefinementAsk(text: string): boolean {
  return IMAGE_REFINEMENT_RE.test(String(text || '').trim());
}
