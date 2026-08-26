// Vault-surface / display intent gate for the chat send pipeline: pure
// regex-driven detection of whether the user asked, THIS turn, to bring a
// saved vault item into the chat (card render) or to pop the full embedded
// reader open. Extracted verbatim from src/lib/ai/chatSendOrchestrator.ts
// (chat engine decomposition Wave 1, see docs/REFACTOR_LOG.md). Matching
// behavior is unchanged.

// --- Vault-surface gate ----------------------------------------------------
// A saved VAULT item should only render as a card in the chat when the user
// actually asked to SEE it. The agent (model) decides whether to call
// lykn_loadNeuron, and it sometimes over-eagerly surfaces vault items that
// have nothing to do with the conversation. This client-side gate is the
// deterministic backstop: even if the model loads a vault neuron, we only
// render the card when the user's words this turn requested it (or they
// confirmed a surfacing offer the assistant just made).

// Verbs/phrases that signal the user wants a saved item rendered in chat.
// Broad on purpose: the model-side prompt guardrail does the precise work
// of deciding WHETHER to load, so this client gate only needs to reliably
// recognise an explicit ask and block the clearly-unprompted case (a plain
// topical question like "how do I price my SaaS?" matches none of these).
// Missing a real ask is the worse failure (the card silently never shows),
// so we err toward catching every natural surfacing verb.
// View / place verbs — alone these are NOT enough (normal chat uses "show",
// "see", "find" constantly). Must pair with SAVED_CONTEXT or an offer yes.
const VAULT_SURFACE_REQUEST_RE =
  /\b(show|see|view|look|open|pull|bring|load|display|render|embed|attach|surface|reveal|include|drop|put|add|insert|place|share|grab|find|lemme)\b/i;

const VAULT_SAVED_CONTEXT_RE =
  /\b(?:vault|saved|artifact|artifacts|my\s+(?:notes?|files?|pics?|pictures?|photos?|images?|docs?|documents?|links?|articles?|bookmarks?|artifacts?|stuff)|from\s+(?:my\s+)?(?:vault|notion|drive|gmail|readwise)|what\s+(?:have|did)\s+i\s+save|something\s+i\s+saved)\b/i;

// Placement phrases that mean "into the conversation" even without a verb
// from the list above ("I want that in the chat", "put it here").
const VAULT_SURFACE_PLACEMENT_RE =
  /\b(in(?:to)?\s+(?:the\s+|this\s+)?chat|in\s+here|right\s+here|in\s+the\s+(?:conversation|thread))\b/i;

// Short affirmations that count as "yes, bring them in" — but ONLY when the
// assistant's previous turn actually offered to surface saved items.
const VAULT_AFFIRMATION_RE =
  /^(?:\s*(?:yes|yep|yeah|yup|ya|sure|ok|okay|k|please|do\s*it|go(?:\s*ahead)?|go\s*for\s*it|sounds?\s*good|that\s*one|those|them|all\s*(?:of\s*)?(?:them|those)|the\s+\w+\s+ones?)\b[\s.,!]*)+$/i;

// Did the assistant's previous turn offer to surface saved items, or even
// just reference saved/vault content the user could now say "yes" to? Kept
// permissive so a bare "yes" / "do it" reliably brings the items in.
const VAULT_SURFACE_OFFER_RE =
  /\b(pull\s*(?:them|those|it|up|in)|bring\s*(?:them|those|it|up|in)|show\s*(?:you|them|those|it)|open\s*(?:them|those|it)|load\s*(?:them|those|it)|surface\s*(?:them|those|it)|want\s*me\s*to\s*(?:pull|show|bring|open|load|surface|display)|i\s*(?:can|could)\s*(?:pull|show|bring|open|load|surface|display)|in\s*(?:your\s*)?vault|you\s*(?:have|saved)|saved\s*(?:note|notes|item|items|image|images|file|files|article|articles))\b/i;

/**
 * True when the user has asked, THIS turn, to bring a saved vault item into
 * the chat — either by using a surfacing verb + saved/vault cue, or by
 * affirming a surfacing offer the assistant made on the preceding turn.
 */
