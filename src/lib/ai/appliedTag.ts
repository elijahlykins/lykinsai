/**
 * <applied> tag helpers — the audit half of the belief-window mechanic.
 *
 * When the chat model determines its reply leaned on a user-ratified rule,
 * it appends a hidden tag like:
 *
 *   <applied rule_id="<uuid>">one short sentence explaining how the rule
 *   shaped this reply</applied>
 *
 * The client strips that tag from the visible reply (same pattern as
 * <learned>/<updated>) and POSTs it to /api/applied where the server
 * verifies the rule is owned + active and records an attribution row.
 *
 * HONESTY-OVER-ATTRIBUTION RULES:
 *   • The tag is OPTIONAL. Most replies are not rule-driven and emit no tag.
 *   • An invalid rule_id (not owned by the user, or not active) is silently
 *     dropped server-side — we never fake-attribute.
 *   • A reply may have BOTH a <learned>/<updated> tag AND an <applied> tag.
 *     The orchestrator strips both before showing the visible text.
 */

export type ParsedAppliedTag = {
  ruleId: string;
  reason: string | null;
};

export type AppliedAttribution = {
  id: string | null;
  messageId: string;
  ruleId: string;
  beliefId: string;
  ruleSnapshot: string;
  beliefSnapshot: string;
  servesNeed: "live" | "love" | "value" | "variety" | string;
  reason: string | null;
  createdAt: string;
};

/**
 * Parse a single <applied rule_id="..."> tag out of a completed reply.
 * Returns null when no tag is present (the common case — most turns are
 * not rule-driven). Tolerates both single and double quotes around the
 * rule_id attribute.
 */
export function parseAppliedTag(rawReply: string): ParsedAppliedTag | null {
  const match = rawReply.match(
    /<applied\b([^>]*)>\s*([\s\S]*?)\s*<\/applied>/i,
  );
  if (!match) return null;
  const attrs = match[1] || "";
  const idAttr = attrs.match(/\brule_id\s*=\s*["']([^"']+)["']/i);
  const ruleId = idAttr ? idAttr[1].trim() : "";
  if (!ruleId) return null;

  // Reject obvious non-uuid placeholders so we don't waste a server round-trip
  // on the model's "0" / "none" / "unknown" / fence-leak hallucinations. The
  // server validates ownership too; this is a cheap pre-filter.
  if (!/^[0-9a-f-]{8,}$/i.test(ruleId)) return null;

  const reason = (match[2] || "")
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .slice(0, 320) || null;
  return { ruleId, reason };
}

/**
 * Hide everything from `<applied` onward as the stream comes in, so the
 * user never sees the hidden tag flicker into view. Mirrors the partial-prefix
 * matching that stripLearnedTagFromStream does.
 */
export function stripAppliedTagFromStream(text: string): string {
  const idx = text.indexOf("<applied");
  if (idx !== -1) return text.slice(0, idx).trimEnd();
  const partial = text.match(/<a(?:p(?:p(?:l(?:i(?:e)?)?)?)?)?$/);
  if (partial && partial.index !== undefined) {
    return text.slice(0, partial.index).trimEnd();
  }
  return text;
}

/**
 * Once the stream is done, strip the entire tag from the final visible
 * reply. Idempotent — safe to call when no tag was emitted.
 */
export function stripAppliedTagFromFinal(text: string): string {
  return text
    .replace(/<applied\b[^>]*>[\s\S]*?<\/applied>/gi, "")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

/**
 * POST a parsed <applied> tag to /api/applied. The server validates the
 * rule_id is owned by the user AND active before inserting an attribution
 * row; anything else returns { ok: false, reason } and we ignore it.
 *
 * Returns the inserted attribution on success or null on any failure —
 * a missed attribution must NEVER break the chat surface.
 *
 * The Authorization header is added automatically by installAuthFetch.
 */
export async function postAppliedAttribution(
  apiBase: string,
  payload: {
    ruleId: string;
    messageId: string;
    reason: string | null;
    surface?: string;
    surfaceId?: string;
  },
): Promise<AppliedAttribution | null> {
  try {
    const res = await fetch(`${apiBase}/api/applied`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ruleId: payload.ruleId,
        messageId: payload.messageId,
        reason: payload.reason || undefined,
        surface: payload.surface || undefined,
        surfaceId: payload.surfaceId || undefined,
      }),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body?.ok || !body?.attribution) return null;
    const a = body.attribution;
    return {
      id: a.id ?? null,
      messageId: String(a.message_id || payload.messageId),
      ruleId: String(a.rule_id || payload.ruleId),
      beliefId: String(a.belief_id || ""),
      ruleSnapshot: String(a.rule_snapshot || ""),
      beliefSnapshot: String(a.belief_snapshot || ""),
      servesNeed: String(a.serves_need || ""),
      reason: a.reason ?? payload.reason ?? null,
      createdAt: String(a.created_at || new Date().toISOString()),
    };
  } catch {
    return null;
  }
}
