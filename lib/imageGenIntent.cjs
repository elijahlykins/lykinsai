'use strict';

/**
 * Typed image-generation intent (parity with "+" → Generate image).
 * Keep in sync with any mirrored checks in server.js / Agent Mode routing.
 */

const IMAGE_BUILD_VERB_RE =
  /\b(?:make|build|create|generate|design|draft|produce|prepare|compose|put together|whip up|mock up|draw up|draw|write|give|need|want|turn (?:this|that|it) into)\b(?:\s+(?:me|us))?\s+(?:a|an|the|some|my|another|one)\s+/i;

const ARTIFACT_ANALYSIS_LEAD_RE =
  /^(?:can you|could you|would you|please|hey|ok|okay|so|now|then|and)?[,\s]*(?:summari[sz]e|explain|describe|analy[sz]e|review|read|improve|fix|edit|update|revise|shorten|expand|lengthen|critique|proofread|rewrite|reword)\b/i;

/** Visual deliverables people commission without saying "image". */
const IMAGE_VISUAL_NOUN =
  String.raw`(?:images?|pictures?|photos?|photographs?|pics?|logos?|illustrations?|icons?|wallpapers?|art ?works?|drawings?|sketch(?:es)?|portraits?|avatars?|thumbnails?|stickers?|posters?|banners?|memes?|ads?|advertisements?|flyers?|creatives?|graphics?|visuals?|covers?|mock[- ]?ups?|collages?|composites?|packaging|product\s+shots?|hero(?:\s+images?)?|social\s+posts?|instagram\s+posts?|ig\s+posts?)`;

// MUST be bounded — bare `ads?` otherwise matches the "ad" inside "spreadsheet".
const IMAGE_INTENT_NOUN_RE = new RegExp(String.raw`\b(?:${IMAGE_VISUAL_NOUN})\b`, 'i');

/** Explicit non-image deliverables — never force image gen for these. */
const NON_IMAGE_DELIVERABLE_RE =
  /\b(?:spread\s*sheets?|excel|xlsx|csv|work\s*sheets?|documents?|\bdocs?\b|reports?|essays?|memos?|pitch\s*decks?|slide\s*decks?|slide\s*shows?|slides?|presentations?|dashboards?|web\s*apps?|landing\s*pages?|budget|estimate|estimation|cost\s*break\s*down|price\s*list)\b/i;

const IMAGE_RESTYLE_RE = new RegExp(
  String.raw`\b(?:make|turn|convert|transform|render|redraw|remake|redo|generate|create|draw|recreate|reimagine|restyle)\s+(?:this|that|it|him|her|them|me|us|my \w+|the \w+)\b[^.!?\n]{0,50}?\b(?:${IMAGE_VISUAL_NOUN}|paintings?|cartoons?|caricatures?|anime|ghibli|pixar|pixel ?art|watercolou?r|oil painting|line ?art|comic)`,
  'i',
);

const IMAGE_NOUN_LEAD_RE = new RegExp(
  String.raw`^(?:an?\s+|the\s+)?${IMAGE_VISUAL_NOUN}\s+(?:of|for|with|showing|depicting|like|similar to|based on|inspired by)\b`,
  'i',
);

const IMAGE_NOUN_REF_RE = new RegExp(
  String.raw`\b${IMAGE_VISUAL_NOUN}\s+(?:like|similar to|based on|inspired by|from|of)\s+(?:this|that|these|those|it)\b`,
  'i',
);

/** "make me an ad like this one" — visual noun + reference comparator. */
const IMAGE_MAKE_LIKE_RE = new RegExp(
  String.raw`\b(?:make|create|design|generate|draw|recreate|remake|mock\s*up|whip\s*up|produce|craft|do)\b(?:\s+(?:me|us))?(?:\s+(?:a|an|the|some|my|another|one))?\s+${IMAGE_VISUAL_NOUN}\b[\s\S]{0,80}\b(?:like|based on|inspired by|in the style of|same style as|matching|copy(?:ing)?)\s+(?:this|that|these|those|it)\b`,
  'i',
);

/**
 * Cropped/attached reference + recreate ask ("make me something like this").
 * Without an attachment, bare "like this" is too ambiguous for image force.
 */
function detectReferenceImageAsk(message, hasAttachedImage = false) {
  const t = String(message || '').trim();
  if (!t || t.length > 600) return false;
  if (ARTIFACT_ANALYSIS_LEAD_RE.test(t)) return false;

  // Works with or without an attachment — noun + "like this" is enough.
  if (IMAGE_MAKE_LIKE_RE.test(t)) return true;
  if (IMAGE_NOUN_REF_RE.test(t)) return true;

  if (!hasAttachedImage) return false;

  const makeVerb =
    /\b(?:make|create|design|generate|draw|recreate|remake|mock\s*up|whip\s*up|produce|craft|redo|reimagine)\b/i.test(
      t,
    );
  if (!makeVerb) return false;

  // Attached pixels + "like this / this style / same vibe" → generate a visual.
  if (
    /\b(?:like|based on|inspired by|in the style of|same (?:style|look|vibe|energy|feel) as|matching|copy(?:ing)?)\s+(?:this|that|these|those|it)\b/i.test(
      t,
    ) ||
    /\b(?:this|that)\s+(?:one|style|look|vibe|ad|poster|banner|image|picture|photo)\b/i.test(t) ||
    /\b(?:same|similar)\s+(?:style|look|vibe|layout|composition)\b/i.test(t)
  ) {
    return true;
  }

  // Attached image + commission a visual noun ("make me an ad", "design a poster").
  const m = IMAGE_BUILD_VERB_RE.exec(t);
  if (m) {
    const tail = t.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (IMAGE_INTENT_NOUN_RE.test(tail)) return true;
  }

  return false;
}

function detectImageIntent(message, opts = {}) {
  const t = String(message || '').trim();
  if (!t || t.length > 600) return false;
  if (ARTIFACT_ANALYSIS_LEAD_RE.test(t)) return false;
  // "make me a spreadsheet / budget / deck" must never become image gen.
  if (NON_IMAGE_DELIVERABLE_RE.test(t)) return false;
  if (IMAGE_NOUN_LEAD_RE.test(t)) return true;
  if (IMAGE_RESTYLE_RE.test(t)) return true;
  if (IMAGE_NOUN_REF_RE.test(t)) return true;
  if (IMAGE_MAKE_LIKE_RE.test(t)) return true;
  if (detectReferenceImageAsk(t, !!opts.hasAttachedImage)) return true;
  const m = IMAGE_BUILD_VERB_RE.exec(t);
  if (!m) return false;
  const tail = t.slice(m.index + m[0].length, m.index + m[0].length + 80);
  // Object of the verb must be the visual noun — not a later incidental match.
  return new RegExp(String.raw`^(?:an?\s+|the\s+|some\s+|my\s+)?${IMAGE_VISUAL_NOUN}\b`, 'i').test(
    tail,
  );
}

module.exports = {
  detectImageIntent,
  detectReferenceImageAsk,
  IMAGE_INTENT_NOUN_RE,
  IMAGE_RESTYLE_RE,
  IMAGE_NOUN_LEAD_RE,
  IMAGE_NOUN_REF_RE,
  IMAGE_MAKE_LIKE_RE,
  NON_IMAGE_DELIVERABLE_RE,
};
