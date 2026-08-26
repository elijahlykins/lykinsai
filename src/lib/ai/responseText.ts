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
  let previous = "";
  while (previous !== out) {
    previous = out;
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

export function stripModelTruncationNoteFromStream(text: string): string {
  const cleaned = stripModelTruncationNote(text);
  if (cleaned !== text) return cleaned;

  const italicStart = text.search(
    /[_*]+\s*[…\.]{1,3}\s*(?:response|reply|message|output|answer)?\s*(?:trunc\w*|cut\s+off|cut\s+short)/i,
  );
  if (italicStart !== -1) return text.slice(0, italicStart).trimEnd();

  const askContinueStart = text.search(
    /(?:^|\n|[.!?]\s)\s*(?:Ask|Type|Reply|Say|Hit)\s+["'`]?continue["'`]?\s+(?:for\s+)?(?:the\s+)?(?:rest|more)/i,
  );
  if (askContinueStart === -1) return text;

  const terminalAt = text.slice(0, askContinueStart).search(/[.!?…]\s*$/);
  return terminalAt === -1
    ? text.slice(0, askContinueStart).trimEnd()
    : text.slice(0, terminalAt + 1).trimEnd();
}

const DANGLING_TERMINAL_RE = /[.!?…]['"”’)\]]?\s*$/;
const WEAK_TAIL_WORDS = new Set([
  "i", "we", "you", "he", "she", "they", "it", "us", "them", "him", "her", "me",
  "my", "our", "your", "his", "their", "its", "a", "an", "the", "and", "or", "but",
  "so", "yet", "nor", "for", "as", "if", "than", "that", "though", "while", "because",
  "since", "when", "whether", "of", "in", "on", "at", "to", "with", "from", "into",
  "onto", "by", "about", "over", "under", "between", "through", "across", "via",
  "against", "without", "within", "after", "before", "during", "is", "are", "was",
  "were", "be", "been", "being", "am", "do", "does", "did", "have", "has", "had",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
]);

export function finalizeVisibleReply(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || DANGLING_TERMINAL_RE.test(trimmed)) return trimmed;

  const lastWord = trimmed.match(/([A-Za-z']+)[^A-Za-z]*$/)?.[1]?.toLowerCase() || "";
  if (!WEAK_TAIL_WORDS.has(lastWord)) return trimmed;

  const lastTerminal = Math.max(
    trimmed.lastIndexOf("."),
    trimmed.lastIndexOf("!"),
    trimmed.lastIndexOf("?"),
    trimmed.lastIndexOf("…"),
  );
  return lastTerminal > 0 && lastTerminal >= trimmed.length - 60
    ? trimmed.slice(0, lastTerminal + 1).trimEnd()
    : `${trimmed}…`;
}
