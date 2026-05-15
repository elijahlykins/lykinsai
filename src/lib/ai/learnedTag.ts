/**
 * Shared <learned> / <updated> tag helpers used by every authenticated
 * chat surface (OmniaFocusedChat + OmniaSideRail via chatSendOrchestrator
 * and ProjectPlaceholder).
 *
 * Two paths are supported and the surfaces should call them in this order:
 *
 *   1. PRIMARY — `parseLearnedTag(rawReply)` → if it returns a tag, the
 *      chat model emitted it. Strip the tag from the visible reply with
 *      `stripLearnedTagsFromFinal`, then call `postLearnedFact()` to mint
 *      / update the neuron. Patch the returned fact onto the chat message
 *      as `factNeuron` so the pill renders.
 *
 *   2. FALLBACK — if `parseLearnedTag` returned null, the chat model
 *      forgot to tag. Call `postAutoLearnedFact()` with the user message
 *      (and optionally the assistant reply) and the server's classifier
 *      will decide whether to mint a neuron anyway. Same `factNeuron`
 *      shape comes back.
 *
 * Both paths are intentionally fire-and-forget from the surface's POV —
 * a network failure, classifier miss, or "nothing personal" verdict must
 * never break the chat bubble from rendering.
 */

const LEARNED_TAG_KIND_FALLBACK = "identity";
const ALLOWED_FACT_KINDS = new Set([
  "identity",
  "focus",
  "theme",
  "goal",
  "preference",
  "style",
  "constraint",
  "relationship",
]);

export type FactNeuron = {
  id: string | null;
  text: string;
  kind: string;
  reason: string | null;
  isNew: boolean;
  isUpdate: boolean;
  previousText: string | null;
};

export type ParsedLearnedTag =
  | { mode: "create"; text: string; kind: string; reason: string | null }
  | {
      mode: "update";
      text: string;
      kind: string;
      reason: string | null;
      previousText: string;
    };

/**
 * Hide everything from the first `<learned` token onward so the user never
 * sees the hidden tag pair flicker into the visible reply while it streams.
 * Tolerates both `<learned>` and `<learned kind="...">`. Also catches the
 * partial trailing prefix the model may have only just begun typing
 * (e.g. "...end. <le", "<lea", "<lear", "<learn", "<learne") so those
 * stray characters don't flash on screen for a frame before the closing
 * angle bracket arrives in the next stream chunk.
 */
export function stripLearnedTagFromStream(text: string): string {
  const learnedIdx = text.indexOf("<learned");
  const updatedIdx = text.indexOf("<updated");
  let cutIdx = -1;
  if (learnedIdx !== -1 && updatedIdx !== -1)
    cutIdx = Math.min(learnedIdx, updatedIdx);
  else if (learnedIdx !== -1) cutIdx = learnedIdx;
  else if (updatedIdx !== -1) cutIdx = updatedIdx;
  if (cutIdx !== -1) return text.slice(0, cutIdx).trimEnd();

  const partial = text.match(
    /(?:<l(?:e(?:a(?:r(?:n(?:e)?)?)?)?)?|<u(?:p(?:d(?:a(?:t(?:e)?)?)?)?)?)$/,
  );
  if (partial && partial.index !== undefined) {
    return text.slice(0, partial.index).trimEnd();
  }
  return text;
}