export function userRequestedVaultSurface(
  userText: string,
  aiThread: Array<{ role: "user" | "assistant"; content: string }>,
  /**
   * Local Mode on for this turn — "pull in the images" then usually means
   * files on the user's MACHINE, so the broad verb+noun match below is
   * skipped and only explicit saved/vault references surface vault cards.
   */
  localModeOn = false,
): boolean {
  const t = String(userText || "").trim();
  if (!t) return false;
  // Local-machine asks ("pull in an image from my downloads", "show the file
  // on my desktop") are Local Mode territory, not vault surfacing — without
  // this, "pull … the … images" below matches and unrelated vault cards
  // render on file-system turns.
  if (
    /\b(?:from|in|on|inside)\s+(?:my\s+)?(?:downloads?|desktop|documents|home\s+folder|mac(?:book)?|machine|computer|laptop|hard\s*drive|finder|file\s*system)\b/i.test(
      t,
    ) &&
    !/\bvault\b/i.test(t)
  ) {
    return false;
  }
  const hasView = VAULT_SURFACE_REQUEST_RE.test(t) || VAULT_SURFACE_PLACEMENT_RE.test(t);
  if (hasView && VAULT_SAVED_CONTEXT_RE.test(t)) return true;
  if (
    !localModeOn &&
    /\b(?:show|see|open|pull|bring|display|load)\b.{0,48}\b(?:my|the|that|those)\b.{0,24}\b(?:notes?|files?|pics?|pictures?|photos?|images?|docs?|vault|saved|links?|articles?|artifacts?)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (VAULT_AFFIRMATION_RE.test(t)) {
    for (let i = aiThread.length - 1; i >= 0; i--) {
      const m = aiThread[i];
      if (m?.role !== "assistant") continue;
      return VAULT_SURFACE_OFFER_RE.test(String(m.content || ""));
    }
  }
  return false;
}

// --- Full-reader auto-open intent ------------------------------------------
// A stronger, narrower signal than `userRequestedVaultSurface`. The card
// renders for the broad "show/find/grab" family, but we only POP the full
// embedded document reader open when the user clearly wants to LOOK AT the
// whole thing — "pull that up", "bring it in", "open it", "show me", "read
// it", "the full thing". Soft verbs like "find" / "grab" / "do you have"
// surface the card (where one tap pulls it up) but don't hijack the screen
// with a modal.
const VAULT_DISPLAY_VERB_RE =
  /\b(pull\s*(?:up|it|that|this|them|those|in)|bring\s*(?:up|in|it|that|this|them|those)|open\s*(?:it|that|this|them|those|up)|show\s*(?:me|it|that|this|them|those|the)|display|view\s*(?:it|that|this|the)|expand|read\s*(?:it|that|this|me|the)|see\s*(?:it|that|this|the\s+(?:whole|full|rest|entire)))\b/i;

// "the full / whole / entire thing|document|note" — a display ask even when
// the verb is generic.
const VAULT_DISPLAY_NOUN_RE =
  /\b(?:full|whole|entire|rest\s+of)\s+(?:thing|document|doc|note|file|article|text|content|version|page)\b/i;

/**
 * True when the user wants the full embedded reader popped open for a vault
 * item this turn — a strict subset of `userRequestedVaultSurface`. Reuses the
 * exact same affirmation→offer detection so a bare "yes" / "pull it up" after
 * the assistant offers ("want me to pull that up?") opens the reader.
 */
export function userRequestedVaultDisplay(
  userText: string,
  aiThread: Array<{ role: "user" | "assistant"; content: string }>,
): boolean {
  const t = String(userText || "").trim();
  if (!t) return false;
  if (VAULT_DISPLAY_VERB_RE.test(t) || VAULT_DISPLAY_NOUN_RE.test(t)) return true;
  if (VAULT_AFFIRMATION_RE.test(t)) {
    for (let i = aiThread.length - 1; i >= 0; i--) {
      const m = aiThread[i];
      if (m?.role !== "assistant") continue;
      return VAULT_SURFACE_OFFER_RE.test(String(m.content || ""));
    }
  }
  return false;
}
