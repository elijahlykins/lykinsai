/**
 * Normalize try-hosted / run-hosted API JSON.
 * Server returns { ok, reply, runtime, tool_calls, ... } at the top level.
 * Older clients expected { ok, result: { reply, ... } }.
 */
export function parseHostedAgentRunPayload(data) {
  const raw = data && typeof data === "object" ? data : {};
  const inner =
    raw.result && typeof raw.result === "object" && raw.result.reply != null
      ? raw.result
      : raw;
  return {
    reply: String(inner.reply || "").trim(),
    runtime: inner.runtime || null,
    tool_calls: Array.isArray(inner.tool_calls) ? inner.tool_calls : [],
    handler_warning: String(inner.handler_warning || inner._last_handler_error || "").trim(),
    ok: raw.ok !== false && inner.ok !== false,
  };
}