function extractReasonSentence(rawReply: string): string | null {
  const reasonMatch = rawReply.match(/<reason>\s*([\s\S]+?)\s*<\/reason>/i);
  if (!reasonMatch) return null;
  return (
    reasonMatch[1]
      .trim()
      .replace(/^["'`]|["'`]$/g, "")
      .slice(0, 240) || null
  );
}

/**
 * Pull the noun phrase, kind attribute, optional `old="..."` attribute (for
 * updates), and reason sentence out of a completed reply. Returns null when
 * no tag was emitted (which is the common case — most chat turns are not
 * personal disclosures, and the auto-classifier fallback handles the rest).
 *
 * Returns `mode: "create"` for plain <learned> tags and `mode: "update"`
 * (with `previousText`) for <updated old="..."> tags. The server uses
 * `previousText` to find and rewrite the matching existing neuron in place.
 */
export function parseLearnedTag(rawReply: string): ParsedLearnedTag | null {
  const updatedMatch = rawReply.match(
    /<updated\b([^>]*)>\s*([\s\S]+?)\s*<\/updated>/i,
  );
  if (updatedMatch) {
    const attrs = updatedMatch[1] || "";
    const oldAttr = attrs.match(/\bold\s*=\s*["']([^"']+)["']/i);
    const kindAttr = attrs.match(/\bkind\s*=\s*["']([^"']+)["']/i);
    const previousText = oldAttr ? oldAttr[1].trim().slice(0, 240) : "";
    if (previousText) {
      const rawKind = (kindAttr?.[1] || "").trim().toLowerCase();
      const kind = ALLOWED_FACT_KINDS.has(rawKind)
        ? rawKind
        : LEARNED_TAG_KIND_FALLBACK;
      const phrase = (updatedMatch[2] || "")
        .trim()
        .replace(/^["'`]|["'`]$/g, "")
        .replace(/[.!?]$/, "")
        .slice(0, 90);
      if (phrase) {
        const reason = extractReasonSentence(rawReply);
        return { mode: "update", text: phrase, kind, reason, previousText };
      }
    }
  }

  const learnedMatch = rawReply.match(
    /<learned(?:\s+kind\s*=\s*["']([^"']+)["'])?\s*>\s*([\s\S]+?)\s*<\/learned>/i,
  );
  if (!learnedMatch) return null;
  const rawKind = (learnedMatch[1] || "").trim().toLowerCase();
  const kind = ALLOWED_FACT_KINDS.has(rawKind)
    ? rawKind
    : LEARNED_TAG_KIND_FALLBACK;
  const phrase = (learnedMatch[2] || "")
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/[.!?]$/, "")
    .slice(0, 90);
  if (!phrase) return null;

  const reason = extractReasonSentence(rawReply);
  return { mode: "create", text: phrase, kind, reason };
}

/**
 * Once the stream is done, strip the entire tag region (both <learned> /
 * <updated> and <reason>) from the final text the chat shows. Idempotent —
 * safe to call even when no tag was emitted.
 */
export function stripLearnedTagsFromFinal(text: string): string {
  return text
    .replace(/<learned\b[^>]*>[\s\S]*?<\/learned>/gi, "")
    .replace(/<updated\b[^>]*>[\s\S]*?<\/updated>/gi, "")
    .replace(/<reason>[\s\S]*?<\/reason>/gi, "")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

/**
 * Strip a self-emitted "_…response truncated. Ask 'continue' for the rest._"
 * style note from the END of the visible reply. Some models add a meta
 * "to be continued" indicator even though the system prompt forbids it
 * (they were trained on transcripts that do this). This helper rips it
 * back out so the chat bubble never shows the user a "type continue"
 * prompt.
 *
 * What gets stripped (case-insensitive, only at end-of-text, repeats
 * until stable so stacked variants all clear in one call):
 *   - `_…response truncated. Ask "continue" for the rest._`
 *   - `_…reply truncated for length._`
 *   - `_…response cut off — type 'continue' to see more._`
 *   - `[response truncated, reply continue for the rest]`
 *   - `(response truncated — say continue to keep going)`
 *   - bare trailing `Ask "continue" for the rest.` /
 *     `Type 'continue' for more.` lines.
 *
 * What is preserved (these are server-injected, NOT model-emitted):
 *   - `_…response stopped early (safety filter)._`
 *   - `_…response stopped early (recitation filter)._`
 *   The differentiator is the "stopped early" keyword — we don't match it.
 */
const MODEL_TRUNCATION_ITALIC_RE =
  /\s*[_*]+\s*[…\.\s]*(?:response|reply|message|output|answer)?\s*(?:truncat\w*|cut\s+off|cut\s+short)\b[^_*\n]*[_*]+\s*$/i;
const MODEL_TRUNCATION_BRACKET_RE =
  /\s*[\(\[]+\s*(?:response|reply|message|output|answer)?\s*truncat\w*\b[^\)\]\n]*[\)\]]+\s*$/i;
const ASK_CONTINUE_TAIL_RE =
  /\s*[_*\(\[]*\s*(?:Ask|Type|Reply|Say|Hit)\s+["'`]?continue["'`]?\s+(?:for\s+)?(?:the\s+)?(?:rest|more|next\s+part)\b[^_*\)\]\n]*[._*\)\]]*\s*$/i;
const TO_BE_CONTINUED_TAIL_RE =
  /\s*[_*\(\[]*\s*(?:to\s+be\s+continued|continued\s+below|more\s+to\s+come)\b[^_*\)\]\n]*[._*\)\]]*\s*$/i;

export function stripModelTruncationNote(text: string): string {
  let out = String(text || "");
  let prev = "";
  // Loop in case the model stacks multiple variants (e.g. an italic
  // truncation note FOLLOWED by a bare "Type continue for more." line).
  while (prev !== out) {
    prev = out;
    out = out
      .replace(MODEL_TRUNCATION_ITALIC_RE, "")
      .replace(MODEL_TRUNCATION_BRACKET_RE, "")
      .replace(ASK_CONTINUE_TAIL_RE, "")
      .replace(TO_BE_CONTINUED_TAIL_RE, "")
      .replace(/[ \t]+$/gm, "")
      .trimEnd();
  }
  return out;
}

/**
 * Live-stream variant: same idea as stripModelTruncationNote, but tolerant
 * of partial trailing markers that may only have arrived halfway in the
 * current SSE chunk (e.g. "...glass-boxed_…respo" before the next chunk
 * lands). Hides anything from the first suspicious "to-be-continued"
 * marker onward so the user never sees the note flicker into the bubble
 * before the final post-process pass clears it for good.
 *
 * Heuristic: scan the tail for an italic underscore / asterisk run that
 * starts with "…" or "..." and contains "trunc" / "cut off" / "continue"
 * keywords. Same tail-keyword heuristic for plain-text "Ask continue"
 * sentences.
 */
export function stripModelTruncationNoteFromStream(text: string): string {
  const cleanedFinal = stripModelTruncationNote(text);
  if (cleanedFinal !== text) return cleanedFinal;

  // Final pass didn't match — look for an in-progress italic marker
  // ("_…response trunc" mid-stream) and hide it until it completes.
  const italicStart = text.search(
    /[_*]+\s*[…\.]{1,3}\s*(?:response|reply|message|output|answer)?\s*(?:trunc\w*|cut\s+off|cut\s+short)/i,
  );
  if (italicStart !== -1) return text.slice(0, italicStart).trimEnd();

  const askContinueStart = text.search(
    /(?:^|\n|[.!?]\s)\s*(?:Ask|Type|Reply|Say|Hit)\s+["'`]?continue["'`]?\s+(?:for\s+)?(?:the\s+)?(?:rest|more)/i,
  );
  if (askContinueStart !== -1) {
    // Keep up to the start of the "Ask continue ..." sentence boundary.
    const trimAt = text.slice(0, askContinueStart).search(/[.!?…]\s*$/);
    if (trimAt !== -1) return text.slice(0, trimAt + 1).trimEnd();
    return text.slice(0, askContinueStart).trimEnd();
  }
  return text;
}

/**
 * Defensive cleanup for the visible reply when the model misbehaves and
 * starts the hidden `<learned>` / `<updated>` tag mid-sentence. The strip
 * leaves the user staring at a dangling fragment, which reads like a bug.
 *
 * Strategy:
 *   1. If the text already ends with terminal punctuation → leave it alone.
 *   2. If the last word is a "weak" tail (pronoun / article / conjunction /
 *      preposition like "We", "The", "a", "and", "to", "for") — that's an
 *      OBVIOUS cut-off ("...right now. We"). Pop back to the previous
 *      sentence boundary; if there isn't one nearby, append "…".
 *   3. Otherwise the dangling word is at least a noun or verb — the reply
 *      reads as a complete-enough thought even without final punctuation.
 *      Leave it alone (no "…" appended) — adding an ellipsis there made
 *      the cut feel MORE conspicuous, not less. This is the difference
 *      between "Honda Civic version of their ego" (acceptable as-is) and
 *      "...and we" (clearly broken, must trim).
 */
const DANGLING_TERMINAL_RE = /[.!?…]['"”’)\]]?\s*$/;
const WEAK_TAIL_WORDS = new Set([
  // pronouns
  "i", "we", "you", "he", "she", "they", "it", "us", "them", "him", "her", "me",
  "my", "our", "your", "his", "their", "its",
  // articles
  "a", "an", "the",
  // common conjunctions
  "and", "or", "but", "so", "yet", "nor", "for", "as", "if", "than", "that", "though", "while", "because", "since", "when", "whether",
  // common prepositions
  "of", "in", "on", "at", "to", "with", "from", "into", "onto", "by", "about", "over", "under", "between", "through", "across", "via", "against", "without", "within", "after", "before", "during",
  // weak verbs (auxiliaries) that signal an unfinished clause
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "have", "has", "had", "will", "would", "can", "could", "should", "shall", "may", "might", "must",
]);
export function finalizeVisibleReply(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (DANGLING_TERMINAL_RE.test(trimmed)) return trimmed;

  // Pull the last alphabetic word (ignoring trailing punctuation/quotes).
  const lastWordMatch = trimmed.match(/([A-Za-z']+)[^A-Za-z]*$/);
  const lastWord = lastWordMatch?.[1]?.toLowerCase() || "";

  // Only treat it as a "broken" cut-off when the dangling tail is a weak
  // function word. If the last word is a noun/verb/anything substantive,
  // leave the text alone — appending "…" makes it look MORE truncated.
  const isWeakTail = lastWord.length > 0 && WEAK_TAIL_WORDS.has(lastWord);
  if (!isWeakTail) return trimmed;

  // Weak tail → try to pop back to the last sentence boundary if it's
  // close enough. Otherwise append "…" to make the trail-off explicit.
  const lastTerminal = Math.max(
    trimmed.lastIndexOf("."),
    trimmed.lastIndexOf("!"),
    trimmed.lastIndexOf("?"),
    trimmed.lastIndexOf("…"),
  );
  if (lastTerminal > 0 && lastTerminal >= trimmed.length - 60) {
    return trimmed.slice(0, lastTerminal + 1).trimEnd();
  }
  return trimmed + "…";
}

/**
 * POST a model-emitted tag to /api/learned. The server upserts into
 * lykn_user_model_facts and busts the user-model prompt cache. Returns the
 * stored fact (with id) for the chat surface to attach to the message, or
 * null on any failure — never let a learn miss break the chat.
 *
 * When `replacesText` is set, the server runs the in-place update path —
 * the existing neuron with that old text gets its content rewritten rather
 * than a brand-new neuron getting minted next to the stale one.
 *
 * The Authorization header is added automatically by the global authFetch
 * patch in src/lib/installAuthFetch.ts, so no token plumbing is needed here.
 */
export async function postLearnedFact(
  apiBase: string,
  payload: {
    text: string;
    kind: string;
    reason: string | null;
    sourceId?: string;
    replacesText?: string;
  },
): Promise<FactNeuron | null> {
  try {
    const res = await fetch(`${apiBase}/api/learned`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: payload.text,
        kind: payload.kind,
        reason: payload.reason || undefined,
        sourceId: payload.sourceId || undefined,
        replacesText: payload.replacesText || undefined,
      }),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body?.ok || !body?.fact) return null;
    return {
      id: body.fact.id ?? null,
      text: String(body.fact.fact_text || payload.text),
      kind: String(body.fact.fact_kind || payload.kind),
      reason: body.fact.reason ?? payload.reason ?? null,
      isNew: Boolean(body.fact.isNew),
      isUpdate: Boolean(body.fact.isUpdate),
      previousText: body.fact.previousText ?? payload.replacesText ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Fallback path — POST the raw user message (and optional assistant reply)
 * to /api/learned/auto. The server runs a tight gpt-4.1-nano classifier
 * to decide whether the user revealed a personal fact, and if so mints
 * the neuron through the same recordLearnedFactFromChat path the
 * model-tag flow uses.
 *
 * Returns the same FactNeuron shape as `postLearnedFact` on success, or
 * null when the classifier returned "nothing personal" / the request
 * failed / there's nothing to display in the pill.
 *
 * Surfaces should call this ONLY when `parseLearnedTag` returned null
 * for the same reply — calling both wastes the classifier's turn and
 * doesn't change the outcome (the reconciler dedups anyway).
 */
export async function postAutoLearnedFact(
  apiBase: string,
  payload: {
    userMessage: string;
    assistantReply?: string;
    sourceId?: string;
  },
): Promise<FactNeuron | null> {
  try {
    const res = await fetch(`${apiBase}/api/learned/auto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userMessage: payload.userMessage,
        assistantReply: payload.assistantReply || undefined,
        sourceId: payload.sourceId || undefined,
      }),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body?.ok || !body?.fact) return null;
    return {
      id: body.fact.id ?? null,
      text: String(body.fact.fact_text || ""),
      kind: String(body.fact.fact_kind || "identity"),
      reason: body.fact.reason ?? null,
      isNew: Boolean(body.fact.isNew),
      isUpdate: Boolean(body.fact.isUpdate),
      previousText: body.fact.previousText ?? null,
    };
  } catch {
    return null;
  }
}
