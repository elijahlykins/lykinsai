/**
 * Agent hops write planning prose ("I'll check…") that used to concatenate
 * into the visible reply, often without a space. Hold it until we know the
 * hop is the user's final answer, then flush once. Mid-work hops become a
 * single thinking status line.
 */

/** First sentence of hop prose, short enough for a thinking status line. */
export function firstUserStatusLine(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const sentence = t.split(/(?<=[.!?])\s+/)[0] || t;
  return sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}…` : sentence;
}

export function makeWorkReplyGate(onTextChunk, onStatus, enabled) {
  let held = "";
  return {
    ingest(t) {
      if (!t) return;
      if (enabled) held += t;
      else {
        try { onTextChunk?.(t); } catch { /* swallow */ }
      }
    },
    park() {
      if (!enabled) return;
      const line = firstUserStatusLine(held);
      held = "";
      if (line) {
        try { onStatus?.(line); } catch { /* swallow */ }
      }
    },
    deliver() {
      const text = held;
      held = "";
      if (text) {
        try { onTextChunk?.(text); } catch { /* swallow */ }
      }
    },
    discard() {
      held = "";
    },
  };
}
